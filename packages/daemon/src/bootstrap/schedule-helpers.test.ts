import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../db/schema.js";
import type { AgentConfig } from "../config.js";
import {
  getDueCatchupRoutines,
  getLatestMorningAttemptStartMs,
  getProgressMinutesForHour,
  getRecoverableStalledMorningWake,
  getStalledMorningRoutineWake,
  hasFreshAgentDayTodayMd,
  MORNING_MISSED_FIRE_GRACE_MINUTES,
  MORNING_ROUTINE_CONFIG_KEY,
  MORNING_ROUTINE_STALL_THRESHOLD_MINUTES,
  morningRoutineRanToday,
  readMorningRoutineStallThresholdMinutes,
  readSkillCurationCadence,
  shouldCatchUpHourlyCheck,
  shouldQueueMissedMorningFire,
} from "./schedule-helpers.js";

const tokyo = { timezone: "Asia/Tokyo", dayBoundaryHour: 4 };

function insertMorningRoutine(
  db: Database.Database,
  opts: { result: "success" | "failed"; startedAt: string },
): void {
  db
    .prepare(
      `INSERT INTO agent_actions
         (event_id, action_type, result, started_at, completed_at)
       VALUES (?, 'routine.morning_routine', ?, ?, ?)`,
    )
    .run(
      "evt-" + Math.random().toString(36).slice(2),
      opts.result,
      opts.startedAt,
      opts.startedAt,
    );
}

