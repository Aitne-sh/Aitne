import { describe, it, expect } from "vitest";
import {
  compareLocalDateParts,
  getLocalDateParts,
  getTimeZoneOffsetMinutes,
  localDateTimeToUtcMs,
} from "./dispatcher-date-utils.js";

describe("compareLocalDateParts", () => {
  const base = { year: 2026, month: 5, day: 10, hour: 12, minute: 30 };

  it("returns 0 when both are equal", () => {
    expect(compareLocalDateParts(base, { ...base })).toBe(0);
  });

  it("differentiates by year", () => {
    expect(
      compareLocalDateParts({ ...base, year: 2025 }, { ...base, year: 2026 }),
    ).toBeLessThan(0);
    expect(
      compareLocalDateParts({ ...base, year: 2027 }, { ...base, year: 2026 }),
    ).toBeGreaterThan(0);
  });

  it("differentiates by month when year is equal", () => {
    expect(
      compareLocalDateParts({ ...base, month: 4 }, { ...base, month: 5 }),
    ).toBeLessThan(0);
  });

  it("differentiates by day when year+month equal", () => {
    expect(
      compareLocalDateParts({ ...base, day: 9 }, { ...base, day: 10 }),
    ).toBeLessThan(0);
  });

  it("differentiates by hour when year+month+day equal", () => {
    expect(
      compareLocalDateParts({ ...base, hour: 11 }, { ...base, hour: 12 }),
    ).toBeLessThan(0);
  });

  it("differentiates by minute when year+month+day+hour equal", () => {
    expect(
      compareLocalDateParts({ ...base, minute: 29 }, { ...base, minute: 30 }),
    ).toBeLessThan(0);
    expect(
      compareLocalDateParts({ ...base, minute: 31 }, { ...base, minute: 30 }),
    ).toBeGreaterThan(0);
  });
});

describe("getTimeZoneOffsetMinutes", () => {
  it("returns 0 for UTC / Etc/UTC", () => {
    const date = new Date("2026-05-10T12:00:00Z");
    expect(getTimeZoneOffsetMinutes(date, "UTC")).toBe(0);
    expect(getTimeZoneOffsetMinutes(date, "Etc/UTC")).toBe(0);
  });

  it("returns +540 for Asia/Tokyo (UTC+09:00)", () => {
    const date = new Date("2026-05-10T12:00:00Z");
    expect(getTimeZoneOffsetMinutes(date, "Asia/Tokyo")).toBe(9 * 60);
  });

  it("returns the correct DST-aware offset for America/Los_Angeles", () => {
    // Late May → PDT (UTC-7)
    const summer = new Date("2026-05-10T20:00:00Z");
    expect(getTimeZoneOffsetMinutes(summer, "America/Los_Angeles")).toBe(-7 * 60);
    // Mid January → PST (UTC-8)
    const winter = new Date("2026-01-10T20:00:00Z");
    expect(getTimeZoneOffsetMinutes(winter, "America/Los_Angeles")).toBe(-8 * 60);
  });

  it("returns null for an invalid timezone", () => {
    const date = new Date("2026-05-10T12:00:00Z");
    expect(getTimeZoneOffsetMinutes(date, "Not/A_Zone")).toBeNull();
  });
});

describe("getLocalDateParts", () => {
  it("decomposes a UTC instant in Asia/Tokyo correctly", () => {
    const date = new Date("2026-05-10T01:30:00Z");
    expect(getLocalDateParts(date, "Asia/Tokyo")).toEqual({
      year: 2026,
      month: 5,
      day: 10,
      hour: 10,
      minute: 30,
    });
  });

  it("returns runtime-local parts when timeZone is omitted", () => {
    const date = new Date("2026-05-10T12:00:00Z");
    const parts = getLocalDateParts(date);
    // We can't assert exact values without knowing the host TZ, but
    // the shape and value ranges should be sensible.
    expect(parts.year).toBe(2026);
    expect(parts.month).toBeGreaterThanOrEqual(1);
    expect(parts.month).toBeLessThanOrEqual(12);
    expect(parts.hour).toBeGreaterThanOrEqual(0);
    expect(parts.hour).toBeLessThanOrEqual(23);
  });

  it("falls back to runtime local parts when timeZone is invalid", () => {
    const date = new Date("2026-05-10T12:00:00Z");
    const parts = getLocalDateParts(date, "Not/A_Zone");
    expect(parts.year).toBe(2026);
  });
});

describe("localDateTimeToUtcMs", () => {
  it("converts a local-time wall clock in UTC to the matching epoch", () => {
    const ms = localDateTimeToUtcMs(
      { year: 2026, month: 5, day: 10, hour: 12, minute: 0 },
      "UTC",
    );
    expect(ms).toBe(Date.UTC(2026, 4, 10, 12, 0, 0, 0));
  });

  it("converts a local-time wall clock in Asia/Tokyo (UTC+9)", () => {
    const ms = localDateTimeToUtcMs(
      { year: 2026, month: 5, day: 10, hour: 9, minute: 0 },
      "Asia/Tokyo",
    );
    expect(ms).toBe(Date.UTC(2026, 4, 10, 0, 0, 0, 0));
  });

  it("converts a local-time wall clock in America/Los_Angeles (DST-aware)", () => {
    // 2026-05-10 12:00 PDT = 2026-05-10 19:00 UTC
    const ms = localDateTimeToUtcMs(
      { year: 2026, month: 5, day: 10, hour: 12, minute: 0 },
      "America/Los_Angeles",
    );
    expect(ms).toBe(Date.UTC(2026, 4, 10, 19, 0, 0, 0));
  });

  it("returns null for an invalid timezone", () => {
    const ms = localDateTimeToUtcMs(
      { year: 2026, month: 5, day: 10, hour: 12, minute: 0 },
      "Not/A_Zone",
    );
    expect(ms).toBeNull();
  });

  it("uses the runtime local zone when timeZone is omitted", () => {
    const ms = localDateTimeToUtcMs({
      year: 2026,
      month: 5,
      day: 10,
      hour: 12,
      minute: 0,
    });
    // Should match new Date(...).getTime() built locally.
    expect(ms).toBe(new Date(2026, 4, 10, 12, 0, 0, 0).getTime());
  });

  it("returns null for a wall-clock that does not exist (DST gap)", () => {
    // 2026-03-08 02:30 in America/Los_Angeles falls in the spring-forward
    // gap: clocks jump 02:00 → 03:00, so 02:30 PST/PDT does not exist.
    const ms = localDateTimeToUtcMs(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
      "America/Los_Angeles",
    );
    expect(ms).toBeNull();
  });
});
