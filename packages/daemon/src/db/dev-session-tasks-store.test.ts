import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import {
  MIGRATIONS,
  columnExists,
  indexExists,
  runMigrations,
  tableExists,
} from "./migrations.js";
import { createDevSession, getDevSession, listDevIterations, recordDevIteration } from "./dev-sessions-store.js";
import { getDevEscalation } from "./dev-session-escalations-store.js";
import {
  DEV_TASK_LIVE_STATES,
  addDevTaskCost,
  bumpDevTaskMergeRetries,
  bumpDevTaskSuperviseCount,
  claimDevTask,
  getDevTask,
  getDevTaskByKey,
  insertDevTasks,
  listDevTasks,
  markDevTaskState,
  requeueDevTaskForResume,
  resetDevTaskForRedo,
  rewireDevTaskDeps,
  setDevTaskApprovedHash,
  setDevTaskPlanReview,
  setDevTaskSeedBranch,
  setDevTaskWorktree,
  writeDevTaskCheckpoint,
  type NewDevTaskInput,
} from "./dev-session-tasks-store.js";

const T0 = 1_700_000_000_000;

function seedRepo(db: Database.Database, id = "local:test"): string {
  db.prepare(
    `INSERT INTO repositories (id, local_path, local_only, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?)`,
  ).run(id, `/tmp/${id.replace(/[^a-z0-9]/gi, "_")}`, T0, T0);
  return id;
}

function seedSession(db: Database.Database, id = "s1"): string {
  createDevSession(db, {
    id,
    repositoryId: "local:test",
    slug: "test",
    originatingPlatform: "telegram",
    originatingChannel: "telegram:123",
    createdAt: T0,
  });
  return id;
}

function mkTask(overrides: Partial<NewDevTaskInput> & { id: string; taskKey: string }): NewDevTaskInput {
  return {
    summary: `task ${overrides.taskKey}`,
    dependsOn: [],
    scope: "packages/x",
    reqs: [],
    body: `do ${overrides.taskKey}`,
    origin: "plan",
    ...overrides,
  };
}

