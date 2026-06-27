import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { AgentTaskEvent, Event } from "@aitne/shared";
import { formatSqliteDatetime } from "@aitne/shared";
import type { AgentConfig } from "../config.js";
import { loadDefaultRuntimeSettings } from "../config.js";
import { applySchema } from "../db/schema.js";
import {
  createBrowserTask,
  getBrowserTask,
  markTerminal,
} from "../db/browser-task-store.js";
import { createClarification } from "../db/browser-task-clarifications-store.js";
import { findOrCreateActiveChannelSession } from "./session-manager.js";
import { MessageRecorder } from "./message-recorder.js";
import { readTaskDeliveryRecord } from "./dispatcher-result-processor.js";
import type { INotificationManager } from "./dispatcher-types.js";
import {
  createAutonomousForwardDeliveryEvent,
  createBackgroundTaskResultDeliveryEvent,
  createBrowserTaskClarificationDeliveryEvent,
  createBrowserTaskResultDeliveryEvent,
  enqueueUndeliveredBrowserTaskDeliveries,
  handleTaskDeliveryInsideGate,
  TASK_DELIVERY_ATTACHMENTS_KEY,
} from "./dispatcher-task-delivery.js";

class FakeNotificationManager implements INotificationManager {
  sends: Array<{
    message: string;
    event: Event;
    options: Parameters<INotificationManager["send"]>[2];
  }> = [];

  async send(
    message: string,
    event: Event,
    options?: Parameters<INotificationManager["send"]>[2],
  ): Promise<void> {
    this.sends.push({ message, event, options });
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
    // Disable quiet hours for the default fixture so the idle-send tests
    // are deterministic regardless of wall-clock time (start === end is
    // the "quiet hours off" idiom). The deferral case sets its own window.
    quietHoursStart: "00:00",
    quietHoursEnd: "00:00",
  };
  notificationMgr = new FakeNotificationManager();
});

afterEach(() => {
  db.close();
});

function seedCompletedTask(id = "task-1"): void {
  createBrowserTask(db, {
    id,
    description: "check the order status",
    siteKey: null,
    extraAllowedHosts: [],
    originatingChannel: "slack:C123",
    scheduleRowId: null,
    requireFinalConfirm: true,
    effectiveAllowlistRegex: null,
    createdAt: 1000,
  });
  markTerminal(db, {
    id,
    state: "completed",
    outcomeDetail: null,
    report: "The order ships tomorrow.",
    finishedAt: 2000,
  });
}

function recordRecentOwnerMessage(): void {
  const session = findOrCreateActiveChannelSession(db, {
    scope: "dashboard_chat",
    scopeKey: "dashboard",
    platform: "dashboard",
    channelId: "dashboard",
  });
  new MessageRecorder(db).recordMessage({
    sessionId: session.id,
    role: "user",
    platform: "dashboard",
    content: "I am still here.",
  });
}

