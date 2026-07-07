import { describe, it, expect } from "vitest";
import {
  depsState,
  planFleetActions,
  classifyIdleFleet,
  computeSplitNudge,
  renderQueueSnapshot,
  renderParallelContext,
  type DevFleetTaskSnapshot,
} from "./dev-flow-schedule.js";

let seq = 0;
function snap(
  overrides: Partial<DevFleetTaskSnapshot> & { taskKey: string },
): DevFleetTaskSnapshot {
  return {
    id: `id-${overrides.taskKey}-${seq++}`,
    state: "queued",
    dependsOn: [],
    planReview: null,
    loopState: null,
    ...overrides,
  };
}

function byKey(tasks: readonly DevFleetTaskSnapshot[]): Map<string, DevFleetTaskSnapshot> {
  return new Map(tasks.map((t) => [t.taskKey, t]));
}

describe("depsState", () => {
  it("is ready with no deps or with merged, review-settled deps", () => {
    const a = snap({ taskKey: "a", state: "merged", planReview: "done" });
    const b = snap({ taskKey: "b", state: "merged" });
    const t = snap({ taskKey: "t", dependsOn: ["a", "b"] });
    expect(depsState(snap({ taskKey: "solo" }), byKey([]))).toEqual({ kind: "ready" });
    expect(depsState(t, byKey([a, b, t]))).toEqual({ kind: "ready" });
  });
  it("waits on unmerged deps and on pending/escalated plan reviews", () => {
    for (const state of ["queued", "running", "supervise_pending", "merge_pending", "awaiting_user"] as const) {
      const dep = snap({ taskKey: "dep", state });
      const t = snap({ taskKey: "t", dependsOn: ["dep"] });
      expect(depsState(t, byKey([dep, t]))).toEqual({ kind: "waiting" });
    }
    for (const planReview of ["pending", "escalated"] as const) {
      const dep = snap({ taskKey: "dep", state: "merged", planReview });
      const t = snap({ taskKey: "t", dependsOn: ["dep"] });
      expect(depsState(t, byKey([dep, t]))).toEqual({ kind: "waiting" });
    }
  });
  it("fails on failed-like or unknown deps", () => {
    for (const state of ["failed", "dep_failed", "superseded"] as const) {
      const dep = snap({ taskKey: "dep", state });
      const t = snap({ taskKey: "t", dependsOn: ["dep"] });
      expect(depsState(t, byKey([dep, t]))).toEqual({ kind: "failed", depKey: "dep" });
    }
    const t = snap({ taskKey: "t", dependsOn: ["ghost"] });
    expect(depsState(t, byKey([t]))).toEqual({ kind: "failed", depKey: "ghost" });
  });
});

describe("planFleetActions", () => {
  it("emits at most one control-lane action, supervise first", () => {
    const tasks = [
      snap({ taskKey: "m", state: "merge_pending" }),
      snap({ taskKey: "s", state: "supervise_pending" }),
      snap({ taskKey: "p", state: "merged", planReview: "pending" }),
    ];
    const actions = planFleetActions(tasks, 3, 0, false);
    expect(actions).toEqual([{ kind: "supervise", taskId: tasks[1]!.id }]);
  });
  it("falls back merge → planReview and respects a busy control lane", () => {
    const merge = snap({ taskKey: "m", state: "merge_pending" });
    const review = snap({ taskKey: "p", state: "merged", planReview: "pending" });
    expect(planFleetActions([merge, review], 3, 0, false)).toEqual([
      { kind: "merge", taskId: merge.id },
    ]);
    expect(planFleetActions([review], 3, 0, false)).toEqual([
      { kind: "planReview", taskId: review.id },
    ]);
    expect(planFleetActions([merge, review], 3, 0, true)).toEqual([]);
  });
  it("sweeps dep-failures and launches ready tasks into free slots", () => {
    const dead = snap({ taskKey: "dead", state: "failed" });
    const doomed = snap({ taskKey: "doomed", dependsOn: ["dead"] });
    const merged = snap({ taskKey: "landed", state: "merged" });
    const ready1 = snap({ taskKey: "r1", dependsOn: ["landed"] });
    const ready2 = snap({ taskKey: "r2" });
    const waiting = snap({ taskKey: "w", dependsOn: ["r1"] });
    const actions = planFleetActions([dead, doomed, merged, ready1, ready2, waiting], 3, 2, false);
    expect(actions).toEqual([
      { kind: "depFail", taskId: doomed.id, failedDepKey: "dead" },
      { kind: "launch", taskId: ready1.id },
    ]);
  });
  it("never launches with zero free slots", () => {
    const ready = snap({ taskKey: "r" });
    expect(planFleetActions([ready], 1, 1, false)).toEqual([]);
  });
});