function insertMorningWake(
  db: Database.Database,
  opts: {
    createdAt: string;
    scheduledFor?: string;
    status?: "pending" | "running" | "completed" | "failed";
    routine?: string;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO agent_schedule
         (scheduled_for, task_type, task_description, task_context, status, created_at)
       VALUES (?, 'wake', ?, ?, ?, ?)`,
    )
    .run(
      opts.scheduledFor ?? opts.createdAt,
      "Morning routine",
      JSON.stringify({ routine: opts.routine ?? "morning_routine" }),
      opts.status ?? "pending",
      opts.createdAt,
    );
  return Number(result.lastInsertRowid);
}

describe("morningRoutineRanToday", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns false when no morning_routine row exists at all", () => {
    expect(morningRoutineRanToday(db, tokyo)).toBe(false);
  });

  it("returns true when a successful row exists inside the current agent-day window", () => {
    // 2026-05-14 12:00 JST → 03:00 UTC. Agent day for Tokyo / 4-AM boundary
    // starts 2026-05-13 19:00 UTC and ends 2026-05-14 19:00 UTC. The success
    // row at noon-JST sits squarely inside that window.
    insertMorningRoutine(db, {
      result: "success",
      startedAt: "2026-05-14 03:00:00",
    });
    const now = new Date("2026-05-14T08:00:00Z"); // 17:00 JST same agent-day
    expect(morningRoutineRanToday(db, tokyo, now)).toBe(true);
  });

  it("returns false when the only success row falls in the previous agent-day", () => {
    // Same-date wall-clock but BEFORE the 4-AM boundary in Tokyo = previous
    // agent-day. 2026-05-14 02:00 JST = 2026-05-13 17:00 UTC, which is
    // before the agent-day-start of 2026-05-13 19:00 UTC for the morning
    // we're scoring against. So the predicate must return false.
    insertMorningRoutine(db, {
      result: "success",
      startedAt: "2026-05-13 17:00:00",
    });
    const now = new Date("2026-05-14T08:00:00Z");
    expect(morningRoutineRanToday(db, tokyo, now)).toBe(false);
  });

  it("returns false when the only same-day row failed (result != 'success')", () => {
    insertMorningRoutine(db, {
      result: "failed",
      startedAt: "2026-05-14 03:00:00",
    });
    const now = new Date("2026-05-14T08:00:00Z");
    expect(morningRoutineRanToday(db, tokyo, now)).toBe(false);
  });

  it("returns true when a same-day success exists alongside earlier failures", () => {
    insertMorningRoutine(db, {
      result: "failed",
      startedAt: "2026-05-13 19:30:00",
    });
    insertMorningRoutine(db, {
      result: "success",
      startedAt: "2026-05-14 03:00:00",
    });
    const now = new Date("2026-05-14T08:00:00Z");
    expect(morningRoutineRanToday(db, tokyo, now)).toBe(true);
  });

  it("respects the dayBoundaryHour configuration", () => {
    // Custom boundary at 06:00 (some users start their agent-day later).
    // 05:00 local would land in the previous agent-day under this boundary
    // even though the date string is the same.
    const customBoundary = { timezone: "Asia/Tokyo", dayBoundaryHour: 6 };
    insertMorningRoutine(db, {
      result: "success",
      startedAt: "2026-05-13 20:30:00", // 05:30 JST on 2026-05-14
    });
    const now = new Date("2026-05-14T01:00:00Z"); // 10:00 JST
    expect(morningRoutineRanToday(db, customBoundary, now)).toBe(false);
  });
});

describe("getStalledMorningRoutineWake", () => {
  let db: Database.Database;
  const now = new Date("2026-05-14T08:00:00Z"); // 17:00 JST, ~5h into agent-day

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns null when no wake row exists", () => {
    expect(getStalledMorningRoutineWake(db, tokyo, 120, now)).toBeNull();
  });

  it("returns null when a pending wake row is younger than the threshold", () => {
    // 30 minutes old — under 120 minute threshold.
    insertMorningWake(db, { createdAt: "2026-05-14 07:30:00" });
    expect(getStalledMorningRoutineWake(db, tokyo, 120, now)).toBeNull();
  });

  it("returns the row metadata when a pending wake row exceeds the threshold", () => {
    // 3 hours old — exceeds 120 min threshold.
    const id = insertMorningWake(db, { createdAt: "2026-05-14 05:00:00" });
    const stalled = getStalledMorningRoutineWake(db, tokyo, 120, now);
    expect(stalled).not.toBeNull();
    expect(stalled?.id).toBe(id);
    expect(stalled?.ageMinutes).toBe(180);
    expect(stalled?.status).toBe("pending");
  });

  it("returns the row metadata for a stuck 'running' row, not just pending", () => {
    insertMorningWake(db, {
      createdAt: "2026-05-14 05:00:00",
      status: "running",
    });
    const stalled = getStalledMorningRoutineWake(db, tokyo, 120, now);
    expect(stalled?.status).toBe("running");
  });

  it("returns null when the routine already wrote a success row today", () => {
    // Wake row is old, but a success exists — health restored.
    insertMorningWake(db, { createdAt: "2026-05-14 05:00:00" });
    insertMorningRoutine(db, {
      result: "success",
      startedAt: "2026-05-14 07:00:00",
    });
    expect(getStalledMorningRoutineWake(db, tokyo, 120, now)).toBeNull();
  });

  it("ignores wake rows for other routines (e.g., today_refresh)", () => {
    insertMorningWake(db, {
      createdAt: "2026-05-14 05:00:00",
      routine: "today_refresh",
    });
    expect(getStalledMorningRoutineWake(db, tokyo, 120, now)).toBeNull();
  });

  it("ignores completed and failed wake rows", () => {
    insertMorningWake(db, {
      createdAt: "2026-05-14 05:00:00",
      status: "completed",
    });
    insertMorningWake(db, {
      createdAt: "2026-05-14 05:00:00",
      status: "failed",
    });
    expect(getStalledMorningRoutineWake(db, tokyo, 120, now)).toBeNull();
  });

  it("returns the oldest matching row when multiple stall (shouldn't happen due to dedup, but defensive)", () => {
    const older = insertMorningWake(db, { createdAt: "2026-05-14 04:30:00" });
    insertMorningWake(db, { createdAt: "2026-05-14 05:30:00" });
    const stalled = getStalledMorningRoutineWake(db, tokyo, 120, now);
    expect(stalled?.id).toBe(older);
  });

  it("defaults `now` to the wall clock when the caller omits it", () => {
    // Covers the `now ?? new Date()` fallback. Insert a row dated far in
    // the past — under the real wall clock the routine has not run today
    // and the wake row is stale beyond any sane threshold, so the call
    // must surface the row.
    insertMorningWake(db, { createdAt: "2020-01-01 00:00:00" });
    const stalled = getStalledMorningRoutineWake(db, tokyo, 120);
    expect(stalled?.status).toBe("pending");
    // Age is computed against the wall clock; assert a generous lower
    // bound rather than a brittle exact value.
    expect(stalled!.ageMinutes).toBeGreaterThan(1000);
  });

  it("treats a yesterday success as a different agent-day (still stalled today)", () => {
    // Yesterday's success — today's wake row is still stuck.
    insertMorningRoutine(db, {
      result: "success",
      startedAt: "2026-05-13 03:00:00",
    });
    const id = insertMorningWake(db, { createdAt: "2026-05-14 05:00:00" });
    const stalled = getStalledMorningRoutineWake(db, tokyo, 120, now);
    expect(stalled?.id).toBe(id);
  });
});

describe("readMorningRoutineStallThresholdMinutes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function writeConfig(value: unknown): void {
    db
      .prepare(
        `INSERT INTO runtime_state (key, value_json) VALUES (?, ?)`,
      )
      .run(MORNING_ROUTINE_CONFIG_KEY, JSON.stringify(value));
  }

  it("returns the built-in default when the runtime_state row is missing", () => {
    expect(readMorningRoutineStallThresholdMinutes(db)).toBe(
      MORNING_ROUTINE_STALL_THRESHOLD_MINUTES,
    );
  });

  it("returns the configured value when it exceeds the floor", () => {
    writeConfig({ stallThresholdMinutes: 240 });
    expect(readMorningRoutineStallThresholdMinutes(db)).toBe(240);
  });

  it("clamps sub-floor values up to the 15-minute floor", () => {
    writeConfig({ stallThresholdMinutes: 1 });
    expect(readMorningRoutineStallThresholdMinutes(db)).toBe(15);
  });

  it("ignores non-positive values and falls back to the default", () => {
    writeConfig({ stallThresholdMinutes: 0 });
    expect(readMorningRoutineStallThresholdMinutes(db)).toBe(
      MORNING_ROUTINE_STALL_THRESHOLD_MINUTES,
    );
    db.exec(
      `DELETE FROM runtime_state WHERE key = '${MORNING_ROUTINE_CONFIG_KEY}'`,
    );
    writeConfig({ stallThresholdMinutes: -10 });
    expect(readMorningRoutineStallThresholdMinutes(db)).toBe(
      MORNING_ROUTINE_STALL_THRESHOLD_MINUTES,
    );
  });

  it("ignores non-number values and falls back to the default", () => {
    writeConfig({ stallThresholdMinutes: "120" });
    expect(readMorningRoutineStallThresholdMinutes(db)).toBe(
      MORNING_ROUTINE_STALL_THRESHOLD_MINUTES,
    );
  });

  it("returns the default when the value_json is corrupt", () => {
    db
      .prepare(
        `INSERT INTO runtime_state (key, value_json) VALUES (?, ?)`,
      )
      .run(MORNING_ROUTINE_CONFIG_KEY, "{not valid json");
    expect(readMorningRoutineStallThresholdMinutes(db)).toBe(
      MORNING_ROUTINE_STALL_THRESHOLD_MINUTES,
    );
  });

  it("returns the default when the runtime_state table is missing (defensive)", () => {
    db.exec("DROP TABLE runtime_state");
    expect(readMorningRoutineStallThresholdMinutes(db)).toBe(
      MORNING_ROUTINE_STALL_THRESHOLD_MINUTES,
    );
  });
});

// ── getProgressMinutesForHour ─────────────────────────────────────────────
// Pure boundary math: how many minutes after dayBoundaryHour does `hour`
// fall? Wraps across the boundary, so 03:00 with a 04:00 boundary returns
// 23 hours (1380), not -60.

describe("getProgressMinutesForHour", () => {
  it("returns zero at the boundary hour itself", () => {
    expect(getProgressMinutesForHour(4, 4)).toBe(0);
  });

  it("returns hour*60 when boundary is midnight", () => {
    expect(getProgressMinutesForHour(0, 0)).toBe(0);
    expect(getProgressMinutesForHour(12, 0)).toBe(12 * 60);
    expect(getProgressMinutesForHour(23, 0)).toBe(23 * 60);
  });

  it("returns positive offsets for hours after the boundary on the same wall-clock day", () => {
    expect(getProgressMinutesForHour(5, 4)).toBe(60);
    expect(getProgressMinutesForHour(18, 4)).toBe(14 * 60);
  });

  it("wraps across midnight for hours before the boundary", () => {
    // 03:00 with a 04:00 boundary belongs to the *previous* agent-day's
    // tail. Expressed in elapsed minutes since that previous boundary,
    // that's 23h.
    expect(getProgressMinutesForHour(3, 4)).toBe(23 * 60);
    expect(getProgressMinutesForHour(0, 4)).toBe(20 * 60);
  });

  it("handles a non-zero boundary aligning with hour=boundary", () => {
    // Custom 6 AM boundary — 18:00 sits 12h past it; 5:00 sits 23h past it.
    expect(getProgressMinutesForHour(6, 6)).toBe(0);
    expect(getProgressMinutesForHour(18, 6)).toBe(12 * 60);
    expect(getProgressMinutesForHour(5, 6)).toBe(23 * 60);
  });

  it("treats boundary=23 as the late-night-boundary corner case", () => {
    // dayBoundaryHour=23 → 23:00 is hour 0, midnight is hour 1.
    expect(getProgressMinutesForHour(23, 23)).toBe(0);
    expect(getProgressMinutesForHour(0, 23)).toBe(60);
    expect(getProgressMinutesForHour(22, 23)).toBe(23 * 60);
  });
});

// ── shouldCatchUpHourlyCheck ──────────────────────────────────────────────
// Catch-up runs when (a) hourly check is enabled, (b) we're inside active
// hours and not on the day-boundary hour, and (c) the most recent slot
// (anchored at activeStartHour) hasn't already produced a hourly_check
// agent_actions row. Slot math must remain consistent with scheduler.ts's
// `shouldFireHourlyTickAt`, which anchors at the same activeStartHour.

const defaultHourlyConfig = {
  timezone: "Asia/Tokyo",
  dayBoundaryHour: 4,
  hourlyCheckEnabled: true,
  hourlyCheckIntervalMinutes: 60,
  hourlyCheckActiveStartHour: 4,
  hourlyCheckActiveEndHour: 24,
} as unknown as AgentConfig;

function insertHourlyAction(
  db: Database.Database,
  startedAt: string,
  result: "success" | "failed" = "success",
): void {
  db
    .prepare(
      `INSERT INTO agent_actions
         (event_id, action_type, result, started_at, completed_at)
       VALUES (?, 'routine.hourly_check', ?, ?, ?)`,
    )
    .run(
      "evt-" + Math.random().toString(36).slice(2),
      result,
      startedAt,
      startedAt,
    );
}

describe("shouldCatchUpHourlyCheck", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns false when hourlyCheckEnabled=false (early exit)", () => {
    const cfg = { ...defaultHourlyConfig, hourlyCheckEnabled: false } as AgentConfig;
    const now = new Date("2026-05-14T08:00:00Z"); // 17:00 JST
    expect(shouldCatchUpHourlyCheck(db, cfg, now)).toBe(false);
  });

  it("falls back to the system zone when config.timezone is the empty string", () => {
    // Covers the `config.timezone || undefined` branch where timezone is
    // a falsy string (e.g. unset by the runtime-settings default). The
    // function must not throw and must use the wall-clock zone instead.
    const cfg = { ...defaultHourlyConfig, timezone: "" } as AgentConfig;
    const now = new Date("2026-05-14T08:00:00Z");
    // We're not asserting the boolean result (it depends on the test
    // host's TZ); we're asserting the path does not throw and returns a
    // boolean — that pins the branch.
    expect(typeof shouldCatchUpHourlyCheck(db, cfg, now)).toBe("boolean");
  });

  it("returns false before the active-start hour", () => {
    // 03:30 JST = before 04:00 active start.
    const now = new Date("2026-05-13T18:30:00Z");
    expect(shouldCatchUpHourlyCheck(db, defaultHourlyConfig, now)).toBe(false);
  });

  it("returns false at or after the active-end hour", () => {
    // activeEndHour=24 means [4, 24) — so 23:00 is inside, but if we set
    // activeEndHour=22, then 22:00 JST should be outside.
    const cfg = { ...defaultHourlyConfig, hourlyCheckActiveEndHour: 22 } as AgentConfig;
    const now = new Date("2026-05-14T13:00:00Z"); // 22:00 JST
    expect(shouldCatchUpHourlyCheck(db, cfg, now)).toBe(false);
  });

  it("returns false when the local hour equals the day-boundary hour", () => {
    // The boundary hour is carved out to avoid double-firing at the same
    // moment the agent-day starts.
    const now = new Date("2026-05-13T19:30:00Z"); // 04:30 JST
    expect(shouldCatchUpHourlyCheck(db, defaultHourlyConfig, now)).toBe(false);
  });

  it("returns true when inside active hours and no hourly_check row exists at the current slot", () => {
    const now = new Date("2026-05-14T08:00:00Z"); // 17:00 JST sharp
    expect(shouldCatchUpHourlyCheck(db, defaultHourlyConfig, now)).toBe(true);
  });

  it("returns false when an hourly_check row already exists inside the current slot", () => {
    // 17:00 JST slot with interval=60 spans [17:00, 18:00). An action at
    // 17:30 JST (08:30 UTC) sits inside that slot.
    insertHourlyAction(db, "2026-05-14 08:30:00");
    const now = new Date("2026-05-14T08:45:00Z"); // 17:45 JST
    expect(shouldCatchUpHourlyCheck(db, defaultHourlyConfig, now)).toBe(false);
  });

  it("returns true when the only hourly_check row sits in a *prior* slot", () => {
    // 16:00–17:00 slot covered; we're now in the 17:00–18:00 slot with
    // nothing yet recorded.
    insertHourlyAction(db, "2026-05-14 07:15:00"); // 16:15 JST
    const now = new Date("2026-05-14T08:30:00Z"); // 17:30 JST
    expect(shouldCatchUpHourlyCheck(db, defaultHourlyConfig, now)).toBe(true);
  });

  it("anchors slots at activeStartHour, not at midnight (45-minute interval)", () => {
    // With activeStartHour=4 and interval=45, slots start 4:00, 4:45,
    // 5:30, … The 17:00 JST (08:00 UTC) wall-clock fits *somewhere*
    // depending on the anchor. anchorMinutes = 240, current = 17*60=1020,
    // offset = 780, slotOffset = floor(780/45)*45 = 17*45 = 765, slot start
    // = 240 + 765 = 1005 → 16:45 JST. An action at 16:50 JST (07:50 UTC)
    // sits inside this slot and should suppress catch-up.
    const cfg = { ...defaultHourlyConfig, hourlyCheckIntervalMinutes: 45 } as AgentConfig;
    insertHourlyAction(db, "2026-05-14 07:50:00"); // 16:50 JST
    const now = new Date("2026-05-14T08:00:00Z"); // 17:00 JST
    expect(shouldCatchUpHourlyCheck(db, cfg, now)).toBe(false);
  });

  it("still finds a stale slot when the only existing row is from the previous interval", () => {
    // Inverse of the previous test: same 45-min interval, but the latest
    // action sat in the 16:00–16:45 slot, not the current 16:45–17:30 slot.
    const cfg = { ...defaultHourlyConfig, hourlyCheckIntervalMinutes: 45 } as AgentConfig;
    insertHourlyAction(db, "2026-05-14 07:30:00"); // 16:30 JST — prior slot
    const now = new Date("2026-05-14T08:00:00Z"); // 17:00 JST
    expect(shouldCatchUpHourlyCheck(db, cfg, now)).toBe(true);
  });
});

// ── getDueCatchupRoutines ────────────────────────────────────────────────
// After 18:00 local (in agent-day-progress terms), the boot-time catch-up
// queues evening_review / weekly_review (Fri) / monthly_review (when
// tomorrow's local date is the 1st), each suppressed by a matching
// agent_actions row inside the current agent-day window.

function insertReviewAction(
  db: Database.Database,
  actionType: string,
  startedAt: string,
): void {
  db
    .prepare(
      `INSERT INTO agent_actions
         (event_id, action_type, result, started_at, completed_at)
       VALUES (?, ?, 'success', ?, ?)`,
    )
    .run(
      "evt-" + Math.random().toString(36).slice(2),
      actionType,
      startedAt,
      startedAt,
    );
}

const reviewConfig = {
  timezone: "Asia/Tokyo",
  dayBoundaryHour: 4,
  // Monthly review is default-off (kill switch); existing review tests
  // assert the historical behavior where catchup queues monthly on the
  // last day of the month. Flip it on for the fixture, and pin the
  // disabled behavior in its own test below.
  monthlyReviewEnabled: true,
} as unknown as AgentConfig;

describe("getDueCatchupRoutines", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("falls back to the system zone when config.timezone is the empty string", () => {
    // Covers the `config.timezone || undefined` branch in
    // `getDueCatchupRoutines`. Mirrors the parallel branch in
    // `shouldCatchUpHourlyCheck` — the helper must not throw on empty
    // timezone; it just resolves against the wall-clock zone.
    const cfg = { ...reviewConfig, timezone: "" } as AgentConfig;
    const now = new Date("2026-05-14T08:30:00Z");
    expect(
      Array.isArray(
        getDueCatchupRoutines(
          db,
          cfg,
          "2026-05-13 19:00:00",
          "2026-05-14 19:00:00",
          now,
        ),
      ),
    ).toBe(true);
  });

  it("returns [] when current time is before the 18:00 due-line", () => {
    // 2026-05-14 (Thursday) 17:30 JST is 13.5h into the agent-day; the
    // gate requires getProgressMinutesForHour(18, 4) = 14h.
    const now = new Date("2026-05-14T08:30:00Z");
    const bounds = {
      start: "2026-05-13 19:00:00",
      end: "2026-05-14 19:00:00",
    };
    expect(getDueCatchupRoutines(db, reviewConfig, bounds.start, bounds.end, now))
      .toEqual([]);
  });

  it("returns ['evening_review'] after 18:00 on a non-Friday non-month-end day", () => {
    // 2026-05-14 (Thursday) 19:00 JST = 10:00 UTC.
    const now = new Date("2026-05-14T10:00:00Z");
    expect(
      getDueCatchupRoutines(
        db,
        reviewConfig,
        "2026-05-13 19:00:00",
        "2026-05-14 19:00:00",
        now,
      ),
    ).toEqual(["evening_review"]);
  });

  it("suppresses evening_review when an action row already exists inside the agent-day window", () => {
    insertReviewAction(db, "routine.evening_review", "2026-05-14 09:00:00");
    const now = new Date("2026-05-14T10:00:00Z"); // 19:00 JST
    expect(
      getDueCatchupRoutines(
        db,
        reviewConfig,
        "2026-05-13 19:00:00",
        "2026-05-14 19:00:00",
        now,
      ),
    ).toEqual([]);
  });

  it("queues weekly_review on Friday (dayOfWeek === 5)", () => {
    // 2026-05-15 was a Friday — agent-day starting 2026-05-14 19:00 UTC,
    // local Friday in Tokyo.
    const now = new Date("2026-05-15T10:00:00Z"); // 19:00 JST Friday
    expect(
      getDueCatchupRoutines(
        db,
        reviewConfig,
        "2026-05-14 19:00:00",
        "2026-05-15 19:00:00",
        now,
      ),
    ).toEqual(["evening_review", "weekly_review"]);
  });

  it("queues monthly_review on the last day of the month (tomorrow.day === 1)", () => {
    // 2026-05-31 (Sunday) — tomorrow is 2026-06-01 (day=1).
    // Sunday is also in the weekly_review catchup window
    // (weekly-next-week-leverage.md §6), so weekly is queued too unless
    // already run.
    const now = new Date("2026-05-31T10:00:00Z"); // 19:00 JST Sunday
    expect(
      getDueCatchupRoutines(
        db,
        reviewConfig,
        "2026-05-30 19:00:00",
        "2026-05-31 19:00:00",
        now,
      ),
    ).toEqual(["evening_review", "weekly_review", "monthly_review"]);
  });

  it("does NOT queue monthly_review when monthlyReviewEnabled=false (kill switch off)", () => {
    // Same scenario as the previous test, but with the kill switch off
    // (the pre-release default). Monthly catchup must be suppressed so
    // the disabled routine cannot fire via boot-time recovery either.
    // Weekly + evening continue to queue — the flag is monthly-only.
    const cfg = {
      ...reviewConfig,
      monthlyReviewEnabled: false,
    } as AgentConfig;
    const now = new Date("2026-05-31T10:00:00Z"); // 19:00 JST Sunday
    expect(
      getDueCatchupRoutines(
        db,
        cfg,
        "2026-05-30 19:00:00",
        "2026-05-31 19:00:00",
        now,
      ),
    ).toEqual(["evening_review", "weekly_review"]);
  });

  // weekly-next-week-leverage.md §6 — catchup extends Fri → Sat → Sun
  // so a Fri-evening daemon outage can still land the file before the
  // new ISO week's morning_routines read it via `<previous_week>`.
  //
  // The fixtures below use dates whose JST-local agent-day boundary
  // (04:00 JST = 19:00 UTC of the previous calendar day) lands on the
  // target weekday — match the `agent-day` semantics the rest of the
  // file uses.

  it("queues weekly_review on Saturday catchup (dayOfWeek === 6)", () => {
    // 2026-05-16 was a Saturday. Agent-day starts 2026-05-15 19:00 UTC.
    const now = new Date("2026-05-16T10:00:00Z");
    expect(
      getDueCatchupRoutines(
        db,
        reviewConfig,
        "2026-05-15 19:00:00",
        "2026-05-16 19:00:00",
        now,
      ),
    ).toEqual(["evening_review", "weekly_review"]);
  });

  it("queues weekly_review on Sunday catchup (dayOfWeek === 0)", () => {
    // 2026-05-17 was a Sunday. Use a non-month-end Sunday so monthly
    // does not also queue (covered by a separate test below).
    const now = new Date("2026-05-17T10:00:00Z");
    expect(
      getDueCatchupRoutines(
        db,
        reviewConfig,
        "2026-05-16 19:00:00",
        "2026-05-17 19:00:00",
        now,
      ),
    ).toEqual(["evening_review", "weekly_review"]);
  });

  it("suppresses weekly_review on Saturday when the Friday slot already ran", () => {
    // The canonical Friday slot fires inside the Friday agent-day,
    // BEFORE Saturday's agent-day boundary at 2026-05-15 19:00 UTC.
    // The Sat catchup must look back to Friday's agent-day start
    // (2026-05-14 19:00 UTC) to find the prior run, otherwise it
    // would falsely re-fire. This is the regression weekly-next-week-
    // leverage.md §6's wider suppression window prevents.
    insertReviewAction(db, "routine.weekly_review", "2026-05-15 10:00:00");
    const now = new Date("2026-05-16T10:00:00Z");
    expect(
      getDueCatchupRoutines(
        db,
        reviewConfig,
        "2026-05-15 19:00:00",
        "2026-05-16 19:00:00",
        now,
      ),
    ).toEqual(["evening_review"]);
  });

  it("suppresses weekly_review on Sunday when the Saturday catchup already ran", () => {
    // Two-step propagation: Fri missed, Sat catchup fired. Sun catchup
    // must not re-fire. Inserted timestamp is inside the Saturday
    // agent-day (2026-05-15 19:00 → 2026-05-16 19:00 UTC).
    insertReviewAction(db, "routine.weekly_review", "2026-05-16 09:00:00");
    const now = new Date("2026-05-17T10:00:00Z");
    expect(
      getDueCatchupRoutines(
        db,
        reviewConfig,
        "2026-05-16 19:00:00",
        "2026-05-17 19:00:00",
        now,
      ),
    ).toEqual(["evening_review"]);
  });

  it("does NOT queue weekly_review on a Monday (catchup window is Fri-Sun only)", () => {
    // 2026-05-18 was a Monday. Mon–Thu catchup is intentionally out of
    // scope — by then the new ISO week's daily files exist and a
    // backfilled review would distort the morning-routine signal.
    const now = new Date("2026-05-18T10:00:00Z");
    expect(
      getDueCatchupRoutines(
        db,
        reviewConfig,
        "2026-05-17 19:00:00",
        "2026-05-18 19:00:00",
        now,
      ),
    ).toEqual(["evening_review"]);
  });

  it("queues all three when Friday is also the last day of the month", () => {
    // 2026-07-31 was a Friday and the last day of July.
    const now = new Date("2026-07-31T10:00:00Z"); // 19:00 JST
    expect(
      getDueCatchupRoutines(
        db,
        reviewConfig,
        "2026-07-30 19:00:00",
        "2026-07-31 19:00:00",
        now,
      ),
    ).toEqual(["evening_review", "weekly_review", "monthly_review"]);
  });

  it("emits review keys in the documented order even when only some are suppressed", () => {
    // Friday month-end with weekly already done — monthly + evening still due.
    insertReviewAction(db, "routine.weekly_review", "2026-07-31 09:00:00");
    const now = new Date("2026-07-31T10:00:00Z");
    expect(
      getDueCatchupRoutines(
        db,
        reviewConfig,
        "2026-07-30 19:00:00",
        "2026-07-31 19:00:00",
        now,
      ),
    ).toEqual(["evening_review", "monthly_review"]);
  });
});

// ── hasFreshAgentDayTodayMd ──────────────────────────────────────────────
// today.md "freshness" is judged purely by whether its first line includes
// the agent-day date string. Used by boot to decide whether to ask the
// agent to refresh today.md.

describe("hasFreshAgentDayTodayMd", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "schedule-helpers-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns false when today.md does not exist", () => {
    const now = new Date("2026-05-14T08:00:00Z");
    expect(hasFreshAgentDayTodayMd(join(dir, "today.md"), "Asia/Tokyo", 4, now))
      .toBe(false);
  });

  it("returns true when the first line embeds today's agent-day date", () => {
    const path = join(dir, "today.md");
    writeFileSync(path, "# 2026-05-14 Plan\n\nbody\n");
    const now = new Date("2026-05-14T08:00:00Z"); // 17:00 JST → agent-day 2026-05-14
    expect(hasFreshAgentDayTodayMd(path, "Asia/Tokyo", 4, now)).toBe(true);
  });

  it("returns false when the first line embeds yesterday's date", () => {
    const path = join(dir, "today.md");
    writeFileSync(path, "# 2026-05-13 Plan\n");
    const now = new Date("2026-05-14T08:00:00Z");
    expect(hasFreshAgentDayTodayMd(path, "Asia/Tokyo", 4, now)).toBe(false);
  });

  it("respects the agent-day boundary — pre-04:00 JST still maps to yesterday", () => {
    // 2026-05-14 02:00 JST = 2026-05-13 17:00 UTC. Agent-day = 2026-05-13.
    const path = join(dir, "today.md");
    writeFileSync(path, "# 2026-05-13 Plan\n");
    const now = new Date("2026-05-13T17:00:00Z");
    expect(hasFreshAgentDayTodayMd(path, "Asia/Tokyo", 4, now)).toBe(true);
  });

  it("returns false when the file exists but is empty", () => {
    const path = join(dir, "today.md");
    writeFileSync(path, "");
    const now = new Date("2026-05-14T08:00:00Z");
    expect(hasFreshAgentDayTodayMd(path, "Asia/Tokyo", 4, now)).toBe(false);
  });
});

// ── readSkillCurationCadence ─────────────────────────────────────────────

describe("readSkillCurationCadence", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function writeConfig(value: unknown): void {
    db
      .prepare(`INSERT INTO runtime_state (key, value_json) VALUES (?, ?)`)
      .run("skill_curation.config", JSON.stringify(value));
  }

  it("defaults to 'weekly' when the runtime_state row is missing", () => {
    expect(readSkillCurationCadence(db)).toBe("weekly");
  });

  it("returns the configured cadence when present", () => {
    writeConfig({ cadence: "daily" });
    expect(readSkillCurationCadence(db)).toBe("daily");
    db.exec(`DELETE FROM runtime_state WHERE key = 'skill_curation.config'`);
    writeConfig({ cadence: "monthly" });
    expect(readSkillCurationCadence(db)).toBe("monthly");
  });

  it("defaults to 'weekly' when the cadence field is missing from the JSON", () => {
    writeConfig({});
    expect(readSkillCurationCadence(db)).toBe("weekly");
  });

  it("defaults to 'weekly' when the JSON is corrupt", () => {
    db
      .prepare(`INSERT INTO runtime_state (key, value_json) VALUES (?, ?)`)
      .run("skill_curation.config", "{not valid json");
    expect(readSkillCurationCadence(db)).toBe("weekly");
  });
});

// ── Morning self-heal predicates (missed-fire + hung-execution recovery) ──

function insertMorningAttempt(
  db: Database.Database,
  opts: {
    actionType?: string;
    result: "success" | "failed" | "in_progress";
    startedAt: string;
  },
): void {
  db
    .prepare(
      `INSERT INTO agent_actions
         (event_id, action_type, result, started_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      "evt-" + Math.random().toString(36).slice(2),
      opts.actionType ?? "routine.morning_routine_today",
      opts.result,
      opts.startedAt,
    );
}

describe("getLatestMorningAttemptStartMs", () => {
  let db: Database.Database;
  // 19:00 JST on 2026-05-14 — agent-day 2026-05-14 spans
  // [2026-05-13 19:00 UTC, 2026-05-14 19:00 UTC) for the tokyo config.
  const NOW = new Date("2026-05-14T10:00:00Z");

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns null when no attempt has started this agent-day", () => {
    expect(getLatestMorningAttemptStartMs(db, tokyo, NOW)).toBeNull();
  });

  it("returns the most recent attempt across parent and Stage A rows, including in_progress", () => {
    insertMorningRoutine(db, { result: "failed", startedAt: "2026-05-14 01:00:00" });
    insertMorningAttempt(db, { result: "in_progress", startedAt: "2026-05-14 02:00:00" });
    expect(getLatestMorningAttemptStartMs(db, tokyo, NOW)).toBe(
      Date.parse("2026-05-14T02:00:00Z"),
    );
  });

  it("ignores attempts from the previous agent-day", () => {
    insertMorningAttempt(db, { result: "success", startedAt: "2026-05-13 12:00:00" });
    expect(getLatestMorningAttemptStartMs(db, tokyo, NOW)).toBeNull();
  });
});

