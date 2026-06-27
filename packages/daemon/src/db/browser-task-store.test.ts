import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import {
  BROWSER_TASK_TERMINAL_STATES,
  BROWSER_TASK_NON_TERMINAL_STATES,
  countBrowserTasks,
  createBrowserTask,
  deleteTerminalBrowserTasksOlderThan,
  getBrowserTask,
  incrementBlockedRequests,
  incrementExtractChars,
  listBrowserTasks,
  listUndeliveredBrowserTaskReports,
  markAwaitingUser,
  markBrowserTaskDelivered,
  markFinalConfirm,
  markRunning,
  markRunningFromParked,
  markTerminal,
  sweepNonTerminalRowsForBootRecovery,
  type CreateBrowserTaskInput,
} from "./browser-task-store.js";

let db: Database.Database;

function seedInput(overrides: Partial<CreateBrowserTaskInput> = {}): CreateBrowserTaskInput {
  return {
    id: overrides.id ?? "task-1",
    description: "buy milk",
    siteKey: "example",
    extraAllowedHosts: ["cdn.example.com"],
    originatingChannel: "slack:C123",
    scheduleRowId: null,
    requireFinalConfirm: true,
    effectiveAllowlistRegex: "^https://example\\.com",
    createdAt: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
});

afterEach(() => {
  db.close();
});

describe("state-set exports", () => {
  it("partitions the nine states into terminal and non-terminal with no overlap", () => {
    expect(BROWSER_TASK_TERMINAL_STATES.size + BROWSER_TASK_NON_TERMINAL_STATES.size).toBe(9);
    for (const s of BROWSER_TASK_TERMINAL_STATES) {
      expect(BROWSER_TASK_NON_TERMINAL_STATES.has(s)).toBe(false);
    }
  });
});

describe("createBrowserTask + getBrowserTask", () => {
  it("round-trips every field and starts in 'pending'", () => {
    const row = createBrowserTask(db, seedInput());
    expect(row).toMatchObject({
      id: "task-1",
      description: "buy milk",
      siteKey: "example",
      extraAllowedHosts: ["cdn.example.com"],
      originatingChannel: "slack:C123",
      scheduleRowId: null,
      requireFinalConfirm: true,
      state: "pending",
      outcomeDetail: null,
      report: null,
      effectiveAllowlistRegex: "^https://example\\.com",
      blockedRequestsCount: 0,
      extractCharsTotal: 0,
      createdAt: 1000,
      startedAt: null,
      finishedAt: null,
      deliveredAt: null,
    });
    expect(getBrowserTask(db, "task-1")).toEqual(row);
  });

  it("maps requireFinalConfirm=false to 0 and back to boolean", () => {
    const row = createBrowserTask(db, seedInput({ requireFinalConfirm: false }));
    expect(row.requireFinalConfirm).toBe(false);
    expect(getBrowserTask(db, "task-1")!.requireFinalConfirm).toBe(false);
  });

  it("serializes an empty extraAllowedHosts list", () => {
    const row = createBrowserTask(db, seedInput({ extraAllowedHosts: [] }));
    expect(row.extraAllowedHosts).toEqual([]);
  });

  it("returns null for an unknown id", () => {
    expect(getBrowserTask(db, "nope")).toBeNull();
  });
});

describe("delivery recovery helpers", () => {
  it("lists completed report rows until delivered_at is set", () => {
    createBrowserTask(db, seedInput({ id: "done", createdAt: 1000 }));
    createBrowserTask(db, seedInput({ id: "pending", createdAt: 500 }));
    markTerminal(db, {
      id: "done",
      state: "completed",
      outcomeDetail: null,
      report: "all set",
      finishedAt: 2000,
    });
    expect(listUndeliveredBrowserTaskReports(db).map((r) => r.id)).toEqual([
      "done",
    ]);
    const marked = markBrowserTaskDelivered(db, "done", 3000);
    expect(marked?.deliveredAt).toBe(3000);
    expect(listUndeliveredBrowserTaskReports(db)).toEqual([]);
  });
});

describe("fromDbRow JSON resilience", () => {
  function insertRaw(id: string, hostsJson: string | null): void {
    db.prepare(
      `INSERT INTO browser_task
         (id, description, site_key, extra_allowed_hosts_json, originating_channel,
          schedule_row_id, require_final_confirm, state, blocked_requests_count,
          extract_chars_total, created_at)
       VALUES (?, 'd', NULL, ?, NULL, NULL, 1, 'pending', 0, 0, 1)`,
    ).run(id, hostsJson);
  }

  it("falls back to [] on malformed JSON", () => {
    insertRaw("bad", "{not json");
    expect(getBrowserTask(db, "bad")!.extraAllowedHosts).toEqual([]);
  });

  it("falls back to [] when the JSON is not an array", () => {
    insertRaw("obj", '{"a":1}');
    expect(getBrowserTask(db, "obj")!.extraAllowedHosts).toEqual([]);
  });

  it("filters out non-string array members", () => {
    insertRaw("mixed", '["a", 1, "b", null]');
    expect(getBrowserTask(db, "mixed")!.extraAllowedHosts).toEqual(["a", "b"]);
  });

  it("treats a NULL hosts column as []", () => {
    insertRaw("nullhosts", null);
    expect(getBrowserTask(db, "nullhosts")!.extraAllowedHosts).toEqual([]);
  });
});

