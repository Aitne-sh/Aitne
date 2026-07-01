import type Database from "better-sqlite3";

/**
 * Agent executions store — the per-firing rollup layer
 * (AGENT_DEFINITIONS_DESIGN.md §5.2 / §7.4). One row per fired Execution:
 * inserted at start (`result = NULL`), updated at completion, and force-closed
 * by the boot-time janitor if a crash leaves it non-terminal.
 *
 * This module is the persistence layer the Phase-6 recorder
 * (`core/agent-execution-recorder.ts`) wraps — the recorder owns agent-day
 * stamping and the same-transaction `agents.last_execution_id` update; this
 * store owns the raw `agent_executions` SQL.
 *
 * Timestamps (`started_at` / `ended_at`) are epoch-millisecond integers, so
 * the metrics windows are plain `now - days * 86_400_000` cutoffs and the
 * crash janitor compares against `daemon_boot_time` directly (§5.1 note).
 */

export type AgentExecutionTrigger = "cron" | "manual" | "event" | "self";
export type AgentExecutionResult = "success" | "error" | "skipped" | "timeout";

/** Raw row as stored in SQLite. */
export interface AgentExecutionRow {
  id: number;
  agent_id: string;
  schedule_row_id: number | null;
  trigger: AgentExecutionTrigger;
  started_at: number;
  ended_at: number | null;
  result: AgentExecutionResult | null;
  error_kind: string | null;
  error_message: string | null;
  cost_usd: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  turns: number | null;
  success_criteria_json: string | null;
  output_summary: string | null;
  metadata_json: string;
}

/** Parsed, camelCase view returned to callers. */
export interface AgentExecutionDTO {
  id: number;
  agentId: string;
  scheduleRowId: number | null;
  trigger: AgentExecutionTrigger;
  startedAt: number;
  endedAt: number | null;
  result: AgentExecutionResult | null;
  errorKind: string | null;
  errorMessage: string | null;
  costUsd: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  turns: number | null;
  /** Per-criterion hit map; `null` until the criteria are evaluated. */
  successCriteria: Record<string, boolean> | null;
  outputSummary: string | null;
}

export interface StartExecutionInput {
  agentId: string;
  scheduleRowId?: number | null;
  trigger: AgentExecutionTrigger;
}

export interface ExecutionCost {
  usd?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  turns?: number | null;
}

export interface CompleteExecutionInput {
  executionId: number;
  result: AgentExecutionResult;
  errorKind?: string | null;
  errorMessage?: string | null;
  cost?: ExecutionCost;
  successCriteriaHits?: Record<string, boolean>;
  outputSummary?: string | null;
}

export interface ListExecutionsOptions {
  /** Max rows (default 25). */
  limit?: number;
  /** Keyset cursor — return rows with `id < before`. */
  before?: number;
  /** Filter by terminal result. */
  result?: AgentExecutionResult;
}

/** Per-window metrics (§9.1 / §9.2). */
export interface AgentMetricsWindow {
  /** Rows fired in the window (any result, incl. in-flight). */
  executions: number;
  /** errors / terminal rows; 0 when there are no terminal rows. */
  errorRate: number;
  /** Mean `cost_usd` over rows that recorded one; null when none did. */
  avgCostUsd: number | null;
  /** Σtrue / Σtotal across recorded criteria maps; null when none recorded. */
  criteriaHitRate: number | null;
  /**
   * p95 of (ended-started)/1000 over completed rows; null when none.
   * Crash-swept rows (`error_kind = 'crash'`) are EXCLUDED: their `ended_at`
   * is the daemon's boot instant stamped by `sweepAbandoned`, not the real
   * runtime, so a long daemon outage would otherwise inflate the percentile
   * with a fictional multi-hour/day "duration". They still count toward
   * `errorRate` (they are genuine failures) — only the duration sample drops
   * them.
   */
  p95DurationSeconds: number | null;
}

export interface SweepAbandonedResult {
  count: number;
  ids: number[];
}

const DAY_MS = 86_400_000;

function parseSuccessCriteria(
  json: string | null,
): Record<string, boolean> | null {
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(parsed)) {
        out[key] = value === true;
      }
      return out;
    }
  } catch {
    /* fall through to {} */
  }
  return {};
}

function rowToDTO(row: AgentExecutionRow): AgentExecutionDTO {
  return {
    id: row.id,
    agentId: row.agent_id,
    scheduleRowId: row.schedule_row_id,
    trigger: row.trigger,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    result: row.result,
    errorKind: row.error_kind,
    errorMessage: row.error_message,
    costUsd: row.cost_usd,
    tokensInput: row.tokens_input,
    tokensOutput: row.tokens_output,
    turns: row.turns,
    successCriteria: parseSuccessCriteria(row.success_criteria_json),
    outputSummary: row.output_summary,
  };
}