describe("dev-session-tasks-store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    seedRepo(db);
    seedSession(db);
  });

  afterEach(() => {
    db.close();
  });

  it("exposes the live (non-terminal) state set", () => {
    expect([...DEV_TASK_LIVE_STATES].sort()).toEqual([
      "awaiting_user",
      "merge_pending",
      "queued",
      "running",
      "supervise_pending",
    ]);
  });

  it("inserts a batch, round-trips JSON arrays and lists in creation-then-key order", () => {
    // Deliberately out-of-key-order within the batch — created_at ties
    // break on task_key.
    insertDevTasks(
      db,
      "s1",
      [
        mkTask({
          id: "t-b",
          taskKey: "beta",
          dependsOn: ["alpha"],
          reqs: ["REQ-001", "REQ-002"],
        }),
        mkTask({ id: "t-a", taskKey: "alpha" }),
      ],
      T0 + 1,
    );
    insertDevTasks(
      db,
      "s1",
      [mkTask({ id: "t-c", taskKey: "aaa-later", origin: "replan" })],
      T0 + 2,
    );

    const tasks = listDevTasks(db, "s1");
    expect(tasks.map((t) => t.taskKey)).toEqual(["alpha", "beta", "aaa-later"]);

    const beta = getDevTaskByKey(db, "s1", "beta");
    expect(beta?.id).toBe("t-b");
    expect(beta?.dependsOn).toEqual(["alpha"]);
    expect(beta?.reqs).toEqual(["REQ-001", "REQ-002"]);
    expect(beta?.state).toBe("queued");
    expect(beta?.origin).toBe("plan");
    expect(beta?.loopState).toBeNull();
    expect(beta?.costUsd).toBeNull();
    expect(beta?.startedAt).toBeNull();
    expect(getDevTask(db, "t-c")?.origin).toBe("replan");
    expect(getDevTask(db, "missing")).toBeNull();
    expect(getDevTaskByKey(db, "s1", "missing")).toBeNull();
  });

  it("rolls the whole insert batch back on a duplicate task_key (one transaction)", () => {
    insertDevTasks(db, "s1", [mkTask({ id: "t-1", taskKey: "dup" })], T0);
    expect(() =>
      insertDevTasks(
        db,
        "s1",
        [
          mkTask({ id: "t-2", taskKey: "fresh" }),
          mkTask({ id: "t-3", taskKey: "dup" }), // unique (session_id, task_key) violation
        ],
        T0 + 1,
      ),
    ).toThrow(/UNIQUE constraint failed/);
    // The batch peer inserted before the violation must be gone too.
    expect(getDevTask(db, "t-2")).toBeNull();
    expect(listDevTasks(db, "s1")).toHaveLength(1);
  });

  it("falls back to [] for malformed JSON array columns", () => {
    insertDevTasks(db, "s1", [mkTask({ id: "t-1", taskKey: "a" })], T0);
    db.prepare(
      `UPDATE dev_session_tasks SET depends_on = 'not-json', reqs = '{"a":1}' WHERE id = 't-1'`,
    ).run();
    const row = getDevTask(db, "t-1");
    expect(row?.dependsOn).toEqual([]);
    expect(row?.reqs).toEqual([]);
  });

  it("claims a queued task (CAS) and refuses a second claim", () => {
    insertDevTasks(db, "s1", [mkTask({ id: "t-1", taskKey: "a" })], T0);
    const claimed = claimDevTask(db, {
      id: "t-1",
      branch: "aitne-dev/s1/a",
      worktreePath: "/tmp/wt/a",
      baseRef: "deadbeef",
      at: T0 + 1,
    });
    expect(claimed?.state).toBe("running");
    expect(claimed?.branch).toBe("aitne-dev/s1/a");
    expect(claimed?.worktreePath).toBe("/tmp/wt/a");
    expect(claimed?.baseRef).toBe("deadbeef");
    expect(claimed?.startedAt).toBe(T0 + 1);
    // Wrong-state (already running) refused; missing id refused.
    expect(
      claimDevTask(db, {
        id: "t-1",
        branch: "b",
        worktreePath: "w",
        baseRef: "r",
        at: T0 + 2,
      }),
    ).toBeNull();
    expect(
      claimDevTask(db, {
        id: "nope",
        branch: "b",
        worktreePath: "w",
        baseRef: "r",
        at: T0 + 2,
      }),
    ).toBeNull();
  });

  it("markDevTaskState: CAS from-set, ended_at/merged_at stamping, loopState set/clear", () => {
    insertDevTasks(db, "s1", [mkTask({ id: "t-1", taskKey: "a" })], T0);
    claimDevTask(db, {
      id: "t-1",
      branch: "b",
      worktreePath: "w",
      baseRef: "r",
      at: T0 + 1,
    });

    // CAS miss: 'queued' is not the current state.
    expect(
      markDevTaskState(db, {
        id: "t-1",
        from: ["queued"],
        to: "supervise_pending",
        at: T0 + 2,
      }),
    ).toBeNull();
    // Empty from-set never matches.
    expect(
      markDevTaskState(db, { id: "t-1", from: [], to: "failed", at: T0 + 2 }),
    ).toBeNull();

    // running -> supervise_pending, setting the loop verdict.
    const parked = markDevTaskState(db, {
      id: "t-1",
      from: ["running", "awaiting_user"],
      to: "supervise_pending",
      loopState: "SUCCESS",
      at: T0 + 3,
    });
    expect(parked?.state).toBe("supervise_pending");
    expect(parked?.loopState).toBe("SUCCESS");
    expect(parked?.endedAt).toBeNull();
    expect(parked?.mergedAt).toBeNull();

    // loopState omitted = left as-is.
    const kept = markDevTaskState(db, {
      id: "t-1",
      from: ["supervise_pending"],
      to: "merge_pending",
      at: T0 + 4,
    });
    expect(kept?.loopState).toBe("SUCCESS");

    // to='merged' stamps ended_at AND merged_at.
    const merged = markDevTaskState(db, {
      id: "t-1",
      from: ["merge_pending"],
      to: "merged",
      loopState: null, // explicit null clears
      at: T0 + 5,
    });
    expect(merged?.state).toBe("merged");
    expect(merged?.loopState).toBeNull();
    expect(merged?.endedAt).toBe(T0 + 5);
    expect(merged?.mergedAt).toBe(T0 + 5);

    // A second task: terminal non-merged stamps ended_at only + failReason.
    insertDevTasks(db, "s1", [mkTask({ id: "t-2", taskKey: "b" })], T0);
    const failed = markDevTaskState(db, {
      id: "t-2",
      from: ["queued"],
      to: "dep_failed",
      failReason: "upstream a failed",
      at: T0 + 6,
    });
    expect(failed?.state).toBe("dep_failed");
    expect(failed?.failReason).toBe("upstream a failed");
    expect(failed?.endedAt).toBe(T0 + 6);
    expect(failed?.mergedAt).toBeNull();
  });

  it("persists the per-task run-checkpoint", () => {
    insertDevTasks(db, "s1", [mkTask({ id: "t-1", taskKey: "a" })], T0);
    writeDevTaskCheckpoint(
      db,
      {
        id: "t-1",
        iteration: 4,
        agentFailures: 1,
        gateReviseCount: 2,
        iterReviseCount: 3,
        resumes: 1,
      },
      T0 + 1,
    );
    const row = getDevTask(db, "t-1");
    expect(row?.iteration).toBe(4);
    expect(row?.agentFailures).toBe(1);
    expect(row?.gateReviseCount).toBe(2);
    expect(row?.iterReviseCount).toBe(3);
    expect(row?.resumes).toBe(1);
    expect(row?.state).toBe("queued"); // state untouched
    expect(row?.updatedAt).toBe(T0 + 1);
  });

  it("accumulates cost and ignores zero/negative/non-finite deltas", () => {
    insertDevTasks(db, "s1", [mkTask({ id: "t-1", taskKey: "a" })], T0);
    addDevTaskCost(db, "t-1", 0.5, T0 + 1);
    addDevTaskCost(db, "t-1", 0.25, T0 + 2);
    addDevTaskCost(db, "t-1", 0, T0 + 3); // ignored
    addDevTaskCost(db, "t-1", -1, T0 + 4); // ignored
    addDevTaskCost(db, "t-1", Number.NaN, T0 + 5); // ignored
    addDevTaskCost(db, "t-1", Number.POSITIVE_INFINITY, T0 + 6); // ignored
    const row = getDevTask(db, "t-1");
    expect(row?.costUsd).toBeCloseTo(0.75, 6);
    expect(row?.updatedAt).toBe(T0 + 2); // the ignored calls did not touch the row
  });

  it("bumps supervise_count / merge_retries and returns the new value", () => {
    insertDevTasks(db, "s1", [mkTask({ id: "t-1", taskKey: "a" })], T0);
    expect(bumpDevTaskSuperviseCount(db, "t-1", T0 + 1)).toBe(1);
    expect(bumpDevTaskSuperviseCount(db, "t-1", T0 + 2)).toBe(2);
    expect(bumpDevTaskMergeRetries(db, "t-1", T0 + 3)).toBe(1);
    expect(getDevTask(db, "t-1")?.superviseCount).toBe(2);
    expect(getDevTask(db, "t-1")?.mergeRetries).toBe(1);
    // Missing row: nothing to bump, returns 0.
    expect(bumpDevTaskSuperviseCount(db, "nope", T0 + 4)).toBe(0);
    expect(bumpDevTaskMergeRetries(db, "nope", T0 + 4)).toBe(0);
  });

  it("sets plan_review / seed_branch / worktree_path (and clears them with null)", () => {
    insertDevTasks(db, "s1", [mkTask({ id: "t-1", taskKey: "a" })], T0);
    setDevTaskPlanReview(db, "t-1", "pending", T0 + 1);
    setDevTaskSeedBranch(db, "t-1", "aitne-dev/s1/a-seed", T0 + 2);
    setDevTaskWorktree(db, "t-1", "/tmp/wt/a", T0 + 3);
    let row = getDevTask(db, "t-1");
    expect(row?.planReview).toBe("pending");
    expect(row?.seedBranch).toBe("aitne-dev/s1/a-seed");
    expect(row?.worktreePath).toBe("/tmp/wt/a");

    setDevTaskPlanReview(db, "t-1", null, T0 + 4);
    setDevTaskSeedBranch(db, "t-1", null, T0 + 5);
    setDevTaskWorktree(db, "t-1", null, T0 + 6);
    row = getDevTask(db, "t-1");
    expect(row?.planReview).toBeNull();
    expect(row?.seedBranch).toBeNull();
    expect(row?.worktreePath).toBeNull();
    expect(row?.updatedAt).toBe(T0 + 6);
  });

  it("rewires queued dependents from a decomposed key to its sinks (dedup, order, count)", () => {
    insertDevTasks(
      db,
      "s1",
      [
        mkTask({ id: "t-old", taskKey: "old" }),
        mkTask({ id: "t-s1", taskKey: "sink-1" }),
        mkTask({ id: "t-s2", taskKey: "sink-2" }),
        // queued consumer: old replaced, other deps keep their position.
        mkTask({ id: "t-q1", taskKey: "q1", dependsOn: ["old", "x"] }),
        // queued consumer already depending on sink-1: no duplicate.
        mkTask({ id: "t-q2", taskKey: "q2", dependsOn: ["old", "sink-1"] }),
        // queued non-consumer: untouched.
        mkTask({ id: "t-q3", taskKey: "q3", dependsOn: ["x"] }),
        // running consumer: untouched (only queued rows are rewired).
        mkTask({ id: "t-r1", taskKey: "r1", dependsOn: ["old"] }),
      ],
      T0,
    );
    claimDevTask(db, {
      id: "t-r1",
      branch: "b",
      worktreePath: "w",
      baseRef: "r",
      at: T0 + 1,
    });

    const rewired = rewireDevTaskDeps(
      db,
      "s1",
      "old",
      ["sink-1", "sink-2"],
      T0 + 2,
    );
    expect(rewired).toBe(2);
    expect(getDevTask(db, "t-q1")?.dependsOn).toEqual(["x", "sink-1", "sink-2"]);
    expect(getDevTask(db, "t-q2")?.dependsOn).toEqual(["sink-1", "sink-2"]);
    expect(getDevTask(db, "t-q3")?.dependsOn).toEqual(["x"]);
    expect(getDevTask(db, "t-q3")?.updatedAt).toBe(T0); // untouched
    expect(getDevTask(db, "t-r1")?.dependsOn).toEqual(["old"]);
    // No consumers of an unknown key.
    expect(rewireDevTaskDeps(db, "s1", "unknown", ["sink-1"], T0 + 3)).toBe(0);
  });

  it("resetDevTaskForRedo: merge_pending -> queued, zeroes the checkpoint, keeps the keepers", () => {
    insertDevTasks(db, "s1", [mkTask({ id: "t-1", taskKey: "a" })], T0);
    claimDevTask(db, {
      id: "t-1",
      branch: "aitne-dev/s1/a",
      worktreePath: "/tmp/wt/a",
      baseRef: "deadbeef",
      at: T0 + 1,
    });
    // Refuses while not merge_pending.
    expect(resetDevTaskForRedo(db, { id: "t-1", at: T0 + 2 })).toBeNull();

    db.prepare(
      `UPDATE dev_session_tasks
          SET iteration = 5, agent_failures = 2, gate_revise_count = 1,
              iter_revise_count = 3, resumes = 1
        WHERE id = 't-1'`,
    ).run();
    addDevTaskCost(db, "t-1", 1.25, T0 + 3);
    setDevTaskSeedBranch(db, "t-1", "seed-branch", T0 + 4);
    setDevTaskPlanReview(db, "t-1", "done", T0 + 5);
    markDevTaskState(db, {
      id: "t-1",
      from: ["running"],
      to: "merge_pending",
      loopState: "SUCCESS",
      at: T0 + 6,
    });

    const reset = resetDevTaskForRedo(db, { id: "t-1", at: T0 + 7 });
    expect(reset?.state).toBe("queued");
    expect(reset?.mergeRetries).toBe(1);
    // Checkpoint zeroed.
    expect(reset?.iteration).toBe(0);
    expect(reset?.agentFailures).toBe(0);
    expect(reset?.gateReviseCount).toBe(0);
    expect(reset?.iterReviseCount).toBe(0);
    expect(reset?.resumes).toBe(0);
    // Worker anchors + verdict cleared.
    expect(reset?.branch).toBeNull();
    expect(reset?.worktreePath).toBeNull();
    expect(reset?.baseRef).toBeNull();
    expect(reset?.loopState).toBeNull();
    // Kept: first claim time, spend, seed branch, plan review.
    expect(reset?.startedAt).toBe(T0 + 1);
    expect(reset?.costUsd).toBeCloseTo(1.25, 6);
    expect(reset?.seedBranch).toBe("seed-branch");
    expect(reset?.planReview).toBe("done");

    // Idempotent: a second reset CAS-misses (state is queued now).
    expect(resetDevTaskForRedo(db, { id: "t-1", at: T0 + 8 })).toBeNull();
    // A redo re-claim keeps the FIRST started_at.
    const reclaimed = claimDevTask(db, {
      id: "t-1",
      branch: "b2",
      worktreePath: "w2",
      baseRef: "r2",
      at: T0 + 9,
    });
    expect(reclaimed?.startedAt).toBe(T0 + 1);
  });

  it("cascades task rows on session delete", () => {
    insertDevTasks(db, "s1", [mkTask({ id: "t-1", taskKey: "a" })], T0);
    db.prepare("DELETE FROM dev_sessions WHERE id = 's1'").run();
    expect(listDevTasks(db, "s1")).toHaveLength(0);
  });
});

