/**
 * Trace store I/O — filesystem side of the Playwright screenshot capture
 * surface.
 *
 * BROWSER_TASK_REDESIGN_PLAN.md §6.4. The disk layout
 * (`${PA_DATA_DIR}/automation-traces/<id>/`) survived the Phase-6 rip-out
 * of the workflow runner — the browser-task runtime writes its captured
 * screenshots into the same tree, just keyed by `browser_task.id`
 * instead of the old workflow uuid. This module exports the cron-side
 * pruner; per-screenshot writes live inline in
 * `browser-task-tools/server.ts` next to the §14.7 hostname-denylist
 * retention check.
 *
 * Excluded from the 100% coverage gate (FS I/O around
 * `fs/promises.readdir` / `stat` / `rm` is hard to exercise without
 * process-level mocks that ESM blocks). The pure path arithmetic in
 * `trace-store-paths.ts` IS in the covered set so the
 * directory-traversal defence is locked in by tests.
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { createLogger } from "../../../logging.js";
import { tracesRootDir } from "./trace-store-paths.js";

const logger = createLogger("browser-automation-trace-store");

/** Days to retain trace assets before the daily cleanup deletes them. */
export const TRACE_RETENTION_DAYS = 14;

/**
 * Delete every per-task trace directory whose latest mtime is older
 * than `cutoffEpochMs`. Returns the count of pruned directories.
 *
 * Errors on individual entries are logged and skipped — the cron MUST
 * not fail outright because one orphaned dir refuses to delete.
 */
export async function pruneTraceDirectory(
  paDataDir: string,
  cutoffEpochMs: number,
): Promise<number> {
  const root = tracesRootDir(paDataDir);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    logger.warn({ err }, "pruneTraceDirectory readdir failed");
    return 0;
  }
  let pruned = 0;
  for (const entry of entries) {
    const dir = join(root, entry);
    try {
      const stats = await stat(dir);
      if (!stats.isDirectory()) continue;
      if (stats.mtimeMs >= cutoffEpochMs) continue;
      await rm(dir, { recursive: true, force: true });
      pruned += 1;
    } catch (err) {
      logger.warn(
        { err, dir },
        "pruneTraceDirectory entry skip",
      );
    }
  }
  return pruned;
}
