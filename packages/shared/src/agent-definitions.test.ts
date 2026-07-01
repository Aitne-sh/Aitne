import { describe, expect, it } from "vitest";
import {
  AGENT_KINDS,
  AGENT_SLUG_PATTERN,
  AGENT_TIERS,
  OVERRIDE_EDIT_PATHS,
  SCHEDULE_KINDS,
  agentDefinitionSchema,
  agentScheduleSchema,
  stopWarningSchema,
  successCriterionSchema,
} from "./agent-definitions.js";

// ── Fixtures ──────────────────────────────────────────────────────────────

const validStopWarning = {
  level: "critical" as const,
  services_lost: ["Daily state/today.md regeneration"],
  dependent_agents: ["evening-review"],
  reactivation_hint: "Re-enable from /agents/morning-routine.",
};

/** A complete built-in Agent definition (mirrors §4.2's worked example). */
function builtinAgent(overrides: Record<string, unknown> = {}) {
  return {
    slug: "morning-routine",
    name: "Morning Routine",
    description: "Daily check-in; writes state/today.md and sends a DM digest.",
    kind: "builtin",
    version: 1,
    enabled: true,
    tags: ["routine", "daily"],
    schedule: {
      kind: "cron",
      expression: "0 {dayBoundaryHour} * * *",
      timezone: "Asia/Tokyo",
    },
    backend: {
      process_key: "routine.morning_routine",
      tier: "medium",
      model: null,
      backend_id: "claude",
    },
    limits: { max_turns: 30, max_budget_usd: 0.5, timeout_minutes: 15 },
    tools: {
      allowed: ["Read", "Grep", "Bash", "WebFetch"],
      skills: ["today-md-writer"],
    },
    outputs: ["state/today.md", "journal/daily/{date}.md", "dm_digest"],
    success_criteria: [
      { id: "today_md_populated", kind: "file_section_count", target: "state/today.md", min: 5 },
      { id: "daily_journal_created", kind: "file_exists", target: "journal/daily/{date}.md" },
      {
        id: "dm_digest_delivered",
        kind: "notification_log",
        notification_type: "morning_digest",
        delivered_within_minutes: 30,
      },
    ],
    on_error: { retries: 1, retry_delay_seconds: 60, notify_owner: true },
    stop_warning: validStopWarning,
    ...overrides,
  };
}

/** A complete user Agent definition (mirrors §4.2's `/schedule`-created example). */
function userAgent(overrides: Record<string, unknown> = {}) {
  return {
    slug: "weekly-bookmarks-cleanup",
    name: "Weekly Bookmarks Cleanup",
    description: "Reviews Obsidian inbox bookmarks every Sunday, files or discards.",
    kind: "user",
    schedule: { kind: "cron", expression: "0 21 * * 0" },
    backend: { process_key: "agent.task", tier: "lite" },
    limits: { max_turns: 12, max_budget_usd: 0.1, timeout_minutes: 8 },
    tools: { allowed: ["Read", "Grep", "Bash"], skills: ["obsidian-lint"] },
    success_criteria: [
      { id: "any_inbox_processed", kind: "agent_action_count", action_type: "obsidian.write", min: 1 },
    ],
    ...overrides,
  };
}

// ── Vocabulary consts ──────────────────────────────────────────────────────

describe("vocabulary consts", () => {
  it("exposes the documented enum members", () => {
    expect(AGENT_KINDS).toEqual(["builtin", "user"]);
    expect(AGENT_TIERS).toEqual(["lite", "medium", "high"]);
    expect(SCHEDULE_KINDS).toEqual(["cron", "one_shot", "event"]);
  });

  it("AGENT_SLUG_PATTERN accepts kebab-case and rejects bad slugs", () => {
    expect(AGENT_SLUG_PATTERN.test("morning-routine")).toBe(true);
    expect(AGENT_SLUG_PATTERN.test("a")).toBe(true);
    expect(AGENT_SLUG_PATTERN.test("Foo")).toBe(false);
    expect(AGENT_SLUG_PATTERN.test("1abc")).toBe(false);
  });
});

