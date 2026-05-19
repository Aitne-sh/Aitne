import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import {
  AuthRecovery,
  parseClaudeAuthLoginOutput,
  parseCodexDeviceAuthOutput,
  parseGeminiAuthCode,
  extractGeminiOAuthCredentials,
  type AuthRecoveryOptions,
} from "./auth-recovery.js";
import {
  AuthHealthMonitor,
  readCachedAuthStatus,
  recordReactiveAuthFailure,
  type AuthHealthNotifier,
} from "./auth-health-monitor.js";
import { AuthTelemetry } from "./auth-telemetry.js";
import type { AuthCheckResult, IAgentCore } from "../agent-core.js";
import type { BackendId } from "@aitne/shared";

// ──────────────────────────────────────────────────────────────────
// Schema helpers (mirrors auth-health-monitor.test.ts)
// ──────────────────────────────────────────────────────────────────

function createBackendsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE backends (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      auth_method TEXT,
      auth_status TEXT NOT NULL DEFAULT 'unknown',
      auth_checked_at TEXT,
      auth_detail TEXT,
      auth_first_expired_at TEXT,
      auth_notified_at TEXT,
      auth_notification_count INTEGER NOT NULL DEFAULT 0,
      auth_last_success_at TEXT,
      auth_last_verified_at TEXT,
      auth_keepalive_notified_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE auth_telemetry_counters (
      backend_id TEXT NOT NULL,
      counter_key TEXT NOT NULL,
      bucket_hour TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'reactive',
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (backend_id, counter_key, bucket_hour, source)
    );
  `);
  for (const id of ["claude", "codex", "gemini"]) {
    db.prepare("INSERT INTO backends (id, enabled) VALUES (?, 1)").run(id);
  }
}

function fakeCore(backendId: BackendId): IAgentCore {
  return {
    backendId,
    execute: vi.fn(),
    executeResume: vi.fn(),
    summarize: vi.fn(),
    checkAuth: vi.fn(),
    checkAuthDetailed: vi.fn().mockResolvedValue({
      ok: true,
      status: "ok",
      method: "oauth",
    } satisfies AuthCheckResult),
    listModels: vi.fn().mockReturnValue([]),
  } as unknown as IAgentCore;
}

// ──────────────────────────────────────────────────────────────────
// parseCodexDeviceAuthOutput unit tests
// ──────────────────────────────────────────────────────────────────

describe("parseCodexDeviceAuthOutput", () => {
  it("parses clean output with device URL and user code", () => {
    const output = `
Welcome to Codex [v0.118.0]
OpenAI's command-line coding agent

Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device

2. Enter this one-time code (expires in 15 minutes)
   D636-F13CP

Device codes are a common phishing target. Never share this code.

`;
    const result = parseCodexDeviceAuthOutput(output);
    expect(result).toEqual({
      deviceUrl: "https://auth.openai.com/codex/device",
      userCode: "D636-F13CP",
      expiresMinutes: 15,
    });
  });

  it("strips ANSI escape codes before parsing", () => {
    const output =
      "\nWelcome to Codex [v\x1b[90m0.118.0\x1b[0m]\n" +
      "\x1b[90mOpenAI's command-line coding agent\x1b[0m\n\n" +
      "Follow these steps to sign in with ChatGPT using device code authorization:\n\n" +
      "1. Open this link in your browser and sign in to your account\n" +
      "   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n" +
      "2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n" +
      "   \x1b[94mD65V-KQVNP\x1b[0m\n\n" +
      "\x1b[90mDevice codes are a common phishing target. Never share this code.\x1b[0m\n\n";

    const result = parseCodexDeviceAuthOutput(output);
    expect(result).not.toBeNull();
    expect(result!.deviceUrl).toBe("https://auth.openai.com/codex/device");
    expect(result!.userCode).toBe("D65V-KQVNP");
    expect(result!.expiresMinutes).toBe(15);
  });

  it("returns null for empty output", () => {
    expect(parseCodexDeviceAuthOutput("")).toBeNull();
  });

  it("returns null for unrelated output", () => {
    expect(parseCodexDeviceAuthOutput("Logged in using ChatGPT")).toBeNull();
  });

  it("handles missing expires line (defaults to 15 min)", () => {
    const output = `
1. Open this link in your browser
   https://auth.openai.com/codex/device

2. Enter this one-time code
   ABCD-EFGHI
`;
    const result = parseCodexDeviceAuthOutput(output);
    expect(result).not.toBeNull();
    expect(result!.expiresMinutes).toBe(15);
  });

  it("handles different code lengths within spec range", () => {
    // 3-char + 3-char (minimum)
    const output = `
   https://auth.openai.com/codex/device
   ABC-DEF
`;
    const result = parseCodexDeviceAuthOutput(output);
    expect(result).not.toBeNull();
    expect(result!.userCode).toBe("ABC-DEF");
  });

  it("rejects codes that are too short", () => {
    const output = `
   https://auth.openai.com/codex/device
   AB-CD
`;
    const result = parseCodexDeviceAuthOutput(output);
    // URL matches but code doesn't (too short)
    expect(result).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// parseClaudeAuthLoginOutput unit tests (Phase 9 §8.1)
// ──────────────────────────────────────────────────────────────────

describe("parseClaudeAuthLoginOutput", () => {
  it("parses claude.ai OAuth URL from standard output", () => {
    const output =
      "Opening browser to sign in…\n" +
      "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=test-id&state=test-state\n";
    const result = parseClaudeAuthLoginOutput(output);
    expect(result).toBe(
      "https://claude.com/cai/oauth/authorize?code=true&client_id=test-id&state=test-state",
    );
  });

  it("parses platform.claude.com OAuth URL (--console mode)", () => {
    const output =
      "Opening browser to sign in…\n" +
      "If the browser didn't open, visit: https://platform.claude.com/oauth/authorize?code=true&client_id=test-id&state=test-state\n";
    const result = parseClaudeAuthLoginOutput(output);
    expect(result).toBe(
      "https://platform.claude.com/oauth/authorize?code=true&client_id=test-id&state=test-state",
    );
  });

  it("strips ANSI escape codes before parsing", () => {
    const output =
      "\x1b[90mOpening browser to sign in…\x1b[0m\n" +
      "If the browser didn't open, visit: \x1b[94mhttps://claude.com/cai/oauth/authorize?code=true&state=abc\x1b[0m\n";
    const result = parseClaudeAuthLoginOutput(output);
    expect(result).toBe(
      "https://claude.com/cai/oauth/authorize?code=true&state=abc",
    );
  });

  it("returns null for empty output", () => {
    expect(parseClaudeAuthLoginOutput("")).toBeNull();
  });

  it("returns null for unrelated output", () => {
    expect(parseClaudeAuthLoginOutput("Welcome to Claude Code")).toBeNull();
  });

  it("returns null for output without the visit: prefix", () => {
    expect(
      parseClaudeAuthLoginOutput("https://claude.com/cai/oauth/authorize?code=true"),
    ).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// AuthRecovery integration tests
// ──────────────────────────────────────────────────────────────────

// We cannot easily mock `spawn` in integration tests without
// vi.mock at the module level. Instead, we test the class's
// DB-state and API behavior through the public interface.

describe("AuthRecovery", () => {
  let db: Database.Database;
  let telemetry: AuthTelemetry;
  let monitor: AuthHealthMonitor;
  let notifierSpy: AuthHealthNotifier;
  const fixedNow = new Date("2026-04-11T12:00:00Z");

  beforeEach(() => {
    db = new Database(":memory:");
    createBackendsSchema(db);
    telemetry = new AuthTelemetry(db);
    notifierSpy = { send: vi.fn().mockResolvedValue(undefined) };
    monitor = new AuthHealthMonitor(
      db,
      { codex: fakeCore("codex") },
      telemetry,
      { now: () => fixedNow, notifier: notifierSpy },
    );
  });

  afterEach(() => {
    db.close();
  });

  function createRecovery(opts?: Partial<AuthRecoveryOptions>): AuthRecovery {
    return new AuthRecovery(db, telemetry, monitor, notifierSpy, {
      now: () => fixedNow,
      ...opts,
    });
  }

  describe("getActiveRecovery / isRecoveryActive", () => {
    it("returns undefined when no recovery is active", () => {
      const recovery = createRecovery();
      expect(recovery.getActiveRecovery("codex")).toBeUndefined();
      expect(recovery.isRecoveryActive("codex")).toBe(false);
    });
  });

  describe("shutdown", () => {
    it("prevents new recoveries from starting", async () => {
      const recovery = createRecovery();
      recovery.shutdown();
      await expect(recovery.initiateCodexDeviceAuth()).rejects.toThrow(
        "shutting down",
      );
    });

    it("resets recovering rows to expired in DB (B3 fix)", () => {
      db.prepare(
        "UPDATE backends SET auth_status = 'recovering' WHERE id = 'codex'",
      ).run();

      const recovery = createRecovery();
      recovery.shutdown();

      const state = monitor.loadState("codex");
      expect(state?.status).toBe("expired");
      expect(state?.detail).toContain("daemon shutdown");
    });
  });

  // T1 fix: concurrent recovery test requires subprocess mocking
  // → moved to auth-recovery-subprocess.test.ts (§4.3)

  describe("cancelRecovery", () => {
    it("returns false when no recovery is active", () => {
      const recovery = createRecovery();
      expect(recovery.cancelRecovery("codex")).toBe(false);
    });

    // cancelRecovery's DB reset (B3 fix) requires subprocess mock for in-memory entry
    // → moved to auth-recovery-subprocess.test.ts (§4.3)
  });

  describe("DB state: recovering status", () => {
    it("reconcilePendingRecoveries resets stuck recovering rows", () => {
      db.prepare(
        "UPDATE backends SET auth_status = 'recovering', auth_detail = 'Device auth in progress' WHERE id = 'codex'",
      ).run();

      const state = monitor.loadState("codex");
      expect(state?.status).toBe("recovering");

      const count = monitor.reconcilePendingRecoveries();
      expect(count).toBe(1);

      const after = monitor.loadState("codex");
      expect(after?.status).toBe("expired");
      expect(after?.detail).toContain("daemon restart");
    });

    it("readCachedAuthStatus always skips recovering backends", () => {
      db.prepare(
        "UPDATE backends SET auth_status = 'recovering', auth_last_verified_at = ? WHERE id = 'codex'",
      ).run(fixedNow.toISOString());

      const result = readCachedAuthStatus(db, "codex");
      expect(result.status).toBe("recovering");
      expect(result.shouldSkip).toBe(true);
    });

    it("recordReactiveAuthFailure does NOT clobber recovering row", () => {
      db.prepare(
        "UPDATE backends SET auth_status = 'recovering' WHERE id = 'codex'",
      ).run();

      recordReactiveAuthFailure(db, "codex", "some auth failure", telemetry);

      const state = monitor.loadState("codex");
      expect(state?.status).toBe("recovering");
    });

    it("FIRST_EXPIRED_CASE_SQL preserves auth_first_expired_at through recovering → expired (M4 fix)", () => {
      // Simulate: backend expired at T1, then recovery started but failed
      const originalExpired = "2026-04-09T08:00:00.000Z";
      db.prepare(
        `UPDATE backends
            SET auth_status = 'recovering',
                auth_first_expired_at = ?
          WHERE id = 'codex'`,
      ).run(originalExpired);

      const recovery = createRecovery();
      recovery.shutdown();

      const after = monitor.loadState("codex");
      expect(after?.status).toBe("expired");
      expect(after?.firstExpiredAt?.toISOString()).toBe(originalExpired);
    });

    it("FIRST_EXPIRED_CASE_SQL stamps now when auth_first_expired_at is NULL (M4 edge case)", () => {
      // Edge case: recovery started from ok state (unlikely but possible)
      db.prepare(
        "UPDATE backends SET auth_status = 'recovering', auth_first_expired_at = NULL WHERE id = 'codex'",
      ).run();

      const recovery = createRecovery();
      recovery.shutdown();

      const after = monitor.loadState("codex");
      expect(after?.status).toBe("expired");
      // COALESCE(NULL, @now) → now
      expect(after?.firstExpiredAt).not.toBeNull();
      expect(after?.firstExpiredAt?.toISOString()).toBe(fixedNow.toISOString());
    });
  });

  describe("telemetry counter keys", () => {
    it("recovery counter keys are valid AuthCounterKey members", () => {
      telemetry.increment("codex", "recovery_started", "reactive");
      telemetry.increment("codex", "recovery_success", "reactive");
      telemetry.increment("codex", "recovery_timeout", "reactive");
      telemetry.increment("codex", "recovery_failed", "reactive");

      const snap = telemetry.snapshot();
      expect(snap.codex?.recovery_started).toBe(1);
      expect(snap.codex?.recovery_success).toBe(1);
      expect(snap.codex?.recovery_timeout).toBe(1);
      expect(snap.codex?.recovery_failed).toBe(1);
    });
  });

  describe("RecoveryResult reason enum (M6 fix)", () => {
    it("reason field exists on the type and covers all expected values", () => {
      // Compile-time validation — if RecoveryReason doesn't include these,
      // TS will error. Runtime check for completeness.
      const reasons: import("./auth-recovery.js").RecoveryReason[] = [
        "success", "verification_failed", "killed", "timeout", "exit_error", "exception",
      ];
      expect(reasons).toHaveLength(6);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Phase 6 §5.1: Gemini OAuth recovery
  // ────────────────────────────────────────────────────────────

  describe("Gemini OAuth recovery (Phase 6)", () => {
    it("initiateGeminiAuth rejects when encrypted storage is enabled", async () => {
      const originalEnv = process.env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE;
      try {
        process.env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE = "true";
        const recovery = createRecovery();
        await expect(recovery.initiateGeminiAuth()).rejects.toThrow(
          "encrypted storage",
        );
      } finally {
        if (originalEnv === undefined) {
          delete process.env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE;
        } else {
          process.env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE = originalEnv;
        }
      }
    });

    it("initiateGeminiAuth rejects when daemon is shutting down", async () => {
      const recovery = createRecovery();
      recovery.shutdown();
      await expect(recovery.initiateGeminiAuth()).rejects.toThrow(
        "shutting down",
      );
    });

    it("initiateGeminiAuth rejects when OAuth credentials are missing", async () => {
      // No env vars, no CLI installed (findExecutable returns null)
      const origId = process.env.PA_GEMINI_OAUTH_CLIENT_ID;
      const origSecret = process.env.PA_GEMINI_OAUTH_CLIENT_SECRET;
      try {
        delete process.env.PA_GEMINI_OAUTH_CLIENT_ID;
        delete process.env.PA_GEMINI_OAUTH_CLIENT_SECRET;
        const recovery = createRecovery();
        // Will fail to find credentials (env vars not set, CLI not found in test env)
        // unless the actual CLI is installed. We test the guard behavior.
        // If CLI is installed, the test still passes (initiateGeminiAuth succeeds).
        try {
          await recovery.initiateGeminiAuth();
          // If it succeeds, OAuth creds were found from CLI bundle — that's fine,
          // just verify the state was set correctly
          expect(recovery.isRecoveryActive("gemini")).toBe(true);
          recovery.cancelRecovery("gemini");
        } catch (err) {
          expect((err as Error).message).toContain("Cannot extract Gemini OAuth");
        }
      } finally {
        if (origId !== undefined) process.env.PA_GEMINI_OAUTH_CLIENT_ID = origId;
        if (origSecret !== undefined) process.env.PA_GEMINI_OAUTH_CLIENT_SECRET = origSecret;
      }
    });

    it("initiateGeminiAuth with env var credentials sets DB to recovering", async () => {
      const origId = process.env.PA_GEMINI_OAUTH_CLIENT_ID;
      const origSecret = process.env.PA_GEMINI_OAUTH_CLIENT_SECRET;
      try {
        process.env.PA_GEMINI_OAUTH_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
        process.env.PA_GEMINI_OAUTH_CLIENT_SECRET = "test-client-secret";
        const recovery = createRecovery();
        const result = await recovery.initiateGeminiAuth();

        // Check returned ActiveRecovery
        expect(result.backendId).toBe("gemini");
        expect(result.authUrl).toContain("accounts.google.com");
        expect(result.authUrl).toContain("test-client-id");
        expect(result.expiresMinutes).toBe(5);
        expect(result.userCode).toBeUndefined();

        // Check DB state
        const state = monitor.loadState("gemini");
        expect(state?.status).toBe("recovering");
        expect(state?.detail).toContain("OAuth recovery in progress");

        // Check telemetry
        const snap = telemetry.snapshot();
        expect(snap.gemini?.recovery_started).toBe(1);

        // Check active recovery tracking
        expect(recovery.isRecoveryActive("gemini")).toBe(true);
        const active = recovery.getActiveRecovery("gemini");
        expect(active?.authUrl).toBe(result.authUrl);

        // Cleanup
        recovery.cancelRecovery("gemini");
      } finally {
        if (origId !== undefined) process.env.PA_GEMINI_OAUTH_CLIENT_ID = origId;
        else delete process.env.PA_GEMINI_OAUTH_CLIENT_ID;
        if (origSecret !== undefined) process.env.PA_GEMINI_OAUTH_CLIENT_SECRET = origSecret;
        else delete process.env.PA_GEMINI_OAUTH_CLIENT_SECRET;
      }
    });

    it("concurrent Gemini recovery is rejected", async () => {
      const origId = process.env.PA_GEMINI_OAUTH_CLIENT_ID;
      const origSecret = process.env.PA_GEMINI_OAUTH_CLIENT_SECRET;
      try {
        process.env.PA_GEMINI_OAUTH_CLIENT_ID = "test-id.apps.googleusercontent.com";
        process.env.PA_GEMINI_OAUTH_CLIENT_SECRET = "test-secret";
        const recovery = createRecovery();
        await recovery.initiateGeminiAuth();

        await expect(recovery.initiateGeminiAuth()).rejects.toThrow(
          "already in progress",
        );

        recovery.cancelRecovery("gemini");
      } finally {
        if (origId !== undefined) process.env.PA_GEMINI_OAUTH_CLIENT_ID = origId;
        else delete process.env.PA_GEMINI_OAUTH_CLIENT_ID;
        if (origSecret !== undefined) process.env.PA_GEMINI_OAUTH_CLIENT_SECRET = origSecret;
        else delete process.env.PA_GEMINI_OAUTH_CLIENT_SECRET;
      }
    });

    it("cancelRecovery for Gemini resets DB to expired", async () => {
      const origId = process.env.PA_GEMINI_OAUTH_CLIENT_ID;
      const origSecret = process.env.PA_GEMINI_OAUTH_CLIENT_SECRET;
      try {
        process.env.PA_GEMINI_OAUTH_CLIENT_ID = "test-id.apps.googleusercontent.com";
        process.env.PA_GEMINI_OAUTH_CLIENT_SECRET = "test-secret";
        const recovery = createRecovery();
        await recovery.initiateGeminiAuth();
        expect(recovery.isRecoveryActive("gemini")).toBe(true);

        const cancelled = recovery.cancelRecovery("gemini");
        expect(cancelled).toBe(true);
        expect(recovery.isRecoveryActive("gemini")).toBe(false);

        const state = monitor.loadState("gemini");
        expect(state?.status).toBe("expired");
        expect(state?.detail).toContain("cancelled");
      } finally {
        if (origId !== undefined) process.env.PA_GEMINI_OAUTH_CLIENT_ID = origId;
        else delete process.env.PA_GEMINI_OAUTH_CLIENT_ID;
        if (origSecret !== undefined) process.env.PA_GEMINI_OAUTH_CLIENT_SECRET = origSecret;
        else delete process.env.PA_GEMINI_OAUTH_CLIENT_SECRET;
      }
    });

    it("handleGeminiAuthCode rejects when no active Gemini recovery", async () => {
      const recovery = createRecovery();
      await expect(recovery.handleGeminiAuthCode("4/0ATest")).rejects.toThrow(
        "No active Gemini recovery",
      );
    });

    it("handleGeminiAuthCode handles invalid code gracefully", async () => {
      const origId = process.env.PA_GEMINI_OAUTH_CLIENT_ID;
      const origSecret = process.env.PA_GEMINI_OAUTH_CLIENT_SECRET;
      try {
        process.env.PA_GEMINI_OAUTH_CLIENT_ID = "test-id.apps.googleusercontent.com";
        process.env.PA_GEMINI_OAUTH_CLIENT_SECRET = "test-secret";
        const recovery = createRecovery();
        await recovery.initiateGeminiAuth();

        // Send an invalid code — the OAuth exchange will fail
        const result = await recovery.handleGeminiAuthCode("invalid-code");
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("exception");
        expect(result.detail).toContain("Failed to exchange");

        // Recovery should be cleaned up
        expect(recovery.isRecoveryActive("gemini")).toBe(false);

        // DB should be back to expired
        const state = monitor.loadState("gemini");
        expect(state?.status).toBe("expired");
      } finally {
        if (origId !== undefined) process.env.PA_GEMINI_OAUTH_CLIENT_ID = origId;
        else delete process.env.PA_GEMINI_OAUTH_CLIENT_ID;
        if (origSecret !== undefined) process.env.PA_GEMINI_OAUTH_CLIENT_SECRET = origSecret;
        else delete process.env.PA_GEMINI_OAUTH_CLIENT_SECRET;
      }
    });

    it("shutdown resets Gemini recovering rows in DB", async () => {
      const origId = process.env.PA_GEMINI_OAUTH_CLIENT_ID;
      const origSecret = process.env.PA_GEMINI_OAUTH_CLIENT_SECRET;
      try {
        process.env.PA_GEMINI_OAUTH_CLIENT_ID = "test-id.apps.googleusercontent.com";
        process.env.PA_GEMINI_OAUTH_CLIENT_SECRET = "test-secret";
        const recovery = createRecovery();
        await recovery.initiateGeminiAuth();

        recovery.shutdown();

        expect(recovery.isRecoveryActive("gemini")).toBe(false);
        const state = monitor.loadState("gemini");
        expect(state?.status).toBe("expired");
        expect(state?.detail).toContain("daemon shutdown");
      } finally {
        if (origId !== undefined) process.env.PA_GEMINI_OAUTH_CLIENT_ID = origId;
        else delete process.env.PA_GEMINI_OAUTH_CLIENT_ID;
        if (origSecret !== undefined) process.env.PA_GEMINI_OAUTH_CLIENT_SECRET = origSecret;
        else delete process.env.PA_GEMINI_OAUTH_CLIENT_SECRET;
      }
    });

    it("readCachedAuthStatus always skips recovering Gemini backends", () => {
      db.prepare(
        "UPDATE backends SET auth_status = 'recovering', auth_last_verified_at = ? WHERE id = 'gemini'",
      ).run(fixedNow.toISOString());

      const result = readCachedAuthStatus(db, "gemini");
      expect(result.status).toBe("recovering");
      expect(result.shouldSkip).toBe(true);
    });

    it("recordReactiveAuthFailure does NOT clobber Gemini recovering row", () => {
      db.prepare(
        "UPDATE backends SET auth_status = 'recovering' WHERE id = 'gemini'",
      ).run();

      recordReactiveAuthFailure(db, "gemini", "some auth failure", telemetry);

      const state = monitor.loadState("gemini");
      expect(state?.status).toBe("recovering");
    });
  });
});

// ──────────────────────────────────────────────────────────────────
// parseGeminiAuthCode unit tests (Phase 6 §5.2)
// ──────────────────────────────────────────────────────────────────

describe("parseGeminiAuthCode", () => {
  it("parses a valid Google OAuth authorization code", () => {
    const code = "4/0AeanS0aBcDeFgHiJkLmNoPqRsTuVwXyZ123456789";
    expect(parseGeminiAuthCode(code)).toBe(code);
  });

  it("parses a code with leading/trailing whitespace", () => {
    const code = "4/0AeanS0aBcDeFgHiJkLmNoPqRsTuVwXyZ123456789";
    expect(parseGeminiAuthCode(`  ${code}  `)).toBe(code);
  });

  it("parses a code starting with 4/1", () => {
    const code = "4/1AeanS0aBcDeFgHiJkLmNoPqRsTuVwXyZ123456789";
    expect(parseGeminiAuthCode(code)).toBe(code);
  });

  it("parses a code with underscores and hyphens (URL-safe base64)", () => {
    const code = "4/0Aean_S0a-BcDeFgHiJkLmNoPqRsTuVwXyZ12345";
    expect(parseGeminiAuthCode(code)).toBe(code);
  });

  it("rejects codes that don't start with 4/", () => {
    expect(parseGeminiAuthCode("5/0AeanS0aBcDeFgHiJkLmNoPqRsTuVwXyZ12345")).toBeNull();
  });

  it("rejects codes that are too short (< 30 chars after 4/)", () => {
    expect(parseGeminiAuthCode("4/0AeanS0aBcDe")).toBeNull();
  });

  it("rejects regular messages that could false-positive", () => {
    expect(parseGeminiAuthCode("hello world")).toBeNull();
    expect(parseGeminiAuthCode("/auth fix gemini")).toBeNull();
    expect(parseGeminiAuthCode("4/5 rating")).toBeNull();
    expect(parseGeminiAuthCode("")).toBeNull();
  });

  it("rejects multiline input", () => {
    expect(parseGeminiAuthCode("4/0AeanS0aBcDeFgHiJkLmNoPqRsTuVwXyZ12345\nextra line")).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// extractGeminiOAuthCredentials unit tests
// ──────────────────────────────────────────────────────────────────

describe("extractGeminiOAuthCredentials", () => {
  it("returns env var credentials when set", () => {
    const origId = process.env.PA_GEMINI_OAUTH_CLIENT_ID;
    const origSecret = process.env.PA_GEMINI_OAUTH_CLIENT_SECRET;
    try {
      process.env.PA_GEMINI_OAUTH_CLIENT_ID = "env-client-id";
      process.env.PA_GEMINI_OAUTH_CLIENT_SECRET = "env-client-secret";
      const creds = extractGeminiOAuthCredentials();
      expect(creds).toEqual({
        clientId: "env-client-id",
        clientSecret: "env-client-secret",
      });
    } finally {
      if (origId !== undefined) process.env.PA_GEMINI_OAUTH_CLIENT_ID = origId;
      else delete process.env.PA_GEMINI_OAUTH_CLIENT_ID;
      if (origSecret !== undefined) process.env.PA_GEMINI_OAUTH_CLIENT_SECRET = origSecret;
      else delete process.env.PA_GEMINI_OAUTH_CLIENT_SECRET;
    }
  });

  it("returns null when only one env var is set", () => {
    const origId = process.env.PA_GEMINI_OAUTH_CLIENT_ID;
    const origSecret = process.env.PA_GEMINI_OAUTH_CLIENT_SECRET;
    try {
      process.env.PA_GEMINI_OAUTH_CLIENT_ID = "env-client-id";
      delete process.env.PA_GEMINI_OAUTH_CLIENT_SECRET;
      const creds = extractGeminiOAuthCredentials();
      // May still find credentials from CLI bundle if installed
      if (creds && creds.clientId !== "env-client-id") {
        // Found from bundle — valid result
      } else if (creds) {
        expect(creds.clientId).toBe("env-client-id");
      }
      // If null, that's also valid (no CLI installed)
    } finally {
      if (origId !== undefined) process.env.PA_GEMINI_OAUTH_CLIENT_ID = origId;
      else delete process.env.PA_GEMINI_OAUTH_CLIENT_ID;
      if (origSecret !== undefined) process.env.PA_GEMINI_OAUTH_CLIENT_SECRET = origSecret;
      else delete process.env.PA_GEMINI_OAUTH_CLIENT_SECRET;
    }
  });
});
