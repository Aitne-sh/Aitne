import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { SlackAdapter } from "../adapters/slack-adapter.js";
import { MessageHub } from "../adapters/message-hub.js";
import {
  generateMagicPhrase,
  buildPhraseMatcher,
  isPhraseWrappedInExtraText,
} from "./magic-phrase.js";
import {
  sendSetupWelcomeDm,
  WELCOME_DM_RUNTIME_STATE_KEY,
  WELCOME_DM_TEXT,
} from "./setup-welcome-dm.js";
import { readRuntimeState } from "../db/runtime-state.js";
import { applySchema } from "../db/schema.js";
import type { AgentConfig } from "../config.js";

/**
 * P2-25 — end-to-end pairing happy path + recovery branches.
 *
 * Walks: setup wizard issues phrase → adapter receives DM matching phrase
 * → captureOwner fires onOwnerDetected → recordDetectedOwner-like callback
 * persists + invokes sendSetupWelcomeDm → welcome latch set → second
 * pairing (re-pair) does NOT re-fire the welcome.
 *
 * Mocks: @slack/bolt is intentionally NOT loaded (we drive `handleMessage`
 * directly, mirroring slack-adapter.test.ts). MessageHub uses a stub
 * adapter so `sendToUser` records the welcome payload without touching a
 * real Slack workspace.
 */

function makeConfig(): AgentConfig {
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
    agentDisplayName: "Aitne",
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
    defaultNotificationPlatforms: ["slack"],
    disallowedTools: [],
    allowedToolsOverride: null,
    apiPort: 8321,
  } as unknown as AgentConfig;
}

