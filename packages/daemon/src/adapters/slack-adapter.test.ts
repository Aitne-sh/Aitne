import { describe, it, expect, vi } from "vitest";
import { SlackAdapter } from "./slack-adapter.js";
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
 * Slack adapter discovery-mode tests. We don't load @slack/bolt — we
 * directly invoke the private `handleMessage` with a fake message and
 * check that `onOwnerDetected` fires only on DMs (never on channel
 * mentions, even with discovery active).
 */

function makeAdapter(opts: {
  ownerUserId?: string | null;
  onOwnerDetected?: (id: string) => void;
} = {}) {
  return new SlackAdapter({
    botToken: "xoxb-fake",
    appToken: "xapp-fake",
    ownerUserId: opts.ownerUserId ?? null,
    onMessage: vi.fn(),
    onOwnerDetected: opts.onOwnerDetected,
  });
}

// Mirror the daemon-side magic-phrase matcher exactly. The matcher is
// **equality** on the normalised string — wrapping the phrase in extra
// prose must NOT match. See magic-phrase.ts for the security rationale.
function phraseMatcher(phrase: string): (text: string) => boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const expected = norm(phrase);
  return (text: string) => norm(text) === expected;
}

function fakeAttachmentStore() {
  return {
    ingestStream: vi.fn().mockImplementation(async (params: { originalFilename: string; declaredMimeType: string | null }) => ({
      id: "att-slack",
      path: `/tmp/${params.originalFilename}`,
      originalFilename: params.originalFilename,
      safeFilename: params.originalFilename,
      mimeType: params.declaredMimeType ?? "application/octet-stream",
      sizeBytes: 12,
    })),
  } as unknown as AttachmentStore;
}

describe("SlackAdapter challenge-based pairing", () => {
  it("captures the sender of the FIRST DM whose text matches the phrase", () => {
    const onOwnerDetected = vi.fn();
    const adapter = makeAdapter({ onOwnerDetected });
    adapter.startPairing({
      match: phraseMatcher("apple-banana-cherry-date"),
      expiresAt: Date.now() + 60_000,
    });

    // Wrong phrase — dropped (regression test for the previous "first DM
    // wins" race that captured this exact scenario).
    (adapter as unknown as { handleMessage: (msg: unknown) => void }).handleMessage({
      channel_type: "im",
      user: "U_INTRUDER",
      text: "hello there",
      channel: "D_INTRUDER",
    });
    expect(onOwnerDetected).not.toHaveBeenCalled();
    expect(adapter.getOwnerUserId()).toBeNull();

    // Wrapping the phrase in extra prose must NOT capture (C1 regression).
    (adapter as unknown as { handleMessage: (msg: unknown) => void }).handleMessage({
      channel_type: "im",
      user: "U_INTRUDER2",
      text: "my pairing phrase is apple-banana-cherry-date",
      channel: "D_INTRUDER2",
    });
    expect(onOwnerDetected).not.toHaveBeenCalled();
    expect(adapter.getOwnerUserId()).toBeNull();

    // Correct phrase as the only content — captures.
    (adapter as unknown as { handleMessage: (msg: unknown) => void }).handleMessage({
      channel_type: "im",
      user: "U_OWNER",
      text: "apple-banana-cherry-date",
      channel: "D_OWNER",
    });
    expect(onOwnerDetected).toHaveBeenCalledWith("U_OWNER");
    expect(adapter.getOwnerUserId()).toBe("U_OWNER");
  });

  it("normalizes punctuation and case in the user's reply", () => {
    const onOwnerDetected = vi.fn();
    const adapter = makeAdapter({ onOwnerDetected });
    adapter.startPairing({
      match: phraseMatcher("apple-banana-cherry-date"),
      expiresAt: Date.now() + 60_000,
    });

    (adapter as unknown as { handleMessage: (msg: unknown) => void }).handleMessage({
      channel_type: "im",
      user: "U_OWNER",
      text: "Apple Banana, CHERRY date! 🙂",
      channel: "D_OWNER",
    });

    expect(onOwnerDetected).toHaveBeenCalledWith("U_OWNER");
  });

  it("does NOT capture from a public-channel mention even when text equals the phrase", () => {
    // Use a payload that EXACTLY equals the phrase so the only thing
    // protecting us is the DM-vs-channel discriminator.
    const onOwnerDetected = vi.fn();
    const adapter = makeAdapter({ onOwnerDetected });
    adapter.startPairing({
      match: phraseMatcher("apple-banana-cherry-date"),
      expiresAt: Date.now() + 60_000,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";

    (adapter as unknown as { handleMessage: (msg: unknown) => void }).handleMessage({
      channel_type: "channel",
      user: "U_OTHER",
      text: "apple-banana-cherry-date",
      channel: "C_PUBLIC",
    });

    expect(onOwnerDetected).not.toHaveBeenCalled();
    expect(adapter.getOwnerUserId()).toBeNull();
  });

  it("does NOT capture when no pairing challenge is active", () => {
    const onOwnerDetected = vi.fn();
    const adapter = makeAdapter({ onOwnerDetected });

    (adapter as unknown as { handleMessage: (msg: unknown) => void }).handleMessage({
      channel_type: "im",
      user: "U_RANDOM",
      text: "any phrase",
      channel: "D_RANDOM",
    });

    expect(onOwnerDetected).not.toHaveBeenCalled();
    expect(adapter.getOwnerUserId()).toBeNull();
  });

  it("setOwnerUserId / getOwnerUserId round-trips for live config updates", () => {
    const adapter = makeAdapter();
    expect(adapter.getOwnerUserId()).toBeNull();
    adapter.setOwnerUserId("U_NEW");
    expect(adapter.getOwnerUserId()).toBe("U_NEW");
    adapter.setOwnerUserId(null);
    expect(adapter.getOwnerUserId()).toBeNull();
  });

  // H2 regression: the captured magic phrase must NOT be emitted to the
  // agent EventBus. Previously the adapter fell through after capture,
  // burning an agent inference on the phrase itself and producing a
  // duplicate user-facing reply on top of the welcome DM.
  it("does NOT emit the captured phrase to onMessage (H2 regression)", () => {
    const onMessage = vi.fn();
    const onOwnerDetected = vi.fn();
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: null,
      onMessage,
      onOwnerDetected,
    });
    adapter.startPairing({
      match: phraseMatcher("apple-banana-cherry-date"),
      expiresAt: Date.now() + 60_000,
    });

    (adapter as unknown as { handleMessage: (msg: unknown) => void }).handleMessage({
      channel_type: "im",
      user: "U_OWNER",
      text: "apple-banana-cherry-date",
      channel: "D_OWNER",
    });

    expect(onOwnerDetected).toHaveBeenCalledTimes(1);
    expect(onMessage).not.toHaveBeenCalled();
  });
});

