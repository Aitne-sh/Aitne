import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../db/schema.js";
import {
  getVoiceTranscript,
  saveVoiceTranscript,
} from "../../db/voice-transcripts-store.js";
import {
  VoiceTranscriber,
  isWhisperPlaceholderOutput,
  type AudioDecoder,
  type DecodedAudio,
  type PipelineLoader,
  type WhisperPipeline,
} from "./transcriber.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function seedAttachment(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO chat_attachments
       (id, direction, provenance, path, original_filename, safe_filename, mime_type, size_bytes)
     VALUES (?, 'inbound', 'user_telegram', ?, ?, ?, 'audio/ogg', ?)`,
  ).run(id, `/tmp/${id}/voice.ogg`, "voice.ogg", "voice.ogg", 1024);
}

function makeDecoder(audio: DecodedAudio): AudioDecoder {
  return vi.fn(async () => audio);
}

function makePipeline(output: { text: string; language?: string | null }): {
  loader: PipelineLoader;
  pipeline: WhisperPipeline;
} {
  const pipeline = vi.fn(async () => output) as unknown as WhisperPipeline;
  const loader = vi.fn(async () => pipeline) as unknown as PipelineLoader;
  return { loader, pipeline };
}

function silentSamples(durationSec: number, sampleRate = 16000): DecodedAudio {
  return {
    samples: new Float32Array(Math.round(durationSec * sampleRate)),
    sampleRate,
    durationSec,
  };
}

describe("VoiceTranscriber", () => {
  let db: Database.Database;
  let modelDir: string;

  beforeEach(() => {
    db = freshDb();
    modelDir = mkdtempSync(join(tmpdir(), "pa-voice-"));
    seedAttachment(db, "att-1");
    delete process.env.HF_HOME;
    delete process.env.TRANSFORMERS_CACHE;
  });

  it("isAudio matches audio/* MIME types and rejects others", () => {
    const t = new VoiceTranscriber({ db, modelDir });
    expect(t.isAudio("audio/ogg")).toBe(true);
    expect(t.isAudio("audio/mpeg")).toBe(true);
    expect(t.isAudio("audio/mp4; codecs=opus")).toBe(true);
    expect(t.isAudio(" Audio/wav ".trim())).toBe(true);
    expect(t.isAudio("video/mp4")).toBe(false);
    expect(t.isAudio("image/jpeg")).toBe(false);
    expect(t.isAudio("")).toBe(false);
  });

  it("isEnabled reports the configured flag", () => {
    expect(new VoiceTranscriber({ db, modelDir }).isEnabled()).toBe(true);
    expect(new VoiceTranscriber({ db, modelDir, enabled: false }).isEnabled()).toBe(
      false,
    );
  });

  it("constructor sets HF_HOME / TRANSFORMERS_CACHE when enabled", () => {
    new VoiceTranscriber({ db, modelDir });
    expect(process.env.HF_HOME).toBe(modelDir);
    expect(process.env.TRANSFORMERS_CACHE).toBe(modelDir);
  });

  it("constructor leaves env untouched when disabled", () => {
    new VoiceTranscriber({ db, modelDir, enabled: false });
    expect(process.env.HF_HOME).toBeUndefined();
    expect(process.env.TRANSFORMERS_CACHE).toBeUndefined();
  });

  it("constructor preserves an existing HF_HOME", () => {
    process.env.HF_HOME = "/elsewhere";
    new VoiceTranscriber({ db, modelDir });
    expect(process.env.HF_HOME).toBe("/elsewhere");
  });

  it("constructor logs but does not throw when modelDir cannot be created", () => {
    // Pass a path under a known-bad parent so mkdirSync's recursive: true
    // still raises. We use an existing file as the parent.
    const fakePath = "/dev/null/voice-models";
    expect(
      () => new VoiceTranscriber({ db, modelDir: fakePath, enabled: true }),
    ).not.toThrow();
  });

  it("returns null when disabled", async () => {
    const t = new VoiceTranscriber({ db, modelDir, enabled: false });
    const result = await t.transcribe({
      attachmentId: "att-1",
      path: "/tmp/voice.ogg",
      mimeType: "audio/ogg",
    });
    expect(result).toBeNull();
  });

  it("re-reads `enabled` on every call when given a function (live flag)", async () => {
    let live = false;
    const audio = silentSamples(1);
    const decoder = makeDecoder(audio);
    const { loader } = makePipeline({ text: "hi", language: "en" });
    const t = new VoiceTranscriber({
      db,
      modelDir,
      enabled: () => live,
      decodeAudio: decoder,
      loadPipeline: loader,
    });

    // Disabled at boot — env stays untouched and transcribe returns null.
    expect(t.isEnabled()).toBe(false);
    expect(process.env.HF_HOME).toBeUndefined();
    expect(
      await t.transcribe({
        attachmentId: "att-1",
        path: "/tmp/voice.ogg",
        mimeType: "audio/ogg",
      }),
    ).toBeNull();

    // Flip without rebuilding the transcriber — mimics the dashboard's
    // voice install flipping `config.voiceTranscriptionEnabled` mid-boot.
    live = true;
    const result = await t.transcribe({
      attachmentId: "att-1",
      path: "/tmp/voice.ogg",
      mimeType: "audio/ogg",
    });
    expect(result?.transcript).toBe("hi");
    // Lazy setup ran on first enabled transcribe.
    expect(process.env.HF_HOME).toBe(modelDir);
  });

  it("returns null for non-audio MIME types", async () => {
    const t = new VoiceTranscriber({ db, modelDir });
    const result = await t.transcribe({
      attachmentId: "att-1",
      path: "/tmp/photo.jpg",
      mimeType: "image/jpeg",
    });
    expect(result).toBeNull();
  });

  it("returns the cached transcript without invoking the pipeline", async () => {
    saveVoiceTranscript(db, {
      attachmentId: "att-1",
      model: "Xenova/whisper-tiny",
      language: "ja",
      durationSec: 1.5,
      transcript: "cached text",
    });
    const decode = vi.fn();
    const load = vi.fn();
    const t = new VoiceTranscriber({
      db,
      modelDir,
      decodeAudio: decode as unknown as AudioDecoder,
      loadPipeline: load as unknown as PipelineLoader,
    });
    const result = await t.transcribe({
      attachmentId: "att-1",
      path: "/tmp/voice.ogg",
      mimeType: "audio/ogg",
    });
    expect(result).toEqual({
      attachmentId: "att-1",
      transcript: "cached text",
      language: "ja",
      durationSec: 1.5,
      model: "Xenova/whisper-tiny",
      fromCache: true,
    });
    expect(decode).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it("transcribes uncached audio and persists the result", async () => {
    const audio = silentSamples(2);
    const decoder = makeDecoder(audio);
    const { loader } = makePipeline({ text: "  hello world  ", language: "en" });
    const t = new VoiceTranscriber({
      db,
      modelDir,
      model: "Xenova/whisper-small",
      decodeAudio: decoder,
      loadPipeline: loader,
    });
    const result = await t.transcribe({
      attachmentId: "att-1",
      path: "/tmp/voice.ogg",
      mimeType: "audio/ogg",
    });
    expect(result).toEqual({
      attachmentId: "att-1",
      transcript: "hello world",
      language: "en",
      durationSec: 2,
      model: "Xenova/whisper-small",
      fromCache: false,
    });
    const stored = getVoiceTranscript(db, "att-1");
    expect(stored?.transcript).toBe("hello world");
    expect(stored?.language).toBe("en");
  });

  it("falls back to the configured language when the pipeline returns none", async () => {
    const decoder = makeDecoder(silentSamples(1));
    const { loader } = makePipeline({ text: "konnichiwa" });
    const t = new VoiceTranscriber({
      db,
      modelDir,
      language: "ja",
      decodeAudio: decoder,
      loadPipeline: loader,
    });
    const result = await t.transcribe({
      attachmentId: "att-1",
      path: "/tmp/voice.ogg",
      mimeType: "audio/ogg",
    });
    expect(result?.language).toBe("ja");
  });

  it("returns null with no language when neither pipeline nor config provide one", async () => {
    const decoder = makeDecoder(silentSamples(1));
    const { loader } = makePipeline({ text: "untagged" });
    const t = new VoiceTranscriber({
      db,
      modelDir,
      decodeAudio: decoder,
      loadPipeline: loader,
    });
    const result = await t.transcribe({
      attachmentId: "att-1",
      path: "/tmp/voice.ogg",
      mimeType: "audio/ogg",
    });
    expect(result?.language).toBeNull();
  });

  it("returns null when audio exceeds the duration cap", async () => {
    const decoder = makeDecoder(silentSamples(601));
    const { loader, pipeline } = makePipeline({ text: "ignored" });
    const t = new VoiceTranscriber({
      db,
      modelDir,
      maxDurationSec: 600,
      decodeAudio: decoder,
      loadPipeline: loader,
    });
    const result = await t.transcribe({
      attachmentId: "att-1",
      path: "/tmp/voice.ogg",
      mimeType: "audio/ogg",
    });
    expect(result).toBeNull();
    expect(pipeline).not.toHaveBeenCalled();
  });

  it("returns null when the decoder throws", async () => {
    const decoder = vi.fn(async () => {
      throw new Error("ffmpeg blew up");
    });
    const { loader } = makePipeline({ text: "should not reach" });
    const t = new VoiceTranscriber({
      db,
      modelDir,
      decodeAudio: decoder as unknown as AudioDecoder,
      loadPipeline: loader,
    });
    const result = await t.transcribe({
      attachmentId: "att-1",
      path: "/tmp/voice.ogg",
      mimeType: "audio/ogg",
    });
    expect(result).toBeNull();
    expect(getVoiceTranscript(db, "att-1")).toBeNull();
  });

  it("returns null when the decoder reports an unexpected sample rate", async () => {
    const decoder = makeDecoder({
      samples: new Float32Array(8000),
      sampleRate: 8000,
      durationSec: 1,
    });
    const { loader, pipeline } = makePipeline({ text: "ignored" });
    const t = new VoiceTranscriber({
      db,
      modelDir,
      decodeAudio: decoder,
      loadPipeline: loader,
    });
    const result = await t.transcribe({
      attachmentId: "att-1",
      path: "/tmp/voice.ogg",
      mimeType: "audio/ogg",
    });
    expect(result).toBeNull();
    expect(pipeline).not.toHaveBeenCalled();
  });

  it("returns null when the pipeline loader rejects, retrying on the next call", async () => {
    const decoder = makeDecoder(silentSamples(1));
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error("model download failed"))
      .mockResolvedValueOnce(
        (async () => ({ text: "second-try", language: "en" })) as unknown as WhisperPipeline,
      );
    const t = new VoiceTranscriber({
      db,
      modelDir,
      decodeAudio: decoder,
      loadPipeline: loader as unknown as PipelineLoader,
    });
    const first = await t.transcribe({
      attachmentId: "att-1",
      path: "/tmp/voice.ogg",
      mimeType: "audio/ogg",
    });
    expect(first).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);

    const second = await t.transcribe({
      attachmentId: "att-1",
      path: "/tmp/voice.ogg",
      mimeType: "audio/ogg",
    });
    expect(second?.transcript).toBe("second-try");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("returns null when the pipeline throws during inference", async () => {
    const decoder = makeDecoder(silentSamples(1));
    const pipeline = vi.fn(async () => {
      throw new Error("inference crashed");
    });
    const loader = vi.fn(async () => pipeline) as unknown as PipelineLoader;
    const t = new VoiceTranscriber({
      db,
      modelDir,
      decodeAudio: decoder,
      loadPipeline: loader,
    });
    const result = await t.transcribe({
      attachmentId: "att-1",
      path: "/tmp/voice.ogg",
      mimeType: "audio/ogg",
    });
    expect(result).toBeNull();
  });

  it("returns null and does not cache when the transcript is empty", async () => {
    const decoder = makeDecoder(silentSamples(1));
    const { loader } = makePipeline({ text: "   " });
    const t = new VoiceTranscriber({
      db,
      modelDir,
      decodeAudio: decoder,
      loadPipeline: loader,
    });
    const result = await t.transcribe({
      attachmentId: "att-1",
      path: "/tmp/voice.ogg",
      mimeType: "audio/ogg",
    });
    expect(result).toBeNull();
    expect(getVoiceTranscript(db, "att-1")).toBeNull();
  });

  it("dedupes concurrent calls for the same attachment", async () => {
    seedAttachment(db, "att-2");
    const decoder = makeDecoder(silentSamples(1));
    const pipeline = vi.fn(async () => ({ text: "deduped", language: "en" }));
    const loader = vi.fn(async () => pipeline) as unknown as PipelineLoader;
    const t = new VoiceTranscriber({
      db,
      modelDir,
      decodeAudio: decoder,
      loadPipeline: loader,
    });
    const [a, b] = await Promise.all([
      t.transcribe({
        attachmentId: "att-1",
        path: "/tmp/voice.ogg",
        mimeType: "audio/ogg",
      }),
      t.transcribe({
        attachmentId: "att-1",
        path: "/tmp/voice.ogg",
        mimeType: "audio/ogg",
      }),
    ]);
    expect(a?.transcript).toBe("deduped");
    expect(b?.transcript).toBe("deduped");
    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  it("serializes calls for different attachments via the queue", async () => {
    seedAttachment(db, "att-2");
    const decoder = makeDecoder(silentSamples(1));
    const concurrent: number[] = [];
    let inFlight = 0;
    const pipeline = vi.fn(async () => {
      inFlight += 1;
      concurrent.push(inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { text: "ok", language: "en" };
    });
    const loader = vi.fn(async () => pipeline) as unknown as PipelineLoader;
    const t = new VoiceTranscriber({
      db,
      modelDir,
      decodeAudio: decoder,
      loadPipeline: loader,
    });
    await Promise.all([
      t.transcribe({
        attachmentId: "att-1",
        path: "/tmp/a.ogg",
        mimeType: "audio/ogg",
      }),
      t.transcribe({
        attachmentId: "att-2",
        path: "/tmp/b.ogg",
        mimeType: "audio/ogg",
      }),
    ]);
    expect(concurrent.every((n) => n === 1)).toBe(true);
  });

  describe("primary-language fallback", () => {
    it("retries with the primary language when auto-detect emits the foreign-language placeholder", async () => {
      const decoder = makeDecoder(silentSamples(8));
      const pipeline = vi
        .fn()
        .mockResolvedValueOnce({ text: "(speaking in foreign language)", language: null })
        .mockResolvedValueOnce({ text: "こんにちは、テストです。", language: "ja" });
      const loader = vi.fn(async () => pipeline) as unknown as PipelineLoader;
      const t = new VoiceTranscriber({
        db,
        modelDir,
        primaryLanguage: "ja",
        decodeAudio: decoder,
        loadPipeline: loader,
      });
      const result = await t.transcribe({
        attachmentId: "att-1",
        path: "/tmp/voice.ogg",
        mimeType: "audio/ogg",
      });
      expect(result?.transcript).toBe("こんにちは、テストです。");
      expect(result?.language).toBe("ja");
      expect(pipeline).toHaveBeenCalledTimes(2);
      // First pass: auto-detect (no language).
      expect((pipeline.mock.calls[0] as unknown[])[1]).toMatchObject({ language: null, task: "transcribe" });
      // Second pass: primary forced.
      expect(pipeline.mock.calls[1][1]).toMatchObject({ language: "ja", task: "transcribe" });
    });

    it("retries with the primary language when auto-detect returns an empty transcript", async () => {
      const decoder = makeDecoder(silentSamples(2));
      const pipeline = vi
        .fn()
        .mockResolvedValueOnce({ text: "  ", language: null })
        // Second pipeline does NOT emit a language token (transformers.js
        // does this in practice — `_decode_asr` carries a TODO for
        // `return_language`). The transcriber must then attribute the
        // result to the forced primary language so the cache row is
        // tagged correctly.
        .mockResolvedValueOnce({ text: "konnichiwa" });
      const loader = vi.fn(async () => pipeline) as unknown as PipelineLoader;
      const t = new VoiceTranscriber({
        db,
        modelDir,
        primaryLanguage: "ja",
        decodeAudio: decoder,
        loadPipeline: loader,
      });
      const result = await t.transcribe({
        attachmentId: "att-1",
        path: "/tmp/voice.ogg",
        mimeType: "audio/ogg",
      });
      expect(result?.transcript).toBe("konnichiwa");
      expect(result?.language).toBe("ja");
      expect(pipeline).toHaveBeenCalledTimes(2);
    });

    it("does not retry when auto-detect succeeds with a real transcript", async () => {
      const decoder = makeDecoder(silentSamples(2));
      const pipeline = vi.fn(async () => ({
        text: "Hello, this is a real English transcript.",
        language: "en",
      }));
      const loader = vi.fn(async () => pipeline) as unknown as PipelineLoader;
      const t = new VoiceTranscriber({
        db,
        modelDir,
        primaryLanguage: "ja",
        decodeAudio: decoder,
        loadPipeline: loader,
      });
      const result = await t.transcribe({
        attachmentId: "att-1",
        path: "/tmp/voice.ogg",
        mimeType: "audio/ogg",
      });
      expect(result?.transcript).toBe("Hello, this is a real English transcript.");
      expect(result?.language).toBe("en");
      expect(pipeline).toHaveBeenCalledTimes(1);
    });

    it("does not retry when no primary language is configured", async () => {
      const decoder = makeDecoder(silentSamples(8));
      const pipeline = vi.fn(async () => ({
        text: "(speaking in foreign language)",
        language: null,
      }));
      const loader = vi.fn(async () => pipeline) as unknown as PipelineLoader;
      const t = new VoiceTranscriber({
        db,
        modelDir,
        decodeAudio: decoder,
        loadPipeline: loader,
      });
      const result = await t.transcribe({
        attachmentId: "att-1",
        path: "/tmp/voice.ogg",
        mimeType: "audio/ogg",
      });
      // First-pass placeholder + no fallback ⇒ null + nothing cached.
      expect(result).toBeNull();
      expect(pipeline).toHaveBeenCalledTimes(1);
      expect(getVoiceTranscript(db, "att-1")).toBeNull();
    });

    it("returns null and skips caching when both passes produce placeholders", async () => {
      const decoder = makeDecoder(silentSamples(8));
      const pipeline = vi
        .fn()
        .mockResolvedValueOnce({ text: "(speaking in foreign language)", language: null })
        .mockResolvedValueOnce({ text: "[silence]", language: "ja" });
      const loader = vi.fn(async () => pipeline) as unknown as PipelineLoader;
      const t = new VoiceTranscriber({
        db,
        modelDir,
        primaryLanguage: "ja",
        decodeAudio: decoder,
        loadPipeline: loader,
      });
      const result = await t.transcribe({
        attachmentId: "att-1",
        path: "/tmp/voice.ogg",
        mimeType: "audio/ogg",
      });
      expect(result).toBeNull();
      expect(pipeline).toHaveBeenCalledTimes(2);
      expect(getVoiceTranscript(db, "att-1")).toBeNull();
    });

    it("forced language (env override) wins over primary language and skips fallback", async () => {
      const decoder = makeDecoder(silentSamples(8));
      const pipeline = vi.fn(async () => ({
        // Even an obvious placeholder under forced mode does NOT trigger the
        // fallback — `language` is treated as an explicit operator override.
        text: "(speaking in foreign language)",
        language: null,
      }));
      const loader = vi.fn(async () => pipeline) as unknown as PipelineLoader;
      const t = new VoiceTranscriber({
        db,
        modelDir,
        language: "en",
        primaryLanguage: "ja",
        decodeAudio: decoder,
        loadPipeline: loader,
      });
      const result = await t.transcribe({
        attachmentId: "att-1",
        path: "/tmp/voice.ogg",
        mimeType: "audio/ogg",
      });
      expect(result).toBeNull();
      expect(pipeline).toHaveBeenCalledTimes(1);
      expect((pipeline.mock.calls[0] as unknown[])[1]).toMatchObject({ language: "en", task: "transcribe" });
    });

    it("re-reads the primary language on every call when given a getter", async () => {
      seedAttachment(db, "att-2");
      let livePrimary: string | null = null;
      const decoder = makeDecoder(silentSamples(2));
      const pipeline = vi
        .fn()
        // att-1 (no primary configured): single pass, placeholder ⇒ null.
        .mockResolvedValueOnce({ text: "(speaking in foreign language)", language: null })
        // att-2 (primary now ja): pass 1 placeholder, pass 2 succeeds.
        .mockResolvedValueOnce({ text: "(speaking in foreign language)", language: null })
        .mockResolvedValueOnce({ text: "Real Japanese transcript.", language: "ja" });
      const loader = vi.fn(async () => pipeline) as unknown as PipelineLoader;
      const t = new VoiceTranscriber({
        db,
        modelDir,
        primaryLanguage: () => livePrimary,
        decodeAudio: decoder,
        loadPipeline: loader,
      });
      const first = await t.transcribe({
        attachmentId: "att-1",
        path: "/tmp/a.ogg",
        mimeType: "audio/ogg",
      });
      expect(first).toBeNull();

      // Operator flips the setting at runtime — no restart needed.
      livePrimary = "ja";
      const second = await t.transcribe({
        attachmentId: "att-2",
        path: "/tmp/b.ogg",
        mimeType: "audio/ogg",
      });
      expect(second?.transcript).toBe("Real Japanese transcript.");
    });

    it("ignores an unsupported primary-language code instead of forwarding it", async () => {
      const decoder = makeDecoder(silentSamples(2));
      const pipeline = vi.fn(async () => ({
        text: "(speaking in foreign language)",
        language: null,
      }));
      const loader = vi.fn(async () => pipeline) as unknown as PipelineLoader;
      const t = new VoiceTranscriber({
        db,
        modelDir,
        primaryLanguage: "xx",
        decodeAudio: decoder,
        loadPipeline: loader,
      });
      const result = await t.transcribe({
        attachmentId: "att-1",
        path: "/tmp/voice.ogg",
        mimeType: "audio/ogg",
      });
      // Unsupported code is silently treated as null, so the fallback is
      // disabled and the placeholder produces a null result.
      expect(result).toBeNull();
      expect(pipeline).toHaveBeenCalledTimes(1);
    });
  });

  describe("isWhisperPlaceholderOutput", () => {
    it.each([
      "(speaking in foreign language)",
      "(speaking foreign language)",
      "  (speaking in foreign language)  ",
      "(SPEAKING IN FOREIGN LANGUAGE)",
      "(non-English speech)",
      "[silence]",
      "(silent)",
      "[Music]",
      "[Applause]",
      "(...)",
      "[♪♪♪]",
      // Symbols-only bracketed strings — caught by the second-pass regex
      // (the unenumerated-meta-tag branch) rather than the phrase list.
      "(!!!)",
      "[***]",
      "",
      "   ",
    ])("flags %p as a placeholder", (text) => {
      expect(isWhisperPlaceholderOutput(text)).toBe(true);
    });

    it("does not flag long bracketed strings even when they contain no word characters", () => {
      // > 64 chars means the second-pass branch returns false to avoid
      // false-positives on legitimate transcripts that happen to be a
      // long sequence of punctuation (rare but possible).
      const longBracketed = "(" + "!".repeat(70) + ")";
      expect(isWhisperPlaceholderOutput(longBracketed)).toBe(false);
    });

    it.each([
      "Hello, this is a real transcript.",
      "こんにちは、これは実際の文字起こしです。",
      "[Music] hold on a moment, let me check.",
      "konnichiwa",
      "(speaking in foreign language) but then the actual content follows here.",
    ])("does not flag %p as a placeholder", (text) => {
      expect(isWhisperPlaceholderOutput(text)).toBe(false);
    });

    // Regression: short bracketed transcripts in scripts that the legacy
    // hard-coded whitelist omitted (Korean, Thai, Greek, Tamil, etc.) were
    // incorrectly flagged as placeholders, causing the cache to be skipped
    // and the message to fall back to a file-path reference. The fix uses
    // Unicode property escapes (\p{L}\p{N}) so any letter or digit in any
    // script short-circuits the bracketed-meta-token branch.
    it.each([
      "(안녕)",         // Korean Hangul
      "[สวัสดี]",      // Thai
      "(γεια)",        // Greek
      "(வணக்கம்)",     // Tamil
      "(123)",          // digit-only — could be a real numeric utterance
    ])("does not flag short bracketed real transcript %p", (text) => {
      expect(isWhisperPlaceholderOutput(text)).toBe(false);
    });
  });

  it("recovers the queue after a queued task rejects", async () => {
    seedAttachment(db, "att-2");
    const decoder = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error("first fails");
      })
      .mockImplementationOnce(async () => silentSamples(1));
    const { loader } = makePipeline({ text: "second ok", language: "en" });
    const t = new VoiceTranscriber({
      db,
      modelDir,
      decodeAudio: decoder as unknown as AudioDecoder,
      loadPipeline: loader,
    });
    const first = await t.transcribe({
      attachmentId: "att-1",
      path: "/tmp/a.ogg",
      mimeType: "audio/ogg",
    });
    const second = await t.transcribe({
      attachmentId: "att-2",
      path: "/tmp/b.ogg",
      mimeType: "audio/ogg",
    });
    expect(first).toBeNull();
    expect(second?.transcript).toBe("second ok");
  });

  // ── M5: warmUp() pre-loads the pipeline at daemon startup ──
  // Five tests pin the contract laid out in `warmUp`'s JSDoc:
  //   1. Enabled → loader runs once and ensurePipeline caches it.
  //   2. Disabled → loader never runs (cheap no-op).
  //   3. A subsequent transcribe() reuses the warmed pipeline (no
  //      second load).
  //   4. Loader rejection does NOT throw — it is logged. The next
  //      transcribe() can retry from scratch (cached promise was
  //      nulled by ensurePipeline's catch).
  //   5. Timeout firing does NOT throw — same logging contract.
  describe("warmUp", () => {
    it("eagerly loads the pipeline when enabled", async () => {
      const { loader } = makePipeline({ text: "warm" });
      const t = new VoiceTranscriber({ db, modelDir, loadPipeline: loader });
      await t.warmUp(10_000);
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it("is a cheap no-op when transcription is disabled", async () => {
      const { loader } = makePipeline({ text: "should not run" });
      const t = new VoiceTranscriber({
        db,
        modelDir,
        enabled: false,
        loadPipeline: loader,
      });
      await t.warmUp(10_000);
      expect(loader).not.toHaveBeenCalled();
    });

    it("transcribe() reuses the pipeline warmed up at startup", async () => {
      const { loader } = makePipeline({ text: "hello world", language: "en" });
      const t = new VoiceTranscriber({
        db,
        modelDir,
        loadPipeline: loader,
        decodeAudio: makeDecoder(silentSamples(1)),
      });
      await t.warmUp(10_000);
      expect(loader).toHaveBeenCalledTimes(1);

      await t.transcribe({
        attachmentId: "att-1",
        path: "/tmp/voice.ogg",
        mimeType: "audio/ogg",
      });
      // The crucial assertion: pipeline was already loaded by warmUp,
      // so transcribe() does not trigger a second load.
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it("swallows loader rejection so daemon startup is never blocked by HF Hub failure", async () => {
      const loader: PipelineLoader = vi
        .fn()
        .mockRejectedValue(new Error("HF Hub 502"));
      const t = new VoiceTranscriber({ db, modelDir, loadPipeline: loader });
      // The crucial assertion is `not.toThrow` — daemon startup must
      // continue even when warm-up fails.
      await expect(t.warmUp(10_000)).resolves.toBeUndefined();
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it("swallows a warm-up timeout without throwing", async () => {
      // Loader resolves a Whisper pipeline AFTER 100ms. warmUp times out
      // at 5ms, which must NOT propagate as a rejection. The underlying
      // load promise lives on so a later transcribe() can still
      // observe its result.
      const slowPipeline = vi.fn(
        async () => ({ text: "slow" }),
      ) as unknown as WhisperPipeline;
      const loader: PipelineLoader = () =>
        new Promise((resolve) => setTimeout(() => resolve(slowPipeline), 100));
      const t = new VoiceTranscriber({ db, modelDir, loadPipeline: loader });

      await expect(t.warmUp(5)).resolves.toBeUndefined();
    });
  });

  afterEach(() => {
    rmSync(modelDir, { recursive: true, force: true });
  });
});
