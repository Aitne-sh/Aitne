import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@aitne/shared";
import type { AttachmentStore } from "../services/attachments/store.js";
import {
  WhatsAppAdapter,
  extractWhatsAppText,
  toWhatsAppJid,
} from "./whatsapp-adapter.js";

// These mocks intercept the dynamic imports inside loadDependencies() and ensureAuthState().
// vi.mock() is hoisted to the top of the file by Vitest's transformer.
// The mock is configurable per-test via vi.mocked().mockReturnValue() etc.
vi.mock("@whiskeysockets/baileys", () => {
  const fakeSock = {
    ev: { on: vi.fn(), removeAllListeners: vi.fn() },
    ws: { close: vi.fn() },
    end: vi.fn(),
  };
  return {
    default: vi.fn().mockReturnValue(fakeSock),
    useMultiFileAuthState: vi.fn().mockResolvedValue({
      state: { creds: { me: { lid: "123:9@lid" } } },
      saveCreds: vi.fn().mockResolvedValue(undefined),
    }),
    DisconnectReason: { loggedOut: 401 },
    fetchLatestWaWebVersion: vi.fn().mockResolvedValue({ version: [2, 9999, 1], isLatest: true }),
    fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 1234, 5], isLatest: true }),
    generateMessageID: vi.fn().mockReturnValue("mock-msg-id"),
    generateMessageIDV2: undefined, // test the fallback chain
    downloadMediaMessage: vi.fn().mockResolvedValue(Buffer.from([1, 2, 3])),
  };
});
vi.mock("qrcode-terminal", () => ({
  default: { generate: vi.fn() },
}));
vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,MOCK"),
  },
}));

/**
 * Shared shape used to poke at the adapter's private fields. Centralised so
 * the field-name set is one place to update if the adapter is refactored.
 */
type AdapterInternals = {
  fetchLatestWaWebVersion: ((options?: unknown) => Promise<unknown>) | null;
  fetchLatestBaileysVersion: ((options?: unknown) => Promise<unknown>) | null;
  cachedWAVersion: number[] | null;
  cachedWAVersionAt: number;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  lastCloseWasNetwork: boolean;
  reconnecting: boolean;
  dnsLookup: (hostname: string) => Promise<unknown>;
  connectionState: string;
  loggedOutCode: number | null;
  lastError: string | null;
  shuttingDown: boolean;
  resolveWAVersion: () => Promise<number[] | undefined>;
  invalidateWAVersionCache: () => void;
  scheduleReconnect: () => void;
  runReconnectAttempt: (sustained: boolean) => Promise<void>;
  isNetworkReachable: () => Promise<boolean>;
  connect: () => Promise<void>;
  handleConnectionUpdate: (update: unknown, sock: unknown) => Promise<void>;
  closeSocket: () => void;
  sock: unknown;
  ownerLidRecipient: string | null;
  authState: {
    state: {
      creds?: {
        me?: {
          lid?: string;
        };
      };
    };
    saveCreds: () => Promise<void>;
  } | null;
};