// ── Coverage gap fill: authorized owner messages, sendMessage, etc. ──

describe("SlackAdapter owner message handling", () => {
  it("emits a DM event for the authorized owner", () => {
    const onMessage = vi.fn();
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: "U_OWNER",
      onMessage,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";

    (adapter as unknown as { handleMessage: (msg: unknown) => void }).handleMessage({
      channel_type: "im",
      user: "U_OWNER",
      text: "hello agent",
      channel: "D_OWNER",
      ts: "1234.5678",
      team: "T1",
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    const event = onMessage.mock.calls[0][0];
    expect(event.content).toBe("hello agent");
    expect(event.platform).toBe("slack");
    expect(event.isDm).toBe(true);
    expect(event.isMention).toBe(false);
    expect(event.sender).toBe("U_OWNER");
    expect(event.channel).toBe("D_OWNER");
  });

  it("emits a mention event for the authorized owner in a channel", () => {
    const onMessage = vi.fn();
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: "U_OWNER",
      onMessage,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";

    (adapter as unknown as { handleMessage: (msg: unknown) => void }).handleMessage({
      channel_type: "channel",
      user: "U_OWNER",
      text: "<@BOT> do something",
      channel: "C_PUBLIC",
      ts: "1234.5678",
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    const event = onMessage.mock.calls[0][0];
    expect(event.isMention).toBe(true);
    expect(event.isDm).toBe(false);
  });

  it("drops messages from unauthorized senders", () => {
    const onMessage = vi.fn();
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: "U_OWNER",
      onMessage,
    });

    (adapter as unknown as { handleMessage: (msg: unknown) => void }).handleMessage({
      channel_type: "im",
      user: "U_STRANGER",
      text: "hi",
      channel: "D_STRANGER",
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("drops bot messages (bot_id present)", () => {
    const onMessage = vi.fn();
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: "U_OWNER",
      onMessage,
    });

    (adapter as unknown as { handleMessage: (msg: unknown) => void }).handleMessage({
      channel_type: "im",
      user: "U_OWNER",
      text: "bot message",
      channel: "D_OWNER",
      bot_id: "B123",
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("drops messages with subtype", () => {
    const onMessage = vi.fn();
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: "U_OWNER",
      onMessage,
    });

    (adapter as unknown as { handleMessage: (msg: unknown) => void }).handleMessage({
      channel_type: "im",
      user: "U_OWNER",
      text: "edited",
      channel: "D_OWNER",
      subtype: "message_changed",
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("drops non-DM, non-mention channel messages", () => {
    const onMessage = vi.fn();
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: "U_OWNER",
      onMessage,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";

    (adapter as unknown as { handleMessage: (msg: unknown) => void }).handleMessage({
      channel_type: "channel",
      user: "U_OWNER",
      text: "no mention here",
      channel: "C_PUBLIC",
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("includes threadId from thread_ts", () => {
    const onMessage = vi.fn();
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: "U_OWNER",
      onMessage,
    });

    (adapter as unknown as { handleMessage: (msg: unknown) => void }).handleMessage({
      channel_type: "im",
      user: "U_OWNER",
      text: "in a thread",
      channel: "D_OWNER",
      thread_ts: "1234.0000",
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    const event = onMessage.mock.calls[0][0];
    expect(event.threadId).toBe("1234.0000");
  });

  it("ingests audio/video files instead of skipping them", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: "U_OWNER",
      onMessage,
      attachmentStore: store,
    });
    const mockFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as {
      downloadAndEmitSlackMessage: (
        message: unknown,
        senderId: string,
        text: string,
        isDm: boolean,
        isMention: boolean,
        files: unknown[],
      ) => Promise<void>;
    }).downloadAndEmitSlackMessage(
      { channel: "D_OWNER", ts: "1234.5678" },
      "U_OWNER",
      "",
      true,
      false,
      [
        {
          size: 3,
          mimetype: "audio/mpeg",
          name: "clip.mp3",
          url_private_download: "https://files.slack.test/clip.mp3",
        },
        {
          size: 3,
          mimetype: "video/mp4",
          name: "clip.mp4",
          url_private_download: "https://files.slack.test/clip.mp4",
        },
      ],
    );

    expect(store.ingestStream).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        declaredMimeType: "audio/mpeg",
        originalFilename: "clip.mp3",
      }),
    );
    expect(store.ingestStream).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        declaredMimeType: "video/mp4",
        originalFilename: "clip.mp4",
      }),
    );
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].attachments).toHaveLength(2);
    mockFetch.mockRestore();
  });
});

describe("SlackAdapter captureOwner error handling", () => {
  // B-1 regression: a failing onOwnerDetected callback (e.g. .env not
  // writable, keychain locked) MUST roll back mutableOwnerId. Otherwise
  // the adapter accepts owner DMs in memory while the env file still
  // shows no pairing — and the next daemon restart silently loses the
  // binding. The pairing matcher must also stay armed so the user can
  // retry by resending the phrase without regenerating it.
  it("rolls back mutableOwnerId on synchronous throw in onOwnerDetected", async () => {
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
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

    await (adapter as unknown as {
      handleMessage: (msg: unknown) => Promise<void>;
    }).handleMessage({
      channel_type: "im",
      user: "U1",
      text: "test-phrase",
      channel: "D1",
    });

    expect(adapter.getOwnerUserId()).toBeNull();
    // Matcher stays armed for retry — cancelPairing is only called on
    // success.
    expect(adapter.isPairingActive()).toBe(true);
  });

  it("rolls back mutableOwnerId on async rejection in onOwnerDetected", async () => {
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
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

    await (adapter as unknown as {
      handleMessage: (msg: unknown) => Promise<void>;
    }).handleMessage({
      channel_type: "im",
      user: "U1",
      text: "test-phrase",
      channel: "D1",
    });

    expect(adapter.getOwnerUserId()).toBeNull();
    expect(adapter.isPairingActive()).toBe(true);
  });

  it("cancels pairing on successful onOwnerDetected", async () => {
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: null,
      onMessage: vi.fn(),
      onOwnerDetected: async () => {
        /* no-op success */
      },
    });
    adapter.startPairing({
      match: phraseMatcher("test-phrase"),
      expiresAt: Date.now() + 60_000,
    });

    await (adapter as unknown as {
      handleMessage: (msg: unknown) => Promise<void>;
    }).handleMessage({
      channel_type: "im",
      user: "U1",
      text: "test-phrase",
      channel: "D1",
    });

    expect(adapter.getOwnerUserId()).toBe("U1");
    expect(adapter.isPairingActive()).toBe(false);
  });
});

