/**
 * Global rate-limit gate for the seventh-pass two-option engagement
 * offer flow (BROWSER_HISTORY_INTEGRATION_PLAN §5.F1 "Rate-limit
 * policy"). Sits between `evaluateOfferTriggers` (per-cluster gates)
 * and the poller's actual enqueue of a `routine.research_offer_dm`
 * event.
 *
 * The policy:
 *
 * | Constraint               | Value                                     |
 * |--------------------------|-------------------------------------------|
 * | Global daily cap         | 2 offer DMs per agent-day (04:00→04:00)   |
 * | Minimum interval         | 4 hours between any two offer DMs         |
 * | Different topic          | Each offer must be for a different slug   |
 * | Quiet hours              | Respect quietHoursStart / quietHoursEnd   |
 * | Active conversation hold | Skip if the owner DM channel saw activity |
 * |                          | within the last 30 minutes                |
 * | Decline backoff          | Cluster cooldown extends to 30 days after |
 * |                          | a decline reply                           |
 *
 * Pure-ish — reads SQLite, but does not write. Returns a discriminated
 * union the poller logs and routes on:
 *   `{decision: "fire"}` → enqueue routine.research_offer_dm
 *   `{decision: "skip", reason: "..."}` → log and move on
 *
 * Quiet hours + decline backoff intentionally read from config /
 * cluster rows rather than runtime_state — keep state in one place
 * (clusters + config), reuse what already exists.
 */

import type Database from "better-sqlite3";

export interface OfferRateLimitConfig {
  /** Maximum offer DMs per 24h window (default 2). */
  globalDailyCap: number;
  /** Minimum gap between any two offer DMs (default 4h). */
  minIntervalMs: number;
  /** Decline backoff window — bump per-cluster cooldown after decline. */
  declineBackoffMs: number;
  /** Window during which owner DM activity counts as "in progress". */
  activeConversationWindowMs: number;
  /** Quiet hours window — "HH:MM" 24h strings, or null when unconfigured. */
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  /** IANA timezone for quiet-hours evaluation. */
  timezone: string;
}

export const DEFAULT_OFFER_RATE_LIMIT_CONFIG: OfferRateLimitConfig = {
  globalDailyCap: 2,
  minIntervalMs: 4 * 60 * 60 * 1000,
  declineBackoffMs: 30 * 24 * 60 * 60 * 1000,
  activeConversationWindowMs: 30 * 60 * 1000,
  quietHoursStart: null,
  quietHoursEnd: null,
  timezone: "UTC",
};

export type OfferRateLimitSkipReason =
  | "daily_cap"
  | "interval"
  | "same_topic"
  | "quiet_hours"
  | "active_conversation"
  | "decline_backoff";

export type OfferRateLimitDecision =
  | { decision: "fire" }
  | { decision: "skip"; reason: OfferRateLimitSkipReason };

/**
 * Evaluate the gate. The poller calls this for each candidate slug
 * before enqueueing. On `skip`, the poller logs an `agent_actions` row
 * with `action_type='offer_dm_rate_limited'` so the operator can see
 * *why* an offer was suppressed.
 *
 * The "decline backoff" gate looks for the cluster's own
 * `lastResearchOfferAt`/`lastWikiOfferAt` being set within
 * `declineBackoffMs` AND `researchOfferAcceptedAt`/`wikiSummaryWrittenAt`
 * still null — i.e., we offered, the user did not accept (likely
 * declined or ignored), so cool down longer.
 */
