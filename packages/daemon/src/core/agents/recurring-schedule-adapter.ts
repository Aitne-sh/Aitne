import type Database from "better-sqlite3";
import type { RecurrenceRule } from "@aitne/shared";

import {
  createRecurringSchedule,
  getRecurringSchedule,
  listRecurringSchedules,
  updateRecurringSchedule,
  type RecurringScheduleDTO,
} from "../../db/recurring-schedules.js";
import type {
  RecurringAgentRow,
  RecurringCreateInput,
  RecurringSchedulePort,
  RecurringUpdateInput,
} from "./loader.js";
import type { AgentRecurrenceSpec } from "./recurrence-convert.js";

/**
 * Concrete {@link RecurringSchedulePort} over `db/recurring-schedules.ts`
 * (AGENT_DEFINITIONS_DESIGN.md §6.1 step 5 / §6.5 — the Phase-7 adapter the
 * Phase-5 loader's DI seam expects).
 *
 * The loader speaks the cron-representable {@link AgentRecurrenceSpec}; the
 * store speaks the richer daemon `RecurrenceRule` (which additionally carries
 * `hourly` + the monthly `onMissingDay` policy). This adapter maps between the
 * two with a field copy in the three directions the loader needs:
 *
 *   - `list()` / `get()`  — `RecurrenceRule` → `AgentRecurrenceSpec`.
 *   - `create()` / `update()` — `AgentRecurrenceSpec` → `RecurrenceRule`.
 *
 * **`hourly` round-trips** (the former Phase-5/7 gap, now closed). An `hourly`
 * recurring row maps to an `hourly` {@link AgentRecurrenceSpec} (and back via
 * the step-form cron), so the loader pairs hourly user Agents and auto-imports
 * legacy `hourly` `agent.task` rows like any other cadence. Subsystem-owned
 * rows (managed-tasks / automation / the dm_session seed) are still skipped by
 * the loader's own `isSubsystemOwnedRow` gate, not here.
 *
 * Every `update()` carries `cancelReason: "agent_definition_changed"` so a
 * superseded pending materialisation is tagged in its `task_context`
 * (§11.3.2) — the adapter is only ever called for Agent-owned rows, so the
 * reason is always accurate.
 */

const AGENT_CANCEL_REASON = "agent_definition_changed";

/**
 * Map a daemon `RecurrenceRule` to the loader's {@link AgentRecurrenceSpec}.
 * Total over all four frequencies (`hourly` now round-trips via the step-form
 * cron). `time` / `timezone` are guaranteed on daily/weekly/monthly rows by
 * `recurrenceRuleSchema`, but a defensive fallback keeps the mapping total
 * against a hand-edited row.
 */
export function recurrenceRuleToSpec(
  rule: RecurrenceRule,
  fallbackTimezone: string,
): AgentRecurrenceSpec {
  const timezone =
    rule.timezone && rule.timezone.length > 0 ? rule.timezone : fallbackTimezone;
  if (rule.frequency === "hourly") {
    return {
      frequency: "hourly",
      timezone,
      intervalHours: rule.intervalHours ?? 1,
      minuteOfHour: rule.minuteOfHour ?? 0,
    };
  }
  const time = rule.time && rule.time.length > 0 ? rule.time : "00:00";
  if (rule.frequency === "weekly") {
    return {
      frequency: "weekly",
      time,
      timezone,
      daysOfWeek: rule.daysOfWeek ?? [],
    };
  }
  if (rule.frequency === "monthly") {
    return {
      frequency: "monthly",
      time,
      timezone,
      daysOfMonth: rule.daysOfMonth ?? [],
    };
  }
  return { frequency: "daily", time, timezone };
}

/**
 * Map the loader's {@link AgentRecurrenceSpec} back to a daemon
 * `RecurrenceRule`. Total — the spec carries the four cron-representable
 * frequencies, all of which are valid `RecurrenceRule` shapes.
 */
