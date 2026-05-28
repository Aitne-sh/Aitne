import { mkdirSync } from "node:fs";
import type Database from "better-sqlite3";
import { isSupportedVoiceLanguage } from "@aitne/shared";
import { createLogger } from "../../logging.js";
import {
  getVoiceTranscript,
  saveVoiceTranscript,
} from "../../db/voice-transcripts-store.js";
import {
  decodeAudioWithFfmpeg,
  defaultLoadPipeline,
} from "./transcriber-impl.js";

const logger = createLogger("voice-transcriber");

export const VOICE_TRANSCRIBER_DEFAULTS = {
  enabled: true,
  /**
   * Multilingual ONNX-quantized turbo build. Chosen over `Xenova/whisper-small`
   * (the original default) because small's language auto-detection is
   * unreliable for many users — Japanese voice notes from WhatsApp routinely
   * round-tripped as `(speaking in foreign language)` despite small being
   * nominally multilingual. large-v3-turbo's 809M-parameter encoder
   * substantially improves language ID with only a ~2× inference penalty
   * vs small on Apple Silicon CPUs (≈3.7s for 8s audio on M-series), which
   * is well within DM responsiveness budgets.
   *
   * Trade-offs documented in docs/design/appendices/voice-transcription.md.
   */
  model: "onnx-community/whisper-large-v3-turbo",
  /** Forced language (ISO 639-1). When set, skips auto-detect and the
   *  primary-language fallback. `null` = auto-detect with optional fallback. */
  language: null as string | null,
  /** Operator's primary spoken language; used as the fallback target when
   *  auto-detect produces a placeholder hallucination. `null` = no fallback. */
  primaryLanguage: null as string | null,
  maxDurationSec: 600,
} as const;

const TARGET_SAMPLE_RATE = 16000;

/**
 * Detects Whisper hallucination patterns that indicate the language ID
 * step failed and the model fell back to its English-decoder placeholder
 * vocabulary. This is the trigger for the primary-language fallback pass.
 *
 * Patterns to detect (model meta-tokens emitted when language ID fails):
 *   - "(speaking in foreign language)"
 *   - "(speaking foreign language)"
 *   - "(silence)" / "(silent)" / "[silence]"
 *   - "[Music]" / "[Applause]"  ← model gave up and emitted a meta tag
 *   - "(...)" / "[...]"          ← bracketed placeholder with no real content
 *   - empty / whitespace-only after trim
 *
 * The detector is deliberately conservative: it only matches outputs that
 * are *entirely* a placeholder. A real transcript that happens to contain
 * "[Music]" mid-sentence is left alone.
 */
const PLACEHOLDER_PHRASE_REGEX =
  // Whole string is a single bracketed/parenthesized phrase whose content
  // matches a known meta-token vocabulary. We anchor with ^...$ so partial
  // matches inside a longer transcript do not trigger the retry.
  // English-only vocabulary as of the 2026-05-27 revision; the
  // brace-only fallback pattern below catches non-English placeholder
  // shapes (e.g. `[♪♪♪]`, `(***)`, bracketed CJK silence tokens) via
  // its script-agnostic `\P{L}*` content check.
  /^\s*[([](?:\s*[a-z]{1,3}\s*\|\s*)?\s*(?:speaking(?:\s+in)?\s+(?:a\s+)?foreign\s+language|non[-\s]?english\s+speech|in\s+foreign\s+language|silence|silent|music|applause|laughter|inaudible|background\s+noise|♪+|\.{3,}|\s*)\s*[)\]]\s*$/i;

// Bracketed/parenthesized fallback for meta-tokens we did not enumerate
// above (e.g. `(***)`, `[♪♪♪]`, `(...)`). Uses Unicode property escapes so
// the "no word characters" check is script-agnostic — the previous
// hard-coded whitelist (Latin + Latin-Extended-A + Hiragana/Katakana +
// CJK Unified Ideographs + Cyrillic + Hebrew + Arabic + Devanagari)
// wrongly flagged short bracketed transcripts in scripts it omitted
// (Korean, Thai, Greek, Tamil, etc.) as placeholders, causing the cache
// to be skipped and the message to fall back to a path-only file
// reference. Trimming has already happened by the time we test, so the
// bracket characters can be matched directly without an additional `\s`
// slot.
const BRACKETED_NON_LETTER_REGEX = /^[([][^\p{L}\p{N}]*[)\]]$/u;

