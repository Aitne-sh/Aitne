import type Database from "better-sqlite3";

import { BUILTIN_AGENT_REGISTRY } from "./builtin-registry.js";

/**
 * Resolve the owning Agent slug for a firing (AGENT_DEFINITIONS_DESIGN.md
 * §8.1). Pure over its `AgentIdResolutionInput` (the dispatcher extracts the
 * fields from the live `Event`) so the resolution order is unit-testable.
 *
 * Order (first hit wins):
 *   1. `task_context.agent_id` — stamped at materialisation for user Agents
 *      (§7.2, `recurring-schedules.ts:generateNextScheduleRow`).
 *   2. `recurring_schedule_id` → `agents` join — covers legacy pending rows
 *      materialised before the §7.2 stamp landed.
 *   3. `routine` (+ `phase`) → built-in registry slug — routine events carry
 *      no schedule row, so the routine name maps to its built-in Agent.
 *   4. else `null` — a firing with no Agent identity (legacy task, roadmap
 *      refresh, …) records no execution rollup.
 *
 * The two no-LLM in-process passes (`roadmap-maintenance`,
 * `context-index-reconcile`) carry `processKey: null` and fire via the
 * scheduler's `in_process_callback`, never the dispatcher — so they are never
 * resolved here and intentionally produce no execution row.
 */

export interface AgentIdResolutionInput {
  /** `task_context.agent_id` if present on the schedule row's context. */
  taskContextAgentId?: string | null;
  /** `recurring_schedule_id` (schedule-row column or `task_context`). */
  recurringScheduleId?: number | null;
  /** Routine event name (`morning_routine`, `evening_review`, …). */
  routine?: string | null;
  /** Routine `data.phase` — disambiguates the two `user_profile_sweep` slugs. */
  routinePhase?: string | null;
}

/**
 * Map a routine event name (+ phase) to its built-in Agent slug, or `null`
 * when the routine has no 1:1 Agent. Derived from `BUILTIN_AGENT_REGISTRY`
 * (`processKey === "routine.<name>"`) so it never drifts from the registry,
 * with the only many-to-one routine — `user_profile_sweep`, which owns a
 * morning and an evening Agent — disambiguated by phase.
 */
export function routineToAgentSlug(
  routine: string,
  phase: string | null,
): string | null {
  if (routine === "user_profile_sweep") {
    return phase === "evening"
      ? "user-profile-sweep-evening"
      : "user-profile-sweep-morning";
  }
  const processKey = `routine.${routine}`;
  const matches = BUILTIN_AGENT_REGISTRY.filter(
    (entry) => entry.processKey === processKey,
  );
  // A unique match is the Agent; 0 (non-Agent routine like roadmap_refresh)
  // or >1 (only the sweep, handled above) → no resolution.
  return matches.length === 1 ? matches[0].slug : null;
}

/**
 * Resolve the Agent slug for a firing, verifying the row exists so the caller
 * can safely `recorder.start` (the `agent_executions.agent_id` FK requires it).
 * A resolved-but-missing slug (e.g. a hand-set `task_context.agent_id` whose
 * Agent was deleted, or a built-in whose load failed) returns `null` rather
 * than risk an FK violation.
 */
export function resolveAgentId(
  db: Database.Database,
  input: AgentIdResolutionInput,
): string | null {
  const candidate = resolveCandidateSlug(db, input);
  if (candidate === null) return null;
  return agentRowExists(db, candidate) ? candidate : null;
}

function resolveCandidateSlug(
  db: Database.Database,
  input: AgentIdResolutionInput,
): string | null {
  // 1. Explicit stamp.
  if (
    typeof input.taskContextAgentId === "string"
    && input.taskContextAgentId.length > 0
  ) {
    return input.taskContextAgentId;
  }
  // 2. recurring_schedule_id → agents join.
  if (input.recurringScheduleId != null) {
    const row = db
      .prepare<[number], { id: string }>(
        "SELECT id FROM agents WHERE recurring_schedule_id = ? LIMIT 1",
      )
      .get(input.recurringScheduleId);
    if (row) return row.id;
  }
  // 3. routine (+ phase) → registry slug.
  if (input.routine) {
    const slug = routineToAgentSlug(input.routine, input.routinePhase ?? null);
    if (slug) return slug;
  }
  return null;
}

function agentRowExists(db: Database.Database, slug: string): boolean {
  const row = db
    .prepare<[string], { one: number }>(
      "SELECT 1 AS one FROM agents WHERE id = ? LIMIT 1",
    )
    .get(slug);
  return row !== undefined;
}
