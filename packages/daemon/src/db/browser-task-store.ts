/**
 * Browser-task row store — BROWSER_TASK_REDESIGN_PLAN.md §6.4.
 *
 * I/O-bound CRUD over `browser_task`. The state machine itself (§4) is
 * enforced at this layer via the CHECK constraint on the `state` column
 * (closed set) plus the per-transition helpers below — `markRunning`,
 * `markAwaitingUser`, `markFinalConfirm`, `markCompleted`,
 * `markTerminal` — each one's WHERE clause refuses an out-of-order
 * write so a race between two writers cannot flip a row backwards.
 *
 * Pure decision logic (state-machine guards, queue arithmetic) lives in
 * `services/browser-task/browser-task-slots.ts` and is the 100%-covered
 * surface; this module is the SQL wrapper and is excluded from the
 * coverage gate (same posture as `browser-automation-purchase-tokens-store.ts`).
 */

import type Database from "better-sqlite3";

export type BrowserTaskState =
  | "pending"
  | "running"
  | "awaiting_user"
  | "final_confirm"
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled"
  | "abandoned";

export const BROWSER_TASK_TERMINAL_STATES: ReadonlySet<BrowserTaskState> =
  new Set(["completed", "failed", "timeout", "cancelled", "abandoned"]);

export const BROWSER_TASK_NON_TERMINAL_STATES: ReadonlySet<BrowserTaskState> =
  new Set(["pending", "running", "awaiting_user", "final_confirm"]);