export function isWhisperPlaceholderOutput(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (PLACEHOLDER_PHRASE_REGEX.test(trimmed)) return true;
  if (trimmed.length <= 64 && BRACKETED_NON_LETTER_REGEX.test(trimmed)) {
    return true;
  }
  return false;
}

export interface VoiceTranscriberOptions {
  db: Database.Database;
  modelDir: string;
  /**
   * `boolean` to lock the value at construction (legacy / test use), or
   * `() => boolean` to read live from a runtime source — used in production
   * so flipping `voiceTranscriptionEnabled` via the dashboard's voice
   * install flow takes effect on the next inbound audio attachment without
   * waiting for a daemon restart.
   */
  enabled?: boolean | (() => boolean);
  model?: string;
  /**
   * Forced language. When non-null, bypasses auto-detect and the primary-
   * language fallback (single-pass with this language). Maps to env
   * `PA_VOICE_TRANSCRIPTION_LANGUAGE` for advanced operators who want
   * deterministic behaviour for a known-monolingual deployment.
   */
  language?: string | null;
  /**
   * Operator's primary spoken language. When auto-detect produces a
   * placeholder hallucination (see `isWhisperPlaceholderOutput`), the
   * transcriber retries with this language forced. Accepts a getter so
   * the value can be flipped at runtime via `PATCH /api/config` without
   * a daemon restart — same hot-swap pattern as `enabled`.
   */
  primaryLanguage?: string | null | (() => string | null);
  maxDurationSec?: number;
  /**
   * Test seam — inject a transcribe function so dispatcher tests can
   * exercise the wiring without spinning up Whisper. Production code
   * leaves this undefined and the lazy loader builds the real pipeline
   * via `@huggingface/transformers`.
   */
  loadPipeline?: PipelineLoader;
  /**
   * Test seam — inject a custom audio decoder. Production code uses
   * `decodeAudioWithFfmpeg`, which spawns the bundled ffmpeg-static
   * binary and returns 16 kHz mono Float32 samples.
   */
  decodeAudio?: AudioDecoder;
}

export interface DecodedAudio {
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
}

export type AudioDecoder = (input: {
  path: string;
  mimeType: string;
}) => Promise<DecodedAudio>;

export interface WhisperPipelineOutput {
  text: string;
  language?: string | null;
}

export type WhisperPipeline = (
  samples: Float32Array,
  options: { language?: string | null; task: "transcribe" },
) => Promise<WhisperPipelineOutput>;

export interface PipelineProgressEvent {
  status: "initiate" | "download" | "progress" | "done" | "ready" | string;
  file?: string;
  name?: string;
  loaded?: number;
  total?: number;
  progress?: number;
}

export type PipelineLoader = (input: {
  model: string;
  modelDir: string;
  onProgress?: (event: PipelineProgressEvent) => void;
}) => Promise<WhisperPipeline>;

export interface VoiceTranscriptionInput {
  attachmentId: string;
  path: string;
  mimeType: string;
}

export interface VoiceTranscriptionResult {
  attachmentId: string;
  transcript: string;
  language: string | null;
  durationSec: number | null;
  model: string;
  fromCache: boolean;
}

