import { describe, expect, it } from "vitest";
import {
  describeCron,
  describeInterval,
  describeSchedule,
  executionDurationMs,
  formatActiveHours,
  formatCostUsd,
  formatDurationSeconds,
  formatDurationShort,
  formatIntervalEvery,
  formatPercent,
  isIntervalSchedule,
  kindLabel,
  resultBadgeVariant,
} from "./format";
import type { AgentExecution } from "./types";

function exec(overrides: Partial<AgentExecution>): AgentExecution {
  return {
    id: 1,
    agent_id: "a",
    schedule_row_id: null,
    trigger: null,
    started_at: null,
    ended_at: null,
    result: "success",
    error_kind: null,
    error_message: null,
    cost_usd: null,
    tokens_input: null,
    tokens_output: null,
    turns: null,
    success_criteria: null,
    output_summary: null,
    ...overrides,
  };
}

describe("resultBadgeVariant", () => {
  it("maps each terminal result", () => {
    expect(resultBadgeVariant("success")).toBe("green");
    expect(resultBadgeVariant("error")).toBe("red");
    expect(resultBadgeVariant("timeout")).toBe("amber");
    expect(resultBadgeVariant("skipped")).toBe("gray");
    expect(resultBadgeVariant(null)).toBe("gray");
  });
});

describe("kindLabel", () => {
  it("labels builtin/user", () => {
    expect(kindLabel("builtin")).toBe("System");
    expect(kindLabel("user")).toBe("User");
  });
});

describe("describeCron", () => {
  it("describes daily crons", () => {
    expect(describeCron("0 4 * * *")).toBe("Every day at 04:00");
    expect(describeCron("50 17 * * *")).toBe("Every day at 17:50");
  });

  it("describes weekly single-dow crons", () => {
    expect(describeCron("0 19 * * 5")).toBe("Every Friday at 19:00");
    expect(describeCron("0 21 * * 0")).toBe("Every Sunday at 21:00");
  });

  it("drops a leading seconds field on 6-field crons", () => {
    expect(describeCron("0 0 4 * * *")).toBe("Every day at 04:00");
  });

  it("describes sub-daily interval crons", () => {
    expect(describeCron("*/15 * * * *")).toBe("Every 15m");
    expect(describeCron("*/90 * * * *")).toBe("Every 1h 30m");
    expect(describeCron("0,15,30,45 * * * *")).toBe("Every 15m");
    expect(describeCron("* * * * *")).toBe("Every minute");
    expect(describeCron("0 */2 * * *")).toBe("Every 2h");
    expect(describeCron("30 */3 * * *")).toBe("Every 3h at :30");
    expect(describeCron("0 * * * *")).toBe("Hourly");
    expect(describeCron("20 * * * *")).toBe("Hourly at :20");
    // Interval within a bounded active window (hourly-check placeholder shape).
    expect(describeCron("*/30 4-23 * * *")).toBe("Every 30m, 04:00–24:00");
    expect(describeCron("* 9-17 * * *")).toBe("Every minute, 09:00–18:00");
  });

  it("falls back to the raw expression for unsupported shapes", () => {
    expect(describeCron("0 18 1 * *")).toBe("0 18 1 * *");
    expect(describeCron("0 4-23 * * *")).toBe("0 4-23 * * *");
    expect(describeCron("not a cron")).toBe("not a cron");
    expect(describeCron("0 99 * * *")).toBe("0 99 * * *");
    // A non-everyday interval (weekday-scoped) is not classified as interval.
    expect(describeCron("*/15 * * * 1")).toBe("*/15 * * * 1");
    // A non-uniform / non-zero-anchored minute list is not an interval.
    expect(describeCron("5,20,50 * * * *")).toBe("5,20,50 * * * *");
  });
});

