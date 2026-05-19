import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import { recordObservation, updateObservationSummary } from "./observations.js";
import { computeHourlyCheckSignals } from "./hourly-check-signals.js";

describe("computeHourlyCheckSignals", () => {
  let db: Database.Database;
  // Local-time anchor: the Agent Plan parser interprets HH:MM as
  // local-clock minutes-of-day, so the test fixes a local 12:00:00.
  const now = new Date(2026, 4, 6, 12, 0, 0);

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns zeros on an empty DB", () => {
    const signals = computeHourlyCheckSignals(db, { now });
    expect(signals.pendingObsCount).toBe(0);
    expect(signals.maxNoveltyScore).toBeNull();
    expect(signals.noveltyDistribution).toEqual({ low: 0, mid: 0, high: 0 });
    expect(signals.vipMailUnreadCount).toBe(0);
    expect(signals.calendarHas24hChange).toBe(false);
    expect(signals.calendarHasConflict).toBe(false);
    expect(signals.agentPlanOverdueCount).toBe(0);
    expect(signals.scheduleApproachingCount).toBe(0);
    expect(signals.hoursSinceLastStage3Run).toBe(Number.POSITIVE_INFINITY);
  });

  it("counts pending observations across actor=user (poller) and actor=agent (pre-pass) rows", () => {
    // HOURLY_CHECK_GATE_REDESIGN_PLAN.md Phase 1+2 — the gate's signal
    // compute is mode-blind. Both user-actor (direct-mode pollers) and
    // agent-actor (delegated-sync-worker, routine.fetch_window pre-pass)
    // rows must contribute to `pendingObsCount`.
    recordObservation(db, {
      source: "obsidian:primary",
      ref: "a.md",
      changeType: "modified",
      actor: "user",
    });
    recordObservation(db, {
      source: "gmail:default",
      ref: "msg-1",
      changeType: "created",
      actor: "agent",
      payload: { kind: "mail", raw: { from: "x@example.com" } },
    });
    const signals = computeHourlyCheckSignals(db, { now });
    expect(signals.pendingObsCount).toBe(2);
  });

  it("aggregates novelty distribution from done summaries only", () => {
    recordObservation(db, {
      source: "obsidian:primary",
      ref: "low.md",
      changeType: "modified",
      actor: "user",
    });
    recordObservation(db, {
      source: "obsidian:primary",
      ref: "mid.md",
      changeType: "modified",
      actor: "user",
    });
    recordObservation(db, {
      source: "obsidian:primary",
      ref: "high.md",
      changeType: "modified",
      actor: "user",
    });
    recordObservation(db, {
      source: "obsidian:primary",
      ref: "pending.md",
      changeType: "modified",
      actor: "user",
    });
    const ids = (db
      .prepare("SELECT id, ref FROM observations ORDER BY id")
      .all() as Array<{ id: number; ref: string }>);
    updateObservationSummary(db, {
      id: ids.find((r) => r.ref === "low.md")!.id,
      summaryText: "low",
      noveltyScore: 1,
      summaryStatus: "done",
    });
    updateObservationSummary(db, {
      id: ids.find((r) => r.ref === "mid.md")!.id,
      summaryText: "mid",
      noveltyScore: 2,
      summaryStatus: "done",
    });
    updateObservationSummary(db, {
      id: ids.find((r) => r.ref === "high.md")!.id,
      summaryText: "high",
      noveltyScore: 3,
      summaryStatus: "done",
    });

    const signals = computeHourlyCheckSignals(db, { now });
    expect(signals.maxNoveltyScore).toBe(3);
    expect(signals.noveltyDistribution).toEqual({ low: 1, mid: 1, high: 1 });
  });

  it("counts VIP unread mail using case-insensitive exact match", () => {
    db.prepare(
      `INSERT INTO mail_accounts (id, kind, email, auth_type, secret_blob_name, created_at_utc)
       VALUES ('acct-1', 'gmail', 'me@example.com', 'oauth', 'blob', '2026-01-01T00:00:00Z')`,
    ).run();
    const insertMail = db.prepare(
      `INSERT INTO mail_messages_index
         (account_id, provider_msg_id, folder, received_at_utc, from_email, is_read, observed_at_utc)
       VALUES (?, ?, 'INBOX', ?, ?, ?, ?)`,
    );
    insertMail.run("acct-1", "m1", "2026-05-06T11:00:00Z", "VIP@Example.COM", 0, "2026-05-06T11:00:00Z");
    insertMail.run("acct-1", "m2", "2026-05-06T11:01:00Z", "vip@example.com", 0, "2026-05-06T11:01:00Z");
    insertMail.run("acct-1", "m3", "2026-05-06T11:02:00Z", "noise@example.com", 0, "2026-05-06T11:02:00Z");
    insertMail.run("acct-1", "m4", "2026-05-06T11:03:00Z", "vip@example.com", 1, "2026-05-06T11:03:00Z");

    const signals = computeHourlyCheckSignals(db, {
      now,
      vipMailSenders: ["vip@example.com"],
    });
    expect(signals.vipMailUnreadCount).toBe(2);
  });

  it("flips calendarHas24hChange when a calendar observation is pending", () => {
    const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);
    const inTwoHours = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    recordObservation(db, {
      source: "calendar:primary",
      ref: "evt-1",
      changeType: "modified",
      actor: "user",
      payload: { start: inOneHour.toISOString(), end: inTwoHours.toISOString() },
    });
    const signals = computeHourlyCheckSignals(db, { now });
    expect(signals.calendarHas24hChange).toBe(true);
  });

  it("detects overlapping calendar events as a conflict", () => {
    const t1Start = new Date(now.getTime() + 60 * 60 * 1000);
    const t1End = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const t2Start = new Date(now.getTime() + 90 * 60 * 1000);
    const t2End = new Date(now.getTime() + 150 * 60 * 1000);
    recordObservation(db, {
      source: "calendar:primary",
      ref: "evt-1",
      changeType: "modified",
      actor: "user",
      payload: { start: t1Start.toISOString(), end: t1End.toISOString() },
    });
    recordObservation(db, {
      source: "calendar:primary",
      ref: "evt-2",
      changeType: "modified",
      actor: "user",
      payload: { start: t2Start.toISOString(), end: t2End.toISOString() },
    });
    const signals = computeHourlyCheckSignals(db, { now });
    expect(signals.calendarHasConflict).toBe(true);
  });

  it("ignores non-overlapping calendar events", () => {
    const t1Start = new Date(now.getTime() + 60 * 60 * 1000);
    const t1End = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const t2Start = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    const t2End = new Date(now.getTime() + 4 * 60 * 60 * 1000);
    recordObservation(db, {
      source: "calendar:primary",
      ref: "evt-1",
      changeType: "modified",
      actor: "user",
      payload: {
        start: { dateTime: t1Start.toISOString() },
        end: { dateTime: t1End.toISOString() },
      },
    });
    recordObservation(db, {
      source: "calendar:primary",
      ref: "evt-2",
      changeType: "modified",
      actor: "user",
      payload: {
        start: { dateTime: t2Start.toISOString() },
        end: { dateTime: t2End.toISOString() },
      },
    });
    const signals = computeHourlyCheckSignals(db, { now });
    expect(signals.calendarHasConflict).toBe(false);
  });

  it("counts overdue Agent Plan rows from today.md", () => {
    const todayMd = [
      "# 2026-05-06 (Wednesday)",
      "> Day type: Weekday | Work focus: on | Study focus: off | Personal focus: on",
      "",
      "## User Schedule",
      "- 09:00 stand-up",
      "",
      "## Agent Plan",
      "- 09:30 ship the patch",
      "- 11:45 follow-up email",
      "- 13:30 review PR",
      "- 18:00 close laptop",
      "",
      "## Agent Log",
      "- 12:00 routine ran",
      "",
    ].join("\n");
    const signals = computeHourlyCheckSignals(db, { now, todayMd });
    expect(signals.agentPlanOverdueCount).toBe(2);
  });

  it("respects agentTimezone when comparing Agent Plan HH:MM to now", () => {
    // The instant 2026-05-06T03:00:00Z is 12:00 in Asia/Tokyo. Two of
    // the Agent Plan rows below land before noon Tokyo time and should
    // be counted as overdue. If the helper used the JS engine's local
    // TZ instead, the count would shift by the daemon-host offset and
    // this assertion would only hold on a machine running in UTC.
    const utcNow = new Date(Date.UTC(2026, 4, 6, 3, 0, 0));
    const todayMd = [
      "# 2026-05-06",
      "",
      "## Agent Plan",
      "- 09:30 ship the patch",     // 09:30 < 12:00 → overdue in Tokyo
      "- 11:45 follow-up email",    // 11:45 < 12:00 → overdue in Tokyo
      "- 13:30 review PR",          // 13:30 > 12:00
      "",
      "## Agent Log",
      "",
    ].join("\n");
    const signals = computeHourlyCheckSignals(db, {
      now: utcNow,
      todayMd,
      agentTimezone: "Asia/Tokyo",
    });
    expect(signals.agentPlanOverdueCount).toBe(2);
  });

  it("counts agent_schedule rows due in the next 6 hours by default", () => {
    const toUtc = (offsetHours: number): string => {
      const d = new Date(now.getTime() + offsetHours * 60 * 60 * 1000);
      return d.toISOString().replace("T", " ").slice(0, 19);
    };
    db.prepare(
      `INSERT INTO agent_schedule (scheduled_for, task_type, status)
       VALUES (?, 'wake', 'pending')`,
    ).run(toUtc(1));
    db.prepare(
      `INSERT INTO agent_schedule (scheduled_for, task_type, status)
       VALUES (?, 'wake', 'pending')`,
    ).run(toUtc(5));
    db.prepare(
      `INSERT INTO agent_schedule (scheduled_for, task_type, status)
       VALUES (?, 'wake', 'pending')`,
    ).run(toUtc(11));
    db.prepare(
      `INSERT INTO agent_schedule (scheduled_for, task_type, status)
       VALUES (?, 'wake', 'completed')`,
    ).run(toUtc(2));

    const signals = computeHourlyCheckSignals(db, { now });
    expect(signals.scheduleApproachingCount).toBe(2);
  });

  it("computes hoursSinceLastStage3Run from gate-emitted rows", () => {
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);
    const startedAt = sixHoursAgo.toISOString().replace("T", " ").slice(0, 19);
    db.prepare(
      `INSERT INTO agent_actions (action_type, result, detail, started_at, completed_at)
       VALUES ('hourly_check.gate', 'success', json(?), ?, ?)`,
    ).run(
      JSON.stringify({ stage_reached: "stage3" }),
      startedAt,
      startedAt,
    );
    const signals = computeHourlyCheckSignals(db, { now });
    expect(signals.hoursSinceLastStage3Run).toBeCloseTo(6, 1);
  });

  it("falls back to legacy routine.hourly_check rows when no gate row exists", () => {
    const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const startedAt = threeHoursAgo.toISOString().replace("T", " ").slice(0, 19);
    db.prepare(
      `INSERT INTO agent_actions (action_type, result, started_at, completed_at)
       VALUES ('routine.hourly_check', 'success', ?, ?)`,
    ).run(startedAt, startedAt);
    const signals = computeHourlyCheckSignals(db, { now });
    expect(signals.hoursSinceLastStage3Run).toBeCloseTo(3, 1);
  });

  it("counts pre-pass-posted gmail rows toward pendingObsCount + calendarHas24hChange", () => {
    // HOURLY_CHECK_GATE_REDESIGN_PLAN.md Phase 1.C — the source-prefix
    // sets are derived from INTEGRATION_DESCRIPTORS, so a delegated /
    // native pre-pass row tagged with the integration's own prefix
    // (`gmail:%`, `google_calendar:%`, etc.) must contribute to the
    // gate signals exactly like a direct-mode `mail:%` or `calendar:%`
    // row.
    recordObservation(db, {
      source: "gmail:default",
      ref: "msg-1",
      changeType: "created",
      actor: "agent",
      payload: { kind: "mail", raw: { from: "Alice <alice@example.com>" } },
    });
    recordObservation(db, {
      source: "google_calendar:primary",
      ref: "evt-1",
      changeType: "created",
      actor: "agent",
      payload: {
        start: { dateTime: new Date(now.getTime() + 60 * 60 * 1000).toISOString() },
        end: { dateTime: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString() },
      },
    });
    const signals = computeHourlyCheckSignals(db, { now });
    expect(signals.pendingObsCount).toBe(2);
    expect(signals.calendarHas24hChange).toBe(true);
  });

  it("falls back to substring match on payload.raw.from when normalized from_email is absent", () => {
    // HOURLY_CHECK_GATE_REDESIGN_PLAN.md Phase 3 — when the partial
    // POSTed before the normalizer landed (or a future partial that
    // omits the normalized keys), the gate must still recognize a VIP
    // by substring-matching `payload.raw.from`. We keep `is_read=0`
    // (the partial's unread-window contract) but DROP from_email and
    // assert the substring fallback still catches the row.
    recordObservation(db, {
      source: "gmail:default",
      ref: "msg-substr",
      changeType: "created",
      actor: "agent",
      payload: {
        kind: "mail",
        is_read: 0,
        raw: { from: "VIP Person <vip@example.com>" },
      },
    });
    // Also seed a row with raw.from that is NOT a VIP — should not match.
    recordObservation(db, {
      source: "gmail:default",
      ref: "msg-no-vip",
      changeType: "created",
      actor: "agent",
      payload: {
        kind: "mail",
        is_read: 0,
        raw: { from: "Stranger <stranger@example.com>" },
      },
    });
    // And a row with null `raw.from` so the `if (!row.rawFrom) continue` branch fires.
    recordObservation(db, {
      source: "gmail:default",
      ref: "msg-no-from",
      changeType: "created",
      actor: "agent",
      payload: { kind: "mail", is_read: 0, raw: {} },
    });
    const signals = computeHourlyCheckSignals(db, {
      now,
      vipMailSenders: ["vip@example.com"],
    });
    expect(signals.vipMailUnreadCount).toBe(1);
  });

  it("falls back to mail_messages_index when the observations table has no per-message rows", () => {
    // No observation rows are seeded — only the legacy direct-mode
    // mail_messages_index table carries VIP detail. Verify the
    // fallback returns the table count.
    db.prepare(
      `INSERT INTO mail_accounts (id, kind, email, auth_type, secret_blob_name, created_at_utc)
       VALUES ('acct-1', 'gmail', 'me@example.com', 'oauth', 'blob', '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO mail_messages_index
         (account_id, provider_msg_id, folder, received_at_utc, from_email, is_read, observed_at_utc)
       VALUES ('acct-1', 'tbl-1', 'INBOX', '2026-05-06T11:00:00Z', 'vip@example.com', 0, '2026-05-06T11:00:00Z')`,
    ).run();
    const signals = computeHourlyCheckSignals(db, {
      now,
      vipMailSenders: ["vip@example.com"],
    });
    expect(signals.vipMailUnreadCount).toBe(1);
  });

  it("counts VIP unread mail from pre-pass gmail observations via normalized payload", () => {
    // HOURLY_CHECK_GATE_REDESIGN_PLAN.md Phase 3 — the /api/observations
    // POST chokepoint normalizes the pre-pass mail payload to surface
    // `is_read=0` and `from_email=<lowercased>`. Here we simulate that
    // normalization directly (recordObservation bypasses the route)
    // and verify the VIP query reads it via `payload.from_email`.
    recordObservation(db, {
      source: "gmail:default",
      ref: "msg-vip",
      changeType: "created",
      actor: "agent",
      payload: {
        kind: "mail",
        is_read: 0,
        from_email: "vip@example.com",
        raw: { from: "VIP <vip@example.com>", subject: "Hi" },
      },
    });
    recordObservation(db, {
      source: "gmail:default",
      ref: "msg-noise",
      changeType: "created",
      actor: "agent",
      payload: {
        kind: "mail",
        is_read: 0,
        from_email: "noise@example.com",
        raw: { from: "Noise <noise@example.com>" },
      },
    });
    const signals = computeHourlyCheckSignals(db, {
      now,
      vipMailSenders: ["vip@example.com"],
    });
    expect(signals.vipMailUnreadCount).toBe(1);
  });
});
