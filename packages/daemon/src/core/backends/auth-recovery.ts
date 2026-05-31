import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync, mkdirSync, chmodSync, copyFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type Database from "better-sqlite3";
import type { BackendId } from "@aitne/shared";
import { redactSensitiveString } from "@aitne/shared";
import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import type { AuthCheckResult } from "../agent-core.js";
import type { AuthTelemetry, AuthCounterKey } from "./auth-telemetry.js";
import type { AuthHealthMonitor, AuthHealthNotifier } from "./auth-health-monitor.js";
import {
  FIRST_EXPIRED_CASE_SQL,
  writeAuthFailureDetail,
  writeAuthOkDetail,
} from "./auth-health-monitor.js";
import { findExecutable, killChildWithEscalation, runLineCommand } from "./cli-utils.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("auth-recovery");

// ──────────────────────────────────────────────────────────────────
// Telemetry counter keys for recovery lifecycle.
// ──────────────────────────────────────────────────────────────────

/** Recovery-specific counter keys — part of the AuthCounterKey union. */
export type RecoveryCounterKey = Extract<
  AuthCounterKey,
  "recovery_started" | "recovery_success" | "recovery_timeout" | "recovery_failed"
>;

// ──────────────────────────────────────────────────────────────────
// Codex device auth parsing — empirical regex from §4.0 verification
// ──────────────────────────────────────────────────────────────────

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;

/**
 * Device URL — static for the current Codex CLI, but validated anyway
 * so we detect changes early. `\S+` will also capture any future
 * query params without breaking the match.
 */
const CODEX_DEVICE_URL_RE = /https:\/\/auth\.openai\.com\/\S+/;

/**
 * User code format: 3-6 uppercase alphanumeric, hyphen, 3-6 uppercase
 * alphanumeric. Observed patterns: `D636-F13CP`, `D65V-KQVNP`.
 * The line is always indented with 3+ spaces in codex output.
 */
const CODEX_USER_CODE_RE = /^\s{2,}([A-Z0-9]{3,6}-[A-Z0-9]{3,6})\s*$/m;

/**
 * Expiry from the output text: "(expires in N minutes)".
 */
const CODEX_EXPIRES_RE = /expires in (\d+) minutes/;

/**
 * Parsed device-auth output from `codex login --device-auth`.
 */
export interface CodexDeviceAuthInfo {
  deviceUrl: string;
  userCode: string;
  expiresMinutes: number;
}

/**
 * Parse the stdout of `codex login --device-auth` into structured info.
 * Returns `null` if the output doesn't match the expected format.
 */
export function parseCodexDeviceAuthOutput(
  rawStdout: string,
): CodexDeviceAuthInfo | null {
  const clean = rawStdout.replace(ANSI_ESCAPE_RE, "");
  const urlMatch = clean.match(CODEX_DEVICE_URL_RE);
  const codeMatch = clean.match(CODEX_USER_CODE_RE);
  const expiresMatch = clean.match(CODEX_EXPIRES_RE);
  if (!urlMatch || !codeMatch) return null;
  return {
    deviceUrl: urlMatch[0],
    userCode: codeMatch[1],
    expiresMinutes: expiresMatch ? parseInt(expiresMatch[1], 10) : 15,
  };
}

// ──────────────────────────────────────────────────────────────────
// Claude auth login URL parsing — Phase 9 §8.1 empirical
// ──────────────────────────────────────────────────────────────────

/**
 * Regex to extract the OAuth URL from `claude auth login` stdout.
 * Output format (observed in Claude Code 2.1.104):
 *   Line 1: "Opening browser to sign in…"
 *   Line 2: "If the browser didn't open, visit: <URL>"
 */
const CLAUDE_AUTH_URL_RE = /visit:\s+(https:\/\/\S+)/;

/**
 * Parse the OAuth URL from `claude auth login` stdout.
 * Returns the URL string, or `null` if the output doesn't match.
 */
export function parseClaudeAuthLoginOutput(rawStdout: string): string | null {
  const clean = rawStdout.replace(ANSI_ESCAPE_RE, "");
  const match = clean.match(CLAUDE_AUTH_URL_RE);
  return match ? match[1] : null;
}

/** Default Claude recovery timeout in minutes. Browser OAuth is faster than device code. */
const CLAUDE_RECOVERY_TIMEOUT_MIN = 10;

// ──────────────────────────────────────────────────────────────────
// Gemini OAuth auth code parsing — per design §5.2 + §4.4
// ──────────────────────────────────────────────────────────────────

/**
 * Google OAuth authorization code regex.
 * Codes start with `4/` followed by URL-safe base64 chars (30+).
 * The design doc gates on `4/[01]` but Google may change the second
 * char, so we accept any char after `4/` to avoid false negatives.
 */
const GEMINI_AUTH_CODE_RE = /^(4\/[A-Za-z0-9_-]{30,})$/;

/**
 * Test whether a raw DM text looks like a Google OAuth authorization code.
 * Only returns a match when a Gemini recovery session is active — caller
 * must gate on `isRecoveryActive("gemini")` before calling this.
 */
export function parseGeminiAuthCode(text: string): string | null {
  const m = text.trim().match(GEMINI_AUTH_CODE_RE);
  return m ? m[1] : null;
}

/** Gemini OAuth scopes — must match what the CLI uses. */
const GEMINI_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

/** Redirect URI for Google's code relay page (user sees the code to copy). */
const GEMINI_REDIRECT_URI = "https://codeassist.google.com/authcode";

/** Default Gemini recovery timeout in minutes (Google's auth flow times out at 5 min). */
const GEMINI_RECOVERY_TIMEOUT_MIN = 5;

/** Gemini OAuth credentials file path. */
const GEMINI_OAUTH_CREDS_PATH = join(homedir(), ".gemini", "oauth_creds.json");

