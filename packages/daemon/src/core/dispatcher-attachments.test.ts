import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

// N2 spawn gate — permissive stub so dispatcher construction never hits
// the real DNS resolver from unit tests (see dispatcher.test.ts).
vi.mock("./spawn-gates.js", () => ({
  AutonomousSpawnGate: class {
    evaluate = async () => ({ skip: false, backends: [] });
  },
}));
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createEvent, EventPriority } from "@aitne/shared";
import type { MessageEvent } from "@aitne/shared";
import { applySchema } from "../db/schema.js";
import { EventDispatcher } from "./dispatcher.js";
import { EventBus } from "./event-bus.js";
import { AttachmentStore } from "../services/attachments/store.js";
import type { StoreAttachmentRow } from "../services/attachments/store.js";
import type { VoiceTranscriptionResult } from "../services/voice/transcriber.js";
import type {
  IAgentRouter,
  IContextBuilder,
  INotificationManager,
  ISessionManager,
  IMessageRecorder,
  IAuditLogger,
  ReplyActivityHandle,
} from "./dispatcher.js";
import type { AgentConfig } from "../config.js";

function pngBytes(): Buffer {
  return Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
      "0000000d49444154789c626000000000050001b6a87db60000000049454e44ae426082",
    "hex",
  );
}

function fakeConfig(dataDir: string): AgentConfig {
  return {
    dataDir,
    workspaceDir: join(dataDir, "workdirs"),
    apiPort: 0,
    disallowedTools: [],
    timezone: "UTC",
    dayBoundaryHour: 4,
    maxReactiveSessions: 1,
    maxConcurrentSessions: 1,
    executeTimeoutMinutes: 5,
  } as unknown as AgentConfig;
}

function makeDispatcher(db: Database.Database, dataDir: string): {
  dispatcher: EventDispatcher;
  store: AttachmentStore;
} {
  const config = fakeConfig(dataDir);
  const store = new AttachmentStore(db, dataDir);

  const router: IAgentRouter = {
    execute: vi.fn(),
    executeResume: vi.fn(),
    summarize: vi.fn(),
    resolveBinding: vi.fn(),
  };
  const contextBuilder: IContextBuilder = {
    build: vi.fn().mockResolvedValue(""),
    buildResumeCatchupContext: vi.fn().mockResolvedValue(null),
  };
  const replyActivity: ReplyActivityHandle = { stop: vi.fn() };
  const notificationMgr: INotificationManager = {
    send: vi.fn(),
    beginReplyActivity: vi.fn().mockResolvedValue(replyActivity),
  };
  const sessionMgr = {
    getOrCreate: vi.fn(),
    findActive: vi.fn(),
    updateSession: vi.fn(),
    markFreshExecuteStart: vi.fn(),
    touchSession: vi.fn(),
    closeSession: vi.fn(),
    closeSessionInTx: vi.fn(),
    newEffectsBuffer: vi.fn(),
    flushEffects: vi.fn(),
    getActiveChannelIdForSession: vi.fn().mockReturnValue(null),
    getDmPlatformsWithNewMessages: vi.fn().mockReturnValue([]),
    getUnsummarizedDmMessages: vi.fn().mockReturnValue([]),
    getPreviousDmSummary: vi.fn().mockReturnValue(null),
    saveDmSummary: vi.fn(),
    markActiveDmSessionsStale: vi.fn(),
  } as unknown as ISessionManager;
  const messageRecorder: IMessageRecorder = { recordMessage: vi.fn() };
  const audit: IAuditLogger = {
    logAction: vi.fn(),
    logSkip: vi.fn(),
    logError: vi.fn(),
    logAttachment: vi.fn(),
    logBangCommand: vi.fn(),
    insertInProgressRow: vi.fn(() => -1),
  };
  const dispatcher = new EventDispatcher(
    new EventBus(),
    router,
    contextBuilder,
    () => "",
    notificationMgr,
    sessionMgr,
    messageRecorder,
    audit,
    db,
    config,
  );
  dispatcher.setAttachmentStore(store);
  return { dispatcher, store };
}