describe("getRecoverableStalledMorningWake", () => {
  let db: Database.Database;
  const NOW = new Date("2026-05-14T10:00:00Z");
  const THRESHOLD = 120;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function insertWakeWithContext(
    status: "pending" | "running",
    taskContext: string,
  ): number {
    const result = db
      .prepare(
        `INSERT INTO agent_schedule
           (scheduled_for, task_type, task_description, task_context, status, created_at)
         VALUES ('2026-05-14 05:00:00', 'wake', 'Morning routine', ?, ?, '2026-05-14 05:00:00')`,
      )
      .run(taskContext, status);
    return Number(result.lastInsertRowid);
  }

  const ctxWithClaim = (claimedAt: string) =>
    JSON.stringify({ routine: "morning_routine", claimedAt });

  it("returns null when no morning wake row exists", () => {
    expect(getRecoverableStalledMorningWake(db, tokyo, THRESHOLD, NOW)).toBeNull();
    // Default-clock variant — deterministic on an empty DB.
    expect(getRecoverableStalledMorningWake(db, tokyo, THRESHOLD)).toBeNull();
  });

  it("returns null for a pending (not running) wake row — backoff retries are not hung", () => {
    insertWakeWithContext("pending", ctxWithClaim("2026-05-14 05:00:00"));
    expect(getRecoverableStalledMorningWake(db, tokyo, THRESHOLD, NOW)).toBeNull();
  });

  it("returns null for a running row without a claim stamp — alert-only", () => {
    insertWakeWithContext("running", JSON.stringify({ routine: "morning_routine" }));
    expect(getRecoverableStalledMorningWake(db, tokyo, THRESHOLD, NOW)).toBeNull();
  });

  it("returns null when the claim stamp is not a parseable timestamp", () => {
    insertWakeWithContext(
      "running",
      JSON.stringify({ routine: "morning_routine", claimedAt: "garbage" }),
    );
    expect(getRecoverableStalledMorningWake(db, tokyo, THRESHOLD, NOW)).toBeNull();
    db.exec("DELETE FROM agent_schedule");
    insertWakeWithContext(
      "running",
      JSON.stringify({ routine: "morning_routine", claimedAt: 12345 }),
    );
    expect(getRecoverableStalledMorningWake(db, tokyo, THRESHOLD, NOW)).toBeNull();
  });

  it("returns null when task_context is JSON5 — valid to SQLite's parser, not to JSON.parse", () => {
    // SQLite >= 3.42 json_extract accepts JSON5 (unquoted keys), so the
    // row matches the WHERE while the JS-side strict parse throws.
    insertWakeWithContext(
      "running",
      "{routine:'morning_routine',claimedAt:'2026-05-14 05:00:00'}",
    );
    expect(getRecoverableStalledMorningWake(db, tokyo, THRESHOLD, NOW)).toBeNull();
  });

  it("returns null while the claim is younger than the threshold", () => {
    insertWakeWithContext("running", ctxWithClaim("2026-05-14 09:30:00"));
    expect(getRecoverableStalledMorningWake(db, tokyo, THRESHOLD, NOW)).toBeNull();
  });

  it("returns the row when the claim is older than the threshold with no success", () => {
    const id = insertWakeWithContext("running", ctxWithClaim("2026-05-14 05:05:00"));
    const recoverable = getRecoverableStalledMorningWake(db, tokyo, THRESHOLD, NOW);
    expect(recoverable).toEqual({ id, claimedAgeMinutes: 295 });
  });

  it("recovers a claim from before the agent-day boundary (hung overnight run)", () => {
    // Claimed 22:55 the previous agent-day; at 04:30+ the next day the
    // stamp is ~5.6h old. An agent-day-windowed signal would miss this.
    const id = insertWakeWithContext("running", ctxWithClaim("2026-05-13 22:55:00"));
    const recoverable = getRecoverableStalledMorningWake(
      db,
      tokyo,
      THRESHOLD,
      new Date("2026-05-14T04:30:00Z"),
    );
    expect(recoverable).toEqual({ id, claimedAgeMinutes: 335 });
  });

  it("returns null once the morning routine has succeeded this agent-day", () => {
    insertWakeWithContext("running", ctxWithClaim("2026-05-14 05:05:00"));
    insertMorningRoutine(db, { result: "success", startedAt: "2026-05-14 06:00:00" });
    expect(getRecoverableStalledMorningWake(db, tokyo, THRESHOLD, NOW)).toBeNull();
  });
});

