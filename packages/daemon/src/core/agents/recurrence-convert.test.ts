import { describe, expect, it } from "vitest";
import {
  cronToRecurrenceSpec,
  recurrenceRuleToCron,
  recurrenceSpecToCron,
  type AgentRecurrenceSpec,
} from "./recurrence-convert.js";

const TZ = "America/New_York";

describe("cronToRecurrenceSpec", () => {
  it("converts a daily cron", () => {
    expect(cronToRecurrenceSpec("0 4 * * *", TZ)).toEqual({
      frequency: "daily",
      time: "04:00",
      timezone: TZ,
    });
  });

  it("zero-pads single-digit hour and minute", () => {
    expect(cronToRecurrenceSpec("5 9 * * *", TZ)).toEqual({
      frequency: "daily",
      time: "09:05",
      timezone: TZ,
    });
  });

  it("converts a weekly cron with a day-of-week list", () => {
    expect(cronToRecurrenceSpec("0 19 * * 1,3,5", TZ)).toEqual({
      frequency: "weekly",
      time: "19:00",
      timezone: TZ,
      daysOfWeek: [1, 3, 5],
    });
  });

  it("treats `?` in the day-of-week field as wild (daily)", () => {
    expect(cronToRecurrenceSpec("0 4 * * ?", TZ)?.frequency).toBe("daily");
  });

  it("converts a monthly cron with a day-of-month list", () => {
    expect(cronToRecurrenceSpec("30 9 1,15 * *", TZ)).toEqual({
      frequency: "monthly",
      time: "09:30",
      timezone: TZ,
      daysOfMonth: [1, 15],
    });
  });

  it("converts an every-hour cron (`M * * * *`) to hourly with intervalHours 1", () => {
    expect(cronToRecurrenceSpec("0 * * * *", TZ)).toEqual({
      frequency: "hourly",
      timezone: TZ,
      intervalHours: 1,
      minuteOfHour: 0,
    });
    expect(cronToRecurrenceSpec("15 * * * *", TZ)).toEqual({
      frequency: "hourly",
      timezone: TZ,
      intervalHours: 1,
      minuteOfHour: 15,
    });
  });

  it("converts an every-N-hours cron (`M */N * * *`) to hourly with intervalHours N", () => {
    expect(cronToRecurrenceSpec("30 */2 * * *", TZ)).toEqual({
      frequency: "hourly",
      timezone: TZ,
      intervalHours: 2,
      minuteOfHour: 30,
    });
  });

  it("rejects an hourly cron carrying day constraints (not representable)", () => {
    expect(cronToRecurrenceSpec("0 * * * 1", TZ)).toBeNull();
    expect(cronToRecurrenceSpec("0 */2 1 * *", TZ)).toBeNull();
  });

  it("rejects an out-of-range hour step and sub-hourly minute steps", () => {
    expect(cronToRecurrenceSpec("0 */25 * * *", TZ)).toBeNull();
    expect(cronToRecurrenceSpec("*/30 * * * *", TZ)).toBeNull();
  });

  it("returns null when the field count is not 5", () => {
    expect(cronToRecurrenceSpec("0 4 * *", TZ)).toBeNull();
    expect(cronToRecurrenceSpec("0 0 4 * * *", TZ)).toBeNull();
  });

  it("returns null for a stepped / ranged minute or hour", () => {
    expect(cronToRecurrenceSpec("*/5 4 * * *", TZ)).toBeNull();
    expect(cronToRecurrenceSpec("0 4-6 * * *", TZ)).toBeNull();
    expect(cronToRecurrenceSpec("0,30 4 * * *", TZ)).toBeNull();
  });

  it("returns null for out-of-range minute or hour", () => {
    expect(cronToRecurrenceSpec("60 4 * * *", TZ)).toBeNull();
    expect(cronToRecurrenceSpec("0 24 * * *", TZ)).toBeNull();
  });

  it("returns null when a month is specified", () => {
    expect(cronToRecurrenceSpec("0 4 * 6 *", TZ)).toBeNull();
  });

  it("returns null for an out-of-range day-of-week", () => {
    expect(cronToRecurrenceSpec("0 4 * * 7", TZ)).toBeNull();
  });

  it("returns null for an out-of-range day-of-month", () => {
    expect(cronToRecurrenceSpec("0 4 0 * *", TZ)).toBeNull();
    expect(cronToRecurrenceSpec("0 4 32 * *", TZ)).toBeNull();
  });

  it("returns null when both day-of-month and day-of-week are constrained", () => {
    expect(cronToRecurrenceSpec("0 4 1 * 1", TZ)).toBeNull();
  });
});