/**
 * VoiceTranscriber — local Whisper transcription for inbound audio
 * attachments. See `docs/design/appendices/voice-transcription.md`.
 *
 * Lifecycle:
 *  1. Constructor takes options + DB; no model load happens here.
 *  2. First `transcribe(...)` call lazy-loads the pipeline.
 *  3. Subsequent calls reuse the loaded pipeline. Concurrent calls for
 *     the same `attachmentId` share a single in-flight promise; calls
 *     for different attachments are serialized (single-flight queue)
 *     so the CPU does not thrash.
 *
 * Inference strategy (per-attachment):
 *  - **Forced language set** (env override): single pass with `language=forced`.
 *  - **Otherwise (the default)**: pass 1 with auto-detect. If the output
 *    matches a known Whisper placeholder hallucination AND a primary
 *    language is configured, pass 2 retries with `language=primary`.
 *    Auto-detect successes pass through unchanged so a primary-Japanese
 *    operator still gets correct English transcripts on English clips.
 *
 * Failure modes degrade gracefully — every error returns `null` so the
 * dispatcher falls back to the pre-feature behaviour (path-only file
 * reference) without breaking the turn.
 */
export class VoiceTranscriber {
  private readonly db: Database.Database;
  private readonly modelDir: string;
  private readonly enabledFn: () => boolean;
  private readonly model: string;
  private readonly language: string | null;
  private readonly primaryLanguageFn: () => string | null;
  private readonly maxDurationSec: number;
  private readonly loadPipeline: PipelineLoader;
  private readonly decodeAudio: AudioDecoder;

  private pipelinePromise: Promise<WhisperPipeline> | null = null;
  private inflight = new Map<string, Promise<VoiceTranscriptionResult | null>>();
  private queue: Promise<unknown> = Promise.resolve();
  private setupDone = false;

  constructor(opts: VoiceTranscriberOptions) {
    this.db = opts.db;
    this.modelDir = opts.modelDir;
    const enabledOpt = opts.enabled ?? VOICE_TRANSCRIBER_DEFAULTS.enabled;
    this.enabledFn =
      typeof enabledOpt === "function" ? enabledOpt : () => enabledOpt;
    this.model = opts.model ?? VOICE_TRANSCRIBER_DEFAULTS.model;
    this.language = opts.language ?? VOICE_TRANSCRIBER_DEFAULTS.language;
    const primaryOpt =
      opts.primaryLanguage ?? VOICE_TRANSCRIBER_DEFAULTS.primaryLanguage;
    this.primaryLanguageFn =
      typeof primaryOpt === "function" ? primaryOpt : () => primaryOpt;
    this.maxDurationSec =
      opts.maxDurationSec ?? VOICE_TRANSCRIBER_DEFAULTS.maxDurationSec;
    this.loadPipeline = opts.loadPipeline ?? defaultLoadPipeline;
    this.decodeAudio = opts.decodeAudio ?? decodeAudioWithFfmpeg;

    // Eagerly run the model-dir + HF env setup when the flag is on at boot.
    // When the flag flips on later (e.g. after the dashboard's voice install
    // flips `config.voiceTranscriptionEnabled`), `transcribe()` runs the
    // same setup lazily before the first inference.
    if (this.isEnabled()) this.ensureSetup();
  }

  private ensureSetup(): void {
    if (this.setupDone) return;
    this.setupDone = true;
    try {
      mkdirSync(this.modelDir, { recursive: true });
    } catch (err) {
      logger.warn({ err, modelDir: this.modelDir }, "voice model dir mkdir failed");
    }
    // Anchor HuggingFace's cache inside the daemon data dir so models do
    // not pollute the user's `~/.cache/huggingface/`. Set BEFORE the
    // pipeline is first imported so transformers.js picks it up.
    process.env.HF_HOME ??= this.modelDir;
    process.env.TRANSFORMERS_CACHE ??= this.modelDir;
  }

  isEnabled(): boolean {
    return this.enabledFn();
  }

  isAudio(mimeType: string): boolean {
    return /^audio\//i.test(mimeType.split(";")[0].trim());
  }

  /**
   * Reads the configured primary language at the time of the call.
   * Returns the value only if it is currently a Whisper-supported code;
   * an unsupported value (e.g. drift between this code and the registry)
   * is treated as null so the fallback silently disables itself rather
   * than emitting a forced-language pass with a token Whisper rejects.
   */
  private resolvePrimaryLanguage(): string | null {
    const value = this.primaryLanguageFn();
    if (value === null) return null;
    return isSupportedVoiceLanguage(value) ? value : null;
  }

