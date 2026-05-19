/**
 * Static map of CLI install methods per backend and platform.
 *
 * The daemon detects the host platform and which package managers are
 * available, then returns the applicable methods to the dashboard so
 * the user can pick one.
 *
 * Method ordering matters — the first available method is auto-selected
 * in the UI, so recommended approaches should come first.
 *
 * ## Platform coverage
 *
 * | Backend     | macOS                    | Linux              | Windows            |
 * |-------------|--------------------------|--------------------|--------------------|
 * | Claude Code | native, brew cask, npm   | native, npm        | native (PS), npm   |
 * | Codex       | brew cask, npm           | npm                | npm                |
 * | Gemini CLI  | npm, brew formula        | npm, brew formula  | npm                |
 *
 * ## Constraints
 *
 * - `brew install --cask` is macOS-only — cask is not supported on Linuxbrew.
 * - `brew install <formula>` works on both macOS and Linux (Gemini CLI).
 * - `sudo`-based methods are excluded because the daemon runs non-interactively
 *   and cannot provide a password prompt (MacPorts, apt).
 * - WinGet is excluded because it often requires UAC elevation, which cannot
 *   be handled from a background daemon process. Instead, we offer a
 *   "copy command" approach via the manual fallback.
 */
import type { BackendId } from "@aitne/shared";
import { findExecutable } from "./cli-utils.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { accessSync, constants as fsConstants } from "node:fs";

export interface InstallMethod {
  /** Unique key for this method (e.g. "npm", "brew"). */
  id: string;
  /** Human-readable label shown in the UI. */
  label: string;
  /** The shell command to run. */
  command: string;
  /** The executable invoked (first word of command) — checked for availability. */
  executable: string;
  /** Whether the package manager executable is available on PATH. */
  available: boolean;
  /** Whether this is the officially recommended install method. */
  recommended: boolean;
  /** URL to the official install documentation for this backend. */
  docsUrl: string;
  /**
   * When true, the daemon should NOT attempt to run this command
   * automatically — it should be shown as a copyable command for
   * the user to run in their own terminal. This is used for methods
   * that require interactive input (e.g. UAC elevation, sudo).
   */
  manualOnly: boolean;
}

export interface BackendInstallInfo {
  /** The CLI binary name looked up on PATH. */
  cliCommand: string;
  /** Whether the CLI binary is currently installed. */
  installed: boolean;
  /** Available installation methods for the current platform. */
  methods: InstallMethod[];
  /** URL to the official install documentation for this backend. */
  docsUrl: string;
}

export interface InstallMethodsResponse {
  platform: NodeJS.Platform;
  backends: Record<BackendId, BackendInstallInfo>;
}

// ── Per-backend install definitions ────────────────────────────

interface MethodDef {
  id: string;
  label: string;
  command: string;
  executable: string;
  /** Platforms this method applies to. Empty = all platforms. */
  platforms: NodeJS.Platform[];
  /** Whether this is the officially recommended install method. */
  recommended: boolean;
  /** When true, shown as copy-paste only (not auto-runnable). */
  manualOnly: boolean;
}

const CLI_COMMANDS: Record<BackendId, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  opencode: "opencode",
};

const DOCS_URLS: Record<BackendId, string> = {
  claude: "https://docs.anthropic.com/en/docs/claude-code/setup",
  codex: "https://github.com/openai/codex",
  gemini: "https://github.com/google-gemini/gemini-cli",
  opencode: "https://opencode.ai/docs/",
};

/**
 * Install methods are ordered by recommendation priority — the first
 * available method is auto-selected in the dashboard UI.
 *
 * Design principles:
 * - Only include methods that can run non-interactively from a daemon
 *   (no sudo, no UAC, no interactive prompts).
 * - Methods requiring elevation are marked `manualOnly: true` and
 *   displayed as copyable commands rather than auto-run buttons.
 * - `brew install --cask` is macOS-only (Linuxbrew doesn't support cask).
 * - `brew install <formula>` works on both macOS and Linux.
 */
