/**
 * `emitMorningRoutineParentAuditRow` — INSERT the parent
 * `agent_actions` row keyed `action_type='routine.morning_routine'`,
 * `result='success'`, with cost / turn sums across Stage A + Stage B.
 *
 * Spec: `docs/design/appendices/morning-routine-optimization.md`
 * §"Daemon-side modules to add" → parent-audit-emitter (⑥b). This row
 * is what `morningRoutineRanToday` in `src/bootstrap/schedule-helpers.ts`
 * reads — the pre-routine gate must keep firing on the exact same
 * `action_type` string after the pipeline split.
 *
 * Phase 2 ships this module unwired; Phase 5 wires it into the
 * orchestrator after Stage A's terminal state lands and after
 * `diagnoseTodayMdState` returns its verdict.
 *
 * Emit gate (the orchestrator could enforce this externally, but the
 * module owns it so caller paths cannot drift):
 *   - Stage A row exists AND `result === 'success'`
 *   - today.md health === 'fresh'
 *   - Stage B success / failure is recorded in `detail` JSON but does
 *     NOT block the emit. The day still "opened" when today.md is good.
 *
 * Failure modes return `{ emitted: false, reason: <stable string> }` so
 * the caller can audit the skip path via `pnpm audit` without parsing
 * a thrown error.
 */

import type Database from "better-sqlite3";

export const PARENT_AUDIT_ACTION_TYPE = "routine.morning_routine";

/** Subset of `agent_actions.result` Stage A / Stage B can land in. */
export type StageActionResult = "success" | "failed" | "partial" | "skipped" | "in_progress";

/** Stage row shape the emitter reads — same shape for A and B. */
export interface StageSummary {
  cost_usd: number | null;
  num_turns: number | null;
  result: StageActionResult;
}

/**
 * today.md health verdict mirrored from `diagnoseTodayMdState`. Kept as a
 * flat string union so this module stays decoupled from the dispatcher;
 * the orchestrator (Phase 5 wiring) is expected to project the existing
 * `TodayMdState = { kind: "fresh" | "missing" | "no_h1_date" | "wrong_date" }`
 * discriminated union (declared in `src/core/dispatcher-scheduled-tasks.ts`)
 * into this flat form before calling the emitter — i.e. `state.kind`.
 * When extending one side, extend the other in the same change.
 */
export type TodayMdHealth = "fresh" | "missing" | "no_h1_date" | "wrong_date";

export interface ParentAuditEmitterInputs {
  /** Routine event's `correlationId`. Stored in `event_id`. */
  correlationId: string;
  /** Stage A action row summary. `null` when the row is missing. */
  stageA: StageSummary | null;
  /** Stage B action row summary. `null` when the row is missing. */
  stageB: StageSummary | null;
  /** today.md health verdict at parent-emit time. */
  todayMdHealth: TodayMdHealth;
  /** Pipeline start time. Stored as `started_at` (UTC ISO). */
  startedAt: Date;
  /** Pipeline completion time. Stored as `completed_at` (UTC ISO). */
  completedAt: Date;
  /**
   * Optional explicit backend label. Passes through to the row's
   * `backend` column so observability tooling can attribute the
   * routine to a backend. Omit when unknown.
   */
  backend?: string;
}

export type ParentAuditEmitResult =
  | { emitted: true; insertedId: number }
  | { emitted: false; reason: ParentAuditSkipReason };

/**
 * Stable reasons a parent audit emit can be skipped. The orchestrator
 * forwards these to its own audit channel; the strings are part of
 * the public contract so don't rename without coordinating with the
 * gate-side regression tests.
 */
export type ParentAuditSkipReason =
  | "stage_a_row_missing"
  | "stage_a_not_success"
  | "today_md_missing"
  | "today_md_no_h1_date"
  | "today_md_wrong_date";

