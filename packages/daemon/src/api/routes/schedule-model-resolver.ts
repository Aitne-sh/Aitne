import type { BackendId } from "@aitne/shared";
import {
  composeIssue,
  composeWarning,
  type AgentErrorIssue,
} from "../helpers/agent-errors.js";
import {
  snapshotModelRegistry,
  validateModelToken,
  type ModelRegistrySnapshot,
} from "./schedule-validation.js";

/**
 * Phase D bridge between `validateModelToken` (Phase B helper, returns
 * a discriminated union over the four resolution kinds) and the
 * schedule routes' INSERT/UPDATE call sites. Encapsulates:
 *
 *   1. The tier ↔ model mutual-exclusion check
 *      (`schedule.tier_and_model_conflict`).
 *   2. The §4.3 persistence rule — only one of
 *      `(tier_override)` / `(model, backend_id)` is non-NULL on any
 *      row; the alias path persists `tier_override` and clears both
 *      `(model, backend_id)`, the registered-model path does the
 *      opposite, and pure-tier rows leave both NULL except for
 *      `tier_override`.
 *   3. The §5.0.5 deprecation warning channel — registered-but-
 *      deprecated ids still persist, but the route emits a
 *      `schedule.model_deprecated` warning carrying the non-deprecated
 *      replacements so the next LLM turn can refine.
 *
 * Kept as a separate module from `agent-schedule.ts` so the same
 * resolution logic powers the three schedule call sites (POST,
 * POST batch row, PATCH) and the recurring routes via one consistent
 * code path. Pure module — no DB, no I/O — therefore lands inside the
 * 100% coverage tier per `vitest.config.ts`.
 *
 * See `docs/design/appendices/morning-routine-optimization.md`
 * §"Error messaging contract" for the issue-shape contract this
 * helper writes into.
 */

/**
 * Outcome of resolving the (model, tier) pair on a single row.
 *
 * Discriminated by `ok`:
 *   - `ok:true`  — caller persists `(model, tierOverride, backendId)`.
 *                  `warnings` may be non-empty when the resolved model
 *                  is registered but flagged deprecated.
 *   - `ok:false` — caller rejects the row (400 / 422) with `errors[]`.
 */
export type ResolveModelResult =
  | {
      ok: true;
      model: string | null;
      tierOverride: "lite" | "medium" | "high" | null;
      backendId: BackendId | null;
      warnings: AgentErrorIssue[];
    }
  | { ok: false; errors: AgentErrorIssue[] };

/**
 * For the deprecation warning's `validValues.availableModels`,
 * project the snapshot's non-deprecated entries for the resolved
 * backend. Mirrors `simplifyForUnknownPayload` in
 * `schedule-validation.ts` but per-backend so the agent's retry can
 * pick a same-backend replacement without browsing the full registry.
 */
function nonDeprecatedAvailableModels(
  snapshot: ModelRegistrySnapshot,
  backendId: BackendId,
): string[] {
  return snapshot.models[backendId]
    .filter((m) => !m.deprecated)
    .map((m) => m.id);
}

/**
 * Resolve a row's `(model, tier)` pair against the live model registry
 * snapshot. Stateless — call once per row.
 *
 * The four `validateModelToken` kinds map onto persistence as
 * documented in §4.3's table:
 *
 *   | kind        | model            | tier_override | backend_id |
 *   |-------------|------------------|---------------|------------|
 *   | alias       | NULL             | "medium"/"high" | NULL     |
 *   | model       | <modelId>        | NULL          | <backendId>|
 *   | ambiguous   | — (errors[])     | —             | —          |
 *   | unknown     | — (errors[])     | —             | —          |
 *
 * The `tier`-only path (no `model`) falls through with `tierOverride
 * = tier ?? null`, `model = null`, `backendId = null`. The pure-omit
 * path (neither field set) returns all-null and the row inherits the
 * dispatcher's process-key default at fire time.
 *
 * `fieldBase` is the JSON-pointer-ish prefix that issues' `field`
 * paths get rooted at — `"model"` for single-row endpoints,
 * `"rows[i].model"` for batch rows. `rowIndex` is the integer row
 * index for batch rows, `null` for single-row endpoints.
 *
 * @param model       Caller-supplied token. `undefined` = unset.
 * @param tier        Caller-supplied tier override. `undefined` = unset.
 * @param fieldBase   JSON-pointer-ish path the issues' `field` is
 *                    rooted at. Use `"model"` for /schedule and
 *                    `"rows[N].model"` for /schedule/batch.
 * @param tierField   Sibling field path used by the conflict issue's
 *                    `field` half. `"tier"` for /schedule;
 *                    `"rows[N].tier"` for the batch path.
 * @param rowIndex    Integer batch-row index, or `null` outside batch.
 * @param snapshot    Optional snapshot override (Phase B test surface);
 *                    defaults to a freshly taken `snapshotModelRegistry()`.
 */
