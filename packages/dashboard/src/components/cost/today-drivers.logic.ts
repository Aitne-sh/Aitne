import type { TodayBreakdown } from "@/lib/api-types";

/**
 * Pure derivations for the "Today's Spend Drivers" section. Kept out of the
 * .tsx so they are testable in the node environment per the dashboard
 * testing convention (no jsdom).
 */

export interface ProcessShare {
  eventType: string;
  totalCost: number;
  sessionCount: number;
  avgCost: number;
  /** 0–100, clamped. Share of today's total spend. */
  pct: number;
}

/**
 * Rank today's processes by spend with their share of the day's total.
 * `todayCostUsd` (the Today card value) is the denominator so the bars
 * visually reconcile with the headline number; when it is 0 (or the rows
 * disagree with a stale total), shares clamp into [0, 100] instead of
 * rendering overflowing bars.
 */
export function computeProcessShares(
  byEventType: TodayBreakdown["byEventType"],
  todayCostUsd: number,
): ProcessShare[] {
  return byEventType.map((row) => ({
    eventType: row.event_type,
    totalCost: row.total_cost,
    sessionCount: row.session_count,
    avgCost: row.session_count > 0 ? row.total_cost / row.session_count : 0,
    pct:
      todayCostUsd > 0
        ? Math.min(100, Math.max(0, (row.total_cost / todayCostUsd) * 100))
        : 0,
  }));
}

/**
 * Cache hit rate = cache-read share of all input-side tokens delivered to
 * the model (fresh + cache write + cache read). This is the single biggest
 * cost lever for Claude prompt caching: cache reads bill at ~10% of fresh
 * input, so a falling hit rate shows up as a rising Today card. Null when
 * no input-side tokens were recorded (nothing ran, or a backend that does
 * not report cache columns).
 */
export function computeCacheHitRate(
  tokens: TodayBreakdown["tokens"],
): number | null {
  const denominator = tokens.input + tokens.cacheCreation + tokens.cacheRead;
  if (denominator <= 0) return null;
  return tokens.cacheRead / denominator;
}

/**
 * Share of today's spend that came from autonomous (background) runs, as a
 * 0–1 fraction. Null when nothing has spent money yet. Rows with an unknown
 * trigger count toward the denominator only — they are neither provably
 * autonomous nor reactive.
 */
export function computeAutonomousShare(
  byTrigger: TodayBreakdown["byTrigger"],
): number | null {
  let total = 0;
  let autonomous = 0;
  for (const row of byTrigger) {
    total += row.total_cost;
    if (row.trigger === "autonomous") autonomous += row.total_cost;
  }
  if (total <= 0) return null;
  return Math.min(1, Math.max(0, autonomous / total));
}

/** Mean cost per costed run today; null when no runs have cost yet. */
export function computeAvgCostPerRun(
  todayCostUsd: number,
  sessions: number,
): number | null {
  if (sessions <= 0) return null;
  return todayCostUsd / sessions;
}

/** "73%"-style label for a 0–1 fraction; em dash when unavailable. */
export function formatShare(fraction: number | null): string {
  if (fraction == null) return "—";
  return `${Math.round(fraction * 100)}%`;
}
