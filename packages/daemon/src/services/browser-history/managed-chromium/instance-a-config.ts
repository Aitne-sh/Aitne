/**
 * Pure flag / argv builder for Instance A (automation Chromium).
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §5.2, §8.1.
 *
 * Instance A and Instance S share the same Chromium binary but never
 * the same `--user-data-dir`. The structural differences from
 * Instance S's `supervisor-config.ts:SHARED_FLAGS` are:
 *
 *   - `--remote-debugging-port=<random>` (CDP **enabled**). Instance S
 *     uses `--remote-debugging-port=0` (disabled) because Playwright
 *     must never touch the sync profile.
 *   - `--remote-allow-origins=http://127.0.0.1:<port>` is NOT
 *     needed for `connectOverCDP` (the daemon is the only consumer);
 *     including it would silently widen the local-CDP surface.
 *   - Per-workflow `--user-data-dir=<paDataDir>/chromium-automation-anon/<wfid>`.
 *   - `--no-sandbox` is **not** added here. On macOS ≤ 25 / Linux /
 *     Windows it is genuinely never added — the OS-level sandbox
 *     primitive is the outer ring and Chromium's helper-process
 *     renderer sandbox stays as the middle ring. On macOS 26+ the
 *     launcher (`sandbox-launcher.ts:buildSandboxExecArgs`) injects
 *     `--no-sandbox` itself when both the sandbox primitive is
 *     `sandbox-exec` and `darwinTahoeOrLater()` is true, because
 *     Tahoe's `forbidden-sandbox-reinit` default-deny makes the
 *     middle ring fail unconditionally; the outer + inner rings
 *     remain in force. Keeping the injection at the launcher rather
 *     than this builder means an operator who chooses
 *     `SandboxPrimitive.kind === "none"` (no outer ring) still gets
 *     Chromium's middle ring as the only line of defence.
 *
 * Kept as a pure helper so the 100% coverage gate locks in:
 *   - the CDP port flag's exact shape (a typo would silently disable
 *     interception when Playwright's regex match fails)
 *   - the headless flag is always present (a workflow that flips on a
 *     window would leak desktop surface to the user)
 *   - per-workflow profile dir is the LAST positional arg, so the
 *     sandbox's writable-binding list lines up with Chromium's view
 */

import { join } from "node:path";

import {
  INSTANCE_A_ANON_DIRNAME,
  INSTANCE_A_AUTH_DIRNAME,
  INSTANCE_A_PURCHASE_DIRNAME,
} from "./types.js";

/** Stable site-key shape — mirrors `automation/site-registry.ts:SITE_KEY_REGEX`.
 *  Re-declared here so the path builder fails fast when an unsafe key
 *  (containing `/`, `..`, NUL, whitespace) would otherwise escape the
 *  profile-dir root and write into an arbitrary location. The registry
 *  validator enforces this for shipping entries; this is the
 *  defence-in-depth path-shape check the launcher runs unconditionally. */
const SITE_KEY_REGEX = /^[a-z][a-z0-9_]*$/;

/** Shared automation flags — applied verbatim on every Instance A
 *  launch regardless of variant (anon / auth / purchase). */
export const INSTANCE_A_SHARED_FLAGS: readonly string[] = Object.freeze([
  "--headless=new",
  // Telemetry / autofill / translation / media-router off — Instance A
  // exists for headless workflow execution, none of these are useful and
  // each is a network-talkative surface.
  "--disable-extensions",
  "--disable-plugins",
  "--disable-default-apps",
  "--disable-component-update",
  "--no-first-run",
  "--no-default-browser-check",
  "--no-experiments",
  "--disable-features=AutofillServerCommunication,Translate,MediaRouter,InterestFeedV2",
  // Off-the-record-style data minimisation — every workflow gets a
  // fresh BrowserContext but these flags make the SingletonLock and
  // per-profile crash dumps quieter when the dir is short-lived.
  "--disable-crash-reporter",
  "--disable-breakpad",
  // Bind only to loopback for CDP. Chromium defaults to this when
  // `--remote-debugging-port` is set, but stating it explicitly removes
  // the chance of an environment-variable accidentally widening the
  // bind. (`--remote-debugging-address=0.0.0.0` is a known agent-bypass
  // shape; without the explicit flag a buggy operator override is the
  // only way it could land, but defence-in-depth is cheap here.)
  "--remote-debugging-address=127.0.0.1",
] as const);

/** Per-workflow anon profile dir: `<PA_DATA_DIR>/chromium-automation-anon/<workflowId>`. */
export function anonProfileDir(
  paDataDir: string,
  workflowId: string,
): string {
  return join(paDataDir, INSTANCE_A_ANON_DIRNAME, workflowId);
}

