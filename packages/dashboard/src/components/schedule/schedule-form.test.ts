import { describe, expect, it } from "vitest";
import {
  EMPTY_FORM_STATE,
  HOURLY_INTERVAL_MAX,
  HOURLY_INTERVAL_MIN,
  MINUTE_OF_HOUR_MAX,
  MINUTE_OF_HOUR_MIN,
  monthlyHasOverflowDay,
  toSubmitPayload,
  validateScheduleForm,
  type ScheduleFormState,
} from "./schedule-form";
import { dtoToFormState } from "./scheduled-dms-table";
import type { RecurringScheduleDTO } from "@/lib/api-types";

const baseValidPrompt =
  "Run a quick check on overnight mail and surface anything urgent.";

describe("validateScheduleForm", () => {
  it("requires a prompt for a one-off task (description is just an optional label)", () => {
    const result = validateScheduleForm({
      ...EMPTY_FORM_STATE,
      frequency: "once",
      oneOffDateTime: "2099-01-01T09:00",
      description: "short label",
      prompt: "",
    });
    expect(result?.prompt).toBeDefined();
    // A short label is fine — there is no lower bound on the one-off description.
    expect(result?.description).toBeUndefined();
  });

  it("accepts a one-off with a prompt and no description", () => {
    const result = validateScheduleForm({
      ...EMPTY_FORM_STATE,
      frequency: "once",
      oneOffDateTime: "2099-01-01T09:00",
      description: "",
      prompt: baseValidPrompt,
    });
    expect(result).toBeNull();
  });

  it("rejects a one-off in the past", () => {
    const result = validateScheduleForm({
      ...EMPTY_FORM_STATE,
      frequency: "once",
      oneOffDateTime: "2000-01-01T09:00",
      prompt: baseValidPrompt,
    });
    expect(result?.oneOffDateTime).toBeDefined();
  });

  it("rejects weekly with no daysOfWeek", () => {
    const result = validateScheduleForm({
      ...EMPTY_FORM_STATE,
      frequency: "weekly",
      recurringTime: "09:00",
      daysOfWeek: [],
      description: baseValidPrompt,
    });
    expect(result?.daysOfWeek).toBeDefined();
  });

  it("rejects monthly with no daysOfMonth", () => {
    const result = validateScheduleForm({
      ...EMPTY_FORM_STATE,
      frequency: "monthly",
      recurringTime: "09:00",
      daysOfMonth: [],
      description: baseValidPrompt,
    });
    expect(result?.daysOfMonth).toBeDefined();
  });

  it("accepts a fully-formed weekly schedule", () => {
    const result = validateScheduleForm({
      ...EMPTY_FORM_STATE,
      frequency: "weekly",
      recurringTime: "09:00",
      daysOfWeek: [1, 3, 5],
      description: baseValidPrompt,
    });
    expect(result).toBeNull();
  });

  it("rejects malformed time", () => {
    const result = validateScheduleForm({
      ...EMPTY_FORM_STATE,
      frequency: "daily",
      recurringTime: "not-a-time",
      description: baseValidPrompt,
    });
    expect(result?.recurringTime).toBeDefined();
  });

  it("accepts an empty prompt override (description doubles as the body)", () => {
    const result = validateScheduleForm({
      ...EMPTY_FORM_STATE,
      frequency: "daily",
      recurringTime: "09:00",
      description: baseValidPrompt,
      prompt: "",
    });
    expect(result).toBeNull();
  });

  it("rejects a non-empty prompt override that is too short", () => {
    const result = validateScheduleForm({
      ...EMPTY_FORM_STATE,
      frequency: "daily",
      recurringTime: "09:00",
      description: baseValidPrompt,
      prompt: "too short",
    });
    expect(result?.prompt).toBeDefined();
  });

  it("accepts a prompt override at or above 20 chars", () => {
    const result = validateScheduleForm({
      ...EMPTY_FORM_STATE,
      frequency: "daily",
      recurringTime: "09:00",
      description: baseValidPrompt,
      prompt: "Detailed agent instruction body here",
    });
    expect(result).toBeNull();
  });

  // ── Hourly ────────────────────────────────────────────────────────────────

  it("accepts the default hourly state (every 1 hour at :00)", () => {
    const result = validateScheduleForm({
      ...EMPTY_FORM_STATE,
      frequency: "hourly",
      description: baseValidPrompt,
    });
    expect(result).toBeNull();
  });

  it("rejects hourly with intervalHours below the minimum", () => {
    const result = validateScheduleForm({
      ...EMPTY_FORM_STATE,
      frequency: "hourly",
      intervalHours: HOURLY_INTERVAL_MIN - 1,
      description: baseValidPrompt,
    });
    expect(result?.intervalHours).toBeDefined();
  });

  it("rejects hourly with intervalHours above the maximum (caps at 23, not 24)", () => {
    // Mirrors `recurrenceRuleSchema` — every-24h would conflict with the
    // daily path, so 23 is the documented hard ceiling (see §4.2 anchor
    // semantics: every `(localHour % N) == 0`).
    const result = validateScheduleForm({
      ...EMPTY_FORM_STATE,
      frequency: "hourly",
      intervalHours: HOURLY_INTERVAL_MAX + 1,
      description: baseValidPrompt,
    });
    expect(result?.intervalHours).toBeDefined();
  });

  it("rejects hourly with minuteOfHour out of range", () => {
    const result = validateScheduleForm({
      ...EMPTY_FORM_STATE,
      frequency: "hourly",
      minuteOfHour: MINUTE_OF_HOUR_MAX + 1,
      description: baseValidPrompt,
    });
    expect(result?.minuteOfHour).toBeDefined();
  });

  it("rejects hourly with non-integer interval", () => {
    const result = validateScheduleForm({
      ...EMPTY_FORM_STATE,
      frequency: "hourly",
      intervalHours: 2.5,
      description: baseValidPrompt,
    });
    expect(result?.intervalHours).toBeDefined();
  });
});

