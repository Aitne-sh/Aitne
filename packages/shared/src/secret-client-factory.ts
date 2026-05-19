import { platform } from "node:os";
import { readFileSync, accessSync, constants } from "node:fs";
import { join, delimiter } from "node:path";
import type { PersonalAgentKeychainClient } from "./keychain-helper-client.js";

/**
 * Create a platform-appropriate secret client.
 *
 * Resolution order:
 * - macOS  → NativePersonalAgentKeychainClient (macOS Keychain)
 * - win32  → WindowsDpapiSecretClient (DPAPI)
 * - linux  → WSL? FileSecretClient : secret-tool available? LinuxSecretClient : FileSecretClient
 * - other  → FileSecretClient
 *
 * The FileSecretClient fallback requires a master password from
 * `PA_MASTER_PASSWORD` env or `~/.personal-agent/secrets/.master-key` file.
 * If neither is available, throws with setup instructions.
 */
export async function createSecretClient(): Promise<PersonalAgentKeychainClient> {
  const os = platform();

  switch (os) {
    case "darwin": {
      const { NativePersonalAgentKeychainClient } = await import("./keychain-helper-client.js");
      return new NativePersonalAgentKeychainClient();
    }

    case "win32": {
      const { WindowsDpapiSecretClient } = await import("./secret-client-windows.js");
      // Resolve the PowerShell binary once at startup. Windows PowerShell
      // 5.1 (`powershell.exe`) is preferred because it's the in-box choice
      // on every modern desktop SKU; PowerShell 7+ (`pwsh.exe`) is the
      // fallback for setups that ship pwsh-only (Windows Server Core,
      // PowerShell-Core-only installs). If neither is on PATH, leave the
      // default in place — the first DPAPI exec will surface a clear
      // ENOENT and the caller can install one.
      const psBinary = findExecutableInPath("powershell.exe")
        ? "powershell.exe"
        : findExecutableInPath("pwsh.exe")
          ? "pwsh.exe"
          : "powershell.exe";
      return new WindowsDpapiSecretClient(undefined, psBinary);
    }

    case "linux": {
      if (isWsl()) {
        return createFileClient();
      }
      if (findExecutableInPath("secret-tool")) {
        const { LinuxSecretClient } = await import("./secret-client-linux.js");
        return new LinuxSecretClient();
      }
      return createFileClient();
    }

    default:
      return createFileClient();
  }
}

async function createFileClient(): Promise<PersonalAgentKeychainClient> {
  const { FileSecretClient, resolveMasterPassword } = await import("./secret-client-file.js");
  const password = resolveMasterPassword();
  if (!password) {
    throw new Error(
      "No master password configured for the encrypted secret store. " +
      "Set PA_MASTER_PASSWORD environment variable or create " +
      "~/.personal-agent/secrets/.master-key file.",
    );
  }
  return await FileSecretClient.create(password);
}

/**
 * Detect Windows Subsystem for Linux.
 * WSL reports `process.platform === "linux"` but cannot use `secret-tool`
 * because D-Bus / GNOME Keyring are typically unavailable.
 *
 * The platform check is intentionally redundant with the `case "linux"`
 * caller above: `/proc/version` only exists on Linux, so calling this
 * helper from a darwin/win32 path would crash in the read. Keeping the
 * guard inline makes this safe to call from any future code site.
 */
function isWsl(): boolean {
  if (platform() !== "linux") return false;
  try {
    const version = readFileSync("/proc/version", "utf-8");
    return /microsoft|wsl/i.test(version);
  } catch {
    return false;
  }
}

/**
 * Lightweight executable finder (shared package cannot depend on daemon's cli-utils).
 * Checks PATH for the given command, respecting PATHEXT on Windows.
 */
function findExecutableInPath(command: string): boolean {
  const pathValue = process.env.PATH;
  if (!pathValue) return false;

  const extensions = platform() === "win32" && !/\.[A-Za-z0-9]+$/.test(command)
    ? (process.env.PATHEXT?.split(";").filter(Boolean) ?? [".exe", ".cmd", ".bat"])
    : [""];

  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      try {
        accessSync(join(dir, `${command}${ext}`), constants.X_OK);
        return true;
      } catch {
        // keep scanning
      }
    }
  }
  return false;
}
