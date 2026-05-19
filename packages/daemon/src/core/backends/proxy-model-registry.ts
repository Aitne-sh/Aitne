import type Database from "better-sqlite3";
import type { BackendId, BackendModel } from "@aitne/shared";
import {
  findRegisteredModel,
  getModelsForBackend,
  latestLiteFor,
} from "./model-registry.js";

/**
 * Helpers backing `delegatedModel` validation + resolution per
 * DELEGATED-PROXY-API-DESIGN.md §4.2 / §6.1.
 *
 * Two callers care about "is this model name reachable for that backend":
 *   - `PATCH /api/integrations/:key` validates user input and returns the
 *     `unknown_model` 400 envelope when the value is rejected.
 *   - `DelegatedBackendInvoker.resolveModel` falls back to the canonical
 *     light-tier model when a previously-pinned value goes stale after a
 *     `delegatedBackend` swap (silent drop — the dashboard surfaces a
 *     "Reset to default" affordance).
 *
 * Both treat the registry as the source of truth, with one escape hatch:
 * a model id pinned by the user inside `process_backend_config` for the
 * same backend is also accepted, even if not in the static registry.
 * That mirrors `BackendRouter.maybeApplyTierOverride`'s "don't clobber
 * custom pins" trust principle.
 */

/**
 * Return the union of (registered models for `backendId`) ∪ (any
 * `process_backend_config.main_model` / `fallback_model` value the user
 * has pinned against this same backend). Sorted alphabetically so dashboard
 * dropdowns + 400 envelopes have a stable order.
 *
 * Custom pins surface here so a user who has `process_backend_config(message.dm).main_model = "claude-opus-4-7-pinned-build"`
 * can also use that string for `delegatedModel` without hitting an
 * `unknown_model` 400.
 */
