import { describe, expect, it } from "vitest";
import { SKILL_CURATION_BYTE_BUDGET } from "@aitne/shared";
import { renderCurationSection, rendererVersionFor, RENDERER_VERSIONS } from "./index.js";

describe("renderKnowledgeLayout", () => {
  it("emits a 3-column table when ≥3 files", () => {
    const md = renderCurationSection("knowledge_layout", {
      kind: "knowledge_layout",
      files: [
        { path: "user/profile.md", purpose: "identity", sections: [{ heading: "## Identity", contains: "name role" }] },
        { path: "user/people.md",  purpose: "people",   sections: [{ heading: "## Family",   contains: "spouse parents" }] },
        { path: "user/personal.md", purpose: "habits",  sections: [{ heading: "## Hobbies",  contains: "art games" }] },
      ],
    });
    expect(md).toContain("| File | Purpose | Sections |");
    expect(md).toContain("`user/profile.md`");
    expect(md.startsWith("|")).toBe(true);
  });

  it("emits bullets when <3 files", () => {
    const md = renderCurationSection("knowledge_layout", {
      kind: "knowledge_layout",
      files: [
        { path: "user/profile.md", purpose: "identity", sections: [{ heading: "## Identity", contains: "name role" }] },
        { path: "user/people.md",  purpose: "people",   sections: [{ heading: "## Family",   contains: "spouse parents" }] },
      ],
    });
    expect(md.startsWith("-")).toBe(true);
    expect(md).not.toContain("| File |");
  });

  it("annotates writers when more than one", () => {
    const md = renderCurationSection("knowledge_layout", {
      kind: "knowledge_layout",
      files: [
        { path: "today.md", purpose: "daily plan", sections: [
          { heading: "## Plan", contains: "stuff", writers: ["dm", "sweep"] },
        ] },
      ],
    });
    expect(md).toContain("(dm, sweep)");
  });

  it("strips heading markdown prefix in section list", () => {
    const md = renderCurationSection("knowledge_layout", {
      kind: "knowledge_layout",
      files: [
        { path: "x.md", purpose: "p", sections: [{ heading: "## Identity", contains: "yyyyy" }] },
        { path: "y.md", purpose: "q", sections: [{ heading: "### Sub",      contains: "yyyyy" }] },
      ],
    });
    expect(md).toContain("Identity");
    expect(md).toContain("Sub");
    expect(md).not.toContain("## Identity");
  });

  it("returns empty string for empty files list", () => {
    const md = renderCurationSection("knowledge_layout", { kind: "knowledge_layout", files: [] });
    expect(md).toBe("");
  });

  it("does not annotate writers when exactly one writer is listed", () => {
    const md = renderCurationSection("knowledge_layout", {
      kind: "knowledge_layout",
      files: [
        { path: "today.md", purpose: "daily plan", sections: [
          { heading: "## Plan", contains: "stuff", writers: ["dm"] },
        ] },
      ],
    });
    // single-writer arrays must not be inlined
    expect(md).not.toContain("(dm)");
    expect(md).not.toContain("_(dm)_");
  });
});

