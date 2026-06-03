import type Database from "better-sqlite3";
import { getAgentDayDateStr } from "@aitne/shared";

import {
  completeExecution,
  getExecution,
  startExecution,
  sweepAbandoned as sweepAbandonedRows,
  type CompleteExecutionInput,
  type StartExecutionInput,
  type SweepAbandonedResult,
} from "../db/agent-executions-store.js";
import { disableOneShotAfterFire, setLastExecutionId } from "../db/agents-store.js";

/**
 * Per-firing execution recorder (AGENT_DEFINITIONS_DESIGN.md §8.2 / §7.4).
 *
 * A thin lifecycle wrapper over the Phase-2 `agent-executions-store.ts` (which
 * owns the raw `agent_executions` SQL). The store is a faithful column writer
 * and intentionally does NOT know about two things the recorder adds:
 *
 *   1. **The agent-day `{date}` label**, computed once at `start` and pinned to
 *      the execution's `started_at` instant. Pinning at start (not at eval
 *      time) matters: a long routine that begins at 03:55 and finishes at 04:05
 *      must still evaluate its `{date}`-keyed criteria against the agent-day it
 *      *started* in, not the one the 04:00 boundary rolled into mid-run. The
 *      label is returned in the `StartedExecution` handle and threaded into
 *      success-criteria evaluation by the dispatcher (§8.3) — it is derivable
 *      from `started_at` so it is intentionally not persisted.
 *   2. **The same-transaction `agents.last_execution_id` update** at `complete`,
 *      so a dashboard read can never observe a finished execution whose owning
 *      Agent still points at the previous run.
 *
 * Synchronous by design: better-sqlite3 is synchronous and every store function
 * is too, so the original Promise-returning design sketch was an artifact (the
 * design doc §8.2 was reconciled to the shipped sync interface).
 */

/** Constructor dependencies. `now`/`timezone` are injectable for tests. */
export interface AgentExecutionRecorderDeps {
  db: Database.Database;
  /** IANA zone (config.timezone). `undefined` → host system zone. */
  timezone?: string;
  /** Agent-day boundary hour (config.dayBoundaryHour; 4 in production). */
  dayBoundaryHour: number;
  /** Epoch-ms clock; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Handle returned by `start`. The dispatcher holds it for the run's duration and
 * threads `dateStr` / `startedAt` (with the resolved `agentId`) into the
 * success-criteria evaluator at completion (§8.3).
 */
export interface StartedExecution {
  /** New `agent_executions.id`. */
  executionId: number;
  /** Epoch-ms start instant — identical to the persisted `started_at`. */
  startedAt: number;
  /** Agent-day `YYYY-MM-DD` label pinned to `startedAt`, reused per criterion. */
  dateStr: string;
}

export class AgentExecutionRecorder {
  private readonly db: Database.Database;
  private readonly timezone?: string;
  private readonly dayBoundaryHour: number;
  private readonly now: () => number;

  constructor(deps: AgentExecutionRecorderDeps) {
    this.db = deps.db;
    this.timezone = deps.timezone;
    this.dayBoundaryHour = deps.dayBoundaryHour;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Open a new in-flight execution: INSERT a row with `result = NULL` and
   * compute the agent-day label once. The `agent_id` FK requires the Agent row
   * to already exist (the loader upserts it at boot / the API at create-time).
   */
  start(input: StartExecutionInput): StartedExecution {
    const startedAt = this.now();
    const executionId = startExecution(this.db, input, startedAt);
    const dateStr = getAgentDayDateStr(
      this.timezone,
      this.dayBoundaryHour,
      new Date(startedAt),
    );
    return { executionId, startedAt, dateStr };
  }

  /**
   * Finalise an execution and re-point `agents.last_execution_id` at it, both
   * inside a single transaction (§7.4). The owning slug is read back from the
   * just-updated row — the FK is the single source of truth, so the caller
   * cannot mis-attribute the pointer. `last_execution_id` is updated for every
   * terminal result (success, error, timeout, skipped) so the dashboard's
   * "last run" reflects failures too. Returns false when no row matched the id
   * (nothing is updated in that case).
   */
  complete(input: CompleteExecutionInput): boolean {
    const stamp = this.now();
    const apply = this.db.transaction((): boolean => {
      const changed = completeExecution(this.db, input, stamp);
      if (!changed) return false;
      // changed === true ⇒ the UPDATE matched, so the row is present.
      const row = getExecution(this.db, input.executionId)!;
      setLastExecutionId(this.db, row.agentId, input.executionId, stamp);
      // §16 Q8: a one_shot Agent disables itself once it has fired, becoming a
      // re-runnable record (run-now re-fires it). No-op for cron / event Agents.
      disableOneShotAfterFire(this.db, row.agentId, stamp);
      return true;
    });
    return apply();
  }

  /**
   * Boot-time crash janitor (§7.4): flip every still-in-flight row started
   * before `beforeTs` (the daemon boot instant) to `error / crash`. Delegates
   * to the store so the recorder is the single start/complete/sweep lifecycle
   * surface the daemon wires (Phase 7 `bootstrap/db.ts`).
   */
  sweepAbandoned(beforeTs: number): SweepAbandonedResult {
    return sweepAbandonedRows(this.db, beforeTs, this.now());
  }
}