// ── stopWarningSchema ───────────────────────────────────────────────────────

describe("stopWarningSchema", () => {
  it("parses a full stop warning", () => {
    expect(stopWarningSchema.parse(validStopWarning)).toMatchObject({
      level: "critical",
      services_lost: ["Daily state/today.md regeneration"],
      dependent_agents: ["evening-review"],
    });
  });

  it("defaults dependent_agents to [] and leaves reactivation_hint optional", () => {
    const parsed = stopWarningSchema.parse({ level: "high", services_lost: ["X"] });
    expect(parsed.dependent_agents).toEqual([]);
    expect(parsed.reactivation_hint).toBeUndefined();
  });

  it("requires at least one services_lost entry", () => {
    expect(stopWarningSchema.safeParse({ level: "normal", services_lost: [] }).success).toBe(false);
  });

  it("rejects an empty dependent_agents slug", () => {
    expect(
      stopWarningSchema.safeParse({ level: "high", services_lost: ["X"], dependent_agents: [""] })
        .success,
    ).toBe(false);
  });

  it("rejects an unknown level", () => {
    expect(
      stopWarningSchema.safeParse({ level: "blocker", services_lost: ["X"] }).success,
    ).toBe(false);
  });
});

// ── successCriterionSchema (discriminated union) ────────────────────────────

describe("successCriterionSchema", () => {
  it("parses file_exists", () => {
    expect(
      successCriterionSchema.parse({ id: "c", kind: "file_exists", target: "a.md" }),
    ).toEqual({ id: "c", kind: "file_exists", target: "a.md" });
  });

  it("parses file_section_count and defaults heading_level to 2", () => {
    const parsed = successCriterionSchema.parse({
      id: "c",
      kind: "file_section_count",
      target: "a.md",
      min: 3,
    });
    expect(parsed).toMatchObject({ kind: "file_section_count", min: 3, heading_level: 2 });
  });

  it("accepts explicit heading_level 1|2|3 and rejects others", () => {
    for (const level of [1, 2, 3]) {
      expect(
        successCriterionSchema.safeParse({
          id: "c",
          kind: "file_section_count",
          target: "a.md",
          min: 0,
          heading_level: level,
        }).success,
      ).toBe(true);
    }
    expect(
      successCriterionSchema.safeParse({
        id: "c",
        kind: "file_section_count",
        target: "a.md",
        min: 0,
        heading_level: 4,
      }).success,
    ).toBe(false);
  });

  it("parses notification_log and defaults delivered_within_minutes to 60", () => {
    const parsed = successCriterionSchema.parse({
      id: "c",
      kind: "notification_log",
      notification_type: "morning_digest",
    });
    expect(parsed).toMatchObject({ kind: "notification_log", delivered_within_minutes: 60 });
  });

  it("parses agent_action_count", () => {
    expect(
      successCriterionSchema.parse({
        id: "c",
        kind: "agent_action_count",
        action_type: "obsidian.write",
        min: 1,
      }),
    ).toMatchObject({ kind: "agent_action_count", min: 1 });
  });

  it("rejects an unknown criterion kind", () => {
    expect(
      successCriterionSchema.safeParse({ id: "c", kind: "http_ping", target: "x" }).success,
    ).toBe(false);
  });

  it("rejects an empty id", () => {
    expect(
      successCriterionSchema.safeParse({ id: "", kind: "file_exists", target: "a.md" }).success,
    ).toBe(false);
  });

  it("requires a positive min for agent_action_count", () => {
    expect(
      successCriterionSchema.safeParse({
        id: "c",
        kind: "agent_action_count",
        action_type: "x",
        min: 0,
      }).success,
    ).toBe(false);
  });
});

// ── agentScheduleSchema (kind ↔ field refinement) ───────────────────────────