// B-4 regression: Slack multi-person IMs (mpim) must be rejected outright.
// Without the explicit mpim guard, a bot @-mention inside an mpim would
// fall through the isDm check, satisfy isMention, and emit an agent
// response into a channel visible to non-owner participants — violating
// the single-owner scope invariant in CLAUDE.md.
describe("SlackAdapter mpim rejection (B-4)", () => {
  it("drops multi-person IM messages even when owner @-mentions the bot", () => {
    const onMessage = vi.fn();
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: "U_OWNER",
      onMessage,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";

    (adapter as unknown as {
      handleMessage: (msg: unknown) => Promise<void>;
    }).handleMessage({
      channel_type: "mpim",
      user: "U_OWNER",
      text: "<@BOT> what is this",
      channel: "G_MPIM",
    });

    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe("SlackAdapter sendMessage", () => {
  it("sends a message when app is started", async () => {
    const adapter = makeAdapter({ ownerUserId: "U_OWNER" });
    const mockApp = {
      client: {
        chat: {
          postMessage: vi.fn().mockResolvedValue({ ts: "1234.5678" }),
        },
      },
    };
    (adapter as unknown as { app: unknown }).app = mockApp;

    const result = await adapter.sendMessage({
      channel: "D_OWNER",
      text: "hello",
      threadId: "thread-1",
    });

    expect(mockApp.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "D_OWNER",
        text: "hello",
        thread_ts: "thread-1",
      }),
    );
    expect(result.messageId).toBe("1234.5678");
  });

  it("throws when app is not started", async () => {
    const adapter = makeAdapter();

    await expect(
      adapter.sendMessage({ channel: "D1", text: "hi" }),
    ).rejects.toThrow("Slack app not started");
  });

  it("propagates errors from chat.postMessage", async () => {
    const adapter = makeAdapter();
    const mockApp = {
      client: {
        chat: {
          postMessage: vi.fn().mockRejectedValue(new Error("channel_not_found")),
        },
      },
    };
    (adapter as unknown as { app: unknown }).app = mockApp;

    await expect(
      adapter.sendMessage({ channel: "D1", text: "hi" }),
    ).rejects.toThrow("channel_not_found");
  });
});

describe("SlackAdapter resolveUserChannel", () => {
  it("returns null when app is not started", async () => {
    const adapter = makeAdapter({ ownerUserId: "U1" });
    const result = await adapter.resolveUserChannel();
    expect(result).toBeNull();
  });

  it("returns null when no owner is configured", async () => {
    const adapter = makeAdapter({ ownerUserId: null });
    (adapter as unknown as { app: unknown }).app = {};
    const result = await adapter.resolveUserChannel();
    expect(result).toBeNull();
  });

  it("resolves the DM channel for the owner", async () => {
    const adapter = makeAdapter({ ownerUserId: "U_OWNER" });
    const mockApp = {
      client: {
        conversations: {
          open: vi.fn().mockResolvedValue({ channel: { id: "D_RESOLVED" } }),
        },
      },
    };
    (adapter as unknown as { app: unknown }).app = mockApp;

    const result = await adapter.resolveUserChannel();
    expect(result).toBe("D_RESOLVED");
  });
});

describe("SlackAdapter pairing lifecycle", () => {
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

describe("SlackAdapter.fetchBotInfo (static)", () => {
  it("returns bot info on success", async () => {
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          user_id: "U123",
          user: "TestBot",
          team: "T1",
          url: "https://test.slack.com/",
        }),
        { status: 200 },
      ),
    );

    const info = await SlackAdapter.fetchBotInfo("xoxb-fake");
    expect(info.botUserId).toBe("U123");
    expect(info.botName).toBe("TestBot");
    expect(info.team).toBe("T1");
    expect(info.url).toBe("https://test.slack.com/");
    mockFetch.mockRestore();
  });

  it("throws on HTTP error", async () => {
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", { status: 500, statusText: "Internal Server Error" }),
    );

    await expect(SlackAdapter.fetchBotInfo("bad-token")).rejects.toThrow(
      "Slack auth.test HTTP error: 500",
    );
    mockFetch.mockRestore();
  });

  it("throws when body.ok is false", async () => {
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: false, error: "invalid_auth" }),
        { status: 200 },
      ),
    );

    await expect(SlackAdapter.fetchBotInfo("bad-token")).rejects.toThrow(
      "Slack auth.test failed: invalid_auth",
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

describe("SlackAdapter stop()", () => {
  it("is a no-op when app is null", async () => {
    const adapter = makeAdapter();
    // app is null by default — should not throw
    await expect(adapter.stop()).resolves.not.toThrow();
  });

  it("calls app.stop() and sets app to null when app is set", async () => {
    const adapter = makeAdapter();
    const mockStop = vi.fn().mockResolvedValue(undefined);
    (adapter as unknown as { app: { stop: typeof mockStop } }).app = { stop: mockStop };

    await adapter.stop();

    expect(mockStop).toHaveBeenCalledTimes(1);
    expect((adapter as unknown as { app: unknown }).app).toBeNull();
  });
});

describe("SlackAdapter start() dynamic import paths", () => {
  it("throws a helpful error when @slack/bolt cannot be imported", async () => {
    vi.doMock("@slack/bolt", () => { throw new Error("MODULE_NOT_FOUND"); });
    vi.resetModules();

    const { SlackAdapter: FreshSlack } = await import("./slack-adapter.js");
    const adapter = new FreshSlack({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: null,
      onMessage: vi.fn(),
    });

    await expect(adapter.start()).rejects.toThrow("@slack/bolt not installed");

    vi.doUnmock("@slack/bolt");
    vi.resetModules();
  });

  it("happy path: creates App, registers message handler, calls app.start()", async () => {
    // Capture the handler registered with app.message(handler) so we can invoke it
    // to cover the lambda body at lines 180-181.
    let capturedMessageHandler: ((args: { message: unknown; say: unknown }) => Promise<void>) | null = null;
    const mockMessageFn = vi.fn().mockImplementation((handler: typeof capturedMessageHandler) => {
      capturedMessageHandler = handler;
    });
    const mockStartFn = vi.fn().mockResolvedValue(undefined);
    const mockAuthTest = vi.fn().mockResolvedValue({ user_id: "BOT_ID" });

    vi.doMock("@slack/bolt", () => ({
      App: vi.fn().mockImplementation(() => ({
        message: mockMessageFn,
        start: mockStartFn,
        stop: vi.fn().mockResolvedValue(undefined),
        client: { auth: { test: mockAuthTest } },
      })),
    }));
    vi.resetModules();

    const { SlackAdapter: FreshSlack } = await import("./slack-adapter.js");
    const fetchInfoSpy = vi
      .spyOn(FreshSlack, "fetchBotInfo")
      .mockResolvedValue({
        botUserId: "BOT_ID",
        botName: "TestBot",
        team: "T1",
        url: "https://test.slack.com/",
      });

    const onMessage = vi.fn();
    const adapter = new FreshSlack({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: "U_OWNER",
      onMessage,
    });

    await adapter.start();

    expect(mockMessageFn).toHaveBeenCalledTimes(1);
    expect(mockStartFn).toHaveBeenCalledTimes(1);
    expect((adapter as unknown as { botUserId: string | null }).botUserId).toBe("BOT_ID");

    // Invoke the registered handler to cover lines 180-181 (the lambda body).
    expect(capturedMessageHandler).not.toBeNull();
    await capturedMessageHandler!({
      message: {
        channel_type: "im",
        user: "U_OWNER",
        text: "test message via handler",
        channel: "D_OWNER",
        ts: "1234",
      },
      say: vi.fn(),
    });
    expect(onMessage).toHaveBeenCalledTimes(1);

    fetchInfoSpy.mockRestore();
    vi.doUnmock("@slack/bolt");
    vi.resetModules();
  });

  it("falls back to app.client.auth.test when fetchBotInfo fails", async () => {
    const mockMessageFn = vi.fn();
    const mockStartFn = vi.fn().mockResolvedValue(undefined);
    const mockAuthTest = vi.fn().mockResolvedValue({ user_id: "FALLBACK_BOT" });

    vi.doMock("@slack/bolt", () => ({
      App: vi.fn().mockImplementation(() => ({
        message: mockMessageFn,
        start: mockStartFn,
        stop: vi.fn().mockResolvedValue(undefined),
        client: { auth: { test: mockAuthTest } },
      })),
    }));
    vi.resetModules();

    const { SlackAdapter: FreshSlack } = await import("./slack-adapter.js");
    const fetchInfoSpy = vi
      .spyOn(FreshSlack, "fetchBotInfo")
      .mockRejectedValue(new Error("auth.test failed"));

    const adapter = new FreshSlack({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: null,
      onMessage: vi.fn(),
    });

    await adapter.start();

    expect(mockAuthTest).toHaveBeenCalledTimes(1);
    expect((adapter as unknown as { botUserId: string | null }).botUserId).toBe("FALLBACK_BOT");

    fetchInfoSpy.mockRestore();
    vi.doUnmock("@slack/bolt");
    vi.resetModules();
  });
});

describe("SlackAdapter sendMessage with attachments", () => {
  it("uploads files via 3-step API: getUploadURLExternal + PUT + completeUploadExternal", async () => {
    fsOverrides.readFileSync = () => Buffer.from("file-content");
    const adapter = makeAdapter({ ownerUserId: "U_OWNER" });

    const mockUpload = vi.fn().mockResolvedValue({ upload_url: "https://upload.slack.test/upload", file_id: "F123" });
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
    const mockComplete = vi.fn().mockResolvedValue({ ok: true, files: [{ id: "F123" }] });

    const mockApp = {
      client: {
        files: {
          getUploadURLExternal: mockUpload,
          completeUploadExternal: mockComplete,
        },
      },
    };
    (adapter as unknown as { app: unknown }).app = mockApp;

    const result = await adapter.sendMessage({
      channel: "D_OWNER",
      text: "with file",
      attachments: [
        makeOutboundAttachment({ originalFilename: "test.png" }),
      ],
    });

    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(result.messageId).toBe("F123");

    fsOverrides.readFileSync = undefined;
    mockFetch.mockRestore();
  });

  it("skips file when getUploadURLExternal returns no upload_url", async () => {
    fsOverrides.readFileSync = () => Buffer.from("file-content");
    const adapter = makeAdapter({ ownerUserId: "U_OWNER" });

    const mockUpload = vi.fn().mockResolvedValue({ ok: true }); // no upload_url
    const mockApp = {
      client: {
        files: {
          getUploadURLExternal: mockUpload,
          completeUploadExternal: vi.fn(),
        },
      },
    };
    (adapter as unknown as { app: unknown }).app = mockApp;

    const result = await adapter.sendMessage({
      channel: "D_OWNER",
      text: "test",
      attachments: [makeOutboundAttachment()],
    });

    expect(result.messageId).toBeUndefined();
    fsOverrides.readFileSync = undefined;
  });

  it("catches per-attachment errors and continues to next attachment", async () => {
    fsOverrides.readFileSync = () => Buffer.from("file-content");
    const adapter = makeAdapter({ ownerUserId: "U_OWNER" });

    const mockUpload = vi.fn().mockRejectedValue(new Error("network error"));
    const mockApp = {
      client: {
        files: {
          getUploadURLExternal: mockUpload,
          completeUploadExternal: vi.fn(),
        },
      },
    };
    (adapter as unknown as { app: unknown }).app = mockApp;

    // Should not throw even though the upload failed
    await expect(
      adapter.sendMessage({
        channel: "D_OWNER",
        text: "test",
        attachments: [makeOutboundAttachment()],
      }),
    ).resolves.not.toThrow();

    fsOverrides.readFileSync = undefined;
  });

  it("returns undefined messageId when result.ts is absent (text-only path)", async () => {
    const adapter = makeAdapter({ ownerUserId: "U_OWNER" });
    const mockApp = {
      client: {
        chat: {
          postMessage: vi.fn().mockResolvedValue({}), // no ts
        },
      },
    };
    (adapter as unknown as { app: unknown }).app = mockApp;

    const result = await adapter.sendMessage({
      channel: "D_OWNER",
      text: "hello",
    });

    expect(result.messageId).toBeUndefined();
  });
});

describe("SlackAdapter resolveUserChannel with null result", () => {
  it("returns null when result.channel.id is undefined", async () => {
    const adapter = makeAdapter({ ownerUserId: "U_OWNER" });
    const mockApp = {
      client: {
        conversations: {
          open: vi.fn().mockResolvedValue({ channel: {} }), // no .id
        },
      },
    };
    (adapter as unknown as { app: unknown }).app = mockApp;

    const result = await adapter.resolveUserChannel();
    expect(result).toBeNull();
  });
});

describe("SlackAdapter handleMessage with files and attachmentStore", () => {
  it("triggers downloadAndEmitSlackMessage asynchronously when files are present", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: "U_OWNER",
      onMessage,
      attachmentStore: store,
    });
    (adapter as unknown as { botUserId: string }).botUserId = "BOT";

    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    // Spy on downloadAndEmitSlackMessage to detect it was called
    let downloadCalled = false;
    const original = (adapter as unknown as {
      downloadAndEmitSlackMessage: (...args: unknown[]) => Promise<void>;
    }).downloadAndEmitSlackMessage.bind(adapter);
    (adapter as unknown as { downloadAndEmitSlackMessage: (...args: unknown[]) => Promise<void> }).downloadAndEmitSlackMessage = async (...args) => {
      downloadCalled = true;
      return original(...args);
    };

    (adapter as unknown as { handleMessage: (msg: unknown) => void }).handleMessage({
      channel_type: "im",
      user: "U_OWNER",
      text: "here is a file",
      channel: "D_OWNER",
      ts: "1234.5678",
      files: [
        {
          size: 10,
          mimetype: "image/png",
          name: "test.png",
          url_private_download: "https://files.slack.test/test.png",
        },
      ],
    });

    // The async path is launched with void — wait for it
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(downloadCalled).toBe(true);
    mockFetch.mockRestore();
  });
});

