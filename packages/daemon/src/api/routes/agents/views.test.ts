import { describe, it, expect } from "vitest";
import { OVERRIDE_EDIT_PATHS } from "@aitne/shared";

import type { AgentDTO } from "../../../db/agents-store.js";
import type {
  AgentExecutionDTO,
  AgentMetricsWindow,
} from "../../../db/agent-executions-store.js";
import {
  buildDetail,
  buildListItem,
  buildRow,
  EDITABLE_NESTED,
  epochToIso,
  planCreate,
  planPatch,
  planRunNow,
  serializeExecution,
  serializeLastExecution,
  serializeListMetrics,
  serializeMetricsWindow,
} from "./views.js";

function makeDto(overrides: Partial<AgentDTO> = {}): AgentDTO {
  return {
    slug: "morning-routine",
    name: "Morning Routine",
    description: "Generate today.md.",
    source: "builtin",
    definitionPath: "/agents/morning-routine/agent.md",
    definitionHash: "abc",
    enabled: true,
    enabledOverriddenAt: null,
    processKey: "routine.morning_routine",
    scheduleKind: "cron",
    scheduleExpression: "0 4 * * *",
    scheduleTimezone: "America/New_York",
    tags: ["routine", "daily"],
    stopWarning: { level: "critical", services_lost: ["today.md"], dependent_agents: [] },
    recurringScheduleId: null,
    lastExecutionId: 12,
    metadata: { version_counter: 3 },
    invalid: false,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

function makeExecution(overrides: Partial<AgentExecutionDTO> = {}): AgentExecutionDTO {
  return {
    id: 42,
    agentId: "morning-routine",
    scheduleRowId: 7,
    trigger: "cron",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_060_000,
    result: "success",
    errorKind: null,
    errorMessage: null,
    costUsd: 0.18,
    tokensInput: 100,
    tokensOutput: 200,
    turns: 3,
    successCriteria: { today_md_populated: true },
    outputSummary: "today.md updated",
    ...overrides,
  };
}

function mw(overrides: Partial<AgentMetricsWindow> = {}): AgentMetricsWindow {
  return {
    executions: 7,
    errorRate: 0,
    avgCostUsd: 0.17,
    criteriaHitRate: 1,
    p95DurationSeconds: 60,
    ...overrides,
  };
}

describe("epochToIso", () => {
  it("converts epoch-ms to ISO and passes null through", () => {
    expect(epochToIso(1_700_000_000_000)).toBe("2023-11-14T22:13:20.000Z");
    expect(epochToIso(null)).toBeNull();
  });
});

describe("serializeExecution / serializeLastExecution", () => {
  it("serializes a full execution row with ISO timestamps", () => {
    const out = serializeExecution(makeExecution());
    expect(out).toMatchObject({
      id: 42,
      agent_id: "morning-routine",
      schedule_row_id: 7,
      trigger: "cron",
      result: "success",
      cost_usd: 0.18,
      tokens_input: 100,
      tokens_output: 200,
      turns: 3,
      success_criteria: { today_md_populated: true },
      output_summary: "today.md updated",
    });
    expect(out.started_at).toBe("2023-11-14T22:13:20.000Z");
    expect(out.ended_at).toBe("2023-11-14T22:14:20.000Z");
  });

  it("serializes a slim last-execution and null", () => {
    expect(serializeLastExecution(null)).toBeNull();
    const slim = serializeLastExecution(makeExecution({ endedAt: null }));
    expect(slim).toMatchObject({ id: 42, result: "success", cost_usd: 0.18 });
    expect(slim?.ended_at).toBeNull();
  });
});

describe("serializeMetricsWindow / serializeListMetrics", () => {
  it("includes p95 only in the full window", () => {
    expect(serializeMetricsWindow(mw())).toEqual({
      executions: 7,
      error_rate: 0,
      avg_cost_usd: 0.17,
      p95_duration_seconds: 60,
      criteria_hit_rate: 1,
    });
    expect(serializeListMetrics(mw())).toEqual({
      executions: 7,
      error_rate: 0,
      avg_cost_usd: 0.17,
      criteria_hit_rate: 1,
    });
  });
});

describe("buildListItem", () => {
  it("builds a valid item with last execution + metrics", () => {
    const item = buildListItem(makeDto(), {
      metrics7d: mw(),
      lastExecution: makeExecution(),
    });
    expect(item).toMatchObject({
      slug: "morning-routine",
      kind: "builtin",
      enabled: true,
      process_key: "routine.morning_routine",
      invalid: false,
    });
    expect(item.schedule).toEqual({
      kind: "cron",
      expression: "0 4 * * *",
      timezone: "America/New_York",
      interval: null,
    });
    expect(item.last_error).toBeUndefined();
  });

  it("surfaces the runtime-window interval cadence on schedule.interval", () => {
    const item = buildListItem(
      makeDto({ slug: "hourly-check", scheduleExpression: "0 4-23 * * *" }),
      {
        metrics7d: mw(),
        lastExecution: null,
        intervalCadence: { interval_minutes: 30, active_start_hour: 4, active_end_hour: 24 },
      },
    );
    expect(item.schedule).toEqual({
      kind: "cron",
      // The stored placeholder is preserved; the live cadence rides alongside.
      expression: "0 4-23 * * *",
      timezone: "America/New_York",
      interval: { interval_minutes: 30, active_start_hour: 4, active_end_hour: 24 },
    });
  });

  it("surfaces last_error for an invalid row carrying a string error", () => {
    const item = buildListItem(
      makeDto({ invalid: true, metadata: { last_error: "boom" } }),
      { metrics7d: mw(), lastExecution: null },
    );
    expect(item.invalid).toBe(true);
    expect(item.last_error).toBe("boom");
    expect(item.last_execution).toBeNull();
  });

  it("omits last_error when invalid but the error is not a string", () => {
    const item = buildListItem(makeDto({ invalid: true, metadata: {} }), {
      metrics7d: mw(),
      lastExecution: null,
    });
    expect(item.last_error).toBeUndefined();
  });

  it("coalesces a null description to \"\" (honours the dashboard's non-null contract)", () => {
    const item = buildListItem(makeDto({ description: null, invalid: true, metadata: { last_error: "bad yaml" } }), {
      metrics7d: mw(),
      lastExecution: null,
    });
    expect(item.description).toBe("");
    // The real failure is still surfaced separately.
    expect(item.last_error).toBe("bad yaml");
  });
});

describe("buildRow / buildDetail", () => {
  it("projects DB columns, including version_counter + override_snapshot", () => {
    const row = buildRow(
      makeDto({ metadata: { version_counter: 5, override_snapshot: { "backend.tier": "high" } } }),
    );
    expect(row).toMatchObject({
      slug: "morning-routine",
      source: "builtin",
      version_counter: 5,
      override_snapshot: { "backend.tier": "high" },
      created_at: 1000,
      updated_at: 2000,
    });
  });

  it("nulls version_counter + override_snapshot when absent", () => {
    const row = buildRow(makeDto({ metadata: {} }));
    expect(row.version_counter).toBeNull();
    expect(row.override_snapshot).toBeNull();
  });

  it("coalesces a null description to \"\" in the detail row", () => {
    const row = buildRow(makeDto({ description: null }));
    expect(row.description).toBe("");
  });

  it("defaults schedule_interval to null, and carries the cadence when supplied", () => {
    expect(buildRow(makeDto()).schedule_interval).toBeNull();
    const row = buildRow(makeDto({ slug: "hourly-check" }), {
      interval_minutes: 60,
      active_start_hour: 4,
      active_end_hour: 24,
    });
    expect(row.schedule_interval).toEqual({
      interval_minutes: 60,
      active_start_hour: 4,
      active_end_hour: 24,
    });
  });

  it("builds the full detail envelope", () => {
    const detail = buildDetail({
      dto: makeDto(),
      definition: null,
      definitionYaml: "---\nslug: x\n---\n",
      recentExecutions: [makeExecution()],
      metrics7d: mw(),
      metrics30d: mw({ executions: 30 }),
      byErrorKind7d: { quota: 0, tool: 1 },
    });
    expect(detail.agent).toBeNull();
    expect(detail.definition_yaml).toBe("---\nslug: x\n---\n");
    expect(detail.definition_path).toBe("/agents/morning-routine/agent.md");
    expect((detail.metrics as Record<string, unknown>)["30d"]).toMatchObject({ executions: 30 });
    expect((detail.metrics as Record<string, unknown>).by_error_kind_7d).toEqual({ quota: 0, tool: 1 });
    expect((detail.recent_executions as unknown[]).length).toBe(1);
    // No cadence supplied → the detail row's schedule_interval is null.
    expect((detail.row as Record<string, unknown>).schedule_interval).toBeNull();
  });

  it("threads the runtime-window cadence into the detail row", () => {
    const detail = buildDetail({
      dto: makeDto({ slug: "hourly-check" }),
      definition: null,
      definitionYaml: null,
      recentExecutions: [],
      metrics7d: mw(),
      metrics30d: mw(),
      byErrorKind7d: {},
      intervalCadence: { interval_minutes: 15, active_start_hour: 6, active_end_hour: 22 },
    });
    expect((detail.row as Record<string, unknown>).schedule_interval).toEqual({
      interval_minutes: 15,
      active_start_hour: 6,
      active_end_hour: 22,
    });
  });
});

describe("EDITABLE_NESTED", () => {
  it("covers exactly the shared OVERRIDE_EDIT_PATHS allow-list (4th consumer, drift-guarded)", () => {
    const flat = Object.entries(EDITABLE_NESTED).flatMap(([parent, leaves]) =>
      [...leaves].map((leaf) => `${parent}.${leaf}`),
    );
    expect(flat.sort()).toEqual([...OVERRIDE_EDIT_PATHS].sort());
  });
});

describe("planRunNow", () => {
  it("rejects an invalid Agent", () => {
    const plan = planRunNow(makeDto({ invalid: true }));
    expect(plan).toMatchObject({ ok: false, status: 409, error: "agent_invalid" });
  });

  it("rejects a no-LLM in-process pass (null process_key)", () => {
    const plan = planRunNow(makeDto({ slug: "roadmap-maintenance", processKey: null }));
    expect(plan).toMatchObject({ ok: false, status: 409, error: "agent_not_runnable" });
  });

  it("plans a built-in routine run with the routine marker + DM", () => {
    const plan = planRunNow(makeDto());
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("unreachable");
    expect(plan.taskType).toBe("routine.morning_routine");
    expect(plan.taskDescription).toBe("Morning Routine");
    expect(plan.taskPrompt).toBeNull();
    expect(plan.emitDm).toBe(true);
    expect(plan.taskContext).toMatchObject({
      agent_id: "morning-routine",
      trigger: "manual",
      processKey: "routine.morning_routine",
      routine: "morning_routine",
    });
    expect(plan.taskContext.phase).toBeUndefined();
  });

  it("stamps the sweep phase from the slug", () => {
    const evening = planRunNow(
      makeDto({ slug: "user-profile-sweep-evening", processKey: "routine.user_profile_sweep" }),
    );
    const morning = planRunNow(
      makeDto({ slug: "user-profile-sweep-morning", processKey: "routine.user_profile_sweep" }),
    );
    if (!evening.ok || !morning.ok) throw new Error("unreachable");
    expect(evening.taskContext.phase).toBe("evening");
    expect(morning.taskContext.phase).toBe("morning");
  });

  it("omits the routine marker for a built-in with a non-routine process key", () => {
    const plan = planRunNow(makeDto({ processKey: "custom.thing" }));
    if (!plan.ok) throw new Error("unreachable");
    expect(plan.taskContext.routine).toBeUndefined();
  });

  it("stamps trigger_note into task_context only when supplied (§9.4)", () => {
    const withNote = planRunNow(makeDto(), { triggerNote: "manual smoke" });
    if (!withNote.ok) throw new Error("unreachable");
    expect(withNote.taskContext.trigger_note).toBe("manual smoke");

    const withoutNote = planRunNow(makeDto());
    if (!withoutNote.ok) throw new Error("unreachable");
    expect(withoutNote.taskContext.trigger_note).toBeUndefined();
  });

  it("carries the recurring prompt for a user Agent and no DM", () => {
    const withPrompt = planRunNow(
      makeDto({ slug: "my-task", source: "user", processKey: "agent.task", recurringScheduleId: 9 }),
      { taskPrompt: "Do the thing" },
    );
    const withoutPrompt = planRunNow(
      makeDto({ slug: "my-task", source: "user", processKey: "agent.task" }),
    );
    if (!withPrompt.ok || !withoutPrompt.ok) throw new Error("unreachable");
    expect(withPrompt.taskPrompt).toBe("Do the thing");
    expect(withPrompt.emitDm).toBe(false);
    expect(withPrompt.taskContext.routine).toBeUndefined();
    expect(withoutPrompt.taskPrompt).toBeNull();
  });

  it("surfaces a user Agent's backend/model/tier pin so run-now matches a cron fire", () => {
    // Engine-only pin: backendId set, model null. The plan must carry the pin
    // into the insert payload (regression guard for run-now ignoring the
    // Agent's backend — manual runs must route like cron fires).
    const plan = planRunNow(
      makeDto({ slug: "my-task", source: "user", processKey: "agent.task", recurringScheduleId: 9 }),
      { backendId: "codex", model: null, tier: "lite" },
    );
    if (!plan.ok) throw new Error("unreachable");
    expect(plan.backendId).toBe("codex");
    expect(plan.model).toBeNull();
    expect(plan.tier).toBe("lite");
  });

  it("never leaks a routing pin onto a built-in's manual run", () => {
    // Built-ins resolve their backend from the process key; even if opts carry a
    // pin (they never should), the plan must null it out.
    const plan = planRunNow(makeDto({ source: "builtin" }), {
      backendId: "codex",
      model: "gpt-5-codex",
      tier: "high",
    });
    if (!plan.ok) throw new Error("unreachable");
    expect(plan.backendId).toBeNull();
    expect(plan.model).toBeNull();
    expect(plan.tier).toBeNull();
  });
});

describe("planPatch — enabled toggle", () => {
  it("rejects a non-boolean enabled", () => {
    expect(planPatch(makeDto(), { enabled: "yes" })).toMatchObject({
      ok: false,
      status: 400,
      error: "invalid_enabled",
    });
  });

  it("requires ack_warning to disable a built-in", () => {
    const plan = planPatch(makeDto(), { enabled: false });
    expect(plan).toMatchObject({ ok: false, status: 409, error: "stop_warning_required" });
    if (plan.ok) throw new Error("unreachable");
    if (plan.status !== 409) throw new Error("unreachable");
    expect(plan.warning).toMatchObject({ level: "critical" });
  });

  it("disables a built-in with ack_warning", () => {
    const plan = planPatch(makeDto(), { enabled: false, ack_warning: true });
    expect(plan).toMatchObject({ ok: true, setEnabled: false });
  });

  it("enables without an ack", () => {
    expect(planPatch(makeDto({ enabled: false }), { enabled: true })).toMatchObject({
      ok: true,
      setEnabled: true,
    });
  });

  it("treats a same-state enabled value as a no-op (no ack gate, no setEnabled)", () => {
    // Re-disabling an already-stopped built-in is not a transition (§12.2), so
    // the stop-warning ack gate must NOT fire and no enabled write is planned.
    const reDisable = planPatch(makeDto({ enabled: false }), { enabled: false });
    expect(reDisable.ok).toBe(true);
    expect((reDisable as { setEnabled?: boolean }).setEnabled).toBeUndefined();
    // A no-op enabled still lets a built-in override edit through.
    const withOverride = planPatch(makeDto({ enabled: true }), {
      enabled: true,
      backend: { tier: "high" },
    });
    expect(withOverride).toMatchObject({ ok: true, overrideSet: { "backend.tier": "high" } });
    expect((withOverride as { setEnabled?: boolean }).setEnabled).toBeUndefined();
  });

  it("mirrors a user Agent's enabled toggle onto its recurring row", () => {
    const withRow = planPatch(
      makeDto({ source: "user", processKey: "agent.task", recurringScheduleId: 5 }),
      { enabled: false },
    );
    const withoutRow = planPatch(
      makeDto({ source: "user", processKey: "agent.task", recurringScheduleId: null }),
      { enabled: false },
    );
    expect(withRow).toMatchObject({ ok: true, setEnabled: false, mirrorRecurringEnabled: false });
    if (withoutRow.ok !== true) throw new Error("unreachable");
    expect(withoutRow.mirrorRecurringEnabled).toBeUndefined();
  });
});

describe("planPatch — built-in override edits", () => {
  it("collects valid override edits into overrideSet", () => {
    const plan = planPatch(makeDto(), {
      backend: { tier: "high", model: "claude-opus-4-8" },
      limits: { max_turns: 30, max_budget_usd: 0, timeout_minutes: 15 },
      on_error: { notify_owner: true },
    });
    if (!plan.ok) throw new Error("unreachable");
    expect(plan.overrideSet).toEqual({
      "backend.tier": "high",
      "backend.model": "claude-opus-4-8",
      "limits.max_turns": 30,
      "limits.max_budget_usd": 0,
      "limits.timeout_minutes": 15,
      "on_error.notify_owner": true,
    });
    expect(plan.stripped).toEqual([]);
  });

  it("accepts null tier and null model (defer to process_backend_config)", () => {
    const plan = planPatch(makeDto(), { backend: { tier: null, model: null } });
    if (!plan.ok) throw new Error("unreachable");
    expect(plan.overrideSet).toEqual({ "backend.tier": null, "backend.model": null });
  });

  it.each([
    ["backend.tier invalid string", { backend: { tier: "ultra" } }, "backend.tier"],
    ["backend.tier non-string", { backend: { tier: 1 } }, "backend.tier"],
    ["backend.model empty string", { backend: { model: "" } }, "backend.model"],
    ["limits.max_turns non-integer", { limits: { max_turns: 1.5 } }, "limits.max_turns"],
    ["limits.max_turns non-number", { limits: { max_turns: "10" } }, "limits.max_turns"],
    ["limits.max_turns zero", { limits: { max_turns: 0 } }, "limits.max_turns"],
    ["limits.timeout_minutes zero", { limits: { timeout_minutes: 0 } }, "limits.timeout_minutes"],
    ["limits.max_budget_usd negative", { limits: { max_budget_usd: -1 } }, "limits.max_budget_usd"],
    ["limits.max_budget_usd infinite", { limits: { max_budget_usd: Infinity } }, "limits.max_budget_usd"],
    ["on_error.notify_owner non-boolean", { on_error: { notify_owner: "yes" } }, "on_error.notify_owner"],
  ])("rejects %s", (_label, body, field) => {
    expect(planPatch(makeDto(), body as Record<string, unknown>)).toMatchObject({
      ok: false,
      status: 400,
      error: "invalid_field_value",
      field,
    });
  });

  it("strips read-only top-level + nested keys, keeping the valid edit", () => {
    const plan = planPatch(makeDto(), {
      name: "Renamed",
      process_key: "routine.x",
      backend: { tier: "medium", process_key: "routine.y", backend_id: "codex" },
      on_error: { retries: 2 },
    });
    if (!plan.ok) throw new Error("unreachable");
    expect(plan.overrideSet).toEqual({ "backend.tier": "medium" });
    expect(plan.stripped).toEqual(
      expect.arrayContaining(["name", "process_key", "backend.process_key", "backend.backend_id", "on_error.retries"]),
    );
  });

  it("strips a non-object editable parent block", () => {
    const plan = planPatch(makeDto(), { backend: "oops" });
    if (!plan.ok) throw new Error("unreachable");
    expect(plan.stripped).toContain("backend");
    expect(plan.overrideSet).toEqual({});
  });
});

describe("planPatch — reset", () => {
  it("plans a reset of override paths", () => {
    const plan = planPatch(makeDto(), { reset: ["limits.max_budget_usd", "backend.tier"] });
    expect(plan).toMatchObject({
      ok: true,
      overrideReset: ["limits.max_budget_usd", "backend.tier"],
    });
  });

  it("rejects a non-array reset", () => {
    expect(planPatch(makeDto(), { reset: "limits.max_turns" })).toMatchObject({
      ok: false,
      error: "invalid_reset",
    });
  });

  it("rejects a reset array with a non-string element", () => {
    expect(planPatch(makeDto(), { reset: [1] })).toMatchObject({
      ok: false,
      error: "invalid_reset",
    });
  });

  it("rejects an unknown reset path", () => {
    expect(planPatch(makeDto(), { reset: ["enabled"] })).toMatchObject({
      ok: false,
      error: "invalid_reset_path",
      field: "enabled",
    });
  });
});

describe("planPatch — user Agent field edits routed to the file", () => {
  it("rejects field edits on a user Agent", () => {
    expect(
      planPatch(makeDto({ source: "user", processKey: "agent.task" }), {
        limits: { max_turns: 5 },
      }),
    ).toMatchObject({ ok: false, status: 400, error: "user_agent_edit_via_file" });
  });

  it("rejects a reset on a user Agent", () => {
    expect(
      planPatch(makeDto({ source: "user", processKey: "agent.task" }), {
        reset: ["backend.tier"],
      }),
    ).toMatchObject({ ok: false, error: "user_agent_edit_via_file" });
  });

  it("returns an empty no-op plan when the body carries nothing actionable", () => {
    const plan = planPatch(makeDto(), {});
    expect(plan).toEqual({ ok: true, overrideSet: {}, overrideReset: [], stripped: [] });
  });
});

describe("planCreate (POST /api/agents)", () => {
  const NONE: ReadonlySet<string> = new Set<string>();

  function cronBody(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      slug: "daily-triage",
      name: "Daily Triage",
      description: "Triage the inbox every morning.",
      schedule: { kind: "cron", expression: "0 9 * * *", timezone: "Asia/Tokyo" },
      backend: { tier: "medium" },
      prompt: "## Goal\nTriage inbox.\n## Steps\n1. Read.\n2. Act.",
      ...over,
    };
  }

  it("renders a valid recurring agent.md and defaults process_key to agent.task", () => {
    const plan = planCreate(cronBody(), NONE);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.slug).toBe("daily-triage");
    expect(plan.markdown).toContain("slug: daily-triage");
    expect(plan.markdown).toContain("kind: user");
    expect(plan.markdown).toContain("process_key: agent.task");
    expect(plan.markdown).toContain("expression: 0 9 * * *");
    expect(plan.markdown).toContain("## Goal");
  });

  it("honours an explicit process_key", () => {
    const plan = planCreate(cronBody({ backend: { process_key: "routine.custom.foo" } }), NONE);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.markdown).toContain("process_key: routine.custom.foo");
  });

  it("requires a slug (missing and empty)", () => {
    expect(planCreate({ name: "X", schedule: { kind: "cron", expression: "0 9 * * *" } }, NONE))
      .toMatchObject({ ok: false, status: 400, error: "slug_required", field: "slug" });
    expect(planCreate({ slug: "", name: "X", schedule: { kind: "cron", expression: "0 9 * * *" } }, NONE))
      .toMatchObject({ ok: false, error: "slug_required" });
    // A non-string slug is treated as absent.
    expect(planCreate({ slug: 42, name: "X", schedule: { kind: "cron", expression: "0 9 * * *" } }, NONE))
      .toMatchObject({ ok: false, error: "slug_required" });
  });

  it("requires a name (missing and empty)", () => {
    expect(planCreate({ slug: "x", schedule: { kind: "cron", expression: "0 9 * * *" } }, NONE))
      .toMatchObject({ ok: false, status: 400, error: "name_required", field: "name" });
    expect(planCreate({ slug: "x", name: "", schedule: { kind: "cron", expression: "0 9 * * *" } }, NONE))
      .toMatchObject({ ok: false, error: "name_required" });
  });

  it("requires a schedule object (missing, string, array, null)", () => {
    expect(planCreate({ slug: "x", name: "X" }, NONE))
      .toMatchObject({ ok: false, status: 400, error: "schedule_required", field: "schedule" });
    // A non-object schedule (string / array / null) is treated as absent —
    // exercises every `asRecord` reject branch (non-object, array, null).
    expect(planCreate({ slug: "x", name: "X", schedule: "0 9 * * *" }, NONE))
      .toMatchObject({ ok: false, error: "schedule_required" });
    expect(planCreate({ slug: "x", name: "X", schedule: ["cron"] }, NONE))
      .toMatchObject({ ok: false, error: "schedule_required" });
    expect(planCreate({ slug: "x", name: "X", schedule: null }, NONE))
      .toMatchObject({ ok: false, error: "schedule_required" });
  });

  it("treats a null/non-object backend as absent (defaults process_key)", () => {
    const plan = planCreate(cronBody({ backend: null }), NONE);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.markdown).toContain("process_key: agent.task");
  });

  it("reaches the assembly with description omitted, then the schema rejects it", () => {
    // Exercises the `description` optional-spread's absent branch; the schema
    // requires description (`z.string().min(1)`), so the assembled frontmatter
    // then fails validation with a field-keyed issue.
    const { description: _drop, ...noDesc } = cronBody();
    void _drop;
    const plan = planCreate(noDesc, NONE);
    if (plan.ok || plan.status !== 400) throw new Error("expected invalid_definition");
    expect(plan.error).toBe("invalid_definition");
    expect(plan.issues?.some((i) => i.field === "description")).toBe(true);
  });

  it("carries every optional field through into the rendered frontmatter", () => {
    const plan = planCreate(
      cronBody({
        enabled: false,
        backend: { process_key: "agent.task", tier: "high", model: null, backend_id: "claude" },
        limits: { max_turns: 5, max_budget_usd: 1, timeout_minutes: 30 },
        tags: ["ops", "daily"],
        outputs: ["state/today.md"],
        tools: { allowed: ["Read"], skills: ["context"] },
        on_error: { notify_owner: true, retries: 1 },
        success_criteria: [{ id: "wrote", kind: "file_exists", target: "state/today.md" }],
      }),
      NONE,
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.markdown).toContain("enabled: false");
    expect(plan.markdown).toContain("backend_id: claude");
    expect(plan.markdown).toContain("max_turns: 5");
    expect(plan.markdown).toContain("ops");
    expect(plan.markdown).toContain("state/today.md");
  });

  it("rejects a one_shot schedule with a pointer to /schedule", () => {
    const plan = planCreate(
      { slug: "x", name: "X", schedule: { kind: "one_shot", one_shot_at: "2099-01-01T00:00:00Z" } },
      NONE,
    );
    expect(plan).toMatchObject({ ok: false, status: 400, error: "one_shot_not_supported", field: "schedule.kind" });
    if (!plan.ok && plan.status === 400) expect(plan.hint).toContain("/api/schedule");
  });

  it("rejects an event schedule (non-cron)", () => {
    expect(
      planCreate({ slug: "x", name: "X", schedule: { kind: "event", event_ref: "pr.opened" } }, NONE),
    ).toMatchObject({ ok: false, status: 400, error: "one_shot_not_supported" });
  });

  it("renders a structured hourly recurrence to the every-hour cron", () => {
    const plan = planCreate(
      cronBody({
        schedule: {
          kind: "recurring",
          recurrence: { frequency: "hourly", intervalHours: 1, minuteOfHour: 0 },
          timezone: "Asia/Tokyo",
        },
      }),
      NONE,
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.markdown).toContain("kind: cron");
    expect(plan.markdown).toContain("expression: 0 * * * *");
    expect(plan.markdown).toContain("timezone: Asia/Tokyo");
  });

  it("renders a structured every-N-hours recurrence to the step-form cron", () => {
    const plan = planCreate(
      cronBody({
        schedule: {
          kind: "recurring",
          recurrence: { frequency: "hourly", intervalHours: 2, minuteOfHour: 30 },
        },
      }),
      NONE,
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.markdown).toContain("expression: 30 */2 * * *");
  });

  it("renders a structured daily recurrence and takes the timezone from the rule", () => {
    const plan = planCreate(
      cronBody({
        schedule: {
          kind: "recurring",
          recurrence: { frequency: "daily", time: "09:00", timezone: "America/New_York" },
        },
      }),
      NONE,
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.markdown).toContain("expression: 0 9 * * *");
    expect(plan.markdown).toContain("timezone: America/New_York");
  });

  it("omits the timezone when neither the schedule nor the recurrence carries one", () => {
    const plan = planCreate(
      cronBody({
        schedule: { kind: "recurring", recurrence: { frequency: "daily", time: "07:30" } },
      }),
      NONE,
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.markdown).toContain("expression: 30 7 * * *");
    expect(plan.markdown).not.toContain("timezone:");
  });

  it("rejects an invalid recurrence with field-keyed issues", () => {
    // `time` is forbidden for hourly frequency (recurrenceRuleSchema superRefine).
    const plan = planCreate(
      cronBody({
        schedule: { kind: "recurring", recurrence: { frequency: "hourly", time: "09:00" } },
      }),
      NONE,
    );
    if (plan.ok || plan.status !== 400) throw new Error("expected invalid_recurrence");
    expect(plan.error).toBe("invalid_recurrence");
    expect(plan.issues?.some((i) => i.field === "schedule.recurrence.time")).toBe(true);
  });

  it("rejects a recurring schedule with no recurrence object", () => {
    const plan = planCreate(cronBody({ schedule: { kind: "recurring" } }), NONE);
    expect(plan).toMatchObject({ ok: false, status: 400, error: "invalid_recurrence" });
  });

  it("reports a slug collision (409)", () => {
    expect(planCreate(cronBody(), new Set(["daily-triage"])))
      .toMatchObject({ ok: false, status: 409, error: "slug_collision", slug: "daily-triage" });
  });

  it("rejects a schema-invalid definition with field issues", () => {
    // An invalid slug pattern fails the schema's slug validation.
    const plan = planCreate(cronBody({ slug: "Bad Slug With Spaces" }), NONE);
    if (plan.ok || plan.status !== 400) throw new Error("expected a 400 invalid_definition plan");
    expect(plan.error).toBe("invalid_definition");
    expect(Array.isArray(plan.issues)).toBe(true);
    expect(plan.issues!.length).toBeGreaterThan(0);
  });

  it("renders an empty body when no prompt is supplied", () => {
    const plan = planCreate(cronBody({ prompt: undefined }), NONE);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // The frontmatter still renders; body is just blank.
    expect(plan.markdown).toContain("slug: daily-triage");
  });
});
