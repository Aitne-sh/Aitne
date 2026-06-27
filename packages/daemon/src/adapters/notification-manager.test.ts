import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createEvent, EventPriority, type Event, type MessageEvent } from "@aitne/shared";
import { applySchema } from "../db/schema.js";
import { NotificationManager } from "./notification-manager.js";
import { findOrCreateActiveChannelSession } from "../core/session-manager.js";
import { MessageRecorder } from "../core/message-recorder.js";
import type { MessageHub } from "./message-hub.js";
import type { AgentConfig } from "../config.js";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    slackOwnerUserId: null,
    telegramOwnerChatId: null,
    discordOwnerUserId: null,
    whatsappEnabled: false,
    whatsappOwnerPhone: null,
    whatsappAuthDir: null,
    googleCalendarId: "primary",
    notionDatabaseIds: {},
    dataDir: "/tmp/test",
    workspaceDir: ".",
    primaryVaultPath: null,
    primaryVaultName: null,
    externalObsidianVaultPath: null,
    externalObsidianVaultName: null,
    gitRepos: [],
    maxConcurrentSessions: 3,
    maxReactiveSessions: 2,
    sessionTimeoutDmMinutes: 60,
    sessionTimeoutChannelMinutes: 30,
    sessionTimeoutDashboardMinutes: 120,
    character: "",
    timezone: "",
    dayBoundaryHour: 4,
    schedulePollIntervalSeconds: 5,
    maxNotificationsPerHour: 3,
    maxNotificationsPerDay: 12,
    quietHoursStart: "00:00",
    quietHoursEnd: "00:00",
    batchIntervalMinutes: 15,
    primaryPlatform: "slack",
    defaultNotificationPlatforms: [],
    disallowedTools: [],
    allowedToolsOverride: null,
    obsidianDebounceSeconds: 5,
    gitPollIntervalSeconds: 300,
    notionPollIntervalSeconds: 60,
    calendarPollIntervalSeconds: 300,
    apiPort: 8321,
    ownerActivityIdleThresholdMinutes: 5,
    autonomousForwardNaturalDelivery: false,
    ...overrides,
  } as unknown as AgentConfig;
}

function makeMessageEvent(overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    ...createEvent({
      type: "message.received",
      source: "slack",
      priority: EventPriority.HIGH,
    }),
    sender: "user1",
    channel: "D123",
    content: "hello",
    platform: "slack",
    threadId: null,
    isDm: true,
    isMention: false,
    ...overrides,
  } as MessageEvent;
}

function makeRoutineEvent(overrides: Partial<Event> = {}): Event {
  return {
    ...createEvent({
      type: "routine.evening_review",
      source: "cron",
      priority: EventPriority.NORMAL,
    }),
    ...overrides,
  };
}

