import { describe, it, expect } from "vitest";
import {
  contextPutSchema,
  contextPatchSchema,
  notifyRequestSchema,
  scheduleRequestSchema,
  scheduleUpdateRequestSchema,
  scheduleDmRequestSchema,
  skillNameSchema,
  skillCreateSchema,
  skillUpdateSchema,
  calendarCreateEventSchema,
  calendarUpdateEventSchema,
  calendarFreeBusySchema,
  actionLogRequestSchema,
  recurrenceRuleSchema,
  recurringScheduleCreateSchema,
  recurringScheduleUpdateSchema,
  triggerCreateSchema,
  triggerUpdateSchema,
} from "./schemas.js";

describe("contextPutSchema", () => {
  it("accepts content with optional expectedMtime", () => {
    expect(contextPutSchema.safeParse({ content: "hello" }).success).toBe(true);
    expect(contextPutSchema.safeParse({ content: "hello", expectedMtime: "123" }).success).toBe(true);
  });

  it("rejects missing content", () => {
    expect(contextPutSchema.safeParse({}).success).toBe(false);
  });
});

describe("contextPatchSchema", () => {
  it("accepts valid modes", () => {
    expect(contextPatchSchema.safeParse({ section: "## Log", mode: "append", content: "entry" }).success).toBe(true);
    expect(contextPatchSchema.safeParse({ section: "## Log", mode: "replace", content: "new" }).success).toBe(true);
    expect(contextPatchSchema.safeParse({ section: "## Log", mode: "clear" }).success).toBe(true);
  });

  it("accepts clear_before mode with cutoff", () => {
    expect(contextPatchSchema.safeParse({
      section: "raw_signals",
      mode: "clear_before",
      cutoff: "2026-04-10 02:33:00",
    }).success).toBe(true);
  });

  it("accepts append with maxEntries", () => {
    expect(contextPatchSchema.safeParse({
      section: "raw_signals",
      mode: "append",
      content: "- new entry",
      maxEntries: 20,
    }).success).toBe(true);
  });

  it("rejects non-positive maxEntries", () => {
    expect(contextPatchSchema.safeParse({
      section: "raw_signals",
      mode: "append",
      content: "x",
      maxEntries: 0,
    }).success).toBe(false);
    expect(contextPatchSchema.safeParse({
      section: "raw_signals",
      mode: "append",
      content: "x",
      maxEntries: -1,
    }).success).toBe(false);
  });

  it("rejects maxEntries on non-append modes", () => {
    expect(contextPatchSchema.safeParse({
      section: "s", mode: "replace", content: "x", maxEntries: 5,
    }).success).toBe(false);
    expect(contextPatchSchema.safeParse({
      section: "s", mode: "clear", maxEntries: 5,
    }).success).toBe(false);
    expect(contextPatchSchema.safeParse({
      section: "s", mode: "clear_before", cutoff: "2026-04-10 02:00:00", maxEntries: 5,
    }).success).toBe(false);
  });

  it("rejects cutoff on non-clear_before modes", () => {
    expect(contextPatchSchema.safeParse({
      section: "s", mode: "append", content: "x", cutoff: "2026-04-10 02:00:00",
    }).success).toBe(false);
    expect(contextPatchSchema.safeParse({
      section: "s", mode: "replace", content: "x", cutoff: "2026-04-10 02:00:00",
    }).success).toBe(false);
  });

  it("rejects clear_before without cutoff", () => {
    expect(contextPatchSchema.safeParse({
      section: "s", mode: "clear_before",
    }).success).toBe(false);
  });

  it("rejects clear_before with malformed cutoff", () => {
    // No zero-padding
    expect(contextPatchSchema.safeParse({
      section: "s", mode: "clear_before", cutoff: "2026-4-10 2:33:00",
    }).success).toBe(false);
    // ISO format with T
    expect(contextPatchSchema.safeParse({
      section: "s", mode: "clear_before", cutoff: "2026-04-10T02:33:00",
    }).success).toBe(false);
    // Missing seconds
    expect(contextPatchSchema.safeParse({
      section: "s", mode: "clear_before", cutoff: "2026-04-10 02:33",
    }).success).toBe(false);
  });

  it("rejects invalid mode", () => {
    expect(contextPatchSchema.safeParse({ section: "## Log", mode: "delete" }).success).toBe(false);
  });

  // ── append_to_file mode ──

  it("accepts append_to_file without section", () => {
    expect(contextPatchSchema.safeParse({
      mode: "append_to_file",
      content: "## Weekly 2026-W14\n- note",
    }).success).toBe(true);
  });

  it("accepts append_to_file with section (ignored by handler but schema-valid)", () => {
    expect(contextPatchSchema.safeParse({
      section: "unused",
      mode: "append_to_file",
      content: "## Weekly 2026-W14\n- note",
    }).success).toBe(true);
  });

  it("rejects section-based modes without section", () => {
    expect(contextPatchSchema.safeParse({
      mode: "append",
      content: "entry",
    }).success).toBe(false);
    expect(contextPatchSchema.safeParse({
      mode: "replace",
      content: "new",
    }).success).toBe(false);
    expect(contextPatchSchema.safeParse({
      mode: "clear",
    }).success).toBe(false);
  });

  // ── Content-required refinement ──

  it("rejects content-bearing modes when content is omitted", () => {
    expect(contextPatchSchema.safeParse({
      section: "## Log", mode: "append",
    }).success).toBe(false);
    expect(contextPatchSchema.safeParse({
      section: "## Log", mode: "replace",
    }).success).toBe(false);
    expect(contextPatchSchema.safeParse({
      mode: "append_to_file",
    }).success).toBe(false);
  });

  it("accepts empty string content for replace (explicit clear via replace)", () => {
    expect(contextPatchSchema.safeParse({
      section: "## Log", mode: "replace", content: "",
    }).success).toBe(true);
  });

  it("does not require content for clear / clear_before", () => {
    expect(contextPatchSchema.safeParse({
      section: "## Log", mode: "clear",
    }).success).toBe(true);
    expect(contextPatchSchema.safeParse({
      section: "raw_signals", mode: "clear_before", cutoff: "2026-04-10 02:00:00",
    }).success).toBe(true);
  });
});

