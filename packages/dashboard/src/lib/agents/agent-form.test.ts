import { describe, expect, it } from "vitest";
import {
  AGENT_BACKEND_CHOICES,
  AGENT_TIER_CHOICES,
  EMPTY_AGENT_FORM_STATE,
  agentFormToCron,
  agentFormToFrontmatter,
  agentFormToMarkdown,
  slugifyAgentName,
  validateAgentForm,
  type AgentFormState,
} from "./agent-form";
import { validateAgentMarkdown } from "./yaml-edit";

/**
 * A complete, valid form state — each test clones and mutates the field under
 * scrutiny so an unrelated failure can't leak in. `/agents` is recurring-only,
 * so every frequency the form offers (daily/weekly/monthly) renders to cron.
 */
function validState(overrides: Partial<AgentFormState> = {}): AgentFormState {
  return {
    ...EMPTY_AGENT_FORM_STATE,
    name: "Daily Digest",
    slug: "daily-digest",
    description: "Summarise the day.",
    prompt: "Read today's notes and write a short digest.",
    ...overrides,
  };
}

describe("slugifyAgentName", () => {
  it("lowercases and hyphenates", () => {
    expect(slugifyAgentName("Daily Digest")).toBe("daily-digest");
  });
  it("collapses non-alphanumeric runs and trims edge hyphens", () => {
    expect(slugifyAgentName("  My  Agent!! (v2) ")).toBe("my-agent-v2");
  });
  it("returns empty when there are no ASCII alphanumerics", () => {
    expect(slugifyAgentName("日本語のみ")).toBe("");
  });
  it("keeps a leading digit (validation flags it, not slugify)", () => {
    expect(slugifyAgentName("2024 report")).toBe("2024-report");
  });
});

describe("validateAgentForm", () => {
  it("returns null for a complete valid daily state", () => {
    expect(validateAgentForm(validState())).toBeNull();
  });

  it("flags missing required text fields", () => {
    const errs = validateAgentForm(
      validState({ name: "  ", description: "", prompt: "   " }),
    );
    expect(errs?.name).toBeDefined();
    expect(errs?.description).toBeDefined();
    expect(errs?.prompt).toBeDefined();
  });

  it("flags an empty slug", () => {
    expect(validateAgentForm(validState({ slug: "" }))?.slug).toBeDefined();
  });

  it("flags a slug that breaks the kebab-case pattern", () => {
    expect(validateAgentForm(validState({ slug: "2bad" }))?.slug).toBeDefined();
    expect(validateAgentForm(validState({ slug: "Bad Slug" }))?.slug).toBeDefined();
  });

  it("flags a slug that collides with an existing agent", () => {
    const errs = validateAgentForm(validState({ slug: "morning-routine" }), [
      "morning-routine",
      "weekly-review",
    ]);
    expect(errs?.slug).toContain("already exists");
  });

  it("accepts a unique slug against the existing set", () => {
    expect(
      validateAgentForm(validState({ slug: "my-new-agent" }), ["morning-routine"]),
    ).toBeNull();
  });

  it("requires a HH:MM time for recurring frequencies", () => {
    expect(validateAgentForm(validState({ time: "9am" }))?.time).toBeDefined();
  });

  it("accepts a valid hourly cadence and skips the time check", () => {
    // Time is irrelevant for hourly — a malformed time must not block save.
    expect(
      validateAgentForm(
        validState({ frequency: "hourly", time: "bad", intervalHours: 2, minuteOfHour: 30 }),
      ),
    ).toBeNull();
  });

  it("rejects an out-of-range hourly interval or minute", () => {
    expect(validateAgentForm(validState({ frequency: "hourly", intervalHours: 0 }))?.intervalHours).toBeDefined();
    expect(validateAgentForm(validState({ frequency: "hourly", intervalHours: 24 }))?.intervalHours).toBeDefined();
    expect(validateAgentForm(validState({ frequency: "hourly", minuteOfHour: 60 }))?.minuteOfHour).toBeDefined();
  });

  it("requires at least one weekday for weekly", () => {
    expect(
      validateAgentForm(validState({ frequency: "weekly", daysOfWeek: [] }))?.daysOfWeek,
    ).toBeDefined();
    expect(
      validateAgentForm(validState({ frequency: "weekly", daysOfWeek: [1] })),
    ).toBeNull();
  });

  it("requires at least one month-day for monthly", () => {
    expect(
      validateAgentForm(validState({ frequency: "monthly", daysOfMonth: [] }))
        ?.daysOfMonth,
    ).toBeDefined();
    expect(
      validateAgentForm(validState({ frequency: "monthly", daysOfMonth: [15] })),
    ).toBeNull();
  });

  it("flags non-positive / non-integer limits", () => {
    const errs = validateAgentForm(
      validState({ maxTurns: 0, maxBudgetUsd: -1, timeoutMinutes: 2.5 }),
    );
    expect(errs?.maxTurns).toBeDefined();
    expect(errs?.maxBudgetUsd).toBeDefined();
    expect(errs?.timeoutMinutes).toBeDefined();
  });

  it("allows a zero budget (soft cap)", () => {
    expect(validateAgentForm(validState({ maxBudgetUsd: 0 }))).toBeNull();
  });
});

