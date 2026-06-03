import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

import { applySchema } from "../db/schema.js";
import { getAgent, upsertAgent, type AgentUpsertInput } from "../db/agents-store.js";
import { getExecution, startExecution } from "../db/agent-executions-store.js";
import { AgentExecutionRecorder } from "./agent-execution-recorder.js";

function seedAgent(db: Database.Database, slug: string): void {
  upsertAgent(db, {
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
  } as AgentUpsertInput);
}

const AFTER_BOUNDARY = Date.parse("2026-05-31T06:00:00Z"); // 06:00 UTC → agent-day 2026-05-31
const BEFORE_BOUNDARY = Date.parse("2026-05-31T02:00:00Z"); // 02:00 UTC → agent-day 2026-05-30

describe("AgentExecutionRecorder", () => {
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

  function makeRecorder(nowMs: number): AgentExecutionRecorder {
    return new AgentExecutionRecorder({
      db,
      timezone: "UTC",
      dayBoundaryHour: 4,
      now: () => nowMs,
    });
  }

  describe("start", () => {
    it("inserts an in-flight row (result NULL) and returns the handle", () => {
      const recorder = makeRecorder(AFTER_BOUNDARY);
      const handle = recorder.start({ agentId: "deploy-watch", trigger: "cron" });

      expect(handle.executionId).toBeGreaterThan(0);
      expect(handle.startedAt).toBe(AFTER_BOUNDARY);

      const row = getExecution(db, handle.executionId);
      expect(row).toMatchObject({
        agentId: "deploy-watch",
        trigger: "cron",
        startedAt: AFTER_BOUNDARY,
        endedAt: null,
        result: null,
      });
    });

    it("pins {date} to the agent-day AFTER the 04:00 boundary", () => {
      const handle = makeRecorder(AFTER_BOUNDARY).start({
        agentId: "deploy-watch",
        trigger: "cron",
      });
      expect(handle.dateStr).toBe("2026-05-31");
    });

    it("pins {date} to the PREVIOUS agent-day before the 04:00 boundary", () => {
      const handle = makeRecorder(BEFORE_BOUNDARY).start({
        agentId: "deploy-watch",
        trigger: "cron",
      });
      expect(handle.dateStr).toBe("2026-05-30");
    });

    it("defaults the clock to Date.now() when no `now` is injected", () => {
      const recorder = new AgentExecutionRecorder({ db, dayBoundaryHour: 4 });
      const before = Date.now();
      const handle = recorder.start({ agentId: "deploy-watch", trigger: "manual" });
      const after = Date.now();
      expect(handle.startedAt).toBeGreaterThanOrEqual(before);
      expect(handle.startedAt).toBeLessThanOrEqual(after);
    });
  });

  describe("complete", () => {
    it("finalises the row and re-points agents.last_execution_id in one step", () => {
      const recorder = makeRecorder(AFTER_BOUNDARY);
      const { executionId } = recorder.start({ agentId: "deploy-watch", trigger: "cron" });

      const ok = recorder.complete({
        executionId,
        result: "success",
        cost: { usd: 0.12, tokensIn: 100, tokensOut: 50, turns: 3 },
        successCriteriaHits: { today_md_populated: true },
        outputSummary: "today.md regenerated",
      });

      expect(ok).toBe(true);
      const row = getExecution(db, executionId);
      expect(row).toMatchObject({
        result: "success",
        endedAt: AFTER_BOUNDARY,
        costUsd: 0.12,
        tokensInput: 100,
        tokensOutput: 50,
        turns: 3,
        successCriteria: { today_md_populated: true },
        outputSummary: "today.md regenerated",
      });
      expect(getAgent(db, "deploy-watch")?.lastExecutionId).toBe(executionId);
    });

    it("reads agent_id from the row — caller need not re-supply the slug", () => {
      const recorder = makeRecorder(AFTER_BOUNDARY);
      seedAgent(db, "other-agent");
      const { executionId } = recorder.start({ agentId: "deploy-watch", trigger: "cron" });

      recorder.complete({ executionId, result: "success" });

      // Only deploy-watch (the row's agent_id) is re-pointed; other-agent stays clear.
      expect(getAgent(db, "deploy-watch")?.lastExecutionId).toBe(executionId);
      expect(getAgent(db, "other-agent")?.lastExecutionId).toBeNull();
    });

    it("updates last_execution_id for a failed run too", () => {
      const recorder = makeRecorder(AFTER_BOUNDARY);
      const { executionId } = recorder.start({ agentId: "deploy-watch", trigger: "cron" });

      const ok = recorder.complete({
        executionId,
        result: "error",
        errorKind: "tool",
        errorMessage: "boom",
      });

      expect(ok).toBe(true);
      const row = getExecution(db, executionId);
      expect(row?.result).toBe("error");
      expect(row?.errorKind).toBe("tool");
      expect(getAgent(db, "deploy-watch")?.lastExecutionId).toBe(executionId);
    });

    it("returns false and touches nothing for an unknown execution id", () => {
      const recorder = makeRecorder(AFTER_BOUNDARY);
      recorder.start({ agentId: "deploy-watch", trigger: "cron" });

      const ok = recorder.complete({ executionId: 9999, result: "success" });

      expect(ok).toBe(false);
      expect(getAgent(db, "deploy-watch")?.lastExecutionId).toBeNull();
    });

    it("disables a one_shot Agent once it fires (§16 Q8 re-runnable record)", () => {
      upsertAgent(db, {
        slug: "remind-me",
        name: "remind-me",
        source: "user",
        definitionPath: "/vault/policies/agents/remind-me/agent.md",
        definitionHash: "h",
        enabled: true,
        processKey: "agent.task",
        scheduleKind: "one_shot",
        scheduleExpression: "2099-01-02T09:00:00.000Z",
        scheduleTimezone: "UTC",
      } as AgentUpsertInput);
      const recorder = makeRecorder(AFTER_BOUNDARY);
      const handle = recorder.start({ agentId: "remind-me", trigger: "cron" });

      expect(recorder.complete({ executionId: handle.executionId, result: "success" })).toBe(true);
      const agent = getAgent(db, "remind-me")!;
      expect(agent.enabled).toBe(false);
      expect(agent.enabledOverriddenAt).toBe(AFTER_BOUNDARY);
    });

    it("leaves a cron Agent enabled after it fires", () => {
      const recorder = makeRecorder(AFTER_BOUNDARY);
      const handle = recorder.start({ agentId: "deploy-watch", trigger: "cron" });
      recorder.complete({ executionId: handle.executionId, result: "success" });
      expect(getAgent(db, "deploy-watch")!.enabled).toBe(true);
    });
  });

  describe("sweepAbandoned", () => {
    it("flips an execution started before the boot cutoff to error/crash", () => {
      // A pre-boot in-flight row (inserted directly so its started_at predates boot).
      const staleId = startExecution(db, { agentId: "deploy-watch", trigger: "cron" }, 1_000);
      const bootTime = 10_000;
      const recorder = new AgentExecutionRecorder({
        db,
        dayBoundaryHour: 4,
        now: () => 20_000,
      });

      const result = recorder.sweepAbandoned(bootTime);

      expect(result.count).toBe(1);
      expect(result.ids).toEqual([staleId]);
      const row = getExecution(db, staleId);
      expect(row).toMatchObject({ result: "error", errorKind: "crash", endedAt: 20_000 });
    });
  });
});
