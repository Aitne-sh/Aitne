import { describe, it, expect, vi } from "vitest";
import type { Event } from "@aitne/shared";
import { TelegramAdapter } from "./telegram-adapter.js";
import type { AttachmentStore } from "../services/attachments/store.js";

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

/**
 * Telegram adapter unit tests for the Phase-2 pairing flows.
 *
 * We never load the real telegraf module here — we exercise the private
 * `handleMessage` directly with a fake telegraf-shaped ctx and observe
 * whether the `onOwnerDetected` callback fires per the discovery rules.
 */

function makeAdapter(opts: {
  ownerChatId?: string | null;
  onOwnerDetected?: (id: string) => void;
} = {}) {
  return new TelegramAdapter({
    botToken: "fake:token",
    ownerChatId: opts.ownerChatId ?? null,
    onMessage: vi.fn(),
    onOwnerDetected: opts.onOwnerDetected,
  });
}

function fakeCtx(chatId: string, text: string, fromId = "999") {
  // The adapter coerces both .from.id and .chat.id with String(...) before
  // comparing — feeding the values in directly as strings keeps the test
  // round-trip clean (Number("CHAT2") would become NaN otherwise).
  return {
    message: {
      message_id: 1,
      from: { id: fromId },
      chat: { id: chatId, type: "private" },
      text,
    },
  };
}

function fakeGroupCtx(chatId: string, text: string, fromId = "999") {
  return {
    message: {
      message_id: 1,
      from: { id: fromId },
      chat: { id: chatId, type: "group" },
      text,
    },
  };
}

function fakeAttachmentStore() {
  return {
    ingestStream: vi.fn().mockImplementation(async (params: { originalFilename: string; declaredMimeType: string | null; maxSizeBytes: number }) => ({
      id: "att-1",
      path: `/tmp/${params.originalFilename}`,
      originalFilename: params.originalFilename,
      safeFilename: params.originalFilename,
      mimeType: params.declaredMimeType ?? "application/octet-stream",
      sizeBytes: 12,
    })),
  } as unknown as AttachmentStore;
}

/**
 * Mirror the matcher built by `buildTelegramControls.startPairing` exactly,
 * including the case-insensitive prefix and case-sensitive token rules.
 * The two implementations must stay in sync — if you change the daemon-
 * side matcher, change this one too.
 */
function startMatcher(token: string, botUsername = "TestBot"): (text: string) => boolean {
  const escapedUsername = botUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefixRe = new RegExp(`^/start(?:@${escapedUsername})?\\s+`, "i");
  return (text: string) => {
    const trimmed = text.trim();
    const prefixMatch = trimmed.match(prefixRe);
    if (!prefixMatch) return false;
    const remainder = trimmed.slice(prefixMatch[0].length);
    return remainder === token;
  };
}

// Inline tests for the matcher itself, separate from the adapter wiring.
describe("Telegram start-token matcher", () => {
  it("accepts the canonical /start <token> form", () => {
    const m = startMatcher("ABCxyz123");
    expect(m("/start ABCxyz123")).toBe(true);
  });

  it("accepts /start@<bot> <token> case-insensitively on the prefix", () => {
    // H1 regression: previous matcher compared the bot username
    // case-sensitively, so /start@mybot would fail when info.username
    // was set to "MyBot".
    const m = startMatcher("ABCxyz123", "MyBot");
    expect(m("/start@MyBot ABCxyz123")).toBe(true);
    expect(m("/start@mybot ABCxyz123")).toBe(true);
    expect(m("/Start@MYBOT ABCxyz123")).toBe(true);
  });

  it("compares the token CASE-SENSITIVELY to preserve base64url entropy", () => {
    const m = startMatcher("ABCxyz123");
    // Lowercased token must NOT match — that would halve the search
    // space (effectively dropping ~16 bits).
    expect(m("/start abcxyz123")).toBe(false);
    expect(m("/START ABCXYZ123")).toBe(false);
  });

  it("rejects extra arguments after the token", () => {
    const m = startMatcher("ABCxyz123");
    expect(m("/start ABCxyz123 extra")).toBe(false);
    expect(m("/start ABCxyz123\nmore")).toBe(false);
  });

  it("rejects when the wrong bot username is mentioned", () => {
    const m = startMatcher("ABCxyz123", "MyBot");
    expect(m("/start@OtherBot ABCxyz123")).toBe(false);
  });

  it("rejects messages that don't start with /start", () => {
    const m = startMatcher("ABCxyz123");
    expect(m("hello /start ABCxyz123")).toBe(false);
    expect(m("ABCxyz123")).toBe(false);
  });
});

