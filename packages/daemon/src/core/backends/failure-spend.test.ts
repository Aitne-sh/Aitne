import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import {
  BackendDecisiveFailure,
  BackendQuotaError,
  type BackendQuotaSpend,
} from "../agent-core.js";
import {
  extractFailureSpendInfo,
  recordFailureSpendRow,
  type FailureSpendInfo,
} from "./failure-spend.js";

function makeSpend(overrides: Partial<BackendQuotaSpend> = {}): BackendQuotaSpend {
  return {
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 20,
    },
    costUsd: 0.42,
    modelId: "claude-sonnet-4-6",
    numTurns: 3,
    durationMs: 1234,
    costSource: "sdk",
    ...overrides,
  };
}

describe("extractFailureSpendInfo", () => {
  it("recovers spend from a BackendQuotaError carrying one (costSource from spend)", () => {
    const spend = makeSpend({ costSource: "sdk_partial" });
    const failure = new BackendQuotaError(
      "claude",
      "max_budget_usd",
      null,
      "budget exceeded",
      spend,
    );

    expect(extractFailureSpendInfo(failure)).toEqual({
      backendId: "claude",
      spend,
      costSource: "sdk_partial",
    });
  });

  it("maps an undefined spend.costSource to null", () => {
    const spend = makeSpend({ costSource: undefined });
    const failure = new BackendQuotaError(
      "codex",
      "max_budget_usd",
      null,
      "budget exceeded",
      spend,
    );

    const info = extractFailureSpendInfo(failure);
    expect(info?.backendId).toBe("codex");
    expect(info?.costSource).toBeNull();
  });

  it("unwraps BackendDecisiveFailure(kind='quota') to the inner BackendQuotaError spend", () => {
    const spend = makeSpend();
    const inner = new BackendQuotaError(
      "gemini",
      "rate_limited",
      null,
      "quota",
      spend,
    );
    const failure = new BackendDecisiveFailure("gemini", "quota", inner);

    expect(extractFailureSpendInfo(failure)).toEqual({
      backendId: "gemini",
      spend,
      costSource: "sdk",
    });
  });

  it("tags a non-quota BackendDecisiveFailure's own spend as post_hoc_error", () => {
    const spend = makeSpend({ costSource: "hardcoded" });
    const failure = new BackendDecisiveFailure(
      "codex",
      "timeout",
      new Error("wall clock"),
      spend,
    );

    expect(extractFailureSpendInfo(failure)).toEqual({
      backendId: "codex",
      spend,
      costSource: "post_hoc_error",
    });
  });

  it("falls through to the own-spend branch when kind='quota' but cause is not a BackendQuotaError", () => {
    const spend = makeSpend();
    const failure = new BackendDecisiveFailure(
      "claude",
      "quota",
      new Error("raw quota signal"),
      spend,
    );

    expect(extractFailureSpendInfo(failure)).toEqual({
      backendId: "claude",
      spend,
      costSource: "post_hoc_error",
    });
  });

  it("returns null for a BackendDecisiveFailure without spend", () => {
    const failure = new BackendDecisiveFailure(
      "claude",
      "auth",
      new Error("401"),
    );
    expect(extractFailureSpendInfo(failure)).toBeNull();
  });

  it("returns null for a BackendQuotaError without spend", () => {
    const failure = new BackendQuotaError(
      "claude",
      "rate_limited",
      null,
      "quota",
    );
    expect(extractFailureSpendInfo(failure)).toBeNull();
  });

  it("returns null for a plain Error", () => {
    expect(extractFailureSpendInfo(new Error("boom"))).toBeNull();
  });
});

