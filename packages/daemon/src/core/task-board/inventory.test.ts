import { describe, it, expect } from "vitest";
import { assembleInventory } from "./inventory.js";
import type { InventorySources, PendingOneOff } from "./inventory.js";
import type { RecurringScheduleDTO } from "../../db/recurring-schedules.js";
import type { AgentDTO } from "../../db/agents-store.js";
import type { AgentExecutionDTO } from "../../db/agent-executions-store.js";
import type { AutomationTriggerDTO } from "../../db/automation-triggers.js";
import type { ManagedTask } from "@aitne/shared";
import type { BackgroundTaskRow } from "../../db/background-task-store.js";
import type { BrowserTaskRow } from "../../db/browser-task-store.js";

// ── factories (partial + cast — the projection reads only a subset) ──

function rs(over: Partial<RecurringScheduleDTO>): RecurringScheduleDTO {
  return {
    id: 1,
    taskType: "dm_session",
    description: "Morning briefing — daily summary",
    prompt: null,
    recurrenceRule: { frequency: "daily" } as unknown,
    model: null,
    tier: null,
    backendId: null,
    enabled: true,
    nextRunAt: "2026-07-01 08:00:00",
    recurrenceLabel: "daily 08:00",
    taskContext: {},
    createdAt: "",
    updatedAt: "",
    ...over,
  } as RecurringScheduleDTO;
}

function agent(over: Partial<AgentDTO>): AgentDTO {
  return {
    slug: "weekly-digest",
    name: "Weekly market digest",
    source: "user",
    enabled: true,
    scheduleKind: "cron",
    scheduleExpression: "0 9 * * 1",
    recurringScheduleId: null,
    invalid: false,
    ...over,
  } as unknown as AgentDTO;
}

function mt(over: Partial<ManagedTask>): ManagedTask {
  return {
    id: "mt_3",
    intent: "Zoom recordings sweep",
    app: "zoom",
    app_normalized: "zoom",
    cadence: "daily 10:00 (Asia/Tokyo)",
    output_path: "work/meetings/",
    schedule_id: 51,
    last_run_at: "2026-06-28 10:00:00",
    last_result: "ok",
    consecutive_failures: 0,
    created_at: "",
    updated_at: "",
    ...over,
  } as ManagedTask;
}

function bg(over: Partial<BackgroundTaskRow>): BackgroundTaskRow {
  return {
    id: "bg-uuid-1",
    brief: "Research flight prices",
    title: null,
    state: "running",
    outcomeDetail: null,
    finishedAt: null,
    ...over,
  } as unknown as BackgroundTaskRow;
}

function bx(over: Partial<BrowserTaskRow>): BrowserTaskRow {
  return {
    id: "bx-uuid-1",
    description: "Fill the renewal form",
    state: "awaiting_user",
    outcomeDetail: null,
    finishedAt: null,
    ...over,
  } as unknown as BrowserTaskRow;
}

function trg(over: Partial<AutomationTriggerDTO>): AutomationTriggerDTO {
  return {
    id: 9,
    domain: "git",
    eventType: "cron.daily",
    prompt: "Sweep stale branches across active repos",
    enabled: true,
    recurringScheduleId: 51,
    nextRunAt: "2026-07-02 09:00:00",
    lastRunStartedAt: "2026-07-01 09:00:00",
    lastRunResult: "success",
    ...over,
  } as unknown as AutomationTriggerDTO;
}

function exec(over: Partial<AgentExecutionDTO>): AgentExecutionDTO {
  return {
    id: 1,
    agentId: "weekly-digest",
    result: "success",
    outputSummary: "3 repos swept",
    startedAt: 1751200000000,
    endedAt: 1751200060000,
    ...over,
  } as unknown as AgentExecutionDTO;
}

function emptySources(over: Partial<InventorySources>): InventorySources {
  return {
    recurringDmSessions: [],
    agents: [],
    lastExecutionByAgent: new Map(),
    inFlightAgentSlugs: new Set(),
    automationTriggers: [],
    managedTasks: [],
    recurringById: new Map(),
    pendingOneOffs: [],
    backgroundTasks: [],
    browserTasks: [],
    ...over,
  };
}

