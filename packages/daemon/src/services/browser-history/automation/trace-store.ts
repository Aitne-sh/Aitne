/**
 * Trace store I/O — filesystem side of the Playwright trace +
 * screenshot capture surface.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §8.7.
 *
 * Three responsibilities:
 *   1. Build a `ScreenshotSink` the workflow uses inside `run()`.
 *      `capture(label, page)` writes a PNG into the per-workflow trace
 *      directory and returns the **API-served path** the workflow
 *      stores in its output schema's `screenshotPath` field.
 *   2. Prune trace assets older than `TRACE_RETENTION_DAYS` (14 d).
 *      Called from the daily retention cron.
 *   3. Resolve an API-served path back to a filesystem path for the
 *      `/api/browser-automation/traces/...` route handler — pure-logic
 *      half lives in `trace-store-paths.ts`.
 *
 * This module is excluded from the 100% coverage gate (FS I/O around
 * `fs/promises.mkdir` / `readdir` / `stat` / `rm` is hard to exercise
 * without process-level mocks that ESM blocks). The pure path
 * arithmetic in `trace-store-paths.ts` IS in the covered set so the
 * directory-traversal defence is locked in by tests.
 */

import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { createLogger } from "../../../logging.js";
import type { ScreenshotSink } from "./types.js";
import {
  apiPathForTraceFile,
  makeScreenshotFileName,
  tracesRootDir,
  workflowTraceDir,
} from "./trace-store-paths.js";

const logger = createLogger("browser-automation-trace-store");

/** Days to retain trace assets before the daily cleanup deletes them. */
export const TRACE_RETENTION_DAYS = 14;

/** Build a per-workflow screenshot sink. Each `capture` call writes one
 *  PNG into the workflow's trace dir and returns the API-served path. */
export function makeScreenshotSink(opts: {
  paDataDir: string;
  workflowId: string;
}): ScreenshotSink {
  const dir = workflowTraceDir({
    paDataDir: opts.paDataDir,
    workflowId: opts.workflowId,
  });
  return {
    async capture(label: string, page: unknown): Promise<string> {
      await mkdir(dir, { recursive: true });
      const fileName = makeScreenshotFileName(label, Date.now());
      const absolutePath = join(dir, fileName);
      // Playwright's Page type carries `screenshot({ path, fullPage })`
      // — we typecheck via a structural cast to keep this module free
      // of playwright-core imports. The workflow runner that wires
      // this is the only caller and supplies a real Page.
      await (page as {
        screenshot: (opts: { path: string; fullPage?: boolean }) => Promise<Buffer>;
      }).screenshot({ path: absolutePath, fullPage: true });
      return apiPathForTraceFile(opts.workflowId, fileName);
    },
  };
}

/**
 * Delete every per-workflow trace directory whose latest mtime is older
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
