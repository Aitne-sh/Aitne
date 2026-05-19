import { describe, it, expect } from "vitest";
import {
  computeNextHourly,
  computeNextOccurrence,
  formatRecurrenceLabel,
} from "./recurrence.js";
import type { RecurrenceRule } from "@aitne/shared";

const TZ = "Pacific/Honolulu"; // UTC-10, no DST

describe("computeNextOccurrence", () => {
  describe("daily", () => {
    it("returns today if the time hasn't passed yet", () => {
      const rule: RecurrenceRule = { frequency: "daily", time: "15:00", timezone: TZ };
      // Reference: 2026-04-10 09:00 HST = 2026-04-10 19:00 UTC
      const ref = new Date("2026-04-10T19:00:00Z");
      const next = computeNextOccurrence(rule, ref)!;
      // 15:00 HST = 2026-04-11 01:00 UTC (same HST day, next UTC day)
      expect(next.toISOString()).toBe("2026-04-11T01:00:00.000Z");
    });

    it("returns tomorrow if the time already passed", () => {
      const rule: RecurrenceRule = { frequency: "daily", time: "09:00", timezone: TZ };
      // Reference: 2026-04-10 10:00 HST = 2026-04-10 20:00 UTC
      const ref = new Date("2026-04-10T20:00:00Z");
      const next = computeNextOccurrence(rule, ref)!;
      // Next 09:00 HST = 2026-04-11 19:00 UTC
      expect(next.toISOString()).toBe("2026-04-11T19:00:00.000Z");
    });

    it("returns tomorrow if the time is exactly now", () => {
      const rule: RecurrenceRule = { frequency: "daily", time: "09:00", timezone: TZ };
      // Reference: exactly 09:00 HST on 2026-04-10 = 19:00 UTC
      const ref = new Date("2026-04-10T19:00:00.000Z");
      const next = computeNextOccurrence(rule, ref)!;
      // Must be strictly after reference, so next day
      expect(next.toISOString()).toBe("2026-04-11T19:00:00.000Z");
    });
  });

  describe("weekly", () => {
    it("returns the next matching day of week", () => {
      const rule: RecurrenceRule = {
        frequency: "weekly",
        time: "10:00",
        timezone: TZ,
        daysOfWeek: [1, 3, 5], // Mon, Wed, Fri
      };
      // 2026-04-10 is Friday (day 5)
      // Reference: 2026-04-10 11:00 HST = 21:00 UTC (after 10:00 HST)
      const ref = new Date("2026-04-10T21:00:00Z");
      const next = computeNextOccurrence(rule, ref)!;
      // Next Mon (2026-04-13) at 10:00 HST = 20:00 UTC same day
      expect(next.toISOString()).toBe("2026-04-13T20:00:00.000Z");
    });

    it("returns today if the matching day hasn't had its time yet", () => {
      const rule: RecurrenceRule = {
        frequency: "weekly",
        time: "14:00",
        timezone: TZ,
        daysOfWeek: [5], // Friday only
      };
      // 2026-04-10 is Friday, reference at 08:00 HST = 18:00 UTC
      const ref = new Date("2026-04-10T18:00:00Z");
      const next = computeNextOccurrence(rule, ref)!;
      // 14:00 HST same day = 2026-04-11 00:00 UTC
      expect(next.toISOString()).toBe("2026-04-11T00:00:00.000Z");
    });

    it("returns null for empty daysOfWeek", () => {
      const rule: RecurrenceRule = {
        frequency: "weekly",
        time: "10:00",
        timezone: TZ,
        daysOfWeek: [],
      };
      const ref = new Date("2026-04-10T00:00:00Z");
      expect(computeNextOccurrence(rule, ref)).toBeNull();
    });
  });

  describe("monthly", () => {
    it("returns the next matching day of month", () => {
      const rule: RecurrenceRule = {
        frequency: "monthly",
        time: "09:00",
        timezone: TZ,
        daysOfMonth: [1, 15],
      };
      // Reference: 2026-04-10 12:00 HST = 22:00 UTC
      const ref = new Date("2026-04-10T22:00:00Z");
      const next = computeNextOccurrence(rule, ref)!;
      // Next is April 15 at 09:00 HST = 19:00 UTC same day
      expect(next.toISOString()).toBe("2026-04-15T19:00:00.000Z");
    });

    it("rolls to next month if all days have passed", () => {
      const rule: RecurrenceRule = {
        frequency: "monthly",
        time: "09:00",
        timezone: TZ,
        daysOfMonth: [5],
      };
      // Reference: 2026-04-10 00:00 HST = 10:00 UTC (after the 5th in HST)
      const ref = new Date("2026-04-10T10:00:00Z");
      const next = computeNextOccurrence(rule, ref)!;
      // May 5 at 09:00 HST = 19:00 UTC same day
      expect(next.toISOString()).toBe("2026-05-05T19:00:00.000Z");
    });

    it("clamps day-of-month overflow (31st in February)", () => {
      const rule: RecurrenceRule = {
        frequency: "monthly",
        time: "09:00",
        timezone: TZ,
        daysOfMonth: [31],
      };
      // Reference: 2027-01-31 10:00 HST = 20:00 UTC (after this month's 31st has fired)
      const ref = new Date("2027-01-31T20:00:00Z");
      const next = computeNextOccurrence(rule, ref)!;
      // February 2027 has 28 days, so clamped to 28th at 09:00 HST = 19:00 UTC
      expect(next.toISOString()).toBe("2027-02-28T19:00:00.000Z");
    });

    it("returns null for empty daysOfMonth", () => {
      const rule: RecurrenceRule = {
        frequency: "monthly",
        time: "10:00",
        timezone: TZ,
        daysOfMonth: [],
      };
      const ref = new Date("2026-04-10T00:00:00Z");
      expect(computeNextOccurrence(rule, ref)).toBeNull();
    });
  });
});

