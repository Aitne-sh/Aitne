/**
 * Browser-task action log — BROWSER_TASK_REDESIGN_PLAN.md §6.6.
 *
 * One row per tool call (and per defence-in-depth event: popup close,
 * dialog dismiss, file-chooser cancel, download block — emitted with
 * tool_name='browser_internal' per §14.3 / §14.4).
 *
 * I/O-bound — the dashboard reads via paginated list, the runner only
 * appends. Excluded from the coverage gate per the same `db/*` exclusion
 * rationale as the B-4 stores.
 */

import type Database from "better-sqlite3";

export type BrowserTaskActionOutcome =
  | "ok"
  | "denied"
  | "error"
  | "allowlist_block"
  | "payment_block"
  | "timeout"
  | "popup_blocked"
  | "dialog_dismissed"
  | "filechooser_cancelled"
  | "download_blocked"
  | "extract_cap_exceeded"
  | "tool_loop_detected";

export interface BrowserTaskActionLogRow {
  id: number;
  taskId: string;
  stepIndex: number;
  toolName: string;
  args: unknown;
  outcome: BrowserTaskActionOutcome;
  blockedReason: string | null;
  screenshotKey: string | null;
  durationMs: number;
  at: number;
}

interface BrowserTaskActionLogDbRow {
  id: number;
  task_id: string;
  step_index: number;
  tool_name: string;
  args_json: string;
  outcome: BrowserTaskActionOutcome;
  blocked_reason: string | null;
  screenshot_key: string | null;
  duration_ms: number;
  at: number;
}

function fromDbRow(row: BrowserTaskActionLogDbRow): BrowserTaskActionLogRow {
  let args: unknown;
  try {
    args = JSON.parse(row.args_json);
  } catch {
    args = row.args_json;
  }
  return {
    id: row.id,
    taskId: row.task_id,
    stepIndex: row.step_index,
    toolName: row.tool_name,
    args,
    outcome: row.outcome,
    blockedReason: row.blocked_reason,
    screenshotKey: row.screenshot_key,
    durationMs: row.duration_ms,
    at: row.at,
  };
}

export interface InsertBrowserTaskActionLogInput {
  taskId: string;
  stepIndex: number;
  toolName: string;
  args: unknown;
  outcome: BrowserTaskActionOutcome;
  blockedReason?: string | null;
  screenshotKey?: string | null;
  durationMs: number;
  at: number;
}

export function insertBrowserTaskActionLog(
  db: Database.Database,
  input: InsertBrowserTaskActionLogInput,
): BrowserTaskActionLogRow {
  const result = db
    .prepare(
      `INSERT INTO browser_task_action_log
         (task_id, step_index, tool_name, args_json,
          outcome, blocked_reason, screenshot_key,
          duration_ms, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.taskId,
      input.stepIndex,
      input.toolName,
      JSON.stringify(input.args ?? null),
      input.outcome,
      input.blockedReason ?? null,
      input.screenshotKey ?? null,
      input.durationMs,
      input.at,
    );
  const id = Number(result.lastInsertRowid);
  const row = db
    .prepare<[number], BrowserTaskActionLogDbRow>(
      `SELECT id, task_id, step_index, tool_name, args_json,
              outcome, blocked_reason, screenshot_key,
              duration_ms, at
         FROM browser_task_action_log
        WHERE id = ?`,
    )
    .get(id);
  if (!row) {
    throw new Error(`insertBrowserTaskActionLog: post-insert row ${id} missing`);
  }
  return fromDbRow(row);
}

/** Highest existing step_index for this task, or -1 if none yet. The
 *  runner increments from here to assign the next step's index. */
export function nextStepIndexFor(
  db: Database.Database,
  taskId: string,
): number {
  const row = db
    .prepare<[string], { m: number | null }>(
      `SELECT MAX(step_index) AS m
         FROM browser_task_action_log
        WHERE task_id = ?`,
    )
    .get(taskId);
  return (row?.m ?? -1) + 1;
}

export function listBrowserTaskActionLog(
  db: Database.Database,
  taskId: string,
): readonly BrowserTaskActionLogRow[] {
  const rows = db
    .prepare<[string], BrowserTaskActionLogDbRow>(
      `SELECT id, task_id, step_index, tool_name, args_json,
              outcome, blocked_reason, screenshot_key,
              duration_ms, at
         FROM browser_task_action_log
        WHERE task_id = ?
        ORDER BY step_index ASC`,
    )
    .all(taskId);
  return rows.map(fromDbRow);
}