export function resolveModelToken(args: {
  model: string | undefined;
  tier: "lite" | "medium" | "high" | undefined;
  fieldBase: string;
  tierField: string;
  rowIndex: number | null;
  snapshot?: ModelRegistrySnapshot;
}): ResolveModelResult {
  const { model, tier, fieldBase, tierField, rowIndex } = args;
  const snapshot = args.snapshot ?? snapshotModelRegistry();

  // §4.3 mutual exclusion. Both unset is fine — the row resolves via
  // process-key defaults. Both set is a hard reject so the row's
  // intent is unambiguous (the LLM error loop adapts in one retry).
  if (model !== undefined && tier !== undefined) {
    return {
      ok: false,
      errors: [
        composeIssue("schedule.tier_and_model_conflict", {
          field: fieldBase,
          received: { model, tier },
          rowIndex,
          validValues: {
            rule: "specify tier OR model, not both",
            tierField,
            modelField: fieldBase,
          },
        }),
      ],
    };
  }

  // Neither set → row inherits dispatcher's process-key default.
  if (model === undefined && tier === undefined) {
    return { ok: true, model: null, tierOverride: null, backendId: null, warnings: [] };
  }

  // Tier only → store the tier and clear the model pin. `tier` is
  // guaranteed defined here (the both-undefined case returned above and
  // the both-defined case errored above), but TS does not propagate that
  // narrowing through the disjunction — the non-null assertion is the
  // narrowest fix and keeps the branch count honest.
  if (model === undefined) {
    return {
      ok: true,
      model: null,
      tierOverride: tier!,
      backendId: null,
      warnings: [],
    };
  }

  // Model token present — resolve against the registry.
  const result = validateModelToken(model, snapshot);

  switch (result.kind) {
    case "alias":
      // Rewrite "sonnet" → tier:medium, "opus" → tier:high. The row
      // no longer carries the alias verbatim — one canonical form.
      return {
        ok: true,
        model: null,
        tierOverride: result.tierToken,
        backendId: null,
        warnings: [],
      };
    case "model": {
      const warnings: AgentErrorIssue[] = [];
      if (result.deprecated) {
        // §5.0.5: registered-but-deprecated stays persisted, surfaces
        // a warning so the LLM can refine on the next turn. The row
        // is still load-bearing — recurring rules that pin a known
        // deprecated id shouldn't die on a registry version bump.
        warnings.push(
          composeWarning("schedule.model_deprecated", {
            field: fieldBase,
            received: model,
            rowIndex,
            validValues: {
              model,
              backendId: result.backendId,
              availableModels: nonDeprecatedAvailableModels(
                snapshot,
                result.backendId,
              ),
            },
          }),
        );
      }
      return {
        ok: true,
        model: result.modelId,
        tierOverride: null,
        backendId: result.backendId,
        warnings,
      };
    }
    case "ambiguous":
      return {
        ok: false,
        errors: [
          composeIssue("schedule.model_ambiguous", {
            field: fieldBase,
            received: model,
            rowIndex,
            validValues: result.validValues,
          }),
        ],
      };
    case "unknown":
      return {
        ok: false,
        errors: [
          composeIssue("schedule.model_unknown", {
            field: fieldBase,
            received: model,
            rowIndex,
            validValues: result.validValues,
          }),
        ],
      };
  }
}

/**
 * PATCH variant — accepts `null` on either field as the explicit
 * "clear" sentinel. Returns three partial updates the route then
 * threads into its dynamic-SQL builder:
 *
 *   - `model`: present + value means "write this column"; absent
 *     means "leave the column alone".
 *   - `tierOverride`: same.
 *   - `backendId`: same. Always coupled to `model` — either both
 *     present or both absent.
 *
 * The conflict + alias + deprecated-warning rules from
 * `resolveModelToken` carry over verbatim. PATCH-only differences:
 *
 *   - `model: null` clears BOTH `model` and `backend_id`.
 *   - `model: <token>` with `tier === undefined` leaves the existing
 *     `tier_override` column untouched. (Equivalent to passing `tier:
 *     null` and `model: <token>` on the row's prior state — the row's
 *     prior `tier_override` column may already be NULL because the
 *     INSERT path normalises one or the other to NULL. If a stray
 *     row predates this normalisation, the route's `model:<token>`
 *     branch additionally writes `tier_override = NULL` so the row
 *     ends up consistent — see the route's UPDATE assembly.)
 *
 * Why a separate function: the create path's `model:undefined`
 * branch falls through to "no pin", but the PATCH path's
 * `model:undefined` is "no change". Reusing one function would force
 * either ambiguity (which doesn't survive PATCH `{}`) or a third
 * sentinel — a separate entry point is cleaner.
 */
