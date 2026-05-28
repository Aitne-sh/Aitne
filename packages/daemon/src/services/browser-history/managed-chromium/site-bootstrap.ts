/**
 * Per-site authenticated-session bootstrap.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §16.3.
 *
 * Lifecycle:
 *   1. `startSiteBootstrap` spawns a UI Chromium under the OS sandbox
 *      primitive with `--app=<signInUrl>` and CDP exposed on a
 *      loopback random port. The user signs in interactively. The
 *      bootstrap row is persisted to
 *      `runtime_state.managed_chromium.site_bootstrap.<siteKey>`
 *      with a 15-min deadline (orphan reaper).
 *   2. The dashboard polls `getSiteBootstrapStatus`, which
 *      `connectOverCDP`'s into the already-running UI window, opens a
 *      new tab, navigates to `profileVerifyUrl`, and checks whether
 *      the site's `signedInSelector` resolves. CDP probe lives next to
 *      the UI window (sharing the cookies in the live profile dir) —
 *      a sibling headless Chromium would not see the SingletonLock-
 *      protected profile.
 *   3. `finalizeSiteBootstrap` re-runs the probe, SIGTERMs the UI
 *      window, writes the persistent
 *      `runtime_state.managed_chromium.sites.<siteKey>` row carrying
 *      `{ connectedAt, accountLabel, lastWorkflowAt: null }`.
 *   4. `disconnectSite` SIGTERMs any UI window for this siteKey,
 *      removes `chromium-automation-auth/<siteKey>/` recursively, and
 *      clears both runtime_state rows. The dashboard tells the user
 *      they should also revoke the session from the site's own
 *      account page if they want global revocation.
 *   5. `reapStaleSiteBootstrap` is the orphan reaper — invoked by the
 *      supervisor's per-cycle hook to SIGKILL bootstraps whose
 *      `deadlineAt` has passed without a finalize.
 *
 * Excluded from the 100% coverage gate — every function in this
 * module touches a real subprocess (the UI Chromium spawn), the
 * network (Playwright CDP connect / probe-page navigate), or the
 * filesystem (per-site profile dir lifecycle); matches the existing
 * `setup-bootstrap.ts` / `instance-a-launcher.ts` exclusion rationale.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";

import type Database from "better-sqlite3";

import {
  clearSiteBootstrap,
  clearSiteConnection,
  readSiteBootstrap,
  writeSiteBootstrap,
  writeSiteConnection,
  type SiteBootstrap,
} from "../../../db/managed-chromium-sites-store.js";
import { createLogger } from "../../../logging.js";
import { authProfileDir } from "./instance-a-config.js";
import { launchUnderSandbox } from "./sandbox-launcher.js";
import { materialiseSandboxPrimitive } from "./sandbox-install.js";
import { buildAuthBootstrapArgs } from "./supervisor-config.js";
import { chromiumBundleRoot } from "../lifecycle/platform.js";
import { DEFAULT_BOOTSTRAP_TIMEOUT_MS } from "./types.js";
import type { HostProfile, SandboxPrimitive } from "../types.js";
import { getSite, type SiteDefinition } from "../automation/site-registry.js";

const logger = createLogger("managed-chromium-site-bootstrap");

/** Probe page navigation timeout — the probe is a network-bound
 *  fetch through Chromium's network stack, so we allow longer than
 *  the CDP attach timeout (3 s) but still short enough that a
 *  network-broken site does not hang the status poll. */
const PROBE_NAVIGATE_TIMEOUT_MS = 8_000;

/** CDP attach timeout — the daemon owns the spawned UI window, so a
 *  failure to connect is exceptional and short-timeouts are correct. */
const CDP_ATTACH_TIMEOUT_MS = 3_000;

export interface SiteBootstrapDeps {
  db: Database.Database;
  host: HostProfile;
  paDataDir: string;
  /** Allows tests to inject a clock. */
  now?: () => number;
  /** Allows tests to override the timeout. */
  timeoutMs?: number;
  /** Allows tests to inject a launcher. */
  launcher?: typeof launchUnderSandbox;
  /** Allows tests to skip the real sandbox materialisation. */
  resolveSandbox?: (raw: SandboxPrimitive) => Promise<SandboxPrimitive>;
}

export type StartSiteBootstrapResult =
  | { ok: true; pid: number; deadlineAt: number; cdpPort: number }
  | {
      ok: false;
      reason:
        | "unknown_site"
        | "missing_binary"
        | "missing_sandbox"
        | "spawn_failed"
        | "already_running";
    };