function asInternals(adapter: WhatsAppAdapter): AdapterInternals {
  return adapter as unknown as AdapterInternals;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fakeAttachmentStore() {
  return {
    ingestStream: vi.fn().mockImplementation(async (params: { originalFilename: string; declaredMimeType: string | null; caption?: string }) => ({
      id: "att-wa",
      path: `/tmp/${params.originalFilename}`,
      originalFilename: params.originalFilename,
      safeFilename: params.originalFilename,
      mimeType: params.declaredMimeType ?? "application/octet-stream",
      sizeBytes: 12,
      caption: params.caption,
    })),
  } as unknown as AttachmentStore;
}

function createAdapter(
  onMessage: (event: Event) => void = vi.fn(),
  attachmentStore?: AttachmentStore,
): WhatsAppAdapter {
  const authDir = mkdtempSync(join(tmpdir(), "personal-agent-whatsapp-test-"));
  return new WhatsAppAdapter({
    ownerPhone: "+818012345678",
    authDir,
    onMessage,
    ...(attachmentStore ? { attachmentStore } : {}),
  });
}

describe("WhatsAppAdapter", () => {
  it("derives the owner JID from an E.164 phone number", () => {
    expect(toWhatsAppJid("+818012345678")).toBe("818012345678@s.whatsapp.net");
  });

  it("rejects invalid owner phone numbers", () => {
    expect(() => toWhatsAppJid("08012345678")).toThrow("Invalid WhatsApp owner phone");
  });

  it("extracts text from supported WhatsApp message payloads", () => {
    expect(extractWhatsAppText({ conversation: "hello" })).toBe("hello");
    expect(
      extractWhatsAppText({ extendedTextMessage: { text: "hello again" } }),
    ).toBe("hello again");
    expect(
      extractWhatsAppText({
        ephemeralMessage: {
          message: { conversation: "wrapped hello" },
        },
      }),
    ).toBe("wrapped hello");
    expect(extractWhatsAppText({ imageMessage: { caption: "ignored" } })).toBeNull();
  });

  it("emits an owner DM as a MessageEvent", () => {
    const onMessage = vi.fn();
    const adapter = createAdapter(onMessage);

    (adapter as unknown as { handleMessagesUpsert: (payload: unknown) => void }).handleMessagesUpsert({
      messages: [
        {
          key: {
            id: "wamid-1",
            remoteJid: "818012345678@s.whatsapp.net",
            fromMe: false,
          },
          message: {
            conversation: "hello",
          },
        },
      ],
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    const event = onMessage.mock.calls[0][0] as Event & {
      sender: string;
      channel: string;
      content: string;
      platform: string;
      isDm: boolean;
      isMention: boolean;
      threadId: string | null;
    };
    expect(event.sender).toBe("818012345678@s.whatsapp.net");
    expect(event.channel).toBe("818012345678@s.whatsapp.net");
    expect(event.content).toBe("hello");
    expect(event.platform).toBe("whatsapp");
    expect(event.isDm).toBe(true);
    expect(event.isMention).toBe(false);
    expect(event.threadId).toBeNull();
  });

  it("drops messages from non-owner JIDs", () => {
    const onMessage = vi.fn();
    const adapter = createAdapter(onMessage);

    (adapter as unknown as { handleMessagesUpsert: (payload: unknown) => void }).handleMessagesUpsert({
      messages: [
        {
          key: {
            id: "wamid-2",
            remoteJid: "15550001111@s.whatsapp.net",
            fromMe: false,
          },
          message: {
            conversation: "hello",
          },
        },
      ],
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("drops group messages", () => {
    const onMessage = vi.fn();
    const adapter = createAdapter(onMessage);

    (adapter as unknown as { handleMessagesUpsert: (payload: unknown) => void }).handleMessagesUpsert({
      messages: [
        {
          key: {
            id: "wamid-3",
            remoteJid: "12345@g.us",
            fromMe: false,
          },
          message: {
            conversation: "hello",
          },
        },
      ],
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("drops the daemon's own outbound echo (id is in the sent set)", () => {
    const onMessage = vi.fn();
    const adapter = createAdapter(onMessage);

    // Simulate the daemon having just sent a reply with this id — the
    // matching `messages.upsert` echo Baileys emits via process.nextTick
    // must NOT be re-ingested as a fresh user message.
    (adapter as unknown as { rememberSentMessageId: (id: string) => void }).rememberSentMessageId(
      "echo-id-1",
    );

    (adapter as unknown as { handleMessagesUpsert: (payload: unknown) => void }).handleMessagesUpsert({
      messages: [
        {
          key: {
            id: "echo-id-1",
            remoteJid: "818012345678@s.whatsapp.net",
            fromMe: true,
          },
          message: { conversation: "this is the daemon's own reply echoing back" },
        },
      ],
    });

    expect(onMessage).not.toHaveBeenCalled();
    // The id should have been consumed (deleted) so a future redelivery
    // wouldn't accidentally re-trigger the dedup path.
    const sent = (adapter as unknown as { sentMessageIds: Set<string> }).sentMessageIds;
    expect(sent.has("echo-id-1")).toBe(false);
  });

  it("ingests a self-DM (fromMe:true) when the id is NOT in the sent set", () => {
    const onMessage = vi.fn();
    const adapter = createAdapter(onMessage);

    // The owner sends a message from their phone to themselves. Baileys
    // marks it `fromMe:true` (the owner's account is the sender), but the
    // id was generated by the phone, not by the daemon — so it must be
    // accepted as a real user-initiated message.
    (adapter as unknown as { handleMessagesUpsert: (payload: unknown) => void }).handleMessagesUpsert({
      messages: [
        {
          key: {
            id: "phone-generated-id",
            remoteJid: "818012345678@s.whatsapp.net",
            fromMe: true,
          },
          message: { conversation: "hello from my phone" },
        },
      ],
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    const event = onMessage.mock.calls[0][0] as Event & { content: string; channel: string; isDm: boolean };
    expect(event.content).toBe("hello from my phone");
    expect(event.channel).toBe("818012345678@s.whatsapp.net");
    expect(event.isDm).toBe(true);
  });

  it("ingests a self-DM addressed to the owner's LID", () => {
    const onMessage = vi.fn();
    const adapter = createAdapter(onMessage);

    // Baileys logs the linked-device identity as `<opaque>:<device>@lid`.
    // Incoming self-DMs can arrive on the chat JID without the device suffix,
    // so the adapter must normalize both before comparing.
    (adapter as unknown as AdapterInternals).authState = {
      state: {
        creds: {
          me: {
            lid: "138302929817841:9@lid",
          },
        },
      },
      saveCreds: async () => {},
    };

    (adapter as unknown as { handleMessagesUpsert: (payload: unknown) => void }).handleMessagesUpsert({
      messages: [
        {
          key: {
            id: "lid-self-dm",
            remoteJid: "138302929817841@lid",
            fromMe: true,
          },
          message: { conversation: "hello via lid" },
        },
      ],
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    const event = onMessage.mock.calls[0][0] as Event & { content: string; channel: string; isDm: boolean };
    expect(event.content).toBe("hello via lid");
    expect(event.channel).toBe("818012345678@s.whatsapp.net");
    expect(event.isDm).toBe(true);
  });

  it("drops fromMe messages addressed to other people (not self-DMs)", () => {
    const onMessage = vi.fn();
    const adapter = createAdapter(onMessage);

    // Owner sends a message from their phone to a different contact.
    // fromMe is true, but the remoteJid is NOT the owner's own JID, so
    // the unauthorized-sender filter must reject it.
    (adapter as unknown as { handleMessagesUpsert: (payload: unknown) => void }).handleMessagesUpsert({
      messages: [
        {
          key: {
            id: "outbound-to-friend",
            remoteJid: "15550009999@s.whatsapp.net",
            fromMe: true,
          },
          message: { conversation: "hi friend" },
        },
      ],
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("drops media-only messages", () => {
    const onMessage = vi.fn();
    const adapter = createAdapter(onMessage);

    (adapter as unknown as { handleMessagesUpsert: (payload: unknown) => void }).handleMessagesUpsert({
      messages: [
        {
          key: {
            id: "wamid-5",
            remoteJid: "818012345678@s.whatsapp.net",
            fromMe: false,
          },
          message: {
            imageMessage: {},
          },
        },
      ],
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("ingests owner audio messages as attachments", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = createAdapter(onMessage, store);
    const downloadMediaMessage = vi.fn().mockResolvedValue(Buffer.from([1, 2, 3]));
    (adapter as unknown as { downloadMediaMessage: typeof downloadMediaMessage }).downloadMediaMessage =
      downloadMediaMessage;

    await (adapter as unknown as { handleIncomingMessage: (message: unknown) => Promise<void> }).handleIncomingMessage({
      key: {
        id: "wa-audio-1",
        remoteJid: "818012345678@s.whatsapp.net",
        fromMe: false,
      },
      message: {
        audioMessage: {
          mimetype: "audio/ogg",
          fileLength: { toString: () => "3" },
        },
      },
    });

    expect(downloadMediaMessage).toHaveBeenCalled();
    expect(store.ingestStream).toHaveBeenCalledWith(
      expect.objectContaining({
        declaredMimeType: "audio/ogg",
        originalFilename: "audio.ogg",
        maxSizeBytes: 16 * 1024 * 1024,
      }),
    );
    expect(onMessage).toHaveBeenCalledTimes(1);
    const event = onMessage.mock.calls[0][0] as Event & { attachments?: unknown[] };
    expect(event.attachments).toHaveLength(1);
  });

  it("ingests owner video messages as attachments", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = createAdapter(onMessage, store);
    const downloadMediaMessage = vi.fn().mockResolvedValue(Buffer.from([1, 2, 3]));
    (adapter as unknown as { downloadMediaMessage: typeof downloadMediaMessage }).downloadMediaMessage =
      downloadMediaMessage;

    await (adapter as unknown as { handleIncomingMessage: (message: unknown) => Promise<void> }).handleIncomingMessage({
      key: {
        id: "wa-video-1",
        remoteJid: "818012345678@s.whatsapp.net",
        fromMe: false,
      },
      message: {
        videoMessage: {
          mimetype: "video/mp4",
          fileLength: { toString: () => "3" },
          caption: "clip",
        },
      },
    });

    expect(downloadMediaMessage).toHaveBeenCalled();
    expect(store.ingestStream).toHaveBeenCalledWith(
      expect.objectContaining({
        declaredMimeType: "video/mp4",
        originalFilename: "video.mp4",
        caption: "clip",
        maxSizeBytes: 16 * 1024 * 1024,
      }),
    );
    expect(onMessage).toHaveBeenCalledTimes(1);
    const event = onMessage.mock.calls[0][0] as Event & { attachments?: unknown[] };
    expect(event.attachments).toHaveLength(1);
  });

  it("ignores owner stickers without sending an unsupported-media reply", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = createAdapter(onMessage, store);
    const sendMessage = vi.fn();
    const internals = adapter as unknown as {
      sock: { sendMessage: typeof sendMessage };
      connectionState: string;
      downloadMediaMessage: (message: unknown, type: "buffer") => Promise<Buffer>;
      handleIncomingMessage: (message: unknown) => Promise<void>;
    };
    internals.sock = { sendMessage };
    internals.connectionState = "ok";
    internals.downloadMediaMessage = vi.fn().mockResolvedValue(Buffer.from([1, 2, 3]));

    await internals.handleIncomingMessage({
      key: {
        id: "wa-sticker-1",
        remoteJid: "818012345678@s.whatsapp.net",
        fromMe: false,
      },
      message: {
        stickerMessage: {
          mimetype: "image/webp",
          fileLength: 10,
        },
      },
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(store.ingestStream).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("sends outbound messages in chunks", async () => {
    const adapter = createAdapter();
    const sendMessage = vi.fn().mockResolvedValue(undefined);

    const mutableAdapter = adapter as unknown as {
      sock: { sendMessage: typeof sendMessage };
      connectionState: string;
      generateMessageId: (() => string) | null;
    };
    mutableAdapter.sock = { sendMessage };
    mutableAdapter.connectionState = "ok";
    // Provide a deterministic id generator so we can assert the
    // pre-registration path AND the third arg to sock.sendMessage.
    let counter = 0;
    mutableAdapter.generateMessageId = () => `pre-id-${++counter}`;

    await adapter.sendMessage({
      channel: "818012345678@s.whatsapp.net",
      text: `first line\n${"x".repeat(4500)}`,
    });

    expect(sendMessage.mock.calls.length).toBeGreaterThan(1);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      "818012345678@s.whatsapp.net",
      expect.objectContaining({ text: expect.any(String) }),
      expect.objectContaining({ messageId: "pre-id-1" }),
    );
    expect(
      sendMessage.mock.calls
        .map(([, payload]) => (payload as { text: string }).text)
        .join(""),
    ).toContain("first line");
  });

  it("keeps WhatsApp in composing state while processing and pauses on stop", async () => {
    vi.useFakeTimers();

    const adapter = createAdapter();
    const sendPresenceUpdate = vi.fn().mockResolvedValue(undefined);
    const internals = adapter as unknown as {
      sock: { sendPresenceUpdate: typeof sendPresenceUpdate };
      connectionState: string;
    };
    internals.sock = { sendPresenceUpdate };
    internals.connectionState = "ok";

    const handle = await adapter.beginProcessingIndicator({
      channel: "818012345678@s.whatsapp.net",
    });

    expect(sendPresenceUpdate).toHaveBeenNthCalledWith(
      1,
      "composing",
      "818012345678@s.whatsapp.net",
    );

    await vi.advanceTimersByTimeAsync(8_000);

    expect(sendPresenceUpdate).toHaveBeenNthCalledWith(
      2,
      "composing",
      "818012345678@s.whatsapp.net",
    );

    await handle.stop();

    expect(sendPresenceUpdate).toHaveBeenLastCalledWith(
      "paused",
      "818012345678@s.whatsapp.net",
    );
  });

  it("registers each pre-generated id in the sent set BEFORE sock.sendMessage resolves", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      sock: { sendMessage: (...args: unknown[]) => Promise<unknown> };
      connectionState: string;
      generateMessageId: (() => string) | null;
      sentMessageIds: Set<string>;
    };

    // Capture the state of the sent-set at the moment Baileys would emit
    // its messages.upsert echo (i.e. WHILE sock.sendMessage is still
    // pending). The fix's correctness hinges on this snapshot containing
    // the id BEFORE the await resolves.
    let setSnapshotDuringSend: string[] = [];
    internals.sock = {
      sendMessage: async (_jid: unknown, _content: unknown, opts: unknown) => {
        setSnapshotDuringSend = Array.from(internals.sentMessageIds);
        return {
          key: {
            id: (opts as { messageId?: string } | undefined)?.messageId ?? "fallback-id",
            fromMe: true,
            remoteJid: "818012345678@s.whatsapp.net",
          },
        };
      },
    };
    internals.connectionState = "ok";
    internals.generateMessageId = () => "deterministic-id-A";

    const result = await adapter.sendMessage({
      channel: "818012345678@s.whatsapp.net",
      text: "short message",
    });

    expect(setSnapshotDuringSend).toContain("deterministic-id-A");
    expect(result.messageId).toBe("deterministic-id-A");
    expect(internals.sentMessageIds.has("deterministic-id-A")).toBe(true);
  });

  it("sendWhatsAppText: null ?? lastMessageId path (second chunk has null actualId, falls back to prior chunk id)", async () => {
    const adapter = createAdapter();
    let callCount = 0;
    const internals = adapter as unknown as {
      sock: { sendMessage: (...args: unknown[]) => Promise<unknown> };
      connectionState: string;
      generateMessageId: (() => string) | null;
    };
    internals.sock = {
      sendMessage: async () => {
        callCount++;
        if (callCount === 1) {
          // First chunk succeeds with an id
          return { key: { id: "chunk-1-id", fromMe: true, remoteJid: "818012345678@s.whatsapp.net" } };
        }
        // Second chunk has no id (null)
        return { key: { id: null, fromMe: true, remoteJid: "818012345678@s.whatsapp.net" } };
      },
    };
    internals.connectionState = "ok";
    internals.generateMessageId = null; // preId=null for both chunks

    // Long message to trigger 2 chunks
    const longText = "x".repeat(4500);
    const result = await adapter.sendMessage({
      channel: "818012345678@s.whatsapp.net",
      text: longText,
    });

    // First chunk set lastMessageId to "chunk-1-id"
    // Second chunk: actualId=null → preId=null → null ?? "chunk-1-id" = "chunk-1-id"
    expect(result.messageId).toBe("chunk-1-id");
    expect(callCount).toBeGreaterThan(1);
  });

  it("actualId not a string in sendWhatsAppText → uses preId (line 566 false branch)", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      sock: { sendMessage: (...args: unknown[]) => Promise<unknown> };
      connectionState: string;
      generateMessageId: (() => string) | null;
    };

    internals.sock = {
      sendMessage: async () => ({ key: { id: null, fromMe: true, remoteJid: "818012345678@s.whatsapp.net" } }),
    };
    internals.connectionState = "ok";
    internals.generateMessageId = () => "pre-text-id";

    const result = await adapter.sendMessage({
      channel: "818012345678@s.whatsapp.net",
      text: "short message",
    });

    // actualId is null → uses preId "pre-text-id"
    expect(result.messageId).toBe("pre-text-id");
  });

  it("falls back to the id Baileys returned if no pre-generator is wired", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      sock: { sendMessage: (...args: unknown[]) => Promise<unknown> };
      connectionState: string;
      generateMessageId: (() => string) | null;
      sentMessageIds: Set<string>;
    };

    internals.sock = {
      sendMessage: async () => ({ key: { id: "baileys-generated-id", fromMe: true, remoteJid: "818012345678@s.whatsapp.net" } }),
    };
    internals.connectionState = "ok";
    internals.generateMessageId = null;

    const result = await adapter.sendMessage({
      channel: "818012345678@s.whatsapp.net",
      text: "fallback path",
    });

    expect(result.messageId).toBe("baileys-generated-id");
    expect(internals.sentMessageIds.has("baileys-generated-id")).toBe(true);
  });

  it("exposes the owner JID as primaryRecipient", () => {
    const adapter = createAdapter();
    expect(adapter.primaryRecipient).toBe("818012345678@s.whatsapp.net");
  });

  it("renders Baileys QR payloads into a scannable data URL snapshot", async () => {
    const adapter = createAdapter();
    const renderToDataUrl = vi
      .fn()
      .mockResolvedValue("data:image/png;base64,IMAGE_BYTES");

    // Inject the rendered-QR helpers without loading the real baileys/qrcode
    // modules — captureQr() is the unit under test.
    const internal = adapter as unknown as {
      renderQrToDataUrl: typeof renderToDataUrl;
      captureQr: (payload: string) => Promise<void>;
    };
    internal.renderQrToDataUrl = renderToDataUrl;

    await internal.captureQr("2@PAYLOAD_FROM_BAILEYS,sigA,sigB,==");

    expect(renderToDataUrl).toHaveBeenCalledWith(
      "2@PAYLOAD_FROM_BAILEYS,sigA,sigB,==",
      expect.objectContaining({ width: 320 }),
    );
    const snapshot = adapter.getQrSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.dataUrl).toBe("data:image/png;base64,IMAGE_BYTES");
    expect(snapshot!.payload).toBe("2@PAYLOAD_FROM_BAILEYS,sigA,sigB,==");
    expect(snapshot!.expiresAt).toBeGreaterThan(snapshot!.generatedAt);
  });


  it("waitForQr returns the latest snapshot if one is already in memory", async () => {
    const adapter = createAdapter();
    const internal = adapter as unknown as {
      renderQrToDataUrl: (payload: string) => Promise<string>;
      captureQr: (payload: string) => Promise<void>;
    };
    internal.renderQrToDataUrl = vi.fn().mockResolvedValue("data:image/png;base64,QR");
    await internal.captureQr("CACHED");

    const snap = await adapter.waitForQr(50);
    expect(snap).not.toBeNull();
    expect(snap!.payload).toBe("CACHED");
  });

});

describe("WhatsAppAdapter — WhatsApp Web version resolution", () => {
  it("prefers fetchLatestWaWebVersion when it returns a fresh version", async () => {
    const adapter = createAdapter();
    const internals = asInternals(adapter);

    const liveFetch = vi
      .fn()
      .mockResolvedValue({ version: [2, 9999, 1], isLatest: true });
    const fallbackFetch = vi
      .fn()
      .mockResolvedValue({ version: [2, 1234, 5], isLatest: true });

    internals.fetchLatestWaWebVersion = liveFetch;
    internals.fetchLatestBaileysVersion = fallbackFetch;

    const version = await internals.resolveWAVersion();
    expect(version).toEqual([2, 9999, 1]);
    expect(liveFetch).toHaveBeenCalledTimes(1);
    expect(fallbackFetch).not.toHaveBeenCalled();
  });

  it("falls back to fetchLatestBaileysVersion when the live source is stale", async () => {
    const adapter = createAdapter();
    const internals = asInternals(adapter);

    internals.fetchLatestWaWebVersion = vi
      .fn()
      .mockResolvedValue({ version: [2, 1, 1], isLatest: false, error: "blocked" });
    internals.fetchLatestBaileysVersion = vi
      .fn()
      .mockResolvedValue({ version: [2, 4242, 7], isLatest: true });

    const version = await internals.resolveWAVersion();
    expect(version).toEqual([2, 4242, 7]);
  });

  it("returns undefined when both sources fail (Baileys uses bundled default)", async () => {
    const adapter = createAdapter();
    const internals = asInternals(adapter);

    internals.fetchLatestWaWebVersion = vi.fn().mockRejectedValue(new Error("network"));
    internals.fetchLatestBaileysVersion = vi
      .fn()
      .mockResolvedValue({ version: [2, 1, 1], isLatest: false });

    const version = await internals.resolveWAVersion();
    expect(version).toBeUndefined();
  });

  it("caches the resolved version within the TTL", async () => {
    const adapter = createAdapter();
    const internals = asInternals(adapter);

    const liveFetch = vi
      .fn()
      .mockResolvedValue({ version: [2, 5000, 1], isLatest: true });
    internals.fetchLatestWaWebVersion = liveFetch;
    internals.fetchLatestBaileysVersion = vi.fn();

    const first = await internals.resolveWAVersion();
    const second = await internals.resolveWAVersion();
    expect(first).toEqual([2, 5000, 1]);
    expect(second).toEqual([2, 5000, 1]);
    expect(liveFetch).toHaveBeenCalledTimes(1);
  });

  it("invalidateWAVersionCache forces the next resolve to refetch", async () => {
    const adapter = createAdapter();
    const internals = asInternals(adapter);

    const liveFetch = vi
      .fn()
      .mockResolvedValueOnce({ version: [2, 1000, 1], isLatest: true })
      .mockResolvedValueOnce({ version: [2, 2000, 2], isLatest: true });
    internals.fetchLatestWaWebVersion = liveFetch;
    internals.fetchLatestBaileysVersion = vi.fn();

    const first = await internals.resolveWAVersion();
    expect(first).toEqual([2, 1000, 1]);

    internals.invalidateWAVersionCache();
    expect(internals.cachedWAVersion).toBeNull();

    const second = await internals.resolveWAVersion();
    expect(second).toEqual([2, 2000, 2]);
    expect(liveFetch).toHaveBeenCalledTimes(2);
  });

  it("tryResolve: fn=null returns null (if (!fn) return null branch)", async () => {
    // When fetchLatestWaWebVersion is null, tryResolve skips it and falls through to Baileys
    const adapter = createAdapter();
    const internals = asInternals(adapter);

    internals.fetchLatestWaWebVersion = null; // fn is null → returns null
    internals.fetchLatestBaileysVersion = vi
      .fn()
      .mockResolvedValue({ version: [2, 1000, 1], isLatest: true });

    const version = await internals.resolveWAVersion();
    expect(version).toEqual([2, 1000, 1]);
  });

  it("rejects malformed version arrays from upstream", async () => {
    const adapter = createAdapter();
    const internals = asInternals(adapter);

    internals.fetchLatestWaWebVersion = vi
      .fn()
      .mockResolvedValue({ version: [2, "bad" as unknown as number, 0], isLatest: true });
    internals.fetchLatestBaileysVersion = vi
      .fn()
      .mockResolvedValue({ version: [2, 9, 9, 9], isLatest: true });

    const version = await internals.resolveWAVersion();
    // Both rejected → undefined → bundled default
    expect(version).toBeUndefined();
  });
});

describe("WhatsAppAdapter — sent-id dedup helpers", () => {
  type DedupInternals = {
    sentMessageIds: Set<string>;
    rememberSentMessageId: (id: string) => void;
    consumeSentMessageId: (id: string | null | undefined) => boolean;
  };

  it("rememberSentMessageId is a no-op for empty string (line 812 !id branch)", () => {
    const adapter = createAdapter();
    const i = adapter as unknown as DedupInternals;
    const sizeBefore = i.sentMessageIds.size;
    i.rememberSentMessageId("");
    expect(i.sentMessageIds.size).toBe(sizeBefore); // empty string → no-op
  });

  it("rememberSentMessageId is idempotent for the same id", () => {
    const adapter = createAdapter();
    const i = adapter as unknown as DedupInternals;
    i.rememberSentMessageId("a");
    i.rememberSentMessageId("a");
    i.rememberSentMessageId("a");
    expect(i.sentMessageIds.size).toBe(1);
  });

  it("consumeSentMessageId returns true once and then false (consume-on-match)", () => {
    const adapter = createAdapter();
    const i = adapter as unknown as DedupInternals;
    i.rememberSentMessageId("z");
    expect(i.consumeSentMessageId("z")).toBe(true);
    expect(i.consumeSentMessageId("z")).toBe(false);
    expect(i.sentMessageIds.has("z")).toBe(false);
  });

  it("consumeSentMessageId returns false for null/undefined/empty input", () => {
    const adapter = createAdapter();
    const i = adapter as unknown as DedupInternals;
    expect(i.consumeSentMessageId(null)).toBe(false);
    expect(i.consumeSentMessageId(undefined)).toBe(false);
    expect(i.consumeSentMessageId("")).toBe(false);
  });

  it("evicts the oldest id when the cap is exceeded (FIFO)", () => {
    const adapter = createAdapter();
    const i = adapter as unknown as DedupInternals;
    const CAP = 256; // SENT_MESSAGE_ID_CAP — kept in sync with the source
    for (let n = 0; n < CAP; n++) i.rememberSentMessageId(`id-${n}`);
    expect(i.sentMessageIds.size).toBe(CAP);
    expect(i.sentMessageIds.has("id-0")).toBe(true);

    i.rememberSentMessageId(`id-${CAP}`);
    expect(i.sentMessageIds.size).toBe(CAP);
    expect(i.sentMessageIds.has("id-0")).toBe(false); // oldest evicted
    expect(i.sentMessageIds.has(`id-${CAP}`)).toBe(true); // newest present
  });
});

describe("WhatsAppAdapter — reconnect classifier", () => {
  function makeCloseUpdate(statusCode: number | null) {
    return {
      connection: "close" as const,
      lastDisconnect: {
        error: {
          output: { statusCode },
          data: { statusCode },
        },
      },
    };
  }

  it("treats DisconnectReason.loggedOut (401) as logged_out and stops the loop", async () => {
    const onLoggedOut = vi.fn();
    const adapter = new WhatsAppAdapter({
      ownerPhone: "+818012345678",
      authDir: mkdtempSync(join(tmpdir(), "personal-agent-whatsapp-test-")),
      onMessage: vi.fn(),
      onLoggedOut,
    });
    const internals = asInternals(adapter);
    internals.loggedOutCode = 401;
    internals.sock = {};

    await internals.handleConnectionUpdate(makeCloseUpdate(401), internals.sock);

    expect(internals.connectionState).toBe("logged_out");
    expect(internals.reconnectTimer).toBeNull();
    expect(onLoggedOut).toHaveBeenCalledTimes(1);
  });

  it("treats forbidden (403) and multidevice mismatch (411) as logged_out", async () => {
    for (const status of [403, 411]) {
      const adapter = createAdapter();
      const internals = asInternals(adapter);
      internals.loggedOutCode = 401;
      internals.sock = {};

      await internals.handleConnectionUpdate(makeCloseUpdate(status), internals.sock);
      expect(internals.connectionState).toBe("logged_out");
      expect(internals.reconnectTimer).toBeNull();
    }
  });

  it("invalidates the version cache on a 405 close", async () => {
    const adapter = createAdapter();
    const internals = asInternals(adapter);
    internals.loggedOutCode = 401;
    internals.sock = {};
    internals.cachedWAVersion = [2, 3000, 1];
    internals.cachedWAVersionAt = Date.now();

    // Use fake timers so scheduleReconnect's setTimeout doesn't actually fire.
    vi.useFakeTimers();

    await internals.handleConnectionUpdate(makeCloseUpdate(405), internals.sock);

    expect(internals.cachedWAVersion).toBeNull();
    expect(internals.connectionState).toBe("disconnected");
    expect(internals.reconnectAttempts).toBe(1);
    expect(internals.lastError).toMatch(/rejected client version/i);

    // Cleanup any scheduled timers
    const reconnectTimer = (internals as { reconnectTimer?: ReturnType<typeof setTimeout> | null }).reconnectTimer;
    if (reconnectTimer) clearTimeout(reconnectTimer);
  });

  it("invalidates the version cache on a 515 restart-required close", async () => {
    const adapter = createAdapter();
    const internals = asInternals(adapter);
    internals.loggedOutCode = 401;
    internals.sock = {};
    internals.cachedWAVersion = [2, 3000, 1];
    internals.cachedWAVersionAt = Date.now();

    vi.useFakeTimers();
    await internals.handleConnectionUpdate(makeCloseUpdate(515), internals.sock);

    expect(internals.cachedWAVersion).toBeNull();
    const reconnectTimer = (internals as { reconnectTimer?: ReturnType<typeof setTimeout> | null }).reconnectTimer;
    if (reconnectTimer) clearTimeout(reconnectTimer);
  });
});

describe("WhatsAppAdapter — closeSocket reentry safety", () => {
  /**
   * Regression test for the dual-socket race that produced
   * `stream:error type="replaced"` conflicts in production:
   *
   *   1. requestQR → closeSocket → sock.end()
   *   2. sock.end() emits `connection.update` SYNCHRONOUSLY (Baileys
   *      socket.js line ~489), reentering handleConnectionUpdate
   *   3. Old code: `this.sock` was still set → reentry classified the close
   *      as a network failure → scheduleReconnect → 1s later a SECOND
   *      socket spawns → conflict
   *   4. New code: `this.sock = null` happens BEFORE sock.end(), AND an
   *      `intentionalClose` flag short-circuits the reentry path
   */
  it("does NOT schedule a reconnect when closeSocket triggers a synchronous close event", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      sock: { end: (err: Error) => void; ws?: { close?: () => void } } | null;
      reconnectTimer: ReturnType<typeof setTimeout> | null;
      reconnectAttempts: number;
      intentionalClose: boolean;
      handleConnectionUpdate: (u: unknown, sock: unknown) => Promise<void>;
      closeSocket: () => void;
      loggedOutCode: number | null;
    };
    internals.loggedOutCode = 401;

    // Build a fake sock whose end(err) synchronously dispatches a
    // `connection.update` close event back into our handler — exactly
    // what Baileys does in real life.
    const fakeSock = {
      ws: { close: vi.fn() },
      end: vi.fn(function end(this: unknown, error: Error) {
        // Snapshot the state observed by the close handler reentry —
        // the regression is that this.sock was still defined here,
        // letting the handler call scheduleReconnect.
        void internals.handleConnectionUpdate(
          {
            connection: "close",
            lastDisconnect: { error, date: new Date() },
          },
          fakeSock,
        );
      }),
    };
    internals.sock = fakeSock as unknown as typeof internals.sock;
    internals.reconnectAttempts = 0;
    internals.reconnectTimer = null;

    internals.closeSocket();

    // The unwanted reconnect timer must NOT have been armed.
    expect(internals.reconnectTimer).toBeNull();
    expect(internals.reconnectAttempts).toBe(0);
    // The intentionalClose flag must have been cleared after closeSocket
    // returned, so a future genuine network failure is still classified.
    expect(internals.intentionalClose).toBe(false);
    // The fake sock must actually have been told to end (i.e. closeSocket
    // didn't bail out before reaching it).
    expect(fakeSock.end).toHaveBeenCalledTimes(1);
  });

  it("classifies a NORMAL close (no intentionalClose) as a reconnect candidate", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      sock: unknown;
      reconnectTimer: ReturnType<typeof setTimeout> | null;
      reconnectAttempts: number;
      intentionalClose: boolean;
      handleConnectionUpdate: (u: unknown, sock: unknown) => Promise<void>;
      loggedOutCode: number | null;
      closeSocket: () => void;
    };
    internals.loggedOutCode = 401;
    internals.intentionalClose = false;
    const fakeSock = {};
    internals.sock = fakeSock;

    vi.useFakeTimers();
    await internals.handleConnectionUpdate(
      {
        connection: "close",
        lastDisconnect: { error: { output: { statusCode: 500 } }, date: new Date() },
      },
      fakeSock,
    );

    // A non-intentional close with a transient status should arm the
    // reconnect classifier — this proves the intentionalClose guard is
    // gating only the reentry path, not all closes.
    expect(internals.reconnectTimer).not.toBeNull();
    expect(internals.reconnectAttempts).toBe(1);
    const reconnectTimer = (internals as { reconnectTimer?: ReturnType<typeof setTimeout> | null }).reconnectTimer;
    if (reconnectTimer) clearTimeout(reconnectTimer);
  });
});

describe("WhatsAppAdapter — connect() Baileys options", () => {
  /**
   * The actual `connect()` reaches out to import('@whiskeysockets/baileys'),
   * which we don't want to do in tests. Instead we exercise the makeWASocket
   * call site directly via the injected factory: assert that it receives
   * markOnlineOnConnect:true, syncFullHistory:false, and the
   * shouldSyncHistoryMessage callback. These three options are what unblocks
   * incoming self-DMs (see the connect() comments).
   */
  it("passes markOnlineOnConnect:true, syncFullHistory:false, and a shouldSyncHistoryMessage callback", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      makeWASocket: ((opts: Record<string, unknown>) => unknown) | null;
      authState: { state: unknown; saveCreds: () => Promise<void> } | null;
      fetchLatestWaWebVersion: (() => Promise<unknown>) | null;
      fetchLatestBaileysVersion: (() => Promise<unknown>) | null;
      connect: () => Promise<void>;
      sock: unknown;
    };

    const factory = vi.fn().mockReturnValue({
      ev: { on: vi.fn() },
      ws: { close: vi.fn() },
      end: vi.fn(),
    });

    internals.makeWASocket = factory;
    internals.authState = { state: { creds: {} }, saveCreds: async () => {} };
    // Skip the network resolver — return undefined so Baileys would use the
    // bundled default. We only care about the OTHER options here.
    internals.fetchLatestWaWebVersion = vi
      .fn()
      .mockResolvedValue({ version: undefined, isLatest: false });
    internals.fetchLatestBaileysVersion = vi
      .fn()
      .mockResolvedValue({ version: undefined, isLatest: false });

    await internals.connect();

    expect(factory).toHaveBeenCalledTimes(1);
    const opts = factory.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.markOnlineOnConnect).toBe(true);
    expect(opts.syncFullHistory).toBe(false);
    expect(typeof opts.shouldSyncHistoryMessage).toBe("function");
    // Defensive: regardless of the message argument, the callback returns
    // false so Baileys never tries to enqueue a history sync gate.
    const cb = opts.shouldSyncHistoryMessage as (msg: unknown) => boolean;
    expect(cb({})).toBe(false);
    expect(cb({ message: { conversation: "anything" } })).toBe(false);
  });
});

describe("WhatsAppAdapter — reconnect backoff", () => {
  it("schedules a deterministic exponential delay (jitter pinned to 0)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const adapter = createAdapter();
    const internals = asInternals(adapter);

    // attempt 0 → 1000ms; attempt 1 → 2000ms; attempt 2 → 4000ms
    const expected = [1000, 2000, 4000];
    for (const want of expected) {
      const before = setTimeoutSpy.mock.calls.length;
      internals.scheduleReconnect();
      const call = setTimeoutSpy.mock.calls[before];
      expect(call?.[1]).toBe(want);
      // Clear the timer so the next scheduleReconnect isn't blocked.
      if (internals.reconnectTimer) {
        clearTimeout(internals.reconnectTimer);
        internals.reconnectTimer = null;
      }
    }

    expect(internals.reconnectAttempts).toBe(expected.length);
  });

  it("caps the backoff at the configured maximum", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const adapter = createAdapter();
    const internals = asInternals(adapter);

    // Jump straight to a high attempt count — exponential would blow up to
    // ~512s, but the cap keeps us at the configured 60s ceiling.
    internals.reconnectAttempts = 9;
    internals.scheduleReconnect();
    const call = setTimeoutSpy.mock.calls.at(-1);
    expect(call?.[1]).toBe(60_000);
    const reconnectTimer = (internals as { reconnectTimer?: ReturnType<typeof setTimeout> | null }).reconnectTimer;
    if (reconnectTimer) clearTimeout(reconnectTimer);
  });

  it("stops scheduling once max attempts is exceeded", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.useFakeTimers();

    const adapter = createAdapter();
    const internals = asInternals(adapter);

    internals.reconnectAttempts = 10; // == RECONNECT_MAX_ATTEMPTS
    internals.scheduleReconnect();

    expect(internals.reconnectTimer).toBeNull();
    expect(internals.lastError).toMatch(/gave up after 10 attempts/);
  });

  it("does not schedule when shuttingDown", () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const adapter = createAdapter();
    const internals = asInternals(adapter);
    internals.shuttingDown = true;
    const before = setTimeoutSpy.mock.calls.length;

    internals.scheduleReconnect();
    expect(setTimeoutSpy.mock.calls.length).toBe(before);
    expect(internals.reconnectTimer).toBeNull();
  });

  it("does not schedule when already logged_out", () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const adapter = createAdapter();
    const internals = asInternals(adapter);
    internals.connectionState = "logged_out";
    const before = setTimeoutSpy.mock.calls.length;

    internals.scheduleReconnect();
    expect(setTimeoutSpy.mock.calls.length).toBe(before);
    expect(internals.reconnectTimer).toBeNull();
  });
});

describe("WhatsAppAdapter — sustained network watch", () => {
  function makeCloseUpdate(statusCode: number | null) {
    return {
      connection: "close" as const,
      lastDisconnect: { error: { output: { statusCode }, data: { statusCode } } },
    };
  }

  it("classifies transport closes (408/428/503) as network and app-layer closes (405/500) as not", async () => {
    const cases: ReadonlyArray<readonly [number, boolean]> = [
      [408, true],
      [428, true],
      [503, true],
      [405, false],
      [500, false],
    ];
    vi.useFakeTimers();
    for (const [status, expected] of cases) {
      const adapter = createAdapter();
      const internals = asInternals(adapter);
      internals.loggedOutCode = 401;
      internals.sock = {};

      await internals.handleConnectionUpdate(makeCloseUpdate(status), internals.sock);

      expect(internals.lastCloseWasNetwork).toBe(expected);
      if (internals.reconnectTimer) {
        clearTimeout(internals.reconnectTimer);
        internals.reconnectTimer = null;
      }
    }
  });

  it("treats a close carrying no statusCode as network-class", async () => {
    const adapter = createAdapter();
    const internals = asInternals(adapter);
    internals.loggedOutCode = 401;
    internals.sock = {};

    vi.useFakeTimers();
    await internals.handleConnectionUpdate(
      { connection: "close", lastDisconnect: { error: new Error("socket hang up") } },
      internals.sock,
    );

    expect(internals.lastCloseWasNetwork).toBe(true);
    const reconnectTimer = (internals as { reconnectTimer?: ReturnType<typeof setTimeout> | null }).reconnectTimer;
    if (reconnectTimer) clearTimeout(reconnectTimer);
  });

  it("enters the sustained watch instead of giving up on a network close past the fast cap", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const adapter = createAdapter();
    const internals = asInternals(adapter);
    internals.reconnectAttempts = 10; // == RECONNECT_MAX_ATTEMPTS
    internals.lastCloseWasNetwork = true;

    internals.scheduleReconnect();

    // Sustained cadence (30s, jitter pinned to 0), NOT the permanent give-up.
    expect(setTimeoutSpy.mock.calls.at(-1)?.[1]).toBe(30_000);
    expect(internals.reconnectTimer).not.toBeNull();
    expect(internals.reconnecting).toBe(true);
    expect(internals.lastError ?? "").not.toMatch(/gave up/);
    // Counter pinned at the cap rather than growing across the offline window.
    expect(internals.reconnectAttempts).toBe(10);
    const reconnectTimer = (internals as { reconnectTimer?: ReturnType<typeof setTimeout> | null }).reconnectTimer;
    if (reconnectTimer) clearTimeout(reconnectTimer);
  });

  it("still gives up on a non-network close past the fast cap", () => {
    vi.useFakeTimers();
    const adapter = createAdapter();
    const internals = asInternals(adapter);
    internals.reconnectAttempts = 10;
    internals.lastCloseWasNetwork = false;
    internals.lastError = "WhatsApp rejected client version (status 515)";

    internals.scheduleReconnect();

    expect(internals.reconnectTimer).toBeNull();
    expect(internals.reconnecting).toBe(false);
    expect(internals.lastError).toMatch(/gave up after 10 attempts/);
  });

  it("keeps watching without opening a socket while still offline", async () => {
    vi.useFakeTimers();
    const adapter = createAdapter();
    const internals = asInternals(adapter);
    internals.reconnectAttempts = 10;
    internals.lastCloseWasNetwork = true;
    internals.connectionState = "disconnected";
    internals.dnsLookup = vi.fn().mockRejectedValue(new Error("EAI_AGAIN"));
    const connectSpy = vi.spyOn(internals, "connect").mockResolvedValue();

    await internals.runReconnectAttempt(true);

    expect(connectSpy).not.toHaveBeenCalled();
    // Re-armed for another probe rather than wedging in an error state.
    expect(internals.reconnectTimer).not.toBeNull();
    expect(internals.reconnecting).toBe(true);
    const reconnectTimer = (internals as { reconnectTimer?: ReturnType<typeof setTimeout> | null }).reconnectTimer;
    if (reconnectTimer) clearTimeout(reconnectTimer);
  });

  it("reconnects with a fresh fast phase once the network returns", async () => {
    const adapter = createAdapter();
    const internals = asInternals(adapter);
    internals.reconnectAttempts = 10;
    internals.lastCloseWasNetwork = true;
    internals.connectionState = "disconnected";
    internals.dnsLookup = vi.fn().mockResolvedValue({ address: "1.2.3.4", family: 4 });
    const connectSpy = vi.spyOn(internals, "connect").mockResolvedValue();

    await internals.runReconnectAttempt(true);

    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(internals.reconnectAttempts).toBe(0); // fresh fast phase for the next blip
  });

  it("re-marks a thrown connect as non-network so a persistent failure gives up at the cap", async () => {
    // A thrown connect() is a local misconfiguration, never a network signal
    // (network failures arrive via the close event). Without re-marking, the
    // watch would inherit lastCloseWasNetwork=true and loop forever.
    const adapter = createAdapter();
    const internals = asInternals(adapter);
    internals.lastCloseWasNetwork = true; // inherited from the close that opened the watch
    internals.connectionState = "disconnected";
    internals.dnsLookup = vi.fn().mockResolvedValue({ address: "1.2.3.4", family: 4 });
    vi.spyOn(internals, "connect").mockRejectedValue(new Error("deps not initialized"));

    vi.useFakeTimers();
    await internals.runReconnectAttempt(true);

    expect(internals.lastCloseWasNetwork).toBe(false);
    const reconnectTimer = (internals as { reconnectTimer?: ReturnType<typeof setTimeout> | null }).reconnectTimer;
    if (reconnectTimer) clearTimeout(reconnectTimer);
  });

  it("abandons the sustained attempt if shut down during the connectivity probe", async () => {
    const adapter = createAdapter();
    const internals = asInternals(adapter);
    internals.reconnectAttempts = 10;
    internals.lastCloseWasNetwork = true;
    internals.reconnecting = true;
    internals.dnsLookup = vi.fn().mockImplementation(async () => {
      internals.shuttingDown = true; // flips mid-probe (e.g. adapter stop())
      return { address: "1.2.3.4", family: 4 };
    });
    const connectSpy = vi.spyOn(internals, "connect").mockResolvedValue();

    await internals.runReconnectAttempt(true);

    expect(connectSpy).not.toHaveBeenCalled();
    expect(internals.reconnecting).toBe(false);
    expect(internals.reconnectTimer).toBeNull();
  });

  it("isNetworkReachable resolves true on lookup success and false on failure", async () => {
    const adapter = createAdapter();
    const internals = asInternals(adapter);

    internals.dnsLookup = vi.fn().mockResolvedValue({ address: "1.2.3.4", family: 4 });
    await expect(internals.isNetworkReachable()).resolves.toBe(true);

    internals.dnsLookup = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    await expect(internals.isNetworkReachable()).resolves.toBe(false);
  });

  it("surfaces the sustained watch as connecting even with the timer momentarily null", () => {
    const adapter = createAdapter();
    const internals = asInternals(adapter);
    internals.connectionState = "disconnected";
    internals.lastError = "WhatsApp connection closed (status 408)";
    internals.reconnectTimer = null;
    internals.reconnecting = true; // brief mid-probe window of the sustained watch
    expect(adapter.getStatusError()).toBeNull();
    expect(adapter.getNotificationRuntimeStatus()).toEqual({
      runtimeState: "connecting",
      error: null,
    });
  });
});

// ── Coverage gap fill: getStatus, getLastError, getNotificationRuntimeStatus, etc. ──

describe("WhatsAppAdapter — connection state accessors", () => {
  it("getStatus returns the current connection state", () => {
    const adapter = createAdapter();
    expect(adapter.getStatus()).toBe("disabled");
    (adapter as unknown as { connectionState: string }).connectionState = "ok";
    expect(adapter.getStatus()).toBe("ok");
  });

  it("getLastError returns null initially", () => {
    const adapter = createAdapter();
    expect(adapter.getLastError()).toBeNull();
  });

  it("getLastError returns the recorded error", () => {
    const adapter = createAdapter();
    (adapter as unknown as { lastError: string }).lastError = "connection reset";
    expect(adapter.getLastError()).toBe("connection reset");
  });

  it("getNotificationRuntimeStatus reports ok state", () => {
    const adapter = createAdapter();
    (adapter as unknown as { connectionState: string }).connectionState = "ok";
    expect(adapter.getNotificationRuntimeStatus()).toEqual({
      runtimeState: "ok",
      error: null,
    });
  });

  it("getNotificationRuntimeStatus reports connecting state as non-error", () => {
    const adapter = createAdapter();
    (adapter as unknown as { connectionState: string }).connectionState = "connecting";
    expect(adapter.getNotificationRuntimeStatus()).toEqual({
      runtimeState: "connecting",
      error: null,
    });
  });

  it("getNotificationRuntimeStatus reports awaiting_qr state as non-error", () => {
    const adapter = createAdapter();
    (adapter as unknown as { connectionState: string }).connectionState = "awaiting_qr";
    expect(adapter.getNotificationRuntimeStatus()).toEqual({
      runtimeState: "connecting",
      error: null,
    });
  });

  it("getNotificationRuntimeStatus reports logged_out state", () => {
    const adapter = createAdapter();
    (adapter as unknown as { connectionState: string }).connectionState = "logged_out";
    expect(adapter.getNotificationRuntimeStatus()).toEqual({
      runtimeState: "error",
      error: "WhatsApp logged out",
    });
  });

  it("getNotificationRuntimeStatus reports disconnected state with no pending reconnect as error", () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      connectionState: string;
      lastError: string | null;
      reconnectTimer: ReturnType<typeof setTimeout> | null;
    };
    internals.connectionState = "disconnected";
    internals.lastError = "WhatsApp reconnect gave up after 10 attempts (status 515)";
    internals.reconnectTimer = null;
    expect(adapter.getNotificationRuntimeStatus()).toEqual({
      runtimeState: "error",
      error: "WhatsApp reconnect gave up after 10 attempts (status 515)",
    });
  });

  it("getNotificationRuntimeStatus suppresses disconnected error while a reconnect is pending", () => {
    // Brief window between connection.close → scheduleReconnect and the next
    // connect() firing. A version-rejection during initial pairing lands here
    // and used to flash a red "rejected client version" alert beneath the QR.
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      connectionState: string;
      lastError: string | null;
      reconnectTimer: ReturnType<typeof setTimeout> | null;
    };
    internals.connectionState = "disconnected";
    internals.lastError = "WhatsApp rejected client version (status 515)";
    internals.reconnectTimer = setTimeout(() => {}, 10_000);
    try {
      expect(adapter.getNotificationRuntimeStatus()).toEqual({
        runtimeState: "connecting",
        error: null,
      });
    } finally {
      const reconnectTimer = (internals as { reconnectTimer?: ReturnType<typeof setTimeout> | null }).reconnectTimer;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    }
  });

  it("getNotificationRuntimeStatus reports disconnected with no lastError as generic error", () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      connectionState: string;
      reconnectTimer: ReturnType<typeof setTimeout> | null;
    };
    internals.connectionState = "disconnected";
    internals.reconnectTimer = null;
    expect(adapter.getNotificationRuntimeStatus()).toEqual({
      runtimeState: "error",
      error: "WhatsApp disconnected",
    });
  });

  it("getNotificationRuntimeStatus reports disabled state as connecting (pre-connect window)", () => {
    // "disabled" is the transient state between construction and connect().
    // It's not a failure — a prior lastError from a previous session must
    // NOT be surfaced here, since the adapter is about to connect again.
    const adapter = createAdapter();
    (adapter as unknown as { connectionState: string }).connectionState = "disabled";
    (adapter as unknown as { lastError: string }).lastError = "stale error from prior attempt";
    expect(adapter.getNotificationRuntimeStatus()).toEqual({
      runtimeState: "connecting",
      error: null,
    });
  });

  it("getNotificationRuntimeStatus reports initial (unset connectionState) as connecting", () => {
    const adapter = createAdapter();
    expect(adapter.getNotificationRuntimeStatus()).toEqual({
      runtimeState: "connecting",
      error: null,
    });
  });
});

