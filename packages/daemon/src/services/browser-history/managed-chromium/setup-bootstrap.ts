/**
 * Bootstrap (one-time interactive sign-in) for Instance S.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §7.3.
 *
 * Spawn a UI Chromium under the sandbox primitive, open Google's
 * sign-in URL, persist the PID + deadline into runtime_state. The
 * dashboard polls status until `Local State` reports a signed-in
 * username; finalize SIGTERMs the UI window and flips state to
 * `ready`. An orphan reaper sweeps past-deadline PIDs on every
 * supervisor tick so an abandoned bootstrap can't leak a UI Chromium
 * forever.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type Database from "better-sqlite3";

import {
  readManagedChromiumState,
  updateManagedChromiumState,
} from "../../../db/managed-chromium-state.js";
import { createLogger } from "../../../logging.js";
import type { HostProfile, SandboxPrimitive } from "../types.js";
import { extractSignedInUser } from "./reauth-detector.js";
import { launchUnderSandbox } from "./sandbox-launcher.js";
import { materialiseSandboxPrimitive } from "./sandbox-install.js";
import { buildBootstrapArgs, instanceSProfileDir } from "./supervisor-config.js";
import {
  DEFAULT_BOOTSTRAP_TIMEOUT_MS,
  type ManagedChromiumBootstrapState,
} from "./types.js";

const logger = createLogger("managed-chromium-bootstrap");

const GOOGLE_SIGN_IN_URL =
  "https://accounts.google.com/signin/v2/identifier?service=chromiumsync&flowName=GlifWebSignIn";

export interface BootstrapDeps {
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

export interface BootstrapStartResult {
  ok: boolean;
  pid: number | null;
  deadlineAt: number | null;
  reason?: "missing_binary" | "missing_sandbox" | "spawn_failed" | "already_running";
}

/**
 * Start a UI Chromium for interactive sign-in. Two modes:
 *   - `reauth=false`: assert the profile dir is empty (refuses if the
 *     dir already holds a signed-in profile, to avoid the
 *     "two-profiles-collide" failure mode).
 *   - `reauth=true`: re-uses the existing profile dir so Chromium can
 *     drive auto-sign-in / 2FA reprompt.
 */
export async function startBootstrap(
  deps: BootstrapDeps,
  opts: { reauth: boolean },
): Promise<BootstrapStartResult> {
  const now = (deps.now ?? Date.now)();
  const state = readManagedChromiumState(deps.db);
  if (state.bootstrap && state.bootstrap.deadlineAt > now) {
    return {
      ok: false,
      pid: state.bootstrap.pid,
      deadlineAt: state.bootstrap.deadlineAt,
      reason: "already_running",
    };
  }

  const binaryPath = deps.host.browserBinaryFor("chromium");
  if (!binaryPath) {
    updateManagedChromiumState(deps.db, (draft) => {
      draft.state = "missing_binary";
      draft.bootstrap = null;
    });
    return { ok: false, pid: null, deadlineAt: null, reason: "missing_binary" };
  }

  const sandboxKindOk =
    deps.host.sandboxPrimitive.kind !== "none" || state.unsandboxedOptIn;
  if (!sandboxKindOk) {
    updateManagedChromiumState(deps.db, (draft) => {
      draft.state = "missing_sandbox";
      draft.bootstrap = null;
    });
    return { ok: false, pid: null, deadlineAt: null, reason: "missing_sandbox" };
  }

  const profileDir = instanceSProfileDir(deps.paDataDir);
  await mkdir(profileDir, { recursive: true });

  if (!opts.reauth) {
    const signedIn = await isProfileSignedIn(profileDir);
    if (signedIn) {
      // Profile already populated — caller must explicitly reset.
      return {
        ok: false,
        pid: null,
        deadlineAt: null,
        reason: "already_running",
      };
    }
  }

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
    child = launcher(sandbox, {
      binary: binaryPath,
      args: buildBootstrapArgs(profileDir, GOOGLE_SIGN_IN_URL),
      writableBindings: [profileDir],
      readableBindings: [binaryPath],
      detached: true,
    }).child;
  } catch (err) {
    logger.error({ err }, "bootstrap UI spawn failed");
    return { ok: false, pid: null, deadlineAt: null, reason: "spawn_failed" };
  }

  if (!child.pid) {
    return { ok: false, pid: null, deadlineAt: null, reason: "spawn_failed" };
  }

  const deadlineAt = now + (deps.timeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS);
  const bootstrap: ManagedChromiumBootstrapState = {
    pid: child.pid,
    deadlineAt,
    reauth: opts.reauth,
  };

  updateManagedChromiumState(deps.db, (draft) => {
    draft.state = opts.reauth ? draft.state : "needs_setup";
    draft.bootstrap = bootstrap;
  });

  logger.info(
    { pid: bootstrap.pid, deadlineAt, reauth: opts.reauth },
    "bootstrap UI Chromium spawned",
  );
  return { ok: true, pid: bootstrap.pid, deadlineAt };
}

