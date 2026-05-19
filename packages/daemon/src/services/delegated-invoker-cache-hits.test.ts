import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import type { DelegatedTaskCacheEntry } from "./delegated-task-result-cache.js";
import {
  buildCacheHitRunResult,
  buildCacheHitTaskResult,
} from "./delegated-invoker-cache-hits.js";
import type {
  RunInvokeParams,
  TaskInvokeParams,
} from "./delegated-backend-invoker.js";

/**
 * The cache-hit builders are exercised end-to-end by the parent
 * `delegated-backend-invoker.test.ts` suite, but only with the parent-event
 * / parent-process metadata DEFINED. The conditional-spread branches that
 * fire when the caller omits those fields (cron-driven tasks, ad-hoc
 * dashboard calls) need direct coverage to satisfy the 100% gate.
 *
 * Both builders are pure synthesis + a single audit-row write. We use an
 * in-memory SQLite db so the audit row is exercised end-to-end and the
 * inserted row can be inspected for the conditional fields.
 */

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

function makeHit(): DelegatedTaskCacheEntry {
  return {
    result: { ok: true, summary: "from cache" },
    needsConfirmation: false,
    confirmationPlan: null,
    cost: {
      tokensInput: 100,
      tokensOutput: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0.0012,
      durationMs: 220,
      numTurns: 1,
    },
    trace: [
      {
        toolName: "mcp__claude_ai_Gmail__search_threads",
        toolArgs: { q: "is:unread" },
        durationMs: 80,
        status: "ok",
        costUsd: null,
        tokensInput: null,
        tokensOutput: null,
      },
    ],
    backendId: "claude",
    modelId: "claude-haiku-4-5-20251001",
    retried: false,
  };
}

function makeTaskParams(
  overrides: Partial<TaskInvokeParams> = {},
): TaskInvokeParams {
  return {
    integrationKey: "gmail",
    task: "Summarise unread threads.",
    outputSchema: { type: "object" },
    maxToolCalls: 3,
    maxBudgetUsd: 0.05,
    timeoutMs: 30_000,
    allowDestructive: false,
    ...overrides,
  };
}

function makeRunParams(
  overrides: Partial<RunInvokeParams> = {},
): RunInvokeParams {
  return {
    delegatedBackend: "claude",
    allowedTools: ["mcp__claude_ai_Gmail__search_threads"],
    task: "Summarise unread threads.",
    outputSchema: { type: "object" },
    maxToolCalls: 3,
    maxBudgetUsd: 0.05,
    timeoutMs: 30_000,
    allowDestructive: false,
    ...overrides,
  };
}