describe("TelegramAdapter challenge-based pairing", () => {
  it("emits an owner private chat as a DM event", () => {
    const onMessage = vi.fn();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
    });

    (adapter as unknown as { handleMessage: (ctx: unknown) => void }).handleMessage(
      fakeCtx("CHAT1", "hello", "USER1"),
    );

    expect(onMessage).toHaveBeenCalledTimes(1);
    const event = onMessage.mock.calls[0][0] as Event & {
      sender: string;
      channel: string;
      content: string;
      platform: string;
      threadId: string | null;
      isDm: boolean;
      isMention: boolean;
    };
    expect(event.sender).toBe("USER1");
    expect(event.channel).toBe("CHAT1");
    expect(event.content).toBe("hello");
    expect(event.platform).toBe("telegram");
    expect(event.threadId).toBeNull();
    expect(event.isDm).toBe(true);
    expect(event.isMention).toBe(false);
  });

  it("ingests owner voice messages as attachments", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });
    const sendMessage = vi.fn();
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: {
        getFile: vi.fn().mockResolvedValue({ file_path: "voice.ogg" }),
        sendMessage,
      },
    };
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        voice: {
          file_id: "voice-file",
          mime_type: "audio/ogg",
          file_size: 3,
        },
      },
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(store.ingestStream).toHaveBeenCalledWith(
      expect.objectContaining({
        declaredMimeType: "audio/ogg",
        originalFilename: "voice.ogg",
      }),
    );
    expect(onMessage).toHaveBeenCalledTimes(1);
    const event = onMessage.mock.calls[0][0] as Event & { attachments?: unknown[] };
    expect(event.attachments).toHaveLength(1);
    mockFetch.mockRestore();
  });

  it("ingests owner video messages as attachments", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });
    const sendMessage = vi.fn();
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: {
        getFile: vi.fn().mockResolvedValue({ file_path: "video.mp4" }),
        sendMessage,
      },
    };
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        video: {
          file_id: "video-file",
          mime_type: "video/mp4",
          file_name: "clip.mp4",
          file_size: 3,
        },
      },
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(store.ingestStream).toHaveBeenCalledWith(
      expect.objectContaining({
        declaredMimeType: "video/mp4",
        originalFilename: "clip.mp4",
      }),
    );
    expect(onMessage).toHaveBeenCalledTimes(1);
    const event = onMessage.mock.calls[0][0] as Event & { attachments?: unknown[] };
    expect(event.attachments).toHaveLength(1);
    mockFetch.mockRestore();
  });

  it("ignores owner stickers without sending an unsupported-media reply", async () => {
    const onMessage = vi.fn();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
    });
    const sendMessage = vi.fn();
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: { sendMessage },
    };

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        sticker: { file_id: "sticker-file" },
      },
    });

    expect(onMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("ignores group chats entirely", () => {
    const onMessage = vi.fn();
    const onOwnerDetected = vi.fn();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      onOwnerDetected,
    });
    adapter.startPairing({
      match: startMatcher("ABCDEFGHIJ"),
      expiresAt: Date.now() + 60_000,
    });

    (adapter as unknown as { handleMessage: (ctx: unknown) => void }).handleMessage(
      fakeGroupCtx("GROUP1", "/start ABCDEFGHIJ", "USER1"),
    );

    expect(onMessage).not.toHaveBeenCalled();
    expect(onOwnerDetected).not.toHaveBeenCalled();
  });

  it("captures owner only when the matcher accepts the message text", () => {
    const onOwnerDetected = vi.fn();
    const adapter = makeAdapter({ onOwnerDetected });
    adapter.startPairing({
      match: startMatcher("ABCDEFGHIJ"),
      expiresAt: Date.now() + 60_000,
    });

    // Wrong token — dropped, no capture.
    (adapter as unknown as { handleMessage: (ctx: unknown) => void }).handleMessage(
      fakeCtx("CHAT1", "/start WRONG"),
    );
    expect(onOwnerDetected).not.toHaveBeenCalled();
    expect(adapter.getOwnerChatId()).toBeNull();

    // Plain "hi" — also dropped (this is the regression test for CRITICAL #1:
    // the previous combined discovery+token implementation captured ANY
    // first DM during the window).
    (adapter as unknown as { handleMessage: (ctx: unknown) => void }).handleMessage(
      fakeCtx("CHAT_INTRUDER", "hi"),
    );
    expect(onOwnerDetected).not.toHaveBeenCalled();
    expect(adapter.getOwnerChatId()).toBeNull();

    // Right token — captures.
    (adapter as unknown as { handleMessage: (ctx: unknown) => void }).handleMessage(
      fakeCtx("CHAT2", "/start ABCDEFGHIJ"),
    );
    expect(onOwnerDetected).toHaveBeenCalledWith("CHAT2");
    expect(adapter.getOwnerChatId()).toBe("CHAT2");
  });

  it("clears the challenge after a successful match (one-shot)", async () => {
    const onOwnerDetected = vi.fn();
    const adapter = makeAdapter({ onOwnerDetected });
    adapter.startPairing({
      match: startMatcher("XYZ"),
      expiresAt: Date.now() + 60_000,
    });

    // handleMessage is async (B-1: must await captureOwner so cancelPairing
    // fires only after the env/DB persist completes). Awaiting here lets
    // the cancelPairing call land before we assert pairing inactivity.
    await (adapter as unknown as {
      handleMessage: (ctx: unknown) => Promise<void>;
    }).handleMessage(fakeCtx("CHAT", "/start XYZ"));
    expect(onOwnerDetected).toHaveBeenCalledTimes(1);
    expect(adapter.isPairingActive()).toBe(false);

    // Replaying the same payload from a different chat is now blocked by
    // the strict owner filter (owner is "CHAT", sender is "OTHER").
    onOwnerDetected.mockClear();
    await (adapter as unknown as {
      handleMessage: (ctx: unknown) => Promise<void>;
    }).handleMessage(fakeCtx("OTHER", "/start XYZ"));
    expect(onOwnerDetected).not.toHaveBeenCalled();
  });

  it("does NOT capture when no challenge is registered", () => {
    const onOwnerDetected = vi.fn();
    const adapter = makeAdapter({ onOwnerDetected });

    (adapter as unknown as { handleMessage: (ctx: unknown) => void }).handleMessage(
      fakeCtx("12345", "/start anything"),
    );

    expect(onOwnerDetected).not.toHaveBeenCalled();
    expect(adapter.getOwnerChatId()).toBeNull();
    expect(adapter.isPairingActive()).toBe(false);
  });

  it("does NOT capture from a stranger when an owner is already set", () => {
    const onOwnerDetected = vi.fn();
    const adapter = makeAdapter({
      ownerChatId: "AUTHORIZED",
      onOwnerDetected,
    });
    adapter.startPairing({
      match: startMatcher("XYZ"),
      expiresAt: Date.now() + 60_000,
    });

    (adapter as unknown as { handleMessage: (ctx: unknown) => void }).handleMessage(
      fakeCtx("STRANGER", "hi"),
    );

    expect(onOwnerDetected).not.toHaveBeenCalled();
    expect(adapter.getOwnerChatId()).toBe("AUTHORIZED");
  });

  it("respects the challenge expiry timestamp", () => {
    const onOwnerDetected = vi.fn();
    const adapter = makeAdapter({ onOwnerDetected });
    adapter.startPairing({
      match: startMatcher("EXPIRED"),
      expiresAt: Date.now() - 1, // already expired
    });

    expect(adapter.isPairingActive()).toBe(false);
    (adapter as unknown as { handleMessage: (ctx: unknown) => void }).handleMessage(
      fakeCtx("CHAT", "/start EXPIRED"),
    );
    expect(onOwnerDetected).not.toHaveBeenCalled();
  });

  // H2 regression: the captured pairing payload (`/start <token>`) must
  // NOT be emitted to the agent EventBus. Previously the adapter "fell
  // through" after capture, so the agent burned an inference on the
  // base64 token string and the user got a confused reply on top of the
  // welcome DM.
  it("does NOT emit the captured /start message to onMessage (H2 regression)", () => {
    const onMessage = vi.fn();
    const onOwnerDetected = vi.fn();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: null,
      onMessage,
      onOwnerDetected,
    });
    adapter.startPairing({
      match: startMatcher("ABCDEFGHIJ"),
      expiresAt: Date.now() + 60_000,
    });

    (adapter as unknown as { handleMessage: (ctx: unknown) => void }).handleMessage(
      fakeCtx("CHAT", "/start ABCDEFGHIJ"),
    );

    expect(onOwnerDetected).toHaveBeenCalledTimes(1);
    expect(onMessage).not.toHaveBeenCalled();
  });
});

// ── Coverage gap fill: sendMessage, resolveUserChannel, fetchBotInfo, etc. ──

describe("TelegramAdapter sendMessage", () => {
  it("sends a message via the telegram bot", async () => {
    const adapter = makeAdapter({ ownerChatId: "CHAT1" });
    const mockBot = {
      telegram: {
        sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
      },
    };
    (adapter as unknown as { bot: unknown }).bot = mockBot;

    const result = await adapter.sendMessage({
      channel: "CHAT1",
      text: "hello",
    });

    expect(mockBot.telegram.sendMessage).toHaveBeenCalledWith(
      "CHAT1",
      "hello",
      {},
    );
    expect(result.messageId).toBe("42");
  });

  it("sends with reply_parameters when threadId is provided", async () => {
    const adapter = makeAdapter({ ownerChatId: "CHAT1" });
    const mockBot = {
      telegram: {
        sendMessage: vi.fn().mockResolvedValue({ message_id: 43 }),
      },
    };
    (adapter as unknown as { bot: unknown }).bot = mockBot;

    const result = await adapter.sendMessage({
      channel: "CHAT1",
      text: "reply",
      threadId: "10",
    });

    expect(mockBot.telegram.sendMessage).toHaveBeenCalledWith(
      "CHAT1",
      "reply",
      { reply_parameters: { message_id: 10 } },
    );
    expect(result.messageId).toBe("43");
  });

  it("throws when bot is not started", async () => {
    const adapter = makeAdapter();

    await expect(
      adapter.sendMessage({ channel: "CHAT1", text: "hi" }),
    ).rejects.toThrow("Telegram bot not started");
  });

  it("propagates errors from telegram.sendMessage", async () => {
    const adapter = makeAdapter();
    const mockBot = {
      telegram: {
        sendMessage: vi.fn().mockRejectedValue(new Error("chat not found")),
      },
    };
    (adapter as unknown as { bot: unknown }).bot = mockBot;

    await expect(
      adapter.sendMessage({ channel: "CHAT1", text: "hi" }),
    ).rejects.toThrow("chat not found");
  });

  it("handles undefined message_id in response", async () => {
    const adapter = makeAdapter({ ownerChatId: "CHAT1" });
    const mockBot = {
      telegram: {
        sendMessage: vi.fn().mockResolvedValue({}),
      },
    };
    (adapter as unknown as { bot: unknown }).bot = mockBot;

    const result = await adapter.sendMessage({
      channel: "CHAT1",
      text: "hello",
    });
    expect(result.messageId).toBeUndefined();
  });
});

describe("TelegramAdapter resolveUserChannel", () => {
  it("returns the owner chat ID", async () => {
    const adapter = makeAdapter({ ownerChatId: "CHAT_OWNER" });
    const result = await adapter.resolveUserChannel();
    expect(result).toBe("CHAT_OWNER");
  });

  it("returns null when no owner is configured", async () => {
    const adapter = makeAdapter({ ownerChatId: null });
    const result = await adapter.resolveUserChannel();
    expect(result).toBeNull();
  });
});