/**
 * Start a UI Chromium for the per-site sign-in flow. Two modes:
 *   - `reauth=false`: initial connect; profile dir is created if absent.
 *   - `reauth=true`: re-spawn the UI window over the existing profile
 *     dir so Chromium can drive auto-sign-in / a 2FA reprompt without
 *     forcing the user to retype their primary credentials.
 *
 * Returns the spawned PID + the CDP port the status probe should
 * connect to + the deadline the orphan reaper enforces.
 */
export async function startSiteBootstrap(
  deps: SiteBootstrapDeps,
  opts: { siteKey: string; reauth: boolean },
): Promise<StartSiteBootstrapResult> {
  const site = getSite(opts.siteKey);
  if (!site) {
    return { ok: false, reason: "unknown_site" };
  }

  const now = (deps.now ?? Date.now)();
  const existing = readSiteBootstrap(deps.db, opts.siteKey);
  if (existing && existing.deadlineAt > now) {
    return {
      ok: true,
      pid: existing.pid,
      deadlineAt: existing.deadlineAt,
      cdpPort: existing.cdpPort,
    };
  }

  const binaryPath = deps.host.browserBinaryFor("chromium");
  if (!binaryPath) {
    return { ok: false, reason: "missing_binary" };
  }
  if (deps.host.sandboxPrimitive.kind === "none") {
    // Operator must explicitly opt in via the managed-chromium master
    // toggle (state.unsandboxedOptIn). The route layer is the chokepoint
    // for that check; this is the defence-in-depth refusal mirroring the
    // Instance A launcher.
    return { ok: false, reason: "missing_sandbox" };
  }

  const profileDir = authProfileDir(deps.paDataDir, opts.siteKey);
  await mkdir(profileDir, { recursive: true });

  const cdpPort = await pickFreeLoopbackPort();
  const sandbox = await (deps.resolveSandbox ?? materialiseSandboxPrimitive)(
    deps.host.sandboxPrimitive,
    {
      paDataDir: deps.paDataDir,
      binaryPath,
      userDataDir: profileDir,
    },
  );

  const launcher = deps.launcher ?? launchUnderSandbox;
  let child;
  try {
    const result = launcher(sandbox, {
      binary: binaryPath,
      args: buildAuthBootstrapArgs({
        perSiteProfileDir: profileDir,
        signInUrl: site.signInUrl,
        cdpPort,
      }),
      writableBindings: [profileDir],
      readableBindings: [chromiumBundleRoot(binaryPath)],
      detached: true,
    });
    child = result.child;
  } catch (err) {
    logger.error({ err, siteKey: opts.siteKey }, "site bootstrap UI spawn failed");
    return { ok: false, reason: "spawn_failed" };
  }

  if (!child.pid) {
    return { ok: false, reason: "spawn_failed" };
  }

  const deadlineAt = now + (deps.timeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS);
  const bootstrap: SiteBootstrap = {
    pid: child.pid,
    deadlineAt,
    reauth: opts.reauth,
    cdpPort,
  };
  writeSiteBootstrap(deps.db, opts.siteKey, bootstrap);
  logger.info(
    { siteKey: opts.siteKey, pid: bootstrap.pid, deadlineAt, reauth: opts.reauth },
    "site-bootstrap UI Chromium spawned",
  );
  return { ok: true, pid: bootstrap.pid, deadlineAt, cdpPort };
}

export type SiteBootstrapStatus =
  | { state: "idle" }
  | {
      state: "running";
      pid: number;
      deadlineAt: number;
      cdpPort: number;
      signedIn: false;
    }
  | {
      state: "running";
      pid: number;
      deadlineAt: number;
      cdpPort: number;
      signedIn: true;
      observedSelector: string;
      /** Account label observed by the live probe, if extractable.
       *  Surfaced to the dashboard so "Detected as Alice — click
       *  Finalize" can render before the user commits, instead of the
       *  user blindly clicking Finalize and only seeing the label
       *  afterwards (or the probe failing on the second pass and the
       *  user wasting the bootstrap window). Same trim/cap rules as
       *  `finalizeSiteBootstrap`'s persisted accountLabel. */
      accountLabel: string | null;
    };