export function emitMorningRoutineParentAuditRow(
  db: Database.Database,
  inputs: ParentAuditEmitterInputs,
): ParentAuditEmitResult {
  if (inputs.stageA === null) {
    return { emitted: false, reason: "stage_a_row_missing" };
  }
  if (inputs.stageA.result !== "success") {
    return { emitted: false, reason: "stage_a_not_success" };
  }
  if (inputs.todayMdHealth !== "fresh") {
    return { emitted: false, reason: todayMdHealthToReason(inputs.todayMdHealth) };
  }

  const stageACost = numericOrZero(inputs.stageA.cost_usd);
  const stageBCost = numericOrZero(inputs.stageB?.cost_usd);
  const stageATurns = numericOrZero(inputs.stageA.num_turns);
  const stageBTurns = numericOrZero(inputs.stageB?.num_turns);
  const totalCost = round6(stageACost + stageBCost);
  const totalTurns = stageATurns + stageBTurns;
  const durationMs = Math.max(0, inputs.completedAt.getTime() - inputs.startedAt.getTime());

  // The parent row is a roll-up marker — its existence is what the
  // pre-routine gate reads. The cost / turns the user actually paid live
  // on the Stage A / Stage B `agent_actions` rows
  // (`action_type=routine.morning_routine_today` / `..._journal`), which
  // the orchestrator writes via `processResult` per stage. Carrying the
  // sum on this row too would double-count against
  // `autonomousDailyCostCapUsd`'s `SUM(cost_usd)` query — so we ZERO the
  // numeric columns and keep the per-stage sums + aggregate in `detail`
  // for observability (`pnpm audit`, dashboard cost-attribution UI).
  const detail = {
    stageA: summariseStage(inputs.stageA),
    stageB: inputs.stageB === null ? null : summariseStage(inputs.stageB),
    todayMdHealth: inputs.todayMdHealth,
    totalCostUsd: totalCost,
    totalNumTurns: totalTurns,
  };

  const result = db
    .prepare(
      `INSERT INTO agent_actions
         (event_id, action_type, trigger, result, cost_usd, num_turns,
          duration_ms, started_at, completed_at, detail, backend)
       VALUES (?, ?, 'autonomous', 'success', 0, 0, ?, ?, ?, json(?), ?)`,
    )
    .run(
      inputs.correlationId,
      PARENT_AUDIT_ACTION_TYPE,
      durationMs,
      toSqliteDatetime(inputs.startedAt),
      toSqliteDatetime(inputs.completedAt),
      JSON.stringify(detail),
      inputs.backend ?? null,
    );

  const insertedId = Number(result.lastInsertRowid);
  return { emitted: true, insertedId };
}

function todayMdHealthToReason(health: TodayMdHealth): ParentAuditSkipReason {
  switch (health) {
    case "missing":
      return "today_md_missing";
    case "no_h1_date":
      return "today_md_no_h1_date";
    case "wrong_date":
      return "today_md_wrong_date";
    // Exhaustiveness guard. The caller fast-paths `fresh` to the
    // INSERT branch before this function fires; the `case` exists
    // only to make TypeScript's exhaustive switch force a compile-
    // time decision when a new `TodayMdHealth` value lands.
    /* c8 ignore start */
    case "fresh":
      throw new Error(
        "emitMorningRoutineParentAuditRow: 'fresh' should have been gated above",
      );
    /* c8 ignore stop */
  }
}

function summariseStage(stage: StageSummary): {
  result: StageActionResult;
  cost_usd: number;
  num_turns: number;
} {
  return {
    result: stage.result,
    cost_usd: numericOrZero(stage.cost_usd),
    num_turns: numericOrZero(stage.num_turns),
  };
}

function numericOrZero(value: number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (!Number.isFinite(value)) return 0;
  return value;
}

/**
 * Round to 6 decimals so `0.1 + 0.2`-style floating point noise does
 * not leak into the audit row. Six places is finer than the per-stage
 * cost precision (~4 places) and survives a JSON round-trip.
 */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Format a Date as the `YYYY-MM-DD HH:MM:SS` shape SQLite's `datetime()`
 * function produces. Stored in UTC because every other agent_actions
 * row in the daemon uses `datetime('now')` which is UTC.
 */
function toSqliteDatetime(date: Date): string {
  const iso = date.toISOString();
  // `YYYY-MM-DDTHH:MM:SS.sssZ` → `YYYY-MM-DD HH:MM:SS`.
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}