// Peer coverage for migration 0027-dev-flow (the migration-file test suite
// pins the generic runner; the dev-mode migrations are exercised beside
// their stores, same as 0026 in dev-sessions-store.test.ts). Contract per
// CLAUDE.md non-negotiable #4: fresh DB (applySchema final shape) → all
// guards no-op + id recorded; legacy 0026-shape DB → ALTERs + iterations
// rebuild run with data preserved and task_id NULL; re-run → no-op.
describe("migration 0027-dev-flow", () => {
  const m26 = MIGRATIONS.find((m) => m.id === "0026-dev-mode");
  const m27 = MIGRATIONS.find((m) => m.id === "0027-dev-flow");
  // 0028 adds the escalation `queued` column that the store SELECTs; the
  // legacy-upgrade test migrates the DB to the current shape before reading
  // escalations back through getDevEscalation.
  const m28 = MIGRATIONS.find((m) => m.id === "0028-dev-escalation-queue");
  const m29 = MIGRATIONS.find((m) => m.id === "0029-dev-loop-hardening");

  it("is registered in the production MIGRATIONS list, after 0026", () => {
    expect(m26).toBeDefined();
    expect(m27).toBeDefined();
    expect(MIGRATIONS.indexOf(m27!)).toBeGreaterThan(MIGRATIONS.indexOf(m26!));
  });

  it("no-ops on a fresh DB where applySchema already produced the final shape", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    seedRepo(db);
    seedSession(db);
    // Pre-migration data in the FINAL shape — a task-scoped iteration. If
    // the rebuild wrongly ran, the copy would null task_id out.
    insertDevTasks(db, "s1", [mkTask({ id: "t-1", taskKey: "a" })], T0);
    recordDevIteration(db, {
      id: "i1",
      sessionId: "s1",
      taskId: "t-1",
      iteration: 1,
      phase: "supervise",
      verdict: "ok",
      createdAt: T0 + 1,
    });

    const result = runMigrations(db, [m26!, m27!]);
    expect(result.applied).toEqual(["0026-dev-mode", "0027-dev-flow"]);

    const legs = listDevIterations(db, "s1");
    expect(legs).toHaveLength(1);
    expect(legs[0]?.taskId).toBe("t-1"); // guard skipped the rebuild
    expect(legs[0]?.phase).toBe("supervise");
    expect(getDevSession(db, "s1")?.replanCount).toBe(0);
    expect(getDevTask(db, "t-1")?.taskKey).toBe("a");
    db.close();
  });

  it("upgrades a legacy 0026-shape DB: ALTERs + rebuild, data preserved, task_id NULL", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    // Bare legacy install: minimal stubs for 0026's FK targets
    // (repositories + agent_schedule), then ONLY 0026 to materialise the
    // pre-flow dev-mode shape.
    db.exec(`
      CREATE TABLE repositories (id TEXT PRIMARY KEY);
      CREATE TABLE agent_schedule (id INTEGER PRIMARY KEY AUTOINCREMENT);
    `);
    db.prepare(`INSERT INTO repositories (id) VALUES ('local:test')`).run();
    runMigrations(db, [m26!]);

    // Legacy-shape rows via raw SQL (the store helpers now name the new
    // columns and would fail here — that is the point of the migration).
    db.prepare(
      `INSERT INTO dev_sessions
         (id, repository_id, slug, state, created_at, entered_at, updated_at)
       VALUES ('s1', 'local:test', 'test', 'running', ?, ?, ?)`,
    ).run(T0, T0, T0);
    // The legacy narrow phase CHECK rejects a fleet phase — proves we are
    // starting from the pre-migration shape.
    expect(() =>
      db
        .prepare(
          `INSERT INTO dev_session_iterations (id, session_id, iteration, phase, created_at)
           VALUES ('iX', 's1', 1, 'merge', ?)`,
        )
        .run(T0),
    ).toThrow(/CHECK constraint failed/);
    db.prepare(
      `INSERT INTO dev_session_iterations
         (id, session_id, iteration, phase, verdict, reason, cost_usd, commit_sha, created_at)
       VALUES ('i1', 's1', 1, 'implement', 'ok', NULL, 0.1, NULL, ?)`,
    ).run(T0 + 1);
    db.prepare(
      `INSERT INTO dev_session_iterations
         (id, session_id, iteration, phase, verdict, reason, cost_usd, commit_sha, created_at)
       VALUES ('i2', 's1', 1, 'evaluate', 'CONTINUE', 'more to do', NULL, 'abc123', ?)`,
    ).run(T0 + 2);
    db.prepare(
      `INSERT INTO dev_session_escalations
         (id, session_id, kind, question, context_summary, asked_at,
          deadline_at, delivered_at, answer, answered_at, resolved)
       VALUES ('e1', 's1', 'spec_decision', 'which db?', NULL, ?, NULL, NULL, NULL, NULL, 0)`,
    ).run(T0 + 3);

    // The modern store reads the 0029 shape (superseded etc.), so the legacy
    // chain runs through 0029 — exactly what a real upgrade does.
    const result = runMigrations(db, [m26!, m27!, m28!, m29!]);
    expect(result.applied).toEqual([
      "0027-dev-flow",
      "0028-dev-escalation-queue",
      "0029-dev-loop-hardening",
    ]);

    // New table + indexes.
    expect(tableExists(db, "dev_session_tasks")).toBe(true);
    expect(indexExists(db, "idx_dev_tasks_session_key")).toBe(true);
    expect(indexExists(db, "idx_dev_tasks_session_state")).toBe(true);
    // New columns.
    expect(columnExists(db, "dev_sessions", "replan_count")).toBe(true);
    expect(columnExists(db, "dev_sessions", "plan_review_count")).toBe(true);
    expect(columnExists(db, "dev_sessions", "fixup_count")).toBe(true);
    expect(columnExists(db, "dev_session_escalations", "task_id")).toBe(true);
    expect(columnExists(db, "dev_session_iterations", "task_id")).toBe(true);
    // Rebuild recreated both iteration indexes.
    expect(indexExists(db, "idx_dev_iterations_session")).toBe(true);
    expect(indexExists(db, "idx_dev_iterations_task")).toBe(true);

    // Data preserved; migrated legs are session-level (task_id NULL).
    const legs = listDevIterations(db, "s1");
    expect(legs.map((l) => l.id)).toEqual(["i1", "i2"]);
    expect(legs.every((l) => l.taskId === null)).toBe(true);
    expect(legs[0]?.costUsd).toBeCloseTo(0.1, 6);
    expect(legs[1]?.verdict).toBe("CONTINUE");
    expect(legs[1]?.commitSha).toBe("abc123");
    // Counters backfilled to 0; escalation kept, session-scoped.
    expect(getDevSession(db, "s1")?.replanCount).toBe(0);
    expect(getDevSession(db, "s1")?.fixupCount).toBe(0);
    const escalation = getDevEscalation(db, "e1");
    expect(escalation?.question).toBe("which db?");
    expect(escalation?.taskId).toBeNull();

    // The widened CHECK + FK now accept a task-scoped fleet leg.
    insertDevTasks(db, "s1", [mkTask({ id: "t-1", taskKey: "a" })], T0 + 4);
    recordDevIteration(db, {
      id: "i3",
      sessionId: "s1",
      taskId: "t-1",
      iteration: 2,
      phase: "merge",
      createdAt: T0 + 5,
    });
    expect(listDevIterations(db, "s1")[2]?.taskId).toBe("t-1");

    // Re-run is a recorded no-op.
    const second = runMigrations(db, [m26!, m27!, m28!, m29!]);
    expect(second.applied).toEqual([]);
    db.close();
  });
});

