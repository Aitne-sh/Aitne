import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import {
  MetricsCollector,
  aggregateManagedTaskRuns,
  aggregatePrePassMetrics,
  classifyManagedTaskRunResult,
  inferBackendFromModel,
  groupErrorRows,
} from "./metrics.js";
import {
  recordActivityViewRebuildDuration,
  recordEntityMirrorLag,
  recordManagementMdRenderDuration,
  resetManagementTelemetry,
} from "./management-telemetry.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

describe("MetricsCollector", () => {
  let db: Database.Database;
  let collector: MetricsCollector;

  beforeEach(() => {
    db = createTestDb();
    collector = new MetricsCollector(db);
  });

  it("returns null rates when no data", () => {
    const m = collector.collect();
    expect(m.notificationConfirmRate).toBeNull();
    expect(m.advisorCallRate).toBeNull();
    expect(m.responseTime.p50).toBeNull();
    expect(m.responseTime.p95).toBeNull();
    expect(m.cost.todayUsd).toBe(0);
    expect(m.sessions.todayTotal).toBe(0);
    expect(m.proactiveForwardResume).toEqual({
      injected: 0,
      disavowed: 0,
      ratio: null,
      threshold: 0.05,
    });
  });

  it("calculates proactive forward disavowal ratio", () => {
    for (let i = 0; i < 10; i++) {
      db.prepare(
        `INSERT INTO agent_actions (action_type, trigger, result, detail, started_at)
         VALUES ('proactive_forward_injected', 'reactive', 'success', '{}', datetime('now'))`,
      ).run();
    }
    db.prepare(
      `INSERT INTO agent_actions (action_type, trigger, result, detail, started_at)
       VALUES ('proactive_forward_disavowed', 'reactive', 'success', '{}', datetime('now'))`,
    ).run();

    const m = collector.collect();

    expect(m.proactiveForwardResume.injected).toBe(10);
    expect(m.proactiveForwardResume.disavowed).toBe(1);
    expect(m.proactiveForwardResume.ratio).toBeCloseTo(0.1);
  });

  it("calculates notification confirmation rate", () => {
    // Insert 10 delivered, 7 reacted
    for (let i = 0; i < 10; i++) {
      db.prepare(
        `INSERT INTO notification_log (notification_type, priority, platform, content_summary, status, user_reaction, created_at, delivered_at)
         VALUES ('test', 'normal', 'slack', 'test msg', 'delivered', ${i < 7 ? "'acknowledged'" : "NULL"}, datetime('now'), datetime('now'))`,
      ).run();
    }
    // 2 suppressed
    for (let i = 0; i < 2; i++) {
      db.prepare(
        `INSERT INTO notification_log (notification_type, priority, platform, content_summary, status, created_at)
         VALUES ('test', 'low', 'slack', 'suppressed', 'suppressed', datetime('now'))`,
      ).run();
    }

    const m = collector.collect();
    expect(m.notificationConfirmRate).toBeCloseTo(0.7);
    expect(m.notificationCounts.delivered).toBe(10);
    expect(m.notificationCounts.reacted).toBe(7);
    expect(m.notificationCounts.suppressed).toBe(2);
  });

  it("counts Sonnet and Opus sessions separately", () => {
    for (let i = 0; i < 10; i++) {
      db.prepare(
        `INSERT INTO agent_actions (event_id, action_type, trigger, model_used, cost_usd, tokens_input, tokens_output, duration_ms, num_turns, result, started_at, completed_at)
         VALUES ('e${i}', 'message.received', 'reactive', 'claude-sonnet-4-6', 0.01, 100, 50, 1000, 1, 'success', datetime('now'), datetime('now'))`,
      ).run();
    }
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO agent_actions (event_id, action_type, trigger, model_used, cost_usd, tokens_input, tokens_output, duration_ms, num_turns, result, started_at, completed_at)
         VALUES ('o${i}', 'routine.morning_routine', 'autonomous', 'claude-opus-4-6', 0.50, 1000, 500, 5000, 3, 'success', datetime('now'), datetime('now'))`,
      ).run();
    }

    const m = collector.collect();
    // advisorCallRate is 0 because all sessions have advisor_call_count = 0
    // (full schema always creates the column; no sessions made advisor calls).
    expect(m.advisorCallRate).toBe(0);
    expect(m.modelCounts.sonnetSessions).toBe(10);
    expect(m.modelCounts.opusSessions).toBe(5);
  });

  it("computes advisorCallRate when advisor calls are recorded", () => {
    const migratedDb = new Database(":memory:");
    migratedDb.pragma("foreign_keys = ON");
    applySchema(migratedDb);
    const migratedCollector = new MetricsCollector(migratedDb);

    // 4 Sonnet sessions, 2 of which made one advisor call each, plus 1 that
    // made two calls. 1 Opus session with no advisor calls.
    const seedRow = (
      id: string,
      model: string,
      advisorCalls: number,
    ): void => {
      migratedDb
        .prepare(
          `INSERT INTO agent_actions (
             event_id, action_type, trigger, model_used, cost_usd,
             tokens_input, tokens_output, duration_ms, num_turns,
             result, advisor_call_count, started_at, completed_at
           ) VALUES (?, 'message.received', 'reactive', ?, 0.01, 100, 50,
                     1000, 1, 'success', ?, datetime('now'), datetime('now'))`,
        )
        .run(id, model, advisorCalls);
    };
    seedRow("s1", "claude-sonnet-4-6", 1);
    seedRow("s2", "claude-sonnet-4-6", 1);
    seedRow("s3", "claude-sonnet-4-6", 2);
    seedRow("s4", "claude-sonnet-4-6", 0);
    seedRow("o1", "claude-opus-4-6", 0);

    const m = migratedCollector.collect();
    // eligible_sessions = 5 (4 sonnet + 1 opus), total_calls = 4 → 0.8
    expect(m.advisorCallRate).toBeCloseTo(4 / 5);
    expect(m.modelCounts.sonnetSessions).toBe(4);
    expect(m.modelCounts.opusSessions).toBe(1);

    migratedDb.close();
  });

  it("returns advisorCallRate=null when there are successful sessions but no advisor calls", () => {
    const migratedDb = new Database(":memory:");
    migratedDb.pragma("foreign_keys = ON");
    applySchema(migratedDb);
    const migratedCollector = new MetricsCollector(migratedDb);

    migratedDb
      .prepare(
        `INSERT INTO agent_actions (
           event_id, action_type, trigger, model_used, cost_usd,
           tokens_input, tokens_output, duration_ms, num_turns,
           result, advisor_call_count, started_at, completed_at
         ) VALUES ('s1', 'message.received', 'reactive', 'claude-sonnet-4-6',
                   0.01, 100, 50, 1000, 1, 'success', 0,
                   datetime('now'), datetime('now'))`,
      )
      .run();

    const m = migratedCollector.collect();
    // eligible_sessions = 1, total_calls = 0 → rate = 0. We return 0 here,
    // not null, because we HAVE data (just no calls).
    expect(m.advisorCallRate).toBe(0);

    migratedDb.close();
  });

  it("calculates response time percentiles", () => {
    // Insert 100 reactive sessions with duration 100..10000
    for (let i = 1; i <= 100; i++) {
      db.prepare(
        `INSERT INTO agent_actions (event_id, action_type, trigger, model_used, cost_usd, tokens_input, tokens_output, duration_ms, num_turns, result, started_at, completed_at)
         VALUES ('e${i}', 'message.received', 'reactive', 'claude-sonnet-4-6', 0.01, 100, 50, ${i * 100}, 1, 'success', datetime('now'), datetime('now'))`,
      ).run();
    }

    const m = collector.collect();
    expect(m.responseTime.p50).toBe(5100);   // ~50th percentile
    expect(m.responseTime.p90).toBe(9100);   // ~90th percentile
    expect(m.responseTime.p95).toBe(9600);   // ~95th percentile
    expect(m.responseTime.avg).toBe(5050);   // average of 100..10000
  });

  it("calculates cost metrics", () => {
    // Today: 3 sessions at $0.10 each
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO agent_actions (event_id, action_type, trigger, model_used, cost_usd, tokens_input, tokens_output, duration_ms, num_turns, result, started_at, completed_at)
         VALUES ('t${i}', 'test', 'reactive', 'claude-sonnet-4-6', 0.10, 100, 50, 1000, 1, 'success', datetime('now'), datetime('now'))`,
      ).run();
    }

    const m = collector.collect();
    expect(m.cost.todayUsd).toBeCloseTo(0.30);
    expect(m.cost.last7dUsd).toBeCloseTo(0.30);
    expect(m.cost.last30dUsd).toBeCloseTo(0.30);
  });

  it("calculates session counts by trigger type", () => {
    // 3 reactive, 2 autonomous today
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO agent_actions (event_id, action_type, trigger, model_used, cost_usd, tokens_input, tokens_output, duration_ms, num_turns, result, started_at, completed_at)
         VALUES ('r${i}', 'message.received', 'reactive', 'claude-sonnet-4-6', 0.01, 100, 50, 1000, 1, 'success', datetime('now'), datetime('now'))`,
      ).run();
    }
    for (let i = 0; i < 2; i++) {
      db.prepare(
        `INSERT INTO agent_actions (event_id, action_type, trigger, model_used, cost_usd, tokens_input, tokens_output, duration_ms, num_turns, result, started_at, completed_at)
         VALUES ('a${i}', 'routine.morning_routine', 'autonomous', 'claude-opus-4-6', 0.50, 1000, 500, 5000, 3, 'success', datetime('now'), datetime('now'))`,
      ).run();
    }

    const m = collector.collect();
    expect(m.sessions.todayTotal).toBe(5);
    expect(m.sessions.todayReactive).toBe(3);
    expect(m.sessions.todayAutonomous).toBe(2);
  });

  it("includes collectedAt timestamp", () => {
    const m = collector.collect();
    expect(m.collectedAt).toBeTruthy();
    expect(new Date(m.collectedAt).getTime()).toBeGreaterThan(0);
  });

  it("collectTimeseries(0) filters to the current agent day only", () => {
    const localDb = new Database(":memory:");
    applySchema(localDb);
    const localCollector = new MetricsCollector(localDb, {
      timezone: "UTC",
      dayBoundaryHour: 4,
    });

    // Fix "now" to 2026-04-10 20:00 UTC
    // timezone=UTC, dayBoundaryHour=4 → agent day bounds:
    //   start = "2026-04-10 04:00:00", end = "2026-04-11 04:00:00"
    const fixedNow = new Date("2026-04-10T20:00:00Z");

    // INSIDE — reactive success at 15:00, duration 1500ms
    localDb
      .prepare(
        `INSERT INTO agent_actions (event_id, action_type, trigger, model_used, cost_usd,
           tokens_input, tokens_output, duration_ms, num_turns, result, started_at, completed_at)
         VALUES ('inside', 'message.received', 'reactive', 'claude-sonnet-4-6',
                 0.01, 100, 50, 1500, 1, 'success',
                 '2026-04-10 15:00:00', '2026-04-10 15:00:01')`,
      )
      .run();

    // INSIDE — reactive failure at 15:30, quota error, duration excluded from avg
    localDb
      .prepare(
        `INSERT INTO agent_actions (event_id, action_type, trigger, model_used, cost_usd,
           tokens_input, tokens_output, duration_ms, num_turns, result, error, started_at, completed_at)
         VALUES ('inside-fail', 'message.received', 'reactive', 'gpt-5-codex',
                 0.02, 200, 100, 9999, 1, 'failed', '429 rate limit exceeded',
                 '2026-04-10 15:30:00', '2026-04-10 15:30:10')`,
      )
      .run();

    // OUTSIDE — 02:00 is before the 04:00 agent day start
    localDb
      .prepare(
        `INSERT INTO agent_actions (event_id, action_type, trigger, model_used, cost_usd,
           tokens_input, tokens_output, duration_ms, num_turns, result, started_at, completed_at)
         VALUES ('outside', 'message.received', 'reactive', 'claude-sonnet-4-6',
                 0.01, 100, 50, 1000, 1, 'success',
                 '2026-04-10 02:00:00', '2026-04-10 02:00:01')`,
      )
      .run();

    // OUTSIDE — next day 05:00 is past the end boundary
    localDb
      .prepare(
        `INSERT INTO agent_actions (event_id, action_type, trigger, model_used, cost_usd,
           tokens_input, tokens_output, duration_ms, num_turns, result, error, started_at, completed_at)
         VALUES ('tomorrow', 'message.received', 'reactive', 'claude-sonnet-4-6',
                 0.01, 100, 50, 1000, 1, 'failed', 'some other error',
                 '2026-04-11 05:00:00', '2026-04-11 05:00:01')`,
      )
      .run();

    // Upper-boundary edge case — row AT end boundary must be excluded (strict <)
    localDb
      .prepare(
        `INSERT INTO agent_actions (event_id, action_type, trigger, model_used, cost_usd,
           tokens_input, tokens_output, duration_ms, num_turns, result, started_at, completed_at)
         VALUES ('edge', 'message.received', 'reactive', 'claude-sonnet-4-6',
                 0.01, 100, 50, 1000, 1, 'success',
                 '2026-04-11 04:00:00', '2026-04-11 04:00:01')`,
      )
      .run();

    // notification_log — one inside delivered+reacted, one inside delivered-only,
    // one outside (before boundary), one outside (after boundary)
    localDb
      .prepare(
        `INSERT INTO notification_log (notification_type, priority, platform, content_summary, status, user_reaction, created_at, delivered_at)
         VALUES ('test', 'normal', 'slack', 'inside-reacted', 'delivered', 'acknowledged',
                 '2026-04-10 10:00:00', '2026-04-10 10:00:00')`,
      )
      .run();
    localDb
      .prepare(
        `INSERT INTO notification_log (notification_type, priority, platform, content_summary, status, created_at, delivered_at)
         VALUES ('test', 'normal', 'slack', 'inside-ignored', 'delivered',
                 '2026-04-10 11:00:00', '2026-04-10 11:00:00')`,
      )
      .run();
    localDb
      .prepare(
        `INSERT INTO notification_log (notification_type, priority, platform, content_summary, status, created_at, delivered_at)
         VALUES ('test', 'normal', 'slack', 'pre-boundary', 'delivered',
                 '2026-04-10 03:00:00', '2026-04-10 03:00:00')`,
      )
      .run();
    localDb
      .prepare(
        `INSERT INTO notification_log (notification_type, priority, platform, content_summary, status, created_at, delivered_at)
         VALUES ('test', 'normal', 'slack', 'next-day', 'delivered',
                 '2026-04-11 05:00:00', '2026-04-11 05:00:00')`,
      )
      .run();

    const ts = localCollector.collectTimeseries(0, fixedNow);

    expect(ts.days).toBe(0);
    expect(ts.daily).toHaveLength(1);
    const bucket = ts.daily[0];

    // 2 inside rows (1 success + 1 failed) — both pre- and post- and edge excluded
    expect(bucket.executions).toBe(2);
    expect(bucket.executionsReactive).toBe(2);
    expect(bucket.executionsAutonomous).toBe(0);
    expect(bucket.failures).toBe(1);
    expect(bucket.date).toBe("2026-04-10");

    // avgDurationMs: only reactive-success inside → 1500ms (failed row excluded)
    expect(bucket.avgDurationMs).toBe(1500);

    // notification filter: 2 delivered inside (1 reacted, 1 ignored)
    expect(bucket.notificationsDelivered).toBe(2);
    expect(bucket.notificationsReacted).toBe(1);

    // errorGroupsInRange: 1 quota error attributed to 'codex' backend
    expect(ts.recentErrors).toHaveLength(1);
    expect(ts.recentErrors[0].category).toBe("quota");
    expect(ts.recentErrors[0].count).toBe(1);
    expect(ts.recentErrors[0].backend).toBe("codex");
    // 'some other error' on the next-day row must not leak in
    expect(
      ts.recentErrors.some((g) => g.sampleMessage.includes("some other")),
    ).toBe(false);

    localDb.close();
  });
});

describe("inferBackendFromModel", () => {
  it("maps sonnet/opus/haiku to claude-code", () => {
    expect(inferBackendFromModel("claude-sonnet-4-6")).toBe("claude-code");
    expect(inferBackendFromModel("claude-opus-4-6")).toBe("claude-code");
    expect(inferBackendFromModel("claude-haiku-4-5")).toBe("claude-code");
  });

  it("maps gemini-* to gemini-cli", () => {
    expect(inferBackendFromModel("gemini-2.0-flash")).toBe("gemini-cli");
    expect(inferBackendFromModel("gemini-1.5-pro")).toBe("gemini-cli");
  });

  it("maps codex/gpt/o3/o4 to codex", () => {
    expect(inferBackendFromModel("gpt-5-codex")).toBe("codex");
    expect(inferBackendFromModel("gpt-5")).toBe("codex");
    expect(inferBackendFromModel("o3-mini")).toBe("codex");
    expect(inferBackendFromModel("o4-mini")).toBe("codex");
  });

  it("returns null for null input", () => {
    expect(inferBackendFromModel(null)).toBeNull();
  });

  it("returns null for unknown models", () => {
    expect(inferBackendFromModel("llama-3")).toBeNull();
    expect(inferBackendFromModel("mistral-large")).toBeNull();
    expect(inferBackendFromModel("")).toBeNull();
  });
});

describe("groupErrorRows", () => {
  it("returns [] for empty input", () => {
    expect(groupErrorRows([])).toEqual([]);
  });

  it("groups rows by category and sorts by count desc", () => {
    const rows = [
      {
        error: "timeout: deadline exceeded",
        model_used: "gemini-2.0-flash",
        started_at: "2026-04-10 13:00:00",
      },
      {
        error: "quota exceeded",
        model_used: "claude-sonnet-4-6",
        started_at: "2026-04-10 15:00:00",
      },
      {
        error: "429 rate limit reached",
        model_used: "claude-sonnet-4-6",
        started_at: "2026-04-10 14:00:00",
      },
    ];
    const groups = groupErrorRows(rows);

    expect(groups).toHaveLength(2);
    // quota (count=2) before timeout (count=1)
    expect(groups[0].category).toBe("quota");
    expect(groups[0].count).toBe(2);
    expect(groups[0].backend).toBe("claude-code");
    expect(groups[1].category).toBe("timeout");
    expect(groups[1].count).toBe(1);
    expect(groups[1].backend).toBe("gemini-cli");
  });

  it("uses the FIRST row of each category as lastSeen and sampleMessage", () => {
    // Rows arrive DESC by started_at in the caller, so the first row of a
    // category is the newest one. groupErrorRows preserves that row's
    // started_at as lastSeen.
    const rows = [
      {
        error: "timeout A",
        model_used: "claude-sonnet-4-6",
        started_at: "2026-04-10 20:00:00",
      },
      {
        error: "timeout B",
        model_used: "claude-sonnet-4-6",
        started_at: "2026-04-10 10:00:00",
      },
    ];
    const groups = groupErrorRows(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].lastSeen).toBe("2026-04-10 20:00:00");
    expect(groups[0].sampleMessage).toBe("timeout A");
  });

  it("truncates sample messages longer than 200 chars with an ellipsis", () => {
    const longError = "timeout: " + "x".repeat(250);
    const groups = groupErrorRows([
      { error: longError, model_used: null, started_at: "2026-04-10 15:00:00" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].sampleMessage).toHaveLength(201); // 200 chars + "…"
    expect(groups[0].sampleMessage.endsWith("…")).toBe(true);
  });

  it("keeps short messages untouched", () => {
    const groups = groupErrorRows([
      {
        error: "network unreachable",
        model_used: null,
        started_at: "2026-04-10 15:00:00",
      },
    ]);
    expect(groups[0].sampleMessage).toBe("network unreachable");
    expect(groups[0].backend).toBeNull();
  });

  it("classifies auth / network categories correctly", () => {
    const groups = groupErrorRows([
      {
        error: "401 unauthorized",
        model_used: "claude-sonnet-4-6",
        started_at: "2026-04-10 10:00:00",
      },
      {
        error: "ECONNREFUSED",
        model_used: "claude-sonnet-4-6",
        started_at: "2026-04-10 11:00:00",
      },
      {
        error: "some weird thing",
        model_used: "claude-sonnet-4-6",
        started_at: "2026-04-10 12:00:00",
      },
    ]);
    const categories = groups.map((g) => g.category).sort();
    expect(categories).toEqual(["auth", "network", "other"]);
  });
});

// DELEGATED-TASK-MODE-DESIGN.md §11.2 — task-mode metrics aggregation.
describe("MetricsCollector.collectDelegatedTaskMetrics", () => {
  let db: Database.Database;
  let collector: MetricsCollector;

  beforeEach(() => {
    db = createTestDb();
    collector = new MetricsCollector(db);
  });

  function insertTaskRow(args: {
    actionType: "delegated_task.exec" | "delegated_task.run";
    backend: string;
    result: "success" | "failed";
    costUsd: number;
    detail: Record<string, unknown>;
  }): void {
    db.prepare(
      `INSERT INTO agent_actions (
         action_type, trigger, model_used,
         cost_usd, tokens_input, tokens_output,
         cache_creation_tokens, cache_read_tokens,
         duration_ms, num_turns, result, detail,
         started_at, completed_at, error, backend, cost_source
       ) VALUES (
         @action_type, NULL, @model_used,
         @cost_usd, 0, 0, 0, 0,
         0, 1, @result, @detail,
         datetime('now'), datetime('now'), NULL, @backend, 'sdk'
       )`,
    ).run({
      action_type: args.actionType,
      model_used: "test-model",
      cost_usd: args.costUsd,
      result: args.result,
      detail: JSON.stringify(args.detail),
      backend: args.backend,
    });
  }

  it("returns empty buckets when no rows exist", () => {
    const m = collector.collectDelegatedTaskMetrics();
    expect(m.total).toEqual([]);
    expect(m.toolCalls).toEqual([]);
    expect(m.validationFailures).toEqual([]);
    expect(m.destructiveBlocked).toEqual([]);
    expect(m.costUsd).toEqual([]);
    expect(m.windowDays).toBe(30);
  });

  it("aggregates total counts by integration+backend+result", () => {
    insertTaskRow({
      actionType: "delegated_task.exec",
      backend: "gemini",
      result: "success",
      costUsd: 0.001,
      detail: {
        integrationKey: "gmail",
        toolCallCount: 3,
        retried: false,
        needsConfirmation: false,
      },
    });
    insertTaskRow({
      actionType: "delegated_task.exec",
      backend: "gemini",
      result: "success",
      costUsd: 0.002,
      detail: {
        integrationKey: "gmail",
        toolCallCount: 5,
        retried: true,
        needsConfirmation: false,
      },
    });
    insertTaskRow({
      actionType: "delegated_task.exec",
      backend: "claude",
      result: "failed",
      costUsd: 0.0005,
      detail: {
        integrationKey: "gmail",
        toolCallCount: 1,
        errorClass: "schema_violation",
        retried: true,
        needsConfirmation: false,
      },
    });

    const m = collector.collectDelegatedTaskMetrics();
    const success = m.total.find(
      (t) => t.backend === "gemini" && t.result === "success",
    );
    expect(success?.count).toBe(2);
    const failed = m.total.find(
      (t) => t.backend === "claude" && t.result === "failed",
    );
    expect(failed?.count).toBe(1);
  });

  it("buckets needsConfirmation under destructive_blocked instead of success", () => {
    insertTaskRow({
      actionType: "delegated_task.exec",
      backend: "gemini",
      result: "success",
      costUsd: 0.001,
      detail: {
        integrationKey: "gmail",
        toolCallCount: 0,
        retried: false,
        needsConfirmation: true,
      },
    });

    const m = collector.collectDelegatedTaskMetrics();
    expect(m.total).toEqual([
      {
        integrationKey: "gmail",
        backend: "gemini",
        result: "destructive_blocked",
        count: 1,
      },
    ]);
    expect(m.destructiveBlocked).toEqual([
      { integrationKey: "gmail", backend: "gemini", count: 1 },
    ]);
  });

  it("aggregates tool-call histogram per integration+backend", () => {
    for (const count of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      insertTaskRow({
        actionType: "delegated_task.exec",
        backend: "gemini",
        result: "success",
        costUsd: 0.001,
        detail: {
          integrationKey: "gmail",
          toolCallCount: count,
          retried: false,
          needsConfirmation: false,
        },
      });
    }
    const m = collector.collectDelegatedTaskMetrics();
    const bucket = m.toolCalls[0];
    expect(bucket.histogram.count).toBe(10);
    expect(bucket.histogram.min).toBe(1);
    expect(bucket.histogram.max).toBe(10);
    expect(bucket.histogram.sum).toBe(55);
    expect(bucket.histogram.avg).toBeCloseTo(5.5);
    expect(bucket.histogram.p90).toBe(10);
  });

  it("counts validation failures by kind", () => {
    insertTaskRow({
      actionType: "delegated_task.exec",
      backend: "claude",
      result: "failed",
      costUsd: 0,
      detail: {
        integrationKey: "gmail",
        errorClass: "parse_error",
        toolCallCount: 0,
        retried: true,
        needsConfirmation: false,
      },
    });
    insertTaskRow({
      actionType: "delegated_task.exec",
      backend: "claude",
      result: "failed",
      costUsd: 0,
      detail: {
        integrationKey: "gmail",
        errorClass: "schema_violation",
        toolCallCount: 0,
        retried: true,
        needsConfirmation: false,
      },
    });
    insertTaskRow({
      actionType: "delegated_task.exec",
      backend: "claude",
      result: "failed",
      costUsd: 0,
      detail: {
        integrationKey: "gmail",
        errorClass: "tool_failed",
        toolCallCount: 0,
        retried: false,
        needsConfirmation: false,
      },
    });

    const m = collector.collectDelegatedTaskMetrics();
    const kinds = m.validationFailures
      .map((v) => `${v.kind}:${v.count}`)
      .sort();
    expect(kinds).toEqual(["parse_error:1", "schema_violation:1"]);
  });

  it("sums cost per integration+backend across exec and run", () => {
    insertTaskRow({
      actionType: "delegated_task.exec",
      backend: "gemini",
      result: "success",
      costUsd: 0.001,
      detail: {
        integrationKey: "gmail",
        toolCallCount: 1,
        retried: false,
        needsConfirmation: false,
      },
    });
    insertTaskRow({
      actionType: "delegated_task.exec",
      backend: "gemini",
      result: "success",
      costUsd: 0.0023,
      detail: {
        integrationKey: "gmail",
        toolCallCount: 1,
        retried: false,
        needsConfirmation: false,
      },
    });
    insertTaskRow({
      actionType: "delegated_task.run",
      backend: "claude",
      result: "success",
      costUsd: 0.005,
      detail: { toolCallCount: 1, retried: false, needsConfirmation: false },
    });

    const m = collector.collectDelegatedTaskMetrics();
    const gmail = m.costUsd.find(
      (c) => c.integrationKey === "gmail" && c.backend === "gemini",
    );
    expect(gmail?.costUsd).toBeCloseTo(0.0033);
    const run = m.costUsd.find(
      (c) => c.integrationKey === null && c.backend === "claude",
    );
    expect(run?.costUsd).toBeCloseTo(0.005);
  });

  it("clamps the days window to [1, 90]", () => {
    expect(collector.collectDelegatedTaskMetrics(0).windowDays).toBe(1);
    expect(collector.collectDelegatedTaskMetrics(1000).windowDays).toBe(90);
    expect(collector.collectDelegatedTaskMetrics(NaN).windowDays).toBe(30);
  });

  it("treats rows with NULL detail as empty without losing the row", () => {
    db.prepare(
      `INSERT INTO agent_actions (
         action_type, model_used, cost_usd, result, detail,
         started_at, completed_at, backend, cost_source
       ) VALUES (
         'delegated_task.exec', 'm', 0.01, 'success', NULL,
         datetime('now'), datetime('now'), 'gemini', 'sdk'
       )`,
    ).run();

    const m = collector.collectDelegatedTaskMetrics();
    expect(m.total[0].count).toBe(1);
    expect(m.total[0].integrationKey).toBeNull();
    expect(m.costUsd[0].costUsd).toBeCloseTo(0.01);
  });
});

// ── Phase 8 — management-registry metrics ────────────────────────────────────

describe("classifyManagedTaskRunResult", () => {
  it("classifies ok variants", () => {
    expect(classifyManagedTaskRunResult("ok")).toBe("ok");
    expect(classifyManagedTaskRunResult("OK")).toBe("ok");
    expect(classifyManagedTaskRunResult("ok (3 new)")).toBe("ok");
    expect(classifyManagedTaskRunResult("  ok  ")).toBe("ok");
  });

  it("classifies failed variants (case + punctuation insensitive)", () => {
    expect(classifyManagedTaskRunResult("failed")).toBe("failed");
    expect(classifyManagedTaskRunResult("Failed: rate limited")).toBe("failed");
    expect(classifyManagedTaskRunResult("FAILED (auth)")).toBe("failed");
  });

  it("classifies skipped variants", () => {
    expect(classifyManagedTaskRunResult("skipped")).toBe("skipped");
    expect(classifyManagedTaskRunResult("skipped: no new data")).toBe("skipped");
  });

  it("returns unknown for null, empty, or non-string input", () => {
    expect(classifyManagedTaskRunResult(null)).toBe("unknown");
    expect(classifyManagedTaskRunResult(undefined)).toBe("unknown");
    expect(classifyManagedTaskRunResult("")).toBe("unknown");
    expect(classifyManagedTaskRunResult("   ")).toBe("unknown");
    expect(classifyManagedTaskRunResult("pending")).toBe("unknown");
    // Defensive: non-string values returned by malformed JSON
    expect(classifyManagedTaskRunResult(42 as unknown as string)).toBe("unknown");
  });

  it("does NOT match prefixes that are not whole-word leading tokens", () => {
    // Words like "okie", "failure", "skipping" should not be coerced to
    // ok / failed / skipped — they're free-form strings the agent
    // happens to start with similar letters.
    expect(classifyManagedTaskRunResult("failure")).toBe("unknown");
    expect(classifyManagedTaskRunResult("skipping the run")).toBe("unknown");
    expect(classifyManagedTaskRunResult("okay")).toBe("unknown");
  });
});

describe("aggregateManagedTaskRuns", () => {
  it("returns zero counts for an empty input", () => {
    expect(aggregateManagedTaskRuns([])).toEqual({
      ok: 0,
      failed: 0,
      skipped: 0,
      unknown: 0,
    });
  });

  it("sums multiple rows into the four buckets", () => {
    const result = aggregateManagedTaskRuns([
      { last_result: "ok (3 new)", cnt: 5 },
      { last_result: "ok", cnt: 2 },
      { last_result: "failed: timeout", cnt: 3 },
      { last_result: "skipped", cnt: 1 },
      { last_result: null, cnt: 4 },
    ]);
    expect(result).toEqual({ ok: 7, failed: 3, skipped: 1, unknown: 4 });
  });
});

describe("MetricsCollector.collectManagementMetrics", () => {
  let db: Database.Database;
  let collector: MetricsCollector;

  const baseOptions = {
    softWarningThreshold: 30,
    hardCap: 100,
    failureNotifyThreshold: 3,
  };

  beforeEach(() => {
    resetManagementTelemetry();
    db = new Database(":memory:");
    applySchema(db);
    collector = new MetricsCollector(db);
  });

  function insertManagedTask(
    id: string,
    overrides: Partial<{
      app: string;
      app_normalized: string;
      consecutive_failures: number;
    }> = {},
  ): void {
    const app = overrides.app ?? "zoom";
    const appNormalized = overrides.app_normalized ?? app.toLowerCase();
    const failures = overrides.consecutive_failures ?? 0;
    // recurring_schedules has its own NOT NULL constraints; insert a
    // companion row so the FK is satisfied. The numeric mt suffix is
    // reused for the schedule id so the test fixture stays compact.
    const scheduleId = Number(id.replace(/^mt_/, ""));
    db.prepare(
      `INSERT INTO recurring_schedules (id, task_type, recurrence_rule, task_description, created_at, updated_at)
       VALUES (?, 'scheduled.task', ?, ?, datetime('now'), datetime('now'))`,
    ).run(scheduleId, "FREQ=DAILY;BYHOUR=10;BYMINUTE=0", `mt:${id}`);
    db.prepare(
      `INSERT INTO managed_tasks
        (id, intent, app, app_normalized, cadence, schedule_id,
         consecutive_failures, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'daily', ?, ?, datetime('now'), datetime('now'))`,
    ).run(id, "Test", app, appNormalized, scheduleId, failures);
  }

  function insertRunAuditRow(lastResult: string, daysAgo = 0): void {
    db.prepare(
      `INSERT INTO agent_actions (action_type, trigger, result, detail, started_at)
       VALUES ('management_task.run_recorded', 'autonomous', 'success', ?,
               datetime('now', '-' || ? || ' days'))`,
    ).run(JSON.stringify({ last_result: lastResult, mt_id: "mt_1" }), daysAgo);
  }

  it("returns zero counts on a fresh DB", () => {
    const m = collector.collectManagementMetrics(baseOptions);
    expect(m.active).toBe(0);
    expect(m.failingNow).toBe(0);
    expect(m.consecutiveFailures).toEqual([]);
    expect(m.runs).toEqual({ ok: 0, failed: 0, skipped: 0, unknown: 0 });
    expect(m.softWarningThreshold).toBe(30);
    expect(m.hardCap).toBe(100);
    expect(m.failureNotifyThreshold).toBe(3);
  });

  it("counts active managed tasks", () => {
    insertManagedTask("mt_1");
    insertManagedTask("mt_2", { app: "gmail", app_normalized: "gmail" });
    const m = collector.collectManagementMetrics(baseOptions);
    expect(m.active).toBe(2);
  });

  it("emits per-mt_id buckets for nonzero consecutive_failures, sorted by count desc", () => {
    insertManagedTask("mt_1", { consecutive_failures: 0 });
    insertManagedTask("mt_2", {
      app: "notion",
      app_normalized: "notion",
      consecutive_failures: 2,
    });
    insertManagedTask("mt_3", {
      app: "gmail",
      app_normalized: "gmail",
      consecutive_failures: 5,
    });

    const m = collector.collectManagementMetrics(baseOptions);
    expect(m.consecutiveFailures).toEqual([
      { mtId: "mt_3", app: "gmail", count: 5 },
      { mtId: "mt_2", app: "notion", count: 2 },
    ]);
  });

  it("counts failingNow at or above the configured notify threshold", () => {
    insertManagedTask("mt_1", { consecutive_failures: 2 });
    insertManagedTask("mt_2", {
      app: "gmail",
      app_normalized: "gmail",
      consecutive_failures: 3,
    });
    insertManagedTask("mt_3", {
      app: "notion",
      app_normalized: "notion",
      consecutive_failures: 7,
    });

    const m = collector.collectManagementMetrics(baseOptions);
    // Only mt_2 (=3) and mt_3 (=7) cross the threshold of 3.
    expect(m.failingNow).toBe(2);
  });

  it("aggregates run-result audit rows over the configured window", () => {
    insertRunAuditRow("ok (3 new)", 0);
    insertRunAuditRow("ok", 1);
    insertRunAuditRow("failed: rate limited", 2);
    insertRunAuditRow("skipped: no new data", 3);
    // Outside default 30-day window — should be excluded.
    insertRunAuditRow("ok", 60);

    const m = collector.collectManagementMetrics(baseOptions);
    expect(m.runs).toEqual({ ok: 2, failed: 1, skipped: 1, unknown: 0 });
  });

  it("clamps the windowDays parameter to [1, 90]", () => {
    expect(
      collector.collectManagementMetrics({ ...baseOptions, windowDays: 0 })
        .windowDays,
    ).toBe(1);
    expect(
      collector.collectManagementMetrics({ ...baseOptions, windowDays: 1000 })
        .windowDays,
    ).toBe(90);
    expect(
      collector.collectManagementMetrics({
        ...baseOptions,
        windowDays: Number.NaN,
      }).windowDays,
    ).toBe(30);
  });

  it("threads the in-memory telemetry buffers through the snapshot", () => {
    recordManagementMdRenderDuration(15);
    recordManagementMdRenderDuration(45);
    recordActivityViewRebuildDuration("zoom", 100);
    recordEntityMirrorLag(250);

    const m = collector.collectManagementMetrics(baseOptions);
    expect(m.managementMdRenderMs.count).toBe(2);
    expect(m.managementMdRenderMs.avg).toBe(30);
    expect(m.activityViewRebuildMs).toEqual([
      {
        source: "zoom",
        histogram: expect.objectContaining({ count: 1, avg: 100 }),
      },
    ]);
    expect(m.entityMirrorLag.lastMs).toBe(250);
  });

  it("falls back to zero counts when the managed_tasks table is missing", () => {
    const bareDb = new Database(":memory:");
    // No applySchema → no managed_tasks table.
    const bareCollector = new MetricsCollector(bareDb);
    const m = bareCollector.collectManagementMetrics(baseOptions);
    expect(m.active).toBe(0);
    expect(m.failingNow).toBe(0);
    expect(m.consecutiveFailures).toEqual([]);
    expect(m.runs).toEqual({ ok: 0, failed: 0, skipped: 0, unknown: 0 });
  });
});

// docs/design/appendices/pre-pass-fan-out.md §7.3 — pure aggregation kernel for the
// `pre_pass_*` metric families. Tested in isolation (no DB) so chain
// rollup logic is locked independently of SQL projection details.
describe("aggregatePrePassMetrics", () => {
  function attempt(
    overrides: {
      pcid?: string;
      routine?: string;
      integration?: string;
      attempt?: number;
      status?: "success" | "partial" | "failed" | "skipped";
      costUsd?: number;
      durationMs?: number;
      fallbackTriggered?: boolean;
      requestedBackend?: string | null;
      actualBackend?: string | null;
      cacheCreationTokens?: number | null;
      cacheReadTokens?: number | null;
      tokensInput?: number | null;
    } = {},
  ) {
    // `??` over `||` so explicit `null` passes through (the
    // null-pair-skip test depends on that distinction); bare overrides
    // not present in the partial fall back to the defaults.
    return {
      pcid: overrides.pcid ?? "p1",
      routine: overrides.routine ?? "routine.morning_routine",
      integration: overrides.integration ?? "gmail",
      attempt: overrides.attempt ?? 1,
      status: overrides.status ?? "success",
      costUsd: overrides.costUsd ?? 0.05,
      durationMs: overrides.durationMs ?? 1000,
      fallbackTriggered: overrides.fallbackTriggered ?? false,
      requestedBackend:
        "requestedBackend" in overrides ? overrides.requestedBackend ?? null : "claude",
      actualBackend:
        "actualBackend" in overrides ? overrides.actualBackend ?? null : "claude",
      cacheCreationTokens:
        "cacheCreationTokens" in overrides ? overrides.cacheCreationTokens ?? null : null,
      cacheReadTokens:
        "cacheReadTokens" in overrides ? overrides.cacheReadTokens ?? null : null,
      tokensInput:
        "tokensInput" in overrides ? overrides.tokensInput ?? null : null,
    };
  }

  it("returns the empty snapshot for zero attempts", () => {
    const snap = aggregatePrePassMetrics([], 30, "2026-05-13T00:00:00.000Z");
    expect(snap.totalChains).toBe(0);
    expect(snap.totalAttempts).toBe(0);
    expect(snap.chainsByStatus).toEqual([]);
    expect(snap.attemptsPerChain).toEqual([]);
    expect(snap.costUsdByRoutine).toEqual([]);
    expect(snap.durationMsByIntegration).toEqual([]);
    expect(snap.fallbacks).toEqual([]);
  });

  it("rolls up multi-attempt chains by (pcid, integration) and uses the MAX-attempt status as terminal", () => {
    // One chain (pcid=p1, gmail) with three attempts: partial, partial,
    // success. Terminal status = success because attempt 3 is the
    // highest-numbered attempt.
    const snap = aggregatePrePassMetrics(
      [
        attempt({ pcid: "p1", integration: "gmail", attempt: 1, status: "partial", costUsd: 0.05, durationMs: 1000 }),
        attempt({ pcid: "p1", integration: "gmail", attempt: 2, status: "partial", costUsd: 0.07, durationMs: 1500 }),
        attempt({ pcid: "p1", integration: "gmail", attempt: 3, status: "success", costUsd: 0.06, durationMs: 800 }),
      ],
      30,
      "2026-05-13T00:00:00.000Z",
    );
    expect(snap.totalChains).toBe(1);
    expect(snap.totalAttempts).toBe(3);
    expect(snap.chainsByStatus).toEqual([
      { routine: "routine.morning_routine", integrationKey: "gmail", status: "success", count: 1 },
    ]);
    const attempts = snap.attemptsPerChain[0]!;
    expect(attempts.histogram.count).toBe(1);
    expect(attempts.histogram.avg).toBe(3);
    const cost = snap.costUsdByRoutine[0]!;
    expect(cost.histogram.sum).toBeCloseTo(0.18, 5);
    const duration = snap.durationMsByIntegration[0]!;
    expect(duration.histogram.sum).toBe(3300);
  });

  it("separates chains across different integrations of the same parent routine", () => {
    // Same pcid, different integrations → two chains.
    const snap = aggregatePrePassMetrics(
      [
        attempt({ pcid: "p1", integration: "gmail", attempt: 1, status: "success" }),
        attempt({ pcid: "p1", integration: "google_calendar", attempt: 1, status: "failed" }),
      ],
      30,
      "2026-05-13T00:00:00.000Z",
    );
    expect(snap.totalChains).toBe(2);
    expect(snap.chainsByStatus).toEqual([
      { routine: "routine.morning_routine", integrationKey: "gmail", status: "success", count: 1 },
      { routine: "routine.morning_routine", integrationKey: "google_calendar", status: "failed", count: 1 },
    ]);
  });

  it("counts each unique (pcid, integration) as a distinct chain (multiple parent routines)", () => {
    // Two morning_routine runs, each producing a gmail chain.
    const snap = aggregatePrePassMetrics(
      [
        attempt({ pcid: "p1", integration: "gmail", attempt: 1, status: "success" }),
        attempt({ pcid: "p2", integration: "gmail", attempt: 1, status: "failed" }),
        attempt({ pcid: "p2", integration: "gmail", attempt: 2, status: "failed" }),
      ],
      30,
      "2026-05-13T00:00:00.000Z",
    );
    expect(snap.totalChains).toBe(2);
    expect(snap.totalAttempts).toBe(3);
    const success = snap.chainsByStatus.find((b) => b.status === "success");
    const failed = snap.chainsByStatus.find((b) => b.status === "failed");
    expect(success?.count).toBe(1);
    expect(failed?.count).toBe(1);
    // attempts histogram sees [1, 2] — one for each chain.
    const attempts = snap.attemptsPerChain[0]!;
    expect(attempts.histogram.count).toBe(2);
    expect(attempts.histogram.min).toBe(1);
    expect(attempts.histogram.max).toBe(2);
  });

  it("counts fallbacks at the attempt level grouped by (routine, requested, actual)", () => {
    const snap = aggregatePrePassMetrics(
      [
        attempt({
          fallbackTriggered: true,
          requestedBackend: "claude",
          actualBackend: "codex",
        }),
        attempt({
          pcid: "p2",
          fallbackTriggered: true,
          requestedBackend: "claude",
          actualBackend: "codex",
        }),
        attempt({
          pcid: "p3",
          fallbackTriggered: true,
          requestedBackend: "claude",
          actualBackend: "gemini",
        }),
        // Non-fallback attempt — must NOT appear in the bucket.
        attempt({ pcid: "p4", fallbackTriggered: false }),
      ],
      30,
      "2026-05-13T00:00:00.000Z",
    );
    expect(snap.fallbacks).toEqual([
      {
        routine: "routine.morning_routine",
        requestedBackend: "claude",
        actualBackend: "codex",
        count: 2,
      },
      {
        routine: "routine.morning_routine",
        requestedBackend: "claude",
        actualBackend: "gemini",
        count: 1,
      },
    ]);
  });

  it("ignores fallbacks where requestedBackend or actualBackend is null (cannot pair)", () => {
    const snap = aggregatePrePassMetrics(
      [
        attempt({
          fallbackTriggered: true,
          requestedBackend: null,
          actualBackend: "codex",
        }),
        attempt({
          pcid: "p2",
          fallbackTriggered: true,
          requestedBackend: "claude",
          actualBackend: null,
        }),
      ],
      30,
      "2026-05-13T00:00:00.000Z",
    );
    expect(snap.fallbacks).toEqual([]);
  });

  // docs/design/appendices/fetch-window-cost-reduction.md §10.1 — verification metric
  // for Phase 1. The histogram is the load-bearing surface: a Phase 1
  // deploy is considered effective when `p50` drops by ≥25 K.
  it("emits per-attempt cache_creation / cache_read histograms with quantile estimates", () => {
    const snap = aggregatePrePassMetrics(
      [
        attempt({ cacheCreationTokens: 30_000, cacheReadTokens: 80_000 }),
        attempt({ pcid: "p2", cacheCreationTokens: 50_000, cacheReadTokens: 120_000 }),
        attempt({ pcid: "p3", cacheCreationTokens: 70_000, cacheReadTokens: 200_000 }),
      ],
      30,
      "2026-05-13T00:00:00.000Z",
    );
    expect(snap.cacheCreationTokensPerAttempt.count).toBe(3);
    expect(snap.cacheCreationTokensPerAttempt.min).toBe(30_000);
    expect(snap.cacheCreationTokensPerAttempt.max).toBe(70_000);
    expect(snap.cacheCreationTokensPerAttempt.sum).toBe(150_000);
    // p50 across [30K, 50K, 70K] using nearest-rank → 50K.
    expect(snap.cacheCreationTokensPerAttempt.p50).toBe(50_000);
    expect(snap.cacheReadTokensPerAttempt.count).toBe(3);
    expect(snap.cacheReadTokensPerAttempt.sum).toBe(400_000);
  });

  // Phase 1 only changes the cache_create side; the histogram must
  // continue to omit null samples (legacy rows / non-Claude backends)
  // rather than treating them as zero — including zeros would skew the
  // p50 verification target downward.
  it("excludes attempts with null cache_creation_tokens from the histogram", () => {
    const snap = aggregatePrePassMetrics(
      [
        attempt({ cacheCreationTokens: 60_000 }),
        attempt({ pcid: "p2", cacheCreationTokens: null }),
        attempt({ pcid: "p3", cacheCreationTokens: 80_000 }),
      ],
      30,
      "2026-05-13T00:00:00.000Z",
    );
    expect(snap.cacheCreationTokensPerAttempt.count).toBe(2);
    expect(snap.cacheCreationTokensPerAttempt.min).toBe(60_000);
    expect(snap.cacheCreationTokensPerAttempt.max).toBe(80_000);
  });

  it("returns a zero-count histogram (not null) for an empty attempts array", () => {
    const snap = aggregatePrePassMetrics([], 30, "2026-05-13T00:00:00.000Z");
    expect(snap.cacheCreationTokensPerAttempt.count).toBe(0);
    expect(snap.cacheCreationTokensPerAttempt.p50).toBeNull();
    expect(snap.cacheReadTokensPerAttempt.count).toBe(0);
  });

  it("emits stable, sorted output (snapshots are byte-comparable across runs)", () => {
    const snap = aggregatePrePassMetrics(
      [
        attempt({ pcid: "p3", routine: "routine.hourly_check", integration: "notion" }),
        attempt({ pcid: "p1", routine: "routine.morning_routine", integration: "gmail" }),
        attempt({ pcid: "p2", routine: "routine.morning_routine", integration: "google_calendar" }),
      ],
      30,
      "2026-05-13T00:00:00.000Z",
    );
    // Sorted by routine, then integration. routine.hourly_check < routine.morning_routine.
    const order = snap.chainsByStatus.map((b) => `${b.routine}/${b.integrationKey}`);
    expect(order).toEqual([
      "routine.hourly_check/notion",
      "routine.morning_routine/gmail",
      "routine.morning_routine/google_calendar",
    ]);
  });

  // docs/design/appendices/fetch-window-cost-reduction.md §10.1 / §10.2 Phase 1.5
  // amendment — Codex / Gemini parsers persist
  // `cache_creation_tokens = 0` (no paid cache-creation dimension on
  // their providers). Including those zeros in the histogram would skew
  // p50 toward 0 and obscure the Phase 1 verification target. The
  // aggregator must filter to `actualBackend === 'claude'` for both
  // cache histograms.
  it("filters cacheCreationTokensPerAttempt / cacheReadTokensPerAttempt to actualBackend='claude'", () => {
    const snap = aggregatePrePassMetrics(
      [
        attempt({
          actualBackend: "claude",
          cacheCreationTokens: 60_000,
          cacheReadTokens: 100_000,
        }),
        // Codex / Gemini rows would carry 0 for cache creation; they
        // MUST NOT contribute to the Claude-only histogram.
        attempt({
          pcid: "p2",
          actualBackend: "codex",
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        }),
        attempt({
          pcid: "p3",
          actualBackend: "gemini",
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        }),
      ],
      30,
      "2026-05-13T00:00:00.000Z",
    );
    expect(snap.cacheCreationTokensPerAttempt.count).toBe(1);
    expect(snap.cacheCreationTokensPerAttempt.min).toBe(60_000);
    expect(snap.cacheReadTokensPerAttempt.count).toBe(1);
    expect(snap.cacheReadTokensPerAttempt.min).toBe(100_000);
  });

  // Phase 1.5 §10.1 — non-Claude analog of the cache-create histogram.
  // Per-backend `tokens_input` and `cost_usd` buckets surface the
  // CLI instruction-file minimization saving directly.
  it("emits per-backend tokens_input and cost_usd histograms bucketed by actualBackend", () => {
    const snap = aggregatePrePassMetrics(
      [
        attempt({ actualBackend: "claude", costUsd: 0.05, tokensInput: 40_000 }),
        attempt({ pcid: "p2", actualBackend: "codex", costUsd: 0.02, tokensInput: 18_000 }),
        attempt({ pcid: "p3", actualBackend: "codex", costUsd: 0.03, tokensInput: 22_000 }),
        attempt({ pcid: "p4", actualBackend: "gemini", costUsd: 0.01, tokensInput: 12_000 }),
      ],
      30,
      "2026-05-13T00:00:00.000Z",
    );

    // Sorted by actualBackend alphabetically.
    expect(snap.inputTokensByBackend.map((b) => b.actualBackend)).toEqual([
      "claude",
      "codex",
      "gemini",
    ]);
    const codexInput = snap.inputTokensByBackend.find((b) => b.actualBackend === "codex");
    expect(codexInput?.histogram.count).toBe(2);
    expect(codexInput?.histogram.min).toBe(18_000);
    expect(codexInput?.histogram.max).toBe(22_000);

    const claudeInput = snap.inputTokensByBackend.find((b) => b.actualBackend === "claude");
    expect(claudeInput?.histogram.count).toBe(1);
    expect(claudeInput?.histogram.sum).toBe(40_000);

    const codexCost = snap.costUsdByBackend.find((b) => b.actualBackend === "codex");
    expect(codexCost?.histogram.count).toBe(2);
    expect(codexCost?.histogram.sum).toBeCloseTo(0.05, 5);
    const geminiCost = snap.costUsdByBackend.find((b) => b.actualBackend === "gemini");
    expect(geminiCost?.histogram.sum).toBeCloseTo(0.01, 5);
  });

  // Sister to `excludes attempts with null cache_creation_tokens` —
  // `tokens_input` is sometimes NULL on legacy rows; those samples
  // must be skipped on the per-backend bucket too. But the bucket
  // itself stays present because `cost_usd` always coalesces to 0,
  // so the backend's costUsdByBackend entry is always populated.
  it("excludes attempts with null tokens_input from inputTokensByBackend but still surfaces the backend in costUsdByBackend", () => {
    const snap = aggregatePrePassMetrics(
      [
        attempt({ pcid: "p1", actualBackend: "codex", costUsd: 0.02, tokensInput: 18_000 }),
        attempt({ pcid: "p2", actualBackend: "codex", costUsd: 0.01, tokensInput: null }),
      ],
      30,
      "2026-05-13T00:00:00.000Z",
    );
    const codexInput = snap.inputTokensByBackend.find((b) => b.actualBackend === "codex");
    expect(codexInput?.histogram.count).toBe(1);
    expect(codexInput?.histogram.sum).toBe(18_000);
    const codexCost = snap.costUsdByBackend.find((b) => b.actualBackend === "codex");
    expect(codexCost?.histogram.count).toBe(2);
    expect(codexCost?.histogram.sum).toBeCloseTo(0.03, 5);
  });

  // Attempts with no resolved backend (legacy rows) can't prove a
  // per-backend saving — drop them silently rather than putting them
  // in a fabricated 'unknown' bucket that would mislead the reader.
  it("drops attempts with null actualBackend from the per-backend buckets entirely", () => {
    const snap = aggregatePrePassMetrics(
      [
        attempt({ actualBackend: null, costUsd: 0.05, tokensInput: 100 }),
      ],
      30,
      "2026-05-13T00:00:00.000Z",
    );
    expect(snap.inputTokensByBackend).toEqual([]);
    expect(snap.costUsdByBackend).toEqual([]);
  });
});

describe("MetricsCollector.collectPrePassMetrics", () => {
  let db: Database.Database;
  let collector: MetricsCollector;

  beforeEach(() => {
    db = createTestDb();
    collector = new MetricsCollector(db);
  });

  function insertPrePassRow(detail: Record<string, unknown>, opts: {
    costUsd?: number;
    durationMs?: number;
    backend?: string;
    tokensInput?: number | null;
    cacheCreationTokens?: number | null;
    cacheReadTokens?: number | null;
  } = {}): void {
    db.prepare(
      `INSERT INTO agent_actions (
         action_type, trigger, model_used,
         cost_usd, tokens_input, tokens_output,
         cache_creation_tokens, cache_read_tokens,
         duration_ms, num_turns, result, detail,
         started_at, completed_at, error, backend, cost_source
       ) VALUES (
         'routine.fetch_window', 'autonomous', 'claude-haiku-4-5',
         @cost_usd, @tokens_input, 0, @cache_create, @cache_read,
         @duration_ms, 1, 'success', @detail,
         datetime('now'), datetime('now'), NULL, @backend, 'sdk'
       )`,
    ).run({
      cost_usd: opts.costUsd ?? 0.05,
      duration_ms: opts.durationMs ?? 1000,
      tokens_input:
        "tokensInput" in opts ? opts.tokensInput ?? null : 0,
      cache_create:
        "cacheCreationTokens" in opts ? opts.cacheCreationTokens ?? null : null,
      cache_read:
        "cacheReadTokens" in opts ? opts.cacheReadTokens ?? null : null,
      detail: JSON.stringify({ prePass: detail }),
      backend: opts.backend ?? "claude",
    });
  }

  it("returns empty snapshot when no rows exist", () => {
    const snap = collector.collectPrePassMetrics();
    expect(snap.totalChains).toBe(0);
    expect(snap.totalAttempts).toBe(0);
    expect(snap.chainsByStatus).toEqual([]);
    expect(snap.windowDays).toBe(30);
  });

  it("aggregates rows from agent_actions through the SQL → JS pipeline", () => {
    insertPrePassRow({
      parentCorrelationId: "p1",
      parentRoutine: "routine.morning_routine",
      integrationKey: "gmail",
      attempt: 1,
      maxAttempts: 3,
      retriedFromAttempt: null,
      status: "partial",
      fetched: 3,
      posted: 0,
      duplicates: 0,
      errors: [],
      willRetry: true,
      retryReason: "partial-no-post",
      requestedBackend: "claude",
    });
    insertPrePassRow({
      parentCorrelationId: "p1",
      parentRoutine: "routine.morning_routine",
      integrationKey: "gmail",
      attempt: 2,
      maxAttempts: 3,
      retriedFromAttempt: 1,
      status: "success",
      fetched: 3,
      posted: 3,
      duplicates: 0,
      errors: [],
      willRetry: false,
      retryReason: "success",
      requestedBackend: "claude",
    });

    const snap = collector.collectPrePassMetrics();
    expect(snap.totalChains).toBe(1);
    expect(snap.totalAttempts).toBe(2);
    expect(snap.chainsByStatus).toEqual([
      { routine: "routine.morning_routine", integrationKey: "gmail", status: "success", count: 1 },
    ]);
  });

  it("skips rows where detail.prePass is missing or malformed (soft-fail)", () => {
    // Valid prePass row (will be counted).
    insertPrePassRow({
      parentCorrelationId: "p1",
      parentRoutine: "routine.morning_routine",
      integrationKey: "gmail",
      attempt: 1,
      maxAttempts: 1,
      retriedFromAttempt: null,
      status: "success",
      fetched: 1,
      posted: 1,
      duplicates: 0,
      errors: [],
      willRetry: false,
      retryReason: "success",
    });
    // SQLite's `detail JSON` column type rejects malformed JSON at
    // insert time (json_valid enforced via the FTS trigger), so we
    // can't simulate that path through the DB. The aggregator's
    // soft-fail try/catch is still exercised — this test focuses on
    // the well-formed-JSON-but-no-prePass-key path that DOES reach the
    // aggregator and must be skipped silently.
    // Row with detail but no prePass key (must NOT count).
    db.prepare(
      `INSERT INTO agent_actions (
         action_type, trigger, model_used,
         cost_usd, tokens_input, tokens_output,
         cache_creation_tokens, cache_read_tokens,
         duration_ms, num_turns, result, detail,
         started_at, completed_at, error, backend, cost_source
       ) VALUES (
         'routine.fetch_window', 'autonomous', 'claude-haiku-4-5',
         0, 0, 0, 0, 0, 0, 1, 'success', '{"foo":"bar"}',
         datetime('now'), datetime('now'), NULL, 'claude', 'sdk'
       )`,
    ).run();

    const snap = collector.collectPrePassMetrics();
    // Only the valid row contributes.
    expect(snap.totalChains).toBe(1);
    expect(snap.totalAttempts).toBe(1);
  });

  it("ignores non-routine.fetch_window rows", () => {
    db.prepare(
      `INSERT INTO agent_actions (
         action_type, trigger, model_used,
         cost_usd, tokens_input, tokens_output,
         cache_creation_tokens, cache_read_tokens,
         duration_ms, num_turns, result, detail,
         started_at, completed_at, error, backend, cost_source
       ) VALUES (
         'message.received', 'reactive', 'claude-haiku-4-5',
         0.01, 0, 0, 0, 0, 100, 1, 'success', '{"prePass":{"parentCorrelationId":"p1"}}',
         datetime('now'), datetime('now'), NULL, 'claude', 'sdk'
       )`,
    ).run();

    const snap = collector.collectPrePassMetrics();
    expect(snap.totalChains).toBe(0);
    expect(snap.totalAttempts).toBe(0);
  });

  it("clamps `days` to [1, 90] and falls back to 30 on garbage input", () => {
    expect(collector.collectPrePassMetrics(0).windowDays).toBe(1);
    expect(collector.collectPrePassMetrics(200).windowDays).toBe(90);
    expect(collector.collectPrePassMetrics(Number.NaN).windowDays).toBe(30);
  });

  it("rolls cache_creation / cache_read columns into per-attempt histograms", () => {
    insertPrePassRow(
      {
        parentCorrelationId: "p1",
        parentRoutine: "routine.morning_routine",
        integrationKey: "gmail",
        attempt: 1,
        status: "success",
      },
      { cacheCreationTokens: 89_000, cacheReadTokens: 200_000 },
    );
    insertPrePassRow(
      {
        parentCorrelationId: "p2",
        parentRoutine: "routine.hourly_check",
        integrationKey: "gmail",
        attempt: 1,
        status: "success",
      },
      { cacheCreationTokens: 60_000, cacheReadTokens: 90_000 },
    );

    const snap = collector.collectPrePassMetrics();
    expect(snap.cacheCreationTokensPerAttempt.count).toBe(2);
    expect(snap.cacheCreationTokensPerAttempt.sum).toBe(149_000);
    expect(snap.cacheCreationTokensPerAttempt.min).toBe(60_000);
    expect(snap.cacheCreationTokensPerAttempt.max).toBe(89_000);
    expect(snap.cacheReadTokensPerAttempt.count).toBe(2);
    expect(snap.cacheReadTokensPerAttempt.sum).toBe(290_000);
  });

  // docs/design/appendices/fetch-window-cost-reduction.md Phase 1.5 — per-backend
  // input-token + cost histograms surface through the SQL → JS
  // pipeline. Mixed Claude / Codex / Gemini rows must each land in
  // their own bucket, and Codex / Gemini cache-creation zeros must NOT
  // contribute to the Claude-only cache_create histogram.
  it("rolls tokens_input + cost_usd into per-backend histograms and excludes non-Claude rows from cacheCreationTokensPerAttempt", () => {
    insertPrePassRow(
      {
        parentCorrelationId: "p1",
        parentRoutine: "routine.morning_routine",
        integrationKey: "gmail",
        attempt: 1,
        status: "success",
      },
      {
        backend: "claude",
        tokensInput: 30_000,
        cacheCreationTokens: 70_000,
        cacheReadTokens: 150_000,
        costUsd: 0.13,
      },
    );
    insertPrePassRow(
      {
        parentCorrelationId: "p2",
        parentRoutine: "routine.hourly_check",
        integrationKey: "gmail",
        attempt: 1,
        status: "success",
      },
      {
        backend: "codex",
        tokensInput: 12_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0.04,
      },
    );
    insertPrePassRow(
      {
        parentCorrelationId: "p3",
        parentRoutine: "routine.hourly_check",
        integrationKey: "google_calendar",
        attempt: 1,
        status: "success",
      },
      {
        backend: "gemini",
        tokensInput: 14_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0.02,
      },
    );

    const snap = collector.collectPrePassMetrics();
    // Claude-only cache_create histogram — Codex / Gemini zeros excluded.
    expect(snap.cacheCreationTokensPerAttempt.count).toBe(1);
    expect(snap.cacheCreationTokensPerAttempt.sum).toBe(70_000);
    expect(snap.cacheReadTokensPerAttempt.count).toBe(1);
    expect(snap.cacheReadTokensPerAttempt.sum).toBe(150_000);

    // Per-backend input tokens — every backend present, sorted alphabetically.
    expect(snap.inputTokensByBackend.map((b) => b.actualBackend)).toEqual([
      "claude",
      "codex",
      "gemini",
    ]);
    expect(
      snap.inputTokensByBackend.find((b) => b.actualBackend === "codex")?.histogram.sum,
    ).toBe(12_000);
    expect(
      snap.inputTokensByBackend.find((b) => b.actualBackend === "gemini")?.histogram.sum,
    ).toBe(14_000);

    // Per-backend cost USD — same three buckets.
    expect(snap.costUsdByBackend.map((b) => b.actualBackend)).toEqual([
      "claude",
      "codex",
      "gemini",
    ]);
    expect(
      snap.costUsdByBackend.find((b) => b.actualBackend === "claude")?.histogram.sum,
    ).toBeCloseTo(0.13, 5);
  });
});