const METHOD_DEFS: Record<BackendId, MethodDef[]> = {
  claude: [
    // Native installer — officially recommended on macOS/Linux.
    {
      id: "native",
      label: "Native installer (recommended)",
      command: "curl -fsSL https://claude.ai/install.sh | bash",
      executable: "curl",
      platforms: ["darwin", "linux"],
      recommended: true,
      manualOnly: false,
    },
    // Homebrew cask — macOS only (cask is not supported on Linux).
    {
      id: "brew",
      label: "Homebrew",
      command: "brew install --cask claude-code",
      executable: "brew",
      platforms: ["darwin"],
      recommended: false,
      manualOnly: false,
    },
    // npm — cross-platform fallback. Officially deprecated for Claude
    // but still functional.
    {
      id: "npm",
      label: "npm (global)",
      command: "npm install -g @anthropic-ai/claude-code",
      executable: "npm",
      platforms: [],
      recommended: false,
      manualOnly: false,
    },
    // Windows — PowerShell native installer. Requires user to run in
    // their own terminal (irm | iex needs an interactive PS session).
    {
      id: "winget",
      label: "WinGet (run in terminal)",
      command: "winget install Anthropic.ClaudeCode",
      executable: "winget",
      platforms: ["win32"],
      recommended: true,
      manualOnly: true,
    },
  ],
  codex: [
    // Homebrew cask — macOS only.
    {
      id: "brew",
      label: "Homebrew (recommended)",
      command: "brew install --cask codex",
      executable: "brew",
      platforms: ["darwin"],
      recommended: true,
      manualOnly: false,
    },
    // npm — cross-platform.
    {
      id: "npm",
      label: "npm (global)",
      command: "npm install -g @openai/codex",
      executable: "npm",
      platforms: [],
      recommended: false,
      manualOnly: false,
    },
  ],
  gemini: [
    // npm — cross-platform, officially recommended.
    {
      id: "npm",
      label: "npm (global, recommended)",
      command: "npm install -g @google/gemini-cli",
      executable: "npm",
      platforms: [],
      recommended: true,
      manualOnly: false,
    },
    // Homebrew formula (NOT cask) — works on both macOS and Linux.
    {
      id: "brew",
      label: "Homebrew",
      command: "brew install gemini-cli",
      executable: "brew",
      platforms: ["darwin", "linux"],
      recommended: false,
      manualOnly: false,
    },
  ],
  opencode: [
    {
      id: "npm",
      label: "npm (global)",
      command: "npm install -g opencode-ai",
      executable: "npm",
      platforms: ["darwin", "linux", "win32"],
      recommended: true,
      manualOnly: false,
    },
    {
      id: "brew",
      label: "Homebrew",
      command: "brew install sst/tap/opencode",
      executable: "brew",
      platforms: ["darwin", "linux"],
      recommended: false,
      manualOnly: false,
    },
  ],
};

/**
 * Additional directories to scan when looking for CLI binaries that
 * may not be on the daemon's PATH (e.g. installed while daemon runs).
 *
 * The daemon inherits PATH from its parent process at startup. CLIs
 * installed after the daemon starts may land in directories that
 * weren't on PATH at boot. These common install locations are checked
 * as a supplement.
 */