describe("recordFailureSpendRow", () => {
  const event = { correlationId: "corr-1", type: "routine.fetch_window" };

  function makeInfo(overrides: Partial<FailureSpendInfo> = {}): FailureSpendInfo {
    return {
      backendId: "claude",
      spend: makeSpend(),
      costSource: "sdk_partial",
      ...overrides,
    };
  }

  it("inserts a result='failed' row with spend + cache-token columns on a full-schema DB", () => {
    const db = new Database(":memory:");
    try {
      applySchema(db);

      recordFailureSpendRow(db, event, makeInfo(), "main backend died");

      const row = db
        .prepare(
          `SELECT event_id, action_type, model_used, cost_usd, tokens_input,
                  tokens_output, cache_creation_tokens, cache_read_tokens,
                  duration_ms, num_turns, result, backend, cost_source, error,
                  completed_at
             FROM agent_actions`,
        )
        .get() as Record<string, unknown>;

      expect(row).toMatchObject({
        event_id: "corr-1",
        action_type: "routine.fetch_window",
        model_used: "claude-sonnet-4-6",
        tokens_input: 100,
        tokens_output: 50,
        cache_creation_tokens: 10,
        cache_read_tokens: 20,
        duration_ms: 1234,
        num_turns: 3,
        result: "failed",
        backend: "claude",
        cost_source: "sdk_partial",
        error: "main backend died",
      });
      expect(row.cost_usd as number).toBeCloseTo(0.42, 4);
      expect(row.completed_at).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it("truncates the error message to 4096 chars", () => {
    const db = new Database(":memory:");
    try {
      applySchema(db);

      recordFailureSpendRow(db, event, makeInfo(), "x".repeat(5000));

      const row = db
        .prepare("SELECT error FROM agent_actions")
        .get() as { error: string };
      expect(row.error).toHaveLength(4096);
      expect(row.error).toBe("x".repeat(4096));
    } finally {
      db.close();
    }
  });

  it("inserts two rows on two calls (second call hits the memoized PRAGMA branch)", () => {
    const db = new Database(":memory:");
    try {
      applySchema(db);

      recordFailureSpendRow(db, event, makeInfo(), "first");
      recordFailureSpendRow(db, event, makeInfo(), "second");

      const rows = db
        .prepare(
          "SELECT error, cache_creation_tokens, cache_read_tokens FROM agent_actions ORDER BY id",
        )
        .all() as Array<{
          error: string;
          cache_creation_tokens: number;
          cache_read_tokens: number;
        }>;
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.error)).toEqual(["first", "second"]);
      // The memoized branch still splices the cache columns in.
      expect(rows[1]).toMatchObject({
        cache_creation_tokens: 10,
        cache_read_tokens: 20,
      });
    } finally {
      db.close();
    }
  });

  it("inserts without cache-token columns on a pre-migration agent_actions table", () => {
    const db = new Database(":memory:");
    try {
      db.exec(
        `CREATE TABLE agent_actions (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           event_id TEXT,
           action_type TEXT NOT NULL,
           model_used TEXT,
           cost_usd REAL,
           tokens_input INTEGER,
           tokens_output INTEGER,
           duration_ms INTEGER,
           num_turns INTEGER,
           result TEXT,
           backend TEXT,
           cost_source TEXT,
           error TEXT,
           completed_at TIMESTAMP
         )`,
      );

      recordFailureSpendRow(db, event, makeInfo(), "legacy schema");

      const row = db
        .prepare(
          `SELECT event_id, result, backend, cost_source, tokens_input,
                  tokens_output, error
             FROM agent_actions`,
        )
        .get() as Record<string, unknown>;
      expect(row).toMatchObject({
        event_id: "corr-1",
        result: "failed",
        backend: "claude",
        cost_source: "sdk_partial",
        tokens_input: 100,
        tokens_output: 50,
        error: "legacy schema",
      });
    } finally {
      db.close();
    }
  });

  it("does not throw when the DB rejects both the PRAGMA and the INSERT (best-effort)", () => {
    const throwingDb = {
      prepare: () => {
        throw new Error("db is gone");
      },
    } as unknown as Database.Database;

    expect(() =>
      recordFailureSpendRow(throwingDb, event, makeInfo(), "boom"),
    ).not.toThrow();
  });
});
