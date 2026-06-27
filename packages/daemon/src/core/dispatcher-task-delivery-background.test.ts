import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Event } from "@aitne/shared";
import type { AgentConfig } from "../config.js";
import { loadDefaultRuntimeSettings } from "../config.js";
import { applySchema } from "../db/schema.js";
import {
  createBackgroundTask,
  getBackgroundTask,
  markRunning,
  markAwaitingUser,
  markTerminal,
} from "../db/background-task-store.js";
import {
  createClarification,
  getClarification,
} from "../db/background-task-clarifications-store.js";
import type { INotificationManager } from "./dispatcher-types.js";
import {
  createBackgroundTaskClarificationDeliveryEvent,
  createBackgroundTaskResultDeliveryEvent,
  enqueueUndeliveredBackgroundTaskDeliveries,
  handleTaskDeliveryInsideGate,
  type TaskDeliveryHandlerDeps,
} from "./dispatcher-task-delivery.js";

class FakeNotificationManager implements INotificationManager {
  sends: Array<{ message: string; event: Event }> = [];
  async send(message: string, event: Event): Promise<void> {
    this.sends.push({ message, event });
  }
  async beginReplyActivity(): Promise<{ stop(): Promise<void> }> {
    return { stop: async () => {} };
  }
}

let db: Database.Database;
let config: AgentConfig;
let notificationMgr: FakeNotificationManager;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  config = {
    ...loadDefaultRuntimeSettings(),
    dataDir: "/tmp/aitne-test",
    workspaceDir: "/tmp/aitne-test",
    apiPort: 0,
    quietHoursStart: "00:00",
    quietHoursEnd: "00:00",
  } as AgentConfig;
  notificationMgr = new FakeNotificationManager();
});

afterEach(() => db.close());

function seedCompleted(id: string, notify: boolean): void {
  createBackgroundTask(db, {
    id,
    brief: "audit repos",
    title: "audit",
    notificationPolicy: "always",
    originatingChannel: "slack:C123",
    correlationId: null,
    scheduleRowId: null,
    tier: "medium",
    maxBudgetUsd: null,
    createdAt: 1000,
  });
  markRunning(db, id, 1100);
  markTerminal(db, {
    id,
    state: "completed",
    outcomeDetail: null,
    finishedAt: 2000,
    report: "full report",
    draft: "two repos red",
    notify,
  });
}

function deps(): TaskDeliveryHandlerDeps {
  return {
    db,
    config,
    notificationMgr,
    executeScheduledTask: async () => {
      throw new Error("idle should not run an active turn");
    },
    nowFn: () => 9_000,
  };
}

