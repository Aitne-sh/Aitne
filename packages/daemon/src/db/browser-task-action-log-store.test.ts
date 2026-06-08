import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import {
  insertBrowserTaskActionLog,
  listBrowserTaskActionLog,
  nextStepIndexFor,
  type InsertBrowserTaskActionLogInput,
} from "./browser-task-action-log-store.js";

let db: Database.Database;

function seedTask(id: string): void {
  db.prepare(
    `INSERT INTO browser_task
       (id, description, state, require_final_confirm, blocked_requests_count,
        extract_chars_total, created_at)
     VALUES (?, 'd', 'running', 1, 0, 0, 1)`,
  ).run(id);
}

function input(
  overrides: Partial<InsertBrowserTaskActionLogInput> = {},
): InsertBrowserTaskActionLogInput {
  return {
    taskId: "task-1",
    stepIndex: 0,
    toolName: "navigate",
    args: { url: "https://example.com" },
    outcome: "ok",
    durationMs: 12,
    at: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  seedTask("task-1");
});

afterEach(() => {
  db.close();
});

describe("insertBrowserTaskActionLog", () => {
  it("round-trips a row with structured args and defaults blockedReason/screenshotKey to null", () => {
    const row = insertBrowserTaskActionLog(db, input());
    expect(row).toMatchObject({
      taskId: "task-1",
      stepIndex: 0,
      toolName: "navigate",
      args: { url: "https://example.com" },
      outcome: "ok",
      blockedReason: null,
      screenshotKey: null,
      durationMs: 12,
      at: 1000,
    });
    expect(row.id).toBeGreaterThan(0);
  });

  it("persists blockedReason and screenshotKey when provided", () => {
    const row = insertBrowserTaskActionLog(
      db,
      input({ outcome: "allowlist_block", blockedReason: "host not allowed", screenshotKey: "task-1/0.png" }),
    );
    expect(row.blockedReason).toBe("host not allowed");
    expect(row.screenshotKey).toBe("task-1/0.png");
  });

  it("stores null args as JSON null and reads it back as null", () => {
    const row = insertBrowserTaskActionLog(db, input({ args: undefined }));
    expect(row.args).toBeNull();
  });
});

describe("fromDbRow args resilience", () => {
  it("returns the raw string when args_json is not valid JSON", () => {
    db.prepare(
      `INSERT INTO browser_task_action_log
         (task_id, step_index, tool_name, args_json, outcome, duration_ms, at)
       VALUES ('task-1', 0, 'click', 'not-json', 'ok', 1, 1)`,
    ).run();
    expect(listBrowserTaskActionLog(db, "task-1")[0].args).toBe("not-json");
  });
});

describe("nextStepIndexFor", () => {
  it("returns 0 when the task has no rows yet", () => {
    expect(nextStepIndexFor(db, "task-1")).toBe(0);
  });

  it("returns max(step_index) + 1", () => {
    insertBrowserTaskActionLog(db, input({ stepIndex: 0 }));
    insertBrowserTaskActionLog(db, input({ stepIndex: 4 }));
    expect(nextStepIndexFor(db, "task-1")).toBe(5);
  });

  it("is scoped per task", () => {
    seedTask("task-2");
    insertBrowserTaskActionLog(db, input({ taskId: "task-1", stepIndex: 9 }));
    expect(nextStepIndexFor(db, "task-2")).toBe(0);
  });
});

describe("listBrowserTaskActionLog", () => {
  it("orders rows by step_index ASC and is scoped per task", () => {
    seedTask("task-2");
    insertBrowserTaskActionLog(db, input({ stepIndex: 2 }));
    insertBrowserTaskActionLog(db, input({ stepIndex: 0 }));
    insertBrowserTaskActionLog(db, input({ stepIndex: 1 }));
    insertBrowserTaskActionLog(db, input({ taskId: "task-2", stepIndex: 0 }));

    expect(listBrowserTaskActionLog(db, "task-1").map((r) => r.stepIndex)).toEqual([0, 1, 2]);
    expect(listBrowserTaskActionLog(db, "task-2")).toHaveLength(1);
  });
});
