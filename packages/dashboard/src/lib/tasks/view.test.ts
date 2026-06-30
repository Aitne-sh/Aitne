import { describe, it, expect } from "vitest";
import { groupTasksByKind, kindLabel, originLabel, KIND_ORDER } from "./view.js";
import type { TaskBoardItem, TaskKind } from "./types.js";

function item(over: Partial<TaskBoardItem> & { ref: string; kind: TaskKind }): TaskBoardItem {
  return {
    title: over.ref,
    status: "active",
    cadence: null,
    fulfilledBy: over.ref,
    origin: "user",
    lastResult: null,
    lastRunAt: null,
    nextRunAt: null,
    ...over,
  };
}

describe("labels", () => {
  it("labels every kind and origin", () => {
    for (const kind of KIND_ORDER) expect(kindLabel(kind).length).toBeGreaterThan(0);
    expect(originLabel("system")).toBe("System");
    expect(originLabel("user")).toBe("You");
    expect(originLabel("agent")).toBe("Agent");
  });
});

describe("groupTasksByKind", () => {
  it("groups in KIND_ORDER, drops empty groups, keeps within-kind order", () => {
    const items = [
      item({ ref: "cluster:c", kind: "research" }),
      item({ ref: "rs:7", kind: "dm" }),
      item({ ref: "rs:42", kind: "dm" }),
      item({ ref: "agent:a", kind: "agent" }),
    ];
    const groups = groupTasksByKind(items);
    expect(groups.map((g) => g.kind)).toEqual(["dm", "agent", "research"]);
    expect(groups[0].items.map((i) => i.ref)).toEqual(["rs:7", "rs:42"]); // server order kept
    expect(groups[0].label).toBe("Recurring DMs");
  });

  it("returns no groups for an empty board", () => {
    expect(groupTasksByKind([])).toEqual([]);
  });

  it("surfaces an unknown kind after the known ones", () => {
    const items = [
      item({ ref: "rs:1", kind: "dm" }),
      item({ ref: "x:1", kind: "mystery" as TaskKind }),
    ];
    const groups = groupTasksByKind(items);
    expect(groups.map((g) => g.kind)).toEqual(["dm", "mystery"]);
    expect(groups[1].label).toBe("mystery");
  });
});