describe("listBrowserTasks + countBrowserTasks", () => {
  beforeEach(() => {
    createBrowserTask(db, seedInput({ id: "a", siteKey: "x", createdAt: 100 }));
    createBrowserTask(db, seedInput({ id: "b", siteKey: "y", createdAt: 300 }));
    createBrowserTask(db, seedInput({ id: "c", siteKey: null, createdAt: 200 }));
  });

  it("orders by created_at DESC", () => {
    const ids = listBrowserTasks(db).map((r) => r.id);
    expect(ids).toEqual(["b", "c", "a"]);
  });

  it("filters by state", () => {
    markRunning(db, "b", 400);
    const running = listBrowserTasks(db, { states: ["running"] });
    expect(running.map((r) => r.id)).toEqual(["b"]);
    expect(countBrowserTasks(db, { states: ["running"] })).toBe(1);
    expect(countBrowserTasks(db, { states: ["pending"] })).toBe(2);
  });

  it("filters by a concrete siteKey", () => {
    expect(listBrowserTasks(db, { siteKey: "x" }).map((r) => r.id)).toEqual(["a"]);
    expect(countBrowserTasks(db, { siteKey: "x" })).toBe(1);
  });

  it("filters by an explicit null siteKey", () => {
    expect(listBrowserTasks(db, { siteKey: null }).map((r) => r.id)).toEqual(["c"]);
    expect(countBrowserTasks(db, { siteKey: null })).toBe(1);
  });

  it("honours limit and offset", () => {
    expect(listBrowserTasks(db, { limit: 1 }).map((r) => r.id)).toEqual(["b"]);
    expect(listBrowserTasks(db, { limit: 1, offset: 1 }).map((r) => r.id)).toEqual(["c"]);
  });

  it("counts all rows with no filter", () => {
    expect(countBrowserTasks(db)).toBe(3);
  });
});

describe("state transitions (CAS)", () => {
  it("markRunning: pending → running sets started_at, and CAS-misses otherwise", () => {
    createBrowserTask(db, seedInput());
    const running = markRunning(db, "task-1", 5000);
    expect(running).toMatchObject({ state: "running", startedAt: 5000 });
    // Re-running on a non-pending row is a no-op.
    expect(markRunning(db, "task-1", 6000)).toBeNull();
    expect(getBrowserTask(db, "task-1")!.startedAt).toBe(5000);
  });

  it("markAwaitingUser: running → awaiting_user, miss when not running", () => {
    createBrowserTask(db, seedInput());
    expect(markAwaitingUser(db, "task-1")).toBeNull(); // still pending
    markRunning(db, "task-1", 1);
    expect(markAwaitingUser(db, "task-1")!.state).toBe("awaiting_user");
  });

  it("markFinalConfirm: running → final_confirm, miss when not running", () => {
    createBrowserTask(db, seedInput());
    expect(markFinalConfirm(db, "task-1")).toBeNull();
    markRunning(db, "task-1", 1);
    expect(markFinalConfirm(db, "task-1")!.state).toBe("final_confirm");
  });

  it("markRunningFromParked: resumes from either parked state, miss when running", () => {
    createBrowserTask(db, seedInput({ id: "p1" }));
    markRunning(db, "p1", 1);
    markAwaitingUser(db, "p1");
    expect(markRunningFromParked(db, "p1")!.state).toBe("running");

    createBrowserTask(db, seedInput({ id: "p2" }));
    markRunning(db, "p2", 1);
    markFinalConfirm(db, "p2");
    expect(markRunningFromParked(db, "p2")!.state).toBe("running");

    // Already running → CAS miss.
    expect(markRunningFromParked(db, "p2")).toBeNull();
  });

  it("markTerminal: non-terminal → terminal, idempotent on already-terminal", () => {
    createBrowserTask(db, seedInput());
    markRunning(db, "task-1", 1);
    const done = markTerminal(db, {
      id: "task-1",
      state: "completed",
      outcomeDetail: null,
      report: "all good",
      finishedAt: 9000,
    });
    expect(done).toMatchObject({ state: "completed", report: "all good", finishedAt: 9000 });
    // Second call CAS-misses (row already terminal).
    expect(
      markTerminal(db, {
        id: "task-1",
        state: "failed",
        outcomeDetail: "late",
        report: "noop",
        finishedAt: 9999,
      }),
    ).toBeNull();
    expect(getBrowserTask(db, "task-1")!.state).toBe("completed");
  });

  it("markTerminal: report COALESCE preserves an existing report when null is passed", () => {
    // Seed a running row that already carries a report so the COALESCE
    // keep-branch is exercised (createBrowserTask always inserts report=NULL).
    db.prepare(
      `INSERT INTO browser_task
         (id, description, state, report, require_final_confirm,
          blocked_requests_count, extract_chars_total, created_at)
       VALUES ('r1', 'd', 'running', 'prior report', 1, 0, 0, 1)`,
    ).run();
    const row = markTerminal(db, {
      id: "r1",
      state: "failed",
      outcomeDetail: "boom",
      report: null,
      finishedAt: 7,
    });
    expect(row).toMatchObject({ state: "failed", outcomeDetail: "boom", report: "prior report" });
  });
});