describe("TelegramAdapter captureOwner error handling", () => {
  // B-1 regression: a failing onOwnerDetected (env unwritable etc.) must
  // roll back mutableOwnerId AND keep the matcher armed so the user can
  // retry. See slack-adapter.test for the full rationale.
  it("rolls back mutableOwnerId on synchronous throw in onOwnerDetected", async () => {
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: null,
      onMessage: vi.fn(),
      onOwnerDetected: () => {
        throw new Error("sync fail");
      },
    });
    adapter.startPairing({
      match: startMatcher("TOKEN"),
      expiresAt: Date.now() + 60_000,
    });

    await (adapter as unknown as {
      handleMessage: (ctx: unknown) => Promise<void>;
    }).handleMessage(fakeCtx("CHAT", "/start TOKEN"));

    expect(adapter.getOwnerChatId()).toBeNull();
    expect(adapter.isPairingActive()).toBe(true);
  });

  it("rolls back mutableOwnerId on async rejection in onOwnerDetected", async () => {
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: null,
      onMessage: vi.fn(),
      onOwnerDetected: async () => {
        throw new Error("async fail");
      },
    });
    adapter.startPairing({
      match: startMatcher("TOKEN"),
      expiresAt: Date.now() + 60_000,
    });

    await (adapter as unknown as {
      handleMessage: (ctx: unknown) => Promise<void>;
    }).handleMessage(fakeCtx("CHAT", "/start TOKEN"));

    expect(adapter.getOwnerChatId()).toBeNull();
    expect(adapter.isPairingActive()).toBe(true);
  });

  it("captures owner and cancels pairing when no onOwnerDetected callback supplied", async () => {
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: null,
      onMessage: vi.fn(),
    });
    adapter.startPairing({
      match: startMatcher("TOKEN"),
      expiresAt: Date.now() + 60_000,
    });

    await (adapter as unknown as {
      handleMessage: (ctx: unknown) => Promise<void>;
    }).handleMessage(fakeCtx("CHAT", "/start TOKEN"));

    expect(adapter.getOwnerChatId()).toBe("CHAT");
    expect(adapter.isPairingActive()).toBe(false);
  });
});

describe("TelegramAdapter handleMessage edge cases", () => {
  it("extracts threadId from reply_to_message", () => {
    const onMessage = vi.fn();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
    });

    const ctx = {
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        text: "replying",
        reply_to_message: { message_id: 99 },
      },
    };
    (adapter as unknown as { handleMessage: (ctx: unknown) => void }).handleMessage(ctx);

    expect(onMessage).toHaveBeenCalledTimes(1);
    const event = onMessage.mock.calls[0][0];
    expect(event.threadId).toBe("99");
  });

  it("drops messages without text", () => {
    const onMessage = vi.fn();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
    });

    const ctx = {
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        text: undefined,
      },
    };
    (adapter as unknown as { handleMessage: (ctx: unknown) => void }).handleMessage(ctx);

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("drops messages without a message object", () => {
    const onMessage = vi.fn();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
    });

    (adapter as unknown as { handleMessage: (ctx: unknown) => void }).handleMessage({});

    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe("TelegramAdapter.fetchBotInfo (static)", () => {
  it("returns bot info on success", async () => {
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          result: { id: 123, username: "TestBot", first_name: "Test" },
        }),
        { status: 200 },
      ),
    );

    const info = await TelegramAdapter.fetchBotInfo("fake:token");
    expect(info.id).toBe(123);
    expect(info.username).toBe("TestBot");
    expect(info.firstName).toBe("Test");
    mockFetch.mockRestore();
  });

  it("throws on HTTP error", async () => {
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", { status: 401, statusText: "Unauthorized" }),
    );

    await expect(TelegramAdapter.fetchBotInfo("bad:token")).rejects.toThrow(
      "Telegram getMe failed: 401",
    );
    mockFetch.mockRestore();
  });

  it("throws when body.ok is false", async () => {
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: false, description: "Unauthorized" }),
        { status: 200 },
      ),
    );

    await expect(TelegramAdapter.fetchBotInfo("bad:token")).rejects.toThrow(
      "Unauthorized",
    );
    mockFetch.mockRestore();
  });

  it("handles missing result", async () => {
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: false }),
        { status: 200 },
      ),
    );

    await expect(TelegramAdapter.fetchBotInfo("bad:token")).rejects.toThrow(
      "Telegram getMe returned ok=false",
    );
    mockFetch.mockRestore();
  });

  it("returns null for missing optional fields", async () => {
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          result: { id: 456 },
        }),
        { status: 200 },
      ),
    );

    const info = await TelegramAdapter.fetchBotInfo("fake:token");
    expect(info.id).toBe(456);
    expect(info.username).toBeNull();
    expect(info.firstName).toBeNull();
    mockFetch.mockRestore();
  });

  it("setOwnerChatId / getOwnerChatId round-trips", () => {
    const adapter = makeAdapter();
    expect(adapter.getOwnerChatId()).toBeNull();
    adapter.setOwnerChatId("CHAT_NEW");
    expect(adapter.getOwnerChatId()).toBe("CHAT_NEW");
    adapter.setOwnerChatId(null);
    expect(adapter.getOwnerChatId()).toBeNull();
  });

  it("getBotInfo returns null before start", () => {
    const adapter = makeAdapter();
    expect(adapter.getBotInfo()).toBeNull();
  });
});

// ── New coverage gap tests ─────────────────────────────────────────────────

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

describe("TelegramAdapter stop()", () => {
  it("is a no-op when bot is null", async () => {
    const adapter = makeAdapter();
    // bot is null by default
    await expect(adapter.stop()).resolves.not.toThrow();
  });

  it("stops bot and clears pending media-group timers", async () => {
    const adapter = makeAdapter();
    const mockStop = vi.fn();
    (adapter as unknown as { bot: { stop: typeof mockStop } }).bot = { stop: mockStop };

    // Inject a pending media group buffer with a fake timer
    const fakeTimer = { id: 99 };
    (adapter as unknown as { mediaGroupBuffers: Map<string, unknown> }).mediaGroupBuffers.set(
      "group-1",
      { items: [], caption: null, channelId: "C1", senderId: "U1", chatType: "private", isDm: true, timer: fakeTimer },
    );

    await adapter.stop();

    expect(mockStop).toHaveBeenCalledWith("SIGTERM");
    expect((adapter as unknown as { bot: unknown }).bot).toBeNull();
    expect((adapter as unknown as { mediaGroupBuffers: Map<string, unknown> }).mediaGroupBuffers.size).toBe(0);
  });
});