  async transcribe(
    input: VoiceTranscriptionInput,
  ): Promise<VoiceTranscriptionResult | null> {
    if (!this.isEnabled()) return null;
    if (!this.isAudio(input.mimeType)) return null;
    // Cover the boot-disabled → later-enabled path: the constructor only ran
    // setup when the flag was true at construction.
    this.ensureSetup();

    const cached = getVoiceTranscript(this.db, input.attachmentId);
    if (cached) {
      return {
        attachmentId: cached.attachmentId,
        transcript: cached.transcript,
        language: cached.language,
        durationSec: cached.durationSec,
        model: cached.model,
        fromCache: true,
      };
    }

    const existing = this.inflight.get(input.attachmentId);
    if (existing) return existing;

    const promise = this.runQueued(() => this.transcribeUncached(input));
    this.inflight.set(input.attachmentId, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(input.attachmentId);
    }
  }

  private runQueued<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    // Swallow failures on the queue chain so a single bad inference does
    // not poison subsequent ones; callers still see the rejection.
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async transcribeUncached(
    input: VoiceTranscriptionInput,
  ): Promise<VoiceTranscriptionResult | null> {
    let audio: DecodedAudio;
    try {
      audio = await this.decodeAudio({
        path: input.path,
        mimeType: input.mimeType,
      });
    } catch (err) {
      logger.warn({ err, attachmentId: input.attachmentId }, "voice decode failed");
      return null;
    }

    if (audio.durationSec > this.maxDurationSec) {
      logger.info(
        {
          attachmentId: input.attachmentId,
          durationSec: audio.durationSec,
          maxDurationSec: this.maxDurationSec,
        },
        "voice clip exceeds duration cap, skipping transcription",
      );
      return null;
    }

    if (audio.sampleRate !== TARGET_SAMPLE_RATE) {
      logger.warn(
        { attachmentId: input.attachmentId, sampleRate: audio.sampleRate },
        "voice decoder returned unexpected sample rate; skipping",
      );
      return null;
    }

    let pipeline: WhisperPipeline;
    try {
      pipeline = await this.ensurePipeline();
    } catch (err) {
      logger.warn({ err }, "voice pipeline load failed");
      return null;
    }

    let output: WhisperPipelineOutput;
    let usedLanguage: string | null;
    let fallbackUsed = false;

    try {
      if (this.language) {
        // Forced-language mode: single pass, no fallback, legacy behaviour.
        output = await pipeline(audio.samples, {
          language: this.language,
          task: "transcribe",
        });
        usedLanguage = this.language;
      } else {
        // Pass 1 — auto-detect. transformers.js does not surface the
        // detected language back to us today (the `return_language`
        // option is wired but the tokenizer's `_decode_asr` carries a
        // "TODO" for it), so `output.language` is usually null on this
        // path. We treat that as "unknown" and rely on placeholder
        // detection to gate the fallback pass.
        output = await pipeline(audio.samples, {
          language: null,
          task: "transcribe",
        });
        usedLanguage = output.language ?? null;

        const primary = this.resolvePrimaryLanguage();
        if (primary && isWhisperPlaceholderOutput(output.text)) {
          logger.info(
            {
              attachmentId: input.attachmentId,
              primaryLanguage: primary,
              firstPassText: output.text.trim().slice(0, 80),
            },
            "voice: auto-detect produced placeholder, retrying with primary language",
          );
          output = await pipeline(audio.samples, {
            language: primary,
            task: "transcribe",
          });
          usedLanguage = output.language ?? primary;
          fallbackUsed = true;
        }
      }
    } catch (err) {
      logger.warn({ err, attachmentId: input.attachmentId }, "voice inference failed");
      return null;
    }

    const transcript = output.text.trim();
    if (!transcript || isWhisperPlaceholderOutput(transcript)) {
      // Either the model returned nothing or the fallback also produced a
      // placeholder. Skip the cache so a future re-upload of the same
      // attachment id is not pinned to a useless transcript, and surface
      // null so the dispatcher uses the pre-feature path (file reference).
      logger.info(
        {
          attachmentId: input.attachmentId,
          fallbackUsed,
          transcriptPreview: transcript.slice(0, 80),
        },
        "voice transcript empty or placeholder, skipping cache",
      );
      return null;
    }

    saveVoiceTranscript(this.db, {
      attachmentId: input.attachmentId,
      model: this.model,
      language: usedLanguage,
      durationSec: audio.durationSec,
      transcript,
    });

    return {
      attachmentId: input.attachmentId,
      transcript,
      language: usedLanguage,
      durationSec: audio.durationSec,
      model: this.model,
      fromCache: false,
    };
  }

