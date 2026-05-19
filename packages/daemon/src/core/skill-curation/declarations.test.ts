import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  lintAnchorPlacement,
  loadAllCurationDeclarations,
  loadCurationDeclaration,
  loadSkillCurationContext,
  parseAnchorsFromMarkdown,
} from "./declarations.js";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "skill-curation-decl-"));
});
afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function writeSkill(slug: string, md: string, declJson?: object) {
  const dir = join(workdir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), md, "utf-8");
  if (declJson) writeFileSync(join(dir, "curation.json"), JSON.stringify(declJson), "utf-8");
}

describe("parseAnchorsFromMarkdown", () => {
  it("parses CURATION anchors with kind+id", () => {
    const md = [
      "## Topic file layout",
      "",
      `<!-- CURATION:knowledge_layout id="topic-files" -->`,
      "",
      "## When to update — routing",
      "",
      `<!-- CURATION:routing_table id="routing-table" -->`,
    ].join("\n");
    const anchors = parseAnchorsFromMarkdown(md);
    expect(anchors).toHaveLength(2);
    expect(anchors[0].kind).toBe("knowledge_layout");
    expect(anchors[0].id).toBe("topic-files");
    expect(anchors[1].kind).toBe("routing_table");
  });

  it("ignores unknown kinds", () => {
    const md = `<!-- CURATION:fictional_kind id="x" -->`;
    expect(parseAnchorsFromMarkdown(md)).toHaveLength(0);
  });
});

describe("lintAnchorPlacement", () => {
  it("flags anchor without preceding heading", () => {
    const md = [
      "Some prose.",
      "",
      `<!-- CURATION:convention_notes id="x" -->`,
    ].join("\n");
    const anchors = parseAnchorsFromMarkdown(md);
    const decl = {
      version: 1 as const,
      sections: [{ id: "x", kind: "convention_notes" as const, anchor: "...", human_label: "x", description: "y", scope_paths: ["a.md"] }],
    };
    const diags = lintAnchorPlacement(md, decl, anchors);
    expect(diags.some((d) => d.code === "anchor_missing_heading")).toBe(true);
  });

  it("accepts heading on previous non-blank line through blank lines", () => {
    const md = [
      "## Heading",
      "",
      "",
      `<!-- CURATION:convention_notes id="x" -->`,
    ].join("\n");
    const anchors = parseAnchorsFromMarkdown(md);
    const decl = {
      version: 1 as const,
      sections: [{ id: "x", kind: "convention_notes" as const, anchor: "...", human_label: "x", description: "y", scope_paths: ["a.md"] }],
    };
    const diags = lintAnchorPlacement(md, decl, anchors);
    expect(diags.some((d) => d.code === "anchor_missing_heading")).toBe(false);
  });

  it("flags duplicate anchor ids", () => {
    const md = [
      "## A",
      `<!-- CURATION:convention_notes id="dup" -->`,
      "## B",
      `<!-- CURATION:convention_notes id="dup" -->`,
    ].join("\n");
    const anchors = parseAnchorsFromMarkdown(md);
    const decl = {
      version: 1 as const,
      sections: [{ id: "dup", kind: "convention_notes" as const, anchor: "...", human_label: "x", description: "y", scope_paths: ["a.md"] }],
    };
    const diags = lintAnchorPlacement(md, decl, anchors);
    expect(diags.some((d) => d.code === "anchor_id_duplicate")).toBe(true);
  });

  it("flags anchor kind mismatch", () => {
    const md = [
      "## A",
      `<!-- CURATION:knowledge_layout id="x" -->`,
    ].join("\n");
    const anchors = parseAnchorsFromMarkdown(md);
    const decl = {
      version: 1 as const,
      sections: [{ id: "x", kind: "convention_notes" as const, anchor: "...", human_label: "x", description: "y", scope_paths: ["a.md"] }],
    };
    const diags = lintAnchorPlacement(md, decl, anchors);
    expect(diags.some((d) => d.code === "anchor_kind_mismatch")).toBe(true);
  });

  it("flags orphan anchors", () => {
    const md = [
      "## A",
      `<!-- CURATION:convention_notes id="orphan" -->`,
    ].join("\n");
    const anchors = parseAnchorsFromMarkdown(md);
    const diags = lintAnchorPlacement(md, null, anchors);
    expect(diags.some((d) => d.code === "anchor_orphan")).toBe(true);
  });

  it("flags anchor_count_exceeded when more than 4 anchors are present", () => {
    // Covers lines 113-118 — Rule 3 soft cap of 4 anchors per skill.
    const md = [
      "## A",
      `<!-- CURATION:convention_notes id="a1" -->`,
      "## B",
      `<!-- CURATION:convention_notes id="a2" -->`,
      "## C",
      `<!-- CURATION:convention_notes id="a3" -->`,
      "## D",
      `<!-- CURATION:convention_notes id="a4" -->`,
      "## E",
      `<!-- CURATION:convention_notes id="a5" -->`,
    ].join("\n");
    const anchors = parseAnchorsFromMarkdown(md);
    expect(anchors).toHaveLength(5);
    const diags = lintAnchorPlacement(md, null, anchors);
    const exceeded = diags.find((d) => d.code === "anchor_count_exceeded");
    expect(exceeded).toBeDefined();
    expect(exceeded?.message).toContain("5");
  });

  it("flags anchor_orphan when declaration exists but lacks the anchor's id (covers 142-150)", () => {
    // Different from the existing 'flags orphan anchors' test, which uses a
    // null declaration. This one exercises the WITH-declaration branch in
    // lintAnchorPlacement: the declaration is present but does not contain
    // the anchor's id, so the loop pushes anchor_orphan and `continue;`
    // skips the kind-mismatch check.
    const md = [
      "## A",
      `<!-- CURATION:convention_notes id="not-declared" -->`,
    ].join("\n");
    const anchors = parseAnchorsFromMarkdown(md);
    const decl = {
      version: 1 as const,
      sections: [{
        id: "different-section",
        kind: "convention_notes" as const,
        anchor: "...",
        human_label: "x",
        description: "y",
        scope_paths: ["a.md"],
      }],
    };
    const diags = lintAnchorPlacement(md, decl, anchors);
    const orphan = diags.find((d) => d.code === "anchor_orphan");
    expect(orphan).toBeDefined();
    expect(orphan?.anchorId).toBe("not-declared");
    // Declaration's other section has no anchor → section_missing_anchor warning.
    expect(diags.some((d) => d.code === "section_missing_anchor")).toBe(true);
  });

  it("warns on declared section with no anchor", () => {
    const md = "## A\n";
    const decl = {
      version: 1 as const,
      sections: [{ id: "missing", kind: "convention_notes" as const, anchor: "...", human_label: "x", description: "y", scope_paths: ["a.md"] }],
    };
    const diags = lintAnchorPlacement(md, decl, []);
    const sma = diags.find((d) => d.code === "section_missing_anchor");
    expect(sma?.level).toBe("warning");
  });
});