describe("notifyRequestSchema", () => {
  it("accepts single platform", () => {
    expect(notifyRequestSchema.safeParse({ message: "hi", platform: "slack" }).success).toBe(true);
  });

  it("accepts multiple platforms", () => {
    expect(notifyRequestSchema.safeParse({ message: "hi", platforms: ["slack", "discord"] }).success).toBe(true);
  });

  it("rejects both platform and platforms", () => {
    const result = notifyRequestSchema.safeParse({
      message: "hi",
      platform: "slack",
      platforms: ["discord"],
    });
    expect(result.success).toBe(false);
  });

  it("accepts message only (no platform)", () => {
    expect(notifyRequestSchema.safeParse({ message: "hi" }).success).toBe(true);
  });
});

describe("scheduleRequestSchema", () => {
  it("requires description of at least 20 characters", () => {
    const valid = {
      time: "2026-04-15T10:00:00Z",
      taskType: "wake",
      description: "Check pending observations and update context files",
    };
    expect(scheduleRequestSchema.safeParse(valid).success).toBe(true);

    const short = { ...valid, description: "short" };
    expect(scheduleRequestSchema.safeParse(short).success).toBe(false);
  });

  it("accepts optional model and taskContext", () => {
    const result = scheduleRequestSchema.safeParse({
      time: "2026-04-15T10:00:00Z",
      taskType: "wake",
      description: "Check pending observations and update context files",
      model: "opus",
      taskContext: { key: "value" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an optional prompt override of at least 20 characters", () => {
    const result = scheduleRequestSchema.safeParse({
      time: "2026-04-15T10:00:00Z",
      taskType: "wake",
      description: "Check pending observations and update context files",
      prompt: "Detailed agent instruction body for the wake-up run",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a prompt override shorter than 20 characters", () => {
    const result = scheduleRequestSchema.safeParse({
      time: "2026-04-15T10:00:00Z",
      taskType: "wake",
      description: "Check pending observations and update context files",
      prompt: "too short",
    });
    expect(result.success).toBe(false);
  });
});

describe("scheduleUpdateRequestSchema", () => {
  it("requires at least one field", () => {
    expect(scheduleUpdateRequestSchema.safeParse({}).success).toBe(false);
  });

  it("rejects setting both description and message", () => {
    const result = scheduleUpdateRequestSchema.safeParse({
      description: "Updated description that is long enough",
      message: "Hello",
    });
    expect(result.success).toBe(false);
  });

  it("accepts description alone", () => {
    const result = scheduleUpdateRequestSchema.safeParse({
      description: "Updated description that is long enough",
    });
    expect(result.success).toBe(true);
  });

  it("accepts message alone", () => {
    expect(scheduleUpdateRequestSchema.safeParse({ message: "Hello" }).success).toBe(true);
  });

  it("accepts time alone", () => {
    expect(scheduleUpdateRequestSchema.safeParse({ time: "2026-04-15T10:00:00Z" }).success).toBe(true);
  });

  it("accepts a prompt override string of at least 20 characters", () => {
    const result = scheduleUpdateRequestSchema.safeParse({
      prompt: "Detailed agent instruction body for the wake-up run",
    });
    expect(result.success).toBe(true);
  });

  it("accepts prompt: null as the explicit clear sentinel", () => {
    const result = scheduleUpdateRequestSchema.safeParse({ prompt: null });
    expect(result.success).toBe(true);
  });

  it("rejects a prompt override shorter than 20 characters", () => {
    const result = scheduleUpdateRequestSchema.safeParse({ prompt: "short" });
    expect(result.success).toBe(false);
  });

  it("rejects setting both prompt and message together", () => {
    // prompt is for non-dm rows (overrides agent body); message is for dm
    // rows (the message text). They cannot coexist on a real row, so the
    // refine catches the obviously inconsistent payload before the route
    // handler even sees it.
    const result = scheduleUpdateRequestSchema.safeParse({
      prompt: "Detailed override that takes precedence over description",
      message: "Reminder",
    });
    expect(result.success).toBe(false);
  });
});

describe("scheduleDmRequestSchema", () => {
  it("accepts valid DM schedule", () => {
    expect(scheduleDmRequestSchema.safeParse({
      time: "2026-04-15T10:00:00Z",
      message: "Hello",
    }).success).toBe(true);
  });

  it("rejects empty message", () => {
    expect(scheduleDmRequestSchema.safeParse({
      time: "2026-04-15T10:00:00Z",
      message: "",
    }).success).toBe(false);
  });

  it("rejects both platform and platforms", () => {
    expect(scheduleDmRequestSchema.safeParse({
      time: "2026-04-15T10:00:00Z",
      message: "Hello",
      platform: "slack",
      platforms: ["discord"],
    }).success).toBe(false);
  });

  it("accepts valid importance overrides", () => {
    for (const importance of ["transient", "normal", "strategic"] as const) {
      expect(scheduleDmRequestSchema.safeParse({
        time: "2026-04-15T10:00:00Z",
        message: "Hello",
        importance,
      }).success).toBe(true);
    }
  });

  it("rejects unknown importance values", () => {
    expect(scheduleDmRequestSchema.safeParse({
      time: "2026-04-15T10:00:00Z",
      message: "Hello",
      importance: "low",
    }).success).toBe(false);
    expect(scheduleDmRequestSchema.safeParse({
      time: "2026-04-15T10:00:00Z",
      message: "Hello",
      importance: "urgent",
    }).success).toBe(false);
  });
});

describe("skillNameSchema", () => {
  it("accepts valid kebab-case names", () => {
    expect(skillNameSchema.safeParse("my-skill").success).toBe(true);
    expect(skillNameSchema.safeParse("skill123").success).toBe(true);
    expect(skillNameSchema.safeParse("a").success).toBe(true);
  });

  it("rejects invalid names", () => {
    expect(skillNameSchema.safeParse("").success).toBe(false);
    expect(skillNameSchema.safeParse("MySkill").success).toBe(false);
    expect(skillNameSchema.safeParse("my_skill").success).toBe(false);
    expect(skillNameSchema.safeParse("-leading").success).toBe(false);
    expect(skillNameSchema.safeParse("a".repeat(65)).success).toBe(false);
  });
});

describe("skillCreateSchema", () => {
  it("accepts valid skill creation", () => {
    expect(skillCreateSchema.safeParse({
      name: "my-skill",
      description: "A useful skill",
      content: "# Skill content",
    }).success).toBe(true);
  });

  it("accepts optional allowedTools", () => {
    expect(skillCreateSchema.safeParse({
      name: "my-skill",
      description: "A useful skill",
      content: "# Content",
      allowedTools: ["Bash(curl *)", "Read"],
    }).success).toBe(true);
  });

  it("rejects description with newlines", () => {
    expect(skillCreateSchema.safeParse({
      name: "my-skill",
      description: "Line1\nLine2",
      content: "# Content",
    }).success).toBe(false);
  });

  it("rejects tool entries with newlines", () => {
    expect(skillCreateSchema.safeParse({
      name: "my-skill",
      description: "Valid",
      content: "# Content",
      allowedTools: ["Bash\nGrep"],
    }).success).toBe(false);
  });
});

describe("skillUpdateSchema", () => {
  it("requires at least one field", () => {
    expect(skillUpdateSchema.safeParse({}).success).toBe(false);
  });

  it("accepts partial updates", () => {
    expect(skillUpdateSchema.safeParse({ description: "Updated" }).success).toBe(true);
    expect(skillUpdateSchema.safeParse({ content: "New content" }).success).toBe(true);
    expect(skillUpdateSchema.safeParse({ allowedTools: ["Read"] }).success).toBe(true);
  });
});

describe("calendarCreateEventSchema", () => {
  it("accepts valid event", () => {
    expect(calendarCreateEventSchema.safeParse({
      summary: "Meeting",
      start: "2026-04-15T10:00:00Z",
      end: "2026-04-15T11:00:00Z",
    }).success).toBe(true);
  });

  it("rejects empty summary", () => {
    expect(calendarCreateEventSchema.safeParse({
      summary: "",
      start: "2026-04-15T10:00:00Z",
      end: "2026-04-15T11:00:00Z",
    }).success).toBe(false);
  });
});

describe("calendarUpdateEventSchema", () => {
  it("accepts partial update with one field", () => {
    expect(calendarUpdateEventSchema.safeParse({ summary: "Updated" }).success).toBe(true);
    expect(calendarUpdateEventSchema.safeParse({ start: "2026-04-15T10:00:00Z" }).success).toBe(true);
  });

  it("rejects empty object (at least one field required)", () => {
    expect(calendarUpdateEventSchema.safeParse({}).success).toBe(false);
  });
});

describe("calendarFreeBusySchema", () => {
  it("accepts valid free/busy request", () => {
    expect(calendarFreeBusySchema.safeParse({
      timeMin: "2026-04-15T00:00:00Z",
      timeMax: "2026-04-16T00:00:00Z",
    }).success).toBe(true);
  });

  it("accepts optional calendarIds", () => {
    expect(calendarFreeBusySchema.safeParse({
      timeMin: "2026-04-15T00:00:00Z",
      timeMax: "2026-04-16T00:00:00Z",
      calendarIds: ["primary"],
    }).success).toBe(true);
  });

  it("rejects missing timeMin", () => {
    expect(calendarFreeBusySchema.safeParse({
      timeMax: "2026-04-16T00:00:00Z",
    }).success).toBe(false);
  });
});

describe("actionLogRequestSchema", () => {
  it("accepts valid action log", () => {
    expect(actionLogRequestSchema.safeParse({
      actionType: "context.write",
      detail: "Wrote user.md",
      result: "success",
    }).success).toBe(true);
  });

  it("rejects invalid result value", () => {
    expect(actionLogRequestSchema.safeParse({
      actionType: "context.write",
      detail: "Wrote user.md",
      result: "unknown",
    }).success).toBe(false);
  });
});

describe("recurrenceRuleSchema", () => {
  it("accepts valid daily rule", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "daily",
      time: "08:00",
      timezone: "America/New_York",
    }).success).toBe(true);
  });

  it("accepts valid weekly rule with daysOfWeek", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "weekly",
      time: "09:00",
      daysOfWeek: [1, 3, 5],
    }).success).toBe(true);
  });

  it("accepts valid monthly rule with daysOfMonth", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "monthly",
      time: "10:00",
      daysOfMonth: [1, 15],
    }).success).toBe(true);
  });

  it("rejects weekly without daysOfWeek", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "weekly",
      time: "09:00",
    }).success).toBe(false);
  });

  it("rejects monthly without daysOfMonth", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "monthly",
      time: "10:00",
    }).success).toBe(false);
  });

  it("rejects daily with daysOfWeek", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "daily",
      time: "08:00",
      daysOfWeek: [1],
    }).success).toBe(false);
  });

  it("rejects daily with daysOfMonth", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "daily",
      time: "08:00",
      daysOfMonth: [1],
    }).success).toBe(false);
  });

  it("rejects weekly with daysOfMonth", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "weekly",
      time: "09:00",
      daysOfWeek: [1],
      daysOfMonth: [1],
    }).success).toBe(false);
  });

  it("rejects monthly with daysOfWeek", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "monthly",
      time: "10:00",
      daysOfMonth: [1],
      daysOfWeek: [1],
    }).success).toBe(false);
  });

  it("rejects weekly with minuteOfHour", () => {
    // minuteOfHour belongs only to the hourly frequency variant.
    expect(recurrenceRuleSchema.safeParse({
      frequency: "weekly",
      time: "09:00",
      daysOfWeek: [1],
      minuteOfHour: 15,
    }).success).toBe(false);
  });

  it("rejects monthly with minuteOfHour", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "monthly",
      time: "10:00",
      daysOfMonth: [1],
      minuteOfHour: 15,
    }).success).toBe(false);
  });
});

