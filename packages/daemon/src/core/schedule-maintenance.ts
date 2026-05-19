import type Database from "better-sqlite3";
import { createLogger } from "../logging.js";

const logger = createLogger("schedule-maintenance");

export interface OrphanedRunningRecoveryResult {
  skipped: number;
  failed: number;
}

/**
 * Discard pending tasks that belong to a previous agent day.
 *
 * The user explicitly prefers stale notifications / wake tasks to be dropped
 * rather than replayed after downtime.
 */
export function discardStalePendingSchedules(
  db: Database.Database,
  currentAgentDayStartUtc: string,
): number {
  const result = db
    .prepare(
      `UPDATE agent_schedule
          SET status = 'skipped'
        WHERE status = 'pending'
          AND scheduled_for < ?`,
    )
    .run(currentAgentDayStartUtc);

  return result.changes;
}

/**
 * Resolve orphaned running tasks after a crash without replaying them.
 *
 * Replaying a mid-flight task can duplicate side effects (DM sends, external
 * writes). Current-agent-day rows become failed for visibility; older rows are
 * skipped as stale.
 */
export function recoverOrphanedRunningSchedules(
  db: Database.Database,
  currentAgentDayStartUtc: string,
): OrphanedRunningRecoveryResult {
  const skipResult = db
    .prepare(
      `UPDATE agent_schedule
          SET status = 'skipped'
        WHERE status = 'running'
          AND scheduled_for < ?`,
    )
    .run(currentAgentDayStartUtc);

  const failResult = db
    .prepare(
      `UPDATE agent_schedule
          SET status = 'failed'
        WHERE status = 'running'`,
    )
    .run();

  const result = {
    skipped: skipResult.changes,
    failed: failResult.changes,
  };

  if (result.skipped > 0 || result.failed > 0) {
    logger.info(result, "Recovered orphaned running schedules");
  }

  return result;
}

export function hasActionInWindow(
  db: Database.Database,
  actionType: string,
  startUtc: string,
  endUtc: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS seen
         FROM agent_actions
        WHERE action_type = ?
          AND started_at >= ?
          AND started_at < ?
        LIMIT 1`,
    )
    .get(actionType, startUtc, endUtc) as { seen: number } | undefined;

  return !!row;
}