describe("SlackAdapter downloadAndEmitSlackMessage edge cases", () => {
  it("skips null/non-object items in files array", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: "U_OWNER",
      onMessage,
      attachmentStore: store,
    });

    await (adapter as unknown as {
      downloadAndEmitSlackMessage: (
        message: unknown, senderId: string, text: string,
        isDm: boolean, isMention: boolean, files: unknown[],
      ) => Promise<void>;
    }).downloadAndEmitSlackMessage(
      { channel: "D_OWNER", ts: "1" },
      "U_OWNER",
      "text",
      true,
      false,
      [null, "string-not-object", 42], // all non-objects
    );

    expect(store.ingestStream).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("resolves file via files.info when file_access === 'check_file_info'", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: "U_OWNER",
      onMessage,
      attachmentStore: store,
    });

    const resolvedFile = {
      size: 10,
      mimetype: "image/png",
      name: "resolved.png",
      url_private_download: "https://files.slack.test/resolved.png",
    };
    const mockFilesInfo = vi.fn().mockResolvedValue({ file: resolvedFile });
    (adapter as unknown as { app: unknown }).app = {
      client: {
        files: { info: mockFilesInfo },
      },
    };

    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as {
      downloadAndEmitSlackMessage: (
        message: unknown, senderId: string, text: string,
        isDm: boolean, isMention: boolean, files: unknown[],
      ) => Promise<void>;
    }).downloadAndEmitSlackMessage(
      { channel: "D_OWNER", ts: "1" },
      "U_OWNER",
      "text",
      true,
      false,
      [
        { file_access: "check_file_info", id: "F_CHECK", name: "original.png" },
      ],
    );

    expect(mockFilesInfo).toHaveBeenCalledTimes(1);
    expect(store.ingestStream).toHaveBeenCalledWith(
      expect.objectContaining({ originalFilename: "resolved.png" }),
    );

    mockFetch.mockRestore();
  });

  it("continues with original file when files.info throws", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: "U_OWNER",
      onMessage,
      attachmentStore: store,
    });

    const mockFilesInfo = vi.fn().mockRejectedValue(new Error("access denied"));
    (adapter as unknown as { app: unknown }).app = {
      client: {
        files: { info: mockFilesInfo },
      },
    };

    // The original file has a download url so we can continue
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as {
      downloadAndEmitSlackMessage: (
        message: unknown, senderId: string, text: string,
        isDm: boolean, isMention: boolean, files: unknown[],
      ) => Promise<void>;
    }).downloadAndEmitSlackMessage(
      { channel: "D_OWNER", ts: "1" },
      "U_OWNER",
      "text",
      true,
      false,
      [
        {
          file_access: "check_file_info",
          id: "F_CHECK",
          name: "fallback.png",
          size: 10,
          mimetype: "image/png",
          url_private_download: "https://files.slack.test/fallback.png",
        },
      ],
    );

    expect(mockFilesInfo).toHaveBeenCalledTimes(1);
    // Should still ingest the original file
    expect(store.ingestStream).toHaveBeenCalledWith(
      expect.objectContaining({ originalFilename: "fallback.png" }),
    );

    mockFetch.mockRestore();
  });

  it("skips file when fileSize exceeds SLACK_INBOUND_MAX_BYTES", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: "U_OWNER",
      onMessage,
      attachmentStore: store,
    });

    await (adapter as unknown as {
      downloadAndEmitSlackMessage: (
        message: unknown, senderId: string, text: string,
        isDm: boolean, isMention: boolean, files: unknown[],
      ) => Promise<void>;
    }).downloadAndEmitSlackMessage(
      { channel: "D_OWNER", ts: "1" },
      "U_OWNER",
      "text",
      true,
      false,
      [
        {
          size: 25 * 1024 * 1024 + 1, // exceeds 25 MB cap
          mimetype: "video/mp4",
          name: "huge.mp4",
          url_private_download: "https://files.slack.test/huge.mp4",
        },
      ],
    );

    expect(store.ingestStream).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledTimes(1); // event emitted without attachments
  });

  it("skips file when no downloadUrl is available", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: "U_OWNER",
      onMessage,
      attachmentStore: store,
    });

    await (adapter as unknown as {
      downloadAndEmitSlackMessage: (
        message: unknown, senderId: string, text: string,
        isDm: boolean, isMention: boolean, files: unknown[],
      ) => Promise<void>;
    }).downloadAndEmitSlackMessage(
      { channel: "D_OWNER", ts: "1" },
      "U_OWNER",
      "text",
      true,
      false,
      [
        {
          size: 10,
          mimetype: "image/png",
          name: "no-url.png",
          // no url_private_download or url_private
        },
      ],
    );

    expect(store.ingestStream).not.toHaveBeenCalled();
  });

  it("uses url_private as fallback when url_private_download is absent", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: "U_OWNER",
      onMessage,
      attachmentStore: store,
    });

    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as {
      downloadAndEmitSlackMessage: (
        message: unknown, senderId: string, text: string,
        isDm: boolean, isMention: boolean, files: unknown[],
      ) => Promise<void>;
    }).downloadAndEmitSlackMessage(
      { channel: "D_OWNER", ts: "1" },
      "U_OWNER",
      "text",
      true,
      false,
      [
        {
          size: 10,
          mimetype: "image/png",
          name: "private.png",
          url_private: "https://files.slack.test/private.png", // fallback
          // no url_private_download
        },
      ],
    );

    expect(store.ingestStream).toHaveBeenCalledTimes(1);
    // Verify the fetch was called with the url_private URL
    expect(mockFetch).toHaveBeenCalledWith(
      "https://files.slack.test/private.png",
      expect.anything(),
    );

    mockFetch.mockRestore();
  });

  it("skips file when fetch returns non-ok response", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: "U_OWNER",
      onMessage,
      attachmentStore: store,
    });

    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("forbidden", { status: 403 }),
    );

    await (adapter as unknown as {
      downloadAndEmitSlackMessage: (
        message: unknown, senderId: string, text: string,
        isDm: boolean, isMention: boolean, files: unknown[],
      ) => Promise<void>;
    }).downloadAndEmitSlackMessage(
      { channel: "D_OWNER", ts: "1" },
      "U_OWNER",
      "text",
      true,
      false,
      [
        {
          size: 10,
          mimetype: "image/png",
          name: "test.png",
          url_private_download: "https://files.slack.test/test.png",
        },
      ],
    );

    expect(store.ingestStream).not.toHaveBeenCalled();
    mockFetch.mockRestore();
  });

  it("catches and continues when ingestStream throws", async () => {
    const onMessage = vi.fn();
    const store = {
      ingestStream: vi.fn().mockRejectedValue(new Error("disk full")),
    } as unknown as AttachmentStore;
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: "U_OWNER",
      onMessage,
      attachmentStore: store,
    });

    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as {
      downloadAndEmitSlackMessage: (
        message: unknown, senderId: string, text: string,
        isDm: boolean, isMention: boolean, files: unknown[],
      ) => Promise<void>;
    }).downloadAndEmitSlackMessage(
      { channel: "D_OWNER", ts: "1" },
      "U_OWNER",
      "text",
      true,
      false,
      [
        {
          size: 10,
          mimetype: "image/png",
          name: "test.png",
          url_private_download: "https://files.slack.test/test.png",
        },
      ],
    );

    // Event still emitted even though ingest failed
    expect(onMessage).toHaveBeenCalledTimes(1);
    mockFetch.mockRestore();
  });
});

