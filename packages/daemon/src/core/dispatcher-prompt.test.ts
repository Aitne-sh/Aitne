import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applySchema } from "../db/schema.js";
import { setDegradedMode } from "../db/runtime-state.js";
import { PromptAssembler } from "./dispatcher-prompt.js";
import type { AgentConfig } from "../config.js";
import type { AttachmentStore, StoreAttachmentRow } from "../services/attachments/store.js";
import type { VoiceTranscriber } from "../services/voice/transcriber.js";
import type { GetTaskFlow } from "./dispatcher-types.js";

function fakeConfig(dataDir: string, workspaceDir?: string): AgentConfig {
  return {
    dataDir,
    workspaceDir: workspaceDir ?? join(dataDir, "workdirs"),
    apiPort: 0,
    timezone: "UTC",
    dayBoundaryHour: 4,
    maxReactiveSessions: 1,
    maxConcurrentSessions: 1,
    executeTimeoutMinutes: 5,
    useReviewDossiers: false,
    useContextIndex: false,
  } as unknown as AgentConfig;
}

function makeAssembler(opts: {
  db: Database.Database;
  dataDir: string;
  workspaceDir?: string;
  getTaskFlow?: GetTaskFlow;
  attachmentStore?: AttachmentStore | null;
  voiceTranscriber?: VoiceTranscriber | null;
  activeTurnTokens?: Map<string, number>;
}): { prompt: PromptAssembler; activeTurnTokens: Map<string, number> } {
  const activeTurnTokens = opts.activeTurnTokens ?? new Map<string, number>();
  const prompt = new PromptAssembler({
    db: opts.db,
    config: fakeConfig(opts.dataDir, opts.workspaceDir),
    getTaskFlow: opts.getTaskFlow ?? (() => "task-flow-template"),
    activeTurnTokens,
    getAttachmentStore: () => opts.attachmentStore ?? null,
    getVoiceTranscriber: () => opts.voiceTranscriber ?? null,
  });
  return { prompt, activeTurnTokens };
}

describe("PromptAssembler — turn-token lifecycle", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-prompt-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("issueAttachmentTurnToken inserts into the live activeTurnTokens map", () => {
    const { prompt, activeTurnTokens } = makeAssembler({ db, dataDir });
    const token = prompt.issueAttachmentTurnToken(42);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
    expect(activeTurnTokens.get(token)).toBe(42);
  });

  it("releaseAttachmentTurnToken deletes from the live map", () => {
    const { prompt, activeTurnTokens } = makeAssembler({ db, dataDir });
    const token = prompt.issueAttachmentTurnToken(7);
    prompt.releaseAttachmentTurnToken(token);
    expect(activeTurnTokens.has(token)).toBe(false);
  });

  it("issued tokens are unique per call", () => {
    const { prompt } = makeAssembler({ db, dataDir });
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) {
      seen.add(prompt.issueAttachmentTurnToken(i));
    }
    expect(seen.size).toBe(25);
  });
});

