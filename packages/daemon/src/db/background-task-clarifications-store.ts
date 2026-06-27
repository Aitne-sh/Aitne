/**
 * Background-task clarifications — BACKGROUND_TASK_RUNNER_DESIGN.md §6.
 *
 * One row per `ask_user` round-trip. The worker writes the row when it
 * calls `ask_user`, the runner transitions the task to `awaiting_user`,
 * and the delivery boundary surfaces the question to the owner (active
 * delivery turn or idle draft send). The owner replies via DM; the DM
 * agent forwards the answer through `POST /api/background-task/:id/clarify`
 * which calls `resolveClarification` here.
 *
 * Deadline enforcement: a daemon housekeeping tick sweeps
 * `WHERE resolved = 0 AND deadline_at < now()` via
 * `listOverdueClarifications` and transitions the parent task to
 * `timeout` (releasing the slot). The TTL is CONFIGURABLE
 * (`backgroundTaskClarificationTtlMinutes`) and longer than
 * browser-task's fixed 5 min — no browser resource is held while parked.
 *
 * I/O-bound. Excluded from the coverage gate.
 */

import type Database from "better-sqlite3";

export interface BackgroundTaskClarificationRow {
  id: string;
  taskId: string;
  question: string;
  contextSummary: string | null;
  askedAt: number;
  deadlineAt: number;
  deliveredAt: number | null;
  answer: string | null;
  answeredAt: number | null;
  resolved: boolean;
}

interface BackgroundTaskClarificationDbRow {
  id: string;
  task_id: string;
  question: string;
  context_summary: string | null;
  asked_at: number;
  deadline_at: number;
  delivered_at: number | null;
  answer: string | null;
  answered_at: number | null;
  resolved: number;
}

const SELECT_COLUMNS = `id, task_id, question, context_summary,
        asked_at, deadline_at, delivered_at, answer, answered_at, resolved`;

function fromDbRow(
  row: BackgroundTaskClarificationDbRow,
): BackgroundTaskClarificationRow {
  return {
    id: row.id,
    taskId: row.task_id,
    question: row.question,
    contextSummary: row.context_summary,
    askedAt: row.asked_at,
    deadlineAt: row.deadline_at,
    deliveredAt: row.delivered_at,
    answer: row.answer,
    answeredAt: row.answered_at,
    resolved: row.resolved === 1,
  };
}

export interface CreateClarificationInput {
  id: string;
  taskId: string;
  question: string;
  contextSummary: string | null;
  askedAt: number;
  /** TTL in ms — the deadline is computed here (asked_at + ttlMs) so the
   *  runner and the scanner cannot disagree. The caller reads
   *  `backgroundTaskClarificationTtlMinutes` and passes ms. */
  ttlMs: number;
}

export function createClarification(
  db: Database.Database,
  input: CreateClarificationInput,
): BackgroundTaskClarificationRow {
  const deadline = input.askedAt + input.ttlMs;
  db.prepare(
    `INSERT INTO background_task_clarifications
       (id, task_id, question, context_summary,
        asked_at, deadline_at, delivered_at, answer, answered_at, resolved)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0)`,
  ).run(
    input.id,
    input.taskId,
    input.question,
    input.contextSummary,
    input.askedAt,
    deadline,
  );
  const row = getClarification(db, input.id);
  if (!row) {
    throw new Error(
      `createClarification: post-insert row for ${input.id} missing`,
    );
  }
  return row;
}

export function getClarification(
  db: Database.Database,
  id: string,
): BackgroundTaskClarificationRow | null {
  const row = db
    .prepare<[string], BackgroundTaskClarificationDbRow>(
      `SELECT ${SELECT_COLUMNS} FROM background_task_clarifications WHERE id = ?`,
    )
    .get(id);
  return row ? fromDbRow(row) : null;
}

export function listClarificationsForTask(
  db: Database.Database,
  taskId: string,
): readonly BackgroundTaskClarificationRow[] {
  const rows = db
    .prepare<[string], BackgroundTaskClarificationDbRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM background_task_clarifications
        WHERE task_id = ?
        ORDER BY asked_at ASC`,
    )
    .all(taskId);
  return rows.map(fromDbRow);
}

/** The most-recent unresolved clarification for a task — the one a
 *  /clarify reply without an explicit id resolves against. */
export function getOpenClarificationForTask(
  db: Database.Database,
  taskId: string,
): BackgroundTaskClarificationRow | null {
  const row = db
    .prepare<[string], BackgroundTaskClarificationDbRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM background_task_clarifications
        WHERE task_id = ? AND resolved = 0
        ORDER BY asked_at DESC
        LIMIT 1`,
    )
    .get(taskId);
  return row ? fromDbRow(row) : null;
}

