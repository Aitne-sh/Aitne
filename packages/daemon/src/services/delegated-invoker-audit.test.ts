/**
 * Peer tests for `./delegated-invoker-audit.ts` — pure DB writers for
 * the delegated proxy + task subsystem (file-split-plan §9 Tier 2).
 *
 * Each writer is structurally simple: prepare-and-run an INSERT/UPDATE,
 * log-and-swallow on SQL failure. The tests cover:
 *  - row content matches the args (correct columns get written)
 *  - swallow-on-failure contract (writers don't propagate exceptions)
 *  - `recordCacheHitAuditRow` + `recordTaskHeaderInProgress` return the
 *    inserted rowid (or -1 on failure) so the invoker can FK against it
 *  - `completeTaskHeader` no-ops when `headerId < 0`
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";

import { applySchema } from "../db/schema.js";
import {
  completeTaskHeader,
  recordAction,
  recordCacheHitAuditRow,
  recordTaskHeaderInProgress,
  recordTaskToolStep,
} from "./delegated-invoker-audit.js";
import type { InvokeParams } from "./delegated-backend-invoker.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function makeParams(overrides: Partial<InvokeParams> = {}): InvokeParams {
  return {
    backendId: "claude",
    integrationKey: "gmail",
    toolName: "mcp__claude_ai_Gmail__search_threads",
    toolArgs: { query: "hello" },
    parentEventId: "evt-1",
    parentProcessKey: "message.dm",
    sessionId: null,
    sessionDir: "/tmp/session",
    backendQuotaError: null,
    requestId: "req-1",
    abortSignal: new AbortController().signal,
    timeoutMs: 60_000,
    ...overrides,
  } as InvokeParams;
}

const ZERO_COST = {
  costUsd: 0,
  tokensInput: 0,
  tokensOutput: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  durationMs: 0,
  numTurns: 0,
};

describe("recordAction", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("writes a terminal delegated_proxy.invoke row with the supplied cost + result", () => {
    recordAction(db, {
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
      params: makeParams(),
      result: "success",
      cost: {
        costUsd: 0.0042,
        tokensInput: 100,
        tokensOutput: 200,
        cacheCreationTokens: 5,
        cacheReadTokens: 50,
        durationMs: 1234,
        numTurns: 2,
      },
      startedAt: "2026-05-10T00:00:00Z",
      completedAt: "2026-05-10T00:00:01Z",
    });

    const row = db
      .prepare<[], { action_type: string; cost_usd: number; result: string; model_used: string; backend: string; cost_source: string; detail: string }>(
        `SELECT action_type, cost_usd, result, model_used, backend, cost_source, detail
         FROM agent_actions ORDER BY id DESC LIMIT 1`,
      )
      .get();
    expect(row).toBeDefined();
    expect(row?.action_type).toBe("delegated_proxy.invoke");
    expect(row?.cost_usd).toBeCloseTo(0.0042);
    expect(row?.result).toBe("success");
    expect(row?.model_used).toBe("claude-sonnet-4-6");
    expect(row?.backend).toBe("claude");
    expect(row?.cost_source).toBe("sdk");
    const detail = JSON.parse(row!.detail);
    expect(detail.integrationKey).toBe("gmail");
    expect(detail.toolName).toBe("mcp__claude_ai_Gmail__search_threads");
    expect(typeof detail.toolArgsHash).toBe("string");
  });

  it("captures errorClass and errorMessage on failure rows", () => {
    recordAction(db, {
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
      params: makeParams(),
      result: "failed",
      errorClass: "wrong_tool",
      cost: ZERO_COST,
      startedAt: "2026-05-10T00:00:00Z",
      completedAt: "2026-05-10T00:00:01Z",
      errorMessage: "model invoked the wrong tool",
    });

    const row = db
      .prepare<[], { error: string; result: string; detail: string }>(
        `SELECT error, result, detail FROM agent_actions ORDER BY id DESC LIMIT 1`,
      )
      .get();
    expect(row?.result).toBe("failed");
    expect(row?.error).toBe("model invoked the wrong tool");
    expect(JSON.parse(row!.detail).errorClass).toBe("wrong_tool");
  });

  it("swallows write failures without throwing (DB closed)", () => {
    db.close();
    expect(() =>
      recordAction(db, {
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
        params: makeParams(),
        result: "success",
        cost: ZERO_COST,
        startedAt: "2026-05-10T00:00:00Z",
        completedAt: "2026-05-10T00:00:01Z",
      }),
    ).not.toThrow();
  });
});

describe("recordCacheHitAuditRow", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("inserts a cache-source success row and returns the rowid", () => {
    const id = recordCacheHitAuditRow(db, {
      actionType: "delegated_task.exec",
      backendId: "claude",
      modelId: "claude-haiku-4-5",
      parentEventId: "evt-2",
      parentProcessKey: "morning_routine",
      timestamp: "2026-05-10T00:00:00Z",
      detail: { taskHash: "hash-1" },
      toolCallCount: 3,
    });
    expect(id).toBeGreaterThan(0);

    const row = db
      .prepare<[number], { action_type: string; cost_usd: number; result: string; cost_source: string; num_turns: number; detail: string }>(
        `SELECT action_type, cost_usd, result, cost_source, num_turns, detail
         FROM agent_actions WHERE id = ?`,
      )
      .get(id);
    expect(row?.action_type).toBe("delegated_task.exec");
    expect(row?.cost_usd).toBe(0);
    expect(row?.result).toBe("success");
    expect(row?.cost_source).toBe("cache");
    expect(row?.num_turns).toBe(3);
    expect(JSON.parse(row!.detail).taskHash).toBe("hash-1");
  });

  it("returns -1 on SQL failure", () => {
    db.close();
    const id = recordCacheHitAuditRow(db, {
      actionType: "delegated_task.run",
      backendId: "claude",
      modelId: "claude-haiku-4-5",
      timestamp: "2026-05-10T00:00:00Z",
      detail: {},
      toolCallCount: 0,
    });
    expect(id).toBe(-1);
  });
});

describe("recordTaskHeaderInProgress + completeTaskHeader", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("inserts an in_progress header and returns the rowid", () => {
    const id = recordTaskHeaderInProgress(db, {
      actionType: "delegated_task.exec",
      backendId: "claude",
      modelId: "claude-haiku-4-5",
      parentEventId: "evt-3",
      parentProcessKey: "hourly_check",
      startedAt: "2026-05-10T00:00:00Z",
      detail: { integrationKey: "gmail" },
    });
    expect(id).toBeGreaterThan(0);

    const row = db
      .prepare<[number], { result: string; completed_at: string | null }>(
        `SELECT result, completed_at FROM agent_actions WHERE id = ?`,
      )
      .get(id);
    expect(row?.result).toBe("in_progress");
    expect(row?.completed_at).toBeNull();
  });

  it("completeTaskHeader flips the row to success and writes cost", () => {
    const id = recordTaskHeaderInProgress(db, {
      actionType: "delegated_task.exec",
      backendId: "claude",
      modelId: "claude-haiku-4-5",
      startedAt: "2026-05-10T00:00:00Z",
      detail: { integrationKey: "gmail" },
    });
    completeTaskHeader(db, {
      headerId: id,
      result: "success",
      cost: {
        costUsd: 0.05,
        tokensInput: 500,
        tokensOutput: 1000,
        cacheCreationTokens: 10,
        cacheReadTokens: 100,
        durationMs: 5000,
        numTurns: 4,
      },
      completedAt: "2026-05-10T00:00:05Z",
      errorClass: null,
      errorMessage: null,
      retried: false,
      toolCallCount: 3,
      detail: { integrationKey: "gmail", retried: false, toolCallCount: 3 },
    });

    const row = db
      .prepare<[number], { result: string; cost_usd: number; num_turns: number; completed_at: string | null }>(
        `SELECT result, cost_usd, num_turns, completed_at FROM agent_actions WHERE id = ?`,
      )
      .get(id);
    expect(row?.result).toBe("success");
    expect(row?.cost_usd).toBeCloseTo(0.05);
    expect(row?.num_turns).toBe(4);
    expect(row?.completed_at).not.toBeNull();
  });

  it("completeTaskHeader is a no-op when headerId < 0", () => {
    expect(() =>
      completeTaskHeader(db, {
        headerId: -1,
        result: "success",
        cost: ZERO_COST,
        completedAt: "2026-05-10T00:00:05Z",
        errorClass: null,
        errorMessage: null,
        retried: false,
        toolCallCount: 0,
        detail: {},
      }),
    ).not.toThrow();
  });
});

describe("recordTaskToolStep", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("writes a tool_step row with status mapped to result", () => {
    recordTaskToolStep(db, {
      parentTaskActionId: 999,
      backendId: "claude",
      modelId: "claude-haiku-4-5",
      integrationKey: "gmail",
      step: {
        toolName: "mcp__claude_ai_Gmail__search_threads",
        toolArgs: { query: "x" },
        status: "ok",
        costUsd: 0.001,
        tokensInput: 10,
        tokensOutput: 20,
        durationMs: 100,
        toolResult: { threads: [] },
      },
    });

    const row = db
      .prepare<[], { action_type: string; result: string; detail: string; error: string | null }>(
        `SELECT action_type, result, detail, error FROM agent_actions ORDER BY id DESC LIMIT 1`,
      )
      .get();
    expect(row?.action_type).toBe("delegated_task.tool_step");
    expect(row?.result).toBe("success");
    expect(row?.error).toBeNull();
    const detail = JSON.parse(row!.detail);
    expect(detail.toolName).toBe("mcp__claude_ai_Gmail__search_threads");
    expect(detail.parentTaskActionId).toBe(999);
    expect(detail.integrationKey).toBe("gmail");
  });

  it("maps step.status === 'error' to result=failed + error=tool_step_error", () => {
    recordTaskToolStep(db, {
      parentTaskActionId: 1,
      backendId: "claude",
      modelId: "claude-haiku-4-5",
      step: {
        toolName: "mcp__claude_ai_Notion__notion-search",
        toolArgs: {},
        status: "error",
        costUsd: 0,
        tokensInput: 0,
        tokensOutput: 0,
        durationMs: 50,
      },
    });

    const row = db
      .prepare<[], { result: string; error: string | null }>(
        `SELECT result, error FROM agent_actions ORDER BY id DESC LIMIT 1`,
      )
      .get();
    expect(row?.result).toBe("failed");
    expect(row?.error).toBe("tool_step_error");
  });

  it("swallows DB errors (warn-and-continue contract)", () => {
    db.close();
    expect(() =>
      recordTaskToolStep(db, {
        parentTaskActionId: 1,
        backendId: "claude",
        modelId: "claude-haiku-4-5",
        step: {
          toolName: "x",
          toolArgs: {},
          status: "ok",
          costUsd: 0,
          tokensInput: 0,
          tokensOutput: 0,
          durationMs: 0,
        },
      }),
    ).not.toThrow();
  });
});
