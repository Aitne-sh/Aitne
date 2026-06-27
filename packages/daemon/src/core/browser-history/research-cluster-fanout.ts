/**
 * Day-boundary fan-out helper — enumerates active research clusters
 * with new meaningful activity in the last 24h and emits one
 * `routine.research_cluster_update` event per cluster onto the
 * EventBus. Called from the scheduler's day-boundary callback (see
 * `index.ts`), which can fire MORE than once per agent-day — the 04:00
 * cron, wake catch-up (every detected sleep gap >= 5 min), and the
 * morning self-heal all invoke it.
 *
 * BROWSER_HISTORY_INTEGRATION_PLAN §10.6 step 3; dedup added by
 * RESEARCH_CLUSTER_COST_FIX_PLAN.md F1 after replayed day boundaries
 * re-enqueued the same cluster ~25x in one morning.
 *
 * Pure orchestration — no LLM in this path. Each cluster is atomically
 * CLAIMED for `todayAgentDay` BEFORE its event is enqueued, so neither a
 * later sequential replay (`listClustersNeedingUpdate` filters claimed
 * rows) nor a concurrently in-flight callback (the per-row claim is a
 * single atomic UPDATE — only one fire wins) can double-fire — exactly
 * one enqueue per cluster per agent day. A cluster whose claimed run
 * fails retries on the next agent day; the journal task flow backfills
 * the missed day. The fan-out is bounded by the `limit` parameter
 * (default 25) so a backlog from a long outage cannot flood the queue.
 */

import type Database from "better-sqlite3";
import {
  claimClusterJournalEnqueue,
  listClustersNeedingUpdate,
} from "../../db/browser-history-store.js";
import { createResearchCommandEvent } from "./research-events.js";

export interface EventBusLike {
  put(event: import("@aitne/shared").Event): Promise<void>;
}

export const RESEARCH_CLUSTER_FANOUT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const RESEARCH_CLUSTER_FANOUT_LIMIT = 25;

export interface FanoutResult {
  enqueuedSlugs: string[];
}

/**
 * Enumerate active clusters with new meaningful activity not yet
 * enqueued for `todayAgentDay` and enqueue one
 * `routine.research_cluster_update` event per cluster. Always returns
 * the slugs it enqueued so the caller can log a structured summary.
 *
 * `todayAgentDay` is the caller-computed local agent-day label
 * (`getAgentDayDateStr(config.timezone, config.dayBoundaryHour)`) —
 * the fan-out is timezone-blind by design so it stays pure and
 * deterministic in tests.
 *
 * When `eventBus` is absent (early-boot path before EventBus wiring),
 * the function returns an empty result without throwing — the next
 * day-boundary tick re-evaluates and picks up the clusters once
 * messaging is live. Nothing is stamped on that path.
 */
export async function fanoutResearchClusterUpdates(
  db: Database.Database,
  eventBus: EventBusLike | null | undefined,
  options: {
    todayAgentDay: string;
    lookbackMs?: number;
    limit?: number;
    nowMs?: number;
  },
): Promise<FanoutResult> {
  if (!eventBus) return { enqueuedSlugs: [] };
  const lookbackMs = options.lookbackMs ?? RESEARCH_CLUSTER_FANOUT_LOOKBACK_MS;
  const limit = options.limit ?? RESEARCH_CLUSTER_FANOUT_LIMIT;
  const nowMs = options.nowMs ?? Date.now();
  const rows = listClustersNeedingUpdate(
    db,
    lookbackMs,
    nowMs,
    limit,
    options.todayAgentDay,
  );
  const enqueuedSlugs: string[] = [];
  for (const row of rows) {
    // Claim BEFORE the put. The claim is atomic, so if a concurrent
    // day-boundary fire (the 04:00 cron is fire-and-forget and can
    // overlap a wake catch-up) already claimed this cluster for today,
    // our claim returns false and we skip it — exactly one enqueue per
    // cluster per agent day. If the put then throws, the claim still
    // persists so the cluster waits for the next agent day instead of
    // re-firing on the next day-boundary replay.
    if (!claimClusterJournalEnqueue(db, row.slug, options.todayAgentDay)) {
      continue;
    }
    await eventBus.put(
      createResearchCommandEvent({
        processKey: "routine.research_cluster_update",
        slug: row.slug,
      }),
    );
    enqueuedSlugs.push(row.slug);
  }
  return { enqueuedSlugs };
}
