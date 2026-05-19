import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runLineCommand } from "./cli-utils.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("claude-credentials-store");

/**
 * READ-ONLY Claude Code credentials store.
 *
 * Phase 0 of the auth health design confirmed that refresh_token rotates +
 * immediately invalidates on reuse, so the daemon must never write to the
 * Keychain or `.credentials.json`. This module exposes read helpers only —
 * see `docs/design/09-safety-cost.md` §9.5.1 and §9.5.3.
 *
 * Note: this store reads the bundle Claude CLI writes when the operator
 * runs `claude login` (the API-key fallback path). The `subscriptionType`
 * field below mirrors what Anthropic's CLI emits — Aitne does not consume
 * it for routing, but the schema accepts it so parsing doesn't fail when
 * the operator is on the CLI-login fallback. With `ANTHROPIC_API_KEY`
 * configured the SDK bypasses this bundle entirely.
 */

const ClaudeCredentialsBundleSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().nullable(),
  expiresAt: z.number().nullable(),
  scopes: z.array(z.string()).default([]),
  // Field name mirrors the upstream Claude CLI credentials format; Aitne
  // does not branch on its value (subscription tier never affects routing).
  subscriptionType: z.string().optional(),
  rateLimitTier: z.string().optional(),
});

export type ClaudeCredentialsBundle = z.infer<typeof ClaudeCredentialsBundleSchema>;

const KeychainRootSchema = z.object({
  claudeAiOauth: ClaudeCredentialsBundleSchema,
});

/** Telemetry hooks — all optional so the store is dependency-free by default. */
export interface ClaudeCredentialsTelemetry {
  recordSchemaParseFailure?(detail: string): void;
  recordKeychainReadFailed?(exitCode: number): void;
  recordCredentialsFileReadFailed?(code: string): void;
}

export interface ReadClaudeCredentialsOptions {
  telemetry?: ClaudeCredentialsTelemetry;
  /** Override for tests — defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Override for tests — Keychain read via `security` subprocess. */
  readKeychain?: (account: string) => Promise<KeychainReadResult>;
  /** Override for tests — plaintext `.credentials.json` reader. */
  readPlaintext?: (path: string) => string;
  /** Override for tests — used to resolve default Keychain accounts. */
  currentUsername?: string;
  /** Override for tests — used to locate `.credentials.json`. */
  credentialsFilePath?: string;
}

export interface KeychainReadResult {
  exitCode: number;
  payload: string;
}

export function getClaudeCredentialsFilePath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(configDir, ".credentials.json");
}

/**
 * Decode a Keychain payload. Current format is raw JSON; legacy entries
 * (written by older Claude Code versions) are hex-encoded, sometimes with
 * a leading 0x07 byte before the JSON fragment and trailing `mcpOAuth`
 * debris after the JSON closes. We support both on read.
 *
 * Legacy entries can contain MULTIPLE `{…}` fragments (the primary
 * `claudeAiOauth` object and trailing debris). The previous implementation
 * used `indexOf("{")` + `lastIndexOf("}")` which greedily swallowed the
 * debris and failed to parse. The current implementation walks braces
 * with a depth counter and returns the first balanced object — which is
 * always the `claudeAiOauth` payload we want.
 */
export function decodeKeychainPayload(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("Empty Claude keychain payload");
  }
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    const bytes = Buffer.from(trimmed, "hex");
    const text = bytes.toString("utf-8");
    const firstObject = extractFirstBalancedObject(text);
    if (firstObject !== null) {
      return JSON.parse(firstObject);
    }
  }
  throw new Error(
    `Unexpected Claude keychain payload format: ${trimmed.slice(0, 32)}...`,
  );
}

/**
 * Scan `text` for the first balanced `{…}` substring, respecting
 * JSON string literals (including escaped quotes) so that a `}` inside
 * a string value does not terminate the match early. Returns the
 * substring (inclusive of braces) or null if no balanced object is
 * found.
 */
function extractFirstBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

export function parseBundle(
  raw: unknown,
  telemetry?: ClaudeCredentialsTelemetry,
): ClaudeCredentialsBundle | null {
  const result = KeychainRootSchema.safeParse(raw);
  if (!result.success) {
    telemetry?.recordSchemaParseFailure?.(result.error.message);
    return null;
  }
  return result.data.claudeAiOauth;
}

/**
 * Keychain account candidates in priority order:
 *   1. Real username (current format)
 *   2. "unknown" (legacy entries from older Claude Code versions)
 */
