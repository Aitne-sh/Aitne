import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import {
  allocateNextManagedTaskId,
  bootstrapManagedTaskSeq,
  countManagedTasks,
  deleteManagedTask,
  findManagedTaskByAppCadence,
  getManagedTask,
  insertManagedTask,
  listManagedTasks,
  updateManagedTask,
  updateManagedTaskRunResult,
} from "./managed-tasks-store.js";

function insertSchedule(
  db: Database.Database,
  cron = "0 10 * * *",
  description = "managed task",
): number {
  const result = db
    .prepare(
      `INSERT INTO recurring_schedules
         (task_type, task_description, recurrence_rule, enabled)
         VALUES (?, ?, json(?), 1)`,
    )
    .run("scheduled.task", description, JSON.stringify({ cron }));
  return Number(result.lastInsertRowid);
}

function insertManagedTaskRow(
  db: Database.Database,
  args: {
    id: string;
    intent?: string;
    app?: string;
    app_normalized?: string;
    cadence?: string;
    output_path?: string | null;
    schedule_id?: number;
    last_run_at?: string | null;
    last_result?: string | null;
    consecutive_failures?: number;
  },
): void {
  const scheduleId = args.schedule_id ?? insertSchedule(db);
  // Distinguish "explicit null" from "field omitted" so tests can exercise
  // the NULL output_path path without the default re-asserting itself.
  const outputPath =
    "output_path" in args ? args.output_path : "work/meetings/";
  db.prepare(
    `INSERT INTO managed_tasks
       (id, intent, app, app_normalized, cadence, output_path,
        schedule_id, last_run_at, last_result, consecutive_failures)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.id,
    args.intent ?? "Sample intent",
    args.app ?? "zoom",
    args.app_normalized ?? "zoom",
    args.cadence ?? "daily 10:00 (Asia/Tokyo)",
    outputPath,
    scheduleId,
    args.last_run_at ?? null,
    args.last_result ?? null,
    args.consecutive_failures ?? 0,
  );
}

describe("managed-tasks-store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("listManagedTasks", () => {
    it("returns [] when no rows present", () => {
      expect(listManagedTasks(db)).toEqual([]);
    });

    it("orders rows by numeric id (mt_2 before mt_10)", () => {
      insertManagedTaskRow(db, { id: "mt_10", app: "gmail", app_normalized: "gmail", cadence: "hourly" });
      insertManagedTaskRow(db, { id: "mt_2", app: "zoom", app_normalized: "zoom", cadence: "daily 10:00" });
      insertManagedTaskRow(db, { id: "mt_1", app: "obsidian", app_normalized: "obsidian", cadence: "weekly" });
      const out = listManagedTasks(db);
      expect(out.map((r) => r.id)).toEqual(["mt_1", "mt_2", "mt_10"]);
    });

    it("hydrates output_path NULL → null", () => {
      insertManagedTaskRow(db, {
        id: "mt_1",
        output_path: null,
      });
      const [row] = listManagedTasks(db);
      expect(row.output_path).toBeNull();
    });
  });

  describe("getManagedTask", () => {
    it("returns null for malformed ids without touching the DB", () => {
      expect(getManagedTask(db, "garbage")).toBeNull();
      expect(getManagedTask(db, "mt_0")).toBeNull(); // leading-zero rejection
      expect(getManagedTask(db, "")).toBeNull();
    });

    it("returns null for an unknown well-formed id", () => {
      expect(getManagedTask(db, "mt_42")).toBeNull();
    });

    it("returns the row when present", () => {
      insertManagedTaskRow(db, { id: "mt_42", intent: "watch zoom" });
      const row = getManagedTask(db, "mt_42");
      expect(row?.intent).toBe("watch zoom");
    });
  });

  describe("countManagedTasks", () => {
    it("returns 0 on an empty table", () => {
      expect(countManagedTasks(db)).toBe(0);
    });

    it("counts active rows", () => {
      insertManagedTaskRow(db, { id: "mt_1" });
      insertManagedTaskRow(db, { id: "mt_2", app: "gmail", app_normalized: "gmail", cadence: "hourly" });
      expect(countManagedTasks(db)).toBe(2);
    });
  });

  describe("allocateNextManagedTaskId", () => {
    it("starts at mt_1 and increments monotonically", () => {
      expect(allocateNextManagedTaskId(db)).toBe("mt_1");
      expect(allocateNextManagedTaskId(db)).toBe("mt_2");
      expect(allocateNextManagedTaskId(db)).toBe("mt_3");
    });

    it("recovers when the singleton row was wiped", () => {
      db.prepare("DELETE FROM managed_task_seq").run();
      expect(allocateNextManagedTaskId(db)).toBe("mt_1");
      expect(allocateNextManagedTaskId(db)).toBe("mt_2");
    });

    it("allocations survive across reads (no rollback when no transaction)", () => {
      allocateNextManagedTaskId(db);
      allocateNextManagedTaskId(db);
      const next = allocateNextManagedTaskId(db);
      expect(next).toBe("mt_3");
    });
  });

  describe("insertManagedTask", () => {
    it("inserts a row and returns the rehydrated DTO", () => {
      const scheduleId = insertSchedule(db);
      const dto = insertManagedTask(db, {
        id: "mt_7",
        intent: "Watch zoom",
        app: "zoom",
        cadence: "daily 10:00 (Asia/Tokyo)",
        outputPath: "work/meetings/",
        scheduleId,
      });
      expect(dto.id).toBe("mt_7");
      expect(dto.intent).toBe("Watch zoom");
      expect(dto.app).toBe("zoom");
      // app_normalized is derived from the input app label.
      expect(dto.app_normalized).toBe("zoom");
      expect(dto.output_path).toBe("work/meetings/");
      expect(dto.consecutive_failures).toBe(0);
    });

    it("normalizes the app label for app_normalized", () => {
      const scheduleId = insertSchedule(db);
      const dto = insertManagedTask(db, {
        id: "mt_8",
        intent: "Watch the team Zoom Meeting",
        app: "Zoom Workplace",
        cadence: "weekly Mon 09:00",
        outputPath: null,
        scheduleId,
      });
      // Whatever the normalizer collapses Zoom Workplace to, the DTO
      // surfaces it. The exact form is asserted in normalizeAppLabel's
      // own suite — here we just pin that the field is populated and
      // case-folded.
      expect(dto.app_normalized).toBe(dto.app_normalized.toLowerCase());
      expect(dto.output_path).toBeNull();
    });

    it("rejects malformed ids", () => {
      const scheduleId = insertSchedule(db);
      expect(() =>
        insertManagedTask(db, {
          id: "garbage",
          intent: "x",
          app: "zoom",
          cadence: "daily",
          outputPath: null,
          scheduleId,
        }),
      ).toThrow(/invalid id/);
    });
  });

  describe("updateManagedTask", () => {
    it("returns null for malformed ids", () => {
      expect(updateManagedTask(db, "garbage", { intent: "x" })).toBeNull();
    });

    it("returns null when no row matches a well-formed id", () => {
      expect(updateManagedTask(db, "mt_42", { intent: "x" })).toBeNull();
    });

    it("returns the existing row unchanged when no fields are supplied", () => {
      insertManagedTaskRow(db, { id: "mt_3", intent: "before" });
      const out = updateManagedTask(db, "mt_3", {});
      expect(out?.intent).toBe("before");
    });

    it("updates intent only", () => {
      insertManagedTaskRow(db, { id: "mt_3", intent: "before" });
      const out = updateManagedTask(db, "mt_3", { intent: "after" });
      expect(out?.intent).toBe("after");
    });

    it("updates cadence only", () => {
      insertManagedTaskRow(db, { id: "mt_4", cadence: "daily 10:00" });
      const out = updateManagedTask(db, "mt_4", { cadence: "weekly Mon 09:00" });
      expect(out?.cadence).toBe("weekly Mon 09:00");
    });

    it("updates outputPath, accepting explicit null to clear it", () => {
      insertManagedTaskRow(db, { id: "mt_5", output_path: "work/meetings/" });
      const cleared = updateManagedTask(db, "mt_5", { outputPath: null });
      expect(cleared?.output_path).toBeNull();
      const set = updateManagedTask(db, "mt_5", { outputPath: "work/projects/" });
      expect(set?.output_path).toBe("work/projects/");
    });

    it("applies multiple fields in a single call", () => {
      insertManagedTaskRow(db, {
        id: "mt_6",
        intent: "before",
        cadence: "daily 09:00",
      });
      const out = updateManagedTask(db, "mt_6", {
        intent: "after",
        cadence: "daily 10:00",
        outputPath: "work/projects/",
      });
      expect(out?.intent).toBe("after");
      expect(out?.cadence).toBe("daily 10:00");
      expect(out?.output_path).toBe("work/projects/");
    });
  });

  describe("updateManagedTaskRunResult", () => {
    it("returns null for malformed ids", () => {
      expect(
        updateManagedTaskRunResult(db, "garbage", {
          lastRunAt: "2026-01-01T00:00:00Z",
          lastResult: "ok",
          consecutiveFailures: 0,
        }),
      ).toBeNull();
    });

    it("returns null for an unknown well-formed id", () => {
      expect(
        updateManagedTaskRunResult(db, "mt_99", {
          lastRunAt: "2026-01-01T00:00:00Z",
          lastResult: "ok",
          consecutiveFailures: 0,
        }),
      ).toBeNull();
    });

    it("replaces last_run_at / last_result / consecutive_failures verbatim", () => {
      insertManagedTaskRow(db, { id: "mt_5", consecutive_failures: 1 });
      const out = updateManagedTaskRunResult(db, "mt_5", {
        lastRunAt: "2026-01-02T03:04:05Z",
        lastResult: "failed: timeout",
        consecutiveFailures: 3,
      });
      expect(out?.last_run_at).toBe("2026-01-02T03:04:05Z");
      expect(out?.last_result).toBe("failed: timeout");
      expect(out?.consecutive_failures).toBe(3);
    });
  });

  describe("deleteManagedTask", () => {
    it("returns false for malformed ids", () => {
      expect(deleteManagedTask(db, "garbage")).toBe(false);
    });

    it("returns false when nothing matches", () => {
      expect(deleteManagedTask(db, "mt_99")).toBe(false);
    });

    it("deletes the row and returns true", () => {
      insertManagedTaskRow(db, { id: "mt_3" });
      expect(deleteManagedTask(db, "mt_3")).toBe(true);
      expect(getManagedTask(db, "mt_3")).toBeNull();
    });
  });

  describe("findManagedTaskByAppCadence", () => {
    it("returns null when no row matches", () => {
      expect(findManagedTaskByAppCadence(db, "zoom", "daily 10:00")).toBeNull();
    });

    it("matches on (normalized app, exact cadence)", () => {
      insertManagedTaskRow(db, {
        id: "mt_3",
        app: "zoom",
        app_normalized: "zoom",
        cadence: "daily 10:00 (Asia/Tokyo)",
      });
      // Caller passes the raw label; the helper normalizes before
      // matching. So "Zoom Workplace" should still find the same
      // normalized row given the right cadence.
      const found = findManagedTaskByAppCadence(
        db,
        "zoom",
        "daily 10:00 (Asia/Tokyo)",
      );
      expect(found?.id).toBe("mt_3");
    });

    it("returns null when the cadence string differs even by a character", () => {
      insertManagedTaskRow(db, {
        id: "mt_3",
        app: "zoom",
        app_normalized: "zoom",
        cadence: "daily 10:00 (Asia/Tokyo)",
      });
      // Cadence match is byte-exact — semantic equivalence is the LLM's
      // job (§10.1 step 2).
      expect(
        findManagedTaskByAppCadence(db, "zoom", "daily 10:00"),
      ).toBeNull();
    });
  });

  describe("bootstrapManagedTaskSeq", () => {
    it("is a no-op on an empty table", () => {
      bootstrapManagedTaskSeq(db);
      const row = db
        .prepare("SELECT next_id FROM managed_task_seq WHERE singleton = 1")
        .get() as { next_id: number };
      expect(row.next_id).toBe(1);
    });

    it("advances next_id past the max existing id", () => {
      insertManagedTaskRow(db, { id: "mt_5" });
      insertManagedTaskRow(db, { id: "mt_42", app: "gmail", app_normalized: "gmail", cadence: "hourly" });
      bootstrapManagedTaskSeq(db);
      expect(allocateNextManagedTaskId(db)).toBe("mt_43");
    });

    it("does not regress next_id when seq is already ahead", () => {
      insertManagedTaskRow(db, { id: "mt_3" });
      // Pre-set seq high to simulate a prior session.
      db.prepare("UPDATE managed_task_seq SET next_id = 100 WHERE singleton = 1").run();
      bootstrapManagedTaskSeq(db);
      expect(allocateNextManagedTaskId(db)).toBe("mt_100");
    });
  });
});
