import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import {
  approveDevSession,
  createDevSession,
  markDevAwaitingApproval,
  markDevTerminal,
  seedDevRequirements,
  updateDevRequirement,
} from "../../db/dev-sessions-store.js";
import { insertDevTasks, markDevTaskState } from "../../db/dev-session-tasks-store.js";
import { upsertDevChecklistRow } from "../../db/dev-session-checklist-store.js";
import { createDevEscalation } from "../../db/dev-session-escalations-store.js";
import {
  buildDevStatusSnapshot,
  formatDevStatus,
  type DevStatusSnapshot,
} from "./dev-status.js";

const T0 = 1_700_000_000_000;

function baseSnapshot(overrides: Partial<DevStatusSnapshot> = {}): DevStatusSnapshot {
  return {
    slug: "acme",
    state: "running",
    loopState: null,
    iteration: 3,
    maxIterations: 10,
    reqMet: 1,
    reqTotal: 2,
    acVerified: 0,
    acTotal: 0,
    acHumanPending: 0,
    costUsd: 1.234,
    maxBudgetUsd: null,
    branch: "aitne-dev/s1",
    tasksMerged: 0,
    tasksTotal: 0,
    queuedManual: 0,
    openQuestionAgeMs: null,
    ...overrides,
  };
}

describe("formatDevStatus (pure)", () => {
  it("renders the compact head line with only the parts that exist", () => {
    const out = formatDevStatus(baseSnapshot());
    expect(out).toContain("dev acme: running · iter 3/10 · REQ 1/2 · $1.23");
    expect(out).toContain("branch: aitne-dev/s1");
    expect(out).not.toContain("AC ");
    expect(out).not.toContain("fleet:");
  });

  it("adds checklist/fleet/question/action lines when present", () => {
    const out = formatDevStatus(baseSnapshot({
      state: "failed",
      loopState: "BLOCKED",
      acVerified: 5,
      acTotal: 7,
      acHumanPending: 1,
      maxBudgetUsd: 6,
      tasksMerged: 2,
      tasksTotal: 4,
      queuedManual: 1,
      openQuestionAgeMs: 95 * 60_000,
    }));
    expect(out).toContain("dev acme: failed/BLOCKED");
    expect(out).toContain("AC 5/7 (1 await your sign-off)");
    expect(out).toContain("$1.23/$6");
    expect(out).toContain("fleet: 2/4 merged · 1 manual queued");
    expect(out).toContain("open question waiting 2h");
    expect(out).toContain("→ !resume to continue");
    // Mobile budget: the block stays tight.
    expect(out.length).toBeLessThan(500);
  });

  it("suggests the right next action per state", () => {
    expect(formatDevStatus(baseSnapshot({ state: "awaiting_approval" }))).toContain("!approve");
    expect(formatDevStatus(baseSnapshot({ state: "awaiting_user" }))).toContain("answer the open question");
    expect(formatDevStatus(baseSnapshot({ state: "done" }))).toContain("!add");
    expect(formatDevStatus(baseSnapshot({ state: "done", queuedManual: 2 }))).toContain("!resume");
  });
});

describe("buildDevStatusSnapshot (db aggregation)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    db.prepare(
      `INSERT INTO repositories (id, local_path, local_only, created_at, updated_at)
       VALUES ('r1', '/tmp/r1', 1, ?, ?)`,
    ).run(T0, T0);
    createDevSession(db, {
      id: "s1",
      repositoryId: "r1",
      slug: "acme",
      originatingPlatform: "telegram",
      originatingChannel: "telegram:D1",
      createdAt: T0,
    });
    markDevAwaitingApproval(db, "s1", T0);
    approveDevSession(db, {
      id: "s1", approvedHash: "h", branch: "aitne-dev/s1", baseRef: "x",
      maxIterations: 10, maxBudgetUsd: 5, approvedAt: T0,
    });
    seedDevRequirements(db, "s1", [
      { id: "q1", reqId: "REQ-001", title: "a" },
      { id: "q2", reqId: "REQ-002", title: "b" },
    ], T0);
    updateDevRequirement(db, { sessionId: "s1", reqId: "REQ-001", status: "met", updatedAt: T0 });
  });

  afterEach(() => db.close());

  it("aggregates reqs, checklist, fleet, and the open question for the channel", () => {
    upsertDevChecklistRow(db, {
      id: "c1", sessionId: "s1", taskId: null, acId: "AC-001", reqId: "REQ-001",
      expectation: "x", method: "human", status: "pending", evidence: null,
      iter: 1, updatedAt: T0,
    });
    insertDevTasks(db, "s1", [
      { id: "t1", taskKey: "a", summary: "a", dependsOn: [], scope: "", reqs: [], body: "x", origin: "plan" },
      { id: "t2", taskKey: "manual-1", summary: "m", dependsOn: [], scope: "", reqs: [], body: "y", origin: "manual" },
    ], T0);
    markDevTaskState(db, { id: "t1", from: ["queued"], to: "running", at: T0 });
    markDevTaskState(db, { id: "t1", from: ["running"], to: "merge_pending", at: T0 });
    markDevTaskState(db, { id: "t1", from: ["merge_pending"], to: "merged", at: T0 });
    createDevEscalation(db, {
      id: "e1", sessionId: "s1", kind: "spec_decision", question: "which db?",
      contextSummary: null, askedAt: T0,
    });

    const snap = buildDevStatusSnapshot(db, "telegram:D1", T0 + 10 * 60_000)!;
    expect(snap).toMatchObject({
      slug: "acme",
      state: "running",
      reqMet: 1,
      reqTotal: 2,
      acTotal: 1,
      acHumanPending: 1,
      tasksMerged: 1,
      tasksTotal: 2,
      queuedManual: 1,
      maxBudgetUsd: 5,
      openQuestionAgeMs: 10 * 60_000,
    });
  });

  it("channel binding: another channel sees nothing while a foreign session is active", () => {
    expect(buildDevStatusSnapshot(db, "discord:9", T0)).toBeNull();
    // After the session ends, the ORIGINATING channel still sees it (terminal
    // render with the next action); other channels still see nothing.
    markDevTerminal(db, { id: "s1", state: "failed", loopState: "BLOCKED", exitedAt: T0 });
    expect(buildDevStatusSnapshot(db, "telegram:D1", T0)?.state).toBe("failed");
    expect(buildDevStatusSnapshot(db, "discord:9", T0)).toBeNull();
  });
});
