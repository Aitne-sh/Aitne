/**
 * On-demand Playwright Chromium installer.
 *
 * Resolves the "first-run UX" problem for the managed-Chromium feature:
 * instead of asking the operator to `brew install chromium` (or apt /
 * dnf equivalent) and *then* enable the integration, we let them flip
 * the master toggle and trigger a daemon-driven download of the
 * Playwright-pinned Chromium build into `~/.cache/ms-playwright/`
 * (XDG cache root differs per OS — Playwright manages the layout).
 *
 * Rationale (vs. bundling Chromium in the npm tarball):
 *   - npm tarball size stays where it is (today's package is ~tens of
 *     MB; bundling Chromium for every supported platform pushes that
 *     to ~1 GB and turns every Aitne release into a Chromium security
 *     release).
 *   - Playwright already ships pre-notarised macOS builds and prebuilt
 *     Linux/Windows binaries. Aitne does not have to maintain the
 *     code-signing pipeline.
 *   - System-installed Chromium (brew / apt / dnf) still wins when
 *     present — `HostProfile.browserBinaryFor("chromium")` probes the
 *     OS package first and only falls back to the Playwright cache
 *     when the OS path resolves to null. Operators who already have
 *     Chromium installed see zero extra disk usage.
 *
 * Concurrency: at most one install runs daemon-wide. A second
 * `startInstall()` while one is in flight returns `already_running`.
 *
 * State persistence: progress is in-memory (the dashboard polls every
 * second while downloading); the *result* (binary path on success,
 * error message on failure) is the only durable output, and it lives
 * implicitly in the Playwright cache on disk — the next boot's
 * `browserBinaryFor("chromium")` probe will pick it up.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { createLogger } from "../../../logging.js";
import { playwrightExecutablePathSync } from "./platform.js";

const logger = createLogger("chromium-install");

export type ChromiumInstallState =
  | "idle"
  | "downloading"
  | "verifying"
  | "completed"
  | "failed";

export interface ChromiumInstallStatus {
  state: ChromiumInstallState;
  /** 0-100, null until first progress line. */
  progressPercent: number | null;
  /** Total MiB reported by Playwright; null until first line. */
  totalMib: number | null;
  /** Approximate downloaded MiB (derived from percent × total). */
  downloadedMib: number | null;
  startedAt: number | null;
  completedAt: number | null;
  /** Resolved binary path on `completed`; null otherwise. */
  binaryPath: string | null;
  errorMessage: string | null;
}

const DEFAULT_STATUS: ChromiumInstallStatus = {
  state: "idle",
  progressPercent: null,
  totalMib: null,
  downloadedMib: null,
  startedAt: null,
  completedAt: null,
  binaryPath: null,
  errorMessage: null,
};

let current: ChromiumInstallStatus = { ...DEFAULT_STATUS };
let childRef: ChildProcess | null = null;

export function getChromiumInstallStatus(): ChromiumInstallStatus {
  return { ...current };
}

/**
 * Resolve the headed Chromium binary path inside the Playwright cache,
 * if Playwright has been installed via `playwright install chromium`.
 * Async wrapper over the synchronous resolver in `platform.ts` — kept
 * as a `Promise` because the install-completion callback below was
 * written against an async signature and other future callers may want
 * to chain a real verification step here (e.g. spawning the binary
 * with `--version`).
 */
export async function getPlaywrightChromiumPath(): Promise<string | null> {
  return playwrightExecutablePathSync();
}

function resolveCliPath(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req.resolve("playwright-core/package.json");
    const cli = join(dirname(pkg), "cli.js");
    return existsSync(cli) ? cli : null;
  } catch (err) {
    logger.warn({ err }, "could not resolve playwright-core/cli.js path");
    return null;
  }
}

export type StartInstallResult =
  | { ok: true }
  | { ok: false; reason: "already_running" | "spawn_failed" };

/**
 * Spawn `node <playwright-core>/cli.js install chromium`. Returns
 * synchronously after the spawn — completion is observed via
 * `getChromiumInstallStatus()` polling. Idempotent: a second call
 * while a download is in flight returns `already_running`.
 */
