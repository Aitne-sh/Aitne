import { describe, expect, it } from "vitest";

import {
  RUNTIME_WINDOW_BOUNDS,
  RUNTIME_WINDOW_FIELDS,
  isValidRuntimeWindowValue,
  mergeRuntimeWindow,
  parseRuntimeWindowOverride,
  resolveActivityScanCadence,
  type ActivityScanCadenceConfig,
} from "./activity-scan-cadence.js";

const CONFIG: ActivityScanCadenceConfig = {
  activityScanIntervalMinutes: 60,
  activityScanActiveStartHour: 7,
  activityScanActiveEndHour: 23,
  activityScanMinObservations: 1,
};

describe("RUNTIME_WINDOW_FIELDS", () => {
  it("enumerates exactly the bounded fields", () => {
    expect([...RUNTIME_WINDOW_FIELDS].sort()).toEqual(
      Object.keys(RUNTIME_WINDOW_BOUNDS).sort(),
    );
  });
});

describe("isValidRuntimeWindowValue", () => {
  it("accepts in-bounds integers", () => {
    expect(isValidRuntimeWindowValue("interval_minutes", 5)).toBe(true);
    expect(isValidRuntimeWindowValue("interval_minutes", 1440)).toBe(true);
    expect(isValidRuntimeWindowValue("active_start_hour", 0)).toBe(true);
    expect(isValidRuntimeWindowValue("active_end_hour", 24)).toBe(true);
    expect(isValidRuntimeWindowValue("min_observations", 0)).toBe(true);
  });

  it("rejects out-of-bounds, floats, and non-numbers", () => {
    expect(isValidRuntimeWindowValue("interval_minutes", 4)).toBe(false);
    expect(isValidRuntimeWindowValue("interval_minutes", 1441)).toBe(false);
    expect(isValidRuntimeWindowValue("active_start_hour", 24)).toBe(false);
    expect(isValidRuntimeWindowValue("active_end_hour", 0)).toBe(false);
    expect(isValidRuntimeWindowValue("min_observations", 1001)).toBe(false);
    expect(isValidRuntimeWindowValue("interval_minutes", 7.5)).toBe(false);
    expect(isValidRuntimeWindowValue("interval_minutes", "60")).toBe(false);
    expect(isValidRuntimeWindowValue("interval_minutes", null)).toBe(false);
  });
});

describe("parseRuntimeWindowOverride", () => {
  it("returns {} for non-object blobs", () => {
    expect(parseRuntimeWindowOverride(undefined)).toEqual({});
    expect(parseRuntimeWindowOverride(null)).toEqual({});
    expect(parseRuntimeWindowOverride("x")).toEqual({});
    expect(parseRuntimeWindowOverride([1])).toEqual({});
  });

  it("keeps valid fields and drops invalid / unknown ones", () => {
    expect(
      parseRuntimeWindowOverride({
        interval_minutes: 30,
        active_start_hour: 99,
        active_end_hour: 22,
        min_observations: "3",
        bogus: 1,
      }),
    ).toEqual({ interval_minutes: 30, active_end_hour: 22 });
  });
});

describe("resolveActivityScanCadence", () => {
  it("falls back to config for absent override / absent fields", () => {
    expect(resolveActivityScanCadence(undefined, CONFIG)).toEqual({
      intervalMinutes: 60,
      activeStartHour: 7,
      activeEndHour: 23,
      minObservations: 1,
    });
    expect(resolveActivityScanCadence({ interval_minutes: 15 }, CONFIG)).toEqual({
      intervalMinutes: 15,
      activeStartHour: 7,
      activeEndHour: 23,
      minObservations: 1,
    });
  });

  it("override wins per field", () => {
    expect(
      resolveActivityScanCadence(
        {
          interval_minutes: 30,
          active_start_hour: 9,
          active_end_hour: 18,
          min_observations: 5,
        },
        CONFIG,
      ),
    ).toEqual({
      intervalMinutes: 30,
      activeStartHour: 9,
      activeEndHour: 18,
      minObservations: 5,
    });
  });

  it("repairs an inverted window by widening end to start + 1 (capped at 24)", () => {
    expect(
      resolveActivityScanCadence({ active_start_hour: 23 }, CONFIG),
    ).toMatchObject({ activeStartHour: 23, activeEndHour: 24 });
    // start 23 + legacy config end 23 → inverted; never exceeds 24
    expect(
      resolveActivityScanCadence(
        { active_start_hour: 23 },
        { ...CONFIG, activityScanActiveEndHour: 10 },
      ),
    ).toMatchObject({ activeStartHour: 23, activeEndHour: 24 });
  });
});

describe("mergeRuntimeWindow", () => {
  it("merges valid fields and reports cadence change", () => {
    const result = mergeRuntimeWindow({}, { interval_minutes: 30 }, CONFIG);
    expect(result).toEqual({
      ok: true,
      value: { interval_minutes: 30 },
      cadenceChanged: true,
    });
  });

  it("min_observations alone does not require a cron rebuild", () => {
    const result = mergeRuntimeWindow({}, { min_observations: 3 }, CONFIG);
    expect(result).toEqual({
      ok: true,
      value: { min_observations: 3 },
      cadenceChanged: false,
    });
  });

  it("same-value patch is not a cadence change", () => {
    const result = mergeRuntimeWindow(
      { interval_minutes: 30 },
      { interval_minutes: 30 },
      CONFIG,
    );
    expect(result).toEqual({
      ok: true,
      value: { interval_minutes: 30 },
      cadenceChanged: false,
    });
  });

  it("null resets a field to the config fallback", () => {
    const result = mergeRuntimeWindow(
      { interval_minutes: 30, min_observations: 3 },
      { interval_minutes: null, min_observations: null },
      CONFIG,
    );
    expect(result).toEqual({
      ok: true,
      value: {},
      cadenceChanged: true,
    });
  });

  it("null on an already-absent field is a no-op", () => {
    const result = mergeRuntimeWindow({}, { interval_minutes: null }, CONFIG);
    expect(result).toEqual({ ok: true, value: {}, cadenceChanged: false });
  });

  it("rejects unknown fields", () => {
    expect(mergeRuntimeWindow({}, { bogus: 1 }, CONFIG)).toEqual({
      ok: false,
      field: "schedule_window.bogus",
      error: "invalid_field_value",
    });
  });

  it("rejects out-of-bounds values", () => {
    expect(mergeRuntimeWindow({}, { interval_minutes: 2 }, CONFIG)).toEqual({
      ok: false,
      field: "schedule_window.interval_minutes",
      error: "invalid_field_value",
    });
  });

  it("rejects a post-merge empty window (cross-field)", () => {
    // start patched to 22 while stored end override is 20 → empty window.
    expect(
      mergeRuntimeWindow({ active_end_hour: 20 }, { active_start_hour: 22 }, CONFIG),
    ).toEqual({
      ok: false,
      field: "schedule_window.active_end_hour",
      error: "invalid_window",
    });
    // end patched below the config-fallback start.
    expect(mergeRuntimeWindow({}, { active_end_hour: 6 }, CONFIG)).toEqual({
      ok: false,
      field: "schedule_window.active_end_hour",
      error: "invalid_window",
    });
  });
});
