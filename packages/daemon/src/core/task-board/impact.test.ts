import { describe, it, expect } from "vitest";
import { computeImpact } from "./impact.js";
import type { ImpactSources } from "./impact.js";
import { parseTaskRef } from "./refs.js";
import type { TaskRef } from "./types.js";
import type { RecurringScheduleDTO } from "../../db/recurring-schedules.js";
import type { AgentDTO } from "../../db/agents-store.js";
import type { ManagedTask } from "@aitne/shared";
import type { AutomationTriggerDTO } from "../../db/automation-triggers.js";

const ref = (raw: string): TaskRef => parseTaskRef(raw) as TaskRef;

function rs(id: number, over: Partial<RecurringScheduleDTO> = {}): RecurringScheduleDTO {
  return { id, taskType: "dm_session", enabled: true, ...over } as unknown as RecurringScheduleDTO;
}
function mt(id: string, scheduleId: number): ManagedTask {
  return { id, schedule_id: scheduleId } as ManagedTask;
}
function agent(slug: string, recurringScheduleId: number | null): AgentDTO {
  return { slug, recurringScheduleId } as unknown as AgentDTO;
}
function trigger(id: number, recurringScheduleId: number | null): AutomationTriggerDTO {
  return { id, recurringScheduleId } as unknown as AutomationTriggerDTO;
}

function sources(over: Partial<ImpactSources>): ImpactSources {
  return {
    recurringById: new Map(),
    managedTasks: [],
    agents: [],
    automationTriggers: [],
    pendingOccurrences: [],
    backgroundTaskIds: new Set(),
    browserTaskIds: new Set(),
    researchClusterSlugs: new Set(),
    ...over,
  };
}

describe("computeImpact — rs target", () => {
  it("labels each satellite by its real cascade semantics", () => {
    const result = computeImpact(
      ref("rs:51"),
      sources({
        recurringById: new Map([[51, rs(51, { taskType: "managed_fetch" })]]),
        managedTasks: [mt("mt_3", 51)],
        agents: [agent("digest", 51)],
        automationTriggers: [trigger(9, 51)],
        pendingOccurrences: [
          { id: 1, recurringScheduleId: 51 },
          { id: 2, recurringScheduleId: 99 },
        ],
      }),
    );
    expect(result.found).toBe(true);
    const byCascade = Object.fromEntries(result.nodes.map((n) => [n.ref, n]));
    expect(byCascade["rs:51"].cascade).toBe("self");
    expect(byCascade["mt_3"]).toMatchObject({ cascade: "is_a_cascade", removed: true });
    expect(byCascade["agent:digest"]).toMatchObject({ cascade: "set_null_satellite", removed: false });
    expect(byCascade["trigger:9"]).toMatchObject({ cascade: "set_null_satellite", removed: false });
    expect(byCascade["rs:51#pending"]).toMatchObject({ cascade: "no_action_unlinked", removed: false });
    // self + managed task are removed (2); agent + trigger + pending survive/unlink (3).
    expect(result.summary).toContain("removes 2 row(s)");
    expect(result.summary).toContain("touches 3");
  });

  it("summarises a bare schedule with no satellites (nothing survives)", () => {
    const result = computeImpact(ref("rs:42"), sources({ recurringById: new Map([[42, rs(42)]]) }));
    expect(result.nodes).toHaveLength(1);
    expect(result.summary).toBe("Deleting rs:42 removes 1 row(s).");
  });

  it("returns found:false for a missing recurring row", () => {
    const result = computeImpact(ref("rs:404"), sources({}));
    expect(result).toMatchObject({ found: false, nodes: [] });
  });
});

describe("computeImpact — mt target", () => {
  it("removes the managed task and its recurring schedule (1:1), counts unlinked fires", () => {
    const result = computeImpact(
      ref("mt_3"),
      sources({
        managedTasks: [mt("mt_3", 51)],
        recurringById: new Map([[51, rs(51)]]),
        pendingOccurrences: [{ id: 7, recurringScheduleId: 51 }],
      }),
    );
    expect(result.found).toBe(true);
    const refs = result.nodes.map((n) => n.ref);
    expect(refs).toContain("mt_3");
    expect(refs).toContain("rs:51");
    expect(result.nodes.find((n) => n.ref === "rs:51")).toMatchObject({ cascade: "is_a_cascade", removed: true });
    expect(result.nodes.find((n) => n.ref === "rs:51#pending")).toMatchObject({ removed: false });
    // The managed task is NOT double-listed as a satellite of its own schedule.
    expect(refs.filter((r) => r === "mt_3")).toHaveLength(1);
  });

  it("returns found:false for a missing managed task", () => {
    expect(computeImpact(ref("mt_9"), sources({})).found).toBe(false);
  });
});

describe("computeImpact — agent target", () => {
  it("reports the Agent + its recurring schedule, neither removed by default", () => {
    const result = computeImpact(ref("agent:digest"), sources({ agents: [agent("digest", 51)] }));
    expect(result.found).toBe(true);
    expect(result.nodes.map((n) => n.ref)).toEqual(["agent:digest", "rs:51"]);
    expect(result.nodes.every((n) => n.removed === false)).toBe(true);
    // The Agent's own paired schedule is NOT an IS-A wrapper — it gets its own
    // honest cascade kind so the preview never conflates it with managed_tasks.
    expect(result.nodes.find((n) => n.ref === "rs:51")).toMatchObject({
      cascade: "owner_paired_schedule",
      removed: false,
    });
    expect(result.summary).toContain("keep_history:false");
  });

  it("omits the schedule node when the agent has no paired schedule", () => {
    const result = computeImpact(ref("agent:lonely"), sources({ agents: [agent("lonely", null)] }));
    expect(result.nodes.map((n) => n.ref)).toEqual(["agent:lonely"]);
  });

  it("returns found:false for a missing agent", () => {
    expect(computeImpact(ref("agent:ghost"), sources({})).found).toBe(false);
  });
});

describe("computeImpact — one-off + fulfillers + reserved", () => {
  it("cancels a single pending reminder with no cascade", () => {
    const result = computeImpact(ref("as:8190"), sources({ pendingOccurrences: [{ id: 8190, recurringScheduleId: null }] }));
    expect(result).toMatchObject({ found: true });
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({ cascade: "self", removed: true });
    expect(result.summary).toContain("no cascade");
  });

  it("returns found:false for a missing one-off", () => {
    expect(computeImpact(ref("as:1"), sources({})).found).toBe(false);
  });

  it("treats background/browser/cluster as read-only when present", () => {
    expect(computeImpact(ref("bt:u"), sources({ backgroundTaskIds: new Set(["u"]) }))).toMatchObject({
      found: true,
      nodes: [{ cascade: "self", removed: false }],
    });
    expect(computeImpact(ref("bx:v"), sources({ browserTaskIds: new Set(["v"]) })).found).toBe(true);
    expect(computeImpact(ref("cluster:c"), sources({ researchClusterSlugs: new Set(["c"]) })).found).toBe(true);
  });

  it("returns found:false for absent fulfillers", () => {
    expect(computeImpact(ref("bt:missing"), sources({})).found).toBe(false);
    expect(computeImpact(ref("bx:missing"), sources({})).found).toBe(false);
    expect(computeImpact(ref("cluster:missing"), sources({})).found).toBe(false);
  });

  it("reports obj: as reserved / not yet available", () => {
    const result = computeImpact(ref("obj:o1"), sources({}));
    expect(result).toMatchObject({ found: false, nodes: [] });
    expect(result.summary).toContain("reserved");
  });
});