describe("loadCurationDeclaration / loadSkillCurationContext", () => {
  it("returns null when no curation.json", () => {
    writeSkill("foo", "## A\n");
    expect(loadCurationDeclaration(workdir, "foo")).toBeNull();
  });

  it("loadAllCurationDeclarations returns [] when skillsRoot does not exist (covers 217)", () => {
    const missing = join(workdir, "no-such-skills-dir");
    expect(loadAllCurationDeclarations(missing)).toEqual([]);
  });

  it("loadAllCurationDeclarations skips non-directory entries (covers 220)", () => {
    // A stray file at the skill root must not be treated as a slug.
    writeFileSync(join(workdir, "stray.txt"), "ignored", "utf-8");
    writeSkill("real-skill", "## A\n");
    const all = loadAllCurationDeclarations(workdir);
    // The stray file is filtered out; only real-skill survives.
    expect(all.map((d) => d.slug)).toEqual(["real-skill"]);
  });

  it("loads + validates a well-formed declaration", () => {
    writeSkill(
      "foo",
      ["## A", "", `<!-- CURATION:convention_notes id="x" -->`].join("\n"),
      {
        version: 1,
        sections: [{ id: "x", kind: "convention_notes", anchor: `<!-- CURATION:convention_notes id="x" -->`, human_label: "X", description: "Y", scope_paths: ["a.md"] }],
      },
    );
    const ctx = loadSkillCurationContext(workdir, "foo");
    expect(ctx.declaration).not.toBeNull();
    expect(ctx.anchors).toHaveLength(1);
    expect(ctx.diagnostics.filter((d) => d.level === "error")).toHaveLength(0);
  });
});