describe("triggerCreateSchema", () => {
  const base = {
    domain: "git" as const,
    prompt: "x".repeat(25),
    time: "09:00",
  };

  it("accepts cron.daily without daysOfWeek", () => {
    expect(triggerCreateSchema.safeParse({
      ...base,
      eventType: "cron.daily",
    }).success).toBe(true);
  });

  it("accepts cron.weekly with daysOfWeek", () => {
    expect(triggerCreateSchema.safeParse({
      ...base,
      eventType: "cron.weekly",
      daysOfWeek: [1, 3, 5],
    }).success).toBe(true);
  });

  it("rejects cron.weekly without daysOfWeek (refine branch)", () => {
    expect(triggerCreateSchema.safeParse({
      ...base,
      eventType: "cron.weekly",
    }).success).toBe(false);
  });
});

describe("triggerUpdateSchema", () => {
  it("accepts partial updates with at least one field", () => {
    expect(triggerUpdateSchema.safeParse({ enabled: false }).success).toBe(true);
  });

  it("rejects empty updates via the refine guard", () => {
    expect(triggerUpdateSchema.safeParse({}).success).toBe(false);
  });

  it("rejects invalid time format", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "daily",
      time: "8:00",
    }).success).toBe(false);
  });

  // ── hourly frequency ─────────────────────────────────────────────
  it("accepts hourly with no extra fields (defaults: 1h, :00)", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "hourly",
      timezone: "Asia/Tokyo",
    }).success).toBe(true);
  });

  it("accepts hourly with intervalHours + minuteOfHour", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "hourly",
      intervalHours: 2,
      minuteOfHour: 30,
      timezone: "Asia/Tokyo",
    }).success).toBe(true);
  });

  it("rejects hourly with time", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "hourly",
      time: "09:00",
    }).success).toBe(false);
  });

  it("rejects hourly with daysOfWeek", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "hourly",
      daysOfWeek: [1],
    }).success).toBe(false);
  });

  it("rejects hourly with daysOfMonth", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "hourly",
      daysOfMonth: [1],
    }).success).toBe(false);
  });

  it("rejects hourly with onMissingDay", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "hourly",
      onMissingDay: "skip",
    }).success).toBe(false);
  });

  it("rejects intervalHours below 1", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "hourly",
      intervalHours: 0,
    }).success).toBe(false);
  });

  it("rejects intervalHours above 23", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "hourly",
      intervalHours: 24,
    }).success).toBe(false);
  });

  it("rejects minuteOfHour above 59", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "hourly",
      minuteOfHour: 60,
    }).success).toBe(false);
  });

  // ── daily / weekly / monthly: hourly fields forbidden ────────────
  it("rejects daily with intervalHours", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "daily",
      time: "09:00",
      intervalHours: 2,
    }).success).toBe(false);
  });

  it("rejects daily with minuteOfHour", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "daily",
      time: "09:00",
      minuteOfHour: 30,
    }).success).toBe(false);
  });

  it("rejects weekly with intervalHours", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "weekly",
      time: "09:00",
      daysOfWeek: [1],
      intervalHours: 2,
    }).success).toBe(false);
  });

  it("rejects monthly with intervalHours", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "monthly",
      time: "09:00",
      daysOfMonth: [1],
      intervalHours: 2,
    }).success).toBe(false);
  });

  // ── time required on daily/weekly/monthly ────────────────────────
  it("rejects daily without time (now superRefine-checked)", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "daily",
    }).success).toBe(false);
  });

  it("rejects weekly without time", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "weekly",
      daysOfWeek: [1],
    }).success).toBe(false);
  });

  it("rejects monthly without time", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "monthly",
      daysOfMonth: [1],
    }).success).toBe(false);
  });

  // ── onMissingDay ─────────────────────────────────────────────────
  it("accepts monthly with onMissingDay='skip'", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "monthly",
      time: "21:00",
      daysOfMonth: [31],
      onMissingDay: "skip",
    }).success).toBe(true);
  });

  it("accepts monthly with onMissingDay='lastDayOfMonth'", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "monthly",
      time: "21:00",
      daysOfMonth: [31],
      onMissingDay: "lastDayOfMonth",
    }).success).toBe(true);
  });

  it("rejects monthly with onMissingDay='other'", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "monthly",
      time: "21:00",
      daysOfMonth: [31],
      onMissingDay: "other" as never,
    }).success).toBe(false);
  });

  it("rejects daily with onMissingDay (only monthly carries it)", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "daily",
      time: "09:00",
      onMissingDay: "skip",
    }).success).toBe(false);
  });

  it("rejects weekly with onMissingDay", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "weekly",
      time: "09:00",
      daysOfWeek: [1],
      onMissingDay: "skip",
    }).success).toBe(false);
  });

  // ── duplicate guards on day-of-* arrays ──────────────────────────
  it("rejects duplicate entries in daysOfWeek", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "weekly",
      time: "09:00",
      daysOfWeek: [1, 1, 3],
    }).success).toBe(false);
  });

  it("rejects duplicate entries in daysOfMonth", () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: "monthly",
      time: "21:00",
      daysOfMonth: [15, 15],
    }).success).toBe(false);
  });
});

describe("recurringScheduleCreateSchema", () => {
  it("accepts valid recurring schedule", () => {
    expect(recurringScheduleCreateSchema.safeParse({
      taskType: "routine.morning_routine",
      description: "Morning check-in with task review and agenda",
      recurrenceRule: { frequency: "daily", time: "08:00" },
    }).success).toBe(true);
  });

  it("rejects short description", () => {
    expect(recurringScheduleCreateSchema.safeParse({
      taskType: "routine",
      description: "short",
      recurrenceRule: { frequency: "daily", time: "08:00" },
    }).success).toBe(false);
  });
});

describe("recurringScheduleUpdateSchema", () => {
  it("accepts partial update", () => {
    expect(recurringScheduleUpdateSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(recurringScheduleUpdateSchema.safeParse({ model: "opus" }).success).toBe(true);
  });

  it("rejects empty object (at least one field required)", () => {
    expect(recurringScheduleUpdateSchema.safeParse({}).success).toBe(false);
  });
});
