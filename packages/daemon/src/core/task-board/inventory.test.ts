import { describe, it, expect } from "vitest";
import { assembleInventory } from "./inventory.js";
import type {
  InventorySources,
  PendingOneOff,
  ResearchClusterSummary,
} from "./inventory.js";
import type { RecurringScheduleDTO } from "../../db/recurring-schedules.js";
import type { AgentDTO } from "../../db/agents-store.js";
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

function cluster(over: Partial<ResearchClusterSummary>): ResearchClusterSummary {
  return { slug: "flights-jun", displayName: "Flight-price research", status: "active", lastActivityAt: null, ...over };
}

function emptySources(over: Partial<InventorySources>): InventorySources {
  return {
    recurringDmSessions: [],
    agents: [],
    managedTasks: [],
    recurringById: new Map(),
    pendingOneOffs: [],
    backgroundTasks: [],
    browserTasks: [],
    researchClusters: [],
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

  it("projects research clusters; string + null lastActivityAt pass through", () => {
    const withStr = assembleInventory(emptySources({ researchClusters: [cluster({ lastActivityAt: "2026-06-29T00:00:00Z" })] }));
    expect(withStr[0]).toMatchObject({ ref: "cluster:flights-jun", kind: "research", cadence: "nightly", status: "active", lastRunAt: "2026-06-29T00:00:00Z" });
    const withNull = assembleInventory(emptySources({ researchClusters: [cluster({ lastActivityAt: null })] }));
    expect(withNull[0].lastRunAt).toBeNull();
  });
});

describe("assembleInventory — ordering", () => {
  it("groups by kind in a fixed order and sorts numerically within a group", () => {
    const items = assembleInventory(
      emptySources({
        recurringDmSessions: [rs({ id: 42 }), rs({ id: 7 })],
        agents: [agent({ slug: "z" }), agent({ slug: "a" })],
        researchClusters: [cluster({ slug: "c" })],
      }),
    );
    expect(items.map((i) => i.ref)).toEqual(["rs:7", "rs:42", "agent:a", "agent:z", "cluster:c"]);
  });
});