export function knownProxyModels(
  db: Database.Database,
  backendId: BackendId,
): readonly string[] {
  const models = new Set<string>();
  for (const m of getModelsForBackend(backendId)) {
    models.add(m.modelId);
  }
  // process_backend_config may not exist on a fresh install before the
  // schema-applier runs — guard with a try/catch and fall back to the
  // registry-only set. (The schema is idempotent on every boot, so in
  // practice this catch is reached only when the daemon is mid-init.)
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT main_backend AS backend, main_model AS model
           FROM process_backend_config
          WHERE main_model IS NOT NULL
         UNION
         SELECT DISTINCT fallback_backend AS backend, fallback_model AS model
           FROM process_backend_config
          WHERE fallback_model IS NOT NULL`,
      )
      .all() as { backend: string | null; model: string | null }[];
    for (const row of rows) {
      if (row.backend === backendId && row.model) {
        models.add(row.model);
      }
    }
    /* c8 ignore start — best-effort fall-through for minimal DBs without
       process_backend_config; registry-only validation still works. */
  } catch {
    // Best-effort: ignore lookup errors — registry-only validation is
    // still meaningful and tests that build minimal DBs do not always
    // create process_backend_config.
  }
  /* c8 ignore stop */
  return [...models].sort();
}

/**
 * Convenience for the PATCH validator: returns true if the proposed
 * `delegatedModel` value would resolve at call time. Mirrors the v0.1
 * trust contract — best-effort, with the registry as the primary source.
 */
export function proxyModelIsKnown(
  db: Database.Database,
  backendId: BackendId,
  modelId: string,
): boolean {
  if (findRegisteredModel(backendId, modelId) !== undefined) return true;
  return knownProxyModels(db, backendId).includes(modelId);
}

/**
 * DELEGATED-TASK-MODE-DESIGN.md §8.1 — return the user's
 * `process_backend_config.main_model` for the given ProcessKey **only if**
 * the row's `main_backend` matches the active delegated backend. The
 * delegated backend is determined by the integration's `delegatedBackend`,
 * not by the process row, so we ignore the row's `main_backend` field
 * for binding purposes — but we honor its `main_model` pin when the user
 * has explicitly customised the model for this ProcessKey on this backend.
 *
 * Returns `null` when no row exists, the row pins a different backend,
 * or the pinned model is no longer reachable for the backend (registry
 * + custom-pin set). Callers fall through to canonical resolution.
 *
 * Usable for any ProcessKey, but the design's primary consumers are
 * `delegated_task` and `delegated_task_heavy`. Best-effort against fresh-
 * install DBs without the table.
 */
export function resolveProcessKeyModel(
  db: Database.Database,
  processKey: string,
  backendId: BackendId,
): string | null {
  try {
    const row = db
      .prepare(
        `SELECT main_backend, main_model
           FROM process_backend_config
          WHERE process_key = ?`,
      )
      .get(processKey) as
      | { main_backend: string | null; main_model: string | null }
      | undefined;
    if (!row) return null;
    if (row.main_backend !== backendId) return null;
    if (!row.main_model) return null;
    /* c8 ignore start — defensive: any row that satisfies main_backend === backendId
       AND main_model truthy is itself the source `knownProxyModels` reads, so this
       guard is unreachable from natural flow. Kept as defense-in-depth in case the
       registry/known-set semantics diverge in future. */
    if (!proxyModelIsKnown(db, backendId, row.main_model)) return null;
    /* c8 ignore stop */
    return row.main_model;
    /* c8 ignore start — defensive: schema-applier or fresh-install paths
       that don't carry process_backend_config. */
  } catch {
    return null;
  }
  /* c8 ignore stop */
}

/**
 * Canonical lite-tier model id for `backendId`. Returns `null` when the
 * registry lists no lite-tier model for the backend (the route-handler
 * caller falls through to the first available model in that case).
 *
 * Resolution order:
 *   1. `backend_global_defaults.default_lite_model` — but only when the
 *      target backend matches the row's `default_backend` AND the
 *      configured model is registered as lite + available. The
 *      backend-match guard prevents a Codex `default_lite_model` value
 *      from leaking into a Claude proxy call after a main-backend swap.
 *   2. First registered, available lite-tier model for the backend.
 *   3. `null` — caller surfaces a "no canonical" hint.
 *
 * Delegated proxy calls (`DelegatedBackendInvoker`) want the cheapest
 * model that fits the connector's tool-call shape. Reading the lite slot
 * here means: Claude → Haiku, Codex → gpt-5.4-mini, Gemini → flash-lite.
 * Operators who want to override per-integration use the `delegatedModel`
 * field on `IntegrationState`; per-backend overrides happen by editing
 * `backend_global_defaults.default_lite_model` from the dashboard.
 */
export function resolveCanonicalDelegatedModel(
  backendId: BackendId,
  db: Database.Database | null = null,
): string | null {
  if (db) {
    try {
      const row = db
        .prepare(
          `SELECT default_backend, default_lite_model
             FROM backend_global_defaults
            WHERE singleton = 1`,
        )
        .get() as
        | { default_backend: string | null; default_lite_model: string | null }
        | undefined;
      if (
        row?.default_backend === backendId
        && row?.default_lite_model
      ) {
        const registered = findRegisteredModel(backendId, row.default_lite_model);
        if (registered?.tier === "lite" && registered.available) {
          return row.default_lite_model;
        }
      }
      /* c8 ignore start — defensive: schema-applier or fresh-install paths
         that don't carry backend_global_defaults. */
    } catch {
      // Best-effort: schema-applier may not have run yet, or the row may
      // be absent on a fresh install. Fall through to the registry pick.
    }
    /* c8 ignore stop */
  }
  return latestLiteFor(backendId);
}

/**
 * @deprecated Renamed to `resolveCanonicalDelegatedModel` and reoriented
 * around the lite tier. Existing call sites should migrate; this alias
 * exists only to soften the rename inside the daemon while the dashboard
 * + tests catch up.
 */
export const resolveCanonicalProxyModel = resolveCanonicalDelegatedModel;

/**
 * Per-model preset entries for the dashboard's "model" dropdown in the
 * delegated-mode card. Returns the registered light-tier models first,
 * then heavy-tier (so heavy variants can also be picked when a user
 * deliberately wants a smarter proxy). Each entry includes the per-token
 * pricing fields the IntegrationCard uses for its "estimated cost / call"
 * chip — keeping them on the daemon side avoids the dashboard hard-coding
 * a stale price list.
 */
export interface ProxyModelOption {
  modelId: string;
  displayName: string;
  tier: BackendModel["tier"];
  deprecated: boolean;
  /**
   * USD / 1k input tokens (lower-tier branch when the model has a
   * context-tier pricing split). `null` when the registry doesn't have
   * pricing data for the model — the dashboard hides the cost chip in
   * that case rather than rendering 0 / undefined.
   */
  usdPer1kIn: number | null;
  /** USD / 1k output tokens (lower-tier branch). */
  usdPer1kOut: number | null;
}

export function listProxyModelOptions(
  backendId: BackendId,
): ProxyModelOption[] {
  const models = getModelsForBackend(backendId).filter((m) => m.available);
  // lite → medium → high so the dashboard's default canonical pick (lite)
  // sits at the top of the dropdown without a separate sort pass.
  const order: Record<BackendModel["tier"], number> = { lite: 0, medium: 1, high: 2 };
  return [...models]
    .sort((a, b) => order[a.tier] - order[b.tier])
    .map((m) => ({
      modelId: m.modelId,
      /* c8 ignore start — registry seed always supplies displayName +
         pricing for the published models, so the `??` fallbacks are
         defensive normalization for future entries. */
      displayName: m.displayName ?? m.label ?? m.modelId,
      tier: m.tier,
      deprecated: m.deprecated === true,
      usdPer1kIn: m.usdPer1kIn ?? null,
      usdPer1kOut: m.usdPer1kOut ?? null,
      /* c8 ignore stop */
    }));
}
