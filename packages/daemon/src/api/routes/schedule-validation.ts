import {
  BACKEND_IDS,
  type BackendId,
  type BackendModelTier,
  isBackendId,
} from "@aitne/shared";
import { getModelsForBackend } from "../../core/backends/model-registry.js";

/**
 * Phase B helper for SCHEDULE_API_REDESIGN_PLAN.md §4.3.
 *
 * `validateModelToken` is the single chokepoint Phase D's schedule routes
 * use to translate the free-form `model` field on schedule create/PATCH
 * payloads into either:
 *
 *   - a legacy-alias rewrite to `tier_override` (`"sonnet"` → `"medium"`,
 *     `"opus"` → `"high"`),
 *   - a registry-backed `(backendId, modelId)` pin captured at write-time
 *     (closes the §4.3a `requestedBackendId` silent-drop bug),
 *   - an ambiguous match across multiple backends (today unreachable, but
 *     `MODEL_REGISTRY` is editable so a future entry could collide),
 *   - or unknown — caller emits `schedule.model_unknown` with a snapshot
 *     of every registered model the operator could have meant.
 *
 * `snapshotModelRegistry` projects `MODEL_REGISTRY` to the shape the new
 * `GET /api/schedule/options` endpoint returns (§4.4) AND the shape the
 * error envelope's `validValues` cites (§5). The same projection serves
 * both because /options carries the rich `{id, tier, deprecated}` rows
 * the dashboard wants and `validateModelToken` derives the simpler
 * `{aliases, models: Record<backend, string[]>}` error payload from it.
 *
 * `validateModelToken` matches entirely against its `snapshot` argument
 * (no direct registry reads). That keeps the helper pure — tests can
 * construct a synthetic snapshot to exercise the ambiguous branch which
 * is currently unreachable from the live registry. Pure module — no DB,
 * no I/O. 100% coverage tier per `vitest.config.ts`.
 */

/** Per-model entry shown in `/schedule/options.models[backendId]`. */
export interface BackendModelDetail {
  id: string;
  tier: BackendModelTier;
  deprecated: boolean;
}

/**
 * Read-only projection of `MODEL_REGISTRY` consumed by /schedule/options
 * AND by `validateModelToken`. Kept stable across the two consumers so
 * a registry change only needs one update site.
 */
export interface ModelRegistrySnapshot {
  /**
   * Legacy alias → process tier mapping. Mirrors the `model: "sonnet" | "opus"`
   * field the pre-redesign schemas carried. New schedules should prefer
   * `tier` directly; aliases remain accepted for backward compat
   * (§9 "Backward compatibility" — existing rows with `model='sonnet'|'opus'`).
   */
  modelAliases: { sonnet: BackendModelTier; opus: BackendModelTier };
  /** Per-backend list of every registered model. Stable registry order. */
  models: Record<BackendId, BackendModelDetail[]>;
}

const LEGACY_ALIAS_TIERS: { sonnet: BackendModelTier; opus: BackendModelTier } = {
  sonnet: "medium",
  opus: "high",
};

/**
 * Build a snapshot of `MODEL_REGISTRY`. Used by:
 *   - `GET /api/schedule/options` — returned verbatim under `models` +
 *     `modelAliases` keys (§4.4).
 *   - `validateModelToken` — fed in as the second argument so the unknown
 *     branch can cite valid alternatives without re-walking the registry.
 *
 * Entries appear in registry declaration order; callers that need a
 * sorted view should re-sort. Deprecated entries are kept in the snapshot
 * (so the dashboard can still surface them) but excluded from the error
 * envelope's `validValues` payload (so the agent's retry can't loop on a
 * model the registry would have warned about) — see
 * `simplifyForUnknownPayload`.
 */
export function snapshotModelRegistry(): ModelRegistrySnapshot {
  const models = {} as Record<BackendId, BackendModelDetail[]>;
  for (const backendId of BACKEND_IDS) {
    models[backendId] = getModelsForBackend(backendId).map((model) => ({
      id: model.modelId,
      tier: model.tier,
      deprecated: Boolean(model.deprecated),
    }));
  }
  return {
    modelAliases: { ...LEGACY_ALIAS_TIERS },
    models,
  };
}

/**
 * Result of `validateModelToken`. Discriminated by `kind`:
 *
 *   - `"alias"`     — legacy `"sonnet"`/`"opus"`. Route rewrites to
 *                     `tier_override` and clears `model` + `backend_id`.
 *   - `"model"`     — registered exact-match. Route persists both
 *                     `(backend_id, model)` and clears `tier_override`.
 *                     `deprecated: true` adds a §5.0.5 warnings[] entry
 *                     but does NOT reject the row.
 *   - `"ambiguous"` — token matched > 1 backend. Route emits
 *                     `schedule.model_ambiguous` with the matches list
 *                     so the caller can resubmit using the
 *                     `<backendId>/<modelId>` composite form.
 *   - `"unknown"`   — no alias, no registered match. Route emits
 *                     `schedule.model_unknown` with the full validValues
 *                     snapshot so the caller's retry can pick a real id.
 *
 * `validValues` is shaped to drop straight into
 * `AgentErrorIssue.validValues` (§5.3). The four kinds are sealed in this
 * union; new kinds require a registry-code addition + Phase D route
 * branch update.
 */