describe("shouldQueueMissedMorningFire", () => {
  let db: Database.Database;
  const NOW = new Date("2026-05-14T10:00:00Z");
  const GRACE = MORNING_MISSED_FIRE_GRACE_MINUTES;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns false inside the post-boundary grace window", () => {
    // 04:10 JST — 10 minutes into the agent-day, under the 15-min grace.
    expect(
      shouldQueueMissedMorningFire(db, tokyo, GRACE, new Date("2026-05-13T19:10:00Z")),
    ).toBe(false);
  });

  it("returns false while a pending or running morning wake row exists", () => {
    insertMorningWake(db, { createdAt: "2026-05-14 05:00:00", status: "pending" });
    expect(shouldQueueMissedMorningFire(db, tokyo, GRACE, NOW)).toBe(false);
    db.prepare("UPDATE agent_schedule SET status = 'running'").run();
    expect(shouldQueueMissedMorningFire(db, tokyo, GRACE, NOW)).toBe(false);
  });

  it("returns false when any attempt exists — never resurrects an exhausted retry chain", () => {
    insertMorningRoutine(db, { result: "failed", startedAt: "2026-05-14 02:00:00" });
    expect(shouldQueueMissedMorningFire(db, tokyo, GRACE, NOW)).toBe(false);
  });

  it("returns true when the boundary fire was swallowed: no attempt, no live wake row, grace elapsed", () => {
    // A completed wake row from a prior day must not mask the miss.
    insertMorningWake(db, { createdAt: "2026-05-13 05:00:00", status: "completed" });
    expect(shouldQueueMissedMorningFire(db, tokyo, GRACE, NOW)).toBe(true);
    // Default-clock variant — grace 0 makes the progress check pass at
    // any real wall-clock instant, and the empty-DB conditions are
    // time-independent.
    expect(shouldQueueMissedMorningFire(db, tokyo, 0)).toBe(true);
  });
});
