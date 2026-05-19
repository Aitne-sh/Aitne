/**
 * Pure timezone-aware date helpers used by the dispatcher's quota-reset
 * logic (`resolveQuotaResetAtMs`) — no instance state, no I/O.
 *
 * Extracted from `core/dispatcher.ts` as part of phase D-2 of
 * `docs/design/appendices/file-split-plan.md` (pattern A — pure
 * functions). The dispatcher imports these directly at the call sites
 * that previously read `this.…`; no re-export from `dispatcher.ts`
 * because none of these were ever public surface.
 */

export interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * Convert local-time `parts` in `timeZone` to a UTC epoch ms. Returns
 * `null` when the wall-clock instant does not exist in the zone (e.g.
 * the "spring forward" gap) or when `timeZone` is not a valid IANA id.
 *
 * The implementation iterates up to 3 times because the first offset
 * lookup uses the UTC instant — the resolved offset can shift the wall
 * time across a DST boundary, requiring another lookup at the new guess.
 */
export function localDateTimeToUtcMs(
  parts: LocalDateParts,
  timeZone?: string,
): number | null {
  if (!timeZone) {
    return new Date(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      0,
      0,
    ).getTime();
  }

  const baseUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    0,
    0,
  );
  let guess = baseUtc;

  for (let attempt = 0; attempt < 3; attempt++) {
    const offsetMinutes = getTimeZoneOffsetMinutes(new Date(guess), timeZone);
    if (offsetMinutes === null) {
      return null;
    }
    const nextGuess = baseUtc - offsetMinutes * 60 * 1000;
    if (nextGuess === guess) {
      break;
    }
    guess = nextGuess;
  }

  const resolved = getLocalDateParts(new Date(guess), timeZone);
  if (compareLocalDateParts(resolved, parts) !== 0) {
    return null;
  }
  return guess;
}

/**
 * Return the offset (in minutes) that the given `timeZone` applied at
 * the supplied instant. Positive east of UTC, negative west; `null`
 * when `timeZone` is invalid or the platform's `Intl` data lacks the
 * shortOffset name.
 */
export function getTimeZoneOffsetMinutes(
  date: Date,
  timeZone: string,
): number | null {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "shortOffset",
    });
  } catch {
    return null;
  }
  const zonePart = formatter.formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
  if (!zonePart) {
    return null;
  }
  if (zonePart === "GMT") {
    return 0;
  }
  const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(zonePart);
  if (!match) {
    return null;
  }
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? "0");
  return sign * (hours * 60 + minutes);
}

/**
 * Decompose `date` into year/month/day/hour/minute as observed in the
 * given `timeZone`. Falls back to the runtime's local zone when the
 * supplied id is invalid (matching the original behaviour from
 * dispatcher.ts).
 */
export function getLocalDateParts(date: Date, timeZone?: string): LocalDateParts {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    formatter = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  }
  const parts = formatter.formatToParts(date);
  const valueOf = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  return {
    year: valueOf("year"),
    month: valueOf("month"),
    day: valueOf("day"),
    hour: valueOf("hour"),
    minute: valueOf("minute"),
  };
}

/**
 * Lexicographic comparator on `LocalDateParts` — returns negative when
 * `a < b`, positive when `a > b`, 0 when equal. Used by the quota-reset
 * resolver to decide whether the next reset wall-clock has already
 * passed today.
 */
export function compareLocalDateParts(
  a: LocalDateParts,
  b: LocalDateParts,
): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  if (a.day !== b.day) return a.day - b.day;
  if (a.hour !== b.hour) return a.hour - b.hour;
  return a.minute - b.minute;
}
