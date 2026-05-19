import type Database from "better-sqlite3";
import { formatSqliteDatetime } from "@aitne/shared";

/**
 * STAGE-C-DM-FRESHNESS-PLAN §Task 4 — "is the user asking about recent
 * activity?" detector. Mirrors the English trigger phrases exposed in
 * `agent-assets/task-flows/message.received.dm.md`'s "Recent activity
 * — refetch on demand" subsection; equivalents in other languages are
 * handled by the LLM rather than by this heuristic.
 *
 * Match is intentionally permissive: it powers the refetch-hit rate
 * metric (Task 4 §Acceptance threshold), not gating logic. False
 * negatives on non-English DMs slightly under-count refetch hits in
 * non-English cohorts but never cause harm.
 */
export const RECENT_ACTIVITY_TRIGGER_RE =
  /(what have you been up to|did anything come in|anything new since|anything happen|in the (?:last|past) \d+\s*min)/i;

export function matchesRecentActivityTrigger(content: string): boolean {
  return RECENT_ACTIVITY_TRIGGER_RE.test(content);
}

export interface DmFreshnessWindowedCounts {
  loud: number;
  quiet: number;
}

/**
 * Count `context_write` rows by classified tier in the half-open window
 * [sessionStartedAtSqlite, turnStartSqlite). Used by the DM dispatch row
 * to record how many loud / quiet writes the agent missed since session
 * start — a direct measure of how "stale" the resumed `<today>` snapshot
 * was when this turn fired.
 */
export function countContextWritesInWindow(
  db: Database.Database,
  sessionStartedAtSqlite: string,
  turnStartSqlite: string,
): DmFreshnessWindowedCounts {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN json_extract(detail, '$.tier') = 'loud' THEN 1 ELSE 0 END) AS loud,
         SUM(CASE WHEN json_extract(detail, '$.tier') = 'quiet' THEN 1 ELSE 0 END) AS quiet
       FROM agent_actions
       WHERE action_type = 'context_write'
         AND started_at >= ?
         AND started_at < ?`,
    )
    .get(sessionStartedAtSqlite, turnStartSqlite) as
    | { loud: number | null; quiet: number | null }
    | undefined;
  return {
    loud: Number(row?.loud ?? 0),
    quiet: Number(row?.quiet ?? 0),
  };
}

/**
 * Did a `GET /api/context/today` row land during the half-open window
 * [turnStartSqlite, turnEndSqlite]? The context route logs an
 * action_type='context_read' row when path === 'today' (Task 4 §
 * Refetch-hit rate); this query asks the question.
 *
 * The window is closed at turnEndSqlite (typically the SQLite "now" at
 * the moment of telemetry collection). A bounded upper edge keeps the
 * detection scoped to the agent turn even if a future change parallelizes
 * dispatch — without it, a context_read landing AFTER this turn (e.g.
 * from a concurrent routine, a dashboard reload, or a delayed write
 * arriving on a slow disk) would be wrongly attributed to this turn's
 * refetch.
 */
export function didRefetchTodayDuringTurn(
  db: Database.Database,
  turnStartSqlite: string,
  turnEndSqlite: string = nowSqlite(),
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS found
       FROM agent_actions
       WHERE action_type = 'context_read'
         AND json_extract(detail, '$.path') = 'today'
         AND started_at >= ?
         AND started_at <= ?
       LIMIT 1`,
    )
    .get(turnStartSqlite, turnEndSqlite) as { found: number } | undefined;
  return row !== undefined;
}

export function nowSqlite(): string {
  return formatSqliteDatetime(new Date());
}

export interface DmFreshnessAggregate {
  windowDays: number;
  totalDmTurns: number;
  resumedTurns: number;
  resumeRate: number;
  /**
   * Lag percentiles among RESUMED DM turns only. Fresh-execute turns set
   * `agent_log_lag_minutes=0` by construction (the snapshot is built at
   * dispatch time), so including them would drag the percentile toward 0
   * and hide the cohort the plan §6 acceptance threshold targets
   * ("p95 ≤ 60 — i.e. resumed turns are typically within an hourly_check
   * cadence of session start"). When `resumedTurns === 0`, both
   * percentiles are 0 — there is no lag to report.
   */
  p50LagMinutes: number;
  p95LagMinutes: number;
  triggerMatchedTurns: number;
  refetchHits: number;
  refetchHitRate: number;
}

/**
 * Compute the 7-day (default) DM freshness aggregate served by
 * `GET /api/dashboard/dm-freshness`. Lives next to the writer so the
 * shape stays in sync with the row format (`detail.dm_freshness.*`).
 *
 * Percentiles: SQLite has no native percentile_cont — we pull the lag
 * column and compute p50/p95 in JS. DM volume is bounded (hundreds of
 * rows over 7 days at the maintainer's traffic) so this is fine.
 */
export function computeDmFreshnessAggregate(
  db: Database.Database,
  windowDays = 7,
): DmFreshnessAggregate {
  const rows = db
    .prepare(
      `SELECT
         json_extract(detail, '$.dm_freshness.resumed') AS resumed,
         CAST(json_extract(detail, '$.dm_freshness.agent_log_lag_minutes') AS REAL) AS lag,
         json_extract(detail, '$.dm_freshness.trigger_matched') AS trigger_matched,
         json_extract(detail, '$.dm_freshness.refetched_today') AS refetched_today
       FROM agent_actions
       WHERE json_extract(detail, '$.dm_freshness') IS NOT NULL
         AND started_at >= datetime('now', ?)`,
    )
    .all(`-${windowDays} days`) as Array<{
      resumed: number | null;
      lag: number | null;
      trigger_matched: number | null;
      refetched_today: number | null;
    }>;

  const totalDmTurns = rows.length;
  if (totalDmTurns === 0) {
    return {
      windowDays,
      totalDmTurns: 0,
      resumedTurns: 0,
      resumeRate: 0,
      p50LagMinutes: 0,
      p95LagMinutes: 0,
      triggerMatchedTurns: 0,
      refetchHits: 0,
      refetchHitRate: 0,
    };
  }

  let resumedTurns = 0;
  let triggerMatchedTurns = 0;
  let refetchHits = 0;
  const resumedLags: number[] = [];
  for (const row of rows) {
    if (row.resumed) {
      resumedTurns += 1;
      resumedLags.push(Number.isFinite(row.lag) ? Number(row.lag) : 0);
    }
    if (row.trigger_matched) {
      triggerMatchedTurns += 1;
      if (row.refetched_today) refetchHits += 1;
    }
  }
  resumedLags.sort((a, b) => a - b);

  return {
    windowDays,
    totalDmTurns,
    resumedTurns,
    resumeRate: resumedTurns / totalDmTurns,
    p50LagMinutes: percentile(resumedLags, 0.5),
    p95LagMinutes: percentile(resumedLags, 0.95),
    triggerMatchedTurns,
    refetchHits,
    refetchHitRate:
      triggerMatchedTurns === 0 ? 0 : refetchHits / triggerMatchedTurns,
  };
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  // Nearest-rank percentile — sufficient for monitoring resolution and
  // independent of interpolation library behavior.
  const rank = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil(p * sortedAsc.length) - 1),
  );
  return sortedAsc[rank];
}
