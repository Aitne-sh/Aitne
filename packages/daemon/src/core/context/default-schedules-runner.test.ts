import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import { CONTEXT_RELATIVE_PATHS } from "../context-paths.js";
import { readRuntimeState } from "../../db/runtime-state.js";
import {
  buildDefaultSchedulesSnapshot,
  runDefaultSchedulesReconciler,
  DEFAULT_SCHEDULES_RECONCILER_LAST_RUN_KEY,
} from "./default-schedules-runner.js";

function makeContextDir(): string {
  return mkdtempSync(join(tmpdir(), "pa-default-schedules-runner-"));
}

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function writeManagement(contextDir: string, body: string): void {
  const dir = join(contextDir, "policies");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(contextDir, CONTEXT_RELATIVE_PATHS.rules.management),
    body,
    "utf-8",
  );
}

function seedRecurring(
  db: Database.Database,
  params: {
    taskType?: string;
    description: string;
    rule: object;
    context?: object;
    enabled?: boolean;
  },
): void {
  db.prepare(
    `INSERT INTO recurring_schedules
       (task_type, task_description, task_context, model, recurrence_rule, enabled)
     VALUES (?, ?, ?, 'sonnet', ?, ?)`,
  ).run(
    params.taskType ?? "dm_session",
    params.description,
    JSON.stringify(params.context ?? {}),
    JSON.stringify(params.rule),
    params.enabled === false ? 0 : 1,
  );
}

const VALID_FRONTMATTER = `---
type: rule
slug: management
owner: shared
updated: 2026-04-26
---

# Management rules

## Source of Truth

x

## Active Policies

_No active policies yet._
`;

