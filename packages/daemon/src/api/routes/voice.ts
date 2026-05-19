import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { z } from "zod";
import { isSupportedVoiceLanguage, localeToVoiceLanguage } from "@aitne/shared";
import type { ApiDependencies } from "../server.js";
import { createSettingsStore } from "../../settings/settings-store.js";
import { defaultLoadPipeline } from "../../services/voice/transcriber-impl.js";
import {
  VOICE_TRANSCRIBER_DEFAULTS,
  type PipelineProgressEvent,
} from "../../services/voice/transcriber.js";
import { createLogger, toSafeErrorMessage } from "../../logging.js";

const logger = createLogger("api:voice");

/**
 * Voice transcription opt-in surface.
 *
 *   GET  /api/voice/status   — current install/enable state for the dashboard
 *   POST /api/voice/install  — kick off model download, persist enabled=true,
 *                              and trigger a daemon self-restart on success.
 *
 * See docs/design/appendices/voice-transcription.md for the toggle workflow,
 * the model defaults, and the post-install restart contract.
 */

type InstallStatus = "idle" | "running" | "ready" | "error";

interface InstallProgress {
  phase: "initializing" | "downloading" | "loading" | "ready";
  currentFile: string | null;
  loadedBytes: number;
  totalBytes: number;
  percent: number;
  filesDownloaded: number;
}

interface InstallState {
  status: InstallStatus;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  /**
   * `true` once a successful download completes. Surviving across the
   * planned auto-restart relies on `voiceTranscriptionEnabled` being
   * persisted before the restart fires; this flag is the in-process
   * shadow used until the restart actually happens.
   */
  installed: boolean;
  progress: InstallProgress | null;
}

let state: InstallState = {
  status: "idle",
  startedAt: null,
  finishedAt: null,
  error: null,
  installed: false,
  progress: null,
};

/** Test seam — let the test harness inspect state without exposing the full module. */
export function __getVoiceInstallStateForTest(): InstallState {
  return { ...state };
}
export function __resetVoiceInstallStateForTest(): void {
  state = {
    status: "idle",
    startedAt: null,
    finishedAt: null,
    error: null,
    installed: false,
    progress: null,
  };
}

/**
 * Resolve the configured Whisper model id, applying the env override
 * (advanced operators) on top of the package default. Single source of
 * truth — the install route, the status route, and the on-disk check
 * all run through this so they cannot drift.
 */
function resolveConfiguredModel(): string {
  return (
    process.env.PA_VOICE_TRANSCRIPTION_MODEL ?? VOICE_TRANSCRIBER_DEFAULTS.model
  );
}

/**
 * Best-effort check that the configured model is materialized on disk.
 * Used by the dashboard to surface an "upgrade available" prompt when
 * the package default model has changed since the last install (e.g.
 * the v0.1.1 → v0.2.0 jump from `Xenova/whisper-small` to
 * `onnx-community/whisper-large-v3-turbo`).
 *
 * Two cache layouts are checked because we set BOTH `env.cacheDir` and
 * `env.localModelPath` to `modelDir` in `defaultLoadPipeline`:
 *
 *  1. Hub layout — `hub/models--<owner>--<name>/snapshots/<commit>/...`
 *     This is what transformers.js writes when it falls through to the
 *     remote-fetch path with `cacheDir` set.
 *  2. Flat (localModelPath) layout — `<owner>/<name>/onnx/<file>.onnx`
 *     What transformers.js writes (and reads from) when `localModelPath`
 *     is set and the model is resolved as a local model. Existing
 *     installs from before the turbo upgrade live in this layout.
 *
 * Both checks require at least one ONNX weight to be present — an empty
 * directory tree left behind by an aborted download must not register
 * as "installed" or the install endpoint's `alreadyEnabled` short-
 * circuit fires on a cold cache and the user is stuck unable to retry.
 */