// ── Lifecycle writes ──────────────────────────────────────────────────

/**
 * Insert a new in-flight Execution (`result = NULL`). Returns the new id.
 * The `agent_id` FK requires the Agent row to already exist — the recorder
 * always upserts the Agent first.
 */
export function startExecution(
  db: Database.Database,
  input: StartExecutionInput,
  now: number = Date.now(),
): number {
  const result = db
    .prepare(
      `INSERT INTO agent_executions
         (agent_id, schedule_row_id, trigger, started_at, result)
       VALUES (?, ?, ?, ?, NULL)`,
    )
    .run(input.agentId, input.scheduleRowId ?? null, input.trigger, now);
  return Number(result.lastInsertRowid);
}

/**
 * Finalise an Execution row with its result, cost, criteria, and summary.
 * Returns true when a row matched the id. Does NOT touch
 * `agents.last_execution_id` — the recorder pairs this with
 * `agents-store.setLastExecutionId` in one transaction (§8.2).
 */
export function completeExecution(
  db: Database.Database,
  input: CompleteExecutionInput,
  now: number = Date.now(),
): boolean {
  const cost = input.cost ?? {};
  const result = db
    .prepare(
      `UPDATE agent_executions SET
          ended_at = ?,
          result = ?,
          error_kind = ?,
          error_message = ?,
          cost_usd = ?,
          tokens_input = ?,
          tokens_output = ?,
          turns = ?,
          success_criteria_json = ?,
          output_summary = ?
        WHERE id = ?`,
    )
    .run(
      now,
      input.result,
      input.errorKind ?? null,
      input.errorMessage ?? null,
      cost.usd ?? null,
      cost.tokensIn ?? null,
      cost.tokensOut ?? null,
      cost.turns ?? null,
      input.successCriteriaHits !== undefined
        ? JSON.stringify(input.successCriteriaHits)
        : null,
      input.outputSummary ?? null,
      input.executionId,
    );
  return result.changes > 0;
}

/**
 * Boot-time crash janitor (§7.4). Flips every still-in-flight row whose
 * `started_at` predates `beforeTs` (the daemon boot instant) to
 * `error / crash`, stamping `ended_at = now`. Returns the affected ids so the
 * caller can surface an audit line. Idempotent: a second call finds nothing
 * left non-terminal.
 */
export function sweepAbandoned(
  db: Database.Database,
  beforeTs: number,
  now: number = Date.now(),
): SweepAbandonedResult {
  const sweep = db.transaction((): number[] => {
    const rows = db
      .prepare<[number], { id: number }>(
        "SELECT id FROM agent_executions WHERE result IS NULL AND started_at < ?",
      )
      .all(beforeTs);
    if (rows.length === 0) return [];
    db.prepare(
      `UPDATE agent_executions
          SET result = 'error', error_kind = 'crash', ended_at = ?
        WHERE result IS NULL AND started_at < ?`,
    ).run(now, beforeTs);
    return rows.map((r) => r.id);
  });
  const ids = sweep();
  return { count: ids.length, ids };
}

// ── Reads ────────────────────────────────────────────────────────────

export function getExecution(
  db: Database.Database,
  id: number,
): AgentExecutionDTO | null {
  const row = db
    .prepare<[number], AgentExecutionRow>(
      "SELECT * FROM agent_executions WHERE id = ?",
    )
    .get(id);
  return row ? rowToDTO(row) : null;
}

/**
 * Every Agent's most recent COMPLETED execution, keyed by slug — one scan of
 * the denormalised `agents.last_execution_id` pointers (kept in sync by the
 * recorder, §8.2). Feeds the Task Board's `lastResult`/`lastRunAt` projection
 * without a per-agent query fan-out.
 */
export function listLastExecutionsByAgent(
  db: Database.Database,
): Map<string, AgentExecutionDTO> {
  const rows = db
    .prepare(
      `SELECT e.*
         FROM agents a
         JOIN agent_executions e ON e.id = a.last_execution_id`,
    )
    .all() as AgentExecutionRow[];
  return new Map(rows.map((row) => [row.agent_id, rowToDTO(row)]));
}

/**
 * Slugs of Agents with an execution currently IN FLIGHT (`result IS NULL` —
 * opened by `startExecution`, closed by `completeExecution` or the boot
 * janitor). Feeds the Task Board's `running` status.
 */