describe("TelegramAdapter start() dynamic import paths", () => {
  it("throws a helpful error when telegraf cannot be imported", async () => {
    vi.doMock("telegraf", () => { throw new Error("MODULE_NOT_FOUND"); });
    vi.resetModules();

    const { TelegramAdapter: FreshTelegram } = await import("./telegram-adapter.js");
    const adapter = new FreshTelegram({
      botToken: "fake:token",
      ownerChatId: null,
      onMessage: vi.fn(),
    });

    await expect(adapter.start()).rejects.toThrow("telegraf not installed");

    vi.doUnmock("telegraf");
    vi.resetModules();
  });

  it("happy path: creates Telegraf, registers handler, calls bot.launch", async () => {
    // Capture the "message" handler so we can invoke it to cover lines 215-217.
    let capturedMessageHandler: ((ctx: unknown) => Promise<void>) | null = null;
    const mockOn = vi.fn().mockImplementation((event: string, handler: (ctx: unknown) => Promise<void>) => {
      if (event === "message") capturedMessageHandler = handler;
    });
    const mockLaunch = vi.fn();
    vi.doMock("telegraf", () => ({
      Telegraf: vi.fn().mockImplementation(() => ({
        on: mockOn,
        launch: mockLaunch,
        stop: vi.fn(),
        telegram: { getFile: vi.fn(), sendMessage: vi.fn(), sendPhoto: vi.fn(), sendDocument: vi.fn() },
      })),
    }));
    vi.resetModules();

    const { TelegramAdapter: FreshTelegram } = await import("./telegram-adapter.js");
    const fetchInfoSpy = vi
      .spyOn(FreshTelegram, "fetchBotInfo")
      .mockResolvedValue({ id: 123, username: "TestBot", firstName: "Test" });

    const onMessage = vi.fn();
    const adapter = new FreshTelegram({
      botToken: "fake:token",
      ownerChatId: "CHAT_OWNER",
      onMessage,
    });

    await adapter.start();

    expect(mockOn).toHaveBeenCalledWith("message", expect.any(Function));
    expect(mockLaunch).toHaveBeenCalledWith({ dropPendingUpdates: true });

    // Invoke the registered handler to cover lines 215-217 (the lambda body).
    expect(capturedMessageHandler).not.toBeNull();
    await capturedMessageHandler!({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT_OWNER", type: "private" },
        text: "hello from handler",
      },
    });
    expect(onMessage).toHaveBeenCalledTimes(1);

    fetchInfoSpy.mockRestore();
    vi.doUnmock("telegraf");
    vi.resetModules();
  });

  it("the message handler .catch fires when handleMessage throws (covers line 216)", async () => {
    let capturedHandler: ((ctx: unknown) => Promise<void>) | null = null;
    const mockOn = vi.fn().mockImplementation((event: string, handler: (ctx: unknown) => Promise<void>) => {
      if (event === "message") capturedHandler = handler;
    });
    const mockLaunch = vi.fn();
    vi.doMock("telegraf", () => ({
      Telegraf: vi.fn().mockImplementation(() => ({
        on: mockOn,
        launch: mockLaunch,
        stop: vi.fn(),
        telegram: { getFile: vi.fn(), sendMessage: vi.fn(), sendPhoto: vi.fn(), sendDocument: vi.fn() },
      })),
    }));
    vi.resetModules();

    const { TelegramAdapter: FreshTelegram } = await import("./telegram-adapter.js");
    const fetchInfoSpy = vi
      .spyOn(FreshTelegram, "fetchBotInfo")
      .mockResolvedValue({ id: 123, username: "TestBot", firstName: "Test" });

    const adapter = new FreshTelegram({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage: vi.fn(),
    });

    await adapter.start();

    // Inject a handleMessage that throws to trigger the .catch
    (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage =
      vi.fn().mockRejectedValue(new Error("handler threw"));

    // Invoke the handler — the .catch should absorb the error
    expect(capturedHandler).not.toBeNull();
    await capturedHandler!({ message: { chat: { id: "CHAT1", type: "private" } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // No unhandled rejection = catch fired successfully

    fetchInfoSpy.mockRestore();
    vi.doUnmock("telegraf");
    vi.resetModules();
  });

  it("warns and continues when fetchBotInfo fails during start", async () => {
    const mockOn = vi.fn();
    const mockLaunch = vi.fn();
    vi.doMock("telegraf", () => ({
      Telegraf: vi.fn().mockImplementation(() => ({
        on: mockOn,
        launch: mockLaunch,
        stop: vi.fn(),
        telegram: { getFile: vi.fn(), sendMessage: vi.fn(), sendPhoto: vi.fn(), sendDocument: vi.fn() },
      })),
    }));
    vi.resetModules();

    const { TelegramAdapter: FreshTelegram } = await import("./telegram-adapter.js");
    const fetchInfoSpy = vi
      .spyOn(FreshTelegram, "fetchBotInfo")
      .mockRejectedValue(new Error("getMe failed"));

    const adapter = new FreshTelegram({
      botToken: "fake:token",
      ownerChatId: null,
      onMessage: vi.fn(),
    });

    await adapter.start();

    // Bot started despite fetchBotInfo failure
    expect(mockLaunch).toHaveBeenCalledTimes(1);
    expect(adapter.getBotInfo()).toBeNull();

    fetchInfoSpy.mockRestore();
    vi.doUnmock("telegraf");
    vi.resetModules();
  });
});

describe("TelegramAdapter sendMessage with attachments", () => {
  it("sends photo with caption for short text and image mimeType", async () => {
    fsOverrides.readFileSync = () => Buffer.from("img-data");
    const adapter = makeAdapter({ ownerChatId: "CHAT1" });
    const mockSendPhoto = vi.fn().mockResolvedValue({ message_id: 10 });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: { sendPhoto: mockSendPhoto, sendMessage: vi.fn(), sendDocument: vi.fn() },
    };

    const result = await adapter.sendMessage({
      channel: "CHAT1",
      text: "short caption",
      attachments: [makeOutboundAttachment({ mimeType: "image/jpeg", originalFilename: "photo.jpg" })],
    });

    expect(mockSendPhoto).toHaveBeenCalledTimes(1);
    const [chatId, source, opts] = mockSendPhoto.mock.calls[0];
    expect(chatId).toBe("CHAT1");
    expect(source).toMatchObject({ source: expect.any(Buffer) });
    expect(opts).toMatchObject({ caption: "short caption" });
    expect(result.messageId).toBe("10");

    fsOverrides.readFileSync = undefined;
  });

  it("sends document with caption for short text and non-image mimeType", async () => {
    fsOverrides.readFileSync = () => Buffer.from("doc-data");
    const adapter = makeAdapter({ ownerChatId: "CHAT1" });
    const mockSendDocument = vi.fn().mockResolvedValue({ message_id: 11 });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: { sendPhoto: vi.fn(), sendMessage: vi.fn(), sendDocument: mockSendDocument },
    };

    const result = await adapter.sendMessage({
      channel: "CHAT1",
      text: "here is a doc",
      attachments: [makeOutboundAttachment({ mimeType: "application/pdf", originalFilename: "doc.pdf" })],
    });

    expect(mockSendDocument).toHaveBeenCalledTimes(1);
    const [chatId, source, opts] = mockSendDocument.mock.calls[0];
    expect(chatId).toBe("CHAT1");
    expect(source).toMatchObject({ filename: "doc.pdf" });
    expect(opts).toMatchObject({ caption: "here is a doc" });
    expect(result.messageId).toBe("11");

    fsOverrides.readFileSync = undefined;
  });

  it("sends text as standalone message(s) first when text is too long for caption", async () => {
    fsOverrides.readFileSync = () => Buffer.from("img-data");
    const adapter = makeAdapter({ ownerChatId: "CHAT1" });
    const mockSendMessage = vi.fn().mockResolvedValue({ message_id: 5 });
    const mockSendPhoto = vi.fn().mockResolvedValue({ message_id: 6 });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: { sendMessage: mockSendMessage, sendPhoto: mockSendPhoto, sendDocument: vi.fn() },
    };

    const longText = "x".repeat(1025); // exceeds TELEGRAM_CAPTION_MAX_CHARS (1024)
    await adapter.sendMessage({
      channel: "CHAT1",
      text: longText,
      attachments: [makeOutboundAttachment({ mimeType: "image/png" })],
    });

    // Text sent first as standalone chunks, then photo without caption
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendPhoto).toHaveBeenCalledTimes(1);
    // Photo should have no caption (captionText is null)
    const photoOpts = mockSendPhoto.mock.calls[0][2];
    expect(photoOpts?.caption).toBeUndefined();

    fsOverrides.readFileSync = undefined;
  });

  it("catches and continues when sendPhoto throws", async () => {
    fsOverrides.readFileSync = () => Buffer.from("img-data");
    const adapter = makeAdapter({ ownerChatId: "CHAT1" });
    const mockSendPhoto = vi.fn().mockRejectedValue(new Error("telegram error"));
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: { sendPhoto: mockSendPhoto, sendMessage: vi.fn(), sendDocument: vi.fn() },
    };

    await expect(
      adapter.sendMessage({
        channel: "CHAT1",
        text: "short",
        attachments: [makeOutboundAttachment({ mimeType: "image/png" })],
      }),
    ).resolves.not.toThrow();

    fsOverrides.readFileSync = undefined;
  });

  it("catches and continues when sendDocument throws", async () => {
    fsOverrides.readFileSync = () => Buffer.from("doc-data");
    const adapter = makeAdapter({ ownerChatId: "CHAT1" });
    const mockSendDocument = vi.fn().mockRejectedValue(new Error("telegram error"));
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: { sendPhoto: vi.fn(), sendMessage: vi.fn(), sendDocument: mockSendDocument },
    };

    await expect(
      adapter.sendMessage({
        channel: "CHAT1",
        text: "here is a doc",
        attachments: [makeOutboundAttachment({ mimeType: "application/pdf" })],
      }),
    ).resolves.not.toThrow();

    fsOverrides.readFileSync = undefined;
  });
});

describe("TelegramAdapter handleMessage: photo routing", () => {
  it("emits text event with empty attachments when photo arrives and no attachmentStore", async () => {
    const onMessage = vi.fn();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
    });

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        photo: [{ file_id: "ph1", file_size: 100 }],
        caption: "nice photo",
      },
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    const event = onMessage.mock.calls[0][0];
    expect(event.content).toBe("nice photo");
    expect(event.attachments).toBeUndefined();
  });

  it("buffers photo with media_group_id when attachmentStore is present", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });

    const bufferSpy = vi.spyOn(
      adapter as unknown as { bufferMediaGroupItem: (...args: unknown[]) => Promise<void> },
      "bufferMediaGroupItem",
    );

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        photo: [{ file_id: "ph1", file_size: 100 }],
        caption: "album photo",
        media_group_id: "mg1",
      },
    });

    expect(bufferSpy).toHaveBeenCalledTimes(1);
    // Timer is pending — clean up
    for (const [, entry] of (adapter as unknown as { mediaGroupBuffers: Map<string, { timer: ReturnType<typeof setTimeout> }> }).mediaGroupBuffers) {
      clearTimeout(entry.timer);
    }
    (adapter as unknown as { mediaGroupBuffers: Map<string, unknown> }).mediaGroupBuffers.clear();
  });

  it("downloads photo directly when attachmentStore present and no media_group_id", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: {
        getFile: vi.fn().mockResolvedValue({ file_path: "photo.jpg" }),
      },
    };
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        photo: [{ file_id: "ph1", file_size: 100 }],
      },
    });

    expect(store.ingestStream).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
    mockFetch.mockRestore();
  });
});