export interface InstanceALaunchArgsInput {
  paDataDir: string;
  workflowId: string;
  /** Loopback TCP port the daemon picks (cf. instance-a-launcher's
   *  random-port helper). Caller ensures it's available before passing. */
  cdpPort: number;
}

/**
 * Build the full argv for a Chromium spawn under Instance A's anon
 * variant. The launcher wraps this in the OS sandbox primitive and
 * passes the binary path separately.
 */
export function buildInstanceAAnonArgs(
  input: InstanceALaunchArgsInput,
): readonly string[] {
  const profileDir = anonProfileDir(input.paDataDir, input.workflowId);
  return Object.freeze([
    ...INSTANCE_A_SHARED_FLAGS,
    `--remote-debugging-port=${input.cdpPort}`,
    `--user-data-dir=${profileDir}`,
  ]);
}

/**
 * Per-site auth profile dir:
 * `<PA_DATA_DIR>/chromium-automation-auth/<siteKey>`.
 *
 * Throws on an invalid `siteKey` so a registry typo cannot land on disk
 * as a directory at `~/.personal-agent/chromium-automation-auth/../etc`.
 * The site registry validator already runs this check at module load;
 * doing it again here is the defence-in-depth path-shape contract for
 * any code path that builds an auth profile dir.
 */
export function authProfileDir(paDataDir: string, siteKey: string): string {
  if (!SITE_KEY_REGEX.test(siteKey)) {
    throw new Error(
      `authProfileDir: siteKey "${siteKey}" violates naming convention`,
    );
  }
  return join(paDataDir, INSTANCE_A_AUTH_DIRNAME, siteKey);
}

export interface InstanceAAuthLaunchArgsInput {
  paDataDir: string;
  siteKey: string;
  /** Loopback TCP port the daemon picks (cf. instance-a-launcher's
   *  random-port helper). Caller ensures it's available before passing. */
  cdpPort: number;
}

/**
 * Build the full argv for a Chromium spawn under Instance A's auth
 * variant — headless, reuses the per-site profile dir so persistent
 * cookies survive across workflows. The launcher wraps this in the OS
 * sandbox primitive and passes the binary path separately.
 *
 * Distinct from `buildInstanceAAuthBootstrapArgs` (in
 * `supervisor-config.ts`), which builds the UI-shaped argv for the
 * one-time sign-in window. The headless argv here is the per-workflow
 * runtime shape — both must point at the same profile dir so cookies
 * planted during sign-in are visible to subsequent workflow runs.
 */
export function buildInstanceAAuthArgs(
  input: InstanceAAuthLaunchArgsInput,
): readonly string[] {
  const profileDir = authProfileDir(input.paDataDir, input.siteKey);
  return Object.freeze([
    ...INSTANCE_A_SHARED_FLAGS,
    `--remote-debugging-port=${input.cdpPort}`,
    `--user-data-dir=${profileDir}`,
  ]);
}

/**
 * Per-site purchase profile dir:
 * `<PA_DATA_DIR>/chromium-automation-purchase/<siteKey>`.
 *
 * Strictly isolated from the auth profile dir of the same `siteKey`
 * (different parent directory) — cookies / localStorage planted under
 * B-2.5 sign-in cannot cross-contaminate the purchase profile, and the
 * absolute-block layer's `chromium-automation-purchase/**` Read/Write
 * deny patterns scope exactly to this tree.
 *
 * Throws on an invalid `siteKey` for the same reason as
 * `authProfileDir` — a registry typo cannot land at
 * `~/.personal-agent/chromium-automation-purchase/../etc`.
 */
export function purchaseProfileDir(
  paDataDir: string,
  siteKey: string,
): string {
  if (!SITE_KEY_REGEX.test(siteKey)) {
    throw new Error(
      `purchaseProfileDir: siteKey "${siteKey}" violates naming convention`,
    );
  }
  return join(paDataDir, INSTANCE_A_PURCHASE_DIRNAME, siteKey);
}

export interface InstanceAPurchaseLaunchArgsInput {
  paDataDir: string;
  siteKey: string;
  cdpPort: number;
}

/**
 * Build the full argv for a Chromium spawn under Instance A's purchase
 * variant. Identical shape to the auth variant — headless, per-site
 * profile dir — but rooted under `chromium-automation-purchase/` so
 * the absolute-block layer + the file-shape guards distinguish the two
 * trees. Plan §17.5: "operates on the A-purchase/<site_key> profile's
 * already-populated cart".
 */
export function buildInstanceAPurchaseArgs(
  input: InstanceAPurchaseLaunchArgsInput,
): readonly string[] {
  const profileDir = purchaseProfileDir(input.paDataDir, input.siteKey);
  return Object.freeze([
    ...INSTANCE_A_SHARED_FLAGS,
    `--remote-debugging-port=${input.cdpPort}`,
    `--user-data-dir=${profileDir}`,
  ]);
}
