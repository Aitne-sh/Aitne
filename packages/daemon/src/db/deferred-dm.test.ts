import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import {
  deferDmToQuietHoursEnd,
  retimeDeferredDmRows,
  retimeDeferredRunRows,
} from "./deferred-dm.js";

const WINDOW = { start: "22:00", end: "08:00", timezone: "UTC" };
/** Inside the 22:00→08:00 UTC overnight window. */
const QUIET_NOW = new Date("2026-06-10T23:00:00Z");
/** Outside it. */
const LOUD_NOW = new Date("2026-06-10T12:00:00Z");

interface ScheduleRow {
  id: number;
  scheduled_for: string;
  task_type: string;
  task_description: string;
  task_context: string;
  model: string | null;
  status: string;
}

function allRows(db: Database.Database): ScheduleRow[] {
  return db
    .prepare(
      `SELECT id, scheduled_for, task_type, task_description, task_context, model, status
         FROM agent_schedule ORDER BY id`,
    )
    .all() as ScheduleRow[];
}

function auditRows(db: Database.Database): { action_type: string; detail: string }[] {
  return db
    .prepare(`SELECT action_type, detail FROM agent_actions ORDER BY id`)
    .all() as { action_type: string; detail: string }[];
}

describe("deferDmToQuietHoursEnd", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns null outside quiet hours and writes nothing", () => {
    const result = deferDmToQuietHoursEnd(
      db,
      WINDOW,
      { message: "hi", deferredFrom: "api.notify" },
      LOUD_NOW,
    );
    expect(result).toBeNull();
    expect(allRows(db)).toHaveLength(0);
    expect(auditRows(db)).toHaveLength(0);
  });

  it("inserts a task_type='dm' row at the quiet-hours end with origin markers + audit row", () => {
    const result = deferDmToQuietHoursEnd(
      db,
      WINDOW,
      {
        message: "Overnight briefing text",
        platforms: ["slack"],
        deferredFrom: "api.notify",
        originSessionId: 42,
        agentId: "inbox-watcher",
      },
      QUIET_NOW,
    );

    expect(result).toEqual({
      scheduleId: expect.any(String),
      deliverAfter: "2026-06-11 08:00:00",
      coalesced: false,
    });

    const rows = allRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].task_type).toBe("dm");
    expect(rows[0].status).toBe("pending");
    expect(rows[0].model).toBeNull();
    expect(rows[0].scheduled_for).toBe("2026-06-11 08:00:00");
    expect(rows[0].task_description).toBe("Overnight briefing text");
    expect(JSON.parse(rows[0].task_context)).toEqual({
      platforms: ["slack"],
      importance: "transient",
      deferred_from: "api.notify",
      origin_session_id: 42,
      agent_id: "inbox-watcher",
    });

    const audits = auditRows(db);
    expect(audits).toHaveLength(1);
    expect(audits[0].action_type).toBe("notify.deferred_for_quiet_hours");
    expect(JSON.parse(audits[0].detail)).toEqual({
      scheduleId: result!.scheduleId,
      deferredFrom: "api.notify",
      originSessionId: 42,
      agentId: "inbox-watcher",
      deliverAfter: "2026-06-11 08:00:00",
      coalesced: false,
      quietHoursStart: "22:00",
      quietHoursEnd: "08:00",
    });
  });

  it("omits origin markers that are not resolvable", () => {
    deferDmToQuietHoursEnd(
      db,
      WINDOW,
      { message: "anon", deferredFrom: "api.notify" },
      QUIET_NOW,
    );
    expect(JSON.parse(allRows(db)[0].task_context)).toEqual({
      platforms: null,
      importance: "transient",
      deferred_from: "api.notify",
    });
  });

  it("coalesces a second deferral from the same Agent into one combined row (across sessions)", () => {
    const first = deferDmToQuietHoursEnd(
      db,
      WINDOW,
      {
        message: "first ping",
        deferredFrom: "api.notify",
        originSessionId: 1,
        agentId: "inbox-watcher",
      },
      QUIET_NOW,
    );
    const second = deferDmToQuietHoursEnd(
      db,
      WINDOW,
      {
        message: "second ping",
        deferredFrom: "api.notify",
        originSessionId: 2,
        agentId: "inbox-watcher",
      },
      new Date("2026-06-11T02:00:00Z"),
    );

    expect(second).toEqual({
      scheduleId: first!.scheduleId,
      deliverAfter: first!.deliverAfter,
      coalesced: true,
    });
    const rows = allRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].task_description).toBe("first ping\n\nsecond ping");
    // One audit row per deferral, including the coalesced one.
    expect(auditRows(db)).toHaveLength(2);
    expect(JSON.parse(auditRows(db)[1].detail).coalesced).toBe(true);
  });

  it("coalesces by origin session when no Agent id is resolvable", () => {
    deferDmToQuietHoursEnd(
      db,
      WINDOW,
      { message: "a", deferredFrom: "api.notify", originSessionId: 7 },
      QUIET_NOW,
    );
    const second = deferDmToQuietHoursEnd(
      db,
      WINDOW,
      { message: "b", deferredFrom: "api.notify", originSessionId: 7 },
      QUIET_NOW,
    );
    expect(second!.coalesced).toBe(true);
    expect(allRows(db)).toHaveLength(1);
  });

  it("coalesces anonymous deferrals into the shared bucket", () => {
    deferDmToQuietHoursEnd(
      db,
      WINDOW,
      { message: "a", deferredFrom: "api.notify" },
      QUIET_NOW,
    );
    const second = deferDmToQuietHoursEnd(
      db,
      WINDOW,
      { message: "b", deferredFrom: "api.notify" },
      QUIET_NOW,
    );
    expect(second!.coalesced).toBe(true);
    expect(allRows(db)[0].task_description).toBe("a\n\nb");
  });

  it("does NOT coalesce across different origins or different identities", () => {
    deferDmToQuietHoursEnd(
      db,
      WINDOW,
      { message: "a", deferredFrom: "api.notify", agentId: "agent-a" },
      QUIET_NOW,
    );
    const otherAgent = deferDmToQuietHoursEnd(
      db,
      WINDOW,
      { message: "b", deferredFrom: "api.notify", agentId: "agent-b" },
      QUIET_NOW,
    );
    const otherSession = deferDmToQuietHoursEnd(
      db,
      WINDOW,
      { message: "c", deferredFrom: "api.notify", originSessionId: 9 },
      QUIET_NOW,
    );
    const otherOrigin = deferDmToQuietHoursEnd(
      db,
      WINDOW,
      { message: "d", deferredFrom: "scheduled.task", agentId: "agent-a" },
      QUIET_NOW,
    );
    expect(otherAgent!.coalesced).toBe(false);
    expect(otherSession!.coalesced).toBe(false);
    expect(otherOrigin!.coalesced).toBe(false);
    expect(allRows(db)).toHaveLength(4);
  });

  it("ignores user-scheduled dm rows (no deferred_from marker) when coalescing", () => {
    db.prepare(
      `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, model, status)
       VALUES ('2026-06-11 08:00:00', 'dm', 'user reminder', '{"platforms":null,"importance":"transient"}', NULL, 'pending')`,
    ).run();
    const result = deferDmToQuietHoursEnd(
      db,
      WINDOW,
      { message: "deferred", deferredFrom: "api.notify" },
      QUIET_NOW,
    );
    expect(result!.coalesced).toBe(false);
    expect(allRows(db)).toHaveLength(2);
    expect(allRows(db)[0].task_description).toBe("user reminder");
  });

  it("unions explicit platforms on coalesce; either side defaulting keeps the default", () => {
    deferDmToQuietHoursEnd(
      db,
      WINDOW,
      { message: "a", platforms: ["slack"], deferredFrom: "api.notify" },
      QUIET_NOW,
    );
    deferDmToQuietHoursEnd(
      db,
      WINDOW,
      { message: "b", platforms: ["telegram", "slack"], deferredFrom: "api.notify" },
      QUIET_NOW,
    );
    expect(JSON.parse(allRows(db)[0].task_context).platforms).toEqual([
      "slack",
      "telegram",
    ]);

    deferDmToQuietHoursEnd(
      db,
      WINDOW,
      { message: "c", deferredFrom: "api.notify" },
      QUIET_NOW,
    );
    expect(JSON.parse(allRows(db)[0].task_context).platforms).toBeNull();
  });

  it("skips a pending row with malformed task_context JSON and inserts a fresh one", () => {
    // Without the json_valid WHERE guard this row would make json_extract
    // throw for the whole coalesce query.
    db.prepare(
      `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, model, status)
       VALUES ('2026-06-11 08:00:00', 'dm', 'broken', '{"deferred_from":"api.notify"', NULL, 'pending')`,
    ).run();
    const result = deferDmToQuietHoursEnd(
      db,
      WINDOW,
      { message: "fresh", deferredFrom: "api.notify" },
      QUIET_NOW,
    );
    expect(result!.coalesced).toBe(false);
    expect(allRows(db)).toHaveLength(2);
  });

  it("tolerates an audit-write failure (deferred row still persisted)", () => {
    db.exec("DROP TABLE agent_actions");
    const result = deferDmToQuietHoursEnd(
      db,
      WINDOW,
      { message: "still works", deferredFrom: "api.notify" },
      QUIET_NOW,
    );
    expect(result).not.toBeNull();
    expect(allRows(db)).toHaveLength(1);
  });
});

