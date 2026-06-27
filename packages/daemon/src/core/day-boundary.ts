/**
 * Day-boundary task runner with a per-agent-day idempotence marker —
 * RESEARCH_CLUSTER_COST_FIX_PLAN.md F2 (defense in depth on top of the
 * F1 per-cluster enqueue stamp).
 *
 * The scheduler invokes its day-boundary callback from THREE sites: the
 * 04:00 cron, wake catch-up (which fires on every detected sleep gap
 * >= 5 min — every macOS maintenance DarkWake), and the morning
 * self-heal missed-fire path. Before this marker existed, each replay
 * re-ran the full callback body; on 2026-06-11 that re-enqueued the
 * same research cluster ~25x in one morning. Wrapping the body HERE —
 * the single composition point — protects every future day-boundary
 * addition, not just the research fan-out.
 *
 * Marker semantics: `runtime_state.day_boundary_last_agent_day` is
 * written AFTER the body completes, not before. A sleep-interrupted or
 * failed body therefore retries on the next scheduler fire (all three
 * scheduler sites catch + log callback rejections), while replay safety
 * of the individual steps comes from the steps themselves — the F1
 * stamp for the fan-out, summarizeDmSessions' own incremental gating.
 */

import type Database from "better-sqlite3";
import { readRuntimeState, writeRuntimeState } from "../db/runtime-state.js";

export const DAY_BOUNDARY_LAST_AGENT_DAY_KEY = "day_boundary_last_agent_day";

export interface DayBoundaryTasksDeps {
  db: Database.Database;
  /** Local agent-day label ('YYYY-MM-DD') the caller computes via
   *  `getAgentDayDateStr(config.timezone, config.dayBoundaryHour)`. */
  todayAgentDay: string;
  summarizeDmSessions: () => Promise<void>;
  fanoutResearchClusterUpdates: () => Promise<{ enqueuedSlugs: string[] }>;
}

export type DayBoundaryTasksResult =
  | { ran: false }
  | { ran: true; enqueuedSlugs: string[] };

/**
 * Run the day-boundary body at most once per agent-day. Returns
 * `{ ran: false }` when the marker shows the body already completed for
 * `todayAgentDay`. Errors propagate to the caller WITHOUT writing the
 * marker, so the next scheduler fire retries the whole body.
 */
export async function runDayBoundaryTasks(
  deps: DayBoundaryTasksDeps,
): Promise<DayBoundaryTasksResult> {
  const { db, todayAgentDay } = deps;
  const lastRunAgentDay = readRuntimeState<string>(
    db,
    DAY_BOUNDARY_LAST_AGENT_DAY_KEY,
  );
  if (lastRunAgentDay === todayAgentDay) {
    return { ran: false };
  }
  await deps.summarizeDmSessions();
  const fanout = await deps.fanoutResearchClusterUpdates();
  writeRuntimeState(db, DAY_BOUNDARY_LAST_AGENT_DAY_KEY, todayAgentDay);
  return { ran: true, enqueuedSlugs: fanout.enqueuedSlugs };
}
