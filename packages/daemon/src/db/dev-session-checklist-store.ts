/**
 * Dev-session acceptance-checklist store — the DB mirror of
 * `.aitne-dev/docs/acceptance-checklist.md` (loop-kit's fine-grained
 * expectation ledger with cmd/run/human verification methods).
 *
 * Rows are UPSERTed from the markdown by the engine's checklist sync and
 * NEVER deleted during a run: the full ac_id set in this table doubles as the
 * monotonicity baseline (loop-kit's run-scoped `.loop/ac-seen` file), so a row
 * the model deletes from the markdown surfaces as "vanished" in the
 * deterministic evaluator's §6.6(c) check. `task_id` scopes a fleet worker's
 * rows; NULL = session-level (the single loop / the master checklist).
 *
 * SQL wrapper only — excluded from the coverage gate, same posture as
 * `dev-sessions-store.ts` (its peer test still exercises every branch).
 */

import type Database from "better-sqlite3";

export type DevAcMethod = "cmd" | "run" | "human";
export type DevAcRowStatus = "pending" | "verified" | "failed";

export interface DevChecklistDbRow {
  id: string;
  sessionId: string;
  /** Fleet-worker scope; null = session-level. */
  taskId: string | null;
  acId: string;
  reqId: string | null;
  expectation: string | null;
  method: DevAcMethod;
  status: DevAcRowStatus;
  evidence: string | null;
  /** Iteration the id was first synced at (kept across upserts). */
  firstSeenIter: number | null;
  updatedAt: number;
}

interface RawRow {
  id: string;
  session_id: string;
  task_id: string | null;
  ac_id: string;
  req_id: string | null;
  expectation: string | null;
  method: DevAcMethod;
  status: DevAcRowStatus;
  evidence: string | null;
  first_seen_iter: number | null;
  updated_at: number;
}

const SELECT_COLUMNS = `
  id, session_id, task_id, ac_id, req_id, expectation, method, status,
  evidence, first_seen_iter, updated_at
`;

function fromRaw(row: RawRow): DevChecklistDbRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    acId: row.ac_id,
    reqId: row.req_id,
    expectation: row.expectation,
    method: row.method,
    status: row.status,
    evidence: row.evidence,
    firstSeenIter: row.first_seen_iter,
    updatedAt: row.updated_at,
  };
}

export interface UpsertDevChecklistRowInput {
  /** Row id used ONLY on first insert (a conflict keeps the existing id). */
  id: string;
  sessionId: string;
  taskId: string | null;
  acId: string;
  reqId: string | null;
  expectation: string | null;
  method: DevAcMethod;
  status: DevAcRowStatus;
  evidence: string | null;
  /** Iteration of THIS sync; first_seen_iter is kept across upserts. */
  iter: number | null;
  updatedAt: number;
}

/**
 * Insert-or-update one checklist row keyed on (session, [task,] ac_id).
 * Content cells follow the markdown; `first_seen_iter` is write-once (the
 * monotonicity audit anchor). SQLite partial unique indexes cannot be named
 * as an ON CONFLICT target across the NULL/non-NULL task lanes, so the upsert
 * is a manual probe-then-write (single-threaded daemon; no race).
 */
export function upsertDevChecklistRow(
  db: Database.Database,
  input: UpsertDevChecklistRowInput,
): void {
  const existing = input.taskId === null
    ? db
        .prepare<[string, string], { id: string }>(
          `SELECT id FROM dev_session_checklist
            WHERE session_id = ? AND ac_id = ? AND task_id IS NULL`,
        )
        .get(input.sessionId, input.acId)
    : db
        .prepare<[string, string, string], { id: string }>(
          `SELECT id FROM dev_session_checklist
            WHERE session_id = ? AND task_id = ? AND ac_id = ?`,
        )
        .get(input.sessionId, input.taskId, input.acId);
  if (existing) {
    db.prepare(
      `UPDATE dev_session_checklist
          SET req_id = ?, expectation = ?, method = ?, status = ?,
              evidence = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      input.reqId,
      input.expectation,
      input.method,
      input.status,
      input.evidence,
      input.updatedAt,
      existing.id,
    );
    return;
  }
  db.prepare(
    `INSERT INTO dev_session_checklist
       (id, session_id, task_id, ac_id, req_id, expectation, method, status,
        evidence, first_seen_iter, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.sessionId,
    input.taskId,
    input.acId,
    input.reqId,
    input.expectation,
    input.method,
    input.status,
    input.evidence,
    input.iter,
    input.updatedAt,
  );
}

/** All rows for a scope, stable ac_id order. `taskId` undefined = every row
 *  for the session (the API/dashboard read); null = session-level rows only;
 *  a string = that task's rows only. */
export function listDevChecklist(
  db: Database.Database,
  sessionId: string,
  taskId?: string | null,
): DevChecklistDbRow[] {
  if (taskId === undefined) {
    return db
      .prepare<[string], RawRow>(
        `SELECT ${SELECT_COLUMNS} FROM dev_session_checklist
          WHERE session_id = ?
          ORDER BY ac_id ASC`,
      )
      .all(sessionId)
      .map(fromRaw);
  }
  if (taskId === null) {
    return db
      .prepare<[string], RawRow>(
        `SELECT ${SELECT_COLUMNS} FROM dev_session_checklist
          WHERE session_id = ? AND task_id IS NULL
          ORDER BY ac_id ASC`,
      )
      .all(sessionId)
      .map(fromRaw);
  }
  return db
    .prepare<[string, string], RawRow>(
      `SELECT ${SELECT_COLUMNS} FROM dev_session_checklist
        WHERE session_id = ? AND task_id = ?
        ORDER BY ac_id ASC`,
    )
    .all(sessionId, taskId)
    .map(fromRaw);
}

/** Every ac_id ever synced for a scope — the evaluator's §6.6(c)
 *  monotonicity baseline (rows are never deleted during a run). */
export function listSeenAcIds(
  db: Database.Database,
  sessionId: string,
  taskId: string | null,
): string[] {
  const rows = taskId === null
    ? db
        .prepare<[string], { ac_id: string }>(
          `SELECT ac_id FROM dev_session_checklist
            WHERE session_id = ? AND task_id IS NULL
            ORDER BY ac_id ASC`,
        )
        .all(sessionId)
    : db
        .prepare<[string, string], { ac_id: string }>(
          `SELECT ac_id FROM dev_session_checklist
            WHERE session_id = ? AND task_id = ?
            ORDER BY ac_id ASC`,
        )
        .all(sessionId, taskId);
  return rows.map((r) => r.ac_id);
}