function isModelOnDisk(modelDir: string, modelId: string): boolean {
  const [owner, name] = modelId.split("/");
  if (!owner || !name) return false;

  // Hub layout: any non-empty snapshot dir signals a successful checkout.
  const snapshotsDir = join(
    modelDir,
    "hub",
    `models--${owner}--${name}`,
    "snapshots",
  );
  try {
    if (readdirSync(snapshotsDir).length > 0) return true;
  } catch {
    // ENOENT (dir doesn't exist) or permission error — fall through to
    // the flat-layout check.
  }

  // Flat layout: require at least one `.onnx` weight under `<owner>/<name>/
  // onnx/`. The presence of `config.json` alone is not sufficient — a
  // partial download can leave the metadata files but no weights.
  const flatOnnxDir = join(modelDir, owner, name, "onnx");
  try {
    return readdirSync(flatOnnxDir).some((f) => f.endsWith(".onnx"));
  } catch {
    return false;
  }
}

/**
 * Sum the on-disk size (in bytes) of every file under the configured
 * model's directory tree. Returns 0 when nothing is materialized. Used
 * by the dashboard to surface "Installed: 759.4 MB" so the operator can
 * confirm at a glance that the weights are present without consulting
 * the file system.
 *
 * Checks both layouts (hub + flat) for symmetry with `isModelOnDisk`.
 * Walks recursively because the flat layout splits weights into an
 * `onnx/` subdir and the hub layout nests under `snapshots/<commit>/`.
 */
function computeModelDiskSize(modelDir: string, modelId: string): number {
  const [owner, name] = modelId.split("/");
  if (!owner || !name) return 0;

  let total = 0;
  const walk = (dirPath: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dirPath);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dirPath, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(full);
      } else if (stats.isFile()) {
        total += stats.size;
      }
    }
  };

  walk(join(modelDir, owner, name));
  walk(join(modelDir, "hub", `models--${owner}--${name}`));
  return total;
}

/**
 * Map the daemon's runtime locale to a Whisper language code, used as
 * the default selection in the dashboard's install dialog. We prefer
 * `Intl.DateTimeFormat` (stable, cross-platform) over POSIX `LANG`
 * because `LANG` is often `C.UTF-8` on headless macOS launches.
 */
function suggestPrimaryLanguageFromLocale(): string {
  const candidates = [
    Intl.DateTimeFormat().resolvedOptions().locale,
    process.env.LANG ?? null,
    process.env.LC_ALL ?? null,
  ];
  for (const candidate of candidates) {
    const mapped = localeToVoiceLanguage(candidate);
    if (mapped) return mapped;
  }
  return "en";
}

/**
 * Walk up from `start` looking for a directory that contains
 * `bin/aitne.mjs`. Returns the resolved path to the bin script, or
 * `null` if no ancestor matches before reaching the filesystem root.
 *
 * Used by `triggerSelfRestart` so the restart works regardless of the
 * daemon's launch cwd — the bin script lives at `<package-root>/bin/
 * aitne.mjs` whether the package was installed via npm into a global
 * prefix, into a project's node_modules, or run from the source repo.
 *
 * Bounded at AITNE_BIN_SEARCH_MAX_DEPTH iterations as a defensive guard
 * against pathological inputs; the deepest realistic distance is
 * `packages/daemon/dist/api/routes` → package root, which is 5.
 */
const AITNE_BIN_SEARCH_MAX_DEPTH = 10;