export async function getSiteBootstrapStatus(
  deps: Pick<SiteBootstrapDeps, "db" | "paDataDir">,
  siteKey: string,
): Promise<SiteBootstrapStatus> {
  const bootstrap = readSiteBootstrap(deps.db, siteKey);
  if (!bootstrap) return { state: "idle" };
  const site = getSite(siteKey);
  if (!site) {
    // Stale row for a site that has been removed from the registry —
    // treat as idle so the dashboard can rebuild from scratch. The
    // disconnect path is responsible for cleaning the row.
    return { state: "idle" };
  }
  const probed = await probeAccountLabel(bootstrap.cdpPort, site);
  if (probed.signedIn) {
    return {
      state: "running",
      pid: bootstrap.pid,
      deadlineAt: bootstrap.deadlineAt,
      cdpPort: bootstrap.cdpPort,
      signedIn: true,
      observedSelector: site.signedInSelector,
      accountLabel: probed.accountLabel,
    };
  }
  return {
    state: "running",
    pid: bootstrap.pid,
    deadlineAt: bootstrap.deadlineAt,
    cdpPort: bootstrap.cdpPort,
    signedIn: false,
  };
}

export interface FinalizeSiteBootstrapResult {
  ok: boolean;
  reason?: "unknown_site" | "not_running" | "not_signed_in";
  accountLabel?: string | null;
}

/**
 * Finalize: probe once more, SIGTERM the UI window, persist the
 * connection record. The probe is repeated here even though the
 * dashboard already polled status — the user may have signed out
 * between the status poll and the finalize click, and the persistent
 * row would be a lie if we wrote it without re-verifying.
 */
export async function finalizeSiteBootstrap(
  deps: SiteBootstrapDeps,
  opts: { siteKey: string },
): Promise<FinalizeSiteBootstrapResult> {
  const site = getSite(opts.siteKey);
  if (!site) {
    return { ok: false, reason: "unknown_site" };
  }
  const bootstrap = readSiteBootstrap(deps.db, opts.siteKey);
  if (!bootstrap) {
    return { ok: false, reason: "not_running" };
  }
  const probed = await probeAccountLabel(bootstrap.cdpPort, site);
  if (!probed.signedIn) {
    return { ok: false, reason: "not_signed_in" };
  }
  await terminateBootstrap(deps, bootstrap, "graceful");
  clearSiteBootstrap(deps.db, opts.siteKey);
  const now = (deps.now ?? Date.now)();
  writeSiteConnection(deps.db, opts.siteKey, {
    schemaVersion: 1,
    connectedAt: now,
    accountLabel: probed.accountLabel,
    lastWorkflowAt: null,
  });
  logger.info(
    { siteKey: opts.siteKey, accountLabel: probed.accountLabel },
    "site bootstrap finalised",
  );
  return { ok: true, accountLabel: probed.accountLabel };
}

/**
 * Orphan reaper for an individual site. Invoked per-site by the
 * supervisor's enumeration sweep (see
 * `managed-chromium-supervisor.ts`).
 */
export async function reapStaleSiteBootstrap(
  deps: SiteBootstrapDeps,
  siteKey: string,
): Promise<{ reaped: boolean }> {
  const now = (deps.now ?? Date.now)();
  const bootstrap = readSiteBootstrap(deps.db, siteKey);
  if (!bootstrap) return { reaped: false };
  if (bootstrap.deadlineAt > now) return { reaped: false };
  await terminateBootstrap(deps, bootstrap, "force");
  clearSiteBootstrap(deps.db, siteKey);
  recordSiteBootstrapTimeoutAudit(deps.db, siteKey, bootstrap);
  logger.warn(
    { siteKey, pid: bootstrap.pid, deadlineAt: bootstrap.deadlineAt },
    "site bootstrap UI Chromium deadline exceeded; reaped",
  );
  return { reaped: true };
}

/**
 * User-initiated disconnect. SIGKILLs any UI window for this site
 * key, recursively removes the per-site profile dir, and clears both
 * runtime_state rows so a future Connect lands on a clean slate.
 */
export async function disconnectSite(
  deps: SiteBootstrapDeps,
  opts: { siteKey: string },
): Promise<void> {
  const bootstrap = readSiteBootstrap(deps.db, opts.siteKey);
  if (bootstrap) {
    await terminateBootstrap(deps, bootstrap, "force");
  }
  const profileDir = authProfileDir(deps.paDataDir, opts.siteKey);
  if (existsSync(profileDir)) {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(profileDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        { err, profileDir, siteKey: opts.siteKey },
        "failed to remove per-site profile dir",
      );
    }
  }
  clearSiteBootstrap(deps.db, opts.siteKey);
  clearSiteConnection(deps.db, opts.siteKey);
}

