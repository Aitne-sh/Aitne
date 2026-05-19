/**
 * Timezone-aware date utilities for the Aitne system.
 *
 * The "agent day" starts at `dayBoundaryHour` (default 04:00) in the
 * configured timezone, NOT at UTC midnight. All SQL queries that reference
 * "today" must use getAgentDayBoundsUtc() to get correct UTC boundaries.
 */

// ── Local date string ──────────────────────────────────────────────

/**
 * Get YYYY-MM-DD string in the specified (or system-local) timezone.
 *
 * Unlike `date.toISOString().slice(0, 10)` which returns the UTC date,
 * this respects the given timezone (or falls back to system local).
 */
export function localDateStr(date: Date, timezone?: string): string {
  if (timezone) {
    const t = nowInTimezone(timezone, date);
    return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ── Timezone-aware "now" ───────────────────────────────────────────

/**
 * Get time components in the specified timezone.
 * Falls back to system timezone if timezone is empty/undefined.
 */
export function nowInTimezone(timezone: string | undefined, now?: Date): {
  hours: number;
  minutes: number;
  year: number;
  month: number;
  day: number;
  dayOfWeek: number;
} {
  const d = now ?? new Date();
  if (!timezone) {
    return {
      hours: d.getHours(),
      minutes: d.getMinutes(),
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      dayOfWeek: d.getDay(),
    };
  }

  const offsetMs = getTimezoneOffsetMs(timezone, d);
  const local = new Date(d.getTime() + offsetMs);

  return {
    hours: local.getUTCHours(),
    minutes: local.getUTCMinutes(),
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    dayOfWeek: local.getUTCDay(),
  };
}

// ── Agent day boundaries ───────────────────────────────────────────

/**
 * Compute the UTC boundaries of the current "agent day".
 *
 * An agent day starts at `dayBoundaryHour` in the configured timezone.
 * For example, with timezone "America/New_York" and dayBoundaryHour 4:
 *   - Agent day starts at 04:00 ET = 09:00 UTC (current day, EST)
 *   - Agent day ends   at 04:00 ET = 09:00 UTC (next day, EST)
 *
 * @returns start (inclusive) and end (exclusive) as 'YYYY-MM-DD HH:MM:SS'
 *          UTC strings suitable for SQLite WHERE clauses.
 */
export function getAgentDayBoundsUtc(
  timezone: string | undefined,
  dayBoundaryHour: number,
  now?: Date,
): { start: string; end: string } {
  const d = now ?? new Date();
  const offsetMs = timezone
    ? getTimezoneOffsetMs(timezone, d)
    : -d.getTimezoneOffset() * 60 * 1000;

  // Shift UTC time into "local" space (UTC-shifted Date where UTC methods
  // give local time components)
  const localMs = d.getTime() + offsetMs;
  const localDate = new Date(localMs);

  const localHour = localDate.getUTCHours();

  // Start of the agent day in local-shifted space
  const dayStartLocal = new Date(localDate);
  dayStartLocal.setUTCHours(dayBoundaryHour, 0, 0, 0);

  if (localHour < dayBoundaryHour) {
    // Before the boundary: still in previous agent day
    dayStartLocal.setUTCDate(dayStartLocal.getUTCDate() - 1);
  }

  // Convert back to real UTC. We recompute the timezone offset *at the
  // boundary instant* — using the offset captured at `d` would skew the
  // result by an hour around DST transitions when `d` and the boundary
  // straddle the change-over (e.g. inputs around 02:00–04:00 local on a
  // spring-forward day in ET/CET). For non-DST zones (Asia/Tokyo, UTC)
  // this is a no-op.
  const provisionalUtcMs = dayStartLocal.getTime() - offsetMs;
  const boundaryOffsetMs = timezone
    ? getTimezoneOffsetMs(timezone, new Date(provisionalUtcMs))
    : offsetMs;
  const dayStartUtcMs = dayStartLocal.getTime() - boundaryOffsetMs;
  const dayEndUtcMs = dayStartUtcMs + 24 * 60 * 60 * 1000;

  return {
    start: formatSqliteDatetime(new Date(dayStartUtcMs)),
    end: formatSqliteDatetime(new Date(dayEndUtcMs)),
  };
}

/**
 * Return the local YYYY-MM-DD label of the current agent day.
 *
 * With a 04:00 boundary, times between 00:00 and 03:59 belong to the
 * previous agent day and therefore return the previous local date.
 */
export function getAgentDayDateStr(
  timezone: string | undefined,
  dayBoundaryHour: number,
  now?: Date,
): string {
  const { start } = getAgentDayBoundsUtc(timezone, dayBoundaryHour, now);
  return localDateStr(new Date(start.replace(" ", "T") + "Z"), timezone);
}

/**
 * Build the SQLite `date()` / `strftime()` modifier that aligns UTC
 * timestamps with the agent-day boundary, so `date(started_at, ?)` buckets
 * rows by agent day instead of UTC day.
 *
 * Example — Asia/Tokyo (+09:00), dayBoundary 04:00:
 *   - Agent day starts at 04:00 JST = 19:00 UTC of the previous calendar day.
 *   - Shift = tzOffset − dayBoundary = (+540 min) − (240 min) = +300 minutes.
 *   - A row at 19:00 UTC May 16 (= 04:00 JST May 17) shifted +5h lands at
 *     00:00 UTC May 17 → `date()` returns "2026-05-17" ✓
 *   - A row at 18:00 UTC May 16 (= 03:00 JST May 17, still agent-day May 16)
 *     shifted +5h lands at 23:00 UTC May 16 → `date()` returns "2026-05-16" ✓
 *
 * DST: uses the offset at "now", so cross-DST buckets can be off by an hour
 * at the boundary instant on transition days. The two SQL chart queries that
 * use this don't need DST-precise per-row accuracy (visualization only).
 * Asia/Tokyo and other non-DST zones are exact.
 */
export function getAgentDaySqlShiftModifier(
  timezone: string | undefined,
  dayBoundaryHour: number,
  now?: Date,
): string {
  const d = now ?? new Date();
  const offsetMs = timezone
    ? getTimezoneOffsetMs(timezone, d)
    : -d.getTimezoneOffset() * 60 * 1000;
  const shiftMinutes = Math.round(offsetMs / 60_000) - dayBoundaryHour * 60;
  const sign = shiftMinutes >= 0 ? "+" : "-";
  return `${sign}${Math.abs(shiftMinutes)} minutes`;
}

/**
 * Return minutes elapsed since the start of the current agent day.
 *
 * Example: with a 04:00 boundary, 05:30 returns 90 and 02:15 returns 1335.
 */
export function getAgentDayProgressMinutes(
  timezone: string | undefined,
  dayBoundaryHour: number,
  now?: Date,
): number {
  const local = nowInTimezone(timezone, now);
  const currentMinutes = local.hours * 60 + local.minutes;
  const boundaryMinutes = dayBoundaryHour * 60;

  return currentMinutes >= boundaryMinutes
    ? currentMinutes - boundaryMinutes
    : (24 * 60 - boundaryMinutes) + currentMinutes;
}

/**
 * Project a candidate Date forward to the next start of an active-hours
 * window in the configured timezone. The window is `[startHour, endHour)`
 * in local time; `endHour=24` is treated as exclusive (no shift for
 * candidate hour 23).
 *
 * - Candidate's local hour already inside the window → returns candidate
 *   unchanged.
 * - Local hour `< startHour` → returns today's `startHour:00:00.000` local.
 * - Local hour `>= endHour`  → returns tomorrow's `startHour:00:00.000`
 *   local.
 *
 * Mirrors the timezone-shift / DST-recompute pattern used in
 * `getAgentDayBoundsUtc` so cross-DST transitions land on the correct
 * wall-clock hour rather than an hour offset.
 */
export function nextActiveHoursStart(
  candidate: Date,
  timezone: string | undefined,
  startHour: number,
  endHour: number,
): Date {
  const local = nowInTimezone(timezone, candidate);
  if (local.hours >= startHour && local.hours < endHour) {
    return candidate;
  }

  const offsetMs = timezone
    ? getTimezoneOffsetMs(timezone, candidate)
    : -candidate.getTimezoneOffset() * 60 * 1000;

  // Local-shifted Date — UTC accessors return the local-time components.
  const localShifted = new Date(candidate.getTime() + offsetMs);
  const target = new Date(localShifted);
  target.setUTCHours(startHour, 0, 0, 0);

  if (local.hours >= endHour) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  // local.hours < startHour → today's startHour (no day shift needed).

  // Convert back to UTC, recomputing TZ offset at the target instant so a
  // candidate that straddles a DST change lands at the intended local hour.
  const provisionalUtcMs = target.getTime() - offsetMs;
  const targetOffsetMs = timezone
    ? getTimezoneOffsetMs(timezone, new Date(provisionalUtcMs))
    : offsetMs;
  return new Date(target.getTime() - targetOffsetMs);
}

// ── Helpers ────────────────────────────────────────────────────────

/** Format a Date as 'YYYY-MM-DD HH:MM:SS' UTC string for SQLite. */
export function formatSqliteDatetime(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Parse a SQLite UTC datetime string ('YYYY-MM-DD HH:MM:SS') into epoch ms.
 * More robust than ad-hoc `new Date(s + "Z")` — explicitly normalizes the
 * format before parsing.
 */
export function parseSqliteUtcMs(s: string): number {
  // SQLite datetime('now') produces 'YYYY-MM-DD HH:MM:SS' (space-separated, no Z)
  // Replace space with T and append Z to create a valid ISO 8601 UTC string
  return new Date(s.replace(" ", "T") + "Z").getTime();
}

/**
 * Get the timezone offset in milliseconds (positive = east of UTC).
 * Uses toLocaleString comparison which handles DST correctly for
 * the given instant.
 */
function getTimezoneOffsetMs(timezone: string, date: Date): number {
  const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
  const localStr = date.toLocaleString("en-US", { timeZone: timezone });
  return new Date(localStr).getTime() - new Date(utcStr).getTime();
}
