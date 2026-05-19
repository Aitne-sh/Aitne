import { parseSqliteUtcMs } from "@aitne/shared";
import { createLogger } from "../logging.js";

const logger = createLogger("schedule-insert-helper");

/**
 * `task_context.importance` convention for `agent_schedule` rows.
 *
 * Set `"transient"` for one-off pings that should only surface in
 * today.md on the day they fire.
 *
 * Omit the field (or set `"normal"`) when the row represents a user-facing
 * reminder that should surface in `roadmap.md` only once it is beyond the
 * short-reminder horizon.
 *
 * Set `"strategic"` for long-prep commitments that should surface in
 * `roadmap.md` regardless of horizon.
 *
 * Set `"low"` when the row is an internal tick that already has a visible
 * counterpart elsewhere (today.md Agent Plan row, recurring_schedules entry,
 * morning-routine retry loop) so the roadmap refresh skips it.
 */
export type ScheduleImportance = "transient" | "normal" | "strategic" | "low";

export interface TriggerDecisionInput {
  scheduledFor: string;
  taskContext?: Record<string, unknown> | null;
  now?: number;
}

/**
 * Pure predicate — should an `agent_schedule` INSERT trigger a
 * `routine.roadmap_refresh`?
 *
 * Rules:
 *  1. `transient` and `low` never trigger roadmap refreshes.
 *  2. `strategic` triggers for any future scheduled time.
 *  3. Undefined / `"normal"` importance both mean "user-facing" and only
 *     trigger when the wake-up is beyond the 7-day short-reminder horizon.
 */
export function shouldTriggerRoadmapRefresh(input: TriggerDecisionInput): boolean {
  const importance = input.taskContext?.importance;
  if (importance === "transient" || importance === "low") {
    return false;
  }
  const scheduledMs = parseSqliteUtcMs(input.scheduledFor);
  if (!Number.isFinite(scheduledMs)) {
    return false;
  }
  const now = input.now ?? Date.now();
  if (importance === "strategic") {
    return scheduledMs > now;
  }
  const HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
  return scheduledMs - now > HORIZON_MS;
}

/**
 * Fire `triggerRoadmapRefresh` when the row qualifies. Callers are expected
 * to have already committed the INSERT; this helper only bridges the
 * decision to the dispatcher callback so the logic is unit-testable and
 * can be reused across the five INSERT call-sites.
 *
 * The callback is optional because tests and non-dispatcher wiring paths
 * (e.g. the daemon bootstrap window before the dispatcher is ready) can
 * run without it.
 */
export function maybeTriggerRoadmapRefresh(
  input: TriggerDecisionInput,
  triggerRoadmapRefresh: ((source: string) => void) | null | undefined,
  source: string,
): void {
  if (!triggerRoadmapRefresh) return;
  if (!shouldTriggerRoadmapRefresh(input)) return;
  try {
    triggerRoadmapRefresh(source);
  } catch (err) {
    logger.warn({ err, source }, "triggerRoadmapRefresh threw — continuing");
  }
}
