import { describe, expect, it } from "vitest";
import {
  applyFrequency,
  recurrenceRulesEqual,
  toggleDayOfMonth,
  toggleDayOfWeek,
  validateRecurrenceRule,
} from "./recurrence-rule-editor.logic";
import type { RecurrenceRule } from "@/lib/api-types";

describe("validateRecurrenceRule", () => {
  it("accepts a well-formed daily rule", () => {
    expect(
      validateRecurrenceRule({ frequency: "daily", time: "10:00" }),
    ).toBeNull();
  });

  it("rejects a non HH:MM time", () => {
    expect(
      validateRecurrenceRule({ frequency: "daily", time: "9:00" }),
    ).toEqual({ time: expect.stringMatching(/HH:MM/) });
    expect(
      validateRecurrenceRule({ frequency: "daily", time: "25:00" }),
    ).toEqual({ time: expect.stringMatching(/HH:MM/) });
  });

  it("rejects weekly with no daysOfWeek", () => {
    expect(
      validateRecurrenceRule({
        frequency: "weekly",
        time: "10:00",
        daysOfWeek: [],
      }),
    ).toEqual({
      daysOfWeek: expect.stringMatching(/at least one weekday/),
    });
  });

  it("rejects weekly with out-of-range daysOfWeek", () => {
    expect(
      validateRecurrenceRule({
        frequency: "weekly",
        time: "10:00",
        daysOfWeek: [7],
      }),
    ).toEqual({ daysOfWeek: expect.stringMatching(/0\.\.6/) });
  });

  it("rejects monthly with no daysOfMonth", () => {
    expect(
      validateRecurrenceRule({ frequency: "monthly", time: "10:00" }),
    ).toEqual({
      daysOfMonth: expect.stringMatching(/at least one day/),
    });
  });

  it("rejects monthly with daysOfMonth out of 1..31", () => {
    expect(
      validateRecurrenceRule({
        frequency: "monthly",
        time: "10:00",
        daysOfMonth: [0],
      }),
    ).toEqual({ daysOfMonth: expect.stringMatching(/1\.\.31/) });
  });

  it("accepts weekly with at least one day", () => {
    expect(
      validateRecurrenceRule({
        frequency: "weekly",
        time: "10:00",
        daysOfWeek: [1, 3, 5],
      }),
    ).toBeNull();
  });
});

describe("applyFrequency", () => {
  const weeklyRule: RecurrenceRule = {
    frequency: "weekly",
    time: "10:00",
    daysOfWeek: [1, 3],
    timezone: "UTC",
  };

  it("clears `daysOfWeek` when transitioning to daily", () => {
    const next = applyFrequency(weeklyRule, "daily");
    expect(next.frequency).toBe("daily");
    expect(next.daysOfWeek).toBeUndefined();
    expect(next.daysOfMonth).toBeUndefined();
    expect(next.timezone).toBe("UTC");
  });

  it("preserves `daysOfWeek` when staying weekly", () => {
    const next = applyFrequency(weeklyRule, "weekly");
    expect(next.daysOfWeek).toEqual([1, 3]);
  });

  it("seeds an empty `daysOfMonth` when switching from weekly to monthly", () => {
    const next = applyFrequency(weeklyRule, "monthly");
    expect(next.frequency).toBe("monthly");
    expect(next.daysOfMonth).toEqual([]);
    expect(next.daysOfWeek).toBeUndefined();
  });
});

describe("toggleDayOfWeek / toggleDayOfMonth", () => {
  it("adds and removes a day idempotently and keeps the array sorted", () => {
    let rule: RecurrenceRule = {
      frequency: "weekly",
      time: "10:00",
      daysOfWeek: [],
    };
    rule = toggleDayOfWeek(rule, 3);
    rule = toggleDayOfWeek(rule, 1);
    expect(rule.daysOfWeek).toEqual([1, 3]);
    rule = toggleDayOfWeek(rule, 1);
    expect(rule.daysOfWeek).toEqual([3]);
  });

  it("is a no-op on non-weekly rules", () => {
    const rule: RecurrenceRule = { frequency: "daily", time: "10:00" };
    expect(toggleDayOfWeek(rule, 3)).toBe(rule);
  });

  it("toggles daysOfMonth with sorted output", () => {
    let rule: RecurrenceRule = {
      frequency: "monthly",
      time: "10:00",
      daysOfMonth: [],
    };
    rule = toggleDayOfMonth(rule, 15);
    rule = toggleDayOfMonth(rule, 1);
    expect(rule.daysOfMonth).toEqual([1, 15]);
    rule = toggleDayOfMonth(rule, 1);
    expect(rule.daysOfMonth).toEqual([15]);
  });
});

describe("recurrenceRulesEqual", () => {
  it("treats nulls as equal", () => {
    expect(recurrenceRulesEqual(null, null)).toBe(true);
  });

  it("returns false when one side is null", () => {
    expect(
      recurrenceRulesEqual(null, { frequency: "daily", time: "10:00" }),
    ).toBe(false);
  });

  it("compares structurally, ignoring day-array ordering", () => {
    expect(
      recurrenceRulesEqual(
        { frequency: "weekly", time: "10:00", daysOfWeek: [1, 3] },
        { frequency: "weekly", time: "10:00", daysOfWeek: [3, 1] },
      ),
    ).toBe(true);
  });

  it("detects time / frequency / timezone drift", () => {
    expect(
      recurrenceRulesEqual(
        { frequency: "daily", time: "10:00" },
        { frequency: "daily", time: "11:00" },
      ),
    ).toBe(false);
    expect(
      recurrenceRulesEqual(
        { frequency: "daily", time: "10:00", timezone: "Asia/Tokyo" },
        { frequency: "daily", time: "10:00", timezone: "UTC" },
      ),
    ).toBe(false);
  });
});
