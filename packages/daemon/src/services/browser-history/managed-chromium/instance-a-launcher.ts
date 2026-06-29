/**
 * Instance A on-demand launcher.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §8.1.
 *
 * Cold-start every workflow at MVP. Per-workflow profile dirs are
 * incompatible with browser-process pooling (`--user-data-dir` is a
 * launch-time flag) and the failure-mode coupling argument in §8.1
 * makes pooling undesirable even with the cold-start latency cost.
 *
 * Flow:
 *   1. Pick a free loopback TCP port (kernel-assigned via a transient
 *      `net.Server.listen(0)`).
 *   2. Materialise the sandbox primitive (per-OS — handled by the
 *      shared `materialiseSandboxPrimitive` helper).
 *   3. Spawn Chromium with `--remote-debugging-port=<port>` under the
 *      sandbox primitive. Bindings:
 *        - readable: Chromium binary path
 *        - writable: per-workflow profile dir
 *   4. Poll `GET http://127.0.0.1:<port>/json/version` every 200 ms
 *      until CDP responds or the 5 s deadline elapses.
 *   5. Hand back a `LaunchedInstanceA` carrying the port + a release
 *      function that SIGTERMs (5 s grace) → SIGKILLs the Chromium PID
 *      and (for the anon variant) deletes the profile dir.
 *
 * Concurrency cap of 1 instance globally is enforced at the workflow
 * runner level — the runner takes a semaphore before calling this
 * launcher so two concurrent workflows do not race on profile-dir
 * creation.
 *
 * Excluded from the 100% coverage gate — every function in this module
 * touches a real subprocess, the network, or the filesystem; matches the
 * existing `chromium-launcher.ts` / `setup-bootstrap.ts` exclusion
 * rationale.
 */

import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import type Database from "better-sqlite3";

import { createLogger } from "../../../logging.js";
import type { HostProfile } from "../types.js";
import {
  anonProfileDir,
  authProfileDir,
  buildInstanceAAnonArgs,
  buildInstanceAAuthArgs,
  buildInstanceAPurchaseArgs,
  purchaseProfileDir,
} from "./instance-a-config.js";
import { launchUnderSandbox } from "./sandbox-launcher.js";
import { materialiseSandboxPrimitive } from "./sandbox-install.js";
import { chromiumBundleRoot } from "../lifecycle/platform.js";

const logger = createLogger("instance-a-launcher");

/** Hard ceiling on the spawn-to-CDP-ready window. Chromium under
 *  sandbox-exec / bwrap typically responds in ~1.5–2 s; 5 s is a
 *  generous slack for cold storage / lower-tier machines. */
const CDP_READY_TIMEOUT_MS = 5000;
const CDP_READY_POLL_INTERVAL_MS = 200;
const SIGTERM_GRACE_MS = 5000;

export type LaunchInstanceAOptions =
  | {
      db: Database.Database;
      host: HostProfile;
      paDataDir: string;
      workflowId: string;
      variant: "anon";
    }
  | {
      db: Database.Database;
      host: HostProfile;
      paDataDir: string;
      workflowId: string;
      variant: "auth";
      /** B-2.5 per-site profile dir identifier. */
      siteKey: string;
    }
  | {
      db: Database.Database;
      host: HostProfile;
      paDataDir: string;
      workflowId: string;
      variant: "purchase";
      /** B-4 per-site profile dir identifier. Strictly isolated from
       *  the auth profile of the same siteKey — different parent
       *  directory under PA_DATA_DIR. */
      siteKey: string;
    };

export interface LaunchedInstanceA {
  cdpPort: number;
  cdpEndpoint: string;
  /** Profile dir on disk — release() deletes it for anon variants
   *  and preserves it for auth (per-site cookies must persist across
   *  workflow runs). */
  profileDir: string;
  /** Tear down: close any sockets, SIGTERM Chromium. For the anon
   *  variant, also deletes the per-workflow profile dir. Idempotent. */
  release(): Promise<void>;
}

export type LaunchInstanceAResult =
  | { ok: true; handle: LaunchedInstanceA }
  | { ok: false; reason: "missing_binary" | "missing_sandbox" | "spawn_failed" | "cdp_timeout" };

