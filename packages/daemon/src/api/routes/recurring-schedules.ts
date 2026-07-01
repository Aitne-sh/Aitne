import { Hono } from "hono";
import {
  recurringScheduleCreateSchema,
  recurringScheduleUpdateSchema,
  type RecurrenceRule,
} from "@aitne/shared";
import {
  createRecurringSchedule,
  listRecurringSchedules,
  getRecurringSchedule,
  updateRecurringSchedule,
  deleteRecurringSchedule,
} from "../../db/recurring-schedules.js";
import { listAgents } from "../../db/agents-store.js";
import { claimedRecurringScheduleAgents } from "../../core/task-board/inventory.js";
import { createLogger } from "../../logging.js";
import type { ApiDependencies } from "../server.js";
import { readJsonBody } from "../json-body.js";
import {
  composeIssue,
  composeWarning,
  respondWithAgentError,
  translateZodError,
  type AgentErrorIssue,
} from "../helpers/agent-errors.js";
import { runDefaultSchedulesReconciler } from "../../core/context/default-schedules-runner.js";
import { getContextDir } from "../../config.js";
import {
  resolveModelToken,
  resolveModelTokenForPatch,
} from "./schedule-model-resolver.js";

const logger = createLogger("recurring-schedules-api");

/**
 * Per-field code overrides fed to `translateZodError` so the recurring
 * routes emit specific `schedule.*` codes instead of collapsing every
 * Zod failure onto the legacy `recurring_schedules.validation_error`
 * single-issue placeholder (SCHEDULE_API_REDESIGN_PLAN §5.4).
 *
 * The map keys are JSON-pointer tails — translateZodIssue selects the
 * longest matching suffix, so `recurrenceRule.time` beats `time` for
 * the recurrence-rule sub-fields while a plain top-level `description`
 * still resolves through the shorter key.
 *
 * Custom-Zod-code (superRefine) issues at the recurrenceRule.* paths
 * land on these same codes through `applyRecurringIssueOverrides`
 * below — the additional pass remaps them to
 * `schedule.frequency_field_mismatch` because the superRefine emits
 * one issue per cross-field violation (e.g. "time is not allowed for
 * hourly frequency").
 */
const RECURRING_FIELD_CODE_MAP: Record<string, string> = {
  taskType: "schedule.task_type_unknown",
  description: "schedule.description_too_short",
  prompt: "schedule.prompt_too_short",
  model: "schedule.model_unknown",
  tier: "schedule.tier_unknown",
  recurrenceRule: "schedule.recurrence_rule_invalid",
  "recurrenceRule.frequency": "schedule.frequency_unknown",
  "recurrenceRule.time": "schedule.time_format_invalid",
  "recurrenceRule.intervalHours": "schedule.interval_hours_out_of_range",
  "recurrenceRule.minuteOfHour": "schedule.minute_of_hour_out_of_range",
  "recurrenceRule.daysOfWeek": "schedule.days_of_week_invalid",
  "recurrenceRule.daysOfMonth": "schedule.days_of_month_invalid",
  "recurrenceRule.onMissingDay": "schedule.on_missing_day_unknown",
  "recurrenceRule.timezone": "schedule.timezone_unknown",
};

/**
 * Promote custom-Zod-code issues (those emitted by the recurrence-rule
 * superRefine for cross-field violations like "time is not allowed
 * for hourly frequency") onto `schedule.frequency_field_mismatch`
 * regardless of the field path. The fieldCodeMap by itself would
 * route every `recurrenceRule.time` failure onto
 * `schedule.time_format_invalid` — accurate for a regex miss, wrong
 * for "time is required for daily".
 *
 * The remap key is the original Zod `issue.code === "custom"`. The
 * registry entry's `field_mismatch` code attaches a generic hint that
 * lists every per-frequency rule; the LLM picks the matching one.
 */
