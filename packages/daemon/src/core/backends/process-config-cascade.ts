import type Database from "better-sqlite3";
import type {
  BackendId,
  ProcessKey,
  ProcessModelTier,
} from "@aitne/shared";
import {
  DEFAULT_CLAUDE_HIGH_MODEL,
  DEFAULT_CLAUDE_LITE_MODEL,
  DEFAULT_CLAUDE_MEDIUM_MODEL,
  findRegisteredModel,
  getModelsForBackend,
} from "./model-registry.js";
import { applyBackendBudgetFactor } from "./plan-presets.js";

/**
 * Process-config cascade-write helper (DOCS_QA_DESIGN.md §10.2 Q4 = option B).
 *
 * **Why this exists.** `dashboard.docs_qa` inherits its backend choice
 * from `message.dm`. Rather than teach `BackendRouter.resolveBinding` to
 * read two rows, we materialize the inheritance at *write* time: every
 * write to `process_backend_config(message.dm)` cascades into a
 * matching write on `process_backend_config(dashboard.docs_qa)`.
 *
 * **Why tier-aware.** A naïve copy would re-pin the inheritor to the
 * source's exact `(backend, model)` — which means flipping `message.dm`
 * to Opus would silently re-pin `dashboard.docs_qa` to Opus too, defeating
 * the §10.1 hard medium-tier rule. Instead, we copy `(main_backend,
 * fallback_backend)` and re-resolve `(main_model, fallback_model)` for
 * the inheritor's *own* default tier (`medium` for `dashboard.docs_qa`).
 *
 * **Why skip when `updated_by='user'`.** A user explicitly edited the
 * inheritor's row through the dashboard. We treat that as "manually
 * pinned" — subsequent cascades respect the operator's choice. The seed
 * row in schema.ts uses `updated_by='cascade'` so the FIRST cascade
 * after install actually fires.
 *
 * **Limitation.** Direct SQL writes that bypass this helper will not
 * trigger the cascade. This is acceptable: direct-SQL edits already
 * bypass every other invariant in the codebase. All in-process writers
 * (backends.ts PATCH, plan-presets.ts apply, applyDmPreference) are
 * routed through this helper.
 */

/**
 * Pairs each inheriting ProcessKey with the source it follows. The
 * cascade fires when any write touches a key listed as a value here.
 *
 * Adding a new inheritor: add an entry, decide its tier, and audit the
 * writers (`grep INSERT INTO process_backend_config` outside this file)
 * to confirm they all go through `setProcessBackendConfig`.
 */
export const INHERITANCE_CASCADE_MAP: ReadonlyArray<{
  inheritor: ProcessKey;
  source: ProcessKey;
  /** Tier the inheritor's model is re-resolved for, regardless of source. */
  inheritorTier: ProcessModelTier;
}> = [
  {
    inheritor: "dashboard.docs_qa",
    source: "message.dm",
    inheritorTier: "medium",
  },
];

/**
 * Caps applied to the inheritor row. Independent of the source's caps —
 * `dashboard.docs_qa` is a focused QA panel, not a full DM lane, so it
 * gets a lower budget envelope to bound the worst case if the operator
 * starts asking questions in a tight loop.
 */
const INHERITOR_DEFAULTS: Record<
  ProcessKey,
  { maxTurns: number; maxBudgetUsd: number }
> = {
  "dashboard.docs_qa": { maxTurns: 20, maxBudgetUsd: 0.5 },
};

interface BackendDefaultsRow {
  default_backend: BackendId;
  default_lite_model: string;
  default_medium_model: string;
  default_high_model: string;
}

export interface ProcessConfigWrite {
  processKey: ProcessKey;
  mainBackend: BackendId;
  mainModel: string;
  fallbackBackend: BackendId | null;
  fallbackModel: string | null;
  maxTurns: number;
  maxBudgetUsd: number;
  /** 'user' marks operator-driven edits; 'preset'/'cascade' do not block
   *  future cascades. Match the existing column vocabulary in schema.ts. */
  updatedBy: "user" | "preset" | "cascade" | "system";
}

/**
 * Single chokepoint for `process_backend_config` writes. Performs the
 * upsert, then walks `INHERITANCE_CASCADE_MAP` to mirror the change into
 * any inheriting rows whose `updated_by` is not `'user'`.
 *
 * Returns the list of inheritor process keys that were rewritten. Used
 * by callers and tests to assert cascade behavior.
 */