describe("TelegramAdapter handleMessage: document routing", () => {
  it("emits text event with empty attachments when document arrives and no attachmentStore", async () => {
    const onMessage = vi.fn();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
    });

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        document: { file_id: "doc1", mime_type: "application/pdf", file_name: "test.pdf", file_size: 100 },
        caption: "attached doc",
      },
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    const event = onMessage.mock.calls[0][0];
    expect(event.content).toBe("attached doc");
    expect(event.attachments).toBeUndefined();
  });

  it("buffers document with media_group_id when attachmentStore is present", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        document: { file_id: "doc1", mime_type: "application/pdf", file_name: "test.pdf", file_size: 100 },
        media_group_id: "mg2",
      },
    });

    // Timer pending — clean up
    for (const [, entry] of (adapter as unknown as { mediaGroupBuffers: Map<string, { timer: ReturnType<typeof setTimeout> }> }).mediaGroupBuffers) {
      clearTimeout(entry.timer);
    }
    (adapter as unknown as { mediaGroupBuffers: Map<string, unknown> }).mediaGroupBuffers.clear();
  });

  it("downloads document directly when attachmentStore present and no media_group_id", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: {
        getFile: vi.fn().mockResolvedValue({ file_path: "test.pdf" }),
      },
    };
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        document: { file_id: "doc1", mime_type: "application/pdf", file_name: "test.pdf", file_size: 100 },
      },
    });

    expect(store.ingestStream).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
    mockFetch.mockRestore();
  });

  it("uses fallback filename when document has no file_name", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: {
        getFile: vi.fn().mockResolvedValue({ file_path: "unknown" }),
      },
    };
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        document: { file_id: "doc1" }, // no mime_type, no file_name, no file_size
      },
    });

    expect(store.ingestStream).toHaveBeenCalledWith(
      expect.objectContaining({ originalFilename: "file" }),
    );
    mockFetch.mockRestore();
  });
});

describe("TelegramAdapter handleMessage: audio/voice/video/video_note routing", () => {
  it("returns early (no event) when audio has no attachmentStore and no caption", async () => {
    const onMessage = vi.fn();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
    });

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        audio: { file_id: "a1", mime_type: "audio/mpeg", file_size: 100 },
        // no caption
      },
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("emits text event with audio caption when no attachmentStore but caption present", async () => {
    const onMessage = vi.fn();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
    });

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        audio: { file_id: "a1", mime_type: "audio/mpeg", file_size: 100 },
        caption: "listen to this",
      },
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].content).toBe("listen to this");
  });

  it("buffers audio with media_group_id", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        audio: { file_id: "a1", mime_type: "audio/mpeg", file_size: 100, file_name: "track.mp3" },
        media_group_id: "mg-audio",
      },
    });

    expect((adapter as unknown as { mediaGroupBuffers: Map<string, unknown> }).mediaGroupBuffers.size).toBe(1);
    // Clean up
    for (const [, entry] of (adapter as unknown as { mediaGroupBuffers: Map<string, { timer: ReturnType<typeof setTimeout> }> }).mediaGroupBuffers) {
      clearTimeout(entry.timer);
    }
    (adapter as unknown as { mediaGroupBuffers: Map<string, unknown> }).mediaGroupBuffers.clear();
  });

  it("buffers video with media_group_id", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        video: { file_id: "v1", mime_type: "video/mp4", file_name: "clip.mp4", file_size: 200 },
        media_group_id: "mg-video",
      },
    });

    expect((adapter as unknown as { mediaGroupBuffers: Map<string, unknown> }).mediaGroupBuffers.size).toBe(1);
    // Clean up
    for (const [, entry] of (adapter as unknown as { mediaGroupBuffers: Map<string, { timer: ReturnType<typeof setTimeout> }> }).mediaGroupBuffers) {
      clearTimeout(entry.timer);
    }
    (adapter as unknown as { mediaGroupBuffers: Map<string, unknown> }).mediaGroupBuffers.clear();
  });

  it("downloads voice directly (no media_group_id support for voice)", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: {
        getFile: vi.fn().mockResolvedValue({ file_path: "voice.ogg" }),
      },
    };
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        voice: { file_id: "vc1", mime_type: "audio/ogg", file_size: 50 },
        // no media_group_id — voice goes direct
      },
    });

    expect(store.ingestStream).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
    mockFetch.mockRestore();
  });

  it("handles video_note using filenameForMime('video-note', ...)", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: {
        getFile: vi.fn().mockResolvedValue({ file_path: "video_note.mp4" }),
      },
    };
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        video_note: { file_id: "vn1", mime_type: "video/mp4", file_size: 50 },
      },
    });

    expect(store.ingestStream).toHaveBeenCalledWith(
      expect.objectContaining({ originalFilename: "video-note.mp4" }),
    );
    mockFetch.mockRestore();
  });

  it("uses default 'audio/ogg' mime when audio has no mime_type", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: {
        getFile: vi.fn().mockResolvedValue({ file_path: "audio" }),
      },
    };
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        audio: { file_id: "a1", file_size: 50 }, // no mime_type
      },
    });

    expect(store.ingestStream).toHaveBeenCalledWith(
      expect.objectContaining({ declaredMimeType: "audio/ogg" }),
    );
    mockFetch.mockRestore();
  });

  it("uses default 'audio/ogg' mime and filenameForMime('voice') when voice has no mime_type", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: {
        getFile: vi.fn().mockResolvedValue({ file_path: "voice" }),
      },
    };
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        voice: { file_id: "vc1", file_size: 20 }, // no mime_type
      },
    });

    expect(store.ingestStream).toHaveBeenCalledWith(
      expect.objectContaining({ declaredMimeType: "audio/ogg", originalFilename: "voice.ogg" }),
    );
    mockFetch.mockRestore();
  });

  it("uses filenameForMime('video') when video has no file_name", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: {
        getFile: vi.fn().mockResolvedValue({ file_path: "video.mp4" }),
      },
    };
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        video: { file_id: "v1", mime_type: "video/mp4", file_size: 100 }, // no file_name
      },
    });

    expect(store.ingestStream).toHaveBeenCalledWith(
      expect.objectContaining({ originalFilename: "video.mp4" }),
    );
    mockFetch.mockRestore();
  });
});

describe("TelegramAdapter downloadAndIngest edge cases", () => {
  it("returns null when fileSizeBytes exceeds maxBytes", async () => {
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage: vi.fn(),
      attachmentStore: store,
    });

    const result = await (adapter as unknown as {
      downloadAndIngest: (
        fileId: string, declaredMime: string | null, filename: string,
        fileSizeBytes: number, maxBytes: number, caption?: string,
      ) => Promise<unknown>;
    }).downloadAndIngest("file-id", "image/png", "test.png", 100, 50); // 100 > 50

    expect(result).toBeNull();
    expect(store.ingestStream).not.toHaveBeenCalled();
  });

  it("returns null when getFile throws", async () => {
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage: vi.fn(),
      attachmentStore: store,
    });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: {
        getFile: vi.fn().mockRejectedValue(new Error("file not found")),
      },
    };

    const result = await (adapter as unknown as {
      downloadAndIngest: (
        fileId: string, declaredMime: string | null, filename: string,
        fileSizeBytes: number, maxBytes: number, caption?: string,
      ) => Promise<unknown>;
    }).downloadAndIngest("bad-id", "image/png", "test.png", 10, 100);

    expect(result).toBeNull();
  });

  it("returns null when file_path is absent from getFile response", async () => {
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage: vi.fn(),
      attachmentStore: store,
    });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: {
        getFile: vi.fn().mockResolvedValue({}), // no file_path
      },
    };

    const result = await (adapter as unknown as {
      downloadAndIngest: (
        fileId: string, declaredMime: string | null, filename: string,
        fileSizeBytes: number, maxBytes: number, caption?: string,
      ) => Promise<unknown>;
    }).downloadAndIngest("file-id", "image/png", "test.png", 10, 100);

    expect(result).toBeNull();
  });

  it("returns null when fetch returns non-ok response", async () => {
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage: vi.fn(),
      attachmentStore: store,
    });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: {
        getFile: vi.fn().mockResolvedValue({ file_path: "some/path.jpg" }),
      },
    };
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("forbidden", { status: 403 }),
    );

    const result = await (adapter as unknown as {
      downloadAndIngest: (
        fileId: string, declaredMime: string | null, filename: string,
        fileSizeBytes: number, maxBytes: number, caption?: string,
      ) => Promise<unknown>;
    }).downloadAndIngest("file-id", "image/png", "test.png", 10, 100);

    expect(result).toBeNull();
    mockFetch.mockRestore();
  });

  it("returns null when ingestStream throws", async () => {
    const store = {
      ingestStream: vi.fn().mockRejectedValue(new Error("disk full")),
    } as unknown as AttachmentStore;
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage: vi.fn(),
      attachmentStore: store,
    });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: {
        getFile: vi.fn().mockResolvedValue({ file_path: "some/path.jpg" }),
      },
    };
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    const result = await (adapter as unknown as {
      downloadAndIngest: (
        fileId: string, declaredMime: string | null, filename: string,
        fileSizeBytes: number, maxBytes: number, caption?: string,
      ) => Promise<unknown>;
    }).downloadAndIngest("file-id", "image/png", "test.png", 10, 100);

    expect(result).toBeNull();
    mockFetch.mockRestore();
  });
});

