"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { RecurrenceRule } from "@/lib/api-types";
import { ModelPicker } from "./model-picker";
import { cn } from "@/lib/utils";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

/** Per SCHEDULE_API_REDESIGN_PLAN.md §4.1, the recurring set is
 *  {hourly, daily, weekly, monthly}; the form adds "once" as a
 *  client-only sentinel for one-off `POST /api/schedule` rows. */
export type ScheduleFrequency = "once" | "hourly" | "daily" | "weekly" | "monthly";

/** Bounds — mirror `recurrenceRuleSchema` and `/schedule/options.recurrence`. */
export const HOURLY_INTERVAL_MIN = 1;
export const HOURLY_INTERVAL_MAX = 23;
export const MINUTE_OF_HOUR_MIN = 0;
export const MINUTE_OF_HOUR_MAX = 59;

/** Sentinel value for the onMissingDay select's "leave default" choice. */
export type OnMissingDayChoice = "" | "skip" | "lastDayOfMonth";

export interface ScheduleFormState {
  frequency: ScheduleFrequency;
  /** ISO local datetime — only used when frequency === "once". */
  oneOffDateTime: string;
  /** HH:MM — used for daily/weekly/monthly. Ignored when frequency === "hourly". */
  recurringTime: string;
  /** Hourly only — `1..23`. Defaults to 1. */
  intervalHours: number;
  /** Hourly only — `0..59`. Defaults to 0. */
  minuteOfHour: number;
  daysOfWeek: number[];
  daysOfMonth: number[];
  /**
   * Monthly only. Empty string = "let the daemon default to lastDayOfMonth"
   * (preserves bit-identical behavior for rules that don't carry 29/30/31).
   * Setting it explicitly is required when the user wants `"skip"`.
   */
  onMissingDay: OnMissingDayChoice;
  /**
   * Free-form model token (per §4.3 — legacy alias `sonnet`/`opus`, a
   * registered ID, or a `<backend>/<model>` composite). Empty string =
   * use the process_backend_config default at the dispatcher. The server
   * validates and surfaces `schedule.model_unknown` on a bad token.
   */
  model: string;
  description: string;
  /** Optional prompt override. When empty, description doubles as the agent
   *  body — preserving the long-standing schedule semantics. When set, the
   *  daemon stores it in agent_schedule.task_prompt and the dispatcher uses
   *  it as the `task` slot in the task-flow template. */
  prompt: string;
}

export const EMPTY_FORM_STATE: ScheduleFormState = {
  frequency: "once",
  oneOffDateTime: "",
  recurringTime: "09:00",
  intervalHours: 1,
  minuteOfHour: 0,
  daysOfWeek: [],
  daysOfMonth: [],
  onMissingDay: "",
  model: "",
  description: "",
  prompt: "",
};

export interface ScheduleFormProps {
  state: ScheduleFormState;
  onChange: (next: ScheduleFormState) => void;
  /** Disable the frequency selector when editing — the daemon does not
   *  support converting one-off ↔ recurring in place. */
  lockFrequency?: boolean;
  /** Hide the frequency selector entirely (e.g. recurring-only edit form). */
  hideFrequency?: boolean;
  /** Show validation hints; called by parent before submit. */
  errors?: ScheduleFormErrors | null;
  /** Optional: called when the user edits any field, so the parent can clear
   *  stale validation errors before they retry submit. */
  onEdit?: () => void;
}

export interface ScheduleFormErrors {
  oneOffDateTime?: string;
  recurringTime?: string;
  intervalHours?: string;
  minuteOfHour?: string;
  daysOfWeek?: string;
  daysOfMonth?: string;
  onMissingDay?: string;
  description?: string;
  prompt?: string;
}