describe("agentFormToCron", () => {
  it("builds a daily expression", () => {
    expect(agentFormToCron(validState({ frequency: "daily", time: "09:30" }))).toBe(
      "30 9 * * *",
    );
  });
  it("builds a weekly expression with sorted days", () => {
    expect(
      agentFormToCron(
        validState({ frequency: "weekly", time: "07:00", daysOfWeek: [5, 1, 3] }),
      ),
    ).toBe("0 7 * * 1,3,5");
  });
  it("builds a monthly expression with sorted days", () => {
    expect(
      agentFormToCron(
        validState({ frequency: "monthly", time: "23:15", daysOfMonth: [15, 1] }),
      ),
    ).toBe("15 23 1,15 * *");
  });
  it("falls back to wildcard when a recurring day set is empty", () => {
    expect(
      agentFormToCron(validState({ frequency: "weekly", time: "06:00", daysOfWeek: [] })),
    ).toBe("0 6 * * *");
  });
  it("tolerates a malformed time by defaulting to midnight fields", () => {
    expect(agentFormToCron(validState({ frequency: "daily", time: "bad" }))).toBe(
      "0 0 * * *",
    );
  });
  it("builds an every-hour expression (intervalHours 1)", () => {
    expect(
      agentFormToCron(validState({ frequency: "hourly", intervalHours: 1, minuteOfHour: 0 })),
    ).toBe("0 * * * *");
  });
  it("builds an every-N-hours expression (intervalHours > 1)", () => {
    expect(
      agentFormToCron(validState({ frequency: "hourly", intervalHours: 3, minuteOfHour: 15 })),
    ).toBe("15 */3 * * *");
  });
});

describe("agentFormToFrontmatter", () => {
  it("pins the user-Agent process key and omits default backend knobs", () => {
    const fm = agentFormToFrontmatter(validState());
    expect(fm.backend).toEqual({ process_key: "agent.task" });
    expect(fm.kind).toBe("user");
  });
  it("includes tier and backend_id only when set", () => {
    const fm = agentFormToFrontmatter(
      validState({ tier: "high", backendId: "codex" }),
    );
    expect(fm.backend).toEqual({
      process_key: "agent.task",
      tier: "high",
      backend_id: "codex",
    });
  });
  it("always emits a cron schedule (recurring-only)", () => {
    const fm = agentFormToFrontmatter(
      validState({ frequency: "daily", time: "09:00" }),
    ) as { schedule: { kind: string; expression: string } };
    expect(fm.schedule.kind).toBe("cron");
    expect(fm.schedule.expression).toBe("0 9 * * *");
  });
  it("carries the limits trio through", () => {
    const fm = agentFormToFrontmatter(
      validState({ maxTurns: 5, maxBudgetUsd: 1.5, timeoutMinutes: 30 }),
    );
    expect(fm.limits).toEqual({
      max_turns: 5,
      max_budget_usd: 1.5,
      timeout_minutes: 30,
    });
  });
  it("emits schedule.defer_in_quiet_hours only when opted in (QUIET_HOURS_HARDENING_PLAN §6)", () => {
    const off = agentFormToFrontmatter(validState()) as { schedule: Record<string, unknown> };
    expect("defer_in_quiet_hours" in off.schedule).toBe(false);

    const on = agentFormToFrontmatter(validState({ deferInQuietHours: true })) as {
      schedule: Record<string, unknown>;
    };
    expect(on.schedule.defer_in_quiet_hours).toBe(true);
  });
});

describe("agentFormToMarkdown", () => {
  it("produces a document that passes the shared schema validator (daily)", () => {
    const md = agentFormToMarkdown(validState());
    expect(validateAgentMarkdown(md)).toEqual({ ok: true });
    expect(md).toContain("Read today's notes");
  });

  it("produces a valid document for weekly", () => {
    const md = agentFormToMarkdown(
      validState({ frequency: "weekly", daysOfWeek: [1, 3] }),
    );
    expect(validateAgentMarkdown(md)).toEqual({ ok: true });
  });

  it("produces a valid document for monthly with backend overrides", () => {
    const md = agentFormToMarkdown(
      validState({
        frequency: "monthly",
        daysOfMonth: [1, 15],
        tier: "lite",
        backendId: "claude",
        enabled: false,
        deferInQuietHours: true,
      }),
    );
    expect(validateAgentMarkdown(md)).toEqual({ ok: true });
  });
});

describe("choice constants", () => {
  it("offer a leading default sentinel", () => {
    expect(AGENT_BACKEND_CHOICES[0]).toBe("");
    expect(AGENT_TIER_CHOICES[0]).toBe("");
    expect(AGENT_BACKEND_CHOICES).toContain("claude");
    expect(AGENT_TIER_CHOICES).toContain("medium");
  });
});
