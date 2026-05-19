import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PersonalAgentKeychainClient } from "./keychain-helper-client.js";
import { execWithStdin } from "./exec-with-stdin.js";

const execFileAsync = promisify(execFile);

/**
 * Secret client backed by libsecret (`secret-tool` CLI).
 *
 * Uses GNOME Keyring (or KWallet via the libsecret backend) to store
 * secrets in the user's login keyring. Requires `libsecret-tools`
 * (`secret-tool`) to be installed.
 *
 * Secrets are stored with attributes:
 *   service = "personal-agent"
 *   key     = <secretName>
 *
 * `secret-tool store` reads the value from stdin (not command args),
 * preventing the secret from appearing in process listings.
 * `secret-tool lookup` outputs the value to stdout.
 * Both use `execFileAsync` / `execWithStdin` with argument arrays —
 * no shell interpolation, injection-safe.
 */
export class LinuxSecretClient implements PersonalAgentKeychainClient {
  private validateName(secretName: string): void {
    if (/[/\\]/.test(secretName)) {
      throw new Error(`Invalid secret name: ${secretName}`);
    }
  }

  async has(secretName: string): Promise<boolean> {
    return (await this.get(secretName)) !== null;
  }

  async get(secretName: string): Promise<string | null> {
    this.validateName(secretName);
    try {
      const { stdout } = await execFileAsync("secret-tool", [
        "lookup", "service", "personal-agent", "key", secretName,
      ], { encoding: "utf8", timeout: 5_000 });
      return stdout.replace(/\n$/, "");
    } catch {
      return null;
    }
  }

  async set(secretName: string, value: string): Promise<void> {
    this.validateName(secretName);
    // secret-tool store reads the password from stdin
    await execWithStdin(
      "secret-tool",
      [
        "store", "--label", `PersonalAgent: ${secretName}`,
        "service", "personal-agent", "key", secretName,
      ],
      value,
      { timeout: 5_000 },
    );
  }

  async delete(secretName: string): Promise<void> {
    this.validateName(secretName);
    try {
      await execFileAsync("secret-tool", [
        "clear", "service", "personal-agent", "key", secretName,
      ], { encoding: "utf8", timeout: 5_000 });
    } catch {
      // not found — treat as success
    }
  }
}