/** Encrypted storage env var — if set, we cannot write plaintext creds. */
const GEMINI_ENCRYPTED_STORAGE_ENV = "GEMINI_FORCE_ENCRYPTED_FILE_STORAGE";

/**
 * Extracted OAuth client credentials for Gemini.
 */
export interface GeminiOAuthCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Extract Gemini OAuth client credentials.
 *
 * Priority:
 * 1. Env vars PA_GEMINI_OAUTH_CLIENT_ID + PA_GEMINI_OAUTH_CLIENT_SECRET
 * 2. Runtime scan of @google/gemini-cli bundle chunks
 *
 * Returns null if credentials cannot be found.
 */
export function extractGeminiOAuthCredentials(): GeminiOAuthCredentials | null {
  // 1. Env var override (most reliable, recommended for production)
  const envId = process.env.PA_GEMINI_OAUTH_CLIENT_ID?.trim();
  const envSecret = process.env.PA_GEMINI_OAUTH_CLIENT_SECRET?.trim();
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret };
  }
  // M3 fix: warn if only one of the two env vars is set — likely a
  // configuration mistake that would silently fall through to bundle scan.
  if (envId || envSecret) {
    logger.warn(
      "Only one of PA_GEMINI_OAUTH_CLIENT_ID / PA_GEMINI_OAUTH_CLIENT_SECRET is set — " +
      "both are required. Falling back to CLI bundle scan.",
    );
  }

  // 2. Bundle scan — fragile across CLI versions but works as fallback
  return scanGeminiCliBundleCredentials();
}

/**
 * Scan the @google/gemini-cli bundle for embedded OAuth credentials.
 * The credentials are public (shipped in a npm package), not secrets.
 */
