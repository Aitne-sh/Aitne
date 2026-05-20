/**
 * Pure schedule predicates and progress math used by the boot-time catchup
 * sequence in `bootstrap/catchup.ts` and by the inline routine-readiness
 * check in `index.ts`. Pattern A pure-move from `index.ts` per
 * `docs/design/appendices/file-split-plan.md` §10.
 *
 * No instance state, no captured closures. Every function takes its
 * dependencies (db handle, config, clock) as arguments so the boot
 * sequence can compose them without going through `this`.
 */

import type Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import {
  formatSqliteDatetime,
  getAgentDayBoundsUtc,
  getAgentDayDateStr,
  getAgentDayProgressMinutes,
  nowInTimezone,
  parseSqliteUtcMs,
} from "@aitne/shared";
import type { AgentConfig } from "../config.js";
import { hasActionInWindow } from "../core/schedule-maintenance.js";

/**
 * Days of week on which the boot-time catchup will fire an unrun
 * `routine.weekly_review`. Friday is the canonical slot; Saturday and
 * Sunday extend the window so a Fri-evening daemon outage can still
 * land the week's file before the new ISO week's morning_routines
 * begin reading it via `<previous_week>`.
 *
 * Exported for tests and for any future cross-package introspection
 * (e.g. dashboard "next catchup" surface). Reads only — mutating this
 * set would silently change scheduling behaviour.
 */
export const WEEKLY_REVIEW_CATCHUP_DAYS_OF_WEEK = new Set<number>([5, 6, 0]);

export function getDueCatchupRoutines(
  db: Database.Database,
  config: AgentConfig,
  agentDayStartUtc: string,
  agentDayEndUtc: string,
  now: Date,
): string[] {
  const tz = config.timezone || undefined;
  const progressMinutes = getAgentDayProgressMinutes(
    tz,
    config.dayBoundaryHour,
    now,
  );
  const dueAt18 = getProgressMinutesForHour(18, config.dayBoundaryHour);
  if (progressMinutes < dueAt18) {
    return [];
  }

  const routines: string[] = [];
  const agentDayStartMs = parseSqliteUtcMs(agentDayStartUtc);
  const agentDayLocal = nowInTimezone(tz, new Date(agentDayStartMs));
  const tomorrowLocal = nowInTimezone(
    tz,
    new Date(agentDayStartMs + 24 * 60 * 60 * 1000),
  );

  if (!hasActionInWindow(db, "routine.evening_review", agentDayStartUtc, agentDayEndUtc)) {
    routines.push("evening_review");
  }

  // `docs/design/appendices/weekly-next-week-leverage.md` §6 — catchup
  // window for weekly_review extends Friday through Sunday. The
  // `<previous_week>` injection wired into every Mon–Sun morning_routine
  // assumes `weekly/YYYY-W{prev}.md` exists, so a Fri-evening daemon
  // outage that wedges the routine until the weekend must still produce
  // the file before the new ISO week begins. Mon–Thu catchup is
  // intentionally out of scope: by then the new week has its own daily
  // files and a backfilled review would distort the morning-routine
  // signal it feeds into.
  //
  // Suppression must look back to Friday's agent-day start — not the
  // current agent-day — otherwise a successful Friday fire would not
  // suppress the Saturday or Sunday catchup, causing a double-fire on
  // the weekend after a healthy Friday run. Step back
  // `(dayOfWeek - 5 + 7) % 7` days from the current agent-day boundary
  // to land on the matching Friday boundary.
  //
  // dayOfWeek convention (from `nowInTimezone`): 0 = Sunday,
  // 5 = Friday, 6 = Saturday.
  if (WEEKLY_REVIEW_CATCHUP_DAYS_OF_WEEK.has(agentDayLocal.dayOfWeek)) {
    const daysSinceFriday = (agentDayLocal.dayOfWeek - 5 + 7) % 7;
    const fridayWindowStartMs =
      agentDayStartMs - daysSinceFriday * 24 * 60 * 60 * 1000;
    const fridayWindowStartUtc = formatSqliteDatetime(
      new Date(fridayWindowStartMs),
    );
    if (
      !hasActionInWindow(
        db,
        "routine.weekly_review",
        fridayWindowStartUtc,
        agentDayEndUtc,
      )
    ) {
      routines.push("weekly_review");
    }
  }

  // Monthly catchup is gated by the same kill switch as the scheduler
  // cron (see scheduler.ts comment block). Default OFF pre-release until
  // the Mirror+Prune redesign; operators opt in via
  // PA_MONTHLY_REVIEW_ENABLED or PATCH /api/config.
  if (
    config.monthlyReviewEnabled &&
    tomorrowLocal.day === 1 &&
    !hasActionInWindow(db, "routine.monthly_review", agentDayStartUtc, agentDayEndUtc)
  ) {
    routines.push("monthly_review");
  }

  return routines;
}

