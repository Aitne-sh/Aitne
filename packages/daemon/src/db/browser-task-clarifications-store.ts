/**
 * Browser-task clarifications — BROWSER_TASK_REDESIGN_PLAN.md §6.7.
 *
 * One row per `ask_user` round-trip. The runner writes the row when the
 * sub-agent calls `ask_user`, transitions the task to `awaiting_user`,
 * and DMs the question + screenshot. The user replies via DM; the
 * adapter forwards the reply through `POST /api/browser-task/:id/clarify`
 * which calls `resolveClarification` here.
 *
 * Deadline enforcement: a single 30 s daemon tick scans
 * `WHERE resolved = 0 AND deadline_at < now()` via
 * `listOverdueClarifications` and the deadline scanner transitions the
 * parent task to `abandoned` (releasing the slot + DMing the user once).
 *
 * I/O-bound. Excluded from the coverage gate.
 */

import type Database from "better-sqlite3";

/** §5 ask_user — 5-minute clarification TTL. The runner reads this
 *  constant when writing `deadline_at = asked_at + CLARIFICATION_TTL_MS`. */
export const CLARIFICATION_TTL_MS = 5 * 60 * 1000;

export interface BrowserTaskClarificationRow {
  id: string;
  taskId: string;
  question: string;
  contextSummary: string | null;
  screenshotKey: string | null;
  askedAt: number;
  deadlineAt: number;
  deliveredAt: number | null;
  answer: string | null;
  answeredAt: number | null;
  resolved: boolean;
}

interface BrowserTaskClarificationDbRow {
  id: string;
  task_id: string;
  question: string;
  context_summary: string | null;
  screenshot_key: string | null;
  asked_at: number;
  deadline_at: number;
  delivered_at: number | null;
  answer: string | null;
  answered_at: number | null;
  resolved: number;
}

function fromDbRow(
  row: BrowserTaskClarificationDbRow,
): BrowserTaskClarificationRow {
  return {
    id: row.id,
    taskId: row.task_id,
    question: row.question,
    contextSummary: row.context_summary,
    screenshotKey: row.screenshot_key,
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
  screenshotKey: string | null;
  askedAt: number;
}

/** Insert a fresh clarification row. The deadline is computed at this
 *  layer (asked_at + CLARIFICATION_TTL_MS) so the runner and the
 *  scanner cannot disagree. */
export function createClarification(
  db: Database.Database,
  input: CreateClarificationInput,
): BrowserTaskClarificationRow {
  const deadline = input.askedAt + CLARIFICATION_TTL_MS;
  db.prepare(
    `INSERT INTO browser_task_clarifications
       (id, task_id, question, context_summary, screenshot_key,
        asked_at, deadline_at, delivered_at, answer, answered_at, resolved)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0)`,
  ).run(
    input.id,
    input.taskId,
    input.question,
    input.contextSummary,
    input.screenshotKey,
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
): BrowserTaskClarificationRow | null {
  const row = db
    .prepare<[string], BrowserTaskClarificationDbRow>(
      `SELECT id, task_id, question, context_summary, screenshot_key,
              asked_at, deadline_at, delivered_at, answer, answered_at, resolved
         FROM browser_task_clarifications
        WHERE id = ?`,
    )
    .get(id);
  return row ? fromDbRow(row) : null;
}

export function listClarificationsForTask(
  db: Database.Database,
  taskId: string,
): readonly BrowserTaskClarificationRow[] {
  const rows = db
    .prepare<[string], BrowserTaskClarificationDbRow>(
      `SELECT id, task_id, question, context_summary, screenshot_key,
              asked_at, deadline_at, delivered_at, answer, answered_at, resolved
         FROM browser_task_clarifications
        WHERE task_id = ?
        ORDER BY asked_at ASC`,
    )
    .all(taskId);
  return rows.map(fromDbRow);
}

export interface ResolveClarificationResult {
  ok: boolean;
  row: BrowserTaskClarificationRow | null;
  reason?: "not_found" | "already_resolved" | "expired";
}

/** CAS-resolve a clarification with the user's answer. Refuses if
 *  already resolved (idempotent DM forwarding) or past deadline (the
 *  deadline scanner owns the abandoned transition). */
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
      `UPDATE browser_task_clarifications
          SET answer = ?, answered_at = ?, resolved = 1
        WHERE id = ? AND resolved = 0`,
    )
    .run(input.answer, input.answeredAt, input.id);
  if (result.changes === 0) {
    const after = getClarification(db, input.id);
    return { ok: false, row: after, reason: "already_resolved" };
  }
  const row = getClarification(db, input.id);
  return { ok: true, row };
}

/** Sweep target — every unresolved clarification whose deadline has
 *  passed. The deadline scanner walks the list and transitions each
 *  parent task to `abandoned`. */
export function listOverdueClarifications(
  db: Database.Database,
  nowMs: number,
): readonly BrowserTaskClarificationRow[] {
  const rows = db
    .prepare<[number], BrowserTaskClarificationDbRow>(
      `SELECT id, task_id, question, context_summary, screenshot_key,
              asked_at, deadline_at, delivered_at, answer, answered_at, resolved
         FROM browser_task_clarifications
        WHERE resolved = 0 AND deadline_at < ?
        ORDER BY deadline_at ASC`,
    )
    .all(nowMs);
  return rows.map(fromDbRow);
}

/** Mark a clarification resolved without an answer (deadline path).
 *  Differs from `resolveClarification` in that it skips the deadline
 *  check — the scanner is calling this BECAUSE the deadline passed. */
export function expireClarification(
  db: Database.Database,
  id: string,
  nowMs: number,
): BrowserTaskClarificationRow | null {
  const result = db
    .prepare(
      `UPDATE browser_task_clarifications
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
): BrowserTaskClarificationRow | null {
  const result = db
    .prepare(
      `UPDATE browser_task_clarifications
          SET delivered_at = COALESCE(delivered_at, ?)
        WHERE id = ?`,
    )
    .run(deliveredAt, id);
  return result.changes > 0 ? getClarification(db, id) : null;
}

/** A recovery-sweep clarification row enriched with the parent task's
 *  delivery fields. The list query already INNER JOINs `browser_task`
 *  (on `state='awaiting_user'`), so the originating channel + description
 *  are folded in here — the sweep needs no second `getBrowserTask` fetch
 *  and carries no unreachable "task missing" guard. */
export interface UndeliveredClarificationRow
  extends BrowserTaskClarificationRow {
  taskOriginatingChannel: string | null;
  taskDescription: string;
}

export function listUndeliveredClarifications(
  db: Database.Database,
  nowMs: number,
  limit = 20,
): readonly UndeliveredClarificationRow[] {
  const rows = db
    .prepare<
      [number, number],
      BrowserTaskClarificationDbRow & {
        originating_channel: string | null;
        description: string;
      }
    >(
      `SELECT c.id, c.task_id, c.question, c.context_summary, c.screenshot_key,
              c.asked_at, c.deadline_at, c.delivered_at,
              c.answer, c.answered_at, c.resolved,
              t.originating_channel, t.description
         FROM browser_task_clarifications c
         JOIN browser_task t ON t.id = c.task_id
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
    taskDescription: row.description,
  }));
}