describe("assembleInventory — dm", () => {
  it("projects a dm_session row, system origin for the briefing", () => {
    const items = assembleInventory(
      emptySources({
        recurringDmSessions: [rs({ id: 42, taskContext: { sub_flow: "morning_briefing" } })],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      ref: "rs:42",
      kind: "dm",
      status: "active",
      origin: "system",
      cadence: "daily 08:00",
      fulfilledBy: "rs:42",
      nextRunAt: "2026-07-01 08:00:00",
    });
  });

  it("marks a disabled non-briefing dm row paused/user", () => {
    const [item] = assembleInventory(
      emptySources({ recurringDmSessions: [rs({ id: 5, enabled: false, taskContext: {} })] }),
    );
    expect(item.status).toBe("paused");
    expect(item.origin).toBe("user");
  });

  it("drops a dm_session already owned by an Agent (no double-listing)", () => {
    // An auto-imported `imported-<id>` Agent references the same dm_session row.
    // The board must surface it once, via the Agent (canonical owner), not twice.
    const items = assembleInventory(
      emptySources({
        recurringDmSessions: [rs({ id: 2, description: "Evening daily summary" })],
        agents: [agent({ slug: "imported-2", recurringScheduleId: 2 })],
        recurringById: new Map([[2, rs({ id: 2, recurrenceLabel: "Daily at 19:00" })]]),
      }),
    );
    expect(items.map((i) => i.ref)).toEqual(["agent:imported-2"]);
    expect(items.filter((i) => i.kind === "dm")).toHaveLength(0);
    expect(items[0].cadence).toBe("Daily at 19:00");
  });

  it("keeps an orphan dm_session that no Agent references", () => {
    const items = assembleInventory(
      emptySources({
        recurringDmSessions: [rs({ id: 2 }), rs({ id: 9 })],
        // An Agent referencing a *different* schedule must not shadow rs:2/rs:9.
        agents: [agent({ slug: "weekly-digest", recurringScheduleId: 77 })],
        recurringById: new Map([[77, rs({ id: 77, taskType: "agent.task" })]]),
      }),
    );
    expect(items.filter((i) => i.kind === "dm").map((i) => i.ref)).toEqual(["rs:2", "rs:9"]);
  });
});

describe("assembleInventory — agent", () => {
  it("uses the paired recurring row's cadence + next run", () => {
    const paired = rs({ id: 51, taskType: "agent.task", recurrenceLabel: "Mon 09:00", nextRunAt: "2026-07-06 09:00:00" });
    const [item] = assembleInventory(
      emptySources({
        agents: [agent({ recurringScheduleId: 51 })],
        recurringById: new Map([[51, paired]]),
      }),
    );
    expect(item).toMatchObject({ ref: "agent:weekly-digest", kind: "agent", cadence: "Mon 09:00", nextRunAt: "2026-07-06 09:00:00" });
  });

  it("falls back to the cron expression when there is no paired row", () => {
    const [item] = assembleInventory(emptySources({ agents: [agent({ recurringScheduleId: null })] }));
    expect(item.cadence).toBe("0 9 * * 1");
    expect(item.nextRunAt).toBeNull();
  });

  it("falls back to null cadence and flags invalid/disabled agents", () => {
    const invalid = assembleInventory(emptySources({ agents: [agent({ invalid: true, scheduleExpression: null })] }));
    expect(invalid[0].status).toBe("invalid");
    expect(invalid[0].cadence).toBeNull();
    const disabled = assembleInventory(emptySources({ agents: [agent({ enabled: false })] }));
    expect(disabled[0].status).toBe("paused");
  });

  it("shows paused when the paired row is disabled, even if the Agent flag is on", () => {
    // The scheduler fires from the paired row's `enabled`; an enabled Agent
    // whose satellite row is paused does not run. With the satellite hidden by
    // the dedup, the Agent item is the only surface left — it must not claim
    // "active" for a schedule that never fires.
    const [item] = assembleInventory(
      emptySources({
        agents: [agent({ enabled: true, recurringScheduleId: 51 })],
        recurringById: new Map([[51, rs({ id: 51, taskType: "agent.task", enabled: false })]]),
      }),
    );
    expect(item.status).toBe("paused");
  });

  it("stays active when both the Agent and its paired row are enabled", () => {
    const [item] = assembleInventory(
      emptySources({
        agents: [agent({ enabled: true, recurringScheduleId: 51 })],
        recurringById: new Map([[51, rs({ id: 51, taskType: "agent.task", enabled: true })]]),
      }),
    );
    expect(item.status).toBe("active");
  });

  it("tags built-in agents origin:system and user agents origin:user", () => {
    const items = assembleInventory(
      emptySources({
        agents: [
          agent({ slug: "morning-routine", source: "builtin" }),
          agent({ slug: "weekly-digest", source: "user" }),
        ],
      }),
    );
    const byRef = Object.fromEntries(items.map((i) => [i.ref, i]));
    expect(byRef["agent:morning-routine"].origin).toBe("system");
    expect(byRef["agent:weekly-digest"].origin).toBe("user");
  });

  it("shows running while an execution is in flight — even mid-disable", () => {
    // A run already in motion is the truth of "what is happening now";
    // it outranks the enabled flags (but never the invalid flag).
    const [running] = assembleInventory(
      emptySources({
        agents: [agent({ enabled: false })],
        inFlightAgentSlugs: new Set(["weekly-digest"]),
      }),
    );
    expect(running.status).toBe("running");
    const [invalid] = assembleInventory(
      emptySources({
        agents: [agent({ invalid: true })],
        inFlightAgentSlugs: new Set(["weekly-digest"]),
      }),
    );
    expect(invalid.status).toBe("invalid");
  });

  it("projects the last execution's summary + end time (data /api/agents always had)", () => {
    const [item] = assembleInventory(
      emptySources({
        agents: [agent({})],
        lastExecutionByAgent: new Map([["weekly-digest", exec({})]]),
      }),
    );
    expect(item.lastResult).toBe("3 repos swept");
    expect(item.lastRunAt).toBe(new Date(1751200060000).toISOString());
  });

  it("falls back to the result word without a summary, and start time without an end", () => {
    const [item] = assembleInventory(
      emptySources({
        agents: [agent({})],
        lastExecutionByAgent: new Map([
          ["weekly-digest", exec({ outputSummary: null, result: "error", endedAt: null })],
        ]),
      }),
    );
    expect(item.lastResult).toBe("error");
    expect(item.lastRunAt).toBe(new Date(1751200000000).toISOString());
  });
});

describe("assembleInventory — trigger", () => {
  it("projects an automation trigger through its paired schedule", () => {
    const [item] = assembleInventory(
      emptySources({
        automationTriggers: [trg({})],
        recurringById: new Map([
          [51, rs({ id: 51, taskType: "agent.task", recurrenceLabel: "daily 09:00" })],
        ]),
      }),
    );
    expect(item).toMatchObject({
      ref: "trigger:9",
      kind: "trigger",
      status: "active",
      cadence: "daily 09:00",
      fulfilledBy: "rs:51",
      origin: "user",
      lastResult: "success",
      lastRunAt: "2026-07-01 09:00:00",
      nextRunAt: "2026-07-02 09:00:00",
    });
    expect(item.title).toBe("Sweep stale branches across active repos");
  });

  it("paused when disabled; self-fulfilled with a title fallback when the schedule ref was severed", () => {
    const [item] = assembleInventory(
      emptySources({
        automationTriggers: [
          trg({ enabled: false, recurringScheduleId: null, prompt: "", nextRunAt: null }),
        ],
      }),
    );
    expect(item).toMatchObject({
      ref: "trigger:9",
      status: "paused",
      cadence: null,
      fulfilledBy: "trigger:9",
      nextRunAt: null,
    });
    expect(item.title).toBe("git automation");
  });
});

describe("assembleInventory — app_fetch", () => {
  it("chains fulfilledBy to the recurring schedule and carries last-run state", () => {
    const [item] = assembleInventory(
      emptySources({
        managedTasks: [mt({})],
        recurringById: new Map([[51, rs({ id: 51, enabled: true })]]),
      }),
    );
    expect(item).toMatchObject({
      ref: "mt_3",
      kind: "app_fetch",
      status: "active",
      fulfilledBy: "rs:51",
      cadence: "daily 10:00 (Asia/Tokyo)",
      lastResult: "ok",
      lastRunAt: "2026-06-28 10:00:00",
    });
  });

  it("paused when the paired row is disabled; active when the paired row is missing", () => {
    const paused = assembleInventory(
      emptySources({ managedTasks: [mt({})], recurringById: new Map([[51, rs({ id: 51, enabled: false })]]) }),
    );
    expect(paused[0].status).toBe("paused");
    const orphan = assembleInventory(emptySources({ managedTasks: [mt({})] }));
    expect(orphan[0].status).toBe("active");
    expect(orphan[0].nextRunAt).toBeNull();
  });
});

describe("assembleInventory — reminder", () => {
  const base: PendingOneOff = {
    id: 8190,
    scheduledFor: "2026-06-30 15:00:00",
    taskType: "dm_session",
    taskDescription: "call dentist",
    taskPrompt: null,
    taskContext: {},
  };

  it("projects a pending one-off, user origin", () => {
    const [item] = assembleInventory(emptySources({ pendingOneOffs: [base] }));
    expect(item).toMatchObject({
      ref: "as:8190",
      kind: "reminder",
      status: "pending",
      cadence: "one-off",
      origin: "user",
      nextRunAt: "2026-06-30 15:00:00",
    });
  });

  it("agent origin when a sub_flow is present; prompt/fallback titles", () => {
    const agentOrigin = assembleInventory(
      emptySources({ pendingOneOffs: [{ ...base, taskDescription: null, taskContext: { sub_flow: "confirm" } }] }),
    );
    expect(agentOrigin[0].origin).toBe("agent");
    expect(agentOrigin[0].title).toBe("Reminder"); // no description, no prompt
    const fromPrompt = assembleInventory(
      emptySources({ pendingOneOffs: [{ ...base, taskDescription: null, taskPrompt: "ping me" }] }),
    );
    expect(fromPrompt[0].title).toBe("ping me");
  });

  it("honours an explicit ctx.origin (deferred background/browser one-offs carry one)", () => {
    const explicit = assembleInventory(
      emptySources({
        pendingOneOffs: [
          { ...base, taskType: "background_task", taskContext: { origin: "user", preGeneratedTaskId: "x" } },
        ],
      }),
    );
    expect(explicit[0].origin).toBe("user");
    // A bogus value falls back to the sub_flow heuristic, not a crash.
    const bogus = assembleInventory(
      emptySources({
        pendingOneOffs: [{ ...base, taskContext: { origin: "martian", sub_flow: "confirm" } }],
      }),
    );
    expect(bogus[0].origin).toBe("agent");
  });
});

describe("assembleInventory — fulfillers", () => {
  it("projects background tasks, normalising the finished timestamp", () => {
    const [item] = assembleInventory(
      emptySources({ backgroundTasks: [bg({ title: "Digest run", state: "running", finishedAt: 1751200000000, outcomeDetail: "wip" })] }),
    );
    expect(item).toMatchObject({ ref: "bt:bg-uuid-1", kind: "background", status: "running", lastResult: "wip" });
    expect(item.lastRunAt).toBe(new Date(1751200000000).toISOString());
  });

  it("background title falls back to brief", () => {
    const [item] = assembleInventory(emptySources({ backgroundTasks: [bg({ title: null })] }));
    expect(item.title).toBe("Research flight prices");
  });

  it("projects browser tasks and truncates a long description", () => {
    const long = "x".repeat(140);
    const [item] = assembleInventory(emptySources({ browserTasks: [bx({ description: long })] }));
    expect(item.kind).toBe("browser");
    expect(item.title.endsWith("…")).toBe(true);
    expect(item.title.length).toBeLessThanOrEqual(101);
  });

  it("reads the recorded origin off the row, defaulting legacy rows to agent", () => {
    const items = assembleInventory(
      emptySources({
        backgroundTasks: [bg({ origin: "user" })],
        // Pre-migration row shape without the column → historical assumption.
        browserTasks: [bx({})],
      }),
    );
    expect(items.find((i) => i.kind === "background")?.origin).toBe("user");
    expect(items.find((i) => i.kind === "browser")?.origin).toBe("agent");
  });
});

describe("assembleInventory — ordering", () => {
  it("groups by kind in a fixed order and sorts numerically within a group", () => {
    const items = assembleInventory(
      emptySources({
        recurringDmSessions: [rs({ id: 42 }), rs({ id: 7 })],
        agents: [agent({ slug: "z" }), agent({ slug: "a" })],
        automationTriggers: [trg({ id: 9, recurringScheduleId: null })],
        browserTasks: [bx({ id: "c" })],
      }),
    );
    expect(items.map((i) => i.ref)).toEqual([
      "rs:7",
      "rs:42",
      "agent:a",
      "agent:z",
      "trigger:9",
      "bx:c",
    ]);
  });
});