describe("dispatcher attachment turn-token lifecycle", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-disp-att-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns null for an unknown token", () => {
    const { dispatcher } = makeDispatcher(db, dataDir);
    expect(dispatcher.validateAttachmentTurnToken("does-not-exist")).toBeNull();
  });

  it("does not accept a released outbound attachment after releaseTurnToken", async () => {
    const { dispatcher, store } = makeDispatcher(db, dataDir);
    // Can't easily exercise the private issueAttachmentTurnToken directly;
    // use the store path to simulate what the agent would do.
    const token = "t-1";
    await store.ingestStream({
      stream: Readable.from(pngBytes()),
      declaredMimeType: "image/png",
      originalFilename: "a.png",
      direction: "outbound",
      provenance: "agent",
      turnToken: token,
      maxSizeBytes: 1024 * 1024,
    });
    // Dispatcher has never issued this token, so validateAttachmentTurnToken
    // must refuse to authenticate it even though the DB has a row with it.
    expect(dispatcher.validateAttachmentTurnToken(token)).toBeNull();
  });
});

describe("dispatcher attachment prompt block", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-disp-att-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("stageInboundAttachments is a no-op when event has no attachments", () => {
    const { dispatcher } = makeDispatcher(db, dataDir);
    const event: MessageEvent = {
      ...createEvent({
        type: "message.received",
        source: "dashboard",
        priority: EventPriority.HIGH,
      }),
      sender: "user",
      channel: "abc",
      content: "hi",
      platform: "dashboard",
      threadId: null,
      isDm: true,
      isMention: false,
    };
    // Using a disambiguated any-cast to reach the private helper for
    // purposes of this narrow behavior check.
    const result = (
      dispatcher as unknown as { prompt: {
        stageInboundAttachments(e: MessageEvent, dir: string): unknown[];
      } }
    ).prompt.stageInboundAttachments(event, "/tmp/not-used");
    expect(result).toEqual([]);
  });

  it("describes audio/video attachments as staged files in the prompt block", () => {
    const { dispatcher } = makeDispatcher(db, dataDir);
    const row: StoreAttachmentRow = {
      id: "att-1",
      sessionId: 1,
      messageId: null,
      direction: "inbound",
      provenance: "user_discord",
      path: "/tmp/clip.mp4",
      originalFilename: "clip.mp4",
      safeFilename: "clip.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1024,
      turnToken: null,
      caption: null,
      createdAt: "2026-04-22T00:00:00.000Z",
    };

    const block = (
      dispatcher as unknown as { prompt: {
        buildAttachmentPromptBlock(rows: StoreAttachmentRow[]): string;
      } }
    ).prompt.buildAttachmentPromptBlock([row]);

    expect(block).toContain("_attachments/clip.mp4");
    expect(block).toContain("audio/video");
    expect(block).toContain("transcription");
  });

  it("renders an inline 'Voice transcript' for audio rows that have a transcript", () => {
    const { dispatcher } = makeDispatcher(db, dataDir);
    const row: StoreAttachmentRow = {
      id: "att-voice",
      sessionId: 1,
      messageId: null,
      direction: "inbound",
      provenance: "user_telegram",
      path: "/tmp/voice.ogg",
      originalFilename: "voice.ogg",
      safeFilename: "voice.ogg",
      mimeType: "audio/ogg",
      sizeBytes: 4096,
      turnToken: null,
      caption: null,
      createdAt: "2026-05-04T00:00:00.000Z",
    };
    const transcripts = new Map([
      [
        "att-voice",
        {
          attachmentId: "att-voice",
          transcript: "今日の天気を教えて",
          language: "ja",
          durationSec: 3.4,
          model: "Xenova/whisper-small",
          fromCache: false,
        },
      ],
    ]);

    const block = (
      dispatcher as unknown as { prompt: {
        buildAttachmentPromptBlock(
          rows: StoreAttachmentRow[],
          transcripts: Map<string, VoiceTranscriptionResult>,
        ): string;
      } }
    ).prompt.buildAttachmentPromptBlock([row], transcripts);

    expect(block).toContain("_attachments/voice.ogg");
    expect(block).toContain("Voice transcript");
    expect(block).toContain("(lang=ja)");
    expect(block).toContain("3.4s");
    expect(block).toContain('"今日の天気を教えて"');
  });

  it("renders the transcript without language/duration when those fields are missing", () => {
    const { dispatcher } = makeDispatcher(db, dataDir);
    const row: StoreAttachmentRow = {
      id: "att-voice2",
      sessionId: 1,
      messageId: null,
      direction: "inbound",
      provenance: "user_whatsapp",
      path: "/tmp/voice.ogg",
      originalFilename: "voice.ogg",
      safeFilename: "voice.ogg",
      mimeType: "audio/ogg",
      sizeBytes: 2048,
      turnToken: null,
      caption: null,
      createdAt: "2026-05-04T00:00:00.000Z",
    };
    const transcripts = new Map([
      [
        "att-voice2",
        {
          attachmentId: "att-voice2",
          transcript: "hello world",
          language: null,
          durationSec: null,
          model: "Xenova/whisper-small",
          fromCache: true,
        },
      ],
    ]);

    const block = (
      dispatcher as unknown as { prompt: {
        buildAttachmentPromptBlock(
          rows: StoreAttachmentRow[],
          transcripts: Map<string, VoiceTranscriptionResult>,
        ): string;
      } }
    ).prompt.buildAttachmentPromptBlock([row], transcripts);

    expect(block).toContain('Voice transcript: "hello world"');
    expect(block).not.toContain("(lang=");
    expect(block).not.toMatch(/\d+\.\d+s/);
  });

  it("annotates audio rows without a transcript when the transcriber is enabled", () => {
    const { dispatcher } = makeDispatcher(db, dataDir);
    const fakeTranscriber = {
      isAudio: (mime: string) => mime.startsWith("audio/"),
      isEnabled: () => true,
      transcribe: vi.fn(),
    };
    dispatcher.setVoiceTranscriber(fakeTranscriber as never);
    const audioRow: StoreAttachmentRow = {
      id: "att-too-long",
      sessionId: 1,
      messageId: null,
      direction: "inbound",
      provenance: "user_telegram",
      path: "/tmp/voice.ogg",
      originalFilename: "voice.ogg",
      safeFilename: "voice.ogg",
      mimeType: "audio/ogg",
      sizeBytes: 99999,
      turnToken: null,
      caption: null,
      createdAt: "2026-05-04T00:00:00.000Z",
    };
    const block = (
      dispatcher as unknown as { prompt: {
        buildAttachmentPromptBlock(rows: StoreAttachmentRow[]): string;
      } }
    ).prompt.buildAttachmentPromptBlock([audioRow]);
    expect(block).toContain("voice transcript unavailable");
    // Non-audio rows should not get the marker.
    expect(block).not.toContain("Voice transcript");
  });

  it("does not annotate audio rows when the transcriber is disabled", () => {
    const { dispatcher } = makeDispatcher(db, dataDir);
    const fakeTranscriber = {
      isAudio: () => true,
      isEnabled: () => false,
      transcribe: vi.fn(),
    };
    dispatcher.setVoiceTranscriber(fakeTranscriber as never);
    const audioRow: StoreAttachmentRow = {
      id: "att-disabled",
      sessionId: 1,
      messageId: null,
      direction: "inbound",
      provenance: "user_telegram",
      path: "/tmp/voice.ogg",
      originalFilename: "voice.ogg",
      safeFilename: "voice.ogg",
      mimeType: "audio/ogg",
      sizeBytes: 1024,
      turnToken: null,
      caption: null,
      createdAt: "2026-05-04T00:00:00.000Z",
    };
    const block = (
      dispatcher as unknown as { prompt: {
        buildAttachmentPromptBlock(rows: StoreAttachmentRow[]): string;
      } }
    ).prompt.buildAttachmentPromptBlock([audioRow]);
    expect(block).not.toContain("voice transcript unavailable");
  });

  it("does not annotate non-audio attachments missing a transcript", () => {
    const { dispatcher } = makeDispatcher(db, dataDir);
    const fakeTranscriber = {
      isAudio: (mime: string) => mime.startsWith("audio/"),
      isEnabled: () => true,
      transcribe: vi.fn(),
    };
    dispatcher.setVoiceTranscriber(fakeTranscriber as never);
    const photoRow: StoreAttachmentRow = {
      id: "att-photo",
      sessionId: 1,
      messageId: null,
      direction: "inbound",
      provenance: "user_telegram",
      path: "/tmp/photo.jpg",
      originalFilename: "photo.jpg",
      safeFilename: "photo.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1024,
      turnToken: null,
      caption: null,
      createdAt: "2026-05-04T00:00:00.000Z",
    };
    const block = (
      dispatcher as unknown as { prompt: {
        buildAttachmentPromptBlock(rows: StoreAttachmentRow[]): string;
      } }
    ).prompt.buildAttachmentPromptBlock([photoRow]);
    expect(block).not.toContain("voice transcript unavailable");
  });

  it("transcribeAttachments returns empty when no voice transcriber is wired", async () => {
    const { dispatcher } = makeDispatcher(db, dataDir);
    const row: StoreAttachmentRow = {
      id: "att-x",
      sessionId: 1,
      messageId: null,
      direction: "inbound",
      provenance: "user_telegram",
      path: "/tmp/voice.ogg",
      originalFilename: "voice.ogg",
      safeFilename: "voice.ogg",
      mimeType: "audio/ogg",
      sizeBytes: 1024,
      turnToken: null,
      caption: null,
      createdAt: "2026-05-04T00:00:00.000Z",
    };
    const result = await (
      dispatcher as unknown as { prompt: {
        transcribeAttachments(rows: StoreAttachmentRow[]): Promise<Map<string, unknown>>;
      } }
    ).prompt.transcribeAttachments([row]);
    expect(result.size).toBe(0);
  });

  it("transcribeAttachments only invokes the transcriber for audio rows", async () => {
    const { dispatcher } = makeDispatcher(db, dataDir);
    const transcribe = vi.fn().mockResolvedValue({
      attachmentId: "att-audio",
      transcript: "ok",
      language: "en",
      durationSec: 1.2,
      model: "Xenova/whisper-small",
      fromCache: false,
    });
    const fakeTranscriber = {
      isAudio: (mime: string) => mime.startsWith("audio/"),
      isEnabled: () => true,
      transcribe,
    };
    dispatcher.setVoiceTranscriber(fakeTranscriber as never);
    const audioRow: StoreAttachmentRow = {
      id: "att-audio",
      sessionId: 1,
      messageId: null,
      direction: "inbound",
      provenance: "user_telegram",
      path: "/tmp/voice.ogg",
      originalFilename: "voice.ogg",
      safeFilename: "voice.ogg",
      mimeType: "audio/ogg",
      sizeBytes: 1024,
      turnToken: null,
      caption: null,
      createdAt: "2026-05-04T00:00:00.000Z",
    };
    const photoRow: StoreAttachmentRow = {
      ...audioRow,
      id: "att-photo",
      mimeType: "image/jpeg",
      originalFilename: "p.jpg",
      safeFilename: "p.jpg",
    };
    const result = await (
      dispatcher as unknown as { prompt: {
        transcribeAttachments(rows: StoreAttachmentRow[]): Promise<Map<string, unknown>>;
      } }
    ).prompt.transcribeAttachments([audioRow, photoRow]);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(result.has("att-audio")).toBe(true);
    expect(result.has("att-photo")).toBe(false);
  });

  it("transcribeAttachments swallows transcriber rejections per attachment", async () => {
    const { dispatcher } = makeDispatcher(db, dataDir);
    const transcribe = vi
      .fn()
      .mockRejectedValueOnce(new Error("first throws"))
      .mockResolvedValueOnce({
        attachmentId: "att-2",
        transcript: "second works",
        language: "en",
        durationSec: 1,
        model: "Xenova/whisper-small",
        fromCache: false,
      });
    const fakeTranscriber = {
      isAudio: () => true,
      isEnabled: () => true,
      transcribe,
    };
    dispatcher.setVoiceTranscriber(fakeTranscriber as never);
    const rows: StoreAttachmentRow[] = [
      {
        id: "att-1",
        sessionId: 1,
        messageId: null,
        direction: "inbound",
        provenance: "user_telegram",
        path: "/tmp/a.ogg",
        originalFilename: "a.ogg",
        safeFilename: "a.ogg",
        mimeType: "audio/ogg",
        sizeBytes: 1024,
        turnToken: null,
        caption: null,
        createdAt: "2026-05-04T00:00:00.000Z",
      },
      {
        id: "att-2",
        sessionId: 1,
        messageId: null,
        direction: "inbound",
        provenance: "user_telegram",
        path: "/tmp/b.ogg",
        originalFilename: "b.ogg",
        safeFilename: "b.ogg",
        mimeType: "audio/ogg",
        sizeBytes: 1024,
        turnToken: null,
        caption: null,
        createdAt: "2026-05-04T00:00:00.000Z",
      },
    ];
    const result = await (
      dispatcher as unknown as { prompt: {
        transcribeAttachments(rows: StoreAttachmentRow[]): Promise<Map<string, { transcript: string }>>;
      } }
    ).prompt.transcribeAttachments(rows);
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(result.has("att-1")).toBe(false);
    expect(result.get("att-2")?.transcript).toBe("second works");
  });
});
