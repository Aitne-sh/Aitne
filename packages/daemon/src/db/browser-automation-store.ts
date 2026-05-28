/**
 * Browser Automation (Phase B-2 legacy audit) — retention-only helper.
 *
 * BROWSER_TASK_REDESIGN_PLAN.md §9 Phase 6 + §6.8 + the Phase 6.5 dead-
 * code rip-out retired the workflow-runner, the frozen registry, the
 * per-domain allowlist surface, and every `/api/browser-automation/
 * {workflows,recent-runs,traces,allowlist,approvals,observation-gate}`
 * route. The store now serves a single, narrow purpose: pruning aged
 * rows out of the retained `browser_automation_workflows` audit table.
 *
 * The audit table itself is INTENTIONALLY retained so users with
 * existing pre-Phase-6 audit rows can still query their history out-of-
 * band (sqlite shell, future archived-view dashboard). No live code
 * writes to it; the daemon's new audit surface is
 * `browser_task_action_log` (BROWSER_TASK_REDESIGN_PLAN.md §6.6).
 *
 * The companion `browser_automation_allowlist` table is dropped by
 * Migration 0005 (`db/migrations.ts`); its store helpers
 * (`listAllowlistEntries`, `upsertAllowlistEntry`, `removeAllowlistEntry`,
 * `isDomainAllowed`) had no callers post-Phase 6 and were removed
 * alongside the table.
 *
 * The historical workflow-runner-facing reader/writer helpers
 * (`insertWorkflowRun`, `listRecentWorkflowRuns`, `getWorkflowRunById`)
 * were also removed in the same Phase 6.5 pass — every caller was a
 * route that Phase 6 deleted, and the retained audit rows are read-
 * only data from this point forward.
 */

import type Database from "better-sqlite3";

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
