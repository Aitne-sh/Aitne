/**
 * Cross-platform reader for the daemon's `apiToken` secret.
 *
 * CLI scripts (`run-now`, `remint-roadmap-ids`) need the daemon's apiToken to
 * call Approve-tier `/api/...` routes, but they intentionally must run WITHOUT
 * a successful `@aitne/shared` build (which only ships `./dist/*.js`). So this
 * helper re-implements the per-OS read inline, mirroring the secret clients in
 * `packages/shared/src/`:
 *
 *   - darwin → macOS Keychain via `security` (service com.personal-agent.secret.apiToken)
 *   - win32  → DPAPI: decrypt ~/.personal-agent/secrets/apiToken.dpapi via PowerShell
 *   - linux  → libsecret (`secret-tool lookup`), else the AES-256-GCM file store
 *   - WSL / other → the AES-256-GCM file store
 *
 * The file-store format/params and the DPAPI script are copied verbatim from
 * `secret-client-file.ts` / `secret-client-windows.ts` — keep them in sync if
 * those change. The secret clients hardcode `~/.personal-agent/secrets` (they
 * do NOT honor PA_DATA_DIR), so this helper uses the same homedir-relative
 * location to find what the daemon actually wrote.
 *
 * Returns the token string, or null when it cannot be read; the caller decides
 * how to message the failure. Best-effort: never throws (so a CLI never dies
 * with a raw stack trace on a misconfigured secret store).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createDecipheriv, scryptSync } from "node:crypto";

const SECRET_NAME = "apiToken";
const KEYCHAIN_SERVICE = "com.personal-agent.secret.apiToken";

function secretsDir() {
  return join(homedir(), ".personal-agent", "secrets");
}

/** @returns {string | null} the daemon apiToken, or null if unreadable. */
export function readApiToken() {
  const platform = process.platform;
  if (platform === "darwin") return readDarwin();
  if (platform === "win32") return readWindows();
  if (platform === "linux") {
    if (!isWsl() && whichSync("secret-tool")) {
      const fromKeyring = readSecretTool();
      if (fromKeyring) return fromKeyring;
    }
    return readFileStore();
  }
  return readFileStore();
}

function readDarwin() {
  // Byte-identical to the historical `security` read so macOS cannot regress.
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf-8" },
    ).trim();
  } catch {
    return null;
  }
}

/** Cross-platform `which`, returning the resolved path or null. */
function whichSync(cmd) {
  const tool = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(tool, [cmd], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
    return out.toString().split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}

function readWindows() {
  const path = join(secretsDir(), `${SECRET_NAME}.dpapi`);
  if (!existsSync(path)) return null;
  const encrypted = readFileSync(path, "utf-8").trim();
  // Prefer in-box Windows PowerShell 5.1, fall back to PowerShell 7+ (pwsh),
  // matching the daemon's secret-client-factory resolution order.
  const psBinary = whichSync("powershell.exe")
    ? "powershell.exe"
    : whichSync("pwsh.exe")
      ? "pwsh.exe"
      : "powershell.exe";
  // Mirrors WindowsDpapiSecretClient.get(): DPAPI-decrypt via
  // ConvertTo-SecureString and marshal back to plaintext. The ciphertext is
  // passed via stdin, never interpolated into the script, to avoid injection.
  const script = [
    "$enc = [System.Console]::In.ReadToEnd().Trim()",
    "$ss = ConvertTo-SecureString $enc",
    "$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss)",
    "try { [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }",
    "finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }",
  ].join("; ");
  try {
    const out = execFileSync(
      psBinary,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { input: encrypted, encoding: "utf-8", timeout: 10_000 },
    );
    return out.trimEnd() || null;
  } catch {
    return null;
  }
}

function readSecretTool() {
  try {
    const out = execFileSync(
      "secret-tool",
      ["lookup", "service", "personal-agent", "key", SECRET_NAME],
      { encoding: "utf-8", timeout: 5_000 },
    );
    return out.replace(/\n$/, "") || null;
  } catch {
    return null;
  }
}

/**
 * Detect WSL. WSL reports platform "linux" but cannot use `secret-tool`
 * (D-Bus / GNOME Keyring typically unavailable), so it uses the file store.
 */
function isWsl() {
  try {
    return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf-8"));
  } catch {
    return false;
  }
}

// ── AES-256-GCM file store (mirrors secret-client-file.ts) ────────────────
const FILE_ALGORITHM = "aes-256-gcm";
const FILE_KEY_LENGTH = 32; // 256 bits
const FILE_SCRYPT = { N: 16384, r: 8, p: 1 };

/** Resolve the file-store master password (env, then key file); null if none. */
function resolveMasterPassword() {
  if (process.env.PA_MASTER_PASSWORD) return process.env.PA_MASTER_PASSWORD;
  const keyFilePath = join(secretsDir(), ".master-key");
  if (!existsSync(keyFilePath)) return null;
  // Refuse to read a key file with insecure permissions (mirrors the daemon's
  // 0600/0400 gate); degrade to null rather than risk exposing it.
  const mode = statSync(keyFilePath).mode & 0o777;
  if (mode !== 0o600 && mode !== 0o400) return null;
  return readFileSync(keyFilePath, "utf-8").trim();
}

function readFileStore() {
  const path = join(secretsDir(), `${SECRET_NAME}.enc`);
  if (!existsSync(path)) return null;
  try {
    const password = resolveMasterPassword();
    if (!password) return null;
    const stored = JSON.parse(readFileSync(path, "utf-8"));
    const salt = Buffer.from(stored.salt, "hex");
    const iv = Buffer.from(stored.iv, "hex");
    const authTag = Buffer.from(stored.authTag, "hex");
    const ciphertext = Buffer.from(stored.ciphertext, "hex");
    const key = scryptSync(password, salt, FILE_KEY_LENGTH, FILE_SCRYPT);
    const decipher = createDecipheriv(FILE_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf-8");
  } catch {
    return null;
  }
}
