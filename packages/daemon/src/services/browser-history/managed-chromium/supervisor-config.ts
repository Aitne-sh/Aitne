/**
 * Build the per-instance launch config for the managed Chromium
 * supervisor.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §7.1.
 *
 * Pure shape — no IO. The supervisor reads this on every tick to know
 * which binary to spawn, which user-data-dir to point at, which sandbox
 * primitive to wrap with, and which Chrome flags to pass.
 */

import { join } from "node:path";

import type { HostProfile, SandboxPrimitive } from "../types.js";
import {
  DEFAULT_CHECK_INTERVAL_MINUTES,
  DEFAULT_SYNC_FLUSH_WAIT_SECONDS,
  INSTANCE_S_DIRNAME,
  type ManagedChromiumLaunchConfig,
} from "./types.js";

/**
 * Chrome flags shared by Instance S supervisor cycles AND the
 * bootstrap UI window. The UI window appends its own `--app=` /
 * removes `--headless=new` etc. — this is the minimal common set.
 *
 * Why each:
 *   --remote-debugging-port=0     — CDP disabled. Instance S MUST NOT
 *                                    be reachable from Playwright;
 *                                    this is a structural guard
 *                                    independent of the absolute-block
 *                                    layer.
 *   --no-startup-window           — supervisor cycles run headless.
 *                                    Removed by the bootstrap module
 *                                    when an interactive UI window is
 *                                    needed.
 *   --disable-extensions          — no third-party extension surface.
 *   --disable-plugins             — no NPAPI surface.
 *   --disable-default-apps        — no Drive/Docs preinstalled webapps.
 *   --no-experiments              — predictable channel.
 *   --disable-features=…          — turn off autofill telemetry,
 *                                    translation, MediaRouter (all
 *                                    network-talkative surfaces not
 *                                    needed for sync).
 *   --disable-component-update    — pin component versions; the
 *                                    supervisor's lifecycle is the
 *                                    update gate, not Chrome's own
 *                                    component updater.
 *   --no-first-run                — skip welcome wizard.
 *   --no-default-browser-check    — don't prompt to set as default.
 */
const SHARED_FLAGS: readonly string[] = [
  "--no-startup-window",
  "--remote-debugging-port=0",
  "--disable-extensions",
  "--disable-plugins",
  "--disable-default-apps",
  "--no-experiments",
  "--disable-component-update",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-features=AutofillServerCommunication,Translate,MediaRouter",
] as const;

/** Additional flag for headless supervisor cycles. */
const HEADLESS_FLAG = "--headless=new";

/** Argv prefix for bootstrap UI windows. */
const BOOTSTRAP_UI_FLAGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-component-update",
  "--remote-debugging-port=0",
  "--disable-extensions",
] as const;

export interface BuildInstanceSConfigInput {
  host: HostProfile;
  paDataDir: string;
  /** Materialised sandbox primitive (with profilePath resolved for
   *  sandbox-exec). Resolved by `materialiseSandboxPrimitive`. */
  sandbox: SandboxPrimitive;
  /** Operator override for the per-cycle interval. */
  checkIntervalMinutes?: number;
  /** Operator override for the post-launch flush window. */
  syncFlushWaitSeconds?: number;
}

/**
 * Returns null when `binaryBath` resolution fails — caller persists
 * `state = "missing_binary"` in that case so the dashboard surfaces a
 * "Install Chromium first" hint.
 */
export function buildInstanceSConfig(
  input: BuildInstanceSConfigInput,
): ManagedChromiumLaunchConfig | null {
  const binaryPath = input.host.browserBinaryFor("chromium");
  if (!binaryPath) return null;
  const userDataDir = instanceSProfileDir(input.paDataDir);
  const args: string[] = [
    HEADLESS_FLAG,
    ...SHARED_FLAGS,
    `--user-data-dir=${userDataDir}`,
  ];
  return {
    binaryPath,
    userDataDir,
    extraArgs: args,
    syncFlushWaitSeconds: input.syncFlushWaitSeconds ?? DEFAULT_SYNC_FLUSH_WAIT_SECONDS,
    checkIntervalMinutes: input.checkIntervalMinutes ?? DEFAULT_CHECK_INTERVAL_MINUTES,
    sandbox: input.sandbox,
  };
}

/**
 * Build the argv for a bootstrap UI window. Reuses the same
 * user-data-dir as supervisor cycles so the resulting cookies / Local
 * State persist into the headless phase.
 */
export function buildBootstrapArgs(
  userDataDir: string,
  signInUrl: string,
): string[] {
  return [
    ...BOOTSTRAP_UI_FLAGS,
    `--user-data-dir=${userDataDir}`,
    `--app=${signInUrl}`,
  ];
}

export function instanceSProfileDir(paDataDir: string): string {
  return join(paDataDir, INSTANCE_S_DIRNAME);
}

/**
 * Build the argv for a B-2.5 per-site auth sign-in UI window.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §16.3.
 *
 * Structurally close to `buildBootstrapArgs` (Instance S sign-in) —
 * same minimal flag set, `--app=` opens the target page in a
 * chromeless UI window — but with two B-2.5-specific differences:
 *
 *   - The CDP port is kernel-assigned and exposed on loopback so the
 *     daemon can verify the post-sign-in state by `connectOverCDP`'ing
 *     into the already-running UI window (no second Chromium against
 *     the same profile dir — `--user-data-dir` cannot be shared, and a
 *     headless probe in a sibling dir would not see the cookies).
 *     `--remote-debugging-address=127.0.0.1` is added explicitly even
 *     though Chromium defaults that way when `--remote-debugging-port`
 *     is set — same defence-in-depth rationale as
 *     `INSTANCE_A_SHARED_FLAGS`.
 *   - Profile dir is per-site and parameterised by the caller (the
 *     site-bootstrap module owns the
 *     `<PA_DATA_DIR>/chromium-automation-auth/<siteKey>/` path).
 *
 * Note: Instance S's `BOOTSTRAP_UI_FLAGS` is reused for the static
 * flags (`--no-first-run`, `--no-default-browser-check`,
 * `--disable-component-update`, `--disable-extensions`) but the
 * `--remote-debugging-port=0` entry within it is overridden — the
 * caller-supplied port comes after, and Chromium honours the last
 * value when a flag repeats.
 */
export function buildAuthBootstrapArgs(input: {
  perSiteProfileDir: string;
  signInUrl: string;
  cdpPort: number;
}): string[] {
  return [
    ...BOOTSTRAP_UI_FLAGS,
    `--remote-debugging-port=${input.cdpPort}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${input.perSiteProfileDir}`,
    `--app=${input.signInUrl}`,
  ];
}

export const __testing = {
  SHARED_FLAGS,
  HEADLESS_FLAG,
  BOOTSTRAP_UI_FLAGS,
};
