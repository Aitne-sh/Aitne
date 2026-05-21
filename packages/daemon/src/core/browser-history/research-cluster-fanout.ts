/**
 * Day-boundary fan-out helper — enumerates active research clusters
 * with new meaningful activity in the last 24h and emits one
 * `routine.research_cluster_update` event per cluster onto the
 * EventBus. Called once per agent-day from the scheduler's day-boundary
 * callback (see `bootstrap/index.ts`).
 *
 * BROWSER_HISTORY_INTEGRATION_PLAN §10.6 step 3.
 *
 * Pure orchestration — no LLM in this path. The fan-out is bounded by
 * the `limit` parameter (default 25) so a backlog from a long outage
 * cannot flood the event queue. Clusters that miss this cycle pick up
 * on the next day-boundary fire; the next cycle's DB query naturally
 * sees them as "still active with new activity since prior update".
 */

import type Database from "better-sqlite3";
import { listClustersNeedingUpdate } from "../../db/browser-history-store.js";
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
 * Enumerate active clusters with new meaningful activity since the last
 * day-boundary cycle and enqueue one `routine.research_cluster_update`
 * event per cluster. Always returns the slugs it enqueued so the caller
 * can log a structured summary.
 *
 * When `eventBus` is absent (early-boot path before EventBus wiring),
 * the function returns an empty result without throwing — the next
 * day-boundary tick re-evaluates and picks up the clusters once
 * messaging is live.
 */
export async function fanoutResearchClusterUpdates(
  db: Database.Database,
  eventBus: EventBusLike | null | undefined,
  options: {
    lookbackMs?: number;
    limit?: number;
    nowMs?: number;
  } = {},
): Promise<FanoutResult> {
  if (!eventBus) return { enqueuedSlugs: [] };
  const lookbackMs = options.lookbackMs ?? RESEARCH_CLUSTER_FANOUT_LOOKBACK_MS;
  const limit = options.limit ?? RESEARCH_CLUSTER_FANOUT_LIMIT;
  const nowMs = options.nowMs ?? Date.now();
  const rows = listClustersNeedingUpdate(db, lookbackMs, nowMs, limit);
  const enqueuedSlugs: string[] = [];
  for (const row of rows) {
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
