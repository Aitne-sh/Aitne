import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import {
  DEFAULT_AGENT_DISPLAY_NAME,
  formatAgentOutboundLabel,
} from "@aitne/shared";

const DEFAULT_OUTBOUND_LABEL = formatAgentOutboundLabel(DEFAULT_AGENT_DISPLAY_NAME);
import { applySchema } from "../db/schema.js";
import { MessageDeliveryError, MessageHub } from "./message-hub.js";
import type { MessageAdapter } from "./types.js";
import type { AgentConfig } from "../config.js";

interface TestAdapterOptions {
  primaryRecipient?: string | null;
  sendMessage?: MessageAdapter["sendMessage"];
  beginProcessingIndicator?: MessageAdapter["beginProcessingIndicator"];
  resolveUserChannel?: MessageAdapter["resolveUserChannel"];
  notificationEligible?: boolean;
  start?: MessageAdapter["start"];
}

function makeAdapter(
  platformName: string,
  options: TestAdapterOptions = {},
): MessageAdapter {
  return {
    platformName,
    primaryRecipient: options.primaryRecipient ?? null,
    notificationEligible: options.notificationEligible,
    start: options.start ?? (async () => {}),
    stop: async () => {},
    sendMessage: options.sendMessage ?? vi.fn().mockResolvedValue(undefined),
    beginProcessingIndicator: options.beginProcessingIndicator,
    resolveUserChannel: options.resolveUserChannel,
  };
}

/**
 * Register a test adapter and immediately mark it as "ok". After P2-04
 * `MessageHub.register()` seeds the runtime status as "connecting" so the
 * dashboard's /health card doesn't claim a live connection in the boot
 * window between register() and startAll() — but the bulk of these tests
 * exercise the post-startup routing matrix directly, so they short-circuit
 * the lifecycle via this helper rather than awaiting startAll().
 */
function registerForTest(hub: MessageHub, adapter: MessageAdapter): MessageAdapter {
  hub.register(adapter);
  hub.setPlatformRuntimeStatus(adapter.platformName, {
    runtimeState: "ok",
    error: null,
  });
  return adapter;
}

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
    agentDisplayName: DEFAULT_AGENT_DISPLAY_NAME,
    sessionTimeoutDmMinutes: 60,
    sessionTimeoutChannelMinutes: 30,
    sessionTimeoutDashboardMinutes: 120,
    character: "",
    timezone: "",
    dayBoundaryHour: 4,
    schedulePollIntervalSeconds: 5,
    maxNotificationsPerHour: 3,
    maxNotificationsPerDay: 12,
    quietHoursStart: "23:00",
    quietHoursEnd: "07:00",
    batchIntervalMinutes: 15,
    primaryPlatform: "slack",
    defaultNotificationPlatforms: [],
    disallowedTools: [],
    allowedToolsOverride: null,
    apiPort: 8321,
    ...overrides,
  } as unknown as AgentConfig;
}