describe("buildDefaultSchedulesSnapshot", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  it("returns [] when no rows are present", () => {
    expect(buildDefaultSchedulesSnapshot(db)).toEqual([]);
  });

  it("derives label from task_context.sub_flow when present", () => {
    seedRecurring(db, {
      description: "morning briefing — daily summary",
      rule: { frequency: "daily", time: "08:00", timezone: "America/New_York" },
      context: { sub_flow: "morning_briefing", pin_to_quiet_hours_end: true },
    });
    const snap = buildDefaultSchedulesSnapshot(db);
    expect(snap).toHaveLength(1);
    expect(snap[0].label).toBe("Morning briefing");
    expect(snap[0].subFlow).toBe("morning_briefing");
    expect(snap[0].pinnedToQuietHours).toBe(true);
    expect(snap[0].enabled).toBe(true);
    expect(snap[0].recurrenceRule).toEqual({
      frequency: "daily",
      time: "08:00",
      timezone: "America/New_York",
    });
  });

  it("treats malformed task_context as an empty object", () => {
    db.prepare(
      `INSERT INTO recurring_schedules
         (task_type, task_description, task_context, model, recurrence_rule, enabled)
       VALUES ('dm_session', 'bad ctx', 'NOT VALID JSON', 'sonnet', '{"frequency":"daily","time":"08:00"}', 1)`,
    ).run();
    const snap = buildDefaultSchedulesSnapshot(db);
    expect(snap).toHaveLength(1);
    expect(snap[0].subFlow).toBe(null);
    expect(snap[0].pinnedToQuietHours).toBe(false);
    expect(snap[0].label).toBe("bad ctx");
  });

  it("preserves daysOfWeek for weekly schedules so the rendered cadence is complete", () => {
    seedRecurring(db, {
      description: "weekly check-in — review",
      rule: {
        frequency: "weekly",
        time: "09:00",
        timezone: "America/New_York",
        daysOfWeek: [1, 3, 5],
      },
      context: { sub_flow: "weekly_checkin" },
    });
    const snap = buildDefaultSchedulesSnapshot(db);
    expect(snap).toHaveLength(1);
    expect(snap[0].recurrenceRule).toEqual({
      frequency: "weekly",
      time: "09:00",
      timezone: "America/New_York",
      daysOfWeek: [1, 3, 5],
    });
  });

  it("preserves daysOfMonth for monthly schedules", () => {
    seedRecurring(db, {
      description: "monthly review — day 1",
      rule: {
        frequency: "monthly",
        time: "10:00",
        daysOfMonth: [1, 15],
      },
      context: { sub_flow: "monthly_review" },
    });
    const snap = buildDefaultSchedulesSnapshot(db);
    expect(snap).toHaveLength(1);
    expect(snap[0].recurrenceRule).toEqual({
      frequency: "monthly",
      time: "10:00",
      daysOfMonth: [1, 15],
    });
  });

  it("falls back to a placeholder rule when recurrence_rule JSON is malformed", () => {
    db.prepare(
      `INSERT INTO recurring_schedules
         (task_type, task_description, task_context, model, recurrence_rule, enabled)
       VALUES ('dm_session', 'bad rule', '{}', 'sonnet', 'NOT VALID JSON', 1)`,
    ).run();
    const snap = buildDefaultSchedulesSnapshot(db);
    expect(snap).toHaveLength(1);
    // Coerced placeholder — formatRecurrenceLabel still renders this
    // without throwing instead of crashing the reconciler.
    expect(snap[0].recurrenceRule.frequency).toBe("daily");
    expect(snap[0].recurrenceRule.time).toBe("—");
  });

  // SCHEDULE_API_REDESIGN_PLAN §6.1 — hourly and onMissingDay must be
  // carried through parseRecurrenceRule, otherwise stored hourly rules
  // render as `daily —` in rules/management.md §B.
  it("preserves hourly frequency with intervalHours + minuteOfHour", () => {
    seedRecurring(db, {
      description: "hourly health check — every 2h",
      rule: {
        frequency: "hourly",
        intervalHours: 2,
        minuteOfHour: 30,
        timezone: "America/New_York",
      },
    });
    const snap = buildDefaultSchedulesSnapshot(db);
    expect(snap).toHaveLength(1);
    expect(snap[0].recurrenceRule).toEqual({
      frequency: "hourly",
      intervalHours: 2,
      minuteOfHour: 30,
      timezone: "America/New_York",
    });
  });

  it("preserves hourly frequency with no extra fields (defaults applied at render time)", () => {
    seedRecurring(db, {
      description: "hourly tick — defaults to every hour at :00",
      rule: { frequency: "hourly" },
    });
    const snap = buildDefaultSchedulesSnapshot(db);
    expect(snap).toHaveLength(1);
    expect(snap[0].recurrenceRule.frequency).toBe("hourly");
    // No `time` for hourly — the renderer reads intervalHours/minuteOfHour.
    expect(snap[0].recurrenceRule.time).toBeUndefined();
  });

  it("preserves onMissingDay for monthly schedules", () => {
    seedRecurring(db, {
      description: "month-end billing — 31st with skip policy",
      rule: {
        frequency: "monthly",
        time: "21:00",
        daysOfMonth: [31],
        onMissingDay: "skip",
      },
    });
    const snap = buildDefaultSchedulesSnapshot(db);
    expect(snap).toHaveLength(1);
    expect(snap[0].recurrenceRule).toEqual({
      frequency: "monthly",
      time: "21:00",
      daysOfMonth: [31],
      onMissingDay: "skip",
    });
  });

  it("drops onMissingDay on non-monthly frequencies (defensive filter)", () => {
    seedRecurring(db, {
      description: "weekly with bogus onMissingDay — must drop the field",
      rule: {
        frequency: "weekly",
        time: "09:00",
        daysOfWeek: [1],
        onMissingDay: "skip",
      },
    });
    const snap = buildDefaultSchedulesSnapshot(db);
    expect(snap).toHaveLength(1);
    // The validation layer rejects this combo, but if it somehow lands
    // in the DB (manual poke, schema-pre-redesign rows) the parser
    // drops the field so the mirror renders correctly.
    expect(snap[0].recurrenceRule).toEqual({
      frequency: "weekly",
      time: "09:00",
      daysOfWeek: [1],
    });
  });

  it("drops out-of-range intervalHours on hourly (defensive filter)", () => {
    seedRecurring(db, {
      description: "hourly with rogue intervalHours — must drop the field",
      rule: {
        frequency: "hourly",
        intervalHours: 99,
        minuteOfHour: 5,
      },
    });
    const snap = buildDefaultSchedulesSnapshot(db);
    expect(snap).toHaveLength(1);
    expect(snap[0].recurrenceRule).toEqual({
      frequency: "hourly",
      minuteOfHour: 5,
    });
  });

  it("falls back to 'daily' for an unrecognised frequency in stored rule", () => {
    seedRecurring(db, {
      description: "rogue frequency — must coerce to daily",
      rule: { frequency: "yearly", time: "09:00" },
    });
    const snap = buildDefaultSchedulesSnapshot(db);
    expect(snap).toHaveLength(1);
    expect(snap[0].recurrenceRule.frequency).toBe("daily");
    expect(snap[0].recurrenceRule.time).toBe("09:00");
  });
});

