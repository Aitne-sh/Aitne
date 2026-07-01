import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Event } from "@aitne/shared";
import { EventPriority } from "@aitne/shared";

// vi.mock is hoisted — route most calls through the real implementation and
// allow individual tests to override readFileSync via the hoisted override slot.
const fsOverrides = vi.hoisted(() => ({
  readFileSync: undefined as ((...args: unknown[]) => unknown) | undefined,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: (...args: unknown[]) =>
      fsOverrides.readFileSync
        ? fsOverrides.readFileSync(...args)
        : (actual.readFileSync as (...args: unknown[]) => unknown)(...args),
  };
});

// We test constructor + outbound-attachment behaviour here without
// actually connecting to Discord. The discord.js Client is too complex
// to mock meaningfully — integration tests cover that path. Outbound
// text-chunking is exercised against the canonical `splitOutboundText`
// in `outbound-text.test.ts`; Discord's invocation point is `discord.ts`
// where it's called with `maxLen=2000`.

describe("DiscordAdapter interface contract", () => {
  it("module exports DiscordAdapter class", async () => {
    const mod = await import("./discord.js");
    expect(mod.DiscordAdapter).toBeDefined();
    expect(typeof mod.DiscordAdapter).toBe("function");
  });

  it("DiscordAdapter has correct platformName", async () => {
    // We can't actually construct without a valid token that connects,
    // but we can verify the class shape via prototype
    const mod = await import("./discord.js");
    const events: Event[] = [];
    const adapter = new mod.DiscordAdapter({
      botToken: "fake-token",
      ownerUserId: null,
      onMessage: (e) => events.push(e),
    });
    expect(adapter.platformName).toBe("discord");
  });

  // Regression guard: start() must register a "raw" gateway listener that
  // routes MESSAGE_CREATE packets to handleRawMessage. The discord.js
  // 14.26.2 bug documented in start() makes Events.MessageCreate silently
  // drop DMs — if a refactor ever re-introduces that listener as the
  // primary path, pairing breaks without any visible error.
  it("routes raw MESSAGE_CREATE packets to handleRawMessage", async () => {
    const mod = await import("./discord.js");
    const onMessage = vi.fn();
    const adapter = new mod.DiscordAdapter({
      botToken: "fake",
      ownerUserId: "U_OWNER",
      onMessage,
    });

    const rawHandlers: Array<(p: unknown) => void> = [];
    const stubClient = {
      removeAllListeners: vi.fn(),
      on: vi.fn((event: string, handler: (p: unknown) => void) => {
        if (event === "raw") rawHandlers.push(handler);
      }),
      login: vi.fn().mockResolvedValue(undefined),
      user: { id: "BOT", username: "bot", discriminator: "0", avatarURL: () => null, tag: "bot#0" },
    };
    (adapter as unknown as { client: typeof stubClient }).client = stubClient;

    await adapter.start();

    expect(rawHandlers.length).toBe(1);

    // Simulate a DM packet coming off the gateway.
    rawHandlers[0]({
      t: "MESSAGE_CREATE",
      d: {
        id: "m1",
        channel_id: "DM_CH",
        channel_type: 1,
        content: "hello",
        author: { id: "U_OWNER", bot: false },
        mentions: [],
      },
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    const event = onMessage.mock.calls[0][0];
    expect(event.isDm).toBe(true);
    expect(event.content).toBe("hello");
  });
});

// ── Challenge-based pairing ────────────────────────────────────────────
//
// We don't log into the Gateway — we feed the private `handleRawMessage`
// directly with a fake payload matching Discord's raw MESSAGE_CREATE
// gateway shape (not discord.js's Message class).

import { DiscordAdapter } from "./discord.js";
import type { AttachmentStore } from "../services/attachments/store.js";

function makeAdapter(opts: {
  ownerUserId?: string | null;
  onOwnerDetected?: (id: string) => void;
} = {}) {
  return new DiscordAdapter({
    botToken: "fake",
    ownerUserId: opts.ownerUserId ?? null,
    onMessage: vi.fn(),
    onOwnerDetected: opts.onOwnerDetected,
  });
}

function fakeDmPayload(userId: string, text: string) {
  return {
    author: { id: userId, bot: false },
    channel_type: 1, // DM
    channel_id: "DM_CH",
    mentions: [],
    content: text,
    id: "msg-dm",
  };
}

function fakeMentionPayload(userId: string, text: string) {
  return {
    author: { id: userId, bot: false },
    channel_type: 0, // GuildText
    channel_id: "GUILD_CH",
    mentions: [{ id: "BOT" }],
    content: text,
    id: "msg-mention",
    guild_id: "G1",
  };
}

// Mirror the daemon-side magic-phrase matcher exactly: equality on the
// normalised string. See magic-phrase.ts for security rationale.
function phraseMatcher(phrase: string): (text: string) => boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const expected = norm(phrase);
  return (text: string) => norm(text) === expected;
}

function fakeAttachmentStore() {
  return {
    ingestStream: vi.fn().mockImplementation(async (params: { originalFilename: string; declaredMimeType: string | null }) => ({
      id: "att-discord",
      path: `/tmp/${params.originalFilename}`,
      originalFilename: params.originalFilename,
      safeFilename: params.originalFilename,
      mimeType: params.declaredMimeType ?? "application/octet-stream",
      sizeBytes: 12,
    })),
  } as unknown as AttachmentStore;
}

describe("DiscordAdapter challenge-based pairing", () => {
  beforeEach(() => {
    void EventPriority; // suppress unused-import lint
  });

  it("captures only when an inbound DM contains the phrase", () => {
    const onOwnerDetected = vi.fn();
    const adapter = makeAdapter({ onOwnerDetected });
    adapter.startPairing({
      match: phraseMatcher("apple-banana-cherry-date"),
      expiresAt: Date.now() + 60_000,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";

    // Wrong text — dropped (regression test for the previous "first DM
    // wins" race that captured this exact scenario).
    (adapter as unknown as { handleRawMessage: (msg: unknown) => void }).handleRawMessage(
      fakeDmPayload("U_INTRUDER", "hi"),
    );
    expect(onOwnerDetected).not.toHaveBeenCalled();

    // Correct phrase — captures.
    (adapter as unknown as { handleRawMessage: (msg: unknown) => void }).handleRawMessage(
      fakeDmPayload("U_OWNER", "Apple Banana CHERRY date 🚀"),
    );
    expect(onOwnerDetected).toHaveBeenCalledWith("U_OWNER");
    expect(adapter.getOwnerUserId()).toBe("U_OWNER");
  });

  it("does NOT capture from a guild mention even when the text equals the phrase", () => {
    // Use a payload that EXACTLY equals the phrase so the only thing
    // protecting us here is the DM-vs-channel discriminator. If someone
    // ever weakens that check, this test will fail loudly.
    const onOwnerDetected = vi.fn();
    const adapter = makeAdapter({ onOwnerDetected });
    adapter.startPairing({
      match: phraseMatcher("apple-banana-cherry-date"),
      expiresAt: Date.now() + 60_000,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";

    (adapter as unknown as { handleRawMessage: (msg: unknown) => void }).handleRawMessage(
      fakeMentionPayload("U_OTHER", "apple-banana-cherry-date"),
    );

    expect(onOwnerDetected).not.toHaveBeenCalled();
    expect(adapter.getOwnerUserId()).toBeNull();
  });

  it("ignores messages from other bots", () => {
    const onOwnerDetected = vi.fn();
    const adapter = makeAdapter({ onOwnerDetected });
    adapter.startPairing({
      match: phraseMatcher("apple-banana-cherry-date"),
      expiresAt: Date.now() + 60_000,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";

    const botMessage = {
      ...fakeDmPayload("U_OTHER_BOT", "apple-banana-cherry-date"),
      author: { id: "U_OTHER_BOT", bot: true },
    };
    (adapter as unknown as { handleRawMessage: (msg: unknown) => void }).handleRawMessage(
      botMessage,
    );

    expect(onOwnerDetected).not.toHaveBeenCalled();
  });

  it("does NOT capture when no pairing challenge is active", () => {
    const onOwnerDetected = vi.fn();
    const adapter = makeAdapter({ onOwnerDetected });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";

    (adapter as unknown as { handleRawMessage: (msg: unknown) => void }).handleRawMessage(
      fakeDmPayload("U_RANDOM", "any text at all"),
    );

    expect(onOwnerDetected).not.toHaveBeenCalled();
    expect(adapter.getOwnerUserId()).toBeNull();
  });

  // H2 regression — see slack-adapter.test.ts for rationale.
  it("does NOT emit the captured phrase to onMessage (H2 regression)", () => {
    const onMessage = vi.fn();
    const onOwnerDetected = vi.fn();
    const adapter = new DiscordAdapter({
      botToken: "fake",
      ownerUserId: null,
      onMessage,
      onOwnerDetected,
    });
    adapter.startPairing({
      match: phraseMatcher("apple-banana-cherry-date"),
      expiresAt: Date.now() + 60_000,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";

    (adapter as unknown as { handleRawMessage: (msg: unknown) => void }).handleRawMessage(
      fakeDmPayload("U_OWNER", "apple-banana-cherry-date"),
    );

    expect(onOwnerDetected).toHaveBeenCalledTimes(1);
    expect(onMessage).not.toHaveBeenCalled();
  });
});

// ── Coverage gap fill: owner message handling, sendMessage, lifecycle, etc. ──

describe("DiscordAdapter owner message handling", () => {
  it("emits a DM event for the authorized owner", () => {
    const onMessage = vi.fn();
    const adapter = new DiscordAdapter({
      botToken: "fake",
      ownerUserId: "U_OWNER",
      onMessage,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";

    (adapter as unknown as { handleRawMessage: (msg: unknown) => void }).handleRawMessage(
      fakeDmPayload("U_OWNER", "hello agent"),
    );

    expect(onMessage).toHaveBeenCalledTimes(1);
    const event = onMessage.mock.calls[0][0];
    expect(event.content).toBe("hello agent");
    expect(event.platform).toBe("discord");
    expect(event.isDm).toBe(true);
    expect(event.isMention).toBe(false);
    expect(event.channel).toBe("DM_CH");
    expect(event.sender).toBe("U_OWNER");
  });

  it("emits a mention event for the authorized owner in a guild", () => {
    const onMessage = vi.fn();
    const adapter = new DiscordAdapter({
      botToken: "fake",
      ownerUserId: "U_OWNER",
      onMessage,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";

    (adapter as unknown as { handleRawMessage: (msg: unknown) => void }).handleRawMessage(
      fakeMentionPayload("U_OWNER", "<@BOT> do something"),
    );

    expect(onMessage).toHaveBeenCalledTimes(1);
    const event = onMessage.mock.calls[0][0];
    expect(event.isMention).toBe(true);
    expect(event.isDm).toBe(false);
  });

  it("drops messages from unauthorized senders", () => {
    const onMessage = vi.fn();
    const adapter = new DiscordAdapter({
      botToken: "fake",
      ownerUserId: "U_OWNER",
      onMessage,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";

    (adapter as unknown as { handleRawMessage: (msg: unknown) => void }).handleRawMessage(
      fakeDmPayload("U_STRANGER", "hi"),
    );

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("drops non-DM, non-mention guild messages", () => {
    const onMessage = vi.fn();
    const adapter = new DiscordAdapter({
      botToken: "fake",
      ownerUserId: "U_OWNER",
      onMessage,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";

    const guildMsg = {
      author: { id: "U_OWNER", bot: false },
      channel_type: 0,
      channel_id: "GUILD_CH",
      mentions: [],
      content: "just chatting",
      id: "msg-guild",
      guild_id: "G1",
    };
    (adapter as unknown as { handleRawMessage: (msg: unknown) => void }).handleRawMessage(guildMsg);

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("ignores the bot's own messages", () => {
    const onMessage = vi.fn();
    const adapter = new DiscordAdapter({
      botToken: "fake",
      ownerUserId: "U_OWNER",
      onMessage,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";

    (adapter as unknown as { handleRawMessage: (msg: unknown) => void }).handleRawMessage(
      fakeDmPayload("BOT", "my own message"),
    );

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("ingests audio/video attachments instead of skipping them", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new DiscordAdapter({
      botToken: "fake",
      ownerUserId: "U_OWNER",
      onMessage,
      attachmentStore: store,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";
    const mockFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as { handleRawMessage: (msg: unknown) => Promise<void> }).handleRawMessage({
      ...fakeDmPayload("U_OWNER", ""),
      attachments: [
        {
          id: "att1",
          url: "https://cdn.discord.test/clip.mp4",
          filename: "clip.mp4",
          size: 3,
          content_type: "video/mp4",
        },
        {
          id: "att2",
          url: "https://cdn.discord.test/clip.mp3",
          filename: "clip.mp3",
          size: 3,
          content_type: "audio/mpeg",
        },
      ],
    });

    expect(store.ingestStream).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        declaredMimeType: "video/mp4",
        originalFilename: "clip.mp4",
        maxSizeBytes: 25 * 1024 * 1024,
      }),
    );
    expect(store.ingestStream).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        declaredMimeType: "audio/mpeg",
        originalFilename: "clip.mp3",
        maxSizeBytes: 25 * 1024 * 1024,
      }),
    );
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].attachments).toHaveLength(2);
    mockFetch.mockRestore();
  });

  it("ignores sticker-only messages", async () => {
    const onMessage = vi.fn();
    const adapter = new DiscordAdapter({
      botToken: "fake",
      ownerUserId: "U_OWNER",
      onMessage,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";

    await (adapter as unknown as { handleRawMessage: (msg: unknown) => Promise<void> }).handleRawMessage({
      ...fakeDmPayload("U_OWNER", ""),
      sticker_items: [{ id: "sticker1", name: "wave" }],
    });

    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe("DiscordAdapter captureOwner error handling", () => {
  // B-1 regression: a failing onOwnerDetected (env unwritable etc.) must
  // roll back mutableOwnerId AND keep the matcher armed so the user can
  // retry. See slack-adapter.test for the full rationale.
  it("rolls back mutableOwnerId on synchronous throw in onOwnerDetected", async () => {
    const adapter = new DiscordAdapter({
      botToken: "fake",
      ownerUserId: null,
      onMessage: vi.fn(),
      onOwnerDetected: () => {
        throw new Error("sync fail");
      },
    });
    adapter.startPairing({
      match: phraseMatcher("test-phrase"),
      expiresAt: Date.now() + 60_000,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";

    await (adapter as unknown as {
      handleRawMessage: (msg: unknown) => Promise<void>;
    }).handleRawMessage(fakeDmPayload("U1", "test-phrase"));

    expect(adapter.getOwnerUserId()).toBeNull();
    expect(adapter.isPairingActive()).toBe(true);
  });

  it("rolls back mutableOwnerId on async rejection in onOwnerDetected", async () => {
    const adapter = new DiscordAdapter({
      botToken: "fake",
      ownerUserId: null,
      onMessage: vi.fn(),
      onOwnerDetected: async () => {
        throw new Error("async fail");
      },
    });
    adapter.startPairing({
      match: phraseMatcher("test-phrase"),
      expiresAt: Date.now() + 60_000,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";

    await (adapter as unknown as {
      handleRawMessage: (msg: unknown) => Promise<void>;
    }).handleRawMessage(fakeDmPayload("U1", "test-phrase"));

    expect(adapter.getOwnerUserId()).toBeNull();
    expect(adapter.isPairingActive()).toBe(true);
  });

  it("captures owner and cancels pairing when no onOwnerDetected callback supplied", async () => {
    const adapter = new DiscordAdapter({
      botToken: "fake",
      ownerUserId: null,
      onMessage: vi.fn(),
    });
    adapter.startPairing({
      match: phraseMatcher("test-phrase"),
      expiresAt: Date.now() + 60_000,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";

    await (adapter as unknown as {
      handleRawMessage: (msg: unknown) => Promise<void>;
    }).handleRawMessage(fakeDmPayload("U1", "test-phrase"));

    expect(adapter.getOwnerUserId()).toBe("U1");
    expect(adapter.isPairingActive()).toBe(false);
  });
});

// B-4 regression: Discord GroupDM (channel_type 3) must be rejected
// outright. Without the explicit type-3 guard, an owner @-mention in a
// GroupDM would fall through and emit an agent reply into a channel
// visible to non-owner participants.
describe("DiscordAdapter GroupDM rejection (B-4)", () => {
  it("drops GroupDM messages even when owner @-mentions the bot", async () => {
    const onMessage = vi.fn();
    const adapter = new DiscordAdapter({
      botToken: "fake",
      ownerUserId: "U_OWNER",
      onMessage,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";

    await (adapter as unknown as {
      handleRawMessage: (msg: unknown) => Promise<void>;
    }).handleRawMessage({
      id: "M1",
      channel_id: "C_GDM",
      author: { id: "U_OWNER", bot: false },
      content: "<@BOT> hello",
      channel_type: 3, // GroupDM
      mentions: [{ id: "BOT" }],
    });

    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe("DiscordAdapter pairing lifecycle", () => {
  it("setOwnerUserId / getOwnerUserId round-trips", () => {
    const adapter = makeAdapter();
    expect(adapter.getOwnerUserId()).toBeNull();
    adapter.setOwnerUserId("U_NEW");
    expect(adapter.getOwnerUserId()).toBe("U_NEW");
    adapter.setOwnerUserId(null);
    expect(adapter.getOwnerUserId()).toBeNull();
  });

  it("cancelPairing deactivates the challenge", () => {
    const adapter = makeAdapter();
    adapter.startPairing({
      match: phraseMatcher("test"),
      expiresAt: Date.now() + 60_000,
    });
    expect(adapter.isPairingActive()).toBe(true);
    adapter.cancelPairing();
    expect(adapter.isPairingActive()).toBe(false);
  });

  it("isPairingActive returns false when challenge has expired", () => {
    const adapter = makeAdapter();
    adapter.startPairing({
      match: phraseMatcher("test"),
      expiresAt: Date.now() - 1,
    });
    expect(adapter.isPairingActive()).toBe(false);
  });

  it("getBotInfo returns null before start", () => {
    const adapter = makeAdapter();
    expect(adapter.getBotInfo()).toBeNull();
  });
});

describe("DiscordAdapter sendMessage", () => {
  it("sends a message through the discord client", async () => {
    const adapter = makeAdapter();
    const sentMsg = { id: "sent-1" };
    const mockChannel = {
      send: vi.fn().mockResolvedValue(sentMsg),
    };
    const mockClient = adapter as unknown as {
      client: { channels: { fetch: (id: string) => Promise<unknown> } };
    };
    mockClient.client.channels = {
      fetch: vi.fn().mockResolvedValue(mockChannel),
    };

    const result = await adapter.sendMessage({
      channel: "CH1",
      text: "hello",
    });

    expect(mockChannel.send).toHaveBeenCalledWith("hello");
    expect(result.messageId).toBe("sent-1");
  });

  it("splits long messages into 2000-char chunks", async () => {
    const adapter = makeAdapter();
    const mockChannel = {
      send: vi.fn().mockResolvedValue({ id: "sent-chunk" }),
    };
    const mockClient = adapter as unknown as {
      client: { channels: { fetch: (id: string) => Promise<unknown> } };
    };
    mockClient.client.channels = {
      fetch: vi.fn().mockResolvedValue(mockChannel),
    };

    await adapter.sendMessage({
      channel: "CH1",
      text: "a".repeat(5000),
    });

    expect(mockChannel.send.mock.calls.length).toBeGreaterThan(1);
  });

  it("throws when channel is not found", async () => {
    const adapter = makeAdapter();
    const mockClient = adapter as unknown as {
      client: { channels: { fetch: (id: string) => Promise<unknown> } };
    };
    mockClient.client.channels = {
      fetch: vi.fn().mockResolvedValue(null),
    };

    await expect(
      adapter.sendMessage({ channel: "MISSING", text: "hi" }),
    ).rejects.toThrow("Channel not found or not text");
  });

  it("throws when channel has no send method", async () => {
    const adapter = makeAdapter();
    const mockClient = adapter as unknown as {
      client: { channels: { fetch: (id: string) => Promise<unknown> } };
    };
    mockClient.client.channels = {
      fetch: vi.fn().mockResolvedValue({ id: "voice-ch" }),
    };

    await expect(
      adapter.sendMessage({ channel: "VOICE", text: "hi" }),
    ).rejects.toThrow("Channel not found or not text");
  });
});

describe("DiscordAdapter beginProcessingIndicator (…is typing)", () => {
  function withChannel(sendTyping = vi.fn().mockResolvedValue(undefined)) {
    const adapter = makeAdapter({ ownerUserId: "U1" });
    const fetch = vi.fn().mockResolvedValue({ sendTyping });
    (adapter as unknown as {
      client: { channels: { fetch: (id: string) => Promise<unknown> } };
    }).client.channels = { fetch };
    return { adapter, fetch, sendTyping };
  }

  it("fires sendTyping immediately on begin", async () => {
    const { adapter, sendTyping } = withChannel();

    const handle = await adapter.beginProcessingIndicator({ channel: "CH1" });

    expect(sendTyping).toHaveBeenCalledTimes(1);
    await handle.stop();
  });

  it("re-fires sendTyping on the refresh interval until stopped", async () => {
    vi.useFakeTimers();
    const { adapter, sendTyping } = withChannel();

    const handle = await adapter.beginProcessingIndicator({ channel: "CH1" });
    expect(sendTyping).toHaveBeenCalledTimes(1); // immediate

    await vi.advanceTimersByTimeAsync(8_000);
    expect(sendTyping).toHaveBeenCalledTimes(2); // one refresh

    await handle.stop();
    await vi.advanceTimersByTimeAsync(24_000);
    expect(sendTyping).toHaveBeenCalledTimes(2); // no more after stop

    vi.useRealTimers();
  });

  it("stop() is idempotent — a second call is a no-op", async () => {
    vi.useFakeTimers();
    const { adapter, sendTyping } = withChannel();

    const handle = await adapter.beginProcessingIndicator({ channel: "CH1" });
    await handle.stop();
    const afterFirst = sendTyping.mock.calls.length;
    await handle.stop();
    expect(sendTyping.mock.calls.length).toBe(afterFirst);

    vi.useRealTimers();
  });

  it("swallows a channel-fetch rejection and still returns a working handle", async () => {
    const adapter = makeAdapter({ ownerUserId: "U1" });
    (adapter as unknown as {
      client: { channels: { fetch: (id: string) => Promise<unknown> } };
    }).client.channels = {
      fetch: vi.fn().mockRejectedValue(new Error("Unknown Channel")),
    };

    const handle = await adapter.beginProcessingIndicator({ channel: "CH1" });
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it("skips a channel that has no sendTyping (voice channel guard)", async () => {
    const adapter = makeAdapter({ ownerUserId: "U1" });
    (adapter as unknown as {
      client: { channels: { fetch: (id: string) => Promise<unknown> } };
    }).client.channels = {
      fetch: vi.fn().mockResolvedValue({ id: "voice-ch" }), // no sendTyping
    };

    const handle = await adapter.beginProcessingIndicator({ channel: "VOICE" });
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it("adapter stop() cancels an in-flight typing interval", async () => {
    vi.useFakeTimers();
    const { adapter, sendTyping } = withChannel();

    await adapter.beginProcessingIndicator({ channel: "CH1" });
    expect(
      (adapter as unknown as { typingInterval: unknown }).typingInterval,
    ).not.toBeNull();

    await adapter.stop();
    expect(
      (adapter as unknown as { typingInterval: unknown }).typingInterval,
    ).toBeNull();

    const callsAtStop = sendTyping.mock.calls.length;
    await vi.advanceTimersByTimeAsync(24_000);
    expect(sendTyping.mock.calls.length).toBe(callsAtStop);

    vi.useRealTimers();
  });

  it("swallows a non-Error rejection (String(err) branch)", async () => {
    const adapter = makeAdapter({ ownerUserId: "U1" });
    (adapter as unknown as {
      client: { channels: { fetch: (id: string) => Promise<unknown> } };
    }).client.channels = {
      fetch: vi.fn().mockRejectedValue("boom"), // non-Error
    };

    const handle = await adapter.beginProcessingIndicator({ channel: "CH1" });
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it("defensively clears a stranded prior interval when a new indicator begins", async () => {
    vi.useFakeTimers();
    const { adapter, sendTyping } = withChannel();

    // First indicator whose stop() never ran (stranded interval), then a
    // second indicator claims the slot — the first interval must be cleared
    // so refresh ticks never stack two-per-period.
    await adapter.beginProcessingIndicator({ channel: "CH1" });
    await adapter.beginProcessingIndicator({ channel: "CH1" });

    const baseline = sendTyping.mock.calls.length; // 2 immediate begins
    await vi.advanceTimersByTimeAsync(8_000);
    expect(sendTyping.mock.calls.length).toBe(baseline + 1); // exactly one tick

    vi.useRealTimers();
  });
});

describe("DiscordAdapter resolveUserChannel", () => {
  it("returns null when no owner is configured", async () => {
    const adapter = makeAdapter({ ownerUserId: null });
    const result = await adapter.resolveUserChannel();
    expect(result).toBeNull();
  });

  it("resolves the DM channel for the owner", async () => {
    const adapter = makeAdapter({ ownerUserId: "U_OWNER" });
    const mockClient = adapter as unknown as {
      client: {
        users: {
          fetch: (id: string) => Promise<{ createDM: () => Promise<{ id: string }> }>;
        };
      };
    };
    mockClient.client.users = {
      fetch: vi.fn().mockResolvedValue({
        createDM: vi.fn().mockResolvedValue({ id: "DM_CHANNEL" }),
      }),
    };

    const result = await adapter.resolveUserChannel();
    expect(result).toBe("DM_CHANNEL");
  });
});

describe("DiscordAdapter.fetchBotInfo (static)", () => {
  it("returns bot info on success", async () => {
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "123",
          username: "TestBot",
          discriminator: "0001",
          avatar: "abc",
        }),
        { status: 200 },
      ),
    );

    const info = await DiscordAdapter.fetchBotInfo("fake-token");

    expect(info.id).toBe("123");
    expect(info.username).toBe("TestBot");
    expect(info.discriminator).toBe("0001");
    expect(info.avatarUrl).toContain("cdn.discordapp.com");
    mockFetch.mockRestore();
  });

  it("returns null avatarUrl when avatar is not set", async () => {
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ id: "123", username: "Bot", avatar: null }),
        { status: 200 },
      ),
    );

    const info = await DiscordAdapter.fetchBotInfo("fake-token");
    expect(info.avatarUrl).toBeNull();
    mockFetch.mockRestore();
  });

  it("throws on HTTP error", async () => {
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", { status: 401, statusText: "Unauthorized" }),
    );

    await expect(DiscordAdapter.fetchBotInfo("bad-token")).rejects.toThrow(
      "Discord /users/@me failed: 401",
    );
    mockFetch.mockRestore();
  });
});

// ── New coverage gap tests ──────────────────────────────────────────────────

function makeOutboundAttachment(overrides: Partial<{
  id: string;
  path: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  caption?: string;
}> = {}) {
  return {
    id: "att-1",
    path: "/tmp/test.png",
    originalFilename: "test.png",
    mimeType: "image/png",
    sizeBytes: 100,
    ...overrides,
  };
}

describe("DiscordAdapter stop()", () => {
  it("calls client.destroy()", async () => {
    const adapter = makeAdapter();
    const mockDestroy = vi.fn();
    (adapter as unknown as { client: { destroy: () => void } }).client.destroy = mockDestroy;

    await adapter.stop();

    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });
});

describe("DiscordAdapter start() event handlers and branches", () => {
  it("registers error and warn handlers that can be triggered without throwing", async () => {
    const adapter = makeAdapter({ ownerUserId: "U_OWNER" });
    const allHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    const stubClient = {
      removeAllListeners: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        allHandlers[event] = [...(allHandlers[event] ?? []), handler];
      }),
      login: vi.fn().mockResolvedValue(undefined),
      user: { id: "BOT", username: "bot", discriminator: "0", avatarURL: () => null, tag: "bot#0" },
    };
    (adapter as unknown as { client: typeof stubClient }).client = stubClient;

    await adapter.start();

    // Error handler must not throw
    expect(() => allHandlers["error"]?.[0](new Error("ws fail"))).not.toThrow();
    // Warn handler must not throw
    expect(() => allHandlers["warn"]?.[0]("rate limit")).not.toThrow();
  });

  it("handles client.user being null after login (botInfo stays null, botUserId stays null)", async () => {
    const adapter = makeAdapter();
    const stubClient = {
      removeAllListeners: vi.fn(),
      on: vi.fn(),
      login: vi.fn().mockResolvedValue(undefined),
      user: null, // <— null branch
    };
    (adapter as unknown as { client: typeof stubClient }).client = stubClient;

    await adapter.start();

    expect(adapter.getBotInfo()).toBeNull();
    expect((adapter as unknown as { botUserId: string | null }).botUserId).toBeNull();
  });

  it("captures discriminator as null when undefined and avatarURL as non-null when returned", async () => {
    const adapter = makeAdapter();
    const stubClient = {
      removeAllListeners: vi.fn(),
      on: vi.fn(),
      login: vi.fn().mockResolvedValue(undefined),
      user: {
        id: "BOT",
        username: "bot",
        discriminator: undefined, // <— null branch: discriminator ?? null
        avatarURL: () => "https://cdn.discordapp.com/avatars/BOT/abc.png", // <— non-null branch
        tag: "bot",
      },
    };
    (adapter as unknown as { client: typeof stubClient }).client = stubClient;

    await adapter.start();

    const info = adapter.getBotInfo();
    expect(info).not.toBeNull();
    expect(info!.discriminator).toBeNull();
    expect(info!.avatarUrl).toBe("https://cdn.discordapp.com/avatars/BOT/abc.png");
  });

  it("raw .catch callback fires when handleRawMessage rejects", async () => {
    const adapter = makeAdapter({ ownerUserId: "U_OWNER" });
    const allHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    const stubClient = {
      removeAllListeners: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        allHandlers[event] = [...(allHandlers[event] ?? []), handler];
      }),
      login: vi.fn().mockResolvedValue(undefined),
      user: { id: "BOT", username: "bot", discriminator: "0", avatarURL: () => null, tag: "bot#0" },
    };
    (adapter as unknown as { client: typeof stubClient }).client = stubClient;

    // Replace handleRawMessage with one that rejects
    (adapter as unknown as { handleRawMessage: (d: unknown) => Promise<void> }).handleRawMessage =
      vi.fn().mockRejectedValue(new Error("internal fail"));

    await adapter.start();

    // Trigger the raw handler — the .catch should absorb the rejection
    allHandlers["raw"]?.[0]({ t: "MESSAGE_CREATE", d: { channel_type: 1, content: "hi", author: { id: "U_OWNER" } } });

    // Let microtask queue drain
    await new Promise((resolve) => setTimeout(resolve, 0));
    // No unhandled rejection = success
  });

  it("raw packet that is NOT MESSAGE_CREATE is ignored", async () => {
    const adapter = makeAdapter({ ownerUserId: "U_OWNER" });
    const onMessage = vi.fn();
    (adapter as unknown as { onMessage: typeof onMessage }).onMessage = onMessage;
    const allHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    const stubClient = {
      removeAllListeners: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        allHandlers[event] = [...(allHandlers[event] ?? []), handler];
      }),
      login: vi.fn().mockResolvedValue(undefined),
      user: { id: "BOT", username: "bot", discriminator: "0", avatarURL: () => null, tag: "bot#0" },
    };
    (adapter as unknown as { client: typeof stubClient }).client = stubClient;

    await adapter.start();

    // A non-MESSAGE_CREATE packet — should be silently ignored
    allHandlers["raw"]?.[0]({ t: "PRESENCE_UPDATE", d: { user: { id: "U_OWNER" } } });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe("DiscordAdapter handleRawMessage edge cases", () => {
  it("returns early when author.id is missing", async () => {
    const onMessage = vi.fn();
    const adapter = new DiscordAdapter({
      botToken: "fake",
      ownerUserId: "U_OWNER",
      onMessage,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";

    await (adapter as unknown as { handleRawMessage: (msg: unknown) => Promise<void> }).handleRawMessage({
      channel_type: 1,
      content: "hi",
      author: { bot: false }, // id is absent
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("skips inbound attachment with no url", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new DiscordAdapter({
      botToken: "fake",
      ownerUserId: "U_OWNER",
      onMessage,
      attachmentStore: store,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";

    await (adapter as unknown as { handleRawMessage: (msg: unknown) => Promise<void> }).handleRawMessage({
      ...fakeDmPayload("U_OWNER", "hello"),
      attachments: [
        { id: "att1", filename: "test.png", size: 100 }, // no url
      ],
    });

    expect(store.ingestStream).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledTimes(1); // event still emitted (text message)
  });

  it("skips inbound attachment with no filename", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new DiscordAdapter({
      botToken: "fake",
      ownerUserId: "U_OWNER",
      onMessage,
      attachmentStore: store,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";

    await (adapter as unknown as { handleRawMessage: (msg: unknown) => Promise<void> }).handleRawMessage({
      ...fakeDmPayload("U_OWNER", "hello"),
      attachments: [
        { id: "att1", url: "https://cdn.discord.test/test.png", size: 100 }, // no filename
      ],
    });

    expect(store.ingestStream).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("skips inbound attachment that exceeds DISCORD_INBOUND_MAX_BYTES (25 MB)", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new DiscordAdapter({
      botToken: "fake",
      ownerUserId: "U_OWNER",
      onMessage,
      attachmentStore: store,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";

    const oversizedBytes = 25 * 1024 * 1024 + 1;
    await (adapter as unknown as { handleRawMessage: (msg: unknown) => Promise<void> }).handleRawMessage({
      ...fakeDmPayload("U_OWNER", "hello"),
      attachments: [
        { id: "att1", url: "https://cdn.discord.test/huge.bin", filename: "huge.bin", size: oversizedBytes },
      ],
    });

    expect(store.ingestStream).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("uses 0 as default when att.size is undefined (the ?? 0 null branch)", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new DiscordAdapter({
      botToken: "fake",
      ownerUserId: "U_OWNER",
      onMessage,
      attachmentStore: store,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as { handleRawMessage: (msg: unknown) => Promise<void> }).handleRawMessage({
      ...fakeDmPayload("U_OWNER", "hello"),
      attachments: [
        { id: "att1", url: "https://cdn.discord.test/test.png", filename: "test.png" }, // size: undefined
      ],
    });

    expect(store.ingestStream).toHaveBeenCalledTimes(1);
    mockFetch.mockRestore();
  });

  it("skips inbound attachment when fetch returns non-ok", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new DiscordAdapter({
      botToken: "fake",
      ownerUserId: "U_OWNER",
      onMessage,
      attachmentStore: store,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("forbidden", { status: 403 }),
    );

    await (adapter as unknown as { handleRawMessage: (msg: unknown) => Promise<void> }).handleRawMessage({
      ...fakeDmPayload("U_OWNER", "hello"),
      attachments: [
        { id: "att1", url: "https://cdn.discord.test/test.png", filename: "test.png", size: 100 },
      ],
    });

    expect(store.ingestStream).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledTimes(1);
    mockFetch.mockRestore();
  });

  it("catches and continues when ingestStream throws", async () => {
    const onMessage = vi.fn();
    const store = {
      ingestStream: vi.fn().mockRejectedValue(new Error("disk full")),
    } as unknown as AttachmentStore;
    const adapter = new DiscordAdapter({
      botToken: "fake",
      ownerUserId: "U_OWNER",
      onMessage,
      attachmentStore: store,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as { handleRawMessage: (msg: unknown) => Promise<void> }).handleRawMessage({
      ...fakeDmPayload("U_OWNER", "hello"),
      attachments: [
        { id: "att1", url: "https://cdn.discord.test/test.png", filename: "test.png", size: 100 },
      ],
    });

    // Event still emitted despite ingest failure
    expect(onMessage).toHaveBeenCalledTimes(1);
    mockFetch.mockRestore();
  });
});

describe("DiscordAdapter sendMessage with attachments", () => {
  it("sends eligible files in batches, prepends text chunks before last, and returns first batch message ID", async () => {
    fsOverrides.readFileSync = () => Buffer.from("file-content");
    const adapter = makeAdapter();
    const sentMessages: Array<{ id: string }> = [];
    let callCount = 0;
    const mockChannel = {
      send: vi.fn().mockImplementation(async () => {
        callCount++;
        const msg = { id: `sent-${callCount}` };
        sentMessages.push(msg);
        return msg;
      }),
    };
    (adapter as unknown as { client: { channels: { fetch: (id: string) => Promise<unknown> } } }).client.channels = {
      fetch: vi.fn().mockResolvedValue(mockChannel),
    };

    const result = await adapter.sendMessage({
      channel: "CH1",
      text: "short text",
      attachments: [
        makeOutboundAttachment({ id: "a1", originalFilename: "a1.png", sizeBytes: 100, mimeType: "image/png" }),
        makeOutboundAttachment({ id: "a2", originalFilename: "a2.png", sizeBytes: 200, mimeType: "image/png" }),
      ],
    });

    // 1 send call for the combined (text + files) batch
    expect(mockChannel.send).toHaveBeenCalledTimes(1);
    // First batch should include the text as content
    const firstCall = mockChannel.send.mock.calls[0][0] as { content: string; files: unknown[] };
    expect(firstCall).toMatchObject({ content: "short text" });
    expect(firstCall.files).toHaveLength(2);
    expect(result.messageId).toBe("sent-1");
    fsOverrides.readFileSync = undefined;
  });

  it("splits long text into pre-chunks and combines last chunk with files", async () => {
    fsOverrides.readFileSync = () => Buffer.from("file-content");
    const adapter = makeAdapter();
    let callCount = 0;
    const mockChannel = {
      send: vi.fn().mockImplementation(async () => {
        callCount++;
        return { id: `sent-${callCount}` };
      }),
    };
    (adapter as unknown as { client: { channels: { fetch: (id: string) => Promise<unknown> } } }).client.channels = {
      fetch: vi.fn().mockResolvedValue(mockChannel),
    };

    const longText = "a".repeat(2001); // triggers chunking at 2000
    await adapter.sendMessage({
      channel: "CH1",
      text: longText,
      attachments: [
        makeOutboundAttachment({ id: "a1", originalFilename: "a1.png", sizeBytes: 100, mimeType: "image/png" }),
      ],
    });

    // At least 2 calls: one for the pre-chunk, one for (last chunk + file)
    expect(mockChannel.send.mock.calls.length).toBeGreaterThanOrEqual(2);
    fsOverrides.readFileSync = undefined;
  });

  it("notifies about oversized attachments that exceed 10 MB", async () => {
    fsOverrides.readFileSync = () => Buffer.from("file-content");
    const adapter = makeAdapter();
    let callCount = 0;
    const mockChannel = {
      send: vi.fn().mockImplementation(async (arg: unknown) => {
        callCount++;
        return { id: `sent-${callCount}`, arg };
      }),
    };
    (adapter as unknown as { client: { channels: { fetch: (id: string) => Promise<unknown> } } }).client.channels = {
      fetch: vi.fn().mockResolvedValue(mockChannel),
    };

    const oversizedBytes = 10 * 1024 * 1024 + 1;
    await adapter.sendMessage({
      channel: "CH1",
      text: "check this",
      attachments: [
        makeOutboundAttachment({ id: "big", originalFilename: "huge.bin", sizeBytes: oversizedBytes, mimeType: "application/octet-stream" }),
      ],
    });

    // Should see the "[File too large for Discord DM...]" notification
    const calls = mockChannel.send.mock.calls.map((c) => c[0]);
    const oversizedNotification = calls.find(
      (c) => typeof c === "string" && c.includes("File too large for Discord DM"),
    );
    expect(oversizedNotification).toBeDefined();
    fsOverrides.readFileSync = undefined;
  });

  it("sends only the text as last chunk when all attachments are oversized (no eligible files)", async () => {
    const adapter = makeAdapter();
    let callCount = 0;
    const mockChannel = {
      send: vi.fn().mockImplementation(async () => {
        callCount++;
        return { id: `sent-${callCount}` };
      }),
    };
    (adapter as unknown as { client: { channels: { fetch: (id: string) => Promise<unknown> } } }).client.channels = {
      fetch: vi.fn().mockResolvedValue(mockChannel),
    };

    const oversizedBytes = 10 * 1024 * 1024 + 1;
    const result = await adapter.sendMessage({
      channel: "CH1",
      text: "the last chunk text",
      attachments: [
        makeOutboundAttachment({ id: "big", originalFilename: "huge.bin", sizeBytes: oversizedBytes, mimeType: "application/octet-stream" }),
      ],
    });

    // Should have: 1 oversized notification + 1 text-only fallback
    const calls = mockChannel.send.mock.calls.map((c) => c[0]);
    const textChunk = calls.find((c) => c === "the last chunk text");
    expect(textChunk).toBeDefined();
    expect(result.messageId).toBeDefined();
  });

  it("returns undefined messageId when all attachments are oversized and text is empty", async () => {
    const adapter = makeAdapter();
    const mockChannel = {
      send: vi.fn().mockResolvedValue({ id: "oversized-notif" }),
    };
    (adapter as unknown as { client: { channels: { fetch: (id: string) => Promise<unknown> } } }).client.channels = {
      fetch: vi.fn().mockResolvedValue(mockChannel),
    };

    const oversizedBytes = 10 * 1024 * 1024 + 1;
    const result = await adapter.sendMessage({
      channel: "CH1",
      text: "", // empty — no lastChunk to send
      attachments: [
        makeOutboundAttachment({ id: "big", originalFilename: "huge.bin", sizeBytes: oversizedBytes, mimeType: "application/octet-stream" }),
      ],
    });

    // No eligible files, text is empty — messageId stays undefined
    expect(result.messageId).toBeUndefined();
  });

  it("sends second batch without text content (i > 0 branch, content = '')", async () => {
    fsOverrides.readFileSync = () => Buffer.from("file-content");
    const adapter = makeAdapter();
    let callCount = 0;
    const mockChannel = {
      send: vi.fn().mockImplementation(async () => {
        callCount++;
        return { id: `sent-${callCount}` };
      }),
    };
    (adapter as unknown as { client: { channels: { fetch: (id: string) => Promise<unknown> } } }).client.channels = {
      fetch: vi.fn().mockResolvedValue(mockChannel),
    };

    // 11 eligible attachments — triggers 2 batches (batch 0: i=0 with text, batch 1: i=10 without text)
    const attachments = Array.from({ length: 11 }, (_, idx) =>
      makeOutboundAttachment({ id: `a${idx}`, originalFilename: `file${idx}.png`, sizeBytes: 100, mimeType: "image/png" }),
    );

    const result = await adapter.sendMessage({
      channel: "CH1",
      text: "with 11 files",
      attachments,
    });

    // 2 batch sends (i=0 and i=10)
    expect(mockChannel.send.mock.calls.length).toBeGreaterThanOrEqual(2);
    // First batch (i=0): content is the text
    const firstBatch = mockChannel.send.mock.calls[0][0] as { content: string; files: unknown[] };
    expect(firstBatch.content).toBe("with 11 files");
    // Second batch (i=10): no content field (sent as { files: builders })
    const secondBatch = mockChannel.send.mock.calls[1][0] as { files: unknown[]; content?: string };
    expect(secondBatch.content).toBeUndefined();
    expect(result.messageId).toBe("sent-1"); // only first batch sets lastMessageId

    fsOverrides.readFileSync = undefined;
  });

  it("only sets lastMessageId from i===0 batch (subsequent batches don't overwrite)", async () => {
    fsOverrides.readFileSync = () => Buffer.from("file-content");
    const adapter = makeAdapter();
    let callCount = 0;
    const mockChannel = {
      send: vi.fn().mockImplementation(async () => {
        callCount++;
        return { id: `sent-${callCount}` };
      }),
    };
    (adapter as unknown as { client: { channels: { fetch: (id: string) => Promise<unknown> } } }).client.channels = {
      fetch: vi.fn().mockResolvedValue(mockChannel),
    };

    const attachments = Array.from({ length: 20 }, (_, idx) =>
      makeOutboundAttachment({ id: `a${idx}`, originalFilename: `file${idx}.png`, sizeBytes: 100, mimeType: "image/png" }),
    );

    const result = await adapter.sendMessage({
      channel: "CH1",
      text: "lots of files",
      attachments,
    });

    // 2 batches (i=0 and i=10), but lastMessageId is from i=0 only
    expect(result.messageId).toBe("sent-1");
    fsOverrides.readFileSync = undefined;
  });
});

describe("DiscordAdapter sendMessage lastChunk ?? '' defensive branch", () => {
  it("uses empty string when splitOutboundText returns empty array (defensive ?? '' branch)", async () => {
    // Force splitOutboundText to return [] to trigger the ?? '' null branch at line 285.
    vi.doMock("./outbound-text.js", async () => {
      const actual = await vi.importActual<typeof import("./outbound-text.js")>("./outbound-text.js");
      return { ...actual, splitOutboundText: vi.fn().mockReturnValue([]) };
    });
    vi.resetModules();

    const { DiscordAdapter: FreshDiscord } = await import("./discord.js");
    const adapter = new FreshDiscord({
      botToken: "fake",
      ownerUserId: null,
      onMessage: vi.fn(),
    });

    let callCount = 0;
    const mockChannel = {
      send: vi.fn().mockImplementation(async () => {
        callCount++;
        return { id: `sent-${callCount}` };
      }),
    };
    (adapter as unknown as { client: { channels: { fetch: (id: string) => Promise<unknown> } } }).client.channels = {
      fetch: vi.fn().mockResolvedValue(mockChannel),
    };

    fsOverrides.readFileSync = () => Buffer.from("data");
    await adapter.sendMessage({
      channel: "CH1",
      text: "some text",
      attachments: [makeOutboundAttachment()],
    });

    // With empty chunks, only eligible files loop runs; no error
    fsOverrides.readFileSync = undefined;
    vi.doUnmock("./outbound-text.js");
    vi.resetModules();
  });
});

describe("DiscordAdapter handleRawMessage content ?? '' branch", () => {
  it("treats undefined content as empty string (the ?? '' null branch)", async () => {
    const onMessage = vi.fn();
    const adapter = new DiscordAdapter({
      botToken: "fake",
      ownerUserId: "U_OWNER",
      onMessage,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";

    await (adapter as unknown as { handleRawMessage: (msg: unknown) => Promise<void> }).handleRawMessage({
      author: { id: "U_OWNER", bot: false },
      channel_type: 1,
      channel_id: "DM_CH",
      mentions: [],
      // content is absent → exercises the ?? "" right branch
      id: "msg-no-content",
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].content).toBe("");
  });
});

describe("DiscordAdapter getConnectionState (watchdog probe)", () => {
  type Internals = {
    client: { isReady: () => boolean };
    startCompleted: boolean;
    sessionInvalidated: boolean;
  };

  it("reports unknown before start() completes", () => {
    const adapter = makeAdapter();
    expect(adapter.getConnectionState()).toBe("unknown");
  });

  it("mirrors client.isReady() once started", () => {
    const adapter = makeAdapter();
    const internals = adapter as unknown as Internals;
    internals.startCompleted = true;

    internals.client = { isReady: () => true };
    expect(adapter.getConnectionState()).toBe("ok");

    internals.client = { isReady: () => false };
    expect(adapter.getConnectionState()).toBe("down");
  });

  it("reports down on an invalidated session even when the client claims ready", () => {
    const adapter = makeAdapter();
    const internals = adapter as unknown as Internals;
    internals.startCompleted = true;
    internals.client = { isReady: () => true };
    internals.sessionInvalidated = true;
    expect(adapter.getConnectionState()).toBe("down");
  });
});