describe("SlackAdapter start() fallback: auth.test user_id absent (null branch)", () => {
  it("sets botUserId to null when auth.test returns no user_id", async () => {
    const mockMessageFn = vi.fn();
    const mockStartFn = vi.fn().mockResolvedValue(undefined);
    const mockAuthTest = vi.fn().mockResolvedValue({}); // no user_id

    vi.doMock("@slack/bolt", () => ({
      App: vi.fn().mockImplementation(() => ({
        message: mockMessageFn,
        start: mockStartFn,
        stop: vi.fn().mockResolvedValue(undefined),
        client: { auth: { test: mockAuthTest } },
      })),
    }));
    vi.resetModules();

    const { SlackAdapter: FreshSlack } = await import("./slack-adapter.js");
    const fetchInfoSpy = vi
      .spyOn(FreshSlack, "fetchBotInfo")
      .mockRejectedValue(new Error("auth failed"));

    const adapter = new FreshSlack({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: null,
      onMessage: vi.fn(),
    });

    await adapter.start();

    // user_id was absent → botUserId should be null
    expect((adapter as unknown as { botUserId: string | null }).botUserId).toBeNull();

    fetchInfoSpy.mockRestore();
    vi.doUnmock("@slack/bolt");
    vi.resetModules();
  });
});

