import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const KEYCHAIN_ACCOUNT = "personal-agent";
const SERVICE_PREFIX = "com.personal-agent.secret";

export interface PersonalAgentKeychainClient {
  has(secretName: string): Promise<boolean>;
  get(secretName: string): Promise<string | null>;
  set(secretName: string, value: string): Promise<void>;
  delete(secretName: string): Promise<void>;
}

/**
 * Keychain client backed entirely by the macOS `security` CLI.
 *
 * All writes use `security add-generic-password -T /usr/bin/security`
 * which restricts read access to the security CLI itself. Other
 * applications running as the same macOS user cannot read these items
 * via the Keychain Services API (SecKeychainItemCopyData) — they will
 * hit an ACL denial.
 *
 * The daemon reads secrets via `security find-generic-password -w`,
 * which invokes `/usr/bin/security` — matching the `-T` entry. Agent
 * backends (Claude Code, Codex, Gemini CLI) are additionally blocked
 * from running `security` commands via the disallowedTools blocklist.
 *
 * This replaces the previous Swift helper approach which suffered from
 * macOS Keychain prompting on every binary recompilation (different
 * ad-hoc code signature → ACL mismatch → password dialog).
 */
export class NativePersonalAgentKeychainClient implements PersonalAgentKeychainClient {
  async has(secretName: string): Promise<boolean> {
    const service = `${SERVICE_PREFIX}.${secretName}`;
    try {
      // find-generic-password without -w only reads metadata (no decryption),
      // so it does not trigger ACL prompts.
      await execFileAsync("security", [
        "find-generic-password", "-s", service, "-a", KEYCHAIN_ACCOUNT,
      ], { encoding: "utf8", timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  async get(secretName: string): Promise<string | null> {
    const service = `${SERVICE_PREFIX}.${secretName}`;
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password", "-s", service, "-a", KEYCHAIN_ACCOUNT, "-w",
      ], { encoding: "utf8", timeout: 5_000 });
      // -w outputs the password followed by a newline
      return stdout.replace(/\n$/, "");
    } catch {
      return null;
    }
  }

  async set(secretName: string, value: string): Promise<void> {
    const service = `${SERVICE_PREFIX}.${secretName}`;
    // Split create vs. update. Passing `-T /usr/bin/security` together with
    // `-U` against an existing item triggers `SecKeychainItemSetAccess`,
    // which macOS treats as an ACL change requiring a user confirmation
    // dialog. A background daemon cannot answer that prompt: the write
    // fails with "User canceled the operation", the refreshed token is
    // silently dropped, and the next API call keeps using the stale value.
    //
    // `-T` is only meaningful on the first create, and `add-generic-password`
    // (no `-U`) fails cleanly if the item already exists, so:
    //   - item missing → create with `-T /usr/bin/security`; on a race,
    //     fall through to the update branch.
    //   - item present → `-U` password-only update, which leaves the ACL
    //     alone and never prompts.
    if (!(await this.has(secretName))) {
      try {
        await execFileAsync("security", [
          "add-generic-password",
          "-s", service,
          "-a", KEYCHAIN_ACCOUNT,
          "-w", value,
          "-T", "/usr/bin/security",
        ], { encoding: "utf8" });
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("already exists")) throw err;
        // fall through to the update path
      }
    }
    await execFileAsync("security", [
      "add-generic-password",
      "-U",
      "-s", service,
      "-a", KEYCHAIN_ACCOUNT,
      "-w", value,
    ], { encoding: "utf8" });
  }

  async delete(secretName: string): Promise<void> {
    const service = `${SERVICE_PREFIX}.${secretName}`;
    try {
      await execFileAsync("security", [
        "delete-generic-password", "-s", service, "-a", KEYCHAIN_ACCOUNT,
      ], { encoding: "utf8", timeout: 5_000 });
    } catch {
      // not found or inaccessible — treat as success
    }
  }
}
