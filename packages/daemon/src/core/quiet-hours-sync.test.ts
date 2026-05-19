import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import { syncDmSessionTimesToQuietHours } from "./quiet-hours-sync.js";

function seedRecurring(
  db: Database.Database,
  params: {
    enabled?: boolean;
    pinned: boolean;
    time: string;
    description?: string;
    taskType?: string;
  },
): number {
  const ctx = JSON.stringify({
    sub_flow: "morning_briefing",
    pin_to_quiet_hours_end: params.pinned,
  });
  const rule = JSON.stringify({
    frequency: "daily",
    time: params.time,
    timezone: "America/New_York",
  });
  const result = db
    .prepare(
      `INSERT INTO recurring_schedules
         (task_type, task_description, task_context, model, recurrence_rule, enabled)
       VALUES (?, ?, ?, 'sonnet', ?, ?)`,
    )
    .run(
      params.taskType ?? "dm_session",
      params.description ?? "morning briefing — daily summary",
      ctx,
      rule,
      params.enabled === false ? 0 : 1,
    );
  return Number(result.lastInsertRowid);
}

describe("syncDmSessionTimesToQuietHours", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("retimes pinned dm_session rows to the new quiet-hours edge", () => {
    const id = seedRecurring(db, { pinned: true, time: "08:00" });

    syncDmSessionTimesToQuietHours(db, "07:30");

    const row = db
      .prepare("SELECT recurrence_rule FROM recurring_schedules WHERE id = ?")
      .get(id) as { recurrence_rule: string };
    const rule = JSON.parse(row.recurrence_rule) as { time: string };
    expect(rule.time).toBe("07:30");
  });

  it("leaves user-pinned rows (pin_to_quiet_hours_end:false) untouched", () => {
    const id = seedRecurring(db, { pinned: false, time: "06:30" });

    syncDmSessionTimesToQuietHours(db, "07:30");

    const row = db
      .prepare("SELECT recurrence_rule FROM recurring_schedules WHERE id = ?")
      .get(id) as { recurrence_rule: string };
    const rule = JSON.parse(row.recurrence_rule) as { time: string };
    expect(rule.time).toBe("06:30");
  });

  it("ignores disabled rows", () => {
    const id = seedRecurring(db, {
      pinned: true,
      time: "08:00",
      enabled: false,
    });

    syncDmSessionTimesToQuietHours(db, "07:30");

    const row = db
      .prepare("SELECT recurrence_rule FROM recurring_schedules WHERE id = ?")
      .get(id) as { recurrence_rule: string };
    const rule = JSON.parse(row.recurrence_rule) as { time: string };
    expect(rule.time).toBe("08:00");
  });

  it("ignores non-dm_session rows", () => {
    const id = seedRecurring(db, {
      pinned: true,
      time: "08:00",
      taskType: "wake",
    });

    syncDmSessionTimesToQuietHours(db, "07:30");

    const row = db
      .prepare("SELECT recurrence_rule FROM recurring_schedules WHERE id = ?")
      .get(id) as { recurrence_rule: string };
    const rule = JSON.parse(row.recurrence_rule) as { time: string };
    expect(rule.time).toBe("08:00");
  });

  it("skips when the recurrence time already matches (no-op)", () => {
    const id = seedRecurring(db, { pinned: true, time: "07:30" });
    const before = db
      .prepare("SELECT updated_at FROM recurring_schedules WHERE id = ?")
      .get(id) as { updated_at: string };

    syncDmSessionTimesToQuietHours(db, "07:30");

    const after = db
      .prepare("SELECT updated_at FROM recurring_schedules WHERE id = ?")
      .get(id) as { updated_at: string };
    // updated_at unchanged because no UPDATE ran.
    expect(after.updated_at).toBe(before.updated_at);
  });

  it("cancels the pending agent_schedule row of a retimed recurring", () => {
    const recurringId = seedRecurring(db, { pinned: true, time: "08:00" });
    db.prepare(
      `INSERT INTO agent_schedule
         (scheduled_for, task_type, task_description, model, status, recurring_schedule_id)
       VALUES (datetime('now', '+1 hour'), 'dm_session', 'm', 'sonnet', 'pending', ?)`,
    ).run(recurringId);

    syncDmSessionTimesToQuietHours(db, "07:30");

    const pending = db
      .prepare(
        "SELECT status FROM agent_schedule WHERE recurring_schedule_id = ?",
      )
      .get(recurringId) as { status: string };
    expect(pending.status).toBe("skipped");
  });

  it("returns silently when the recurring_schedules table is missing", () => {
    db.exec("DROP TABLE recurring_schedules");
    expect(() =>
      syncDmSessionTimesToQuietHours(db, "07:30"),
    ).not.toThrow();
  });

  it("skips rows with malformed JSON in task_context or recurrence_rule", () => {
    // Insert a dm_session row whose task_context can't be JSON.parsed —
    // the sync must skip it, not throw.
    db.prepare(
      `INSERT INTO recurring_schedules
         (task_type, task_description, task_context, model, recurrence_rule, enabled)
       VALUES ('dm_session', 'broken row', '{broken json', 'sonnet', '{"frequency":"daily","time":"08:00"}', 1)`,
    ).run();
    expect(() => syncDmSessionTimesToQuietHours(db, "07:30")).not.toThrow();
  });

  it("treats an empty task_context as `{}` (falsy short-circuit branch)", () => {
    // Hits the `row.task_context || "{}"` falsy branch. The parsed ctx
    // then lacks `pin_to_quiet_hours_end`, so the row is skipped — but
    // the parser must not throw and the row must remain at its original
    // time.
    db.prepare(
      `INSERT INTO recurring_schedules
         (task_type, task_description, task_context, model, recurrence_rule, enabled)
       VALUES ('dm_session', 'empty ctx', '', 'sonnet', '{"frequency":"daily","time":"08:00","timezone":"America/New_York"}', 1)`,
    ).run();

    expect(() => syncDmSessionTimesToQuietHours(db, "07:30")).not.toThrow();

    const row = db
      .prepare(
        "SELECT recurrence_rule FROM recurring_schedules WHERE task_description = 'empty ctx'",
      )
      .get() as { recurrence_rule: string };
    const rule = JSON.parse(row.recurrence_rule) as { time: string };
    expect(rule.time).toBe("08:00");
  });

  it("skips hourly dm_session rows (stamping `time` would write a schema-invalid rule)", () => {
    // SCHEDULE_API_REDESIGN_PLAN §4.1 made `hourly` a valid recurring
    // frequency, but the schema forbids `time` on hourly. If an operator
    // pins an hourly dm_session to quiet hours, the sync must leave the
    // rule alone rather than stamping a forbidden `time` field that the
    // next route PATCH would reject.
    const ctx = JSON.stringify({
      sub_flow: "morning_briefing",
      pin_to_quiet_hours_end: true,
    });
    const rule = JSON.stringify({
      frequency: "hourly",
      intervalHours: 2,
      minuteOfHour: 30,
      timezone: "America/New_York",
    });
    const result = db
      .prepare(
        `INSERT INTO recurring_schedules
           (task_type, task_description, task_context, model, recurrence_rule, enabled)
         VALUES ('dm_session', 'hourly pinned briefing', ?, 'sonnet', ?, 1)`,
      )
      .run(ctx, rule);
    const id = Number(result.lastInsertRowid);

    syncDmSessionTimesToQuietHours(db, "07:30");

    const row = db
      .prepare("SELECT recurrence_rule FROM recurring_schedules WHERE id = ?")
      .get(id) as { recurrence_rule: string };
    const parsed = JSON.parse(row.recurrence_rule) as Record<string, unknown>;
    expect(parsed).toEqual({
      frequency: "hourly",
      intervalHours: 2,
      minuteOfHour: 30,
      timezone: "America/New_York",
    });
    expect(parsed.time).toBeUndefined();
  });

  it("writes next_run_at = NULL when computeNextOccurrence returns null", () => {
    // Weekly rule with no daysOfWeek -> computeNextOccurrence returns null
    // -> the UPDATE sets next_run_at to NULL. Hits the `: null` branch
    // on the `next ? formatSqliteDatetime(next) : null` ternary.
    const ctx = JSON.stringify({
      sub_flow: "morning_briefing",
      pin_to_quiet_hours_end: true,
    });
    const rule = JSON.stringify({
      frequency: "weekly",
      time: "08:00",
      timezone: "America/New_York",
      daysOfWeek: [],
    });
    const result = db
      .prepare(
        `INSERT INTO recurring_schedules
           (task_type, task_description, task_context, model, recurrence_rule, enabled)
         VALUES ('dm_session', 'weekly empty days', ?, 'sonnet', ?, 1)`,
      )
      .run(ctx, rule);
    const id = Number(result.lastInsertRowid);

    syncDmSessionTimesToQuietHours(db, "07:30");

    const row = db
      .prepare(
        "SELECT recurrence_rule, next_run_at FROM recurring_schedules WHERE id = ?",
      )
      .get(id) as { recurrence_rule: string; next_run_at: string | null };
    const updatedRule = JSON.parse(row.recurrence_rule) as { time: string };
    expect(updatedRule.time).toBe("07:30");
    expect(row.next_run_at).toBeNull();
  });
});