describe("background-task delivery generalization", () => {
  it("the result factory builds a background_task task_result event", () => {
    const e = createBackgroundTaskResultDeliveryEvent({
      taskId: "bg-1",
      originatingChannel: "slack:C123",
      title: "audit",
      draft: "summary",
      report: "verbatim",
    });
    expect(e.type).toBe("task.delivery");
    expect(e.taskContext.taskKind).toBe("background_task");
    expect(e.taskContext.deliveryType).toBe("task_result");
    expect(e.taskContext.draft).toBe("summary");
    expect(e.taskContext.report).toBe("verbatim");
  });

  it("the clarification factory builds a background_task task_clarification event", () => {
    const e = createBackgroundTaskClarificationDeliveryEvent({
      taskId: "bg-1",
      originatingChannel: "slack:C123",
      title: "audit",
      clarificationId: "c1",
      question: "web or api?",
      contextSummary: "scoping",
    });
    expect(e.taskContext.taskKind).toBe("background_task");
    expect(e.taskContext.deliveryType).toBe("task_clarification");
    expect(e.taskContext.clarificationId).toBe("c1");
    expect(e.taskContext.draft).toContain("web or api?");
  });

  it("idle delivery sends the draft and marks the background row delivered", async () => {
    seedCompleted("bg-1", true);
    const event = createBackgroundTaskResultDeliveryEvent({
      taskId: "bg-1",
      originatingChannel: "slack:C123",
      title: "audit",
      draft: "two repos red",
      report: "full report",
    });
    await handleTaskDeliveryInsideGate(deps(), event);
    expect(notificationMgr.sends).toHaveLength(1);
    expect(notificationMgr.sends[0].message).toBe("two repos red");
    // routed to the BACKGROUND store, not browser_task
    expect(getBackgroundTask(db, "bg-1")?.deliveredAt).toBe(9_000);
  });

  it("a second delivery is deduped (delivered_at already set ⇒ no double send)", async () => {
    seedCompleted("bg-1", true);
    const event = createBackgroundTaskResultDeliveryEvent({
      taskId: "bg-1",
      originatingChannel: "slack:C123",
      title: "audit",
      draft: "two repos red",
      report: "full report",
    });
    await handleTaskDeliveryInsideGate(deps(), event);
    await handleTaskDeliveryInsideGate(deps(), event);
    expect(notificationMgr.sends).toHaveLength(1);
  });

  it("idle clarification delivery marks the clarification delivered", async () => {
    createBackgroundTask(db, {
      id: "bg-2",
      brief: "audit",
      title: "audit",
      notificationPolicy: "always",
      originatingChannel: "slack:C123",
      correlationId: null,
      scheduleRowId: null,
      tier: "medium",
      maxBudgetUsd: null,
      createdAt: 1000,
    });
    markRunning(db, "bg-2", 1100);
    markAwaitingUser(db, "bg-2");
    createClarification(db, {
      id: "c1",
      taskId: "bg-2",
      question: "web or api?",
      contextSummary: null,
      askedAt: 1200,
      ttlMs: 60 * 60 * 1000,
    });
    const event = createBackgroundTaskClarificationDeliveryEvent({
      taskId: "bg-2",
      originatingChannel: "slack:C123",
      title: "audit",
      clarificationId: "c1",
      question: "web or api?",
      contextSummary: null,
    });
    await handleTaskDeliveryInsideGate(deps(), event);
    expect(notificationMgr.sends).toHaveLength(1);
    expect(getClarification(db, "c1")?.deliveredAt).toBe(9_000);
  });

  it("isDeliveryAlreadyMarked short-circuits a background result whose message was pruned", async () => {
    seedCompleted("bg-1", true);
    const event = createBackgroundTaskResultDeliveryEvent({
      taskId: "bg-1",
      originatingChannel: "slack:C123",
      title: "audit",
      draft: "two repos red",
      report: "full report",
    });
    await handleTaskDeliveryInsideGate(deps(), event);
    // Drop the recorded assistant message so the message-existence backfill
    // misses, forcing the delivered_at (isDeliveryAlreadyMarked) guard.
    db.prepare("DELETE FROM messages").run();
    await handleTaskDeliveryInsideGate(deps(), event);
    expect(notificationMgr.sends).toHaveLength(1);
  });

  it("isDeliveryAlreadyMarked short-circuits a background clarification already delivered", async () => {
    createBackgroundTask(db, {
      id: "bg-3",
      brief: "b",
      title: "t",
      notificationPolicy: "always",
      originatingChannel: "slack:C123",
      correlationId: null,
      scheduleRowId: null,
      tier: "medium",
      maxBudgetUsd: null,
      createdAt: 1000,
    });
    markRunning(db, "bg-3", 1100);
    markAwaitingUser(db, "bg-3");
    createClarification(db, {
      id: "c9",
      taskId: "bg-3",
      question: "q",
      contextSummary: null,
      askedAt: 1200,
      ttlMs: 60 * 60 * 1000,
    });
    const event = createBackgroundTaskClarificationDeliveryEvent({
      taskId: "bg-3",
      originatingChannel: "slack:C123",
      title: "t",
      clarificationId: "c9",
      question: "q",
      contextSummary: null,
    });
    await handleTaskDeliveryInsideGate(deps(), event);
    db.prepare("DELETE FROM messages").run();
    await handleTaskDeliveryInsideGate(deps(), event);
    expect(notificationMgr.sends).toHaveLength(1);
  });

  it("ignores an unsupported task kind", async () => {
    const event = createBackgroundTaskResultDeliveryEvent({
      taskId: "bg-x",
      originatingChannel: "slack:C123",
      title: "t",
      draft: "d",
      report: "r",
    });
    (event.taskContext as { taskKind: string }).taskKind = "mystery_task";
    await handleTaskDeliveryInsideGate(deps(), event);
    expect(notificationMgr.sends).toHaveLength(0);
  });

  it("recovery sweep enqueues completed notify=1 results + open clarifications", async () => {
    seedCompleted("notify", true);
    seedCompleted("filed", false);
    // an open, undelivered clarification on a parked task
    createBackgroundTask(db, {
      id: "parked",
      brief: "b",
      title: "t",
      notificationPolicy: "always",
      originatingChannel: "slack:C1",
      correlationId: null,
      scheduleRowId: null,
      tier: "medium",
      maxBudgetUsd: null,
      createdAt: 1000,
    });
    markRunning(db, "parked", 1100);
    markAwaitingUser(db, "parked");
    createClarification(db, {
      id: "c1",
      taskId: "parked",
      question: "q",
      contextSummary: null,
      askedAt: 1200,
      ttlMs: 60 * 60 * 1000,
    });

    const enqueued: string[] = [];
    const count = await enqueueUndeliveredBackgroundTaskDeliveries({
      db,
      eventBus: {
        put: async (e) => {
          enqueued.push(
            `${e.taskContext.taskId}:${e.taskContext.deliveryType}`,
          );
        },
      },
      nowMs: 5000,
    });
    expect(count).toBe(2);
    expect(enqueued).toContain("notify:task_result");
    expect(enqueued).toContain("parked:task_clarification");
    expect(enqueued).not.toContain("filed:task_result");
  });

  it("recovery sweep falls back to Date.now() when no clock is injected", async () => {
    seedCompleted("notify-default", true);
    const enqueued: string[] = [];
    const count = await enqueueUndeliveredBackgroundTaskDeliveries({
      db,
      eventBus: {
        put: async (e) => {
          enqueued.push(e.taskContext.taskId);
        },
      },
      // no nowMs ⇒ exercises the Date.now() default
    });
    expect(count).toBe(1);
    expect(enqueued).toContain("notify-default");
  });

  it("recovery sweep skips a completed notify=1 row whose draft is blank", async () => {
    createBackgroundTask(db, {
      id: "nodraft",
      brief: "audit repos",
      title: "audit",
      notificationPolicy: "always",
      originatingChannel: "slack:C123",
      correlationId: null,
      scheduleRowId: null,
      tier: "medium",
      maxBudgetUsd: null,
      createdAt: 1000,
    });
    markRunning(db, "nodraft", 1100);
    // The recovery query filters `draft IS NOT NULL`, but an empty-string
    // draft still passes it — so the `!row.draft` guard is what skips a row
    // whose worker produced no usable summary.
    markTerminal(db, {
      id: "nodraft",
      state: "completed",
      outcomeDetail: null,
      finishedAt: 2000,
      report: "full report",
      draft: "",
      notify: true,
    });
    const count = await enqueueUndeliveredBackgroundTaskDeliveries({
      db,
      eventBus: { put: async () => {} },
      nowMs: 5000,
    });
    expect(count).toBe(0);
  });

  it("recovery sweep falls back to brief and draft when a result row has no title or report", async () => {
    const brief = "audit every repo for failing CI";
    createBackgroundTask(db, {
      id: "sparse",
      brief,
      title: null,
      notificationPolicy: "always",
      originatingChannel: "slack:C123",
      correlationId: null,
      scheduleRowId: null,
      tier: "medium",
      maxBudgetUsd: null,
      createdAt: 1000,
    });
    markRunning(db, "sparse", 1100);
    // report NULL + title NULL, draft present
    markTerminal(db, {
      id: "sparse",
      state: "completed",
      outcomeDetail: null,
      finishedAt: 2000,
      draft: "two repos red",
      notify: true,
    });
    let captured: ReturnType<
      typeof createBackgroundTaskResultDeliveryEvent
    > | null = null;
    const count = await enqueueUndeliveredBackgroundTaskDeliveries({
      db,
      eventBus: {
        put: async (e) => {
          captured = e;
        },
      },
      nowMs: 5000,
    });
    expect(count).toBe(1);
    const ctx = captured!.taskContext;
    expect(ctx.title).toBe(brief); // title ?? brief.slice(0, 80)
    expect(ctx.report).toBe("two repos red"); // report ?? draft
    expect(ctx.draft).toBe("two repos red");
  });

  it("recovery sweep uses the brief as the clarification title when the parked task has none", async () => {
    const brief = "monitor the staging deploy until it goes green";
    createBackgroundTask(db, {
      id: "parked-notitle",
      brief,
      title: null,
      notificationPolicy: "always",
      originatingChannel: "slack:C1",
      correlationId: null,
      scheduleRowId: null,
      tier: "medium",
      maxBudgetUsd: null,
      createdAt: 1000,
    });
    markRunning(db, "parked-notitle", 1100);
    markAwaitingUser(db, "parked-notitle");
    createClarification(db, {
      id: "c-nt",
      taskId: "parked-notitle",
      question: "redeploy now?",
      contextSummary: null,
      askedAt: 1200,
      ttlMs: 60 * 60 * 1000,
    });
    let captured: ReturnType<
      typeof createBackgroundTaskClarificationDeliveryEvent
    > | null = null;
    const count = await enqueueUndeliveredBackgroundTaskDeliveries({
      db,
      eventBus: {
        put: async (e) => {
          captured = e;
        },
      },
      nowMs: 5000,
    });
    expect(count).toBe(1);
    const ctx = captured!.taskContext;
    expect(ctx.deliveryType).toBe("task_clarification");
    expect(ctx.title).toBe(brief); // taskTitle ?? taskBrief.slice(0, 80)
  });
});