describe("resume/manual support (0029)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    seedRepo(db);
    seedSession(db);
  });

  afterEach(() => {
    db.close();
  });

  it("round-trips a manual task with its own approved hash", () => {
    insertDevTasks(db, "s1", [mkTask({ id: "m1", taskKey: "manual-1", origin: "manual" })], T0);
    expect(getDevTask(db, "m1")?.origin).toBe("manual");
    expect(getDevTask(db, "m1")?.approvedHash).toBeNull();
    setDevTaskApprovedHash(db, "m1", "hash-m1", T0 + 1);
    expect(getDevTask(db, "m1")?.approvedHash).toBe("hash-m1");
    setDevTaskApprovedHash(db, "m1", null, T0 + 2);
    expect(getDevTask(db, "m1")?.approvedHash).toBeNull();
  });

  it("requeueDevTaskForResume: fresh window, kept forensics, CAS from failed/dep_failed only", () => {
    insertDevTasks(db, "s1", [mkTask({ id: "t1", taskKey: "a" })], T0);
    claimDevTask(db, {
      id: "t1", branch: "aitne-dev/s1-a", worktreePath: "/tmp/wt-a",
      baseRef: "sha0", at: T0 + 1,
    });
    writeDevTaskCheckpoint(db, {
      id: "t1", iteration: 4, agentFailures: 1, gateReviseCount: 2,
      iterReviseCount: 1, resumes: 0,
    }, T0 + 2);
    addDevTaskCost(db, "t1", 1.25, T0 + 3);
    bumpDevTaskMergeRetries(db, "t1", T0 + 3);
    setDevTaskSeedBranch(db, "t1", "seed-a", T0 + 3);
    // Not failed yet — the CAS refuses.
    expect(requeueDevTaskForResume(db, { id: "t1", at: T0 + 4 })).toBeNull();
    markDevTaskState(db, {
      id: "t1", from: ["running"], to: "failed",
      loopState: "BLOCKED", failReason: "boom", at: T0 + 5,
    });

    const requeued = requeueDevTaskForResume(db, { id: "t1", at: T0 + 6 })!;
    expect(requeued.state).toBe("queued");
    // Fresh stop-heuristic window.
    expect(requeued.iteration).toBe(0);
    expect(requeued.agentFailures).toBe(0);
    expect(requeued.gateReviseCount).toBe(0);
    expect(requeued.iterReviseCount).toBe(0);
    expect(requeued.loopState).toBeNull();
    expect(requeued.failReason).toBeNull();
    // Worker anchors cleared for a fresh bootstrap…
    expect(requeued.branch).toBeNull();
    expect(requeued.worktreePath).toBeNull();
    expect(requeued.baseRef).toBeNull();
    // …but the forensics/carryover state is kept.
    expect(requeued.resumes).toBe(1);
    expect(requeued.mergeRetries).toBe(1);
    expect(requeued.costUsd).toBe(1.25);
    expect(requeued.seedBranch).toBe("seed-a");
    expect(requeued.startedAt).toBe(T0 + 1);
  });

  it("requeueDevTaskForResume accepts dep_failed", () => {
    insertDevTasks(db, "s1", [mkTask({ id: "t2", taskKey: "b" })], T0);
    markDevTaskState(db, { id: "t2", from: ["queued"], to: "dep_failed", at: T0 + 1 });
    expect(requeueDevTaskForResume(db, { id: "t2", at: T0 + 2 })?.state).toBe("queued");
  });
});