describe("WhatsAppAdapter — getStatusError", () => {
  it("returns null while connected, connecting, awaiting QR, or disabled", () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      connectionState: string;
      lastError: string | null;
    };
    internals.lastError = "stale error";
    for (const state of ["ok", "connecting", "awaiting_qr", "disabled"] as const) {
      internals.connectionState = state;
      expect(adapter.getStatusError()).toBeNull();
    }
  });

  it("returns lastError when logged out", () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      connectionState: string;
      lastError: string | null;
    };
    internals.connectionState = "logged_out";
    internals.lastError = "WhatsApp logged out (status 401) — re-pair required";
    expect(adapter.getStatusError()).toBe(
      "WhatsApp logged out (status 401) — re-pair required",
    );
  });

  it("falls back to a generic message when logged_out has no lastError", () => {
    const adapter = createAdapter();
    (adapter as unknown as { connectionState: string }).connectionState = "logged_out";
    expect(adapter.getStatusError()).toBe("WhatsApp logged out");
  });

  it("suppresses the disconnected error while a reconnect timer is pending", () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      connectionState: string;
      lastError: string | null;
      reconnectTimer: ReturnType<typeof setTimeout> | null;
    };
    internals.connectionState = "disconnected";
    internals.lastError = "WhatsApp rejected client version (status 515)";
    internals.reconnectTimer = setTimeout(() => {}, 10_000);
    try {
      expect(adapter.getStatusError()).toBeNull();
    } finally {
      const reconnectTimer = (internals as { reconnectTimer?: ReturnType<typeof setTimeout> | null }).reconnectTimer;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    }
  });

  it("surfaces the disconnected error once reconnect has stopped", () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      connectionState: string;
      lastError: string | null;
      reconnectTimer: ReturnType<typeof setTimeout> | null;
    };
    internals.connectionState = "disconnected";
    internals.lastError = "WhatsApp reconnect gave up after 10 attempts (status 515)";
    internals.reconnectTimer = null;
    expect(adapter.getStatusError()).toBe(
      "WhatsApp reconnect gave up after 10 attempts (status 515)",
    );
  });
});