describe("TelegramAdapter bufferMediaGroupItem and flushMediaGroup", () => {
  it("creates a new group entry on first item", async () => {
    const adapter = makeAdapter({ ownerChatId: "CHAT1" });

    await (adapter as unknown as {
      bufferMediaGroupItem: (
        groupId: string,
        item: { fileId: string; declaredMime: string | null; filename: string; fileSizeBytes: number },
        caption: string | null,
        channelId: string,
        senderId: string,
        chatType: string,
        isDm: boolean,
      ) => Promise<void>;
    }).bufferMediaGroupItem(
      "group-new",
      { fileId: "f1", declaredMime: "image/jpeg", filename: "photo.jpg", fileSizeBytes: 100 },
      "caption text",
      "CHAT1",
      "USER1",
      "private",
      true,
    );

    const buffers = (adapter as unknown as { mediaGroupBuffers: Map<string, unknown> }).mediaGroupBuffers;
    expect(buffers.has("group-new")).toBe(true);
    const entry = buffers.get("group-new") as { items: unknown[]; caption: string | null };
    expect(entry.items).toHaveLength(1);
    expect(entry.caption).toBe("caption text");

    // Clean up timer
    clearTimeout((buffers.get("group-new") as { timer: ReturnType<typeof setTimeout> }).timer);
    buffers.clear();
  });

  it("adds item to existing group and resets timer", async () => {
    const adapter = makeAdapter({ ownerChatId: "CHAT1" });

    const bufferFn = (adapter as unknown as {
      bufferMediaGroupItem: (
        groupId: string,
        item: { fileId: string; declaredMime: string | null; filename: string; fileSizeBytes: number },
        caption: string | null,
        channelId: string,
        senderId: string,
        chatType: string,
        isDm: boolean,
      ) => Promise<void>;
    }).bufferMediaGroupItem.bind(adapter);

    // First item
    await bufferFn(
      "group-existing",
      { fileId: "f1", declaredMime: "image/jpeg", filename: "photo1.jpg", fileSizeBytes: 100 },
      "first caption",
      "CHAT1",
      "USER1",
      "private",
      true,
    );

    // Second item — adds to existing group, caption stays "first caption"
    await bufferFn(
      "group-existing",
      { fileId: "f2", declaredMime: "image/jpeg", filename: "photo2.jpg", fileSizeBytes: 200 },
      null, // no new caption
      "CHAT1",
      "USER1",
      "private",
      true,
    );

    const buffers = (adapter as unknown as { mediaGroupBuffers: Map<string, unknown> }).mediaGroupBuffers;
    const entry = buffers.get("group-existing") as { items: unknown[]; caption: string | null };
    expect(entry.items).toHaveLength(2);
    expect(entry.caption).toBe("first caption"); // unchanged

    // Clean up
    clearTimeout((buffers.get("group-existing") as { timer: ReturnType<typeof setTimeout> }).timer);
    buffers.clear();
  });

  it("flushMediaGroup returns early when group doesn't exist", async () => {
    const onMessage = vi.fn();
    const adapter = makeAdapter({ ownerChatId: "CHAT1" });
    (adapter as unknown as { onMessage: typeof onMessage }).onMessage = onMessage;

    await (adapter as unknown as {
      flushMediaGroup: (groupId: string) => Promise<void>;
    }).flushMediaGroup("nonexistent-group");

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("flushMediaGroup downloads all items and emits event", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: {
        getFile: vi.fn().mockResolvedValue({ file_path: "photo.jpg" }),
      },
    };
    const mockFetch = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
    );

    // Manually inject a media group
    const buffers = (adapter as unknown as { mediaGroupBuffers: Map<string, unknown> }).mediaGroupBuffers;
    buffers.set("flush-group", {
      items: [
        { fileId: "f1", declaredMime: "image/jpeg", filename: "photo1.jpg", fileSizeBytes: 100 },
        { fileId: "f2", declaredMime: "image/jpeg", filename: "photo2.jpg", fileSizeBytes: 200 },
      ],
      caption: "album caption",
      channelId: "CHAT1",
      senderId: "USER1",
      chatType: "private",
      isDm: true,
      timer: setTimeout(() => {}, 99999),
    });
    clearTimeout((buffers.get("flush-group") as { timer: ReturnType<typeof setTimeout> }).timer);

    await (adapter as unknown as {
      flushMediaGroup: (groupId: string) => Promise<void>;
    }).flushMediaGroup("flush-group");

    expect(store.ingestStream).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenCalledTimes(1);
    const event = onMessage.mock.calls[0][0];
    expect(event.content).toBe("album caption");
    expect(event.attachments).toHaveLength(2);

    mockFetch.mockRestore();
  });
});

describe("TelegramAdapter pickLargestPhoto and photoSizeBytes edge cases", () => {
  it("pickLargestPhoto returns empty string for empty array", () => {
    const adapter = makeAdapter();
    const result = (adapter as unknown as {
      pickLargestPhoto: (photos: unknown[]) => string;
    }).pickLargestPhoto([]);
    expect(result).toBe("");
  });

  it("photoSizeBytes returns 0 for empty array", () => {
    const adapter = makeAdapter();
    const result = (adapter as unknown as {
      photoSizeBytes: (photos: unknown[]) => number;
    }).photoSizeBytes([]);
    expect(result).toBe(0);
  });

  it("pickLargestPhoto handles photos with no file_size (uses ?? 0 in sort comparator)", () => {
    const adapter = makeAdapter();
    // Use 3 elements to ensure all ?? branches are hit (b.file_size and a.file_size both null and non-null)
    const result = (adapter as unknown as {
      pickLargestPhoto: (photos: unknown[]) => string;
    }).pickLargestPhoto([
      { file_id: "ph_none_1" },           // no file_size
      { file_id: "ph_large", file_size: 500 },  // has file_size
      { file_id: "ph_none_2" },           // no file_size
    ]);
    // Should pick the one with file_size=500
    expect(result).toBe("ph_large");
  });

  it("photoSizeBytes handles photos with no file_size (uses ?? 0 in sort comparator and ?? 0 return)", () => {
    const adapter = makeAdapter();
    const result = (adapter as unknown as {
      photoSizeBytes: (photos: unknown[]) => number;
    }).photoSizeBytes([
      { file_id: "ph1" }, // no file_size → sort comparator uses ?? 0
      { file_id: "ph2" }, // also no file_size
    ]);
    // Both have no file_size, largest?.file_size is undefined → ?? 0 → 0
    expect(result).toBe(0);
  });

  it("photoSizeBytes ?? 0 branch: both file_size present and absent in comparator", () => {
    const adapter = makeAdapter();
    // 3 elements to force multiple comparisons covering both b.file_size and a.file_size absent
    const result = (adapter as unknown as {
      photoSizeBytes: (photos: unknown[]) => number;
    }).photoSizeBytes([
      { file_id: "ph_none" },             // no file_size
      { file_id: "ph_big", file_size: 300 }, // has file_size
      { file_id: "ph_none_2" },           // no file_size
    ]);
    expect(result).toBe(300);
  });
});

describe("TelegramAdapter handleMessage: video_note without mime_type (video/mp4 default branch)", () => {
  it("uses 'video/mp4' default when video_note has no mime_type", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: {
        getFile: vi.fn().mockResolvedValue({ file_path: "video_note.mp4" }),
      },
    };
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        video_note: { file_id: "vn1", file_size: 50 }, // no mime_type → exercises "video/mp4" default branch
      },
    });

    expect(store.ingestStream).toHaveBeenCalledWith(
      expect.objectContaining({ declaredMimeType: "video/mp4" }),
    );

    mockFetch.mockRestore();
  });

  it("uses 'video/mp4' default when video has no mime_type", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: {
        getFile: vi.fn().mockResolvedValue({ file_path: "video.mp4" }),
      },
    };
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        video: { file_id: "v1", file_size: 100 }, // no mime_type → exercises "video/mp4" default (not audio/voice)
      },
    });

    expect(store.ingestStream).toHaveBeenCalledWith(
      expect.objectContaining({ declaredMimeType: "video/mp4" }),
    );

    mockFetch.mockRestore();
  });
});