describe("agentScheduleSchema", () => {
  it("leaves timezone undefined when omitted (loader fills it from daemon config)", () => {
    expect(
      agentScheduleSchema.parse({ kind: "cron", expression: "* * * * *" }).timezone,
    ).toBeUndefined();
  });

  it("preserves an explicit timezone", () => {
    expect(
      agentScheduleSchema.parse({
        kind: "cron",
        expression: "* * * * *",
        timezone: "America/New_York",
      }).timezone,
    ).toBe("America/New_York");
  });

  it("rejects an empty timezone string", () => {
    expect(
      agentScheduleSchema.safeParse({ kind: "cron", expression: "* * * * *", timezone: "" }).success,
    ).toBe(false);
  });

  it("accepts each kind with its matching field", () => {
    expect(agentScheduleSchema.safeParse({ kind: "cron", expression: "0 4 * * *" }).success).toBe(
      true,
    );
    expect(
      agentScheduleSchema.safeParse({ kind: "one_shot", one_shot_at: "2026-06-01T09:00:00Z" })
        .success,
    ).toBe(true);
    expect(
      agentScheduleSchema.safeParse({ kind: "event", event_ref: "push.failed" }).success,
    ).toBe(true);
  });

  it("rejects each kind missing its matching field", () => {
    expect(agentScheduleSchema.safeParse({ kind: "cron" }).success).toBe(false);
    expect(agentScheduleSchema.safeParse({ kind: "one_shot" }).success).toBe(false);
    expect(agentScheduleSchema.safeParse({ kind: "event" }).success).toBe(false);
  });

  it("accepts a one_shot_at carrying a timezone offset", () => {
    expect(
      agentScheduleSchema.safeParse({ kind: "one_shot", one_shot_at: "2026-06-01T09:00:00+09:00" })
        .success,
    ).toBe(true);
  });

  it("rejects a non-ISO one_shot_at", () => {
    expect(
      agentScheduleSchema.safeParse({ kind: "one_shot", one_shot_at: "not-a-date" }).success,
    ).toBe(false);
  });

  it("rejects a bare local one_shot_at carrying neither Z nor an offset", () => {
    // datetime({ offset: true }) requires an explicit Z or ±hh:mm — a naked
    // local datetime is ambiguous and rejected (matches the field's comment).
    expect(
      agentScheduleSchema.safeParse({ kind: "one_shot", one_shot_at: "2026-06-01T09:00:00" })
        .success,
    ).toBe(false);
  });

  it("defaults defer_in_quiet_hours to false (additive — existing files parse unchanged)", () => {
    expect(
      agentScheduleSchema.parse({ kind: "cron", expression: "* * * * *" })
        .defer_in_quiet_hours,
    ).toBe(false);
  });

  it("preserves an explicit defer_in_quiet_hours: true", () => {
    expect(
      agentScheduleSchema.parse({
        kind: "cron",
        expression: "0 3 * * *",
        defer_in_quiet_hours: true,
      }).defer_in_quiet_hours,
    ).toBe(true);
  });

  it("rejects a non-boolean defer_in_quiet_hours", () => {
    expect(
      agentScheduleSchema.safeParse({
        kind: "cron",
        expression: "* * * * *",
        defer_in_quiet_hours: "yes",
      }).success,
    ).toBe(false);
  });
});

// ── agentDefinitionSchema ───────────────────────────────────────────────────

