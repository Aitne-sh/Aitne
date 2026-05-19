// Pure helpers that match an incoming `agent_schedule` row to the
// corresponding `today.md` Agent Plan row, so a future `scheduled.task`
// session inherits the `agentPlan` metadata its row was authored from.
//
// Co-resident with agent-schedule.ts (the routes that consume them) — kept
// separate so the route file stays under the api-route-decomposition.md
// §8 ~800-line soft cap and so the matching logic can be unit-tested
// without going through Hono. Used only by POST /schedule and POST
// /schedule/batch.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nowInTimezone } from "@aitne/shared";
import { getContextDir } from "../../config.js";
import { createLogger } from "../../logging.js";
import type { ApiDependencies } from "../server.js";
import {
  buildTodayAgentPlanMetadata,
  extractTodayAgentPlanRows,
  extractTodayDate,
  normalizeAgentPlanAction,
  readTodayAgentPlanMetadata,
  type TodayAgentPlanCategory,
  type TodayAgentPlanRow,
  type TodayAgentPlanTrigger,
} from "../../core/today-agent-plan.js";

const logger = createLogger("agent-schedule-plan-match");

export function enrichAgentPlanTaskContext(
  taskContext: Record<string, unknown> | undefined,
  scheduledAt: Date,
  description: string,
  deps: ApiDependencies,
): Record<string, unknown> {
  const nextContext: Record<string, unknown> = taskContext
    ? { ...taskContext }
    : {};
  if (readTodayAgentPlanMetadata(nextContext)) return nextContext;

  const config = deps.config;
  if (!config?.dataDir) return nextContext;

  const timezone = config.timezone || undefined;
  const scheduledLocal = localDateTimeParts(scheduledAt, timezone);
  let content: string;
  try {
    const todayPath = join(getContextDir(config, deps.db), "today.md");
    if (!existsSync(todayPath)) return nextContext;
    content = readFileSync(todayPath, "utf-8");
  /* c8 ignore start */
  } catch (err) {
    logger.warn({ err }, "Failed to read today.md for Agent Plan schedule metadata");
    return nextContext;
  }
  /* c8 ignore stop */

  if (extractTodayDate(content) !== scheduledLocal.date) return nextContext;

  const candidates = extractTodayAgentPlanRows(content).rows.filter(
    (row) => !row.checked && row.time === scheduledLocal.time,
  );
  const matched = selectAgentPlanRowForSchedule(
    candidates,
    description,
    nextContext,
  );
  if (!matched) return nextContext;

  nextContext.agentPlan = buildTodayAgentPlanMetadata(
    scheduledLocal.date,
    matched,
  );
  return nextContext;
}

export function selectAgentPlanRowForSchedule(
  rows: TodayAgentPlanRow[],
  description: string,
  taskContext: Record<string, unknown>,
): TodayAgentPlanRow | null {
  let candidates = rows;
  const triggerHint = contextTriggerHint(taskContext);
  if (triggerHint) {
    const filtered = candidates.filter((row) => row.trigger === triggerHint);
    if (filtered.length > 0) candidates = filtered;
  }
  const categoryHint = contextCategoryHint(taskContext);
  if (categoryHint) {
    const filtered = candidates.filter((row) => row.category === categoryHint);
    if (filtered.length > 0) candidates = filtered;
  }

  const descriptionMatches = candidates.filter((row) =>
    actionsLikelyMatch(row.action, description)
  );
  if (descriptionMatches.length === 1) return descriptionMatches[0];
  if (candidates.length === 1) return candidates[0];
  return null;
}

function actionsLikelyMatch(agentPlanAction: string, description: string): boolean {
  const action = normalizeAgentPlanAction(agentPlanAction);
  const task = normalizeAgentPlanAction(description);
  return task.includes(action) || action.includes(task);
}

function contextTriggerHint(
  taskContext: Record<string, unknown>,
): TodayAgentPlanTrigger | null {
  const value = taskContext.agentPlanTrigger ?? taskContext.trigger;
  return value === "DM" ||
    value === "notify" ||
    value === "check-in" ||
    value === "wake"
    ? value
    : null;
}

function contextCategoryHint(
  taskContext: Record<string, unknown>,
): TodayAgentPlanCategory | null {
  const value = taskContext.agentPlanCategory ?? taskContext.category;
  return value === "work" ||
    value === "study" ||
    value === "personal" ||
    value === "home"
    ? value
    : null;
}

function localDateTimeParts(date: Date, timezone?: string): {
  date: string;
  time: string;
} {
  const local = nowInTimezone(timezone, date);
  return {
    date: `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`,
    time: `${String(local.hours).padStart(2, "0")}:${String(local.minutes).padStart(2, "0")}`,
  };
}