describe("recurrenceSpecToCron", () => {
  it("emits a daily expression", () => {
    expect(recurrenceSpecToCron({ frequency: "daily", time: "04:00", timezone: TZ })).toBe(
      "0 4 * * *",
    );
  });

  it("emits a weekly expression with the day list", () => {
    expect(
      recurrenceSpecToCron({
        frequency: "weekly",
        time: "19:30",
        timezone: TZ,
        daysOfWeek: [1, 3],
      }),
    ).toBe("30 19 * * 1,3");
  });

  it("falls back to a wildcard day-of-week when the weekly list is empty", () => {
    expect(
      recurrenceSpecToCron({ frequency: "weekly", time: "00:00", timezone: TZ, daysOfWeek: [] }),
    ).toBe("0 0 * * *");
    expect(
      recurrenceSpecToCron({ frequency: "weekly", time: "00:00", timezone: TZ }),
    ).toBe("0 0 * * *");
  });

  it("emits a monthly expression with the day list", () => {
    expect(
      recurrenceSpecToCron({
        frequency: "monthly",
        time: "09:00",
        timezone: TZ,
        daysOfMonth: [1, 15],
      }),
    ).toBe("0 9 1,15 * *");
  });

  it("falls back to a wildcard day-of-month when the monthly list is empty", () => {
    expect(
      recurrenceSpecToCron({ frequency: "monthly", time: "09:00", timezone: TZ, daysOfMonth: [] }),
    ).toBe("0 9 * * *");
  });

  it("defaults a malformed time to midnight", () => {
    const spec: AgentRecurrenceSpec = { frequency: "daily", time: "99:99", timezone: TZ };
    expect(recurrenceSpecToCron(spec)).toBe("0 0 * * *");
    expect(recurrenceSpecToCron({ frequency: "daily", time: "", timezone: TZ })).toBe(
      "0 0 * * *",
    );
  });

  it("emits the every-hour / every-N-hours step form", () => {
    expect(
      recurrenceSpecToCron({ frequency: "hourly", timezone: TZ, intervalHours: 1, minuteOfHour: 0 }),
    ).toBe("0 * * * *");
    expect(
      recurrenceSpecToCron({ frequency: "hourly", timezone: TZ, intervalHours: 3, minuteOfHour: 15 }),
    ).toBe("15 */3 * * *");
  });

  it("defaults hourly intervalHours / minuteOfHour when omitted", () => {
    expect(recurrenceSpecToCron({ frequency: "hourly", timezone: TZ })).toBe("0 * * * *");
  });

  it("defaults a timed spec with no time to the midnight fields", () => {
    expect(recurrenceSpecToCron({ frequency: "daily", timezone: TZ })).toBe("0 0 * * *");
  });

  it("round-trips all four frequencies through both converters", () => {
    for (const cron of ["0 * * * *", "15 */3 * * *", "0 4 * * *", "30 19 * * 1,3,5", "0 9 1,15 * *"]) {
      const spec = cronToRecurrenceSpec(cron, TZ);
      expect(spec).not.toBeNull();
      expect(recurrenceSpecToCron(spec!)).toBe(cron);
    }
  });
});

describe("recurrenceRuleToCron", () => {
  it("renders each frequency to the canonical cron", () => {
    expect(recurrenceRuleToCron({ frequency: "hourly", intervalHours: 1, minuteOfHour: 0, timezone: TZ })).toBe(
      "0 * * * *",
    );
    expect(recurrenceRuleToCron({ frequency: "hourly", intervalHours: 2, minuteOfHour: 30, timezone: TZ })).toBe(
      "30 */2 * * *",
    );
    expect(recurrenceRuleToCron({ frequency: "daily", time: "09:00", timezone: TZ })).toBe("0 9 * * *");
    expect(
      recurrenceRuleToCron({ frequency: "weekly", time: "08:00", daysOfWeek: [1], timezone: TZ }),
    ).toBe("0 8 * * 1");
    expect(
      recurrenceRuleToCron({ frequency: "monthly", time: "18:00", daysOfMonth: [1], timezone: TZ }),
    ).toBe("0 18 1 * *");
  });

  it("tolerates an hourly rule with defaults omitted", () => {
    expect(recurrenceRuleToCron({ frequency: "hourly", timezone: TZ })).toBe("0 * * * *");
  });
});
