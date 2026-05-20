/**
 * Recurrence calculation — pure functions for computing next occurrence
 * from a recurrence rule and a reference date.
 *
 * All internal computation uses the configured timezone so that "09:00 daily"
 * always fires at 09:00 local, even across DST transitions.
 */

import { nowInTimezone } from "@aitne/shared";
import type { RecurrenceRule } from "@aitne/shared";

export type { RecurrenceRule };

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Resolve a RecurrenceRule's timezone, falling back to OS timezone.
 * The API layer fills timezone before storing, but this is a safety net
 * for any code path that calls computeNextOccurrence directly.
 */
function resolveRuleTimezone(rule: RecurrenceRule): string {
  return rule.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Get timezone offset in ms (positive = east of UTC) for a given instant.
 * Uses toLocaleString comparison which handles DST correctly.
 */
function getTimezoneOffsetMs(timezone: string, date: Date): number {
  const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
  const localStr = date.toLocaleString("en-US", { timeZone: timezone });
  return new Date(localStr).getTime() - new Date(utcStr).getTime();
}

/** Build a UTC Date from local date components + timezone. */
function localToUtc(
  timezone: string,
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
): Date {
  // Build a "fake UTC" date with the local components, then subtract the
  // timezone offset at that instant to get the real UTC timestamp.
  const fakeUtc = new Date(Date.UTC(year, month - 1, day, hours, minutes, 0, 0));
  const offset = getTimezoneOffsetMs(timezone, fakeUtc);
  const result = new Date(fakeUtc.getTime() - offset);

  // DST edge: the offset might differ at the real UTC time — recompute once
  const offset2 = getTimezoneOffsetMs(timezone, result);
  /* v8 ignore next 3 — DST spring-forward/fall-back edge; extremely rare and timezone-specific */
  if (offset !== offset2) {
    return new Date(fakeUtc.getTime() - offset2);
  }
  return result;
}

/** Last day of a given month (1-indexed). */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function parseTime(time: string): { hours: number; minutes: number } {
  const [h, m] = time.split(":").map(Number);
  return { hours: h, minutes: m };
}

/** Advance a local date by N days, returning { year, month, day }. */
function addDays(year: number, month: number, day: number, n: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// ── Core calculation ─────────────────────────────────────────────────

/**
 * Compute the next occurrence of a recurring schedule after `referenceUtc`.
 *
 * Returns a UTC Date, or null if no valid occurrence can be computed
 * (e.g. malformed rule).
 *
 * @param rule       The recurrence rule (timezone resolved internally if missing)
 * @param referenceUtc  The reference point. Next occurrence is strictly after this instant.
 */
export function computeNextOccurrence(
  rule: RecurrenceRule,
  referenceUtc: Date,
): Date | null {
  const timezone = resolveRuleTimezone(rule);

  if (rule.frequency === "hourly") {
    return computeNextHourly(
      timezone,
      rule.intervalHours ?? 1,
      rule.minuteOfHour ?? 0,
      referenceUtc,
    );
  }

  // daily / weekly / monthly all carry `time`. The schema guarantees it,
  // but `parseRecurrenceRule` in default-schedules-runner forwards stored
  // rows verbatim — fall back to "00:00" so a malformed row degrades to a
  // never-matching candidate rather than NaN.
  const { hours, minutes } = parseTime(/* c8 ignore next */ rule.time ?? "00:00");
  const local = nowInTimezone(timezone, referenceUtc);

  switch (rule.frequency) {
    case "daily":
      return computeNextDaily(timezone, local, hours, minutes, referenceUtc);
    case "weekly":
      return computeNextWeekly(timezone, local, hours, minutes, referenceUtc, rule.daysOfWeek ?? []);
    case "monthly":
      return computeNextMonthly(
        timezone,
        local,
        hours,
        minutes,
        referenceUtc,
        rule.daysOfMonth ?? [],
        rule.onMissingDay ?? "lastDayOfMonth",
      );
    /* v8 ignore next 2 — TypeScript closed union: all RecurrenceRule frequencies are handled above */
    default:
      return null;
  }
}

function computeNextDaily(
  timezone: string,
  local: { year: number; month: number; day: number },
  hours: number,
  minutes: number,
  referenceUtc: Date,
): Date {
  // Try today
  const candidate = localToUtc(timezone, local.year, local.month, local.day, hours, minutes);
  if (candidate.getTime() > referenceUtc.getTime()) {
    return candidate;
  }
  // Tomorrow
  const tmr = addDays(local.year, local.month, local.day, 1);
  return localToUtc(timezone, tmr.year, tmr.month, tmr.day, hours, minutes);
}

function computeNextWeekly(
  timezone: string,
  local: { year: number; month: number; day: number; dayOfWeek: number },
  hours: number,
  minutes: number,
  referenceUtc: Date,
  daysOfWeek: number[],
): Date | null {
  if (daysOfWeek.length === 0) return null;
  const sorted = [...new Set(daysOfWeek)].sort((a, b) => a - b);

  for (let offset = 0; offset <= 7; offset++) {
    const d = addDays(local.year, local.month, local.day, offset);
    const candidate = localToUtc(timezone, d.year, d.month, d.day, hours, minutes);
    // Determine day-of-week in the target timezone at the candidate time
    const candidateLocal = nowInTimezone(timezone, candidate);

    if (!sorted.includes(candidateLocal.dayOfWeek)) continue;
    if (candidate.getTime() > referenceUtc.getTime()) {
      return candidate;
    }
  /* c8 ignore start — 8-day window guarantees a match before loop exhaustion */
  }
  // 8-day window always contains every weekday, so a non-empty `sorted`
  // guarantees a match before the loop completes.
  return null;
}
/* c8 ignore stop */

function computeNextMonthly(
  timezone: string,
  local: { year: number; month: number },
  hours: number,
  minutes: number,
  referenceUtc: Date,
  daysOfMonth: number[],
  onMissingDay: "skip" | "lastDayOfMonth",
): Date | null {
  if (daysOfMonth.length === 0) return null;
  const sorted = [...new Set(daysOfMonth)].sort((a, b) => a - b);

  let year = local.year;
  let month = local.month;

  // 13-month window is wide enough to cover any monthly cadence in
  // practice — even `[29]` with onMissingDay:"skip" always hits a 29+-day
  // month inside any 13-month window because at least one of {Jan, Mar,
  // May, Jul, Aug, Oct, Dec} appears with day 29 ≤ lastDay. We cap the
  // walk defensively rather than loop forever in case a future caller
  // passes a degenerate set.
  for (let i = 0; i < 13; i++) {
    const lastDay = lastDayOfMonth(year, month);

    // Expand the requested day-of-month list for THIS month with the
    // missing-day policy applied, then de-duplicate so a collision
    // (e.g. [28,31] in non-leap Feb + lastDayOfMonth) fires once.
    const expanded = new Set<number>();
    for (const targetDay of sorted) {
      if (targetDay <= lastDay) {
        expanded.add(targetDay);
      } else if (onMissingDay === "lastDayOfMonth") {
        expanded.add(lastDay);
      }
      // onMissingDay === "skip" → omit this (day, month) pair.
    }

    const monthDays = [...expanded].sort((a, b) => a - b);
    for (const day of monthDays) {
      const candidate = localToUtc(timezone, year, month, day, hours, minutes);
      if (candidate.getTime() > referenceUtc.getTime()) {
        return candidate;
      }
    }

    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  /* c8 ignore start — 13-month window guarantees a match before loop exhaustion for any realistic input */
  }
  return null;
}
/* c8 ignore stop */

/**
 * Compute the next hourly occurrence after `referenceUtc`.
 *
 * Anchoring: `intervalHours=N` fires when `localHour % N == 0` at
 * `minuteOfHour` local. The anchor is local midnight of `timezone`, so
 * N=2 lands on the even hours predictably regardless of when the rule
 * was created. N=1 fires every hour at `minuteOfHour`.
 *
 * DST: skipped local hour drops one fire (we advance one extra hour);
 * doubled local hour fires once (we take the first occurrence via the
 * `localToUtc` offset-recompute path).
 */
export function computeNextHourly(
  timezone: string,
  intervalHours: number,
  minuteOfHour: number,
  referenceUtc: Date,
): Date {
  const local = nowInTimezone(timezone, referenceUtc);

  // Walk forward hour-by-hour starting at the candidate for the current
  // hour. The first candidate whose UTC instant is strictly after the
  // reference and whose local hour-of-day is divisible by intervalHours
  // is the answer. The walk covers DST anomalies because we re-derive
  // the local hour-of-day at every step from the UTC candidate.
  //
  // A 49-iteration cap is enough to bridge two full days (the worst case
  // is a backward-clock DST that repeats an hour and pushes us across a
  // full day twice). In normal cadence this resolves within
  // `intervalHours` steps.
  let hourCursor = local.hours;
  let year = local.year;
  let month = local.month;
  let day = local.day;

  for (let i = 0; i < 49; i++) {
    if (hourCursor >= 24) {
      const next = addDays(year, month, day, 1);
      year = next.year;
      month = next.month;
      day = next.day;
      hourCursor -= 24;
    }
    const candidate = localToUtc(timezone, year, month, day, hourCursor, minuteOfHour);
    // Re-derive the local hour at the candidate to handle DST: the local
    // hour we used to build the candidate may differ from the local hour
    // that candidate actually lands on (spring-forward consumes an hour).
    const candidateLocal = nowInTimezone(timezone, candidate);
    if (
      candidate.getTime() > referenceUtc.getTime()
      && candidateLocal.hours % intervalHours === 0
    ) {
      return candidate;
    }
    hourCursor++;
  /* c8 ignore start — 49-iteration window always finds a valid candidate */
  }
  // Defensive — should never reach here for any valid interval.
  return localToUtc(timezone, year, month, day, hourCursor, minuteOfHour);
}
/* c8 ignore stop */

/**
 * Format a recurrence rule as a human-readable summary.
 */
export function formatRecurrenceLabel(rule: RecurrenceRule): string {
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  switch (rule.frequency) {
    case "hourly": {
      const interval = rule.intervalHours ?? 1;
      const minute = String(rule.minuteOfHour ?? 0).padStart(2, "0");
      return interval === 1
        ? `Every hour at :${minute}`
        : `Every ${interval} hours at :${minute}`;
    }
    case "daily":
      return `Daily at ${/* c8 ignore next */ rule.time ?? "—"}`;
    case "weekly": {
      const days = (rule.daysOfWeek ?? [])
        .slice()
        .sort((a, b) => a - b)
        .map((d) => dayNames[d])
        .join(", ");
      return `Weekly on ${days} at ${/* c8 ignore next */ rule.time ?? "—"}`;
    }
    case "monthly": {
      const days = (rule.daysOfMonth ?? [])
        .slice()
        .sort((a, b) => a - b)
        .join(", ");
      const hasOverflow = (rule.daysOfMonth ?? []).some((d) => d >= 29);
      const policy = rule.onMissingDay ?? "lastDayOfMonth";
      const suffix = !hasOverflow
        ? ""
        : policy === "skip"
        ? " (skips months without that day)"
        : " (falls back to last day of month)";
      return `Monthly on day ${days} at ${/* c8 ignore next */ rule.time ?? "—"}${suffix}`;
    }
    /* v8 ignore next 2 — closed union exhausted above */
    default:
      return `${(rule as { frequency: string }).frequency} at ${/* c8 ignore next */ rule.time ?? "—"}`;
  }
}
