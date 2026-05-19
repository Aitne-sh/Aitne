import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import {
  AuthHealthMonitor,
  readCachedAuthStatus,
  recordReactiveAuthFailure,
  recordReactiveAuthSuccess,
  type AuthHealthNotifier,
} from "./auth-health-monitor.js";
import { AuthTelemetry } from "./auth-telemetry.js";
import type { AuthCheckResult, IAgentCore } from "../agent-core.js";
import type { BackendId } from "@aitne/shared";

function createBackendsSchema(db: Database.Database): void {
  // Mirrors the production `backends` table from `schema.ts` — the columns
  // this test asserts behavior over. Kept as a local minimal schema rather
  // than calling applySchema so the test focuses on auth-health columns.
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
    db.prepare(
      "INSERT INTO backends (id, enabled) VALUES (?, 1)",
    ).run(id);
  }
}

function fakeCore(backendId: BackendId): IAgentCore {
  return {
    backendId,
    execute: vi.fn(),
    executeResume: vi.fn(),
    summarize: vi.fn(),
    checkAuth: vi.fn(),
    checkAuthDetailed: vi.fn(),
    listModels: vi.fn().mockReturnValue([]),
  } as unknown as IAgentCore;
}

describe("recordReactiveAuthFailure", () => {
  let db: Database.Database;
  let telemetry: AuthTelemetry;

  beforeEach(() => {
    db = new Database(":memory:");
    createBackendsSchema(db);
    telemetry = new AuthTelemetry(db);
  });

  afterEach(() => db.close());

  it("updates the DB cache to expired and records telemetry", () => {
    const now = new Date("2026-04-10T10:00:00Z");
    recordReactiveAuthFailure(db, "codex", "401 unauthorized", telemetry, now);

    const row = db
      .prepare("SELECT * FROM backends WHERE id = 'codex'")
      .get() as {
        auth_status: string;
        auth_detail: string | null;
        auth_checked_at: string;
        auth_first_expired_at: string;
        last_error: string | null;
      };
    expect(row.auth_status).toBe("expired");
    expect(row.auth_detail).toBe("401 unauthorized");
    expect(row.auth_checked_at).toBe(now.toISOString());
    expect(row.auth_first_expired_at).toBe(now.toISOString());
    // last_error mirrors auth_detail so dashboard consumers (which still
    // read lastError) stay in sync with the new auth_detail column.
    expect(row.last_error).toBe("401 unauthorized");

    expect(telemetry.snapshot().codex?.reactive_expired).toBe(1);
  });

  it("does NOT overwrite a recovering row and does NOT bump telemetry", () => {
    db.prepare(
      "UPDATE backends SET auth_status='recovering', auth_detail='in progress' WHERE id='codex'",
    ).run();
    const now = new Date("2026-04-10T10:00:00Z");
    recordReactiveAuthFailure(db, "codex", "runtime 401", telemetry, now);

    const row = db
      .prepare("SELECT auth_status, auth_detail FROM backends WHERE id='codex'")
      .get() as { auth_status: string; auth_detail: string | null };
    expect(row.auth_status).toBe("recovering");
    expect(row.auth_detail).toBe("in progress");
    expect(telemetry.snapshot().codex?.reactive_expired).toBeUndefined();
  });

  it("preserves the existing first_expired_at on repeated failures", () => {
    const first = new Date("2026-04-10T10:00:00Z");
    const second = new Date("2026-04-10T11:00:00Z");
    recordReactiveAuthFailure(db, "codex", "fail-1", undefined, first);
    recordReactiveAuthFailure(db, "codex", "fail-2", undefined, second);

    const row = db
      .prepare("SELECT auth_first_expired_at, auth_checked_at FROM backends WHERE id = 'codex'")
      .get() as { auth_first_expired_at: string; auth_checked_at: string };
    expect(row.auth_first_expired_at).toBe(first.toISOString());
    expect(row.auth_checked_at).toBe(second.toISOString());
  });

  it("resets stale first_expired_at when transitioning from ok", () => {
    // Roadmap §2.2 — the unified CASE ensures an ok → expired
    // transition stamps a fresh first_expired_at even if a stale
    // value leaked through from an earlier, un-cleared failure. The
    // pre-refactor `COALESCE(auth_first_expired_at, ?)` would have
    // incorrectly preserved the stale value.
    db.prepare(
      "UPDATE backends SET auth_status='ok', auth_first_expired_at='2026-04-01T00:00:00Z' WHERE id='codex'",
    ).run();
    const now = new Date("2026-04-10T10:00:00Z");
    recordReactiveAuthFailure(db, "codex", "fresh 401", undefined, now);
    const row = db
      .prepare("SELECT auth_first_expired_at FROM backends WHERE id='codex'")
      .get() as { auth_first_expired_at: string };
    expect(row.auth_first_expired_at).toBe(now.toISOString());
  });

  it("swallows DB errors without throwing but logs a warning", () => {
    db.exec("DROP TABLE backends");
    expect(() =>
      recordReactiveAuthFailure(db, "codex", "x"),
    ).not.toThrow();
    // We don't assert on log output here (the logger is module-global)
    // — the behavioural contract is "never throw", proven above. The
    // log side-effect is documented in code.
  });

  it("uses default clock when now is not provided", () => {
    recordReactiveAuthFailure(db, "codex", "x");
    const row = db
      .prepare("SELECT auth_first_expired_at FROM backends WHERE id = 'codex'")
      .get() as { auth_first_expired_at: string };
    expect(row.auth_first_expired_at).toBeTruthy();
  });

  it("redacts upstream token fragments from detail before writing", () => {
    const now = new Date("2026-04-10T10:00:00Z");
    // Simulate an upstream 401 body that echoes the Authorization header
    // back into the error message.
    recordReactiveAuthFailure(
      db,
      "claude",
      "401 Unauthorized: Bearer sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAA is invalid",
      telemetry,
      now,
    );
    const row = db
      .prepare("SELECT auth_detail, last_error FROM backends WHERE id = 'claude'")
      .get() as { auth_detail: string; last_error: string };
    expect(row.auth_detail).not.toContain("sk-ant-");
    expect(row.auth_detail).toContain("[REDACTED]");
    expect(row.last_error).not.toContain("sk-ant-");
    expect(row.last_error).toContain("[REDACTED]");
  });
});

describe("recordReactiveAuthSuccess", () => {
  let db: Database.Database;
  let telemetry: AuthTelemetry;

  beforeEach(() => {
    db = new Database(":memory:");
    createBackendsSchema(db);
    telemetry = new AuthTelemetry(db);
  });

  afterEach(() => db.close());

  it("bumps auth_last_success_at on ok → ok", () => {
    db.prepare("UPDATE backends SET auth_status='ok' WHERE id='claude'").run();
    const now = new Date("2026-04-10T10:00:00Z");
    recordReactiveAuthSuccess(db, "claude", telemetry, now);

    const row = db
      .prepare("SELECT auth_status, auth_last_success_at FROM backends WHERE id='claude'")
      .get() as { auth_status: string; auth_last_success_at: string };
    expect(row.auth_status).toBe("ok");
    expect(row.auth_last_success_at).toBe(now.toISOString());
    // No self-heal counted on an ok → ok transition.
    expect(telemetry.snapshot().claude?.self_heal_observed).toBeUndefined();
  });

  it("transitions expired → ok and records self-heal telemetry", () => {
    db.prepare(
      "UPDATE backends SET auth_status='expired', auth_detail='401', auth_first_expired_at='2026-04-09T00:00:00Z', auth_notified_at='2026-04-09T01:00:00Z', auth_notification_count=3, last_error='401' WHERE id='codex'",
    ).run();
    const now = new Date("2026-04-10T10:00:00Z");
    recordReactiveAuthSuccess(db, "codex", telemetry, now);

    const row = db
      .prepare(
        "SELECT auth_status, auth_detail, auth_first_expired_at, auth_notified_at, auth_notification_count, auth_last_success_at, last_error FROM backends WHERE id='codex'",
      )
      .get() as {
        auth_status: string;
        auth_detail: string | null;
        auth_first_expired_at: string | null;
        auth_notified_at: string | null;
        auth_notification_count: number;
        auth_last_success_at: string;
        last_error: string | null;
      };
    expect(row.auth_status).toBe("ok");
    expect(row.auth_detail).toBeNull();
    expect(row.auth_first_expired_at).toBeNull();
    expect(row.auth_notified_at).toBeNull();
    expect(row.auth_notification_count).toBe(0);
    expect(row.auth_last_success_at).toBe(now.toISOString());
    expect(row.last_error).toBeNull();
    expect(telemetry.snapshot().codex?.self_heal_observed).toBe(1);
  });

  it("transitions missing → ok and records self-heal telemetry", () => {
    db.prepare("UPDATE backends SET auth_status='missing' WHERE id='gemini'").run();
    recordReactiveAuthSuccess(db, "gemini", telemetry);
    expect(
      (db.prepare("SELECT auth_status FROM backends WHERE id='gemini'").get() as { auth_status: string }).auth_status,
    ).toBe("ok");
    expect(telemetry.snapshot().gemini?.self_heal_observed).toBe(1);
  });

  it("transitions unknown → ok (first-ever successful use) WITHOUT a self-heal bump", () => {
    // `unknown` is the initial state at daemon startup — reaching ok
    // from there is not a "recovery from a failure we saw" because we
    // never saw a failure. persistCheckResult has the same carve-out;
    // the reactive path must stay consistent with it.
    recordReactiveAuthSuccess(db, "claude", telemetry);
    const row = db
      .prepare("SELECT auth_status, auth_last_success_at FROM backends WHERE id='claude'")
      .get() as { auth_status: string; auth_last_success_at: string };
    expect(row.auth_status).toBe("ok");
    expect(row.auth_last_success_at).toBeTruthy();
    expect(telemetry.snapshot().claude?.self_heal_observed).toBeUndefined();
  });

  it("does NOT clobber a recovering row", () => {
    db.prepare(
      "UPDATE backends SET auth_status='recovering', auth_detail='in progress' WHERE id='codex'",
    ).run();
    recordReactiveAuthSuccess(db, "codex", telemetry);
    const row = db
      .prepare("SELECT auth_status, auth_detail, auth_last_success_at FROM backends WHERE id='codex'")
      .get() as { auth_status: string; auth_detail: string; auth_last_success_at: string | null };
    expect(row.auth_status).toBe("recovering");
    expect(row.auth_detail).toBe("in progress");
    expect(row.auth_last_success_at).toBeNull();
  });

  it("is a no-op when the row does not exist", () => {
    db.prepare("DELETE FROM backends WHERE id='gemini'").run();
    expect(() => recordReactiveAuthSuccess(db, "gemini", telemetry)).not.toThrow();
  });

  it("swallows DB errors without throwing", () => {
    db.exec("DROP TABLE backends");
    expect(() => recordReactiveAuthSuccess(db, "claude", telemetry)).not.toThrow();
  });
});

