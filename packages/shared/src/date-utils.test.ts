import { describe, it, expect } from "vitest";
import {
  localDateStr,
  nowInTimezone,
  getAgentDayBoundsUtc,
  getAgentDayDateStr,
  getAgentDayProgressMinutes,
  getAgentDaySqlShiftModifier,
  nextActiveHoursStart,
  formatSqliteDatetime,
  parseSqliteUtcMs,
} from "./date-utils.js";

describe("localDateStr", () => {
  it("returns YYYY-MM-DD using local timezone", () => {
    // Use a date where local and UTC would agree
    const date = new Date(2026, 3, 15, 12, 0, 0); // April 15, 2026, noon local
    expect(localDateStr(date)).toBe("2026-04-15");
  });

  it("pads single-digit month and day", () => {
    const date = new Date(2026, 0, 5, 12, 0, 0); // Jan 5
    expect(localDateStr(date)).toBe("2026-01-05");
  });

  it("uses local date, not UTC date", () => {
    // Create a date at local midnight — this ensures getDate() returns the local date
    const date = new Date(2026, 5, 1, 0, 30, 0); // June 1, 00:30 local
    expect(localDateStr(date)).toBe("2026-06-01");
  });

  it("handles year boundaries", () => {
    const date = new Date(2026, 11, 31, 23, 59, 0); // Dec 31 23:59 local
    expect(localDateStr(date)).toBe("2026-12-31");
  });

  it("respects explicit timezone parameter", () => {
    // 2026-04-16 02:00 UTC = 2026-04-15 22:00 EDT (UTC-4)
    const date = new Date("2026-04-16T02:00:00Z");
    expect(localDateStr(date, "America/New_York")).toBe("2026-04-15");
    expect(localDateStr(date, "UTC")).toBe("2026-04-16");
  });
});

describe("nowInTimezone", () => {
  it("uses current time when now parameter is omitted", () => {
    const before = new Date();
    const result = nowInTimezone("UTC");
    const after = new Date();
    // The result hours should be between before and after UTC hours
    expect(result.year).toBeGreaterThanOrEqual(before.getUTCFullYear());
    expect(result.year).toBeLessThanOrEqual(after.getUTCFullYear());
  });

  it("returns system-local components when timezone is undefined", () => {
    const date = new Date(2026, 3, 15, 14, 30, 0); // April 15, 14:30 local
    const result = nowInTimezone(undefined, date);
    expect(result.hours).toBe(14);
    expect(result.minutes).toBe(30);
    expect(result.year).toBe(2026);
    expect(result.month).toBe(4);
    expect(result.day).toBe(15);
  });

  it("returns system-local components when timezone is empty", () => {
    const date = new Date(2026, 3, 15, 14, 30, 0);
    const result = nowInTimezone("", date);
    expect(result.hours).toBe(14);
    expect(result.minutes).toBe(30);
  });

  it("converts to specified timezone", () => {
    // 2026-04-15 12:00 UTC → 2026-04-15 08:00 EDT (UTC-4)
    const date = new Date("2026-04-15T12:00:00Z");
    const result = nowInTimezone("America/New_York", date);
    expect(result.hours).toBe(8);
    expect(result.year).toBe(2026);
    expect(result.month).toBe(4);
    expect(result.day).toBe(15);
  });

  it("handles date rollover across timezone boundary", () => {
    // 2026-04-16 02:00 UTC → 2026-04-15 22:00 EDT (UTC-4)
    const date = new Date("2026-04-16T02:00:00Z");
    const result = nowInTimezone("America/New_York", date);
    expect(result.hours).toBe(22);
    expect(result.day).toBe(15);
  });

  it("returns correct dayOfWeek", () => {
    // 2026-04-15 is a Wednesday (3)
    const date = new Date("2026-04-15T12:00:00Z");
    const result = nowInTimezone("UTC", date);
    expect(result.dayOfWeek).toBe(3);
  });
});