describe("PromptAssembler — stageInboundAttachments", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-prompt-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns [] when the attachment store is unwired", () => {
    const { prompt } = makeAssembler({ db, dataDir, attachmentStore: null });
    const event = {
      attachments: [{ id: "att-1" }],
    } as unknown as Parameters<PromptAssembler["stageInboundAttachments"]>[0];
    expect(prompt.stageInboundAttachments(event, "/tmp/sd")).toEqual([]);
  });

  it("returns [] when sessionDir is undefined", () => {
    const fakeStore = { get: vi.fn(), stageIntoWorkdir: vi.fn() } as unknown as AttachmentStore;
    const { prompt } = makeAssembler({ db, dataDir, attachmentStore: fakeStore });
    const event = {
      attachments: [{ id: "att-1" }],
    } as unknown as Parameters<PromptAssembler["stageInboundAttachments"]>[0];
    expect(prompt.stageInboundAttachments(event, undefined)).toEqual([]);
  });

  it("returns [] when the event has no attachments", () => {
    const fakeStore = { get: vi.fn(), stageIntoWorkdir: vi.fn() } as unknown as AttachmentStore;
    const { prompt } = makeAssembler({ db, dataDir, attachmentStore: fakeStore });
    const event = { attachments: [] } as unknown as Parameters<PromptAssembler["stageInboundAttachments"]>[0];
    expect(prompt.stageInboundAttachments(event, "/tmp/sd")).toEqual([]);
  });

  it("skips rows the store cannot find", () => {
    const fakeStore = {
      get: vi.fn().mockReturnValue(null),
      stageIntoWorkdir: vi.fn(),
    } as unknown as AttachmentStore;
    const { prompt } = makeAssembler({ db, dataDir, attachmentStore: fakeStore });
    const event = {
      attachments: [{ id: "missing" }],
    } as unknown as Parameters<PromptAssembler["stageInboundAttachments"]>[0];
    expect(prompt.stageInboundAttachments(event, "/tmp/sd")).toEqual([]);
    expect(fakeStore.stageIntoWorkdir).not.toHaveBeenCalled();
  });

  it("collects rows the store stages successfully and skips throws", () => {
    const row1: StoreAttachmentRow = { id: "ok", path: "/tmp/ok" } as StoreAttachmentRow;
    const row2: StoreAttachmentRow = { id: "fail", path: "/tmp/fail" } as StoreAttachmentRow;
    const fakeStore = {
      get: vi.fn((id: string) => (id === "ok" ? row1 : row2)),
      stageIntoWorkdir: vi.fn().mockImplementation((arg: { row: StoreAttachmentRow }) => {
        if (arg.row.id === "fail") throw new Error("boom");
      }),
    } as unknown as AttachmentStore;
    const { prompt } = makeAssembler({ db, dataDir, attachmentStore: fakeStore });
    const event = {
      attachments: [{ id: "ok" }, { id: "fail" }],
    } as unknown as Parameters<PromptAssembler["stageInboundAttachments"]>[0];
    const staged = prompt.stageInboundAttachments(event, "/tmp/sd");
    expect(staged).toEqual([row1]);
  });
});

describe("PromptAssembler — buildAttachmentPromptBlock", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-prompt-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns an empty string for no rows", () => {
    const { prompt } = makeAssembler({ db, dataDir });
    expect(prompt.buildAttachmentPromptBlock([])).toBe("");
  });

  it("includes the file path, mime type, and approximate KB size", () => {
    const { prompt } = makeAssembler({ db, dataDir });
    const row: StoreAttachmentRow = {
      id: "att",
      sizeBytes: 2048,
      safeFilename: "file.png",
      mimeType: "image/png",
      caption: null,
    } as StoreAttachmentRow;
    const block = prompt.buildAttachmentPromptBlock([row]);
    expect(block).toContain("_attachments/file.png");
    expect(block).toContain("image/png");
    expect(block).toContain("2 KB");
  });

  it("renders a caption when provided", () => {
    const { prompt } = makeAssembler({ db, dataDir });
    const row: StoreAttachmentRow = {
      id: "att",
      sizeBytes: 1024,
      safeFilename: "memo.png",
      mimeType: "image/png",
      caption: "test caption",
    } as StoreAttachmentRow;
    const block = prompt.buildAttachmentPromptBlock([row]);
    expect(block).toContain('caption: "test caption"');
  });

  it("annotates audio rows without transcripts when the transcriber is enabled", () => {
    const transcriber = {
      isAudio: (mt: string) => mt.startsWith("audio/"),
      isEnabled: () => true,
    } as unknown as VoiceTranscriber;
    const { prompt } = makeAssembler({ db, dataDir, voiceTranscriber: transcriber });
    const row: StoreAttachmentRow = {
      id: "att",
      sizeBytes: 9999,
      safeFilename: "voice.ogg",
      mimeType: "audio/ogg",
      caption: null,
    } as StoreAttachmentRow;
    const block = prompt.buildAttachmentPromptBlock([row]);
    expect(block).toContain("voice transcript unavailable");
  });

  it("does NOT annotate audio rows when the transcriber is disabled", () => {
    const transcriber = {
      isAudio: () => true,
      isEnabled: () => false,
    } as unknown as VoiceTranscriber;
    const { prompt } = makeAssembler({ db, dataDir, voiceTranscriber: transcriber });
    const row: StoreAttachmentRow = {
      id: "att",
      sizeBytes: 1024,
      safeFilename: "voice.ogg",
      mimeType: "audio/ogg",
      caption: null,
    } as StoreAttachmentRow;
    const block = prompt.buildAttachmentPromptBlock([row]);
    expect(block).not.toContain("voice transcript unavailable");
  });
});

