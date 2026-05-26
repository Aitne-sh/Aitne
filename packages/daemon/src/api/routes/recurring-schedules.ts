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

/** Resolve the effective timezone for a recurrence rule. */
function resolveTimezone(
  rule: { timezone?: string },
  configTimezone: string,
): string {
  if (rule.timezone) return rule.timezone;
  if (configTimezone) return configTimezone;
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
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

    // Auto-fill timezone from daemon config if not provided
    const resolvedRule: RecurrenceRule = {
      ...recurrenceRule,
      timezone: resolveTimezone(recurrenceRule, config.timezone),
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
    const items = listRecurringSchedules(db, { enabledOnly });
    return c.json({ items });
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

    // Auto-fill timezone on recurrenceRule update
    if (updateData.recurrenceRule) {
      updateData.recurrenceRule = {
        ...updateData.recurrenceRule,
        timezone: resolveTimezone(updateData.recurrenceRule, config.timezone),
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
