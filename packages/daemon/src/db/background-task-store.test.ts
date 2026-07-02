import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";

import { applySchema } from "./schema.js";
import {
  createBackgroundTask,
  findRecentDuplicateBackgroundTask,
  getBackgroundTask,
  listBackgroundTasks,
  countBackgroundTasks,
  listNonTerminalBackgroundTasks,
  markRunning,
  markAwaitingUser,
  markRunningFromParked,
  markTerminal,
  setBackendSessionId,
  markBackgroundTaskDelivered,
  listUndeliveredBackgroundTaskReports,
  listFiledBackgroundTaskResults,
  resetNonTerminalForBootRedispatch,
  resetSingleForBootRedispatch,
  deleteTerminalBackgroundTasksOlderThan,
} from "./background-task-store.js";

function seed(db: Database.Database, id: string, overrides = {}): void {
  createBackgroundTask(db, {
    id,
    brief: `brief ${id}`,
    title: `title ${id}`,
    notificationPolicy: "always",
    originatingChannel: "slack:C1",
    correlationId: null,
    scheduleRowId: null,
    tier: "medium",
    maxBudgetUsd: null,
    createdAt: 1000,
    ...overrides,
  });
}

describe("background-task-store", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  it("creates a pending row with null artifact fields", () => {
    seed(db, "t1");
    const row = getBackgroundTask(db, "t1");
    expect(row?.state).toBe("pending");
    expect(row?.notify).toBeNull();
    expect(row?.report).toBeNull();
    expect(row?.draft).toBeNull();
    expect(row?.notificationPolicy).toBe("always");
  });

  it("runs the pending → running → awaiting_user → running cycle via CAS", () => {
    seed(db, "t1");
    expect(markRunning(db, "t1", 1100)?.state).toBe("running");
    // CAS miss: can't run a non-pending row
    expect(markRunning(db, "t1", 1200)).toBeNull();
    expect(markAwaitingUser(db, "t1")?.state).toBe("awaiting_user");
    expect(markRunningFromParked(db, "t1")?.state).toBe("running");
  });

  it("finish-shaped markTerminal writes the artifact atomically", () => {
    seed(db, "t1");
    markRunning(db, "t1", 1100);
    const done = markTerminal(db, {
      id: "t1",
      state: "completed",
      outcomeDetail: null,
      finishedAt: 2000,
      report: "verbatim result with numbers 42",
      draft: "short summary",
      notify: true,
      significance: "all good",
    });
    expect(done?.state).toBe("completed");
    expect(done?.report).toBe("verbatim result with numbers 42");
    expect(done?.draft).toBe("short summary");
    expect(done?.notify).toBe(true);
    // idempotent — re-running CAS-misses
    expect(markTerminal(db, { id: "t1", state: "failed", outcomeDetail: "x", finishedAt: 3000 })).toBeNull();
  });

  it("notify=false is filed (not in the undelivered-reports recovery set)", () => {
    seed(db, "filed");
    markRunning(db, "filed", 1100);
    markTerminal(db, {
      id: "filed",
      state: "completed",
      outcomeDetail: null,
      finishedAt: 2000,
      report: "r",
      draft: "d",
      notify: false,
    });
    expect(listUndeliveredBackgroundTaskReports(db)).toHaveLength(0);
    expect(listFiledBackgroundTaskResults(db, 0).map((r) => r.id)).toContain("filed");
  });

  it("list/count notify + finishedSinceMs filters drive the §10.5 digest pull", () => {
    // filed (notify=false) at t=2000, surfaced (notify=true) at t=5000,
    // and an unfinished pending row (notify NULL).
    seed(db, "filed");
    markRunning(db, "filed", 1100);
    markTerminal(db, { id: "filed", state: "completed", outcomeDetail: null, finishedAt: 2000, report: "r", draft: "d", notify: false });
    seed(db, "surfaced");
    markRunning(db, "surfaced", 1100);
    markTerminal(db, { id: "surfaced", state: "completed", outcomeDetail: null, finishedAt: 5000, report: "r", draft: "d", notify: true });
    seed(db, "pending");

    // notify=false narrows to the filed row only (the NULL-notify pending
    // row is excluded, not coalesced into "false").
    const filed = listBackgroundTasks(db, { states: ["completed"], notify: false });
    expect(filed.map((r) => r.id)).toEqual(["filed"]);
    expect(countBackgroundTasks(db, { states: ["completed"], notify: false })).toBe(1);

    // notify=true narrows to the surfaced row.
    expect(
      listBackgroundTasks(db, { states: ["completed"], notify: true }).map((r) => r.id),
    ).toEqual(["surfaced"]);

    // finishedSinceMs windows out the older filed row.
    expect(
      listBackgroundTasks(db, { states: ["completed"], finishedSinceMs: 3000 }).map((r) => r.id),
    ).toEqual(["surfaced"]);
    expect(
      countBackgroundTasks(db, { states: ["completed"], notify: false, finishedSinceMs: 3000 }),
    ).toBe(0);
  });

  it("undelivered-reports recovery set = completed + notify=1 + delivered_at NULL", () => {
    seed(db, "notify");
    markRunning(db, "notify", 1100);
    markTerminal(db, {
      id: "notify",
      state: "completed",
      outcomeDetail: null,
      finishedAt: 2000,
      report: "r",
      draft: "d",
      notify: true,
    });
    expect(listUndeliveredBackgroundTaskReports(db).map((r) => r.id)).toEqual(["notify"]);
    // once delivered, drops out of the recovery set (idempotent mark)
    expect(markBackgroundTaskDelivered(db, "notify", 2500)?.deliveredAt).toBe(2500);
    expect(markBackgroundTaskDelivered(db, "notify", 9999)?.deliveredAt).toBe(2500);
    expect(listUndeliveredBackgroundTaskReports(db)).toHaveLength(0);
  });

  it("captures + persists the backend session id", () => {
    seed(db, "t1");
    setBackendSessionId(db, "t1", "sess-abc");
    expect(getBackgroundTask(db, "t1")?.backendSessionId).toBe("sess-abc");
  });

  it("resetNonTerminalForBootRedispatch flips non-terminal rows back to pending", () => {
    seed(db, "running");
    markRunning(db, "running", 1100);
    setBackendSessionId(db, "running", "sess-1");
    seed(db, "parked");
    markRunning(db, "parked", 1100);
    markAwaitingUser(db, "parked");
    seed(db, "done");
    markRunning(db, "done", 1100);
    markTerminal(db, { id: "done", state: "completed", outcomeDetail: null, finishedAt: 2000, report: "r", draft: "d", notify: true });

    const reset = resetNonTerminalForBootRedispatch(db);
    expect(reset.map((r) => r.id).sort()).toEqual(["parked", "running"]);
    expect(getBackgroundTask(db, "running")?.state).toBe("pending");
    expect(getBackgroundTask(db, "running")?.backendSessionId).toBeNull();
    expect(getBackgroundTask(db, "parked")?.state).toBe("pending");
    // terminal row untouched
    expect(getBackgroundTask(db, "done")?.state).toBe("completed");
  });

  it("resetNonTerminalForBootRedispatch resolves orphaned clarifications so the deadline scanner cannot timeout the re-dispatched run", () => {
    // A task parked on a clarification when the daemon restarted: the
    // pre-restart run is gone, but its clarification row survives. Without
    // cleanup, listOverdueClarifications would later expireForDeadline the
    // FRESH re-dispatched run (now active again) into a spurious timeout.
    seed(db, "parked");
    markRunning(db, "parked", 1100);
    markAwaitingUser(db, "parked");
    db.prepare(
      `INSERT INTO background_task_clarifications
         (id, task_id, question, context_summary, asked_at, deadline_at,
          delivered_at, answer, answered_at, resolved)
       VALUES ('clar-1', 'parked', 'web or api first?', NULL, 1200, 1260,
               NULL, NULL, NULL, 0)`,
    ).run();

    resetNonTerminalForBootRedispatch(db, 5000);

    const clar = db
      .prepare<[], { resolved: number; answered_at: number | null }>(
        "SELECT resolved, answered_at FROM background_task_clarifications WHERE id = 'clar-1'",
      )
      .get();
    expect(clar?.resolved).toBe(1);
    expect(clar?.answered_at).toBe(5000);
  });

  describe("verification (finish-time self-check, migration 0023)", () => {
    it("markTerminal persists + round-trips the checklist", () => {
      seed(db, "v1");
      markRunning(db, "v1", 1100);
      const done = markTerminal(db, {
        id: "v1",
        state: "completed",
        outcomeDetail: null,
        finishedAt: 2000,
        report: "r",
        draft: "d",
        notify: true,
        verification: [
          { requirement: "one line per repo", met: true, evidence: "6 rows" },
          { requirement: "name the failing job", met: false, evidence: "job log 404ed" },
        ],
      });
      expect(done?.verification).toEqual([
        { requirement: "one line per repo", met: true, evidence: "6 rows" },
        { requirement: "name the failing job", met: false, evidence: "job log 404ed" },
      ]);
    });

    it("markTerminal without verification leaves the column NULL (fail-loud path)", () => {
      seed(db, "v2");
      markRunning(db, "v2", 1100);
      markTerminal(db, { id: "v2", state: "failed", outcomeDetail: "sdk_error", finishedAt: 2000 });
      expect(getBackgroundTask(db, "v2")?.verification).toBeNull();
      // an explicit empty array also stores SQL NULL, not "[]"
      seed(db, "v3");
      markRunning(db, "v3", 1100);
      markTerminal(db, {
        id: "v3",
        state: "completed",
        outcomeDetail: null,
        finishedAt: 2000,
        verification: [],
      });
      const raw = db
        .prepare<[], { verification: string | null }>(
          "SELECT verification FROM background_task WHERE id = 'v3'",
        )
        .get();
      expect(raw?.verification).toBeNull();
    });

    it("degrades malformed persisted verification to null rather than throwing", () => {
      seed(db, "bad");
      for (const value of ["{not json", '{"requirement":"solo object"}', "[]"]) {
        db.prepare("UPDATE background_task SET verification = ? WHERE id = 'bad'").run(value);
        expect(getBackgroundTask(db, "bad")?.verification).toBeNull();
      }
      // well-typed items survive; malformed siblings are dropped
      db.prepare("UPDATE background_task SET verification = ? WHERE id = 'bad'").run(
        JSON.stringify([
          { requirement: "ok", met: true, evidence: "e" },
          { requirement: "missing met", evidence: "e" },
          "not an object",
        ]),
      );
      expect(getBackgroundTask(db, "bad")?.verification).toEqual([
        { requirement: "ok", met: true, evidence: "e" },
      ]);
    });
  });

  describe("significanceCriteria (§4.3 if_significant DSL)", () => {
    it("persists + round-trips a JSON criteria array", () => {
      createBackgroundTask(db, {
        id: "sc",
        brief: "audit",
        title: null,
        notificationPolicy: "if_significant",
        significanceCriteria: ["any repo red", "spend > $100"],
        originatingChannel: null,
        correlationId: null,
        scheduleRowId: null,
        tier: null,
        maxBudgetUsd: null,
        createdAt: 1000,
      });
      expect(getBackgroundTask(db, "sc")?.significanceCriteria).toEqual([
        "any repo red",
        "spend > $100",
      ]);
    });

    it("stores NULL for an absent or empty criteria list", () => {
      seed(db, "none");
      expect(getBackgroundTask(db, "none")?.significanceCriteria).toBeNull();
      createBackgroundTask(db, {
        id: "empty",
        brief: "b",
        title: null,
        notificationPolicy: "if_significant",
        significanceCriteria: [],
        originatingChannel: null,
        correlationId: null,
        scheduleRowId: null,
        tier: null,
        maxBudgetUsd: null,
        createdAt: 1000,
      });
      const raw = db
        .prepare<[], { significance_criteria: string | null }>(
          "SELECT significance_criteria FROM background_task WHERE id = 'empty'",
        )
        .get();
      expect(raw?.significance_criteria).toBeNull();
    });

    it("degrades a malformed persisted value to null rather than throwing", () => {
      seed(db, "bad");
      db.prepare(
        "UPDATE background_task SET significance_criteria = ? WHERE id = 'bad'",
      ).run("{not json");
      expect(getBackgroundTask(db, "bad")?.significanceCriteria).toBeNull();
    });
  });

  describe("findRecentDuplicateBackgroundTask (§10.3 brief-dedup)", () => {
    it("matches an identical brief + tier inside the window", () => {
      createBackgroundTask(db, {
        id: "orig",
        brief: "audit all repos",
        title: null,
        notificationPolicy: "always",
        originatingChannel: "slack:C1",
        correlationId: null,
        scheduleRowId: null,
        tier: "medium",
        maxBudgetUsd: null,
        createdAt: 10_000,
      });
      const hit = findRecentDuplicateBackgroundTask(db, {
        brief: "audit all repos",
        tier: "medium",
        sinceMs: 9_000,
      });
      expect(hit?.id).toBe("orig");
    });

    it("does not match outside the window, a different brief, or a different tier", () => {
      createBackgroundTask(db, {
        id: "orig",
        brief: "audit all repos",
        title: null,
        notificationPolicy: "always",
        originatingChannel: null,
        correlationId: null,
        scheduleRowId: null,
        tier: "medium",
        maxBudgetUsd: null,
        createdAt: 10_000,
      });
      // window starts after the row was created
      expect(
        findRecentDuplicateBackgroundTask(db, { brief: "audit all repos", tier: "medium", sinceMs: 11_000 }),
      ).toBeNull();
      // different brief
      expect(
        findRecentDuplicateBackgroundTask(db, { brief: "audit ONE repo", tier: "medium", sinceMs: 9_000 }),
      ).toBeNull();
      // different tier
      expect(
        findRecentDuplicateBackgroundTask(db, { brief: "audit all repos", tier: "high", sinceMs: 9_000 }),
      ).toBeNull();
    });

    it("matches a NULL tier (IS NULL semantics, not = NULL)", () => {
      createBackgroundTask(db, {
        id: "orig",
        brief: "watch the thing",
        title: null,
        notificationPolicy: "always",
        originatingChannel: null,
        correlationId: null,
        scheduleRowId: null,
        tier: null,
        maxBudgetUsd: null,
        createdAt: 10_000,
      });
      expect(
        findRecentDuplicateBackgroundTask(db, { brief: "watch the thing", tier: null, sinceMs: 9_000 })?.id,
      ).toBe("orig");
      // a NULL-tier query must NOT collapse onto a tiered row
      expect(
        findRecentDuplicateBackgroundTask(db, { brief: "watch the thing", tier: "lite", sinceMs: 9_000 }),
      ).toBeNull();
    });

    it("ignores FAIL terminals so a prior failure is retryable, but reuses a completed result", () => {
      // failed duplicate ⇒ NOT a dedup hit (retry should be allowed)
      createBackgroundTask(db, {
        id: "failed",
        brief: "do work",
        title: null,
        notificationPolicy: "always",
        originatingChannel: null,
        correlationId: null,
        scheduleRowId: null,
        tier: "lite",
        maxBudgetUsd: null,
        createdAt: 10_000,
      });
      markRunning(db, "failed", 10_100);
      markTerminal(db, { id: "failed", state: "failed", outcomeDetail: "x", finishedAt: 10_200 });
      expect(
        findRecentDuplicateBackgroundTask(db, { brief: "do work", tier: "lite", sinceMs: 9_000 }),
      ).toBeNull();

      // a completed duplicate IS a hit (answer already exists; don't re-spend)
      createBackgroundTask(db, {
        id: "done",
        brief: "do work",
        title: null,
        notificationPolicy: "always",
        originatingChannel: null,
        correlationId: null,
        scheduleRowId: null,
        tier: "lite",
        maxBudgetUsd: null,
        createdAt: 11_000,
      });
      markRunning(db, "done", 11_100);
      markTerminal(db, { id: "done", state: "completed", outcomeDetail: null, finishedAt: 11_200, report: "r", draft: "d", notify: true });
      expect(
        findRecentDuplicateBackgroundTask(db, { brief: "do work", tier: "lite", sinceMs: 9_000 })?.id,
      ).toBe("done");
    });
  });

  describe("boot recovery selectors (§10.2 Phase 4 resume)", () => {
    it("listNonTerminalBackgroundTasks returns id/state/session for the non-terminal set only", () => {
      seed(db, "run");
      markRunning(db, "run", 1100);
      setBackendSessionId(db, "run", "sess-run");
      seed(db, "parked");
      markRunning(db, "parked", 1100);
      markAwaitingUser(db, "parked");
      seed(db, "pend");
      seed(db, "done");
      markRunning(db, "done", 1100);
      markTerminal(db, { id: "done", state: "completed", outcomeDetail: null, finishedAt: 2000, report: "r", draft: "d", notify: true });

      const rows = listNonTerminalBackgroundTasks(db);
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(Object.keys(byId).sort()).toEqual(["parked", "pend", "run"]);
      expect(byId.run).toMatchObject({ state: "running", backendSessionId: "sess-run" });
      expect(byId.parked).toMatchObject({ state: "awaiting_user" });
      expect(byId.pend).toMatchObject({ state: "pending", backendSessionId: null });
    });

    it("resetSingleForBootRedispatch resets ONE row + resolves its clarifications, leaving others", () => {
      seed(db, "a");
      markRunning(db, "a", 1100);
      setBackendSessionId(db, "a", "sess-a");
      db.prepare(
        `INSERT INTO background_task_clarifications
           (id, task_id, question, context_summary, asked_at, deadline_at, delivered_at, answer, answered_at, resolved)
         VALUES ('clar-a', 'a', 'q', NULL, 1200, 1260, NULL, NULL, NULL, 0)`,
      ).run();
      seed(db, "b");
      markRunning(db, "b", 1100);
      setBackendSessionId(db, "b", "sess-b");

      expect(resetSingleForBootRedispatch(db, "a", 9000)).toBe("a");
      expect(getBackgroundTask(db, "a")?.state).toBe("pending");
      expect(getBackgroundTask(db, "a")?.backendSessionId).toBeNull();
      const clar = db
        .prepare<[], { resolved: number }>("SELECT resolved FROM background_task_clarifications WHERE id='clar-a'")
        .get();
      expect(clar?.resolved).toBe(1);
      // the other running row is untouched
      expect(getBackgroundTask(db, "b")?.state).toBe("running");
      expect(getBackgroundTask(db, "b")?.backendSessionId).toBe("sess-b");
    });

    it("resetSingleForBootRedispatch is a no-op (null) on a terminal/missing row", () => {
      seed(db, "done");
      markRunning(db, "done", 1100);
      markTerminal(db, { id: "done", state: "completed", outcomeDetail: null, finishedAt: 2000, report: "r", draft: "d", notify: true });
      expect(resetSingleForBootRedispatch(db, "done")).toBeNull();
      expect(getBackgroundTask(db, "done")?.state).toBe("completed");
      expect(resetSingleForBootRedispatch(db, "missing")).toBeNull();
    });
  });

  it("lists + counts by state and prunes old terminal rows", () => {
    seed(db, "a");
    seed(db, "b");
    markRunning(db, "b", 1100);
    expect(countBackgroundTasks(db, { states: ["pending"] })).toBe(1);
    expect(listBackgroundTasks(db, {}).length).toBe(2);
    markTerminal(db, { id: "b", state: "failed", outcomeDetail: "x", finishedAt: 100 });
    expect(deleteTerminalBackgroundTasksOlderThan(db, 1_000_000)).toBe(1);
    expect(getBackgroundTask(db, "b")).toBeNull();
    expect(getBackgroundTask(db, "a")).not.toBeNull();
  });
});
