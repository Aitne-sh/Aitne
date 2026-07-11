import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import { MIGRATIONS, runMigrations, tableExists } from "./migrations.js";
import {
  addDevSessionCost,
  approveDevSession,
  bumpDevSessionFleetCounter,
  bumpDevSessionRunResumes,
  clearDevSessionRunResumes,
  countDevRequirements,
  countDevRequirementsIn,
  createDevSession,
  getActiveDevSession,
  getDevSession,
  getLatestDevSessionForChannel,
  getLatestRollbackableDevSession,
  latestEvaluateCommitFor,
  listDevIterations,
  listDevRequirements,
  listDevSessions,
  listNonTerminalDevSessions,
  markDevAwaitingApproval,
  markDevAwaitingUser,
  markDevRunningFromParked,
  markDevRunningFromTerminal,
  markDevSessionRolledBack,
  markDevTerminal,
  rebindDevSessionApproval,
  recordDevIteration,
  resetDevRequirementStatuses,
  resetDevSessionStopHeuristics,
  seedDevRequirements,
  setDevSessionBaselineDone,
  setDevTimeoutScheduleId,
  supersedeDevIterationsAfter,
  updateDevRequirement,
  updateDevSessionBaseRef,
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

  it("serializes concurrent escalations and promotes the next on resolve (P0-5)", () => {
    // Two escalations open at once (a fleet raising per-task questions). The
    // FIRST is active (queued = 0); the second is held (queued = 1). The open
    // pointer is the single active one — never the newest — so a bare DM reply
    // cannot mis-map to the wrong task.
    const a = createDevEscalation(db, {
      id: "e-a", sessionId: "s1", kind: "risk_approval",
      question: "A?", contextSummary: null, askedAt: T0 + 1,
    });
    const b = createDevEscalation(db, {
      id: "e-b", sessionId: "s1", kind: "spec_decision",
      question: "B?", contextSummary: null, askedAt: T0 + 2,
    });
    expect(a.queued).toBe(false);
    expect(b.queued).toBe(true);
    expect(getOpenDevEscalationForSession(db, "s1")?.id).toBe("e-a");

    // Resolving A promotes B to active and hands it back for delivery.
    const res = resolveDevEscalation(db, { id: "e-a", answer: "yes", answeredAt: T0 + 3 });
    expect(res.ok).toBe(true);
    expect(res.promoted?.id).toBe("e-b");
    expect(getOpenDevEscalationForSession(db, "s1")?.id).toBe("e-b");

    // Resolving the last open escalation promotes nothing.
    const res2 = resolveDevEscalation(db, { id: "e-b", answer: "ok", answeredAt: T0 + 4 });
    expect(res2.ok).toBe(true);
    expect(res2.promoted).toBeNull();
    expect(getOpenDevEscalationForSession(db, "s1")).toBeNull();
  });

  it("recovery sweep covers an active task escalation on a still-running session, not a held one (P1-18)", () => {
    insertDevTasks(
      db,
      "s1",
      [
        { id: "t1", taskKey: "a", summary: "a", dependsOn: [], scope: "", reqs: [], body: "b", origin: "plan" },
        { id: "t2", taskKey: "b", summary: "b", dependsOn: [], scope: "", reqs: [], body: "b", origin: "plan" },
      ],
      T0,
    );
    // Fleet task escalations are raised WHILE the session is still 'running'
    // (siblings in flight); the sweep must recover them, not only awaiting_user.
    markDevRunningFromParked(db, "s1", T0);
    const active = createDevEscalation(db, {
      id: "e-run-a", sessionId: "s1", taskId: "t1", kind: "risk_approval",
      question: "A?", contextSummary: null, askedAt: T0 + 1,
    });
    const held = createDevEscalation(db, {
      id: "e-run-b", sessionId: "s1", taskId: "t2", kind: "risk_approval",
      question: "B?", contextSummary: null, askedAt: T0 + 2,
    });
    expect(active.queued).toBe(false);
    expect(held.queued).toBe(true);
    // The ACTIVE task escalation is recovered despite the running session; the
    // held (queued) one is withheld until it is promoted.
    expect(listUndeliveredDevEscalations(db).map((e) => e.id)).toEqual(["e-run-a"]);
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
    // P0-5 serialization: the FIRST-created escalation (e-task) is ACTIVE
    // (queued = 0); the second (e-session) is held (queued = 1). The open
    // pointer resolves to the single active one — here the task-scoped row, so
    // its taskId still round-trips through the open-pointer surface.
    expect(getOpenDevEscalationForSession(db, "s1")?.id).toBe("e-task");
    expect(getOpenDevEscalationForSession(db, "s1")?.taskId).toBe("t1");
    expect(scoped.queued).toBe(false);
    expect(sessionScoped.queued).toBe(true);
    const undelivered = listUndeliveredDevEscalations(db);
    expect(undelivered.find((e) => e.id === "e-task")?.taskId).toBe("t1");
    // The held (queued) escalation is NOT swept for delivery ahead of its turn.
    expect(undelivered.find((e) => e.id === "e-session")).toBeUndefined();
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

describe("migration 0028-dev-escalation-queue", () => {
  function hasColumn(db: Database.Database, table: string, col: string): boolean {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((r) => r.name === col);
  }

  it("is registered after 0027", () => {
    const i27 = MIGRATIONS.findIndex((m) => m.id === "0027-dev-flow");
    const i28 = MIGRATIONS.findIndex((m) => m.id === "0028-dev-escalation-queue");
    expect(i28).toBeGreaterThan(i27);
  });

  it("adds the queued column to a legacy escalations table, backfills to 0, narrows the index, idempotently", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    // Legacy shape: 0026 creates dev_session_escalations WITHOUT `queued`.
    runMigrations(db, MIGRATIONS.filter((m) => m.id === "0026-dev-mode"));
    expect(hasColumn(db, "dev_session_escalations", "queued")).toBe(false);
    // A pre-existing escalation row (FK off just to seed without a session row).
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO dev_session_escalations
         (id, session_id, kind, question, context_summary, asked_at,
          deadline_at, delivered_at, answer, answered_at, resolved)
       VALUES ('e1', 's1', 'spec_decision', 'q', NULL, 0, NULL, NULL, NULL, NULL, 0)`,
    ).run();
    db.pragma("foreign_keys = ON");

    const only28 = MIGRATIONS.filter((m) => m.id === "0028-dev-escalation-queue");
    expect(runMigrations(db, only28).applied).toEqual(["0028-dev-escalation-queue"]);

    expect(hasColumn(db, "dev_session_escalations", "queued")).toBe(true);
    // Pre-existing row backfilled to active (queued = 0).
    expect((db.prepare(`SELECT queued FROM dev_session_escalations WHERE id='e1'`).get() as { queued: number }).queued).toBe(0);
    // The partial index is narrowed to the active-escalation predicate.
    const idx = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_dev_esc_unresolved'`).get() as { sql: string };
    expect(idx.sql).toContain("queued = 0");
    // Idempotent — a recorded re-run changes nothing.
    expect(runMigrations(db, only28).applied).toEqual([]);
    db.close();
  });

  it("repairs legacy multi-active escalations — only the oldest stays active per session", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db, MIGRATIONS.filter((m) => m.id === "0026-dev-mode"));
    // The pre-WP3 fleet engine could raise several concurrent unresolved
    // escalations per session (no serialization). Seed two for s1, one for s2.
    db.pragma("foreign_keys = OFF");
    const seed = db.prepare(
      `INSERT INTO dev_session_escalations
         (id, session_id, kind, question, context_summary, asked_at,
          deadline_at, delivered_at, answer, answered_at, resolved)
       VALUES (?, ?, 'spec_decision', 'q', NULL, ?, NULL, NULL, NULL, NULL, 0)`,
    );
    seed.run("s1-old", "s1", 10);
    seed.run("s1-new", "s1", 20);
    seed.run("s2-only", "s2", 5);
    db.pragma("foreign_keys = ON");

    runMigrations(db, MIGRATIONS.filter((m) => m.id === "0028-dev-escalation-queue"));

    const q = (id: string) =>
      (db.prepare(`SELECT queued FROM dev_session_escalations WHERE id=?`).get(id) as { queued: number }).queued;
    // s1: oldest (asked_at 10) stays active; the newer one is held.
    expect(q("s1-old")).toBe(0);
    expect(q("s1-new")).toBe(1);
    // s2: its single escalation stays active.
    expect(q("s2-only")).toBe(0);
    db.close();
  });
});