describe("agentDefinitionSchema", () => {
  it("parses a valid built-in Agent", () => {
    const parsed = agentDefinitionSchema.parse(builtinAgent());
    expect(parsed.slug).toBe("morning-routine");
    expect(parsed.kind).toBe("builtin");
    expect(parsed.stop_warning?.level).toBe("critical");
    expect(parsed.success_criteria).toHaveLength(3);
  });

  it("parses a valid user Agent", () => {
    const parsed = agentDefinitionSchema.parse(userAgent());
    expect(parsed.slug).toBe("weekly-bookmarks-cleanup");
    expect(parsed.kind).toBe("user");
    expect(parsed.stop_warning).toBeUndefined();
  });

  it("populates defaults when optional keys are omitted", () => {
    const parsed = agentDefinitionSchema.parse({
      slug: "minimal-agent",
      name: "Minimal",
      description: "Smallest valid user Agent.",
      kind: "user",
      schedule: { kind: "cron", expression: "0 9 * * *" },
      backend: { process_key: "agent.task" },
      limits: {},
    });
    expect(parsed.version).toBe(1);
    expect(parsed.enabled).toBe(true);
    expect(parsed.tags).toEqual([]);
    expect(parsed.tools).toEqual({ allowed: [], skills: [], skills_replace: false });
    expect(parsed.outputs).toEqual([]);
    expect(parsed.success_criteria).toEqual([]);
    expect(parsed.playbooks).toEqual([]);
    expect(parsed.on_error).toEqual({ retries: 0, retry_delay_seconds: 30, notify_owner: false });
    expect(parsed.schedule.timezone).toBeUndefined();
    expect(parsed.backend).toEqual({
      process_key: "agent.task",
      tier: null,
      model: null,
      backend_id: null,
    });
    expect(parsed.limits).toEqual({ max_turns: 20, max_budget_usd: 0.25, timeout_minutes: 10 });
  });

  it("defaults skills_replace to false when tools omits it", () => {
    const parsed = agentDefinitionSchema.parse(
      userAgent({ tools: { allowed: ["Read"], skills: ["obsidian-lint"] } }),
    );
    expect(parsed.tools.skills_replace).toBe(false);
  });

  it("honours an explicit skills_replace: true", () => {
    const parsed = agentDefinitionSchema.parse(
      userAgent({ tools: { allowed: ["Read"], skills: ["obsidian-lint"], skills_replace: true } }),
    );
    expect(parsed.tools.skills_replace).toBe(true);
  });

  it("fails a builtin without stop_warning, pointing at stop_warning", () => {
    const result = agentDefinitionSchema.safeParse(builtinAgent({ stop_warning: undefined }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === "stop_warning");
      expect(issue).toBeDefined();
      expect(issue?.message).toBe("builtin Agents must declare stop_warning");
    }
  });

  it("allows a user Agent without stop_warning", () => {
    expect(agentDefinitionSchema.safeParse(userAgent({ stop_warning: undefined })).success).toBe(
      true,
    );
  });

  it("rejects duplicate success_criteria ids, pointing at the offending entry", () => {
    const result = agentDefinitionSchema.safeParse(
      userAgent({
        success_criteria: [
          { id: "dup", kind: "agent_action_count", action_type: "obsidian.write", min: 1 },
          { id: "dup", kind: "file_exists", target: "a.md" },
        ],
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === "success_criteria.1.id");
      expect(issue?.message).toBe('duplicate success_criteria id "dup"');
    }
  });

  it("fails schedule cron without expression", () => {
    expect(
      agentDefinitionSchema.safeParse(userAgent({ schedule: { kind: "cron" } })).success,
    ).toBe(false);
  });

  it("fails schedule one_shot without one_shot_at", () => {
    expect(
      agentDefinitionSchema.safeParse(userAgent({ schedule: { kind: "one_shot" } })).success,
    ).toBe(false);
  });

  it("fails schedule event without event_ref", () => {
    expect(
      agentDefinitionSchema.safeParse(userAgent({ schedule: { kind: "event" } })).success,
    ).toBe(false);
  });

  it("accepts a one_shot schedule with one_shot_at", () => {
    expect(
      agentDefinitionSchema.safeParse(
        userAgent({ schedule: { kind: "one_shot", one_shot_at: "2026-06-01T09:00:00Z" } }),
      ).success,
    ).toBe(true);
  });

  it("accepts an event schedule with event_ref", () => {
    expect(
      agentDefinitionSchema.safeParse(
        userAgent({ schedule: { kind: "event", event_ref: "pr.opened" } }),
      ).success,
    ).toBe(true);
  });

  it.each(["Foo", "1abc", "-leading", "has_underscore", ""])(
    "rejects bad slug %j",
    (slug) => {
      expect(agentDefinitionSchema.safeParse(userAgent({ slug })).success).toBe(false);
    },
  );

  it("rejects an unknown backend_id", () => {
    expect(
      agentDefinitionSchema.safeParse(
        userAgent({ backend: { process_key: "agent.task", backend_id: "openai" } }),
      ).success,
    ).toBe(false);
  });

  it("rejects an unknown tier", () => {
    expect(
      agentDefinitionSchema.safeParse(
        userAgent({ backend: { process_key: "agent.task", tier: "ultra" } }),
      ).success,
    ).toBe(false);
  });

  it("requires a non-empty process_key", () => {
    expect(
      agentDefinitionSchema.safeParse(userAgent({ backend: { process_key: "" } })).success,
    ).toBe(false);
  });

  it("accepts a builtin with a null process_key (no-LLM in-process pass)", () => {
    // roadmap-maintenance / context-index-reconcile fire via in-process
    // callbacks and carry no backend-routing key — null must be representable.
    const parsed = agentDefinitionSchema.parse(
      builtinAgent({
        slug: "roadmap-maintenance",
        name: "Roadmap Maintenance",
        backend: { process_key: null },
        success_criteria: [],
      }),
    );
    expect(parsed.backend.process_key).toBeNull();
  });

  it("rejects a user Agent with a null process_key, pointing at backend.process_key", () => {
    const result = agentDefinitionSchema.safeParse(userAgent({ backend: { process_key: null } }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => i.path.join(".") === "backend.process_key",
      );
      expect(issue?.message).toBe("user Agents require a non-null backend.process_key");
    }
  });

  it("accepts a null model but rejects an empty-string model", () => {
    expect(
      agentDefinitionSchema.safeParse(
        userAgent({ backend: { process_key: "agent.task", model: null } }),
      ).success,
    ).toBe(true);
    expect(
      agentDefinitionSchema.safeParse(
        userAgent({ backend: { process_key: "agent.task", model: "" } }),
      ).success,
    ).toBe(false);
  });

  it.each([
    ["tags", { tags: ["ok", ""] }],
    ["outputs", { outputs: ["state/today.md", ""] }],
    ["tools.allowed", { tools: { allowed: ["Read", ""] } }],
    ["tools.skills", { tools: { skills: ["obsidian-lint", ""] } }],
  ])("rejects a blank entry in %s", (_label, overrides) => {
    expect(agentDefinitionSchema.safeParse(userAgent(overrides)).success).toBe(false);
  });

  it("rejects a non-positive max_turns", () => {
    expect(
      agentDefinitionSchema.safeParse(
        userAgent({ limits: { max_turns: 0, max_budget_usd: 0.1, timeout_minutes: 8 } }),
      ).success,
    ).toBe(false);
  });

  // ── playbooks[] (AGENT_PROMPT_QUALITY_DESIGN.md Phase 2) ──
  it("accepts a valid playbooks[] of registry slugs", () => {
    const parsed = agentDefinitionSchema.parse(
      userAgent({ playbooks: ["research", "markdown-note"] }),
    );
    expect(parsed.playbooks).toEqual(["research", "markdown-note"]);
  });

  it("rejects an unknown playbook slug (enum-validated against the registry)", () => {
    const result = agentDefinitionSchema.safeParse(
      userAgent({ playbooks: ["research", "not-a-playbook"] }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "playbooks")).toBe(true);
    }
  });
});

describe("OVERRIDE_EDIT_PATHS", () => {
  it("is the §6.4.1 built-in override field allow-list (excludes the column-authority enabled* keys)", () => {
    expect([...OVERRIDE_EDIT_PATHS]).toEqual([
      "backend.tier",
      "backend.model",
      "backend.backend_id",
      "limits.max_turns",
      "limits.max_budget_usd",
      "limits.timeout_minutes",
      "on_error.notify_owner",
    ]);
    expect((OVERRIDE_EDIT_PATHS as readonly string[]).includes("enabled")).toBe(false);
  });
});