describe("SlackAdapter downloadAndEmitSlackMessage: resolvedFile.name fallback branch", () => {
  it("uses 'file' fallback when resolvedFile has no name", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: "U_OWNER",
      onMessage,
      attachmentStore: store,
    });

    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as {
      downloadAndEmitSlackMessage: (
        message: unknown, senderId: string, text: string,
        isDm: boolean, isMention: boolean, files: unknown[],
      ) => Promise<void>;
    }).downloadAndEmitSlackMessage(
      { channel: "D_OWNER", ts: "1" },
      "U_OWNER",
      "text",
      true,
      false,
      [
        {
          size: 10,
          mimetype: "image/png",
          // name is absent — should fallback to "file"
          url_private_download: "https://files.slack.test/noname.png",
        },
      ],
    );

    expect(store.ingestStream).toHaveBeenCalledWith(
      expect.objectContaining({ originalFilename: "file" }),
    );

    mockFetch.mockRestore();
  });
});

describe("SlackAdapter emitSlackEvent: EventPriority.LOW branch and channel ?? '' branch", () => {
  it("uses EventPriority.LOW when isDm and isMention are both false (direct call to emitSlackEvent)", () => {
    const onMessage = vi.fn();
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: "U_OWNER",
      onMessage,
    });

    // Call emitSlackEvent directly to reach the EventPriority.LOW branch
    (adapter as unknown as {
      emitSlackEvent: (
        message: unknown, senderId: string, text: string,
        isDm: boolean, isMention: boolean, attachments: unknown[],
      ) => void;
    }).emitSlackEvent(
      { channel: "C_PUBLIC", ts: "1", team: "T1", thread_ts: null },
      "U_OWNER",
      "some text",
      false, // not DM
      false, // not mention
      [],
    );

    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("uses empty string for channel when message.channel is absent", () => {
    const onMessage = vi.fn();
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: "U_OWNER",
      onMessage,
    });

    // Call emitSlackEvent with no channel to exercise the ?? '' right branch
    (adapter as unknown as {
      emitSlackEvent: (
        message: unknown, senderId: string, text: string,
        isDm: boolean, isMention: boolean, attachments: unknown[],
      ) => void;
    }).emitSlackEvent(
      { ts: "1" }, // no channel
      "U_OWNER",
      "text",
      true,
      false,
      [],
    );

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].channel).toBe("");
  });
});