/**
 * Decide whether the boot sequence should immediately fire one
 * catch-up `routine.hourly_check` (because the cron callback never ran
 * for the current slot — typically because the host was asleep / the
 * daemon was stopped during the slot window).
 *
 * Slot math mirrors `shouldFireHourlyTickAt` in `scheduler.ts` so the
 * catch-up always lands on the same slot the cron would have fired at.
 *
 * **Wrap-around active hours are NOT supported.** The active-hours
 * window is interpreted as the contiguous range
 * `[activeStartHour, activeEndHour)`. A user-set configuration where
 * `activeStartHour > activeEndHour` (e.g. start=22, end=4 — wanting
 * "active overnight") would short-circuit on the
 * `local.hours >= activeEndHour` branch for every hour after 04:00,
 * silently disabling hourly catch-up. The runtime-settings validator
 * does not currently cross-check the two values (CLAUDE.md notes the
 * gap under "Active-hours and quiet-hours strings are validated
 * independently … there is no cross-window non-overlap check today").
 * Operators with overnight workloads should set
 * `activeStartHour=0, activeEndHour=24` (covers the full day) rather
 * than attempting wrap-around. If wrap-around becomes a real
 * requirement, the fix is to either (a) reject `start > end` at
 * config-write time, or (b) split the window into two non-wrap
 * ranges in the same call site that consumes them.
 */
export function shouldCatchUpHourlyCheck(
  db: Database.Database,
  config: AgentConfig,
  now: Date,
): boolean {
  if (!config.hourlyCheckEnabled) {
    return false;
  }

  const tz = config.timezone || undefined;
  const local = nowInTimezone(tz, now);
  if (
    local.hours < config.hourlyCheckActiveStartHour ||
    local.hours >= config.hourlyCheckActiveEndHour ||
    local.hours === config.dayBoundaryHour
  ) {
    return false;
  }

  // Slot anchors to `activeStartHour`, mirroring shouldFireHourlyTickAt
  // in scheduler.ts so the catch-up function picks the same slot the
  // cron callback would have fired at. The earlier branch already
  // returned false when local.hours < activeStartHour, so the offset is
  // always non-negative here.
  const anchorMinutes = config.hourlyCheckActiveStartHour * 60;
  const offsetFromAnchor =
    local.hours * 60 + local.minutes - anchorMinutes;
  const slotOffsetFromAnchor =
    Math.floor(offsetFromAnchor / config.hourlyCheckIntervalMinutes) *
    config.hourlyCheckIntervalMinutes;
  const slotMinutesSinceMidnight = anchorMinutes + slotOffsetFromAnchor;
  const dayStartUtc = getAgentDayBoundsUtc(tz, 0, now).start;
  const slotStartMs =
    parseSqliteUtcMs(dayStartUtc) + slotMinutesSinceMidnight * 60 * 1000;
  const slotStartUtc = formatSqliteDatetime(new Date(slotStartMs));

  return !hasActionInWindow(
    db,
    "routine.hourly_check",
    slotStartUtc,
    formatSqliteDatetime(now),
  );
}