describe("renderRoutingTable", () => {
  it("emits a table at ≥3 rules with footnotes for notes", () => {
    const md = renderCurationSection("routing_table", {
      kind: "routing_table",
      rules: [
        { trigger_pattern: "user mentions a doctor visit", destination_path: "user/personal.md", destination_section: "## Health", destination_mode: "append", note: "include date" },
        { trigger_pattern: "user shares a goal target",   destination_path: "user/goals.md",    destination_section: "## Learning", destination_mode: "append" },
        { trigger_pattern: "user states a notification preference", destination_path: "user/profile.md", destination_section: "## Notification Preferences", destination_mode: "replace" },
      ],
    });
    expect(md).toContain("| Trigger | Destination | Mode |");
    expect(md).toContain("[^1]");
    expect(md).toContain("[^1]: include date");
  });

  it("falls back to bullets at <3 rules", () => {
    const md = renderCurationSection("routing_table", {
      kind: "routing_table",
      rules: [
        { trigger_pattern: "user mentions doctor visit", destination_path: "user/personal.md", destination_section: "## Health", destination_mode: "append" },
      ],
    });
    expect(md.startsWith("-")).toBe(true);
  });

  it("returns empty string for empty rules list", () => {
    const md = renderCurationSection("routing_table", { kind: "routing_table", rules: [] });
    expect(md).toBe("");
  });

  it("emits a table without footnote section when no rule has a note", () => {
    const md = renderCurationSection("routing_table", {
      kind: "routing_table",
      rules: [
        { trigger_pattern: "user mentions a doctor visit", destination_path: "user/personal.md", destination_section: "## Health", destination_mode: "append" },
        { trigger_pattern: "user shares a goal target",   destination_path: "user/goals.md",    destination_section: "## Learning", destination_mode: "append" },
        { trigger_pattern: "user states a notification preference", destination_path: "user/profile.md", destination_section: "## Notification Preferences", destination_mode: "replace" },
      ],
    });
    expect(md).toContain("| Trigger | Destination | Mode |");
    // No footnote refs or footnote section
    expect(md).not.toContain("[^1]");
    // All trigger cells must end with the | column delimiter (no [^N] suffix)
    expect(md).not.toMatch(/\[\^\d+\]/);
  });

  it("renders bullet form with appended note in <3 rules case", () => {
    const md = renderCurationSection("routing_table", {
      kind: "routing_table",
      rules: [
        { trigger_pattern: "user mentions doctor visit", destination_path: "user/personal.md", destination_section: "## Health", destination_mode: "append", note: "include date" },
      ],
    });
    expect(md).toContain(" — include date");
  });
});

describe("renderFrontmatterSchema", () => {
  it("renders required + conventional inline", () => {
    const md = renderCurationSection("frontmatter_schema", {
      kind: "frontmatter_schema",
      file_types: [{
        glob: "projects/*.md",
        required: [
          { key: "type", type: "enum", example: "project" },
          { key: "owner", type: "string", example: "shared" },
        ],
        conventional: [
          { key: "slug", purpose: "kebab-case slug" },
        ],
      }],
    });
    expect(md).toContain("**`projects/*.md`**");
    expect(md).toContain("Required:");
    expect(md).toContain("Conventional:");
  });
});

describe("renderSearchRecipes", () => {
  it("renders a 2-column table", () => {
    const md = renderCurationSection("search_recipes", {
      kind: "search_recipes",
      recipes: [
        { question_shape: "who the user reports to", lookup_path: "user/work.md", lookup_section: "## Reporting", note: "freshest version is wiki" },
        { question_shape: "recent doctor visits", lookup_path: "user/personal.md", lookup_section: "## Health" },
        { question_shape: "user's tz", lookup_path: "user/profile.md" },
      ],
    });
    expect(md).toContain("| If you need to know… | Read |");
    // First recipe carries a note → footnote ref + footnote line
    expect(md).toContain("[^1]");
    expect(md).toContain("[^1]: freshest version is wiki");
  });

  it("returns empty string for empty recipes list", () => {
    const md = renderCurationSection("search_recipes", { kind: "search_recipes", recipes: [] });
    expect(md).toBe("");
  });

  it("renders a table with no footnote section when no recipe has a note", () => {
    const md = renderCurationSection("search_recipes", {
      kind: "search_recipes",
      recipes: [
        { question_shape: "who reports to whom", lookup_path: "user/work.md", lookup_section: "## Reporting" },
        { question_shape: "recent doctor visits", lookup_path: "user/personal.md" },
        { question_shape: "tz", lookup_path: "user/profile.md" },
      ],
    });
    expect(md).toContain("| If you need to know… | Read |");
    expect(md).not.toMatch(/\[\^\d+\]/);
  });

  it("renders bullets with appended note in <3 recipes case", () => {
    const md = renderCurationSection("search_recipes", {
      kind: "search_recipes",
      recipes: [
        { question_shape: "user's tz", lookup_path: "user/profile.md", note: "may be stale on travel" },
      ],
    });
    expect(md.startsWith("-")).toBe(true);
    expect(md).toContain(" — may be stale on travel");
  });

  it("renders bullets without note suffix when none is provided", () => {
    const md = renderCurationSection("search_recipes", {
      kind: "search_recipes",
      recipes: [
        { question_shape: "user's tz", lookup_path: "user/profile.md" },
      ],
    });
    expect(md.startsWith("-")).toBe(true);
    expect(md).not.toMatch(/—/);
  });
});

