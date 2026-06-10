/**
 * Outbound-notification rate-limit evaluation — pure(ish) helper shared by
 * NotificationManager (proactive suppression) and the `/api/notify` gate
 * (QUIET_HOURS_HARDENING_PLAN.md Phase 1). Extracted so the two call sites
 * cannot drift on the counting semantics: distinct dispatches, delivered
 * only, `message.received` replies excluded, hourly window + agent-day
 * window both enforced.
 *
 * 100% covered. NotificationManager itself stays excluded from the
 * coverage gate as I/O-heavy; this helper is the pure leg it shares with
 * the notify-route gate.
 */
import type Database from "better-sqlite3";
import { formatSqliteDatetime, getAgentDayBoundsUtc } from "@aitne/shared";

export interface NotificationRateLimitOptions {
  maxNotificationsPerHour: number;
  maxNotificationsPerDay: number;
  /** IANA tz; empty/undefined falls back to system timezone. */
  timezone?: string | undefined;
  /** Agent day boundary hour (default config: 4). */
  dayBoundaryHour: number;
}

export interface NotificationRateLimitState {
  limited: boolean;
  /**
   * SQLite-format UTC datetime (`YYYY-MM-DD HH:MM:SS`) when a retry could
   * succeed, or `null` when not limited. Hourly limit → the moment the
   * oldest delivery in the trailing hour ages out of the window; daily
   * limit → the agent-day end boundary. Advisory — the caller's retry can
   * still lose to a concurrent delivery.
   */
  retryAfter: string | null;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Count semantics mirror the pre-extraction `NotificationManager`
 * implementation byte-for-byte: a multi-channel dispatch counts once
 * (DISTINCT on dispatch_id, falling back to the row id for legacy rows
 * with an empty dispatch_id), only `delivered` rows count, and
 * `message.received` reply forwards never count against proactive budget.
 */
export function evaluateNotificationRateLimit(
  db: Database.Database,
  opts: NotificationRateLimitOptions,
  now: Date = new Date(),
): NotificationRateLimitState {
  const hourFloor = formatSqliteDatetime(new Date(now.getTime() - HOUR_MS));
  const hourly = db
    .prepare(
      `SELECT COUNT(DISTINCT CASE
           WHEN dispatch_id != '' THEN dispatch_id
           ELSE CAST(id AS TEXT)
         END) as cnt,
         MIN(created_at) as oldest
       FROM notification_log
       WHERE status = 'delivered'
         AND COALESCE(notification_type, '') != 'message.received'
         AND created_at > ?`,
    )
    .get(hourFloor) as { cnt: number; oldest: string | null };

  if (hourly.cnt >= opts.maxNotificationsPerHour) {
    // The window opens when the oldest in-window delivery ages past 1 h.
    // `oldest` is non-null whenever cnt > 0; the cnt===0 ∧ limit<=0 corner
    // (a zero/negative configured cap) degrades to "retry at now + 1 h".
    const oldestMs = hourly.oldest
      ? new Date(`${hourly.oldest.replace(" ", "T")}Z`).getTime()
      : now.getTime();
    return {
      limited: true,
      retryAfter: formatSqliteDatetime(new Date(oldestMs + HOUR_MS)),
    };
  }

  const bounds = getAgentDayBoundsUtc(
    opts.timezone || undefined,
    opts.dayBoundaryHour,
    now,
  );
  const daily = db
    .prepare(
      `SELECT COUNT(DISTINCT CASE
           WHEN dispatch_id != '' THEN dispatch_id
           ELSE CAST(id AS TEXT)
         END) as cnt
       FROM notification_log
       WHERE status = 'delivered'
         AND COALESCE(notification_type, '') != 'message.received'
         AND created_at >= ? AND created_at < ?`,
    )
    .get(bounds.start, bounds.end) as { cnt: number };

  if (daily.cnt >= opts.maxNotificationsPerDay) {
    return { limited: true, retryAfter: bounds.end };
  }

  return { limited: false, retryAfter: null };
}