describe("failure-clearing DRY invariant (§2.1)", () => {
  // Snapshot-equivalence check: both the probe-path (persistCheckResult
  // ok branch) and the reactive-path (recordReactiveAuthSuccess non-ok
  // → ok branch) must leave the shared "failure bookkeeping" columns in
  // IDENTICAL states. This is the regression guard for the
  // CLEAR_FAILURE_BOOKKEEPING_SQL fragment — if a future contributor
  // adds a column to one path but forgets the other, this test fails.
  let db: Database.Database;
  let telemetry: AuthTelemetry;
  const fixedNow = new Date("2026-04-10T10:00:00Z");

  beforeEach(() => {
    db = new Database(":memory:");
    createBackendsSchema(db);
    telemetry = new AuthTelemetry(db);
  });

  afterEach(() => db.close());

  function seedExpiredRow(backendId: BackendId): void {
    db.prepare(
      `UPDATE backends
          SET auth_status = 'expired',
              auth_detail = 'seeded failure',
              auth_first_expired_at = '2026-04-09T08:00:00Z',
              auth_notified_at = '2026-04-09T09:00:00Z',
              auth_notification_count = 3,
              last_error = 'seeded failure'
        WHERE id = ?`,
    ).run(backendId);
  }

  type FailureColumns = {
    auth_first_expired_at: string | null;
    auth_notified_at: string | null;
    auth_notification_count: number;
    auth_last_success_at: string | null;
    auth_last_verified_at: string | null;
    last_error: string | null;
  };

  function readFailureColumns(backendId: BackendId): FailureColumns {
    return db
      .prepare(
        `SELECT auth_first_expired_at, auth_notified_at,
                auth_notification_count, auth_last_success_at,
                auth_last_verified_at, last_error
           FROM backends WHERE id = ?`,
      )
      .get(backendId) as FailureColumns;
  }

  it("reactive and probe paths clear identical columns when transitioning into ok", () => {
    // Two backends seeded to identical expired state.
    seedExpiredRow("codex");
    seedExpiredRow("gemini");

    // Path A — reactive success.
    recordReactiveAuthSuccess(db, "codex", telemetry, fixedNow);

    // Path B — probe success via persistCheckResult.
    const monitor = new AuthHealthMonitor(
      db,
      { gemini: fakeCore("gemini") },
      telemetry,
      { now: () => fixedNow },
    );
    monitor.persistCheckResult("gemini", {
      ok: true,
      status: "ok",
      method: "oauth",
    });

    const reactiveCols = readFailureColumns("codex");
    const probeCols = readFailureColumns("gemini");
    expect(reactiveCols).toEqual(probeCols);
    // Sanity: the shared state should be "fully cleared".
    expect(reactiveCols.auth_first_expired_at).toBeNull();
    expect(reactiveCols.auth_notified_at).toBeNull();
    expect(reactiveCols.auth_notification_count).toBe(0);
    expect(reactiveCols.last_error).toBeNull();
    expect(reactiveCols.auth_last_success_at).toBe(fixedNow.toISOString());
  });
});

