import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";

import { applySchema } from "../db/schema.js";
import { getBackgroundTask } from "../db/background-task-store.js";
import {
  handleScheduledBackgroundTask,
  type BackgroundTaskDispatchDeps,
} from "./dispatcher-scheduled-background-task.js";
import type { ScheduledBackgroundTaskEvent } from "@aitne/shared";

function makeEvent(
  overrides: Partial<ScheduledBackgroundTaskEvent["taskContext"]> = {},
  scheduleId = 1,
): ScheduledBackgroundTaskEvent {
  return {
    type: "scheduled.background_task",
    source: "cron",
    priority: 1,
    timestamp: new Date(0),
    data: {},
    correlationId: "corr-1",
    scheduleId,
    taskContext: {
      preGeneratedTaskId: "11111111-1111-4111-8111-111111111111",
      brief: "summarize my week",
      title: "weekly summary",
      notificationPolicy: "always",
      tier: "medium",
      maxBudgetUsd: null,
      originatingChannel: "slack:C1",
      ...overrides,
    },
  } as ScheduledBackgroundTaskEvent;
}

function fakeRunner() {
  return {
    runFromPost: vi.fn(),
    runFromScheduleRow: vi.fn().mockResolvedValue({ ok: true, reason: "queued", state: "pending" }),
    cancel: vi.fn(),
    resumeAfterClarification: vi.fn(),
    resumeFromBoot: vi.fn(),
    expireForDeadline: vi.fn(),
    __peekParkedIds: () => [],
  };
}

/** Seed a `running` agent_schedule row so the FK on
 *  background_task.schedule_row_id is satisfiable at fire time (the
 *  scheduler always created the row before the dispatch branch fires). */
function seedScheduleRow(db: Database.Database): number {
  const r = db
    .prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, status) VALUES (?, 'background_task', 'running')",
    )
    .run("2026-06-16 09:00:00");
  return Number(r.lastInsertRowid);
}

describe("handleScheduledBackgroundTask", () => {
  let db: Database.Database;
  let scheduleId: number;
  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    scheduleId = seedScheduleRow(db);
  });

  it("creates the row at fire time and hands off to the runner", async () => {
    const runner = fakeRunner();
    const deps: BackgroundTaskDispatchDeps = { db, runner, nowFn: () => 5000 };
    const outcome = await handleScheduledBackgroundTask(deps, makeEvent({}, scheduleId));
    expect(outcome.kind).toBe("dispatched");
    const row = getBackgroundTask(db, "11111111-1111-4111-8111-111111111111");
    expect(row?.state).toBe("pending");
    expect(row?.brief).toBe("summarize my week");
    expect(row?.scheduleRowId).toBe(scheduleId);
    expect(row?.correlationId).toBe("corr-1");
    expect(runner.runFromScheduleRow).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("dedups when a row already exists for the preGeneratedTaskId", async () => {
    const runner = fakeRunner();
    const deps: BackgroundTaskDispatchDeps = { db, runner };
    await handleScheduledBackgroundTask(deps, makeEvent({}, scheduleId));
    runner.runFromScheduleRow.mockClear();
    const second = await handleScheduledBackgroundTask(deps, makeEvent({}, scheduleId));
    expect(second.kind).toBe("row_already_exists");
    expect(runner.runFromScheduleRow).not.toHaveBeenCalled();
  });

  it("swallows a runner that rejects on handoff (fire-and-forget)", async () => {
    const runner = fakeRunner();
    runner.runFromScheduleRow.mockRejectedValue(new Error("boom"));
    const deps: BackgroundTaskDispatchDeps = { db, runner };
    const outcome = await handleScheduledBackgroundTask(deps, makeEvent({}, scheduleId));
    expect(outcome.kind).toBe("dispatched");
    // let the fire-and-forget rejection's .catch run
    await new Promise((r) => setTimeout(r, 0));
    expect(runner.runFromScheduleRow).toHaveBeenCalled();
  });

  it("rejects an invalid task_context", async () => {
    const runner = fakeRunner();
    const deps: BackgroundTaskDispatchDeps = { db, runner };
    const outcome = await handleScheduledBackgroundTask(
      deps,
      makeEvent({ brief: "" }, scheduleId),
    );
    expect(outcome.kind).toBe("task_context_invalid");
  });

  it("reports <root> for a non-object task_context", async () => {
    const runner = fakeRunner();
    const deps: BackgroundTaskDispatchDeps = { db, runner };
    const bad = {
      ...makeEvent({}, scheduleId),
      taskContext: null as unknown as ScheduledBackgroundTaskEvent["taskContext"],
    } as ScheduledBackgroundTaskEvent;
    const outcome = await handleScheduledBackgroundTask(deps, bad);
    expect(outcome.kind).toBe("task_context_invalid");
    if (outcome.kind === "task_context_invalid") {
      expect(outcome.reason).toContain("<root>");
    }
  });

  it("applies notification/tier/correlation defaults for a minimal context", async () => {
    const runner = fakeRunner();
    const deps: BackgroundTaskDispatchDeps = { db, runner };
    const minimal = {
      type: "scheduled.background_task",
      source: "cron",
      priority: 1,
      timestamp: new Date(0),
      data: {},
      // correlationId intentionally absent → row gets null
      scheduleId,
      taskContext: {
        preGeneratedTaskId: "22222222-2222-4222-8222-222222222222",
        brief: "just the brief",
      },
    } as unknown as ScheduledBackgroundTaskEvent;
    const outcome = await handleScheduledBackgroundTask(deps, minimal);
    expect(outcome.kind).toBe("dispatched");
    const row = getBackgroundTask(db, "22222222-2222-4222-8222-222222222222");
    expect(row?.title).toBeNull();
    expect(row?.notificationPolicy).toBe("always");
    expect(row?.tier).toBeNull();
    expect(row?.maxBudgetUsd).toBeNull();
    expect(row?.originatingChannel).toBeNull();
    expect(row?.correlationId).toBeNull();
  });

  it("marks failed (runner_unavailable) when no runner is wired", async () => {
    const deps: BackgroundTaskDispatchDeps = { db, runner: null, nowFn: () => 9 };
    const outcome = await handleScheduledBackgroundTask(deps, makeEvent({}, scheduleId));
    expect(outcome.kind).toBe("runner_unavailable");
    const row = getBackgroundTask(db, "11111111-1111-4111-8111-111111111111");
    expect(row?.state).toBe("failed");
    expect(row?.outcomeDetail).toBe("runner_unavailable");
    // fail-loud: notify=true so the owner hears the scheduled task couldn't start
    expect(row?.notify).toBe(true);
    expect(row?.draft).toBeTruthy();
  });
});