  private ensurePipeline(): Promise<WhisperPipeline> {
    if (this.pipelinePromise) return this.pipelinePromise;
    this.pipelinePromise = this.loadPipeline({
      model: this.model,
      modelDir: this.modelDir,
    }).catch((err) => {
      // Reset so a transient model-download failure can be retried on
      // the next inbound voice message instead of being latched.
      this.pipelinePromise = null;
      throw err;
    });
    return this.pipelinePromise;
  }

  /**
   * Pre-load the Whisper pipeline so the first inbound voice DM does
   * not pay the 800 MB – 2.5 GB model-download cost on the request path.
   *
   * Wiring contract:
   *   - The daemon bootstrap (`bootstrap/event-pipeline.ts`) kicks this
   *     off with `void warmUp()` immediately after constructing the
   *     transcriber. Background, not awaited — startup must not block
   *     on Hugging Face Hub being reachable.
   *   - When voice transcription is disabled the call is a cheap no-op
   *     (no setup, no download).
   *   - The timeout bounds **how long we wait**, not the download
   *     itself: `loadPipeline` runs inside `ensurePipeline` which caches
   *     the promise. If we time out, the underlying load keeps running
   *     and the first real `transcribe(...)` call simply awaits the
   *     same cached promise. This avoids the "warm-up fails on a slow
   *     network, agent permanently boots without voice" failure mode.
   *   - On a true load failure (model invalid, transformers.js missing),
   *     `ensurePipeline`'s catch nulls `pipelinePromise` so the next DM
   *     retries from scratch — same behaviour as before warm-up.
   */
  async warmUp(timeoutMs = 120_000): Promise<void> {
    if (!this.isEnabled()) {
      logger.debug("voice transcriber disabled, skipping warm-up");
      return;
    }
    this.ensureSetup();

    const startedAt = Date.now();
    logger.info(
      { model: this.model, modelDir: this.modelDir, timeoutMs },
      "voice transcriber: warming up pipeline",
    );

    // Race the load against a timeout. The timer's `.unref()` keeps it
    // from preventing daemon shutdown; the bare race promise rejecting
    // does not cancel the underlying load (transformers.js downloads
    // are not abortable), which is the intended behaviour described in
    // the JSDoc above.
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () =>
          reject(
            new Error(
              `voice transcriber warm-up timed out after ${timeoutMs}ms`,
            ),
          ),
        timeoutMs,
      );
      if (
        timeoutHandle !== null
        && typeof (timeoutHandle as { unref?: () => void }).unref === "function"
      ) {
        (timeoutHandle as { unref: () => void }).unref();
      }
    });
    try {
      await Promise.race([this.ensurePipeline(), timeoutPromise]);
      logger.info(
        { elapsedMs: Date.now() - startedAt, model: this.model },
        "voice transcriber: pipeline ready",
      );
    } catch (err) {
      logger.warn(
        { err, elapsedMs: Date.now() - startedAt, model: this.model },
        "voice transcriber: warm-up did not complete; first voice DM will trigger a fresh load",
      );
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    }
  }
}