function applyRecurringIssueOverrides(
  zodIssues: ReadonlyArray<{ code: string }>,
  issues: AgentErrorIssue[],
): AgentErrorIssue[] {
  return issues.map((issue, idx) => {
    const original = zodIssues[idx];
    if (
      original?.code === "custom" &&
      issue.field.startsWith("recurrenceRule.")
    ) {
      return composeIssue("schedule.frequency_field_mismatch", {
        field: issue.field,
        received: issue.received,
        rowIndex: issue.rowIndex,
      });
    }
    return issue;
  });
}

/**
 * Resolve the timezone to STAMP on a recurrence rule, or `undefined` to omit
 * the key. An explicit per-rule zone or an operator config zone is stamped and
 * stays pinned; in auto mode (no per-rule zone, empty config) we return
 * `undefined` so the `timezone` key is omitted and `resolveRuleTimezone`
 * re-resolves the LIVE OS zone at every materialization — self-healing, the
 * same behaviour the morning-briefing seed relies on (TimezoneWatcher keeps
 * `Intl` current). Baking a concrete OS zone here froze a rule to its
 * create-time zone, so a laptop crossing timezones kept firing at the old
 * wall-clock time (audit finding A3).
 */
function resolveTimezone(
  rule: { timezone?: string },
  configTimezone: string,
): string | undefined {
  if (rule.timezone) return rule.timezone;
  if (configTimezone) return configTimezone;
  return undefined;
}

/**
 * SCHEDULE_API_REDESIGN_PLAN §5 / §5.0.5 — emit
 * `schedule.on_missing_day_unused` (warning, non-blocking) when
 * `onMissingDay` is set on a monthly rule whose `daysOfMonth` has no
 * entry in [29, 30, 31]. The field is a no-op intent signal in that
 * shape; the row still persists and the warning nudges the caller to
 * either drop the field or extend the day set on the next PATCH.
 *
 * Returns an empty array for any rule that doesn't fit the pattern,
 * so the caller can always spread it into the response's `warnings[]`
 * channel without conditionals.
 */
function detectOnMissingDayUnusedWarnings(
  rule: RecurrenceRule,
): AgentErrorIssue[] {
  if (rule.frequency !== "monthly") return [];
  if (rule.onMissingDay === undefined) return [];
  const days = rule.daysOfMonth ?? [];
  if (days.some((d) => d >= 29)) return [];
  return [
    composeWarning("schedule.on_missing_day_unused", {
      field: "recurrenceRule.onMissingDay",
      received: rule.onMissingDay,
      rowIndex: null,
      validValues: {
        daysOfMonth: days,
        overflowDays: [29, 30, 31],
      },
    }),
  ];
}

/**
 * Scheduling split — `recurring_schedules` is now the home ONLY for recurring
 * scheduled DMs (`task_type = 'dm_session'`, e.g. the morning briefing — whose
 * fire time is dynamically retimed by `quiet-hours-sync.ts` and so does not fit
 * the fixed-cron Agent model). Recurring `agent.task` (LLM work) is created and
 * managed as an Agent via `/api/agents` (the `agent-create` skill). Every
 * non-`dm_session` mutation here is therefore 410 Gone with a pointer.
 */
function recurringAgentTaskGone(action: "create" | "update" | "delete"): {
  error: string;
  hint: string;
} {
  const pointer =
    action === "create"
      ? "Create a recurring work Agent with POST /api/agents (the agent-create skill)."
      : action === "update"
        ? "Manage the owning Agent via PATCH /api/agents/:slug (or its agent.md)."
        : "Remove the owning Agent via DELETE /api/agents/:slug.";
  return {
    error: "recurring_agent_task_moved_to_agents",
    hint: `recurring_schedules now serves dm_session (scheduled DMs) only; recurring agent.task work moved to the /agents layer. ${pointer}`,
  };
}

/**
 * Canonical-owner write guard — a dm_session row an Agent references (its
 * cadence satellite; see `claimedRecurringScheduleAgents`) must not be edited
 * or deleted out from under that Agent: a direct PATCH desyncs `enabled` from
 * the Agent card (the one-way Agent→row mirror never repairs it), and a direct
 * DELETE SET-NULLs `agents.recurring_schedule_id`, leaving an Agent that
 * silently never fires. 409 with a pointer to the owning Agent.
 */