export function setProcessBackendConfig(
  db: Database.Database,
  write: ProcessConfigWrite,
): { cascaded: ProcessKey[] } {
  upsertRow(db, write);

  const cascaded: ProcessKey[] = [];
  for (const rule of INHERITANCE_CASCADE_MAP) {
    if (rule.source !== write.processKey) continue;

    const existing = readUpdatedBy(db, rule.inheritor);
    if (existing === "user") continue;

    const inheritorMainModel = resolveTierModel(
      db,
      write.mainBackend,
      rule.inheritorTier,
    );
    const inheritorFallbackBackend = write.fallbackBackend;
    const inheritorFallbackModel = inheritorFallbackBackend
      ? resolveTierModel(db, inheritorFallbackBackend, rule.inheritorTier)
      : null;

    // INHERITOR_DEFAULTS covers every entry in INHERITANCE_CASCADE_MAP
    // today; the fallback object literal is forward-defensive for
    // inheritors added to the map without a corresponding defaults entry.
    /* c8 ignore start */
    const rawCaps = INHERITOR_DEFAULTS[rule.inheritor] ?? {
      maxTurns: write.maxTurns,
      maxBudgetUsd: write.maxBudgetUsd,
    };
    /* c8 ignore stop */
    // INHERITOR_DEFAULTS holds Claude-baseline budgets. When the cascade
    // is firing on a non-Claude main backend (e.g., operator pins
    // message.dm to Codex), scale the inheritor's budget the same way
    // resolveDefaultBindingFor does for top-level seeds, so post-hoc-
    // enforced backends get the same headroom.
    const caps = {
      maxTurns: rawCaps.maxTurns,
      maxBudgetUsd: applyBackendBudgetFactor(
        write.mainBackend,
        rule.inheritorTier,
        rawCaps.maxBudgetUsd,
      ),
    };

    upsertRow(db, {
      processKey: rule.inheritor,
      mainBackend: write.mainBackend,
      mainModel: inheritorMainModel,
      fallbackBackend: inheritorFallbackBackend,
      fallbackModel: inheritorFallbackModel,
      maxTurns: caps.maxTurns,
      maxBudgetUsd: caps.maxBudgetUsd,
      updatedBy: "cascade",
    });
    cascaded.push(rule.inheritor);
  }
  return { cascaded };
}

function upsertRow(db: Database.Database, write: ProcessConfigWrite): void {
  db.prepare(
    `INSERT INTO process_backend_config (
       process_key,
       main_backend,
       main_model,
       fallback_backend,
       fallback_model,
       max_turns,
       max_budget_usd,
       updated_by,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(process_key) DO UPDATE SET
       main_backend = excluded.main_backend,
       main_model = excluded.main_model,
       fallback_backend = excluded.fallback_backend,
       fallback_model = excluded.fallback_model,
       max_turns = excluded.max_turns,
       max_budget_usd = excluded.max_budget_usd,
       updated_by = excluded.updated_by,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(
    write.processKey,
    write.mainBackend,
    write.mainModel,
    write.fallbackBackend,
    write.fallbackModel,
    write.maxTurns,
    write.maxBudgetUsd,
    write.updatedBy,
  );
}

function readUpdatedBy(
  db: Database.Database,
  processKey: ProcessKey,
): string | null {
  const row = db
    .prepare(
      "SELECT updated_by FROM process_backend_config WHERE process_key = ?",
    )
    .get(processKey) as { updated_by: string } | undefined;
  return row?.updated_by ?? null;
}

/**
 * Resolve a canonical model id for `(backendId, tier)`. Mirrors the
 * priority chain inside `BackendRouter.resolveDefaultModelId` so cascade
 * writes pick the same model the router would default to if no row
 * existed at all.
 *
 * Priority:
 *   1. `backend_global_defaults` row (when its backend matches AND the
 *      configured default-tier model is actually that tier in the
 *      registry).
 *   2. First registered, available model on (backendId, tier).
 *   3. Hardcoded Claude Sonnet/Opus fallback (only when backend=claude).
 *   4. As a last resort, the source's pinned model — better to keep a
 *      working binding than to write `null` and crash dispatch.
 */
function resolveTierModel(
  db: Database.Database,
  backendId: BackendId,
  tier: ProcessModelTier,
): string {
  const defaults = readDefaults(db);
  if (defaults && defaults.default_backend === backendId) {
    const candidate =
      tier === "high"
        ? defaults.default_high_model
        : tier === "medium"
          ? defaults.default_medium_model
          : defaults.default_lite_model;
    const registered = findRegisteredModel(backendId, candidate);
    if (registered?.tier === tier && registered.available) {
      return candidate;
    }
  }

  const match = getModelsForBackend(backendId).find(
    (m) => m.tier === tier && m.available,
  );
  /* c8 ignore start — every registered BackendId has at least one
     available model per tier in MODEL_REGISTRY today, so `match` is
     always defined when the defaults block falls through. The
     `if (match)` falsy branch and the fallbacks below are
     forward-defensive in case a backend ever drops a tier (e.g.,
     Codex stops shipping lite). Neither can be reached via valid
     BackendId values without module-mocking the registry, which ESM
     blocks. */
  if (match) return match.modelId;

  if (backendId === "claude") {
    return tier === "high"
      ? DEFAULT_CLAUDE_HIGH_MODEL
      : tier === "medium"
        ? DEFAULT_CLAUDE_MEDIUM_MODEL
        : DEFAULT_CLAUDE_LITE_MODEL;
  }

  // Last-resort: any registered model on the backend, regardless of tier.
  // Better than throwing — keeps dispatch functional. The cascade is a
  // best-effort mirror; the backend-router has its own resolution chain.
  const anyModel = getModelsForBackend(backendId)[0]?.modelId;
  return anyModel ?? "";
  /* c8 ignore stop */
}

function readDefaults(db: Database.Database): BackendDefaultsRow | null {
  return (
    (db
      .prepare(
        `SELECT default_backend, default_lite_model, default_medium_model, default_high_model
           FROM backend_global_defaults
          WHERE singleton = 1`,
      )
      .get() as BackendDefaultsRow | undefined) ?? null
  );
}

/**
 * Internal helpers exposed for unit testing. Production code should
 * call `setProcessBackendConfig` instead — these are private to the
 * cascade-write chokepoint.
 */
export const _internals = {
  resolveTierModel,
  readDefaults,
  readUpdatedBy,
};
