import { spawn } from "node:child_process";
import { readlink, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserProfileCandidate, HostProfile } from "../types.js";

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
    const linkStat = await stat(lockPath).catch(() => null);
    if (!linkStat) return "none";
    // `stat()` follows symlinks; an EEXISTS via `stat` confirms the
    // target is reachable. A dangling symlink will throw above and we
    // treat that as "no live owner" too.
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

export async function launchChromiumProfile(
  host: HostProfile,
  profile: BrowserProfileCandidate,
): Promise<"launched" | "missing_binary" | "already_running"> {
  const binary = host.browserBinaryFor(profile.browser);
  if (!binary) return "missing_binary";
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
    return "already_running";
  }
  const args = buildChromiumLaunchArgs(host, profile);
  const child = spawn(binary, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return "launched";
}