describe("retimeDeferredDmRows", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function insertDeferred(scheduledFor: string): number {
    const r = db
      .prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, model, status)
         VALUES (?, 'dm', 'deferred ping', '{"platforms":null,"importance":"transient","deferred_from":"api.notify"}', NULL, 'pending')`,
      )
      .run(scheduledFor);
    return Number(r.lastInsertRowid);
  }

  function scheduledFor(id: number): string {
    return (
      db
        .prepare("SELECT scheduled_for FROM agent_schedule WHERE id = ?")
        .get(id) as { scheduled_for: string }
    ).scheduled_for;
  }

  it("returns 0 and writes nothing when no deferred rows exist", () => {
    db.prepare(
      `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, model, status)
       VALUES ('2026-06-11 08:00:00', 'dm', 'user reminder', '{"platforms":null}', NULL, 'pending')`,
    ).run();
    expect(retimeDeferredDmRows(db, WINDOW, QUIET_NOW)).toBe(0);
  });

  it("moves deferred rows to the new quiet-hours end when still inside the window (window widened)", () => {
    // Row stamped under the old 22:00→08:00 window…
    const id = insertDeferred("2026-06-11 08:00:00");
    // …user widens the window to 22:00→10:00 at 23:00.
    const widened = { ...WINDOW, end: "10:00" };
    expect(retimeDeferredDmRows(db, widened, QUIET_NOW)).toBe(1);
    expect(scheduledFor(id)).toBe("2026-06-11 10:00:00");
  });

  it("pulls future-dated rows up to now when the new window no longer covers now (window narrowed)", () => {
    // Row stamped for the old 08:00 edge; user narrows the end to 06:00
    // and it is now 06:30 — outside the new window.
    const id = insertDeferred("2026-06-11 08:00:00");
    const narrowed = { ...WINDOW, end: "06:00" };
    const now = new Date("2026-06-11T06:30:00Z");
    expect(retimeDeferredDmRows(db, narrowed, now)).toBe(1);
    expect(scheduledFor(id)).toBe("2026-06-11 06:30:00");
  });

  it("leaves already-due rows alone outside quiet hours (scheduler's to claim)", () => {
    const id = insertDeferred("2026-06-11 05:00:00");
    const now = new Date("2026-06-11T12:00:00Z");
    expect(retimeDeferredDmRows(db, WINDOW, now)).toBe(0);
    expect(scheduledFor(id)).toBe("2026-06-11 05:00:00");
  });

  it("no-ops on rows already pointing at the new edge", () => {
    const id = insertDeferred("2026-06-11 08:00:00");
    expect(retimeDeferredDmRows(db, WINDOW, QUIET_NOW)).toBe(0);
    expect(scheduledFor(id)).toBe("2026-06-11 08:00:00");
  });

  it("never touches user-scheduled dm rows or non-pending/malformed rows", () => {
    db.prepare(
      `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, model, status)
       VALUES ('2026-06-11 08:00:00', 'dm', 'user reminder', '{"platforms":null,"importance":"transient"}', NULL, 'pending')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, model, status)
       VALUES ('2026-06-11 08:00:00', 'dm', 'done', '{"deferred_from":"api.notify"}', NULL, 'completed')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, model, status)
       VALUES ('2026-06-11 08:00:00', 'dm', 'broken', '{"deferred_from":"api.notify"', NULL, 'pending')`,
    ).run();
    const widened = { ...WINDOW, end: "10:00" };
    expect(retimeDeferredDmRows(db, widened, QUIET_NOW)).toBe(0);
    const rows = db
      .prepare("SELECT scheduled_for FROM agent_schedule")
      .all() as { scheduled_for: string }[];
    expect(rows.every((r) => r.scheduled_for === "2026-06-11 08:00:00")).toBe(
      true,
    );
  });
});

// QUIET_HOURS_HARDENING_PLAN.md Phase 2 follow-up — the run-row sibling of
// retimeDeferredDmRows. Selects on the `quiet_hours_deferred` marker the
// scheduler's deferClaimedRowForQuietHours stamps at deferral time, so rows
// that merely carry the `defer_in_quiet_hours` opt-in on a future cron slot
// are never touched.
describe("retimeDeferredRunRows", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function insertDeferredRun(
    scheduledFor: string,
    taskType = "agent.task",
    context = '{"defer_in_quiet_hours":true,"agent_id":"nightly-digest","quiet_hours_deferred":true}',
    status = "pending",
  ): number {
    const r = db
      .prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, model, status)
         VALUES (?, ?, 'nightly digest', ?, NULL, ?)`,
      )
      .run(scheduledFor, taskType, context, status);
    return Number(r.lastInsertRowid);
  }

  function scheduledFor(id: number): string {
    return (
      db
        .prepare("SELECT scheduled_for FROM agent_schedule WHERE id = ?")
        .get(id) as { scheduled_for: string }
    ).scheduled_for;
  }

  it("returns 0 when no marker-stamped rows exist", () => {
    // Opt-in flag alone (a future cron slot that was never deferred) is NOT
    // selected — its cron-scheduled time must stay put.
    const id = insertDeferredRun(
      "2026-06-11 03:00:00",
      "agent.task",
      '{"defer_in_quiet_hours":true,"agent_id":"nightly-digest"}',
    );
    expect(retimeDeferredRunRows(db, WINDOW, QUIET_NOW)).toBe(0);
    expect(scheduledFor(id)).toBe("2026-06-11 03:00:00");
  });

  it("moves deferred run rows (agent.task + browser_task) to the new edge when the window widens", () => {
    const agentRow = insertDeferredRun("2026-06-11 08:00:00");
    const browserRow = insertDeferredRun(
      "2026-06-11 08:00:00",
      "browser_task",
      '{"preGeneratedTaskId":"t-1","quiet_hours_deferred":true}',
    );
    const widened = { ...WINDOW, end: "10:00" };
    expect(retimeDeferredRunRows(db, widened, QUIET_NOW)).toBe(2);
    expect(scheduledFor(agentRow)).toBe("2026-06-11 10:00:00");
    expect(scheduledFor(browserRow)).toBe("2026-06-11 10:00:00");
  });

  it("pulls a future-dated deferred run up to now when the window narrows past it", () => {
    const id = insertDeferredRun("2026-06-11 08:00:00");
    const narrowed = { ...WINDOW, end: "06:00" };
    const now = new Date("2026-06-11T06:30:00Z");
    expect(retimeDeferredRunRows(db, narrowed, now)).toBe(1);
    expect(scheduledFor(id)).toBe("2026-06-11 06:30:00");
  });

  it("pulls a future-dated deferred run up to now when quiet hours are disabled (start == end)", () => {
    const id = insertDeferredRun("2026-06-11 08:00:00");
    const disabled = { ...WINDOW, start: "00:00", end: "00:00" };
    const now = new Date("2026-06-11T06:30:00Z");
    expect(retimeDeferredRunRows(db, disabled, now)).toBe(1);
    expect(scheduledFor(id)).toBe("2026-06-11 06:30:00");
  });

  it("leaves already-due rows alone outside quiet hours (scheduler's to claim)", () => {
    const due = insertDeferredRun("2026-06-11 05:00:00");
    expect(retimeDeferredRunRows(db, WINDOW, new Date("2026-06-11T12:00:00Z"))).toBe(0);
    expect(scheduledFor(due)).toBe("2026-06-11 05:00:00");
  });

  it("no-ops on rows already pointing at the new edge", () => {
    const atEdge = insertDeferredRun("2026-06-11 08:00:00");
    expect(retimeDeferredRunRows(db, WINDOW, QUIET_NOW)).toBe(0);
    expect(scheduledFor(atEdge)).toBe("2026-06-11 08:00:00");
  });

  it("never touches non-pending or malformed-context rows", () => {
    insertDeferredRun(
      "2026-06-11 08:00:00",
      "agent.task",
      '{"quiet_hours_deferred":true}',
      "completed",
    );
    insertDeferredRun(
      "2026-06-11 08:00:00",
      "agent.task",
      '{"quiet_hours_deferred":true', // malformed JSON
    );
    const widened = { ...WINDOW, end: "10:00" };
    expect(retimeDeferredRunRows(db, widened, QUIET_NOW)).toBe(0);
    const rows = db
      .prepare("SELECT scheduled_for FROM agent_schedule")
      .all() as { scheduled_for: string }[];
    expect(rows.every((r) => r.scheduled_for === "2026-06-11 08:00:00")).toBe(
      true,
    );
  });
});