describe("handleTaskDeliveryInsideGate", () => {
  it("idle delivery sends the draft, records task_result, and marks the browser task delivered", async () => {
    seedCompletedTask();
    const event = createBrowserTaskResultDeliveryEvent({
      taskId: "task-1",
      originatingChannel: "slack:C123",
      title: "check the order status",
      report: "The order ships tomorrow.",
    });

    await handleTaskDeliveryInsideGate(
      {
        db,
        config,
        notificationMgr,
        executeScheduledTask: async () => {
          throw new Error("should not run active turn");
        },
      },
      event,
    );

    expect(notificationMgr.sends).toHaveLength(1);
    expect(notificationMgr.sends[0].message).toContain("ships tomorrow");
    expect(notificationMgr.sends[0].options?.replyTo).toMatchObject({
      platform: "slack",
      channel: "C123",
    });
    expect(getBrowserTask(db, "task-1")?.deliveredAt).toEqual(
      expect.any(Number),
    );
    const row = db
      .prepare("SELECT metadata FROM messages WHERE role = 'assistant'")
      .get() as { metadata: string };
    expect(JSON.parse(row.metadata)).toMatchObject({
      notificationType: "task_result",
      taskKind: "browser_task",
      taskId: "task-1",
    });
  });

  it("createAutonomousForwardDeliveryEvent honors optional title + correlationId", () => {
    const event = createAutonomousForwardDeliveryEvent({
      content: "the body",
      originatingChannel: "slack:C9",
      title: "Cluster update",
      correlationId: "corr-xyz",
    });
    expect(event.correlationId).toBe("corr-xyz");
    expect(event.taskContext).toMatchObject({
      taskKind: "autonomous_forward",
      title: "Cluster update",
      draft: "the body",
      report: "the body",
      originatingChannel: "slack:C9",
    });
    // default title path when omitted
    const bare = createAutonomousForwardDeliveryEvent({
      content: "x",
      originatingChannel: null,
    });
    expect(bare.taskContext.title).toBe("update");
  });

  it("autonomous_forward idle ⇒ verbatim send + proactive_forward record, no DB row", async () => {
    const event = createAutonomousForwardDeliveryEvent({
      content: "Heads up — your research cluster on EV batteries grew.",
      originatingChannel: "slack:C123",
    });
    await handleTaskDeliveryInsideGate(
      {
        db,
        config,
        notificationMgr,
        executeScheduledTask: async () => {
          throw new Error("should not run active turn when idle");
        },
      },
      event,
    );
    expect(notificationMgr.sends).toHaveLength(1);
    expect(notificationMgr.sends[0].message).toContain("EV batteries");
    const row = db
      .prepare("SELECT metadata FROM messages WHERE role = 'assistant'")
      .get() as { metadata: string };
    expect(JSON.parse(row.metadata)).toMatchObject({
      notificationType: "proactive_forward",
      taskKind: "autonomous_forward",
    });
  });

  it("autonomous_forward active ⇒ runs a synthetic scheduled.dm weave turn (no verbatim send)", async () => {
    recordRecentOwnerMessage();
    const event = createAutonomousForwardDeliveryEvent({
      content: "Your EV battery cluster grew.",
      originatingChannel: "slack:C123",
    });
    const executed: AgentTaskEvent[] = [];
    await handleTaskDeliveryInsideGate(
      {
        db,
        config,
        notificationMgr,
        executeScheduledTask: async (scheduledEvent) => {
          executed.push(scheduledEvent);
          const session = findOrCreateActiveChannelSession(db, {
            scope: "owner_dm",
            scopeKey: "owner",
            platform: "slack",
            channelId: "C123",
          });
          // Mirror the real result processor: derive the recorded metadata
          // from the synthetic event's `task_delivery_record` via the SAME
          // parser production uses. If `readTaskDeliveryRecord` ever drops
          // the autonomous_forward (proactive_forward) record again, `rec`
          // is null, the message loses its taskKind/deliveredTaskId tags,
          // the message-existence check misses, and `deliverActive` falls
          // through to a verbatim re-send — failing the `sends` assertion
          // below. (Regression guard for the double-delivery bug.)
          const rec = readTaskDeliveryRecord(scheduledEvent);
          new MessageRecorder(db).recordMessage({
            sessionId: session.id,
            role: "assistant",
            platform: "slack",
            content: "By the way, your EV cluster has been busy.",
            metadata: {
              notificationType: rec?.notificationType ?? "proactive_forward",
              ...(rec?.metadata ?? {}),
            },
          });
        },
      },
      event,
    );
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ type: "scheduled.dm", source: "task.delivery" });
    // The woven message carried the task-delivery tags, so the existence
    // check confirmed the weave landed — no verbatim re-send happened.
    expect(notificationMgr.sends).toHaveLength(0);
    // And the recorded message is tagged so a later turn knows the forward
    // was already surfaced (awareness) and the dedup can find it.
    const recorded = db
      .prepare(
        "SELECT metadata FROM messages WHERE role = 'assistant' ORDER BY id DESC LIMIT 1",
      )
      .get() as { metadata: string };
    expect(JSON.parse(recorded.metadata)).toMatchObject({
      notificationType: "proactive_forward",
      taskKind: "autonomous_forward",
      deliveredTaskId: event.taskContext.taskId,
    });
  });

  it("active delivery runs a synthetic scheduled.dm turn and backfills delivered_at from tagged history", async () => {
    seedCompletedTask();
    recordRecentOwnerMessage();
    const event = createBrowserTaskResultDeliveryEvent({
      taskId: "task-1",
      originatingChannel: "slack:C123",
      title: "check the order status",
      report: "The order ships tomorrow.",
    });
    const executed: AgentTaskEvent[] = [];

    await handleTaskDeliveryInsideGate(
      {
        db,
        config,
        notificationMgr,
        executeScheduledTask: async (scheduledEvent) => {
          executed.push(scheduledEvent);
          const session = findOrCreateActiveChannelSession(db, {
            scope: "owner_dm",
            scopeKey: "owner",
            platform: "slack",
            channelId: "C123",
          });
          new MessageRecorder(db).recordMessage({
            sessionId: session.id,
            role: "assistant",
            platform: "slack",
            content: "That order task finished: it ships tomorrow.",
            metadata: {
              notificationType: "task_result",
              taskKind: "browser_task",
              deliveredTaskId: "task-1",
            },
          });
        },
      },
      event,
    );

    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({
      type: "scheduled.dm",
      source: "task.delivery",
      task: "task delivery: check the order status",
    });
    expect(notificationMgr.sends).toHaveLength(0);
    expect(getBrowserTask(db, "task-1")?.deliveredAt).toEqual(
      expect.any(Number),
    );
  });

  it("hands resolved assets to the active turn (attachments on data, manifest in task_context)", async () => {
    seedCompletedTask();
    recordRecentOwnerMessage();
    const event = createBrowserTaskResultDeliveryEvent({
      taskId: "task-1",
      originatingChannel: "slack:C123",
      title: "check the order status",
      report: "The order ships tomorrow.",
      screenshotKeys: ["task-1/confirmation.png"],
    });
    const attachment = {
      id: "task-1/confirmation.png",
      path: "/tmp/aitne-test/trace/task-1/confirmation.png",
      originalFilename: "confirmation.png",
      mimeType: "image/png",
      sizeBytes: 1234,
    };
    let captured: AgentTaskEvent | undefined;

    await handleTaskDeliveryInsideGate(
      {
        db,
        config,
        notificationMgr,
        resolveAssets: async () => [attachment],
        executeScheduledTask: async (scheduledEvent) => {
          captured = scheduledEvent;
          const session = findOrCreateActiveChannelSession(db, {
            scope: "owner_dm",
            scopeKey: "owner",
            platform: "slack",
            channelId: "C123",
          });
          new MessageRecorder(db).recordMessage({
            sessionId: session.id,
            role: "assistant",
            platform: "slack",
            content: "Done — screenshot attached.",
            metadata: {
              notificationType: "task_result",
              taskKind: "browser_task",
              deliveredTaskId: "task-1",
            },
          });
        },
      },
      event,
    );

    // Resolved bytes ride on the synthetic event's data for the result
    // processor to attach to the woven reply…
    const data = captured?.data as Record<string, unknown>;
    expect(data[TASK_DELIVERY_ATTACHMENTS_KEY]).toEqual([attachment]);
    // …and the agent sees the filename/kind manifest (no internal key/path).
    const taskCtx = captured?.taskContext as {
      task_delivery: { assets: unknown };
    };
    expect(taskCtx.task_delivery.assets).toEqual([
      { filename: "confirmation.png", kind: "screenshot" },
    ]);
  });

  it("carries the resolved assets into the idle fallback when the active turn leaves no tagged message", async () => {
    seedCompletedTask();
    recordRecentOwnerMessage();
    const event = createBrowserTaskResultDeliveryEvent({
      taskId: "task-1",
      originatingChannel: "slack:C123",
      title: "check the order status",
      report: "The order ships tomorrow.",
      screenshotKeys: ["task-1/confirmation.png"],
    });
    const attachment = {
      id: "task-1/confirmation.png",
      path: "/tmp/aitne-test/trace/task-1/confirmation.png",
      originalFilename: "confirmation.png",
      mimeType: "image/png",
      sizeBytes: 1234,
    };
    let resolveCalls = 0;

    await handleTaskDeliveryInsideGate(
      {
        db,
        config,
        notificationMgr,
        resolveAssets: async () => {
          resolveCalls += 1;
          return [attachment];
        },
        // Active turn runs but records no tagged message ⇒ fallback to idle.
        executeScheduledTask: async () => {},
      },
      event,
    );

    // Fallback idle send still carries the screenshot, and assets are
    // resolved exactly once (the pre-resolved set is reused).
    expect(notificationMgr.sends).toHaveLength(1);
    expect(notificationMgr.sends[0].options?.attachments).toEqual([attachment]);
    expect(resolveCalls).toBe(1);
    expect(getBrowserTask(db, "task-1")?.deliveredAt).toEqual(
      expect.any(Number),
    );
  });

  it("recovery dedups an existing tagged message and does not send again", async () => {
    seedCompletedTask();
    const session = findOrCreateActiveChannelSession(db, {
      scope: "owner_dm",
      scopeKey: "owner",
      platform: "slack",
      channelId: "C123",
    });
    new MessageRecorder(db).recordMessage({
      sessionId: session.id,
      role: "assistant",
      platform: "slack",
      content: "Already delivered.",
      metadata: {
        notificationType: "task_result",
        taskKind: "browser_task",
        taskId: "task-1",
      },
    });
    const event = createBrowserTaskResultDeliveryEvent({
      taskId: "task-1",
      originatingChannel: "slack:C123",
      title: "check the order status",
      report: "The order ships tomorrow.",
    });

    await handleTaskDeliveryInsideGate(
      {
        db,
        config,
        notificationMgr,
        executeScheduledTask: async () => {
          throw new Error("should not run active turn");
        },
      },
      event,
    );

    expect(notificationMgr.sends).toHaveLength(0);
    expect(getBrowserTask(db, "task-1")?.deliveredAt).toEqual(
      expect.any(Number),
    );
  });

  it("defers an idle send during quiet hours and leaves the row undelivered for the recovery sweep", async () => {
    seedCompletedTask();
    const event = createBrowserTaskResultDeliveryEvent({
      taskId: "task-1",
      originatingChannel: "slack:C123",
      title: "check the order status",
      report: "The order ships tomorrow.",
    });
    // 03:00 UTC, inside an 01:00–05:00 UTC quiet window. No owner inbound
    // ⇒ idle. The send must be suppressed and delivered_at left NULL.
    const nowMs = new Date(Date.UTC(2026, 0, 1, 3, 0, 0)).getTime();

    await handleTaskDeliveryInsideGate(
      {
        db,
        config: {
          ...config,
          timezone: "UTC",
          quietHoursStart: "01:00",
          quietHoursEnd: "05:00",
        },
        notificationMgr,
        executeScheduledTask: async () => {
          throw new Error("idle should not run an active turn");
        },
        nowFn: () => nowMs,
      },
      event,
    );

    expect(notificationMgr.sends).toHaveLength(0);
    expect(getBrowserTask(db, "task-1")?.deliveredAt).toBeNull();
  });

  it("folds browser-task screenshots into assets and attaches them to the idle send", async () => {
    seedCompletedTask();
    const event = createBrowserTaskResultDeliveryEvent({
      taskId: "task-1",
      originatingChannel: "slack:C123",
      title: "check the order status",
      report: "The order ships tomorrow.",
      screenshotKeys: ["task-1/confirmation.png"],
    });
    const attachment = {
      id: "task-1/confirmation.png",
      path: "/tmp/aitne-test/trace/task-1/confirmation.png",
      originalFilename: "confirmation.png",
      mimeType: "image/png",
      sizeBytes: 1234,
    };

    await handleTaskDeliveryInsideGate(
      {
        db,
        config,
        notificationMgr,
        executeScheduledTask: async () => {
          throw new Error("idle should not run an active turn");
        },
        resolveAssets: async (platform, assets) => {
          expect(platform).toBe("slack");
          // The legacy screenshotKey is folded into a screenshot asset.
          expect(assets).toEqual([
            {
              filename: "confirmation.png",
              kind: "screenshot",
              screenshotKey: "task-1/confirmation.png",
            },
          ]);
          return [attachment];
        },
      },
      event,
    );

    expect(notificationMgr.sends).toHaveLength(1);
    expect(notificationMgr.sends[0].options?.attachments).toEqual([attachment]);
  });

  it("attaches worker-produced background-task file assets (PDF) to the idle send", async () => {
    // background_task delivery with an explicit `assets` file manifest —
    // the generic path-based asset source the worker populates.
    const event = createBackgroundTaskResultDeliveryEvent({
      taskId: "bg-1",
      originatingChannel: "slack:C123",
      title: "quarterly report",
      draft: "Your quarterly report is ready.",
      report: "Full report body…",
      assets: [
        { filename: "Q3.pdf", kind: "pdf", path: "/tmp/out/Q3.pdf" },
      ],
    });
    const pdf = {
      id: "/tmp/out/Q3.pdf",
      path: "/tmp/out/Q3.pdf",
      originalFilename: "Q3.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4096,
    };

    await handleTaskDeliveryInsideGate(
      {
        db,
        config,
        notificationMgr,
        executeScheduledTask: async () => {
          throw new Error("idle should not run an active turn");
        },
        resolveAssets: async (_platform, assets) => {
          expect(assets).toEqual([
            { filename: "Q3.pdf", kind: "pdf", path: "/tmp/out/Q3.pdf" },
          ]);
          return [pdf];
        },
      },
      event,
    );

    expect(notificationMgr.sends).toHaveLength(1);
    expect(notificationMgr.sends[0].options?.attachments).toEqual([pdf]);
  });

  it("files-and-marks a channel-less task so the recovery sweep stops re-enqueuing it", async () => {
    createBrowserTask(db, {
      id: "task-nochan",
      description: "headless monitor",
      siteKey: null,
      extraAllowedHosts: [],
      originatingChannel: null,
      scheduleRowId: null,
      requireFinalConfirm: true,
      effectiveAllowlistRegex: null,
      createdAt: 1000,
    });
    markTerminal(db, {
      id: "task-nochan",
      state: "completed",
      outcomeDetail: null,
      report: "Nothing changed overnight.",
      finishedAt: 2000,
    });
    const event = createBrowserTaskResultDeliveryEvent({
      taskId: "task-nochan",
      originatingChannel: null,
      title: "headless monitor",
      report: "Nothing changed overnight.",
    });

    await handleTaskDeliveryInsideGate(
      {
        db,
        config,
        notificationMgr,
        executeScheduledTask: async () => {
          throw new Error("active turn must not run for a channel-less task");
        },
      },
      event,
    );

    // No DM attempted, no LLM turn, but delivered_at is set so the sweep
    // does not churn on this row forever.
    expect(notificationMgr.sends).toHaveLength(0);
    expect(getBrowserTask(db, "task-nochan")?.deliveredAt).toEqual(
      expect.any(Number),
    );
  });

  it("clarification delivery records task_clarification metadata without exposing the id in text", async () => {
    createBrowserTask(db, {
      id: "task-clarify",
      description: "choose the shipping option",
      siteKey: null,
      extraAllowedHosts: [],
      originatingChannel: "slack:C123",
      scheduleRowId: null,
      requireFinalConfirm: true,
      effectiveAllowlistRegex: null,
      createdAt: 1000,
    });
    db.prepare("UPDATE browser_task SET state = 'awaiting_user' WHERE id = ?")
      .run("task-clarify");
    const clarification = createClarification(db, {
      id: "11111111-1111-4111-8111-111111111111",
      taskId: "task-clarify",
      question: "Which shipping speed should I pick?",
      contextSummary: "Standard is free; express costs $8.",
      screenshotKey: null,
      askedAt: Date.now(),
    });
    const event = createBrowserTaskClarificationDeliveryEvent({
      taskId: "task-clarify",
      originatingChannel: "slack:C123",
      title: "choose the shipping option",
      clarificationId: clarification.id,
      question: clarification.question,
      contextSummary: clarification.contextSummary,
      screenshotKey: null,
    });

    await handleTaskDeliveryInsideGate(
      {
        db,
        config,
        notificationMgr,
        executeScheduledTask: async () => {
          throw new Error("should not run active turn");
        },
      },
      event,
    );

    expect(notificationMgr.sends[0].message).not.toContain(clarification.id);
    const row = db
      .prepare("SELECT metadata FROM messages WHERE role = 'assistant'")
      .get() as { metadata: string };
    expect(JSON.parse(row.metadata)).toMatchObject({
      notificationType: "task_clarification",
      taskKind: "browser_task",
      taskId: "task-clarify",
      clarificationId: clarification.id,
    });
  });

  it("falls back to a direct draft send when the active delivery turn throws", async () => {
    seedCompletedTask();
    recordRecentOwnerMessage();
    const event = createBrowserTaskResultDeliveryEvent({
      taskId: "task-1",
      originatingChannel: "slack:C123",
      title: "check the order status",
      report: "The order ships tomorrow.",
    });

    await handleTaskDeliveryInsideGate(
      {
        db,
        config,
        notificationMgr,
        executeScheduledTask: async () => {
          throw new Error("the delivery turn blew up");
        },
      },
      event,
    );

    // The active turn threw ⇒ the handler fell back to the idle draft send,
    // which still records + marks the task delivered.
    expect(notificationMgr.sends).toHaveLength(1);
    expect(notificationMgr.sends[0].message).toContain("ships tomorrow");
    expect(getBrowserTask(db, "task-1")?.deliveredAt).toEqual(
      expect.any(Number),
    );
  });

  it("threads the injected clock and a labelled asset manifest through the active turn", async () => {
    recordRecentOwnerMessage();
    const event = createBackgroundTaskResultDeliveryEvent({
      taskId: "bg-active",
      originatingChannel: "slack:C123",
      title: "quarterly audit",
      draft: "two repos red",
      report: "full audit body",
      assets: [
        {
          filename: "Q3.pdf",
          kind: "pdf",
          path: "/tmp/out/Q3.pdf",
          label: "quarterly numbers",
        },
      ],
    });
    const pdf = {
      id: "/tmp/out/Q3.pdf",
      path: "/tmp/out/Q3.pdf",
      originalFilename: "Q3.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4096,
    };
    let captured: AgentTaskEvent | undefined;

    await handleTaskDeliveryInsideGate(
      {
        db,
        config,
        notificationMgr,
        nowFn: () => 7_777,
        resolveAssets: async () => [pdf],
        executeScheduledTask: async (scheduledEvent) => {
          captured = scheduledEvent;
          const session = findOrCreateActiveChannelSession(db, {
            scope: "owner_dm",
            scopeKey: "owner",
            platform: "slack",
            channelId: "C123",
          });
          new MessageRecorder(db).recordMessage({
            sessionId: session.id,
            role: "assistant",
            platform: "slack",
            content: "Done — quarterly numbers attached.",
            metadata: {
              notificationType: "task_result",
              taskKind: "background_task",
              deliveredTaskId: "bg-active",
            },
          });
        },
      },
      event,
    );

    // Active weave ⇒ no verbatim idle send…
    expect(notificationMgr.sends).toHaveLength(0);
    // …and the agent-facing manifest surfaces the human label (no path/key).
    const taskCtx = captured?.taskContext as {
      task_delivery: { assets: unknown };
    };
    expect(taskCtx.task_delivery.assets).toEqual([
      { filename: "Q3.pdf", kind: "pdf", label: "quarterly numbers" },
    ]);
  });

  it("sends text-only when asset resolution throws", async () => {
    seedCompletedTask();
    const event = createBrowserTaskResultDeliveryEvent({
      taskId: "task-1",
      originatingChannel: "slack:C123",
      title: "check the order status",
      report: "The order ships tomorrow.",
      screenshotKeys: ["task-1/confirmation.png"],
    });

    await handleTaskDeliveryInsideGate(
      {
        db,
        config,
        notificationMgr,
        resolveAssets: async () => {
          throw new Error("resolver is down");
        },
        executeScheduledTask: async () => {
          throw new Error("idle send expected");
        },
      },
      event,
    );

    // Asset failure must never block the text DM — it just drops the files.
    expect(notificationMgr.sends).toHaveLength(1);
    expect(notificationMgr.sends[0].options?.attachments).toBeUndefined();
  });

  it("resolves no attachments when the payload has neither assets nor screenshot keys", async () => {
    seedCompletedTask();
    const event = createBrowserTaskResultDeliveryEvent({
      taskId: "task-1",
      originatingChannel: "slack:C123",
      title: "check the order status",
      report: "The order ships tomorrow.",
    });
    // A payload missing the screenshotKeys field entirely (the worker wrote
    // no deliverables) must resolve to an empty asset list, never call the
    // resolver, and send text only.
    delete (event.taskContext as { screenshotKeys?: string[] }).screenshotKeys;

    await handleTaskDeliveryInsideGate(
      {
        db,
        config,
        notificationMgr,
        resolveAssets: async () => {
          throw new Error("must not resolve when there are no assets");
        },
        executeScheduledTask: async () => {
          throw new Error("idle send expected");
        },
      },
      event,
    );

    expect(notificationMgr.sends).toHaveLength(1);
    expect(notificationMgr.sends[0].options?.attachments).toBeUndefined();
  });

  it("grounds the active turn on the draft when the payload carries no verbatim report", async () => {
    seedCompletedTask();
    recordRecentOwnerMessage();
    const event = createBrowserTaskResultDeliveryEvent({
      taskId: "task-1",
      originatingChannel: "slack:C123",
      title: "check the order status",
      report: "The order ships tomorrow.",
    });
    // No verbatim report on the payload ⇒ the active turn is grounded on the
    // worker draft instead.
    delete (event.taskContext as { report?: string | null }).report;
    let captured: AgentTaskEvent | undefined;

    await handleTaskDeliveryInsideGate(
      {
        db,
        config,
        notificationMgr,
        executeScheduledTask: async (scheduledEvent) => {
          captured = scheduledEvent;
          const session = findOrCreateActiveChannelSession(db, {
            scope: "owner_dm",
            scopeKey: "owner",
            platform: "slack",
            channelId: "C123",
          });
          new MessageRecorder(db).recordMessage({
            sessionId: session.id,
            role: "assistant",
            platform: "slack",
            content: "It ships tomorrow.",
            metadata: {
              notificationType: "task_result",
              taskKind: "browser_task",
              deliveredTaskId: "task-1",
            },
          });
        },
      },
      event,
    );

    const tc = captured?.taskContext as {
      task_delivery: { report: string; draft: string };
    };
    expect(tc.task_delivery.report).toBe(tc.task_delivery.draft);
  });

  it("treats a clarification delivery missing its clarificationId as not-yet-delivered", async () => {
    createBrowserTask(db, {
      id: "task-c",
      description: "choose shipping",
      siteKey: null,
      extraAllowedHosts: [],
      originatingChannel: "slack:C123",
      scheduleRowId: null,
      requireFinalConfirm: true,
      effectiveAllowlistRegex: null,
      createdAt: 1000,
    });
    db.prepare("UPDATE browser_task SET state = 'awaiting_user' WHERE id = ?")
      .run("task-c");
    const event = createBrowserTaskClarificationDeliveryEvent({
      taskId: "task-c",
      originatingChannel: "slack:C123",
      title: "choose shipping",
      clarificationId: "c1",
      question: "fast or cheap?",
      contextSummary: null,
      screenshotKey: null,
    });
    // Strip the id ⇒ the delivered-already check must short-circuit to
    // "not delivered" rather than crash, and the idle send proceeds.
    delete (event.taskContext as { clarificationId?: string | null })
      .clarificationId;

    await handleTaskDeliveryInsideGate(
      {
        db,
        config,
        notificationMgr,
        executeScheduledTask: async () => {
          throw new Error("idle send expected");
        },
      },
      event,
    );

    expect(notificationMgr.sends).toHaveLength(1);
  });
});

