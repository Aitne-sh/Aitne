import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";

import { applySchema } from "./schema.js";
import { createBackgroundTask, markRunning, markAwaitingUser } from "./background-task-store.js";
import {
  createClarification,
  getClarification,
  getOpenClarificationForTask,
  listClarificationsForTask,
  resolveClarification,
  listOverdueClarifications,
  expireClarification,
  markClarificationDelivered,
  listUndeliveredClarifications,
} from "./background-task-clarifications-store.js";

const TTL = 60 * 60 * 1000; // 60 min

function seedTask(db: Database.Database, id: string): void {
  createBackgroundTask(db, {
    id,
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
  markRunning(db, id, 1100);
  markAwaitingUser(db, id);
}

describe("background-task-clarifications-store", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    seedTask(db, "t1");
  });

  it("creates a clarification with a TTL-derived deadline", () => {
    const row = createClarification(db, {
      id: "c1",
      taskId: "t1",
      question: "web or api first?",
      contextSummary: "scoping the audit",
      askedAt: 2000,
      ttlMs: TTL,
    });
    expect(row.deadlineAt).toBe(2000 + TTL);
    expect(getOpenClarificationForTask(db, "t1")?.id).toBe("c1");
    expect(listClarificationsForTask(db, "t1")).toHaveLength(1);
  });

  it("CAS-resolves an answer and is idempotent", () => {
    createClarification(db, { id: "c1", taskId: "t1", question: "q", contextSummary: null, askedAt: 2000, ttlMs: TTL });
    const r = resolveClarification(db, { id: "c1", answer: "api", answeredAt: 3000 });
    expect(r.ok).toBe(true);
    expect(getClarification(db, "c1")?.answer).toBe("api");
    // second resolve fails (already resolved)
    const again = resolveClarification(db, { id: "c1", answer: "web", answeredAt: 3100 });
    expect(again.ok).toBe(false);
    expect(again.reason).toBe("already_resolved");
    expect(getOpenClarificationForTask(db, "t1")).toBeNull();
  });

  it("refuses a past-deadline answer and lets the scanner expire it", () => {
    createClarification(db, { id: "c1", taskId: "t1", question: "q", contextSummary: null, askedAt: 2000, ttlMs: TTL });
    const late = resolveClarification(db, { id: "c1", answer: "x", answeredAt: 2000 + TTL + 1 });
    expect(late.ok).toBe(false);
    expect(late.reason).toBe("expired");
    const overdue = listOverdueClarifications(db, 2000 + TTL + 5);
    expect(overdue.map((c) => c.id)).toEqual(["c1"]);
    expect(expireClarification(db, "c1", 2000 + TTL + 5)?.resolved).toBe(true);
    expect(listOverdueClarifications(db, 2000 + TTL + 9)).toHaveLength(0);
  });

  it("tracks delivery + lists undelivered open clarifications", () => {
    createClarification(db, { id: "c1", taskId: "t1", question: "q", contextSummary: null, askedAt: 2000, ttlMs: TTL });
    expect(listUndeliveredClarifications(db, 2500).map((c) => c.id)).toEqual(["c1"]);
    expect(markClarificationDelivered(db, "c1", 2600)?.deliveredAt).toBe(2600);
    // idempotent
    expect(markClarificationDelivered(db, "c1", 9999)?.deliveredAt).toBe(2600);
    expect(listUndeliveredClarifications(db, 2700)).toHaveLength(0);
  });
});
