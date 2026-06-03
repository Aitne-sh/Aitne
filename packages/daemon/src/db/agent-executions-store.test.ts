import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import { upsertAgent, type AgentUpsertInput } from "./agents-store.js";
import {
  byErrorKind,
  completeExecution,
  getExecution,
  listExecutions,
  metricsWindow,
  startExecution,
  sweepAbandoned,
} from "./agent-executions-store.js";

function seedAgent(db: Database.Database, slug: string): void {
  const input: AgentUpsertInput = {
    slug,
    name: slug,
    source: "user",
    definitionPath: `/vault/policies/agents/${slug}/agent.md`,
    definitionHash: "h",
    enabled: true,
    processKey: "agent.task",
    scheduleKind: "cron",
    scheduleExpression: "0 9 * * *",
    scheduleTimezone: "UTC",
  } as AgentUpsertInput;
  upsertAgent(db, input);
}

function seedScheduleRow(db: Database.Database): number {
  const r = db
    .prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type) VALUES (?, ?)",
    )
    .run("2026-01-01 00:00:00", "agent.task");
  return Number(r.lastInsertRowid);
}

describe("agent-executions-store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    seedAgent(db, "deploy-watch");
  });

  afterEach(() => {
    db.close();
  });

  describe("startExecution", () => {
    it("inserts an in-flight row and returns its id", () => {
      const id = startExecution(
        db,
        { agentId: "deploy-watch", trigger: "cron" },
        1000,
      );
      const dto = getExecution(db, id);
      expect(dto).toMatchObject({
        id,
        agentId: "deploy-watch",
        scheduleRowId: null,
        trigger: "cron",
        startedAt: 1000,
        endedAt: null,
        result: null,
        successCriteria: null,
      });
    });

    it("links a schedule row when provided", () => {
      const scheduleRowId = seedScheduleRow(db);
      const id = startExecution(db, {
        agentId: "deploy-watch",
        trigger: "manual",
        scheduleRowId,
      });
      expect(getExecution(db, id)!.scheduleRowId).toBe(scheduleRowId);
    });
  });

  describe("completeExecution", () => {
    it("finalises a row with full cost, criteria, and summary", () => {
      const id = startExecution(db, { agentId: "deploy-watch", trigger: "cron" }, 1000);
      const ok = completeExecution(
        db,
        {
          executionId: id,
          result: "success",
          cost: { usd: 0.18, tokensIn: 1200, tokensOut: 800, turns: 6 },
          successCriteriaHits: { today_md: true, digest: false },
          outputSummary: "today.md updated",
        },
        2000,
      );
      expect(ok).toBe(true);
      const dto = getExecution(db, id)!;
      expect(dto).toMatchObject({
        endedAt: 2000,
        result: "success",
        errorKind: null,
        errorMessage: null,
        costUsd: 0.18,
        tokensInput: 1200,
        tokensOutput: 800,
        turns: 6,
        outputSummary: "today.md updated",
      });
      expect(dto.successCriteria).toEqual({ today_md: true, digest: false });
    });

    it("finalises an error row with no cost/criteria/summary (all defaults to null)", () => {
      const id = startExecution(db, { agentId: "deploy-watch", trigger: "cron" });
      const ok = completeExecution(db, {
        executionId: id,
        result: "error",
        errorKind: "quota",
        errorMessage: "rate limited",
      });
      expect(ok).toBe(true);
      const dto = getExecution(db, id)!;
      expect(dto).toMatchObject({
        result: "error",
        errorKind: "quota",
        errorMessage: "rate limited",
        costUsd: null,
        tokensInput: null,
        tokensOutput: null,
        turns: null,
        outputSummary: null,
      });
      // success_criteria_json stays NULL → parsed as null (not {}).
      expect(dto.successCriteria).toBeNull();
    });

    it("returns false when no row matches the execution id", () => {
      expect(completeExecution(db, { executionId: 99999, result: "success" })).toBe(
        false,
      );
    });
  });

  describe("getExecution", () => {
    it("returns null for an unknown id", () => {
      expect(getExecution(db, 12345)).toBeNull();
    });
  });

  describe("listExecutions", () => {
    let ids: number[];
    beforeEach(() => {
      ids = [];
      for (let i = 0; i < 4; i++) {
        const id = startExecution(
          db,
          { agentId: "deploy-watch", trigger: "cron" },
          1000 + i,
        );
        ids.push(id);
      }
      // ids[0] success, ids[1] error, others in-flight.
      completeExecution(db, { executionId: ids[0], result: "success" });
      completeExecution(db, { executionId: ids[1], result: "error", errorKind: "tool" });
    });

    it("returns newest-first, default limit", () => {
      const got = listExecutions(db, "deploy-watch").map((e) => e.id);
      expect(got).toEqual([ids[3], ids[2], ids[1], ids[0]]);
    });

    it("honours limit", () => {
      expect(listExecutions(db, "deploy-watch", { limit: 2 }).map((e) => e.id)).toEqual([
        ids[3],
        ids[2],
      ]);
    });

    it("applies the before keyset cursor", () => {
      const got = listExecutions(db, "deploy-watch", { before: ids[2] }).map((e) => e.id);
      expect(got).toEqual([ids[1], ids[0]]);
    });

    it("filters by result", () => {
      const got = listExecutions(db, "deploy-watch", { result: "error" }).map((e) => e.id);
      expect(got).toEqual([ids[1]]);
    });

    it("scopes to the requested agent", () => {
      seedAgent(db, "other");
      startExecution(db, { agentId: "other", trigger: "cron" });
      expect(
        listExecutions(db, "deploy-watch").every((e) => e.agentId === "deploy-watch"),
      ).toBe(true);
    });
  });

  describe("metricsWindow", () => {
    it("returns zero/null metrics for an agent with only in-flight rows", () => {
      // started_at well within the window; never completed.
      startExecution(db, { agentId: "deploy-watch", trigger: "cron" }, 1_000_000);
      startExecution(db, { agentId: "deploy-watch", trigger: "cron" }, 1_000_001);
      const m = metricsWindow(db, "deploy-watch", 7, 1_000_500);
      expect(m).toEqual({
        executions: 2,
        errorRate: 0,
        avgCostUsd: null,
        criteriaHitRate: null,
        p95DurationSeconds: null,
      });
    });

    it("computes error_rate, avg_cost, criteria_hit_rate and p95 over a rich window", () => {
      const now = 10_000_000;
      // Three terminal rows + one in-flight, all inside a 7-day window.
      const a = startExecution(db, { agentId: "deploy-watch", trigger: "cron" }, now - 3000);
      completeExecution(
        db,
        {
          executionId: a,
          result: "success",
          cost: { usd: 0.1 },
          successCriteriaHits: { x: true, y: true },
        },
        now - 1000, // duration 2s
      );
      const b = startExecution(db, { agentId: "deploy-watch", trigger: "cron" }, now - 6000);
      completeExecution(
        db,
        {
          executionId: b,
          result: "error",
          errorKind: "tool",
          cost: { usd: 0.3 },
          successCriteriaHits: { x: false, y: true },
        },
        now - 2000, // duration 4s
      );
      const c = startExecution(db, { agentId: "deploy-watch", trigger: "cron" }, now - 12000);
      completeExecution(
        db,
        { executionId: c, result: "success" }, // no cost, no criteria
        now - 2000, // duration 10s
      );
      // in-flight, no cost/criteria/duration.
      startExecution(db, { agentId: "deploy-watch", trigger: "cron" }, now - 500);

      const m = metricsWindow(db, "deploy-watch", 7, now);
      expect(m.executions).toBe(4);
      // terminal = 3 (a,b,c); errors = 1 (b) → 1/3.
      expect(m.errorRate).toBeCloseTo(1 / 3, 10);
      // costs recorded on a (0.1) and b (0.3) → avg 0.2.
      expect(m.avgCostUsd).toBeCloseTo(0.2, 10);
      // criteria: a {x:true,y:true} + b {x:false,y:true} = 3 true / 4 total.
      expect(m.criteriaHitRate).toBeCloseTo(3 / 4, 10);
      // durations (s): 2, 4, 10 → nearest-rank p95 (ceil(0.95*3)=3) → 10.
      expect(m.p95DurationSeconds).toBe(10);
    });

    it("excludes crash-swept rows from p95 duration but still counts them as errors", () => {
      const now = 10_000_000;
      // A real completed run: 2s duration, success.
      const ok = startExecution(db, { agentId: "deploy-watch", trigger: "cron" }, now - 5000);
      completeExecution(db, { executionId: ok, result: "success" }, now - 3000);
      // A crashed run: started long ago, swept at boot so ended_at = boot
      // instant — a ~46-minute fictional "duration" that must NOT pollute p95.
      startExecution(db, { agentId: "deploy-watch", trigger: "cron" }, now - 2_800_000);
      sweepAbandoned(db, now - 2_000_000, now);

      const m = metricsWindow(db, "deploy-watch", 7, now);
      expect(m.executions).toBe(2);
      // terminal = 2 (success + crash-error); errors = 1 (the crash) → 1/2.
      expect(m.errorRate).toBeCloseTo(1 / 2, 10);
      // Only the genuine 2s run feeds the percentile; the crash row is dropped.
      expect(m.p95DurationSeconds).toBe(2);
    });

    it("excludes rows older than the window", () => {
      const now = 10_000_000;
      // 8 days old — outside a 7-day window.
      const old = startExecution(
        db,
        { agentId: "deploy-watch", trigger: "cron" },
        now - 8 * 86_400_000,
      );
      completeExecution(db, { executionId: old, result: "success", cost: { usd: 9 } }, now);
      const m = metricsWindow(db, "deploy-watch", 7, now);
      expect(m.executions).toBe(0);
      expect(m.avgCostUsd).toBeNull();
    });
  });

  describe("byErrorKind", () => {
    it("buckets error executions by kind, coalescing NULL to 'unknown'", () => {
      const now = 5_000_000;
      const mk = (result: "success" | "error", kind: string | null) => {
        const id = startExecution(db, { agentId: "deploy-watch", trigger: "cron" }, now - 1000);
        completeExecution(db, { executionId: id, result, errorKind: kind }, now);
      };
      mk("error", "quota");
      mk("error", "quota");
      mk("error", "tool");
      mk("error", null); // → 'unknown'
      mk("success", null); // ignored (not an error)
      const counts = byErrorKind(db, "deploy-watch", 7, now);
      expect(counts).toEqual({ quota: 2, tool: 1, unknown: 1 });
    });

    it("returns {} when there are no errors in the window", () => {
      const id = startExecution(db, { agentId: "deploy-watch", trigger: "cron" });
      completeExecution(db, { executionId: id, result: "success" });
      expect(byErrorKind(db, "deploy-watch", 7)).toEqual({});
    });
  });

  describe("sweepAbandoned", () => {
    it("flips stale in-flight rows to error/crash and returns their ids", () => {
      const stale = startExecution(db, { agentId: "deploy-watch", trigger: "cron" }, 100);
      const recent = startExecution(db, { agentId: "deploy-watch", trigger: "cron" }, 200);
      const done = startExecution(db, { agentId: "deploy-watch", trigger: "cron" }, 50);
      completeExecution(db, { executionId: done, result: "success" }, 60);

      const res = sweepAbandoned(db, 150, 9999);
      expect(res).toEqual({ count: 1, ids: [stale] });

      const swept = getExecution(db, stale)!;
      expect(swept.result).toBe("error");
      expect(swept.errorKind).toBe("crash");
      expect(swept.endedAt).toBe(9999);
      // The recent in-flight row (started_at 200 >= cutoff) is untouched.
      expect(getExecution(db, recent)!.result).toBeNull();
      // The completed row is untouched.
      expect(getExecution(db, done)!.result).toBe("success");
    });

    it("returns count 0 with no ids when nothing is abandoned", () => {
      expect(sweepAbandoned(db, 1000)).toEqual({ count: 0, ids: [] });
    });

    it("is idempotent — a second sweep finds nothing", () => {
      startExecution(db, { agentId: "deploy-watch", trigger: "cron" }, 100);
      const first = sweepAbandoned(db, 150, 200);
      expect(first.count).toBe(1);
      const second = sweepAbandoned(db, 150, 300);
      expect(second).toEqual({ count: 0, ids: [] });
    });
  });

  describe("defensive success-criteria parsing", () => {
    // Raw-insert malformed / wrong-shape success_criteria_json to exercise
    // the rowToDTO fallbacks.
    function insertRawExecution(criteriaJson: string): number {
      const r = db
        .prepare(
          `INSERT INTO agent_executions
             (agent_id, trigger, started_at, result, success_criteria_json)
           VALUES ('deploy-watch', 'cron', 0, 'success', ?)`,
        )
        .run(criteriaJson);
      return Number(r.lastInsertRowid);
    }

    it("returns {} for malformed JSON", () => {
      const id = insertRawExecution("not json");
      expect(getExecution(db, id)!.successCriteria).toEqual({});
    });

    it("returns {} for a JSON array", () => {
      const id = insertRawExecution("[1,2]");
      expect(getExecution(db, id)!.successCriteria).toEqual({});
    });

    it("coerces non-boolean values to false", () => {
      const id = insertRawExecution('{"a": 1, "b": true, "c": "yes"}');
      expect(getExecution(db, id)!.successCriteria).toEqual({
        a: false,
        b: true,
        c: false,
      });
    });
  });
});
