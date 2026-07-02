import { describe, it, expect } from "vitest";
import { groupProjects } from "./projects-tree.logic";

describe("groupProjects", () => {
  it("groups by lifecycle state in active → on-hold → archived order", () => {
    const { groups } = groupProjects([
      { name: "old.md", meta: { title: "Old thing", state: "archived" } },
      { name: "paused.md", meta: { title: "Paused", state: "on-hold" } },
      { name: "ucla.md", meta: { title: "UCLA course", state: "active" } },
    ]);
    expect(groups.map((g) => g.key)).toEqual(["active", "on-hold", "archived"]);
    expect(groups.map((g) => g.label)).toEqual([
      "Active",
      "On hold",
      "Archived",
    ]);
  });

  it("omits empty groups", () => {
    const { groups } = groupProjects([
      { name: "ucla.md", meta: { title: "UCLA course", state: "active" } },
    ]);
    expect(groups.map((g) => g.key)).toEqual(["active"]);
  });

  it("sorts items by title within a group", () => {
    const { groups } = groupProjects([
      { name: "z.md", meta: { title: "Beta", state: "active" } },
      { name: "a.md", meta: { title: "alpha", state: "active" } },
    ]);
    expect(groups[0]!.items.map((i) => i.title)).toEqual(["alpha", "Beta"]);
  });

  it("routes incubating and unknown states into the active group with state preserved", () => {
    const { groups } = groupProjects([
      { name: "seed.md", meta: { title: "Seed", state: "incubating" } },
      { name: "odd.md", meta: { title: "Odd", state: "someday" } },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe("active");
    expect(groups[0]!.items.map((i) => i.state).sort()).toEqual([
      "incubating",
      "someday",
    ]);
  });

  it("normalizes on_hold to the on-hold group", () => {
    const { groups } = groupProjects([
      { name: "p.md", meta: { title: "P", state: "on_hold" } },
    ]);
    expect(groups[0]!.key).toBe("on-hold");
  });

  it("builds extension-stripped selection paths", () => {
    const { groups } = groupProjects([
      { name: "ucla.md", meta: { title: "UCLA", state: "active" } },
    ]);
    expect(groups[0]!.items[0]).toMatchObject({
      slug: "ucla",
      selectionPath: "plans/projects/ucla",
    });
  });

  it("excludes _index.md entirely", () => {
    const { groups, other } = groupProjects([{ name: "_index.md" }]);
    expect(groups).toEqual([]);
    expect(other).toEqual([]);
  });

  it("collects meta-less files under other with extensions preserved for .base", () => {
    const { other } = groupProjects([
      { name: "_active.base" },
      { name: "stray.md" },
    ]);
    expect(other).toEqual([
      { name: "_active.base", selectionPath: "plans/projects/_active.base" },
      { name: "stray.md", selectionPath: "plans/projects/stray" },
    ]);
  });
});
