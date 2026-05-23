/**
 * Playwright `connectOverCDP` shim for Instance A.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §5.3, §8.2.
 *
 * The daemon owns Chromium's process lifecycle (`instance-a-launcher`).
 * Playwright drives the **already-running** browser via the DevTools
 * Protocol — so we use `chromium.connectOverCDP(endpoint)` rather than
 * Playwright's `chromium.launch()`, which would manage its own bundled
 * Chromium and skip our sandbox wrapping.
 *
 * Lifecycle binding:
 *   1. Launch Instance A → get `LaunchedInstanceA` handle.
 *   2. Connect Playwright over CDP at the handle's endpoint.
 *   3. Create a fresh `BrowserContext` for the workflow.
 *   4. Install the CDP route interception layer (`cdp-network-interception`)
 *      with the workflow's allowlist regex.
 *   5. Return a `ManagedPlaywrightHandle` whose `release()` closes the
 *      context, disconnects the Playwright browser, and tears down
 *      Instance A.
 *
 * Excluded from the 100% coverage gate — exercises `playwright-core`
 * (Anthropic SDK-shape mock-blocked by ESM) + the real Chromium process
 * over a TCP socket; matches the parent claude-code-core.ts exclusion
 * rationale.
 */

import { createLogger } from "../../../logging.js";
import {
  applyCDPInterception,
  type BlockedRequestRecorder,
  makeBlockedRequestRecorder,
} from "../automation/cdp-network-interception.js";
import { launchInstanceA, type LaunchedInstanceA } from "./instance-a-launcher.js";
import type Database from "better-sqlite3";
import type { HostProfile } from "../types.js";

const logger = createLogger("instance-a-cdp-connect");

export type AcquirePlaywrightContextOptions =
  | {
      db: Database.Database;
      host: HostProfile;
      paDataDir: string;
      workflowId: string;
      variant: "anon";
      /** Per-workflow positive selector (the workflow's `allowlistRegex`). */
      allowlistRegex: RegExp;
    }
  | {
      db: Database.Database;
      host: HostProfile;
      paDataDir: string;
      workflowId: string;
      variant: "auth";
      /** B-2.5 per-site identifier — selects the profile dir under
       *  `chromium-automation-auth/<siteKey>/` and threads through to
       *  the launcher so persistent cookies survive across runs. */
      siteKey: string;
      /** Per-workflow positive selector. The runner enforces that this
       *  is a subset of the site's `allowedHostPattern` before reaching
       *  the launcher. */
      allowlistRegex: RegExp;
    }
  | {
      db: Database.Database;
      host: HostProfile;
      paDataDir: string;
      workflowId: string;
      variant: "purchase";
      /** B-4 per-site identifier — selects the profile dir under
       *  `chromium-automation-purchase/<siteKey>/`. The cookies survive
       *  across runs (so the cart state populated by user/B-3 work
       *  persists), but the profile is strictly isolated from the
       *  auth-variant profile of the same `siteKey`. */
      siteKey: string;
      /** Per-workflow positive selector. The workflow declares this in
       *  its `allowlistRegex` (e.g. checkout-page subpath). */
      allowlistRegex: RegExp;
    };

/** Minimal CDP-side surface we need from playwright-core. Kept local so
 *  the daemon never pulls the full playwright-core type tree into its
 *  module graph (the runtime cost is paid by `acquirePlaywrightContext`
 *  via dynamic import). */
interface BrowserHandle {
  contexts: () => unknown[];
  newContext: () => Promise<unknown>;
  close: () => Promise<void>;
}

export interface ManagedPlaywrightHandle {
  /** Playwright `BrowserContext`. Workflow `run()` consumes via
   *  `playwrightContext.newPage()` / etc. Typed `unknown` so callers
   *  that don't need the strong type avoid a transitive playwright-core
   *  import. */
  context: unknown;
  /** Per-workflow blocked-request audit accumulator. Read at release-
   *  time to persist into `browser_automation_workflows.blocked_requests`. */
  blockedRequests: BlockedRequestRecorder;
  /** Idempotent teardown — closes context (anon-only — for auth/purchase
   *  the persistent default context is left in place so Chromium's own
   *  shutdown sequence flushes profile state to disk), disconnects
   *  Playwright, SIGTERMs Chromium, deletes anon profile dir. */
  release(): Promise<void>;
}

export type AcquirePlaywrightContextResult =
  | { ok: true; handle: ManagedPlaywrightHandle }
  | {
      ok: false;
      reason:
        | "missing_binary"
        | "missing_sandbox"
        | "spawn_failed"
        | "cdp_timeout"
        | "playwright_connect_failed";
    };