export function listInFlightAgentIds(db: Database.Database): Set<string> {
  const rows = db
    .prepare(
      "SELECT DISTINCT agent_id FROM agent_executions WHERE result IS NULL",
    )
    .all() as Array<{ agent_id: string }>;
  return new Set(rows.map((r) => r.agent_id));
}

/**
 * Paginated execution history for one Agent, newest first (§9.3). `before` is
 * a keyset cursor on `id`; `result` filters by terminal state.
 */
export function listExecutions(
  db: Database.Database,
  agentId: string,
  opts: ListExecutionsOptions = {},
): AgentExecutionDTO[] {
  const limit = opts.limit ?? 25;
  const where = ["agent_id = ?"];
  const params: Array<string | number> = [agentId];
  if (opts.before !== undefined) {
    where.push("id < ?");
    params.push(opts.before);
  }
  if (opts.result !== undefined) {
    where.push("result = ?");
    params.push(opts.result);
  }
  const rows = db
    .prepare(
      `SELECT * FROM agent_executions
        WHERE ${where.join(" AND ")}
        ORDER BY id DESC
        LIMIT ?`,
    )
    .all(...params, limit) as AgentExecutionRow[];
  return rows.map(rowToDTO);
}

// ── Metrics ──────────────────────────────────────────────────────────

/** Columns the metrics reducers need — one index scan, reduced in JS. */
interface MetricsRow {
  result: AgentExecutionResult | null;
  error_kind: string | null;
  cost_usd: number | null;
  started_at: number;
  ended_at: number | null;
  success_criteria_json: string | null;
}

/** Nearest-rank p95 over a non-empty ascending-sortable sample. */
function p95(samples: number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[rank - 1];
}

/**
 * Rollup metrics over the trailing `days` window (§9.1 / §9.2). All derived
 * fields are computed in JS over a single `(agent_id, started_at DESC)` index
 * scan so the math (error_rate, avg_cost, criteria_hit_rate, p95) stays
 * unit-testable without SQL fixtures.
 */
export function metricsWindow(
  db: Database.Database,
  agentId: string,
  days: number,
  now: number = Date.now(),
): AgentMetricsWindow {
  const cutoff = now - days * DAY_MS;
  const rows = db
    .prepare<[string, number], MetricsRow>(
      `SELECT result, error_kind, cost_usd, started_at, ended_at, success_criteria_json
         FROM agent_executions
        WHERE agent_id = ? AND started_at >= ?`,
    )
    .all(agentId, cutoff);

  let terminal = 0;
  let errors = 0;
  let costSum = 0;
  let costCount = 0;
  let criteriaTrue = 0;
  let criteriaTotal = 0;
  const durations: number[] = [];

  for (const row of rows) {
    if (row.result !== null) {
      terminal += 1;
      if (row.result === "error") errors += 1;
    }
    if (row.cost_usd !== null) {
      costSum += row.cost_usd;
      costCount += 1;
    }
    // Exclude crash-swept rows: their ended_at is the boot instant, not the
    // real runtime, and would inflate the percentile (see p95DurationSeconds).
    if (row.ended_at !== null && row.error_kind !== "crash") {
      durations.push((row.ended_at - row.started_at) / 1000);
    }
    const criteria = parseSuccessCriteria(row.success_criteria_json);
    if (criteria !== null) {
      for (const hit of Object.values(criteria)) {
        criteriaTotal += 1;
        if (hit) criteriaTrue += 1;
      }
    }
  }

  return {
    executions: rows.length,
    errorRate: terminal === 0 ? 0 : errors / terminal,
    avgCostUsd: costCount === 0 ? null : costSum / costCount,
    criteriaHitRate: criteriaTotal === 0 ? null : criteriaTrue / criteriaTotal,
    p95DurationSeconds: p95(durations),
  };
}

/**
 * Count of error executions grouped by `error_kind` over the trailing `days`
 * window (§9.2 `by_error_kind_7d`). A NULL `error_kind` is bucketed as
 * `"unknown"`.
 */
export function byErrorKind(
  db: Database.Database,
  agentId: string,
  days: number,
  now: number = Date.now(),
): Record<string, number> {
  const cutoff = now - days * DAY_MS;
  const rows = db
    .prepare<[string, number], { kind: string; n: number }>(
      `SELECT COALESCE(error_kind, 'unknown') AS kind, COUNT(*) AS n
         FROM agent_executions
        WHERE agent_id = ? AND started_at >= ? AND result = 'error'
        GROUP BY COALESCE(error_kind, 'unknown')`,
    )
    .all(agentId, cutoff);
  const out: Record<string, number> = {};
  for (const row of rows) out[row.kind] = row.n;
  return out;
}