function scanGeminiCliBundleCredentials(): GeminiOAuthCredentials | null {
  try {
    // Find the gemini CLI installation
    const geminiPath = findExecutable("gemini");
    if (!geminiPath) return null;

    // Resolve symlink to get the actual installation path
    const realPath = realpathSync(geminiPath);
    // Walk up to find the package root: .../bundle/cli.js or .../bin/cli.js
    let pkgDir = dirname(realPath);
    for (let i = 0; i < 5; i++) {
      if (existsSync(join(pkgDir, "package.json"))) break;
      pkgDir = dirname(pkgDir);
    }
    const bundleDir = join(pkgDir, "bundle");
    if (!existsSync(bundleDir)) return null;

    // Scan chunk files for the known constant patterns
    const chunks = readdirSync(bundleDir).filter(
      (f) => f.startsWith("chunk-") && f.endsWith(".js"),
    );

    const clientIdRe = /var OAUTH_CLIENT_ID\s*=\s*"([^"]+)"/;
    const clientSecretRe = /var OAUTH_CLIENT_SECRET\s*=\s*"([^"]+)"/;

    for (const chunk of chunks) {
      const content = readFileSync(join(bundleDir, chunk), "utf-8");
      const idMatch = content.match(clientIdRe);
      const secretMatch = content.match(clientSecretRe);
      if (idMatch && secretMatch) {
        return { clientId: idMatch[1], clientSecret: secretMatch[1] };
      }
    }
  } catch (err) {
    logger.debug({ err }, "Failed to scan Gemini CLI bundle for OAuth credentials");
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────
// Active recovery session tracking
// ──────────────────────────────────────────────────────────────────

/** Structured reason for recovery completion — avoids fragile string matching (M6 fix). */
export type RecoveryReason = "success" | "verification_failed" | "killed" | "timeout" | "exit_error" | "exception";

export interface ActiveRecovery {
  backendId: BackendId;
  startedAt: Date;
  /** Device URL for user to visit (Codex) or OAuth URL (Gemini). */
  authUrl: string;
  /** User code to enter (Codex device auth). */
  userCode?: string;
  /** Minutes until the auth flow expires. */
  expiresMinutes: number;
  /**
   * Resolves when the recovery subprocess completes (success or failure).
   * Callers can `await` this to know when the flow is done.
   */
  completion: Promise<RecoveryResult>;
}

export interface RecoveryResult {
  ok: boolean;
  /** Structured reason — use this for telemetry/branching, not `detail`. */
  reason: RecoveryReason;
  /** Human-readable detail for logs/DM. */
  detail: string;
}

// ──────────────────────────────────────────────────────────────────
// AuthRecovery — manages interactive auth recovery subprocesses
// ──────────────────────────────────────────────────────────────────

/** Default recovery timeout in minutes (matches Codex `expires_in`). */
const DEFAULT_RECOVERY_TIMEOUT_MIN = 15;

export interface AuthRecoveryOptions {
  now?: () => Date;
  /** Claude recovery timeout in minutes (default 10 — browser OAuth is faster than device code). */
  claudeRecoveryTimeoutMin?: number;
  /** Codex recovery timeout in minutes (default 15 — matches OpenAI device code expires_in). */
  codexRecoveryTimeoutMin?: number;
  /** Gemini recovery timeout in minutes (default 5 — matches Google auth flow timeout). */
  geminiRecoveryTimeoutMin?: number;
}

export class AuthRecovery {
  private readonly activeRecoveries = new Map<BackendId, ActiveRecoveryInternal>();
  private readonly now: () => Date;
  private readonly claudeRecoveryTimeoutMin: number;
  private readonly codexRecoveryTimeoutMin: number;
  private readonly geminiRecoveryTimeoutMin: number;
  private shuttingDown = false;

  constructor(
    private readonly db: Database.Database,
    private readonly telemetry: AuthTelemetry,
    private readonly authHealthMonitor: AuthHealthMonitor,
    private readonly notifier: AuthHealthNotifier | undefined,
    options: AuthRecoveryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.claudeRecoveryTimeoutMin = options.claudeRecoveryTimeoutMin ?? CLAUDE_RECOVERY_TIMEOUT_MIN;
    this.codexRecoveryTimeoutMin = options.codexRecoveryTimeoutMin ?? DEFAULT_RECOVERY_TIMEOUT_MIN;
    this.geminiRecoveryTimeoutMin = options.geminiRecoveryTimeoutMin ?? GEMINI_RECOVERY_TIMEOUT_MIN;
  }

  /**
   * Get the active recovery session for a backend, or `undefined`.
   */
  getActiveRecovery(backendId: BackendId): ActiveRecovery | undefined {
    const internal = this.activeRecoveries.get(backendId);
    if (!internal) return undefined;
    return {
      backendId: internal.backendId,
      startedAt: internal.startedAt,
      authUrl: internal.authUrl,
      userCode: internal.userCode,
      expiresMinutes: internal.expiresMinutes,
      completion: internal.completion,
    };
  }

  /**
   * Check if a recovery is currently active for the given backend.
   */
  isRecoveryActive(backendId: BackendId): boolean {
    return this.activeRecoveries.has(backendId);
  }

  // ────────────────────────────────────────────────────────────
  // Codex device auth recovery (Phase 5 §4.1)
  // ────────────────────────────────────────────────────────────

  /**
   * Initiate Codex device auth recovery.
   *
   * Spawns `codex login --device-auth` as a subprocess, parses the
   * device URL and user code from stdout, writes `recovering` to DB,
   * and returns the device auth info for user presentation.
   *
   * The subprocess blocks until the user completes auth in the browser
   * or the code expires. On completion:
   *   - exit 0  → `persistCheckResult({ok:true})`, counter `recovery_success`
   *   - exit ≠0 → DB → `expired`, counter `recovery_timeout` or `recovery_failed`
   *   - SIGTERM → daemon shutdown cleanup
   *
   * **Notification policy (M1 fix)**: This method does NOT send a DM.
   * The caller (dispatcher / API route) is responsible for presenting
   * the returned URL/code to the user, avoiding double-notification.
   *
   * Throws if:
   *   - A recovery is already in progress for this backend
   *   - The Codex CLI is not installed
   *   - The subprocess fails to produce a device code within 10s
   */
  async initiateCodexDeviceAuth(): Promise<ActiveRecovery> {
    const backendId: BackendId = "codex";

    // Guard: concurrent recovery
    if (this.activeRecoveries.has(backendId)) {
      throw new Error(
        `Recovery already in progress for ${backendId}. Wait for it to complete or cancel.`,
      );
    }

    // Guard: CLI installed
    const cliPath = findExecutable("codex");
    if (!cliPath) {
      throw new Error("Codex CLI is not installed or not on PATH.");
    }

    // Guard: daemon shutting down
    if (this.shuttingDown) {
      throw new Error("Daemon is shutting down, cannot start recovery.");
    }

    // Windows npm installs resolve `codex`/`claude` to a .cmd/.bat shim that
    // spawn() cannot exec without a shell (ENOENT). POSIX resolves to
    // extensionless binaries, so the regex is false there and shell stays
    // false. When the shell IS used, Node hands the command line to cmd.exe
    // verbatim without auto-quoting, so a cliPath containing spaces
    // (`C:\Program Files\…`) must be double-quoted; the static args are safe
    // literals needing no quoting.
    const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(cliPath);
    // Spawn `codex login --device-auth`
    const child = spawn(useShell ? `"${cliPath}"` : cliPath, ["login", "--device-auth"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "dumb", NO_COLOR: "1" },
      shell: useShell,
    });

    // Parse device code from stdout (collected until first \n\n after code)
    const deviceInfo = await this.waitForDeviceCode(child);

    // Write `recovering` status to DB
    const nowIso = this.now().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE backends
              SET auth_status = 'recovering',
                  auth_checked_at = @now,
                  auth_last_verified_at = @now,
                  updated_at = @now
            WHERE id = @id`,
        )
        .run({ now: nowIso, id: backendId });
      writeAuthOkDetail(
        this.db,
        backendId,
        `Device auth in progress — code ${deviceInfo.userCode}`,
      );
    })();

    // Telemetry
    this.incrementRecovery(backendId, "recovery_started");

    // Set up timeout
    const timeoutMs = this.codexRecoveryTimeoutMin * 60 * 1000;
    const timeoutHandle = setTimeout(() => {
      logger.info({ backendId }, "Recovery timeout — killing subprocess");
      killChildWithEscalation(child);
    }, timeoutMs);
    timeoutHandle.unref?.();

    // Build completion promise
    const completion = this.monitorCodexRecovery(child, backendId, timeoutHandle);

    const internal: ActiveRecoveryInternal = {
      backendId,
      startedAt: this.now(),
      authUrl: deviceInfo.deviceUrl,
      userCode: deviceInfo.userCode,
      expiresMinutes: deviceInfo.expiresMinutes,
      completion,
      child,
      timeoutHandle,
    };
    this.activeRecoveries.set(backendId, internal);

    return {
      backendId: internal.backendId,
      startedAt: internal.startedAt,
      authUrl: internal.authUrl,
      userCode: internal.userCode,
      expiresMinutes: internal.expiresMinutes,
      completion: internal.completion,
    };
  }

  // ────────────────────────────────────────────────────────────
  // Claude browser auth recovery (Phase 9 §8.2)
  // ────────────────────────────────────────────────────────────

  /**
   * Initiate Claude auth recovery via browser OAuth.
   *
   * Phase 9 empirical verification showed that `claude auth login` does
   * NOT require a PTY — pipe stdio works. The subprocess prints an OAuth
   * URL to stdout and blocks until the user completes browser auth:
   *
   *   1. Spawn `claude auth login --claudeai` with pipe stdio
   *   2. Parse OAuth URL from stdout
   *   3. Present URL to user (caller's responsibility — M1 policy)
   *   4. Wait for process exit (exit 0 = success)
   *   5. Verify with `claude auth status --json`
   *
   * Structurally identical to Codex device auth (Phase 5).
   *
   * **BROWSER=echo**: Suppresses the daemon from opening a browser in the
   * user's session. The URL is always printed to stdout regardless.
   */
  async initiateClaudeAuth(): Promise<ActiveRecovery> {
    const backendId: BackendId = "claude";

    if (this.activeRecoveries.has(backendId)) {
      throw new Error(
        `Recovery already in progress for ${backendId}. Wait for it to complete or cancel.`,
      );
    }

    const cliPath = findExecutable("claude");
    if (!cliPath) {
      throw new Error("Claude Code CLI is not installed or not on PATH.");
    }

    if (this.shuttingDown) {
      throw new Error("Daemon is shutting down, cannot start recovery.");
    }

    // See the device-auth spawn above: win32 .cmd/.bat shims need a shell;
    // when the shell is used the cliPath must be double-quoted for paths with
    // spaces, and POSIX stays shell:false on extensionless binaries.
    const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(cliPath);
    // Spawn with BROWSER=echo to suppress daemon-initiated browser launch
    const child = spawn(useShell ? `"${cliPath}"` : cliPath, ["auth", "login", "--claudeai"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "dumb", NO_COLOR: "1", BROWSER: "echo" },
      shell: useShell,
    });

    // Parse OAuth URL from stdout
    const authUrl = await this.waitForClaudeAuthUrl(child);

    // Write `recovering` status to DB
    const nowIso = this.now().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE backends
              SET auth_status = 'recovering',
                  auth_checked_at = @now,
                  auth_last_verified_at = @now,
                  updated_at = @now
            WHERE id = @id`,
        )
        .run({ now: nowIso, id: backendId });
      writeAuthOkDetail(
        this.db,
        backendId,
        "Browser OAuth recovery in progress",
      );
    })();

    this.incrementRecovery(backendId, "recovery_started");

    // Set up timeout
    const timeoutMs = this.claudeRecoveryTimeoutMin * 60 * 1000;
    const timeoutHandle = setTimeout(() => {
      logger.info({ backendId }, "Recovery timeout — killing subprocess");
      killChildWithEscalation(child);
    }, timeoutMs);
    timeoutHandle.unref?.();

    const completion = this.monitorClaudeRecovery(child, backendId, timeoutHandle);

    const internal: ActiveRecoveryInternal = {
      backendId,
      startedAt: this.now(),
      authUrl,
      expiresMinutes: this.claudeRecoveryTimeoutMin,
      completion,
      child,
      timeoutHandle,
    };
    this.activeRecoveries.set(backendId, internal);

    return {
      backendId: internal.backendId,
      startedAt: internal.startedAt,
      authUrl: internal.authUrl,
      expiresMinutes: internal.expiresMinutes,
      completion: internal.completion,
    };
  }

  // ────────────────────────────────────────────────────────────
  // Gemini OAuth recovery (Phase 6 §5.1)
  // ────────────────────────────────────────────────────────────

  /**
   * Initiate Gemini OAuth recovery using direct OAuth flow.
   *
   * Because the Gemini CLI requires a TTY for its auth flow (§5.0
   * empirical verification), we bypass the CLI and implement OAuth
   * directly using google-auth-library:
   *
   *   1. Extract client credentials from env vars or CLI bundle
   *   2. Generate PKCE-protected OAuth URL
   *   3. Present URL to user (caller's responsibility — M1 policy)
   *   4. Wait for user to send auth code via handleGeminiAuthCode()
   *   5. Exchange code for tokens → write oauth_creds.json
   *
   * **Encrypted storage rejection**: If GEMINI_FORCE_ENCRYPTED_FILE_STORAGE
   * is enabled, we cannot write plaintext oauth_creds.json and the recovery
   * is refused. The user must re-authenticate via the CLI directly.
   *
   * **Notification policy (M1 fix)**: This method does NOT send a DM.
   * The caller is responsible for presenting the URL.
   *
   * Throws if:
   *   - A recovery is already in progress for this backend
   *   - Encrypted storage mode is enabled
   *   - OAuth credentials cannot be extracted
   */
  async initiateGeminiAuth(): Promise<ActiveRecovery> {
    const backendId: BackendId = "gemini";

    // Guard: concurrent recovery
    if (this.activeRecoveries.has(backendId)) {
      throw new Error(
        `Recovery already in progress for ${backendId}. Wait for it to complete or cancel.`,
      );
    }

    // Guard: daemon shutting down
    if (this.shuttingDown) {
      throw new Error("Daemon is shutting down, cannot start recovery.");
    }

    // Guard: encrypted storage — we can only write plaintext oauth_creds.json
    if (process.env[GEMINI_ENCRYPTED_STORAGE_ENV] === "true") {
      throw new Error(
        "Gemini encrypted storage mode is enabled (GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true). " +
        "Cannot write plaintext OAuth credentials. Please re-authenticate via the Gemini CLI directly.",
      );
    }

    // Extract OAuth client credentials
    const credentials = extractGeminiOAuthCredentials();
    if (!credentials) {
      throw new Error(
        "Cannot extract Gemini OAuth credentials. " +
        "Set PA_GEMINI_OAUTH_CLIENT_ID and PA_GEMINI_OAUTH_CLIENT_SECRET env vars, " +
        "or ensure the Gemini CLI is installed.",
      );
    }

    // Create OAuth2 client and generate PKCE auth URL
    const oauthClient = new OAuth2Client({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    });

    const codeVerifierResult = await oauthClient.generateCodeVerifierAsync();
    const authUrl = oauthClient.generateAuthUrl({
      redirect_uri: GEMINI_REDIRECT_URI,
      access_type: "offline",
      scope: GEMINI_OAUTH_SCOPES,
      code_challenge_method: CodeChallengeMethod.S256,
      code_challenge: codeVerifierResult.codeChallenge,
    });

    // Write `recovering` status to DB
    const nowIso = this.now().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE backends
              SET auth_status = 'recovering',
                  auth_checked_at = @now,
                  auth_last_verified_at = @now,
                  updated_at = @now
            WHERE id = @id`,
        )
        .run({ now: nowIso, id: backendId });
      writeAuthOkDetail(
        this.db,
        backendId,
        "OAuth recovery in progress — waiting for authorization code",
      );
    })();

    // Telemetry
    this.incrementRecovery(backendId, "recovery_started");

    // Set up timeout (Gemini's auth flow expires in ~5 min)
    const timeoutMs = this.geminiRecoveryTimeoutMin * 60 * 1000;

    // Build completion promise that resolves when auth code is received or timeout
    let resolveCompletion!: (result: RecoveryResult) => void;
    const completion = new Promise<RecoveryResult>((resolve) => {
      resolveCompletion = resolve;
    });

    const timeoutHandle = setTimeout(() => {
      logger.info({ backendId }, "Gemini recovery timeout — no auth code received");
      const result: RecoveryResult = {
        ok: false,
        reason: "timeout",
        detail: `OAuth recovery timed out after ${this.geminiRecoveryTimeoutMin} minutes — no authorization code received`,
      };
      // Apply the result (DB + telemetry + notification)
      this.applyRecoveryResult(backendId, result);
      resolveCompletion(result);
      this.activeRecoveries.delete(backendId);
    }, timeoutMs);
    timeoutHandle.unref?.();

    const internal: ActiveRecoveryInternal = {
      backendId,
      startedAt: this.now(),
      authUrl,
      expiresMinutes: this.geminiRecoveryTimeoutMin,
      completion,
      oauthClient,
      codeVerifier: codeVerifierResult.codeVerifier,
      resolveCompletion,
      timeoutHandle,
    };
    this.activeRecoveries.set(backendId, internal);

    return {
      backendId: internal.backendId,
      startedAt: internal.startedAt,
      authUrl: internal.authUrl,
      expiresMinutes: internal.expiresMinutes,
      completion: internal.completion,
    };
  }

  /**
   * Handle a Google OAuth authorization code sent by the user.
   *
   * Called from the dispatcher (DM interception) or the API route
   * (POST /backends/gemini/recovery/code). Exchanges the code for
   * tokens, writes oauth_creds.json, verifies auth, and completes
   * the recovery.
   *
   * Returns the recovery result. Throws if no Gemini recovery is active.
   */
  async handleGeminiAuthCode(code: string): Promise<RecoveryResult> {
    const backendId: BackendId = "gemini";
    const internal = this.activeRecoveries.get(backendId);

    if (!internal || !internal.oauthClient || !internal.codeVerifier || !internal.resolveCompletion) {
      throw new Error("No active Gemini recovery session to receive an auth code.");
    }

    // Prevent timeout from firing after we start processing
    clearTimeout(internal.timeoutHandle);

    // B2 fix: backup existing oauth_creds.json before overwriting so we can
    // restore on failure (design doc §4.2 backup/restore pattern).
    const backedUp = backupGeminiOAuthCreds();

    let result: RecoveryResult;
    try {
      // Exchange auth code for tokens
      const { tokens } = await internal.oauthClient.getToken({
        code,
        codeVerifier: internal.codeVerifier,
        redirect_uri: GEMINI_REDIRECT_URI,
      });

      if (!tokens || !tokens.access_token) {
        result = {
          ok: false,
          reason: "verification_failed",
          detail: "Token exchange succeeded but no access_token returned",
        };
      } else {
        // Write tokens to oauth_creds.json (same format as Gemini CLI)
        writeGeminiOAuthCreds(tokens as unknown as Record<string, unknown>);

        // Verify the credentials contain a refresh_token
        const verified = await this.verifyGeminiAuth();
        if (verified) {
          // Success — remove backup
          removeGeminiOAuthCredsBackup();
          result = {
            ok: true,
            reason: "success",
            detail: "OAuth authentication completed successfully",
          };
        } else {
          // Verification failed — restore backup
          if (backedUp) restoreGeminiOAuthCreds();
          result = {
            ok: false,
            reason: "verification_failed",
            detail: "Token exchange succeeded but refresh_token missing — original credentials restored",
          };
        }
      }
    } catch (err) {
      // B3 fix: redact provider error messages before they reach DM / logs.
      const rawDetail = err instanceof Error ? err.message : "unknown error";
      const safeDetail = redactSensitiveString(rawDetail);
      // Restore backup on exchange failure
      if (backedUp) restoreGeminiOAuthCreds();
      result = {
        ok: false,
        reason: "exception",
        detail: `Failed to exchange authorization code: ${safeDetail}`,
      };
    }

    // Apply result (DB + telemetry + notification)
    this.applyRecoveryResult(backendId, result);
    internal.resolveCompletion(result);
    internal.resolveCompletion = undefined;
    this.activeRecoveries.delete(backendId);

    return result;
  }

  /**
   * Post-auth verification: check that oauth_creds.json exists and
   * contains a refresh_token. Must match GeminiCliCore.checkAuthDetailed
   * semantics — access_token alone is insufficient because it expires
   * in ~1h and cannot be renewed without a refresh_token, causing the
   * next hourly probe to flag it as expired.
   */
  private async verifyGeminiAuth(): Promise<boolean> {
    try {
      if (!existsSync(GEMINI_OAUTH_CREDS_PATH)) return false;
      const raw = readFileSync(GEMINI_OAUTH_CREDS_PATH, "utf-8");
      const creds = JSON.parse(raw) as { refresh_token?: unknown };
      return typeof creds.refresh_token === "string" && creds.refresh_token.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Cancel an active recovery for a backend.
   *
   * Synchronously resets the DB row to `expired` so it is never left
   * stuck in `recovering` even if the subprocess close event arrives
   * late or never (B3 fix). The subprocess close handler may later
   * call applyRecoveryResult, but that is guarded by
   * `WHERE auth_status = 'recovering'` and will no-op.
   */
  cancelRecovery(backendId: BackendId): boolean {
    const internal = this.activeRecoveries.get(backendId);
    if (!internal) return false;

    // Synchronously reset DB BEFORE killing — daemon might exit before
    // the close event arrives (B3).
    this.resetRecoveringToExpired(backendId, "Recovery cancelled by user");

    this.killRecoveryProcess(internal);
    this.activeRecoveries.delete(backendId);
    return true;
  }

  /**
   * Graceful shutdown — kill all active recovery subprocesses.
   * Called from the daemon's SIGTERM handler.
   *
   * Synchronously resets DB rows so they are never stuck in `recovering`
   * across daemon restarts (reinforces reconcilePendingRecoveries).
   * Scans the DB in addition to the in-memory map for defense-in-depth
   * — if a recovery was started but the in-memory tracking diverged
   * (e.g. partial init failure), the DB scan catches it.
   */
  shutdown(): void {
    this.shuttingDown = true;
    // 1. Kill tracked subprocesses
    for (const internal of this.activeRecoveries.values()) {
      this.killRecoveryProcess(internal);
    }
    this.activeRecoveries.clear();
    // 2. Reset ALL recovering rows in DB (defense-in-depth)
    try {
      const ids = (this.db.prepare(
        "SELECT id FROM backends WHERE auth_status = 'recovering'",
      ).all() as Array<{ id: string }>).map((r) => r.id);
      for (const id of ids) {
        this.resetRecoveringToExpired(
          id as BackendId,
          "Recovery interrupted by daemon shutdown",
        );
      }
    } catch (err) {
      logger.warn({ err }, "shutdown: failed to reset recovering rows");
    }
  }

  // ────────────────────────────────────────────────────────────
  // Private helpers
  // ────────────────────────────────────────────────────────────

  /**
   * Wait for the device code output from `codex login --device-auth`.
   * Times out after 10 seconds if the expected output doesn't appear.
   */
  private waitForDeviceCode(
    child: ChildProcess,
  ): Promise<CodexDeviceAuthInfo> {
    return new Promise<CodexDeviceAuthInfo>((resolve, reject) => {
      let stdout = "";
      const PARSE_TIMEOUT_MS = 10_000;

      const timer = setTimeout(() => {
        cleanup();
        killChildWithEscalation(child);
        reject(
          new Error(
            "Codex device auth did not produce a device code within 10s. " +
            `Captured stdout: ${redactSensitiveString(stdout.slice(0, 200))}`,
          ),
        );
      }, PARSE_TIMEOUT_MS);
      timer.unref?.();

      const onData = (chunk: Buffer): void => {
        stdout += chunk.toString();
        const info = parseCodexDeviceAuthOutput(stdout);
        if (info) {
          cleanup();
          resolve(info);
        }
      };

      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };

      const onClose = (code: number | null): void => {
        cleanup();
        reject(
          new Error(
            `Codex login exited (code=${code}) before producing a device code.`,
          ),
        );
      };

      child.stdout?.on("data", onData);
      child.once("error", onError);
      child.once("close", onClose);

      function cleanup(): void {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.off("error", onError);
        child.off("close", onClose);
      }
    });
  }

  /**
   * Monitor the Codex recovery subprocess until it exits.
   *
   * B2 fix: after `waitForDeviceCode` resolves, the child may have
   * already exited (e.g. crash immediately after printing the code).
   * We check `child.exitCode !== null` before registering `once("close")`
   * and handle the already-exited case synchronously.
   */
  private async monitorCodexRecovery(
    child: ChildProcess,
    backendId: BackendId,
    timeoutHandle: ReturnType<typeof setTimeout>,
  ): Promise<RecoveryResult> {
    try {
      const result = await new Promise<RecoveryResult>((resolve) => {
        const handleClose = async (code: number | null, signal: NodeJS.Signals | null): Promise<void> => {
          clearTimeout(timeoutHandle);
          try {
            if (code === 0) {
              const verified = await this.verifyCodexAuth();
              if (verified) {
                resolve({ ok: true, reason: "success", detail: "Device auth completed successfully" });
              } else {
                resolve({ ok: false, reason: "verification_failed", detail: "Device auth process exited 0 but login status check failed" });
              }
            } else if (signal) {
              resolve({ ok: false, reason: "killed", detail: `Recovery process killed (signal=${signal})` });
            } else {
              resolve({ ok: false, reason: "exit_error", detail: `Device auth failed (exit code=${code})` });
            }
          } catch (err) {
            resolve({ ok: false, reason: "exception", detail: `Recovery verification failed: ${err instanceof Error ? err.message : "unknown"}` });
          }
        };

        // B2 fix: child may have already exited between waitForDeviceCode
        // resolve and this registration. Node sets child.exitCode
        // synchronously on exit before emitting "close".
        if (child.exitCode !== null) {
          void handleClose(child.exitCode, null);
        } else {
          child.once("close", (code, signal) => void handleClose(code, signal));
        }
      });

      this.applyRecoveryResult(backendId, result);
      return result;
    } finally {
      this.activeRecoveries.delete(backendId);
    }
  }

  /**
   * Post-auth verification: run `codex login status` and check exit code.
   */
  private async verifyCodexAuth(): Promise<boolean> {
    const cliPath = findExecutable("codex");
    if (!cliPath) return false;
    try {
      const result = await runLineCommand({
        command: cliPath,
        args: ["login", "status"],
        cwd: process.cwd(),
        timeoutMs: 10_000,
      });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  /**
   * Wait for the OAuth URL from `claude auth login` stdout.
   * Times out after 10 seconds if the expected output doesn't appear.
   */
  private waitForClaudeAuthUrl(child: ChildProcess): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let stdout = "";
      const PARSE_TIMEOUT_MS = 10_000;

      const timer = setTimeout(() => {
        cleanup();
        killChildWithEscalation(child);
        reject(
          new Error(
            "Claude auth login did not produce an OAuth URL within 10s. " +
            `Captured stdout: ${redactSensitiveString(stdout.slice(0, 200))}`,
          ),
        );
      }, PARSE_TIMEOUT_MS);
      timer.unref?.();

      const onData = (chunk: Buffer): void => {
        stdout += chunk.toString();
        const url = parseClaudeAuthLoginOutput(stdout);
        if (url) {
          cleanup();
          resolve(url);
        }
      };

      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };

      const onClose = (code: number | null): void => {
        cleanup();
        reject(
          new Error(
            `Claude auth login exited (code=${code}) before producing an OAuth URL.`,
          ),
        );
      };

      child.stdout?.on("data", onData);
      child.once("error", onError);
      child.once("close", onClose);

      function cleanup(): void {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.off("error", onError);
        child.off("close", onClose);
      }
    });
  }

  /**
   * Monitor the Claude recovery subprocess until it exits.
   * Mirrors monitorCodexRecovery — same B2 fix pattern.
   */
  private async monitorClaudeRecovery(
    child: ChildProcess,
    backendId: BackendId,
    timeoutHandle: ReturnType<typeof setTimeout>,
  ): Promise<RecoveryResult> {
    try {
      const result = await new Promise<RecoveryResult>((resolve) => {
        const handleClose = async (code: number | null, signal: NodeJS.Signals | null): Promise<void> => {
          clearTimeout(timeoutHandle);
          try {
            if (code === 0) {
              const verified = await this.verifyClaudeAuth();
              if (verified) {
                resolve({ ok: true, reason: "success", detail: "Browser auth completed successfully" });
              } else {
                resolve({ ok: false, reason: "verification_failed", detail: "Claude auth process exited 0 but auth status check failed" });
              }
            } else if (signal) {
              resolve({ ok: false, reason: "killed", detail: `Recovery process killed (signal=${signal})` });
            } else {
              resolve({ ok: false, reason: "exit_error", detail: `Claude auth failed (exit code=${code})` });
            }
          } catch (err) {
            resolve({ ok: false, reason: "exception", detail: `Recovery verification failed: ${err instanceof Error ? err.message : "unknown"}` });
          }
        };

        if (child.exitCode !== null) {
          void handleClose(child.exitCode, null);
        } else {
          child.once("close", (code, signal) => void handleClose(code, signal));
        }
      });

      this.applyRecoveryResult(backendId, result);
      return result;
    } finally {
      this.activeRecoveries.delete(backendId);
    }
  }

  /**
   * Post-auth verification: run `claude auth status --json` and check loggedIn.
   */
  private async verifyClaudeAuth(): Promise<boolean> {
    const cliPath = findExecutable("claude");
    if (!cliPath) return false;
    try {
      const result = await runLineCommand({
        command: cliPath,
        args: ["auth", "status", "--json"],
        cwd: process.cwd(),
        timeoutMs: 10_000,
      });
      if (result.exitCode !== 0) return false;
      const stdout = result.stdoutLines.join("");
      try {
        const parsed = JSON.parse(stdout);
        return parsed.loggedIn === true;
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }

  /**
   * Apply recovery result: update DB status and record telemetry.
   */
  private applyRecoveryResult(
    backendId: BackendId,
    result: RecoveryResult,
  ): void {
    try {
      if (result.ok) {
        // Persist success via AuthHealthMonitor — clears failure
        // bookkeeping, stamps auth_last_success_at, records self-heal.
        this.authHealthMonitor.persistCheckResult(backendId, {
          ok: true,
          status: "ok",
          method: "oauth",
          detail: result.detail,
        } as AuthCheckResult);

        this.incrementRecovery(backendId, "recovery_success");
        this.telemetry.recordSelfHealObserved(backendId, "reactive");

        logger.info({ backendId }, "Auth recovery succeeded");
      } else {
        // Write `expired` back — the recovering subprocess no longer
        // owns the row. Uses FIRST_EXPIRED_CASE_SQL so that
        // `auth_first_expired_at` is preserved from the pre-recovery
        // state (the ELSE/COALESCE branch handles `recovering` →
        // `expired`). The `WHERE auth_status = 'recovering'` guard
        // ensures we only touch rows we own — if cancelRecovery or
        // reconcilePendingRecoveries already reset the row, this is
        // a no-op (B1 fix: writeAuthFailureDetail is gated on changes).
        const nowIso = this.now().toISOString();
        let changes = 0;
        this.db.transaction(() => {
          const info = this.db
            .prepare(
              `UPDATE backends
                  SET auth_status = 'expired',
                      auth_checked_at = @now,
                      auth_last_verified_at = @now,
                      ${FIRST_EXPIRED_CASE_SQL},
                      updated_at = @now
                WHERE id = @id
                  AND auth_status = 'recovering'`,
            )
            .run({ now: nowIso, id: backendId });
          changes = Number(info.changes);
          // B1 fix: only write detail if the UPDATE actually matched.
          // If another path (cancelRecovery, reconcilePendingRecoveries)
          // already reset the row, we must not clobber their detail.
          if (changes > 0) {
            writeAuthFailureDetail(this.db, backendId, result.detail);
          }
        })();

        // M6 fix: use structured reason for counter attribution.
        const counterKey: RecoveryCounterKey =
          result.reason === "killed" || result.reason === "timeout"
            ? "recovery_timeout"
            : "recovery_failed";
        this.incrementRecovery(backendId, counterKey);

        logger.info({ backendId, detail: result.detail, reason: result.reason }, "Auth recovery failed");
      }
    } catch (err) {
      logger.warn(
        { err, backendId },
        "Failed to apply recovery result to DB",
      );
    }

    // Notify user of result (D2 fix: kind = "recovery")
    this.notifyRecoveryComplete(backendId, result).catch((err) => {
      logger.warn({ err, backendId }, "Failed to send recovery completion notification");
    });
  }

  /**
   * Synchronously reset a `recovering` row back to `expired`.
   * Used by cancelRecovery and shutdown (B3 fix) so the DB is never
   * left stuck even if the subprocess close event doesn't arrive.
   */
  private resetRecoveringToExpired(
    backendId: BackendId,
    detail: string,
  ): void {
    try {
      const nowIso = this.now().toISOString();
      this.db.transaction(() => {
        const info = this.db
          .prepare(
            `UPDATE backends
                SET auth_status = 'expired',
                    auth_checked_at = @now,
                    auth_last_verified_at = @now,
                    ${FIRST_EXPIRED_CASE_SQL},
                    updated_at = @now
              WHERE id = @id
                AND auth_status = 'recovering'`,
          )
          .run({ now: nowIso, id: backendId });
        if (Number(info.changes) > 0) {
          writeAuthFailureDetail(this.db, backendId, detail);
        }
      })();
    } catch (err) {
      logger.warn({ err, backendId }, "resetRecoveringToExpired: DB write failed");
    }
  }

  private killRecoveryProcess(internal: ActiveRecoveryInternal): void {
    clearTimeout(internal.timeoutHandle);
    if (internal.child) {
      killChildWithEscalation(internal.child);
    }
    // Gemini: reject the pending completion promise so callers aren't stuck
    if (internal.resolveCompletion) {
      internal.resolveCompletion({
        ok: false,
        reason: "killed",
        detail: "Recovery cancelled",
      });
      internal.resolveCompletion = undefined;
    }
  }

  /**
   * Notify the user that a recovery completed (D2 fix: kind = "recovery").
   */
  private async notifyRecoveryComplete(
    backendId: BackendId,
    result: RecoveryResult,
  ): Promise<void> {
    if (!this.notifier) return;
    const icon = result.ok ? "✅" : "❌";
    // B3 fix: redact detail before sending to DM — provider error messages
    // may contain token fragments or client credentials.
    const safeDetail = redactSensitiveString(result.detail);
    const msg = `${icon} ${backendId} auth recovery: ${safeDetail}`;
    try {
      await this.notifier.send(msg, { kind: "recovery" });
    } catch (err) {
      logger.warn({ err }, "Failed to send recovery completion notification");
    }
  }

  /**
   * Increment a recovery telemetry counter.
   * Recovery counters reuse the AuthTelemetry infrastructure with
   * `source = "reactive"` since recovery is user-initiated.
   */
  private incrementRecovery(
    backendId: BackendId,
    key: RecoveryCounterKey,
  ): void {
    try {
      this.telemetry.increment(backendId, key, "reactive");
    } catch {
      // Telemetry is best-effort
    }
  }
}

// ──────────────────────────────────────────────────────────────────
// Internal types
// ──────────────────────────────────────────────────────────────────

interface ActiveRecoveryInternal extends ActiveRecovery {
  /** Subprocess handle — present for Codex, absent for Gemini OAuth. */
  child?: ChildProcess;
  timeoutHandle: ReturnType<typeof setTimeout>;
  /** Gemini-only: OAuth2 client used to exchange the auth code for tokens. */
  oauthClient?: OAuth2Client;
  /** Gemini-only: PKCE code verifier needed for the token exchange. */
  codeVerifier?: string;
  /** Gemini-only: resolve the completion promise when auth code is received. */
  resolveCompletion?: (result: RecoveryResult) => void;
}

/**
 * Write OAuth tokens to ~/.gemini/oauth_creds.json in the same format
 * the Gemini CLI uses (mode 0600). Creates the directory if needed.
 */
function writeGeminiOAuthCreds(tokens: Record<string, unknown>): void {
  const dir = dirname(GEMINI_OAUTH_CREDS_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const content = JSON.stringify(tokens, null, 2);
  writeFileSync(GEMINI_OAUTH_CREDS_PATH, content, { mode: 0o600 });
  try {
    chmodSync(GEMINI_OAUTH_CREDS_PATH, 0o600);
  } catch {
    // Best-effort
  }
}

const GEMINI_OAUTH_CREDS_BACKUP = GEMINI_OAUTH_CREDS_PATH + ".pa-backup";

/**
 * B2 fix: backup existing oauth_creds.json before overwriting.
 * Returns true if a backup was created.
 */
function backupGeminiOAuthCreds(): boolean {
  try {
    if (existsSync(GEMINI_OAUTH_CREDS_PATH)) {
      copyFileSync(GEMINI_OAUTH_CREDS_PATH, GEMINI_OAUTH_CREDS_BACKUP);
      return true;
    }
  } catch (err) {
    logger.debug({ err }, "Failed to backup oauth_creds.json — proceeding without backup");
  }
  return false;
}

/**
 * B2 fix: restore oauth_creds.json from backup on recovery failure.
 */
function restoreGeminiOAuthCreds(): void {
  try {
    if (existsSync(GEMINI_OAUTH_CREDS_BACKUP)) {
      copyFileSync(GEMINI_OAUTH_CREDS_BACKUP, GEMINI_OAUTH_CREDS_PATH);
      unlinkSync(GEMINI_OAUTH_CREDS_BACKUP);
      logger.info("Restored original oauth_creds.json from backup after failed recovery");
    }
  } catch (err) {
    logger.warn({ err }, "Failed to restore oauth_creds.json backup");
  }
}

/**
 * Remove the backup file after successful recovery.
 */
function removeGeminiOAuthCredsBackup(): void {
  try {
    if (existsSync(GEMINI_OAUTH_CREDS_BACKUP)) {
      unlinkSync(GEMINI_OAUTH_CREDS_BACKUP);
    }
  } catch {
    // Best-effort
  }
}

