import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

import { applySchema } from "../db/schema.js";
import {
  createBrowserTask,
  getBrowserTask,
} from "../db/browser-task-store.js";
import { handleScheduledBrowserTask } from "./dispatcher-scheduled-browser-task.js";
import type {
  BrowserTaskNotifier,
  BrowserTaskRunner,
  RunResult,
} from "../services/browser-task/browser-task-runner.js";
import type { ScheduledBrowserTaskEvent } from "@aitne/shared";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

/**
 * Insert a stub `agent_schedule` row so the `browser_task.schedule_row_id`
 * foreign key can be satisfied when the FK pragma is enabled. The handler
 * under test only cares about `scheduleId` as an integer to write into
 * the new `browser_task` row + the audit log; the agent_schedule row's
 * content is irrelevant beyond its existence.
 */
function seedScheduleRow(
  db: Database.Database,
  scheduleId: number,
): void {
  db.prepare(
    `INSERT INTO agent_schedule
       (id, scheduled_for, task_type, task_description, task_context, status)
     VALUES (?, datetime('now'), 'browser_task', 'test', '{}', 'running')`,
  ).run(scheduleId);
}

type RecordedNotify = {
  taskId: string;
  originatingChannel: string | null;
  state: string;
  outcomeDetail: string | null;
};

function fakeNotifier(): BrowserTaskNotifier & {
  terminal: RecordedNotify[];
  queued: { taskId: string; blockedCount: number }[];
} {
  const terminal: RecordedNotify[] = [];
  const queued: { taskId: string; blockedCount: number }[] = [];
  return {
    terminal,
    queued,
    notifyQueued: async (input) => {
      queued.push({ taskId: input.taskId, blockedCount: input.blockedCount });
    },
    notifyTerminal: async (input) => {
      terminal.push({
        taskId: input.taskId,
        originatingChannel: input.originatingChannel,
        state: input.state,
        outcomeDetail: input.outcomeDetail,
      });
    },
  };
}

function fakeRunner(): BrowserTaskRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runFromPost: async (id) => {
      calls.push(`post:${id}`);
      return { ok: true, reason: "completed", state: "completed" } as RunResult;
    },
    runFromScheduleRow: async (id) => {
      calls.push(`schedule:${id}`);
      return { ok: true, reason: "completed", state: "completed" } as RunResult;
    },
    cancel: async () => true,
    resumeAfterClarification: async () => ({
      ok: true,
      reason: "completed",
      state: "completed",
    } as RunResult),
    expireForDeadline: async () => ({
      ok: false,
      reason: "abandoned",
      state: "abandoned",
    } as RunResult),
    __peekParkedIds: () => [],
  };
}

function makeEvent(
  scheduleId: number,
  taskContext: Partial<ScheduledBrowserTaskEvent["taskContext"]> & {
    preGeneratedTaskId: string;
  },
): ScheduledBrowserTaskEvent {
  return {
    type: "scheduled.browser_task",
    source: "browser_task",
    priority: 2,
    timestamp: new Date(),
    data: {},
    correlationId: randomUUID(),
    scheduleId,
    taskContext: {
      description: "test task",
      siteKey: "amazon_jp",
      ...taskContext,
    } as ScheduledBrowserTaskEvent["taskContext"],
  };
}