describe("formatRecurrenceLabel", () => {
  it("formats daily", () => {
    expect(formatRecurrenceLabel({ frequency: "daily", time: "09:00", timezone: TZ }))
      .toBe("Daily at 09:00");
  });

  it("formats weekly", () => {
    expect(formatRecurrenceLabel({
      frequency: "weekly",
      time: "10:00",
      timezone: TZ,
      daysOfWeek: [1, 3, 5],
    })).toBe("Weekly on Mon, Wed, Fri at 10:00");
  });

  it("formats monthly", () => {
    expect(formatRecurrenceLabel({
      frequency: "monthly",
      time: "18:00",
      timezone: TZ,
      daysOfMonth: [1, 15],
    })).toBe("Monthly on day 1, 15 at 18:00");
  });

  it("formats hourly with default interval/minute", () => {
    expect(formatRecurrenceLabel({ frequency: "hourly", timezone: TZ }))
      .toBe("Every hour at :00");
  });

  it("formats hourly with custom interval + minuteOfHour", () => {
    expect(formatRecurrenceLabel({
      frequency: "hourly",
      intervalHours: 2,
      minuteOfHour: 30,
      timezone: TZ,
    })).toBe("Every 2 hours at :30");
  });

  it("formats monthly with onMissingDay='skip' suffix when 29/30/31 is requested", () => {
    expect(formatRecurrenceLabel({
      frequency: "monthly",
      time: "21:00",
      timezone: TZ,
      daysOfMonth: [31],
      onMissingDay: "skip",
    })).toBe("Monthly on day 31 at 21:00 (skips months without that day)");
  });

  it("formats monthly with default 'lastDayOfMonth' suffix when 29/30/31 is requested", () => {
    expect(formatRecurrenceLabel({
      frequency: "monthly",
      time: "21:00",
      timezone: TZ,
      daysOfMonth: [31],
    })).toBe("Monthly on day 31 at 21:00 (falls back to last day of month)");
  });

  it("omits the overflow suffix when daysOfMonth has no 29/30/31 entry", () => {
    expect(formatRecurrenceLabel({
      frequency: "monthly",
      time: "10:00",
      timezone: TZ,
      daysOfMonth: [1, 15],
    })).toBe("Monthly on day 1, 15 at 10:00");
  });

  it("default branch handles a frequency outside the closed union without throwing", () => {
    expect(
      formatRecurrenceLabel({ frequency: "yearly" as never, time: "09:00" }),
    ).toBe("yearly at 09:00");
  });
});