describe("toSubmitPayload", () => {
  it("emits the one-off shape with no model when 'default' is selected", () => {
    const state: ScheduleFormState = {
      ...EMPTY_FORM_STATE,
      frequency: "once",
      // Pick a fixed timestamp so the test is deterministic regardless of
      // when it runs — toSubmitPayload doesn't validate, it just shapes.
      oneOffDateTime: "2099-12-31T23:59",
      description: baseValidPrompt,
      model: "",
    };
    const payload = toSubmitPayload(state);
    expect(payload.kind).toBe("once");
    if (payload.kind !== "once") throw new Error("unreachable");
    expect(payload.body.taskType).toBe("custom");
    expect(payload.body.description).toBe(baseValidPrompt);
    // `model` is intentionally absent so the daemon falls back to the
    // process_backend_config default for `agent.task` (NULL in the DB
    // column, no `requestedModel` on the dispatched event).
    expect(payload.body).not.toHaveProperty("model");
    expect(payload.body.taskContext).toEqual({ source: "dashboard_manual" });
    // Time is normalized to ISO-8601 UTC so the daemon's
    // formatSqliteDatetime can lex-compare it inside the watcher.
    expect(payload.body.time).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it("emits the one-off shape WITH a pinned alias when 'opus' is selected", () => {
    const payload = toSubmitPayload({
      ...EMPTY_FORM_STATE,
      frequency: "once",
      oneOffDateTime: "2099-12-31T23:59",
      description: baseValidPrompt,
      model: "opus",
    });
    if (payload.kind !== "once") throw new Error("unreachable");
    expect(payload.body.model).toBe("opus");
  });

  it("threads a registered model id through verbatim", () => {
    // Per SCHEDULE_API_REDESIGN_PLAN.md §4.3 the schemas now accept any
    // registered id — the dashboard sends it free-form and the daemon's
    // `validateModelToken` resolves it to (backend, model). The form
    // therefore must not coerce the string in any way.
    const payload = toSubmitPayload({
      ...EMPTY_FORM_STATE,
      frequency: "once",
      oneOffDateTime: "2099-12-31T23:59",
      description: baseValidPrompt,
      model: "claude-opus-4-7",
    });
    if (payload.kind !== "once") throw new Error("unreachable");
    expect(payload.body.model).toBe("claude-opus-4-7");
  });

  it("emits the recurring weekly shape with daysOfWeek sorted", () => {
    const payload = toSubmitPayload({
      ...EMPTY_FORM_STATE,
      frequency: "weekly",
      recurringTime: "07:30",
      daysOfWeek: [5, 1, 3], // intentionally unsorted
      description: baseValidPrompt,
      model: "sonnet",
    });
    expect(payload.kind).toBe("recurring");
    if (payload.kind !== "recurring") throw new Error("unreachable");
    expect(payload.body.recurrenceRule.frequency).toBe("weekly");
    expect(payload.body.recurrenceRule.time).toBe("07:30");
    expect(payload.body.recurrenceRule.daysOfWeek).toEqual([1, 3, 5]);
    // daysOfMonth must NOT be present on a weekly rule — the daemon's
    // recurrenceRuleSchema rejects the cross-axis combo.
    expect(payload.body.recurrenceRule.daysOfMonth).toBeUndefined();
    expect(payload.body.model).toBe("sonnet");
  });

  it("emits the recurring monthly shape with daysOfMonth sorted, daysOfWeek absent", () => {
    const payload = toSubmitPayload({
      ...EMPTY_FORM_STATE,
      frequency: "monthly",
      recurringTime: "12:00",
      daysOfMonth: [15, 1, 31],
      description: baseValidPrompt,
    });
    if (payload.kind !== "recurring") throw new Error("unreachable");
    expect(payload.body.recurrenceRule.daysOfMonth).toEqual([1, 15, 31]);
    expect(payload.body.recurrenceRule.daysOfWeek).toBeUndefined();
  });

  it("threads onMissingDay through monthly rules when set", () => {
    const payload = toSubmitPayload({
      ...EMPTY_FORM_STATE,
      frequency: "monthly",
      recurringTime: "21:00",
      daysOfMonth: [31],
      onMissingDay: "skip",
      description: baseValidPrompt,
    });
    if (payload.kind !== "recurring") throw new Error("unreachable");
    expect(payload.body.recurrenceRule.onMissingDay).toBe("skip");
  });

  it("strips a stale onMissingDay value when daysOfMonth no longer contains 29/30/31", () => {
    // Hide-but-don't-clear bug: when a user picked `skip` for
    // daysOfMonth=[31], then removed day 31, the
    // select hid but state retained `skip`. Sending that wire value
    // emits a §5.0.5 `on_missing_day_unused` warning that the user can no
    // longer reach from the form. The build step strips the field at
    // submit time so the wire payload matches what the (now-hidden) UI
    // reflects.
    const payload = toSubmitPayload({
      ...EMPTY_FORM_STATE,
      frequency: "monthly",
      recurringTime: "21:00",
      daysOfMonth: [1, 15],
      onMissingDay: "skip",
      description: baseValidPrompt,
    });
    if (payload.kind !== "recurring") throw new Error("unreachable");
    expect(payload.body.recurrenceRule.onMissingDay).toBeUndefined();
  });

  it("preserves onMissingDay when at least one daysOfMonth value is 29+", () => {
    // Mirror of the above — confirms the guard only strips when the
    // field is truly a no-op. daysOfMonth=[15,30] still carries the
    // policy through because day 30 is missing in Feb.
    const payload = toSubmitPayload({
      ...EMPTY_FORM_STATE,
      frequency: "monthly",
      recurringTime: "21:00",
      daysOfMonth: [15, 30],
      onMissingDay: "skip",
      description: baseValidPrompt,
    });
    if (payload.kind !== "recurring") throw new Error("unreachable");
    expect(payload.body.recurrenceRule.onMissingDay).toBe("skip");
  });

  it("omits onMissingDay when blank so the daemon applies its default", () => {
    // The wire absence is meaningful: per §4.2.5 the daemon defaults to
    // `lastDayOfMonth`, preserving bit-identical behavior with the
    // pre-redesign clamp. Sending the literal "lastDayOfMonth" from the
    // dashboard would be redundant noise.
    const payload = toSubmitPayload({
      ...EMPTY_FORM_STATE,
      frequency: "monthly",
      recurringTime: "21:00",
      daysOfMonth: [31],
      onMissingDay: "",
      description: baseValidPrompt,
    });
    if (payload.kind !== "recurring") throw new Error("unreachable");
    expect(payload.body.recurrenceRule.onMissingDay).toBeUndefined();
  });

  it("daily recurring carries no day arrays", () => {
    const payload = toSubmitPayload({
      ...EMPTY_FORM_STATE,
      frequency: "daily",
      recurringTime: "06:00",
      description: baseValidPrompt,
    });
    if (payload.kind !== "recurring") throw new Error("unreachable");
    expect(payload.body.recurrenceRule.daysOfWeek).toBeUndefined();
    expect(payload.body.recurrenceRule.daysOfMonth).toBeUndefined();
  });

  it("emits the hourly recurrence rule with default fields stripped", () => {
    // intervalHours=1, minuteOfHour=0 are the schema defaults — the wire
    // payload omits them to keep the JSON minimal and to surface the
    // intent ("every hour at :00") without ceremony.
    const payload = toSubmitPayload({
      ...EMPTY_FORM_STATE,
      frequency: "hourly",
      intervalHours: 1,
      minuteOfHour: 0,
      description: baseValidPrompt,
    });
    if (payload.kind !== "recurring") throw new Error("unreachable");
    expect(payload.body.recurrenceRule.frequency).toBe("hourly");
    expect(payload.body.recurrenceRule.intervalHours).toBeUndefined();
    expect(payload.body.recurrenceRule.minuteOfHour).toBeUndefined();
    // time MUST be absent on hourly — recurrenceRuleSchema's superRefine
    // forbids it.
    expect(payload.body.recurrenceRule.time).toBeUndefined();
  });

  it("emits the hourly recurrence rule with non-default interval and minute", () => {
    const payload = toSubmitPayload({
      ...EMPTY_FORM_STATE,
      frequency: "hourly",
      intervalHours: 2,
      minuteOfHour: 30,
      description: baseValidPrompt,
    });
    if (payload.kind !== "recurring") throw new Error("unreachable");
    expect(payload.body.recurrenceRule.frequency).toBe("hourly");
    expect(payload.body.recurrenceRule.intervalHours).toBe(2);
    expect(payload.body.recurrenceRule.minuteOfHour).toBe(30);
  });

  it("trims whitespace off the description", () => {
    const payload = toSubmitPayload({
      ...EMPTY_FORM_STATE,
      frequency: "daily",
      recurringTime: "06:00",
      description: `   ${baseValidPrompt}   `,
    });
    if (payload.kind !== "recurring") throw new Error("unreachable");
    expect(payload.body.description).toBe(baseValidPrompt);
  });

  it("one-off always sends prompt (the body) and omits description when empty", () => {
    const payload = toSubmitPayload({
      ...EMPTY_FORM_STATE,
      frequency: "once",
      oneOffDateTime: "2099-12-31T23:59",
      description: "",
      prompt: baseValidPrompt,
    });
    if (payload.kind !== "once") throw new Error("unreachable");
    expect(payload.body.prompt).toBe(baseValidPrompt);
    expect(payload.body).not.toHaveProperty("description");
  });

  it("one-off sends a trimmed prompt and a trimmed description label", () => {
    const promptBody = "Detailed agent instruction body here";
    const payload = toSubmitPayload({
      ...EMPTY_FORM_STATE,
      frequency: "once",
      oneOffDateTime: "2099-12-31T23:59",
      description: "   PR review label   ",
      prompt: `   ${promptBody}   `,
    });
    if (payload.kind !== "once") throw new Error("unreachable");
    expect(payload.body.prompt).toBe(promptBody);
    expect(payload.body.description).toBe("PR review label");
  });

  it("threads the prompt override through the recurring shape too", () => {
    const overrideBody = "Detailed agent instruction body here";
    const payload = toSubmitPayload({
      ...EMPTY_FORM_STATE,
      frequency: "daily",
      recurringTime: "06:00",
      description: baseValidPrompt,
      prompt: overrideBody,
    });
    if (payload.kind !== "recurring") throw new Error("unreachable");
    expect(payload.body.prompt).toBe(overrideBody);
  });

  it("trims whitespace off the model token before sending", () => {
    const payload = toSubmitPayload({
      ...EMPTY_FORM_STATE,
      frequency: "once",
      oneOffDateTime: "2099-12-31T23:59",
      description: baseValidPrompt,
      model: "  claude-opus-4-7  ",
    });
    if (payload.kind !== "once") throw new Error("unreachable");
    expect(payload.body.model).toBe("claude-opus-4-7");
  });
});

describe("monthlyHasOverflowDay", () => {
  // `onMissingDay` is meaningful only when daysOfMonth contains 29/30/31;
  // the form surfaces the dropdown via this helper. Non-monthly frequencies
  // and short-day sets must both return false.
  const cases: Array<{
    description: string;
    state: Partial<ScheduleFormState>;
    expected: boolean;
  }> = [
    { description: "monthly w/ 31 → true", state: { frequency: "monthly", daysOfMonth: [1, 31] }, expected: true },
    { description: "monthly w/ 30 → true", state: { frequency: "monthly", daysOfMonth: [30] }, expected: true },
    { description: "monthly w/ 29 → true", state: { frequency: "monthly", daysOfMonth: [29] }, expected: true },
    { description: "monthly w/ 28 only → false", state: { frequency: "monthly", daysOfMonth: [1, 28] }, expected: false },
    { description: "weekly → false", state: { frequency: "weekly", daysOfMonth: [31] }, expected: false },
    { description: "hourly → false", state: { frequency: "hourly", daysOfMonth: [31] }, expected: false },
  ];
  it.each(cases)("$description", ({ state, expected }) => {
    expect(monthlyHasOverflowDay({ ...EMPTY_FORM_STATE, ...state })).toBe(expected);
  });
});

describe("dtoToFormState (Scheduled DMs edit form)", () => {
  // The Scheduled DMs edit sheet seeds its form from a recurring dm_session DTO.
  // The morning briefing is daily; the round-trip must preserve the cadence so
  // an edit that only changes the time doesn't silently drop the rule shape.
  function dmDto(over: Partial<RecurringScheduleDTO> = {}): RecurringScheduleDTO {
    return {
      id: 1,
      taskType: "dm_session",
      description: "Morning briefing — daily summary delivered as a DM at 07:00.",
      prompt: null,
      recurrenceRule: { frequency: "daily", time: "07:00" },
      model: null,
      enabled: true,
      nextRunAt: "2026-06-02T22:00:00Z",
      recurrenceLabel: "Daily at 07:00",
      taskContext: { sub_flow: "morning_briefing", pin_to_quiet_hours_end: true },
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
      ...over,
    };
  }

  it("maps a daily dm_session row to a cron form state", () => {
    const state = dtoToFormState(dmDto());
    expect(state.frequency).toBe("daily");
    expect(state.recurringTime).toBe("07:00");
    expect(state.model).toBe("");
  });

  it("round-trips through toSubmitPayload preserving the daily rule", () => {
    const payload = toSubmitPayload(dtoToFormState(dmDto()));
    if (payload.kind !== "recurring") throw new Error("expected recurring");
    expect(payload.body.recurrenceRule).toEqual({ frequency: "daily", time: "07:00" });
  });
});