export function gateOfferRateLimit(
  db: Database.Database,
  candidateSlug: string,
  nowMs: number,
  config: OfferRateLimitConfig = DEFAULT_OFFER_RATE_LIMIT_CONFIG,
): OfferRateLimitDecision {
  // Quiet hours — cheapest check, do it first.
  if (
    config.quietHoursStart
    && config.quietHoursEnd
    && isInQuietHours(nowMs, config.quietHoursStart, config.quietHoursEnd, config.timezone)
  ) {
    return { decision: "skip", reason: "quiet_hours" };
  }

  // Decline backoff per-cluster — query the candidate's own row.
  const cluster = db
    .prepare(
      `SELECT
         last_research_offer_at AS lastResearchOfferAt,
         last_wiki_offer_at AS lastWikiOfferAt,
         research_offer_accepted_at AS researchOfferAcceptedAt,
         wiki_summary_written_at AS wikiSummaryWrittenAt
       FROM browser_research_clusters
       WHERE slug = ?`,
    )
    .get(candidateSlug) as
    | {
        lastResearchOfferAt: number | null;
        lastWikiOfferAt: number | null;
        researchOfferAcceptedAt: number | null;
        wikiSummaryWrittenAt: number | null;
      }
    | undefined;

  if (cluster) {
    const isResearchDeclineActive =
      cluster.lastResearchOfferAt !== null
      && cluster.researchOfferAcceptedAt === null
      && nowMs - cluster.lastResearchOfferAt < config.declineBackoffMs;
    const isWikiDeclineActive =
      cluster.lastWikiOfferAt !== null
      && cluster.wikiSummaryWrittenAt === null
      && nowMs - cluster.lastWikiOfferAt < config.declineBackoffMs;
    if (isResearchDeclineActive && isWikiDeclineActive) {
      return { decision: "skip", reason: "decline_backoff" };
    }
  }

  // Global daily cap + interval + different topic — single SQL query
  // against `last_dm_at` over the last 24h, ordered by recency. The
  // index on `last_dm_at` keeps this O(log N + K) where K is the
  // (small) number of recent fires.
  const dayAgo = nowMs - 24 * 60 * 60 * 1000;
  const recentFires = db
    .prepare(
      `SELECT slug, last_dm_at AS lastDmAt
       FROM browser_research_clusters
       WHERE last_dm_at IS NOT NULL AND last_dm_at > ?
       ORDER BY last_dm_at DESC`,
    )
    .all(dayAgo) as Array<{ slug: string; lastDmAt: number }>;

  if (recentFires.length >= config.globalDailyCap) {
    return { decision: "skip", reason: "daily_cap" };
  }

  if (recentFires.length > 0) {
    const mostRecent = recentFires[0];
    if (nowMs - mostRecent.lastDmAt < config.minIntervalMs) {
      return { decision: "skip", reason: "interval" };
    }
    if (mostRecent.slug === candidateSlug) {
      return { decision: "skip", reason: "same_topic" };
    }
    // Same-topic check also covers ANY of the recent fires having the
    // same slug — not just the most recent — because the daily cap of
    // 2 means we could have fired this same slug earlier in the day
    // for a different signal. Don't double-DM the same cluster.
    if (recentFires.some((row) => row.slug === candidateSlug)) {
      return { decision: "skip", reason: "same_topic" };
    }
  }

  // Active-conversation hold — look at the most recent message in the
  // owner DM scope. The scope is determined by getConversationScope
  // (`('owner_dm', 'owner')` for non-dashboard DMs), but the messages
  // table query is simpler: any message in any of the owner DM
  // sessions within the window counts as "active".
  const activeWindowStart = nowMs - config.activeConversationWindowMs;
  // SQLite stores message timestamps as ISO strings ('2026-05-20
  // 14:30:00') via the default CURRENT_TIMESTAMP, so the comparison
  // is lexicographic-safe — convert the threshold the same way.
  const activeWindowIso = new Date(activeWindowStart)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  const recentDmActivity = db
    .prepare(
      `SELECT 1
       FROM messages m
       JOIN conversation_sessions s ON m.session_id = s.id
       WHERE s.scope = 'owner_dm' AND s.scope_key = 'owner'
         AND m.timestamp > ?
       LIMIT 1`,
    )
    .get(activeWindowIso);
  if (recentDmActivity) {
    return { decision: "skip", reason: "active_conversation" };
  }

  return { decision: "fire" };
}

/**
 * Quiet hours arithmetic with timezone awareness. Supports both
 * same-day windows ("09:00"–"22:00" = work-day-loud) and windows that
 * cross midnight ("22:00"–"07:00" = sleep). Uses the JS Date API with
 * Intl.DateTimeFormat to localise to the agent's timezone.
 *
 * Pure — no I/O. The caller passes a clock + config.
 */
export function isInQuietHours(
  nowMs: number,
  start: string,
  end: string,
  timezone: string,
): boolean {
  const startMinutes = parseHHMM(start);
  const endMinutes = parseHHMM(end);
  if (startMinutes === null || endMinutes === null) return false;
  if (startMinutes === endMinutes) return false; // empty window

  const tzNow = new Date(nowMs);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(tzNow);
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === "hour") hour = Number(part.value) % 24;
    if (part.type === "minute") minute = Number(part.value);
  }
  const nowMinutes = hour * 60 + minute;

  if (startMinutes < endMinutes) {
    // Same-day window: [start, end).
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  // Crosses midnight: in window if AFTER start OR BEFORE end.
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

function parseHHMM(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}
