import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { MessageEvent, WikiCostEstimate } from "@aitne/shared";
import { applySchema } from "../../db/schema.js";
import { enqueueWikiApproval } from "./approval-queue.js";
import type { GitPreCompilePreview } from "./git-precompile.js";

function makeMessageEvent(overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    type: "message.received",
    source: "slack",
    priority: 5,
    timestamp: new Date("2026-05-15T08:00:00Z"),
    data: {},
    correlationId: "corr-123",
    sender: "U0001",
    channel: "D0001",
    content: "!compile full",
    platform: "slack",
    threadId: null,
    isDm: true,
    isMention: false,
    ...overrides,
  };
}

function makeEstimate(overrides: Partial<WikiCostEstimate> = {}): WikiCostEstimate {
  return {
    rawCount: 42,
    estimatedInputTokens: 12_345,
    unitCostUsdPerKToken: 0.0008,
    optimisticUsd: 1.5,
    expectedUsd: 3,
    pessimisticUsd: 6,
    thresholdUsd: 2,
    exceedsThreshold: true,
    method: "flat-heuristic",
    perFile: [],
    ...overrides,
  };
}

function makePreview(): GitPreCompilePreview {
  return { status: "clean_would_commit" };
}

describe("enqueueWikiApproval", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("inserts a pending approval row with workspace + estimate in the task description", () => {
    const result = enqueueWikiApproval(db, {
      workspace: "default",
      processKey: "wiki.compile",
      sourceEvent: makeMessageEvent(),
      estimate: makeEstimate(),
      gitOutcome: makePreview(),
    });

    expect(result.scheduleId).toBeGreaterThan(0);
    expect(result.taskDescription).toBe(
      "Wiki full compile (default) — est. $3.00 (range $1.50–$6.00)",
    );

    const row = db
      .prepare(
        `SELECT task_type, task_description, task_prompt, correlation_id, status, task_context
           FROM agent_schedule
          WHERE id = ?`,
      )
      .get(result.scheduleId) as {
        task_type: string;
        task_description: string;
        task_prompt: string | null;
        correlation_id: string;
        status: string;
        task_context: string;
      };
    expect(row.task_type).toBe("approval");
    expect(row.task_description).toBe(result.taskDescription);
    expect(row.task_prompt).toBeNull();
    expect(row.correlation_id).toBe("corr-123");
    expect(row.status).toBe("pending");
  });

  it("encodes the reply-routing tuple in task_context", () => {
    const sourceEvent = makeMessageEvent({
      platform: "telegram",
      channel: "@aitne",
      threadId: "thread-42",
      sender: "owner",
      correlationId: "corr-tg",
    });
    const result = enqueueWikiApproval(db, {
      workspace: "research",
      processKey: "wiki.compile",
      sourceEvent,
      estimate: makeEstimate({ expectedUsd: 4.2 }),
      gitOutcome: { status: "refused", reason: "dirty_tree", dirtyPaths: ["a.md"] },
    });

    const row = db
      .prepare(`SELECT task_context FROM agent_schedule WHERE id = ?`)
      .get(result.scheduleId) as { task_context: string };
    const ctx = JSON.parse(row.task_context) as {
      workspace: string;
      processKey: string;
      estimate: WikiCostEstimate;
      git: GitPreCompilePreview;
      sourceCorrelationId: string;
      sourcePlatform: string;
      sourceChannel: string;
      replyTarget: {
        platform: string;
        channel: string;
        threadId: string | null | undefined;
        sender: string | undefined;
      };
    };
    expect(ctx.workspace).toBe("research");
    expect(ctx.processKey).toBe("wiki.compile");
    expect(ctx.estimate.expectedUsd).toBe(4.2);
    expect(ctx.git).toEqual({
      status: "refused",
      reason: "dirty_tree",
      dirtyPaths: ["a.md"],
    });
    expect(ctx.sourceCorrelationId).toBe("corr-tg");
    expect(ctx.sourcePlatform).toBe("telegram");
    expect(ctx.sourceChannel).toBe("@aitne");
    expect(ctx.replyTarget).toEqual({
      platform: "telegram",
      channel: "@aitne",
      threadId: "thread-42",
      sender: "owner",
    });
  });

  it("each call produces a distinct schedule row", () => {
    const first = enqueueWikiApproval(db, {
      workspace: "default",
      processKey: "wiki.compile",
      sourceEvent: makeMessageEvent({ correlationId: "corr-a" }),
      estimate: makeEstimate(),
      gitOutcome: makePreview(),
    });
    const second = enqueueWikiApproval(db, {
      workspace: "default",
      processKey: "wiki.compile",
      sourceEvent: makeMessageEvent({ correlationId: "corr-b" }),
      estimate: makeEstimate(),
      gitOutcome: makePreview(),
    });
    expect(second.scheduleId).not.toBe(first.scheduleId);
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM agent_schedule WHERE task_type = 'approval'`)
      .get() as { n: number };
    expect(count.n).toBe(2);
  });
});