export function getProgressMinutesForHour(hour: number, dayBoundaryHour: number): number {
  const scheduledMinutes = hour * 60;
  const boundaryMinutes = dayBoundaryHour * 60;
  return scheduledMinutes >= boundaryMinutes
    ? scheduledMinutes - boundaryMinutes
    : 24 * 60 - boundaryMinutes + scheduledMinutes;
}

export function hasFreshAgentDayTodayMd(
  todayMdPath: string,
  timezone: string | undefined,
  dayBoundaryHour: number,
  now?: Date,
): boolean {
  if (!existsSync(todayMdPath)) {
    return false;
  }

  // `String.split` always returns a non-empty array, so index 0 is
  // defined for any contents — including the empty string. A `?? ""`
  // fallback would be dead defensive code.
  const firstLine = readFileSync(todayMdPath, "utf-8").split("\n")[0]!;
  const today = getAgentDayDateStr(timezone, dayBoundaryHour, now);
  return firstLine.includes(today);
}

/**
 * Did `routine.morning_routine` complete successfully within the current
 * agent-day window? Used by the pre-routine gate that fronts hourly_check
 * and the review routines (evening / weekly / monthly) so they refuse to
 * run before the day has been properly opened.
 *
 * Authoritative signal: `agent_actions` rather than today.md, because
 * today.md can be mutated by the user (manual rollover, DM-driven edits)
 * and we hit exactly that failure mode on 2026-05-14 — the Mac slept
 * through the 04:00 cron, the user manually rolled today.md to the new
 * date, and `hasFreshAgentDayTodayMd` then falsely reported "morning
 * routine done". `agent_actions.result='success'` never lies.
 *
 * Pure: takes db + agent-day config, returns boolean.
 */
export function morningRoutineRanToday(
  db: Database.Database,
  agentDayConfig: { timezone?: string; dayBoundaryHour: number },
  now?: Date,
): boolean {
  const { start } = getAgentDayBoundsUtc(
    agentDayConfig.timezone,
    agentDayConfig.dayBoundaryHour,
    now,
  );
  const row = db
    .prepare(
      `SELECT 1
         FROM agent_actions
        WHERE action_type = 'routine.morning_routine'
          AND result = 'success'
          AND started_at >= ?
        LIMIT 1`,
    )
    .get(start);
  return row !== undefined;
}

/**
 * Default threshold for the morning-routine stall watchdog. A wake row
 * older than this without a matching `agent_actions.result='success'`
 * row triggers an owner DM. 120 min is generous enough to cover an
 * unusually slow routine (multiple Sonnet turns + slow integrations)
 * while still alerting before the entire agent-day is blocked.
 *
 * Operators with atypically slow morning routines can override via the
 * `morning_routine.config` runtime_state row — see
 * `readMorningRoutineStallThresholdMinutes`. A floor of 15 minutes is
 * applied so an operator typo cannot flood the DM channel.
 */
export const MORNING_ROUTINE_STALL_THRESHOLD_MINUTES = 120;
const MIN_MORNING_ROUTINE_STALL_THRESHOLD_MINUTES = 15;

/**
 * Resolve the effective stall-threshold minutes from runtime_state, with
 * the default and the operator-side floor applied. Mirrors the
 * `invokerTimeoutSeconds` override path in `delegated-sync-worker.ts` so
 * the two operator-tunable thresholds share a shape:
 *
 *   runtime_state row "morning_routine.config" with
 *     `{ "stallThresholdMinutes": <positive number> }`
 *
 * Missing row, corrupt JSON, or a non-positive value falls through to
 * the built-in default. Sub-floor values clamp up to the floor.
 *
 * Pure read — never writes. Safe to call on every hourly tick.
 */
export const MORNING_ROUTINE_CONFIG_KEY = "morning_routine.config";