function recurringClaimedByAgent(
  action: "update" | "delete",
  slug: string,
): { error: string; hint: string } {
  const pointer =
    action === "update"
      ? `Manage it via PATCH /api/agents/${slug} (e.g. {"enabled": false} to pause, or schedule_window to retime).`
      : `DELETE /api/agents/${slug} disables the Agent; add {"keep_history": false} to hard-delete it along with this schedule row.`;
  return {
    error: "recurring_schedule_claimed_by_agent",
    hint: `This dm_session row is the cadence satellite of Agent '${slug}' (its canonical owner). ${pointer}`,
  };
}

/**
 * An automation trigger's paired recurring row is stamped by `createTrigger`
 * (`task_context.triggerSource = 'automation_trigger'`, plus the owning
 * `triggerId`). The trigger is its canonical owner — the board lists it as
 * `trigger:<id>` — so the list hides it by default, symmetric with
 * agent-claimed dm_sessions.
 */
function isTriggerOwned(it: { taskContext: Record<string, unknown> | null }): boolean {
  return it.taskContext?.triggerSource === "automation_trigger";
}

/** The owning trigger id for annotation, or null when not trigger-owned
 *  (or the back-patched id is missing — theoretical, same-txn write). */
function owningTriggerId(it: { taskContext: Record<string, unknown> | null }): number | null {
  if (!isTriggerOwned(it)) return null;
  const id = it.taskContext?.triggerId;
  return typeof id === "number" ? id : null;
}

