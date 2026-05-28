import { spawn } from "node:child_process";
import { lstat, readlink, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserProfileCandidate, HostProfile } from "../types.js";
import { readSingletonLockOwnerPid } from "./platform.js";

const CHROMIUM_FLAGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-component-update",
  "--disable-features=AutofillServerCommunication,Translate,MediaRouter",
] as const;

// Sibling lock files Chromium writes alongside its profile root on Unix.
// On Windows the equivalent is a named mutex, which dies with the
// owning process — no on-disk cleanup needed.
const CHROMIUM_SINGLETON_FILES = [
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
] as const;

export function buildChromiumLaunchArgs(
  host: HostProfile,
  profile: BrowserProfileCandidate,
): string[] {
  const flags: string[] = [...CHROMIUM_FLAGS];
  if (host.os === "linux" && !host.hasDisplay) {
    flags.push("--headless=new");
  } else {
    flags.push("--no-startup-window");
  }
  flags.push(`--user-data-dir=${profile.userDataDir}`);
  flags.push(`--profile-directory=${profile.profileName}`);
  return flags;
}

/**
 * BROWSER_HISTORY_INTEGRATION_PLAN.md §7.4.5 — "SingletonLock orphaned"
 * recovery. Chromium writes `SingletonLock` as a symlink whose target
 * encodes `<host>-<pid>`. When the browser shuts down cleanly the
 * symlink is removed; a crash leaves it pointing at a dead pid and the
 * next launch silently no-ops (Chromium refuses to start when it sees
 * the file). The supervisor cannot recover from this without removing
 * the stale lock first.
 *
 * Implementation reads the symlink target and parses out the pid. If
 * the lock file is a regular file (some Chromium variants), it falls
 * through to the host's `isProcessRunning(binary, userDataDir)` probe;
 * an empty result means no owning process and the lock is removable.
 *
 * Windows has no on-disk lock here — Chromium uses a named mutex that
 * the OS cleans up automatically on process exit, so the function is a
 * no-op on win32.
 */
export async function cleanupStaleSingletonLock(
  host: HostProfile,
  profile: BrowserProfileCandidate,
): Promise<"none" | "no_owner" | "owned" | "removed"> {
  if (host.os === "win32") return "none";
  let staleOwner: number | null = null;
  let kind: "symlink" | "file" | null = null;
  try {
    const lockPath = join(profile.userDataDir, "SingletonLock");
    const linkStat = await lstat(lockPath).catch(() => null);
    if (!linkStat) return "none";
    // `lstat()` does NOT follow symlinks, so it resolves the
    // symlink/regular-file/missing distinction without chasing the
    // SingletonLock target — which is a fabricated `<host>-<pid>`
    // string that never points at a real path. A missing lock throws
    // ENOENT above and is the only "none" case.
    try {
      const target = await readlink(lockPath);
      kind = "symlink";
      // Symlink target is `<hostname>-<pid>`. The pid is the last
      // numeric segment after the final `-`.
      const match = /-(\d+)$/.exec(target);
      if (match) staleOwner = Number(match[1]);
    } catch {
      kind = "file";
    }
  } catch {
    return "none";
  }

  // If the symlink encoded a pid, check whether it's still alive. If we
  // fell through to the file branch, ask the host abstraction whether
  // any Chromium instance is currently bound to this profile.
  const binary = host.browserBinaryFor(profile.browser);
  const ownerAlive = await (async (): Promise<boolean> => {
    if (staleOwner !== null) {
      try {
        process.kill(staleOwner, 0);
        return true;
      } catch {
        return false;
      }
    }
    if (binary) {
      try {
        return await host.isProcessRunning(binary, profile.userDataDir);
      } catch {
        return false;
      }
    }
    return false;
  })();

  if (ownerAlive) return "owned";

  // No live owner — clean up the lock trio so the next launch succeeds.
  let removed = false;
  for (const name of CHROMIUM_SINGLETON_FILES) {
    try {
      await rm(join(profile.userDataDir, name), { force: true });
      removed = true;
    } catch {
      // Best-effort cleanup; carry on with the rest.
    }
  }
  return removed ? "removed" : (kind === null ? "none" : "no_owner");
}

export type LaunchChromiumResult =
  | { outcome: "missing_binary" }
  | { outcome: "already_running" }
  | { outcome: "launched"; pid: number };

