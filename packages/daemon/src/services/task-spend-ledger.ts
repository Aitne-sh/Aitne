/**
 * Detached-worker spend ledger — one `agent_actions` row per driver leg.
 *
 * The background/browser drivers have always COMPUTED a per-run `costUsd`
 * (summed from the SDK's `total_cost_usd`), and the runners then discarded
 * it: no cost column on the task row, no `agent_actions` row — so detached
 * workers were invisible on `GET /cost`, the canonical spend surface that
 * reads ONLY `agent_actions` (the tier-2 cost-audit hole). The runners now
 * call this once per driver leg (park included — a parked task has already
 * spent its leg), pairing the task-row rollup (`addBackgroundTaskCost` /
 * `addBrowserTaskCost`, migration 0022) with this per-run ledger row.
 *
 * Ledger shape mirrors `delegated-invoker-audit.ts`: `datetime(@iso)`
 * coerces ISO-8601 into SQLite's canonical format so the row sorts with
 * `datetime('now')` rows; `cost_source='sdk'` tags the number's origin;
 * `source_kind`/`source_ref` carry the owning task for provenance joins.
 * Best-effort: a ledger failure must never fail the task reconcile.
 */

import type Database from "better-sqlite3";
import { createLogger } from "../logging.js";

const logger = createLogger("task-spend-ledger");

export type TaskSpendKind = "background_task" | "browser_task";

/** Leg outcome in `agent_actions.result` vocabulary: a completed run is
 *  `success`, a park (clarification) is `partial` — the leg ended but the
 *  task continues — an owner cancel is `skipped` (spent, but not a
 *  failure), and every fail-loud terminal is `failed`. */
export type TaskSpendResult = "success" | "failed" | "partial" | "skipped";

export interface TaskRunSpendInput {
  taskKind: TaskSpendKind;
  taskId: string;
  result: TaskSpendResult;
  /** USD this leg spent (driver-accumulated `total_cost_usd`). */
  costUsd: number;
  numTurns: number;
  durationMs: number;
  /** Epoch ms the leg ended; `started_at` is derived via `durationMs`. */
  completedAt: number;
  /** Model the leg ran under (`DriverRunResult.modelId`) — without it the
   *  /cost by-model split undercounts worker spend vs the headline total. */
  modelUsed: string | null;
}

/**
 * Record one driver leg in the spend ledger. Skips the no-spend bails
 * (`task_missing`, driver-unavailable synthetics: cost 0, turns 0) so a
 * bail never fabricates a ledger row; a genuine 0-cost run with turns is
 * still recorded (turns are telemetry even when the SDK bills nothing).
 */
export function recordTaskRunSpend(
  db: Database.Database,
  input: TaskRunSpendInput,
): void {
  if (!(input.costUsd > 0) && !(input.numTurns > 0)) return;
  try {
    // backend is 'claude' by construction: both task drivers import the
    // claude SDK's query() directly (never the BackendRouter) and bail with
    // backend_misconfigured BEFORE running under any other main backend — a
    // leg that spent anything was a claude leg. `trigger` stays NULL
    // DELIBERATELY: the dispatcher's autonomous daily cost cap sums
    // `trigger = 'autonomous'` rows, and worker spend is already bounded by
    // its own per-task envelope (tier / max_budget_usd) — stamping it would
    // double-gate the same dollars.
    db.prepare(
      `INSERT INTO agent_actions (
         action_type, model_used, cost_usd, duration_ms, num_turns, result,
         started_at, completed_at, source_kind, source_ref, backend, cost_source
       ) VALUES (
         @action_type, @model_used, @cost_usd, @duration_ms, @num_turns, @result,
         datetime(@started_at), datetime(@completed_at),
         @source_kind, @source_ref, 'claude', 'sdk'
       )`,
    ).run({
      action_type: `${input.taskKind}.run`,
      model_used: input.modelUsed,
      cost_usd: input.costUsd,
      duration_ms: input.durationMs,
      num_turns: input.numTurns,
      result: input.result,
      started_at: new Date(input.completedAt - input.durationMs).toISOString(),
      completed_at: new Date(input.completedAt).toISOString(),
      source_kind: input.taskKind,
      source_ref: input.taskId,
    });
  } catch (err) {
    logger.error(
      { err, taskId: input.taskId, taskKind: input.taskKind },
      "failed to record task-run spend (continuing — ledger is best-effort)",
    );
  }
}