describe("handleScheduledBrowserTask", () => {
  let db: Database.Database;
  let nowMs: number;
  let now: () => number;

  beforeEach(() => {
    db = freshDb();
    nowMs = Date.UTC(2026, 4, 26, 12, 0, 0);
    now = () => nowMs;
  });

  it("dispatches happy path — inserts row, calls runner.runFromScheduleRow, returns dispatched", async () => {
    const runner = fakeRunner();
    const taskId = randomUUID();
    seedScheduleRow(db, 42);
    const event = makeEvent(42, {
      preGeneratedTaskId: taskId,
      description: "post hello to x",
      siteKey: "amazon_jp",
      originatingChannel: "slack:U123",
    });
    const outcome = await handleScheduledBrowserTask(
      { db, runner, nowFn: now },
      event,
    );
    expect(outcome).toEqual({ kind: "dispatched", taskId });
    const row = getBrowserTask(db, taskId);
    expect(row).not.toBeNull();
    expect(row?.state).toBe("pending");
    expect(row?.siteKey).toBe("amazon_jp");
    expect(row?.originatingChannel).toBe("slack:U123");
    expect(row?.scheduleRowId).toBe(42);
    expect(row?.effectiveAllowlistRegex).not.toBeNull();
    // Fire-and-forget runner call — await one microtask so the
    // `void` chain finishes scheduling.
    await Promise.resolve();
    expect(runner.calls).toContain(`schedule:${taskId}`);
  });

  it("returns site_unregistered when siteKey is not in the registry + DMs the originating channel", async () => {
    const runner = fakeRunner();
    const notifier = fakeNotifier();
    const taskId = randomUUID();
    seedScheduleRow(db, 99);
    const event = makeEvent(99, {
      preGeneratedTaskId: taskId,
      description: "do thing",
      siteKey: "unknown_site",
      originatingChannel: "slack:U999",
    });
    const outcome = await handleScheduledBrowserTask(
      { db, runner, notifier, nowFn: now },
      event,
    );
    expect(outcome).toEqual({
      kind: "site_unregistered",
      taskId,
      siteKey: "unknown_site",
    });
    const row = getBrowserTask(db, taskId);
    expect(row?.state).toBe("failed");
    expect(row?.outcomeDetail).toBe("site_unregistered");
    expect(runner.calls).toEqual([]);
    // Wait for the fire-and-forget notifier microtask to flush.
    await Promise.resolve();
    await Promise.resolve();
    expect(notifier.terminal).toEqual([
      {
        taskId,
        originatingChannel: "slack:U999",
        state: "failed",
        outcomeDetail: "site_unregistered",
      },
    ]);
  });

  it("omits the dispatch-failure DM when no notifier is wired AND originatingChannel is absent", async () => {
    // Defensive — handler tests historically omitted the notifier dep
    // and must keep working. Covers the `if (!deps.notifier) return`
    // early-out inside `notifyDispatchFailure` AND the
    // `originatingChannel ?? null` fallback branch when the persisted
    // task_context has no channel value at all (some early scheduling
    // paths may set it `undefined`).
    const runner = fakeRunner();
    const taskId = randomUUID();
    seedScheduleRow(db, 991);
    const event = makeEvent(991, {
      preGeneratedTaskId: taskId,
      siteKey: "unknown_site",
      // originatingChannel intentionally omitted to exercise the `??`
      // fallback in both the row write and the notifier call.
    });
    const outcome = await handleScheduledBrowserTask(
      { db, runner, nowFn: now },
      event,
    );
    expect(outcome.kind).toBe("site_unregistered");
    const row = getBrowserTask(db, taskId);
    expect(row?.state).toBe("failed");
    expect(row?.originatingChannel).toBeNull();
  });

  it("notifies with null channel when originatingChannel is undefined on allowlist_rejected", async () => {
    // Covers the `ctx.originatingChannel ?? null` nullish-coalesce
    // branches in the allowlist_rejected path (both `createBrowserTask`
    // and `notifyDispatchFailure`).
    const runner = fakeRunner();
    const notifier = fakeNotifier();
    const taskId = randomUUID();
    seedScheduleRow(db, 1010);
    const event = makeEvent(1010, {
      preGeneratedTaskId: taskId,
      siteKey: "amazon_jp",
      extraAllowedHosts: ["evil.example.com"],
      // originatingChannel intentionally omitted.
    });
    const outcome = await handleScheduledBrowserTask(
      { db, runner, notifier, nowFn: now },
      event,
    );
    expect(outcome.kind).toBe("allowlist_rejected");
    await Promise.resolve();
    await Promise.resolve();
    expect(notifier.terminal).toEqual([
      {
        taskId,
        originatingChannel: null,
        state: "failed",
        outcomeDetail: "allowlist_rejected:extra_host_not_in_etld_set",
      },
    ]);
  });

  it("notifies with null channel when originatingChannel is undefined on runner_unavailable", async () => {
    // Covers the `ctx.originatingChannel ?? null` nullish-coalesce
    // branch in the runner_unavailable path's `notifyDispatchFailure`
    // call.
    const notifier = fakeNotifier();
    const taskId = randomUUID();
    seedScheduleRow(db, 1011);
    const event = makeEvent(1011, {
      preGeneratedTaskId: taskId,
      siteKey: "amazon_jp",
      // originatingChannel intentionally omitted.
    });
    const outcome = await handleScheduledBrowserTask(
      { db, runner: null, notifier, nowFn: now },
      event,
    );
    expect(outcome.kind).toBe("runner_unavailable");
    await Promise.resolve();
    await Promise.resolve();
    expect(notifier.terminal[0]?.originatingChannel).toBeNull();
  });

  it("returns task_context_invalid for a malformed task_context", async () => {
    const runner = fakeRunner();
    const badEvent: ScheduledBrowserTaskEvent = {
      type: "scheduled.browser_task",
      source: "browser_task",
      priority: 2,
      timestamp: new Date(),
      data: {},
      correlationId: randomUUID(),
      scheduleId: 7,
      taskContext: {
        // Missing required fields entirely.
        preGeneratedTaskId: "not-a-uuid",
      } as ScheduledBrowserTaskEvent["taskContext"],
    };
    const outcome = await handleScheduledBrowserTask(
      { db, runner, nowFn: now },
      badEvent,
    );
    expect(outcome.kind).toBe("task_context_invalid");
    expect(runner.calls).toEqual([]);
  });

  it("renders <root> for a top-level Zod issue when path is empty", async () => {
    // A non-object task_context (e.g. an array) lands at the schema
    // root — `issue.path` is `[]` so `join('.')` returns the empty
    // string and the `<root>` fallback kicks in. Cheaper than
    // crafting a `.refine`-shaped failure that lands at the root.
    const runner = fakeRunner();
    const badEvent = {
      type: "scheduled.browser_task" as const,
      source: "browser_task",
      priority: 2,
      timestamp: new Date(),
      data: {},
      correlationId: randomUUID(),
      scheduleId: 8,
      // Top-level value is not an object — fails at root.
      taskContext: "not-an-object",
    } as unknown as ScheduledBrowserTaskEvent;
    const outcome = await handleScheduledBrowserTask(
      { db, runner, nowFn: now },
      badEvent,
    );
    expect(outcome.kind).toBe("task_context_invalid");
    if (outcome.kind === "task_context_invalid") {
      expect(outcome.reason).toContain("<root>");
    }
  });

  it("defaults nowFn to Date.now when not provided", async () => {
    // The `nowFn` parameter is optional; production wires Date.now
    // implicitly. Construct a happy-path dispatch with nowFn omitted
    // to exercise the `?? (() => Date.now())` fallback branch.
    const runner = fakeRunner();
    const taskId = randomUUID();
    seedScheduleRow(db, 67);
    const event = makeEvent(67, {
      preGeneratedTaskId: taskId,
      description: "default nowFn",
      siteKey: "amazon_jp",
    });
    const outcome = await handleScheduledBrowserTask(
      { db, runner }, // no nowFn
      event,
    );
    expect(outcome).toEqual({ kind: "dispatched", taskId });
    const row = getBrowserTask(db, taskId);
    expect(row?.createdAt).toBeGreaterThan(0);
  });

  it("dedups when a browser_task row already exists for the preGeneratedTaskId", async () => {
    const runner = fakeRunner();
    const taskId = randomUUID();
    seedScheduleRow(db, 11);
    createBrowserTask(db, {
      id: taskId,
      description: "pre-existing",
      siteKey: "amazon_jp",
      extraAllowedHosts: [],
      originatingChannel: null,
      scheduleRowId: null,
      requireFinalConfirm: true,
      effectiveAllowlistRegex: "^https://amazon\\.co\\.jp/",
      createdAt: nowMs,
    });
    const event = makeEvent(11, {
      preGeneratedTaskId: taskId,
      description: "post hello",
      siteKey: "amazon_jp",
    });
    const outcome = await handleScheduledBrowserTask(
      { db, runner, nowFn: now },
      event,
    );
    expect(outcome).toEqual({ kind: "row_already_exists", taskId });
    expect(runner.calls).toEqual([]);
  });

  it("returns runner_unavailable + marks row failed + DMs the owner when runner is null", async () => {
    const taskId = randomUUID();
    const notifier = fakeNotifier();
    seedScheduleRow(db, 33);
    const event = makeEvent(33, {
      preGeneratedTaskId: taskId,
      siteKey: "amazon_jp",
      originatingChannel: "telegram:42",
    });
    const outcome = await handleScheduledBrowserTask(
      { db, runner: null, notifier, nowFn: now },
      event,
    );
    expect(outcome).toEqual({ kind: "runner_unavailable", taskId });
    const row = getBrowserTask(db, taskId);
    expect(row?.state).toBe("failed");
    expect(row?.outcomeDetail).toBe("runner_unavailable");
    await Promise.resolve();
    await Promise.resolve();
    expect(notifier.terminal).toEqual([
      {
        taskId,
        originatingChannel: "telegram:42",
        state: "failed",
        outcomeDetail: "runner_unavailable",
      },
    ]);
  });

  it("swallows a throwing notifier inside the .catch (handler outcome unaffected)", async () => {
    // Defensive: the notifier promise can reject (messaging hub error,
    // unparseable channel ref bubble). The handler's fire-and-forget
    // `.catch` must keep the outcome stable so the dispatcher branch
    // still marks the schedule row failed cleanly.
    const taskId = randomUUID();
    seedScheduleRow(db, 331);
    const throwingNotifier: BrowserTaskNotifier = {
      notifyQueued: async () => undefined,
      notifyTerminal: async () => {
        throw new Error("DM broker offline");
      },
    };
    const event = makeEvent(331, {
      preGeneratedTaskId: taskId,
      siteKey: "amazon_jp",
      originatingChannel: "telegram:99",
    });
    const outcome = await handleScheduledBrowserTask(
      { db, runner: null, notifier: throwingNotifier, nowFn: now },
      event,
    );
    expect(outcome.kind).toBe("runner_unavailable");
    // Allow the rejected fire-and-forget promise to settle.
    await Promise.resolve();
    await Promise.resolve();
  });

  it("returns allowlist_rejected when extraAllowedHosts contains an out-of-eTLD host + DMs the owner", async () => {
    const runner = fakeRunner();
    const notifier = fakeNotifier();
    const taskId = randomUUID();
    seedScheduleRow(db, 101);
    const event = makeEvent(101, {
      preGeneratedTaskId: taskId,
      siteKey: "amazon_jp",
      extraAllowedHosts: ["evil.example.com"],
      originatingChannel: "discord:CH1",
    });
    const outcome = await handleScheduledBrowserTask(
      { db, runner, notifier, nowFn: now },
      event,
    );
    expect(outcome.kind).toBe("allowlist_rejected");
    if (outcome.kind === "allowlist_rejected") {
      expect(outcome.reason).toBe("extra_host_not_in_etld_set");
      expect(outcome.offendingHost).toBe("evil.example.com");
    }
    const row = getBrowserTask(db, taskId);
    expect(row?.state).toBe("failed");
    expect(row?.outcomeDetail).toBe(
      "allowlist_rejected:extra_host_not_in_etld_set",
    );
    expect(runner.calls).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(notifier.terminal).toEqual([
      {
        taskId,
        originatingChannel: "discord:CH1",
        state: "failed",
        outcomeDetail: "allowlist_rejected:extra_host_not_in_etld_set",
      },
    ]);
  });

  it("propagates a non-rethrown runner error via the void .catch (does not throw outward)", async () => {
    const calls: string[] = [];
    const errorRunner: BrowserTaskRunner = {
      runFromPost: async () => {
        throw new Error("no");
      },
      runFromScheduleRow: async (id) => {
        calls.push(id);
        throw new Error("boom");
      },
      cancel: async () => true,
      resumeAfterClarification: async () => ({
        ok: false,
        reason: "failed",
        state: "failed",
      } as RunResult),
      expireForDeadline: async () => ({
        ok: false,
        reason: "failed",
        state: "failed",
      } as RunResult),
      __peekParkedIds: () => [],
    };
    const taskId = randomUUID();
    seedScheduleRow(db, 55);
    const event = makeEvent(55, {
      preGeneratedTaskId: taskId,
      siteKey: "amazon_jp",
    });
    const outcome = await handleScheduledBrowserTask(
      { db, runner: errorRunner, nowFn: now },
      event,
    );
    // Handler still reports dispatched — the runner's exception is
    // swallowed inside the void .catch by design.
    expect(outcome).toEqual({ kind: "dispatched", taskId });
    // Give the void chain time to run + catch.
    await vi.waitFor(() => expect(calls).toContain(taskId));
    const row = getBrowserTask(db, taskId);
    expect(row?.state).toBe("pending"); // runner threw before terminal transition
  });
});