describe("getAgentDayBoundsUtc", () => {
  it("uses current time when now parameter is omitted", () => {
    const bounds = getAgentDayBoundsUtc("UTC", 0);
    const startMs = new Date(bounds.start + "Z").getTime();
    const endMs = new Date(bounds.end + "Z").getTime();
    expect(endMs - startMs).toBe(24 * 60 * 60 * 1000);
  });

  it("falls back to system timezone offset when timezone is undefined", () => {
    const now = new Date("2026-04-15T10:00:00Z");
    const bounds = getAgentDayBoundsUtc(undefined, 4, now);
    // Should still produce valid bounds using the system's local offset
    expect(bounds.start).toBeDefined();
    expect(bounds.end).toBeDefined();
    // The gap between start and end is exactly 24 hours
    const startMs = new Date(bounds.start + "Z").getTime();
    const endMs = new Date(bounds.end + "Z").getTime();
    expect(endMs - startMs).toBe(24 * 60 * 60 * 1000);
  });

  it("returns correct UTC bounds for Pacific/Honolulu with dayBoundary=4", () => {
    // 2026-04-15 10:00 HST (= 20:00 UTC). Pacific/Honolulu is UTC-10
    // with no DST, so the offset is stable year-round.
    // Agent day: 04:00 HST Apr 15 → 04:00 HST Apr 16
    //          = 14:00 UTC Apr 15 → 14:00 UTC Apr 16
    const now = new Date("2026-04-15T20:00:00Z");
    const bounds = getAgentDayBoundsUtc("Pacific/Honolulu", 4, now);
    expect(bounds.start).toBe("2026-04-15 14:00:00");
    expect(bounds.end).toBe("2026-04-16 14:00:00");
  });

  it("handles time before boundary hour (still previous agent day)", () => {
    // 2026-04-15 02:00 HST (= 12:00 UTC same day)
    // Before 04:00 HST → still in Apr 14's agent day
    // Agent day: 04:00 HST Apr 14 → 04:00 HST Apr 15
    //          = 14:00 UTC Apr 14 → 14:00 UTC Apr 15
    const now = new Date("2026-04-15T12:00:00Z");
    const bounds = getAgentDayBoundsUtc("Pacific/Honolulu", 4, now);
    expect(bounds.start).toBe("2026-04-14 14:00:00");
    expect(bounds.end).toBe("2026-04-15 14:00:00");
  });

  it("handles exact boundary hour", () => {
    // 2026-04-15 04:00 HST (= 14:00 UTC same day)
    // At exactly 04:00 → this is the start of Apr 15's agent day
    const now = new Date("2026-04-15T14:00:00Z");
    const bounds = getAgentDayBoundsUtc("Pacific/Honolulu", 4, now);
    expect(bounds.start).toBe("2026-04-15 14:00:00");
    expect(bounds.end).toBe("2026-04-16 14:00:00");
  });

  it("works with UTC timezone", () => {
    // dayBoundary=4, timezone=UTC
    // 2026-04-15 10:00 UTC → agent day 04:00..04:00 UTC
    const now = new Date("2026-04-15T10:00:00Z");
    const bounds = getAgentDayBoundsUtc("UTC", 4, now);
    expect(bounds.start).toBe("2026-04-15 04:00:00");
    expect(bounds.end).toBe("2026-04-16 04:00:00");
  });

  it("works with dayBoundary=0 (midnight boundary)", () => {
    const now = new Date("2026-04-15T10:00:00Z");
    const bounds = getAgentDayBoundsUtc("UTC", 0, now);
    expect(bounds.start).toBe("2026-04-15 00:00:00");
    expect(bounds.end).toBe("2026-04-16 00:00:00");
  });

  it("works with western timezone", () => {
    // 2026-04-15 10:00 UTC = 2026-04-15 06:00 EDT (UTC-4)
    // Agent day boundary at 04:00 EDT = 08:00 UTC
    const now = new Date("2026-04-15T10:00:00Z");
    const bounds = getAgentDayBoundsUtc("America/New_York", 4, now);
    expect(bounds.start).toBe("2026-04-15 08:00:00");
    expect(bounds.end).toBe("2026-04-16 08:00:00");
  });
});