describe("migration 0029-dev-loop-hardening", () => {
  function hasColumn(db: Database.Database, table: string, col: string): boolean {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((r) => r.name === col);
  }
  const LEGACY = MIGRATIONS.filter((m) =>
    ["0026-dev-mode", "0027-dev-flow", "0028-dev-escalation-queue"].includes(m.id),
  );
  const ONLY_29 = MIGRATIONS.filter((m) => m.id === "0029-dev-loop-hardening");

  it("is registered after 0028", () => {
    const i28 = MIGRATIONS.findIndex((m) => m.id === "0028-dev-escalation-queue");
    const i29 = MIGRATIONS.findIndex((m) => m.id === "0029-dev-loop-hardening");
    expect(i29).toBeGreaterThan(i28);
  });

  it("upgrades a legacy dev-mode DB: parent rebuild preserves children, CHECKs widen, idempotent", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db, LEGACY);
    expect(hasColumn(db, "dev_session_tasks", "approved_hash")).toBe(false);
    expect(hasColumn(db, "dev_session_iterations", "superseded")).toBe(false);

    // Seed legacy rows (FK off — the bare db has no repositories table).
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO dev_sessions (id, repository_id, slug, state, created_at, entered_at, updated_at)
       VALUES ('s1', 'r1', 'test', 'running', 1, 1, 1)`,
    ).run();
    db.pragma("foreign_keys = ON");
    db.prepare(
      `INSERT INTO dev_session_tasks
         (id, session_id, task_key, summary, body, origin, state, created_at, updated_at)
       VALUES ('t1', 's1', 'core', 'core task', 'do it', 'plan', 'running', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO dev_session_iterations
         (id, session_id, task_id, iteration, phase, verdict, created_at)
       VALUES ('i1', 's1', 't1', 1, 'implement', 'ok', 2)`,
    ).run();
    db.prepare(
      `INSERT INTO dev_session_iterations
         (id, session_id, task_id, iteration, phase, verdict, commit_sha, created_at)
       VALUES ('i2', 's1', NULL, 3, 'evaluate', 'CONTINUE', 'abc123', 3)`,
    ).run();
    db.prepare(
      `INSERT INTO dev_session_escalations
         (id, session_id, task_id, kind, question, asked_at, resolved, queued)
       VALUES ('e1', 's1', 't1', 'spec_decision', 'q', 4, 0, 1)`,
    ).run();

    expect(runMigrations(db, ONLY_29).applied).toEqual(["0029-dev-loop-hardening"]);

    // Columns landed.
    for (const col of [
      "original_branch", "original_head", "wip_snapshot_ref",
      "baseline_verified_at", "rolled_back_at", "run_resumes",
    ]) {
      expect(hasColumn(db, "dev_sessions", col)).toBe(true);
    }
    expect(hasColumn(db, "dev_session_tasks", "approved_hash")).toBe(true);
    expect(hasColumn(db, "dev_session_iterations", "superseded")).toBe(true);
    // The renamed old parent is gone.
    expect(tableExists(db, "dev_session_tasks_old")).toBe(false);
    expect(tableExists(db, "dev_session_checklist")).toBe(true);

    // Data preserved across the rebuild dance — INCLUDING child task_id
    // attribution (the whole point of the rename-first ordering).
    const iters = db
      .prepare(`SELECT id, task_id, superseded FROM dev_session_iterations ORDER BY id`)
      .all() as { id: string; task_id: string | null; superseded: number }[];
    expect(iters).toEqual([
      { id: "i1", task_id: "t1", superseded: 0 },
      { id: "i2", task_id: null, superseded: 0 },
    ]);
    const esc = db
      .prepare(`SELECT task_id, queued FROM dev_session_escalations WHERE id='e1'`)
      .get() as { task_id: string | null; queued: number };
    expect(esc).toEqual({ task_id: "t1", queued: 1 });

    // CHECKs widened (and still enforced).
    db.prepare(
      `INSERT INTO dev_session_tasks
         (id, session_id, task_key, summary, body, origin, state, created_at, updated_at)
       VALUES ('t2', 's1', 'manual-1', 'added', 'body', 'manual', 'queued', 5, 5)`,
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO dev_session_tasks
           (id, session_id, task_key, summary, body, origin, state, created_at, updated_at)
         VALUES ('t3', 's1', 'x', 'x', 'x', 'bogus', 'queued', 5, 5)`,
      ).run(),
    ).toThrow(/CHECK/);
    db.prepare(
      `INSERT INTO dev_session_iterations
         (id, session_id, iteration, phase, created_at)
       VALUES ('i3', 's1', 0, 'baseline', 6)`,
    ).run();
    db.prepare(
      `INSERT INTO dev_session_escalations
         (id, session_id, kind, question, asked_at, resolved, queued)
       VALUES ('e2', 's1', 'human_verify', 'sign off?', 7, 0, 0)`,
    ).run();
    // The unique (session, task_key) index was recreated with the new parent.
    expect(() =>
      db.prepare(
        `INSERT INTO dev_session_tasks
           (id, session_id, task_key, summary, body, origin, state, created_at, updated_at)
         VALUES ('t4', 's1', 'core', 'dup key', 'x', 'plan', 'queued', 8, 8)`,
      ).run(),
    ).toThrow(/UNIQUE/);

    // FK graph re-points at the NEW parent: delete cascades/nullifies.
    db.prepare(`DELETE FROM dev_session_tasks WHERE id = 't1'`).run();
    expect(db.prepare(`SELECT id FROM dev_session_iterations WHERE id='i1'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT id FROM dev_session_iterations WHERE id='i2'`).get()).toBeDefined();
    expect(
      (db.prepare(`SELECT task_id FROM dev_session_escalations WHERE id='e1'`).get() as { task_id: string | null }).task_id,
    ).toBeNull();

    // Idempotent — a recorded re-run changes nothing.
    expect(runMigrations(db, ONLY_29).applied).toEqual([]);
    db.close();
  });

  it("upgrades a 0026+0027 shape that skipped 0028 — defaults queued to 0", () => {
    // The registered runner always orders 0028 before 0029, but 0029's
    // escalations rebuild defensively defaults `queued` when it is absent.
    // Exercise that fallback via a partial chain (0026+0027, NOT 0028).
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db, MIGRATIONS.filter((m) => ["0026-dev-mode", "0027-dev-flow"].includes(m.id)));
    expect(hasColumn(db, "dev_session_escalations", "queued")).toBe(false);
    expect(hasColumn(db, "dev_session_escalations", "task_id")).toBe(true); // 0027 added it

    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO dev_sessions (id, repository_id, slug, state, created_at, entered_at, updated_at)
       VALUES ('s1', 'r1', 't', 'running', 1, 1, 1)`,
    ).run();
    db.pragma("foreign_keys = ON");
    db.prepare(
      `INSERT INTO dev_session_escalations
         (id, session_id, kind, question, asked_at, resolved)
       VALUES ('e1', 's1', 'spec_decision', 'q', 5, 0)`,
    ).run();

    expect(runMigrations(db, ONLY_29).applied).toEqual(["0029-dev-loop-hardening"]);

    // queued defaulted to 0; the row survived; the human_verify CHECK landed.
    expect(hasColumn(db, "dev_session_escalations", "queued")).toBe(true);
    const row = db
      .prepare(`SELECT queued FROM dev_session_escalations WHERE id = 'e1'`)
      .get() as { queued: number };
    expect(row.queued).toBe(0);
    db.prepare(
      `INSERT INTO dev_session_escalations (id, session_id, kind, question, asked_at, resolved, queued)
       VALUES ('e2', 's1', 'human_verify', 'sign off?', 6, 0, 0)`,
    ).run();
    db.close();
  });

  it("is a recorded no-op on a fresh applySchema DB", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    db.prepare(
      `INSERT INTO repositories (id, local_path, local_only, created_at, updated_at)
       VALUES ('r1', '/tmp/r1', 1, 1, 1)`,
    ).run();
    createDevSession(db, {
      id: "s1",
      repositoryId: "r1",
      slug: "fresh",
      originatingPlatform: "telegram",
      originatingChannel: "telegram:1",
      createdAt: 1,
    });
    expect(runMigrations(db, ONLY_29).applied).toEqual(["0029-dev-loop-hardening"]);
    // The modern shape survived untouched and the store round-trips.
    const row = getDevSession(db, "s1");
    expect(row?.runResumes).toBe(0);
    expect(row?.originalBranch).toBeNull();
    expect(row?.rolledBackAt).toBeNull();
    db.close();
  });
});

describe("rollback/resume store support (0029)", () => {
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

  function approve(id = "s1"): void {
    markDevAwaitingApproval(db, id, T0 + 1);
    approveDevSession(db, {
      id,
      approvedHash: "h1",
      branch: `aitne-dev/${id}`,
      baseRef: "base1",
      originalBranch: "develop",
      originalHead: "head0",
      wipSnapshotRef: "wip1",
      maxIterations: 10,
      maxBudgetUsd: null,
      approvedAt: T0 + 2,
    });
  }

  it("approveDevSession records the rollback anchors", () => {
    approve();
    const row = getDevSession(db, "s1")!;
    expect(row.originalBranch).toBe("develop");
    expect(row.originalHead).toBe("head0");
    expect(row.wipSnapshotRef).toBe("wip1");
    expect(row.baselineVerifiedAt).toBeNull();
  });

  it("setDevSessionBaselineDone advances base_ref and stamps the discriminator", () => {
    approve();
    setDevSessionBaselineDone(db, { id: "s1", baseRef: "base2", verifiedAt: T0 + 3 });
    const row = getDevSession(db, "s1")!;
    expect(row.baseRef).toBe("base2");
    expect(row.baselineVerifiedAt).toBe(T0 + 3);
  });

  it("updateDevSessionBaseRef degrades the review base", () => {
    approve();
    updateDevSessionBaseRef(db, "s1", "headX", T0 + 4);
    expect(getDevSession(db, "s1")?.baseRef).toBe("headX");
  });

  it("rollback marking removes the session from the rollback target lookup", () => {
    approve();
    expect(getLatestRollbackableDevSession(db)?.id).toBe("s1");
    markDevSessionRolledBack(db, { id: "s1", at: T0 + 5 });
    expect(getDevSession(db, "s1")?.rolledBackAt).toBe(T0 + 5);
    expect(getLatestRollbackableDevSession(db)).toBeNull();
  });

  it("getLatestRollbackableDevSession skips branchless sessions and picks the newest", () => {
    // s1 never approved (branch NULL) — not a target.
    expect(getLatestRollbackableDevSession(db)).toBeNull();
    approve();
    createDevSession(db, {
      id: "s2",
      repositoryId: "local:test",
      slug: "test",
      originatingPlatform: "telegram",
      originatingChannel: "telegram:123",
      createdAt: T0 + 10,
    });
    // s2 is newer but branchless — s1 stays the target.
    expect(getLatestRollbackableDevSession(db)?.id).toBe("s1");
  });

  it("getLatestDevSessionForChannel resolves the newest session for the channel", () => {
    expect(getLatestDevSessionForChannel(db, "telegram:123")?.id).toBe("s1");
    expect(getLatestDevSessionForChannel(db, "discord:9")).toBeNull();
    createDevSession(db, {
      id: "s2",
      repositoryId: "local:test",
      slug: "test",
      originatingPlatform: "telegram",
      originatingChannel: "telegram:123",
      createdAt: T0 + 10,
    });
    expect(getLatestDevSessionForChannel(db, "telegram:123")?.id).toBe("s2");
  });

  it("latestEvaluateCommitFor / supersedeDevIterationsAfter drive iteration rollback", () => {
    approve();
    const rec = (id: string, iteration: number, phase: "evaluate" | "implement", sha: string | null, at: number) =>
      recordDevIteration(db, {
        id, sessionId: "s1", iteration, phase, verdict: "CONTINUE",
        commitSha: sha, createdAt: at,
      });
    rec("i1", 1, "evaluate", "sha1", T0 + 1);
    rec("i2", 2, "evaluate", "sha2", T0 + 2);
    rec("i2b", 2, "implement", null, T0 + 3); // no commit — never a target
    rec("i3", 3, "evaluate", "sha3", T0 + 4);
    expect(latestEvaluateCommitFor(db, "s1", 2)).toBe("sha2");
    expect(latestEvaluateCommitFor(db, "s1", 9)).toBeNull();

    // Roll back to iteration 2: rows PAST it flip superseded (kept).
    expect(supersedeDevIterationsAfter(db, "s1", 2)).toBe(1);
    const rows = listDevIterations(db, "s1");
    expect(rows.find((r) => r.id === "i3")?.superseded).toBe(true);
    expect(rows.find((r) => r.id === "i2")?.superseded).toBe(false);
    // A superseded evaluate row is no longer a commit target.
    expect(latestEvaluateCommitFor(db, "s1", 3)).toBeNull();
  });

  it("resetDevRequirementStatuses wipes the ledger before the re-sync", () => {
    approve();
    seedDevRequirements(db, "s1", [
      { id: "q1", reqId: "REQ-001", title: "a" },
      { id: "q2", reqId: "REQ-002", title: "b" },
    ], T0);
    updateDevRequirement(db, {
      sessionId: "s1", reqId: "REQ-001", status: "met", evidence: "done", iter: 3, updatedAt: T0 + 1,
    });
    resetDevRequirementStatuses(db, "s1", T0 + 2);
    const rows = listDevRequirements(db, "s1");
    expect(rows.map((r) => r.status)).toEqual(["unstarted", "unstarted"]);
    expect(rows[0]?.evidence).toBeNull();
    expect(rows[0]?.iter).toBeNull();
  });

  it("markDevRunningFromTerminal is a terminal-only CAS", () => {
    approve();
    // Running → refuse.
    expect(markDevRunningFromTerminal(db, { id: "s1", at: T0 + 5 })).toBeNull();
    markDevTerminal(db, { id: "s1", state: "failed", loopState: "BLOCKED", exitedAt: T0 + 6 });
    const resumed = markDevRunningFromTerminal(db, { id: "s1", at: T0 + 7 });
    expect(resumed?.state).toBe("running");
    expect(resumed?.exitedAt).toBeNull();
    // The loop verdict is kept for the resume decision; only state flips.
    expect(resumed?.loopState).toBe("BLOCKED");
  });

  it("resetDevSessionStopHeuristics zeroes ONLY the streak counters", () => {
    approve();
    writeDevCheckpoint(db, {
      id: "s1", iteration: 7, agentFailures: 1, gateReviseCount: 2,
      iterReviseCount: 3, resumes: 4,
    }, T0 + 3);
    resetDevSessionStopHeuristics(db, "s1", T0 + 4);
    const row = getDevSession(db, "s1")!;
    expect(row.iteration).toBe(7);
    expect(row.resumes).toBe(4);
    expect(row.agentFailures).toBe(0);
    expect(row.gateReviseCount).toBe(0);
    expect(row.iterReviseCount).toBe(0);
  });

  it("run_resumes bumps, persists, and clears on progress", () => {
    approve();
    expect(bumpDevSessionRunResumes(db, "s1", T0 + 1)).toBe(1);
    expect(bumpDevSessionRunResumes(db, "s1", T0 + 2)).toBe(2);
    expect(getDevSession(db, "s1")?.runResumes).toBe(2);
    clearDevSessionRunResumes(db, "s1", T0 + 3);
    expect(getDevSession(db, "s1")?.runResumes).toBe(0);
    // Clearing an already-zero counter is a no-op (no updated_at churn).
    const before = getDevSession(db, "s1")!.updatedAt;
    clearDevSessionRunResumes(db, "s1", T0 + 9);
    expect(getDevSession(db, "s1")!.updatedAt).toBe(before);
  });

  it("rebindDevSessionApproval re-anchors the hash + budget caps", () => {
    approve();
    rebindDevSessionApproval(db, {
      id: "s1", approvedHash: "h2", maxIterations: 20, maxBudgetUsd: 5, at: T0 + 8,
    });
    const row = getDevSession(db, "s1")!;
    expect(row.approvedHash).toBe("h2");
    expect(row.maxIterations).toBe(20);
    expect(row.maxBudgetUsd).toBe(5);
  });
});