export function getClaudeKeychainAccounts(username: string): string[] {
  if (username && username !== "unknown") {
    return [username, "unknown"];
  }
  return ["unknown"];
}

async function defaultReadKeychain(account: string): Promise<KeychainReadResult> {
  const result = await runLineCommand({
    command: "security",
    args: [
      "find-generic-password",
      "-s",
      "Claude Code-credentials",
      "-a",
      account,
      "-w",
    ],
    cwd: process.cwd(),
    timeoutMs: 5_000,
  });
  return {
    exitCode: result.exitCode ?? -1,
    payload: result.stdoutLines.join("").trim(),
  };
}

function defaultReadPlaintext(path: string): string {
  return readFileSync(path, "utf-8");
}

/**
 * Read the Claude Code OAuth bundle.
 *
 *   macOS           → Keychain (service `Claude Code-credentials`, account=username,
 *                      falling back to legacy account `unknown`), then plaintext file.
 *   Linux / Windows → plaintext `$CLAUDE_CONFIG_DIR/.credentials.json` only.
 *
 * Returns `null` when no readable credentials exist. Errors are caught and
 * reported via the optional telemetry hooks; this function never throws.
 */
export async function readClaudeCredentials(
  options: ReadClaudeCredentialsOptions = {},
): Promise<ClaudeCredentialsBundle | null> {
  const {
    telemetry,
    platform = process.platform,
    readKeychain = defaultReadKeychain,
    readPlaintext = defaultReadPlaintext,
    currentUsername = userInfo().username,
    credentialsFilePath = getClaudeCredentialsFilePath(),
  } = options;

  if (platform === "darwin") {
    for (const account of getClaudeKeychainAccounts(currentUsername)) {
      const fromKeychain = await readFromKeychain(account, readKeychain, telemetry);
      if (fromKeychain) {
        return fromKeychain;
      }
    }
  }
  return readFromPlaintext(credentialsFilePath, readPlaintext, telemetry);
}

async function readFromKeychain(
  account: string,
  readKeychain: (account: string) => Promise<KeychainReadResult>,
  telemetry: ClaudeCredentialsTelemetry | undefined,
): Promise<ClaudeCredentialsBundle | null> {
  // Phase 1: read the Keychain entry. Failures here are subprocess/ACL issues
  // — record under keychain_read_failed. Also log a warning so a broken
  // Keychain ACL leaves a diagnostic trail in the daemon logs instead of
  // silently returning null forever.
  let result: KeychainReadResult;
  try {
    result = await readKeychain(account);
  } catch (err) {
    logger.warn({ err, account }, "Claude keychain subprocess failed");
    telemetry?.recordKeychainReadFailed?.(-1);
    return null;
  }

  if (result.exitCode !== 0) {
    // exit 44 = entry not found (normal for the "unknown" fallback probe);
    // anything else is a real failure worth recording + logging.
    if (result.exitCode !== 44) {
      logger.warn(
        { exitCode: result.exitCode, account },
        "Claude keychain read returned non-zero exit",
      );
      telemetry?.recordKeychainReadFailed?.(result.exitCode);
    }
    return null;
  }
  if (!result.payload) {
    return null;
  }

  // Phase 2: decode + schema-validate the payload. Failures here are format
  // issues (raw bytes arrived, but they don't match what we expect) —
  // record under schema_parse_failed instead of keychain_read_failed.
  try {
    return parseBundle(decodeKeychainPayload(result.payload), telemetry);
  } catch (err) {
    logger.warn({ err, account }, "Claude keychain payload decode failed");
    telemetry?.recordSchemaParseFailure?.(
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

function readFromPlaintext(
  path: string,
  readPlaintext: (path: string) => string,
  telemetry: ClaudeCredentialsTelemetry | undefined,
): ClaudeCredentialsBundle | null {
  // Phase 1: file read. ENOENT is the normal "no file yet" signal and is
  // not recorded; other errno values are real file-read failures.
  let raw: string;
  try {
    raw = readPlaintext(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      telemetry?.recordCredentialsFileReadFailed?.(
        String(code ?? (err instanceof Error ? err.message : err)),
      );
    }
    return null;
  }

  // Phase 2: JSON + schema parse. These are format failures, not read
  // failures — record under schema_parse_failed.
  try {
    return parseBundle(JSON.parse(raw), telemetry);
  } catch (err) {
    logger.warn({ err, path }, "Claude credentials plaintext parse failed");
    telemetry?.recordSchemaParseFailure?.(
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