function isHourlyValid(state: ScheduleFormState): ScheduleFormErrors {
  const errs: ScheduleFormErrors = {};
  if (
    !Number.isInteger(state.intervalHours) ||
    state.intervalHours < HOURLY_INTERVAL_MIN ||
    state.intervalHours > HOURLY_INTERVAL_MAX
  ) {
    errs.intervalHours = `Interval must be an integer between ${HOURLY_INTERVAL_MIN} and ${HOURLY_INTERVAL_MAX}.`;
  }
  if (
    !Number.isInteger(state.minuteOfHour) ||
    state.minuteOfHour < MINUTE_OF_HOUR_MIN ||
    state.minuteOfHour > MINUTE_OF_HOUR_MAX
  ) {
    errs.minuteOfHour = `Minute must be an integer between ${MINUTE_OF_HOUR_MIN} and ${MINUTE_OF_HOUR_MAX}.`;
  }
  return errs;
}

/** Pure validator. Returns null when valid, an errors object otherwise. */
export function validateScheduleForm(
  state: ScheduleFormState,
): ScheduleFormErrors | null {
  const errs: ScheduleFormErrors = {};
  if (state.description.trim().length < 20) {
    errs.description =
      "Description must be at least 20 characters — when no prompt override is set, this text is the agent's only context.";
  }
  // Prompt is optional. Daemon enforces ≥20 chars when set; mirror that here
  // so the user gets feedback before submit.
  if (state.prompt.trim().length > 0 && state.prompt.trim().length < 20) {
    errs.prompt =
      "Prompt override must be at least 20 characters, or leave empty to use the description as the agent body.";
  }
  if (state.frequency === "once") {
    if (!state.oneOffDateTime) {
      errs.oneOffDateTime = "Required.";
    } else {
      const t = new Date(state.oneOffDateTime).getTime();
      if (Number.isNaN(t)) errs.oneOffDateTime = "Invalid date/time.";
      else if (t < Date.now() - 60_000)
        errs.oneOffDateTime = "Must be at least a minute in the future.";
    }
  } else if (state.frequency === "hourly") {
    Object.assign(errs, isHourlyValid(state));
  } else {
    if (!/^\d{2}:\d{2}$/.test(state.recurringTime)) {
      errs.recurringTime = "Time must be HH:MM.";
    }
    if (state.frequency === "weekly" && state.daysOfWeek.length === 0) {
      errs.daysOfWeek = "Select at least one weekday.";
    }
    if (state.frequency === "monthly" && state.daysOfMonth.length === 0) {
      errs.daysOfMonth = "Select at least one day of the month.";
    }
  }
  return Object.keys(errs).length === 0 ? null : errs;
}

/**
 * Build the recurrence-rule fragment for a non-once schedule. Pure —
 * extracted so both submit and label-preview helpers can reuse it.
 */
function buildRecurrenceRule(state: ScheduleFormState): RecurrenceRule {
  if (state.frequency === "hourly") {
    return {
      frequency: "hourly",
      ...(state.intervalHours !== 1 ? { intervalHours: state.intervalHours } : {}),
      ...(state.minuteOfHour !== 0 ? { minuteOfHour: state.minuteOfHour } : {}),
    };
  }
  if (state.frequency === "weekly") {
    return {
      frequency: "weekly",
      time: state.recurringTime,
      daysOfWeek: [...state.daysOfWeek].sort((a, b) => a - b),
    };
  }
  if (state.frequency === "monthly") {
    const sortedDays = [...state.daysOfMonth].sort((a, b) => a - b);
    // onMissingDay only matters when daysOfMonth contains 29/30/31. Strip
    // any stale value (left in form state after the user removed an
    // overflow day) so the daemon doesn't surface a noop-warning the user
    // can no longer act on from the form (the select control is hidden
    // once `showMissingDaySelect` is false — see `monthlyHasOverflowDay`).
    const hasOverflowDay = sortedDays.some((d) => d >= 29);
    return {
      frequency: "monthly",
      time: state.recurringTime,
      daysOfMonth: sortedDays,
      ...(hasOverflowDay && state.onMissingDay !== ""
        ? { onMissingDay: state.onMissingDay }
        : {}),
    };
  }
  // daily
  return { frequency: "daily", time: state.recurringTime };
}