export type BootstrapStatus =
  | { state: "idle" }
  | { state: "running"; pid: number; deadlineAt: number; signedIn: false }
  | { state: "running"; pid: number; deadlineAt: number; signedIn: true; observedUser: string };

export async function getBootstrapStatus(
  deps: Pick<BootstrapDeps, "db" | "paDataDir">,
): Promise<BootstrapStatus> {
  const state = readManagedChromiumState(deps.db);
  if (!state.bootstrap) return { state: "idle" };
  const profileDir = instanceSProfileDir(deps.paDataDir);
  const observedUser = await readSignedInUser(profileDir);
  if (observedUser) {
    return {
      state: "running",
      pid: state.bootstrap.pid,
      deadlineAt: state.bootstrap.deadlineAt,
      signedIn: true,
      observedUser,
    };
  }
  return {
    state: "running",
    pid: state.bootstrap.pid,
    deadlineAt: state.bootstrap.deadlineAt,
    signedIn: false,
  };
}

export interface FinalizeBootstrapResult {
  ok: boolean;
  reason?: "not_running" | "not_signed_in";
  observedUser?: string;
}

/**
 * Finalize bootstrap: SIGTERM the UI Chromium, flip state to `ready`,
 * record the observed signed-in user. Caller (the API route) is
 * responsible for following up with supervisor re-registration so the
 * next tick picks up the new profile.
 */
export async function finalizeBootstrap(
  deps: BootstrapDeps,
): Promise<FinalizeBootstrapResult> {
  const state = readManagedChromiumState(deps.db);
  if (!state.bootstrap) {
    return { ok: false, reason: "not_running" };
  }
  const profileDir = instanceSProfileDir(deps.paDataDir);
  const observedUser = await readSignedInUser(profileDir);
  if (!observedUser) {
    return { ok: false, reason: "not_signed_in" };
  }
  await terminateBootstrap(deps, state.bootstrap, "graceful");
  updateManagedChromiumState(deps.db, (draft) => {
    draft.state = "ready";
    draft.signedInUser = observedUser;
    draft.bootstrap = null;
    draft.consecutiveFailures = 0;
    draft.pausedUntil = null;
  });
  logger.info({ observedUser }, "bootstrap finalised");
  return { ok: true, observedUser };
}

/**
 * Orphan reaper. Called from the supervisor's per-cycle hook. Looks at
 * `runtime_state.managed_chromium.bootstrap`; if `deadlineAt < now`
 * the orphan Chromium is SIGKILLed and state is reset to `needs_setup`
 * so the dashboard prompts the user to re-start.
 */
export async function reapStaleBootstrap(
  deps: BootstrapDeps,
): Promise<{ reaped: boolean }> {
  const now = (deps.now ?? Date.now)();
  const state = readManagedChromiumState(deps.db);
  if (!state.bootstrap) return { reaped: false };
  if (state.bootstrap.deadlineAt > now) return { reaped: false };
  await terminateBootstrap(deps, state.bootstrap, "force");
  updateManagedChromiumState(deps.db, (draft) => {
    draft.bootstrap = null;
    if (draft.state === "needs_setup" || draft.state === "needs_reauth") {
      // Leave state where it is; the user will retry via the dashboard.
      return draft;
    }
    draft.state = "needs_setup";
    return draft;
  });
  recordBootstrapTimeoutAudit(deps.db, state.bootstrap);
  logger.warn(
    { pid: state.bootstrap.pid, deadlineAt: state.bootstrap.deadlineAt },
    "bootstrap UI Chromium deadline exceeded; reaped",
  );
  return { reaped: true };
}

