import { Hono } from "hono";
import type { AgentConfig } from "../../config.js";
import { snapshotModelRegistry } from "./schedule-validation.js";

/**
 * SCHEDULE_API_REDESIGN_PLAN.md §4.4 — read-only discovery endpoint.
 *
 * `GET /api/schedule/options` returns every value the LLM needs to
 * compose a valid POST /api/schedule (or /recurring-schedules) call:
 * tiers, model aliases, registered models per backend, recurrence
 * frequencies, day-of-week labels, time format, and the configured
 * default timezone.
 *
 * The error envelope (schedule.model_unknown, schedule.frequency_unknown,
 * schedule.days_of_week_invalid, schedule.timezone_unknown) cites this
 * endpoint via `docsUrl` so the LLM can fetch the live shape on the next
 * turn instead of guessing.
 *
 * Pure read — no DB hit. The snapshot is built from the static
 * `MODEL_REGISTRY` plus the operator-configured timezone. Phase G may
 * hang a dashboard surface off this same payload.
 */

export interface ScheduleOptionsRouteDependencies {
  config: AgentConfig;
}

/**
 * Day-of-week labels exposed in `/schedule/options.daysOfWeek`. Mirrors
 * the `daysOfWeek` integer enum in `recurrenceRuleSchema` (`0=Sun`..`6=Sat`)
 * so the LLM can map between the schema and a human-readable label.
 *
 * Static — locale-aware labels are out of scope (Aitne is single-owner
 * and the daemon answers in English per `feedback_skill_content_english_only`).
 */
const DAYS_OF_WEEK: Readonly<Record<"0" | "1" | "2" | "3" | "4" | "5" | "6", string>> = {
  "0": "Sun",
  "1": "Mon",
  "2": "Tue",
  "3": "Wed",
  "4": "Thu",
  "5": "Fri",
  "6": "Sat",
};

/** Static enum surface — kept in sync with `recurrenceRuleSchema.frequency`. */
const FREQUENCIES = ["hourly", "daily", "weekly", "monthly"] as const;
const TIERS = ["lite", "medium", "high"] as const;

/**
 * Per-frequency composition bounds. Surfaced so the LLM has a one-stop
 * discovery endpoint for composing any recurring rule on the first try
 * instead of probing via Phase D's error envelope. Mirrors the
 * superRefine ranges in `recurrenceRuleSchema` — keep these in lockstep
 * with the schema (`packages/shared/src/schemas.ts`); the
 * schedule-options.test.ts contract pins the pair.
 *
 * `onMissingDay.default` reflects the §12.6 "lastDayOfMonth"
 * recommendation: callers that omit the field on a monthly rule with
 * `daysOfMonth` containing 29/30/31 get the bit-compatible clamp
 * behavior of the pre-redesign engine.
 */
const RECURRENCE = {
  intervalHours: { min: 1, max: 23 },
  minuteOfHour: { min: 0, max: 59 },
  daysOfMonth: { min: 1, max: 31 },
  onMissingDay: {
    values: ["skip", "lastDayOfMonth"] as const,
    default: "lastDayOfMonth" as const,
  },
} as const;

function resolveDefaultTimezone(config: AgentConfig): string {
  // Prefer the operator's configured primary timezone. When unset (the
  // first-boot default), fall back to the system-resolved IANA zone so
  // the LLM still gets a real default rather than an empty string.
  if (config.timezone && config.timezone.length > 0) {
    return config.timezone;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function createScheduleOptionsRoutes(
  deps: ScheduleOptionsRouteDependencies,
): Hono {
  const app = new Hono();

  app.get("/schedule/options", (c) => {
    const snapshot = snapshotModelRegistry();
    const defaultTimezone = resolveDefaultTimezone(deps.config);
    return c.json({
      tiers: TIERS,
      modelAliases: snapshot.modelAliases,
      models: snapshot.models,
      frequencies: FREQUENCIES,
      daysOfWeek: DAYS_OF_WEEK,
      // Composition bounds for hourly + monthly rules. Without these the
      // LLM has to probe via Phase D's error envelope to learn that
      // `intervalHours` caps at 23 (not 24) and `onMissingDay` is the
      // non-obvious `"skip" | "lastDayOfMonth"` enum.
      recurrence: RECURRENCE,
      timeFormat: "HH:MM (24h)",
      timezoneExample: "Asia/Tokyo",
      defaults: { timezone: defaultTimezone },
    });
  });

  return app;
}
