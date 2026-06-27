import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { PersonalAgentKeychainClient } from "./keychain-helper-client.js";
import { execWithStdin } from "./exec-with-stdin.js";

/**
 * Secret client backed by Windows DPAPI (Data Protection API).
 *
 * Secrets are encrypted using PowerShell's `ConvertTo-SecureString` /
 * `ConvertFrom-SecureString` which wraps DPAPI by default (when `-Key`
 * is omitted). Each secret is stored as a `.dpapi` file containing the
 * DPAPI-encrypted string.
 *
 * DPAPI properties:
 * - Uses the current Windows user's credentials as the encryption key
 * - Only the same user on the same machine can decrypt
 * - No additional installs required — built into PowerShell
 *
 * Security: All values are passed via stdin to avoid command injection.
 * The PowerShell script reads from `[System.Console]::In.ReadToEnd()`,
 * never from string interpolation in the script body.
 */
export class WindowsDpapiSecretClient implements PersonalAgentKeychainClient {
  private readonly secretsDir: string;
  private readonly psBinary: string;

  /**
   * @param secretsDir Override for `~/.personal-agent/secrets` (tests).
   * @param psBinary   PowerShell executable name. Defaults to
   *   `powershell.exe` (Windows PowerShell 5.1, ships with every modern
   *   Windows). The factory may pass `pwsh.exe` when 5.1 is unavailable
   *   (PowerShell-Core-only setups, Windows Server Core). Both expose the
   *   `ConvertTo-SecureString` / DPAPI surface this client relies on.
   */
  constructor(secretsDir?: string, psBinary?: string) {
    this.secretsDir = secretsDir ?? join(homedir(), ".personal-agent", "secrets");
    this.psBinary = psBinary ?? "powershell.exe";
    // Restrictive mode for parity with the POSIX file client. On Windows the
    // .dpapi files are already user-bound encrypted, so this is consistency
    // hardening rather than the primary control.
    mkdirSync(this.secretsDir, { recursive: true, mode: 0o700 });
  }

  private filePath(name: string): string {
    if (/[/\\]/.test(name)) {
      throw new Error(`Invalid secret name: ${name}`);
    }
    return join(this.secretsDir, `${name}.dpapi`);
  }

  async has(secretName: string): Promise<boolean> {
    return existsSync(this.filePath(secretName));
  }

  async get(secretName: string): Promise<string | null> {
    const path = this.filePath(secretName);
    if (!existsSync(path)) return null;

    const encrypted = readFileSync(path, "utf-8").trim();

    // DPAPI decrypt: ConvertTo-SecureString → Marshal to plaintext
    // Value is passed via stdin to avoid injection
    const script = [
      "$enc = [System.Console]::In.ReadToEnd().Trim()",
      "$ss = ConvertTo-SecureString $enc",
      "$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss)",
      "try { [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }",
      "finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }",
    ].join("; ");

    const { stdout } = await execWithStdin(
      this.psBinary,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      encrypted,
      { timeout: 10_000 },
    );
    return stdout.trimEnd();
  }

  async set(secretName: string, value: string): Promise<void> {
    // Validate early — filePath() checks path traversal but is called late
    const outPath = this.filePath(secretName);

    // DPAPI encrypt: stdin → SecureString → encrypted string
    const script = [
      "$plain = [System.Console]::In.ReadToEnd()",
      "$ss = ConvertTo-SecureString $plain -AsPlainText -Force",
      "ConvertFrom-SecureString $ss",
    ].join("; ");

    const { stdout } = await execWithStdin(
      this.psBinary,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      value,
      { timeout: 10_000 },
    );
    writeFileSync(outPath, stdout.trim(), "utf-8");
  }

  async delete(secretName: string): Promise<void> {
    const path = this.filePath(secretName);
    if (existsSync(path)) unlinkSync(path);
  }
}
