import { describe, it, expect } from "vitest";

import type { AgentDTO } from "../../db/agents-store.js";
import { loadEffectiveDefinition } from "./effective-definition.js";

const BUILTIN_YAML = `---
slug: morning-routine
name: Morning Routine
description: Generate today.md and register the day schedule.
kind: builtin
schedule:
  kind: cron
  expression: "0 4 * * *"
backend:
  process_key: routine.morning_routine
limits: {}
stop_warning:
  level: critical
  services_lost:
    - today.md
---

See agent-assets/task-flows/routine.morning_routine_today.md
`;

const USER_YAML = `---
slug: my-task
name: My Task
description: Do the recurring thing every morning.
kind: user
schedule:
  kind: cron
  expression: "0 9 * * *"
backend:
  process_key: agent.task
limits: {}
---

Run my task.
`;

function makeDto(overrides: Partial<AgentDTO> = {}): AgentDTO {
  return {
    slug: "morning-routine",
    name: "Morning Routine",
    description: "Generate today.md and register the day schedule.",
    source: "builtin",
    definitionPath: "/agents/morning-routine/agent.md",
    definitionHash: "hash",
    enabled: true,
    enabledOverriddenAt: null,
    processKey: "routine.morning_routine",
    scheduleKind: "cron",
    scheduleExpression: "0 4 * * *",
    scheduleTimezone: "America/New_York",
    tags: [],
    stopWarning: null,
    recurringScheduleId: null,
    lastExecutionId: null,
    metadata: {},
    invalid: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const constReader = (content: string | null) => () => content;

describe("loadEffectiveDefinition", () => {
  it("parses a valid built-in file and returns it verbatim", () => {
    const res = loadEffectiveDefinition(makeDto(), {
      readFile: constReader(BUILTIN_YAML),
      dayBoundaryHour: 4,
    });
    expect(res.error).toBeNull();
    expect(res.synthesized).toBe(false);
    expect(res.yaml).toBe(BUILTIN_YAML);
    expect(res.definition?.slug).toBe("morning-routine");
    expect(res.definition?.backend.process_key).toBe("routine.morning_routine");
    // schema default filled in
    expect(res.definition?.limits.max_turns).toBe(20);
  });

  it("applies the built-in override snapshot on top of the file", () => {
    const dto = makeDto({
      metadata: { override_snapshot: { "backend.tier": "high", "limits.max_budget_usd": 0.5 } },
    });
    const res = loadEffectiveDefinition(dto, {
      readFile: constReader(BUILTIN_YAML),
      dayBoundaryHour: 4,
    });
    expect(res.definition?.backend.tier).toBe("high");
    expect(res.definition?.limits.max_budget_usd).toBe(0.5);
  });

  it("ignores a non-object override_snapshot", () => {
    const dto = makeDto({
      // metadata typed loosely; a corrupt array snapshot must be ignored, not merged.
      metadata: { override_snapshot: ["bad"] as unknown as Record<string, unknown> },
    });
    const res = loadEffectiveDefinition(dto, {
      readFile: constReader(BUILTIN_YAML),
      dayBoundaryHour: 4,
    });
    expect(res.definition?.backend.tier).toBeNull();
  });

  it("overwrites definition.enabled with the runtime column value", () => {
    // File says enabled (default true); the disabled column must win.
    const res = loadEffectiveDefinition(makeDto({ enabled: false }), {
      readFile: constReader(BUILTIN_YAML),
      dayBoundaryHour: 4,
    });
    expect(res.definition?.enabled).toBe(false);
  });

  it("falls back to the registry when a built-in file fails to parse (frontmatter)", () => {
    const res = loadEffectiveDefinition(makeDto(), {
      readFile: constReader("not a frontmatter document"),
      dayBoundaryHour: 4,
    });
    expect(res.synthesized).toBe(true);
    expect(res.error).toMatch(/frontmatter/);
    expect(res.definition?.slug).toBe("morning-routine");
    expect(res.yaml).toBe("not a frontmatter document");
  });

  it("falls back to the registry when a built-in file fails schema validation (zod)", () => {
    const badSchema = `---
slug: morning-routine
name: Morning Routine
kind: builtin
schedule:
  kind: cron
backend:
  process_key: routine.morning_routine
limits: {}
---
`;
    const res = loadEffectiveDefinition(makeDto(), {
      readFile: constReader(badSchema),
      dayBoundaryHour: 4,
    });
    expect(res.synthesized).toBe(true);
    expect(res.error).toMatch(/schema validation failed/);
    expect(res.definition?.slug).toBe("morning-routine");
  });

  it("synthesises a built-in from the registry when the file is missing", () => {
    const res = loadEffectiveDefinition(makeDto({ enabled: false }), {
      readFile: constReader(null),
      dayBoundaryHour: 6,
    });
    expect(res.synthesized).toBe(true);
    expect(res.yaml).toBeNull();
    expect(res.error).toBeNull();
    // {dayBoundaryHour} substitution flows through the registry resolver.
    expect(res.definition?.schedule.expression).toBe("0 6 * * *");
    expect(res.definition?.enabled).toBe(false);
  });

  it("returns null + error for a corrupt built-in row whose slug has no registry entry", () => {
    const res = loadEffectiveDefinition(
      makeDto({ slug: "not-a-real-builtin", definitionPath: "/x/agent.md" }),
      { readFile: constReader(null), dayBoundaryHour: 4 },
    );
    expect(res.definition).toBeNull();
    expect(res.error).toMatch(/no registry entry/);
  });

  it("parses a valid user file (no override applied for user source)", () => {
    const dto = makeDto({
      slug: "my-task",
      source: "user",
      processKey: "agent.task",
      // A user row carrying a stray snapshot must NOT be merged (built-ins only).
      metadata: { override_snapshot: { "backend.tier": "high" } },
    });
    const res = loadEffectiveDefinition(dto, {
      readFile: constReader(USER_YAML),
      dayBoundaryHour: 4,
    });
    expect(res.definition?.kind).toBe("user");
    expect(res.definition?.backend.tier).toBeNull(); // snapshot ignored
  });

  it("returns null + error for an unparseable user file (no fallback)", () => {
    const res = loadEffectiveDefinition(
      makeDto({ slug: "my-task", source: "user", processKey: "agent.task" }),
      { readFile: constReader("garbage"), dayBoundaryHour: 4 },
    );
    expect(res.definition).toBeNull();
    expect(res.error).toMatch(/frontmatter/);
    expect(res.yaml).toBe("garbage");
  });

  it("returns null + error for a missing user file", () => {
    const res = loadEffectiveDefinition(
      makeDto({ slug: "my-task", source: "user", processKey: "agent.task" }),
      { readFile: constReader(null), dayBoundaryHour: 4 },
    );
    expect(res.definition).toBeNull();
    expect(res.error).toBe("definition file not found");
  });
});