describe("computeNextHourly", () => {
  it("every hour at :00 from 09:43 → 10:00 local", () => {
    // 2026-04-10 09:43 HST = 2026-04-10 19:43 UTC
    const ref = new Date("2026-04-10T19:43:00Z");
    const next = computeNextHourly(TZ, 1, 0, ref);
    // Next is 10:00 HST = 2026-04-10 20:00 UTC
    expect(next.toISOString()).toBe("2026-04-10T20:00:00.000Z");
  });

  it("every 2 hours at :30 from 07:00 local → 08:30 local", () => {
    // 2026-04-10 07:00 HST = 17:00 UTC
    const ref = new Date("2026-04-10T17:00:00Z");
    const next = computeNextHourly(TZ, 2, 30, ref);
    // 08:30 HST = 18:30 UTC; 08 % 2 == 0 ✓
    expect(next.toISOString()).toBe("2026-04-10T18:30:00.000Z");
  });

  it("every 3 hours at :15 from 23:59 → 00:15 next day", () => {
    // 2026-04-10 23:59 HST = 2026-04-11 09:59 UTC
    const ref = new Date("2026-04-11T09:59:00Z");
    const next = computeNextHourly(TZ, 3, 15, ref);
    // Next anchor at midnight HST → 00:15 HST = 2026-04-11 10:15 UTC; 0 % 3 == 0 ✓
    expect(next.toISOString()).toBe("2026-04-11T10:15:00.000Z");
  });

  it("at top-of-hour boundary the fire is strictly after the reference", () => {
    // 10:00 HST exactly = 20:00 UTC; intervalHours=1 → next must be 11:00 HST
    const ref = new Date("2026-04-10T20:00:00Z");
    const next = computeNextHourly(TZ, 1, 0, ref);
    expect(next.toISOString()).toBe("2026-04-10T21:00:00.000Z");
  });

  it("intervalHours=2 with reference on an odd hour anchors to the next even hour", () => {
    // 03:10 HST = 13:10 UTC; next even-hour anchor at minute 0 is 04:00 HST = 14:00 UTC.
    // 04 % 2 == 0 ✓
    const ref = new Date("2026-04-10T13:10:00Z");
    const next = computeNextHourly(TZ, 2, 0, ref);
    expect(next.toISOString()).toBe("2026-04-10T14:00:00.000Z");
  });

  it("UTC timezone parity", () => {
    const ref = new Date("2026-04-10T07:43:00Z");
    const next = computeNextHourly("UTC", 1, 0, ref);
    expect(next.toISOString()).toBe("2026-04-10T08:00:00.000Z");
  });

  it("crosses DST spring-forward without losing a fire (America/New_York)", () => {
    // US spring-forward 2026: 02:00 EST → 03:00 EDT on Sunday 2026-03-08.
    // From 01:30 EST = 06:30 UTC, the next 1-hour anchor lands on 03:00 EDT
    // = 07:00 UTC (since 02:00 doesn't exist locally that day).
    const ref = new Date("2026-03-08T06:30:00Z");
    const next = computeNextHourly("America/New_York", 1, 0, ref);
    expect(next.toISOString()).toBe("2026-03-08T07:00:00.000Z");
  });
});

describe("computeNextOccurrence — hourly dispatch", () => {
  it("dispatches frequency:'hourly' through computeNextHourly with defaults", () => {
    // Defaults: intervalHours=1, minuteOfHour=0
    const rule: RecurrenceRule = { frequency: "hourly", timezone: TZ };
    const ref = new Date("2026-04-10T19:43:00Z");
    const next = computeNextOccurrence(rule, ref)!;
    expect(next.toISOString()).toBe("2026-04-10T20:00:00.000Z");
  });

  it("dispatches frequency:'hourly' with explicit intervalHours + minuteOfHour", () => {
    const rule: RecurrenceRule = {
      frequency: "hourly",
      intervalHours: 2,
      minuteOfHour: 30,
      timezone: TZ,
    };
    const ref = new Date("2026-04-10T17:00:00Z");
    const next = computeNextOccurrence(rule, ref)!;
    expect(next.toISOString()).toBe("2026-04-10T18:30:00.000Z");
  });
});