describe("formatIntervalEvery / formatActiveHours (split display)", () => {
  it("formatIntervalEvery returns only the cadence part", () => {
    expect(formatIntervalEvery({ interval_minutes: 60, active_start_hour: 4, active_end_hour: 24 })).toBe(
      "Every 1h",
    );
    expect(formatIntervalEvery({ interval_minutes: 30, active_start_hour: 0, active_end_hour: 24 })).toBe(
      "Every 30m",
    );
    expect(formatIntervalEvery({ interval_minutes: 90, active_start_hour: 6, active_end_hour: 22 })).toBe(
      "Every 1h 30m",
    );
  });

  it("formatActiveHours returns the window, or null for a full day", () => {
    expect(formatActiveHours({ interval_minutes: 60, active_start_hour: 4, active_end_hour: 24 })).toBe(
      "04:00–24:00",
    );
    expect(formatActiveHours({ interval_minutes: 30, active_start_hour: 9, active_end_hour: 17 })).toBe(
      "09:00–17:00",
    );
    expect(formatActiveHours({ interval_minutes: 60, active_start_hour: 0, active_end_hour: 24 })).toBeNull();
  });

  it("describeInterval composes the same two parts", () => {
    const cadence = { interval_minutes: 60, active_start_hour: 4, active_end_hour: 24 };
    expect(describeInterval(cadence)).toBe(
      `${formatIntervalEvery(cadence)}, ${formatActiveHours(cadence)}`,
    );
  });
});

describe("describeInterval", () => {
  it("renders the cadence, omitting a full-day window", () => {
    expect(describeInterval({ interval_minutes: 60, active_start_hour: 0, active_end_hour: 24 })).toBe(
      "Every 1h",
    );
  });

  it("appends a bounded active window", () => {
    expect(describeInterval({ interval_minutes: 60, active_start_hour: 4, active_end_hour: 24 })).toBe(
      "Every 1h, 04:00–24:00",
    );
    expect(describeInterval({ interval_minutes: 30, active_start_hour: 9, active_end_hour: 17 })).toBe(
      "Every 30m, 09:00–17:00",
    );
    expect(describeInterval({ interval_minutes: 90, active_start_hour: 6, active_end_hour: 22 })).toBe(
      "Every 1h 30m, 06:00–22:00",
    );
  });

  it("is defensive about a non-positive interval", () => {
    expect(describeInterval({ interval_minutes: 0, active_start_hour: 0, active_end_hour: 24 })).toBe(
      "Every 0m",
    );
  });
});

describe("describeSchedule", () => {
  it("describes each schedule kind", () => {
    expect(describeSchedule({ kind: "cron", expression: "0 4 * * *", timezone: "UTC" })).toBe(
      "Every day at 04:00",
    );
    expect(describeSchedule({ kind: "cron", expression: null, timezone: "UTC" })).toBe("Recurring");
    expect(describeSchedule({ kind: "one_shot", expression: null, timezone: "UTC" })).toBe("One-shot");
    expect(describeSchedule({ kind: "event", expression: "git.push", timezone: "UTC" })).toBe(
      "On event: git.push",
    );
    expect(describeSchedule({ kind: "event", expression: null, timezone: "UTC" })).toBe("On event");
    expect(describeSchedule({ kind: "weird", expression: null, timezone: "UTC" })).toBe("weird");
  });

  it("prefers the resolved runtime-window interval over the placeholder cron", () => {
    // hourly-check: stored placeholder cron + the real config-driven cadence.
    expect(
      describeSchedule({
        kind: "cron",
        expression: "0 4-23 * * *",
        timezone: "UTC",
        interval: { interval_minutes: 30, active_start_hour: 4, active_end_hour: 24 },
      }),
    ).toBe("Every 30m, 04:00–24:00");
    // A null interval is ignored — the cron describes the schedule.
    expect(
      describeSchedule({ kind: "cron", expression: "0 4 * * *", timezone: "UTC", interval: null }),
    ).toBe("Every day at 04:00");
  });
});

