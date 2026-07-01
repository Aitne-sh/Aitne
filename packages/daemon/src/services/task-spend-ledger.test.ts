import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import { recordTaskRunSpend } from "./task-spend-ledger.js";

interface LedgerRow {
  action_type: string;
  model_used: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  num_turns: number | null;
  result: string | null;
  started_at: string;
  completed_at: string;
  source_kind: string | null;
  source_ref: string | null;
  backend: string | null;
  cost_source: string | null;
}

function ledgerRows(db: Database.Database): LedgerRow[] {
  return db
    .prepare(
      `SELECT action_type, model_used, cost_usd, duration_ms, num_turns, result,
              started_at, completed_at, source_kind, source_ref, backend, cost_source
         FROM agent_actions`,
    )
    .all() as LedgerRow[];
}

describe("recordTaskRunSpend", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("writes one agent_actions row per leg with sdk cost provenance", () => {
    recordTaskRunSpend(db, {
      taskKind: "background_task",
      taskId: "bg-1",
      result: "success",
      costUsd: 0.42,
      numTurns: 7,
      durationMs: 60_000,
      completedAt: Date.parse("2026-07-01T12:01:00.000Z"),
      modelUsed: "claude-sonnet-5",
    });
    const rows = ledgerRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action_type: "background_task.run",
      model_used: "claude-sonnet-5",
      cost_usd: 0.42,
      duration_ms: 60_000,
      num_turns: 7,
      result: "success",
      source_kind: "background_task",
      source_ref: "bg-1",
      backend: "claude",
      cost_source: "sdk",
    });
    // datetime(@iso) canonicalises to SQLite's sortable format.
    expect(rows[0].started_at).toBe("2026-07-01 12:00:00");
    expect(rows[0].completed_at).toBe("2026-07-01 12:01:00");
  });

  it("records a browser leg parked for clarification as partial", () => {
    recordTaskRunSpend(db, {
      taskKind: "browser_task",
      taskId: "bx-1",
      result: "partial",
      costUsd: 0.05,
      numTurns: 3,
      durationMs: 1000,
      completedAt: 1_751_200_000_000,
      modelUsed: null,
    });
    expect(ledgerRows(db)[0]).toMatchObject({
      action_type: "browser_task.run",
      result: "partial",
      source_ref: "bx-1",
    });
  });

  it("records a 0-cost run that still spent turns", () => {
    recordTaskRunSpend(db, {
      taskKind: "background_task",
      taskId: "bg-2",
      result: "failed",
      costUsd: 0,
      numTurns: 2,
      durationMs: 500,
      completedAt: 1_751_200_000_000,
      modelUsed: null,
    });
    expect(ledgerRows(db)).toHaveLength(1);
  });

  it("skips a no-spend bail (cost 0, turns 0) — no ledger noise", () => {
    recordTaskRunSpend(db, {
      taskKind: "background_task",
      taskId: "bg-3",
      result: "failed",
      costUsd: 0,
      numTurns: 0,
      durationMs: 0,
      completedAt: 1_751_200_000_000,
      modelUsed: null,
    });
    expect(ledgerRows(db)).toHaveLength(0);
  });

  it("never throws when the insert fails (best-effort ledger)", () => {
    const bare = new Database(":memory:"); // no schema — INSERT will fail
    try {
      expect(() =>
        recordTaskRunSpend(bare, {
          taskKind: "browser_task",
          taskId: "bx-err",
          result: "failed",
          costUsd: 0.01,
          numTurns: 1,
          durationMs: 100,
          completedAt: 1_751_200_000_000,
          modelUsed: null,
        }),
      ).not.toThrow();
    } finally {
      bare.close();
    }
  });
});
