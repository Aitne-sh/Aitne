import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applySchema } from "../../db/schema.js";
import { upsertAgent, getAgent } from "../../db/agents-store.js";
import { getExecution } from "../../db/agent-executions-store.js";
import { AgentExecutionRecorder } from "../agent-execution-recorder.js";
import { AgentExecutionTracker } from "./agent-execution-tracker.js";
import type { SuccessCriterion } from "@aitne/shared";

function seedAgent(db: Database.Database, slug: string): void {
  upsertAgent(db, {
    slug,
    name: slug,
    source: "builtin",
    definitionPath: `/agents/${slug}/agent.md`,
    definitionHash: `hash-${slug}`,
    enabled: true,
    scheduleKind: "cron",
    scheduleExpression: "0 4 * * *",
    scheduleTimezone: "UTC",
  });
}

describe("AgentExecutionTracker", () => {
  let db: Database.Database;
  let contextDir: string;
  let recorder: AgentExecutionRecorder;
  let sse: Array<{ event: string; payload: unknown }>;
  let criteria: SuccessCriterion[];
  let warnSpy: ReturnType<typeof vi.fn>;

  function makeTracker(): AgentExecutionTracker {
    return new AgentExecutionTracker({
      db,
      recorder,
      contextDir,
      emitSse: (event, payload) => sse.push({ event, payload }),
      loadCriteria: () => criteria,
      logger: { warn: warnSpy, debug: vi.fn() },
    });
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    contextDir = mkdtempSync(join(tmpdir(), "pa-tracker-vault-"));
    recorder = new AgentExecutionRecorder({ db, dayBoundaryHour: 4, timezone: "UTC" });
    sse = [];
    criteria = [];
    warnSpy = vi.fn();
    seedAgent(db, "morning-routine");
  });

  afterEach(() => {
    db.close();
    rmSync(contextDir, { recursive: true, force: true });
  });

  it("begin returns null and records nothing when no Agent resolves", () => {
    const tracker = makeTracker();
    expect(tracker.begin("corr-x", { routine: "roadmap_refresh" }, { trigger: "cron" })).toBeNull();
    expect(sse).toHaveLength(0);
    const count = db.prepare("SELECT COUNT(*) AS n FROM agent_executions").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("begin opens an execution row and emits agent.execution.started", () => {
    const tracker = makeTracker();
    const slug = tracker.begin("corr-1", { routine: "morning_routine" }, { trigger: "cron" });
    expect(slug).toBe("morning-routine");
    expect(tracker.currentAgentId("corr-1")).toBe("morning-routine");
    const row = db.prepare("SELECT agent_id, result FROM agent_executions").get() as {
      agent_id: string;
      result: string | null;
    };
    expect(row.agent_id).toBe("morning-routine");
    expect(row.result).toBeNull();
    expect(sse[0].event).toBe("agent.execution.started");
  });

  it("completeFromDispatch settles a success run + last_execution_id + SSE", () => {
    const tracker = makeTracker();
    tracker.begin("corr-2", { routine: "morning_routine" }, { trigger: "cron" });
    tracker.recordOutcome("corr-2", { isError: false, costUsd: 0.42, turns: 3, outputSummary: "done" });
    tracker.completeFromDispatch("corr-2");

    const exec = db.prepare("SELECT * FROM agent_executions").get() as {
      id: number;
      result: string;
      cost_usd: number;
      output_summary: string;
    };
    expect(exec.result).toBe("success");
    expect(exec.cost_usd).toBeCloseTo(0.42);
    expect(exec.output_summary).toBe("done");
    expect(getAgent(db, "morning-routine")?.lastExecutionId).toBe(exec.id);
    const completed = sse.find((e) => e.event === "agent.execution.completed");
    expect((completed?.payload as { result: string }).result).toBe("success");
    // Active entry consumed → idempotent second call is a no-op.
    expect(tracker.currentAgentId("corr-2")).toBeNull();
    tracker.completeFromDispatch("corr-2");
  });

  it("records a thrown dispatch as error/exception", () => {
    const tracker = makeTracker();
    tracker.begin("corr-3", { routine: "morning_routine" }, { trigger: "cron" });
    tracker.completeFromDispatch("corr-3", { thrown: new Error("boom") });
    const exec = db.prepare("SELECT result, error_kind, error_message FROM agent_executions").get() as {
      result: string;
      error_kind: string;
      error_message: string;
    };
    expect(exec.result).toBe("error");
    expect(exec.error_kind).toBe("exception");
    expect(exec.error_message).toBe("boom");
  });

  it("records a non-Error thrown value", () => {
    const tracker = makeTracker();
    tracker.begin("corr-3b", { routine: "morning_routine" }, { trigger: "cron" });
    tracker.completeFromDispatch("corr-3b", { thrown: "string-fail" });
    const exec = db.prepare("SELECT error_message FROM agent_executions").get() as { error_message: string };
    expect(exec.error_message).toBe("string-fail");
  });

  it("records a soft AgentResult.isError as error/agent_error", () => {
    const tracker = makeTracker();
    tracker.begin("corr-4", { routine: "morning_routine" }, { trigger: "cron" });
    tracker.recordOutcome("corr-4", { isError: true });
    tracker.completeFromDispatch("corr-4");
    const exec = db.prepare("SELECT result, error_kind FROM agent_executions").get() as {
      result: string;
      error_kind: string;
    };
    expect(exec.result).toBe("error");
    expect(exec.error_kind).toBe("agent_error");
  });

  it("sums cost/tokens/turns across multi-stage outcomes (morning Stage A + B)", () => {
    const tracker = makeTracker();
    tracker.begin("corr-multi", { routine: "morning_routine" }, { trigger: "cron" });
    // Stage A — carries cost + tokensOut + a summary (tokensIn / turns absent).
    tracker.recordOutcome("corr-multi", {
      isError: false,
      costUsd: 0.4,
      tokensOut: 50,
      outputSummary: "stage A",
    });
    // Stage B — carries cost + tokensIn + its own summary (tokensOut / turns absent).
    tracker.recordOutcome("corr-multi", {
      isError: false,
      costUsd: 0.01,
      tokensIn: 20,
      outputSummary: "stage B",
    });
    tracker.completeFromDispatch("corr-multi");

    const exec = db
      .prepare(
        "SELECT result, cost_usd, tokens_input, tokens_output, turns, output_summary FROM agent_executions",
      )
      .get() as {
      result: string;
      cost_usd: number;
      tokens_input: number | null;
      tokens_output: number;
      turns: number | null;
      output_summary: string;
    };
    expect(exec.result).toBe("success");
    expect(exec.cost_usd).toBeCloseTo(0.41); // 0.4 + 0.01
    expect(exec.tokens_input).toBe(20); // absent (A) + 20 (B)
    expect(exec.tokens_output).toBe(50); // 50 (A) + absent (B)
    expect(exec.turns).toBeNull(); // absent in both → null
    expect(exec.output_summary).toBe("stage B"); // latest non-empty wins
  });

  it("is sticky-error across stages and keeps a prior stage's summary", () => {
    const tracker = makeTracker();
    tracker.begin("corr-sticky", { routine: "morning_routine" }, { trigger: "cron" });
    // Stage A succeeds with a summary.
    tracker.recordOutcome("corr-sticky", { isError: false, costUsd: 0.4, outputSummary: "A" });
    // Stage B soft-fails with no summary → run is error, A's summary survives.
    tracker.recordOutcome("corr-sticky", { isError: true });
    // A third (hypothetical) success must not clear the sticky error.
    tracker.recordOutcome("corr-sticky", { isError: false, costUsd: 0.05 });
    tracker.completeFromDispatch("corr-sticky");

    const exec = db
      .prepare("SELECT result, error_kind, cost_usd, output_summary FROM agent_executions")
      .get() as {
      result: string;
      error_kind: string;
      cost_usd: number;
      output_summary: string;
    };
    expect(exec.result).toBe("error");
    expect(exec.error_kind).toBe("agent_error");
    expect(exec.cost_usd).toBeCloseTo(0.45); // 0.4 + (none) + 0.05
    expect(exec.output_summary).toBe("A"); // B/3rd had none → A retained
  });

  it("markSkipped settles result='skipped' with the reason + SSE, and consumes the entry", () => {
    const tracker = makeTracker();
    tracker.begin("corr-skip", { routine: "morning_routine" }, { trigger: "cron" });
    tracker.markSkipped("corr-skip", "morning_routine_pending_for_today");

    const exec = db
      .prepare("SELECT result, error_kind, output_summary, success_criteria_json FROM agent_executions")
      .get() as {
      result: string;
      error_kind: string | null;
      output_summary: string;
      success_criteria_json: string | null;
    };
    expect(exec.result).toBe("skipped");
    expect(exec.error_kind).toBeNull(); // a skip is NOT an error
    expect(exec.output_summary).toBe("morning_routine_pending_for_today");
    expect(exec.success_criteria_json).toBeNull(); // criteria not evaluated for a skip
    expect(getAgent(db, "morning-routine")?.lastExecutionId).toBe(1);
    const completed = sse.find((e) => e.event === "agent.execution.completed");
    expect((completed?.payload as { result: string }).result).toBe("skipped");
    // Entry consumed → the trailing completeFromDispatch is a no-op.
    expect(tracker.currentAgentId("corr-skip")).toBeNull();
    tracker.completeFromDispatch("corr-skip");
    const stillSkipped = db
      .prepare("SELECT result FROM agent_executions")
      .get() as { result: string };
    expect(stillSkipped.result).toBe("skipped");
  });

  it("markSkipped omits output_summary when no reason is given, and is a no-op without an active execution", () => {
    const tracker = makeTracker();
    tracker.begin("corr-skip2", { routine: "morning_routine" }, { trigger: "cron" });
    tracker.markSkipped("corr-skip2");
    const exec = db
      .prepare("SELECT result, output_summary FROM agent_executions")
      .get() as { result: string; output_summary: string | null };
    expect(exec.result).toBe("skipped");
    expect(exec.output_summary).toBeNull();
    // No active execution → no-op (no second row, no throw).
    expect(() => tracker.markSkipped("ghost")).not.toThrow();
    const count = db.prepare("SELECT COUNT(*) AS n FROM agent_executions").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("evaluates success criteria and logs warnings best-effort", () => {
    criteria = [
      // An out-of-vault target records false + a warning, never throws.
      { kind: "file_exists", id: "escape", target: "../escape.md" } as SuccessCriterion,
    ];
    const tracker = makeTracker();
    tracker.begin("corr-5", { routine: "morning_routine" }, { trigger: "cron" });
    tracker.completeFromDispatch("corr-5");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const exec = db.prepare("SELECT success_criteria_json FROM agent_executions").get() as {
      success_criteria_json: string;
    };
    expect(JSON.parse(exec.success_criteria_json)).toEqual({ escape: false });
  });

  it("falls back to the base logger when none is injected", () => {
    const tracker = new AgentExecutionTracker({
      db,
      recorder,
      contextDir,
      emitSse: (event, payload) => sse.push({ event, payload }),
      loadCriteria: () => [],
    });
    tracker.begin("corr-nolog", { routine: "morning_routine" }, { trigger: "cron" });
    expect(() => tracker.completeFromDispatch("corr-nolog")).not.toThrow();
  });

  it("recordOutcome / completeFromDispatch are no-ops without an active execution", () => {
    const tracker = makeTracker();
    expect(() => tracker.recordOutcome("ghost", { isError: false })).not.toThrow();
    expect(() => tracker.completeFromDispatch("ghost")).not.toThrow();
    expect(tracker.currentAgentId("ghost")).toBeNull();
    const count = db.prepare("SELECT COUNT(*) AS n FROM agent_executions").get() as { n: number };
    expect(count.n).toBe(0);
  });
});
