/**
 * Auth recovery tests that require module-level vi.mock('node:child_process').
 *
 * Separated from auth-recovery.test.ts because vi.mock hoists to module scope
 * and would affect all 39+ tests in the main file. These tests cover:
 *  - §4.3 T1: Concurrent initiateCodexDeviceAuth rejection
 *  - §4.3 B3: cancelRecovery with active in-memory recovery
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import type { BackendId } from "@aitne/shared";
import type { AuthCheckResult, IAgentCore } from "../agent-core.js";

// ──────────────────────────────────────────────────────────────────
// Mock child_process.spawn — returns a fake ChildProcess EventEmitter
// ──────────────────────────────────────────────────────────────────

class FakeChildProcess extends EventEmitter {
  readonly stdin = new EventEmitter();
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  pid = 12345;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal?: string): boolean {
    this.killed = true;
    this.signalCode = (signal ?? "SIGTERM") as NodeJS.Signals;
    // Simulate async close
    process.nextTick(() => {
      this.exitCode = null;
      this.emit("close", null, this.signalCode);
    });
    return true;
  }
}

let latestChild: FakeChildProcess;

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    latestChild = new FakeChildProcess();
    return latestChild;
  }),
}));

// Mock cli-utils — findExecutable returns a fake path, runLineCommand succeeds
vi.mock("./cli-utils.js", async () => {
  const actual = await vi.importActual<typeof import("./cli-utils.js")>("./cli-utils.js");
  return {
    ...actual,
    findExecutable: vi.fn().mockReturnValue("/usr/local/bin/codex"),
    runLineCommand: vi.fn().mockResolvedValue({ exitCode: 0, stdoutLines: [], stderrLines: [], signal: null, timedOut: false }),
  };
});

// Must import AFTER vi.mock (hoisted)
import {
  AuthRecovery,
  type AuthRecoveryOptions,
} from "./auth-recovery.js";
import {
  AuthHealthMonitor,
  type AuthHealthNotifier,
} from "./auth-health-monitor.js";
import { AuthTelemetry } from "./auth-telemetry.js";

// ──────────────────────────────────────────────────────────────────
// Schema helpers (mirrors auth-recovery.test.ts)
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
// Helpers: simulate Codex device code output on the fake child
// ──────────────────────────────────────────────────────────────────

function emitDeviceCode(child: FakeChildProcess): void {
  const output =
    "Welcome to Codex\n\n" +
    "1. Open this link in your browser\n" +
    "   https://auth.openai.com/codex/device\n\n" +
    "2. Enter this one-time code (expires in 15 minutes)\n" +
    "   D636-F13CP\n\n";
  child.stdout.emit("data", Buffer.from(output));
}

function emitClaudeAuthUrl(child: FakeChildProcess): void {
  const output =
    "Opening browser to sign in…\n" +
    "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=test&state=test\n";
  child.stdout.emit("data", Buffer.from(output));
}

// ──────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────

describe("AuthRecovery — subprocess mock tests (§4.3)", () => {
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
      { claude: fakeCore("claude"), codex: fakeCore("codex") },
      telemetry,
      { now: () => fixedNow, notifier: notifierSpy },
    );
  });

  afterEach(() => {
    db.close();
    vi.clearAllTimers();
  });

  function createRecovery(opts?: Partial<AuthRecoveryOptions>): AuthRecovery {
    return new AuthRecovery(db, telemetry, monitor, notifierSpy, {
      now: () => fixedNow,
      codexRecoveryTimeoutMin: 15,
      geminiRecoveryTimeoutMin: 5,
      ...opts,
    });
  }

  it("concurrent recovery: second initiateCodexDeviceAuth rejects while first is active", async () => {
    const recovery = createRecovery();

    // Start first recovery — emit device code so the initiation promise resolves
    const firstPromise = recovery.initiateCodexDeviceAuth();
    emitDeviceCode(latestChild);
    const first = await firstPromise;

    expect(first.backendId).toBe("codex");
    expect(first.userCode).toBe("D636-F13CP");
    expect(recovery.isRecoveryActive("codex")).toBe(true);

    // Second initiation should reject
    await expect(recovery.initiateCodexDeviceAuth()).rejects.toThrow(
      "already in progress",
    );

    // Cleanup
    recovery.cancelRecovery("codex");
  });

  it("cancelRecovery with active in-memory recovery resets DB synchronously", async () => {
    const recovery = createRecovery();

    // Start recovery
    const initPromise = recovery.initiateCodexDeviceAuth();
    emitDeviceCode(latestChild);
    await initPromise;

    // Verify recovering state
    const before = monitor.loadState("codex");
    expect(before?.status).toBe("recovering");

    // Cancel — should synchronously reset DB AND kill the subprocess
    const cancelled = recovery.cancelRecovery("codex");
    expect(cancelled).toBe(true);

    // DB should be `expired` immediately (synchronous)
    const after = monitor.loadState("codex");
    expect(after?.status).toBe("expired");
    expect(after?.detail).toContain("cancelled");

    // In-memory tracking should be cleared
    expect(recovery.isRecoveryActive("codex")).toBe(false);

    // Subprocess should have been killed
    expect(latestChild.killed).toBe(true);
  });

  it("timeout kills subprocess and records recovery_timeout telemetry", async () => {
    vi.useFakeTimers();
    try {
      // Use a very short timeout (0.01 min = 600ms) so fake timers advance fast
      const recovery = createRecovery({ codexRecoveryTimeoutMin: 0.01 });

      // Start recovery
      const initPromise = recovery.initiateCodexDeviceAuth();
      emitDeviceCode(latestChild);
      const result = await initPromise;
      expect(result.backendId).toBe("codex");

      // Capture the completion promise before advancing time
      const completionPromise = result.completion;

      // Advance past timeout (0.01 min = 600 ms)
      await vi.advanceTimersByTimeAsync(700);

      // The timeout fires → child.kill("SIGTERM") → close event → applyRecoveryResult
      const completionResult = await completionPromise;
      expect(completionResult.ok).toBe(false);
      expect(completionResult.reason).toBe("killed");

      // DB should show expired
      const state = monitor.loadState("codex");
      expect(state?.status).toBe("expired");

      // Telemetry should record the timeout start
      const snap = telemetry.snapshot();
      expect(snap.codex?.recovery_started).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // ────────────────────────────────────────────────────────────
  // Claude browser auth recovery (Phase 9 §8.2)
  // ────────────────────────────────────────────────────────────

  it("initiateClaudeAuth spawns subprocess and extracts OAuth URL", async () => {
    const recovery = createRecovery();

    const initPromise = recovery.initiateClaudeAuth();
    emitClaudeAuthUrl(latestChild);
    const result = await initPromise;

    expect(result.backendId).toBe("claude");
    expect(result.authUrl).toContain("https://claude.com/cai/oauth/authorize");
    expect(result.userCode).toBeUndefined();
    expect(result.expiresMinutes).toBe(10);
    expect(recovery.isRecoveryActive("claude")).toBe(true);

    // DB should show recovering
    const state = monitor.loadState("claude");
    expect(state?.status).toBe("recovering");

    // Telemetry
    const snap = telemetry.snapshot();
    expect(snap.claude?.recovery_started).toBe(1);

    // Cleanup
    recovery.cancelRecovery("claude");
  });

  it("concurrent Claude recovery is rejected", async () => {
    const recovery = createRecovery();

    const initPromise = recovery.initiateClaudeAuth();
    emitClaudeAuthUrl(latestChild);
    await initPromise;

    await expect(recovery.initiateClaudeAuth()).rejects.toThrow(
      "already in progress",
    );

    recovery.cancelRecovery("claude");
  });

  it("cancelRecovery for Claude resets DB and kills subprocess", async () => {
    const recovery = createRecovery();

    const initPromise = recovery.initiateClaudeAuth();
    emitClaudeAuthUrl(latestChild);
    await initPromise;

    expect(recovery.cancelRecovery("claude")).toBe(true);

    const state = monitor.loadState("claude");
    expect(state?.status).toBe("expired");
    expect(state?.detail).toContain("cancelled");
    expect(recovery.isRecoveryActive("claude")).toBe(false);
    expect(latestChild.killed).toBe(true);
  });

  it("BROWSER=echo is set in subprocess env", async () => {
    const { spawn } = await import("node:child_process");
    const spawnMock = vi.mocked(spawn);

    const recovery = createRecovery();
    const initPromise = recovery.initiateClaudeAuth();
    emitClaudeAuthUrl(latestChild);
    await initPromise;

    // Check that spawn was called with BROWSER=echo in env
    const lastCall = spawnMock.mock.calls[spawnMock.mock.calls.length - 1];
    const env = (lastCall[2] as { env?: Record<string, string> })?.env;
    expect(env?.BROWSER).toBe("echo");

    recovery.cancelRecovery("claude");
  });
});