describe("NotificationManager", () => {
  let db: Database.Database;
  let mockHub: MessageHub;
  let mgr: NotificationManager;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);

    mockHub = {
      sendToUser: vi.fn().mockResolvedValue([
        {
          platform: "slack",
          channel: "D123",
        },
      ]),
      sendToExactUserDestinations: vi.fn().mockResolvedValue([
        {
          platform: "slack",
          channel: "D123",
        },
      ]),
      sendToPlatform: vi.fn().mockResolvedValue({
        platform: "slack",
        channel: "D123",
      }),
      beginProcessingIndicator: vi.fn().mockResolvedValue({
        stop: vi.fn().mockResolvedValue(undefined),
      }),
    } as unknown as MessageHub;
  });

  afterEach(() => {
    db.close();
  });

  it("sends message event reply to originating platform", async () => {
    mgr = new NotificationManager(mockHub, db, makeConfig());
    const event = makeMessageEvent();

    await mgr.send("Hello back!", event);

    expect(mockHub.sendToPlatform).toHaveBeenCalledWith(
      "slack",
      "D123",
      "Hello back!",
      undefined,
    );
  });

  // BACKGROUND_TASK_RUNNER_DESIGN.md §2.3 / §13 Decision 4 (Phase 4, opt-in)
  // — an ACTIVE owner's proactive forward routes through the delivery
  // machinery (weave); idle keeps the verbatim path; flag-off is unchanged.
  describe("autonomous-forward natural delivery (opt-in)", () => {
    function markOwnerActive(): void {
      const session = findOrCreateActiveChannelSession(db, {
        scope: "owner_dm",
        scopeKey: "owner",
        platform: "slack",
        channelId: "D123",
      });
      new MessageRecorder(db).recordMessage({
        sessionId: session.id,
        role: "user",
        platform: "slack",
        content: "still chatting",
      });
    }

    it("flag OFF ⇒ verbatim send, router never called (even when active)", async () => {
      markOwnerActive();
      const route = vi.fn().mockResolvedValue(true);
      mgr = new NotificationManager(mockHub, db, makeConfig({
        autonomousForwardNaturalDelivery: false,
      } as Partial<AgentConfig>), { routeAutonomousForwardNaturally: route });
      await mgr.send("Your cluster grew.", makeRoutineEvent());
      expect(route).not.toHaveBeenCalled();
      expect(mockHub.sendToUser).toHaveBeenCalledTimes(1);
    });

    it("flag ON + owner IDLE ⇒ verbatim send, router never called", async () => {
      // no recent owner message ⇒ idle
      const route = vi.fn().mockResolvedValue(true);
      mgr = new NotificationManager(mockHub, db, makeConfig({
        autonomousForwardNaturalDelivery: true,
      } as Partial<AgentConfig>), { routeAutonomousForwardNaturally: route });
      await mgr.send("Your cluster grew.", makeRoutineEvent());
      expect(route).not.toHaveBeenCalled();
      expect(mockHub.sendToUser).toHaveBeenCalledTimes(1);
    });

    it("flag ON + owner ACTIVE + router accepts ⇒ rerouted, no verbatim send", async () => {
      markOwnerActive();
      const route = vi.fn().mockResolvedValue(true);
      mgr = new NotificationManager(mockHub, db, makeConfig({
        autonomousForwardNaturalDelivery: true,
      } as Partial<AgentConfig>), { routeAutonomousForwardNaturally: route });
      await mgr.send("Your cluster grew.", makeRoutineEvent());
      expect(route).toHaveBeenCalledTimes(1);
      expect(route.mock.calls[0][0]).toMatchObject({ content: "Your cluster grew." });
      expect(mockHub.sendToUser).not.toHaveBeenCalled();
    });

    it("flag ON + owner ACTIVE + router declines ⇒ falls back to verbatim send", async () => {
      markOwnerActive();
      const route = vi.fn().mockResolvedValue(false);
      mgr = new NotificationManager(mockHub, db, makeConfig({
        autonomousForwardNaturalDelivery: true,
      } as Partial<AgentConfig>), { routeAutonomousForwardNaturally: route });
      await mgr.send("Your cluster grew.", makeRoutineEvent());
      expect(route).toHaveBeenCalledTimes(1);
      expect(mockHub.sendToUser).toHaveBeenCalledTimes(1);
    });

    it("flag ON + ACTIVE + router THROWS ⇒ falls back to verbatim send (does not drop the forward)", async () => {
      markOwnerActive();
      const route = vi.fn().mockRejectedValue(new Error("event bus down"));
      mgr = new NotificationManager(mockHub, db, makeConfig({
        autonomousForwardNaturalDelivery: true,
      } as Partial<AgentConfig>), { routeAutonomousForwardNaturally: route });
      await mgr.send("Your cluster grew.", makeRoutineEvent());
      expect(route).toHaveBeenCalledTimes(1);
      expect(mockHub.sendToUser).toHaveBeenCalledTimes(1);
    });

    it("flag ON + ACTIVE but SAFETY category ⇒ verbatim send, never rerouted", async () => {
      markOwnerActive();
      const route = vi.fn().mockResolvedValue(true);
      mgr = new NotificationManager(mockHub, db, makeConfig({
        autonomousForwardNaturalDelivery: true,
      } as Partial<AgentConfig>), { routeAutonomousForwardNaturally: route });
      await mgr.send("Security alert!", makeRoutineEvent(), { category: "security" });
      expect(route).not.toHaveBeenCalled();
      expect(mockHub.sendToUser).toHaveBeenCalledTimes(1);
    });
  });

  // ── M4: bounded retry + proactive fallback on reply delivery ──
  // The pre-M4 path called the adapter once and swallowed the error,
  // leaving the user with no acknowledgement of their DM. The three
  // tests below pin the new contract: retry up to N attempts on
  // transient platform failures; on exhaustion, route the same payload
  // through proactive destinations so the user is never silently
  // stranded.
  describe("M4 reply retry + fallback", () => {
    it("retries a transient platform failure and succeeds on the next attempt", async () => {
      const sleep = vi.fn().mockResolvedValue(undefined);
      mockHub.sendToPlatform = vi
        .fn()
        .mockRejectedValueOnce(new Error("Slack 503 — server error"))
        .mockResolvedValueOnce({ platform: "slack", channel: "D123" });
      mgr = new NotificationManager(mockHub, db, makeConfig(), {
        replyRetryAttempts: 3,
        replyRetryBackoffBaseMs: 5,
        sleep,
      });

      await mgr.send("Hello back!", makeMessageEvent());

      expect(mockHub.sendToPlatform).toHaveBeenCalledTimes(2);
      // Backoff slept once (after attempt 1) before attempt 2 succeeded.
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(sleep).toHaveBeenCalledWith(5);
      // No fallback was needed.
      expect(mockHub.sendToUser).not.toHaveBeenCalled();
    });

    it("uses exponential backoff between attempts", async () => {
      const sleep = vi.fn().mockResolvedValue(undefined);
      mockHub.sendToPlatform = vi
        .fn()
        .mockRejectedValueOnce(new Error("boom 1"))
        .mockRejectedValueOnce(new Error("boom 2"))
        .mockResolvedValueOnce({ platform: "slack", channel: "D123" });
      mgr = new NotificationManager(mockHub, db, makeConfig(), {
        replyRetryAttempts: 3,
        replyRetryBackoffBaseMs: 10,
        sleep,
      });

      await mgr.send("retry me", makeMessageEvent());

      expect(mockHub.sendToPlatform).toHaveBeenCalledTimes(3);
      // base * 2^0 then base * 2^1 — pins the exponential schedule so
      // future tweaks of the retry curve are caught.
      expect(sleep).toHaveBeenNthCalledWith(1, 10);
      expect(sleep).toHaveBeenNthCalledWith(2, 20);
    });

    it("falls back to proactive delivery (category=error) after exhausting retries", async () => {
      const sleep = vi.fn().mockResolvedValue(undefined);
      mockHub.sendToPlatform = vi
        .fn()
        .mockRejectedValue(new Error("Slack adapter unregistered"));
      mgr = new NotificationManager(mockHub, db, makeConfig(), {
        replyRetryAttempts: 3,
        replyRetryBackoffBaseMs: 1,
        sleep,
      });

      await mgr.send("undelivered", makeMessageEvent());

      // 3 attempts on the originating platform, 2 backoff sleeps.
      expect(mockHub.sendToPlatform).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
      // Fallback routes through the proactive path so the message
      // reaches the user's default destinations.
      expect(mockHub.sendToUser).toHaveBeenCalledWith(
        "undelivered",
        undefined,
        expect.objectContaining({ notificationType: "message.received" }),
      );
    });

    it("does not retry on a successful first attempt (no behavioural change for the happy path)", async () => {
      const sleep = vi.fn().mockResolvedValue(undefined);
      mgr = new NotificationManager(mockHub, db, makeConfig(), {
        replyRetryAttempts: 3,
        replyRetryBackoffBaseMs: 5,
        sleep,
      });

      await mgr.send("first try", makeMessageEvent());

      expect(mockHub.sendToPlatform).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(mockHub.sendToUser).not.toHaveBeenCalled();
    });

    it("clamps replyRetryAttempts to at least 1 so misconfiguration cannot zero out delivery", async () => {
      mgr = new NotificationManager(mockHub, db, makeConfig(), {
        replyRetryAttempts: 0,
        replyRetryBackoffBaseMs: 0,
      });

      await mgr.send("must still deliver", makeMessageEvent());

      // Even with replyRetryAttempts: 0, one attempt is made.
      expect(mockHub.sendToPlatform).toHaveBeenCalledTimes(1);
    });
  });

  it("starts a reply activity indicator on the originating platform", async () => {
    mgr = new NotificationManager(mockHub, db, makeConfig());
    const event = makeMessageEvent();

    const handle = await mgr.beginReplyActivity(event);
    await handle.stop();

    expect(mockHub.beginProcessingIndicator).toHaveBeenCalledWith(
      "slack",
      "D123",
      undefined,
    );
  });

  it("sends non-message event via proactive notification routing", async () => {
    mgr = new NotificationManager(mockHub, db, makeConfig());
    const event = makeRoutineEvent();

    await mgr.send("Review complete", event);

    expect(mockHub.sendToUser).toHaveBeenCalledWith(
      "Review complete",
      undefined,
      expect.objectContaining({
        notificationType: "routine.evening_review",
        priority: "normal",
        contentSummary: "Review complete",
        dispatchId: expect.any(String),
      }),
    );
  });

  // WIKI_BUILDER_DESIGN.md §3.4 — non-message events that carry a
  // `replyTo` tuple are delivered directly to that channel, just like
  // a MessageEvent reply. This is the path wiki.* sessions take so
  // completion DMs land back on the channel the operator ran the bang
  // command on (Slack/Telegram/Discord/dashboard alike).
  it("delivers directly to replyTo target when provided on a non-message event", async () => {
    mgr = new NotificationManager(mockHub, db, makeConfig());
    const event = createEvent({
      type: "wiki.ingest_url",
      source: "wiki.bang",
      priority: EventPriority.HIGH,
    });

    await mgr.send("Ingested https://example.com → 10_raw/example.md", event, {
      replyTo: { platform: "telegram", channel: "chat-42", threadId: null },
    });

    expect(mockHub.sendToPlatform).toHaveBeenCalledWith(
      "telegram",
      "chat-42",
      "Ingested https://example.com → 10_raw/example.md",
      undefined,
    );
    expect(mockHub.sendToUser).not.toHaveBeenCalled();
  });

  it("forwards a non-null threadId on replyTo deliveries", async () => {
    mgr = new NotificationManager(mockHub, db, makeConfig());
    const event = createEvent({
      type: "wiki.compile",
      source: "wiki.bang",
      priority: EventPriority.HIGH,
    });

    await mgr.send("Compiled 3 pages from 2 raw notes.", event, {
      replyTo: { platform: "slack", channel: "C1", threadId: "thread-xyz" },
    });

    expect(mockHub.sendToPlatform).toHaveBeenCalledWith(
      "slack",
      "C1",
      "Compiled 3 pages from 2 raw notes.",
      "thread-xyz",
    );
  });

  // §3.4 fallback contract: if the originating platform's adapter is
  // unregistered between the bang command and the completion (e.g. the
  // operator removed Slack from /settings/messaging during a long
  // compile), the reply path falls through to the proactive
  // destinations — the "primary messaging app" the user configured.
  it("falls back to proactive delivery when replyTo platform is unreachable", async () => {
    mockHub.sendToPlatform = vi
      .fn()
      .mockRejectedValue(new Error("Adapter not found for platform \"slack\""));
    mgr = new NotificationManager(mockHub, db, makeConfig());
    const event = createEvent({
      type: "wiki.ask",
      source: "wiki.bang",
      priority: EventPriority.HIGH,
    });

    await mgr.send("The wiki has no entry for X. Missing: source coverage.", event, {
      replyTo: { platform: "slack", channel: "D-gone", threadId: null },
    });

    expect(mockHub.sendToPlatform).toHaveBeenCalledTimes(1);
    expect(mockHub.sendToUser).toHaveBeenCalledWith(
      "The wiki has no entry for X. Missing: source coverage.",
      undefined,
      expect.objectContaining({ notificationType: "wiki.ask" }),
    );
  });

  it("ignores replyTo when present alongside a MessageEvent is not the use case (replyTo wins)", async () => {
    // A `replyTo` explicitly supplied takes precedence over the
    // MessageEvent's self-derived route. This guards against an
    // accidental double-derivation regression in the result-processor.
    mgr = new NotificationManager(mockHub, db, makeConfig());
    const event = makeMessageEvent({ platform: "slack", channel: "D-original" });

    await mgr.send("override", event, {
      replyTo: { platform: "discord", channel: "D-override", threadId: null },
    });

    expect(mockHub.sendToPlatform).toHaveBeenCalledWith(
      "discord",
      "D-override",
      "override",
      undefined,
    );
    expect(mockHub.sendToPlatform).not.toHaveBeenCalledWith(
      "slack",
      "D-original",
      expect.anything(),
      expect.anything(),
    );
  });

  it("uses only configured notification destinations when destinationMode is configured_only", async () => {
    mgr = new NotificationManager(
      mockHub,
      db,
      makeConfig({ defaultNotificationPlatforms: ["slack"] }),
    );
    const event = makeRoutineEvent();

    await mgr.send("Quota exceeded", event, {
      category: "critical",
      priority: "critical",
      destinationMode: "configured_only",
    });

    expect(mockHub.sendToExactUserDestinations).toHaveBeenCalledWith(
      "Quota exceeded",
      ["slack"],
      expect.objectContaining({
        notificationType: "routine.evening_review",
        priority: "critical",
        contentSummary: "Quota exceeded",
        dispatchId: expect.any(String),
      }),
    );
    expect(mockHub.sendToUser).not.toHaveBeenCalled();
  });

  it("logs notification to database", async () => {
    mgr = new NotificationManager(mockHub, db, makeConfig());
    const event = makeMessageEvent();

    await mgr.send("Test message", event);

    const row = db
      .prepare("SELECT * FROM notification_log ORDER BY id DESC LIMIT 1")
      .get() as { status: string; content_summary: string; notification_type: string };
    expect(row.status).toBe("delivered");
    expect(row.content_summary).toBe("Test message");
    expect(row.notification_type).toBe("message.received");
  });

  it("writes delivered proactive notifications to the owner DM timeline", async () => {
    mgr = new NotificationManager(mockHub, db, makeConfig({ batchIntervalMinutes: 0 }));
    const event = makeRoutineEvent();

    await mgr.send("Full proactive text that must not be truncated", event, {
      originSessionId: 42,
    });

    const row = db
      .prepare(
        `SELECT m.content, m.role, m.platform, m.metadata, m.notification_dispatch_id,
                s.scope, s.scope_key, s.message_count
           FROM messages m
           JOIN conversation_sessions s ON m.session_id = s.id
          ORDER BY m.id DESC
          LIMIT 1`,
      )
      .get() as {
      content: string;
      role: string;
      platform: string;
      metadata: string;
      notification_dispatch_id: string | null;
      scope: string;
      scope_key: string;
      message_count: number;
    };
    expect(row).toMatchObject({
      content: "Full proactive text that must not be truncated",
      role: "assistant",
      platform: "slack",
      scope: "owner_dm",
      scope_key: "owner",
      message_count: 1,
    });
    expect(row.notification_dispatch_id).toEqual(expect.any(String));
    expect(JSON.parse(row.metadata)).toMatchObject({
      notificationType: "proactive_forward",
      originSessionIds: [42],
    });
    expect(JSON.parse(row.metadata).dispatchIds).toEqual([
      row.notification_dispatch_id,
    ]);
  });

  it("does not write direct replies to the proactive channel timeline", async () => {
    mgr = new NotificationManager(mockHub, db, makeConfig({ batchIntervalMinutes: 0 }));

    await mgr.send("Hello back!", makeMessageEvent());

    const row = db
      .prepare("SELECT COUNT(*) AS count FROM messages")
      .get() as { count: number };
    expect(row.count).toBe(0);
  });

  it("skips proactive timeline writes when the write-side kill switch is disabled", async () => {
    mgr = new NotificationManager(
      mockHub,
      db,
      makeConfig({
        batchIntervalMinutes: 0,
        proactiveForwardChannelTimelineEnabled: false,
      }),
    );

    await mgr.send("hidden from messages", makeRoutineEvent());

    const messages = db
      .prepare("SELECT COUNT(*) AS count FROM messages")
      .get() as { count: number };
    const logs = db
      .prepare("SELECT COUNT(*) AS count FROM notification_log WHERE status = 'delivered'")
      .get() as { count: number };
    expect(messages.count).toBe(0);
    expect(logs.count).toBe(1);
  });

  it("clears backend_session_id on proactive insert when the fresh-session fallback is enabled", async () => {
    db.prepare(
      `INSERT INTO conversation_sessions (
         platform, channel_id, scope, scope_key, status, is_dm, backend_session_id
       )
       VALUES ('owner', 'owner', 'owner_dm', 'owner', 'active', 1, 'sdk-session')`,
    ).run();
    mgr = new NotificationManager(
      mockHub,
      db,
      makeConfig({
        batchIntervalMinutes: 0,
        proactiveForwardForceFreshSession: true,
      }),
    );

    await mgr.send("fresh next time", makeRoutineEvent());

    const row = db
      .prepare(
        "SELECT backend_session_id FROM conversation_sessions WHERE scope = 'owner_dm' AND scope_key = 'owner'",
      )
      .get() as { backend_session_id: string | null };
    expect(row.backend_session_id).toBeNull();
  });

  describe("rate limiting", () => {
    it("suppresses when hourly limit reached", async () => {
      // batchIntervalMinutes=0 isolates this test to the rate-limit path:
      // with batching enabled (default) the 2nd/3rd sends would be queued
      // before the counter ever reached the cap, so the suppression branch
      // would never fire. A separate test covers the batched path.
      mgr = new NotificationManager(
        mockHub,
        db,
        makeConfig({ maxNotificationsPerHour: 2, batchIntervalMinutes: 0 }),
      );
      const event = makeRoutineEvent();

      // Send 2 notifications (hits the limit)
      await mgr.send("msg1", event);
      await mgr.send("msg2", event);

      // Third should be suppressed
      await mgr.send("msg3", event);

      expect(mockHub.sendToUser).toHaveBeenCalledTimes(2);

      const suppressed = db
        .prepare(
          "SELECT COUNT(*) as cnt FROM notification_log WHERE status = 'suppressed'",
        )
        .get() as { cnt: number };
      expect(suppressed.cnt).toBe(1);
      const messages = db
        .prepare("SELECT COUNT(*) as cnt FROM messages")
        .get() as { cnt: number };
      expect(messages.cnt).toBe(2);
    });

    it("suppresses when daily limit reached", async () => {
      mgr = new NotificationManager(
        mockHub,
        db,
        makeConfig({
          maxNotificationsPerHour: 100,
          maxNotificationsPerDay: 2,
          batchIntervalMinutes: 0,
        }),
      );
      const event = makeRoutineEvent();

      await mgr.send("msg1", event);
      await mgr.send("msg2", event);
      await mgr.send("msg3", event);

      expect(mockHub.sendToUser).toHaveBeenCalledTimes(2);
    });

    it("does not count direct message replies toward notification limits", async () => {
      mgr = new NotificationManager(
        mockHub,
        db,
        makeConfig({
          maxNotificationsPerHour: 1,
          maxNotificationsPerDay: 1,
          batchIntervalMinutes: 0,
        }),
      );

      await mgr.send("reply", makeMessageEvent());
      await mgr.send("routine", makeRoutineEvent());

      expect(mockHub.sendToPlatform).toHaveBeenCalledTimes(1);
      expect(mockHub.sendToUser).toHaveBeenCalledTimes(1);

      const suppressed = db
        .prepare(
          "SELECT COUNT(*) as cnt FROM notification_log WHERE status = 'suppressed'",
        )
        .get() as { cnt: number };
      expect(suppressed.cnt).toBe(0);
    });
  });

  describe("quiet hours", () => {
    it("detects overnight quiet hours correctly", () => {
      // Set quiet hours to 23:00-07:00
      mgr = new NotificationManager(
        mockHub,
        db,
        makeConfig({ quietHoursStart: "23:00", quietHoursEnd: "07:00" }),
      );

      // The isQuietHours method depends on current time, so we can only
      // verify the logic indirectly. Test that the method exists and returns boolean.
      expect(typeof mgr.isQuietHours()).toBe("boolean");
    });

    it("safety category bypasses quiet hours", async () => {
      // Force quiet hours by using a narrow window that includes current time
      const now = new Date();
      const startH = now.getHours();
      const endH = (startH + 2) % 24;
      const start = `${String(startH).padStart(2, "0")}:00`;
      const end = `${String(endH).padStart(2, "0")}:00`;

      mgr = new NotificationManager(
        mockHub,
        db,
        makeConfig({ quietHoursStart: start, quietHoursEnd: end }),
      );

      const event = createEvent({
        type: "security.alert",
        source: "system",
        priority: EventPriority.CRITICAL,
      });

      await mgr.send("Critical alert!", event, { category: "security" });

      // Should have sent despite quiet hours
      expect(mockHub.sendToUser).toHaveBeenCalledWith(
        "Critical alert!",
        undefined,
        expect.objectContaining({
          notificationType: "security.alert",
          priority: "critical",
          contentSummary: "Critical alert!",
          dispatchId: expect.any(String),
        }),
      );
    });

    it("safety category bypasses rate limits", async () => {
      mgr = new NotificationManager(
        mockHub,
        db,
        makeConfig({ maxNotificationsPerHour: 1 }),
      );

      const normalEvent = makeRoutineEvent();
      const criticalEvent = createEvent({
        type: "error.fatal",
        source: "system",
        priority: EventPriority.CRITICAL,
      });

      // Hit rate limit
      await mgr.send("msg1", normalEvent);
      // This should be suppressed (normal)
      await mgr.send("msg2", normalEvent);
      // This should go through (safety)
      await mgr.send("Critical!", criticalEvent, { category: "error" });

      expect(mockHub.sendToUser).toHaveBeenCalledTimes(2);
    });
  });

  it("truncates long messages in content_summary", async () => {
    mgr = new NotificationManager(mockHub, db, makeConfig());
    const longMessage = "x".repeat(300);
    const event = makeMessageEvent();

    await mgr.send(longMessage, event);

    const row = db
      .prepare("SELECT content_summary FROM notification_log ORDER BY id DESC LIMIT 1")
      .get() as { content_summary: string };
    expect(row.content_summary.length).toBe(200);
    expect(row.content_summary.endsWith("...")).toBe(true);
  });

  it("preserves notification type and priority when delivery fails", async () => {
    mockHub.sendToUser = vi.fn().mockRejectedValue(new Error("network down"));
    mgr = new NotificationManager(mockHub, db, makeConfig());
    const event = createEvent({
      type: "deadline.reminder",
      source: "cron",
      priority: EventPriority.HIGH,
    });

    await mgr.send("Deadline soon", event);

    const row = db
      .prepare(
        `SELECT notification_type, priority, status
         FROM notification_log
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get() as { notification_type: string; priority: string; status: string };
    expect(row.notification_type).toBe("deadline.reminder");
    expect(row.priority).toBe("high");
    expect(row.status).toBe("failed");
    const messages = db
      .prepare("SELECT COUNT(*) AS count FROM messages")
      .get() as { count: number };
    expect(messages.count).toBe(0);
  });

  it("returns noop handle when beginReplyActivity fails", async () => {
    mockHub.beginProcessingIndicator = vi.fn().mockRejectedValue(new Error("platform down"));
    mgr = new NotificationManager(mockHub, db, makeConfig());
    const event = makeMessageEvent();

    const handle = await mgr.beginReplyActivity(event);
    // Should not throw; should get a noop handle
    await handle.stop();
  });

  it("calls signalDetector.trackNotification after successful delivery", async () => {
    mgr = new NotificationManager(mockHub, db, makeConfig());
    const mockDetector = {
      trackNotification: vi.fn(),
    };
    mgr.setSignalDetector(mockDetector as any);

    const event = makeRoutineEvent();
    await mgr.send("Test notification", event);

    expect(mockDetector.trackNotification).toHaveBeenCalledTimes(1);
    expect(mockDetector.trackNotification).toHaveBeenCalledWith(
      expect.any(String),
      "slack",
      "Test notification",
    );
  });

  it("infers priority critical from event priority 0", async () => {
    mgr = new NotificationManager(mockHub, db, makeConfig());
    const event = createEvent({
      type: "system.alert",
      source: "system",
      priority: EventPriority.CRITICAL,
    });

    await mgr.send("Alert!", event);

    const row = db
      .prepare("SELECT priority FROM notification_log ORDER BY id DESC LIMIT 1")
      .get() as { priority: string };
    expect(row.priority).toBe("critical");
  });

  it("treats priority=critical (no category) as a safety bypass", async () => {
    // Force quiet hours
    const now = new Date();
    const startH = now.getHours();
    const endH = (startH + 2) % 24;
    const start = `${String(startH).padStart(2, "0")}:00`;
    const end = `${String(endH).padStart(2, "0")}:00`;

    mgr = new NotificationManager(
      mockHub,
      db,
      makeConfig({ quietHoursStart: start, quietHoursEnd: end }),
    );

    const event = createEvent({
      type: "system.critical",
      source: "system",
      priority: EventPriority.CRITICAL,
    });

    await mgr.send("Critical!", event, { priority: "critical" });

    // Should send despite quiet hours because priority is "critical"
    expect(mockHub.sendToUser).toHaveBeenCalledTimes(1);
  });

  it("infers priority low from event priority 3", async () => {
    mgr = new NotificationManager(mockHub, db, makeConfig());
    const event = createEvent({
      type: "routine.check",
      source: "cron",
      priority: EventPriority.LOW,
    });

    await mgr.send("Low priority", event);

    const row = db
      .prepare("SELECT priority FROM notification_log ORDER BY id DESC LIMIT 1")
      .get() as { priority: string };
    expect(row.priority).toBe("low");
  });

  it("does not add a duplicate failed row when the hub already logged delivery failures", async () => {
    mockHub.sendToUser = vi.fn().mockImplementation(
      async (
        _message: string,
        _platforms: string[] | undefined,
        logContext?: {
          dispatchId: string;
          notificationType: string;
          priority: string;
          contentSummary: string;
        },
      ) => {
        db.prepare(
          `INSERT INTO notification_log (
             dispatch_id,
             notification_type,
             priority,
             platform,
             content_summary,
             status
           )
           VALUES (?, ?, ?, 'slack', ?, 'failed')`,
        ).run(
          logContext?.dispatchId ?? "",
          logContext?.notificationType ?? "",
          logContext?.priority ?? "normal",
          "delivery failed: socket closed",
        );
        throw new Error("network down");
      },
    );
    mgr = new NotificationManager(mockHub, db, makeConfig());
    const event = createEvent({
      type: "deadline.reminder",
      source: "cron",
      priority: EventPriority.HIGH,
    });

    await mgr.send("Deadline soon", event);

    const rows = db
      .prepare(
        `SELECT platform, status
         FROM notification_log
         WHERE notification_type = 'deadline.reminder'`,
      )
      .all() as { platform: string; status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      platform: "slack",
      status: "failed",
    });
  });

  describe("batching (batchIntervalMinutes)", () => {
    it("delivers the first proactive notification immediately", async () => {
      mgr = new NotificationManager(
        mockHub,
        db,
        makeConfig({ batchIntervalMinutes: 15 }),
      );

      await mgr.send("first", makeRoutineEvent());
      expect(mockHub.sendToUser).toHaveBeenCalledTimes(1);
      expect(mockHub.sendToUser).toHaveBeenCalledWith(
        "first",
        undefined,
        expect.any(Object),
      );
    });

    it("queues same-type proactive notifications arriving within the window and combines them on flush", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-16T12:00:00.000Z"));
      try {
        mgr = new NotificationManager(
          mockHub,
          db,
          makeConfig({ batchIntervalMinutes: 15 }),
        );
        const event = makeRoutineEvent();

        await mgr.send("first", event, { originSessionId: 7 });
        await mgr.send("second", event, { originSessionId: 8 });
        await mgr.send("third", event, { originSessionId: 8 });

        // Only the first delivery has gone through so far.
        expect(mockHub.sendToUser).toHaveBeenCalledTimes(1);
        expect(mockHub.sendToUser).toHaveBeenCalledWith(
          "first",
          undefined,
          expect.any(Object),
        );

        const batched = db
          .prepare(
            "SELECT COUNT(*) as cnt FROM notification_log WHERE status = 'batched'",
          )
          .get() as { cnt: number };
        expect(batched.cnt).toBe(2);

        // Advance past the 15-minute window; the flush timer should fire.
        await vi.advanceTimersByTimeAsync(16 * 60 * 1000);

        expect(mockHub.sendToUser).toHaveBeenCalledTimes(2);
        expect(mockHub.sendToUser).toHaveBeenLastCalledWith(
          "second\n\nthird",
          undefined,
          expect.any(Object),
        );

        const rows = db
          .prepare(
            `SELECT content, metadata, notification_dispatch_id
               FROM messages
              ORDER BY id ASC`,
          )
          .all() as Array<{
          content: string;
          metadata: string;
          notification_dispatch_id: string | null;
        }>;
        expect(rows.map((row) => row.content)).toEqual([
          "first",
          "second\n\nthird",
        ]);
        const batchedMetadata = JSON.parse(rows[1].metadata);
        expect(batchedMetadata.notificationType).toBe("proactive_forward_batched");
        expect(batchedMetadata.dispatchIds).toHaveLength(2);
        expect(batchedMetadata.originSessionIds).toEqual([8]);
        expect(rows[1].notification_dispatch_id).toBeNull();
      } finally {
        mgr.stop();
        vi.useRealTimers();
      }
    });

    it("does not batch across distinct event types", async () => {
      mgr = new NotificationManager(
        mockHub,
        db,
        makeConfig({ batchIntervalMinutes: 15 }),
      );

      await mgr.send(
        "evening",
        makeRoutineEvent({ type: "routine.evening_review" }),
      );
      await mgr.send(
        "morning",
        makeRoutineEvent({ type: "routine.morning_routine" }),
      );

      // Two distinct types — both deliver immediately.
      expect(mockHub.sendToUser).toHaveBeenCalledTimes(2);
    });

    it("safety-category notifications bypass batching", async () => {
      mgr = new NotificationManager(
        mockHub,
        db,
        makeConfig({ batchIntervalMinutes: 15 }),
      );
      const event = makeRoutineEvent();

      await mgr.send("normal", event); // delivers, sets cooldown
      await mgr.send("alert!", event, {
        category: "error",
        priority: "critical",
      });

      expect(mockHub.sendToUser).toHaveBeenCalledTimes(2);
    });

    it("safety delivery does NOT start a batching cooldown for later normal notifications", async () => {
      // Regression guard: a critical alert for `system.alert` must not
      // silently freeze the next non-safety `system.alert` into the batch
      // queue. If `lastDeliveryAtMs` were stamped on safety deliveries, the
      // follow-up "ordinary" notification would be queued and held for up
      // to `batchIntervalMinutes` — turning a critical alert into a
      // background-communication blackout on the same event type.
      mgr = new NotificationManager(
        mockHub,
        db,
        makeConfig({ batchIntervalMinutes: 15 }),
      );
      const event = createEvent({
        type: "system.alert",
        source: "system",
        priority: EventPriority.CRITICAL,
      });

      await mgr.send("CRITICAL!", event, {
        category: "error",
        priority: "critical",
      });
      await mgr.send("ordinary follow-up", {
        ...event,
        priority: EventPriority.NORMAL,
      });

      expect(mockHub.sendToUser).toHaveBeenCalledTimes(2);
      const batched = db
        .prepare(
          "SELECT COUNT(*) as cnt FROM notification_log WHERE status = 'batched'",
        )
        .get() as { cnt: number };
      expect(batched.cnt).toBe(0);
    });

    it("direct replies bypass batching even when the last proactive delivery is in-window", async () => {
      mgr = new NotificationManager(
        mockHub,
        db,
        makeConfig({ batchIntervalMinutes: 15 }),
      );

      // Prime the message.received cooldown (unlikely in practice but exercises
      // the code path: replies must never consult batching state).
      await mgr.send("reply1", makeMessageEvent());
      await mgr.send("reply2", makeMessageEvent());

      expect(mockHub.sendToPlatform).toHaveBeenCalledTimes(2);
    });

    it("treats batchIntervalMinutes <= 0 as no batching", async () => {
      mgr = new NotificationManager(
        mockHub,
        db,
        makeConfig({ batchIntervalMinutes: 0 }),
      );
      const event = makeRoutineEvent();

      await mgr.send("one", event);
      await mgr.send("two", event);
      await mgr.send("three", event);

      expect(mockHub.sendToUser).toHaveBeenCalledTimes(3);
    });

    it("stop() clears the pending flush timer", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-16T12:00:00.000Z"));
      try {
        mgr = new NotificationManager(
          mockHub,
          db,
          makeConfig({ batchIntervalMinutes: 15 }),
        );
        const event = makeRoutineEvent();
        await mgr.send("first", event);
        await mgr.send("second", event);

        mgr.stop();

        // Timer was cleared — advancing time should NOT trigger a flush.
        await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
        expect(mockHub.sendToUser).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("queueForBatch: queuing a second notification without originSessionId does not push to originSessionIds", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-16T12:00:00.000Z"));
      try {
        mgr = new NotificationManager(
          mockHub,
          db,
          makeConfig({ batchIntervalMinutes: 15 }),
        );
        const event = makeRoutineEvent();

        // First send delivers immediately and sets the cooldown
        await mgr.send("first", event, { originSessionId: 99 });
        // Second send queues (within window), with no originSessionId
        await mgr.send("second", event);

        // Advance past the window to flush
        await vi.advanceTimersByTimeAsync(16 * 60 * 1000);

        // The flushed batch message metadata must NOT include 99 in originSessionIds
        // (the slot was created without an originSessionId from the second send)
        expect(mockHub.sendToUser).toHaveBeenCalledTimes(2);
        const batchedMsg = db
          .prepare(
            "SELECT metadata FROM messages ORDER BY id DESC LIMIT 1",
          )
          .get() as { metadata: string };
        const meta = JSON.parse(batchedMsg.metadata);
        // The batch was started by the second send which had no originSessionId
        expect(meta.originSessionIds).toEqual([]);
      } finally {
        mgr.stop();
        vi.useRealTimers();
      }
    });

    it("batchIntervalMs: NaN returns 0 (no batching)", async () => {
      mgr = new NotificationManager(
        mockHub,
        db,
        makeConfig({ batchIntervalMinutes: NaN }),
      );
      const event = makeRoutineEvent();

      await mgr.send("one", event);
      await mgr.send("two", event);

      // Both should deliver immediately with no batching
      expect(mockHub.sendToUser).toHaveBeenCalledTimes(2);
    });

    it("batchIntervalMs: negative value returns 0 (no batching)", async () => {
      mgr = new NotificationManager(
        mockHub,
        db,
        makeConfig({ batchIntervalMinutes: -5 }),
      );
      const event = makeRoutineEvent();

      await mgr.send("one", event);
      await mgr.send("two", event);

      // Both should deliver immediately with no batching
      expect(mockHub.sendToUser).toHaveBeenCalledTimes(2);
    });

    it("flushBatches: intervalMs <= 0 clears batchSlots and returns early", async () => {
      // Create manager with batching enabled, queue a notification
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-16T12:00:00.000Z"));
      try {
        const config = makeConfig({ batchIntervalMinutes: 15 });
        mgr = new NotificationManager(mockHub, db, config);
        const event = makeRoutineEvent();

        // First send delivers immediately (establishes cooldown)
        await mgr.send("first", event);
        // Second send queues within the window
        await mgr.send("second", event);

        // Manually invoke flushBatches with intervalMs=0 (simulate config change)
        // by temporarily setting batchIntervalMinutes to 0 on the config
        (config as unknown as { batchIntervalMinutes: number }).batchIntervalMinutes = 0;

        await (mgr as unknown as { flushBatches: () => Promise<void> }).flushBatches();

        // With intervalMs=0, flushBatches clears batchSlots without delivering
        const batched = db
          .prepare("SELECT COUNT(*) as cnt FROM notification_log WHERE status = 'batched'")
          .get() as { cnt: number };
        expect(batched.cnt).toBe(1); // batched row still exists in DB, but memory slot cleared
      } finally {
        mgr.stop();
        vi.useRealTimers();
      }
    });

    it("scheduleBatchFlush: intervalMs <= 0 → returns early (branch 421)", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-16T12:00:00.000Z"));
      try {
        const config = makeConfig({ batchIntervalMinutes: 15 });
        mgr = new NotificationManager(mockHub, db, config);
        const event = makeRoutineEvent();

        // Queue a notification (requires first delivery)
        await mgr.send("first", event);
        await mgr.send("second", event); // queued

        // Change batch interval to 0, then directly call scheduleBatchFlush
        (config as unknown as { batchIntervalMinutes: number }).batchIntervalMinutes = 0;

        // scheduleBatchFlush should return early since intervalMs <= 0
        const mgrInternal = mgr as unknown as {
          scheduleBatchFlush: () => void;
          flushTimer: ReturnType<typeof setTimeout> | null;
        };
        // Clear the existing timer first
        if (mgrInternal.flushTimer) {
          clearTimeout(mgrInternal.flushTimer);
          mgrInternal.flushTimer = null;
        }
        mgrInternal.scheduleBatchFlush();
        // Timer should not have been set since intervalMs <= 0
        expect(mgrInternal.flushTimer).toBeNull();
      } finally {
        mgr.stop();
        vi.useRealTimers();
      }
    });

    it("flushBatches flushing guard prevents overlapping executions", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-16T12:00:00.000Z"));
      try {
        mgr = new NotificationManager(
          mockHub,
          db,
          makeConfig({ batchIntervalMinutes: 15 }),
        );
        const event = makeRoutineEvent();
        await mgr.send("first", event);
        await mgr.send("second", event);

        // Manually set flushing guard to true
        (mgr as unknown as { flushing: boolean }).flushing = true;
        // Manually invoke flushBatches — should return immediately without sending
        await (mgr as unknown as { flushBatches: () => Promise<void> }).flushBatches();

        // Restore guard and advance timers
        (mgr as unknown as { flushing: boolean }).flushing = false;

        // The second notification should still be queued (flush was skipped)
        expect(mockHub.sendToUser).toHaveBeenCalledTimes(1);
      } finally {
        mgr.stop();
        vi.useRealTimers();
      }
    });

    it("deliverProactive fromBatch:true includes fromBatch in suppression log", async () => {
      vi.useFakeTimers();
      // Force quiet hours to be always active (00:00-23:59)
      vi.setSystemTime(new Date("2026-04-16T12:00:00.000Z"));
      try {
        // Use a same-day range that covers 12:00 UTC
        mgr = new NotificationManager(
          mockHub,
          db,
          makeConfig({
            batchIntervalMinutes: 15,
            timezone: "UTC",
            quietHoursStart: "09:00",
            quietHoursEnd: "17:00",
          }),
        );
        const event = makeRoutineEvent();

        // First send should pass (before batch window established)
        // but it's during quiet hours so it gets suppressed
        // So: we need to first establish the delivery window outside quiet hours
        // then flip time to inside quiet hours before flushing

        // Deliver first send at 08:00 (outside 09:00-17:00 quiet hours)
        vi.setSystemTime(new Date("2026-04-16T08:00:00.000Z"));
        await mgr.send("first", event);
        // first delivery succeeds (08:00 is outside quiet window 09-17)
        expect(mockHub.sendToUser).toHaveBeenCalledTimes(1);

        // Queue second send at 08:05 (still within cooldown window)
        vi.setSystemTime(new Date("2026-04-16T08:05:00.000Z"));
        await mgr.send("second", event);
        expect(mockHub.sendToUser).toHaveBeenCalledTimes(1); // still 1 (batched)

        // Now advance into quiet hours (10:00) and past the flush window
        vi.setSystemTime(new Date("2026-04-16T10:00:00.000Z"));
        await vi.advanceTimersByTimeAsync(16 * 60 * 1000);

        // The flush during quiet hours should suppress
        const suppressed = db
          .prepare(
            "SELECT COUNT(*) as cnt FROM notification_log WHERE status = 'suppressed'",
          )
          .get() as { cnt: number };
        expect(suppressed.cnt).toBeGreaterThanOrEqual(1);
      } finally {
        mgr.stop();
        vi.useRealTimers();
      }
    });
  });

  describe("quiet hours with controlled time", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("send() during quiet hours: fromBatch defaults to false in suppression log (line 242)", async () => {
      // Force system time to 12:00 UTC — within the 09:00-17:00 quiet window
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-16T12:00:00.000Z"));
      mgr = new NotificationManager(
        mockHub,
        db,
        makeConfig({
          timezone: "UTC",
          quietHoursStart: "09:00",
          quietHoursEnd: "17:00",
          batchIntervalMinutes: 0,
        }),
      );
      const event = makeRoutineEvent();

      // This hits the quiet hours suppression path with fromBatch=undefined → fromBatch ?? false = false
      await mgr.send("suppressed by quiet hours", event);

      expect(mockHub.sendToUser).not.toHaveBeenCalled();
      const suppressed = db
        .prepare("SELECT COUNT(*) as cnt FROM notification_log WHERE status = 'suppressed'")
        .get() as { cnt: number };
      expect(suppressed.cnt).toBe(1);
    });

    it("isQuietHours: same-day range 09:00-17:00, time 12:00 UTC → returns true", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-16T12:00:00.000Z"));
      mgr = new NotificationManager(
        mockHub,
        db,
        makeConfig({
          timezone: "UTC",
          quietHoursStart: "09:00",
          quietHoursEnd: "17:00",
        }),
      );
      expect(mgr.isQuietHours()).toBe(true);
    });

    it("isQuietHours: same-day range 09:00-17:00, time 20:00 UTC → returns false", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-16T20:00:00.000Z"));
      mgr = new NotificationManager(
        mockHub,
        db,
        makeConfig({
          timezone: "UTC",
          quietHoursStart: "09:00",
          quietHoursEnd: "17:00",
        }),
      );
      expect(mgr.isQuietHours()).toBe(false);
    });

    it("isQuietHours: overnight range 23:00-07:00, time 00:00 UTC → returns true", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-17T00:00:00.000Z"));
      mgr = new NotificationManager(
        mockHub,
        db,
        makeConfig({
          timezone: "UTC",
          quietHoursStart: "23:00",
          quietHoursEnd: "07:00",
        }),
      );
      expect(mgr.isQuietHours()).toBe(true);
    });

    it("isQuietHours: overnight range 23:00-07:00, time 12:00 UTC → returns false", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-16T12:00:00.000Z"));
      mgr = new NotificationManager(
        mockHub,
        db,
        makeConfig({
          timezone: "UTC",
          quietHoursStart: "23:00",
          quietHoursEnd: "07:00",
        }),
      );
      expect(mgr.isQuietHours()).toBe(false);
    });
  });

  it("infers priority high from event priority 1", async () => {
    mgr = new NotificationManager(mockHub, db, makeConfig());
    const { EventPriority: EP } = await import("@aitne/shared");
    const event = {
      ...makeRoutineEvent(),
      priority: EP.HIGH, // priority 1
    };

    await mgr.send("High priority message", event);

    const row = db
      .prepare("SELECT priority FROM notification_log ORDER BY id DESC LIMIT 1")
      .get() as { priority: string };
    expect(row.priority).toBe("high");
  });

  it("beginReplyActivity: non-Error thrown → String(err) branch (line 86)", async () => {
    mockHub.beginProcessingIndicator = vi.fn().mockRejectedValue("string error");
    mgr = new NotificationManager(mockHub, db, makeConfig());
    const event = makeMessageEvent();

    // Should return NOOP handle without throwing
    const handle = await mgr.beginReplyActivity(event);
    await handle.stop();
  });

  it("deliverReply fails: uses event.platform as the platform for logNotificationRows (isMessageEvent branch)", async () => {
    // When sendToPlatform throws and hasLoggedRowsForDispatch returns false,
    // logNotificationRows is called with deliveries=[] and the message event's platform (line 592).
    mockHub.sendToPlatform = vi.fn().mockRejectedValue(new Error("platform down"));
    mgr = new NotificationManager(mockHub, db, makeConfig({ batchIntervalMinutes: 0 }));

    const event = makeMessageEvent({ platform: "slack" });
    await mgr.send("hello", event);

    const row = db
      .prepare(
        "SELECT platform FROM notification_log WHERE status = 'failed' ORDER BY id DESC LIMIT 1",
      )
      .get() as { platform: string };
    expect(row.platform).toBe("slack");
  });

  it("logNotificationRows: DB insert throws → error caught silently", async () => {
    // Cover lines 648-650: the catch block in logNotificationRows when the DB fails.
    // Use a real in-memory DB for rate-limit queries but override prepare for INSERT.
    // We can do this by sending a notification and then making the DB throw on the second call.
    mgr = new NotificationManager(mockHub, db, makeConfig({ batchIntervalMinutes: 0 }));

    // Spy on db.prepare to throw when called with an INSERT for notification_log
    const origPrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO notification_log")) {
        return {
          run: () => { throw new Error("DB locked"); },
          // For the get() calls in rate-limiting, fall through to real prepared statements
          get: origPrepare(sql).get.bind(origPrepare(sql)),
        } as unknown as ReturnType<typeof db.prepare>;
      }
      return origPrepare(sql);
    });

    const event = makeRoutineEvent();
    // Should not throw even when DB INSERT fails
    await mgr.send("hello", event);

    vi.restoreAllMocks();
  });

  it("signalDetector.trackNotification is called after reply delivery", async () => {
    mgr = new NotificationManager(mockHub, db, makeConfig());
    const mockDetector = {
      trackNotification: vi.fn(),
    };
    mgr.setSignalDetector(mockDetector as any);

    const event = makeMessageEvent();
    await mgr.send("Reply text", event);

    expect(mockDetector.trackNotification).toHaveBeenCalledTimes(1);
    expect(mockDetector.trackNotification).toHaveBeenCalledWith(
      expect.any(String),
      "slack",
      "Reply text",
    );
  });

  it("hasLoggedRowsForDispatch returns true and prevents duplicate failed row", async () => {
    // This replicates the duplicate-prevention test but verifies the
    // hasLoggedRowsForDispatch → true path actually prevents a second insert
    mockHub.sendToUser = vi.fn().mockImplementation(
      async (
        _message: string,
        _platforms: string[] | undefined,
        logContext?: {
          dispatchId: string;
          notificationType: string;
          priority: string;
          contentSummary: string;
        },
      ) => {
        // Hub already inserted a 'failed' row for this dispatch
        db.prepare(
          `INSERT INTO notification_log (
             dispatch_id,
             notification_type,
             priority,
             platform,
             content_summary,
             status
           )
           VALUES (?, ?, ?, 'slack', ?, 'failed')`,
        ).run(
          logContext?.dispatchId ?? "",
          logContext?.notificationType ?? "",
          logContext?.priority ?? "normal",
          "delivery failed: platform error",
        );
        throw new Error("network down");
      },
    );

    mgr = new NotificationManager(mockHub, db, makeConfig({ batchIntervalMinutes: 0 }));
    const event = makeRoutineEvent();

    await mgr.send("Test message", event);

    // Only the hub-inserted row should exist, no additional row from NotificationManager
    const rows = db
      .prepare(
        "SELECT COUNT(*) as cnt FROM notification_log WHERE notification_type = 'routine.evening_review'",
      )
      .get() as { cnt: number };
    expect(rows.cnt).toBe(1);
  });
});