describe("WhatsAppAdapter — extractWhatsAppText nested keys", () => {
  it("extracts text from viewOnceMessage", () => {
    expect(
      extractWhatsAppText({
        viewOnceMessage: {
          message: { conversation: "view once text" },
        },
      }),
    ).toBe("view once text");
  });

  it("extracts text from viewOnceMessageV2", () => {
    expect(
      extractWhatsAppText({
        viewOnceMessageV2: {
          message: { extendedTextMessage: { text: "v2 text" } },
        },
      }),
    ).toBe("v2 text");
  });

  it("extracts text from documentWithCaptionMessage", () => {
    expect(
      extractWhatsAppText({
        documentWithCaptionMessage: {
          message: { conversation: "doc caption" },
        },
      }),
    ).toBe("doc caption");
  });

  it("returns null for empty or whitespace-only conversation", () => {
    expect(extractWhatsAppText({ conversation: "  " })).toBeNull();
    expect(extractWhatsAppText({ conversation: "" })).toBeNull();
  });

  it("returns null for empty extendedTextMessage text", () => {
    expect(
      extractWhatsAppText({ extendedTextMessage: { text: "  " } }),
    ).toBeNull();
  });

  it("returns null for null/undefined input", () => {
    expect(extractWhatsAppText(null)).toBeNull();
    expect(extractWhatsAppText(undefined)).toBeNull();
  });
});

describe("WhatsAppAdapter — sendMessage error path", () => {
  it("throws when socket is not connected", async () => {
    const adapter = createAdapter();
    await expect(
      adapter.sendMessage({ channel: "818012345678@s.whatsapp.net", text: "hi" }),
    ).rejects.toThrow("WhatsApp socket is not connected");
  });

  it("throws when connectionState is not ok", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      sock: unknown;
      connectionState: string;
    };
    internals.sock = {};
    internals.connectionState = "connecting";

    await expect(
      adapter.sendMessage({ channel: "818012345678@s.whatsapp.net", text: "hi" }),
    ).rejects.toThrow("WhatsApp socket is not connected");
  });
});

describe("WhatsAppAdapter — waitForQr edge cases", () => {
  it("returns null when already connected", async () => {
    const adapter = createAdapter();
    (adapter as unknown as { connectionState: string }).connectionState = "ok";
    const result = await adapter.waitForQr(50);
    expect(result).toBeNull();
  });

  it("getQrSnapshot returns null when latestQr is null (line 428)", () => {
    const adapter = createAdapter();
    // latestQr is null by default
    expect(adapter.getQrSnapshot()).toBeNull();
  });

  it("waitForQr: state changes to 'ok' during loop → returns null (line 418)", async () => {
    const adapter = createAdapter();

    const requestQRSpy = vi.spyOn(adapter, "requestQR" as any).mockImplementation(async () => {
      // Simulate connection completing
      (adapter as unknown as { connectionState: string }).connectionState = "ok";
    });

    vi.useFakeTimers();
    const waitPromise = adapter.waitForQr(1000);
    await vi.advanceTimersByTimeAsync(300);
    const result = await waitPromise;

    expect(result).toBeNull();
    requestQRSpy.mockRestore();
    vi.useRealTimers();
  });

  it("waitForQr: latestQr becomes available during loop → returns snapshot (line 420)", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      latestQr: { payload: string; dataUrl: string; generatedAt: number; expiresAt: number } | null;
    };

    const requestQRSpy = vi.spyOn(adapter, "requestQR" as any).mockImplementation(async () => {
      // Set latestQr so the loop returns it
      internals.latestQr = {
        payload: "LIVE_QR",
        dataUrl: "data:image/png;base64,LIVE",
        generatedAt: Date.now(),
        expiresAt: Date.now() + 90_000,
      };
    });

    vi.useFakeTimers();
    const waitPromise = adapter.waitForQr(1000);
    await vi.advanceTimersByTimeAsync(300);
    const result = await waitPromise;

    expect(result).not.toBeNull();
    expect(result?.payload).toBe("LIVE_QR");
    requestQRSpy.mockRestore();
    vi.useRealTimers();
  });

  it("getQrSnapshot returns null when QR has expired", async () => {
    const adapter = createAdapter();
    const internal = adapter as unknown as {
      latestQr: { payload: string; dataUrl: string; generatedAt: number; expiresAt: number } | null;
    };
    internal.latestQr = {
      payload: "OLD",
      dataUrl: "data:image/png;base64,OLD",
      generatedAt: Date.now() - 100_000,
      expiresAt: Date.now() - 10_000,
    };
    expect(adapter.getQrSnapshot()).toBeNull();
  });

});

// ── Additional coverage: sendMessage with attachments ──

// Create actual temp files for the attachment tests since the source code
// uses dynamic `import("node:fs").readFileSync` which reads real files.
const _attTmpDir = mkdtempSync(join(tmpdir(), "wa-att-test-"));
const _tmpImgPath = join(_attTmpDir, "test.png");
const _tmpPdfPath = join(_attTmpDir, "report.pdf");
writeFileSync(_tmpImgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
writeFileSync(_tmpPdfPath, Buffer.from([0x25, 0x50, 0x44, 0x46]));

describe("WhatsAppAdapter — sendMessage with attachments", () => {
  type SendMessageInternals = {
    sock: { sendMessage: (...args: unknown[]) => Promise<unknown> };
    connectionState: string;
    generateMessageId: (() => string) | null;
    sentMessageIds: Set<string>;
  };

  it("sends image attachment with text as caption when text <= 1024 chars", async () => {
    const adapter = createAdapter();
    const sendMessage = vi.fn().mockResolvedValue({
      key: { id: "pre-id-img", fromMe: true, remoteJid: "818012345678@s.whatsapp.net" },
    });
    const internals = adapter as unknown as SendMessageInternals;
    internals.sock = { sendMessage };
    internals.connectionState = "ok";
    internals.generateMessageId = () => "pre-id-img";

    const result = await adapter.sendMessage({
      channel: "818012345678@s.whatsapp.net",
      text: "short caption",
      attachments: [
        {
          path: _tmpImgPath,
          mimeType: "image/png",
          originalFilename: "test.png",
          id: "att-1",
          sizeBytes: 4,
        },
      ],
    });

    // sendMessage called once for the image attachment (text used as caption, no text send)
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "818012345678@s.whatsapp.net",
      expect.objectContaining({ image: expect.any(Buffer), caption: "short caption" }),
      expect.objectContaining({ messageId: "pre-id-img" }),
    );
    expect(result.messageId).toBe("pre-id-img");
  });

  it("sends text first then attachment bare when text > 1024 chars", async () => {
    const adapter = createAdapter();
    let callCount = 0;
    const sendMessage = vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        key: { id: `msg-${callCount}`, fromMe: true, remoteJid: "818012345678@s.whatsapp.net" },
      };
    });
    const internals = adapter as unknown as SendMessageInternals;
    internals.sock = { sendMessage };
    internals.connectionState = "ok";
    internals.generateMessageId = null; // no pre-generation

    const longText = "x".repeat(1025);

    await adapter.sendMessage({
      channel: "818012345678@s.whatsapp.net",
      text: longText,
      attachments: [
        {
          path: _tmpImgPath,
          mimeType: "image/png",
          originalFilename: "test.png",
          id: "att-2",
          sizeBytes: 4,
        },
      ],
    });

    // Should send text first (in chunks) then the image without caption
    expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Last call should be the image without caption
    const lastCall = sendMessage.mock.calls[sendMessage.mock.calls.length - 1];
    const mediaPayload = lastCall[1] as Record<string, unknown>;
    expect(mediaPayload.caption).toBeUndefined();
  });

  it("sends document attachment (non-image mime type)", async () => {
    const adapter = createAdapter();
    const sendMessage = vi.fn().mockResolvedValue({
      key: { id: "doc-msg-id", fromMe: true, remoteJid: "818012345678@s.whatsapp.net" },
    });
    const internals = adapter as unknown as SendMessageInternals;
    internals.sock = { sendMessage };
    internals.connectionState = "ok";
    internals.generateMessageId = () => "pre-id-doc";

    await adapter.sendMessage({
      channel: "818012345678@s.whatsapp.net",
      text: "see the document",
      attachments: [
        {
          path: _tmpPdfPath,
          mimeType: "application/pdf",
          originalFilename: "report.pdf",
          id: "att-3",
          sizeBytes: 4,
        },
      ],
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const payload = sendMessage.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.document).toBeDefined();
    expect(payload.fileName).toBe("report.pdf");
  });

  it("preId=null (generateMessageId is null) — no pre-registration before send", async () => {
    const adapter = createAdapter();
    const sendMessage = vi.fn().mockResolvedValue({
      key: { id: "baileys-img-id", fromMe: true, remoteJid: "818012345678@s.whatsapp.net" },
    });
    const internals = adapter as unknown as SendMessageInternals;
    internals.sock = { sendMessage };
    internals.connectionState = "ok";
    internals.generateMessageId = null; // no pre-ID

    const result = await adapter.sendMessage({
      channel: "818012345678@s.whatsapp.net",
      text: "caption",
      attachments: [
        {
          path: _tmpImgPath,
          mimeType: "image/jpeg",
          originalFilename: "img.jpg",
          id: "att-4",
          sizeBytes: 4,
        },
      ],
    });

    expect(result.messageId).toBe("baileys-img-id");
    expect(internals.sentMessageIds.has("baileys-img-id")).toBe(true);
  });

  it("actualId !== preId — both IDs registered in sentMessageIds", async () => {
    const adapter = createAdapter();
    const sendMessage = vi.fn().mockResolvedValue({
      key: { id: "baileys-different-id", fromMe: true, remoteJid: "818012345678@s.whatsapp.net" },
    });
    const internals = adapter as unknown as SendMessageInternals;
    internals.sock = { sendMessage };
    internals.connectionState = "ok";
    internals.generateMessageId = () => "pre-generated-id";

    await adapter.sendMessage({
      channel: "818012345678@s.whatsapp.net",
      text: "caption",
      attachments: [
        {
          path: _tmpImgPath,
          mimeType: "image/jpeg",
          originalFilename: "photo.jpg",
          id: "att-5",
          sizeBytes: 4,
        },
      ],
    });

    // Both preId and actualId should be in sentMessageIds
    expect(internals.sentMessageIds.has("pre-generated-id")).toBe(true);
    expect(internals.sentMessageIds.has("baileys-different-id")).toBe(true);
  });
});

// ── Additional coverage: beginProcessingIndicator edge cases ──

describe("WhatsAppAdapter — beginProcessingIndicator edge cases", () => {
  it("returns handle immediately when sendPresenceUpdate is not a function", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      sock: Record<string, unknown>;
      connectionState: string;
    };
    // sock exists but has no sendPresenceUpdate function
    internals.sock = { end: vi.fn() };
    internals.connectionState = "ok";

    const handle = await adapter.beginProcessingIndicator({
      channel: "818012345678@s.whatsapp.net",
    });
    // Should not throw even without sendPresenceUpdate
    await handle.stop();
  });

  it("sendPresenceUpdate throws non-Error → String(err) branch (line 590)", async () => {
    vi.useFakeTimers();
    const adapter = createAdapter();
    const sendPresenceUpdate = vi.fn().mockRejectedValue("string presence error");
    const internals = adapter as unknown as {
      sock: { sendPresenceUpdate: typeof sendPresenceUpdate };
      connectionState: string;
    };
    internals.sock = { sendPresenceUpdate };
    internals.connectionState = "ok";

    // Should not throw despite non-Error rejection
    const handle = await adapter.beginProcessingIndicator({
      channel: "818012345678@s.whatsapp.net",
    });
    await handle.stop();
    vi.useRealTimers();
  });

  it("sendPresenceUpdate throws — error caught, handle still returned", async () => {
    vi.useFakeTimers();
    const adapter = createAdapter();
    const sendPresenceUpdate = vi.fn().mockRejectedValue(new Error("presence error"));
    const internals = adapter as unknown as {
      sock: { sendPresenceUpdate: typeof sendPresenceUpdate };
      connectionState: string;
    };
    internals.sock = { sendPresenceUpdate };
    internals.connectionState = "ok";

    // Should not throw despite sendPresenceUpdate failing
    const handle = await adapter.beginProcessingIndicator({
      channel: "818012345678@s.whatsapp.net",
    });
    await handle.stop();
    vi.useRealTimers();
  });

  it("stop() called twice — second call is a no-op", async () => {
    vi.useFakeTimers();
    const adapter = createAdapter();
    const sendPresenceUpdate = vi.fn().mockResolvedValue(undefined);
    const internals = adapter as unknown as {
      sock: { sendPresenceUpdate: typeof sendPresenceUpdate };
      connectionState: string;
    };
    internals.sock = { sendPresenceUpdate };
    internals.connectionState = "ok";

    const handle = await adapter.beginProcessingIndicator({
      channel: "818012345678@s.whatsapp.net",
    });

    await handle.stop();
    const callCountAfterFirst = sendPresenceUpdate.mock.calls.length;
    await handle.stop(); // second call — should be a no-op
    expect(sendPresenceUpdate.mock.calls.length).toBe(callCountAfterFirst);
    vi.useRealTimers();
  });
});

// ── Additional coverage: handleConnectionUpdate edge cases ──