describe("buildCacheHitTaskResult", () => {
  it("returns a zero-cost success synthesised from the cache entry", () => {
    const db = makeDb();
    try {
      const hit = makeHit();
      const out = buildCacheHitTaskResult(db, {
        params: makeTaskParams({
          parentEventId: "evt-1",
          parentProcessKey: "scheduled.task",
        }),
        hit,
        backendId: "claude",
        modelId: "claude-haiku-4-5-20251001",
        now: () => 1_700_000_000_000,
      });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.result).toEqual(hit.result);
        expect(out.trace).toEqual(hit.trace);
        expect(out.cost.costUsd).toBe(0); // cache hits bill nothing
        expect(out.needsConfirmation).toBe(false);
        expect(out.confirmationPlan).toBeNull();
        expect(out.retried).toBe(false);
        expect(out.backendId).toBe("claude");
        expect(out.modelId).toBe("claude-haiku-4-5-20251001");
      }
    } finally {
      db.close();
    }
  });

  it("writes one cache-hit audit row with event_id + trigger when set", () => {
    const db = makeDb();
    try {
      buildCacheHitTaskResult(db, {
        params: makeTaskParams({
          parentEventId: "evt-with-meta",
          parentProcessKey: "morning_routine",
        }),
        hit: makeHit(),
        backendId: "claude",
        modelId: "claude-haiku-4-5-20251001",
        now: () => 1_700_000_000_000,
      });
      const row = db
        .prepare(
          `SELECT event_id, trigger, result, cost_usd, cost_source, backend
             FROM agent_actions
             WHERE action_type = 'delegated_task.exec'`,
        )
        .get() as {
          event_id: string | null;
          trigger: string | null;
          result: string;
          cost_usd: number;
          cost_source: string;
          backend: string;
        };
      expect(row.event_id).toBe("evt-with-meta");
      expect(row.trigger).toBe("morning_routine");
      expect(row.result).toBe("success");
      expect(row.cost_usd).toBe(0);
      expect(row.cost_source).toBe("cache");
      expect(row.backend).toBe("claude");
    } finally {
      db.close();
    }
  });

  it("writes a cache-hit audit row with null event/trigger when params omit them", () => {
    const db = makeDb();
    try {
      buildCacheHitTaskResult(db, {
        params: makeTaskParams(), // no parentEventId, no parentProcessKey
        hit: makeHit(),
        backendId: "claude",
        modelId: "claude-haiku-4-5-20251001",
        now: () => 1_700_000_000_000,
      });
      const row = db
        .prepare(
          `SELECT event_id, trigger FROM agent_actions
             WHERE action_type = 'delegated_task.exec'`,
        )
        .get() as { event_id: string | null; trigger: string | null };
      expect(row.event_id).toBeNull();
      expect(row.trigger).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("buildCacheHitRunResult", () => {
  it("returns a zero-cost success synthesised from the cache entry", () => {
    const db = makeDb();
    try {
      const hit = makeHit();
      const out = buildCacheHitRunResult(db, {
        params: makeRunParams({
          parentEventId: "evt-1",
          parentProcessKey: "delegated.run",
        }),
        hit,
        backendId: "claude",
        modelId: "claude-haiku-4-5-20251001",
        now: () => 1_700_000_000_000,
      });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.result).toEqual(hit.result);
        expect(out.trace).toEqual(hit.trace);
        expect(out.cost.costUsd).toBe(0);
        expect(out.needsConfirmation).toBe(false);
        expect(out.confirmationPlan).toBeNull();
        expect(out.retried).toBe(false);
      }
    } finally {
      db.close();
    }
  });

  it("writes a cache-hit audit row tagged 'delegated_task.run' with both parents set", () => {
    const db = makeDb();
    try {
      buildCacheHitRunResult(db, {
        params: makeRunParams({
          parentEventId: "evt-run",
          parentProcessKey: "scheduled.task",
        }),
        hit: makeHit(),
        backendId: "claude",
        modelId: "claude-haiku-4-5-20251001",
        now: () => 1_700_000_000_000,
      });
      const row = db
        .prepare(
          `SELECT event_id, trigger, cost_source, action_type FROM agent_actions
             WHERE action_type = 'delegated_task.run'`,
        )
        .get() as {
          event_id: string | null;
          trigger: string | null;
          cost_source: string;
          action_type: string;
        };
      expect(row.action_type).toBe("delegated_task.run");
      expect(row.event_id).toBe("evt-run");
      expect(row.trigger).toBe("scheduled.task");
      expect(row.cost_source).toBe("cache");
    } finally {
      db.close();
    }
  });

  it("writes a cache-hit audit row with null event/trigger when run params omit them", () => {
    const db = makeDb();
    try {
      buildCacheHitRunResult(db, {
        params: makeRunParams(), // no parent metadata
        hit: makeHit(),
        backendId: "claude",
        modelId: "claude-haiku-4-5-20251001",
        now: () => 1_700_000_000_000,
      });
      const row = db
        .prepare(
          `SELECT event_id, trigger FROM agent_actions
             WHERE action_type = 'delegated_task.run'`,
        )
        .get() as { event_id: string | null; trigger: string | null };
      expect(row.event_id).toBeNull();
      expect(row.trigger).toBeNull();
    } finally {
      db.close();
    }
  });
});