describe("delivery event factories", () => {
  it("truncates an over-long browser report into the draft while keeping the verbatim report", () => {
    const longReport = "x".repeat(4_200);
    const event = createBrowserTaskResultDeliveryEvent({
      taskId: "t",
      originatingChannel: "slack:C1",
      title: "big audit",
      report: longReport,
    });
    // The verbatim report is preserved on the row…
    expect(event.taskContext.report).toBe(longReport);
    // …while the draft is capped with a truncation marker.
    expect(event.taskContext.draft).toContain("[... truncated");
    expect(event.taskContext.draft.length).toBeLessThan(longReport.length);
  });

  it("omits the Context line when a browser clarification has no contextSummary", () => {
    const event = createBrowserTaskClarificationDeliveryEvent({
      taskId: "t",
      originatingChannel: "slack:C1",
      title: "pick one",
      clarificationId: "c1",
      question: "web or api first?",
      contextSummary: null,
      screenshotKey: null,
    });
    expect(event.taskContext.draft).toContain("web or api first?");
    expect(event.taskContext.draft).not.toContain("Context:");
  });

  it("folds a browser clarification screenshotKey into screenshotKeys", () => {
    const event = createBrowserTaskClarificationDeliveryEvent({
      taskId: "t",
      originatingChannel: "slack:C1",
      title: "pick one",
      clarificationId: "c1",
      question: "which option?",
      contextSummary: "two choices on screen",
      screenshotKey: "t/choice.png",
    });
    expect(event.taskContext.screenshotKeys).toEqual(["t/choice.png"]);
  });
});

