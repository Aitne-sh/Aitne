import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { formatSqliteDatetime } from "@aitne/shared";
import { applySchema } from "../db/schema.js";
import {
  SAFETY_CATEGORIES,
  bypassesOutboundGate,
  gateOutboundNotification,
} from "./notification-gate.js";

const CONFIG = {
  quietHoursStart: "22:00",
  quietHoursEnd: "08:00",
  timezone: "UTC",
  maxNotificationsPerHour: 3,
  maxNotificationsPerDay: 12,
  dayBoundaryHour: 4,
};

const QUIET_NOW = new Date("2026-06-10T23:00:00Z");
const LOUD_NOW = new Date("2026-06-10T12:00:00Z");

describe("bypassesOutboundGate", () => {
  it("bypasses on critical and urgent priority", () => {
    expect(bypassesOutboundGate("critical", undefined)).toBe(true);
    expect(bypassesOutboundGate("urgent", undefined)).toBe(true);
  });

  it.each(SAFETY_CATEGORIES)("bypasses on safety type %s", (category) => {
    expect(bypassesOutboundGate("normal", category)).toBe(true);
  });

  it("does not bypass on normal/high/low priority with ordinary types", () => {
    expect(bypassesOutboundGate("normal", "agent")).toBe(false);
    expect(bypassesOutboundGate("high", undefined)).toBe(false);
    expect(bypassesOutboundGate("low", "self_tuning")).toBe(false);
    expect(bypassesOutboundGate(undefined, undefined)).toBe(false);
  });
});

describe("gateOutboundNotification", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  const params = (overrides: Record<string, unknown> = {}) => ({
    message: "hello",
    deferredFrom: "api.notify",
    ...overrides,
  });

  it("sends outside quiet hours when under the rate limits", () => {
    expect(gateOutboundNotification(db, CONFIG, params(), LOUD_NOW)).toEqual({
      action: "send",
    });
  });

  it("defers inside quiet hours and persists the dm row", () => {
    const result = gateOutboundNotification(db, CONFIG, params(), QUIET_NOW);
    expect(result).toEqual({
      action: "defer",
      scheduleId: expect.any(String),
      deliverAfter: "2026-06-11 08:00:00",
      coalesced: false,
    });
    const row = db
      .prepare("SELECT task_type, status FROM agent_schedule")
      .get() as { task_type: string; status: string };
    expect(row).toEqual({ task_type: "dm", status: "pending" });
  });

  it("delivers critical priority immediately even inside quiet hours", () => {
    expect(
      gateOutboundNotification(
        db,
        CONFIG,
        params({ priority: "critical" }),
        QUIET_NOW,
      ),
    ).toEqual({ action: "send" });
  });

  it("rate-limits the immediate path outside quiet hours", () => {
    const insert = db.prepare(
      `INSERT INTO notification_log
         (dispatch_id, notification_type, priority, platform, content_summary, status, created_at, delivered_at)
       VALUES (?, 'agent', 'normal', 'slack', 'x', 'delivered', ?, ?)`,
    );
    for (let i = 0; i < 3; i++) {
      const at = formatSqliteDatetime(
        new Date(LOUD_NOW.getTime() - (i + 1) * 60_000),
      );
      insert.run(`d${i}`, at, at);
    }

    const result = gateOutboundNotification(db, CONFIG, params(), LOUD_NOW);
    expect(result.action).toBe("rate_limit");
    expect(
      (result as { action: "rate_limit"; retryAfter: string | null })
        .retryAfter,
    ).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // Rate-limited messages are NOT queued — the live session adapts.
    expect(
      db.prepare("SELECT COUNT(*) as cnt FROM agent_schedule").get(),
    ).toEqual({ cnt: 0 });
  });

  it("quiet-hours deferral wins over rate limiting (no rate check on the deferred path)", () => {
    const insert = db.prepare(
      `INSERT INTO notification_log
         (dispatch_id, notification_type, priority, platform, content_summary, status, created_at, delivered_at)
       VALUES (?, 'agent', 'normal', 'slack', 'x', 'delivered', ?, ?)`,
    );
    for (let i = 0; i < 3; i++) {
      const at = formatSqliteDatetime(
        new Date(QUIET_NOW.getTime() - (i + 1) * 60_000),
      );
      insert.run(`d${i}`, at, at);
    }
    expect(
      gateOutboundNotification(db, CONFIG, params(), QUIET_NOW).action,
    ).toBe("defer");
  });

  it("treats an empty timezone as system timezone and equal start/end as quiet-hours disabled", () => {
    expect(
      gateOutboundNotification(
        db,
        {
          ...CONFIG,
          timezone: "",
          quietHoursStart: "00:00",
          quietHoursEnd: "00:00",
        },
        params(),
        LOUD_NOW,
      ),
    ).toEqual({ action: "send" });
  });

  it("threads origin markers through to the deferred row", () => {
    gateOutboundNotification(
      db,
      CONFIG,
      params({
        platforms: ["telegram"],
        originSessionId: 5,
        agentId: "inbox-watcher",
        notificationType: "agent",
        priority: "high",
      }),
      QUIET_NOW,
    );
    const ctx = JSON.parse(
      (db.prepare("SELECT task_context FROM agent_schedule").get() as {
        task_context: string;
      }).task_context,
    );
    expect(ctx).toEqual({
      platforms: ["telegram"],
      importance: "transient",
      deferred_from: "api.notify",
      origin_session_id: 5,
      agent_id: "inbox-watcher",
    });
  });
});