export type ValidateModelResult =
  | { kind: "alias"; tierToken: BackendModelTier }
  | {
      kind: "model";
      backendId: BackendId;
      modelId: string;
      deprecated: boolean;
    }
  | {
      kind: "ambiguous";
      matches: ReadonlyArray<{ backendId: BackendId; modelId: string }>;
      validValues: {
        matches: ReadonlyArray<{ backendId: BackendId; modelId: string }>;
        hint: string;
      };
    }
  | {
      kind: "unknown";
      validValues: {
        aliases: ReadonlyArray<"sonnet" | "opus">;
        models: Record<BackendId, string[]>;
      };
    };

/**
 * Project the rich snapshot into the simpler shape the error envelope
 * cites. Deprecated entries are stripped so an LLM retry doesn't
 * immediately pick a model the registry is about to remove.
 */
function simplifyForUnknownPayload(snapshot: ModelRegistrySnapshot): {
  aliases: ReadonlyArray<"sonnet" | "opus">;
  models: Record<BackendId, string[]>;
} {
  const models = {} as Record<BackendId, string[]>;
  for (const backendId of BACKEND_IDS) {
    models[backendId] = snapshot.models[backendId]
      .filter((m) => !m.deprecated)
      .map((m) => m.id);
  }
  return {
    aliases: ["sonnet", "opus"] as const,
    models,
  };
}

/**
 * Locate every snapshot entry matching `modelId` under `backendId`.
 * Snapshot-driven so the ambiguous branch is testable without mutating
 * the live `MODEL_REGISTRY`.
 */
function findInSnapshot(
  snapshot: ModelRegistrySnapshot,
  backendId: BackendId,
  modelId: string,
): BackendModelDetail | undefined {
  return snapshot.models[backendId].find((m) => m.id === modelId);
}

/**
 * Resolve a caller-supplied `model` token to one of four outcomes. See
 * `ValidateModelResult` for the contract.
 *
 * Resolution order (per SCHEDULE_API_REDESIGN_PLAN.md §4.3):
 *   1. Legacy alias ("sonnet" / "opus") → kind:"alias".
 *   2. Composite form "<backendId>/<modelId>" — opt-in disambiguator.
 *      Only honored when the prefix is exactly one of `BACKEND_IDS`. A
 *      composite token that fails to resolve falls through to "unknown"
 *      (not "ambiguous"); the caller named a specific backend, so an
 *      ambiguous match is impossible by construction. A slash-bearing
 *      token whose prefix is NOT a backend id falls through to the
 *      cross-backend scan — opencode model ids like
 *      `anthropic/claude-opus-4-7` would otherwise be unreachable.
 *   3. Cross-backend exact match in the snapshot:
 *        - exactly one match → kind:"model"
 *        - multiple matches  → kind:"ambiguous" (future-proof; today
 *          unreachable because `claude-opus-4-7` and opencode's
 *          `anthropic/claude-opus-4-7` differ — but the registry is
 *          editable and a future entry could collide).
 *   4. No match → kind:"unknown" with the simplified validValues payload.
 *
 * Pure — relies only on the snapshot argument.
 */
export function validateModelToken(
  token: string,
  snapshot: ModelRegistrySnapshot,
): ValidateModelResult {
  // 1. Legacy alias path.
  if (token === "sonnet" || token === "opus") {
    return { kind: "alias", tierToken: snapshot.modelAliases[token] };
  }

  // 2. Composite-form disambiguation.
  const firstSlash = token.indexOf("/");
  if (firstSlash > 0) {
    const prefix = token.slice(0, firstSlash);
    const rest = token.slice(firstSlash + 1);
    if (isBackendId(prefix) && rest.length > 0) {
      const found = findInSnapshot(snapshot, prefix, rest);
      if (found) {
        return {
          kind: "model",
          backendId: prefix,
          modelId: rest,
          deprecated: found.deprecated,
        };
      }
      // Composite prefix named a real backend but pointed at an
      // unregistered model — surface as unknown (the caller already
      // picked a backend; ambiguous is impossible).
      return { kind: "unknown", validValues: simplifyForUnknownPayload(snapshot) };
    }
    // Prefix did not match a backend id (e.g. "anthropic/claude-opus-4-7"
    // intended for opencode but lacking the explicit "opencode/" prefix).
    // Fall through to the cross-backend scan — `anthropic/...` IS a
    // registered opencode modelId, so step 3 still recognises it.
  }

  // 3. Cross-backend exact match scan.
  const matches: Array<{ backendId: BackendId; modelId: string; deprecated: boolean }> = [];
  for (const backendId of BACKEND_IDS) {
    const found = findInSnapshot(snapshot, backendId, token);
    if (found) {
      matches.push({
        backendId,
        modelId: token,
        deprecated: found.deprecated,
      });
    }
  }

  if (matches.length === 1) {
    const only = matches[0];
    return {
      kind: "model",
      backendId: only.backendId,
      modelId: only.modelId,
      deprecated: only.deprecated,
    };
  }

  if (matches.length > 1) {
    const lite = matches.map(({ backendId, modelId }) => ({ backendId, modelId }));
    const backendList = matches.map((m) => m.backendId).join(", ");
    const first = matches[0];
    return {
      kind: "ambiguous",
      matches: lite,
      validValues: {
        matches: lite,
        hint:
          `Model id matches multiple backends (${backendList}). ` +
          `Specify '<backendId>/<modelId>' form, e.g. ` +
          `'${first.backendId}/${first.modelId}'.`,
      },
    };
  }

  // 4. Unknown.
  return { kind: "unknown", validValues: simplifyForUnknownPayload(snapshot) };
}