export async function launchInstanceA(
  opts: LaunchInstanceAOptions,
): Promise<LaunchInstanceAResult> {
  const binaryPath = opts.host.browserBinaryFor("chromium");
  if (!binaryPath) {
    return { ok: false, reason: "missing_binary" };
  }
  if (opts.host.sandboxPrimitive.kind === "none") {
    // Mirror Instance S's gate — operator must explicitly opt-in to
    // unsandboxed via the dashboard's `enable` flow. The runner reads
    // the per-install opt-in flag and refuses to call this launcher
    // without it; this is the defence-in-depth refusal.
    return { ok: false, reason: "missing_sandbox" };
  }

  const profileDir =
    opts.variant === "anon"
      ? anonProfileDir(opts.paDataDir, opts.workflowId)
      : opts.variant === "auth"
        ? authProfileDir(opts.paDataDir, opts.siteKey)
        : purchaseProfileDir(opts.paDataDir, opts.siteKey);
  await mkdir(profileDir, { recursive: true });

  const cdpPort = await pickFreeLoopbackPort();
  const sandbox = await materialiseSandboxPrimitive(
    opts.host.sandboxPrimitive,
    {
      paDataDir: opts.paDataDir,
      binaryPath,
      userDataDir: profileDir,
    },
  );

  const args =
    opts.variant === "anon"
      ? buildInstanceAAnonArgs({
          paDataDir: opts.paDataDir,
          workflowId: opts.workflowId,
          cdpPort,
        })
      : opts.variant === "auth"
        ? buildInstanceAAuthArgs({
            paDataDir: opts.paDataDir,
            siteKey: opts.siteKey,
            cdpPort,
          })
        : buildInstanceAPurchaseArgs({
            paDataDir: opts.paDataDir,
            siteKey: opts.siteKey,
            cdpPort,
          });

  // On spawn / CDP failure, the anon path nukes the per-workflow
  // profile dir (it would only collect garbage otherwise). The auth
  // and purchase paths MUST NOT — the per-site cookies are the entire
  // reason the bootstrap dance exists; deleting them on a transient
  // spawn failure would silently invalidate the user's sign-in and
  // look like a re-auth requirement on the next workflow.
  const cleanupOnFailure = async (): Promise<void> => {
    if (opts.variant === "anon") {
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  let child;
  try {
    const result = launchUnderSandbox(sandbox, {
      binary: binaryPath,
      args,
      readableBindings: [chromiumBundleRoot(binaryPath)],
      writableBindings: [profileDir],
      detached: false,
    });
    child = result.child;
  } catch (err) {
    logger.error({ err, workflowId: opts.workflowId }, "Instance A spawn failed");
    await cleanupOnFailure();
    return { ok: false, reason: "spawn_failed" };
  }

  if (!child.pid) {
    await cleanupOnFailure();
    return { ok: false, reason: "spawn_failed" };
  }
  const pid = child.pid;

  const ready = await waitForCdpReady(`http://127.0.0.1:${cdpPort}`, CDP_READY_TIMEOUT_MS);
  if (!ready) {
    logger.warn({ pid, workflowId: opts.workflowId }, "Instance A CDP ready timeout");
    await opts.host.terminate(pid, "force").catch(() => {});
    await cleanupOnFailure();
    return { ok: false, reason: "cdp_timeout" };
  }

  let released = false;
  const handle: LaunchedInstanceA = {
    cdpPort,
    cdpEndpoint: `http://127.0.0.1:${cdpPort}`,
    profileDir,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        await opts.host.terminate(pid, "graceful");
        await delay(SIGTERM_GRACE_MS);
      } catch {
        // best-effort
      }
      await opts.host.terminate(pid, "force").catch(() => {});
      if (opts.variant === "anon") {
        await rm(profileDir, { recursive: true, force: true }).catch((err) => {
          logger.warn(
            { err, profileDir, workflowId: opts.workflowId },
            "Instance A anon profile cleanup failed (will retry at next launch)",
          );
        });
      }
    },
  };
  return { ok: true, handle };
}

/** Bind to port 0 on loopback, read back the kernel-assigned port,
 *  close. Has a small TOCTOU window before Chromium grabs the port —
 *  not exploitable from outside the loopback interface and the CDP
 *  layer would simply fail to start if a parallel process grabbed it
 *  in that window, which we surface as `cdp_timeout`. */
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

/** Poll `<endpoint>/json/version` until it responds with a 2xx or the
 *  deadline elapses. The CDP HTTP endpoint is available before the
 *  WebSocket upgrade, so a 2xx here is the canonical readiness signal. */
async function waitForCdpReady(
  endpoint: string,
  deadlineMs: number,
): Promise<boolean> {
  const deadlineAt = Date.now() + deadlineMs;
  while (Date.now() < deadlineAt) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 500).unref();
      const res = await fetch(`${endpoint}/json/version`, { signal: ac.signal });
      clearTimeout(timer);
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await delay(CDP_READY_POLL_INTERVAL_MS);
  }
  return false;
}