function getSupplementalPaths(): string[] {
  const home = homedir();
  const paths: string[] = [];

  if (process.platform === "win32") {
    // npm global bin on Windows
    const appData = process.env.APPDATA;
    if (appData) paths.push(join(appData, "npm"));
    // Scoop
    paths.push(join(home, "scoop", "shims"));
  } else {
    // Common Unix install locations
    paths.push(join(home, ".local", "bin")); // Claude native installer
    paths.push("/usr/local/bin");
    paths.push("/opt/homebrew/bin"); // Apple Silicon Homebrew
    paths.push(join(home, ".npm-global", "bin")); // Custom npm prefix
  }

  return paths;
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Check if a specific CLI binary is on PATH (one-shot, no cache).
 *
 * Extends the standard PATH with common install locations so we
 * can detect CLIs installed while the daemon was already running.
 */
export function isCliInstalled(backendId: BackendId): boolean {
  const command = CLI_COMMANDS[backendId];
  // First try standard PATH
  if (findExecutable(command) !== null) return true;
  // Then try supplemental paths
  return findExecutableInDirs(command, getSupplementalPaths());
}

/** Get the CLI command name for a backend. */
export function getCliCommand(backendId: BackendId): string {
  return CLI_COMMANDS[backendId];
}

/**
 * Check if a command exists in a set of specific directories,
 * bypassing the standard PATH lookup.
 */
function findExecutableInDirs(command: string, dirs: string[]): boolean {
  const constants = fsConstants;
  const extensions = process.platform === "win32" && !/\.[A-Za-z0-9]+$/.test(command)
    ? (process.env.PATHEXT?.split(";").filter(Boolean) ?? [".exe", ".cmd", ".bat"])
    : [""];

  for (const dir of dirs) {
    for (const ext of extensions) {
      try {
        accessSync(join(dir, `${command}${ext}`), constants.X_OK);
        return true;
      } catch {
        // not found here, continue
      }
    }
  }
  return false;
}

/**
 * Build the full install-methods response for the current host.
 *
 * Filters methods by platform and probes each package manager
 * executable for availability.
 */
export function getInstallMethods(): InstallMethodsResponse {
  const platform = process.platform;
  // Cache executable availability within a single call to avoid
  // redundant PATH scans for the same executable (e.g. "npm").
  const execCache = new Map<string, boolean>();
  function isAvailable(executable: string): boolean {
    if (execCache.has(executable)) return execCache.get(executable)!;
    const available = findExecutable(executable) !== null;
    execCache.set(executable, available);
    return available;
  }

  const backends = {} as Record<BackendId, BackendInstallInfo>;
  for (const backendId of Object.keys(CLI_COMMANDS) as BackendId[]) {
    const cliCommand = CLI_COMMANDS[backendId];
    const installed = isCliInstalled(backendId);
    const defs = METHOD_DEFS[backendId];
    const docsUrl = DOCS_URLS[backendId];
    const methods: InstallMethod[] = defs
      .filter((d) => d.platforms.length === 0 || d.platforms.includes(platform))
      .map((d) => ({
        id: d.id,
        label: d.label,
        command: d.command,
        executable: d.executable,
        available: d.manualOnly || isAvailable(d.executable),
        recommended: d.recommended,
        docsUrl,
        manualOnly: d.manualOnly,
      }));

    backends[backendId] = { cliCommand, installed, methods, docsUrl };
  }

  return { platform, backends };
}

/**
 * Resolve the install command for a given backend + method id.
 * Returns null if the method is not found, not applicable to
 * the current platform, or is manual-only.
 */
export function resolveInstallCommand(
  backendId: BackendId,
  methodId: string,
): { command: string; executable: string; args: string[] } | null {
  const defs = METHOD_DEFS[backendId];
  const def = defs.find(
    (d) =>
      d.id === methodId &&
      (d.platforms.length === 0 || d.platforms.includes(process.platform)),
  );
  if (!def) return null;

  // Manual-only methods cannot be run by the daemon
  if (def.manualOnly) return null;

  // For piped commands like "curl ... | bash", use shell execution.
  // POSIX-only: Windows native shells (cmd.exe / PowerShell) don't accept
  // `sh -c`-style invocation, and the only piped recipe today (Anthropic's
  // installer) is platform-restricted to darwin/linux. Defensively bail
  // here too so a future METHOD_DEF added without a `platforms` filter
  // can't silently drop us into cmd.exe.
  if (def.command.includes("|")) {
    if (process.platform === "win32") return null;
    return {
      command: def.command,
      // `sh` (PATH lookup) is more portable than hardcoding `bash` for the
      // outer shell. The pipe target inside the command string still
      // requires whichever interpreter the recipe asks for (e.g. Anthropic's
      // installer ends with `| bash`), but that's the recipe's contract.
      executable: "sh",
      args: ["-c", def.command],
    };
  }

  const parts = def.command.split(" ");
  return {
    command: def.command,
    executable: parts[0],
    args: parts.slice(1),
  };
}