export async function launchChromiumProfile(
  host: HostProfile,
  profile: BrowserProfileCandidate,
): Promise<LaunchChromiumResult> {
  const binary = host.browserBinaryFor(profile.browser);
  if (!binary) return { outcome: "missing_binary" };
  // Recover from a previous crash that left an orphan SingletonLock.
  // Without this Chromium silently refuses to start and the supervisor
  // would mark the browser `launch_failed_recently` forever.
  const lockState = await cleanupStaleSingletonLock(host, profile);
  if (lockState === "owned") {
    // A live Chromium instance already holds this profile (e.g. the
    // user opened it via Finder / Dock between the supervisor's pre-
    // launch health probe and this call). Spawning a second instance
    // would either no-op via process-singleton forwarding or exit
    // silently — neither advances the History mtime, so the supervisor
    // would then mis-flag the cycle as `sync_unresponsive`. Tell the
    // caller so it can treat this as "already running" and let the
    // next tick re-evaluate via `checkBrowserProfileHealth`.
    return { outcome: "already_running" };
  }
  const args = buildChromiumLaunchArgs(host, profile);
  const child = spawn(binary, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  // `child.pid` is undefined only when spawn fails synchronously — the
  // emitted `error` event surfaces that via the parent process; we
  // mirror it here as `missing_binary` so callers don't try to
  // terminate a phantom PID.
  if (typeof child.pid !== "number" || child.pid <= 0) {
    return { outcome: "missing_binary" };
  }
  return { outcome: "launched", pid: child.pid };
}

/**
 * Quit a Chromium instance that the supervisor spawned to flush
 * History — see `supervisor.ts:runProfileCycle` for the calling
 * context. Without this the daemon-launched Chrome lingers in the
 * user's dock indefinitely (macOS keeps the app resident after the
 * last window closes), and 24h later the supervisor starts emitting
 * `sync_unresponsive` events against it because no actual browsing
 * advances History's mtime.
 *
 * Ownership verification (what `ownership_changed` actually catches):
 * Just before signalling, we re-read SingletonLock. The check protects
 * the case where our spawned process exited and a *different* Chromium
 * — another daemon launch, an external script, etc. — has since taken
 * over the profile and rewritten the lock. We must not kill that
 * stranger. It does NOT catch the user-opens-Chrome-via-Dock race:
 * Chromium's process-singleton IPC forwards a second launch into the
 * existing owner without touching the lock target, so SingletonLock
 * still points to `spawnedPid` even when a user-initiated window has
 * just been attached to it. Mitigating that fully would require a
 * renderer-process count probe; the residual window is accepted as
 * narrow because the supervisor only spawns when the browser was
 * previously *not* running, so users who actively browse Chrome never
 * hit this path. See the supervisor caller comment for the policy
 * trade-off.
 *
 * Non-symlink locks: some Chromium forks write SingletonLock as a
 * regular file rather than a symlink, so the PID is not encoded in
 * the path. For those we fall back to `host.isProcessRunning` — a
 * weaker signal, but enough to confirm "some Chromium for this
 * profile is alive" before terminating the PID we spawned 60s ago.
 *
 * Returns:
 *   - `terminated` — SIGTERM (and possibly SIGKILL) was sent.
 *   - `ownership_changed` — SingletonLock target now encodes a PID
 *     other than `spawnedPid`; another process owns the profile, so
 *     we declined to signal.
 *   - `already_gone` — process is no longer alive, or no Chromium is
 *     bound to this profile any more (clean exit or external kill);
 *     nothing to do.
 *   - `failed` — verification or signalling threw unexpectedly. The
 *     supervisor logs but does not escalate; the next tick will
 *     re-evaluate via `checkBrowserProfileHealth`.
 */
export async function terminateLaunchedChromium(
  host: HostProfile,
  profile: BrowserProfileCandidate,
  spawnedPid: number,
  options: { gracefulTimeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<"terminated" | "ownership_changed" | "already_gone" | "failed"> {
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 5000;
  const pollIntervalMs = options.pollIntervalMs ?? 200;

  if (!isProcessAlive(spawnedPid)) return "already_gone";

  if (host.os === "win32") {
    // Windows uses a named mutex, not an on-disk lock — there is no
    // PID to parse. Fall back to the host-level userDataDir probe to
    // confirm at least *some* Chromium for this profile is alive
    // before sending the signal.
    const binary = host.browserBinaryFor(profile.browser);
    const ownerAlive = binary
      ? await host.isProcessRunning(binary, profile.userDataDir).catch(() => false)
      : false;
    if (!ownerAlive) return "already_gone";
  } else {
    const ownerPid = await readSingletonLockOwnerPid(profile.userDataDir);
    if (ownerPid !== null) {
      // Precise check — only kill if SingletonLock still encodes the
      // exact PID we spawned. A divergence means our spawn died and
      // something else took the profile; leave that process alone.
      if (ownerPid !== spawnedPid) return "ownership_changed";
    } else {
      // No parseable PID. Two sub-cases to distinguish so we do not
      // regress Chromium forks that use a regular-file lock:
      //   (a) lock path does not exist → process is gone, nothing
      //       to do (already_gone)
      //   (b) lock path is a regular file (some forks) → ownership
      //       can't be cross-checked precisely; verify a Chromium
      //       for this profile is alive via host.isProcessRunning
      //       and proceed with the weaker confidence
      const lockKind = await readSingletonLockKind(profile.userDataDir);
      if (lockKind === "missing") return "already_gone";
      const binary = host.browserBinaryFor(profile.browser);
      const ownerAlive = binary
        ? await host.isProcessRunning(binary, profile.userDataDir).catch(() => false)
        : false;
      if (!ownerAlive) return "already_gone";
    }
  }

  try {
    await host.terminate(spawnedPid, "graceful");
  } catch {
    // process.kill threw — usually because the PID exited between the
    // liveness probe above and the signal. Treat as success.
    return "terminated";
  }

  const deadline = Date.now() + gracefulTimeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(spawnedPid)) return "terminated";
    await sleep(pollIntervalMs);
  }

  // Graceful didn't take — escalate. Chromium very occasionally
  // ignores SIGTERM during a long shutdown step; SIGKILL guarantees
  // the dock entry is gone before the next tick.
  try {
    await host.terminate(spawnedPid, "force");
  } catch {
    return isProcessAlive(spawnedPid) ? "failed" : "terminated";
  }
  return isProcessAlive(spawnedPid) ? "failed" : "terminated";
}

async function readSingletonLockKind(
  userDataDir: string,
): Promise<"missing" | "symlink" | "file"> {
  try {
    const info = await lstat(join(userDataDir, "SingletonLock"));
    return info.isSymbolicLink() ? "symlink" : "file";
  } catch {
    return "missing";
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