describe("WhatsAppAdapter — handleConnectionUpdate edge cases", () => {
  it("stale sock guard: update ignored when sock !== this.sock", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      sock: unknown;
      connectionState: string;
      handleConnectionUpdate: (update: unknown, sock: unknown) => Promise<void>;
      loggedOutCode: number | null;
    };
    internals.loggedOutCode = 401;
    const realSock = {};
    const staleSock = {};
    internals.sock = realSock;
    internals.connectionState = "ok";

    // Call with a stale sock reference — should be a no-op
    await internals.handleConnectionUpdate({ connection: "open" }, staleSock);
    expect(internals.connectionState).toBe("ok"); // unchanged
  });

  it("QR update when renderQr is set — calls terminal render (lines 899-900)", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      sock: unknown;
      connectionState: string;
      renderQr: ((qr: string, opts: { small: boolean }) => void) | null;
      renderQrToDataUrl: ((payload: string, opts?: object) => Promise<string>) | null;
      handleConnectionUpdate: (update: unknown, sock: unknown) => Promise<void>;
      latestQr: unknown;
    };
    const fakeSock = {};
    internals.sock = fakeSock;
    const renderQrSpy = vi.fn();
    internals.renderQr = renderQrSpy;
    internals.renderQrToDataUrl = vi.fn().mockResolvedValue("data:image/png;base64,QR_WITH_TERM");

    await internals.handleConnectionUpdate({ qr: "QR_WITH_TERMINAL" }, fakeSock);

    expect(renderQrSpy).toHaveBeenCalledWith("QR_WITH_TERMINAL", { small: true });
    expect(internals.connectionState).toBe("awaiting_qr");
    expect(internals.latestQr).not.toBeNull();
  });

  it("QR update when renderQr is null — skips terminal render", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      sock: unknown;
      connectionState: string;
      renderQr: unknown;
      renderQrToDataUrl: ((payload: string, opts?: object) => Promise<string>) | null;
      handleConnectionUpdate: (update: unknown, sock: unknown) => Promise<void>;
      latestQr: unknown;
    };
    const fakeSock = {};
    internals.sock = fakeSock;
    internals.renderQr = null; // no terminal renderer
    internals.renderQrToDataUrl = vi.fn().mockResolvedValue("data:image/png;base64,QR_NO_TERM");

    await internals.handleConnectionUpdate({ qr: "QR_PAYLOAD" }, fakeSock);

    expect(internals.connectionState).toBe("awaiting_qr");
    expect(internals.latestQr).not.toBeNull();
  });

  it("captureQr throws — error caught, connection continues", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      sock: unknown;
      connectionState: string;
      renderQr: unknown;
      renderQrToDataUrl: unknown;
      handleConnectionUpdate: (update: unknown, sock: unknown) => Promise<void>;
    };
    const fakeSock = {};
    internals.sock = fakeSock;
    internals.renderQr = null;
    internals.renderQrToDataUrl = vi.fn().mockRejectedValue(new Error("QR render failed"));

    // Should not throw
    await internals.handleConnectionUpdate({ qr: "BAD_QR" }, fakeSock);
    expect(internals.connectionState).toBe("awaiting_qr");
  });

  it("intentionalClose=true during close: handleConnectionUpdate returns early (lines 925-927)", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      sock: unknown;
      connectionState: string;
      intentionalClose: boolean;
      handleConnectionUpdate: (update: unknown, sock: unknown) => Promise<void>;
      loggedOutCode: number | null;
    };
    internals.loggedOutCode = 401;
    const fakeSock = {};
    internals.sock = fakeSock;
    internals.connectionState = "connecting";
    internals.intentionalClose = true;

    await internals.handleConnectionUpdate(
      {
        connection: "close",
        lastDisconnect: { error: { output: { statusCode: 500 } } },
      },
      fakeSock,
    );

    // With intentionalClose=true, should return early without changing state to logged_out/disconnected
    expect(internals.connectionState).toBe("connecting");
  });

  it("statusCode=null (no lastDisconnect) → 'WhatsApp connection closed' message (line 980)", async () => {
    vi.useFakeTimers();
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      sock: unknown;
      connectionState: string;
      handleConnectionUpdate: (update: unknown, sock: unknown) => Promise<void>;
      loggedOutCode: number | null;
      lastError: string | null;
      reconnectTimer: ReturnType<typeof setTimeout> | null;
    };
    internals.loggedOutCode = 401;
    const fakeSock = {};
    internals.sock = fakeSock;

    // No lastDisconnect → statusCode = null → uses the "else" branch (line 977-980)
    await internals.handleConnectionUpdate(
      {
        connection: "close",
        // No lastDisconnect field at all
      },
      fakeSock,
    );

    expect(internals.connectionState).toBe("disconnected");
    expect(internals.lastError).toBe("WhatsApp connection closed");
    const reconnectTimer = (internals as { reconnectTimer?: ReturnType<typeof setTimeout> | null }).reconnectTimer;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    vi.useRealTimers();
  });

  it("statusCode from data?.statusCode when output?.statusCode is undefined (line 932)", async () => {
    vi.useFakeTimers();
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      sock: unknown;
      connectionState: string;
      handleConnectionUpdate: (update: unknown, sock: unknown) => Promise<void>;
      loggedOutCode: number | null;
      lastError: string | null;
    };
    internals.loggedOutCode = 401;
    const fakeSock = {};
    internals.sock = fakeSock;

    // Use data?.statusCode path (no output.statusCode)
    await internals.handleConnectionUpdate(
      {
        connection: "close",
        lastDisconnect: {
          error: {
            // No `output` field — only `data` field
            data: { statusCode: 500 },
          },
        },
      },
      fakeSock,
    );

    expect(internals.connectionState).toBe("disconnected");
    expect(internals.lastError).toContain("500");
    const reconnectTimer = (internals as { reconnectTimer?: ReturnType<typeof setTimeout> | null }).reconnectTimer;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    vi.useRealTimers();
  });

  it("non-close, non-open, non-QR update — returns early without state change", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      sock: unknown;
      connectionState: string;
      handleConnectionUpdate: (update: unknown, sock: unknown) => Promise<void>;
    };
    const fakeSock = {};
    internals.sock = fakeSock;
    internals.connectionState = "connecting";

    await internals.handleConnectionUpdate({ connection: "connecting" }, fakeSock);
    expect(internals.connectionState).toBe("connecting"); // unchanged
  });

  it("connection open: clears QR snapshot and syncs owner identity", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      sock: unknown;
      connectionState: string;
      handleConnectionUpdate: (update: unknown, sock: unknown) => Promise<void>;
      latestQr: unknown;
      authState: { state: { creds?: { me?: { lid?: string } } }; saveCreds: () => Promise<void> } | null;
      loggedOutCode: number | null;
    };
    const fakeSock = {};
    internals.sock = fakeSock;
    internals.latestQr = {
      payload: "OLD_QR",
      dataUrl: "data:image/png;base64,OLD",
      generatedAt: Date.now(),
      expiresAt: Date.now() + 90000,
    };
    internals.authState = {
      state: { creds: { me: { lid: "123:9@lid" } } },
      saveCreds: async () => {},
    };

    await internals.handleConnectionUpdate({ connection: "open" }, fakeSock);

    expect(internals.connectionState).toBe("ok");
    expect(internals.latestQr).toBeNull();
  });

  it("shuttingDown=true on close: sets connectionState to disabled", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      sock: unknown;
      connectionState: string;
      shuttingDown: boolean;
      handleConnectionUpdate: (update: unknown, sock: unknown) => Promise<void>;
      loggedOutCode: number | null;
    };
    const fakeSock = {};
    internals.sock = fakeSock;
    internals.shuttingDown = true;
    internals.loggedOutCode = 401;

    await internals.handleConnectionUpdate(
      {
        connection: "close",
        lastDisconnect: { error: { output: { statusCode: 500 } } },
      },
      fakeSock,
    );

    expect(internals.connectionState).toBe("disabled");
  });

  it("onLoggedOut throws — error caught, state still set to logged_out", async () => {
    const onLoggedOut = vi.fn().mockRejectedValue(new Error("callback error"));
    const adapter = new WhatsAppAdapter({
      ownerPhone: "+818012345678",
      authDir: mkdtempSync(join(tmpdir(), "wa-test-")),
      onMessage: vi.fn(),
      onLoggedOut,
    });
    const internals = adapter as unknown as {
      sock: unknown;
      connectionState: string;
      handleConnectionUpdate: (update: unknown, sock: unknown) => Promise<void>;
      loggedOutCode: number | null;
    };
    const fakeSock = {};
    internals.sock = fakeSock;
    internals.loggedOutCode = 401;

    // Should not throw even when onLoggedOut callback throws
    await internals.handleConnectionUpdate(
      {
        connection: "close",
        lastDisconnect: { error: { output: { statusCode: 401 } } },
      },
      fakeSock,
    );

    expect(internals.connectionState).toBe("logged_out");
    expect(onLoggedOut).toHaveBeenCalledTimes(1);
  });
});

// ── Additional coverage: extractAndIngestWhatsAppMedia missing paths ──

describe("WhatsAppAdapter — extractAndIngestWhatsAppMedia edge cases", () => {
  it("imageMessage over size limit logs warn and skips", async () => {
    const store = fakeAttachmentStore();
    const adapter = createAdapter(vi.fn(), store);
    const downloadMediaMessage = vi.fn().mockResolvedValue(Buffer.from([1, 2, 3]));
    (adapter as unknown as { downloadMediaMessage: typeof downloadMediaMessage }).downloadMediaMessage =
      downloadMediaMessage;

    const WA_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

    await (adapter as unknown as { handleIncomingMessage: (msg: unknown) => Promise<void> }).handleIncomingMessage({
      key: {
        id: "wa-img-oversized",
        remoteJid: "818012345678@s.whatsapp.net",
        fromMe: false,
      },
      message: {
        imageMessage: {
          mimetype: "image/jpeg",
          fileLength: WA_IMAGE_MAX_BYTES + 1,
        },
      },
    });

    expect(downloadMediaMessage).not.toHaveBeenCalled();
    expect(store.ingestStream).not.toHaveBeenCalled();
  });

  it("documentMessage path ingests document correctly", async () => {
    const store = fakeAttachmentStore();
    const onMessage = vi.fn();
    const adapter = createAdapter(onMessage, store);
    const downloadMediaMessage = vi.fn().mockResolvedValue(Buffer.from([1, 2, 3]));
    (adapter as unknown as { downloadMediaMessage: typeof downloadMediaMessage }).downloadMediaMessage =
      downloadMediaMessage;

    await (adapter as unknown as { handleIncomingMessage: (msg: unknown) => Promise<void> }).handleIncomingMessage({
      key: {
        id: "wa-doc-1",
        remoteJid: "818012345678@s.whatsapp.net",
        fromMe: false,
      },
      message: {
        documentMessage: {
          mimetype: "application/pdf",
          fileLength: 1000,
          fileName: "report.pdf",
          caption: "See attached",
        },
      },
    });

    expect(downloadMediaMessage).toHaveBeenCalled();
    expect(store.ingestStream).toHaveBeenCalledWith(
      expect.objectContaining({
        declaredMimeType: "application/pdf",
        originalFilename: "report.pdf",
        caption: "See attached",
        maxSizeBytes: 100 * 1024 * 1024,
      }),
    );
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("documentMessage over size limit logs warn and skips", async () => {
    const store = fakeAttachmentStore();
    const adapter = createAdapter(vi.fn(), store);
    const downloadMediaMessage = vi.fn().mockResolvedValue(Buffer.from([1]));
    (adapter as unknown as { downloadMediaMessage: typeof downloadMediaMessage }).downloadMediaMessage =
      downloadMediaMessage;

    const WA_DOCUMENT_MAX_BYTES = 100 * 1024 * 1024;

    await (adapter as unknown as { handleIncomingMessage: (msg: unknown) => Promise<void> }).handleIncomingMessage({
      key: {
        id: "wa-doc-oversized",
        remoteJid: "818012345678@s.whatsapp.net",
        fromMe: false,
      },
      message: {
        documentMessage: {
          mimetype: "application/zip",
          fileLength: WA_DOCUMENT_MAX_BYTES + 1,
          fileName: "huge.zip",
        },
      },
    });

    expect(downloadMediaMessage).not.toHaveBeenCalled();
  });

  it("audioMessage over size limit logs warn and skips", async () => {
    const store = fakeAttachmentStore();
    const adapter = createAdapter(vi.fn(), store);
    const downloadMediaMessage = vi.fn().mockResolvedValue(Buffer.from([1]));
    (adapter as unknown as { downloadMediaMessage: typeof downloadMediaMessage }).downloadMediaMessage =
      downloadMediaMessage;

    const WA_AUDIO_MAX_BYTES = 16 * 1024 * 1024;

    await (adapter as unknown as { handleIncomingMessage: (msg: unknown) => Promise<void> }).handleIncomingMessage({
      key: {
        id: "wa-audio-oversized",
        remoteJid: "818012345678@s.whatsapp.net",
        fromMe: false,
      },
      message: {
        audioMessage: {
          mimetype: "audio/ogg",
          fileLength: WA_AUDIO_MAX_BYTES + 1,
        },
      },
    });

    expect(downloadMediaMessage).not.toHaveBeenCalled();
  });

  it("videoMessage over size limit logs warn and skips", async () => {
    const store = fakeAttachmentStore();
    const adapter = createAdapter(vi.fn(), store);
    const downloadMediaMessage = vi.fn().mockResolvedValue(Buffer.from([1]));
    (adapter as unknown as { downloadMediaMessage: typeof downloadMediaMessage }).downloadMediaMessage =
      downloadMediaMessage;

    const WA_VIDEO_MAX_BYTES = 16 * 1024 * 1024;

    await (adapter as unknown as { handleIncomingMessage: (msg: unknown) => Promise<void> }).handleIncomingMessage({
      key: {
        id: "wa-video-oversized",
        remoteJid: "818012345678@s.whatsapp.net",
        fromMe: false,
      },
      message: {
        videoMessage: {
          mimetype: "video/mp4",
          fileLength: WA_VIDEO_MAX_BYTES + 1,
        },
      },
    });

    expect(downloadMediaMessage).not.toHaveBeenCalled();
  });

  it("no attachmentStore + downloadMediaMessage set → returns [] and no event", async () => {
    const onMessage = vi.fn();
    // Adapter with NO attachmentStore
    const adapter = createAdapter(onMessage);
    const downloadMediaMessage = vi.fn();
    (adapter as unknown as { downloadMediaMessage: typeof downloadMediaMessage }).downloadMediaMessage =
      downloadMediaMessage;

    await (adapter as unknown as { handleIncomingMessage: (msg: unknown) => Promise<void> }).handleIncomingMessage({
      key: {
        id: "wa-no-store",
        remoteJid: "818012345678@s.whatsapp.net",
        fromMe: false,
      },
      message: {
        imageMessage: {
          mimetype: "image/jpeg",
          fileLength: 100,
        },
      },
    });

    // No attachmentStore → media ignored, pure image with no text → no event
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("message with no recognizable media and no text → no event", async () => {
    const onMessage = vi.fn();
    const adapter = createAdapter(onMessage, fakeAttachmentStore());
    const downloadMediaMessage = vi.fn();
    (adapter as unknown as { downloadMediaMessage: typeof downloadMediaMessage }).downloadMediaMessage =
      downloadMediaMessage;

    // stickerMessage → ignored, no text → no event emitted
    await (adapter as unknown as { handleIncomingMessage: (msg: unknown) => Promise<void> }).handleIncomingMessage({
      key: {
        id: "wa-sticker-no-text",
        remoteJid: "818012345678@s.whatsapp.net",
        fromMe: false,
      },
      message: {
        stickerMessage: { mimetype: "image/webp", fileLength: 10 },
      },
    });

    expect(onMessage).not.toHaveBeenCalled();
  });
});

// ── Additional coverage: downloadAndIngestWhatsApp failure paths ──

describe("WhatsAppAdapter — downloadAndIngestWhatsApp failures", () => {
  it("downloadMediaMessage throws → returns null (no attachment ref)", async () => {
    const store = fakeAttachmentStore();
    const onMessage = vi.fn();
    const adapter = createAdapter(onMessage, store);
    const downloadMediaMessage = vi.fn().mockRejectedValue(new Error("download failed"));
    (adapter as unknown as { downloadMediaMessage: typeof downloadMediaMessage }).downloadMediaMessage =
      downloadMediaMessage;

    await (adapter as unknown as { handleIncomingMessage: (msg: unknown) => Promise<void> }).handleIncomingMessage({
      key: {
        id: "wa-dl-fail",
        remoteJid: "818012345678@s.whatsapp.net",
        fromMe: false,
      },
      message: {
        audioMessage: {
          mimetype: "audio/ogg",
          fileLength: 100,
        },
      },
    });

    // download failed → no attachment ref → no text → no event
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("ingestStream throws → returns null (no attachment ref)", async () => {
    const store = {
      ingestStream: vi.fn().mockRejectedValue(new Error("ingest failed")),
    } as unknown as AttachmentStore;
    const onMessage = vi.fn();
    const adapter = createAdapter(onMessage, store);
    const downloadMediaMessage = vi.fn().mockResolvedValue(Buffer.from([1, 2, 3]));
    (adapter as unknown as { downloadMediaMessage: typeof downloadMediaMessage }).downloadMediaMessage =
      downloadMediaMessage;

    await (adapter as unknown as { handleIncomingMessage: (msg: unknown) => Promise<void> }).handleIncomingMessage({
      key: {
        id: "wa-ingest-fail",
        remoteJid: "818012345678@s.whatsapp.net",
        fromMe: false,
      },
      message: {
        audioMessage: {
          mimetype: "audio/ogg",
          fileLength: 100,
        },
      },
    });

    // ingest failed → no attachment ref → no text → no event
    expect(onMessage).not.toHaveBeenCalled();
  });
});

// ── Additional coverage: captureOwnerIdentity & syncOwnerIdentityFromAuthState ──

describe("WhatsAppAdapter — captureOwnerIdentity edge cases", () => {
  it("me is undefined → no ownerLidRecipient set", () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      captureOwnerIdentity: (update: unknown) => void;
      ownerLidRecipient: string | null;
    };
    internals.captureOwnerIdentity({});
    expect(internals.ownerLidRecipient).toBeNull();
  });

  it("me.lid is not a string → no ownerLidRecipient set", () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      captureOwnerIdentity: (update: unknown) => void;
      ownerLidRecipient: string | null;
    };
    internals.captureOwnerIdentity({ me: { lid: 12345 } });
    expect(internals.ownerLidRecipient).toBeNull();
  });
});

describe("WhatsAppAdapter — syncOwnerIdentityFromAuthState edge cases", () => {
  it("authState is null → no ownerLidRecipient set", () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      authState: null;
      syncOwnerIdentityFromAuthState: () => void;
      ownerLidRecipient: string | null;
    };
    internals.authState = null;
    internals.syncOwnerIdentityFromAuthState();
    expect(internals.ownerLidRecipient).toBeNull();
  });

  it("authState exists but creds.me is undefined → no ownerLidRecipient set", () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      authState: { state: object; saveCreds: () => Promise<void> } | null;
      syncOwnerIdentityFromAuthState: () => void;
      ownerLidRecipient: string | null;
    };
    internals.authState = {
      state: { creds: {} }, // no me field
      saveCreds: async () => {},
    };
    internals.syncOwnerIdentityFromAuthState();
    expect(internals.ownerLidRecipient).toBeNull();
  });
});

