import { describe, it, expect } from "vitest";
import {
  buildContextTree,
  selectionPathFor,
  type ContextTreeNode,
} from "./context-files-tree.logic";

const asDir = (n: ContextTreeNode) => {
  if (n.kind !== "dir") throw new Error(`expected dir, got ${n.kind}`);
  return n;
};
const asFile = (n: ContextTreeNode) => {
  if (n.kind !== "file") throw new Error(`expected file, got ${n.kind}`);
  return n;
};

describe("buildContextTree", () => {
  it("returns an empty tree for an empty file list", () => {
    expect(buildContextTree([])).toEqual([]);
  });

  it("returns flat file nodes when no slashes are present", () => {
    const tree = buildContextTree([{ name: "foo.md" }, { name: "bar.md" }]);
    expect(tree).toHaveLength(2);
    expect(tree.every((n) => n.kind === "file")).toBe(true);
    // alpha-sorted within the file group
    expect(tree.map((n) => n.name)).toEqual(["bar.md", "foo.md"]);
  });

  it("groups one level of nesting under a single dir node", () => {
    const tree = buildContextTree([
      { name: "aitne/overview.md" },
      { name: "bolt/overview.md" },
    ]);
    expect(tree).toHaveLength(2);
    expect(tree.map((n) => `${n.kind}:${n.name}`)).toEqual([
      "dir:aitne",
      "dir:bolt",
    ]);
    const aitne = asDir(tree[0]);
    expect(aitne.relPath).toBe("aitne");
    expect(aitne.children).toHaveLength(1);
    expect(asFile(aitne.children[0])).toMatchObject({
      name: "overview.md",
      relPath: "aitne/overview.md",
    });
  });

  it("groups two levels of nesting (slug/journal/date.md) into nested dirs", () => {
    const tree = buildContextTree([
      { name: "aitne/overview.md" },
      { name: "aitne/journal/2026-05-06.md" },
      { name: "aitne/journal/2026-05-07.md" },
    ]);
    expect(tree).toHaveLength(1);
    const aitne = asDir(tree[0]);
    // dir (`journal`) sorts before file (`overview.md`) at the aitne/ level
    expect(aitne.children.map((n) => `${n.kind}:${n.name}`)).toEqual([
      "dir:journal",
      "file:overview.md",
    ]);
    const journal = asDir(aitne.children[0]);
    expect(journal.relPath).toBe("aitne/journal");
    expect(journal.children).toHaveLength(2);
    // Date entries sort alphabetically (which equals chronologically for ISO YYYY-MM-DD names)
    expect(journal.children.map((n) => asFile(n).relPath)).toEqual([
      "aitne/journal/2026-05-06.md",
      "aitne/journal/2026-05-07.md",
    ]);
  });

  it("merges multiple files sharing a directory prefix into the same dir node", () => {
    const tree = buildContextTree([
      { name: "policies/foo.md" },
      { name: "policies/bar.md" },
      { name: "policies/baz.md" },
    ]);
    expect(tree).toHaveLength(1);
    const policies = asDir(tree[0]);
    expect(policies.children).toHaveLength(3);
    expect(policies.children.map((c) => c.name)).toEqual([
      "bar.md",
      "baz.md",
      "foo.md",
    ]);
  });

  it("places dirs before files at every level, alphabetical within each group", () => {
    const tree = buildContextTree([
      { name: "z.md" },
      { name: "a.md" },
      { name: "z-dir/x.md" },
      { name: "a-dir/x.md" },
    ]);
    expect(tree.map((n) => `${n.kind}:${n.name}`)).toEqual([
      "dir:a-dir",
      "dir:z-dir",
      "file:a.md",
      "file:z.md",
    ]);
  });

  it("preserves non-.md extensions verbatim in relPath", () => {
    // `.base` (Obsidian Bases) keeps its extension; tree-building is
    // extension-agnostic and just records the raw segment.
    const tree = buildContextTree([{ name: "aitne/data.base" }]);
    const aitne = asDir(tree[0]);
    const file = asFile(aitne.children[0]);
    expect(file.name).toBe("data.base");
    expect(file.relPath).toBe("aitne/data.base");
  });

  it("does not treat the input as ordered — equivalent inputs in any order produce equal trees", () => {
    const a = buildContextTree([
      { name: "aitne/journal/2026-05-07.md" },
      { name: "aitne/overview.md" },
      { name: "aitne/journal/2026-05-06.md" },
    ]);
    const b = buildContextTree([
      { name: "aitne/overview.md" },
      { name: "aitne/journal/2026-05-06.md" },
      { name: "aitne/journal/2026-05-07.md" },
    ]);
    expect(a).toEqual(b);
  });
});

describe("selectionPathFor", () => {
  it("strips a trailing .md extension", () => {
    expect(selectionPathFor("git", "aitne/overview.md")).toBe(
      "git/aitne/overview",
    );
  });

  it("strips .md only at the end of the path", () => {
    // A directory segment that contains `.md` substring should not be touched
    expect(selectionPathFor("git", "aitne.md.notes/overview.md")).toBe(
      "git/aitne.md.notes/overview",
    );
  });

  it("preserves .base extensions", () => {
    expect(selectionPathFor("git", "aitne/data.base")).toBe(
      "git/aitne/data.base",
    );
  });

  it("works for top-level (non-nested) files", () => {
    expect(selectionPathFor("inbox", "note.md")).toBe("inbox/note");
  });
});
