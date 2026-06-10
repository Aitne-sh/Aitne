import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { formatSqliteDatetime, getAgentDayBoundsUtc } from "@aitne/shared";
import { applySchema } from "../db/schema.js";
import { evaluateNotificationRateLimit } from "./notification-rate-limit.js";

const OPTS = {
  maxNotificationsPerHour: 3,
  maxNotificationsPerDay: 12,
  timezone: "UTC",
  dayBoundaryHour: 4,
};

/** Insert a delivered notification_log row at a given instant. */
function insertDelivered(
  db: Database.Database,
  at: Date,
  {
    dispatchId = "",
    notificationType = "agent",
    status = "delivered",
  }: { dispatchId?: string; notificationType?: string; status?: string } = {},
): void {
  db.prepare(
    `INSERT INTO notification_log
       (dispatch_id, notification_type, priority, platform, content_summary, status, created_at, delivered_at)
     VALUES (?, ?, 'normal', 'slack', 'x', ?, ?, ?)`,
  ).run(
    dispatchId,
    notificationType,
    status,
    formatSqliteDatetime(at),
    formatSqliteDatetime(at),
  );
}

describe("evaluateNotificationRateLimit", () => {
  let db: Database.Database;
  // Mid-agent-day instant so hourly-window rows stay inside the day bounds.
  const now = new Date("2026-06-10T12:00:00Z");

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns not-limited on an empty log", () => {
    expect(evaluateNotificationRateLimit(db, OPTS, now)).toEqual({
      limited: false,
      retryAfter: null,
    });
  });

  it("limits when the hourly cap is reached and points retryAfter at the oldest in-window delivery + 1h", () => {
    const oldest = new Date("2026-06-10T11:10:00Z");
    insertDelivered(db, oldest, { dispatchId: "d1" });
    insertDelivered(db, new Date("2026-06-10T11:30:00Z"), { dispatchId: "d2" });
    insertDelivered(db, new Date("2026-06-10T11:50:00Z"), { dispatchId: "d3" });

    const state = evaluateNotificationRateLimit(db, OPTS, now);
    expect(state.limited).toBe(true);
    expect(state.retryAfter).toBe("2026-06-10 12:10:00");
  });

  it("counts a multi-channel dispatch once (DISTINCT dispatch_id)", () => {
    const at = new Date("2026-06-10T11:30:00Z");
    insertDelivered(db, at, { dispatchId: "same" });
    insertDelivered(db, at, { dispatchId: "same" });
    insertDelivered(db, at, { dispatchId: "same" });

    expect(evaluateNotificationRateLimit(db, OPTS, now).limited).toBe(false);
  });

  it("falls back to the row id for legacy rows with an empty dispatch_id", () => {
    insertDelivered(db, new Date("2026-06-10T11:20:00Z"));
    insertDelivered(db, new Date("2026-06-10T11:30:00Z"));
    insertDelivered(db, new Date("2026-06-10T11:40:00Z"));

    expect(evaluateNotificationRateLimit(db, OPTS, now).limited).toBe(true);
  });

  it("ignores non-delivered rows and message.received replies", () => {
    insertDelivered(db, new Date("2026-06-10T11:20:00Z"), {
      dispatchId: "s1",
      status: "suppressed",
    });
    insertDelivered(db, new Date("2026-06-10T11:30:00Z"), {
      dispatchId: "r1",
      notificationType: "message.received",
    });
    insertDelivered(db, new Date("2026-06-10T11:40:00Z"), { dispatchId: "d1" });

    expect(evaluateNotificationRateLimit(db, OPTS, now).limited).toBe(false);
  });

  it("ignores deliveries older than one hour for the hourly window", () => {
    insertDelivered(db, new Date("2026-06-10T10:30:00Z"), { dispatchId: "old1" });
    insertDelivered(db, new Date("2026-06-10T10:40:00Z"), { dispatchId: "old2" });
    insertDelivered(db, new Date("2026-06-10T11:30:00Z"), { dispatchId: "d1" });

    expect(evaluateNotificationRateLimit(db, OPTS, now).limited).toBe(false);
  });

  it("limits on the daily cap with retryAfter at the agent-day end", () => {
    // Spread 12 dispatches across the agent day, none inside the trailing
    // hour, so only the daily gate fires.
    for (let i = 0; i < 12; i++) {
      insertDelivered(db, new Date(`2026-06-10T0${4 + (i % 6)}:0${i % 10}:00Z`), {
        dispatchId: `day-${i}`,
      });
    }

    const state = evaluateNotificationRateLimit(db, OPTS, now);
    expect(state.limited).toBe(true);
    expect(state.retryAfter).toBe(
      getAgentDayBoundsUtc("UTC", OPTS.dayBoundaryHour, now).end,
    );
  });

  it("falls back to the system timezone when timezone is empty", () => {
    expect(
      evaluateNotificationRateLimit(db, { ...OPTS, timezone: "" }, now),
    ).toEqual({ limited: false, retryAfter: null });
  });

  it("degrades to retry-at-now+1h when a zero hourly cap limits an empty window", () => {
    const state = evaluateNotificationRateLimit(
      db,
      { ...OPTS, maxNotificationsPerHour: 0 },
      now,
    );
    expect(state.limited).toBe(true);
    expect(state.retryAfter).toBe("2026-06-10 13:00:00");
  });
});
