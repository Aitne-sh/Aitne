import { accessSync, constants, existsSync } from "node:fs";
import { readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChromiumBrowserKey, HostProfile, SandboxPrimitive } from "../types.js";

const execFileAsync = promisify(execFile);

const CHROMIUM_METADATA: Record<
  ChromiumBrowserKey,
  {
    macApps: string[];
    linuxBins: string[];
    windowsBins: string[];
    macProfileRoots: string[];
    linuxProfileRoots: string[];
    windowsProfileRoots: string[];
  }
> = {
  chrome: {
    macApps: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    linuxBins: ["google-chrome", "google-chrome-stable", "chrome"],
    windowsBins: [
      "Google\\Chrome\\Application\\chrome.exe",
      "Google\\Chrome Beta\\Application\\chrome.exe",
    ],
    macProfileRoots: ["Library/Application Support/Google/Chrome"],
    linuxProfileRoots: [
      ".config/google-chrome",
      ".var/app/com.google.Chrome/config/google-chrome",
      "snap/google-chrome/current/.config/google-chrome",
    ],
    windowsProfileRoots: ["Google\\Chrome\\User Data"],
  },
  chromium: {
    macApps: ["/Applications/Chromium.app/Contents/MacOS/Chromium"],
    linuxBins: ["chromium", "chromium-browser"],
    windowsBins: ["Chromium\\User Data\\chrome.exe"],
    macProfileRoots: ["Library/Application Support/Chromium"],
    linuxProfileRoots: [
      ".config/chromium",
      ".var/app/org.chromium.Chromium/config/chromium",
      "snap/chromium/current/.config/chromium",
    ],
    windowsProfileRoots: ["Chromium\\User Data"],
  },
  edge: {
    macApps: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    linuxBins: ["microsoft-edge", "microsoft-edge-stable"],
    windowsBins: ["Microsoft\\Edge\\Application\\msedge.exe"],
    macProfileRoots: ["Library/Application Support/Microsoft Edge"],
    linuxProfileRoots: [".config/microsoft-edge", ".config/microsoft-edge-dev"],
    windowsProfileRoots: ["Microsoft\\Edge\\User Data"],
  },
  brave: {
    macApps: ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
    linuxBins: ["brave-browser", "brave", "brave-browser-stable"],
    windowsBins: ["BraveSoftware\\Brave-Browser\\Application\\brave.exe"],
    macProfileRoots: ["Library/Application Support/BraveSoftware/Brave-Browser"],
    linuxProfileRoots: [".config/BraveSoftware/Brave-Browser"],
    windowsProfileRoots: ["BraveSoftware\\Brave-Browser\\User Data"],
  },
  comet: {
    macApps: ["/Applications/Comet.app/Contents/MacOS/Comet"],
    linuxBins: ["comet", "perplexity-comet"],
    windowsBins: ["Perplexity Comet\\Application\\comet.exe"],
    macProfileRoots: ["Library/Application Support/Perplexity Comet"],
    linuxProfileRoots: [".config/Perplexity Comet", ".config/perplexity-comet"],
    windowsProfileRoots: ["Perplexity Comet\\User Data"],
  },
  atlas: {
    // OpenAI rebranded the macOS bundle to "ChatGPT Atlas.app" with a
    // matching binary name. Keep the legacy "Atlas.app" path as a fallback
    // for users still on a pre-rename build.
    macApps: [
      "/Applications/ChatGPT Atlas.app/Contents/MacOS/ChatGPT Atlas",
      "/Applications/Atlas.app/Contents/MacOS/Atlas",
    ],
    linuxBins: ["atlas"],
    windowsBins: ["OpenAI\\Atlas\\Application\\atlas.exe"],
    macProfileRoots: ["Library/Application Support/com.openai.atlas/browser-data/host"],
    linuxProfileRoots: [".config/openai-atlas/browser-data/host"],
    windowsProfileRoots: ["OpenAI\\Atlas\\User Data"],
  },
};

function readable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function firstExisting(paths: string[]): string | null {
  for (const path of paths) {
    if (existsSync(path)) return path;
  }
  return null;
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("sh", ["-lc", `command -v ${JSON.stringify(command)}`], {
      timeout: 1000,
    });
    return true;
  } catch {
    return false;
  }
}

function expandHome(relative: string): string {
  return join(homedir(), relative);
}

function windowsLocalAppData(): string {
  return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
}