/**
 * Returns the model fragment to splice into the submit payload. The
 * picker emits a single free-form string covering aliases, registered
 * IDs, and composites — the server's `validateModelToken` (Phase B)
 * disambiguates. Empty string = no override.
 */
function modelFragment(state: ScheduleFormState): { model?: string } {
  const trimmed = state.model.trim();
  if (trimmed.length === 0) return {};
  return { model: trimmed };
}

/** Build the API payload pieces from form state. Caller decides which endpoint to hit. */
export function toSubmitPayload(state: ScheduleFormState): {
  kind: "once";
  body: {
    time: string;
    taskType: string;
    description: string;
    prompt?: string;
    model?: string;
    taskContext?: Record<string, unknown>;
  };
} | {
  kind: "recurring";
  body: {
    taskType: string;
    description: string;
    prompt?: string;
    recurrenceRule: RecurrenceRule;
    model?: string;
    taskContext?: Record<string, unknown>;
  };
} {
  const description = state.description.trim();
  const promptTrimmed = state.prompt.trim();
  const promptOverride = promptTrimmed.length > 0 ? promptTrimmed : undefined;
  const taskType = "custom";
  const modelOverride = modelFragment(state);
  if (state.frequency === "once") {
    return {
      kind: "once",
      body: {
        time: new Date(state.oneOffDateTime).toISOString(),
        taskType,
        description,
        ...(promptOverride ? { prompt: promptOverride } : {}),
        ...modelOverride,
        taskContext: { source: "dashboard_manual" },
      },
    };
  }
  return {
    kind: "recurring",
    body: {
      taskType,
      description,
      ...(promptOverride ? { prompt: promptOverride } : {}),
      recurrenceRule: buildRecurrenceRule(state),
      ...modelOverride,
      taskContext: { source: "dashboard_manual" },
    },
  };
}

/** True when the monthly form's daysOfMonth includes a day that may fall
 *  outside short months — drives the onMissingDay select's visibility. */
export function monthlyHasOverflowDay(state: ScheduleFormState): boolean {
  return state.frequency === "monthly" && state.daysOfMonth.some((d) => d >= 29);
}