describe("AuthHealthMonitor", () => {
  let db: Database.Database;
  let telemetry: AuthTelemetry;
  let notifier: { send: ReturnType<typeof vi.fn> };
  let monitor: AuthHealthMonitor;
  const fixedNow = new Date("2026-04-10T10:00:00Z");

  beforeEach(() => {
    db = new Database(":memory:");
    createBackendsSchema(db);
    telemetry = new AuthTelemetry(db);
    notifier = { send: vi.fn().mockResolvedValue(undefined) };
    monitor = new AuthHealthMonitor(
      db,
      {
        claude: fakeCore("claude"),
        codex: fakeCore("codex"),
        gemini: fakeCore("gemini"),
      },
      telemetry,
      {
        notifier,
        keepaliveThresholdDays: 60,
        keepaliveDedupeDays: 30,
        now: () => fixedNow,
      },
    );
  });

  afterEach(() => db.close());

  describe("persistCheckResult", () => {
    it("writes ok status and stamps last_success_at", () => {
      const result: AuthCheckResult = {
        ok: true,
        status: "ok",
        method: "oauth",
      };
      monitor.persistCheckResult("claude", result);

      const state = monitor.loadState("claude");
      expect(state?.status).toBe("ok");
      expect(state?.lastSuccessAt?.toISOString()).toBe(fixedNow.toISOString());
      expect(state?.firstExpiredAt).toBeNull();
    });

    it("records self-heal telemetry on non-ok → ok transition", () => {
      monitor.persistCheckResult("claude", {
        ok: false,
        status: "expired",
        method: "oauth",
      });
      monitor.persistCheckResult("claude", {
        ok: true,
        status: "ok",
        method: "oauth",
      });
      expect(telemetry.snapshot().claude?.self_heal_observed).toBe(1);
    });

    it("tags probe-path self-heals with source='probe'", () => {
      // Roadmap §2.6 — persistCheckResult is the Phase 4 hourly probe
      // entry point, so its self-heal observations must land in the
      // 'probe' source bucket. Contrast with recordReactiveAuthSuccess
      // which tags 'reactive'.
      monitor.persistCheckResult("claude", {
        ok: false,
        status: "expired",
        method: "oauth",
      });
      monitor.persistCheckResult("claude", {
        ok: true,
        status: "ok",
        method: "oauth",
      });
      const grouped = telemetry.snapshotBySource();
      expect(grouped.claude?.probe?.self_heal_observed).toBe(1);
      expect(grouped.claude?.reactive?.self_heal_observed).toBeUndefined();
    });

    it("does not record self-heal on first-ever ok", () => {
      monitor.persistCheckResult("claude", {
        ok: true,
        status: "ok",
        method: "oauth",
      });
      expect(telemetry.snapshot().claude?.self_heal_observed).toBeUndefined();
    });

    it("records first_expired_at once on ok → expired", () => {
      monitor.persistCheckResult("claude", {
        ok: true,
        status: "ok",
        method: "oauth",
      });
      monitor.persistCheckResult("claude", {
        ok: false,
        status: "expired",
        method: "oauth",
        detail: "401",
      });

      const state = monitor.loadState("claude");
      expect(state?.status).toBe("expired");
      expect(state?.firstExpiredAt?.toISOString()).toBe(fixedNow.toISOString());
      expect(state?.detail).toBe("401");
    });

    it("preserves first_expired_at across repeated expired updates", () => {
      const earlier = new Date("2026-04-10T08:00:00Z");
      db.prepare(
        "UPDATE backends SET auth_status='expired', auth_first_expired_at=?, auth_detail='old' WHERE id = 'claude'",
      ).run(earlier.toISOString());

      monitor.persistCheckResult("claude", {
        ok: false,
        status: "expired",
        method: "oauth",
        detail: "still expired",
      });

      const state = monitor.loadState("claude");
      expect(state?.firstExpiredAt?.toISOString()).toBe(earlier.toISOString());
      expect(state?.detail).toBe("still expired");
    });

    it("redacts token fragments in detail before writing", () => {
      monitor.persistCheckResult("claude", {
        ok: false,
        status: "expired",
        method: "oauth",
        detail: "Bearer sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ expired",
      });
      const state = monitor.loadState("claude");
      expect(state?.detail).not.toContain("sk-ant-");
      expect(state?.detail).toContain("[REDACTED]");
    });

    it("clears last_error on ok and sets it on non-ok (stays in sync with auth_detail)", () => {
      // Seed a stale last_error as if a prior reactive failure wrote it.
      db.prepare(
        "UPDATE backends SET last_error='old 401' WHERE id='claude'",
      ).run();

      // Non-ok: last_error should be rewritten to the new detail.
      monitor.persistCheckResult("claude", {
        ok: false,
        status: "expired",
        method: "oauth",
        detail: "new 401",
      });
      let row = db
        .prepare("SELECT last_error FROM backends WHERE id='claude'")
        .get() as { last_error: string | null };
      expect(row.last_error).toBe("new 401");

      // Then ok: last_error should clear.
      monitor.persistCheckResult("claude", {
        ok: true,
        status: "ok",
        method: "oauth",
      });
      row = db
        .prepare("SELECT last_error FROM backends WHERE id='claude'")
        .get() as { last_error: string | null };
      expect(row.last_error).toBeNull();
    });
  });

  describe("loadState", () => {
    it("returns null when no row exists", () => {
      db.prepare("DELETE FROM backends WHERE id = 'claude'").run();
      expect(monitor.loadState("claude")).toBeNull();
    });

    it("parses null timestamps", () => {
      const state = monitor.loadState("claude");
      expect(state?.status).toBe("unknown");
      expect(state?.checkedAt).toBeNull();
      expect(state?.notificationCount).toBe(0);
    });

    it("ignores invalid timestamps", () => {
      db.prepare(
        "UPDATE backends SET auth_checked_at='garbage', auth_first_expired_at='also bad' WHERE id='claude'",
      ).run();
      const state = monitor.loadState("claude");
      expect(state?.checkedAt).toBeNull();
      expect(state?.firstExpiredAt).toBeNull();
    });

  });

  describe("reconcilePendingRecoveries", () => {
    it("resets stuck recovering rows to expired", () => {
      db.prepare(
        "UPDATE backends SET auth_status='recovering' WHERE id='codex'",
      ).run();
      const changes = monitor.reconcilePendingRecoveries();
      expect(changes).toBe(1);
      expect(monitor.loadState("codex")?.status).toBe("expired");
      expect(monitor.loadState("codex")?.detail).toContain("daemon restart");
    });

    it("is a no-op when nothing is recovering", () => {
      expect(monitor.reconcilePendingRecoveries()).toBe(0);
    });
  });

  describe("listExpiredBackends", () => {
    it("returns only expired or missing rows", () => {
      db.prepare("UPDATE backends SET auth_status='expired' WHERE id='codex'").run();
      db.prepare("UPDATE backends SET auth_status='missing' WHERE id='gemini'").run();
      db.prepare("UPDATE backends SET auth_status='ok' WHERE id='claude'").run();
      expect(monitor.listExpiredBackends()).toEqual(["codex", "gemini"]);
    });

    it("excludes unknown backend ids (forward compat)", () => {
      db.prepare("INSERT INTO backends (id, auth_status, enabled) VALUES ('weird', 'expired', 1)").run();
      const ids = monitor.listExpiredBackends();
      expect(ids).not.toContain("weird");
    });

  });

  describe("renderStatusSummary", () => {
    it("renders an icon + detail for every configured backend", () => {
      db.prepare(
        "UPDATE backends SET auth_status='expired', auth_detail='401', auth_first_expired_at=? WHERE id='codex'",
      ).run("2026-04-09T18:23:00Z");

      const summary = monitor.renderStatusSummary();
      expect(summary).toContain("claude");
      expect(summary).toContain("codex");
      expect(summary).toContain("gemini");
      expect(summary).toContain("🔴");
      expect(summary).toContain("401");
      expect(summary).toContain("2026-04-09 18:23");
    });

    it("shows icons for every status type", () => {
      db.prepare("UPDATE backends SET auth_status='ok' WHERE id='claude'").run();
      db.prepare("UPDATE backends SET auth_status='expiring_soon' WHERE id='codex'").run();
      db.prepare("UPDATE backends SET auth_status='missing' WHERE id='gemini'").run();
      const summary = monitor.renderStatusSummary();
      expect(summary).toContain("✅");
      expect(summary).toContain("🟡");
      expect(summary).toContain("⚫");
    });

    it("shows a recovering icon", () => {
      db.prepare("UPDATE backends SET auth_status='recovering' WHERE id='codex'").run();
      expect(monitor.renderStatusSummary()).toContain("🔄");
    });

    it("shows an unknown icon for untouched rows", () => {
      expect(monitor.renderStatusSummary()).toContain("❓");
    });

    it("handles expired rows without first_expired_at or detail", () => {
      db.prepare(
        "UPDATE backends SET auth_status='expired', auth_first_expired_at=NULL, auth_detail=NULL WHERE id='codex'",
      ).run();
      const summary = monitor.renderStatusSummary();
      expect(summary).toContain("expired");
      expect(summary).not.toContain("(since");
    });

    it("renders 'unknown' for backends with no DB row", () => {
      db.prepare("DELETE FROM backends").run();
      const summary = monitor.renderStatusSummary();
      expect(summary).toContain("❓");
      expect(summary).toContain("unknown");
    });
  });

  describe("runKeepaliveSweep", () => {
    it("emits a reminder for long-idle backends", async () => {
      const lastSuccess = new Date(fixedNow.getTime() - 65 * 86_400_000);
      db.prepare(
        "UPDATE backends SET auth_status='ok', auth_last_success_at=? WHERE id='codex'",
      ).run(lastSuccess.toISOString());

      const reminded = await monitor.runKeepaliveSweep();
      expect(reminded).toEqual(["codex"]);
      expect(notifier.send).toHaveBeenCalledTimes(1);
      expect(notifier.send.mock.calls[0][0]).toContain("65 days");
      expect(telemetry.snapshot().codex?.keepalive_reminder_sent).toBe(1);

      const state = monitor.loadState("codex");
      expect(state?.keepaliveNotifiedAt?.toISOString()).toBe(fixedNow.toISOString());
    });

    it("skips recently-reminded backends", async () => {
      const lastSuccess = new Date(fixedNow.getTime() - 70 * 86_400_000);
      const recentNotify = new Date(fixedNow.getTime() - 10 * 86_400_000);
      db.prepare(
        "UPDATE backends SET auth_status='ok', auth_last_success_at=?, auth_keepalive_notified_at=? WHERE id='codex'",
      ).run(lastSuccess.toISOString(), recentNotify.toISOString());

      const reminded = await monitor.runKeepaliveSweep();
      expect(reminded).toEqual([]);
      expect(notifier.send).not.toHaveBeenCalled();
    });

    it("re-sends once the dedupe window expires", async () => {
      const lastSuccess = new Date(fixedNow.getTime() - 120 * 86_400_000);
      const staleNotify = new Date(fixedNow.getTime() - 40 * 86_400_000);
      db.prepare(
        "UPDATE backends SET auth_status='ok', auth_last_success_at=?, auth_keepalive_notified_at=? WHERE id='codex'",
      ).run(lastSuccess.toISOString(), staleNotify.toISOString());

      const reminded = await monitor.runKeepaliveSweep();
      expect(reminded).toEqual(["codex"]);
    });

    it("skips backends below the threshold", async () => {
      const lastSuccess = new Date(fixedNow.getTime() - 30 * 86_400_000);
      db.prepare(
        "UPDATE backends SET auth_status='ok', auth_last_success_at=? WHERE id='codex'",
      ).run(lastSuccess.toISOString());

      const reminded = await monitor.runKeepaliveSweep();
      expect(reminded).toEqual([]);
    });

    it("skips non-ok backends", async () => {
      const lastSuccess = new Date(fixedNow.getTime() - 120 * 86_400_000);
      db.prepare(
        "UPDATE backends SET auth_status='expired', auth_last_success_at=? WHERE id='codex'",
      ).run(lastSuccess.toISOString());

      const reminded = await monitor.runKeepaliveSweep();
      expect(reminded).toEqual([]);
    });

    it("skips when auth_last_success_at is null", async () => {
      db.prepare("UPDATE backends SET auth_status='ok' WHERE id='codex'").run();
      const reminded = await monitor.runKeepaliveSweep();
      expect(reminded).toEqual([]);
    });

    it("is a no-op when no notifier is configured", async () => {
      const noNotifier = new AuthHealthMonitor(
        db,
        { claude: fakeCore("claude") },
        telemetry,
        { now: () => fixedNow },
      );
      const lastSuccess = new Date(fixedNow.getTime() - 120 * 86_400_000);
      db.prepare(
        "UPDATE backends SET auth_status='ok', auth_last_success_at=? WHERE id='claude'",
      ).run(lastSuccess.toISOString());

      expect(await noNotifier.runKeepaliveSweep()).toEqual([]);
    });

    it("skips when row is missing", async () => {
      db.prepare("DELETE FROM backends WHERE id='codex'").run();
      const reminded = await monitor.runKeepaliveSweep();
      expect(reminded).not.toContain("codex");
    });
  });

  describe("constructor defaults", () => {
    const originalEnv = process.env.PA_AUTH_KEEPALIVE_DAYS;
    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.PA_AUTH_KEEPALIVE_DAYS;
      } else {
        process.env.PA_AUTH_KEEPALIVE_DAYS = originalEnv;
      }
    });

    it("uses the default clock when 'now' is not provided", () => {
      const m = new AuthHealthMonitor(db, {}, telemetry);
      const before = Date.now();
      m.reconcilePendingRecoveries();
      expect(Date.now()).toBeGreaterThanOrEqual(before);
    });

    it("honors PA_AUTH_KEEPALIVE_DAYS from env", async () => {
      process.env.PA_AUTH_KEEPALIVE_DAYS = "10";
      const m = new AuthHealthMonitor(
        db,
        { codex: fakeCore("codex") },
        telemetry,
        { notifier, now: () => fixedNow },
      );
      const lastSuccess = new Date(fixedNow.getTime() - 12 * 86_400_000);
      db.prepare(
        "UPDATE backends SET auth_status='ok', auth_last_success_at=? WHERE id='codex'",
      ).run(lastSuccess.toISOString());
      const reminded = await m.runKeepaliveSweep();
      expect(reminded).toEqual(["codex"]);
    });

    it("ignores invalid PA_AUTH_KEEPALIVE_DAYS and falls back to 60", async () => {
      process.env.PA_AUTH_KEEPALIVE_DAYS = "not-a-number";
      const m = new AuthHealthMonitor(
        db,
        { codex: fakeCore("codex") },
        telemetry,
        { notifier, now: () => fixedNow },
      );
      const lastSuccess = new Date(fixedNow.getTime() - 30 * 86_400_000);
      db.prepare(
        "UPDATE backends SET auth_status='ok', auth_last_success_at=? WHERE id='codex'",
      ).run(lastSuccess.toISOString());
      expect(await m.runKeepaliveSweep()).toEqual([]);
    });

    it("ignores PA_AUTH_KEEPALIVE_DAYS <= 0", async () => {
      process.env.PA_AUTH_KEEPALIVE_DAYS = "0";
      const m = new AuthHealthMonitor(
        db,
        { codex: fakeCore("codex") },
        telemetry,
        { notifier, now: () => fixedNow },
      );
      const lastSuccess = new Date(fixedNow.getTime() - 30 * 86_400_000);
      db.prepare(
        "UPDATE backends SET auth_status='ok', auth_last_success_at=? WHERE id='codex'",
      ).run(lastSuccess.toISOString());
      // 0 is falsy-positive → falls back to 60; 30 days is below threshold
      expect(await m.runKeepaliveSweep()).toEqual([]);
    });
  });

  // ── Phase 4: checkAll() hourly probe + grace period + escalation ──
  //
  // These tests cover §3.1, §3.2, §3.4, §3.5 of the design spec plus the
  // reactive → proactive handoff path (§5.3). Every test threads a fake
  // clock, fake cores with controlled `checkAuthDetailed` return values,
  // and the base `notifier` mock from the outer beforeEach.
  describe("checkAll (Phase 4)", () => {
    // Typed wrappers for the fake cores so we can tweak `checkAuthDetailed`
    // per test without re-constructing the monitor.
    type MockedCore = IAgentCore & {
      checkAuthDetailed: ReturnType<typeof vi.fn>;
    };
    let claudeCore: MockedCore;
    let codexCore: MockedCore;
    let geminiCore: MockedCore;
    let clock: Date;
    let monitorP4: AuthHealthMonitor;

    // Options that each test can override piecemeal. The defaults match
    // the production wiring in index.ts: morning-routine inactive, quiet
    // hours off, probe enabled.
    let gates: {
      isMorningRoutineActive: ReturnType<typeof vi.fn<() => boolean>>;
      isQuietHours: ReturnType<typeof vi.fn<() => boolean>>;
      probeDisabled: ReturnType<typeof vi.fn<() => boolean>>;
    };

    function buildMonitor(): AuthHealthMonitor {
      return new AuthHealthMonitor(
        db,
        { claude: claudeCore, codex: codexCore, gemini: geminiCore },
        telemetry,
        {
          notifier,
          now: () => clock,
          isMorningRoutineActive: () => gates.isMorningRoutineActive(),
          isQuietHours: () => gates.isQuietHours(),
          probeDisabled: () => gates.probeDisabled(),
        },
      );
    }

    beforeEach(() => {
      claudeCore = fakeCore("claude") as MockedCore;
      codexCore = fakeCore("codex") as MockedCore;
      geminiCore = fakeCore("gemini") as MockedCore;
      // Default: every backend reports ok.
      for (const core of [claudeCore, codexCore, geminiCore]) {
        core.checkAuthDetailed = vi.fn().mockResolvedValue({
          ok: true,
          status: "ok",
          method: "oauth",
        } as AuthCheckResult);
      }
      gates = {
        isMorningRoutineActive: vi.fn().mockReturnValue(false),
        isQuietHours: vi.fn().mockReturnValue(false),
        probeDisabled: vi.fn().mockReturnValue(false),
      };
      clock = new Date("2026-04-10T10:00:00Z");
      monitorP4 = buildMonitor();
    });

    it("persists probe results to the DB for every backend and sends no DM when all ok", async () => {
      await monitorP4.checkAll();
      expect(notifier.send).not.toHaveBeenCalled();
      for (const id of ["claude", "codex", "gemini"] as const) {
        const state = monitorP4.loadState(id);
        expect(state?.status).toBe("ok");
        expect(state?.checkedAt?.toISOString()).toBe(clock.toISOString());
        // probe_ok telemetry bumped per backend.
        expect(telemetry.snapshot()[id]?.probe_ok).toBe(1);
      }
    });

    it("on first observation of expired: stamps first_expired_at but does NOT notify", async () => {
      codexCore.checkAuthDetailed = vi.fn().mockResolvedValue({
        ok: false,
        status: "expired",
        method: "oauth",
        detail: "OAuth session expired",
      } as AuthCheckResult);

      await monitorP4.checkAll();
      expect(notifier.send).not.toHaveBeenCalled();
      const state = monitorP4.loadState("codex");
      expect(state?.status).toBe("expired");
      expect(state?.firstExpiredAt?.toISOString()).toBe(clock.toISOString());
      expect(state?.notifiedAt).toBeNull();
      expect(state?.notificationCount).toBe(0);
      expect(telemetry.snapshot().codex?.probe_unauthorized).toBe(1);
    });

    it("grace period boundary: 29 minutes after reactive failure does NOT notify", async () => {
      const reactiveTime = new Date("2026-04-10T09:31:00Z");
      recordReactiveAuthFailure(db, "codex", "runtime 401", telemetry, reactiveTime);
      // Probe still sees expired.
      codexCore.checkAuthDetailed = vi.fn().mockResolvedValue({
        ok: false,
        status: "expired",
        method: "oauth",
        detail: "401 Unauthorized",
      } as AuthCheckResult);

      // 29 minutes after the reactive stamp — below grace period.
      clock = new Date("2026-04-10T10:00:00Z");
      monitorP4 = buildMonitor();
      await monitorP4.checkAll();
      expect(notifier.send).not.toHaveBeenCalled();
      const state = monitorP4.loadState("codex");
      expect(state?.notifiedAt).toBeNull();
    });

    it("grace period boundary: 31 minutes after reactive failure DOES notify once", async () => {
      const reactiveTime = new Date("2026-04-10T09:29:00Z");
      recordReactiveAuthFailure(db, "codex", "runtime 401", telemetry, reactiveTime);
      codexCore.checkAuthDetailed = vi.fn().mockResolvedValue({
        ok: false,
        status: "expired",
        method: "oauth",
        detail: "401 Unauthorized",
      } as AuthCheckResult);

      // 31 minutes past first expiry → grace elapsed, notify.
      clock = new Date("2026-04-10T10:00:00Z");
      monitorP4 = buildMonitor();
      await monitorP4.checkAll();
      expect(notifier.send).toHaveBeenCalledTimes(1);
      const [message, options] = notifier.send.mock.calls[0];
      expect(message).toContain("codex");
      expect(message).toContain("401 Unauthorized");
      expect(message).toContain("codex login");
      expect(options).toEqual({ kind: "probe_failure" });

      const state = monitorP4.loadState("codex");
      expect(state?.notificationCount).toBe(1);
      expect(state?.notifiedAt?.toISOString()).toBe(clock.toISOString());
    });

    it("escalation: 2nd DM fires 6h after the 1st, not before", async () => {
      // Seed a "1st DM already sent 5h ago" state.
      db.prepare(
        `UPDATE backends
            SET auth_status='expired',
                auth_first_expired_at=?,
                auth_notified_at=?,
                auth_notification_count=1
          WHERE id='codex'`,
      ).run(
        new Date("2026-04-10T00:00:00Z").toISOString(),
        new Date("2026-04-10T05:00:00Z").toISOString(),
      );
      codexCore.checkAuthDetailed = vi.fn().mockResolvedValue({
        ok: false,
        status: "expired",
        method: "oauth",
        detail: "still 401",
      } as AuthCheckResult);

      // 5h59m since 1st DM — below escalation threshold.
      clock = new Date("2026-04-10T10:59:00Z");
      monitorP4 = buildMonitor();
      await monitorP4.checkAll();
      expect(notifier.send).not.toHaveBeenCalled();

      // 6h01m since 1st DM — escalation threshold crossed.
      clock = new Date("2026-04-10T11:01:00Z");
      monitorP4 = buildMonitor();
      await monitorP4.checkAll();
      expect(notifier.send).toHaveBeenCalledTimes(1);
      expect(monitorP4.loadState("codex")?.notificationCount).toBe(2);
    });

    it("escalation: 3rd DM fires 24h after the 2nd, not before", async () => {
      db.prepare(
        `UPDATE backends
            SET auth_status='expired',
                auth_first_expired_at=?,
                auth_notified_at=?,
                auth_notification_count=2
          WHERE id='codex'`,
      ).run(
        new Date("2026-04-09T00:00:00Z").toISOString(),
        new Date("2026-04-10T06:00:00Z").toISOString(),
      );
      codexCore.checkAuthDetailed = vi.fn().mockResolvedValue({
        ok: false,
        status: "expired",
        method: "oauth",
        detail: "still 401",
      } as AuthCheckResult);

      // 23h59m since 2nd DM.
      clock = new Date("2026-04-11T05:59:00Z");
      monitorP4 = buildMonitor();
      await monitorP4.checkAll();
      expect(notifier.send).not.toHaveBeenCalled();

      // 24h01m since 2nd DM — escalation fires (count is clamped to last step).
      clock = new Date("2026-04-11T06:01:00Z");
      monitorP4 = buildMonitor();
      await monitorP4.checkAll();
      expect(notifier.send).toHaveBeenCalledTimes(1);
      expect(monitorP4.loadState("codex")?.notificationCount).toBe(3);
    });

    it("3-day tone escalation sharpens the DM header (M4: split header vs since assertions)", async () => {
      // 3 days + 9h past first expiry, 1st DM fired 10h ago.
      const firstExpired = new Date("2026-04-07T05:00:00Z");
      const firstNotified = new Date("2026-04-10T04:00:00Z");
      db.prepare(
        `UPDATE backends
            SET auth_status='expired',
                auth_first_expired_at=?,
                auth_notified_at=?,
                auth_notification_count=1
          WHERE id='codex'`,
      ).run(firstExpired.toISOString(), firstNotified.toISOString());
      codexCore.checkAuthDetailed = vi.fn().mockResolvedValue({
        ok: false,
        status: "expired",
        method: "oauth",
        detail: "still 401",
      } as AuthCheckResult);

      // 10h after 1st DM → past the 6h escalation step.
      clock = new Date("2026-04-10T14:00:00Z");
      monitorP4 = buildMonitor();
      await monitorP4.checkAll();
      const [message] = notifier.send.mock.calls[0];
      // HEADER must contain the sharpened tone marker and the
      // "Authentication has not been recovered for 3+ days" phrase.
      expect(message).toContain("⚠️");
      expect(message).toContain("Authentication has not been recovered for 3+ days");
      // PER-BACKEND "since" line must show the actual duration
      // ("3d 9h") — separate assertion so header regressions
      // can't hide behind the since-line substring match.
      expect(message).toContain("3d 9h");
    });

    // ── B1: 1st DM bypasses quiet hours, escalations respect them ──
    //
    // Spec §3.3 table: only the +24h escalation row mentions
    // "quiet hours excluded"; the 1st DM fires at 30min regardless of
    // quiet hours because surfacing the initial failure outweighs
    // DM politeness. These three tests lock in that asymmetry.
    it("B1 (§3.3): 1st DM bypasses quiet hours", async () => {
      const reactiveTime = new Date("2026-04-10T09:00:00Z");
      recordReactiveAuthFailure(db, "codex", "401", telemetry, reactiveTime);
      codexCore.checkAuthDetailed = vi.fn().mockResolvedValue({
        ok: false,
        status: "expired",
        method: "oauth",
        detail: "still 401",
      } as AuthCheckResult);
      gates.isQuietHours.mockReturnValue(true);

      // 1h past reactive failure — grace period elapsed.
      clock = new Date("2026-04-10T10:00:00Z");
      monitorP4 = buildMonitor();
      await monitorP4.checkAll();

      // DM was sent despite quiet hours (1st DM bypass).
      expect(notifier.send).toHaveBeenCalledTimes(1);
      const [, options] = notifier.send.mock.calls[0];
      // `kind: "probe_failure"` is what the index.ts wiring maps to
      // NotificationManager's SAFETY category bypass, so the lower
      // layer doesn't silently drop the DM during its own quiet-hours
      // check. Verify we're passing the right kind.
      expect(options).toEqual({ kind: "probe_failure" });

      const state = monitorP4.loadState("codex");
      expect(state?.notificationCount).toBe(1);
      expect(state?.notifiedAt?.toISOString()).toBe(clock.toISOString());
    });

    it("B1 (§3.3): escalation DMs ARE suppressed by quiet hours", async () => {
      // Seed "1st DM already sent 7h ago" — past the 6h escalation step.
      db.prepare(
        `UPDATE backends
            SET auth_status='expired',
                auth_first_expired_at=?,
                auth_notified_at=?,
                auth_notification_count=1
          WHERE id='codex'`,
      ).run(
        new Date("2026-04-10T00:00:00Z").toISOString(),
        new Date("2026-04-10T03:00:00Z").toISOString(),
      );
      codexCore.checkAuthDetailed = vi.fn().mockResolvedValue({
        ok: false,
        status: "expired",
        method: "oauth",
        detail: "still 401",
      } as AuthCheckResult);
      gates.isQuietHours.mockReturnValue(true);

      // 7h after 1st DM — past 6h escalation but quiet hours on.
      clock = new Date("2026-04-10T10:00:00Z");
      monitorP4 = buildMonitor();
      await monitorP4.checkAll();
      expect(notifier.send).not.toHaveBeenCalled();

      // notification_count must stay at 1 — the escalation was
      // deferred, not consumed. Next non-quiet tick will fire the 2nd DM.
      const state = monitorP4.loadState("codex");
      expect(state?.notificationCount).toBe(1);
    });

    it("B1: probe results persist during quiet hours regardless of notification gating", async () => {
      // This test verifies the invariant that quiet-hours blocking
      // the DM never blocks the DB cache update, so /auth status and
      // the dashboard always reflect ground truth.
      const reactiveTime = new Date("2026-04-10T00:00:00Z");
      recordReactiveAuthFailure(db, "codex", "401", telemetry, reactiveTime);
      // Seed "1st DM already sent 7h ago" so quiet hours actually blocks
      // (1st DM would bypass quiet hours per B1).
      db.prepare(
        `UPDATE backends
            SET auth_notified_at=?, auth_notification_count=1
          WHERE id='codex'`,
      ).run(new Date("2026-04-10T03:00:00Z").toISOString());
      codexCore.checkAuthDetailed = vi.fn().mockResolvedValue({
        ok: false,
        status: "expired",
        method: "oauth",
        detail: "still 401 — probed during quiet hours",
      } as AuthCheckResult);
      gates.isQuietHours.mockReturnValue(true);

      clock = new Date("2026-04-10T10:00:00Z");
      monitorP4 = buildMonitor();
      await monitorP4.checkAll();

      // DM suppressed (escalation + quiet hours) …
      expect(notifier.send).not.toHaveBeenCalled();
      // … but the probe still ran and persisted fresh state.
      expect(codexCore.checkAuthDetailed).toHaveBeenCalledTimes(1);
      const state = monitorP4.loadState("codex");
      expect(state?.status).toBe("expired");
      expect(state?.checkedAt?.toISOString()).toBe(clock.toISOString());
      expect(state?.detail).toBe("still 401 — probed during quiet hours");
    });

    it("is a no-op when morning routine is active — no probes run", async () => {
      gates.isMorningRoutineActive.mockReturnValue(true);
      await monitorP4.checkAll();
      expect(claudeCore.checkAuthDetailed).not.toHaveBeenCalled();
      expect(codexCore.checkAuthDetailed).not.toHaveBeenCalled();
      expect(geminiCore.checkAuthDetailed).not.toHaveBeenCalled();
      expect(notifier.send).not.toHaveBeenCalled();
    });

    it("is a no-op when probeDisabled kill switch is on", async () => {
      gates.probeDisabled.mockReturnValue(true);
      await monitorP4.checkAll();
      expect(claudeCore.checkAuthDetailed).not.toHaveBeenCalled();
      expect(codexCore.checkAuthDetailed).not.toHaveBeenCalled();
      expect(geminiCore.checkAuthDetailed).not.toHaveBeenCalled();
    });

    it("skips a backend whose cached status is 'recovering'", async () => {
      db.prepare(
        "UPDATE backends SET auth_status='recovering' WHERE id='codex'",
      ).run();
      await monitorP4.checkAll();
      expect(codexCore.checkAuthDetailed).not.toHaveBeenCalled();
      // Claude + Gemini still probed.
      expect(claudeCore.checkAuthDetailed).toHaveBeenCalledTimes(1);
      expect(geminiCore.checkAuthDetailed).toHaveBeenCalledTimes(1);
      // The recovering row is untouched by the probe.
      expect(monitorP4.loadState("codex")?.status).toBe("recovering");
    });

    it("records probe_network_error and leaves DB cache untouched on probe exception", async () => {
      codexCore.checkAuthDetailed = vi
        .fn()
        .mockRejectedValue(new Error("ECONNRESET"));
      // Seed a prior known state so we can assert it survives.
      db.prepare(
        "UPDATE backends SET auth_status='ok', auth_last_success_at=? WHERE id='codex'",
      ).run(new Date("2026-04-09T00:00:00Z").toISOString());
      await monitorP4.checkAll();
      const state = monitorP4.loadState("codex");
      expect(state?.status).toBe("ok");
      expect(telemetry.snapshot().codex?.probe_network_error).toBe(1);
      // No notification even though one backend threw.
      expect(notifier.send).not.toHaveBeenCalled();
    });

    it("aggregates multiple failing backends into a single DM (§3.5 dedupe)", async () => {
      // Reactive path stamped both backends 1h ago; grace period already elapsed.
      const reactiveTime = new Date("2026-04-10T09:00:00Z");
      recordReactiveAuthFailure(db, "codex", "codex 401", telemetry, reactiveTime);
      recordReactiveAuthFailure(db, "gemini", "gemini 401", telemetry, reactiveTime);
      codexCore.checkAuthDetailed = vi.fn().mockResolvedValue({
        ok: false, status: "expired", method: "oauth", detail: "codex still 401",
      } as AuthCheckResult);
      geminiCore.checkAuthDetailed = vi.fn().mockResolvedValue({
        ok: false, status: "expired", method: "oauth", detail: "gemini still 401",
      } as AuthCheckResult);

      clock = new Date("2026-04-10T10:00:00Z");
      monitorP4 = buildMonitor();
      await monitorP4.checkAll();
      expect(notifier.send).toHaveBeenCalledTimes(1);
      const [message] = notifier.send.mock.calls[0];
      expect(message).toContain("codex");
      expect(message).toContain("gemini");
      expect(message).toContain("codex login");
      expect(message).toContain("gemini");
      // Both rows have the notified_at stamp bumped.
      expect(monitorP4.loadState("codex")?.notificationCount).toBe(1);
      expect(monitorP4.loadState("gemini")?.notificationCount).toBe(1);
    });

    it("does NOT stamp notified_at when the notifier throws (retry next tick)", async () => {
      const reactiveTime = new Date("2026-04-10T09:00:00Z");
      recordReactiveAuthFailure(db, "codex", "401", telemetry, reactiveTime);
      codexCore.checkAuthDetailed = vi.fn().mockResolvedValue({
        ok: false, status: "expired", method: "oauth", detail: "still 401",
      } as AuthCheckResult);
      notifier.send = vi.fn().mockRejectedValue(new Error("DM failed"));

      clock = new Date("2026-04-10T10:00:00Z");
      monitorP4 = buildMonitor();
      await monitorP4.checkAll();
      const state = monitorP4.loadState("codex");
      // Probe result is persisted …
      expect(state?.status).toBe("expired");
      // … but escalation bookkeeping is NOT advanced.
      expect(state?.notifiedAt).toBeNull();
      expect(state?.notificationCount).toBe(0);
    });

    it("M3: concurrent checkAll() calls are deduped — the second awaits the first", async () => {
      // M3: Gate ALL cores with the same gate Promise so the test
      // doesn't depend on `getBackendIds()` putting any specific
      // backend first. The probe loop is serial; whichever backend
      // is iterated first will block the loop on the gate, and the
      // assertion-time call count will always be exactly 1.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const gatedImpl = vi.fn(async () => {
        await gate;
        return {
          ok: true,
          status: "ok",
          method: "oauth",
        } as AuthCheckResult;
      });
      claudeCore.checkAuthDetailed = gatedImpl;
      codexCore.checkAuthDetailed = gatedImpl;
      geminiCore.checkAuthDetailed = gatedImpl;

      const first = monitorP4.checkAll();
      const second = monitorP4.checkAll();
      // Only the first iteration of the loop has fired so far —
      // subsequent backends are blocked on the gate-awaiting first one.
      expect(gatedImpl).toHaveBeenCalledTimes(1);

      release();
      await Promise.all([first, second]);
      // After release: the loop drains all 3 backends (gate is now
      // resolved, so each await is immediate). The SECOND call to
      // checkAll() is still deduped — gatedImpl total is 3, not 6.
      expect(gatedImpl).toHaveBeenCalledTimes(3);
    });

    it("M6: disabled backend is skipped at iteration (no probe, no DM, no state change)", async () => {
      // M6: After the iteration-level filter, disabled backends are
      // never even probed. This matches `runKeepaliveSweep` and saves
      // CLI subprocess cost. Stale cache for a re-enabled backend
      // gets reseeded by the reactive path on first use, or by the
      // dashboard's "Check auth" button — no need to keep probing
      // every hour for an off backend.
      db.prepare("UPDATE backends SET enabled = 0 WHERE id = 'codex'").run();
      // Seed a state so we can prove it survives untouched.
      const sentinelExpiry = new Date("2026-04-09T00:00:00Z");
      db.prepare(
        "UPDATE backends SET auth_status='expired', auth_first_expired_at=?, auth_checked_at=? WHERE id='codex'",
      ).run(sentinelExpiry.toISOString(), sentinelExpiry.toISOString());
      codexCore.checkAuthDetailed = vi.fn().mockResolvedValue({
        ok: false,
        status: "expired",
        method: "oauth",
        detail: "still 401",
      } as AuthCheckResult);

      clock = new Date("2026-04-10T10:00:00Z");
      monitorP4 = buildMonitor();
      await monitorP4.checkAll();

      // Probe never ran — iteration filter excluded it entirely.
      expect(codexCore.checkAuthDetailed).not.toHaveBeenCalled();
      // The seeded state is exactly as we left it.
      const state = monitorP4.loadState("codex");
      expect(state?.status).toBe("expired");
      expect(state?.firstExpiredAt?.toISOString()).toBe(sentinelExpiry.toISOString());
      expect(state?.checkedAt?.toISOString()).toBe(sentinelExpiry.toISOString());
      // No DM, no escalation bump.
      expect(notifier.send).not.toHaveBeenCalled();
      expect(state?.notifiedAt).toBeNull();
      expect(state?.notificationCount).toBe(0);
      // Telemetry: no probe_* counters for codex.
      const codexTel = telemetry.snapshot().codex ?? {};
      expect(codexTel.probe_ok).toBeUndefined();
      expect(codexTel.probe_unauthorized).toBeUndefined();
      expect(codexTel.probe_network_error).toBeUndefined();
      // Claude + Gemini still probed normally.
      expect(claudeCore.checkAuthDetailed).toHaveBeenCalledTimes(1);
      expect(geminiCore.checkAuthDetailed).toHaveBeenCalledTimes(1);
    });

    it("D3: grace period spans a morning routine — DM defers to next non-skipped tick", async () => {
      // D3: this verifies that the morning-routine skip doesn't
      // permanently consume a 1st DM that should fire — it just
      // delays it until the next clean tick.
      const reactiveTime = new Date("2026-04-10T03:00:00Z");
      recordReactiveAuthFailure(db, "codex", "401", telemetry, reactiveTime);
      codexCore.checkAuthDetailed = vi.fn().mockResolvedValue({
        ok: false,
        status: "expired",
        method: "oauth",
        detail: "still 401",
      } as AuthCheckResult);

      // Tick 1 (04:00 hour): grace already elapsed (1h), but morning
      // routine is active → entire checkAll is skipped, no probe, no DM.
      clock = new Date("2026-04-10T04:00:00Z");
      monitorP4 = buildMonitor();
      gates.isMorningRoutineActive.mockReturnValue(true);
      await monitorP4.checkAll();
      expect(codexCore.checkAuthDetailed).not.toHaveBeenCalled();
      expect(notifier.send).not.toHaveBeenCalled();
      // bookkeeping must NOT have advanced — the next tick should
      // see the same prev state.
      let state = monitorP4.loadState("codex");
      expect(state?.notifiedAt).toBeNull();
      expect(state?.notificationCount).toBe(0);

      // Tick 2 (05:00 hour): morning routine has finished. The same
      // prev state still satisfies shouldNotify (1st DM, grace
      // elapsed) → DM fires.
      clock = new Date("2026-04-10T05:00:00Z");
      monitorP4 = buildMonitor();
      gates.isMorningRoutineActive.mockReturnValue(false);
      await monitorP4.checkAll();
      expect(codexCore.checkAuthDetailed).toHaveBeenCalledTimes(1);
      expect(notifier.send).toHaveBeenCalledTimes(1);
      state = monitorP4.loadState("codex");
      expect(state?.notificationCount).toBe(1);
    });

    it("B3: morning routine that becomes active mid-tick defers the DM (re-check before notify)", async () => {
      // B3: the initial gate fires before the probe loop. We
      // simulate the routine starting AFTER probes finish but
      // BEFORE notifier.send. The probe results must persist; the
      // DM must defer.
      const reactiveTime = new Date("2026-04-10T09:00:00Z");
      recordReactiveAuthFailure(db, "codex", "401", telemetry, reactiveTime);
      // Use a counter to flip isMorningRoutineActive between calls:
      // 1st call (initial gate, before probes) → false
      // 2nd call (re-check, just before notifier.send) → true
      let routineCallCount = 0;
      gates.isMorningRoutineActive.mockImplementation(() => {
        routineCallCount += 1;
        return routineCallCount >= 2;
      });
      codexCore.checkAuthDetailed = vi.fn().mockResolvedValue({
        ok: false,
        status: "expired",
        method: "oauth",
        detail: "still 401",
      } as AuthCheckResult);

      clock = new Date("2026-04-10T10:00:00Z");
      monitorP4 = buildMonitor();
      await monitorP4.checkAll();

      // Probe ran (initial gate let us through) and persisted …
      expect(codexCore.checkAuthDetailed).toHaveBeenCalledTimes(1);
      const state = monitorP4.loadState("codex");
      expect(state?.status).toBe("expired");
      expect(state?.checkedAt?.toISOString()).toBe(clock.toISOString());
      // … but the DM was deferred when the re-check tripped.
      expect(notifier.send).not.toHaveBeenCalled();
      // notification_count must NOT advance — next tick will retry.
      expect(state?.notifiedAt).toBeNull();
      expect(state?.notificationCount).toBe(0);
      // The re-check fired exactly once (in addition to the initial gate).
      expect(routineCallCount).toBe(2);
    });

    it("M1: persistCheckResult DB failure does NOT mislabel as network_error", async () => {
      // M1: prior implementation wrapped persistCheckResult inside
      // the probe try/catch, so a DB lock during persist would bump
      // probe_network_error. The fix splits the try blocks. Verify
      // by simulating a DB write failure (drop the table after the
      // probe returns, before persistCheckResult runs).
      codexCore.checkAuthDetailed = vi.fn(async () => {
        // Drop the table mid-probe so persistCheckResult below fails.
        // This is the cleanest way to force a SQL exception inside
        // persistCheckResult without monkey-patching the prepared
        // statement cache.
        db.exec("ALTER TABLE backends RENAME TO backends_real");
        return {
          ok: false,
          status: "expired",
          method: "oauth",
          detail: "401",
        } as AuthCheckResult;
      });

      clock = new Date("2026-04-10T10:00:00Z");
      monitorP4 = buildMonitor();
      // checkAll itself must not throw — failures are logged, not propagated.
      await expect(monitorP4.checkAll()).resolves.toBeUndefined();

      // Restore the table so the rest of the test (and afterEach) works.
      db.exec("ALTER TABLE backends_real RENAME TO backends");

      const tel = telemetry.snapshot().codex ?? {};
      // probe_unauthorized was bumped (the probe SAID expired) …
      expect(tel.probe_unauthorized).toBe(1);
      // … but probe_network_error was NOT bumped (the failure was
      // a DB write error, not a probe network issue).
      expect(tel.probe_network_error).toBeUndefined();
    });

    it("M2: loadState raising during snapshot does NOT abort the entire sweep", async () => {
      // M2: prior implementation called loadState() in a bare loop;
      // an SqliteError on one row would abort the sweep before
      // probing the others. The fix wraps it per-backend in
      // try/catch, treating failure as `null` snapshot.
      //
      // Simulate by spying on db.prepare for the loadState query
      // and making the first call throw. Subsequent calls (for
      // other backends) should succeed.
      const realPrepare = db.prepare.bind(db);
      let loadStateCalls = 0;
      const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
        if (
          sql.includes("FROM backends")
          && sql.includes("WHERE id = ?")
          && !sql.toLowerCase().startsWith("update")
        ) {
          loadStateCalls += 1;
          if (loadStateCalls === 1) {
            throw new Error("simulated loadState SqliteError");
          }
        }
        return realPrepare(sql);
      });

      try {
        await expect(monitorP4.checkAll()).resolves.toBeUndefined();
      } finally {
        spy.mockRestore();
      }

      // The sweep continued past the failing snapshot — at least one
      // probe ran. (Total count depends on how many loadState calls
      // existed before the spy first matched.)
      const totalProbes =
        (claudeCore.checkAuthDetailed as ReturnType<typeof vi.fn>).mock.calls.length
        + (codexCore.checkAuthDetailed as ReturnType<typeof vi.fn>).mock.calls.length
        + (geminiCore.checkAuthDetailed as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(totalProbes).toBeGreaterThanOrEqual(2);
    });

    it("probe result ok clears first_expired_at and emits self-heal telemetry", async () => {
      const reactiveTime = new Date("2026-04-10T09:00:00Z");
      recordReactiveAuthFailure(db, "codex", "401", telemetry, reactiveTime);
      codexCore.checkAuthDetailed = vi.fn().mockResolvedValue({
        ok: true, status: "ok", method: "oauth",
      } as AuthCheckResult);

      clock = new Date("2026-04-10T10:00:00Z");
      monitorP4 = buildMonitor();
      await monitorP4.checkAll();
      const state = monitorP4.loadState("codex");
      expect(state?.status).toBe("ok");
      expect(state?.firstExpiredAt).toBeNull();
      // persistCheckResult tags the self-heal as `probe` source.
      const bySource = telemetry.snapshotBySource();
      expect(bySource.codex?.probe?.self_heal_observed).toBe(1);
    });

    it("notification message uses 'claude auth login' for claude backend (defaultRecoveryCommand)", async () => {
      // Set claude backend to expired with 1st DM already sent (triggers escalation message).
      const firstExpired = new Date("2026-04-09T10:00:00Z");
      const firstNotified = new Date("2026-04-10T03:00:00Z");
      db.prepare(
        `UPDATE backends
            SET auth_status='expired',
                auth_first_expired_at=?,
                auth_notified_at=?,
                auth_notification_count=1
          WHERE id='claude'`,
      ).run(firstExpired.toISOString(), firstNotified.toISOString());
      claudeCore.checkAuthDetailed = vi.fn().mockResolvedValue({
        ok: false,
        status: "expired",
        method: "cli_login",
        detail: "token expired",
      } as AuthCheckResult);

      // 8h after 1st DM (past 6h escalation step).
      clock = new Date("2026-04-10T11:00:00Z");
      monitorP4 = buildMonitor();
      await monitorP4.checkAll();

      expect(notifier.send).toHaveBeenCalledTimes(1);
      const [message] = notifier.send.mock.calls[0];
      expect(message).toContain("claude auth login");
    });

    it("notification message uses days-only format when elapsed is an exact multiple of 24h", async () => {
      // Exactly 3 days: firstExpired 72h before clock.
      const firstExpired = new Date("2026-04-07T14:00:00Z");
      const firstNotified = new Date("2026-04-10T07:00:00Z");
      db.prepare(
        `UPDATE backends
            SET auth_status='expired',
                auth_first_expired_at=?,
                auth_notified_at=?,
                auth_notification_count=1
          WHERE id='codex'`,
      ).run(firstExpired.toISOString(), firstNotified.toISOString());
      codexCore.checkAuthDetailed = vi.fn().mockResolvedValue({
        ok: false,
        status: "expired",
        method: "oauth",
        detail: "still 401",
      } as AuthCheckResult);

      // Exactly 3 days after firstExpired — produces "3d" with no hour component.
      clock = new Date("2026-04-10T14:00:00Z");
      monitorP4 = buildMonitor();
      await monitorP4.checkAll();

      expect(notifier.send).toHaveBeenCalledTimes(1);
      const [message] = notifier.send.mock.calls[0];
      // "3d" without trailing hour.
      expect(message).toMatch(/\b3d\b(?! \d+h)/);
    });
  });
});