function windowsExecutableCandidates(key: ChromiumBrowserKey): string[] {
  const roots = [
    process.env.PROGRAMFILES,
    process.env["PROGRAMFILES(X86)"],
    windowsLocalAppData(),
  ].filter((item): item is string => !!item);
  return CHROMIUM_METADATA[key].windowsBins.flatMap((suffix) =>
    roots.map((root) => join(root, suffix)),
  );
}

function windowsProfileCandidates(key: ChromiumBrowserKey): string[] {
  return CHROMIUM_METADATA[key].windowsProfileRoots.map((suffix) =>
    join(windowsLocalAppData(), suffix),
  );
}

function linuxProfileCandidates(key: ChromiumBrowserKey): string[] {
  const homeCandidates = CHROMIUM_METADATA[key].linuxProfileRoots.map(expandHome);
  if (isWsl()) {
    const user = process.env.USER ?? "";
    const windowsUserRoot = user
      ? `/mnt/c/Users/${user}/AppData/Local`
      : "/mnt/c/Users";
    if (key === "chrome") {
      homeCandidates.push(join(windowsUserRoot, "Google/Chrome/User Data"));
    }
    if (key === "edge") {
      homeCandidates.push(join(windowsUserRoot, "Microsoft/Edge/User Data"));
    }
    if (key === "brave") {
      homeCandidates.push(join(windowsUserRoot, "BraveSoftware/Brave-Browser/User Data"));
    }
  }
  return homeCandidates;
}

function isWsl(): boolean {
  try {
    const release = process.env.WSL_DISTRO_NAME ?? "";
    return release.length > 0;
  } catch {
    return false;
  }
}

/**
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §5.4 / §7.4 — per-OS sandbox
 * primitive resolution.
 *
 * macOS: `sandbox-exec -f <profile.sb>`. The `profilePath` is filled in
 *        by `managed-chromium/sandbox-install.ts` once the .sb asset is
 *        copied into PA_DATA_DIR. We return an empty string here and
 *        let the installer rewrite the field — keeps this resolver
 *        synchronous and free of PA_DATA_DIR coupling.
 *
 * Linux: `bwrap` (bubblewrap) is the primary primitive. Falls back to
 *        `systemd-run --user --scope --property=...` when bwrap is
 *        absent but systemd is present (common on Debian without
 *        bubblewrap). Returns `none` on minimal hosts; the bootstrap
 *        module refuses to start Instance S in that case unless the
 *        operator has explicitly opted into unsandboxed mode.
 *
 * Windows: AppContainer + Job Object via the bundled native helper
 *          (packages/daemon/native/win-appcontainer/). `profileName` is
 *          the AppContainer profile name the helper creates / re-uses.
 *
 * Detection on Linux uses a synchronous PATH probe (`access(X_OK)`),
 * not an exec — keeps the cost negligible and avoids spawning
 * subprocesses at boot.
 */
function resolveSandboxPrimitive(os: HostProfile["os"]): SandboxPrimitive {
  if (os === "darwin") {
    return { kind: "sandbox-exec", profilePath: "" };
  }
  if (os === "win32") {
    return { kind: "appcontainer-jobobject", profileName: "AitneChromium" };
  }
  return resolveLinuxSandboxPrimitive();
}

/**
 * Order: bwrap > systemd-run > none. bwrap has finer-grained namespace
 * isolation than systemd-run's transient-unit scope; both beat
 * unsandboxed, but neither is acceptable to silently substitute for
 * the other since the launcher emits different argv shapes per kind.
 */
function resolveLinuxSandboxPrimitive(): SandboxPrimitive {
  if (binaryOnPathSync("bwrap")) return { kind: "bubblewrap" };
  if (binaryOnPathSync("systemd-run")) return { kind: "systemd-run" };
  return { kind: "none" };
}

function binaryOnPathSync(name: string): boolean {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    try {
      const candidate = join(dir, name);
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      // not in this PATH entry — keep looking.
    }
  }
  return false;
}