describe("pairing E2E (Slack magic-phrase → recordOwner → welcome DM)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("walks the happy path: phrase match → onOwnerDetected → welcome DM with latch", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ messageId: "ts-welcome" });
    const config = makeConfig();
    const hub = new MessageHub(config, db);
    hub.register({
      platformName: "slack",
      primaryRecipient: null,
      start: async () => {},
      stop: async () => {},
      sendMessage,
      resolveUserChannel: async () => "D-OWNER",
    });
    hub.setPlatformConfigured("slack", true);
    // Adapter starts in "connecting" after P2-04; promote to ok so the
    // notification path treats it as eligible without waiting for startAll.
    hub.setPlatformRuntimeStatus("slack", { runtimeState: "ok", error: null });

    let recordedOwnerId: string | null = null;
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: null,
      onMessage: vi.fn(),
      onOwnerDetected: async (id: string) => {
        // Mirror recordDetectedOwner: persist (via config mutation in this
        // test) and trigger the consolidated welcome path (P2-05).
        recordedOwnerId = id;
        config.slackOwnerUserId = id;
        await sendSetupWelcomeDm({ db, messageHub: hub });
      },
    });

    const phrase = generateMagicPhrase();
    adapter.startPairing({
      match: buildPhraseMatcher(phrase),
      expiresAt: Date.now() + 60_000,
      hintReply: (text) =>
        isPhraseWrappedInExtraText(phrase, text)
          ? "Send the pairing phrase by itself, with no other text."
          : null,
    });

    // Drive an inbound DM that satisfies the matcher.
    await (
      adapter as unknown as {
        handleMessage: (msg: unknown) => Promise<void>;
      }
    ).handleMessage({
      channel_type: "im",
      user: "U_OWNER",
      text: phrase,
      channel: "D-OWNER",
    });

    expect(recordedOwnerId).toBe("U_OWNER");
    expect(adapter.getOwnerUserId()).toBe("U_OWNER");
    expect(adapter.isPairingActive()).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "D-OWNER", text: WELCOME_DM_TEXT }),
    );

    // Latch is set so a re-pairing attempt does NOT double-send.
    const latch = readRuntimeState<{ platforms: string[] }>(
      db,
      WELCOME_DM_RUNTIME_STATE_KEY,
    );
    expect(latch?.platforms).toEqual(["slack"]);
  });

  it("re-pairing after the welcome latch sends a short ack (no duplicate menu)", async () => {
    // Mirrors `recordDetectedOwner`'s new contract: welcome path first;
    // if that's latched, fall back to a per-platform ack so the
    // newly-paired channel isn't left silent. Prevents the regression
    // where a Slack-then-Telegram pairing would give zero feedback on
    // Telegram (welcome was already burned by Slack's first pair).
    const sendMessage = vi.fn().mockResolvedValue({ messageId: "ts" });
    const config = makeConfig();
    config.slackOwnerUserId = "U_OWNER";
    const hub = new MessageHub(config, db);
    hub.register({
      platformName: "slack",
      primaryRecipient: null,
      start: async () => {},
      stop: async () => {},
      sendMessage,
      resolveUserChannel: async () => "D-OWNER",
    });
    hub.setPlatformConfigured("slack", true);
    hub.setPlatformRuntimeStatus("slack", { runtimeState: "ok", error: null });

    // Pretend the welcome already fired on a prior pairing.
    await sendSetupWelcomeDm({ db, messageHub: hub });
    sendMessage.mockClear();

    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: null,
      onMessage: vi.fn(),
      onOwnerDetected: async (_id: string) => {
        const welcome = await sendSetupWelcomeDm({ db, messageHub: hub });
        if (welcome === null) {
          await hub.sendToPlatform(
            "slack",
            "user",
            "Pairing successful — this channel is now linked as your owner DM.",
          );
        }
      },
    });

    const phrase = generateMagicPhrase();
    adapter.startPairing({
      match: buildPhraseMatcher(phrase),
      expiresAt: Date.now() + 60_000,
    });
    await (
      adapter as unknown as {
        handleMessage: (msg: unknown) => Promise<void>;
      }
    ).handleMessage({
      channel_type: "im",
      user: "U_OWNER",
      text: phrase,
      channel: "D-OWNER",
    });

    // Welcome was latched → ack falls through; one short DM, not the full
    // WELCOME_DM_TEXT menu.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sentText = sendMessage.mock.calls[0]?.[0]?.text as string;
    expect(sentText).toContain("Pairing successful");
    expect(sentText).not.toContain("!cost");
  });

  it("rejects wrong phrase and offers wrapped-phrase hint when applicable (P2-23)", async () => {
    const config = makeConfig();
    const hub = new MessageHub(config, db);
    hub.register({
      platformName: "slack",
      primaryRecipient: null,
      start: async () => {},
      stop: async () => {},
      sendMessage: vi.fn().mockResolvedValue({}),
      resolveUserChannel: async () => "D-OWNER",
    });
    hub.setPlatformRuntimeStatus("slack", { runtimeState: "ok", error: null });

    let recordedOwnerId: string | null = null;
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: null,
      onMessage: vi.fn(),
      onOwnerDetected: (id: string) => {
        recordedOwnerId = id;
      },
    });

    // Inject a known phrase so the test can construct a wrapped variant
    // deterministically.
    const phrase = "apple-banana-cherry-date";
    const postMessage = vi.fn().mockResolvedValue({});
    (adapter as unknown as { app: unknown }).app = {
      client: { chat: { postMessage } },
    };
    adapter.startPairing({
      match: buildPhraseMatcher(phrase),
      expiresAt: Date.now() + 60_000,
      hintReply: (text) =>
        isPhraseWrappedInExtraText(phrase, text)
          ? "Send the pairing phrase by itself, with no other text."
          : null,
    });

    await (
      adapter as unknown as {
        handleMessage: (msg: unknown) => Promise<void>;
      }
    ).handleMessage({
      channel_type: "im",
      user: "U_USER",
      text: "my phrase is apple-banana-cherry-date please pair me",
      channel: "D-USER",
    });

    // Hint fired, pairing did NOT capture (wrong format).
    expect(recordedOwnerId).toBeNull();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "D-USER",
        text: expect.stringContaining("Send the pairing phrase by itself"),
      }),
    );
  });
});
