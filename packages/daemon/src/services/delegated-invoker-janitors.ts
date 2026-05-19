import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createLogger } from "../logging.js";
import { DELEGATED_PROXY_DEFAULTS } from "./delegated-proxy-config.js";

/**
 * Boot-time janitors for the delegated proxy + task subsystem.
 *
 * - {@link runDelegatedTaskOrphanJanitor} closes orphan `delegated_task.*`
 *   rows whose owning subprocess died before the daemon could complete
 *   them (SIGKILL / crash mid-task). Without it, in-flight rows
 *   accumulate forever and skew the dashboard's in-flight counter.
 * - {@link runProxyTempdirJanitor} sweeps stale `proxy-*` session dirs
 *   under `<dataDir>/agent-sessions/`. Covers the SIGKILL window the
 *   per-call `finally` cannot reach.
 *
 * Both are pure top-level exports — no invoker instance state.
 */

const logger = createLogger("delegated-proxy-janitors");

/**
 * DELEGATED-TASK-MODE-DESIGN.md §11.1 crash safety — boot-time janitor
 * that flips orphaned `delegated_task.exec` rows older than `maxAgeMs`
 * (default 5 min) from `result='in_progress'` to `result='failed'` with
 * `error='subprocess_orphaned'`. Without this, a daemon crash mid-task
 * leaves the row in flight forever and poisons the dashboard's "in-flight
 * task" counter.
 *
 * Returns the number of rows updated.
 */
export function runDelegatedTaskOrphanJanitor(
  db: Database.Database,
  options: { now?: () => number; maxAgeMs?: number } = {},
): number {
  const maxAgeMs =
    options.maxAgeMs ?? DELEGATED_PROXY_DEFAULTS.janitorMaxAgeMs;
  const cutoffMs = (options.now?.() ?? Date.now()) - maxAgeMs;
  const cutoffIso = new Date(cutoffMs).toISOString();
  try {
    const result = db
      .prepare(
        `UPDATE agent_actions SET
           result = 'failed',
           error = 'subprocess_orphaned',
           completed_at = datetime('now')
         WHERE action_type IN ('delegated_task.exec', 'delegated_task.run', 'delegated_task.tool_step')
           AND result = 'in_progress'
           AND started_at < datetime(?)`,
      )
      .run(cutoffIso);
    if (result.changes > 0) {
      logger.info(
        { changes: result.changes },
        "delegated task janitor: closed orphaned in-progress rows",
      );
    }
    return result.changes;
  } catch (err) {
    logger.warn({ err }, "delegated task janitor: SQL update failed");
    return 0;
  }
}

/**
 * Boot-time janitor — scans the sessions root for orphan `proxy-*` dirs
 * older than the configured threshold and removes them. Covers the SIGKILL
 * mid-call case the per-call `finally` cannot. Safe to call before any
 * invocations have happened.
 *
 * Returns the number of directories removed (for logging at startup).
 */
export function runProxyTempdirJanitor(
  dataDir: string,
  options: { now?: () => number; maxAgeMs?: number } = {},
): number {
  const now = options.now ?? Date.now;
  const maxAgeMs =
    options.maxAgeMs ?? DELEGATED_PROXY_DEFAULTS.janitorMaxAgeMs;
  const root = join(dataDir, "agent-sessions");
  if (!existsSync(root)) return 0;
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch (err) {
    logger.warn({ err, root }, "proxy janitor: readdir failed");
    return 0;
  }
  for (const entry of entries) {
    if (!entry.startsWith(DELEGATED_PROXY_DEFAULTS.tempdirPrefix)) continue;
    const path = join(root, entry);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (now() - stat.mtimeMs < maxAgeMs) continue;
    try {
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch (err) {
      logger.warn({ err, path }, "proxy janitor: rm failed");
    }
  }
  if (removed > 0) {
    logger.info({ removed }, "proxy janitor: removed orphan tempdirs");
  }
  return removed;
}