export function ScheduleForm({
  state,
  onChange,
  lockFrequency,
  hideFrequency,
  errors,
  onEdit,
}: ScheduleFormProps) {
  const set = <K extends keyof ScheduleFormState>(key: K, value: ScheduleFormState[K]) => {
    onChange({ ...state, [key]: value });
    onEdit?.();
  };

  // datetime-local needs `YYYY-MM-DDTHH:MM` in the user's local timezone.
  // useState's lazy initializer is the recommended escape hatch when the
  // initial value comes from an impure source like Date.now() — see
  // https://react.dev/reference/react/useState#avoiding-recreating-the-initial-state.
  const [oneOffMin] = useState(() => {
    const d = new Date(Date.now() + 60_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });

  const showMissingDaySelect = monthlyHasOverflowDay(state);

  return (
    <div className="space-y-4">
      {!hideFrequency ? (
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Frequency
          </label>
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Frequency">
            {(["once", "hourly", "daily", "weekly", "monthly"] as const).map((f) => (
              <Button
                key={f}
                type="button"
                size="sm"
                variant={state.frequency === f ? "default" : "outline"}
                disabled={lockFrequency}
                onClick={() => set("frequency", f)}
                aria-pressed={state.frequency === f}
              >
                {f === "once" ? "One-off" : f.charAt(0).toUpperCase() + f.slice(1)}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {state.frequency === "once" ? (
        <div>
          <label
            className="mb-1 block text-xs font-medium text-muted-foreground"
            htmlFor="schedule-one-off-time"
          >
            When
          </label>
          <Input
            id="schedule-one-off-time"
            type="datetime-local"
            value={state.oneOffDateTime}
            min={oneOffMin}
            onChange={(e) => set("oneOffDateTime", e.target.value)}
            className="h-9"
          />
          {errors?.oneOffDateTime ? (
            <p className="mt-1 text-xs text-red-600">{errors.oneOffDateTime}</p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              Local time. The daemon stores it as UTC.
            </p>
          )}
        </div>
      ) : state.frequency === "hourly" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label
              className="mb-1 block text-xs font-medium text-muted-foreground"
              htmlFor="schedule-interval-hours"
            >
              Every N hours
            </label>
            <Input
              id="schedule-interval-hours"
              type="number"
              inputMode="numeric"
              min={HOURLY_INTERVAL_MIN}
              max={HOURLY_INTERVAL_MAX}
              value={state.intervalHours}
              onChange={(e) =>
                set("intervalHours", Number.parseInt(e.target.value, 10) || HOURLY_INTERVAL_MIN)
              }
              className="h-9 w-32"
            />
            {errors?.intervalHours ? (
              <p className="mt-1 text-xs text-red-600">{errors.intervalHours}</p>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                1–23. Anchored at midnight local time, so &ldquo;every 2 hours&rdquo; fires at 00, 02, 04, …
              </p>
            )}
          </div>
          <div>
            <label
              className="mb-1 block text-xs font-medium text-muted-foreground"
              htmlFor="schedule-minute-of-hour"
            >
              At minute
            </label>
            <Input
              id="schedule-minute-of-hour"
              type="number"
              inputMode="numeric"
              min={MINUTE_OF_HOUR_MIN}
              max={MINUTE_OF_HOUR_MAX}
              value={state.minuteOfHour}
              onChange={(e) =>
                set(
                  "minuteOfHour",
                  Number.parseInt(e.target.value, 10) || MINUTE_OF_HOUR_MIN,
                )
              }
              className="h-9 w-32"
            />
            {errors?.minuteOfHour ? (
              <p className="mt-1 text-xs text-red-600">{errors.minuteOfHour}</p>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">0–59. e.g. set to 30 for HH:30.</p>
            )}
          </div>
        </div>
      ) : (
        <div>
          <label
            className="mb-1 block text-xs font-medium text-muted-foreground"
            htmlFor="schedule-recurring-time"
          >
            Time of day
          </label>
          <Input
            id="schedule-recurring-time"
            type="time"
            value={state.recurringTime}
            onChange={(e) => set("recurringTime", e.target.value)}
            className="h-9 w-32"
          />
          {errors?.recurringTime ? (
            <p className="mt-1 text-xs text-red-600">{errors.recurringTime}</p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              Interpreted in the daemon&rsquo;s configured timezone.
            </p>
          )}
        </div>
      )}

      {state.frequency === "weekly" ? (
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Days of week
          </label>
          <div className="flex flex-wrap gap-1">
            {WEEKDAY_LABELS.map((label, idx) => {
              const active = state.daysOfWeek.includes(idx);
              return (
                <Button
                  key={label}
                  type="button"
                  size="sm"
                  variant={active ? "default" : "outline"}
                  onClick={() =>
                    set(
                      "daysOfWeek",
                      active
                        ? state.daysOfWeek.filter((d) => d !== idx)
                        : [...state.daysOfWeek, idx],
                    )
                  }
                  aria-pressed={active}
                >
                  {label}
                </Button>
              );
            })}
          </div>
          {errors?.daysOfWeek ? (
            <p className="mt-1 text-xs text-red-600">{errors.daysOfWeek}</p>
          ) : null}
        </div>
      ) : null}

      {state.frequency === "monthly" ? (
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Days of month
          </label>
          <div className="grid grid-cols-7 gap-1 sm:grid-cols-10">
            {MONTH_DAYS.map((day) => {
              const active = state.daysOfMonth.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() =>
                    set(
                      "daysOfMonth",
                      active
                        ? state.daysOfMonth.filter((d) => d !== day)
                        : [...state.daysOfMonth, day],
                    )
                  }
                  aria-pressed={active}
                  className={cn(
                    "h-7 rounded-md border text-xs tabular-nums transition-colors",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input bg-background hover:bg-muted",
                  )}
                >
                  {day}
                </button>
              );
            })}
          </div>
          {errors?.daysOfMonth ? (
            <p className="mt-1 text-xs text-red-600">{errors.daysOfMonth}</p>
          ) : null}
        </div>
      ) : null}

      {/* onMissingDay only meaningful for monthly rules that contain 29/30/31. */}
      {showMissingDaySelect ? (
        <div>
          <label
            className="mb-1 block text-xs font-medium text-muted-foreground"
            htmlFor="schedule-on-missing-day"
          >
            When month is too short (e.g. Feb 30, Apr 31)
          </label>
          <select
            id="schedule-on-missing-day"
            value={state.onMissingDay}
            onChange={(e) =>
              set("onMissingDay", e.target.value as OnMissingDayChoice)
            }
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-72"
          >
            {/* "Default" omits the field on the wire — daemon resolves to
                `lastDayOfMonth` per SCHEDULE_API_REDESIGN_PLAN §12.6 and
                preserves bit-identical behavior with the pre-redesign
                clamp. The explicit `lastDayOfMonth` value is intentionally
                NOT a separate option since it produces an identical fire
                cadence; only "skip" diverges. */}
            <option value="">Default (fall back to last day of month)</option>
            <option value="skip">Skip the month entirely</option>
          </select>
          <p className="mt-1 text-xs text-muted-foreground">
            Controls behavior when <code>daysOfMonth</code> contains 29-31 and the
            month is shorter. Default preserves bit-identical behavior with the
            pre-redesign clamp.
          </p>
        </div>
      ) : null}

      <div>
        <label
          className="mb-1 block text-xs font-medium text-muted-foreground"
          htmlFor="schedule-model"
        >
          Model
        </label>
        <ModelPicker
          id="schedule-model"
          value={state.model}
          onChange={(next) => set("model", next)}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          &ldquo;Default&rdquo; lets the dispatcher pick using the
          <code className="mx-1">scheduled.task</code>process binding. Aliases
          (<code>sonnet</code>, <code>opus</code>) rewrite to the matching tier
          server-side; registered IDs pin the row to that specific
          <code className="mx-1">(backend, model)</code>.
        </p>
      </div>

      <div>
        <label
          className="mb-1 block text-xs font-medium text-muted-foreground"
          htmlFor="schedule-description"
        >
          Description
        </label>
        <textarea
          id="schedule-description"
          value={state.description}
          onChange={(e) => set("description", e.target.value)}
          rows={4}
          className="w-full rounded-md border border-input bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder={
            "Short summary shown in the schedule list. When no prompt override is set, this is also what the agent reads."
          }
        />
        {errors?.description ? (
          <p className="mt-1 text-xs text-red-600">{errors.description}</p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            {state.description.trim().length} / 20 characters minimum.
          </p>
        )}
      </div>

      <div>
        <label
          className="mb-1 block text-xs font-medium text-muted-foreground"
          htmlFor="schedule-prompt"
        >
          Prompt <span className="text-muted-foreground/70">(optional override)</span>
        </label>
        <textarea
          id="schedule-prompt"
          value={state.prompt}
          onChange={(e) => set("prompt", e.target.value)}
          rows={6}
          className="w-full rounded-md border border-input bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder={
            "Leave empty to use the description above as the agent body. Fill in to give the agent a fuller, separate instruction."
          }
        />
        {errors?.prompt ? (
          <p className="mt-1 text-xs text-red-600">{errors.prompt}</p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            {state.prompt.trim().length === 0
              ? "Empty — description will be used as the agent body."
              : `${state.prompt.trim().length} / 20 characters minimum (when set).`}
          </p>
        )}
      </div>
    </div>
  );
}