describe("computeNextOccurrence — monthly onMissingDay", () => {
  it("25th @ 21:00 from 2026-05-18 → 2026-05-25 21:00 local", () => {
    const rule: RecurrenceRule = {
      frequency: "monthly",
      time: "21:00",
      timezone: TZ,
      daysOfMonth: [25],
    };
    // 2026-05-18 12:00 HST = 22:00 UTC
    const ref = new Date("2026-05-18T22:00:00Z");
    const next = computeNextOccurrence(rule, ref)!;
    // 2026-05-25 21:00 HST = 2026-05-26 07:00 UTC
    expect(next.toISOString()).toBe("2026-05-26T07:00:00.000Z");
  });

  it("25th @ 21:00 from 2026-05-25 22:00 local → 2026-06-25 21:00 local", () => {
    const rule: RecurrenceRule = {
      frequency: "monthly",
      time: "21:00",
      timezone: TZ,
      daysOfMonth: [25],
    };
    // 2026-05-25 22:00 HST = 2026-05-26 08:00 UTC
    const ref = new Date("2026-05-26T08:00:00Z");
    const next = computeNextOccurrence(rule, ref)!;
    expect(next.toISOString()).toBe("2026-06-26T07:00:00.000Z");
  });

  it("31st + 'skip' from 2026-01-31 22:00 local → 2026-03-31 21:00 local (skips Feb)", () => {
    const rule: RecurrenceRule = {
      frequency: "monthly",
      time: "21:00",
      timezone: TZ,
      daysOfMonth: [31],
      onMissingDay: "skip",
    };
    // 2026-01-31 22:00 HST = 2026-02-01 08:00 UTC
    const ref = new Date("2026-02-01T08:00:00Z");
    const next = computeNextOccurrence(rule, ref)!;
    // 2026-03-31 21:00 HST = 2026-04-01 07:00 UTC
    expect(next.toISOString()).toBe("2026-04-01T07:00:00.000Z");
  });

  it("31st + 'lastDayOfMonth' from 2026-01-31 22:00 local → 2026-02-28 21:00 local (non-leap)", () => {
    const rule: RecurrenceRule = {
      frequency: "monthly",
      time: "21:00",
      timezone: TZ,
      daysOfMonth: [31],
      onMissingDay: "lastDayOfMonth",
    };
    const ref = new Date("2026-02-01T08:00:00Z");
    const next = computeNextOccurrence(rule, ref)!;
    // 2026-02-28 21:00 HST = 2026-03-01 07:00 UTC
    expect(next.toISOString()).toBe("2026-03-01T07:00:00.000Z");
  });

  it("31st + 'lastDayOfMonth' from 2027-01-31 22:00 → 2027-02-28 21:00 (different non-leap year)", () => {
    const rule: RecurrenceRule = {
      frequency: "monthly",
      time: "21:00",
      timezone: TZ,
      daysOfMonth: [31],
      onMissingDay: "lastDayOfMonth",
    };
    const ref = new Date("2027-02-01T08:00:00Z");
    const next = computeNextOccurrence(rule, ref)!;
    expect(next.toISOString()).toBe("2027-03-01T07:00:00.000Z");
  });

  it("29th + 'skip' from 2026-01-29 22:00 → 2026-03-29 21:00 (skips Feb 2026 non-leap)", () => {
    const rule: RecurrenceRule = {
      frequency: "monthly",
      time: "21:00",
      timezone: TZ,
      daysOfMonth: [29],
      onMissingDay: "skip",
    };
    // 2026-01-29 22:00 HST = 2026-01-30 08:00 UTC
    const ref = new Date("2026-01-30T08:00:00Z");
    const next = computeNextOccurrence(rule, ref)!;
    // 2026-03-29 21:00 HST = 2026-03-30 07:00 UTC
    expect(next.toISOString()).toBe("2026-03-30T07:00:00.000Z");
  });

  it("29th + 'skip' from 2028-01-29 22:00 → 2028-02-29 21:00 (leap year — fires)", () => {
    const rule: RecurrenceRule = {
      frequency: "monthly",
      time: "21:00",
      timezone: TZ,
      daysOfMonth: [29],
      onMissingDay: "skip",
    };
    const ref = new Date("2028-01-30T08:00:00Z");
    const next = computeNextOccurrence(rule, ref)!;
    // 2028-02-29 21:00 HST = 2028-03-01 07:00 UTC
    expect(next.toISOString()).toBe("2028-03-01T07:00:00.000Z");
  });

  it("daysOfMonth:[28,31] + 'lastDayOfMonth' in Feb 2026 → fires once on Feb 28 (de-dupe)", () => {
    const rule: RecurrenceRule = {
      frequency: "monthly",
      time: "21:00",
      timezone: TZ,
      daysOfMonth: [28, 31],
      onMissingDay: "lastDayOfMonth",
    };
    // 2026-02-27 22:00 HST = 2026-02-28 08:00 UTC
    const ref = new Date("2026-02-28T08:00:00Z");
    const first = computeNextOccurrence(rule, ref)!;
    // Feb 28 21:00 HST = Mar 1 07:00 UTC
    expect(first.toISOString()).toBe("2026-03-01T07:00:00.000Z");
    // The NEXT fire after Feb 28 should skip the duplicate (collapsed
    // [28,31] → just [28] in Feb) and land in March 28, NOT a second
    // entry for the same Feb day.
    const second = computeNextOccurrence(rule, first)!;
    // March 28 21:00 HST = Mar 29 07:00 UTC
    expect(second.toISOString()).toBe("2026-03-29T07:00:00.000Z");
  });

  it("daysOfMonth:[15,31] + 'skip' in Feb 2026 → fires Feb 15 only; then Mar 15", () => {
    const rule: RecurrenceRule = {
      frequency: "monthly",
      time: "21:00",
      timezone: TZ,
      daysOfMonth: [15, 31],
      onMissingDay: "skip",
    };
    // 2026-02-14 22:00 HST = 2026-02-15 08:00 UTC
    const ref = new Date("2026-02-15T08:00:00Z");
    const first = computeNextOccurrence(rule, ref)!;
    // Feb 15 21:00 HST = Feb 16 07:00 UTC
    expect(first.toISOString()).toBe("2026-02-16T07:00:00.000Z");
    // Next after Feb 15: Feb 31 is skipped → Mar 15.
    const second = computeNextOccurrence(rule, first)!;
    // Mar 15 21:00 HST = Mar 16 07:00 UTC
    expect(second.toISOString()).toBe("2026-03-16T07:00:00.000Z");
  });

  it("preserves prior clamp behavior when onMissingDay is omitted on 31st rule", () => {
    // The default policy is "lastDayOfMonth" — bit-identical to the
    // pre-redesign clamp. Same expectation as the existing clamp test.
    const rule: RecurrenceRule = {
      frequency: "monthly",
      time: "09:00",
      timezone: TZ,
      daysOfMonth: [31],
    };
    const ref = new Date("2027-01-31T20:00:00Z");
    const next = computeNextOccurrence(rule, ref)!;
    expect(next.toISOString()).toBe("2027-02-28T19:00:00.000Z");
  });
});