/**
 * User-initiated disconnect. SIGKILLs any running Chromium for this
 * profile and removes the profile dir. The caller (API route) deletes
 * the runtime_state row afterwards.
 *
 * Active termination is mandatory here, NOT delegated to the supervisor
 * — once the disconnect route flips `enabled=false`, the supervisor
 * exits its cycle early and would never reap a leaked headless instance.
 */
export async function disconnectInstanceS(deps: BootstrapDeps): Promise<void> {
  const profileDir = instanceSProfileDir(deps.paDataDir);
  const state = readManagedChromiumState(deps.db);
  if (state.bootstrap) {
    await terminateBootstrap(deps, state.bootstrap, "force");
  }
  const binaryPath = deps.host.browserBinaryFor("chromium");
  if (binaryPath) {
    try {
      await killManagedChromiumBackground(deps.host, binaryPath, deps.paDataDir);
    } catch (err) {
      logger.warn({ err }, "post-disconnect background-chromium kill failed");
    }
  }
  if (existsSync(profileDir)) {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(profileDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn({ err, profileDir }, "failed to remove chromium-sync profile dir");
    }
  }
}

/**
 * Find every Chromium process whose `--user-data-dir` points at the
 * managed `chromium-sync/` profile and SIGKILL it. Used by the
 * `/disconnect` and `/enable=false` paths so a leaked headless instance
 * cannot survive the supervisor's `enabled` short-circuit.
 *
 * Best-effort: shells out to `ps` (or PowerShell on Windows) and parses
 * matching PIDs. A missing tool or empty result is silent — there is
 * nothing to do.
 */
export async function killManagedChromiumBackground(
  host: HostProfile,
  binaryPath: string,
  paDataDir: string,
): Promise<void> {
  const profileDir = instanceSProfileDir(paDataDir);
  // The host abstraction only exposes a boolean check; we need the PIDs
  // themselves. Implement the PID enumeration inline rather than widening
  // the HostProfile contract for a single caller — keeps the surface
  // narrow and platform-specific code colocated with the other
  // managed-chromium lifecycle helpers.
  const pids = await findChromiumPidsByUserDataDir(binaryPath, profileDir);
  for (const pid of pids) {
    await host.terminate(pid, "force").catch(() => {});
  }
}

/**
 * Enumerate Chromium PIDs whose `--user-data-dir` arg matches
 * `userDataDir`. Exported so the B-4 boot-time orphan-purchase-Chromium
 * sweep (MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.3 "Daemon crash
 * during the 5-min window") can find every parked Chromium process
 * under `chromium-automation-purchase/<siteKey>/` without duplicating
 * the cross-platform `ps` / PowerShell shell-out logic.
 */
