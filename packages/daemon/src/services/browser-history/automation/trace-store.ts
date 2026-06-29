/**
 * Trace store constants — filesystem side of the Playwright screenshot
 * capture surface.
 *
 * BROWSER_TASK_REDESIGN_PLAN.md §6.4. The disk layout
 * (`${PA_DATA_DIR}/automation-traces/<id>/`) survived the Phase-6 rip-out
 * of the workflow runner — the browser-task runtime writes its captured
 * screenshots into the same tree, just keyed by `browser_task.id`
 * instead of the old workflow uuid. Per-screenshot writes live inline in
 * `browser-task-tools/server.ts` next to the §14.7 hostname-denylist
 * retention check.
 *
 * The pure path arithmetic in `trace-store-paths.ts` IS in the covered
 * set so the directory-traversal defence is locked in by tests.
 */

/** Days to retain trace assets before the daily cleanup deletes them. */
export const TRACE_RETENTION_DAYS = 14;