describe("classifyIdleFleet", () => {
  it("parks for humans on awaiting_user tasks or escalated plan reviews", () => {
    const parked = snap({ taskKey: "parked", state: "awaiting_user" });
    const escalated = snap({ taskKey: "esc", state: "merged", planReview: "escalated" });
    const out = classifyIdleFleet([parked, escalated, snap({ taskKey: "q" })]);
    expect(out).toEqual({ kind: "needsHuman", taskIds: [parked.id, escalated.id] });
  });
  it("is clean when everything merged or was superseded", () => {
    expect(
      classifyIdleFleet([
        snap({ taskKey: "a", state: "merged", planReview: "done" }),
        snap({ taskKey: "b", state: "superseded" }),
      ]),
    ).toEqual({ kind: "clean" });
  });
  it("surfaces failed tasks with their loop states", () => {
    const dead = snap({ taskKey: "dead", state: "failed", loopState: "STALLED" });
    const doomed = snap({ taskKey: "doomed", state: "dep_failed" });
    const out = classifyIdleFleet([dead, doomed]);
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") {
      expect(out.taskIds).toEqual([dead.id, doomed.id]);
      expect(out.reason).toContain("dead (STALLED)");
      expect(out.reason).toContain("doomed (dep_failed)");
    }
  });
  it("reports a defensive stall otherwise", () => {
    const out = classifyIdleFleet([
      snap({ taskKey: "q", dependsOn: ["r"] }),
      snap({ taskKey: "r", state: "running" }),
    ]);
    expect(out.kind).toBe("stalled");
  });
});

describe("computeSplitNudge", () => {
  const base = {
    iteration: 5,
    maxIterations: 10,
    splitNudgeAt: 50,
    unmetReqIds: ["REQ-002", "REQ-003"],
    stopNudgeActive: false,
  };
  it("emits the nudge past the threshold with unmet REQs", () => {
    const text = computeSplitNudge(base);
    expect(text).toContain("iteration 5 of 10");
    expect(text).toContain("REQ-002, REQ-003");
    expect(text).toContain("NEEDS_DECOMPOSITION");
  });
  it("is silent when off, superseded by the stop nudge, early, or met", () => {
    expect(computeSplitNudge({ ...base, splitNudgeAt: 0 })).toBeNull();
    expect(computeSplitNudge({ ...base, stopNudgeActive: true })).toBeNull();
    expect(computeSplitNudge({ ...base, iteration: 4 })).toBeNull();
    expect(computeSplitNudge({ ...base, unmetReqIds: [] })).toBeNull();
  });
  it("clamps the threshold to at least one iteration", () => {
    expect(
      computeSplitNudge({ ...base, maxIterations: 1, splitNudgeAt: 10, iteration: 1 }),
    ).toContain("iteration 1 of 1");
  });
});

describe("renderQueueSnapshot", () => {
  const tasks = [
    {
      taskKey: "a",
      state: "merged" as const,
      dependsOn: [],
      reqs: ["REQ-001"],
      summary: "phase 1",
      planReview: "done" as const,
    },
    {
      taskKey: "b",
      state: "queued" as const,
      dependsOn: ["a"],
      reqs: ["REQ-002"],
      summary: "phase 2",
      body: "Build phase 2.",
    },
  ];
  it("renders the live table", () => {
    const md = renderQueueSnapshot(tasks);
    expect(md).toContain("| a | merged | - | REQ-001 | done |");
    expect(md).toContain("| b | queued | a | REQ-002 | - |");
    expect(md).not.toContain("Build phase 2.");
  });
  it("appends queued bodies only when asked (plan-review staging)", () => {
    const md = renderQueueSnapshot(tasks, { includeQueuedBodies: true });
    expect(md).toContain("#### b");
    expect(md).toContain("Build phase 2.");
    // merged tasks never leak bodies
    expect(md).not.toContain("#### a");
    // queued without a body → section only lists those with bodies
    const none = renderQueueSnapshot(
      [{ ...tasks[1]!, body: undefined }],
      { includeQueuedBodies: true },
    );
    expect(none).not.toContain("Queued task bodies");
  });
});

describe("renderParallelContext", () => {
  const tasks = [
    { taskKey: "me", state: "running" as const, dependsOn: [], reqs: [], summary: "self" },
    {
      taskKey: "sib",
      state: "queued" as const,
      dependsOn: [],
      reqs: [],
      summary: "sibling work",
      scope: "src/ui only",
    },
    { taskKey: "landed", state: "merged" as const, dependsOn: [], reqs: [], summary: "done" },
    { taskKey: "gone", state: "superseded" as const, dependsOn: [], reqs: [], summary: "old" },
  ];
  it("lists live siblings with scopes and merged history, excluding self", () => {
    const md = renderParallelContext("me", tasks);
    expect(md).toContain("You are task `me`");
    expect(md).toContain("- sib [queued] sibling work — scope: src/ui only");
    expect(md).toContain("Already merged into your base: landed");
    expect(md).not.toContain("gone");
    expect(md).not.toContain("- me ");
  });
  it("says so when no live siblings remain", () => {
    const md = renderParallelContext("me", [tasks[0]!, tasks[2]!]);
    expect(md).toContain("(no live sibling tasks right now)");
  });
});