describe("runDefaultSchedulesReconciler", () => {
  let contextDir: string;
  let db: Database.Database;

  beforeEach(() => {
    contextDir = makeContextDir();
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    rmSync(contextDir, { recursive: true, force: true });
  });

  it("is a noop when management.md does not exist (skeleton seeder owns first creation)", async () => {
    seedRecurring(db, {
      description: "morning briefing — daily summary",
      rule: { frequency: "daily", time: "08:00", timezone: "America/New_York" },
      context: { sub_flow: "morning_briefing", pin_to_quiet_hours_end: true },
    });

    const record = await runDefaultSchedulesReconciler({
      db,
      contextDir,
      trigger: "manual" as const,
    });

    expect(record.result).toBe("noop");
    expect(
      existsSync(
        join(contextDir, CONTEXT_RELATIVE_PATHS.rules.management),
      ),
    ).toBe(false);
  });

  it("splices the rendered Default Schedules section into existing management.md", async () => {
    writeManagement(contextDir, VALID_FRONTMATTER);
    seedRecurring(db, {
      description: "morning briefing — daily summary",
      rule: { frequency: "daily", time: "08:00", timezone: "America/New_York" },
      context: { sub_flow: "morning_briefing", pin_to_quiet_hours_end: true },
    });

    const record = await runDefaultSchedulesReconciler({
      db,
      contextDir,
      trigger: "manual" as const,
    });

    expect(record.result).toBe("applied");
    const after = readFileSync(
      join(contextDir, CONTEXT_RELATIVE_PATHS.rules.management),
      "utf-8",
    );
    expect(after).toContain("## Default Schedules");
    expect(after).toContain("Morning briefing");
    expect(after).toContain("pinned to quiet_hours_end");
    // Active Policies section is preserved.
    expect(after).toContain("## Active Policies");

    const stored = readRuntimeState(
      db,
      DEFAULT_SCHEDULES_RECONCILER_LAST_RUN_KEY,
    );
    expect(stored).not.toBe(null);
  });

  it("short-circuits to noop when the rendered section already matches on-disk content", async () => {
    writeManagement(contextDir, VALID_FRONTMATTER);
    seedRecurring(db, {
      description: "morning briefing — daily summary",
      rule: { frequency: "daily", time: "08:00", timezone: "America/New_York" },
      context: { sub_flow: "morning_briefing", pin_to_quiet_hours_end: true },
    });

    // First run writes; second run with no DB change must be a noop.
    const first = await runDefaultSchedulesReconciler({
      db,
      contextDir,
      trigger: "manual" as const,
    });
    expect(first.result).toBe("applied");

    const second = await runDefaultSchedulesReconciler({
      db,
      contextDir,
      trigger: "manual" as const,
    });
    expect(second.result).toBe("noop");
  });
});
