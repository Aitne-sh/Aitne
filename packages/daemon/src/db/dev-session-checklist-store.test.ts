import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import { createDevSession } from "./dev-sessions-store.js";
import { insertDevTasks } from "./dev-session-tasks-store.js";
import {
  listDevChecklist,
  listSeenAcIds,
  upsertDevChecklistRow,
  type UpsertDevChecklistRowInput,
} from "./dev-session-checklist-store.js";

const T0 = 1_700_000_000_000;

function mkRow(
  overrides: Partial<UpsertDevChecklistRowInput> & { id: string; acId: string },
): UpsertDevChecklistRowInput {
  return {
    sessionId: "s1",
    taskId: null,
    reqId: "REQ-001",
    expectation: "the thing observably works",
    method: "cmd",
    status: "pending",
    evidence: null,
    iter: 1,
    updatedAt: T0,
    ...overrides,
  };
}

describe("dev-session-checklist-store", () => {
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
      slug: "test",
      originatingPlatform: "telegram",
      originatingChannel: "telegram:1",
      createdAt: T0,
    });
    insertDevTasks(db, "s1", [
      {
        id: "t1", taskKey: "core", summary: "core", dependsOn: [], scope: "",
        reqs: [], body: "do", origin: "plan",
      },
    ], T0);
  });

  afterEach(() => {
    db.close();
  });

  it("upserts: first insert keeps id + first_seen_iter; updates rewrite content only", () => {
    upsertDevChecklistRow(db, mkRow({ id: "c1", acId: "AC-001", iter: 1 }));
    upsertDevChecklistRow(db, mkRow({
      id: "c1-replaced", acId: "AC-001", status: "verified",
      evidence: "npm test", iter: 5, updatedAt: T0 + 10,
    }));
    const rows = listDevChecklist(db, "s1", null);
    expect(rows).toHaveLength(1);
    // The original row identity + first-seen anchor survive the upsert.
    expect(rows[0]?.id).toBe("c1");
    expect(rows[0]?.firstSeenIter).toBe(1);
    // The content cells follow the latest markdown sync.
    expect(rows[0]?.status).toBe("verified");
    expect(rows[0]?.evidence).toBe("npm test");
    expect(rows[0]?.updatedAt).toBe(T0 + 10);
  });

  it("keeps session-level and task-scoped lanes separate for the same ac_id", () => {
    upsertDevChecklistRow(db, mkRow({ id: "c-sess", acId: "AC-001" }));
    upsertDevChecklistRow(db, mkRow({ id: "c-task", acId: "AC-001", taskId: "t1", method: "run" }));
    expect(listDevChecklist(db, "s1", null)).toHaveLength(1);
    expect(listDevChecklist(db, "s1", "t1")).toHaveLength(1);
    expect(listDevChecklist(db, "s1", "t1")[0]?.method).toBe("run");
    // Undefined taskId = the whole session (API/dashboard read).
    expect(listDevChecklist(db, "s1")).toHaveLength(2);
    // Updating the task lane leaves the session lane alone.
    upsertDevChecklistRow(db, mkRow({
      id: "x", acId: "AC-001", taskId: "t1", method: "run", status: "failed",
    }));
    expect(listDevChecklist(db, "s1", null)[0]?.status).toBe("pending");
    expect(listDevChecklist(db, "s1", "t1")[0]?.status).toBe("failed");
  });

  it("listSeenAcIds is the monotonicity baseline — ids only accumulate", () => {
    upsertDevChecklistRow(db, mkRow({ id: "c1", acId: "AC-001" }));
    upsertDevChecklistRow(db, mkRow({ id: "c2", acId: "AC-002" }));
    upsertDevChecklistRow(db, mkRow({ id: "c3", acId: "AC-002" })); // re-sync
    expect(listSeenAcIds(db, "s1", null)).toEqual(["AC-001", "AC-002"]);
    expect(listSeenAcIds(db, "s1", "t1")).toEqual([]);
  });

  it("cascade-deletes with its task and its session", () => {
    upsertDevChecklistRow(db, mkRow({ id: "c-sess", acId: "AC-001" }));
    upsertDevChecklistRow(db, mkRow({ id: "c-task", acId: "AC-002", taskId: "t1" }));
    db.prepare(`DELETE FROM dev_session_tasks WHERE id = 't1'`).run();
    expect(listDevChecklist(db, "s1")).toHaveLength(1);
    db.prepare(`DELETE FROM dev_sessions WHERE id = 's1'`).run();
    expect(listDevChecklist(db, "s1")).toHaveLength(0);
  });
});