describe("MessageHub", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("resolves sendToUser via adapter primaryRecipient", async () => {
    const adapter = makeAdapter("whatsapp", {
      primaryRecipient: "818012345678@s.whatsapp.net",
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });
    const hub = new MessageHub(
      makeConfig({
        primaryPlatform: "whatsapp",
        defaultNotificationPlatforms: ["whatsapp"],
        whatsappEnabled: true,
        whatsappOwnerPhone: "+818012345678",
      }),
      db,
    );
    registerForTest(hub, adapter);

    const delivery = await hub.sendToUser("hello");

    expect(adapter.sendMessage).toHaveBeenCalledWith({
      channel: "818012345678@s.whatsapp.net",
      text: `${DEFAULT_OUTBOUND_LABEL}\nhello`,
    });
    expect(delivery).toEqual([
      {
        platform: "whatsapp",
        channel: "818012345678@s.whatsapp.net",
        messageId: undefined,
      },
    ]);
  });

  it("prefixes WhatsApp proactive messages with the configured agent name", async () => {
    const adapter = makeAdapter("whatsapp", {
      primaryRecipient: "818012345678@s.whatsapp.net",
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });
    const hub = new MessageHub(
      makeConfig({
        agentDisplayName: "ai bot",
        primaryPlatform: "whatsapp",
        defaultNotificationPlatforms: ["whatsapp"],
        whatsappEnabled: true,
        whatsappOwnerPhone: "+818012345678",
      }),
      db,
    );
    registerForTest(hub, adapter);

    await hub.sendToUser("hello");

    expect(adapter.sendMessage).toHaveBeenCalledWith({
      channel: "818012345678@s.whatsapp.net",
      text: "[ai bot]\nhello",
    });
  });

  it("resolves sendToUser via the stored owner channel from the database", async () => {
    const adapter = makeAdapter("slack", {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });
    const hub = new MessageHub(
      makeConfig({
        primaryPlatform: "slack",
        defaultNotificationPlatforms: ["slack"],
        slackOwnerUserId: "U123",
      }),
      db,
    );
    db.prepare(
      `INSERT INTO owner_channels (platform, channel_id)
       VALUES ('slack', 'D123')`,
    ).run();
    hub.setPlatformConfigured("slack", true);
    registerForTest(hub, adapter);

    const delivery = await hub.sendToUser("hello");

    expect(adapter.sendMessage).toHaveBeenCalledWith({
      channel: "D123",
      text: "hello",
    });
    expect(delivery).toEqual([
      {
        platform: "slack",
        channel: "D123",
        messageId: undefined,
      },
    ]);
  });

  it("resolves sendToPlatform when channel is user", async () => {
    const adapter = makeAdapter("whatsapp", {
      primaryRecipient: "818012345678@s.whatsapp.net",
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });
    const hub = new MessageHub(makeConfig({ primaryPlatform: "whatsapp" }), db);
    registerForTest(hub, adapter);

    const delivery = await hub.sendToPlatform("whatsapp", "user", "hello");

    expect(adapter.sendMessage).toHaveBeenCalledWith({
      channel: "818012345678@s.whatsapp.net",
      text: `${DEFAULT_OUTBOUND_LABEL}\nhello`,
      threadId: undefined,
    });
    expect(delivery).toEqual({
      platform: "whatsapp",
      channel: "818012345678@s.whatsapp.net",
      messageId: undefined,
    });
  });

  it("prefixes WhatsApp replies sent back to the originating platform", async () => {
    const adapter = makeAdapter("whatsapp", {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });
    const hub = new MessageHub(
      makeConfig({
        agentDisplayName: "ai bot",
        whatsappEnabled: true,
        whatsappOwnerPhone: "+818012345678",
      }),
      db,
    );
    registerForTest(hub, adapter);

    await hub.sendToPlatform(
      "whatsapp",
      "818012345678@s.whatsapp.net",
      "reply",
    );

    expect(adapter.sendMessage).toHaveBeenCalledWith({
      channel: "818012345678@s.whatsapp.net",
      text: "[ai bot]\nreply",
      threadId: undefined,
    });
  });

  it("passes through explicit channels unchanged", async () => {
    const adapter = makeAdapter("slack", {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });
    const hub = new MessageHub(makeConfig({ primaryPlatform: "slack" }), db);
    registerForTest(hub, adapter);

    await hub.sendToPlatform("slack", "C123", "hello", "thread-1");

    expect(adapter.sendMessage).toHaveBeenCalledWith({
      channel: "C123",
      text: "hello",
      threadId: "thread-1",
    });
  });

  it("starts a platform processing indicator when the adapter supports it", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const adapter = makeAdapter("whatsapp", {
      primaryRecipient: "818012345678@s.whatsapp.net",
      beginProcessingIndicator: vi.fn().mockResolvedValue({ stop }),
    });
    const hub = new MessageHub(
      makeConfig({
        primaryPlatform: "whatsapp",
        whatsappEnabled: true,
        whatsappOwnerPhone: "+818012345678",
      }),
      db,
    );
    registerForTest(hub, adapter);

    const handle = await hub.beginProcessingIndicator("whatsapp", "user");
    await handle.stop();

    expect(adapter.beginProcessingIndicator).toHaveBeenCalledWith({
      channel: "818012345678@s.whatsapp.net",
      threadId: undefined,
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("register() with a duplicate platformName silently replaces the prior adapter (footgun)", () => {
    // Documented invariant: `MessageHub.adapters` is keyed purely by
    // `platformName`. A second `register()` for the same name overwrites
    // the first and only emits a warn-log — `getAdapter()` returns the
    // newer adapter, the older one's `start`/`stop` is never invoked,
    // and `sendToPlatform(name, …)` routes to the newer one.
    //
    // This test exists as a tripwire: `DocsQAAdapter` declares
    // `platformName="dashboard"` (it has to, so inbound `MessageEvent`s
    // dispatch via `event.platform="dashboard"`). If a future change
    // re-introduces `messageHub.register(docsQAAdapter)` in `index.ts`,
    // the chat adapter would silently lose its hub slot. The fix in
    // `index.ts` is to NOT register `DocsQAAdapter` with the hub at all
    // (its lifecycle is owned by `GET /api/docs/qa/stream` directly);
    // see the comment block above the `DocsQAAdapter` construction.
    const first = makeAdapter("dashboard");
    const second = makeAdapter("dashboard");
    const hub = new MessageHub(makeConfig({ primaryPlatform: "dashboard" }), db);
    registerForTest(hub, first);
    registerForTest(hub, second);
    expect(hub.getAdapter("dashboard")).toBe(second);
    expect(hub.getAdapter("dashboard")).not.toBe(first);
  });

  it("falls back to configured destination platforms when primary adapter is missing", async () => {
    const fallback = makeAdapter("telegram", {
      primaryRecipient: "123456789",
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });
    const hub = new MessageHub(
      makeConfig({
        primaryPlatform: "slack",
        defaultNotificationPlatforms: ["telegram"],
        telegramOwnerChatId: "123456789",
      }),
      db,
    );
    registerForTest(hub, makeAdapter("dashboard"));
    hub.setPlatformConfigured("telegram", true);
    registerForTest(hub, fallback);

    await hub.sendToUser("hello");

    expect(fallback.sendMessage).toHaveBeenCalledWith({
      channel: "123456789",
      text: "hello",
    });
  });

  it("filters effective fallback platforms to registered notification destinations", () => {
    const hub = new MessageHub(
      makeConfig({
        primaryPlatform: "dashboard",
        // Defense-in-depth: even if "dashboard" leaks past type-level
        // checks into defaultNotificationPlatforms, the runtime filter
        // must drop it because it's not in NOTIFICATION_DESTINATION_PLATFORMS.
        defaultNotificationPlatforms: [
          "dashboard",
          "slack",
          "telegram",
        ] as unknown as AgentConfig["defaultNotificationPlatforms"],
        slackOwnerUserId: "U123",
      }),
      db,
    );
    hub.setPlatformConfigured("slack", true);
    hub.setPlatformConfigured("telegram", true);
    registerForTest(hub, makeAdapter("slack"));
    registerForTest(hub, makeAdapter("dashboard"));
    registerForTest(hub, makeAdapter("telegram", { notificationEligible: false }));

    expect(hub.getEffectiveFallbackPlatforms()).toEqual(["slack"]);
  });

  it("falls back when primary adapter throws", async () => {
    const primary = makeAdapter("slack", {
      primaryRecipient: "D111",
      sendMessage: vi.fn().mockRejectedValue(new Error("socket closed")),
    });
    const fallback = makeAdapter("telegram", {
      primaryRecipient: "222",
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });
    const hub = new MessageHub(
      makeConfig({
        primaryPlatform: "slack",
        defaultNotificationPlatforms: ["slack", "telegram"],
        slackOwnerUserId: "U111",
        telegramOwnerChatId: "222",
      }),
      db,
    );
    hub.setPlatformConfigured("slack", true);
    hub.setPlatformConfigured("telegram", true);
    registerForTest(hub, primary);
    registerForTest(hub, fallback);

    await hub.sendToUser("hello");

    expect(primary.sendMessage).toHaveBeenCalledTimes(1);
    expect(fallback.sendMessage).toHaveBeenCalledWith({
      channel: "222",
      text: "hello",
    });
  });

  it("does not fall back outside explicitly requested notification destinations", async () => {
    const requested = makeAdapter("slack", {
      primaryRecipient: "D111",
      sendMessage: vi.fn().mockRejectedValue(new Error("socket closed")),
    });
    const fallback = makeAdapter("telegram", {
      primaryRecipient: "222",
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });
    const hub = new MessageHub(
      makeConfig({
        primaryPlatform: "slack",
        defaultNotificationPlatforms: ["slack", "telegram"],
        slackOwnerUserId: "U111",
        telegramOwnerChatId: "222",
      }),
      db,
    );
    hub.setPlatformConfigured("slack", true);
    hub.setPlatformConfigured("telegram", true);
    registerForTest(hub, requested);
    registerForTest(hub, fallback);

    await expect(
      hub.sendToExactUserDestinations("hello", ["slack"]),
    ).rejects.toBeInstanceOf(MessageDeliveryError);

    expect(requested.sendMessage).toHaveBeenCalledTimes(1);
    expect(fallback.sendMessage).not.toHaveBeenCalled();
  });

  it("logs a failed notification row when no delivery target succeeds", async () => {
    const primary = makeAdapter("slack", {
      primaryRecipient: "D111",
      sendMessage: vi.fn().mockRejectedValue(new Error("socket closed")),
    });
    const fallback = makeAdapter("telegram", {
      primaryRecipient: "222",
      sendMessage: vi.fn().mockRejectedValue(new Error("logged out")),
    });
    const hub = new MessageHub(
      makeConfig({
        primaryPlatform: "slack",
        defaultNotificationPlatforms: ["slack", "telegram"],
        slackOwnerUserId: "U111",
        telegramOwnerChatId: "222",
      }),
      db,
    );
    hub.setPlatformConfigured("slack", true);
    hub.setPlatformConfigured("telegram", true);
    registerForTest(hub, primary);
    registerForTest(hub, fallback);

    await expect(
      hub.sendToUser("hello", undefined, {
        dispatchId: "dispatch-1",
        notificationType: "routine.evening_review",
        priority: "normal",
        contentSummary: "hello",
      }),
    ).rejects.toBeInstanceOf(MessageDeliveryError);

    const rows = db
      .prepare(
        "SELECT platform, status, content_summary FROM notification_log ORDER BY id ASC",
      )
      .all() as { platform: string; status: string; content_summary: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.platform)).toEqual(["slack", "telegram"]);
    expect(rows.every((row) => row.status === "failed")).toBe(true);
    expect(rows[0]?.content_summary).toContain("delivery failed: socket closed");
    expect(rows[1]?.content_summary).toContain("delivery failed: logged out");
  });

  it("falls back to the first eligible platform when the primary platform is not notification-eligible", async () => {
    const primary = makeAdapter("slack", {
      primaryRecipient: "D111",
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });
    const fallback = makeAdapter("telegram", {
      primaryRecipient: "222",
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });
    const hub = new MessageHub(
      makeConfig({
        primaryPlatform: "slack",
        slackOwnerUserId: null,
        telegramOwnerChatId: "222",
      }),
      db,
    );
    hub.setPlatformConfigured("slack", true);
    hub.setPlatformConfigured("telegram", true);
    registerForTest(hub, primary);
    registerForTest(hub, fallback);

    await hub.sendToUser("hello");

    expect(primary.sendMessage).not.toHaveBeenCalled();
    expect(fallback.sendMessage).toHaveBeenCalledWith({
      channel: "222",
      text: "hello",
    });
  });

  it("skips platforms whose runtime health is already in error", async () => {
    const primary = makeAdapter("slack", {
      primaryRecipient: "D111",
      start: vi.fn().mockRejectedValue(new Error("socket closed")),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });
    const fallback = makeAdapter("telegram", {
      primaryRecipient: "222",
      start: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });
    const hub = new MessageHub(
      makeConfig({
        primaryPlatform: "slack",
        defaultNotificationPlatforms: ["slack", "telegram"],
        slackOwnerUserId: "U111",
        telegramOwnerChatId: "222",
      }),
      db,
    );
    hub.setPlatformConfigured("slack", true);
    hub.setPlatformConfigured("telegram", true);
    registerForTest(hub, primary);
    registerForTest(hub, fallback);

    await hub.startAll();
    await hub.sendToUser("hello");

    expect(primary.sendMessage).not.toHaveBeenCalled();
    expect(fallback.sendMessage).toHaveBeenCalledWith({
      channel: "222",
      text: "hello",
    });
  });

  it("unregister removes adapter and returns it", () => {
    const adapter = makeAdapter("slack");
    const hub = new MessageHub(makeConfig(), db);
    registerForTest(hub, adapter);

    const removed = hub.unregister("slack");
    expect(removed).toBe(adapter);
    expect(hub.getAdapter("slack")).toBeUndefined();
    expect(hub.getPlatforms()).not.toContain("slack");
  });

  it("unregister returns undefined for non-existent platform", () => {
    const hub = new MessageHub(makeConfig(), db);
    expect(hub.unregister("nonexistent")).toBeUndefined();
  });

  it("getAdapter returns the registered adapter", () => {
    const adapter = makeAdapter("slack");
    const hub = new MessageHub(makeConfig(), db);
    registerForTest(hub, adapter);
    expect(hub.getAdapter("slack")).toBe(adapter);
  });

  it("getPlatforms returns all registered platforms", () => {
    const hub = new MessageHub(makeConfig(), db);
    registerForTest(hub, makeAdapter("slack"));
    registerForTest(hub, makeAdapter("telegram"));
    expect(hub.getPlatforms()).toEqual(["slack", "telegram"]);
  });

  it("getPrimaryPlatform / setPrimaryPlatform", () => {
    const config = makeConfig({ primaryPlatform: "slack" });
    const hub = new MessageHub(config, db);
    expect(hub.getPrimaryPlatform()).toBe("slack");
    hub.setPrimaryPlatform("telegram");
    expect(hub.getPrimaryPlatform()).toBe("telegram");
  });

  it("getAdapterStatuses returns status map", () => {
    const hub = new MessageHub(makeConfig(), db);
    registerForTest(hub, makeAdapter("slack"));
    const statuses = hub.getAdapterStatuses();
    expect(statuses.slack).toEqual({ runtimeState: "ok", error: null });
  });

  it("isOwnerConfigured returns true for dashboard always", () => {
    const hub = new MessageHub(makeConfig(), db);
    expect(hub.isOwnerConfigured("dashboard")).toBe(true);
  });

  it("isOwnerConfigured returns true when owner is set", () => {
    const hub = new MessageHub(
      makeConfig({
        slackOwnerUserId: "U123",
        telegramOwnerChatId: "CHAT1",
        discordOwnerUserId: "D123",
        whatsappOwnerPhone: "+818012345678",
      }),
      db,
    );
    expect(hub.isOwnerConfigured("slack")).toBe(true);
    expect(hub.isOwnerConfigured("telegram")).toBe(true);
    expect(hub.isOwnerConfigured("discord")).toBe(true);
    expect(hub.isOwnerConfigured("whatsapp")).toBe(true);
  });

  it("isOwnerConfigured returns false for unknown platform", () => {
    const hub = new MessageHub(makeConfig(), db);
    expect(hub.isOwnerConfigured("unknown")).toBe(false);
  });

  it("isPlatformConfigured checks whatsappEnabled for whatsapp", () => {
    const hub = new MessageHub(makeConfig({ whatsappEnabled: true }), db);
    expect(hub.isPlatformConfigured("whatsapp")).toBe(true);
    const hub2 = new MessageHub(makeConfig({ whatsappEnabled: false }), db);
    expect(hub2.isPlatformConfigured("whatsapp")).toBe(false);
  });

  it("getPlatformRuntimeStatus returns not_configured when platform is not configured", () => {
    const hub = new MessageHub(makeConfig(), db);
    expect(hub.getPlatformRuntimeStatus("telegram")).toEqual({
      runtimeState: "not_configured",
      error: null,
    });
  });

  it("getPlatformRuntimeStatus returns error when adapter is not registered", () => {
    const hub = new MessageHub(makeConfig(), db);
    hub.setPlatformConfigured("telegram", true);
    expect(hub.getPlatformRuntimeStatus("telegram")).toEqual({
      runtimeState: "error",
      error: "Adapter not registered",
    });
  });

  it("getPlatformRuntimeStatus delegates to adapter.getNotificationRuntimeStatus", () => {
    const adapter = makeAdapter("whatsapp", {
      primaryRecipient: "818012345678@s.whatsapp.net",
    });
    (adapter as any).getNotificationRuntimeStatus = () => ({
      runtimeState: "error" as const,
      error: "WhatsApp connecting",
    });
    const hub = new MessageHub(
      makeConfig({ whatsappEnabled: true, whatsappOwnerPhone: "+818012345678" }),
      db,
    );
    registerForTest(hub, adapter);
    expect(hub.getPlatformRuntimeStatus("whatsapp")).toEqual({
      runtimeState: "error",
      error: "WhatsApp connecting",
    });
  });

  it("sendToPlatform throws when adapter is not found", async () => {
    const hub = new MessageHub(makeConfig(), db);
    await expect(
      hub.sendToPlatform("missing", "CH1", "hello"),
    ).rejects.toThrow('Adapter not found for platform "missing"');
  });

  it("sendToPlatform throws when channel is user but no recipient available", async () => {
    const adapter = makeAdapter("slack");
    const hub = new MessageHub(makeConfig(), db);
    registerForTest(hub, adapter);

    await expect(
      hub.sendToPlatform("slack", "user", "hello"),
    ).rejects.toThrow('No default recipient available for platform "slack"');
  });

  it("beginProcessingIndicator returns noop for adapters without support", async () => {
    const adapter = makeAdapter("slack");
    delete (adapter as any).beginProcessingIndicator;
    const hub = new MessageHub(makeConfig(), db);
    registerForTest(hub, adapter);

    const handle = await hub.beginProcessingIndicator("slack", "CH1");
    // Should get a noop handle
    await handle.stop();
  });

  it("beginProcessingIndicator returns noop when resolveUserChannel returns null", async () => {
    const adapter = makeAdapter("slack", {
      beginProcessingIndicator: vi.fn().mockResolvedValue({ stop: vi.fn() }),
    });
    const hub = new MessageHub(makeConfig(), db);
    registerForTest(hub, adapter);

    const handle = await hub.beginProcessingIndicator("slack", "user");
    await handle.stop();
    expect(adapter.beginProcessingIndicator).not.toHaveBeenCalled();
  });

  it("beginProcessingIndicator returns noop when adapter throws", async () => {
    const adapter = makeAdapter("whatsapp", {
      primaryRecipient: "818012345678@s.whatsapp.net",
      beginProcessingIndicator: vi.fn().mockRejectedValue(new Error("socket error")),
    });
    const hub = new MessageHub(makeConfig(), db);
    registerForTest(hub, adapter);

    const handle = await hub.beginProcessingIndicator("whatsapp", "818012345678@s.whatsapp.net");
    await handle.stop();
  });

  it("resolves sendToUser via adapter.resolveUserChannel", async () => {
    const adapter = makeAdapter("slack", {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      resolveUserChannel: vi.fn().mockResolvedValue("D_RESOLVED"),
    });
    const hub = new MessageHub(
      makeConfig({
        primaryPlatform: "slack",
        defaultNotificationPlatforms: ["slack"],
        slackOwnerUserId: "U123",
      }),
      db,
    );
    hub.setPlatformConfigured("slack", true);
    registerForTest(hub, adapter);

    await hub.sendToUser("hello");
    expect(adapter.sendMessage).toHaveBeenCalledWith({
      channel: "D_RESOLVED",
      text: "hello",
    });
  });

  it("decorateOutboundText does not double-prefix WhatsApp messages", async () => {
    const adapter = makeAdapter("whatsapp", {
      primaryRecipient: "818012345678@s.whatsapp.net",
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });
    const hub = new MessageHub(
      makeConfig({
        primaryPlatform: "whatsapp",
        defaultNotificationPlatforms: ["whatsapp"],
        whatsappEnabled: true,
        whatsappOwnerPhone: "+818012345678",
      }),
      db,
    );
    registerForTest(hub, adapter);

    // Already prefixed — should not double-prefix
    await hub.sendToPlatform(
      "whatsapp",
      "818012345678@s.whatsapp.net",
      `${DEFAULT_OUTBOUND_LABEL}\nalready prefixed`,
    );
    expect(adapter.sendMessage).toHaveBeenCalledWith({
      channel: "818012345678@s.whatsapp.net",
      text: `${DEFAULT_OUTBOUND_LABEL}\nalready prefixed`,
      threadId: undefined,
    });
  });

  it("decorateOutboundText handles empty text", async () => {
    const adapter = makeAdapter("whatsapp", {
      primaryRecipient: "818012345678@s.whatsapp.net",
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });
    const hub = new MessageHub(
      makeConfig({
        primaryPlatform: "whatsapp",
        defaultNotificationPlatforms: ["whatsapp"],
        whatsappEnabled: true,
        whatsappOwnerPhone: "+818012345678",
      }),
      db,
    );
    registerForTest(hub, adapter);

    await hub.sendToPlatform("whatsapp", "818012345678@s.whatsapp.net", "");
    expect(adapter.sendMessage).toHaveBeenCalledWith({
      channel: "818012345678@s.whatsapp.net",
      text: DEFAULT_OUTBOUND_LABEL,
      threadId: undefined,
    });
  });

  it("startAll handles mixed success and failure", async () => {
    const ok = makeAdapter("slack", { start: vi.fn().mockResolvedValue(undefined) });
    const fail = makeAdapter("telegram", {
      start: vi.fn().mockRejectedValue(new Error("connect timeout")),
    });
    const hub = new MessageHub(makeConfig(), db);
    registerForTest(hub, ok);
    registerForTest(hub, fail);

    await hub.startAll();

    const statuses = hub.getAdapterStatuses();
    expect(statuses.slack).toEqual({ runtimeState: "ok", error: null });
    expect(statuses.telegram?.runtimeState).toBe("error");
    expect(statuses.telegram?.error).toContain("connect timeout");
  });

  it("stopAll handles errors gracefully", async () => {
    const adapter = makeAdapter("slack", {
      start: vi.fn().mockResolvedValue(undefined),
    });
    (adapter as any).stop = vi.fn().mockRejectedValue(new Error("cleanup fail"));
    const hub = new MessageHub(makeConfig(), db);
    registerForTest(hub, adapter);

    // Should not throw
    await hub.stopAll();
  });

  it("sendToUserDestinations throws when no eligible platforms exist", async () => {
    const hub = new MessageHub(makeConfig(), db);
    await expect(hub.sendToUserDestinations("hello")).rejects.toThrow(
      "No eligible notification destination",
    );
  });

  it("sendToExactUserDestinations throws when requested platforms are not eligible", async () => {
    const hub = new MessageHub(makeConfig(), db);
    await expect(
      hub.sendToExactUserDestinations("hello", ["slack"]),
    ).rejects.toThrow("No eligible configured notification destination");
  });

  it("does not fabricate last_inbound_at for outbound-only owner channel updates", async () => {
    const adapter = makeAdapter("whatsapp", {
      primaryRecipient: "818012345678@s.whatsapp.net",
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });
    const hub = new MessageHub(
      makeConfig({
        primaryPlatform: "whatsapp",
        defaultNotificationPlatforms: ["whatsapp"],
        whatsappEnabled: true,
        whatsappOwnerPhone: "+818012345678",
      }),
      db,
    );
    registerForTest(hub, adapter);

    await hub.sendToUser("hello");

    const row = db
      .prepare(
        `SELECT last_inbound_at, last_outbound_at
         FROM owner_channels
         WHERE platform = 'whatsapp'`,
      )
      .get() as { last_inbound_at: string | null; last_outbound_at: string | null };
    expect(row.last_inbound_at).toBeNull();
    expect(row.last_outbound_at).not.toBeNull();
  });

  // ── Additional branch coverage ──

  it("decorateOutboundText: text === prefix exactly returns text unchanged", async () => {
    const adapter = makeAdapter("whatsapp", {
      primaryRecipient: "818012345678@s.whatsapp.net",
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });
    const hub = new MessageHub(
      makeConfig({
        primaryPlatform: "whatsapp",
        whatsappEnabled: true,
        whatsappOwnerPhone: "+818012345678",
      }),
      db,
    );
    registerForTest(hub, adapter);

    // Text is EXACTLY the prefix (no trailing newline) — must not double-prefix
    await hub.sendToPlatform("whatsapp", "818012345678@s.whatsapp.net", DEFAULT_OUTBOUND_LABEL);
    expect(adapter.sendMessage).toHaveBeenCalledWith({
      channel: "818012345678@s.whatsapp.net",
      text: DEFAULT_OUTBOUND_LABEL,
      threadId: undefined,
    });
  });

  it("decorateOutboundText: text starts with `prefix ` (space separator) returns text unchanged", async () => {
    const adapter = makeAdapter("whatsapp", {
      primaryRecipient: "818012345678@s.whatsapp.net",
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });
    const hub = new MessageHub(
      makeConfig({
        primaryPlatform: "whatsapp",
        whatsappEnabled: true,
        whatsappOwnerPhone: "+818012345678",
      }),
      db,
    );
    registerForTest(hub, adapter);

    const alreadyPrefixed = `${DEFAULT_OUTBOUND_LABEL} already prefixed with space`;
    await hub.sendToPlatform("whatsapp", "818012345678@s.whatsapp.net", alreadyPrefixed);
    expect(adapter.sendMessage).toHaveBeenCalledWith({
      channel: "818012345678@s.whatsapp.net",
      text: alreadyPrefixed,
      threadId: undefined,
    });
  });

  it("isPlatformNotificationEligible returns false for platform not in NOTIFICATION_DESTINATION_PLATFORMS", () => {
    const hub = new MessageHub(makeConfig(), db);
    registerForTest(hub, makeAdapter("dashboard"));
    hub.setPlatformConfigured("dashboard", true);
    // dashboard is not in NOTIFICATION_DESTINATION_PLATFORMS, so should return false
    expect(hub.isPlatformNotificationEligible("dashboard")).toBe(false);
  });

  it("isPlatformNotificationEligible returns false when adapter is not registered", () => {
    const hub = new MessageHub(
      makeConfig({ slackOwnerUserId: "U123" }),
      db,
    );
    // slack is configured but adapter is not registered
    hub.setPlatformConfigured("slack", true);
    expect(hub.isPlatformNotificationEligible("slack")).toBe(false);
  });

  it("logFailedDelivery is a no-op when hub is created without a db argument", async () => {
    const primary = makeAdapter("slack", {
      primaryRecipient: "D111",
      sendMessage: vi.fn().mockRejectedValue(new Error("socket closed")),
    });
    // Hub created with no db
    const hub = new MessageHub(
      makeConfig({
        primaryPlatform: "slack",
        defaultNotificationPlatforms: ["slack"],
        slackOwnerUserId: "U111",
      }),
    );
    hub.setPlatformConfigured("slack", true);
    registerForTest(hub, primary);

    // Should not throw — logFailedDelivery should exit early when db is absent
    await expect(
      hub.sendToUser("hello", undefined, {
        dispatchId: "dispatch-no-db",
        notificationType: "routine.evening_review",
        priority: "normal",
        contentSummary: "hello",
      }),
    ).rejects.toBeInstanceOf(MessageDeliveryError);
  });

  it("logFailedDelivery is a no-op when logContext is undefined", async () => {
    const primary = makeAdapter("slack", {
      primaryRecipient: "D111",
      sendMessage: vi.fn().mockRejectedValue(new Error("socket closed")),
    });
    const hub = new MessageHub(
      makeConfig({
        primaryPlatform: "slack",
        defaultNotificationPlatforms: ["slack"],
        slackOwnerUserId: "U111",
      }),
      db,
    );
    hub.setPlatformConfigured("slack", true);
    registerForTest(hub, primary);

    // No logContext → logFailedDelivery should be a no-op
    await expect(hub.sendToUser("hello")).rejects.toBeInstanceOf(MessageDeliveryError);

    const rows = db
      .prepare("SELECT COUNT(*) as cnt FROM notification_log")
      .get() as { cnt: number };
    expect(rows.cnt).toBe(0);
  });

  it("logFailedDelivery truncates summaryBase when it exceeds 200 chars", async () => {
    const primary = makeAdapter("slack", {
      primaryRecipient: "D111",
      sendMessage: vi.fn().mockRejectedValue(new Error("socket closed")),
    });
    const hub = new MessageHub(
      makeConfig({
        primaryPlatform: "slack",
        defaultNotificationPlatforms: ["slack"],
        slackOwnerUserId: "U111",
      }),
      db,
    );
    hub.setPlatformConfigured("slack", true);
    registerForTest(hub, primary);

    const longContent = "x".repeat(220);
    await expect(
      hub.sendToUser("hello", undefined, {
        dispatchId: "dispatch-long",
        notificationType: "routine.evening_review",
        priority: "normal",
        contentSummary: longContent,
      }),
    ).rejects.toBeInstanceOf(MessageDeliveryError);

    const row = db
      .prepare("SELECT content_summary FROM notification_log ORDER BY id DESC LIMIT 1")
      .get() as { content_summary: string };
    expect(row.content_summary.length).toBe(200);
    expect(row.content_summary.endsWith("...")).toBe(true);
  });

  it("resolveUserChannel: no db + no primaryRecipient → calls adapter.resolveUserChannel", async () => {
    const adapter = makeAdapter("slack", {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      resolveUserChannel: vi.fn().mockResolvedValue("D_FROM_RESOLVE"),
    });
    // Hub WITHOUT db
    const hub = new MessageHub(
      makeConfig({
        primaryPlatform: "slack",
        defaultNotificationPlatforms: ["slack"],
        slackOwnerUserId: "U123",
      }),
    );
    hub.setPlatformConfigured("slack", true);
    registerForTest(hub, adapter);

    await hub.sendToUser("hello");
    expect(adapter.resolveUserChannel).toHaveBeenCalledTimes(1);
    expect(adapter.sendMessage).toHaveBeenCalledWith({
      channel: "D_FROM_RESOLVE",
      text: "hello",
    });
  });

  it("beginProcessingIndicator: adapter's beginProcessingIndicator returns null → uses NOOP", async () => {
    const adapter = makeAdapter("whatsapp", {
      primaryRecipient: "818012345678@s.whatsapp.net",
      beginProcessingIndicator: vi.fn().mockResolvedValue(null),
    });
    const hub = new MessageHub(makeConfig(), db);
    registerForTest(hub, adapter);

    const handle = await hub.beginProcessingIndicator("whatsapp", "818012345678@s.whatsapp.net");
    // Should be the NOOP handle, which can be stopped without error
    await handle.stop();
    expect(adapter.beginProcessingIndicator).toHaveBeenCalledTimes(1);
  });

  it("isPlatformConfigured('dashboard') always returns true from constructor", () => {
    const hub = new MessageHub(makeConfig(), db);
    expect(hub.isPlatformConfigured("dashboard")).toBe(true);
  });

  it("setPlatformRuntimeStatus updates the stored status", () => {
    const adapter = makeAdapter("slack");
    const hub = new MessageHub(makeConfig(), db);
    registerForTest(hub, adapter);

    hub.setPlatformRuntimeStatus("slack", { runtimeState: "error", error: "disconnected" });
    const statuses = hub.getAdapterStatuses();
    expect(statuses.slack).toEqual({ runtimeState: "error", error: "disconnected" });
  });

  it("deliverToResolvedPlatforms: unresolvable owner channel logs failure and continues", async () => {
    // Adapter with no primaryRecipient, no db, no resolveUserChannel → channel=null
    const adapter = makeAdapter("telegram", {
      primaryRecipient: null,
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });
    // Hub WITHOUT db so the DB lookup is skipped too, and no resolveUserChannel
    const hub = new MessageHub(
      makeConfig({
        primaryPlatform: "telegram",
        defaultNotificationPlatforms: ["telegram"],
        telegramOwnerChatId: "123",
      }),
    );
    hub.setPlatformConfigured("telegram", true);
    registerForTest(hub, adapter);

    // With no way to resolve the channel, delivery should fail
    await expect(hub.sendToUser("hello")).rejects.toBeInstanceOf(MessageDeliveryError);
    // sendMessage should not have been called
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("startAll: rejection reason is not an Error → uses String(reason)", async () => {
    // Start an adapter that rejects with a non-Error value
    const adapter = makeAdapter("telegram", {
      start: vi.fn().mockRejectedValue("string rejection reason"),
    });
    const hub = new MessageHub(makeConfig(), db);
    registerForTest(hub, adapter);

    await hub.startAll();

    const statuses = hub.getAdapterStatuses();
    expect(statuses.telegram?.runtimeState).toBe("error");
    expect(statuses.telegram?.error).toBe("string rejection reason");
  });

  it("getPlatformRuntimeStatus: adapterStatus entry missing for registered adapter → fallback", () => {
    // Tests lines 162-164: the `?? { runtimeState: 'error', error: 'Adapter not registered' }`
    // fallback inside getPlatformRuntimeStatus when adapterStatus has no entry for the platform.
    const adapter = makeAdapter("slack");
    const hub = new MessageHub(
      makeConfig({ slackOwnerUserId: "U123" }),
      db,
    );
    hub.setPlatformConfigured("slack", true);
    registerForTest(hub, adapter);

    // Manually remove the adapterStatus entry to trigger the fallback
    (hub as unknown as { adapterStatus: Map<string, unknown> }).adapterStatus.delete("slack");

    const status = hub.getPlatformRuntimeStatus("slack");
    expect(status).toEqual({ runtimeState: "error", error: "Adapter not registered" });
  });

  it("resolveDestinationPlatforms: requested platforms that are eligible → returned directly", async () => {
    // When sendToUser is called with explicit 'platforms' arg and those platforms are
    // notification-eligible, resolveDestinationPlatforms returns from the requested branch (lines 235-237).
    const adapter = makeAdapter("slack", {
      primaryRecipient: "D111",
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });
    const hub = new MessageHub(
      makeConfig({
        primaryPlatform: "telegram",
        defaultNotificationPlatforms: [],
        slackOwnerUserId: "U111",
      }),
      db,
    );
    hub.setPlatformConfigured("slack", true);
    registerForTest(hub, adapter);

    // Explicitly pass ["slack"] as the platforms arg
    await hub.sendToUser("hello", ["slack"]);
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("beginProcessingIndicator: non-Error thrown → String(err) branch in error handler", async () => {
    const adapter = makeAdapter("whatsapp", {
      primaryRecipient: "818012345678@s.whatsapp.net",
      beginProcessingIndicator: vi.fn().mockRejectedValue("string error"),
    });
    const hub = new MessageHub(makeConfig(), db);
    registerForTest(hub, adapter);

    // Should not throw — catches non-Error rejection
    const handle = await hub.beginProcessingIndicator("whatsapp", "818012345678@s.whatsapp.net");
    await handle.stop();
  });

  it("sendToPlatform: sendMessage returns object with messageId", async () => {
    const adapter = makeAdapter("slack", {
      sendMessage: vi.fn().mockResolvedValue({ messageId: "msg-123" }),
    });
    const hub = new MessageHub(makeConfig(), db);
    registerForTest(hub, adapter);

    const delivery = await hub.sendToPlatform("slack", "C123", "hello");
    expect(delivery.messageId).toBe("msg-123");
  });

  it("deliverToResolvedPlatforms: sendMessage returns object with messageId (optional chain truthy branch)", async () => {
    const adapter = makeAdapter("slack", {
      primaryRecipient: "D111",
      sendMessage: vi.fn().mockResolvedValue({ messageId: "msg-proactive-123" }),
    });
    const hub = new MessageHub(
      makeConfig({
        primaryPlatform: "slack",
        defaultNotificationPlatforms: ["slack"],
        slackOwnerUserId: "U111",
      }),
      db,
    );
    hub.setPlatformConfigured("slack", true);
    registerForTest(hub, adapter);

    const deliveries = await hub.sendToUser("hello");
    expect(deliveries[0]?.messageId).toBe("msg-proactive-123");
  });

  it("deliverToResolvedPlatforms: sendMessage throws non-Error → String(err) branch", async () => {
    const adapter = makeAdapter("slack", {
      primaryRecipient: "D111",
      sendMessage: vi.fn().mockRejectedValue("string error from sendMessage"),
    });
    const hub = new MessageHub(
      makeConfig({
        primaryPlatform: "slack",
        defaultNotificationPlatforms: ["slack"],
        slackOwnerUserId: "U111",
      }),
      db,
    );
    hub.setPlatformConfigured("slack", true);
    registerForTest(hub, adapter);

    // The non-Error rejection hits the String(err) branch at line 365
    await expect(hub.sendToUser("hello")).rejects.toBeInstanceOf(MessageDeliveryError);
  });

  it("resolveDestinationPlatforms: falls through to primary platform when configuredDefaults is empty", async () => {
    // When defaultNotificationPlatforms is empty and primary IS notification-eligible,
    // resolveDestinationPlatforms falls through to the 'primary' check (lines 246-249).
    const adapter = makeAdapter("slack", {
      primaryRecipient: "D111",
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });
    const hub = new MessageHub(
      makeConfig({
        primaryPlatform: "slack",
        defaultNotificationPlatforms: [], // empty — forces fallthrough to primary
        slackOwnerUserId: "U111",
      }),
      db,
    );
    hub.setPlatformConfigured("slack", true);
    registerForTest(hub, adapter);

    await hub.sendToUser("hello");
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("deliverToResolvedPlatforms: adapter not registered for a pre-resolved target platform", async () => {
    // Call deliverToResolvedPlatforms directly with a platform that has no registered adapter.
    // This exercises the defensive !adapter guard (lines 332-337).
    const hub = new MessageHub(
      makeConfig({ primaryPlatform: "slack" }),
      db,
    );
    // Don't register any adapter for "slack" — inject the platform directly
    const deliverFn = (hub as unknown as {
      deliverToResolvedPlatforms: (
        text: string,
        targets: readonly string[],
        logContext?: { dispatchId: string; notificationType: string; priority: string; contentSummary: string },
      ) => Promise<{ platform: string; channel: string; messageId?: string }[]>;
    }).deliverToResolvedPlatforms.bind(hub);

    await expect(
      deliverFn("hello", ["slack" as "slack"], {
        dispatchId: "dispatch-no-adapter",
        notificationType: "routine.check",
        priority: "normal",
        contentSummary: "hello",
      }),
    ).rejects.toBeInstanceOf(MessageDeliveryError);
  });
});