export function readMorningRoutineStallThresholdMinutes(
  db: Database.Database,
): number {
  let raw: { value_json: string } | undefined;
  try {
    raw = db
      .prepare(
        `SELECT value_json FROM runtime_state WHERE key = ?`,
      )
      .get(MORNING_ROUTINE_CONFIG_KEY) as { value_json: string } | undefined;
  } catch {
    return MORNING_ROUTINE_STALL_THRESHOLD_MINUTES;
  }
  if (!raw) return MORNING_ROUTINE_STALL_THRESHOLD_MINUTES;
  let parsed: { stallThresholdMinutes?: unknown };
  try {
    parsed = JSON.parse(raw.value_json);
  } catch {
    return MORNING_ROUTINE_STALL_THRESHOLD_MINUTES;
  }
  const value = parsed.stallThresholdMinutes;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return MORNING_ROUTINE_STALL_THRESHOLD_MINUTES;
  }
  return Math.max(value, MIN_MORNING_ROUTINE_STALL_THRESHOLD_MINUTES);
}

export interface StalledMorningRoutineWake {
  /** agent_schedule.id of the offending row. */
  id: number;
  /** Sqlite timestamp the row was created at (UTC). */
  createdAt: string;
  /** Sqlite timestamp the row was scheduled for (UTC). */
  scheduledFor: string;
  /** Current row status (pending / running). */
  status: string;
  /** Minutes between `createdAt` and `now`, rounded. */
  ageMinutes: number;
}

/**
 * Detect when the morning-routine wake row has been queued for too long
 * without producing a successful `agent_actions` row. Returns the
 * offending row's metadata if stalled, null when the system is healthy.
 *
 * Pairs with `queueMorningRoutineWake` + the hourly-check pre-routine
 * gate. The dedup that keeps `queueMorningRoutineWake` from re-inserting
 * means a stuck wake row leaves the system in a silent freeze — the gate
 * skips `routine.hourly_check`, `routine.evening_review`, etc. forever
 * without surfacing to the user. This helper is the externally visible
 * signal the watchdog uses to break the silence.
 *
 * Returns null in three cases:
 *   1. The morning routine already wrote a `result='success'` row today.
 *   2. No `task_type='wake'` row for `routine='morning_routine'` exists
 *      in `pending`/`running` status.
 *   3. The oldest such row is younger than `thresholdMinutes`.
 *
 * Pure: takes db + threshold + clock, returns row metadata.
 */
export function getStalledMorningRoutineWake(
  db: Database.Database,
  agentDayConfig: { timezone?: string; dayBoundaryHour: number },
  thresholdMinutes: number,
  now?: Date,
): StalledMorningRoutineWake | null {
  const reference = now ?? new Date();
  if (morningRoutineRanToday(db, agentDayConfig, reference)) {
    return null;
  }
  const row = db
    .prepare(
      `SELECT id,
              created_at AS createdAt,
              scheduled_for AS scheduledFor,
              status
         FROM agent_schedule
        WHERE task_type = 'wake'
          AND status IN ('pending', 'running')
          AND json_extract(task_context, '$.routine') = 'morning_routine'
        ORDER BY created_at ASC
        LIMIT 1`,
    )
    .get() as
    | { id: number; createdAt: string; scheduledFor: string; status: string }
    | undefined;
  if (!row) return null;
  const createdMs = parseSqliteUtcMs(row.createdAt);
  const ageMinutes = Math.floor((reference.getTime() - createdMs) / 60_000);
  if (ageMinutes < thresholdMinutes) return null;
  return {
    id: row.id,
    createdAt: row.createdAt,
    scheduledFor: row.scheduledFor,
    status: row.status,
    ageMinutes,
  };
}

// P22 — read the operator's chosen cadence for skill curation runs.
// Mirrors the helper in `core/scheduler.ts` so the dispatcher hook here can
// resolve cadence at runtime without crossing module boundaries.
export function readSkillCurationCadence(
  db: Database.Database,
): "daily" | "weekly" | "monthly" {
  const row = db
    .prepare(`SELECT value_json FROM runtime_state WHERE key = 'skill_curation.config'`)
    .get() as { value_json: string } | undefined;
  if (!row) return "weekly";
  try {
    const v = JSON.parse(row.value_json) as { cadence?: "daily" | "weekly" | "monthly" };
    return v.cadence ?? "weekly";
  } catch {
    return "weekly";
  }
}