describe("getAgentDayDateStr", () => {
  it("returns the current local date after the day boundary", () => {
    const now = new Date("2026-04-15T10:00:00Z"); // 03:00 PDT? Wait LA DST = 03:00, before boundary
    expect(getAgentDayDateStr("UTC", 4, now)).toBe("2026-04-15");
  });

  it("returns the previous local date before the day boundary", () => {
    const now = new Date("2026-04-15T10:00:00Z"); // 03:00 PDT
    expect(getAgentDayDateStr("America/Los_Angeles", 4, now)).toBe("2026-04-14");
  });

  it("handles exact boundary hour as the new agent day", () => {
    const now = new Date("2026-04-15T11:00:00Z"); // 04:00 PDT
    expect(getAgentDayDateStr("America/Los_Angeles", 4, now)).toBe("2026-04-15");
  });
});

describe("getAgentDayProgressMinutes", () => {
  it("returns elapsed minutes after the boundary", () => {
    const now = new Date("2026-04-15T12:30:00Z"); // 05:30 PDT
    expect(getAgentDayProgressMinutes("America/Los_Angeles", 4, now)).toBe(90);
  });

  it("wraps early-morning times into the previous agent day", () => {
    const now = new Date("2026-04-15T09:15:00Z"); // 02:15 PDT
    expect(getAgentDayProgressMinutes("America/Los_Angeles", 4, now)).toBe(22 * 60 + 15);
  });
});

describe("parseSqliteUtcMs", () => {
  it("parses a SQLite datetime string to epoch milliseconds", () => {
    expect(parseSqliteUtcMs("2026-04-15 09:30:45")).toBe(
      new Date("2026-04-15T09:30:45Z").getTime(),
    );
  });

  it("handles midnight", () => {
    expect(parseSqliteUtcMs("2026-01-01 00:00:00")).toBe(
      new Date("2026-01-01T00:00:00Z").getTime(),
    );
  });
});

describe("nextActiveHoursStart", () => {
  it("returns candidate unchanged when local hour is inside the window", () => {
    const candidate = new Date("2026-04-15T12:00:00Z"); // 12:00 UTC
    expect(
      nextActiveHoursStart(candidate, "UTC", 4, 24).toISOString(),
    ).toBe("2026-04-15T12:00:00.000Z");
  });

  it("shifts forward to today's startHour when local hour is before the window", () => {
    const candidate = new Date("2026-04-15T02:30:00Z"); // 02:30 UTC
    expect(
      nextActiveHoursStart(candidate, "UTC", 9, 17).toISOString(),
    ).toBe("2026-04-15T09:00:00.000Z");
  });

  it("shifts forward to tomorrow's startHour when local hour is at or past endHour", () => {
    const candidate = new Date("2026-04-15T18:30:00Z"); // 18:30 UTC, past 17
    expect(
      nextActiveHoursStart(candidate, "UTC", 9, 17).toISOString(),
    ).toBe("2026-04-16T09:00:00.000Z");
  });

  it("treats endHour=24 as exclusive (hour 23 stays in window)", () => {
    const candidate = new Date("2026-04-15T23:30:00Z");
    expect(
      nextActiveHoursStart(candidate, "UTC", 4, 24).toISOString(),
    ).toBe("2026-04-15T23:30:00.000Z");
  });

  it("respects timezone — JST candidate before local startHour shifts to local startHour:00", () => {
    // 2026-04-15 19:00 UTC = 2026-04-16 04:00 JST. With JST window [9, 22)
    // hour 4 is before 9 → today (JST) startHour:00 = 2026-04-16 09:00 JST
    // = 2026-04-16 00:00 UTC.
    const candidate = new Date("2026-04-15T19:00:00Z");
    expect(
      nextActiveHoursStart(candidate, "Asia/Tokyo", 9, 22).toISOString(),
    ).toBe("2026-04-16T00:00:00.000Z");
  });

  it("respects timezone — NY candidate past local endHour shifts to next-day startHour", () => {
    // 2026-04-15 23:00 UTC = 2026-04-15 19:00 EDT (UTC-4). Window [4, 18)
    // hour 19 is past 18 → tomorrow EDT 04:00 = 2026-04-16 08:00 UTC.
    const candidate = new Date("2026-04-15T23:00:00Z");
    expect(
      nextActiveHoursStart(candidate, "America/New_York", 4, 18).toISOString(),
    ).toBe("2026-04-16T08:00:00.000Z");
  });

  it("crosses month boundary correctly when shifting to next day", () => {
    const candidate = new Date("2026-04-30T23:30:00Z"); // past 17 in UTC
    expect(
      nextActiveHoursStart(candidate, "UTC", 9, 17).toISOString(),
    ).toBe("2026-05-01T09:00:00.000Z");
  });

  it("crosses year boundary correctly", () => {
    const candidate = new Date("2026-12-31T23:30:00Z");
    expect(
      nextActiveHoursStart(candidate, "UTC", 4, 24).toISOString(),
    ).toBe("2026-12-31T23:30:00.000Z"); // hour 23 still inside [4, 24)
  });

  it("falls back to the host TZ offset when timezone is undefined (out-of-window candidate)", () => {
    // Drives both `timezone ? ... : -candidate.getTimezoneOffset()...`
    // ternary branches — the function must take the FS path when the
    // local hour is outside the window. The exact instant depends on
    // host TZ; we only assert that the function returns a real Date.
    const candidate = new Date("2026-04-15T02:30:00Z");
    const result = nextActiveHoursStart(candidate, undefined, 9, 17);
    expect(result).toBeInstanceOf(Date);
    expect(Number.isFinite(result.getTime())).toBe(true);
  });

  it("handles undefined timezone via system local", () => {
    // Just ensure it doesn't throw — system-local behaviour is intentionally
    // not asserted because CI / dev machines have different local TZs.
    const candidate = new Date(2026, 3, 15, 14, 0, 0);
    expect(() => nextActiveHoursStart(candidate, undefined, 4, 24)).not.toThrow();
  });
});

