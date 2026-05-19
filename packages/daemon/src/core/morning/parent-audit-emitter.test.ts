import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import {
  emitMorningRoutineParentAuditRow,
  PARENT_AUDIT_ACTION_TYPE,
  type ParentAuditEmitterInputs,
  type StageSummary,
  type TodayMdHealth,
} from "./parent-audit-emitter.js";

const STAGE_A_OK: StageSummary = { cost_usd: 0.32, num_turns: 12, result: "success" };
const STAGE_B_OK: StageSummary = { cost_usd: 0.07, num_turns: 5, result: "success" };
const START = new Date("2026-05-15T04:00:00.000Z");
const END = new Date("2026-05-15T04:02:11.000Z");

function makeInputs(overrides: Partial<ParentAuditEmitterInputs> = {}): ParentAuditEmitterInputs {
  return {
    correlationId: "corr-1",
    stageA: STAGE_A_OK,
    stageB: STAGE_B_OK,
    todayMdHealth: "fresh",
    startedAt: START,
    completedAt: END,
    ...overrides,
  };
}

describe("emitMorningRoutineParentAuditRow — happy path", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });
  afterEach(() => {
    db.close();
  });

  it("INSERTs one roll-up row with zeroed cost / turns (sums live in detail), keyed on the gate's action_type", () => {
    // The parent row is a marker for `morningRoutineRanToday`. Stage A /
    // Stage B `agent_actions` rows carry the actual cost / turns and are
    // what `autonomousDailyCostCapUsd`'s SUM aggregates over — zeroing
    // the parent row's numeric columns avoids double-counting per
    // morning routine. The aggregates remain in `detail` for the
    // dashboard's cost-attribution UI and `pnpm audit`.
    const result = emitMorningRoutineParentAuditRow(db, makeInputs());
    expect(result.emitted).toBe(true);
    const rows = db
      .prepare(
        `SELECT id, event_id, action_type, trigger, result, cost_usd, num_turns,
                duration_ms, started_at, completed_at, backend, detail
           FROM agent_actions`,
      )
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_id: "corr-1",
      action_type: PARENT_AUDIT_ACTION_TYPE,
      trigger: "autonomous",
      result: "success",
      cost_usd: 0,
      num_turns: 0,
      duration_ms: 2 * 60 * 1000 + 11 * 1000,
      started_at: "2026-05-15 04:00:00",
      completed_at: "2026-05-15 04:02:11",
      backend: null,
    });
    const detail = JSON.parse(String(rows[0].detail));
    expect(detail).toEqual({
      stageA: { result: "success", cost_usd: 0.32, num_turns: 12 },
      stageB: { result: "success", cost_usd: 0.07, num_turns: 5 },
      todayMdHealth: "fresh",
      totalCostUsd: 0.39,
      totalNumTurns: 17,
    });
  });

  it("handles missing Stage B (null) — detail aggregates reflect Stage A only; row columns stay zero", () => {
    const result = emitMorningRoutineParentAuditRow(db, makeInputs({ stageB: null }));
    expect(result.emitted).toBe(true);
    const row = db.prepare("SELECT cost_usd, num_turns, detail FROM agent_actions").get() as {
      cost_usd: number;
      num_turns: number;
      detail: string;
    };
    expect(row.cost_usd).toBe(0);
    expect(row.num_turns).toBe(0);
    const detail = JSON.parse(row.detail);
    expect(detail.stageB).toBeNull();
    expect(detail.totalCostUsd).toBe(0.32);
    expect(detail.totalNumTurns).toBe(12);
  });

  it("treats null / NaN / Infinity cost+turns as zero in the detail aggregates (row columns are always zero)", () => {
    emitMorningRoutineParentAuditRow(
      db,
      makeInputs({
        stageA: { cost_usd: null, num_turns: null, result: "success" },
        stageB: { cost_usd: Number.NaN, num_turns: Number.POSITIVE_INFINITY, result: "success" },
      }),
    );
    const row = db.prepare("SELECT cost_usd, num_turns, detail FROM agent_actions").get() as {
      cost_usd: number;
      num_turns: number;
      detail: string;
    };
    expect(row.cost_usd).toBe(0);
    expect(row.num_turns).toBe(0);
    const detail = JSON.parse(row.detail);
    expect(detail.totalCostUsd).toBe(0);
    expect(detail.totalNumTurns).toBe(0);
  });

  it("rounds the aggregate cost in `detail` to 6 decimals to keep floating-point noise out of observability", () => {
    emitMorningRoutineParentAuditRow(
      db,
      makeInputs({
        stageA: { cost_usd: 0.1, num_turns: 1, result: "success" },
        stageB: { cost_usd: 0.2, num_turns: 1, result: "success" },
      }),
    );
    const row = db.prepare("SELECT detail FROM agent_actions").get() as { detail: string };
    expect(JSON.parse(row.detail).totalCostUsd).toBe(0.3);
  });

  it("zeroed row columns keep the SUM(cost_usd) gate query out of double-count territory", () => {
    // Simulate a typical morning: orchestrator wrote Stage A / Stage B
    // rows via processResult before emitting the parent. Cap query must
    // see Stage A + Stage B, NOT (Stage A + Stage B) + sum-on-parent.
    db.prepare(
      `INSERT INTO agent_actions
         (event_id, action_type, trigger, result, cost_usd, num_turns, started_at)
       VALUES (?, 'routine.morning_routine_today',   'autonomous', 'success', 0.32, 12, '2026-05-15 04:00:01'),
              (?, 'routine.morning_routine_journal', 'autonomous', 'success', 0.07,  5, '2026-05-15 04:00:01')`,
    ).run("corr-1", "corr-1");
    emitMorningRoutineParentAuditRow(db, makeInputs());
    const total = (db
      .prepare(
        "SELECT COALESCE(SUM(cost_usd), 0) AS s FROM agent_actions WHERE trigger='autonomous'",
      )
      .get() as { s: number }).s;
    expect(total).toBeCloseTo(0.39, 6);
  });

  it("clamps duration_ms to zero when completedAt is earlier than startedAt", () => {
    emitMorningRoutineParentAuditRow(
      db,
      makeInputs({ startedAt: END, completedAt: START }),
    );
    expect(
      (db.prepare("SELECT duration_ms FROM agent_actions").get() as { duration_ms: number })
        .duration_ms,
    ).toBe(0);
  });

  it("stores backend label on the row when supplied", () => {
    emitMorningRoutineParentAuditRow(db, makeInputs({ backend: "claude" }));
    expect(
      (db.prepare("SELECT backend FROM agent_actions").get() as { backend: string }).backend,
    ).toBe("claude");
  });

  it("includes Stage B's terminal result in detail even when it failed (does not block emit)", () => {
    emitMorningRoutineParentAuditRow(
      db,
      makeInputs({ stageB: { cost_usd: 0.04, num_turns: 2, result: "failed" } }),
    );
    const detail = JSON.parse(
      (db.prepare("SELECT detail FROM agent_actions").get() as { detail: string }).detail,
    );
    expect(detail.stageB).toEqual({ result: "failed", cost_usd: 0.04, num_turns: 2 });
  });

  it("returns the inserted row id matching the row in agent_actions", () => {
    const result = emitMorningRoutineParentAuditRow(db, makeInputs());
    expect(result).toMatchObject({ emitted: true });
    if (!result.emitted) return; // narrowing for the rest of the assertion
    const rowId = (db.prepare("SELECT id FROM agent_actions").get() as { id: number }).id;
    expect(result.insertedId).toBe(rowId);
  });

  it("truncates sub-second precision from startedAt / completedAt to fit SQLite's `YYYY-MM-DD HH:MM:SS` shape", () => {
    // The pre-routine gate's SELECT compares `started_at` against
    // `datetime('now')`-shaped strings — millisecond precision in the
    // ISO source must be dropped so format stays consistent across all
    // agent_actions rows. Pin the byte-shape so a refactor that keeps
    // `.500Z` would land as a failing test.
    emitMorningRoutineParentAuditRow(
      db,
      makeInputs({
        startedAt: new Date("2026-05-15T04:00:00.500Z"),
        completedAt: new Date("2026-05-15T04:02:11.999Z"),
      }),
    );
    const row = db
      .prepare("SELECT started_at, completed_at FROM agent_actions")
      .get() as { started_at: string; completed_at: string };
    expect(row.started_at).toBe("2026-05-15 04:00:00");
    expect(row.completed_at).toBe("2026-05-15 04:02:11");
  });

  it("preserves an empty-string backend label rather than coercing to NULL", () => {
    // `inputs.backend ?? null` only coalesces null/undefined — passing
    // `""` is stored verbatim. Pin this so a downstream consumer that
    // sees `""` knows it was deliberate (the caller chose to label
    // with an explicit empty string) rather than accidentally falling
    // through `??`. If we want to coerce `""` → NULL the change should
    // land via a clear API tweak, not a silent stringy-truthy refactor.
    emitMorningRoutineParentAuditRow(db, makeInputs({ backend: "" }));
    expect(
      (db.prepare("SELECT backend FROM agent_actions").get() as { backend: string | null }).backend,
    ).toBe("");
  });

  it("emits a second row on retry — the gate-side SELECT is COUNT > 0, so duplicate inserts are tolerated", () => {
    // The emitter does NOT dedupe on (event_id, action_type). A retry
    // path that re-fires `emitMorningRoutineParentAuditRow` for the
    // same correlationId leaves two rows. The pre-routine gate reads
    // `morningRoutineRanToday` via existence, so this is acceptable;
    // pin it so a tempting "uniqueness" refactor that would suppress
    // the second insert announces itself.
    const first = emitMorningRoutineParentAuditRow(db, makeInputs());
    const second = emitMorningRoutineParentAuditRow(db, makeInputs());
    expect(first.emitted && second.emitted).toBe(true);
    const count = (db
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_actions
          WHERE action_type = ? AND event_id = ?`,
      )
      .get(PARENT_AUDIT_ACTION_TYPE, "corr-1") as { n: number }).n;
    expect(count).toBe(2);
  });
});

describe("emitMorningRoutineParentAuditRow — skip gates", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });
  afterEach(() => {
    db.close();
  });

  function expectNoRow(): void {
    const n = (db.prepare("SELECT COUNT(*) AS n FROM agent_actions").get() as { n: number }).n;
    expect(n).toBe(0);
  }

  it("skips with stage_a_row_missing when Stage A is null", () => {
    const result = emitMorningRoutineParentAuditRow(db, makeInputs({ stageA: null }));
    expect(result).toEqual({ emitted: false, reason: "stage_a_row_missing" });
    expectNoRow();
  });

  it.each<StageSummary["result"]>(["failed", "partial", "skipped", "in_progress"])(
    "skips with stage_a_not_success when Stage A.result is %s",
    (badResult) => {
      const result = emitMorningRoutineParentAuditRow(
        db,
        makeInputs({ stageA: { cost_usd: 0.1, num_turns: 3, result: badResult } }),
      );
      expect(result).toEqual({ emitted: false, reason: "stage_a_not_success" });
      expectNoRow();
    },
  );

  it.each<[TodayMdHealth, string]>([
    ["missing", "today_md_missing"],
    ["no_h1_date", "today_md_no_h1_date"],
    ["wrong_date", "today_md_wrong_date"],
  ])("skips on todayMdHealth=%s with reason=%s", (health, reason) => {
    const result = emitMorningRoutineParentAuditRow(db, makeInputs({ todayMdHealth: health }));
    expect(result).toEqual({ emitted: false, reason });
    expectNoRow();
  });
});
