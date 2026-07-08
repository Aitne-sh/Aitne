import { describe, it, expect } from "vitest";
import {
  parseTaskPlan,
  wrapReplanBlock,
  validatePlanStructure,
  planAncestors,
  checkReqChains,
  validatePlanReqs,
  validateTaskPlan,
  planParallelGroups,
  liveDepAncestors,
  liveDepRelated,
  liveForkJoinRelated,
  liveReqOwnerElsewhere,
  validateReplanBlock,
  validatePlanRevision,
  validateFixupTask,
  type DevLiveTaskLike,
  type DevPlanTask,
} from "./task-plan.js";

// ── builders ────────────────────────────────────────────────────────────

function block(opts: {
  key: string;
  summary?: string;
  depends?: string;
  scope?: string;
  reqs?: string;
  body?: string;
}): string {
  return [
    `TASK: ${opts.key}`,
    `SUMMARY: ${opts.summary ?? `do ${opts.key}`}`,
    `DEPENDS: ${opts.depends ?? "-"}`,
    `SCOPE: ${opts.scope ?? `${opts.key} files only`}`,
    `REQS: ${opts.reqs ?? "REQ-001"}`,
    "BODY-BEGIN",
    opts.body ?? `Implement ${opts.key}.`,
    "BODY-END",
    "TASK-END",
  ].join("\n");
}

function plan(...blocks: string[]): string {
  return [
    "Some free-prose rationale before the machine block.",
    "<!-- TASK-PLAN-BEGIN v1 -->",
    ...blocks,
    "<!-- TASK-PLAN-END -->",
    "Trailing prose is ignored.",
  ].join("\n");
}

function task(overrides: Partial<DevPlanTask> & { key: string }): DevPlanTask {
  return {
    summary: `do ${overrides.key}`,
    dependsOn: [],
    scope: "s",
    reqs: ["REQ-001"],
    body: "b",
    ...overrides,
  };
}

function live(
  overrides: Partial<DevLiveTaskLike> & { key: string },
): DevLiveTaskLike {
  return {
    state: "queued",
    dependsOn: [],
    reqs: [],
    seedBranch: null,
    ...overrides,
  };
}

const expectErr = (
  result: { ok: boolean },
  pattern: RegExp,
): void => {
  expect(result.ok).toBe(false);
  if (!result.ok) expect((result as { error: string }).error).toMatch(pattern);
};

// ── parseTaskPlan ───────────────────────────────────────────────────────

