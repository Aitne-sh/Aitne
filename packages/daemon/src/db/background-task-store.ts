/**
 * Background-task row store — BACKGROUND_TASK_RUNNER_DESIGN.md §6.
 *
 * I/O-bound CRUD over `background_task`. The state machine is enforced
 * at this layer via the CHECK constraint on the `state` column (closed
 * set) plus the per-transition CAS helpers below — `markRunning`,
 * `markAwaitingUser`, `markRunningFromParked`, `markTerminal` — each
 * one's WHERE clause refuses an out-of-order write so a race between two
 * writers cannot flip a row backwards.
 *
 * The genuinely new shape vs `browser_task` is the ARTIFACT: `report`
 * (verbatim result — the fidelity anchor), `draft` (worker-authored
 * summary), `notify` (the worker's disposition vs the spawn-time policy),
 * `significance`, and `artifact_path`. `markTerminal` writes them in the
 * same transition as the terminal state so a worker's `finish` (or the
 * runner's fail-loud synthesis) is atomic.
 *
 * Pure decision logic (slot arithmetic) is reused from
 * `services/browser-task/browser-task-slots.ts`; this module is the SQL
 * wrapper and is excluded from the coverage gate (same posture as
 * `browser-task-store.ts`).
 */

import type Database from "better-sqlite3";

export type BackgroundTaskState =
  | "pending"
  | "running"
  | "awaiting_user"
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled";

export type BackgroundTaskNotificationPolicy =
  | "always"
  | "if_significant"
  | "silent";

export type BackgroundTaskTier = "lite" | "medium" | "high";

export const BACKGROUND_TASK_NON_TERMINAL_STATES: ReadonlySet<BackgroundTaskState> =
  new Set(["pending", "running", "awaiting_user"]);

export interface BackgroundTaskRow {
  id: string;
  brief: string;
  title: string | null;
  state: BackgroundTaskState;
  notificationPolicy: BackgroundTaskNotificationPolicy;
  /** Phase 4 if_significant criteria DSL (§4.3) — concrete atomic
   *  conditions the worker checks one-by-one. Empty/null ⇒ the worker
   *  falls back to the prose criteria in the brief. */
  significanceCriteria: string[] | null;
  report: string | null;
  draft: string | null;
  /** null until finished; true ⇒ surface, false ⇒ file only. */
  notify: boolean | null;
  significance: string | null;
  artifactPath: string | null;
  outcomeDetail: string | null;
  originatingChannel: string | null;
  correlationId: string | null;
  scheduleRowId: number | null;
  tier: BackgroundTaskTier | null;
  maxBudgetUsd: number | null;
  backendSessionId: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  deliveredAt: number | null;
}

interface BackgroundTaskDbRow {
  id: string;
  brief: string;
  title: string | null;
  state: BackgroundTaskState;
  notification_policy: BackgroundTaskNotificationPolicy;
  significance_criteria: string | null;
  report: string | null;
  draft: string | null;
  notify: number | null;
  significance: string | null;
  artifact_path: string | null;
  outcome_detail: string | null;
  originating_channel: string | null;
  correlation_id: string | null;
  schedule_row_id: number | null;
  tier: BackgroundTaskTier | null;
  max_budget_usd: number | null;
  backend_session_id: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  delivered_at: number | null;
}

const SELECT_COLUMNS = `id, brief, title, state, notification_policy,
        significance_criteria, report, draft, notify, significance,
        artifact_path, outcome_detail, originating_channel, correlation_id,
        schedule_row_id, tier, max_budget_usd, backend_session_id,
        created_at, started_at, finished_at, delivered_at`;

/** Parse the persisted `significance_criteria` JSON. Tolerant: a malformed
 *  or non-array value degrades to null rather than throwing, so a row hand-
 *  written by a migration / test can never crash a read. */
function parseSignificanceCriteria(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const items = parsed.filter((x): x is string => typeof x === "string");
    return items.length > 0 ? items : null;
  } catch {
    return null;
  }
}

function fromDbRow(row: BackgroundTaskDbRow): BackgroundTaskRow {
  return {
    id: row.id,
    brief: row.brief,
    title: row.title,
    state: row.state,
    notificationPolicy: row.notification_policy,
    significanceCriteria: parseSignificanceCriteria(row.significance_criteria),
    report: row.report,
    draft: row.draft,
    notify: row.notify === null ? null : row.notify === 1,
    significance: row.significance,
    artifactPath: row.artifact_path,
    outcomeDetail: row.outcome_detail,
    originatingChannel: row.originating_channel,
    correlationId: row.correlation_id,
    scheduleRowId: row.schedule_row_id,
    tier: row.tier,
    maxBudgetUsd: row.max_budget_usd,
    backendSessionId: row.backend_session_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    deliveredAt: row.delivered_at,
  };
}