// ── Additional coverage: requestQR edge cases ──

describe("WhatsAppAdapter — requestQR paths", () => {
  it("sock exists AND connectionState === 'ok' → returns early (already connected)", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      sock: unknown;
      connectionState: string;
      loadDependencies: () => Promise<void>;
      ensureAuthDir: () => void;
      ensureAuthState: () => Promise<void>;
    };
    // Pre-inject dependencies so loadDependencies doesn't actually import
    internals.loadDependencies = vi.fn().mockResolvedValue(undefined);
    internals.ensureAuthDir = vi.fn();
    internals.ensureAuthState = vi.fn().mockResolvedValue(undefined);

    // Simulate already connected
    internals.sock = {};
    internals.connectionState = "ok";

    // requestQR should return early without calling connect
    await adapter.requestQR();
    // No error means early return was successful
  });

  it("sock exists AND connectionState !== 'ok' → closes socket then reconnects", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      sock: unknown;
      connectionState: string;
      loadDependencies: () => Promise<void>;
      ensureAuthDir: () => void;
      ensureAuthState: () => Promise<void>;
      closeSocket: () => void;
      connect: () => Promise<void>;
    };

    internals.loadDependencies = vi.fn().mockResolvedValue(undefined);
    internals.ensureAuthDir = vi.fn();
    internals.ensureAuthState = vi.fn().mockResolvedValue(undefined);
    const closeSocketSpy = vi.fn();
    internals.closeSocket = closeSocketSpy;
    const connectSpy = vi.fn().mockResolvedValue(undefined);
    internals.connect = connectSpy;

    // sock exists but not in ok state
    internals.sock = {};
    internals.connectionState = "connecting";

    await adapter.requestQR();

    expect(closeSocketSpy).toHaveBeenCalledTimes(1);
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });
});

// ── Additional coverage: waitForQr paths ──

describe("WhatsAppAdapter — waitForQr additional paths", () => {
  it("connectionState === 'logged_out' during wait loop → returns null", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      connectionState: string;
      loadDependencies: () => Promise<void>;
      ensureAuthDir: () => void;
      ensureAuthState: () => Promise<void>;
      connect: () => Promise<void>;
    };

    internals.loadDependencies = vi.fn().mockResolvedValue(undefined);
    internals.ensureAuthDir = vi.fn();
    internals.ensureAuthState = vi.fn().mockResolvedValue(undefined);
    // connect sets state to logged_out
    internals.connect = vi.fn().mockImplementation(async () => {
      internals.connectionState = "logged_out";
    });

    const result = await adapter.waitForQr(500);
    expect(result).toBeNull();
  });

  it("timeout with no QR → returns null", async () => {
    const adapter = createAdapter();

    // Mock requestQR on the prototype so `this.requestQR()` inside waitForQr
    // resolves instantly without doing actual Baileys imports.
    const requestQRSpy = vi.spyOn(adapter, "requestQR" as any).mockResolvedValue(undefined);
    // connectionState stays "disabled" → loop runs, no QR arrives → exits after one 200ms poll

    // Use fake timers so the 200ms poll resolves immediately
    vi.useFakeTimers();
    const waitPromise = adapter.waitForQr(100);
    // Advance past the 200ms poll interval
    await vi.advanceTimersByTimeAsync(300);
    const result = await waitPromise;

    expect(result).toBeNull();
    requestQRSpy.mockRestore();
    vi.useRealTimers();
  });
});

// ── Additional coverage: stop() with pending reconnectTimer ──

describe("WhatsAppAdapter — stop() paths", () => {
  it("stop() with pending reconnectTimer clears it", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      reconnectTimer: ReturnType<typeof setTimeout> | null;
      shuttingDown: boolean;
      connectionState: string;
    };

    vi.useFakeTimers();
    // Set a pending reconnect timer
    internals.reconnectTimer = setTimeout(() => {}, 60_000);
    expect(internals.reconnectTimer).not.toBeNull();

    await adapter.stop();

    expect(internals.reconnectTimer).toBeNull();
    expect(internals.shuttingDown).toBe(true);
    vi.useRealTimers();
  });

  it("stop() without reconnectTimer works fine", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      reconnectTimer: ReturnType<typeof setTimeout> | null;
    };
    expect(internals.reconnectTimer).toBeNull();

    // Should not throw
    await adapter.stop();
  });
});

// ── Additional coverage: writeQrFile paths ──

describe("WhatsAppAdapter — writeQrFile paths", () => {
  it("writeQrFile with existing qrExpiryTimer clears it before setting new one", async () => {
    const adapter = createAdapter();
    const internal = adapter as unknown as {
      renderQrToDataUrl: (payload: string, opts?: object) => Promise<string>;
      captureQr: (payload: string) => Promise<void>;
      qrExpiryTimer: ReturnType<typeof setTimeout> | null;
      writeQrFile: (qr: string) => void;
    };
    internal.renderQrToDataUrl = vi.fn().mockResolvedValue("data:image/png;base64,QR_DATA");

    vi.useFakeTimers();

    // First QR sets a timer
    await internal.captureQr("QR1");
    const firstTimer = internal.qrExpiryTimer;
    expect(firstTimer).not.toBeNull();

    // Second QR should clear the first timer and set a new one
    await internal.captureQr("QR2");
    expect(internal.qrExpiryTimer).not.toBeNull();
    expect(internal.qrExpiryTimer).not.toBe(firstTimer);

    if (internal.qrExpiryTimer) clearTimeout(internal.qrExpiryTimer);
    vi.useRealTimers();
  });

  it("writeQrFile with non-existent auth dir — error silently caught", () => {
    // Create an adapter whose authDir doesn't exist.
    // writeQrFile tries to write to authDir/qr.txt; when authDir is missing
    // writeFileSync throws ENOENT, which the method catches silently.
    const adapter = new WhatsAppAdapter({
      ownerPhone: "+818012345678",
      authDir: "/nonexistent-dir-wa-test-9999/",
      onMessage: vi.fn(),
    });
    const internal = adapter as unknown as {
      writeQrFile: (qr: string) => void;
      qrExpiryTimer: ReturnType<typeof setTimeout> | null;
    };

    vi.useFakeTimers();

    // Should not throw — error is caught silently
    expect(() => internal.writeQrFile("QR_PAYLOAD")).not.toThrow();

    if (internal.qrExpiryTimer) clearTimeout(internal.qrExpiryTimer);
    vi.useRealTimers();
  });
});

// ── Additional coverage: start() when sock already exists ──

describe("WhatsAppAdapter — start() idempotency", () => {
  it("start() when sock already exists returns early", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      sock: unknown;
      loadDependencies: () => Promise<void>;
    };

    // Pre-set sock to simulate already started
    internals.sock = {};
    const loadDepsSpy = vi.fn();
    internals.loadDependencies = loadDepsSpy;

    await adapter.start();
    expect(loadDepsSpy).not.toHaveBeenCalled();
  });
});

// ── Additional coverage: parseMediaLength with bigint ──

describe("WhatsAppAdapter — parseMediaLength via bigint fileLength", () => {
  it("handles bigint fileLength in audioMessage", async () => {
    const store = fakeAttachmentStore();
    const onMessage = vi.fn();
    const adapter = createAdapter(onMessage, store);
    const downloadMediaMessage = vi.fn().mockResolvedValue(Buffer.from([1, 2, 3]));
    (adapter as unknown as { downloadMediaMessage: typeof downloadMediaMessage }).downloadMediaMessage =
      downloadMediaMessage;

    // fileLength as a bigint value — must be parsed correctly (not trigger oversized check for BigInt(100))
    await (adapter as unknown as { handleIncomingMessage: (msg: unknown) => Promise<void> }).handleIncomingMessage({
      key: {
        id: "wa-bigint-1",
        remoteJid: "818012345678@s.whatsapp.net",
        fromMe: false,
      },
      message: {
        audioMessage: {
          mimetype: "audio/ogg",
          fileLength: BigInt(100), // bigint
        },
      },
    });

    expect(downloadMediaMessage).toHaveBeenCalled();
    expect(store.ingestStream).toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledTimes(1);
  });
});

// ── Additional coverage: scheduleReconnect timer callback paths ──

describe("WhatsAppAdapter — scheduleReconnect timer callback paths", () => {
  it("timer fires and shuttingDown=true → early return without connect", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.useFakeTimers();

    const adapter = createAdapter();
    const internals = asInternals(adapter);
    const connectSpy = vi.fn().mockResolvedValue(undefined);
    (internals as unknown as { connect: () => Promise<void> }).connect = connectSpy;

    internals.scheduleReconnect();
    // Now set shuttingDown before the timer fires
    internals.shuttingDown = true;

    await vi.runAllTimersAsync();

    expect(connectSpy).not.toHaveBeenCalled();
    const reconnectTimer = (internals as { reconnectTimer?: ReturnType<typeof setTimeout> | null }).reconnectTimer;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    vi.useRealTimers();
  });

  it("timer fires and connectionState=logged_out → early return without connect", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.useFakeTimers();

    const adapter = createAdapter();
    const internals = asInternals(adapter);
    const connectSpy = vi.fn().mockResolvedValue(undefined);
    (internals as unknown as { connect: () => Promise<void> }).connect = connectSpy;

    internals.scheduleReconnect();
    internals.connectionState = "logged_out";

    await vi.runAllTimersAsync();

    expect(connectSpy).not.toHaveBeenCalled();
    const reconnectTimer = (internals as { reconnectTimer?: ReturnType<typeof setTimeout> | null }).reconnectTimer;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    vi.useRealTimers();
  });

  it("timer fires and connect() throws → error caught, scheduleReconnect called again", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.useFakeTimers();

    const adapter = createAdapter();
    const internals = asInternals(adapter);

    // connect throws — captures state after the first failure
    const connectSpy = vi.fn().mockRejectedValue(new Error("connect failed"));
    (internals as unknown as { connect: () => Promise<void> }).connect = connectSpy;

    internals.scheduleReconnect();
    // attempt 1 fires: initial delay = 1000ms (jitter=0)
    await vi.advanceTimersByTimeAsync(1100);

    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(internals.connectionState).toBe("disconnected");
    expect(internals.lastError).toContain("connect failed");

    // Clean up any subsequent timer scheduled by the error-recovery path
    const reconnectTimer = (internals as { reconnectTimer?: ReturnType<typeof setTimeout> | null }).reconnectTimer;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    vi.useRealTimers();
  });

  it("timer fires and connect() throws non-Error → String(err) path (line 1037)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.useFakeTimers();

    const adapter = createAdapter();
    const internals = asInternals(adapter);

    // connect throws a non-Error value
    const connectSpy = vi.fn().mockRejectedValue("string connect err 1037");
    (internals as unknown as { connect: () => Promise<void> }).connect = connectSpy;

    internals.scheduleReconnect();
    await vi.advanceTimersByTimeAsync(1100);

    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(internals.lastError).toBe("string connect err 1037");

    const reconnectTimer = (internals as { reconnectTimer?: ReturnType<typeof setTimeout> | null }).reconnectTimer;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    vi.useRealTimers();
  });
});

// ── Additional coverage: loadDependencies() and ensureAuthState() via vi.mock ──
// The vi.mock() calls at the top of this file intercept the dynamic imports.