describe("TelegramAdapter sendMessage: long text with attachment — sendMessage chunk error catch", () => {
  it("catches sendMessage error for text chunks and continues to attachment send", async () => {
    fsOverrides.readFileSync = () => Buffer.from("img-data");
    const adapter = makeAdapter({ ownerChatId: "CHAT1" });
    const mockSendMessage = vi.fn().mockRejectedValue(new Error("Telegram flood error"));
    const mockSendPhoto = vi.fn().mockResolvedValue({ message_id: 7 });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: { sendMessage: mockSendMessage, sendPhoto: mockSendPhoto, sendDocument: vi.fn() },
    };

    const longText = "x".repeat(1025); // exceeds TELEGRAM_CAPTION_MAX_CHARS
    const result = await adapter.sendMessage({
      channel: "CHAT1",
      text: longText,
      attachments: [makeOutboundAttachment({ mimeType: "image/png" })],
    });

    // sendMessage threw, but sendPhoto succeeded
    expect(mockSendPhoto).toHaveBeenCalledTimes(1);
    // result.messageId comes from sendPhoto
    expect(result.messageId).toBe("7");

    fsOverrides.readFileSync = undefined;
  });
});

describe("TelegramAdapter remaining branch coverage", () => {
  it("document download with no textContent (textContent || undefined right branch)", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: {
        getFile: vi.fn().mockResolvedValue({ file_path: "doc.pdf" }),
      },
    };
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        document: { file_id: "doc1", mime_type: "application/pdf", file_name: "test.pdf", file_size: 100 },
        // no caption — textContent is ""
      },
    });

    // Empty textContent exercises the `textContent || undefined` right side
    expect(store.ingestStream).toHaveBeenCalledWith(
      expect.objectContaining({ originalFilename: "test.pdf" }),
    );
    const event = onMessage.mock.calls[0][0];
    expect(event.content).toBe("");

    mockFetch.mockRestore();
  });

  it("document downloadAndIngest returns null → emitTextEvent with [] refs", async () => {
    const onMessage = vi.fn();
    const store = {
      ingestStream: vi.fn().mockRejectedValue(new Error("disk full")),
    } as unknown as AttachmentStore;
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: {
        getFile: vi.fn().mockResolvedValue({ file_path: "doc.pdf" }),
      },
    };
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        document: { file_id: "doc1", mime_type: "application/pdf", file_name: "test.pdf", file_size: 100 },
      },
    });

    // downloadAndIngest returned null → ref ? [ref] : [] → [] (no attachments)
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].attachments).toBeUndefined();

    mockFetch.mockRestore();
  });

  it("flushMediaGroup with null caption (entry.caption ?? undefined and entry.caption ?? '')", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: {
        getFile: vi.fn().mockResolvedValue({ file_path: "photo.jpg" }),
      },
    };
    const mockFetch = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
    );

    // Inject a group with null caption to trigger ?? branches
    const buffers = (adapter as unknown as { mediaGroupBuffers: Map<string, unknown> }).mediaGroupBuffers;
    buffers.set("null-caption-group", {
      items: [
        { fileId: "f1", declaredMime: "image/jpeg", filename: "photo.jpg", fileSizeBytes: 100 },
      ],
      caption: null, // ← triggers entry.caption ?? undefined and entry.caption ?? ""
      channelId: "CHAT1",
      senderId: "USER1",
      chatType: "private",
      isDm: true,
      timer: setTimeout(() => {}, 99999),
    });
    clearTimeout((buffers.get("null-caption-group") as { timer: ReturnType<typeof setTimeout> }).timer);

    await (adapter as unknown as {
      flushMediaGroup: (groupId: string) => Promise<void>;
    }).flushMediaGroup("null-caption-group");

    expect(onMessage).toHaveBeenCalledTimes(1);
    // content should be "" because entry.caption ?? "" → ""
    expect(onMessage.mock.calls[0][0].content).toBe("");

    mockFetch.mockRestore();
  });

  it("flushMediaGroup: downloadAndIngest returns null → ref not pushed (if (ref) false branch)", async () => {
    const onMessage = vi.fn();
    // Store that makes ingestStream throw so downloadAndIngest returns null
    const store = {
      ingestStream: vi.fn().mockRejectedValue(new Error("fail")),
    } as unknown as AttachmentStore;
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: {
        getFile: vi.fn().mockResolvedValue({ file_path: "photo.jpg" }),
      },
    };
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    const buffers = (adapter as unknown as { mediaGroupBuffers: Map<string, unknown> }).mediaGroupBuffers;
    buffers.set("fail-group", {
      items: [
        { fileId: "f1", declaredMime: "image/jpeg", filename: "photo.jpg", fileSizeBytes: 10 },
      ],
      caption: "some caption",
      channelId: "CHAT1",
      senderId: "USER1",
      chatType: "private",
      isDm: true,
      timer: setTimeout(() => {}, 99999),
    });
    clearTimeout((buffers.get("fail-group") as { timer: ReturnType<typeof setTimeout> }).timer);

    await (adapter as unknown as {
      flushMediaGroup: (groupId: string) => Promise<void>;
    }).flushMediaGroup("fail-group");

    // Event emitted but no attachments (ref was null → not pushed)
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].attachments).toBeUndefined();

    mockFetch.mockRestore();
  });

  it("downloadAndIngest returns null when attachmentStore is null (line 589)", async () => {
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage: vi.fn(),
      // no attachmentStore
    });

    const result = await (adapter as unknown as {
      downloadAndIngest: (
        fileId: string, declaredMime: string | null, filename: string,
        fileSizeBytes: number, maxBytes: number, caption?: string,
      ) => Promise<unknown>;
    }).downloadAndIngest("file-id", "image/png", "test.png", 10, 100);

    expect(result).toBeNull();
  });

  it("pickLargestPhoto returns '' when photo has no file_id (line 684 ?? '' branch)", () => {
    const adapter = makeAdapter();
    const result = (adapter as unknown as {
      pickLargestPhoto: (photos: unknown[]) => string;
    }).pickLargestPhoto([
      { file_size: 100 }, // no file_id → largest?.file_id is undefined → ?? '' fires
    ]);
    expect(result).toBe("");
  });

  it("audio/video file_size defaults to 0 when absent (line 472 : 0 branch)", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: {
        getFile: vi.fn().mockResolvedValue({ file_path: "audio" }),
      },
    };
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        audio: { file_id: "a1" }, // no file_size → exercises : 0 branch at line 472
      },
    });

    expect(store.ingestStream).toHaveBeenCalledWith(
      expect.objectContaining({ declaredMimeType: "audio/ogg" }),
    );

    mockFetch.mockRestore();
  });
});

