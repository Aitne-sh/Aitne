import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  discardStalePendingSchedules,
  recoverOrphanedRunningSchedules,
  hasActionInWindow,
} from "./schedule-maintenance.js";

describe("schedule-maintenance", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE agent_schedule (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scheduled_for TEXT NOT NULL,
        task_type TEXT NOT NULL,
        task_description TEXT,
        task_context TEXT DEFAULT '{}',
        correlation_id TEXT,
        model TEXT,
        status TEXT DEFAULT 'pending',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE agent_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action_type TEXT NOT NULL,
        started_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  it("skips only stale pending schedules", () => {
    db.prepare(
      `INSERT INTO agent_schedule (scheduled_for, task_type, status)
       VALUES
       ('2026-04-06 23:30:00', 'wake', 'pending'),
       ('2026-04-07 04:00:00', 'wake', 'pending'),
       ('2026-04-07 09:00:00', 'wake', 'running')`,
    ).run();

    const skipped = discardStalePendingSchedules(db, "2026-04-07 04:00:00");

    expect(skipped).toBe(1);
    const statuses = db
      .prepare("SELECT id, status FROM agent_schedule ORDER BY id ASC")
      .all() as { id: number; status: string }[];
    expect(statuses).toEqual([
      { id: 1, status: "skipped" },
      { id: 2, status: "pending" },
      { id: 3, status: "running" },
    ]);
  });

  it("marks orphaned running schedules as skipped or failed without replaying them", () => {
    db.prepare(
      `INSERT INTO agent_schedule (scheduled_for, task_type, status)
       VALUES
       ('2026-04-06 22:00:00', 'wake', 'running'),
       ('2026-04-07 08:30:00', 'wake', 'running'),
       ('2026-04-07 09:00:00', 'wake', 'pending')`,
    ).run();

    const result = recoverOrphanedRunningSchedules(db, "2026-04-07 04:00:00");

    expect(result).toEqual({ skipped: 1, failed: 1 });
    const statuses = db
      .prepare("SELECT id, status FROM agent_schedule ORDER BY id ASC")
      .all() as { id: number; status: string }[];
    expect(statuses).toEqual([
      { id: 1, status: "skipped" },
      { id: 2, status: "failed" },
      { id: 3, status: "pending" },
    ]);
  });

  it("detects whether a routine already ran in the current agent-day window", () => {
    db.prepare(
      `INSERT INTO agent_actions (action_type, started_at)
       VALUES
       ('routine.evening_review', '2026-04-07 18:10:00'),
       ('routine.hourly_check', '2026-04-07 12:00:00')`,
    ).run();

    expect(
      hasActionInWindow(
        db,
        "routine.evening_review",
        "2026-04-07 04:00:00",
        "2026-04-08 04:00:00",
      ),
    ).toBe(true);
    expect(
      hasActionInWindow(
        db,
        "routine.monthly_review",
        "2026-04-07 04:00:00",
        "2026-04-08 04:00:00",
      ),
    ).toBe(false);
  });
});