describe("isIntervalSchedule", () => {
  it("treats a resolved runtime-window cadence as interval", () => {
    expect(
      isIntervalSchedule({
        kind: "cron",
        expression: "0 4-23 * * *",
        timezone: "UTC",
        interval: { interval_minutes: 60, active_start_hour: 4, active_end_hour: 24 },
      }),
    ).toBe(true);
  });

  it("classifies sub-daily crons (multi-value minute or hour) as interval", () => {
    expect(isIntervalSchedule({ kind: "cron", expression: "*/30 * * * *", timezone: "UTC" })).toBe(true);
    expect(isIntervalSchedule({ kind: "cron", expression: "0 */2 * * *", timezone: "UTC" })).toBe(true);
    expect(isIntervalSchedule({ kind: "cron", expression: "0 4-23 * * *", timezone: "UTC" })).toBe(true);
    expect(isIntervalSchedule({ kind: "cron", expression: "0,30 9 * * *", timezone: "UTC" })).toBe(true);
    expect(isIntervalSchedule({ kind: "cron", expression: "0 0 4 * * *", timezone: "UTC" })).toBe(false);
  });

  it("classifies fixed daily/weekly times as not interval", () => {
    expect(isIntervalSchedule({ kind: "cron", expression: "0 4 * * *", timezone: "UTC" })).toBe(false);
    expect(isIntervalSchedule({ kind: "cron", expression: "0 19 * * 5", timezone: "UTC" })).toBe(false);
  });

  it("is false for non-cron, missing, or malformed expressions", () => {
    expect(isIntervalSchedule({ kind: "one_shot", expression: null, timezone: "UTC" })).toBe(false);
    expect(isIntervalSchedule({ kind: "event", expression: "git.push", timezone: "UTC" })).toBe(false);
    expect(isIntervalSchedule({ kind: "cron", expression: null, timezone: "UTC" })).toBe(false);
    expect(isIntervalSchedule({ kind: "cron", expression: "not a cron", timezone: "UTC" })).toBe(false);
  });
});

describe("formatPercent", () => {
  it("formats rates and null", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.123)).toBe("12%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(undefined)).toBe("—");
  });
});

describe("formatCostUsd", () => {
  it("formats USD and null", () => {
    expect(formatCostUsd(0.17)).toBe("$0.17");
    expect(formatCostUsd(0)).toBe("$0.00");
    expect(formatCostUsd(null)).toBe("—");
    expect(formatCostUsd(undefined)).toBe("—");
  });
});

describe("executionDurationMs", () => {
  it("computes a duration from ISO timestamps", () => {
    expect(
      executionDurationMs(
        exec({ started_at: "2026-05-26T04:00:00.000Z", ended_at: "2026-05-26T04:08:32.000Z" }),
      ),
    ).toBe(512_000);
  });

  it("returns null when a timestamp is missing or inverted", () => {
    expect(executionDurationMs(exec({ started_at: null, ended_at: "2026-05-26T04:08:32.000Z" }))).toBeNull();
    expect(executionDurationMs(exec({ started_at: "2026-05-26T04:08:32.000Z", ended_at: null }))).toBeNull();
    expect(
      executionDurationMs(
        exec({ started_at: "2026-05-26T04:08:32.000Z", ended_at: "2026-05-26T04:00:00.000Z" }),
      ),
    ).toBeNull();
    expect(executionDurationMs(exec({ started_at: "nonsense", ended_at: "also" }))).toBeNull();
  });
});

describe("formatDurationShort", () => {
  it("formats sub-minute, sub-hour, and hour spans", () => {
    expect(formatDurationShort(51_000)).toBe("51s");
    expect(formatDurationShort(512_000)).toBe("8m 32s");
    expect(formatDurationShort(3_840_000)).toBe("1h 4m");
    expect(formatDurationShort(0)).toBe("0s");
  });

  it("returns em-dash for null/invalid", () => {
    expect(formatDurationShort(null)).toBe("—");
    expect(formatDurationShort(undefined)).toBe("—");
    expect(formatDurationShort(-5)).toBe("—");
    expect(formatDurationShort(Number.NaN)).toBe("—");
  });
});

describe("formatDurationSeconds", () => {
  it("treats the input as seconds", () => {
    expect(formatDurationSeconds(512)).toBe("8m 32s");
    expect(formatDurationSeconds(null)).toBe("—");
  });
});
