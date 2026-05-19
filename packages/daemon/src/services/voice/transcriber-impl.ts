import { spawn } from "node:child_process";
import type {
  AudioDecoder,
  DecodedAudio,
  PipelineLoader,
} from "./transcriber.js";

const TARGET_SAMPLE_RATE = 16000;

/**
 * Resolve the `dtype` argument we pass into transformers.js's `pipeline()`.
 *
 * Order:
 *   1. `PA_VOICE_TRANSCRIPTION_DTYPE` (advanced operator override). Accepts a
 *      bare dtype name (e.g. `"q4"`) or a JSON object mapping sub-model →
 *      dtype (e.g. `{"encoder_model":"fp16","decoder_model_merged":"q4"}`).
 *   2. Per-model default for the small set of repos whose fp32 default is
 *      broken by ONNX external-data references in Node.
 *   3. `undefined` — let transformers.js pick the default for the model.
 */
function resolveDtype(model: string): string | Record<string, string> | undefined {
  const env = process.env.PA_VOICE_TRANSCRIPTION_DTYPE;
  if (env) {
    const trimmed = env.trim();
    if (trimmed.startsWith("{")) {
      try {
        return JSON.parse(trimmed) as Record<string, string>;
      } catch {
        // Fall through to model-default if the JSON is malformed; logging
        // would require a logger import here and the failure is loud
        // enough at install time when the wrong dtype is rejected.
      }
    } else if (trimmed.length > 0) {
      return trimmed;
    }
  }
  if (model === "onnx-community/whisper-large-v3-turbo") return "q4";
  return undefined;
}

/**
 * Real Whisper pipeline loader. Imports `@huggingface/transformers`
 * dynamically so the (heavy) ONNX runtime is only loaded the first
 * time a voice message arrives. See `transcriber.ts` for the test seam.
 */
export const defaultLoadPipeline: PipelineLoader = async ({
  model,
  modelDir,
  onProgress,
}) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;
  try {
    mod = await import("@huggingface/transformers" as string);
  } catch (err) {
    throw new Error(
      `@huggingface/transformers not installed: ${(err as Error).message}`,
    );
  }
  if (typeof mod?.pipeline !== "function") {
    throw new Error("@huggingface/transformers: `pipeline` export missing");
  }
  // The JS port of @huggingface/transformers does NOT honor HF_HOME or
  // TRANSFORMERS_CACHE — those are Python-side env vars. Instead it reads
  // `mod.env.cacheDir`, defaulting to a `.cache/` folder bundled inside the
  // package's own node_modules path. Under pnpm that path lives in the
  // content-addressable store, which is wiped on `pnpm install` and can
  // surface as "Unable to get model file path or buffer." when the cache
  // write lands somewhere unreadable. Force both knobs at the daemon-owned
  // dir before loading the pipeline.
  if (mod?.env && typeof modelDir === "string" && modelDir.length > 0) {
    mod.env.cacheDir = modelDir;
    mod.env.localModelPath = modelDir;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pipelineOptions: Record<string, any> = {};
  // `onnx-community/whisper-large-v3-turbo`'s default fp32 encoder is a tiny
  // 439 KB stub that references a 2.55 GB sibling `.onnx_data` external-data
  // file (~3 GB total). The `_q4` variants are self-contained single ONNX
  // files (encoder ~425 MB, decoder ~334 MB → ~760 MB total, matches the
  // dashboard's "~800 MB" claim), so we pick them by default for download-
  // size reasons. Operators pointing `PA_VOICE_TRANSCRIPTION_MODEL` at a
  // different repo can pin the dtype themselves via
  // `PA_VOICE_TRANSCRIPTION_DTYPE` (string or JSON object form passed
  // straight through to transformers.js).
  const dtype = resolveDtype(model);
  if (dtype !== undefined) {
    pipelineOptions.dtype = dtype;
  }
  if (onProgress) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pipelineOptions.progress_callback = (event: any) => {
      try {
        onProgress(event);
      } catch {
        // Never let a UI-progress observer break the actual download.
      }
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const transcriber: any = await mod.pipeline(
    "automatic-speech-recognition",
    model,
    pipelineOptions,
  );
  return async (samples, options) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await transcriber(samples, {
      language: options.language ?? undefined,
      task: options.task,
      return_timestamps: false,
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    const text =
      typeof result?.text === "string"
        ? result.text
        : Array.isArray(result?.chunks)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? result.chunks.map((c: any) => c.text ?? "").join(" ")
          : "";
    const language =
      typeof result?.language === "string" ? result.language : null;
    return { text, language };
  };
};

/**
 * Decode any audio file to 16 kHz mono Float32 PCM via the bundled
 * `ffmpeg-static` binary. Spawns ffmpeg with stdin closed, reading the
 * input from `path` and writing raw `f32le` to stdout. The Float32Array
 * carries the samples directly.
 */
export const decodeAudioWithFfmpeg: AudioDecoder = async ({ path }) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ffmpegPathMod: any;
  try {
    ffmpegPathMod = await import("ffmpeg-static" as string);
  } catch (err) {
    throw new Error(
      `ffmpeg-static not installed: ${(err as Error).message}`,
    );
  }
  const ffmpegPath: string =
    typeof ffmpegPathMod?.default === "string"
      ? ffmpegPathMod.default
      : typeof ffmpegPathMod === "string"
        ? ffmpegPathMod
        : "";
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static: binary path not resolved");
  }

  return await new Promise<DecodedAudio>((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      path,
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(TARGET_SAMPLE_RATE),
      "-f",
      "f32le",
      "-",
    ];
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
        return;
      }
      const buf = Buffer.concat(stdoutChunks);
      const samples = new Float32Array(
        buf.buffer,
        buf.byteOffset,
        buf.byteLength / Float32Array.BYTES_PER_ELEMENT,
      );
      const owned = new Float32Array(samples.length);
      owned.set(samples);
      resolve({
        samples: owned,
        sampleRate: TARGET_SAMPLE_RATE,
        durationSec: owned.length / TARGET_SAMPLE_RATE,
      });
    });
  });
};