describe("WhatsAppAdapter — loadDependencies() via mocked modules", () => {
  it("loadDependencies: populates all fields from the mocked baileys/qrcode modules", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      loadDependencies: () => Promise<void>;
      makeWASocket: unknown;
      renderQr: unknown;
      renderQrToDataUrl: unknown;
      fetchLatestWaWebVersion: unknown;
      fetchLatestBaileysVersion: unknown;
      generateMessageId: unknown;
      downloadMediaMessage: unknown;
      loggedOutCode: number | null;
    };

    // All of these start as null
    expect(internals.makeWASocket).toBeNull();

    await (internals as unknown as { loadDependencies: () => Promise<void> }).loadDependencies();

    // After loading, all fields should be populated
    expect(typeof internals.makeWASocket).toBe("function");
    expect(typeof internals.renderQr).toBe("function");
    expect(typeof internals.renderQrToDataUrl).toBe("function");
    expect(typeof internals.fetchLatestWaWebVersion).toBe("function");
    expect(typeof internals.fetchLatestBaileysVersion).toBe("function");
    expect(typeof internals.generateMessageId).toBe("function");
    expect(typeof internals.downloadMediaMessage).toBe("function");
    expect(internals.loggedOutCode).toBe(401);
  });

  it("loadDependencies: uses baileys.makeWASocket when baileys.default is not a function", async () => {
    // Test the false branch of `typeof baileys.default === "function"` (line 660)
    const { default: baileysDefault, ...rest } = await import("@whiskeysockets/baileys" as string);
    // Override: default is not a function, makeWASocket is provided instead
    const mockMakeWASocket = vi.fn().mockReturnValue({
      ev: { on: vi.fn(), removeAllListeners: vi.fn() },
      ws: { close: vi.fn() },
      end: vi.fn(),
    });
    const baileysModule = await import("@whiskeysockets/baileys" as string) as Record<string, unknown>;
    const originalDefault = baileysModule.default;
    // Temporarily make default not a function
    Object.defineProperty(baileysModule, 'default', { value: "not-a-function", configurable: true });
    Object.defineProperty(baileysModule, 'makeWASocket', { value: mockMakeWASocket, configurable: true });

    const adapter = createAdapter();
    const internals = adapter as unknown as {
      loadDependencies: () => Promise<void>;
      makeWASocket: unknown;
    };

    await (internals as unknown as { loadDependencies: () => Promise<void> }).loadDependencies();
    expect(internals.makeWASocket).toBe(mockMakeWASocket);

    // Restore
    Object.defineProperty(baileysModule, 'default', { value: originalDefault, configurable: true });
  });

  it("loadDependencies: second call is a no-op (early return when already loaded)", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      loadDependencies: () => Promise<void>;
      makeWASocket: unknown;
    };

    await (internals as unknown as { loadDependencies: () => Promise<void> }).loadDependencies();
    const firstSocket = internals.makeWASocket;

    // Call again — should not reimport or reassign
    await (internals as unknown as { loadDependencies: () => Promise<void> }).loadDependencies();
    expect(internals.makeWASocket).toBe(firstSocket);
  });

  it("ensureAuthDir: creates authDir (mkdirSync idempotent)", () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      ensureAuthDir: () => void;
    };
    // Should not throw — authDir already exists (created by mkdtempSync in createAdapter)
    expect(() => internals.ensureAuthDir()).not.toThrow();
  });

  it("ensureAuthState: second call returns early when authState already set", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      ensureAuthState: () => Promise<void>;
      authState: { state: unknown; saveCreds: () => Promise<void> } | null;
    };

    // Pre-inject authState to simulate already initialized
    const existingAuthState = {
      state: { creds: { me: { lid: "pre:0@lid" } } },
      saveCreds: vi.fn().mockResolvedValue(undefined),
    };
    internals.authState = existingAuthState;

    await internals.ensureAuthState();
    // Since authState was already set, it should not be replaced
    expect(internals.authState).toBe(existingAuthState);
  });

  it("requestQR(): clears existing reconnectTimer before proceeding (lines 371-373)", async () => {
    vi.useFakeTimers();
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      reconnectTimer: ReturnType<typeof setTimeout> | null;
      loadDependencies: () => Promise<void>;
      ensureAuthDir: () => void;
      ensureAuthState: () => Promise<void>;
      connect: () => Promise<void>;
      sock: unknown;
      connectionState: string;
    };

    // Set a pending reconnect timer
    internals.reconnectTimer = setTimeout(() => {}, 60_000);
    internals.loadDependencies = vi.fn().mockResolvedValue(undefined);
    internals.ensureAuthDir = vi.fn();
    internals.ensureAuthState = vi.fn().mockResolvedValue(undefined);
    internals.connect = vi.fn().mockResolvedValue(undefined);

    await adapter.requestQR();

    expect(internals.reconnectTimer).toBeNull();
    vi.useRealTimers();
  });

  it("requestQR(): catch block when loadDependencies throws → sets lastError and rethrows", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      loadDependencies: () => Promise<void>;
      lastError: string | null;
    };

    internals.loadDependencies = vi.fn().mockRejectedValue(new Error("load failed"));

    await expect(adapter.requestQR()).rejects.toThrow("load failed");
    expect(internals.lastError).toBe("load failed");
  });

  it("requestQR(): non-Error rejection from loadDependencies → String(err) path (line 381)", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      loadDependencies: () => Promise<void>;
      lastError: string | null;
    };

    internals.loadDependencies = vi.fn().mockRejectedValue("string error from load");

    await expect(adapter.requestQR()).rejects.toBe("string error from load");
    expect(internals.lastError).toBe("string error from load");
  });

  it("requestQR(): catch block when connect throws → sets lastError and rethrows", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      loadDependencies: () => Promise<void>;
      ensureAuthDir: () => void;
      ensureAuthState: () => Promise<void>;
      connect: () => Promise<void>;
      lastError: string | null;
    };

    internals.loadDependencies = vi.fn().mockResolvedValue(undefined);
    internals.ensureAuthDir = vi.fn();
    internals.ensureAuthState = vi.fn().mockResolvedValue(undefined);
    internals.connect = vi.fn().mockRejectedValue(new Error("connect failed in requestQR"));

    await expect(adapter.requestQR()).rejects.toThrow("connect failed in requestQR");
    expect(internals.lastError).toBe("connect failed in requestQR");
  });

  it("requestQR(): non-Error rejection from connect → String(err) path (line 393)", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      loadDependencies: () => Promise<void>;
      ensureAuthDir: () => void;
      ensureAuthState: () => Promise<void>;
      connect: () => Promise<void>;
      lastError: string | null;
    };

    internals.loadDependencies = vi.fn().mockResolvedValue(undefined);
    internals.ensureAuthDir = vi.fn();
    internals.ensureAuthState = vi.fn().mockResolvedValue(undefined);
    internals.connect = vi.fn().mockRejectedValue("string connect error");

    await expect(adapter.requestQR()).rejects.toBe("string connect error");
    expect(internals.lastError).toBe("string connect error");
  });

  it("start(): full lifecycle — loadDependencies, ensureAuthDir, ensureAuthState, connect", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      loadDependencies: () => Promise<void>;
      ensureAuthDir: () => void;
      ensureAuthState: () => Promise<void>;
      connect: () => Promise<void>;
      shuttingDown: boolean;
      reconnectAttempts: number;
    };

    internals.loadDependencies = vi.fn().mockResolvedValue(undefined);
    internals.ensureAuthDir = vi.fn();
    internals.ensureAuthState = vi.fn().mockResolvedValue(undefined);
    internals.connect = vi.fn().mockResolvedValue(undefined);

    await adapter.start();

    expect(internals.loadDependencies).toHaveBeenCalledTimes(1);
    expect(internals.ensureAuthDir).toHaveBeenCalledTimes(1);
    expect(internals.ensureAuthState).toHaveBeenCalledTimes(1);
    expect(internals.connect).toHaveBeenCalledTimes(1);
    expect(internals.shuttingDown).toBe(false);
    expect(internals.reconnectAttempts).toBe(0);
  });

  it("connect(): throws when dependencies not initialized (no makeWASocket)", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      connect: () => Promise<void>;
      makeWASocket: null;
      authState: { state: unknown; saveCreds: () => Promise<void> };
    };

    internals.makeWASocket = null;
    internals.authState = { state: {}, saveCreds: async () => {} };

    await expect(internals.connect()).rejects.toThrow("dependencies are not initialized");
  });

  it("connect(): shuttingDown=true after resolveWAVersion → aborts and sets disabled", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      connect: () => Promise<void>;
      makeWASocket: ((opts: unknown) => unknown) | null;
      authState: { state: unknown; saveCreds: () => Promise<void> } | null;
      shuttingDown: boolean;
      connectionState: string;
      fetchLatestWaWebVersion: (() => Promise<unknown>) | null;
      fetchLatestBaileysVersion: (() => Promise<unknown>) | null;
    };

    await (internals as unknown as { loadDependencies: () => Promise<void> }).loadDependencies();
    internals.authState = { state: { creds: {} }, saveCreds: vi.fn().mockResolvedValue(undefined) };
    // Make version resolution set shuttingDown mid-flight
    internals.fetchLatestWaWebVersion = vi.fn().mockImplementation(async () => {
      internals.shuttingDown = true;
      return { version: [2, 9999, 1], isLatest: true };
    });
    internals.fetchLatestBaileysVersion = vi.fn().mockResolvedValue({ version: [2, 1234, 5], isLatest: false });

    await internals.connect();

    expect(internals.connectionState).toBe("disabled");
  });

  it("connect() ev.on callbacks: creds.update fires captureOwnerIdentity, messages.upsert fires handleMessagesUpsert", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      makeWASocket: ((opts: unknown) => unknown) | null;
      authState: { state: unknown; saveCreds: () => Promise<void> } | null;
      connect: () => Promise<void>;
      ownerLidRecipient: string | null;
      loadDependencies: () => Promise<void>;
    };

    await (internals as unknown as { loadDependencies: () => Promise<void> }).loadDependencies();
    internals.authState = { state: { creds: {} }, saveCreds: vi.fn().mockResolvedValue(undefined) };

    const onCallbacks: Record<string, ((...args: unknown[]) => void)[]> = {};
    const fakeSock = {
      ev: {
        on: vi.fn().mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
          if (!onCallbacks[event]) onCallbacks[event] = [];
          onCallbacks[event].push(cb);
        }),
        removeAllListeners: vi.fn(),
      },
      ws: { close: vi.fn() },
      end: vi.fn(),
    };
    internals.makeWASocket = vi.fn().mockReturnValue(fakeSock);

    await internals.connect();

    // Trigger the creds.update callback with a valid LID
    const credsUpdateCallbacks = onCallbacks["creds.update"];
    expect(credsUpdateCallbacks).toHaveLength(2); // saveCreds + captureOwnerIdentity
    // Second callback is captureOwnerIdentity
    credsUpdateCallbacks?.[1]?.({ me: { lid: "77665544:1@lid" } });
    expect(internals.ownerLidRecipient).toBe("77665544@lid");

    // Trigger the messages.upsert callback (with empty array — no events emitted)
    const msgsUpsertCallbacks = onCallbacks["messages.upsert"];
    expect(msgsUpsertCallbacks).toHaveLength(1);
    msgsUpsertCallbacks?.[0]?.({ messages: [] }); // no message events

    // Trigger the connection.update callback
    const connUpdateCallbacks = onCallbacks["connection.update"];
    expect(connUpdateCallbacks).toHaveLength(1);
    // Trigger with a non-actionable update
    connUpdateCallbacks?.[0]?.({ connection: "connecting" });

    await adapter.stop();
  });

  it("start(): with mocked dependencies, connect() registers event listeners on sock", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      sock: unknown;
      connectionState: string;
      shuttingDown: boolean;
      makeWASocket: ((opts: unknown) => unknown) | null;
      authState: { state: unknown; saveCreds: () => Promise<void> } | null;
    };

    // Pre-inject authState so ensureAuthState returns early
    internals.authState = {
      state: { creds: {} },
      saveCreds: vi.fn().mockResolvedValue(undefined),
    };

    // After loadDependencies (via start), makeWASocket should be set
    await (internals as unknown as { loadDependencies: () => Promise<void> }).loadDependencies();
    expect(typeof internals.makeWASocket).toBe("function");

    // Manually call connect() with mocked socket
    const fakeSock = {
      ev: { on: vi.fn(), removeAllListeners: vi.fn() },
      ws: { close: vi.fn() },
      end: vi.fn(),
    };
    internals.makeWASocket = vi.fn().mockReturnValue(fakeSock);

    await (adapter as unknown as { connect: () => Promise<void> }).connect();

    expect(internals.sock).toBe(fakeSock);
    // ev.on should have been called for creds.update, messages.upsert, connection.update
    expect(fakeSock.ev.on).toHaveBeenCalledWith("creds.update", expect.any(Function));
    expect(fakeSock.ev.on).toHaveBeenCalledWith("messages.upsert", expect.any(Function));
    expect(fakeSock.ev.on).toHaveBeenCalledWith("connection.update", expect.any(Function));

    // Clean up
    await adapter.stop();
  });
});

// ── Additional coverage: parseMediaLength edge cases ──

describe("WhatsAppAdapter — parseMediaLength edge cases", () => {
  it("parseMediaLength: returns 0 for null/undefined/false", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = createAdapter(onMessage, store);
    const downloadMediaMessage = vi.fn().mockResolvedValue(Buffer.from([1, 2, 3]));
    (adapter as unknown as { downloadMediaMessage: typeof downloadMediaMessage }).downloadMediaMessage =
      downloadMediaMessage;

    // fileLength = null → parseMediaLength returns 0 → 0 is not > limit → proceeds to download
    await (adapter as unknown as { handleIncomingMessage: (msg: unknown) => Promise<void> }).handleIncomingMessage({
      key: {
        id: "wa-null-len",
        remoteJid: "818012345678@s.whatsapp.net",
        fromMe: false,
      },
      message: {
        audioMessage: {
          mimetype: "audio/ogg",
          fileLength: null, // null → parseMediaLength(null) → 0
        },
      },
    });

    // 0 is not > WA_AUDIO_MAX_BYTES, so download should proceed
    expect(downloadMediaMessage).toHaveBeenCalled();
  });

  it("parseMediaLength: string value parsed as number", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = createAdapter(onMessage, store);
    const downloadMediaMessage = vi.fn().mockResolvedValue(Buffer.from([1, 2, 3]));
    (adapter as unknown as { downloadMediaMessage: typeof downloadMediaMessage }).downloadMediaMessage =
      downloadMediaMessage;

    await (adapter as unknown as { handleIncomingMessage: (msg: unknown) => Promise<void> }).handleIncomingMessage({
      key: {
        id: "wa-str-len",
        remoteJid: "818012345678@s.whatsapp.net",
        fromMe: false,
      },
      message: {
        audioMessage: {
          mimetype: "audio/ogg",
          fileLength: "1000", // string → Number("1000") = 1000
        },
      },
    });

    expect(downloadMediaMessage).toHaveBeenCalled();
  });
});

// ── Additional coverage: unwrapWhatsAppMessage with nested wrapper ──

describe("WhatsAppAdapter — unwrapWhatsAppMessage nested wrapper coverage", () => {
  it("unwrapWhatsAppMessage: 5 levels of ephemeralMessage nesting → loop exits normally (line 221)", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = createAdapter(onMessage, store);
    const downloadMediaMessage = vi.fn().mockResolvedValue(Buffer.from([1, 2, 3]));
    (adapter as unknown as { downloadMediaMessage: typeof downloadMediaMessage }).downloadMediaMessage =
      downloadMediaMessage;

    // Build 5 levels of ephemeralMessage nesting with an image at the bottom
    const innerMessage = {
      imageMessage: { mimetype: "image/jpeg", fileLength: 100 },
    };
    const level4 = { ephemeralMessage: { message: innerMessage } };
    const level3 = { ephemeralMessage: { message: level4 } };
    const level2 = { ephemeralMessage: { message: level3 } };
    const level1 = { ephemeralMessage: { message: level2 } };
    const level0 = { ephemeralMessage: { message: level1 } };

    // This creates exactly 5 levels: the loop runs 5 times and exits normally (line 221)
    await (adapter as unknown as { handleIncomingMessage: (msg: unknown) => Promise<void> }).handleIncomingMessage({
      key: { id: "wa-deep-5", remoteJid: "818012345678@s.whatsapp.net", fromMe: false },
      message: level0,
    });

    // After 5 unwraps, we get innerMessage (which has imageMessage)
    // The image is downloaded and ingested
    expect(downloadMediaMessage).toHaveBeenCalled();
  });

  it("extractAndIngestWhatsAppMedia: message with null inner message → unwrapWhatsAppMessage returns null (line 212)", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = createAdapter(onMessage, store);
    const downloadMediaMessage = vi.fn();
    (adapter as unknown as { downloadMediaMessage: typeof downloadMediaMessage }).downloadMediaMessage =
      downloadMediaMessage;

    // Message with undefined .message field → extractAndIngestWhatsAppMedia gets null → returns []
    await (adapter as unknown as { handleIncomingMessage: (msg: unknown) => Promise<void> }).handleIncomingMessage({
      key: { id: "wa-null-msg", remoteJid: "818012345678@s.whatsapp.net", fromMe: false },
      message: undefined, // rawMessage.message is undefined → unwrapWhatsAppMessage(null) → null
    });

    // No text, no media → no event
    expect(onMessage).not.toHaveBeenCalled();
    expect(downloadMediaMessage).not.toHaveBeenCalled();
  });

  it("extractAndIngestWhatsAppMedia: handles image inside ephemeralMessage wrapper", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = createAdapter(onMessage, store);
    const downloadMediaMessage = vi.fn().mockResolvedValue(Buffer.from([1, 2, 3]));
    (adapter as unknown as { downloadMediaMessage: typeof downloadMediaMessage }).downloadMediaMessage =
      downloadMediaMessage;

    // Wrap image in ephemeralMessage — unwrapWhatsAppMessage will unwrap it
    await (adapter as unknown as { handleIncomingMessage: (msg: unknown) => Promise<void> }).handleIncomingMessage({
      key: {
        id: "wa-ephem-img",
        remoteJid: "818012345678@s.whatsapp.net",
        fromMe: false,
      },
      message: {
        ephemeralMessage: {
          message: {
            imageMessage: {
              mimetype: "image/jpeg",
              fileLength: 100,
            },
          },
        },
      },
    });

    expect(downloadMediaMessage).toHaveBeenCalled();
    expect(store.ingestStream).toHaveBeenCalled();
  });
});

// ── Additional coverage: normalizeWhatsAppUserJid edge cases ──