export type PatchModelResult =
  | {
      ok: true;
      /** `present:true, value:null` clears; `present:true, value:<x>` sets; `present:false` leaves untouched. */
      model: { present: boolean; value: string | null };
      tierOverride: { present: boolean; value: "lite" | "medium" | "high" | null };
      backendId: { present: boolean; value: BackendId | null };
      warnings: AgentErrorIssue[];
    }
  | { ok: false; errors: AgentErrorIssue[] };

export function resolveModelTokenForPatch(args: {
  model: string | null | undefined;
  tier: "lite" | "medium" | "high" | null | undefined;
  fieldBase: string;
  tierField: string;
  rowIndex: number | null;
  snapshot?: ModelRegistrySnapshot;
}): PatchModelResult {
  const { model, tier, fieldBase, tierField, rowIndex } = args;
  const snapshot = args.snapshot ?? snapshotModelRegistry();

  // Conflict check — only triggers when BOTH fields are present AND
  // non-null. The clear-one-set-the-other PATCH form is the
  // documented contract for swapping rows from tier-pinned to
  // model-pinned (and vice-versa) in a single request.
  if (
    model !== undefined &&
    model !== null &&
    tier !== undefined &&
    tier !== null
  ) {
    return {
      ok: false,
      errors: [
        composeIssue("schedule.tier_and_model_conflict", {
          field: fieldBase,
          received: { model, tier },
          rowIndex,
          validValues: {
            rule: "specify tier OR model, not both",
            tierField,
            modelField: fieldBase,
          },
        }),
      ],
    };
  }

  // `tier` partial — pass through verbatim. PATCH semantics: `null`
  // clears the column; a concrete value sets it; `undefined` leaves
  // the column alone.
  const tierPartial: {
    present: boolean;
    value: "lite" | "medium" | "high" | null;
  } =
    tier === undefined
      ? { present: false, value: null }
      : { present: true, value: tier };

  // `model: undefined` → no change to model / backend_id either.
  if (model === undefined) {
    return {
      ok: true,
      model: { present: false, value: null },
      tierOverride: tierPartial,
      backendId: { present: false, value: null },
      warnings: [],
    };
  }

  // `model: null` → explicit clear. Both `model` and `backend_id`
  // get NULLed in the same UPDATE so the dispatcher's override block
  // doesn't see a half-cleared row.
  if (model === null) {
    return {
      ok: true,
      model: { present: true, value: null },
      tierOverride: tierPartial,
      backendId: { present: true, value: null },
      warnings: [],
    };
  }

  // Model token set — resolve against the registry. Same four kinds
  // as the create path; only the persistence wiring differs.
  const result = validateModelToken(model, snapshot);

  switch (result.kind) {
    case "alias":
      // Setting `model: "sonnet"` on PATCH is equivalent to setting
      // `tier: "medium"`. Normalise to the canonical form: write
      // `tier_override`, clear `model` + `backend_id`. If the caller
      // ALSO supplied `tier`, the conflict block above already fired
      // (so this branch only fires when `tier === undefined` or
      // `tier === null` — both of which we override here).
      return {
        ok: true,
        model: { present: true, value: null },
        tierOverride: { present: true, value: result.tierToken },
        backendId: { present: true, value: null },
        warnings: [],
      };
    case "model": {
      const warnings: AgentErrorIssue[] = [];
      if (result.deprecated) {
        warnings.push(
          composeWarning("schedule.model_deprecated", {
            field: fieldBase,
            received: model,
            rowIndex,
            validValues: {
              model,
              backendId: result.backendId,
              availableModels: nonDeprecatedAvailableModels(
                snapshot,
                result.backendId,
              ),
            },
          }),
        );
      }
      // Setting a registered model on PATCH always clears any prior
      // `tier_override` so the row ends up with exactly one pin
      // (per §4.3 — model+tier never both non-null at rest). The
      // route forwards `tierOverride: {present:true, value:null}`
      // when the caller did not supply their own `tier:null`.
      const explicitTierClear = tier === undefined;
      return {
        ok: true,
        model: { present: true, value: result.modelId },
        tierOverride: explicitTierClear
          ? { present: true, value: null }
          : tierPartial,
        backendId: { present: true, value: result.backendId },
        warnings,
      };
    }
    case "ambiguous":
      return {
        ok: false,
        errors: [
          composeIssue("schedule.model_ambiguous", {
            field: fieldBase,
            received: model,
            rowIndex,
            validValues: result.validValues,
          }),
        ],
      };
    case "unknown":
      return {
        ok: false,
        errors: [
          composeIssue("schedule.model_unknown", {
            field: fieldBase,
            received: model,
            rowIndex,
            validValues: result.validValues,
          }),
        ],
      };
  }
}