describe("getAgentDaySqlShiftModifier", () => {
  // Use a non-DST instant so the offset is stable across CI runtimes.
  const fixed = new Date("2026-05-17T10:00:00Z");

  it("returns +300 minutes for Asia/Tokyo with 04:00 boundary", () => {
    expect(getAgentDaySqlShiftModifier("Asia/Tokyo", 4, fixed)).toBe("+300 minutes");
  });

  it("returns -480 minutes for America/New_York (EDT, -4) with 04:00 boundary", () => {
    // 2026-05-17 is during EDT (UTC-4): -4*60 - 4*60 = -480 minutes
    expect(getAgentDaySqlShiftModifier("America/New_York", 4, fixed)).toBe("-480 minutes");
  });

  it("returns -240 minutes for UTC with 04:00 boundary", () => {
    expect(getAgentDaySqlShiftModifier("UTC", 4, fixed)).toBe("-240 minutes");
  });

  it("returns 0 minutes for UTC with midnight boundary", () => {
    expect(getAgentDaySqlShiftModifier("UTC", 0, fixed)).toBe("+0 minutes");
  });

  it("returns +540 minutes for Asia/Tokyo with midnight boundary", () => {
    expect(getAgentDaySqlShiftModifier("Asia/Tokyo", 0, fixed)).toBe("+540 minutes");
  });

  it("falls back to host TZ offset when timezone is undefined", () => {
    // Exact result depends on host TZ; assert only that the helper
    // produces a well-formed +/-N minutes string without throwing.
    const out = getAgentDaySqlShiftModifier(undefined, 4, fixed);
    expect(out).toMatch(/^[+-]\d+ minutes$/);
  });

  it("defaults `now` to the current instant when omitted", () => {
    // Exercises the `now ?? new Date()` branch — exact value depends on
    // wall clock, so we only assert the output shape.
    const out = getAgentDaySqlShiftModifier("UTC", 4);
    expect(out).toMatch(/^[+-]\d+ minutes$/);
  });
});

describe("formatSqliteDatetime", () => {
  it("formats as YYYY-MM-DD HH:MM:SS", () => {
    const date = new Date("2026-04-15T09:30:45Z");
    expect(formatSqliteDatetime(date)).toBe("2026-04-15 09:30:45");
  });

  it("pads single digits", () => {
    const date = new Date("2026-01-05T03:05:07Z");
    expect(formatSqliteDatetime(date)).toBe("2026-01-05 03:05:07");
  });
});
