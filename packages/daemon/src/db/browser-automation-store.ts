/**
 * Browser Automation (Phase B-2) — typed read/write helpers for the two
 * tables added by `schema.ts`:
 *
 *   - `browser_automation_workflows` (audit row per `runWorkflow` call)
 *   - `browser_automation_allowlist` (per-domain user opt-in)
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §8.14.
 *
 * The store is intentionally pure-SQL — no validation, no defaulting, no
 * domain logic. The API route layer Zod-validates inbound payloads; the
 * workflow runner enforces the deny-on-unknown allowlist invariant
 * before any record lands here. Keeping the store thin lets the
 * coverage gate hold on the schema's CHECK constraints (the safety
 * floor) rather than on Node-side guard code that would drift.
 *
 * eTLD+1 normalisation lives in `automation/egress-denylist.ts`
 * (`extractEtldPlusOne`). Callers MUST normalise before insertion;
 * the schema's PRIMARY KEY on `domain` is the dedup floor.
 */

import type Database from "better-sqlite3";

import type { BrowserAutomationOutcome } from "@aitne/shared";

export interface WorkflowRunRecord {
  workflowId: string;
  workflowName: string;
  paramsHash: string;
  targetUrls: readonly string[];
  blockedRequests: readonly string[];
  durationMs: number;
  outcome: BrowserAutomationOutcome;
  startedAt: number;
  finishedAt: number;
  screenshotPath: string | null;
  tracePath: string | null;
}

export interface AllowlistEntryRecord {
  domain: string;
  mode: "read" | "denied";
  addedAt: number;
  addedBy: "user" | "system";
}

/**
 * Insert one workflow audit row. The caller (workflow-runner) wraps every
 * code path that reaches the post-validation phase, including failure
 * outcomes, so the dashboard's Recent Automations panel can surface
 * blocked / errored runs alongside successes.
 */
