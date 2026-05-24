import { nowInTimezone, parseSqliteUtcMs } from "@aitne/shared";

/**
 * Truncate `value` to at most `max` chars, collapsing newlines so the
 * result fits on one line. Suffix `…` when truncation occurs. Used by
 * the scheduled.dm DM-activity / DM-history blocks.
 */
export function truncateForBlock(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

export function formatSqliteTimestampForContext(
  timestamp: string,
  timezone: string,
): string {
  const local = nowInTimezone(
    timezone === "system" ? undefined : timezone,
    new Date(parseSqliteUtcMs(timestamp)),
  );
  return `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")} ${String(local.hours).padStart(2, "0")}:${String(local.minutes).padStart(2, "0")}`;
}

export function truncateContextText(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 3)}...`;
}