export interface CreateBackgroundTaskInput {
  id: string;
  brief: string;
  title: string | null;
  notificationPolicy: BackgroundTaskNotificationPolicy;
  /** Phase 4 if_significant criteria DSL (§4.3) — optional structured
   *  conditions. Persisted as a JSON array; null/empty stores SQL NULL. */
  significanceCriteria?: readonly string[] | null;
  originatingChannel: string | null;
  correlationId: string | null;
  scheduleRowId: number | null;
  tier: BackgroundTaskTier | null;
  maxBudgetUsd: number | null;
  createdAt: number;
}

/** Insert a fresh row in state=pending. The slot manager promotes it to
 *  `running` once a slot frees. */
export function createBackgroundTask(
  db: Database.Database,
  input: CreateBackgroundTaskInput,
): BackgroundTaskRow {
  const criteria =
    input.significanceCriteria && input.significanceCriteria.length > 0
      ? JSON.stringify([...input.significanceCriteria])
      : null;
  db.prepare(
    `INSERT INTO background_task
       (id, brief, title, state, notification_policy, significance_criteria,
        report, draft, notify, significance, artifact_path,
        outcome_detail, originating_channel, correlation_id, schedule_row_id,
        tier, max_budget_usd, backend_session_id,
        created_at, started_at, finished_at, delivered_at)
     VALUES (?, ?, ?, 'pending', ?, ?,
             NULL, NULL, NULL, NULL, NULL,
             NULL, ?, ?, ?,
             ?, ?, NULL,
             ?, NULL, NULL, NULL)`,
  ).run(
    input.id,
    input.brief,
    input.title,
    input.notificationPolicy,
    criteria,
    input.originatingChannel,
    input.correlationId,
    input.scheduleRowId,
    input.tier,
    input.maxBudgetUsd,
    input.createdAt,
  );
  const row = getBackgroundTask(db, input.id);
  if (!row) {
    throw new Error(
      `createBackgroundTask: post-insert row for ${input.id} missing`,
    );
  }
  return row;
}

/**
 * §10.3 brief-dedup — find a still-relevant task with an IDENTICAL brief
 * spawned inside the dedup window, so a runaway fan-out (the
 * RESEARCH_CLUSTER_COST_FIX_PLAN class: a replayed trigger POSTing the
 * same brief many times in minutes) collapses onto the first task instead
 * of spawning N workers. Matches on `brief` + `tier` (the two inputs that
 * define "the same work" — `notificationPolicy` only affects delivery, not
 * the work done) within `sinceMs`, and excludes the FAIL terminals
 * (`failed`/`timeout`/`cancelled`) so a prior failure is retryable rather
 * than sticky. A `completed` duplicate inside the window IS returned — the
 * answer already exists, re-running would just re-spend. Newest first.
 */
export function findRecentDuplicateBackgroundTask(
  db: Database.Database,
  input: { brief: string; tier: BackgroundTaskTier | null; sinceMs: number },
): BackgroundTaskRow | null {
  const row = db
    .prepare<[string, BackgroundTaskTier | null, number], BackgroundTaskDbRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM background_task
        WHERE brief = ?
          AND tier IS ?
          AND created_at >= ?
          AND state NOT IN ('failed', 'timeout', 'cancelled')
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(input.brief, input.tier, input.sinceMs);
  return row ? fromDbRow(row) : null;
}

export function getBackgroundTask(
  db: Database.Database,
  id: string,
): BackgroundTaskRow | null {
  const row = db
    .prepare<[string], BackgroundTaskDbRow>(
      `SELECT ${SELECT_COLUMNS} FROM background_task WHERE id = ?`,
    )
    .get(id);
  return row ? fromDbRow(row) : null;
}

export interface ListBackgroundTasksOptions {
  states?: readonly BackgroundTaskState[];
  /** §10.5 — filter the worker disposition: `false` = the filed
   *  (notify=false) digest pull, `true` = already-surfaced. Rows whose
   *  `notify` is still NULL (unfinished) are excluded when this is set. */
  notify?: boolean;
  /** Keep only rows finished at/after this epoch-ms — the digest "since
   *  yesterday" window. */
  finishedSinceMs?: number;
  limit?: number;
  offset?: number;
}