// ---------------------------------------------------------------------------
// readCachedAuthStatus — Phase 3.3 pre-flight cache check
// ---------------------------------------------------------------------------

describe("readCachedAuthStatus (§3.3 pre-flight)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    createBackendsSchema(db);
  });
  afterEach(() => db.close());

  function setBackendState(
    id: string,
    status: string,
    verifiedAt: string | null,
  ): void {
    db.prepare(
      `UPDATE backends
          SET auth_status = ?,
              auth_last_verified_at = ?
        WHERE id = ?`,
    ).run(status, verifiedAt, id);
  }

  it("returns shouldSkip=false for ok status", () => {
    const now = new Date("2026-04-10T12:00:00Z");
    setBackendState("claude", "ok", new Date("2026-04-10T11:55:00Z").toISOString());
    const result = readCachedAuthStatus(db, "claude" as BackendId, undefined, now);
    expect(result.status).toBe("ok");
    expect(result.shouldSkip).toBe(false);
  });

  it("returns shouldSkip=false for unknown status", () => {
    const now = new Date("2026-04-10T12:00:00Z");
    const result = readCachedAuthStatus(db, "claude" as BackendId, undefined, now);
    expect(result.status).toBe("unknown");
    expect(result.shouldSkip).toBe(false);
  });

  it("returns shouldSkip=true for recovering (unconditional)", () => {
    setBackendState("codex", "recovering", null);
    const result = readCachedAuthStatus(db, "codex" as BackendId);
    expect(result.status).toBe("recovering");
    expect(result.shouldSkip).toBe(true);
  });

  it("returns shouldSkip=true for expired + fresh cache (5 min old)", () => {
    const now = new Date("2026-04-10T12:05:00Z");
    setBackendState("codex", "expired", new Date("2026-04-10T12:00:00Z").toISOString());
    const result = readCachedAuthStatus(db, "codex" as BackendId, 10 * 60 * 1000, now);
    expect(result.status).toBe("expired");
    expect(result.shouldSkip).toBe(true);
  });

  it("returns shouldSkip=false for expired + stale cache (11 min old)", () => {
    const now = new Date("2026-04-10T12:11:00Z");
    setBackendState("codex", "expired", new Date("2026-04-10T12:00:00Z").toISOString());
    const result = readCachedAuthStatus(db, "codex" as BackendId, 10 * 60 * 1000, now);
    expect(result.status).toBe("expired");
    expect(result.shouldSkip).toBe(false);
  });

  it("returns shouldSkip=true for missing + fresh cache", () => {
    const now = new Date("2026-04-10T12:05:00Z");
    setBackendState("gemini", "missing", new Date("2026-04-10T12:00:00Z").toISOString());
    const result = readCachedAuthStatus(db, "gemini" as BackendId, 10 * 60 * 1000, now);
    expect(result.status).toBe("missing");
    expect(result.shouldSkip).toBe(true);
  });

  it("boundary: exactly at freshness window edge (10 min) → shouldSkip=true", () => {
    const now = new Date("2026-04-10T12:10:00Z");
    setBackendState("codex", "expired", new Date("2026-04-10T12:00:00Z").toISOString());
    const result = readCachedAuthStatus(db, "codex" as BackendId, 10 * 60 * 1000, now);
    expect(result.shouldSkip).toBe(true);
  });

  it("boundary: 1 ms past freshness window → shouldSkip=false", () => {
    const now = new Date(new Date("2026-04-10T12:10:00Z").getTime() + 1);
    setBackendState("codex", "expired", new Date("2026-04-10T12:00:00Z").toISOString());
    const result = readCachedAuthStatus(db, "codex" as BackendId, 10 * 60 * 1000, now);
    expect(result.shouldSkip).toBe(false);
  });

  it("returns shouldSkip=false when auth_last_verified_at is NULL (no timestamp)", () => {
    setBackendState("codex", "expired", null);
    const result = readCachedAuthStatus(db, "codex" as BackendId);
    expect(result.status).toBe("expired");
    expect(result.shouldSkip).toBe(false);
  });

  it("returns shouldSkip=false for non-existent backend row", () => {
    const result = readCachedAuthStatus(db, "nonexistent" as BackendId);
    expect(result.status).toBe("unknown");
    expect(result.shouldSkip).toBe(false);
  });

  it("fail-open: DB error returns shouldSkip=false", () => {
    db.close();
    const freshDb = new Database(":memory:");
    // No backends table → query will throw
    const result = readCachedAuthStatus(freshDb, "claude" as BackendId);
    expect(result.shouldSkip).toBe(false);
    freshDb.close();
  });

  it("self-heal after re-auth: reactive success stamps auth_last_verified_at, making cache stale for pre-flight", () => {
    // 1. Probe confirms expired at T=0
    const t0 = new Date("2026-04-10T12:00:00Z");
    setBackendState("codex", "expired", t0.toISOString());

    // 2. Pre-flight at T+5min sees fresh expired → skip
    const t5 = new Date("2026-04-10T12:05:00Z");
    const preflight1 = readCachedAuthStatus(db, "codex" as BackendId, 10 * 60 * 1000, t5);
    expect(preflight1.shouldSkip).toBe(true);

    // 3. User re-auths CLI. Reactive success fires at T+7min → stamps verified_at + clears to ok
    const t7 = new Date("2026-04-10T12:07:00Z");
    const telemetry = new AuthTelemetry(db);
    recordReactiveAuthSuccess(db, "codex" as BackendId, telemetry, t7);

    // 4. Pre-flight at T+8min sees ok → no skip
    const t8 = new Date("2026-04-10T12:08:00Z");
    const preflight2 = readCachedAuthStatus(db, "codex" as BackendId, 10 * 60 * 1000, t8);
    expect(preflight2.status).toBe("ok");
    expect(preflight2.shouldSkip).toBe(false);
  });

  it("reactive failure stamps auth_last_verified_at so next pre-flight can trust it", () => {
    const t0 = new Date("2026-04-10T12:00:00Z");
    recordReactiveAuthFailure(db, "codex" as BackendId, "401 Unauthorized", undefined, t0);

    // Pre-flight 2 min later → fresh expired → skip
    const t2 = new Date("2026-04-10T12:02:00Z");
    const result = readCachedAuthStatus(db, "codex" as BackendId, 10 * 60 * 1000, t2);
    expect(result.status).toBe("expired");
    expect(result.shouldSkip).toBe(true);
  });

  it("persistCheckResult stamps auth_last_verified_at for pre-flight", () => {
    const telemetry = new AuthTelemetry(db);
    const cores = { claude: fakeCore("claude" as BackendId) };
    const monitor = new AuthHealthMonitor(db, cores, telemetry, {
      now: () => new Date("2026-04-10T12:00:00Z"),
    });
    monitor.persistCheckResult("claude" as BackendId, {
      ok: false,
      status: "expired",
      method: "cli_login",
      detail: "token expired",
    });

    const t5 = new Date("2026-04-10T12:05:00Z");
    const result = readCachedAuthStatus(db, "claude" as BackendId, 10 * 60 * 1000, t5);
    expect(result.status).toBe("expired");
    expect(result.shouldSkip).toBe(true);
  });
});