describe("WhatsAppAdapter — normalizeWhatsAppUserJid edge cases (via handleMessagesUpsert)", () => {
  // normalizeWhatsAppUserJid is private but called via handleMessagesUpsert
  // The "drops messages from non-owner JIDs" test covers the happy path.
  // Here we cover the edge cases via the public handleMessagesUpsert interface.

  it("JID starting with @ (at=0) → rejected as non-DM", () => {
    const onMessage = vi.fn();
    const adapter = createAdapter(onMessage);

    (adapter as unknown as { handleMessagesUpsert: (payload: unknown) => void }).handleMessagesUpsert({
      messages: [{
        key: { id: "edge1", remoteJid: "@s.whatsapp.net", fromMe: false },
        message: { conversation: "hello" },
      }],
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("JID with no @ → rejected as non-DM (at=-1, line 148)", () => {
    const onMessage = vi.fn();
    const adapter = createAdapter(onMessage);

    (adapter as unknown as { handleMessagesUpsert: (payload: unknown) => void }).handleMessagesUpsert({
      messages: [{
        key: { id: "edge2", remoteJid: "nodomain", fromMe: false },
        message: { conversation: "hello" },
      }],
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("JID with empty user part ':@domain' → rejected (line 152 !user branch)", () => {
    const onMessage = vi.fn();
    const adapter = createAdapter(onMessage);

    // ":@s.whatsapp.net" → at=1, local=":", user=local.split(":")[0]="" → !user → return null
    (adapter as unknown as { handleMessagesUpsert: (payload: unknown) => void }).handleMessagesUpsert({
      messages: [{
        key: { id: "edge3", remoteJid: ":@s.whatsapp.net", fromMe: false },
        message: { conversation: "hello" },
      }],
    });

    expect(onMessage).not.toHaveBeenCalled();
  });
});

// ── Additional coverage: handleIncomingMessage with fromMe + non-string messageId ──

describe("WhatsAppAdapter — handleIncomingMessage fromMe non-string messageId", () => {
  it("fromMe=true with non-string messageId → consumeSentMessageId(null) → treats as self-DM", () => {
    const onMessage = vi.fn();
    const adapter = createAdapter(onMessage);

    // fromMe=true, messageId=undefined → typeof undefined !== "string" → passes null to consumeSentMessageId
    // consumeSentMessageId(null) returns false → proceeds to self-DM handling
    (adapter as unknown as { handleMessagesUpsert: (payload: unknown) => void }).handleMessagesUpsert({
      messages: [{
        key: {
          id: undefined, // non-string messageId
          remoteJid: "818012345678@s.whatsapp.net",
          fromMe: true,
        },
        message: { conversation: "self-dm with no id" },
      }],
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
  });
});

// ── Additional coverage: handleIncomingMessage waMessageId ?? null ──

describe("WhatsAppAdapter — handleIncomingMessage waMessageId null path", () => {
  it("event data.waMessageId is null when key.id is undefined (line 1121 ?? null)", () => {
    const onMessage = vi.fn();
    const adapter = createAdapter(onMessage);

    // key.id is undefined → rawMessage?.key?.id ?? null = null
    (adapter as unknown as { handleMessagesUpsert: (payload: unknown) => void }).handleMessagesUpsert({
      messages: [{
        key: {
          id: undefined, // undefined → ?? null = null
          remoteJid: "818012345678@s.whatsapp.net",
          fromMe: false,
        },
        message: { conversation: "no message id" },
      }],
    });

    const event = onMessage.mock.calls[0][0] as { data: { waMessageId: string | null } };
    expect(event.data.waMessageId).toBeNull();
  });
});

// ── Additional coverage: extractAndIngestWhatsAppMedia image with no mimetype ──

describe("WhatsAppAdapter — extractAndIngestWhatsAppMedia default mimetype", () => {
  it("image with no mimetype → uses 'image/jpeg' default (line 1151 ?? fallback)", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = createAdapter(onMessage, store);
    const downloadMediaMessage = vi.fn().mockResolvedValue(Buffer.from([1, 2, 3]));
    (adapter as unknown as { downloadMediaMessage: typeof downloadMediaMessage }).downloadMediaMessage =
      downloadMediaMessage;

    await (adapter as unknown as { handleIncomingMessage: (msg: unknown) => Promise<void> }).handleIncomingMessage({
      key: { id: "wa-img-no-mime", remoteJid: "818012345678@s.whatsapp.net", fromMe: false },
      message: {
        imageMessage: {
          // No mimetype field → defaults to "image/jpeg"
          fileLength: 100,
        },
      },
    });

    expect(store.ingestStream).toHaveBeenCalledWith(
      expect.objectContaining({ declaredMimeType: "image/jpeg" }),
    );
  });

  it("document with no mimetype → uses 'application/octet-stream' default", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = createAdapter(onMessage, store);
    const downloadMediaMessage = vi.fn().mockResolvedValue(Buffer.from([1, 2, 3]));
    (adapter as unknown as { downloadMediaMessage: typeof downloadMediaMessage }).downloadMediaMessage =
      downloadMediaMessage;

    await (adapter as unknown as { handleIncomingMessage: (msg: unknown) => Promise<void> }).handleIncomingMessage({
      key: { id: "wa-doc-no-mime", remoteJid: "818012345678@s.whatsapp.net", fromMe: false },
      message: {
        documentMessage: {
          // No mimetype → defaults to "application/octet-stream"
          fileLength: 100,
        },
      },
    });

    expect(store.ingestStream).toHaveBeenCalledWith(
      expect.objectContaining({ declaredMimeType: "application/octet-stream" }),
    );
  });

  it("audio with no mimetype → uses 'audio/ogg' default", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = createAdapter(onMessage, store);
    const downloadMediaMessage = vi.fn().mockResolvedValue(Buffer.from([1, 2, 3]));
    (adapter as unknown as { downloadMediaMessage: typeof downloadMediaMessage }).downloadMediaMessage =
      downloadMediaMessage;

    await (adapter as unknown as { handleIncomingMessage: (msg: unknown) => Promise<void> }).handleIncomingMessage({
      key: { id: "wa-audio-no-mime", remoteJid: "818012345678@s.whatsapp.net", fromMe: false },
      message: {
        audioMessage: {
          // No mimetype → defaults to "audio/ogg"
          fileLength: 100,
        },
      },
    });

    expect(store.ingestStream).toHaveBeenCalledWith(
      expect.objectContaining({ declaredMimeType: "audio/ogg" }),
    );
  });

  it("video with no mimetype → uses 'video/mp4' default", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = createAdapter(onMessage, store);
    const downloadMediaMessage = vi.fn().mockResolvedValue(Buffer.from([1, 2, 3]));
    (adapter as unknown as { downloadMediaMessage: typeof downloadMediaMessage }).downloadMediaMessage =
      downloadMediaMessage;

    await (adapter as unknown as { handleIncomingMessage: (msg: unknown) => Promise<void> }).handleIncomingMessage({
      key: { id: "wa-video-no-mime", remoteJid: "818012345678@s.whatsapp.net", fromMe: false },
      message: {
        videoMessage: {
          // No mimetype → defaults to "video/mp4"
          fileLength: 100,
        },
      },
    });

    expect(store.ingestStream).toHaveBeenCalledWith(
      expect.objectContaining({ declaredMimeType: "video/mp4" }),
    );
  });
});

// ── Additional coverage: parseMediaLength edge cases (string non-finite) ──

describe("WhatsAppAdapter — parseMediaLength string non-finite path", () => {
  it("fileLength as object with non-finite toString → treated as 0 (line 202 false branch)", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = createAdapter(onMessage, store);
    const downloadMediaMessage = vi.fn().mockResolvedValue(Buffer.from([1, 2, 3]));
    (adapter as unknown as { downloadMediaMessage: typeof downloadMediaMessage }).downloadMediaMessage =
      downloadMediaMessage;

    // Object whose toString() returns "NaN" → Number("NaN") = NaN → !isFinite → returns 0
    await (adapter as unknown as { handleIncomingMessage: (msg: unknown) => Promise<void> }).handleIncomingMessage({
      key: { id: "wa-obj-nan-len", remoteJid: "818012345678@s.whatsapp.net", fromMe: false },
      message: {
        audioMessage: {
          mimetype: "audio/ogg",
          fileLength: { toString: () => "NaN" }, // → Number("NaN") = NaN → 0
        },
      },
    });

    // 0 is not > WA_AUDIO_MAX_BYTES, proceeds to download
    expect(downloadMediaMessage).toHaveBeenCalled();
  });

  it("fileLength as non-numeric string → treated as 0 (not > size limit → downloads)", async () => {
    const onMessage = vi.fn();
    const store = fakeAttachmentStore();
    const adapter = createAdapter(onMessage, store);
    const downloadMediaMessage = vi.fn().mockResolvedValue(Buffer.from([1, 2, 3]));
    (adapter as unknown as { downloadMediaMessage: typeof downloadMediaMessage }).downloadMediaMessage =
      downloadMediaMessage;

    await (adapter as unknown as { handleIncomingMessage: (msg: unknown) => Promise<void> }).handleIncomingMessage({
      key: { id: "wa-nan-len", remoteJid: "818012345678@s.whatsapp.net", fromMe: false },
      message: {
        audioMessage: {
          mimetype: "audio/ogg",
          fileLength: "not-a-number", // NaN → parseMediaLength returns 0
        },
      },
    });

    // 0 is not > WA_AUDIO_MAX_BYTES, proceeds to download
    expect(downloadMediaMessage).toHaveBeenCalled();
  });
});

// ── Additional coverage: handleMessagesUpsert catch path ──

describe("WhatsAppAdapter — handleMessagesUpsert catch block", () => {
  it("catch block fires when handleIncomingMessage throws (line 1055)", async () => {
    const onMessage = vi.fn();
    const adapter = createAdapter(onMessage);

    // Override handleIncomingMessage to throw
    const errorPromise = new Promise<void>((resolve) => {
      (adapter as unknown as { handleIncomingMessage: (msg: unknown) => Promise<void> }).handleIncomingMessage =
        vi.fn().mockImplementation(async () => {
          resolve();
          throw new Error("incoming handler threw");
        });
    });

    // handleMessagesUpsert calls handleIncomingMessage in a void+catch
    (adapter as unknown as { handleMessagesUpsert: (payload: unknown) => void }).handleMessagesUpsert({
      messages: [{ key: { id: "x", remoteJid: "foo@s.whatsapp.net", fromMe: false }, message: {} }],
    });

    // Wait for the handler to be called
    await errorPromise;
    // Should not have thrown — error was caught silently
  });
});

// ── Additional coverage: captureQr null check ──

describe("WhatsAppAdapter — captureQr with null renderQrToDataUrl", () => {
  it("throws 'qrcode renderer not initialized' when renderQrToDataUrl is null", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      renderQrToDataUrl: null;
      captureQr: (payload: string) => Promise<void>;
    };
    internals.renderQrToDataUrl = null;

    await expect(internals.captureQr("PAYLOAD")).rejects.toThrow("qrcode renderer not initialized");
  });
});

// ── Additional coverage: writeQrFile timer callback ──

describe("WhatsAppAdapter — writeQrFile timer callback fires", () => {
  it("QR expiry timer fires: clears snapshot and file", async () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      renderQrToDataUrl: ((payload: string, opts?: object) => Promise<string>) | null;
      captureQr: (payload: string) => Promise<void>;
      latestQr: unknown;
      qrExpiryTimer: ReturnType<typeof setTimeout> | null;
    };
    internals.renderQrToDataUrl = vi.fn().mockResolvedValue("data:image/png;base64,QR_EXPIRE");

    vi.useFakeTimers();
    await internals.captureQr("EXPIRE_QR");

    expect(internals.latestQr).not.toBeNull();
    expect(internals.qrExpiryTimer).not.toBeNull();

    // Advance past the QR TTL (90s)
    await vi.advanceTimersByTimeAsync(91_000);

    expect(internals.latestQr).toBeNull();
    expect(internals.qrExpiryTimer).toBeNull();
    vi.useRealTimers();
  });
});

// ── Additional coverage: closeSocket with throwing methods ──

describe("WhatsAppAdapter — closeSocket with methods that throw", () => {
  it("silently catches errors from ev.removeAllListeners, ws.close, and sock.end", () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      sock: unknown;
      loggedOutCode: number | null;
      closeSocket: () => void;
    };
    internals.loggedOutCode = 401;

    // All methods throw
    internals.sock = {
      ev: {
        removeAllListeners: vi.fn().mockImplementation(() => { throw new Error("ev already torn down"); }),
      },
      ws: {
        close: vi.fn().mockImplementation(() => { throw new Error("ws close error"); }),
      },
      end: vi.fn().mockImplementation(() => { throw new Error("end error"); }),
    };

    // Should not throw
    expect(() => internals.closeSocket()).not.toThrow();
    expect(internals.sock).toBeNull();
  });
});

// ── Additional coverage: captureOwnerIdentity with valid LID ──

describe("WhatsAppAdapter — captureOwnerIdentity with valid LID string", () => {
  it("sets ownerLidRecipient when me.lid is a valid LID string", () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      captureOwnerIdentity: (update: unknown) => void;
      ownerLidRecipient: string | null;
    };

    internals.captureOwnerIdentity({ me: { lid: "99887766:3@lid" } });
    expect(internals.ownerLidRecipient).toBe("99887766@lid");
  });
});

// ── Additional coverage: syncOwnerIdentityFromAuthState with valid LID ──

describe("WhatsAppAdapter — syncOwnerIdentityFromAuthState with valid LID", () => {
  it("sets ownerLidRecipient from auth state creds.me.lid", () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      authState: { state: { creds?: { me?: { lid?: string } } }; saveCreds: () => Promise<void> } | null;
      syncOwnerIdentityFromAuthState: () => void;
      ownerLidRecipient: string | null;
    };

    internals.authState = {
      state: { creds: { me: { lid: "55443322:0@lid" } } },
      saveCreds: async () => {},
    };
    internals.syncOwnerIdentityFromAuthState();
    expect(internals.ownerLidRecipient).toBe("55443322@lid");
  });
});

// ── Additional coverage: clearQrSnapshot and clearQrFile internals ──

describe("WhatsAppAdapter — clearQrSnapshot and clearQrFile", () => {
  it("clearQrSnapshot clears latestQr and qrExpiryTimer", () => {
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      latestQr: unknown;
      qrExpiryTimer: ReturnType<typeof setTimeout> | null;
      clearQrSnapshot: () => void;
    };

    vi.useFakeTimers();
    internals.latestQr = { payload: "QR", dataUrl: "data:", generatedAt: Date.now(), expiresAt: Date.now() + 90000 };
    internals.qrExpiryTimer = setTimeout(() => {}, 90000);

    internals.clearQrSnapshot();

    expect(internals.latestQr).toBeNull();
    expect(internals.qrExpiryTimer).toBeNull();
    vi.useRealTimers();
  });

  it("clearQrFile: ignores missing-file errors", () => {
    // Use an authDir with no qr.txt — clearQrFile should not throw
    const adapter = createAdapter();
    const internals = adapter as unknown as {
      clearQrFile: () => void;
    };

    // The authDir was created in createAdapter() but no qr.txt file exists
    expect(() => internals.clearQrFile()).not.toThrow();
  });
});

// ── Additional coverage: handleMessagesUpsert with empty messages array ──

describe("WhatsAppAdapter — handleMessagesUpsert edge cases", () => {
  it("handles non-array messages field gracefully", () => {
    const onMessage = vi.fn();
    const adapter = createAdapter(onMessage);

    (adapter as unknown as { handleMessagesUpsert: (payload: unknown) => void }).handleMessagesUpsert({
      messages: null,
    });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("handles undefined payload gracefully", () => {
    const onMessage = vi.fn();
    const adapter = createAdapter(onMessage);

    (adapter as unknown as { handleMessagesUpsert: (payload: unknown) => void }).handleMessagesUpsert(null);
    expect(onMessage).not.toHaveBeenCalled();
  });
});

// ── Additional coverage: sendMessage attachment when readFileSync throws ──

describe("WhatsAppAdapter — sendMessage attachment error path", () => {
  it("actualId is not a string → uses preId (false branch of line 526 ternary)", async () => {
    const adapter = createAdapter();
    const sendMessage = vi.fn().mockResolvedValue({
      key: { id: null, fromMe: true, remoteJid: "818012345678@s.whatsapp.net" },
    });
    const internals = adapter as unknown as {
      sock: { sendMessage: typeof sendMessage };
      connectionState: string;
      generateMessageId: (() => string) | null;
    };
    internals.sock = { sendMessage };
    internals.connectionState = "ok";
    internals.generateMessageId = () => "pre-id-null-actual";

    const result = await adapter.sendMessage({
      channel: "818012345678@s.whatsapp.net",
      text: "caption",
      attachments: [{
        path: _tmpImgPath,
        mimeType: "image/jpeg",
        originalFilename: "img.jpg",
        id: "att-null",
        sizeBytes: 4,
      }],
    });

    // actualId is null (not a string), preId is "pre-id-null-actual"
    expect(result.messageId).toBe("pre-id-null-actual");
  });

  it("both actualId and preId are null → uses lastMessageId (line 526 ?? branch)", async () => {
    const adapter = createAdapter();
    const sendMessage = vi.fn().mockResolvedValue({
      key: { id: null, fromMe: true, remoteJid: "818012345678@s.whatsapp.net" },
    });
    const internals = adapter as unknown as {
      sock: { sendMessage: typeof sendMessage };
      connectionState: string;
      generateMessageId: (() => string) | null;
    };
    internals.sock = { sendMessage };
    internals.connectionState = "ok";
    internals.generateMessageId = null; // preId = null

    // With long text, text is sent first, then attachment bare
    // lastMessageId is set from the text send
    const longText = "x".repeat(1025);
    let callCount = 0;
    sendMessage.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // Text chunk returns a real id
        return { key: { id: "text-chunk-id", fromMe: true, remoteJid: "818012345678@s.whatsapp.net" } };
      }
      // Attachment returns null id
      return { key: { id: null, fromMe: true, remoteJid: "818012345678@s.whatsapp.net" } };
    });

    const result = await adapter.sendMessage({
      channel: "818012345678@s.whatsapp.net",
      text: longText,
      attachments: [{
        path: _tmpImgPath,
        mimeType: "image/jpeg",
        originalFilename: "img.jpg",
        id: "att-fallback",
        sizeBytes: 4,
      }],
    });

    // lastMessageId should fall back to the text chunk id
    expect(result.messageId).toBe("text-chunk-id");
  });

  it("logs error and continues when readFileSync throws for an attachment", async () => {
    const adapter = createAdapter();
    const sendMessageMock = vi.fn().mockResolvedValue({
      key: { id: "text-id", fromMe: true, remoteJid: "818012345678@s.whatsapp.net" },
    });
    const internals = adapter as unknown as {
      sock: { sendMessage: typeof sendMessageMock };
      connectionState: string;
      generateMessageId: (() => string) | null;
    };
    internals.sock = { sendMessage: sendMessageMock };
    internals.connectionState = "ok";
    internals.generateMessageId = null;

    // Use a path that doesn't exist — readFileSync will throw ENOENT
    const result = await adapter.sendMessage({
      channel: "818012345678@s.whatsapp.net",
      text: "caption",
      attachments: [
        {
          path: "/nonexistent-path-wa-test-9999/file.jpg",
          mimeType: "image/jpeg",
          originalFilename: "file.jpg",
          id: "att-err",
          sizeBytes: 0,
        },
      ],
    });

    // The attachment failed silently; no crash. messageId may be undefined.
    expect(result).toBeDefined();
  });
});

// ── Additional coverage: beginProcessingIndicator when connectionState !== "ok" ──

describe("WhatsAppAdapter — beginProcessingIndicator non-ok state", () => {
  it("sendPresence returns early when connectionState is not ok", async () => {
    vi.useFakeTimers();
    const adapter = createAdapter();
    const sendPresenceUpdate = vi.fn().mockResolvedValue(undefined);
    const internals = adapter as unknown as {
      sock: { sendPresenceUpdate: typeof sendPresenceUpdate };
      connectionState: string;
    };
    internals.sock = { sendPresenceUpdate };
    internals.connectionState = "connecting"; // not "ok"

    const handle = await adapter.beginProcessingIndicator({
      channel: "818012345678@s.whatsapp.net",
    });

    // sendPresenceUpdate should NOT be called since connectionState !== "ok"
    expect(sendPresenceUpdate).not.toHaveBeenCalled();

    await handle.stop();
    vi.useRealTimers();
  });
});
