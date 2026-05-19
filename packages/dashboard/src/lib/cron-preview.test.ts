import { describe, expect, it } from "vitest";
import { previewCronSchedule } from "./cron-preview";

describe("previewCronSchedule", () => {
  it("returns the next weekly fire in the requested timezone", () => {
    const result = previewCronSchedule("0 11 * * 2", "UTC", {
      from: new Date("2026-04-17T10:15:00Z"),
      count: 2,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextRuns.map((date) => date.toISOString())).toEqual([
        "2026-04-21T11:00:00.000Z",
        "2026-04-28T11:00:00.000Z",
      ]);
    }
  });

  it("supports named month and weekday aliases", () => {
    const result = previewCronSchedule("30 8 * jan mon", "UTC", {
      from: new Date("2026-01-05T08:00:00Z"),
      count: 2,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextRuns.map((date) => date.toISOString())).toEqual([
        "2026-01-05T08:30:00.000Z",
        "2026-01-12T08:30:00.000Z",
      ]);
    }
  });

  it("uses crontab OR semantics when both day-of-month and day-of-week are restricted", () => {
    const result = previewCronSchedule("0 9 1 * 1", "UTC", {
      from: new Date("2026-04-06T09:01:00Z"),
      count: 3,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextRuns.map((date) => date.toISOString())).toEqual([
        "2026-04-13T09:00:00.000Z",
        "2026-04-20T09:00:00.000Z",
        "2026-04-27T09:00:00.000Z",
      ]);
    }
  });

  it("rejects malformed expressions", () => {
    const result = previewCronSchedule("bad cron", "UTC");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("exactly 5 fields");
    }
  });
});