export function insertWorkflowRun(
  db: Database.Database,
  row: WorkflowRunRecord,
): void {
  db.prepare(
    `INSERT INTO browser_automation_workflows
       (workflow_id, workflow_name, params_hash, target_urls,
        blocked_requests, duration_ms, outcome,
        started_at, finished_at, screenshot_path, trace_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.workflowId,
    row.workflowName,
    row.paramsHash,
    JSON.stringify(row.targetUrls),
    JSON.stringify(row.blockedRequests),
    row.durationMs,
    row.outcome,
    row.startedAt,
    row.finishedAt,
    row.screenshotPath,
    row.tracePath,
  );
}

interface WorkflowRunDbRow {
  workflow_id: string;
  workflow_name: string;
  params_hash: string;
  target_urls: string;
  blocked_requests: string;
  duration_ms: number;
  outcome: BrowserAutomationOutcome;
  started_at: number;
  finished_at: number;
  screenshot_path: string | null;
  trace_path: string | null;
}

/**
 * Return the most-recent `limit` workflow runs, started-at DESC. Backs the
 * dashboard's Recent Automations panel (default 50, hard cap 200).
 *
 * `JSON.parse` on the two stringified arrays is guarded — a corrupted
 * row (manual DB edit, prior-version write) returns an empty array
 * instead of throwing the whole list query.
 */
export function listRecentWorkflowRuns(
  db: Database.Database,
  limit: number,
): WorkflowRunRecord[] {
  const cap = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = db
    .prepare(
      `SELECT workflow_id, workflow_name, params_hash, target_urls,
              blocked_requests, duration_ms, outcome,
              started_at, finished_at, screenshot_path, trace_path
         FROM browser_automation_workflows
         ORDER BY started_at DESC
         LIMIT ?`,
    )
    .all(cap) as WorkflowRunDbRow[];
  return rows.map((row) => ({
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    paramsHash: row.params_hash,
    targetUrls: safeJsonStringArray(row.target_urls),
    blockedRequests: safeJsonStringArray(row.blocked_requests),
    durationMs: row.duration_ms,
    outcome: row.outcome,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    screenshotPath: row.screenshot_path,
    tracePath: row.trace_path,
  }));
}

/**
 * Return the workflow run with the given id, or null. Used by the
 * `/api/browser-automation/traces/:workflowId/...` route to validate
 * that the requested trace belongs to a known run (defence against an
 * agent fishing for arbitrary files under `automation-traces/`).
 */
export function getWorkflowRunById(
  db: Database.Database,
  workflowId: string,
): WorkflowRunRecord | null {
  const row = db
    .prepare(
      `SELECT workflow_id, workflow_name, params_hash, target_urls,
              blocked_requests, duration_ms, outcome,
              started_at, finished_at, screenshot_path, trace_path
         FROM browser_automation_workflows
        WHERE workflow_id = ?`,
    )
    .get(workflowId) as WorkflowRunDbRow | undefined;
  if (!row) return null;
  return {
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    paramsHash: row.params_hash,
    targetUrls: safeJsonStringArray(row.target_urls),
    blockedRequests: safeJsonStringArray(row.blocked_requests),
    durationMs: row.duration_ms,
    outcome: row.outcome,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    screenshotPath: row.screenshot_path,
    tracePath: row.trace_path,
  };
}

/**
 * Delete `browser_automation_workflows` rows whose `started_at` is older
 * than `cutoffEpochMs`. Returns the deleted count. The retention sweep
 * pairs with `trace-store.ts:pruneTraceDirectory` — the SQL row goes
 * before the FS dir so a partial failure does not leave an audit row
 * pointing at a missing trace.
 */
export function deleteWorkflowRunsOlderThan(
  db: Database.Database,
  cutoffEpochMs: number,
): number {
  const result = db
    .prepare("DELETE FROM browser_automation_workflows WHERE started_at < ?")
    .run(cutoffEpochMs);
  return result.changes;
}

/** List the entire allowlist. Ordered alphabetically for stable
 *  dashboard rendering. */
export function listAllowlistEntries(
  db: Database.Database,
): AllowlistEntryRecord[] {
  const rows = db
    .prepare(
      `SELECT domain, mode, added_at, added_by
         FROM browser_automation_allowlist
         ORDER BY domain ASC`,
    )
    .all() as Array<{
      domain: string;
      mode: "read" | "denied";
      added_at: number;
      added_by: "user" | "system";
    }>;
  return rows.map((r) => ({
    domain: r.domain,
    mode: r.mode,
    addedAt: r.added_at,
    addedBy: r.added_by,
  }));
}

/**
 * `INSERT OR REPLACE` semantics — calling with the same domain re-stamps
 * the `mode`, `addedAt`, and `addedBy` columns. The dashboard wires this
 * to its "promote a domain from denied → read" button; the agent never
 * reaches this code path (`Approve`-tier risk classifier entry).
 */
export function upsertAllowlistEntry(
  db: Database.Database,
  entry: AllowlistEntryRecord,
): void {
  db.prepare(
    `INSERT INTO browser_automation_allowlist
       (domain, mode, added_at, added_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(domain) DO UPDATE SET
       mode     = excluded.mode,
       added_at = excluded.added_at,
       added_by = excluded.added_by`,
  ).run(entry.domain, entry.mode, entry.addedAt, entry.addedBy);
}

/** Returns the number of rows deleted (0 or 1). */
export function removeAllowlistEntry(
  db: Database.Database,
  domain: string,
): number {
  const result = db
    .prepare("DELETE FROM browser_automation_allowlist WHERE domain = ?")
    .run(domain);
  return result.changes;
}

/**
 * Fast O(1) check used by the workflow-runner's deny-on-unknown gate.
 * Returns true only when an entry exists AND its mode is `"read"` (a
 * `"denied"` row blocks even if the user previously enabled the host).
 */
export function isDomainAllowed(
  db: Database.Database,
  domain: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM browser_automation_allowlist
        WHERE domain = ? AND mode = 'read' LIMIT 1`,
    )
    .get(domain);
  return row !== undefined;
}

function safeJsonStringArray(input: string): string[] {
  try {
    const parsed = JSON.parse(input);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}