export interface ResolveClarificationResult {
  ok: boolean;
  row: BackgroundTaskClarificationRow | null;
  reason?: "not_found" | "already_resolved" | "expired";
}

/** CAS-resolve a clarification with the owner's answer. Refuses if
 *  already resolved (idempotent forwarding) or past deadline (the
 *  deadline scanner owns the timeout transition). */
export function resolveClarification(
  db: Database.Database,
  input: { id: string; answer: string; answeredAt: number },
): ResolveClarificationResult {
  const existing = getClarification(db, input.id);
  if (!existing) return { ok: false, row: null, reason: "not_found" };
  if (existing.resolved) {
    return { ok: false, row: existing, reason: "already_resolved" };
  }
  if (input.answeredAt > existing.deadlineAt) {
    return { ok: false, row: existing, reason: "expired" };
  }
  const result = db
    .prepare(
      `UPDATE background_task_clarifications
          SET answer = ?, answered_at = ?, resolved = 1
        WHERE id = ? AND resolved = 0`,
    )
    .run(input.answer, input.answeredAt, input.id);
  if (result.changes === 0) {
    const after = getClarification(db, input.id);
    return { ok: false, row: after, reason: "already_resolved" };
  }
  return { ok: true, row: getClarification(db, input.id) };
}

/** Sweep target — every unresolved clarification whose deadline has
 *  passed. The scanner transitions each parent task to `timeout`. */
export function listOverdueClarifications(
  db: Database.Database,
  nowMs: number,
): readonly BackgroundTaskClarificationRow[] {
  const rows = db
    .prepare<[number], BackgroundTaskClarificationDbRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM background_task_clarifications
        WHERE resolved = 0 AND deadline_at < ?
        ORDER BY deadline_at ASC`,
    )
    .all(nowMs);
  return rows.map(fromDbRow);
}

/** Mark a clarification resolved without an answer (deadline path). */
export function expireClarification(
  db: Database.Database,
  id: string,
  nowMs: number,
): BackgroundTaskClarificationRow | null {
  const result = db
    .prepare(
      `UPDATE background_task_clarifications
          SET resolved = 1, answered_at = ?
        WHERE id = ? AND resolved = 0`,
    )
    .run(nowMs, id);
  if (result.changes === 0) return null;
  return getClarification(db, id);
}

export function markClarificationDelivered(
  db: Database.Database,
  id: string,
  deliveredAt: number,
): BackgroundTaskClarificationRow | null {
  const result = db
    .prepare(
      `UPDATE background_task_clarifications
          SET delivered_at = COALESCE(delivered_at, ?)
        WHERE id = ?`,
    )
    .run(deliveredAt, id);
  return result.changes > 0 ? getClarification(db, id) : null;
}

/** A recovery-sweep clarification row enriched with the parent task's
 *  delivery fields. The list query already INNER JOINs `background_task`
 *  (on `state='awaiting_user'`), so these are folded in here — the sweep
 *  needs no second `getBackgroundTask` fetch and carries no unreachable
 *  "task missing" guard. */
export interface UndeliveredClarificationRow
  extends BackgroundTaskClarificationRow {
  taskOriginatingChannel: string | null;
  taskTitle: string | null;
  taskBrief: string;
}

/** Delivery recovery target — undelivered, still-open clarifications
 *  whose parent task is parked, joined with that task's delivery fields. */
export function listUndeliveredClarifications(
  db: Database.Database,
  nowMs: number,
  limit = 20,
): readonly UndeliveredClarificationRow[] {
  const rows = db
    .prepare<
      [number, number],
      BackgroundTaskClarificationDbRow & {
        originating_channel: string | null;
        title: string | null;
        brief: string;
      }
    >(
      `SELECT c.id, c.task_id, c.question, c.context_summary,
              c.asked_at, c.deadline_at, c.delivered_at,
              c.answer, c.answered_at, c.resolved,
              t.originating_channel, t.title, t.brief
         FROM background_task_clarifications c
         JOIN background_task t ON t.id = c.task_id
        WHERE c.resolved = 0
          AND c.delivered_at IS NULL
          AND c.deadline_at >= ?
          AND t.state = 'awaiting_user'
        ORDER BY c.asked_at ASC
        LIMIT ?`,
    )
    .all(nowMs, limit);
  return rows.map((row) => ({
    ...fromDbRow(row),
    taskOriginatingChannel: row.originating_channel,
    taskTitle: row.title,
    taskBrief: row.brief,
  }));
}
