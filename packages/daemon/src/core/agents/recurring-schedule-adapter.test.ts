import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

import { applySchema } from "../../db/schema.js";
import {
  createRecurringSchedule,
  getRecurringSchedule,
} from "../../db/recurring-schedules.js";
import {
  createRecurringSchedulePort,
  recurrenceRuleToSpec,
  specToRecurrenceRule,
} from "./recurring-schedule-adapter.js";
import type { AgentRecurrenceSpec } from "./recurrence-convert.js";

const TZ = "America/New_York";

describe("recurring-schedule-adapter — pure mappers", () => {
  describe("recurrenceRuleToSpec", () => {
    it("maps a daily rule", () => {
      expect(
        recurrenceRuleToSpec({ frequency: "daily", time: "09:00", timezone: TZ }, "UTC"),
      ).toEqual({ frequency: "daily", time: "09:00", timezone: TZ });
    });

    it("maps a weekly rule with daysOfWeek", () => {
      expect(
        recurrenceRuleToSpec(
          { frequency: "weekly", time: "08:30", timezone: TZ, daysOfWeek: [1, 3, 5] },
          "UTC",
        ),
      ).toEqual({
        frequency: "weekly",
        time: "08:30",
        timezone: TZ,
        daysOfWeek: [1, 3, 5],
      });
    });

    it("maps a weekly rule with no daysOfWeek to an empty list", () => {
      expect(
        recurrenceRuleToSpec({ frequency: "weekly", time: "08:30", timezone: TZ }, "UTC"),
      ).toEqual({ frequency: "weekly", time: "08:30", timezone: TZ, daysOfWeek: [] });
    });

    it("maps a monthly rule with daysOfMonth", () => {
      expect(
        recurrenceRuleToSpec(
          { frequency: "monthly", time: "07:00", timezone: TZ, daysOfMonth: [1, 15] },
          "UTC",
        ),
      ).toEqual({
        frequency: "monthly",
        time: "07:00",
        timezone: TZ,
        daysOfMonth: [1, 15],
      });
    });

    it("maps a monthly rule with no daysOfMonth to an empty list", () => {
      expect(
        recurrenceRuleToSpec({ frequency: "monthly", time: "07:00", timezone: TZ }, "UTC"),
      ).toEqual({ frequency: "monthly", time: "07:00", timezone: TZ, daysOfMonth: [] });
    });

    it("maps an hourly rule to an hourly spec", () => {
      expect(
        recurrenceRuleToSpec(
          { frequency: "hourly", intervalHours: 2, minuteOfHour: 15, timezone: TZ },
          "UTC",
        ),
      ).toEqual({ frequency: "hourly", intervalHours: 2, minuteOfHour: 15, timezone: TZ });
    });

    it("defaults hourly intervalHours / minuteOfHour when the rule omits them", () => {
      expect(
        recurrenceRuleToSpec({ frequency: "hourly", timezone: TZ } as never, "UTC"),
      ).toEqual({ frequency: "hourly", intervalHours: 1, minuteOfHour: 0, timezone: TZ });
    });

    it("falls back to the supplied timezone when the rule omits one", () => {
      const spec = recurrenceRuleToSpec(
        { frequency: "daily", time: "09:00" } as never,
        "Asia/Tokyo",
      );
      expect(spec?.timezone).toBe("Asia/Tokyo");
    });

    it("falls back to 00:00 when the rule omits time", () => {
      const spec = recurrenceRuleToSpec(
        { frequency: "daily", timezone: TZ } as never,
        "UTC",
      );
      expect(spec?.time).toBe("00:00");
    });
  });

  describe("specToRecurrenceRule", () => {
    it("round-trips hourly", () => {
      const spec: AgentRecurrenceSpec = {
        frequency: "hourly",
        intervalHours: 3,
        minuteOfHour: 15,
        timezone: TZ,
      };
      expect(specToRecurrenceRule(spec)).toEqual({
        frequency: "hourly",
        intervalHours: 3,
        minuteOfHour: 15,
        timezone: TZ,
      });
    });

    it("defaults hourly intervalHours / minuteOfHour when the spec omits them", () => {
      expect(specToRecurrenceRule({ frequency: "hourly", timezone: TZ })).toEqual({
        frequency: "hourly",
        intervalHours: 1,
        minuteOfHour: 0,
        timezone: TZ,
      });
    });

    it("defaults a timed spec with no time to midnight", () => {
      expect(specToRecurrenceRule({ frequency: "daily", timezone: TZ }).time).toBe("00:00");
    });

    it("round-trips daily", () => {
      const spec: AgentRecurrenceSpec = { frequency: "daily", time: "09:00", timezone: TZ };
      expect(specToRecurrenceRule(spec)).toEqual({
        frequency: "daily",
        time: "09:00",
        timezone: TZ,
      });
    });

    it("round-trips weekly with daysOfWeek", () => {
      const spec: AgentRecurrenceSpec = {
        frequency: "weekly",
        time: "08:30",
        timezone: TZ,
        daysOfWeek: [2, 4],
      };
      expect(specToRecurrenceRule(spec)).toEqual({
        frequency: "weekly",
        time: "08:30",
        timezone: TZ,
        daysOfWeek: [2, 4],
      });
    });

    it("round-trips weekly with no daysOfWeek to an empty list", () => {
      const spec: AgentRecurrenceSpec = { frequency: "weekly", time: "08:30", timezone: TZ };
      expect(specToRecurrenceRule(spec)).toEqual({
        frequency: "weekly",
        time: "08:30",
        timezone: TZ,
        daysOfWeek: [],
      });
    });

    it("round-trips monthly with daysOfMonth", () => {
      const spec: AgentRecurrenceSpec = {
        frequency: "monthly",
        time: "07:00",
        timezone: TZ,
        daysOfMonth: [1, 15],
      };
      expect(specToRecurrenceRule(spec)).toEqual({
        frequency: "monthly",
        time: "07:00",
        timezone: TZ,
        daysOfMonth: [1, 15],
      });
    });

    it("round-trips monthly with no daysOfMonth to an empty list", () => {
      const spec: AgentRecurrenceSpec = { frequency: "monthly", time: "07:00", timezone: TZ };
      expect(specToRecurrenceRule(spec)).toEqual({
        frequency: "monthly",
        time: "07:00",
        timezone: TZ,
        daysOfMonth: [],
      });
    });
  });
});