export async function acquirePlaywrightContext(
  opts: AcquirePlaywrightContextOptions,
): Promise<AcquirePlaywrightContextResult> {
  const launchResult = await launchInstanceA(
    opts.variant === "anon"
      ? {
          db: opts.db,
          host: opts.host,
          paDataDir: opts.paDataDir,
          workflowId: opts.workflowId,
          variant: "anon",
        }
      : opts.variant === "auth"
        ? {
            db: opts.db,
            host: opts.host,
            paDataDir: opts.paDataDir,
            workflowId: opts.workflowId,
            variant: "auth",
            siteKey: opts.siteKey,
          }
        : {
            db: opts.db,
            host: opts.host,
            paDataDir: opts.paDataDir,
            workflowId: opts.workflowId,
            variant: "purchase",
            siteKey: opts.siteKey,
          },
  );
  if (!launchResult.ok) {
    return { ok: false, reason: launchResult.reason };
  }
  const launched: LaunchedInstanceA = launchResult.handle;

  let chromiumApi: {
    connectOverCDP: (endpoint: string) => Promise<BrowserHandle>;
  };
  try {
    // Dynamic import keeps `playwright-core` off the daemon's eager
    // module graph — only workflow runs pay the cost. Also lets the
    // unit test layer stub the dynamic loader if it ever needs to.
    const mod = (await import("playwright-core")) as {
      chromium: typeof chromiumApi;
    };
    chromiumApi = mod.chromium;
  } catch (err) {
    logger.error({ err }, "playwright-core dynamic import failed");
    await launched.release();
    return { ok: false, reason: "playwright_connect_failed" };
  }

  let browser: BrowserHandle;
  try {
    browser = await chromiumApi.connectOverCDP(launched.cdpEndpoint);
  } catch (err) {
    logger.warn(
      { err, endpoint: launched.cdpEndpoint, workflowId: opts.workflowId },
      "playwright connectOverCDP failed",
    );
    await launched.release();
    return { ok: false, reason: "playwright_connect_failed" };
  }

  // anon: `newContext()` builds a fresh incognito-like context. Storage
  // state for the per-workflow profile dir is irrelevant — the dir is
  // deleted on release.
  //
  // auth/purchase: MUST attach to the persistent default context. When
  // Chromium spawns with `--user-data-dir=<per-site-dir>` the profile's
  // cookies / localStorage are loaded into the *default* BrowserContext,
  // not into a fresh one. `connectOverCDP` exposes that default via
  // `browser.contexts()[0]`. Calling `newContext()` here would silently
  // create an incognito context that does not see the cookies the user
  // planted during sign-in — breaking every auth-variant workflow
  // (getAmazonPurchaseHistory etc.) without surfacing an error.
  // See MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §16.4: "fresh
  // BrowserContext is created per workflow run so storage state from
  // the profile dir (cookies, localStorage) loads in" — the
  // implementation must use the persistent context to honour that
  // guarantee.
  let context: unknown;
  try {
    if (opts.variant === "anon") {
      context = await browser.newContext();
    } else {
      const existing = browser.contexts();
      if (existing.length === 0) {
        // A CDP-connected Chromium spawned with --user-data-dir always
        // exposes one default context. Zero contexts means the spawn
        // raced with a failure mode we did not anticipate; fail closed
        // rather than silently re-creating an empty context.
        logger.warn(
          { workflowId: opts.workflowId, variant: opts.variant },
          "no default browser context after CDP connect; refusing to fall back to newContext()",
        );
        await browser.close().catch(() => {});
        await launched.release();
        return { ok: false, reason: "playwright_connect_failed" };
      }
      context = existing[0];
    }
  } catch (err) {
    logger.warn(
      { err, workflowId: opts.workflowId, variant: opts.variant },
      "playwright context acquisition failed",
    );
    await browser.close().catch(() => {});
    await launched.release();
    return { ok: false, reason: "playwright_connect_failed" };
  }

  const recorder = makeBlockedRequestRecorder();
  try {
    await applyCDPInterception(context, {
      workflowId: opts.workflowId,
      allowlistRegex: opts.allowlistRegex,
      recorder,
    });
  } catch (err) {
    logger.warn(
      { err, workflowId: opts.workflowId },
      "CDP route interception install failed",
    );
    await (context as { close: () => Promise<void> }).close().catch(() => {});
    await browser.close().catch(() => {});
    await launched.release();
    return { ok: false, reason: "playwright_connect_failed" };
  }

  let released = false;
  const handle: ManagedPlaywrightHandle = {
    context,
    blockedRequests: recorder,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      if (opts.variant === "anon") {
        // For anon: close the per-workflow incognito context so any
        // pending request handlers detach cleanly. The dir gets nuked
        // shortly after, so storage flush doesn't matter.
        try {
          await (context as { close: () => Promise<void> }).close();
        } catch {
          // best-effort
        }
      }
      // For auth/purchase: do NOT call context.close() — the persistent
      // default context owns the profile dir; closing it before
      // browser.close() can race with Chromium's cookie/localStorage
      // flush. browser.close() shuts the whole instance down and
      // chrome flushes the profile during normal exit.
      await browser.close().catch(() => {});
      await launched.release();
    },
  };
  return { ok: true, handle };
}