describe("renderConventionNotes", () => {
  it("emits bulletted **topic** descriptions", () => {
    const md = renderCurationSection("convention_notes", {
      kind: "convention_notes",
      notes: [
        { topic: "Date prefix", rule: "Entries are written as [YYYY-MM-DD] prefix.", example: "- [2026-04-01] Prefers concise bullets" },
        { topic: "Slug grammar", rule: "Slugs are kebab-case, ≤32 chars, no leading digits." },
      ],
    });
    expect(md).toContain("- **Date prefix.**");
    expect(md).toContain("Example:");
  });
});

describe("renderCrossReferences", () => {
  it("emits single-line bullets", () => {
    const md = renderCurationSection("cross_references", {
      kind: "cross_references",
      refs: [
        { from_path: "projects/*.md", to_path: "user/people.md", relation: "people referenced from a project" },
      ],
    });
    expect(md).toContain("`projects/*.md`");
    expect(md).toContain("`user/people.md`");
    expect(md).toContain("↔");
  });
});

describe("output never includes headings", () => {
  it.each([
    ["knowledge_layout", { kind: "knowledge_layout" as const, files: [{ path: "x.md", purpose: "p", sections: [{ heading: "## H", contains: "yyyyy" }] }] }],
    ["routing_table", { kind: "routing_table" as const, rules: [{ trigger_pattern: "user says X", destination_path: "x.md", destination_section: "## S", destination_mode: "append" as const }] }],
    ["search_recipes", { kind: "search_recipes" as const, recipes: [{ question_shape: "who reports to whom", lookup_path: "x.md" }] }],
    ["convention_notes", { kind: "convention_notes" as const, notes: [{ topic: "T", rule: "Plain descriptive sentence." }] }],
    ["cross_references", { kind: "cross_references" as const, refs: [{ from_path: "a.md", to_path: "b.md", relation: "rel" }] }],
  ])("never emits a heading line for %s", (kind, payload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const md = renderCurationSection(kind as never, payload as any);
    for (const line of md.split("\n")) {
      expect(line.startsWith("# ")).toBe(false);
      expect(line.startsWith("## ")).toBe(false);
      expect(line.startsWith("### ")).toBe(false);
    }
  });
});

describe("byte budgets sanity-check", () => {
  it("typical small payloads stay well under their budgets", () => {
    const md = renderCurationSection("convention_notes", {
      kind: "convention_notes",
      notes: [{ topic: "Date prefix", rule: "Entries are written as [YYYY-MM-DD] prefix." }],
    });
    expect(Buffer.byteLength(md, "utf-8")).toBeLessThan(SKILL_CURATION_BYTE_BUDGET.convention_notes);
  });
});

describe("rendererVersionFor", () => {
  it("returns the right version per kind", () => {
    expect(rendererVersionFor("knowledge_layout")).toBe(RENDERER_VERSIONS.knowledge_layout);
    expect(rendererVersionFor("routing_table")).toBe(RENDERER_VERSIONS.routing_table);
  });
});

describe("kind/payload mismatch", () => {
  it("throws when called with mismatched discriminator", () => {
    expect(() =>
      renderCurationSection("routing_table", {
        kind: "knowledge_layout",
        files: [{ path: "x.md", purpose: "p", sections: [{ heading: "## H", contains: "yyyyy" }] }],
      }),
    ).toThrow(/kind mismatch/);
  });
});