export interface BrowserTaskRow {
  id: string;
  description: string;
  siteKey: string | null;
  extraAllowedHosts: readonly string[];
  originatingChannel: string | null;
  scheduleRowId: number | null;
  requireFinalConfirm: boolean;
  state: BrowserTaskState;
  outcomeDetail: string | null;
  report: string | null;
  effectiveAllowlistRegex: string | null;
  blockedRequestsCount: number;
  extractCharsTotal: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

interface BrowserTaskDbRow {
  id: string;
  description: string;
  site_key: string | null;
  extra_allowed_hosts_json: string | null;
  originating_channel: string | null;
  schedule_row_id: number | null;
  require_final_confirm: number;
  state: BrowserTaskState;
  outcome_detail: string | null;
  report: string | null;
  effective_allowlist_regex: string | null;
  blocked_requests_count: number;
  extract_chars_total: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

function fromDbRow(row: BrowserTaskDbRow): BrowserTaskRow {
  let hosts: string[] = [];
  if (row.extra_allowed_hosts_json) {
    try {
      const parsed = JSON.parse(row.extra_allowed_hosts_json) as unknown;
      hosts = Array.isArray(parsed)
        ? parsed.filter((v): v is string => typeof v === "string")
        : [];
    } catch {
      hosts = [];
    }
  }
  return {
    id: row.id,
    description: row.description,
    siteKey: row.site_key,
    extraAllowedHosts: hosts,
    originatingChannel: row.originating_channel,
    scheduleRowId: row.schedule_row_id,
    requireFinalConfirm: row.require_final_confirm === 1,
    state: row.state,
    outcomeDetail: row.outcome_detail,
    report: row.report,
    effectiveAllowlistRegex: row.effective_allowlist_regex,
    blockedRequestsCount: row.blocked_requests_count,
    extractCharsTotal: row.extract_chars_total,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export interface CreateBrowserTaskInput {
  id: string;
  description: string;
  siteKey: string | null;
  extraAllowedHosts: readonly string[];
  originatingChannel: string | null;
  scheduleRowId: number | null;
  requireFinalConfirm: boolean;
  effectiveAllowlistRegex: string | null;
  createdAt: number;
}

/** Insert a fresh row in state=pending. The slot manager promotes it
 *  to `running` once a slot frees. */
export function createBrowserTask(
  db: Database.Database,
  input: CreateBrowserTaskInput,
): BrowserTaskRow {
  db.prepare(
    `INSERT INTO browser_task
       (id, description, site_key, extra_allowed_hosts_json,
        originating_channel, schedule_row_id, require_final_confirm,
        state, outcome_detail, report, effective_allowlist_regex,
        blocked_requests_count, extract_chars_total,
        created_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, 0, 0, ?, NULL, NULL)`,
  ).run(
    input.id,
    input.description,
    input.siteKey,
    JSON.stringify([...input.extraAllowedHosts]),
    input.originatingChannel,
    input.scheduleRowId,
    input.requireFinalConfirm ? 1 : 0,
    input.effectiveAllowlistRegex,
    input.createdAt,
  );
  const row = getBrowserTask(db, input.id);
  if (!row) {
    throw new Error(`createBrowserTask: post-insert row for ${input.id} missing`);
  }
  return row;
}

export function getBrowserTask(
  db: Database.Database,
  id: string,
): BrowserTaskRow | null {
  const row = db
    .prepare<[string], BrowserTaskDbRow>(
      `SELECT id, description, site_key, extra_allowed_hosts_json,
              originating_channel, schedule_row_id, require_final_confirm,
              state, outcome_detail, report, effective_allowlist_regex,
              blocked_requests_count, extract_chars_total,
              created_at, started_at, finished_at
         FROM browser_task
        WHERE id = ?`,
    )
    .get(id);
  return row ? fromDbRow(row) : null;
}

export interface ListBrowserTasksOptions {
  states?: readonly BrowserTaskState[];
  siteKey?: string | null;
  limit?: number;
  offset?: number;
}

export function listBrowserTasks(
  db: Database.Database,
  options: ListBrowserTasksOptions = {},
): readonly BrowserTaskRow[] {
  const { states, siteKey, limit = 50, offset = 0 } = options;
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (states && states.length > 0) {
    where.push(`state IN (${states.map(() => "?").join(", ")})`);
    params.push(...states);
  }
  if (siteKey !== undefined) {
    if (siteKey === null) {
      where.push("site_key IS NULL");
    } else {
      where.push("site_key = ?");
      params.push(siteKey);
    }
  }
  const sql = `SELECT id, description, site_key, extra_allowed_hosts_json,
                      originating_channel, schedule_row_id, require_final_confirm,
                      state, outcome_detail, report, effective_allowlist_regex,
                      blocked_requests_count, extract_chars_total,
                      created_at, started_at, finished_at
                 FROM browser_task
               ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY created_at DESC
               LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  const rows = db
    .prepare<unknown[], BrowserTaskDbRow>(sql)
    .all(...params);
  return rows.map(fromDbRow);
}

export function countBrowserTasks(
  db: Database.Database,
  options: ListBrowserTasksOptions = {},
): number {
  const { states, siteKey } = options;
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (states && states.length > 0) {
    where.push(`state IN (${states.map(() => "?").join(", ")})`);
    params.push(...states);
  }
  if (siteKey !== undefined) {
    if (siteKey === null) {
      where.push("site_key IS NULL");
    } else {
      where.push("site_key = ?");
      params.push(siteKey);
    }
  }
  const sql = `SELECT COUNT(*) AS c
                 FROM browser_task
               ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
  const row = db.prepare<unknown[], { c: number }>(sql).get(...params);
  return row?.c ?? 0;
}

/** Pending → running. CAS on prior state so a concurrent terminal
 *  transition (cancel-while-pending → cancelled) does not get clobbered.
 *  Returns the new row or null on CAS miss. */
export function markRunning(
  db: Database.Database,
  id: string,
  startedAt: number,
): BrowserTaskRow | null {
  const result = db
    .prepare(
      `UPDATE browser_task
          SET state = 'running', started_at = ?
        WHERE id = ? AND state = 'pending'`,
    )
    .run(startedAt, id);
  return result.changes > 0 ? getBrowserTask(db, id) : null;
}

/** Running → awaiting_user. Slot stays held; resume via /clarify. */
export function markAwaitingUser(
  db: Database.Database,
  id: string,
): BrowserTaskRow | null {
  const result = db
    .prepare(
      `UPDATE browser_task
          SET state = 'awaiting_user'
        WHERE id = ? AND state = 'running'`,
    )
    .run(id);
  return result.changes > 0 ? getBrowserTask(db, id) : null;
}

/** Running → final_confirm. Slot stays held; resume via token. */
export function markFinalConfirm(
  db: Database.Database,
  id: string,
): BrowserTaskRow | null {
  const result = db
    .prepare(
      `UPDATE browser_task
          SET state = 'final_confirm'
        WHERE id = ? AND state = 'running'`,
    )
    .run(id);
  return result.changes > 0 ? getBrowserTask(db, id) : null;
}

/** Parked state → running. Used by /clarify resume and token-consume
 *  resume. Either parked state is acceptable. */
export function markRunningFromParked(
  db: Database.Database,
  id: string,
): BrowserTaskRow | null {
  const result = db
    .prepare(
      `UPDATE browser_task
          SET state = 'running'
        WHERE id = ? AND state IN ('awaiting_user', 'final_confirm')`,
    )
    .run(id);
  return result.changes > 0 ? getBrowserTask(db, id) : null;
}

export interface TerminalTransitionInput {
  id: string;
  state: "completed" | "failed" | "timeout" | "cancelled" | "abandoned";
  outcomeDetail: string | null;
  report: string | null;
  finishedAt: number;
}

/** Any non-terminal state → terminal. Idempotent — re-running on an
 *  already-terminal row CAS-misses and returns null. */
export function markTerminal(
  db: Database.Database,
  input: TerminalTransitionInput,
): BrowserTaskRow | null {
  const result = db
    .prepare(
      `UPDATE browser_task
          SET state = ?,
              outcome_detail = ?,
              report = COALESCE(?, report),
              finished_at = ?
        WHERE id = ?
          AND state IN ('pending', 'running', 'awaiting_user', 'final_confirm')`,
    )
    .run(
      input.state,
      input.outcomeDetail,
      input.report,
      input.finishedAt,
      input.id,
    );
  return result.changes > 0 ? getBrowserTask(db, input.id) : null;
}

/** Increment the per-task CDP-blocked counter. Atomic. */
export function incrementBlockedRequests(
  db: Database.Database,
  id: string,
  by: number,
): void {
  db.prepare(
    `UPDATE browser_task
        SET blocked_requests_count = blocked_requests_count + ?
      WHERE id = ?`,
  ).run(by, id);
}

/** Increment the per-task cumulative untrusted-content counter. */
export function incrementExtractChars(
  db: Database.Database,
  id: string,
  by: number,
): void {
  db.prepare(
    `UPDATE browser_task
        SET extract_chars_total = extract_chars_total + ?
      WHERE id = ?`,
  ).run(by, id);
}

/**
 * §6.5 boot-recovery sweep — flip every non-terminal row to
 * (failed, 'daemon_restarted', finishedAt) on boot, before the
 * dispatcher starts consuming events.
 *
 * Pure SQL UPDATE; returns the affected row count and the ids that
 * were flipped so the caller can fan out one DM per row to the
 * persisted `originating_channel`.
 */
export function sweepNonTerminalRowsForBootRecovery(
  db: Database.Database,
  nowMs: number,
): readonly { id: string; originatingChannel: string | null }[] {
  const txn = db.transaction(() => {
    const rows = db
      .prepare<[], { id: string; originating_channel: string | null }>(
        `SELECT id, originating_channel
           FROM browser_task
          WHERE state IN ('pending', 'running', 'awaiting_user', 'final_confirm')`,
      )
      .all();
    if (rows.length === 0) return [];
    db.prepare(
      `UPDATE browser_task
          SET state = 'failed',
              outcome_detail = 'daemon_restarted',
              finished_at = ?
        WHERE state IN ('pending', 'running', 'awaiting_user', 'final_confirm')`,
    ).run(nowMs);
    return rows.map((r) => ({
      id: r.id,
      originatingChannel: r.originating_channel,
    }));
  });
  return txn();
}

/**
 * Retention prune for terminal `browser_task` rows older than `cutoffMs`
 * (BROWSER_TASK_REDESIGN_PLAN.md §6.5 deferred follow-up + §14.7 — the
 * trace-store window is 30 days; the SQL row lifetime matches so the
 * dashboard never renders a row whose screenshots are 404). Children in
 * `browser_task_action_log`, `browser_task_clarifications`, and
 * `browser_task_final_confirm_tokens` go with the parent via the
 * ON DELETE CASCADE FK declared in `schema.ts`.
 *
 * Non-terminal rows are NEVER deleted (the boot-recovery sweep is the
 * sole path that mutates them after their owner's daemon-restart).
 * `finished_at` is the lifetime anchor — for the few terminal
 * transitions where the runner failed to set it (defensive), we fall
 * back to `created_at` to avoid stranding rows.
 */
export function deleteTerminalBrowserTasksOlderThan(
  db: Database.Database,
  cutoffMs: number,
): number {
  const result = db
    .prepare(
      `DELETE FROM browser_task
        WHERE state IN ('completed', 'failed', 'timeout', 'cancelled', 'abandoned')
          AND COALESCE(finished_at, created_at) < ?`,
    )
    .run(cutoffMs);
  return result.changes;
}