describe("enqueueUndeliveredBrowserTaskDeliveries", () => {
  it("re-enqueues completed reports and open clarifications with default now/limit", async () => {
    seedCompletedTask("done");
    createBrowserTask(db, {
      id: "parked",
      description: "pick a delivery slot",
      siteKey: null,
      extraAllowedHosts: [],
      originatingChannel: "slack:C1",
      scheduleRowId: null,
      requireFinalConfirm: true,
      effectiveAllowlistRegex: null,
      createdAt: 1000,
    });
    db.prepare("UPDATE browser_task SET state = 'awaiting_user' WHERE id = ?")
      .run("parked");
    createClarification(db, {
      id: "c1",
      taskId: "parked",
      question: "morning or evening?",
      contextSummary: null,
      screenshotKey: null,
      askedAt: Date.now(),
    });

    const enqueued: string[] = [];
    const count = await enqueueUndeliveredBrowserTaskDeliveries({
      db,
      eventBus: {
        put: async (e) => {
          enqueued.push(`${e.taskContext.taskId}:${e.taskContext.deliveryType}`);
        },
      },
    });

    expect(count).toBe(2);
    expect(enqueued).toContain("done:task_result");
    // The clarification title comes from the JOINed task description, with no
    // second fetch.
    expect(enqueued).toContain("parked:task_clarification");
  });

  it("skips a completed row whose report is an empty string", async () => {
    createBrowserTask(db, {
      id: "empty",
      description: "overnight monitor",
      siteKey: null,
      extraAllowedHosts: [],
      originatingChannel: "slack:C1",
      scheduleRowId: null,
      requireFinalConfirm: true,
      effectiveAllowlistRegex: null,
      createdAt: 1000,
    });
    // `report IS NOT NULL` keeps an empty-string report in the recovery set,
    // so the `!row.report` guard is the thing that skips it.
    db.prepare(
      "UPDATE browser_task SET state = 'completed', report = '', finished_at = 2000 WHERE id = ?",
    ).run("empty");

    const enqueued: string[] = [];
    const count = await enqueueUndeliveredBrowserTaskDeliveries({
      db,
      eventBus: {
        put: async (e) => {
          enqueued.push(e.taskContext.taskId);
        },
      },
      nowMs: 5000,
      limit: 10,
    });

    expect(count).toBe(0);
    expect(enqueued).toHaveLength(0);
  });
});

describe("classifyOwnerDmActivity integration", () => {
  it("treats older inbound messages as idle based on the runtime threshold", async () => {
    seedCompletedTask();
    const session = findOrCreateActiveChannelSession(db, {
      scope: "owner_dm",
      scopeKey: "owner",
      platform: "slack",
      channelId: "C123",
    });
    db.prepare(
      `INSERT INTO messages
         (session_id, role, content, platform, timestamp, metadata)
       VALUES (?, 'user', 'old note', 'slack', ?, '{}')`,
    ).run(
      session.id,
      formatSqliteDatetime(new Date(Date.now() - 10 * 60_000)),
    );
    const event = createBrowserTaskResultDeliveryEvent({
      taskId: "task-1",
      originatingChannel: "slack:C123",
      title: "check the order status",
      report: "The order ships tomorrow.",
    });

    await handleTaskDeliveryInsideGate(
      {
        db,
        config: { ...config, ownerActivityIdleThresholdMinutes: 5 },
        notificationMgr,
        executeScheduledTask: async () => {
          throw new Error("should be idle");
        },
      },
      event,
    );

    expect(notificationMgr.sends).toHaveLength(1);
  });
});