describe("parseTaskPlan", () => {
  it("parses a multi-task plan, normalizes REQ ids, splits CSVs", () => {
    const res = parseTaskPlan(
      plan(
        block({ key: "core", reqs: "req-1, REQ-002" }),
        block({ key: "ui", depends: "core", reqs: "REQ-003" }),
      ),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.tasks.map((t) => t.key)).toEqual(["core", "ui"]);
    expect(res.tasks[0]!.reqs).toEqual(["REQ-001", "REQ-002"]);
    expect(res.tasks[0]!.dependsOn).toEqual([]);
    expect(res.tasks[1]!.dependsOn).toEqual(["core"]);
    expect(res.tasks[1]!.body).toBe("Implement ui.");
  });
  it("keeps non-REQ tokens as-is (coverage check flags them later)", () => {
    const res = parseTaskPlan(plan(block({ key: "a", reqs: "FEATURE-1" })));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.tasks[0]!.reqs).toEqual(["FEATURE-1"]);
  });
  it("ignores everything outside the markers", () => {
    const res = parseTaskPlan(
      `TASK: not-parsed\n${plan(block({ key: "a" }))}\nTASK: also-ignored`,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.tasks).toHaveLength(1);
  });
  it("rejects a missing/unterminated plan", () => {
    expectErr(parseTaskPlan("no markers at all"), /missing or unterminated/);
    expectErr(
      parseTaskPlan(`<!-- TASK-PLAN-BEGIN v1 -->\n${block({ key: "a" })}`),
      /missing or unterminated/,
    );
  });
  it("rejects an empty plan block", () => {
    expectErr(parseTaskPlan(plan()), /no TASK blocks/);
  });
  it("rejects markers inside a body", () => {
    for (const marker of [
      "BODY-BEGIN",
      "TASK-END",
      "TASK: sneaky",
      "<!-- TASK-PLAN-END -->",
    ]) {
      const bad = plan(
        [
          "TASK: a",
          "SUMMARY: s",
          "DEPENDS: -",
          "SCOPE: sc",
          "REQS: REQ-001",
          "BODY-BEGIN",
          marker,
          "BODY-END",
          "TASK-END",
        ].join("\n"),
      );
      expectErr(parseTaskPlan(bad), /inside the body/);
    }
  });
  it("rejects a plan ending inside a task", () => {
    expectErr(
      parseTaskPlan(
        "<!-- TASK-PLAN-BEGIN v1 -->\nTASK: a\nSUMMARY: s\n<!-- TASK-PLAN-END -->",
      ),
      /ends inside task 'a'/,
    );
  });
  it("rejects TASK before TASK-END", () => {
    expectErr(
      parseTaskPlan(plan("TASK: a\nSUMMARY: s\nTASK: b")),
      /TASK before TASK-END/,
    );
  });
  it("rejects bad and duplicate ids", () => {
    expectErr(parseTaskPlan(plan(block({ key: "Bad_Id" }))), /bad task id/);
    expectErr(
      parseTaskPlan(plan(block({ key: "a-key-far-too-long-to-be-legal" }))),
      /bad task id/,
    );
    expectErr(
      parseTaskPlan(plan(block({ key: "a" }), block({ key: "a" }))),
      /duplicate task id/,
    );
  });
  it("rejects misplaced/duplicate keys", () => {
    expectErr(parseTaskPlan(plan("SUMMARY: stray")), /misplaced\/duplicate SUMMARY/);
    expectErr(parseTaskPlan(plan("DEPENDS: stray")), /misplaced\/duplicate DEPENDS/);
    expectErr(parseTaskPlan(plan("SCOPE: stray")), /misplaced\/duplicate SCOPE/);
    expectErr(parseTaskPlan(plan("REQS: stray")), /misplaced\/duplicate REQS/);
    expectErr(
      parseTaskPlan(plan("TASK: a\nSUMMARY: one\nSUMMARY: two")),
      /misplaced\/duplicate SUMMARY/,
    );
  });
  it("rejects BODY-BEGIN outside a task or with missing keys", () => {
    expectErr(parseTaskPlan(plan("BODY-BEGIN")), /BODY-BEGIN outside a task/);
    expectErr(
      parseTaskPlan(plan("TASK: a\nSUMMARY: s\nBODY-BEGIN")),
      /missing SUMMARY\/DEPENDS\/SCOPE\/REQS/,
    );
  });
  it("rejects TASK-END without a completed body and empty bodies", () => {
    expectErr(
      parseTaskPlan(
        plan("TASK: a\nSUMMARY: s\nDEPENDS: -\nSCOPE: sc\nREQS: REQ-001\nTASK-END"),
      ),
      /TASK-END without a completed body/,
    );
    expectErr(
      parseTaskPlan(plan(block({ key: "a", body: "   " }))),
      /empty body/,
    );
  });
  it("rejects unexpected lines between blocks (blank lines are fine)", () => {
    expect(parseTaskPlan(plan(block({ key: "a" }), "", "")).ok).toBe(true);
    expectErr(parseTaskPlan(plan("stray prose")), /unexpected line/);
  });
  it("rejects a syntactically-present-but-empty REQS (spaces / commas only)", () => {
    expectErr(parseTaskPlan(plan(block({ key: "a", reqs: ",," }))), /names no REQ ids/);
    expectErr(parseTaskPlan(plan(block({ key: "a", reqs: " " }))), /names no REQ ids/);
  });
});

describe("wrapReplanBlock", () => {
  it("wraps a payload so the plan parser accepts it", () => {
    const res = parseTaskPlan(wrapReplanBlock(block({ key: "a" })));
    expect(res.ok).toBe(true);
  });
});

// ── structure ───────────────────────────────────────────────────────────