function findAitneBin(start: string): string | null {
  let dir = start;
  for (let i = 0; i < AITNE_BIN_SEARCH_MAX_DEPTH; i += 1) {
    const candidate = join(dir, "bin", "aitne.mjs");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Spawn a detached `aitne restart` so the daemon picks up the new
 * `voiceTranscriptionEnabled` flag. The detached child SIGTERMs the
 * current daemon as part of its `cmdStop`, then starts a fresh one;
 * we do NOT exit ourselves because the child needs us alive long enough
 * to find our PID file.
 *
 * The bin script is resolved by walking up from this module's own URL,
 * not from `process.cwd()`. The previous cwd-based lookup only worked
 * when the daemon was launched via the `aitne` CLI (which chdirs to the
 * package root); a direct `node packages/daemon/dist/index.js` would
 * silently fail to restart.
 */
function triggerSelfRestart(): void {
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const aitneBin =
      findAitneBin(moduleDir) ?? findAitneBin(resolve(process.cwd()));
    if (!aitneBin) {
      logger.error(
        { moduleDir, cwd: process.cwd() },
        "could not locate aitne bin for restart after voice install",
      );
      return;
    }
    const child = spawn(process.execPath, [aitneBin, "restart", "--no-open"], {
      detached: true,
      stdio: "ignore",
      // PA_DAEMONIZED is unset deliberately — the restart child runs the
      // CLI's stop+start path the same way an interactive `aitne restart`
      // would, then exits.
      env: { ...process.env },
    });
    child.unref();
    logger.info(
      { pid: child.pid, aitneBin },
      "spawned aitne restart for voice install",
    );
  } catch (err) {
    logger.error({ err }, "failed to spawn aitne restart after voice install");
  }
}

const voiceInstallBodySchema = z
  .object({
    /**
     * Whisper language code persisted as `voiceTranscriptionPrimaryLanguage`.
     * Used as the fallback target when post-install auto-detect produces a
     * placeholder hallucination. Optional — when omitted, an existing
     * setting is preserved; on a fresh install with no existing setting,
     * the dashboard pre-selects the OS-locale suggestion.
     */
    primaryLanguage: z
      .string()
      .refine(isSupportedVoiceLanguage, {
        message: "primaryLanguage is not a Whisper-supported language code.",
      })
      .nullish(),
  })
  .strict();

export interface VoiceRoutesOptions {
  /** Test seam — inject the model loader so unit tests do not actually download weights. */
  loadPipeline?: typeof defaultLoadPipeline;
  /** Test seam — replace the restart trigger so unit tests do not spawn processes. */
  triggerRestart?: () => void;
  /** Test seam — override the locale-suggestion source. */
  suggestPrimaryLanguage?: () => string;
}

export function createVoiceRoutes(
  deps: ApiDependencies,
  opts: VoiceRoutesOptions = {},
): Hono {
  const app = new Hono();
  const { db, config } = deps;
  const loadPipeline = opts.loadPipeline ?? defaultLoadPipeline;
  const triggerRestart = opts.triggerRestart ?? triggerSelfRestart;
  const suggestPrimaryLanguage =
    opts.suggestPrimaryLanguage ?? suggestPrimaryLanguageFromLocale;

  app.get("/voice/status", (c) => {
    const modelDir = join(config.dataDir, "models", "whisper");
    const model = resolveConfiguredModel();
    const modelOnDisk = isModelOnDisk(modelDir, model);
    // Compute disk usage only when something is on disk — saves a
    // recursive readdir on every poll while the model is uninstalled.
    const modelSizeBytes = modelOnDisk
      ? computeModelDiskSize(modelDir, model)
      : 0;
    return c.json({
      enabled: config.voiceTranscriptionEnabled,
      installing: state.status === "running",
      // `installed` is the legacy "voice mode is set up at all" signal,
      // preserved for backward compat with older dashboard builds.
      installed: state.installed || config.voiceTranscriptionEnabled,
      // `modelOnDisk` is the precise filesystem check — if the package
      // default model has changed (an upgrade), this flips to false even
      // while `enabled` and `installed` remain true. The dashboard reads
      // this to surface the "Upgrade available" CTA.
      modelOnDisk,
      // Aggregate byte size of all files under the model's on-disk
      // directory. 0 when nothing materialized. The dashboard renders
      // it next to the model id so operators can confirm at a glance
      // that the weights are actually present (vs an empty stub dir
      // left behind by a half-failed install).
      modelSizeBytes,
      modelDir,
      status: state.status,
      error: state.error,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      model,
      progress: state.progress,
      primaryLanguage: config.voiceTranscriptionPrimaryLanguage,
      suggestedPrimaryLanguage: suggestPrimaryLanguage(),
      // The picker UI imports VOICE_LANGUAGE_TOP / VOICE_LANGUAGE_FULL
      // directly from @aitne/shared rather than receiving them in this
      // payload — the lists are static, ~3KB, and were previously sent
      // on every status poll (1.5s during install + restart-wait) for
      // no UI gain. The daemon doesn't authoritatively pick which
      // languages Whisper supports; it just validates the persisted
      // value against the same shared registry.
    });
  });

  app.post("/voice/install", async (c) => {
    if (state.status === "running") {
      return c.json(
        {
          status: "running",
          startedAt: state.startedAt,
        },
        202,
      );
    }

    const rawBody = await c.req.json().catch(() => ({}));
    const parsedBody = voiceInstallBodySchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return c.json(
        {
          status: "error",
          error: "Invalid request body",
          issues: parsedBody.error.issues,
        },
        400,
      );
    }
    const requestedPrimary = parsedBody.data.primaryLanguage ?? null;

    const settings = createSettingsStore(db);

    // Persist the primary language up front (before the long-running
    // download) so the dashboard can read it back via /voice/status while
    // the install is in flight. Null in the body preserves any existing
    // setting; an explicit non-null value overwrites.
    if (requestedPrimary !== null) {
      settings.set("voiceTranscriptionPrimaryLanguage", requestedPrimary);
      config.voiceTranscriptionPrimaryLanguage = requestedPrimary;
    }

    const model = resolveConfiguredModel();
    const modelDir = join(config.dataDir, "models", "whisper");

    if (
      config.voiceTranscriptionEnabled
      && state.status !== "error"
      && isModelOnDisk(modelDir, model)
    ) {
      // Already enabled in a prior boot AND the configured model is on
      // disk; nothing to download. (If the model is NOT on disk — e.g.
      // a package upgrade switched the default — we still fall through
      // to the install path below so the new weights land.)
      return c.json({ status: "ready", alreadyEnabled: true });
    }

    state = {
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      installed: state.installed,
      progress: {
        phase: "initializing",
        currentFile: null,
        loadedBytes: 0,
        totalBytes: 0,
        percent: 0,
        filesDownloaded: 0,
      },
    };

    // The transcriber constructor mkdirs this dir, but only when the flag is
    // already on at boot — at install time the flag is still false, so create
    // the dir explicitly here. FileCache.put inside transformers.js does its
    // own `mkdir -p`, but having the root dir present at install time makes
    // `isModelOnDisk` checks below behave consistently and avoids relying on
    // a third-party cache implementation to create our daemon-owned path.
    try {
      mkdirSync(modelDir, { recursive: true });
    } catch (err) {
      logger.warn({ err, modelDir }, "voice model dir mkdir failed");
    }

    // NOTE: HF_HOME / TRANSFORMERS_CACHE are PYTHON-side env vars; the JS
    // port of @huggingface/transformers ignores them. The actual cache-dir
    // override happens inside `defaultLoadPipeline`, which sets
    // `mod.env.cacheDir = modelDir` after the dynamic import. We still set
    // these for any sidecar tooling that may honor them.
    process.env.HF_HOME ??= modelDir;
    process.env.TRANSFORMERS_CACHE ??= modelDir;

    const onProgress = (event: PipelineProgressEvent) => {
      const prev = state.progress ?? {
        phase: "initializing" as const,
        currentFile: null,
        loadedBytes: 0,
        totalBytes: 0,
        percent: 0,
        filesDownloaded: 0,
      };
      switch (event.status) {
        case "initiate":
        case "download": {
          state.progress = {
            ...prev,
            phase: "downloading",
            currentFile: event.file ?? prev.currentFile,
            // A new file just started — reset per-file byte counters so the
            // bar doesn't jump backward when the next progress event lands.
            loadedBytes: 0,
            totalBytes: event.total ?? 0,
            percent: 0,
          };
          break;
        }
        case "progress": {
          const total = event.total ?? prev.totalBytes;
          const loaded = event.loaded ?? prev.loadedBytes;
          const percent = typeof event.progress === "number"
            ? event.progress
            : total > 0
              ? Math.round((loaded / total) * 100)
              : prev.percent;
          state.progress = {
            ...prev,
            phase: "downloading",
            currentFile: event.file ?? prev.currentFile,
            loadedBytes: loaded,
            totalBytes: total,
            percent: Math.min(100, Math.max(0, percent)),
          };
          break;
        }
        case "done": {
          state.progress = {
            ...prev,
            filesDownloaded: prev.filesDownloaded + 1,
            // The just-completed file is at 100% by definition.
            percent: 100,
          };
          break;
        }
        case "ready": {
          state.progress = {
            ...prev,
            phase: "ready",
            currentFile: null,
            percent: 100,
          };
          break;
        }
      }
    };

    // Fire-and-forget — the dashboard polls /voice/status to track progress.
    // The HTTP response returns immediately so the client does not hold a
    // long-lived connection through the model download.
    void (async () => {
      try {
        // Actually download + initialize the pipeline to verify the weights
        // resolved end-to-end. A successful return means the next boot can
        // load from cache without network.
        await loadPipeline({ model, modelDir, onProgress });

        settings.set("voiceTranscriptionEnabled", true);
        config.voiceTranscriptionEnabled = true;

        state = {
          status: "ready",
          startedAt: state.startedAt,
          finishedAt: Date.now(),
          error: null,
          installed: true,
          progress: {
            phase: "ready",
            currentFile: null,
            loadedBytes: state.progress?.loadedBytes ?? 0,
            totalBytes: state.progress?.totalBytes ?? 0,
            percent: 100,
            filesDownloaded: state.progress?.filesDownloaded ?? 0,
          },
        };

        logger.info({ model, modelDir }, "voice model installed; restarting daemon");
        // Defer the restart by a tick so the in-flight HTTP response (and
        // any subsequent polling response) flushes before SIGTERM lands.
        setTimeout(triggerRestart, 250);
      } catch (err) {
        const message = toSafeErrorMessage(err);
        state = {
          status: "error",
          startedAt: state.startedAt,
          finishedAt: Date.now(),
          error: message,
          installed: state.installed,
          progress: state.progress,
        };
        logger.error({ err, model }, "voice model install failed");
      }
    })();

    return c.json({ status: "running", startedAt: state.startedAt }, 202);
  });

  /**
   * Remove the on-disk Whisper model so the operator can re-install from
   * scratch. Used after a half-failed download has poisoned the in-memory
   * `state.error` and left the dashboard's "Upgrade available" prompt
   * stuck. Both the flat (`<owner>/<name>/`) and hub
   * (`hub/models--<owner>--<name>/`) layouts are removed because
   * transformers.js may have written into either depending on which
   * lookup path resolved first. `voiceTranscriptionEnabled` is preserved
   * so the dashboard's next /voice/status poll surfaces "Upgrade & install"
   * (modelOnDisk=false) rather than reverting to the disabled state. The
   * route refuses while a download is in flight to avoid pulling the
   * weights out from under the install pipeline.
   */
  app.delete("/voice/model", async (c) => {
    if (state.status === "running") {
      return c.json(
        {
          status: "error",
          error: "Install in progress; cannot delete the model right now.",
        },
        409,
      );
    }

    const model = resolveConfiguredModel();
    const modelDir = join(config.dataDir, "models", "whisper");
    const [owner, name] = model.split("/");
    if (!owner || !name) {
      return c.json(
        { status: "error", error: `Invalid configured model id: "${model}"` },
        400,
      );
    }

    const candidates = [
      join(modelDir, owner, name),
      join(modelDir, "hub", `models--${owner}--${name}`),
    ];
    const removed: string[] = [];
    const errors: { dir: string; error: string }[] = [];
    for (const dir of candidates) {
      const existedBefore = existsSync(dir);
      try {
        await rm(dir, { recursive: true, force: true });
        if (existedBefore) removed.push(dir);
      } catch (err) {
        errors.push({ dir, error: toSafeErrorMessage(err) });
        logger.warn({ err, dir }, "voice model dir removal failed");
      }
    }

    // Reset in-memory install state so the dashboard's stale error banner
    // clears and a subsequent /voice/install runs against a fresh slate.
    // We deliberately leave `installed` at false because nothing is on
    // disk anymore — the next install round-trip flips it back to true.
    state = {
      status: "idle",
      startedAt: null,
      finishedAt: null,
      error: null,
      installed: false,
      progress: null,
    };

    logger.info({ model, removed, errors }, "voice model deleted");

    if (errors.length > 0 && removed.length === 0) {
      return c.json(
        { status: "error", model, removed, errors },
        500,
      );
    }
    return c.json({ status: "deleted", model, removed, errors });
  });

  return app;
}
