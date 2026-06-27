/**
 * Background-task budget envelope — BACKGROUND_TASK_RUNNER_DESIGN.md §6 / §10.1.
 *
 * Pure resolution of the `(modelId, maxTurns, maxBudgetUsd,
 * executeTimeoutMinutes)` envelope for a background-task worker from
 * three inputs:
 *
 *   1. The per-task `tier` (`lite` | `medium` | `high`) — selects the
 *      base turn/budget/timeout envelope.
 *   2. The optional per-task `maxBudgetUsd` override (POST body).
 *   3. The operator-editable `process_backend_config` row for
 *      `process_key='background_task'` (model + caps) — same chokepoint
 *      as browser-task's `loadBrowserTaskBackendBinding`.
 *
 * The worker is Claude-only (it drives the Claude Agent SDK `query()`
 * loop directly, like browser_task). A `process_backend_config` row that
 * pins a non-Claude backend is refused with `backend_misconfigured` so a
 * mis-set `/settings/models` row fails fast rather than silently doing
 * nothing.
 *
 * 100% coverage gate — the I/O (DB read) lives in
 * `loadBackgroundTaskBinding`; this module is the pure arithmetic.
 */

import type { BackgroundTaskTier } from "../../db/background-task-store.js";

/** Fallback model when the `process_backend_config` row is missing or
 *  carries an empty `main_model`. Mirrors the seed default. */
export const BACKGROUND_TASK_FALLBACK_CLAUDE_MODEL = "claude-sonnet-4-6";

export const BACKGROUND_TASK_DEFAULT_TIER: BackgroundTaskTier = "medium";

/** Hard upper bounds. The seed sits well below; the caps give the
 *  operator room to relax via `/settings/models` while pinning a ceiling
 *  no per-task override can blow past. Background tasks are the
 *  long-running surface, so the turn / timeout ceilings are far higher
 *  than browser-task's (60 turns / 5 min) — a deep research or
 *  multi-repo audit legitimately runs for many turns over many minutes. */
export const BACKGROUND_TASK_MAX_TURNS_CAP = 120;
export const BACKGROUND_TASK_MAX_BUDGET_USD_CAP = 15.0;
export const BACKGROUND_TASK_MAX_EXECUTE_TIMEOUT_MINUTES = 120;

export interface BackgroundTaskEnvelope {
  modelId: string;
  maxTurns: number;
  maxBudgetUsd: number;
  executeTimeoutMinutes: number;
}

interface TierEnvelope {
  maxTurns: number;
  maxBudgetUsd: number;
  executeTimeoutMinutes: number;
}

/** Per-tier base envelope. `process_backend_config` overrides
 *  model/turns/budget; the tier is the source of the execute-timeout
 *  (which has no `process_backend_config` column) and the fallback when
 *  the config row is absent. */
const TIER_ENVELOPES: Record<BackgroundTaskTier, TierEnvelope> = {
  lite: { maxTurns: 15, maxBudgetUsd: 0.5, executeTimeoutMinutes: 10 },
  medium: { maxTurns: 40, maxBudgetUsd: 2.0, executeTimeoutMinutes: 30 },
  high: { maxTurns: 80, maxBudgetUsd: 8.0, executeTimeoutMinutes: 60 },
};

export function tierEnvelope(tier: BackgroundTaskTier): TierEnvelope {
  return TIER_ENVELOPES[tier];
}

/** Shape of the operator-editable `process_backend_config` row, already
 *  read from the DB (or null when absent). */
export interface BackgroundTaskProcessConfig {
  mainBackend: string;
  mainModel: string | null;
  maxTurns: number | null;
  maxBudgetUsd: number | null;
}

export interface ResolveEnvelopeInput {
  tier: BackgroundTaskTier | null;
  /** Per-task budget override (POST body). Clamped to the hard cap. */
  maxBudgetUsd: number | null;
  processConfig: BackgroundTaskProcessConfig | null;
}

export type ResolveEnvelopeResult =
  | { ok: true; envelope: BackgroundTaskEnvelope }
  | { ok: false; reason: "backend_misconfigured"; detail: string };

function clampPositive(value: number, cap: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, cap);
}

/**
 * Pure envelope resolution. Branches:
 *   - processConfig present + `mainBackend !== 'claude'` → REFUSE.
 *   - otherwise: model from the config (or fallback); turns from the
 *     config (or tier base), clamped; budget = per-task override ?? config
 *     budget ?? tier base, clamped; timeout from the tier base, clamped.
 */
export function resolveBackgroundTaskEnvelope(
  input: ResolveEnvelopeInput,
): ResolveEnvelopeResult {
  const tier = input.tier ?? BACKGROUND_TASK_DEFAULT_TIER;
  const base = TIER_ENVELOPES[tier];
  const cfg = input.processConfig;

  if (cfg && cfg.mainBackend !== "claude") {
    return {
      ok: false,
      reason: "backend_misconfigured",
      detail: `process_backend_config.main_backend='${cfg.mainBackend}' — background_task drives the Claude Agent SDK directly; refusing to dispatch. Set background_task back to claude in /settings/models.`,
    };
  }

  const modelId =
    cfg && typeof cfg.mainModel === "string" && cfg.mainModel.length > 0
      ? cfg.mainModel
      : BACKGROUND_TASK_FALLBACK_CLAUDE_MODEL;

  const rawTurns =
    cfg && typeof cfg.maxTurns === "number" && Number.isFinite(cfg.maxTurns)
      ? Math.max(1, Math.floor(cfg.maxTurns))
      : base.maxTurns;
  const maxTurns = Math.min(rawTurns, BACKGROUND_TASK_MAX_TURNS_CAP);

  // Per-task override wins, then the operator config, then the tier base.
  const budgetSource =
    input.maxBudgetUsd != null
      ? input.maxBudgetUsd
      : cfg && cfg.maxBudgetUsd != null
        ? cfg.maxBudgetUsd
        : base.maxBudgetUsd;
  const maxBudgetUsd = clampPositive(
    budgetSource,
    BACKGROUND_TASK_MAX_BUDGET_USD_CAP,
    base.maxBudgetUsd,
  );

  const executeTimeoutMinutes = Math.min(
    base.executeTimeoutMinutes,
    BACKGROUND_TASK_MAX_EXECUTE_TIMEOUT_MINUTES,
  );

  return {
    ok: true,
    envelope: { modelId, maxTurns, maxBudgetUsd, executeTimeoutMinutes },
  };
}