describe("computeNextOccurrence — year rollover", () => {
  it("rolls monthly recurrence from December into January next year", () => {
    const rule: RecurrenceRule = {
      frequency: "monthly",
      time: "09:00",
      timezone: TZ,
      daysOfMonth: [5],
    };
    // Reference: 2026-12-10 00:00 HST = 10:00 UTC (after the 5th of December)
    const ref = new Date("2026-12-10T10:00:00Z");
    const next = computeNextOccurrence(rule, ref)!;
    // January 5, 2027 at 09:00 HST = 19:00 UTC same day
    expect(next.toISOString()).toBe("2027-01-05T19:00:00.000Z");
    // Verify year did roll over
    expect(next.getUTCFullYear()).toBe(2027);
  });
});

describe("computeNextOccurrence — defensive fallback for missing day arrays", () => {
  // The schema layer rejects weekly without daysOfWeek and monthly without
  // daysOfMonth, but computeNextOccurrence is called from code paths that
  // forward DB rows directly. The `?? []` fallback ensures a malformed
  // rule returns null instead of dereferencing undefined.
  it("weekly rule with undefined daysOfWeek returns null", () => {
    const rule = {
      frequency: "weekly",
      time: "10:00",
      timezone: TZ,
    } as RecurrenceRule;
    const ref = new Date("2026-04-10T00:00:00Z");
    expect(computeNextOccurrence(rule, ref)).toBeNull();
  });

  it("monthly rule with undefined daysOfMonth returns null", () => {
    const rule = {
      frequency: "monthly",
      time: "10:00",
      timezone: TZ,
    } as RecurrenceRule;
    const ref = new Date("2026-04-10T00:00:00Z");
    expect(computeNextOccurrence(rule, ref)).toBeNull();
  });

  it("uses OS timezone when rule timezone is missing", () => {
    // Empty-string timezone exercises the `rule.timezone || ...` fallback.
    const rule = {
      frequency: "daily",
      time: "09:00",
      timezone: "",
    } as RecurrenceRule;
    const ref = new Date("2026-04-10T00:00:00Z");
    const next = computeNextOccurrence(rule, ref);
    expect(next).toBeInstanceOf(Date);
  });
});

describe("formatRecurrenceLabel — defensive fallback for missing day arrays", () => {
  it("weekly rule renders empty day list when daysOfWeek is undefined", () => {
    const rule = {
      frequency: "weekly",
      time: "10:00",
      timezone: TZ,
    } as RecurrenceRule;
    expect(formatRecurrenceLabel(rule)).toBe("Weekly on  at 10:00");
  });

  it("monthly rule renders empty day list when daysOfMonth is undefined", () => {
    const rule = {
      frequency: "monthly",
      time: "18:00",
      timezone: TZ,
    } as RecurrenceRule;
    expect(formatRecurrenceLabel(rule)).toBe("Monthly on day  at 18:00");
  });
});