/**
 * SingletonLock-based liveness probe. Chromium writes
 * `<userDataDir>/SingletonLock` as a symlink whose target encodes
 * `<host>-<pid>` for the owning process; the file is removed on clean
 * shutdown. This is the same mechanism Chromium uses to enforce single
 * instance, so reading it is the most direct check for "is this profile
 * in use".
 *
 * It is also the only check that catches a Chromium launched without an
 * explicit `--user-data-dir=` flag (Finder / Dock / Start-menu launches
 * inherit the platform default and omit the flag from argv), which the
 * ps-grep below would otherwise miss.
 *
 * Returns false on any error — missing file, regular-file lock used by
 * some Chromium forks, PID not parseable, or dead PID. Callers should
 * fall through to a process-table probe for those cases.
 */
export async function singletonLockHasLiveOwner(userDataDir: string): Promise<boolean> {
  let target: string;
  try {
    target = await readlink(join(userDataDir, "SingletonLock"));
  } catch {
    return false;
  }
  const match = /-(\d+)$/.exec(target);
  if (!match) return false;
  const pid = Number(match[1]);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isUnixProcessRunning(
  binaryPath: string,
  userDataDir: string,
): Promise<boolean> {
  // SingletonLock is definitive when present; preferred over ps-grep
  // because it does not depend on `--user-data-dir=` being present in
  // argv (it isn't, for user-double-clicked Chromium launches).
  if (await singletonLockHasLiveOwner(userDataDir)) return true;
  try {
    const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,command="], {
      timeout: 2000,
      maxBuffer: 2_000_000,
    });
    return stdout
      .split("\n")
      .some((line) =>
        line.includes(binaryPath)
        && line.includes(`--user-data-dir=${userDataDir}`),
      );
  } catch {
    return false;
  }
}

async function isWindowsProcessRunning(
  binaryPath: string,
  userDataDir: string,
): Promise<boolean> {
  const escapedBinary = binaryPath.replace(/'/g, "''");
  const escapedDir = userDataDir.replace(/'/g, "''");
  const command =
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${escapedBinary}*' -and $_.CommandLine -like '*--user-data-dir=${escapedDir}*' } | Select-Object -First 1`;
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      command,
    ], { timeout: 3000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export function createHostProfile(): HostProfile {
  const rawPlatform = process.platform;
  const os: HostProfile["os"] =
    rawPlatform === "darwin" || rawPlatform === "win32" ? rawPlatform : "linux";
  const hasDisplay =
    os === "linux"
      ? !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
      : true;

  return {
    os,
    hasDisplay,
    sandboxPrimitive: resolveSandboxPrimitive(os),
    browserBinaryFor(key) {
      if (os === "darwin") return firstExisting(CHROMIUM_METADATA[key].macApps);
      if (os === "win32") return firstExisting(windowsExecutableCandidates(key));
      const candidates = CHROMIUM_METADATA[key].linuxBins;
      for (const candidate of candidates) {
        // Absolute paths short-circuit existsSync.
        if (candidate.includes("/")) {
          if (existsSync(candidate)) return candidate;
          continue;
        }
        // Bare names: probe PATH synchronously. Returning the bare name is
        // sufficient — child_process.spawn resolves it via PATH at exec time
        // — but consumers (managed-chromium-supervisor's missing_binary
        // check, ps-matching in isProcessRunning) need a reliable null when
        // nothing is installed. The prior fallback (`candidates[0]`)
        // unconditionally returned the bare name and made `missing_binary`
        // unreachable on Linux.
        if (binaryOnPathSync(candidate)) return candidate;
      }
      return null;
    },
    profileRootFor(key) {
      return firstExisting(this.profileRootCandidatesFor(key));
    },
    profileRootCandidatesFor(key) {
      if (os === "darwin") {
        return CHROMIUM_METADATA[key].macProfileRoots.map(expandHome);
      }
      if (os === "win32") return windowsProfileCandidates(key);
      return linuxProfileCandidates(key);
    },
    async isProcessRunning(binaryPath, userDataDir) {
      if (os === "win32") return isWindowsProcessRunning(binaryPath, userDataDir);
      return isUnixProcessRunning(binaryPath, userDataDir);
    },
    async terminate(pid, mode) {
      try {
        process.kill(pid, mode === "force" ? "SIGKILL" : "SIGTERM");
      } catch {
        // Process already gone.
      }
    },
  };
}

export async function resolveLinuxBinaryFromPath(key: ChromiumBrowserKey): Promise<string | null> {
  for (const candidate of CHROMIUM_METADATA[key].linuxBins) {
    if (await commandExists(candidate)) return candidate;
  }
  return null;
}

export function pathIsReadable(path: string): boolean {
  return readable(path);
}