async function terminateBootstrap(
  deps: SiteBootstrapDeps,
  bootstrap: SiteBootstrap,
  mode: "graceful" | "force",
): Promise<void> {
  try {
    await deps.host.terminate(bootstrap.pid, mode);
  } catch {
    // pid already gone — nothing to do
  }
}

interface ProbeAccountLabelResult {
  signedIn: boolean;
  accountLabel: string | null;
}

async function probeAccountLabel(
  cdpPort: number,
  site: SiteDefinition,
): Promise<ProbeAccountLabelResult> {
  let chromiumApi: {
    connectOverCDP: (endpoint: string) => Promise<{
      newContext: () => Promise<unknown>;
      close: () => Promise<void>;
    }>;
  };
  try {
    const mod = (await import("playwright-core")) as {
      chromium: typeof chromiumApi;
    };
    chromiumApi = mod.chromium;
  } catch (err) {
    logger.error({ err }, "playwright-core dynamic import failed");
    return { signedIn: false, accountLabel: null };
  }

  const endpoint = `http://127.0.0.1:${cdpPort}`;
  let browser: { newContext: () => Promise<unknown>; close: () => Promise<void> };
  try {
    browser = await withTimeout(
      chromiumApi.connectOverCDP(endpoint),
      CDP_ATTACH_TIMEOUT_MS,
      "cdp connect timeout",
    );
  } catch (err) {
    logger.warn(
      { err, cdpPort, siteKey: site.siteKey },
      "CDP connect to site bootstrap window failed",
    );
    return { signedIn: false, accountLabel: null };
  }

  try {
    const context = (await browser.newContext()) as {
      newPage: () => Promise<unknown>;
      close: () => Promise<void>;
    };
    try {
      const page = (await context.newPage()) as {
        goto: (
          url: string,
          opts: { waitUntil: "domcontentloaded"; timeout: number },
        ) => Promise<unknown>;
        locator: (sel: string) => {
          first: () => {
            waitFor: (opts: {
              state: "visible";
              timeout: number;
            }) => Promise<unknown>;
            textContent: () => Promise<string | null>;
          };
        };
        close: () => Promise<void>;
      };
      try {
        await page.goto(site.profileVerifyUrl, {
          waitUntil: "domcontentloaded",
          timeout: PROBE_NAVIGATE_TIMEOUT_MS,
        });
        const locator = page.locator(site.signedInSelector).first();
        try {
          await locator.waitFor({ state: "visible", timeout: 2_500 });
        } catch {
          return { signedIn: false, accountLabel: null };
        }
        let accountLabel: string | null = null;
        try {
          const raw = await locator.textContent();
          if (raw) {
            // Clip whitespace + length so an attacker-shaped
            // account-link string cannot exfiltrate prose into the
            // persistent runtime_state row.
            accountLabel = raw.replace(/\s+/g, " ").trim().slice(0, 120) || null;
          }
        } catch {
          accountLabel = null;
        }
        return { signedIn: true, accountLabel };
      } finally {
        await page.close().catch(() => {});
      }
    } finally {
      await context.close().catch(() => {});
    }
  } catch (err) {
    logger.warn(
      { err, cdpPort, siteKey: site.siteKey },
      "site signed-in probe failed",
    );
    return { signedIn: false, accountLabel: null };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  marker: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(marker)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function pickFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      const address = server.address();
      if (typeof address === "object" && address && "port" in address) {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error("failed to read kernel-assigned port"));
      }
    });
  });
}

function recordSiteBootstrapTimeoutAudit(
  db: Database.Database,
  siteKey: string,
  bootstrap: SiteBootstrap,
): void {
  try {
    db.prepare(
      `INSERT INTO agent_actions
         (action_type, trigger, result, detail, completed_at, source_kind)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
    ).run(
      "browser_automation.site_bootstrap_timeout",
      "browser_lifecycle",
      "failed",
      JSON.stringify({
        siteKey,
        pid: bootstrap.pid,
        deadlineAt: bootstrap.deadlineAt,
        reauth: bootstrap.reauth,
      }),
      "cron",
    );
  } catch (err) {
    logger.warn(
      { err, siteKey },
      "failed to write site-bootstrap-timeout audit row",
    );
  }
}