export function startChromiumInstall(): StartInstallResult {
  if (current.state === "downloading" || current.state === "verifying") {
    return { ok: false, reason: "already_running" };
  }
  const cli = resolveCliPath();
  if (!cli) {
    current = {
      ...DEFAULT_STATUS,
      state: "failed",
      errorMessage: "playwright-core cli.js not resolvable on this host",
      startedAt: Date.now(),
      completedAt: Date.now(),
    };
    return { ok: false, reason: "spawn_failed" };
  }

  current = {
    ...DEFAULT_STATUS,
    state: "downloading",
    startedAt: Date.now(),
  };

  try {
    childRef = spawn(process.execPath, [cli, "install", "chromium"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
  } catch (err) {
    childRef = null;
    current = {
      ...DEFAULT_STATUS,
      state: "failed",
      errorMessage: err instanceof Error ? err.message : String(err),
      startedAt: Date.now(),
      completedAt: Date.now(),
    };
    return { ok: false, reason: "spawn_failed" };
  }

  let buf = "";
  // Playwright emits progress lines like:
  //   |████████████░░░░| 60% of 142.3 MiB
  // ...both during the download phase. After the download:
  //   Chromium 130.0.6723.116 (playwright build v1208) downloaded to /.../chromium-1208
  // We parse percent/total from any line that matches the percent
  // pattern; the "downloaded to" line is our verifying→completed
  // transition signal (verified once cli.js exits 0).
  const handleLine = (line: string): void => {
    const pct = /(\d+(?:\.\d+)?)\s*%\s+of\s+(\d+(?:\.\d+)?)\s*(?:MiB|MB)/i.exec(
      line,
    );
    if (pct) {
      // `\d+` in the regex guarantees both groups parse, but be defensive:
      // a future regex tweak that allows e.g. an empty group would otherwise
      // surface as NaN downstream (Math.round(NaN) → NaN → schema rejection).
      const rawPercent = parseFloat(pct[1]);
      const rawTotal = parseFloat(pct[2]);
      const percent = Number.isFinite(rawPercent)
        ? Math.max(0, Math.min(100, rawPercent))
        : current.progressPercent ?? 0;
      current = {
        ...current,
        progressPercent: Math.round(percent),
        totalMib: Number.isFinite(rawTotal) ? rawTotal : current.totalMib,
        downloadedMib: Number.isFinite(rawTotal)
          ? Math.round((percent / 100) * rawTotal * 10) / 10
          : current.downloadedMib,
      };
      return;
    }
    if (/downloaded to/i.test(line)) {
      current = { ...current, state: "verifying" };
    }
  };
  const pipe = (chunk: Buffer): void => {
    buf += chunk.toString("utf8");
    const lines = buf.split(/\r?\n|\r/);
    buf = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  };
  childRef.stdout?.on("data", pipe);
  childRef.stderr?.on("data", pipe);

  childRef.once("exit", (code, signal) => {
    childRef = null;
    if (code === 0) {
      void getPlaywrightChromiumPath().then((path) => {
        current = {
          ...current,
          state: path ? "completed" : "failed",
          binaryPath: path,
          progressPercent: 100,
          completedAt: Date.now(),
          errorMessage: path
            ? null
            : "install exited 0 but Chromium binary path did not resolve",
        };
        logger.info(
          { binaryPath: path },
          path
            ? "Playwright Chromium install completed"
            : "Playwright Chromium install completed but path resolution failed",
        );
      });
    } else {
      current = {
        ...current,
        state: "failed",
        completedAt: Date.now(),
        errorMessage: `playwright install exited code=${code ?? "?"} signal=${signal ?? "?"}`,
      };
      logger.warn(
        { code, signal },
        "Playwright Chromium install exited non-zero",
      );
    }
  });
  childRef.once("error", (err) => {
    childRef = null;
    current = {
      ...current,
      state: "failed",
      completedAt: Date.now(),
      errorMessage: err.message,
    };
    logger.error({ err }, "Playwright Chromium install spawn errored");
  });
  return { ok: true };
}