describe("TelegramAdapter: remaining branch coverage for sendMessage and handleMessage", () => {
  it("sendDocument second attachment has no caption (caption ? ... : replyOpts false branch at line 309)", async () => {
    fsOverrides.readFileSync = () => Buffer.from("doc-data");
    const adapter = makeAdapter({ ownerChatId: "CHAT1" });
    const mockSendDocument = vi.fn().mockResolvedValue({ message_id: 20 });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: { sendPhoto: vi.fn(), sendMessage: vi.fn(), sendDocument: mockSendDocument },
    };

    await adapter.sendMessage({
      channel: "CHAT1",
      text: "two docs",
      attachments: [
        makeOutboundAttachment({ mimeType: "application/pdf", originalFilename: "doc1.pdf" }),
        makeOutboundAttachment({ mimeType: "application/pdf", originalFilename: "doc2.pdf" }),
      ],
    });

    // Second call has no caption
    expect(mockSendDocument).toHaveBeenCalledTimes(2);
    const secondCallOpts = mockSendDocument.mock.calls[1][2];
    expect(secondCallOpts?.caption).toBeUndefined();

    fsOverrides.readFileSync = undefined;
  });

  it("sendPhoto: result.message_id is undefined → lastMessageId unchanged branch", async () => {
    fsOverrides.readFileSync = () => Buffer.from("img-data");
    const adapter = makeAdapter({ ownerChatId: "CHAT1" });
    const mockSendPhoto = vi.fn().mockResolvedValue({}); // no message_id
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: { sendPhoto: mockSendPhoto, sendMessage: vi.fn(), sendDocument: vi.fn() },
    };

    const result = await adapter.sendMessage({
      channel: "CHAT1",
      text: "photo",
      attachments: [makeOutboundAttachment({ mimeType: "image/png" })],
    });

    // message_id undefined → lastMessageId stays undefined
    expect(result.messageId).toBeUndefined();

    fsOverrides.readFileSync = undefined;
  });

  it("audio download with no textContent and downloadAndIngest returns null (lines 499, 501)", async () => {
    const onMessage = vi.fn();
    const store = {
      ingestStream: vi.fn().mockRejectedValue(new Error("fail")),
    } as unknown as AttachmentStore;
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: {
        getFile: vi.fn().mockResolvedValue({ file_path: "audio.ogg" }),
      },
    };
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        audio: { file_id: "a1", mime_type: "audio/mpeg", file_size: 10 },
        // no caption — textContent is ""
      },
    });

    // textContent is "" → textContent || undefined → undefined (right branch)
    // ref is null (ingestStream threw) → ref ? [ref] : [] → [] (false branch)
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].attachments).toBeUndefined();

    mockFetch.mockRestore();
  });

  it("bufferMediaGroupItem: caption update when existing.caption is null and new caption is non-null", async () => {
    const adapter = makeAdapter({ ownerChatId: "CHAT1" });

    const bufferFn = (adapter as unknown as {
      bufferMediaGroupItem: (
        groupId: string,
        item: { fileId: string; declaredMime: string | null; filename: string; fileSizeBytes: number },
        caption: string | null,
        channelId: string,
        senderId: string,
        chatType: string,
        isDm: boolean,
      ) => Promise<void>;
    }).bufferMediaGroupItem.bind(adapter);

    // First item with NO caption
    await bufferFn(
      "cap-update-group",
      { fileId: "f1", declaredMime: "image/jpeg", filename: "photo1.jpg", fileSizeBytes: 100 },
      null, // no caption initially
      "CHAT1",
      "USER1",
      "private",
      true,
    );

    // Second item WITH a caption — existing.caption is null → should update
    await bufferFn(
      "cap-update-group",
      { fileId: "f2", declaredMime: "image/jpeg", filename: "photo2.jpg", fileSizeBytes: 200 },
      "now I have a caption", // caption provided
      "CHAT1",
      "USER1",
      "private",
      true,
    );

    const buffers = (adapter as unknown as { mediaGroupBuffers: Map<string, unknown> }).mediaGroupBuffers;
    const entry = buffers.get("cap-update-group") as { items: unknown[]; caption: string | null };
    expect(entry.caption).toBe("now I have a caption");

    // Clean up
    clearTimeout((buffers.get("cap-update-group") as { timer: ReturnType<typeof setTimeout> }).timer);
    buffers.clear();
  });

  it("photo download returns null → ref ? [ref] : [] → [] (lines 390-392)", async () => {
    const onMessage = vi.fn();
    const store = {
      ingestStream: vi.fn().mockRejectedValue(new Error("fail")),
    } as unknown as AttachmentStore;
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: {
        getFile: vi.fn().mockResolvedValue({ file_path: "photo.jpg" }),
      },
    };
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        photo: [{ file_id: "ph1", file_size: 100 }],
        // no caption — textContent is "" → textContent || undefined → undefined
      },
    });

    // ref is null (ingestStream threw) → ref ? [ref] : [] → no attachments
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].attachments).toBeUndefined();

    mockFetch.mockRestore();
  });

  it("handleMessage: from.id absent uses 'unknown' and chat.id absent uses '' (lines 336-337)", async () => {
    const onMessage = vi.fn();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "unknown", // must match the "unknown" senderId to pass owner filter, but channelId "" won't match
      onMessage,
    });

    // from.id absent → senderId = "unknown", chat.id absent → channelId = ""
    // But channelId "" !== ownerChatId "unknown" → dropped by owner filter
    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: {}, // no id → from?.id is undefined → ?? "unknown"
        chat: { type: "private" }, // no id → chat?.id is undefined → ?? ""
        text: "hello",
      },
    });

    // senderId = "unknown", channelId = "" → channelId !== ownerChatId → dropped
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("handleMessage: from absent uses 'unknown' (from?.id is undefined)", async () => {
    const onMessage = vi.fn();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
    });

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        // no from field — from?.id is undefined → senderId = "unknown"
        chat: { id: "CHAT1", type: "private" },
        text: "hello",
      },
    });

    // senderId = "unknown" → channelId "CHAT1" matches ownerChatId but senderId "unknown" != "CHAT1"... wait
    // Actually the owner filter checks channelId, not senderId:
    // if (!this.mutableOwnerId || channelId !== this.mutableOwnerId) → channelId = "CHAT1" = ownerChatId = OK
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].sender).toBe("unknown");
  });

  it("photo with media_group_id but no caption (textContent || null → null branch at line 376)", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        photo: [{ file_id: "ph1", file_size: 100 }],
        media_group_id: "mg-no-cap",
        // no caption — textContent is "" → textContent || null → null
      },
    });

    const buffers = (adapter as unknown as { mediaGroupBuffers: Map<string, unknown> }).mediaGroupBuffers;
    const entry = buffers.get("mg-no-cap") as { items: unknown[]; caption: string | null };
    expect(entry.caption).toBeNull();

    // Clean up
    clearTimeout((buffers.get("mg-no-cap") as { timer: ReturnType<typeof setTimeout> }).timer);
    buffers.clear();
  });

  it("document with media_group_id but no optional fields (fallback branches 408-410)", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });

    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        document: { file_id: "doc1" }, // no mime_type, no file_name, no file_size
        media_group_id: "mg-no-meta",
      },
    });

    // Buffered — timer pending
    const buffers = (adapter as unknown as { mediaGroupBuffers: Map<string, unknown> }).mediaGroupBuffers;
    expect(buffers.has("mg-no-meta")).toBe(true);
    // Clean up
    clearTimeout((buffers.get("mg-no-meta") as { timer: ReturnType<typeof setTimeout> }).timer);
    buffers.clear();
  });

  it("sendMessage long text: sendMessage succeeds with no message_id (line 283 lastMessageId fallback)", async () => {
    fsOverrides.readFileSync = () => Buffer.from("img-data");
    const adapter = makeAdapter({ ownerChatId: "CHAT1" });
    const mockSendMessage = vi.fn().mockResolvedValue({}); // no message_id
    const mockSendPhoto = vi.fn().mockResolvedValue({ message_id: 15 });
    (adapter as unknown as { bot: unknown }).bot = {
      telegram: { sendMessage: mockSendMessage, sendPhoto: mockSendPhoto, sendDocument: vi.fn() },
    };

    const longText = "x".repeat(1025);
    const result = await adapter.sendMessage({
      channel: "CHAT1",
      text: longText,
      attachments: [makeOutboundAttachment({ mimeType: "image/png" })],
    });

    // sendMessage returned no message_id → lastMessageId stays undefined initially
    // sendPhoto returned message_id: 15
    expect(result.messageId).toBe("15");

    fsOverrides.readFileSync = undefined;
  });

  it("audio/video: !media returns early when media is falsy but not null/undefined (line 454)", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
      attachmentStore: store,
    });

    // msg.audio = false (falsy, non-null) AND msg.voice = {} (truthy):
    // outer check: false || {} = {} = truthy → enters the audio/voice block
    // audio = false (not null/undefined) → media = false ?? {} = false
    // !media = !false = true → returns early at line 454
    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1", type: "private" },
        audio: false, // falsy but not undefined/null → media = false → !media = true
        voice: { file_id: "vc1", mime_type: "audio/ogg", file_size: 10 },
      },
    });

    // Line 454: `if (!media) return` fires → no download, no event
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("handleMessage: msg.chat.type absent uses 'private' default (line 332 ?? 'private' branch)", async () => {
    const onMessage = vi.fn();
    const adapter = new TelegramAdapter({
      botToken: "fake:token",
      ownerChatId: "CHAT1",
      onMessage,
    });

    // chat.type is absent → chatType = msg.chat?.type ?? "private" → "private"
    await (adapter as unknown as { handleMessage: (ctx: unknown) => Promise<void> }).handleMessage({
      message: {
        message_id: 1,
        from: { id: "USER1" },
        chat: { id: "CHAT1" }, // no type → chatType defaults to "private"
        text: "hello",
      },
    });

    // Should emit event (isDm = true since chatType = "private")
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].isDm).toBe(true);
  });
});