export function createRecurringScheduleRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  const { db, config } = deps;

  /**
   * SCHEDULED-DM-IMPLEMENTATION-PLAN §2.5 — every recurring-schedules
   * mutation triggers the `## Default Schedules` reconciler so the
   * read-only mirror in `policies/management.md` stays in lock-step with
   * the table. Best-effort: failures are logged but never block the
   * caller's response — the reconciler runs on its own mutex and
   * persists a runtime_state row so the dashboard can surface drift.
   */
  function refreshDefaultSchedulesMirror(): void {
    let contextDir: string;
    try {
      contextDir = getContextDir(config, db);
    } catch (err) {
      logger.warn(
        { err },
        "Default-schedules reconciler skipped — getContextDir failed",
      );
      return;
    }
    runDefaultSchedulesReconciler({
      db,
      contextDir,
      writeTracker: deps.writeTracker,
      onPromptContextChanged: deps.onPromptContextChanged,
      trigger: "manual",
    }).catch((err) => {
      logger.warn(
        { err },
        "Default-schedules reconciler failed after recurring-schedules mutation",
      );
    });
  }

  // POST /recurring-schedules — Create a new recurring schedule
  app.post("/recurring-schedules", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = recurringScheduleCreateSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      // SCHEDULE_API_REDESIGN_PLAN §5.4 — replace the legacy
      // single-issue collapse with field-keyed `schedule.*` codes
      // so the LLM caller gets the same precision the agent-schedule
      // route already emits. Custom-Zod-code issues (from the
      // recurrenceRule superRefine cross-field rules) get remapped
      // to `schedule.frequency_field_mismatch` in the second pass.
      const issues = applyRecurringIssueOverrides(
        parsed.error.issues,
        translateZodError(parsed.error, {
          namespace: "schedule",
          fieldCodeMap: RECURRING_FIELD_CODE_MAP,
        }),
      );
      return respondWithAgentError(c, 400, issues);
    }

    const { taskType, description, prompt, recurrenceRule, model, tier, taskContext } = parsed.data;

    // Split gate — only recurring scheduled DMs live here now; everything else
    // (recurring agent.task LLM work) is created as an Agent via POST /api/agents.
    if (taskType !== "dm_session") {
      return c.json(recurringAgentTaskGone("create"), 410);
    }

    // Phase D — resolve `(model, tier)` against the live registry
    // BEFORE writing. The resolver enforces §4.3's mutual-exclusion
    // rule, rewrites legacy aliases to `tier_override`, captures the
    // backend pin for registered ids, and surfaces deprecation as a
    // §5.0.5 warning rather than a hard reject.
    const resolved = resolveModelToken({
      model,
      tier,
      fieldBase: "model",
      tierField: "tier",
      rowIndex: null,
    });
    if (!resolved.ok) {
      return respondWithAgentError(c, 400, resolved.errors);
    }

    // Stamp an explicit per-rule / operator-config zone; OMIT the key in auto
    // mode so the rule tracks the live OS zone at fire time (audit A3).
    const resolvedTimezone = resolveTimezone(recurrenceRule, config.timezone);
    const resolvedRule: RecurrenceRule = {
      ...recurrenceRule,
      ...(resolvedTimezone !== undefined ? { timezone: resolvedTimezone } : {}),
    };

    const dto = createRecurringSchedule(db, {
      taskType,
      description,
      prompt,
      recurrenceRule: resolvedRule,
      // §4.3 persistence — alias rows persist `tier_override` only;
      // registered-model rows persist `(model, backend_id)` only;
      // pure-tier rows persist `tier_override` only.
      model: resolved.model ?? undefined,
      tier: resolved.tierOverride ?? undefined,
      // §4.3a — snapshot the backend at write time so the scheduler's
      // override block has both halves when materializing the next
      // agent_schedule row.
      backendId: resolved.backendId ?? undefined,
      taskContext,
    });

    logger.info(
      { id: dto.id, taskType, recurrenceLabel: dto.recurrenceLabel },
      "Recurring schedule created",
    );

    refreshDefaultSchedulesMirror();
    // §5.0.5 advisories — combine the model-resolver's deprecation
    // warning channel with the no-op `onMissingDay` advisory so the
    // LLM sees both nudges in one response shape (always-present
    // array, even when empty).
    const warnings = [
      ...resolved.warnings,
      ...detectOnMissingDayUnusedWarnings(resolvedRule),
    ];
    return c.json({ status: "created", item: dto, warnings }, 201);
  });

  // GET /recurring-schedules — List recurring schedules
  app.get("/recurring-schedules", (c) => {
    const enabledOnly = c.req.query("enabled") === "true";
    const includeClaimed = c.req.query("includeClaimed") === "true";
    const items = listRecurringSchedules(db, { enabledOnly });
    // Canonical-owner dedup, two families:
    // - A `dm_session` row an Agent references (its cadence satellite) is
    //   managed through that Agent (`claimedRecurringScheduleAgents`, shared
    //   with the Task-board inventory dedup).
    // - An automation trigger's paired `agent.task` row is managed through the
    //   trigger (surfaced on the board as `trigger:<id>`); its `task_context`
    //   carries `triggerSource`/`triggerId` from `createTrigger`.
    // Both are hidden here by default so they aren't double-listed on
    // /schedule (also shown as an Agent card / a board trigger item).
    // `?includeClaimed=true` returns them annotated with `claimedByAgentSlug`
    // / `claimedByTriggerId` instead — the schedule skill's dedup pre-check
    // needs to SEE covered cadences or it re-creates them (duplicate DMs at
    // fire time). Writes stay guarded either way (dm_session: the PATCH/DELETE
    // 409 below; agent.task: the 410 split gate).
    const claimedByAgent = claimedRecurringScheduleAgents(listAgents(db));
    if (includeClaimed) {
      const annotated = items.map((it) => {
        const owner =
          it.taskType === "dm_session" ? claimedByAgent.get(it.id) : undefined;
        if (owner) return { ...it, claimedByAgentSlug: owner.slug };
        const triggerId = owningTriggerId(it);
        return triggerId !== null ? { ...it, claimedByTriggerId: triggerId } : it;
      });
      return c.json({ items: annotated });
    }
    const visible = items.filter(
      (it) =>
        !(it.taskType === "dm_session" && claimedByAgent.has(it.id)) &&
        !isTriggerOwned(it),
    );
    return c.json({ items: visible });
  });

  // GET /recurring-schedules/:id — Get a single recurring schedule
  app.get("/recurring-schedules/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return respondWithAgentError(c, 400, [
        composeIssue("schedule.recurring_id_invalid", {
          field: "id",
          received: c.req.param("id") ?? "<missing>",
        }),
      ]);
    }

    const dto = getRecurringSchedule(db, id);
    if (!dto) {
      return respondWithAgentError(c, 404, [
        composeIssue("schedule.recurring_not_found", {
          field: "id",
          received: c.req.param("id") ?? "<unknown>",
        }),
      ]);
    }

    // Surface the canonical owner on a direct fetch, so a caller holding a
    // stale `rs:<id>` learns it is Agent-managed (409 guards below) or
    // trigger-managed (410 split gate) before attempting the write.
    if (dto.taskType === "dm_session") {
      const owner = claimedRecurringScheduleAgents(listAgents(db)).get(dto.id);
      if (owner) return c.json({ ...dto, claimedByAgentSlug: owner.slug });
    }
    const triggerId = owningTriggerId(dto);
    if (triggerId !== null) return c.json({ ...dto, claimedByTriggerId: triggerId });
    return c.json(dto);
  });

  // PATCH /recurring-schedules/:id — Update a recurring schedule
  app.patch("/recurring-schedules/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return respondWithAgentError(c, 400, [
        composeIssue("schedule.recurring_id_invalid", {
          field: "id",
          received: c.req.param("id") ?? "<missing>",
        }),
      ]);
    }

    // Split gate — only dm_session rows are editable here; an agent.task row is
    // Agent-owned and managed via /api/agents.
    const target = getRecurringSchedule(db, id);
    if (!target) {
      return respondWithAgentError(c, 404, [
        composeIssue("schedule.recurring_not_found", {
          field: "id",
          received: c.req.param("id") ?? "<unknown>",
        }),
      ]);
    }
    if (target.taskType !== "dm_session") {
      return c.json(recurringAgentTaskGone("update"), 410);
    }
    // Canonical-owner guard — an agent-claimed satellite row is edited through
    // its Agent, never directly (a direct PATCH desyncs enabled/cadence from
    // the Agent card with no mirror to repair it).
    const patchOwner = claimedRecurringScheduleAgents(listAgents(db)).get(id);
    if (patchOwner) {
      return c.json(recurringClaimedByAgent("update", patchOwner.slug), 409);
    }

    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = recurringScheduleUpdateSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      // SCHEDULE_API_REDESIGN_PLAN §5.4 — adopt translateZodError
      // parity with the create path. The Zod `.refine(at least one
      // field)` failure surfaces as `schedule.recurring_no_changes`
      // via the field-code map's `body` entry; per-field validation
      // failures route through `RECURRING_FIELD_CODE_MAP` as usual.
      const issues = applyRecurringIssueOverrides(
        parsed.error.issues,
        translateZodError(parsed.error, {
          namespace: "schedule",
          fieldCodeMap: RECURRING_FIELD_CODE_MAP,
        }),
      ).map((issue) => {
        // The top-level refine has an empty path (`field === ""`) and
        // surfaces as `<ns>.field_invalid` (unregistered placeholder).
        // Promote to `schedule.recurring_no_changes` so the LLM gets
        // a useful hint.
        if (issue.field === "" && issue.code.endsWith("_invalid")) {
          return composeIssue("schedule.recurring_no_changes", {
            field: "body",
            received: parsedBody.body,
            rowIndex: null,
          });
        }
        return issue;
      });
      return respondWithAgentError(c, 400, issues);
    }

    // Phase D — resolve PATCH-shape `(model, tier)` against the
    // registry. PATCH-only semantics: `null` is the explicit clear
    // sentinel, `undefined` is "leave the column alone".
    const patchResolved = resolveModelTokenForPatch({
      model: parsed.data.model,
      tier: parsed.data.tier,
      fieldBase: "model",
      tierField: "tier",
      rowIndex: null,
    });
    if (!patchResolved.ok) {
      return respondWithAgentError(c, 400, patchResolved.errors);
    }

    // Build the DB update payload, threading the PATCH resolver's
    // three partials onto the typed update params. Each `present:false`
    // leg is just omitted so `updateRecurringSchedule` skips the
    // column entirely.
    const updateData: Parameters<typeof updateRecurringSchedule>[2] = {
      ...parsed.data,
      model: undefined,
      tier: undefined,
    };
    if (patchResolved.model.present) updateData.model = patchResolved.model.value;
    if (patchResolved.tierOverride.present) {
      updateData.tier = patchResolved.tierOverride.value;
    }
    if (patchResolved.backendId.present) {
      updateData.backendId = patchResolved.backendId.value;
    }

    // Stamp an explicit per-rule / operator-config zone; OMIT the key in auto
    // mode so the rule tracks the live OS zone at fire time (audit A3).
    if (updateData.recurrenceRule) {
      const resolvedTimezone = resolveTimezone(
        updateData.recurrenceRule,
        config.timezone,
      );
      updateData.recurrenceRule = {
        ...updateData.recurrenceRule,
        ...(resolvedTimezone !== undefined
          ? { timezone: resolvedTimezone }
          : {}),
      };
    }

    const dto = updateRecurringSchedule(db, id, updateData);
    if (!dto) {
      return respondWithAgentError(c, 404, [
        composeIssue("schedule.recurring_not_found", {
          field: "id",
          received: c.req.param("id") ?? "<unknown>",
        }),
      ]);
    }

    logger.info(
      { id, recurrenceLabel: dto.recurrenceLabel, enabled: dto.enabled },
      "Recurring schedule updated",
    );

    refreshDefaultSchedulesMirror();
    // §5.0.5 — same warning composition as POST, computed against
    // the post-update rule so an operator who removes the no-op
    // `onMissingDay` (or adds a 29/30/31 day) stops seeing the
    // advisory on the very next PATCH response.
    const postUpdateRule = dto.recurrenceRule as RecurrenceRule;
    const warnings = [
      ...patchResolved.warnings,
      ...detectOnMissingDayUnusedWarnings(postUpdateRule),
    ];
    return c.json({
      status: "updated",
      item: dto,
      warnings,
    });
  });

  // DELETE /recurring-schedules/:id — Delete a recurring schedule
  app.delete("/recurring-schedules/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return respondWithAgentError(c, 400, [
        composeIssue("schedule.recurring_id_invalid", {
          field: "id",
          received: c.req.param("id") ?? "<missing>",
        }),
      ]);
    }

    // Split gate — only dm_session rows are deletable here; agent.task rows are
    // Agent-owned (DELETE /api/agents/:slug).
    const target = getRecurringSchedule(db, id);
    if (target && target.taskType !== "dm_session") {
      return c.json(recurringAgentTaskGone("delete"), 410);
    }
    // Canonical-owner guard — deleting a claimed satellite row SET-NULLs
    // `agents.recurring_schedule_id` and leaves an Agent that silently never
    // fires. The agent-delete code path (which cleans up both rows) is the only
    // legitimate remover; it calls `deleteRecurringSchedule` directly and never
    // passes through this route.
    if (target) {
      const deleteOwner = claimedRecurringScheduleAgents(listAgents(db)).get(id);
      if (deleteOwner) {
        return c.json(recurringClaimedByAgent("delete", deleteOwner.slug), 409);
      }
    }

    const deleted = deleteRecurringSchedule(db, id);
    if (!deleted) {
      return respondWithAgentError(c, 404, [
        composeIssue("schedule.recurring_not_found", {
          field: "id",
          received: c.req.param("id") ?? "<unknown>",
        }),
      ]);
    }

    logger.info({ id }, "Recurring schedule deleted");
    refreshDefaultSchedulesMirror();
    return c.json({ status: "deleted", id });
  });

  return app;
}