/** Shared WHERE builder for list + count so the two never diverge. */
function buildListWhere(
  options: ListBackgroundTasksOptions,
): { clause: string; params: (string | number)[] } {
  const { states, notify, finishedSinceMs } = options;
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (states && states.length > 0) {
    where.push(`state IN (${states.map(() => "?").join(", ")})`);
    params.push(...states);
  }
  if (notify !== undefined) {
    where.push(`notify = ?`);
    params.push(notify ? 1 : 0);
  }
  if (finishedSinceMs !== undefined) {
    where.push(`finished_at >= ?`);
    params.push(finishedSinceMs);
  }
  return {
    clause: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

export function listBackgroundTasks(
  db: Database.Database,
  options: ListBackgroundTasksOptions = {},
): readonly BackgroundTaskRow[] {
  const { limit = 50, offset = 0 } = options;
  const { clause, params } = buildListWhere(options);
  const sql = `SELECT ${SELECT_COLUMNS}
                 FROM background_task
               ${clause}
               ORDER BY created_at DESC
               LIMIT ? OFFSET ?`;
  const rows = db
    .prepare<unknown[], BackgroundTaskDbRow>(sql)
    .all(...params, limit, offset);
  return rows.map(fromDbRow);
}

export function countBackgroundTasks(
  db: Database.Database,
  options: ListBackgroundTasksOptions = {},
): number {
  const { clause, params } = buildListWhere(options);
  const sql = `SELECT COUNT(*) AS c FROM background_task
               ${clause}`;
  const row = db.prepare<unknown[], { c: number }>(sql).get(...params);
  return row?.c ?? 0;
}

/** Pending → running. CAS on prior state so a concurrent terminal
 *  transition (cancel-while-pending) does not get clobbered. */
export function markRunning(
  db: Database.Database,
  id: string,
  startedAt: number,
): BackgroundTaskRow | null {
  const result = db
    .prepare(
      `UPDATE background_task
          SET state = 'running', started_at = COALESCE(started_at, ?)
        WHERE id = ? AND state = 'pending'`,
    )
    .run(startedAt, id);
  return result.changes > 0 ? getBackgroundTask(db, id) : null;
}

/** Running → awaiting_user. Slot stays held; resume via /clarify. */
export function markAwaitingUser(
  db: Database.Database,
  id: string,
): BackgroundTaskRow | null {
  const result = db
    .prepare(
      `UPDATE background_task
          SET state = 'awaiting_user'
        WHERE id = ? AND state = 'running'`,
    )
    .run(id);
  return result.changes > 0 ? getBackgroundTask(db, id) : null;
}

/** awaiting_user → running. Used by /clarify resume. */
export function markRunningFromParked(
  db: Database.Database,
  id: string,
): BackgroundTaskRow | null {
  const result = db
    .prepare(
      `UPDATE background_task
          SET state = 'running'
        WHERE id = ? AND state = 'awaiting_user'`,
    )
    .run(id);
  return result.changes > 0 ? getBackgroundTask(db, id) : null;
}

export interface TerminalTransitionInput {
  id: string;
  state: "completed" | "failed" | "timeout" | "cancelled";
  outcomeDetail: string | null;
  finishedAt: number;
  /** Artifact fields. Passing `undefined`/`null` leaves the existing
   *  column unchanged (COALESCE). `finish` writes all of them on the
   *  `completed` path; the runner's fail-loud synthesis writes
   *  `report`/`draft`/`notify` on the `failed`/`timeout` path. */
  report?: string | null;
  draft?: string | null;
  /** `true`/`false` set explicitly; `undefined` leaves it NULL. */
  notify?: boolean;
  significance?: string | null;
  artifactPath?: string | null;
}

/** Any non-terminal state → terminal, writing the artifact atomically.
 *  Idempotent — re-running on an already-terminal row CAS-misses and
 *  returns null. */
export function markTerminal(
  db: Database.Database,
  input: TerminalTransitionInput,
): BackgroundTaskRow | null {
  const result = db
    .prepare(
      `UPDATE background_task
          SET state = ?,
              outcome_detail = ?,
              report = COALESCE(?, report),
              draft = COALESCE(?, draft),
              notify = COALESCE(?, notify),
              significance = COALESCE(?, significance),
              artifact_path = COALESCE(?, artifact_path),
              finished_at = ?
        WHERE id = ?
          AND state IN ('pending', 'running', 'awaiting_user')`,
    )
    .run(
      input.state,
      input.outcomeDetail,
      input.report ?? null,
      input.draft ?? null,
      input.notify === undefined ? null : input.notify ? 1 : 0,
      input.significance ?? null,
      input.artifactPath ?? null,
      input.finishedAt,
      input.id,
    );
  return result.changes > 0 ? getBackgroundTask(db, input.id) : null;
}

/** Capture the SDK session id once the first turn streams it, so a
 *  /clarify resume can `query({resume})` the warm session. */
export function setBackendSessionId(
  db: Database.Database,
  id: string,
  sessionId: string,
): void {
  db.prepare(
    `UPDATE background_task SET backend_session_id = ? WHERE id = ?`,
  ).run(sessionId, id);
}

export function markBackgroundTaskDelivered(
  db: Database.Database,
  id: string,
  deliveredAt: number,
): BackgroundTaskRow | null {
  const result = db
    .prepare(
      `UPDATE background_task
          SET delivered_at = COALESCE(delivered_at, ?)
        WHERE id = ?`,
    )
    .run(deliveredAt, id);
  return result.changes > 0 ? getBackgroundTask(db, id) : null;
}

/** Delivery recovery target — completed rows whose worker stored a
 *  notify=true artifact but whose DM was never sent/recorded (§10.2). */
export function listUndeliveredBackgroundTaskReports(
  db: Database.Database,
  limit = 20,
): readonly BackgroundTaskRow[] {
  const rows = db
    .prepare<[number], BackgroundTaskDbRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM background_task
        WHERE state = 'completed'
          AND notify = 1
          AND delivered_at IS NULL
          AND draft IS NOT NULL
        ORDER BY finished_at ASC, created_at ASC
        LIMIT ?`,
    )
    .all(limit);
  return rows.map(fromDbRow);
}

/** §10.5 — filed (notify=false) results, for the periodic digest +
 *  owner pull ("did that monitor ever run?"). */
export function listFiledBackgroundTaskResults(
  db: Database.Database,
  sinceMs: number,
  limit = 50,
): readonly BackgroundTaskRow[] {
  const rows = db
    .prepare<[number, number], BackgroundTaskDbRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM background_task
        WHERE state = 'completed'
          AND notify = 0
          AND finished_at >= ?
        ORDER BY finished_at DESC
        LIMIT ?`,
    )
    .all(sinceMs, limit);
  return rows.map(fromDbRow);
}

/**
 * §10.2 boot re-dispatch-from-brief — reset every non-terminal row to
 * `pending` (clearing the lost in-memory session) so the event-pipeline
 * boot hook can re-run each one's brief through the runner. Returns the
 * ids reset so the caller can fan out the re-dispatch.
 *
 * Unlike browser_task's `sweepNonTerminalRowsForBootRecovery` (which
 * force-fails), background tasks are re-dispatchable because the brief is
 * self-contained. `backend_session_id` is cleared since the prior SDK
 * session is unreachable after a restart.
 *
 * Open clarifications belonging to the reset tasks are resolved in the
 * SAME transaction. The pre-restart run that raised an `ask_user` is
 * gone, so its clarification row is orphaned: a surviving `resolved = 0`
 * row would later trip the deadline scanner (`listOverdueClarifications`
 * → `expireForDeadline`) into transitioning the FRESH re-dispatched run
 * to `timeout` — and because re-dispatch makes the task ACTIVE again
 * (pending→running), that `expireForDeadline` is NOT a no-op the way it
 * is for a terminal row. Clearing them here closes that window.
 */
export function resetNonTerminalForBootRedispatch(
  db: Database.Database,
  nowMs: number = Date.now(),
): readonly { id: string }[] {
  const txn = db.transaction(() => {
    const rows = db
      .prepare<[], { id: string }>(
        `SELECT id FROM background_task
          WHERE state IN ('pending', 'running', 'awaiting_user')`,
      )
      .all();
    if (rows.length === 0) return [];
    // Abandon orphaned clarifications BEFORE the state reset (so the
    // `task_id IN (non-terminal)` subquery still matches them).
    db.prepare(
      `UPDATE background_task_clarifications
          SET resolved = 1, answered_at = COALESCE(answered_at, ?)
        WHERE resolved = 0
          AND task_id IN (
            SELECT id FROM background_task
             WHERE state IN ('pending', 'running', 'awaiting_user')
          )`,
    ).run(nowMs);
    db.prepare(
      `UPDATE background_task
          SET state = 'pending',
              started_at = NULL,
              backend_session_id = NULL
        WHERE state IN ('pending', 'running', 'awaiting_user')`,
    ).run();
    return rows.map((r) => ({ id: r.id }));
  });
  return txn();
}

/**
 * Phase 4 resume-across-restart (§10.2) — the non-terminal rows the boot
 * recovery path partitions into "resume the SDK session" vs "re-dispatch
 * from brief". Returns just the discriminators (id, state, session id) so
 * the caller can decide without loading the full artifact.
 */
export function listNonTerminalBackgroundTasks(
  db: Database.Database,
): readonly { id: string; state: BackgroundTaskState; backendSessionId: string | null }[] {
  return db
    .prepare<[], { id: string; state: BackgroundTaskState; backend_session_id: string | null }>(
      `SELECT id, state, backend_session_id
         FROM background_task
        WHERE state IN ('pending', 'running', 'awaiting_user')
        ORDER BY created_at ASC`,
    )
    .all()
    .map((r) => ({ id: r.id, state: r.state, backendSessionId: r.backend_session_id }));
}

/**
 * Phase 4 resume-across-restart (§10.2) — reset ONE non-terminal row back
 * to `pending` for re-dispatch-from-brief, clearing its (now unreachable)
 * SDK session id and resolving its orphaned open clarifications in the same
 * transaction (same rationale as the bulk
 * `resetNonTerminalForBootRedispatch`: a surviving `resolved = 0` row would
 * trip the deadline scanner into timing out the FRESH re-dispatched run).
 * Used by the boot path for the rows it re-dispatches and by the runner's
 * resume-failure fallback. Returns the row id when it was non-terminal,
 * else null (idempotent on an already-terminal / missing row).
 */
export function resetSingleForBootRedispatch(
  db: Database.Database,
  id: string,
  nowMs: number = Date.now(),
): string | null {
  const txn = db.transaction(() => {
    const row = db
      .prepare<[string], { state: BackgroundTaskState }>(
        `SELECT state FROM background_task WHERE id = ?`,
      )
      .get(id);
    if (!row || !BACKGROUND_TASK_NON_TERMINAL_STATES.has(row.state)) {
      return null;
    }
    db.prepare(
      `UPDATE background_task_clarifications
          SET resolved = 1, answered_at = COALESCE(answered_at, ?)
        WHERE resolved = 0 AND task_id = ?`,
    ).run(nowMs, id);
    db.prepare(
      `UPDATE background_task
          SET state = 'pending',
              started_at = NULL,
              backend_session_id = NULL
        WHERE id = ?`,
    ).run(id);
    return id;
  });
  return txn();
}

/**
 * Fold a just-answered clarification into the task's brief so a COLD
 * re-dispatch (when the warm SDK session can't be resumed across a restart,
 * §10.2) still carries the owner's answer and doesn't re-ask the same
 * question. The worker only ever sees the brief, so appending the resolved
 * Q&A is the only way to thread the answer into a fresh run. Idempotency is
 * not required — this runs at most once per clarification per re-dispatch,
 * and the clarify route has already CAS-resolved the row.
 */
export function appendResolvedClarificationToBrief(
  db: Database.Database,
  id: string,
  question: string | null,
  answer: string,
): void {
  const block =
    `\n\n<resolved_clarification>\n`
    + (question ? `You previously asked: ${question}\n` : "")
    + `The owner answered: ${answer}\n`
    + `</resolved_clarification>`;
  db.prepare(`UPDATE background_task SET brief = brief || ? WHERE id = ?`).run(block, id);
}

/**
 * Retention prune for terminal rows older than `cutoffMs`. Children in
 * `background_task_clarifications` go with the parent via ON DELETE
 * CASCADE. Non-terminal rows are never deleted (the boot re-dispatch
 * sweep owns them). `finished_at` is the lifetime anchor with a
 * `created_at` fallback for the rare unset-finished_at terminal.
 */
export function deleteTerminalBackgroundTasksOlderThan(
  db: Database.Database,
  cutoffMs: number,
): number {
  const result = db
    .prepare(
      `DELETE FROM background_task
        WHERE state IN ('completed', 'failed', 'timeout', 'cancelled')
          AND COALESCE(finished_at, created_at) < ?`,
    )
    .run(cutoffMs);
  return result.changes;
}