describe("validatePlanStructure", () => {
  const t = (key: string, deps: string[] = []) => task({ key, dependsOn: deps });
  it("returns the topological enqueue order (diamond)", () => {
    const res = validatePlanStructure(
      [t("join", ["left", "right"]), t("left", ["root"]), t("right", ["root"]), t("root")],
      { cap: 8, verdictN: 4, externalDepKeys: [] },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.topo).toEqual(["root", "left", "right", "join"]);
  });
  it("rejects an empty plan, a cap overflow and a verdict-n mismatch", () => {
    expectErr(
      validatePlanStructure([], { cap: 8, verdictN: null, externalDepKeys: [] }),
      /no tasks/,
    );
    expectErr(
      validatePlanStructure([t("a"), t("b")], { cap: 1, verdictN: null, externalDepKeys: [] }),
      /exceeds the task cap/,
    );
    expectErr(
      validatePlanStructure([t("a")], { cap: 8, verdictN: 2, externalDepKeys: [] }),
      /verdict says n=2 but the plan defines 1/,
    );
  });
  it("rejects self-deps and unknown deps; external deps resolve", () => {
    expectErr(
      validatePlanStructure([t("a", ["a"])], { cap: 8, verdictN: null, externalDepKeys: [] }),
      /depends on itself/,
    );
    expectErr(
      validatePlanStructure([t("a", ["ghost"])], { cap: 8, verdictN: null, externalDepKeys: [] }),
      /unknown task 'ghost'/,
    );
    const res = validatePlanStructure([t("a", ["merged-dep"])], {
      cap: 8,
      verdictN: null,
      externalDepKeys: ["merged-dep"],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.topo).toEqual(["a"]);
  });
  it("rejects dependency cycles", () => {
    expectErr(
      validatePlanStructure([t("a", ["b"]), t("b", ["a"])], {
        cap: 8,
        verdictN: null,
        externalDepKeys: [],
      }),
      /dependency cycle among: a, b/,
    );
  });
});

describe("planAncestors", () => {
  it("walks the transitive in-plan closure and ignores external deps", () => {
    const tasks = [
      task({ key: "a" }),
      task({ key: "b", dependsOn: ["a", "outside"] }),
      task({ key: "c", dependsOn: ["b"] }),
    ];
    expect([...planAncestors(tasks, "c")].sort()).toEqual(["a", "b"]);
    expect(planAncestors(tasks, "a").size).toBe(0);
    expect(planAncestors(tasks, "ghost").size).toBe(0);
  });
});

// ── completing owner + REQ coverage ─────────────────────────────────────

describe("checkReqChains", () => {
  it("accepts a single owner, a chain, and a fork-join", () => {
    const single = [task({ key: "a", reqs: ["REQ-001"] })];
    expect(checkReqChains(single, ["a"]).ok).toBe(true);

    const chain = [
      task({ key: "p1", reqs: ["REQ-001"] }),
      task({ key: "p2", reqs: ["REQ-001"], dependsOn: ["p1"] }),
      task({ key: "p3", reqs: ["REQ-001"], dependsOn: ["p2"] }),
    ];
    expect(checkReqChains(chain, ["p1", "p2", "p3"]).ok).toBe(true);

    const forkJoin = [
      task({ key: "root", reqs: ["REQ-001"] }),
      task({ key: "left", reqs: ["REQ-001"], dependsOn: ["root"] }),
      task({ key: "right", reqs: ["REQ-001"], dependsOn: ["root"] }),
      task({ key: "join", reqs: ["REQ-001"], dependsOn: ["left", "right"] }),
    ];
    expect(checkReqChains(forkJoin, ["root", "left", "right", "join"]).ok).toBe(true);
  });
  it("rejects parallel owners with no completing owner", () => {
    const parallel = [
      task({ key: "a", reqs: ["REQ-001"] }),
      task({ key: "b", reqs: ["REQ-001"] }),
    ];
    expectErr(checkReqChains(parallel, ["a", "b"]), /no single completing owner/);
  });
});

describe("validatePlanReqs", () => {
  it("rejects an empty master REQ list and REQ-less tasks", () => {
    expectErr(
      validatePlanReqs([task({ key: "a" })], ["a"], []),
      /defines no REQ-xxx ids/,
    );
    expectErr(
      validatePlanReqs([task({ key: "a", reqs: [] })], ["a"], ["REQ-001"]),
      /owns no REQs/,
    );
  });
  it("rejects coverage mismatches in both directions", () => {
    expectErr(
      validatePlanReqs([task({ key: "a", reqs: ["REQ-001"] })], ["a"], ["REQ-001", "REQ-002"]),
      /REQ coverage mismatch/,
    );
    expectErr(
      validatePlanReqs(
        [task({ key: "a", reqs: ["REQ-001", "REQ-099"] })],
        ["a"],
        ["REQ-001"],
      ),
      /REQ coverage mismatch/,
    );
  });
  it("accepts exact coverage and delegates the chain check", () => {
    expect(
      validatePlanReqs([task({ key: "a", reqs: ["REQ-001"] })], ["a"], ["REQ-001"]).ok,
    ).toBe(true);
    expectErr(
      validatePlanReqs(
        [task({ key: "a", reqs: ["REQ-001"] }), task({ key: "b", reqs: ["REQ-001"] })],
        ["a", "b"],
        ["REQ-001"],
      ),
      /no single completing owner/,
    );
  });
});

describe("validateTaskPlan", () => {
  const master = ["REQ-001", "REQ-002"];
  it("accepts a valid plan end-to-end", () => {
    const res = validateTaskPlan(
      plan(
        block({ key: "core", reqs: "REQ-001" }),
        block({ key: "ui", reqs: "REQ-002", depends: "core" }),
      ),
      { cap: 8, verdictN: 2, masterReqIds: master },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.topo).toEqual(["core", "ui"]);
  });
  it("propagates parse, structure and REQ errors", () => {
    expectErr(
      validateTaskPlan("garbage", { cap: 8, verdictN: null, masterReqIds: master }),
      /missing or unterminated/,
    );
    expectErr(
      validateTaskPlan(plan(block({ key: "a", depends: "ghost" })), {
        cap: 8,
        verdictN: null,
        masterReqIds: master,
      }),
      /unknown task/,
    );
    expectErr(
      validateTaskPlan(plan(block({ key: "a", reqs: "REQ-001" })), {
        cap: 8,
        verdictN: null,
        masterReqIds: master,
      }),
      /REQ coverage mismatch/,
    );
  });
});

describe("planParallelGroups", () => {
  it("groups tasks into topological layers", () => {
    const groups = planParallelGroups([
      task({ key: "root" }),
      task({ key: "left", dependsOn: ["root"] }),
      task({ key: "right", dependsOn: ["root", "outside"] }),
      task({ key: "join", dependsOn: ["left", "right"] }),
    ]);
    expect(groups).toEqual([["root"], ["left", "right"], ["join"]]);
  });
  it("survives a cyclic input (validators reject those separately)", () => {
    const groups = planParallelGroups([
      task({ key: "a", dependsOn: ["b"] }),
      task({ key: "b", dependsOn: ["a"] }),
    ]);
    expect(groups.flat().sort()).toEqual(["a", "b"]);
  });
});

// ── live-queue relations ────────────────────────────────────────────────

describe("live-queue relations", () => {
  const chainTasks = [
    live({ key: "p1", state: "merged", reqs: ["REQ-001"] }),
    live({ key: "p2", state: "running", reqs: ["REQ-001"], dependsOn: ["p1"] }),
    live({ key: "other", state: "queued", reqs: ["REQ-002"] }),
  ];
  it("liveDepAncestors walks the closure and tolerates unknown keys", () => {
    const tasks = [
      live({ key: "a" }),
      live({ key: "b", dependsOn: ["a", "ghost"] }),
      live({ key: "c", dependsOn: ["b"] }),
      live({ key: "d", dependsOn: ["b", "a"] }),
    ];
    expect([...liveDepAncestors(tasks, "c")].sort()).toEqual(["a", "b", "ghost"]);
    // Diamond: `a` is reached twice (directly and via b) — visited-set guard.
    expect([...liveDepAncestors(tasks, "d")].sort()).toEqual(["a", "b", "ghost"]);
    // A start key outside the queue walks nothing.
    expect(liveDepAncestors(tasks, "nope").size).toBe(0);
  });
  it("liveDepRelated matches either direction", () => {
    expect(liveDepRelated(chainTasks, "p1", "p2")).toBe(true);
    expect(liveDepRelated(chainTasks, "p2", "p1")).toBe(true);
    expect(liveDepRelated(chainTasks, "p1", "other")).toBe(false);
  });
  it("liveForkJoinRelated finds a declared join and fails closed otherwise", () => {
    const fork = [
      live({ key: "left", state: "running", reqs: ["REQ-001"] }),
      live({ key: "right", state: "queued", reqs: ["REQ-001"] }),
      live({ key: "join", state: "queued", reqs: ["REQ-001"], dependsOn: ["left", "right"] }),
      live({ key: "superseded-join", state: "superseded", reqs: ["REQ-001"], dependsOn: ["left", "right"] }),
      live({ key: "unrelated", state: "queued", reqs: ["REQ-002"] }),
    ];
    expect(liveForkJoinRelated(fork, "left", "right", "REQ-001")).toBe(true);
    const noJoin = fork.filter((t) => t.key !== "join");
    expect(liveForkJoinRelated(noJoin, "left", "right", "REQ-001")).toBe(false);
  });
  it("liveReqOwnerElsewhere honors exclude/superseded/done/chain carve-outs", () => {
    const tasks = [
      live({ key: "self", state: "running", reqs: ["REQ-001"] }),
      live({ key: "gone", state: "superseded", reqs: ["REQ-001"] }),
      live({ key: "landed", state: "merged", reqs: ["REQ-001"] }),
      live({ key: "rival", state: "queued", reqs: ["REQ-001"] }),
    ];
    // Excluded + superseded skipped; merged skipped when includeDone=false.
    expect(liveReqOwnerElsewhere(tasks.slice(0, 3), "REQ-001", "self", false)).toBeNull();
    expect(liveReqOwnerElsewhere(tasks.slice(0, 3), "REQ-001", "self", true)).toBe("landed");
    expect(liveReqOwnerElsewhere(tasks, "REQ-001", "self", false)).toBe("rival");
    // Chain carve-out: p1 owns the REQ but is dep-related to p2.
    expect(liveReqOwnerElsewhere(chainTasks, "REQ-001", "p2", true, "p2")).toBeNull();
    // Fork carve-out: a declared join relates the two branches.
    const fork = [
      live({ key: "left", state: "running", reqs: ["REQ-001"] }),
      live({ key: "right", state: "queued", reqs: ["REQ-001"] }),
      live({ key: "join", state: "queued", reqs: ["REQ-001"], dependsOn: ["left", "right"] }),
    ];
    expect(liveReqOwnerElsewhere(fork, "REQ-001", "left", true, "left")).toBeNull();
  });
});

// ── REPLAN validation ───────────────────────────────────────────────────

describe("validateReplanBlock", () => {
  const escalated = live({
    key: "big",
    state: "supervise_pending",
    reqs: ["REQ-001", "REQ-002"],
  });
  const baseOpts = {
    escalatedKey: "big",
    escalatedReqs: ["REQ-001", "REQ-002"],
    liveTasks: [escalated],
    replanBudgetUsed: 0,
    replanCap: 6,
    maxTasks: 8,
  };
  it("accepts a phased chain and reports the unique root + sinks", () => {
    const res = validateReplanBlock(
      [
        block({ key: "p1", reqs: "REQ-001,REQ-002" }),
        block({ key: "p2", reqs: "REQ-001,REQ-002", depends: "p1" }),
      ].join("\n"),
      baseOpts,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.topo).toEqual(["p1", "p2"]);
    expect(res.uniqueRootKey).toBe("p1");
    expect(res.sinkKeys).toEqual(["p2"]);
  });
  it("reports a null root for a two-root fork and both sinks", () => {
    const res = validateReplanBlock(
      [
        block({ key: "c", reqs: "REQ-001" }),
        block({ key: "d", reqs: "REQ-002" }),
      ].join("\n"),
      baseOpts,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.uniqueRootKey).toBeNull();
    expect(res.sinkKeys).toEqual(["c", "d"]);
  });
  it("propagates parse errors and rejects id collisions", () => {
    expectErr(validateReplanBlock("garbage", baseOpts), /unexpected line|no TASK blocks/);
    expectErr(
      validateReplanBlock(block({ key: "big", reqs: "REQ-001,REQ-002" }), baseOpts),
      /replacement id 'big' already exists/,
    );
  });
  it("rejects a DEPENDS on the escalated task (unknown) or a failed task", () => {
    expectErr(
      validateReplanBlock(
        block({ key: "p1", reqs: "REQ-001,REQ-002", depends: "big" }),
        baseOpts,
      ),
      /unknown task 'big'/,
    );
    const withFailed = {
      ...baseOpts,
      liveTasks: [escalated, live({ key: "dead", state: "failed", reqs: [] })],
    };
    expectErr(
      validateReplanBlock(
        block({ key: "p1", reqs: "REQ-001,REQ-002", depends: "dead" }),
        withFailed,
      ),
      /depends on failed task 'dead'/,
    );
  });
  it("bounds the scope to the escalated REQs and re-checks cross-fleet ownership", () => {
    expectErr(
      validateReplanBlock(
        block({ key: "p1", reqs: "REQ-001,REQ-002,REQ-009" }),
        baseOpts,
      ),
      /claims REQ-009 outside/,
    );
    const withRival = {
      ...baseOpts,
      liveTasks: [escalated, live({ key: "rival", state: "queued", reqs: ["REQ-002"] })],
    };
    expectErr(
      validateReplanBlock(
        block({ key: "p1", reqs: "REQ-001,REQ-002" }),
        withRival,
      ),
      /already owned by task 'rival'/,
    );
  });
  it("requires the union to cover the escalated REQs exactly", () => {
    expectErr(
      validateReplanBlock(block({ key: "p1", reqs: "REQ-001" }), baseOpts),
      /do not cover the escalated task's REQs/,
    );
  });
  it("applies the completing-owner rule inside the block", () => {
    expectErr(
      validateReplanBlock(
        [
          block({ key: "c", reqs: "REQ-001,REQ-002" }),
          block({ key: "d", reqs: "REQ-001" }),
        ].join("\n"),
        baseOpts,
      ),
      /no single completing owner/,
    );
  });
  it("enforces the cumulative replan budget", () => {
    expectErr(
      validateReplanBlock(
        block({ key: "p1", reqs: "REQ-001,REQ-002" }),
        { ...baseOpts, replanBudgetUsed: 6 },
      ),
      /replan budget exceeded/,
    );
  });
  it("skips the REQ checks when the escalated task owns none", () => {
    const res = validateReplanBlock(block({ key: "p1", reqs: "REQ-001" }), {
      ...baseOpts,
      escalatedReqs: [],
    });
    expect(res.ok).toBe(true);
  });
  it("enforces the post-swap in-flight cap (escalated closes, block adds)", () => {
    // 3 live (escalated supervise_pending + 2 queued rivals) − 1 (escalated
    // closes superseded) + 2 (block) = 4 > cap 3.
    const crowded = {
      ...baseOpts,
      maxTasks: 3,
      liveTasks: [
        escalated,
        live({ key: "q1", state: "queued", reqs: ["REQ-003"] }),
        live({ key: "q2", state: "queued", reqs: ["REQ-004"] }),
      ],
    };
    expectErr(
      validateReplanBlock(
        [block({ key: "p1", reqs: "REQ-001" }), block({ key: "p2", reqs: "REQ-002" })].join("\n"),
        crowded,
      ),
      /would put 4 tasks in flight > cap 3/,
    );
  });
  it("does not subtract the escalated task when it is not counted as in-flight", () => {
    // The escalated key is absent from the live queue (already closed) → the
    // −1 is skipped; 1 live + 2 block = 3 ≤ cap 8 → still accepted.
    const res = validateReplanBlock(
      [block({ key: "p1", reqs: "REQ-001" }), block({ key: "p2", reqs: "REQ-002" })].join("\n"),
      { ...baseOpts, liveTasks: [live({ key: "other", state: "queued", reqs: ["REQ-005"] })] },
    );
    expect(res.ok).toBe(true);
  });
});

// ── plan-review REVISE validation ───────────────────────────────────────

describe("validatePlanRevision", () => {
  const baseTasks: DevLiveTaskLike[] = [
    live({ key: "done1", state: "merged", reqs: ["REQ-001"] }),
    live({ key: "q1", state: "queued", reqs: ["REQ-002"], seedBranch: "aitne-dev/s-old" }),
    live({ key: "q2", state: "queued", reqs: ["REQ-003"], dependsOn: ["q1"] }),
    // A queued survivor whose deps are untouched by the swap.
    live({ key: "bystander", state: "queued", reqs: ["REQ-004"], dependsOn: ["done1"] }),
  ];
  const baseOpts = { liveTasks: baseTasks, maxReplanTasks: 3, maxTasks: 8 };
  it("replaces queued owners, conserves REQs, and moves a pending seed", () => {
    const res = validatePlanRevision(
      [
        block({ key: "n1", reqs: "REQ-002" }),
        block({ key: "n2", reqs: "REQ-003", depends: "n1" }),
      ].join("\n"),
      baseOpts,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.replacedKeys).toEqual(["q1", "q2"]);
    expect(res.seedBranch).toBe("aitne-dev/s-old");
    expect(res.seedTargetKey).toBe("n1");
  });
  it("drops the seed when the block has no unique root", () => {
    const res = validatePlanRevision(
      [
        block({ key: "n1", reqs: "REQ-002" }),
        block({ key: "n2", reqs: "REQ-003" }),
      ].join("\n"),
      baseOpts,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.seedBranch).toBe("aitne-dev/s-old");
    expect(res.seedTargetKey).toBeNull();
  });
  it("reports no seed when the replaced tasks hold none", () => {
    const res = validatePlanRevision(block({ key: "n2", reqs: "REQ-003" }), {
      ...baseOpts,
      liveTasks: [live({ key: "q2", state: "queued", reqs: ["REQ-003"] })],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.seedBranch).toBeNull();
    expect(res.seedTargetKey).toBeNull();
  });
  it("propagates parse errors, id collisions and the block-size cap", () => {
    expectErr(validatePlanRevision("garbage", baseOpts), /unexpected line|no TASK blocks/);
    expectErr(
      validatePlanRevision(block({ key: "q1", reqs: "REQ-002" }), baseOpts),
      /already exists/,
    );
    expectErr(
      validatePlanRevision(
        [
          block({ key: "n1", reqs: "REQ-002" }),
          block({ key: "n2", reqs: "REQ-003", depends: "n1" }),
        ].join("\n"),
        { ...baseOpts, maxReplanTasks: 1 },
      ),
      /revision block has 2 tasks > cap 1/,
    );
  });
  it("rejects claimed and parked owners; merged/superseded are fine", () => {
    expectErr(
      validatePlanRevision(block({ key: "n1", reqs: "REQ-002" }), {
        ...baseOpts,
        liveTasks: [live({ key: "r1", state: "running", reqs: ["REQ-002"] })],
      }),
      /belongs to claimed task 'r1'/,
    );
    expectErr(
      validatePlanRevision(block({ key: "n1", reqs: "REQ-002" }), {
        ...baseOpts,
        liveTasks: [live({ key: "f1", state: "dep_failed", reqs: ["REQ-002"] })],
      }),
      /belongs to parked task 'f1'/,
    );
    const okWithHistory = validatePlanRevision(block({ key: "n1", reqs: "REQ-002" }), {
      ...baseOpts,
      liveTasks: [
        live({ key: "q1", state: "queued", reqs: ["REQ-002"] }),
        live({ key: "old", state: "merged", reqs: ["REQ-002"] }),
        live({ key: "gone", state: "superseded", reqs: ["REQ-002"] }),
      ],
    });
    expect(okWithHistory.ok).toBe(true);
  });
  it("rejects when the REQs match nothing queued or conservation fails", () => {
    expectErr(
      validatePlanRevision(block({ key: "n1", reqs: "REQ-009" }), baseOpts),
      /match no queued task/,
    );
    expectErr(
      validatePlanRevision(block({ key: "n1", reqs: "REQ-002" }), baseOpts),
      // q2 depends on q1 (replaced) and is not included → dependent rule fires
      /depends on replaced task 'q1'/,
    );
    expectErr(
      validatePlanRevision(
        [
          block({ key: "n1", reqs: "REQ-002" }),
          block({ key: "n2", reqs: "REQ-002", depends: "n1" }),
        ].join("\n"),
        {
          ...baseOpts,
          liveTasks: [
            live({ key: "q1", state: "queued", reqs: ["REQ-002", "REQ-003"] }),
          ],
        },
      ),
      /does not conserve/,
    );
  });
  it("validates structure, failed deps and chains inside the block", () => {
    const opts = {
      ...baseOpts,
      liveTasks: [
        live({ key: "q1", state: "queued", reqs: ["REQ-002"] }),
        live({ key: "dead", state: "failed", reqs: [] }),
      ],
    };
    expectErr(
      validatePlanRevision(block({ key: "n1", reqs: "REQ-002", depends: "ghost" }), opts),
      /unknown task 'ghost'/,
    );
    expectErr(
      validatePlanRevision(block({ key: "n1", reqs: "REQ-002", depends: "dead" }), opts),
      /depends on failed task 'dead'/,
    );
    expectErr(
      validatePlanRevision(
        [
          block({ key: "n1", reqs: "REQ-002" }),
          block({ key: "n2", reqs: "REQ-002" }),
        ].join("\n"),
        opts,
      ),
      /no single completing owner/,
    );
  });
  it("caps the post-swap in-flight queue size", () => {
    const opts = {
      liveTasks: [
        live({ key: "q1", state: "queued", reqs: ["REQ-002"] }),
        live({ key: "r1", state: "running", reqs: ["REQ-001"] }),
      ],
      maxReplanTasks: 3,
      maxTasks: 2,
    };
    expectErr(
      validatePlanRevision(
        [
          block({ key: "n1", reqs: "REQ-002" }),
          block({ key: "n2", reqs: "REQ-002", depends: "n1" }),
        ].join("\n"),
        opts,
      ),
      /tasks in flight > cap 2/,
    );
  });
});

// ── fix-up validation ───────────────────────────────────────────────────

describe("validateFixupTask", () => {
  const liveTasks: DevLiveTaskLike[] = [
    live({ key: "done1", state: "merged", reqs: ["REQ-001"] }),
    live({ key: "parked", state: "awaiting_user", reqs: ["REQ-002"] }),
    live({ key: "dead", state: "failed", reqs: [] }),
  ];
  it("accepts exactly one task that may revisit merged REQs", () => {
    const res = validateFixupTask(
      block({ key: "fixup-1", reqs: "REQ-001", depends: "done1" }),
      { liveTasks },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.task.key).toBe("fixup-1");
  });
  it("rejects malformed payloads, multi-task blocks and collisions", () => {
    expectErr(validateFixupTask("garbage", { liveTasks }), /unexpected line|no TASK blocks/);
    expectErr(
      validateFixupTask(
        [block({ key: "f1", reqs: "REQ-001" }), block({ key: "f2", reqs: "REQ-001" })].join("\n"),
        { liveTasks },
      ),
      /exactly ONE task \(got 2\)/,
    );
    expectErr(
      validateFixupTask(block({ key: "done1", reqs: "REQ-001" }), { liveTasks }),
      /already exists/,
    );
  });
  it("rejects unknown or failed deps and live-REQ collisions", () => {
    expectErr(
      validateFixupTask(block({ key: "f1", reqs: "REQ-001", depends: "ghost" }), { liveTasks }),
      /unknown task 'ghost'/,
    );
    expectErr(
      validateFixupTask(block({ key: "f1", reqs: "REQ-001", depends: "dead" }), { liveTasks }),
      /depends on failed task 'dead'/,
    );
    expectErr(
      validateFixupTask(block({ key: "f1", reqs: "REQ-002" }), { liveTasks }),
      /claims REQ-002 owned by live task 'parked'/,
    );
  });
});
