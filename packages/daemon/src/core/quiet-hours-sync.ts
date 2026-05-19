import type Database from "better-sqlite3";
import {
  formatSqliteDatetime,
  type RecurrenceRule,
} from "@aitne/shared";
import { computeNextOccurrence } from "./recurrence.js";

/**
 * SCHEDULED-DM-IMPLEMENTATION-PLAN §6.7 — retime every enabled
 * `dm_session` recurring row whose `task_context.pin_to_quiet_hours_end
 * === true` so the briefing tracks the user's quiet-hours edge.
 * Rows with the pin flag false (user-pinned via DM) are left alone.
 *
 * Recomputes `next_run_at` from the updated rule and clears the
 * existing pending `agent_schedule` row so the reconciler emits the
 * next occurrence at the new time. Pure DB logic — exported as its
 * own module so the dashboard config PATCH can call it AND tests can
 * exercise it without spinning up a Hono app.
 */
export function syncDmSessionTimesToQuietHours(
  db: Database.Database,
  newQuietHoursEnd: string,
): void {
  const tableExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='recurring_schedules'",
    )
    .get();
  if (!tableExists) return;

  const rows = db
    .prepare(
      `SELECT id, recurrence_rule, task_context
       FROM recurring_schedules
       WHERE task_type = 'dm_session' AND enabled = 1`,
    )
    .all() as { id: number; recurrence_rule: string; task_context: string }[];

  for (const row of rows) {
    let ctx: Record<string, unknown>;
    let rule: RecurrenceRule;
    try {
      ctx = JSON.parse(row.task_context || "{}");
      rule = JSON.parse(row.recurrence_rule) as RecurrenceRule;
    } catch {
      continue;
    }
    if (ctx.pin_to_quiet_hours_end !== true) continue;
    // SCHEDULE_API_REDESIGN_PLAN §4.1 — hourly rules forbid the `time`
    // field; stamping one on would write a schema-invalid rule that the
    // next route PATCH would reject. The morning-briefing pin only
    // makes sense for daily/weekly/monthly cadences anyway, so skip
    // rather than corrupt.
    if (rule.frequency === "hourly") continue;
    if (rule.time === newQuietHoursEnd) continue;

    const updated: RecurrenceRule = { ...rule, time: newQuietHoursEnd };
    const next = computeNextOccurrence(updated, new Date());
    const nextRunAt = next ? formatSqliteDatetime(next) : null;
    db.prepare(
      `UPDATE recurring_schedules
       SET recurrence_rule = ?, next_run_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(JSON.stringify(updated), nextRunAt, row.id);
    db.prepare(
      `UPDATE agent_schedule
       SET status = 'skipped'
       WHERE recurring_schedule_id = ? AND status = 'pending'`,
    ).run(row.id);
  }
}