describe("counters", () => {
  it("incrementBlockedRequests and incrementExtractChars add atomically", () => {
    createBrowserTask(db, seedInput());
    incrementBlockedRequests(db, "task-1", 3);
    incrementBlockedRequests(db, "task-1", 2);
    incrementExtractChars(db, "task-1", 128);
    const row = getBrowserTask(db, "task-1")!;
    expect(row.blockedRequestsCount).toBe(5);
    expect(row.extractCharsTotal).toBe(128);
  });
});

describe("sweepNonTerminalRowsForBootRecovery", () => {
  it("flips every non-terminal row to failed/daemon_restarted and returns ids + channels", () => {
    createBrowserTask(db, seedInput({ id: "n1", originatingChannel: "slack:A" }));
    createBrowserTask(db, seedInput({ id: "n2", originatingChannel: null }));
    markRunning(db, "n2", 1);
    // A terminal row that must be left untouched.
    createBrowserTask(db, seedInput({ id: "t1" }));
    markRunning(db, "t1", 1);
    markTerminal(db, { id: "t1", state: "completed", outcomeDetail: null, report: null, finishedAt: 2 });

    const swept = sweepNonTerminalRowsForBootRecovery(db, 5555);
    expect(swept).toHaveLength(2);
    expect(swept).toEqual(
      expect.arrayContaining([
        { id: "n1", originatingChannel: "slack:A" },
        { id: "n2", originatingChannel: null },
      ]),
    );
    for (const id of ["n1", "n2"]) {
      const r = getBrowserTask(db, id)!;
      expect(r.state).toBe("failed");
      expect(r.outcomeDetail).toBe("daemon_restarted");
      expect(r.finishedAt).toBe(5555);
    }
    // The completed row is untouched.
    expect(getBrowserTask(db, "t1")!.state).toBe("completed");
  });

  it("returns an empty array when there are no non-terminal rows", () => {
    expect(sweepNonTerminalRowsForBootRecovery(db, 1)).toEqual([]);
  });
});

describe("deleteTerminalBrowserTasksOlderThan", () => {
  function makeTerminal(id: string, finishedAt: number | null, createdAt: number): void {
    createBrowserTask(db, seedInput({ id, createdAt }));
    markRunning(db, id, createdAt);
    markTerminal(db, { id, state: "completed", outcomeDetail: null, report: null, finishedAt: finishedAt ?? 0 });
    if (finishedAt === null) {
      db.prepare("UPDATE browser_task SET finished_at = NULL WHERE id = ?").run(id);
    }
  }

  it("deletes terminal rows older than the cutoff, keeps newer + non-terminal", () => {
    makeTerminal("old", 100, 50);
    makeTerminal("new", 5000, 50);
    createBrowserTask(db, seedInput({ id: "live", createdAt: 10 })); // pending, ancient created_at

    const removed = deleteTerminalBrowserTasksOlderThan(db, 1000);
    expect(removed).toBe(1);
    expect(getBrowserTask(db, "old")).toBeNull();
    expect(getBrowserTask(db, "new")).not.toBeNull();
    // Non-terminal rows are never pruned, regardless of age.
    expect(getBrowserTask(db, "live")).not.toBeNull();
  });

  it("uses COALESCE(finished_at, created_at) when finished_at is null", () => {
    makeTerminal("nofinish", null, 100); // created_at=100, finished_at=NULL
    expect(deleteTerminalBrowserTasksOlderThan(db, 1000)).toBe(1);
    expect(getBrowserTask(db, "nofinish")).toBeNull();
  });

  it("cascades the delete to child rows via the ON DELETE CASCADE FK", () => {
    makeTerminal("parent", 100, 50);
    db.prepare(
      `INSERT INTO browser_task_action_log
         (task_id, step_index, tool_name, args_json, outcome, duration_ms, at)
       VALUES ('parent', 0, 'navigate', '{}', 'ok', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO browser_task_clarifications
         (id, task_id, question, asked_at, deadline_at)
       VALUES ('cl1', 'parent', 'q?', 1, 2)`,
    ).run();
    db.prepare(
      `INSERT INTO browser_task_final_confirm_tokens
         (jti, token, task_id, action_summary, pre_screenshot_path, delivered_channels,
          issued_at, expires_at, status)
       VALUES ('j1', '!~aaaaaaaa', 'parent', 'do it', 'shot.png', '[]', 1, 2, 'pending')`,
    ).run();

    deleteTerminalBrowserTasksOlderThan(db, 1000);

    expect(db.prepare("SELECT COUNT(*) AS c FROM browser_task_action_log").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM browser_task_clarifications").get()).toEqual({ c: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM browser_task_final_confirm_tokens").get(),
    ).toEqual({ c: 0 });
  });
});