export function specToRecurrenceRule(spec: AgentRecurrenceSpec): RecurrenceRule {
  if (spec.frequency === "hourly") {
    return {
      frequency: "hourly",
      timezone: spec.timezone,
      intervalHours: spec.intervalHours ?? 1,
      minuteOfHour: spec.minuteOfHour ?? 0,
    };
  }
  // Single defensive fallback for the three timed frequencies (well-formed
  // daily/weekly/monthly specs always carry a time).
  const time = spec.time ?? "00:00";
  if (spec.frequency === "weekly") {
    return { frequency: "weekly", time, timezone: spec.timezone, daysOfWeek: spec.daysOfWeek ?? [] };
  }
  if (spec.frequency === "monthly") {
    return { frequency: "monthly", time, timezone: spec.timezone, daysOfMonth: spec.daysOfMonth ?? [] };
  }
  return { frequency: "daily", time, timezone: spec.timezone };
}

/** Map a store DTO to the loader row shape. Total — every `recurrence_rule`
 *  frequency (incl. `hourly`) is now representable as an `AgentRecurrenceSpec`. */
function dtoToAgentRow(
  dto: RecurringScheduleDTO,
  fallbackTimezone: string,
): RecurringAgentRow {
  return {
    id: dto.id,
    enabled: dto.enabled,
    taskType: dto.taskType,
    description: dto.description,
    prompt: dto.prompt,
    model: dto.model,
    tier: dto.tier,
    backendId: dto.backendId,
    recurrence: recurrenceRuleToSpec(dto.recurrenceRule, fallbackTimezone),
    // Carried so the loader's auto-import sweep can skip subsystem-owned rows
    // (managed-tasks `mt_id`, automation-trigger `triggerSource`).
    taskContext: dto.taskContext,
  };
}

/**
 * Build the loader's {@link RecurringSchedulePort} over a live DB. The
 * `fallbackTimezone` (resolved from `config.timezone`) fills a hand-edited
 * row that somehow stored no zone; well-formed rows always carry their own.
 */
export function createRecurringSchedulePort(
  db: Database.Database,
  fallbackTimezone: string,
): RecurringSchedulePort {
  return {
    list(): RecurringAgentRow[] {
      return listRecurringSchedules(db).map((dto) =>
        dtoToAgentRow(dto, fallbackTimezone),
      );
    },

    get(id: number): RecurringAgentRow | null {
      const dto = getRecurringSchedule(db, id);
      return dto === null ? null : dtoToAgentRow(dto, fallbackTimezone);
    },

    create(input: RecurringCreateInput): number {
      const dto = createRecurringSchedule(db, {
        // §6.4-resolved enabled (mirrors `agents.enabled`); the store defaults
        // to enabled when omitted, but the loader always resolves it explicitly.
        enabled: input.enabled,
        taskType: input.taskType,
        description: input.description,
        ...(input.prompt !== null ? { prompt: input.prompt } : {}),
        recurrenceRule: specToRecurrenceRule(input.recurrence),
        ...(input.model !== null ? { model: input.model } : {}),
        ...(input.tier !== null ? { tier: input.tier } : {}),
        ...(input.backendId !== null ? { backendId: input.backendId } : {}),
      });
      return dto.id;
    },

    update(id: number, patch: RecurringUpdateInput): void {
      updateRecurringSchedule(
        db,
        id,
        {
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          ...(patch.description !== undefined
            ? { description: patch.description }
            : {}),
          ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
          ...(patch.model !== undefined ? { model: patch.model } : {}),
          ...(patch.tier !== undefined ? { tier: patch.tier } : {}),
          ...(patch.backendId !== undefined
            ? { backendId: patch.backendId }
            : {}),
          ...(patch.recurrence !== undefined
            ? { recurrenceRule: specToRecurrenceRule(patch.recurrence) }
            : {}),
        },
        // Agent-driven edits tag a superseded pending row so the dispatcher /
        // dashboard can attribute the skip to a definition change (§11.3.2).
        AGENT_CANCEL_REASON,
      );
    },
  };
}