describe("SlackAdapter handleMessage: message.user and message.text fallback branches", () => {
  it("uses 'unknown' as senderId when message.user is absent", () => {
    const onMessage = vi.fn();
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: "unknown", // must match the fallback 'unknown' to pass owner filter
      onMessage,
    });

    (adapter as unknown as { handleMessage: (msg: unknown) => void }).handleMessage({
      channel_type: "im",
      // user is absent → senderId becomes "unknown"
      text: "hello",
      channel: "D_OWNER",
      ts: "1",
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].sender).toBe("unknown");
  });

  it("uses '' for text when message.text is not a string", () => {
    const onMessage = vi.fn();
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: "U_OWNER",
      onMessage,
    });

    (adapter as unknown as { handleMessage: (msg: unknown) => void }).handleMessage({
      channel_type: "im",
      user: "U_OWNER",
      text: 42, // not a string → falls back to ""
      channel: "D_OWNER",
      ts: "1",
    });

    // Empty text should still emit event (text is "" not undefined)
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].content).toBe("");
  });
});

describe("SlackAdapter downloadAndEmitSlackMessage: size and mimetype ?? branches", () => {
  it("uses 0 for fileSize and null for mimetype when both are absent", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = new SlackAdapter({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      ownerUserId: "U_OWNER",
      onMessage,
      attachmentStore: store,
    });

    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    await (adapter as unknown as {
      downloadAndEmitSlackMessage: (
        message: unknown, senderId: string, text: string,
        isDm: boolean, isMention: boolean, files: unknown[],
      ) => Promise<void>;
    }).downloadAndEmitSlackMessage(
      { channel: "D_OWNER", ts: "1" },
      "U_OWNER",
      "text",
      true,
      false,
      [
        {
          // no size, no mimetype — exercises the ?? 0 and ?? null branches
          name: "no-meta.bin",
          url_private_download: "https://files.slack.test/no-meta.bin",
        },
      ],
    );

    // Should successfully ingest with declaredMimeType: null
    expect(store.ingestStream).toHaveBeenCalledWith(
      expect.objectContaining({ declaredMimeType: null }),
    );

    mockFetch.mockRestore();
  });
});

