import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import { MIGRATIONS, runMigrations } from "./migrations.js";
import {
  addDevSessionCost,
  approveDevSession,
  bumpDevSessionFleetCounter,
  countDevRequirements,
  countDevRequirementsIn,
  createDevSession,
  getActiveDevSession,
  getDevSession,
  listDevIterations,
  listDevRequirements,
  listDevSessions,
  listNonTerminalDevSessions,
  markDevAwaitingApproval,
  markDevAwaitingUser,
  markDevRunningFromParked,
  markDevTerminal,
  recordDevIteration,
  seedDevRequirements,
  setDevTimeoutScheduleId,
  updateDevRequirement,
  updateDevSessionConfig,
  writeDevCheckpoint,
} from "./dev-sessions-store.js";
import {
  createDevEscalation,
  getOpenDevEscalationForSession,
  listDevEscalationsForSession,
  listUndeliveredDevEscalations,
  markDevEscalationDelivered,
  resolveDevEscalation,
} from "./dev-session-escalations-store.js";
import { insertDevTasks } from "./dev-session-tasks-store.js";

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

describe("dev-sessions-store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    seedRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates a session in the interview state and reads it back", () => {
    const row = createDevSession(db, {
      id: "s1",
      repositoryId: "local:test",
      slug: "test",
      originatingPlatform: "telegram",
      originatingChannel: "telegram:123",
      createdAt: T0,
    });
    expect(row.state).toBe("interview");
    expect(row.iteration).toBe(0);
    expect(row.costUsd).toBeNull();
    // dev-flow fleet-mutation counters start at 0.
    expect(row.replanCount).toBe(0);
    expect(row.planReviewCount).toBe(0);
    expect(row.fixupCount).toBe(0);
    expect(getDevSession(db, "s1")?.slug).toBe("test");
    expect(getActiveDevSession(db)?.id).toBe("s1");
    expect(listNonTerminalDevSessions(db)).toHaveLength(1);
  });

  it("persists interview config as parsed JSON", () => {
    seedSession(db);
    const updated = updateDevSessionConfig(
      db,
      "s1",
      {
        config: { verifyCommands: ["npm test"], maxIterations: 8 },
        maxBudgetUsd: 5,
      },
      T0 + 1,
    );
    expect(updated?.config).toEqual({
      verifyCommands: ["npm test"],
      maxIterations: 8,
    });
    expect(updated?.maxBudgetUsd).toBe(5);
  });

  it("walks the happy-path state machine and refuses out-of-order writes", () => {
    seedSession(db);
    // Out-of-order: cannot park a session still in interview.
    expect(markDevAwaitingUser(db, "s1", T0 + 1)).toBeNull();
    // interview -> awaiting_approval
    expect(markDevAwaitingApproval(db, "s1", T0 + 1)?.state).toBe(
      "awaiting_approval",
    );
    // awaiting_approval -> running (approve stamps the anchor + baseline)
    const approved = approveDevSession(db, {
      id: "s1",
      approvedHash: "hash-abc",
      branch: "aitne-dev/s1",
      baseRef: "deadbeef",
      maxIterations: 10,
      maxBudgetUsd: 4,
      approvedAt: T0 + 2,
    });
    expect(approved?.state).toBe("running");
    expect(approved?.approvedHash).toBe("hash-abc");
    expect(approved?.branch).toBe("aitne-dev/s1");
    expect(approved?.maxIterations).toBe(10);
    // Idempotent: a second approve CAS-misses.
    expect(
      approveDevSession(db, {
        id: "s1",
        approvedHash: "hash-xyz",
        branch: "b",
        baseRef: "c",
        maxIterations: 99,
        maxBudgetUsd: null,
        approvedAt: T0 + 3,
      }),
    ).toBeNull();
    // running -> awaiting_user -> running
    expect(markDevAwaitingUser(db, "s1", T0 + 4)?.state).toBe("awaiting_user");
    expect(markDevRunningFromParked(db, "s1", T0 + 5)?.state).toBe("running");
    // running -> done (terminal), records the loop verdict
    const done = markDevTerminal(db, {
      id: "s1",
      state: "done",
      loopState: "SUCCESS",
      exitedAt: T0 + 6,
    });
    expect(done?.state).toBe("done");
    expect(done?.loopState).toBe("SUCCESS");
    expect(getActiveDevSession(db)).toBeNull();
    // Idempotent terminal.
    expect(
      markDevTerminal(db, { id: "s1", state: "failed", exitedAt: T0 + 7 }),
    ).toBeNull();
  });

  it("persists the run-checkpoint and accumulates cost", () => {
    seedSession(db);
    writeDevCheckpoint(
      db,
      {
        id: "s1",
        iteration: 3,
        agentFailures: 1,
        gateReviseCount: 0,
        iterReviseCount: 2,
        resumes: 1,
      },
      T0 + 10,
    );
    const row = getDevSession(db, "s1");
    expect(row?.iteration).toBe(3);
    expect(row?.iterReviseCount).toBe(2);
    expect(row?.resumes).toBe(1);

    addDevSessionCost(db, "s1", 0.5);
    addDevSessionCost(db, "s1", 0.25);
    addDevSessionCost(db, "s1", 0); // ignored
    addDevSessionCost(db, "s1", -1); // ignored
    expect(getDevSession(db, "s1")?.costUsd).toBeCloseTo(0.75, 6);
  });

  it("bumps the fleet-mutation counters and returns the new value", () => {
    seedSession(db);
    expect(bumpDevSessionFleetCounter(db, "s1", "replan_count", 1, T0 + 1)).toBe(1);
    expect(bumpDevSessionFleetCounter(db, "s1", "replan_count", 2, T0 + 2)).toBe(3);
    expect(
      bumpDevSessionFleetCounter(db, "s1", "plan_review_count", 1, T0 + 3),
    ).toBe(1);
    expect(bumpDevSessionFleetCounter(db, "s1", "fixup_count", 1, T0 + 4)).toBe(1);
    const row = getDevSession(db, "s1");
    expect(row?.replanCount).toBe(3);
    expect(row?.planReviewCount).toBe(1);
    expect(row?.fixupCount).toBe(1);
    // Missing session: nothing to bump, returns 0.
    expect(bumpDevSessionFleetCounter(db, "nope", "fixup_count", 1, T0 + 5)).toBe(0);
    // The literal allowlist guards the interpolated column name.
    expect(() =>
      bumpDevSessionFleetCounter(
        db,
        "s1",
        "resumes; DROP TABLE dev_sessions" as never,
        1,
        T0 + 6,
      ),
    ).toThrow(/unknown counter/);
  });

  it("arms and clears the timeout schedule fk", () => {
    seedSession(db);
    const scheduleId = Number(
      db
        .prepare(
          "INSERT INTO agent_schedule (scheduled_for, task_type) VALUES (?, ?)",
        )
        .run("2026-01-01 00:00:00", "dev_session_timeout").lastInsertRowid,
    );
    setDevTimeoutScheduleId(db, "s1", scheduleId);
    expect(getDevSession(db, "s1")?.timeoutScheduleId).toBe(scheduleId);
    setDevTimeoutScheduleId(db, "s1", null);
    expect(getDevSession(db, "s1")?.timeoutScheduleId).toBeNull();
  });

  it("seeds, lists, updates and counts the REQ ledger", () => {
    seedSession(db);
    seedDevRequirements(
      db,
      "s1",
      [
        { id: "r1", reqId: "REQ-001", title: "auth" },
        { id: "r2", reqId: "REQ-002", title: "logout" },
      ],
      T0 + 1,
    );
    // Re-seed is idempotent (unique index) and preserves progress.
    updateDevRequirement(db, {
      sessionId: "s1",
      reqId: "REQ-001",
      status: "met",
      evidence: "tests green",
      iter: 2,
      updatedAt: T0 + 2,
    });
    seedDevRequirements(
      db,
      "s1",
      [{ id: "rX", reqId: "REQ-001", title: "auth-changed" }],
      T0 + 3,
    );
    const reqs = listDevRequirements(db, "s1");
    expect(reqs.map((r) => r.reqId)).toEqual(["REQ-001", "REQ-002"]);
    expect(reqs.find((r) => r.reqId === "REQ-001")?.status).toBe("met");
    expect(reqs.find((r) => r.reqId === "REQ-001")?.title).toBe("auth");
    expect(countDevRequirements(db, "s1")).toEqual({ total: 2, met: 1 });
    // Scoped counting (dev-flow per-task gate): only the given req_ids.
    expect(countDevRequirementsIn(db, "s1", ["REQ-001"])).toEqual({
      total: 1,
      met: 1,
    });
    expect(
      countDevRequirementsIn(db, "s1", ["REQ-001", "REQ-002", "REQ-999"]),
    ).toEqual({ total: 2, met: 1 });
    expect(countDevRequirementsIn(db, "s1", [])).toEqual({ total: 0, met: 0 });
    // Unknown REQ update is a no-op.
    expect(
      updateDevRequirement(db, {
        sessionId: "s1",
        reqId: "REQ-999",
        status: "met",
        updatedAt: T0 + 4,
      }),
    ).toBe(false);
  });

  it("records loop legs in order", () => {
    seedSession(db);
    recordDevIteration(db, {
      id: "i1",
      sessionId: "s1",
      iteration: 1,
      phase: "implement",
      verdict: "ok",
      createdAt: T0 + 1,
    });
    recordDevIteration(db, {
      id: "i2",
      sessionId: "s1",
      iteration: 1,
      phase: "evaluate",
      verdict: "CONTINUE",
      commitSha: "abc123",
      createdAt: T0 + 2,
    });
    const legs = listDevIterations(db, "s1");
    expect(legs.map((l) => l.phase)).toEqual(["implement", "evaluate"]);
    expect(legs[1]?.commitSha).toBe("abc123");
    // taskId omitted = session-level leg.
    expect(legs.every((l) => l.taskId === null)).toBe(true);
  });

  it("records task-scoped legs with the dev-flow fleet phases", () => {
    seedSession(db);
    insertDevTasks(
      db,
      "s1",
      [
        {
          id: "t1",
          taskKey: "auth",
          summary: "auth",
          dependsOn: [],
          scope: "",
          reqs: ["REQ-001"],
          body: "do auth",
          origin: "plan",
        },
      ],
      T0,
    );
    // Every widened phase passes the CHECK; task-scoped ones carry taskId.
    const phases = [
      "decompose",
      "decompose_review",
      "supervise",
      "plan_review",
      "merge",
    ] as const;
    phases.forEach((phase, i) => {
      recordDevIteration(db, {
        id: `i-${phase}`,
        sessionId: "s1",
        taskId: phase === "plan_review" ? null : "t1",
        iteration: 1,
        phase,
        createdAt: T0 + 1 + i,
      });
    });
    const legs = listDevIterations(db, "s1");
    expect(legs.map((l) => l.phase)).toEqual([...phases]);
    expect(legs.find((l) => l.phase === "plan_review")?.taskId).toBeNull();
    expect(legs.find((l) => l.phase === "merge")?.taskId).toBe("t1");
    // The FK refuses a leg pointing at a missing task.
    expect(() =>
      recordDevIteration(db, {
        id: "i-bad",
        sessionId: "s1",
        taskId: "no-such-task",
        iteration: 1,
        phase: "supervise",
        createdAt: T0 + 99,
      }),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("filters listDevSessions by repository and state", () => {
    seedRepo(db, "local:other");
    seedSession(db, "s1");
    createDevSession(db, {
      id: "s2",
      repositoryId: "local:other",
      slug: "other",
      originatingPlatform: null,
      originatingChannel: null,
      createdAt: T0 + 1,
    });
    markDevTerminal(db, { id: "s2", state: "exited", exitedAt: T0 + 2 });
    expect(listDevSessions(db, { repositoryId: "local:test" })).toHaveLength(1);
    expect(listDevSessions(db, { states: ["exited"] }).map((s) => s.id)).toEqual([
      "s2",
    ]);
  });

  it("cascades child rows on repository delete", () => {
    seedSession(db);
    seedDevRequirements(db, "s1", [{ id: "r1", reqId: "REQ-001", title: "x" }], T0);
    recordDevIteration(db, {
      id: "i1",
      sessionId: "s1",
      iteration: 1,
      phase: "plan",
      createdAt: T0,
    });
    createDevEscalation(db, {
      id: "e1",
      sessionId: "s1",
      kind: "spec_decision",
      question: "?",
      contextSummary: null,
      askedAt: T0,
    });
    db.prepare("DELETE FROM repositories WHERE id = ?").run("local:test");
    expect(getDevSession(db, "s1")).toBeNull();
    expect(listDevRequirements(db, "s1")).toHaveLength(0);
    expect(listDevIterations(db, "s1")).toHaveLength(0);
    expect(listDevEscalationsForSession(db, "s1")).toHaveLength(0);
  });
});

describe("dev-session-escalations-store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    seedRepo(db);
    seedSession(db);
    markDevAwaitingApproval(db, "s1", T0);
    approveDevSession(db, {
      id: "s1",
      approvedHash: "h",
      branch: "aitne-dev/s1",
      baseRef: "base",
      maxIterations: 10,
      maxBudgetUsd: null,
      approvedAt: T0,
    });
    markDevAwaitingUser(db, "s1", T0);
  });

  afterEach(() => {
    db.close();
  });

  it("creates, opens, resolves and refuses double-resolve", () => {
    createDevEscalation(db, {
      id: "e1",
      sessionId: "s1",
      kind: "risk_approval",
      question: "Touch .env — approve?",
      contextSummary: "denied path",
      askedAt: T0 + 1,
    });
    expect(getOpenDevEscalationForSession(db, "s1")?.id).toBe("e1");

    const first = resolveDevEscalation(db, {
      id: "e1",
      answer: "yes go ahead",
      answeredAt: T0 + 2,
    });
    expect(first.ok).toBe(true);
    expect(first.row?.answer).toBe("yes go ahead");
    expect(getOpenDevEscalationForSession(db, "s1")).toBeNull();

    const second = resolveDevEscalation(db, {
      id: "e1",
      answer: "again",
      answeredAt: T0 + 3,
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("already_resolved");
  });

  it("resolves regardless of any soft deadline (dev escalations never expire)", () => {
    createDevEscalation(db, {
      id: "e1",
      sessionId: "s1",
      kind: "spec_decision",
      question: "which db?",
      contextSummary: null,
      askedAt: T0,
      deadlineAt: T0 + 1, // long past
    });
    const res = resolveDevEscalation(db, {
      id: "e1",
      answer: "postgres",
      answeredAt: T0 + 1_000_000,
    });
    expect(res.ok).toBe(true);
  });

  it("surfaces undelivered escalations for a parked session, then stops after delivery", () => {
    createDevEscalation(db, {
      id: "e1",
      sessionId: "s1",
      kind: "architecture_decision",
      question: "add redis?",
      contextSummary: null,
      askedAt: T0 + 1,
    });
    const undelivered = listUndeliveredDevEscalations(db);
    expect(undelivered).toHaveLength(1);
    expect(undelivered[0]?.sessionOriginatingChannel).toBe("telegram:123");

    markDevEscalationDelivered(db, "e1", T0 + 2);
    expect(listUndeliveredDevEscalations(db)).toHaveLength(0);
  });

  it("missing escalation resolves to not_found", () => {
    expect(
      resolveDevEscalation(db, { id: "nope", answer: "x", answeredAt: T0 }).reason,
    ).toBe("not_found");
  });

  it("round-trips the dev-flow task scope (taskId) and defaults to session-scoped", () => {
    insertDevTasks(
      db,
      "s1",
      [
        {
          id: "t1",
          taskKey: "auth",
          summary: "auth",
          dependsOn: [],
          scope: "",
          reqs: [],
          body: "do auth",
          origin: "plan",
        },
      ],
      T0,
    );
    const scoped = createDevEscalation(db, {
      id: "e-task",
      sessionId: "s1",
      taskId: "t1",
      kind: "risk_approval",
      question: "task wants to touch .env",
      contextSummary: null,
      askedAt: T0 + 1,
    });
    expect(scoped.taskId).toBe("t1");
    const sessionScoped = createDevEscalation(db, {
      id: "e-session",
      sessionId: "s1",
      kind: "spec_decision",
      question: "session-level?",
      contextSummary: null,
      askedAt: T0 + 2,
    });
    expect(sessionScoped.taskId).toBeNull();
    // Every read surface carries it — list, open-pointer, recovery join.
    expect(
      listDevEscalationsForSession(db, "s1").map((e) => e.taskId),
    ).toEqual(["t1", null]);
    expect(getOpenDevEscalationForSession(db, "s1")?.taskId).toBeNull();
    const undelivered = listUndeliveredDevEscalations(db);
    expect(undelivered.find((e) => e.id === "e-task")?.taskId).toBe("t1");
    // ON DELETE SET NULL: dropping the task keeps the Q&A history.
    db.prepare("DELETE FROM dev_session_tasks WHERE id = 't1'").run();
    expect(listDevEscalationsForSession(db, "s1").map((e) => e.taskId)).toEqual([
      null,
      null,
    ]);
  });
});

describe("migration 0026-dev-mode", () => {
  it("creates the dev-mode tables on a bare db and is idempotent", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    // Bare db (no applySchema): run ONLY 0026 in isolation (other migrations
    // may require MigrationContext). The migration must create the tables.
    const only = MIGRATIONS.filter((m) => m.id === "0026-dev-mode");
    expect(only).toHaveLength(1);
    runMigrations(db, only);
    runMigrations(db, only); // second run is a no-op (recorded id short-circuits)
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dev_session%'",
      )
      .all()
      .map((r) => (r as { name: string }).name)
      .sort();
    expect(tables).toEqual([
      "dev_session_escalations",
      "dev_session_iterations",
      "dev_session_requirements",
      "dev_sessions",
    ]);
    db.close();
  });
});