export async function findChromiumPidsByUserDataDir(
  binaryPath: string,
  userDataDir: string,
): Promise<number[]> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileP = promisify(execFile);
  const escapedDir = userDataDir.replace(/'/g, "''");
  if (process.platform === "win32") {
    const escapedBinary = binaryPath.replace(/'/g, "''");
    const cmd =
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${escapedBinary}*' -and $_.CommandLine -like '*--user-data-dir=${escapedDir}*' } | Select-Object -ExpandProperty ProcessId`;
    try {
      const { stdout } = await execFileP("powershell.exe", [
        "-NoProfile", "-Command", cmd,
      ], { timeout: 3000 });
      return stdout
        .split(/\r?\n/)
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    } catch {
      return [];
    }
  }
  try {
    const { stdout } = await execFileP("ps", ["-A", "-o", "pid=,command="], {
      timeout: 2000,
      maxBuffer: 2_000_000,
    });
    const pids: number[] = [];
    for (const line of stdout.split("\n")) {
      // ps line is `<pid>  <command-line>`; match by both the binary
      // and the explicit user-data-dir flag so we don't pick up an
      // unrelated Chromium pointed at a different profile.
      if (line.includes(binaryPath) && line.includes(`--user-data-dir=${userDataDir}`)) {
        const m = line.trim().match(/^(\d+)\s/);
        if (m) pids.push(Number.parseInt(m[1], 10));
      }
    }
    return pids;
  } catch {
    return [];
  }
}

/**
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.3 "Daemon crash during
 * the 5-min window" — purge orphaned A-purchase Chromium processes.
 *
 * After a daemon restart, the SQL-level sweep
 * (`sweepOrphanedConsumedPurchaseTokens` / `expireStalePurchaseTokens`)
 * marks the abandoned token rows cancelled, but if a previous daemon
 * process spawned an A-purchase Chromium (`detached: false`) that the
 * parent's death didn't reliably terminate — Chromium spawns its own
 * helper children, the OS may inherit the orphan, the user may have
 * `nohup`'d the daemon, the launcher could have been suspended — that
 * Chromium still holds an authenticated cart context and a CDP debug
 * port open to localhost. Plan §17.3 row 7 specifies SIGKILL on those.
 *
 * Implementation: enumerate every direct subdirectory of
 * `<PA_DATA_DIR>/chromium-automation-purchase/` (each is a `<siteKey>`),
 * resolve its absolute path, and ask
 * `findChromiumPidsByUserDataDir(binaryPath, dir)` for matching PIDs.
 * SIGKILL each via the host abstraction. Best-effort: a missing
 * directory, missing binary, or a `ps` shell-out failure is silent —
 * the next workflow run reads the same DB state and the next sweep
 * tick retries.
 *
 * Pure-ish: no DB writes; the SQL-level sweep is the source of truth
 * for the row state.
 */
export async function killOrphanedPurchaseChromium(
  host: HostProfile,
  paDataDir: string,
): Promise<{ killedPids: readonly number[] }> {
  const binaryPath = host.browserBinaryFor("chromium");
  if (!binaryPath) return { killedPids: [] };
  const { join } = await import("node:path");
  const { readdir } = await import("node:fs/promises");
  const purchaseRoot = join(paDataDir, "chromium-automation-purchase");
  let siteDirs: string[];
  try {
    const entries = await readdir(purchaseRoot, { withFileTypes: true });
    siteDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => join(purchaseRoot, e.name));
  } catch {
    // Directory missing — nothing to sweep.
    return { killedPids: [] };
  }
  const killed: number[] = [];
  for (const dir of siteDirs) {
    const pids = await findChromiumPidsByUserDataDir(binaryPath, dir);
    for (const pid of pids) {
      try {
        await host.terminate(pid, "force");
        killed.push(pid);
      } catch {
        // PID already gone — nothing to do.
      }
    }
  }
  if (killed.length > 0) {
    logger.warn(
      { killedPids: killed, purchaseRoot },
      "B-4 boot-time recovery: killed orphan A-purchase Chromium processes",
    );
  }
  return { killedPids: killed };
}

async function terminateBootstrap(
  deps: BootstrapDeps,
  bootstrap: ManagedChromiumBootstrapState,
  mode: "graceful" | "force",
): Promise<void> {
  try {
    await deps.host.terminate(bootstrap.pid, mode);
  } catch {
    // pid already gone — nothing to do
  }
}

async function isProfileSignedIn(profileDir: string): Promise<boolean> {
  if (!existsSync(profileDir)) return false;
  try {
    const entries = await readdir(profileDir);
    if (entries.length === 0) return false;
  } catch {
    return false;
  }
  const user = await readSignedInUser(profileDir);
  return user !== null;
}

async function readSignedInUser(profileDir: string): Promise<string | null> {
  const path = join(profileDir, "Local State");
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return extractSignedInUser(parsed);
  } catch {
    return null;
  }
}

function recordBootstrapTimeoutAudit(
  db: Database.Database,
  bootstrap: ManagedChromiumBootstrapState,
): void {
  try {
    db.prepare(
      `INSERT INTO agent_actions
         (action_type, trigger, result, detail, completed_at, source_kind)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
    ).run(
      "browser_history.bootstrap_timeout",
      "browser_lifecycle",
      "failed",
      JSON.stringify({ pid: bootstrap.pid, deadlineAt: bootstrap.deadlineAt, reauth: bootstrap.reauth }),
      "cron",
    );
  } catch (err) {
    logger.warn({ err }, "failed to write bootstrap-timeout audit row");
  }
}

export const __testing = {
  GOOGLE_SIGN_IN_URL,
  isProfileSignedIn,
  readSignedInUser,
};
