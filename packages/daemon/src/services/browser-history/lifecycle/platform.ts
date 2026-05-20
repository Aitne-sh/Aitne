import { accessSync, constants, existsSync } from "node:fs";
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
    macApps: ["/Applications/Atlas.app/Contents/MacOS/Atlas"],
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

function resolveSandboxPrimitive(os: HostProfile["os"]): SandboxPrimitive {
  if (os === "darwin") {
    return { kind: "sandbox-exec", profilePath: "" };
  }
  if (os === "win32") {
    return { kind: "appcontainer-jobobject", profileName: "AitneChromium" };
  }
  return { kind: "none" };
}

async function isUnixProcessRunning(
  binaryPath: string,
  userDataDir: string,
): Promise<boolean> {
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
        // Keep this path synchronous for callers; only absolute binaries can
        // be returned synchronously. PATH binaries are launched by name below.
        if (candidate.includes("/") && existsSync(candidate)) return candidate;
      }
      return candidates[0] ?? null;
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