describe("PromptAssembler — transcribeAttachments", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-prompt-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns an empty map when the transcriber is unwired", async () => {
    const { prompt } = makeAssembler({ db, dataDir, voiceTranscriber: null });
    const row = { id: "x", mimeType: "audio/ogg", path: "/tmp/x" } as StoreAttachmentRow;
    const result = await prompt.transcribeAttachments([row]);
    expect(result.size).toBe(0);
  });

  it("returns an empty map when given no rows", async () => {
    const transcriber = {
      isAudio: () => true,
      isEnabled: () => true,
      transcribe: vi.fn(),
    } as unknown as VoiceTranscriber;
    const { prompt } = makeAssembler({ db, dataDir, voiceTranscriber: transcriber });
    expect((await prompt.transcribeAttachments([])).size).toBe(0);
  });

  it("invokes the transcriber only for audio rows", async () => {
    const transcribe = vi.fn().mockResolvedValue({
      attachmentId: "audio",
      transcript: "ok",
      language: "en",
      durationSec: 1.2,
      model: "Xenova/whisper-small",
      fromCache: false,
    });
    const transcriber = {
      isAudio: (mt: string) => mt.startsWith("audio/"),
      isEnabled: () => true,
      transcribe,
    } as unknown as VoiceTranscriber;
    const { prompt } = makeAssembler({ db, dataDir, voiceTranscriber: transcriber });
    const audioRow = { id: "audio", mimeType: "audio/ogg", path: "/tmp/a" } as StoreAttachmentRow;
    const photoRow = { id: "photo", mimeType: "image/jpeg", path: "/tmp/p" } as StoreAttachmentRow;
    const result = await prompt.transcribeAttachments([audioRow, photoRow]);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(result.has("audio")).toBe(true);
    expect(result.has("photo")).toBe(false);
  });

  it("swallows per-attachment transcription failures", async () => {
    const transcribe = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({
        attachmentId: "ok",
        transcript: "got it",
        language: "en",
        durationSec: 1,
        model: "Xenova/whisper-small",
        fromCache: false,
      });
    const transcriber = {
      isAudio: () => true,
      isEnabled: () => true,
      transcribe,
    } as unknown as VoiceTranscriber;
    const { prompt } = makeAssembler({ db, dataDir, voiceTranscriber: transcriber });
    const rows: StoreAttachmentRow[] = [
      { id: "fails", mimeType: "audio/ogg", path: "/tmp/f" } as StoreAttachmentRow,
      { id: "ok", mimeType: "audio/ogg", path: "/tmp/o" } as StoreAttachmentRow,
    ];
    const result = await prompt.transcribeAttachments(rows);
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(result.has("fails")).toBe(false);
    expect(result.has("ok")).toBe(true);
  });
});

describe("PromptAssembler — assemble", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-prompt-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns the bare task-flow when degraded mode disables policy injection", () => {
    setDegradedMode(db, {
      reason: "vault_missing",
      path: null,
      since: new Date().toISOString(),
    });
    const { prompt } = makeAssembler({
      db,
      dataDir,
      getTaskFlow: () => "BASE_TEMPLATE",
    });
    expect(prompt.assemble("evt", "process", "claude", {})).toBe("BASE_TEMPLATE");
  });
});

describe("PromptAssembler — assemble playbook injection (Phase 2)", () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // packages/daemon/src/core → repo root (has agent-assets/)
  const REPO_ROOT = resolve(__dirname, "../../../../");
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-prompt-pb-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("injects a declared playbook's content from the daemon bundle", () => {
    const { prompt } = makeAssembler({
      db,
      dataDir,
      workspaceDir: REPO_ROOT,
      getTaskFlow: () => "BASE_TEMPLATE",
    });
    const out = prompt.assemble("scheduled.task", "agent.task", "claude", undefined, [
      "research",
    ]);
    expect(out.startsWith("BASE_TEMPLATE")).toBe(true);
    expect(out).toContain("## Operating playbooks");
    expect(out).toContain("### Research playbook (`playbooks:research`)");
    // Frontmatter of the reference file must not leak into the prompt.
    expect(out).not.toContain("kind: reference");
  });

  it("is a no-op when the firing declares no playbooks", () => {
    const { prompt } = makeAssembler({
      db,
      dataDir,
      workspaceDir: REPO_ROOT,
      getTaskFlow: () => "BASE_TEMPLATE",
    });
    const withNone = prompt.assemble("scheduled.task", "agent.task", "claude", undefined, []);
    const withUndef = prompt.assemble("scheduled.task", "agent.task", "claude");
    expect(withNone).not.toContain("## Operating playbooks");
    expect(withUndef).not.toContain("## Operating playbooks");
    expect(withNone).toBe(withUndef);
  });
});