describe("SlackAdapter.fetchBotInfo: null-coalescing right branches", () => {
  it("uses 'unknown' fallback when body.error is absent", async () => {
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: false }), // no error field
        { status: 200 },
      ),
    );

    await expect(SlackAdapter.fetchBotInfo("bad-token")).rejects.toThrow(
      "Slack auth.test failed: unknown",
    );
    mockFetch.mockRestore();
  });

  it("returns null for optional fields when absent from successful response", async () => {
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: true }), // no user_id, user, team, url
        { status: 200 },
      ),
    );

    const info = await SlackAdapter.fetchBotInfo("xoxb-fake");
    expect(info.botUserId).toBeNull();
    expect(info.botName).toBeNull();
    expect(info.team).toBeNull();
    expect(info.url).toBeNull();
    mockFetch.mockRestore();
  });
});

describe("SlackAdapter sendMessage: second attachment has no initial_comment, lastTs fallback", () => {
  it("sends two attachments: second has no initial_comment, lastTs keeps last file id", async () => {
    fsOverrides.readFileSync = () => Buffer.from("file-content");
    const adapter = makeAdapter({ ownerUserId: "U_OWNER" });

    let completeCallCount = 0;
    const mockUpload = vi.fn().mockResolvedValue({ upload_url: "https://upload.slack.test/upload", file_id: "F_ID" });
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
    const mockComplete = vi.fn().mockImplementation(async () => {
      completeCallCount++;
      // First call returns a file id, second call returns no files array
      if (completeCallCount === 1) {
        return { ok: true, files: [{ id: "FILE_1" }] };
      }
      return { ok: true }; // no files → triggers ?? lastTs fallback
    });

    const mockApp = {
      client: {
        files: {
          getUploadURLExternal: mockUpload,
          completeUploadExternal: mockComplete,
        },
      },
    };
    (adapter as unknown as { app: unknown }).app = mockApp;

    const result = await adapter.sendMessage({
      channel: "D_OWNER",
      text: "two files",
      attachments: [
        makeOutboundAttachment({ id: "a1", originalFilename: "f1.png" }),
        makeOutboundAttachment({ id: "a2", originalFilename: "f2.png" }),
      ],
    });

    // Second complete call had no files → lastTs falls back to FILE_1
    expect(result.messageId).toBe("FILE_1");
    // Verify second call had no initial_comment
    const secondCompleteArgs = mockComplete.mock.calls[1][0];
    expect(secondCompleteArgs.initial_comment).toBeUndefined();

    fsOverrides.readFileSync = undefined;
    mockFetch.mockRestore();
  });
});

describe("SlackAdapter getConnectionState (watchdog probe)", () => {
  type Internals = { app: unknown; startCompleted: boolean };

  function makeStartedAdapter(receiver: unknown) {
    const adapter = makeAdapter();
    const internals = adapter as unknown as Internals;
    internals.app = { receiver };
    internals.startCompleted = true;
    return adapter;
  }

  it("reports unknown before start() completes", () => {
    const adapter = makeAdapter();
    expect(adapter.getConnectionState()).toBe("unknown");
    // App assigned but start() not yet resolved — still unknown.
    (adapter as unknown as Internals).app = { receiver: {} };
    expect(adapter.getConnectionState()).toBe("unknown");
  });

  it("reports ok while the socket-mode websocket is active", () => {
    const adapter = makeStartedAdapter({
      client: { websocket: { isActive: () => true } },
    });
    expect(adapter.getConnectionState()).toBe("ok");
  });

  it("reports down when the socket-mode websocket is dead", () => {
    const adapter = makeStartedAdapter({
      client: { websocket: { isActive: () => false } },
    });
    expect(adapter.getConnectionState()).toBe("down");
  });

  it("degrades to unknown when Bolt internals are not introspectable", () => {
    // A Bolt upgrade that changes the receiver shape must NOT read as
    // "down" — that would put the watchdog into a restart loop.
    expect(makeStartedAdapter(undefined).getConnectionState()).toBe("unknown");
    expect(makeStartedAdapter({}).getConnectionState()).toBe("unknown");
    expect(
      makeStartedAdapter({ client: { websocket: {} } }).getConnectionState(),
    ).toBe("unknown");
  });

  it("degrades to unknown when isActive() throws", () => {
    const adapter = makeStartedAdapter({
      client: {
        websocket: {
          isActive: () => {
            throw new Error("socket gone");
          },
        },
      },
    });
    expect(adapter.getConnectionState()).toBe("unknown");
  });
});