describe("recurring-schedule-adapter — port over the DB", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("create() inserts a recurring row and returns its id", () => {
    const port = createRecurringSchedulePort(db, "UTC");
    const id = port.create({
      enabled: true,
      taskType: "agent.task",
      description: "Daily digest",
      prompt: "Compose the daily digest",
      model: null,
      tier: null,
      backendId: null,
      recurrence: { frequency: "daily", time: "09:00", timezone: TZ },
    });
    expect(id).toBeGreaterThan(0);
    const dto = getRecurringSchedule(db, id);
    expect(dto?.taskType).toBe("agent.task");
    expect(dto?.prompt).toBe("Compose the daily digest");
    expect(dto?.recurrenceRule.frequency).toBe("daily");
  });

  it("create() forwards model/tier/backend pins when present", () => {
    const port = createRecurringSchedulePort(db, "UTC");
    const id = port.create({
      enabled: true,
      taskType: "agent.task",
      description: "Pinned task",
      prompt: null,
      model: "claude-opus-4-8",
      tier: "high",
      backendId: "claude",
      recurrence: { frequency: "weekly", time: "08:00", timezone: TZ, daysOfWeek: [1] },
    });
    const dto = getRecurringSchedule(db, id);
    expect(dto?.model).toBe("claude-opus-4-8");
    expect(dto?.tier).toBe("high");
    expect(dto?.backendId).toBe("claude");
    expect(dto?.prompt).toBeNull();
  });

  it("create() forwards a disabled (§6.4-resolved) enabled state", () => {
    const port = createRecurringSchedulePort(db, "UTC");
    const id = port.create({
      enabled: false,
      taskType: "agent.task",
      description: "Disabled agent",
      prompt: null,
      model: null,
      tier: null,
      backendId: null,
      recurrence: { frequency: "daily", time: "09:00", timezone: TZ },
    });
    expect(getRecurringSchedule(db, id)?.enabled).toBe(false);
  });

  it("list() maps rows to AgentRecurrenceSpec, including hourly", () => {
    const port = createRecurringSchedulePort(db, "UTC");
    port.create({
      enabled: true,
      taskType: "agent.task",
      description: "Daily",
      prompt: null,
      model: null,
      tier: null,
      backendId: null,
      recurrence: { frequency: "daily", time: "09:00", timezone: TZ },
    });
    // An hourly recurring row now maps to an hourly spec rather than being dropped.
    createRecurringSchedule(db, {
      taskType: "agent.task",
      description: "Hourly",
      recurrenceRule: { frequency: "hourly", intervalHours: 1, minuteOfHour: 0, timezone: TZ },
    });

    const rows = port.list();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.recurrence.frequency).sort()).toEqual(["daily", "hourly"]);
  });

  it("get() returns the mapped row (incl. hourly), null for missing", () => {
    const port = createRecurringSchedulePort(db, "UTC");
    const id = port.create({
      enabled: true,
      taskType: "agent.task",
      description: "Daily",
      prompt: null,
      model: null,
      tier: null,
      backendId: null,
      recurrence: { frequency: "daily", time: "09:00", timezone: TZ },
    });
    expect(port.get(id)?.recurrence.frequency).toBe("daily");
    expect(port.get(999999)).toBeNull();

    const hourly = createRecurringSchedule(db, {
      taskType: "agent.task",
      description: "Hourly",
      recurrenceRule: { frequency: "hourly", intervalHours: 2, minuteOfHour: 30, timezone: TZ },
    });
    expect(port.get(hourly.id)?.recurrence).toEqual({
      frequency: "hourly",
      intervalHours: 2,
      minuteOfHour: 30,
      timezone: TZ,
    });
  });

  it("update() applies field patches and remaps the recurrence", () => {
    const port = createRecurringSchedulePort(db, "UTC");
    const id = port.create({
      enabled: true,
      taskType: "agent.task",
      description: "Old name",
      prompt: null,
      model: null,
      tier: null,
      backendId: null,
      recurrence: { frequency: "daily", time: "09:00", timezone: TZ },
    });
    port.update(id, {
      enabled: false,
      description: "New name",
      prompt: "Updated instructions",
      model: "claude-sonnet-4-6",
      tier: "medium",
      backendId: "claude",
      recurrence: { frequency: "weekly", time: "10:00", timezone: TZ, daysOfWeek: [5] },
    });
    const dto = getRecurringSchedule(db, id);
    expect(dto?.description).toBe("New name");
    expect(dto?.enabled).toBe(false);
    expect(dto?.prompt).toBe("Updated instructions");
    expect(dto?.model).toBe("claude-sonnet-4-6");
    expect(dto?.recurrenceRule.frequency).toBe("weekly");
  });

  it("update() with no fields is a no-op that still resolves", () => {
    const port = createRecurringSchedulePort(db, "UTC");
    const id = port.create({
      enabled: true,
      taskType: "agent.task",
      description: "Unchanged",
      prompt: null,
      model: null,
      tier: null,
      backendId: null,
      recurrence: { frequency: "daily", time: "09:00", timezone: TZ },
    });
    expect(() => port.update(id, {})).not.toThrow();
    expect(getRecurringSchedule(db, id)?.description).toBe("Unchanged");
  });

  it("update() tags a superseded pending row with skipReason=agent_definition_changed", () => {
    const port = createRecurringSchedulePort(db, "UTC");
    const id = port.create({
      enabled: true,
      taskType: "agent.task",
      description: "Daily",
      prompt: null,
      model: null,
      tier: null,
      backendId: null,
      recurrence: { frequency: "daily", time: "09:00", timezone: TZ },
    });
    // The create generated a pending row; change the rule → it is superseded.
    port.update(id, {
      recurrence: { frequency: "daily", time: "10:00", timezone: TZ },
    });
    const skipped = db
      .prepare(
        `SELECT json_extract(task_context, '$.skipReason') AS reason
           FROM agent_schedule
          WHERE recurring_schedule_id = ? AND status = 'skipped'`,
      )
      .get(id) as { reason: string | null } | undefined;
    expect(skipped?.reason).toBe("agent_definition_changed");
  });
});
