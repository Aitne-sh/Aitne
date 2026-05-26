import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CurationPayloadValue, SectionKind } from "@aitne/shared";
import { applySchema } from "../../db/schema.js";
import { recordSignal } from "./signals.js";
import { buildKnowledgeMap } from "./knowledge-map.js";
import { OverlayStore } from "./overlay-store.js";
import { runSmokeTest } from "./smoke-test.js";

let db: Database.Database;
let dataDir: string;
let skillsRoot: string;
let contextDir: string;
let overlay: OverlayStore;

beforeEach(() => {
  db = new Database(":memory:");
  applySchema(db);
  const root = mkdtempSync(join(tmpdir(), "smoke-"));
  dataDir = join(root, "d");
  skillsRoot = join(root, "s");
  contextDir = join(root, "c");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(skillsRoot, { recursive: true });
  mkdirSync(contextDir, { recursive: true });
  overlay = new OverlayStore(dataDir, skillsRoot);
});
afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(skillsRoot, { recursive: true, force: true });
  rmSync(contextDir, { recursive: true, force: true });
});

function basicInput(overrides: {
  payload: CurationPayloadValue;
  rendered_md: string;
  section_kind: SectionKind;
  signal_ids?: number[];
  frozen?: boolean;
  siblingPayloads?: Record<string, CurationPayloadValue>;
}) {
  return {
    db,
    skill_slug: "user-profile",
    section_id: "topic-files",
    section_kind: overrides.section_kind,
    payload: overrides.payload,
    rendered_md: overrides.rendered_md,
    signal_ids: overrides.signal_ids ?? [],
    snapshot: buildKnowledgeMap(contextDir),
    overlay,
    frozenSet: new Set<string>(overrides.frozen ? ["user-profile:topic-files"] : []),
    siblingPayloads: overrides.siblingPayloads,
  };
}

describe("runSmokeTest — render budget + markers", () => {
  it("rejects rendered MD that exceeds the byte budget", () => {
    const big = "x".repeat(2000);
    const r = runSmokeTest(basicInput({
      payload: { kind: "convention_notes", notes: [{ topic: "T", rule: "Plain rule." }] },
      rendered_md: big,
      section_kind: "convention_notes",
      signal_ids: [seedSignal()],
    }));
    expect(r.failures.find((f) => f.check === "render_within_budget")).toBeDefined();
  });

  it("rejects markers smuggled into rendered MD", () => {
    const r = runSmokeTest(basicInput({
      payload: { kind: "convention_notes", notes: [{ topic: "T", rule: "Plain rule." }] },
      rendered_md: "<!-- CURATION:routing_table id=\"x\" -->",
      section_kind: "convention_notes",
      signal_ids: [seedSignal()],
    }));
    expect(r.failures.find((f) => f.check === "no_embedded_markers")).toBeDefined();
  });
});

describe("runSmokeTest — paths_resolve / sections_resolve", () => {
  it("rejects routing_table whose destination_path does not exist", () => {
    const r = runSmokeTest(basicInput({
      payload: {
        kind: "routing_table",
        rules: [{
          trigger_pattern: "user mentions a doctor visit",
          destination_path: "identity/missing.md",
          destination_section: "## Health",
          destination_mode: "append",
        }],
      },
      rendered_md: "- ok",
      section_kind: "routing_table",
      signal_ids: [seedSignal()],
    }));
    expect(r.failures.find((f) => f.check === "paths_resolve")).toBeDefined();
  });

  it("rejects routing_table whose destination_section is missing in file", () => {
    mkdirSync(join(contextDir, "identity"));
    writeFileSync(join(contextDir, "identity", "personal.md"), "## OtherSection\n");
    const r = runSmokeTest(basicInput({
      payload: {
        kind: "routing_table",
        rules: [{
          trigger_pattern: "user mentions a doctor visit",
          destination_path: "identity/personal.md",
          destination_section: "## Missing",
          destination_mode: "append",
        }],
      },
      rendered_md: "- ok",
      section_kind: "routing_table",
      signal_ids: [seedSignal()],
    }));
    expect(r.failures.find((f) => f.check === "sections_resolve")).toBeDefined();
  });

  it("allows append_to_file mode regardless of section presence", () => {
    mkdirSync(join(contextDir, "identity"));
    writeFileSync(join(contextDir, "identity", "personal.md"), "## OtherSection\n");
    const r = runSmokeTest(basicInput({
      payload: {
        kind: "routing_table",
        rules: [{
          trigger_pattern: "user mentions a doctor visit",
          destination_path: "identity/personal.md",
          destination_section: "## NewSection",
          destination_mode: "append_to_file",
        }],
      },
      rendered_md: "- ok",
      section_kind: "routing_table",
      signal_ids: [seedSignal()],
    }));
    expect(r.failures.find((f) => f.check === "sections_resolve")).toBeUndefined();
  });
});

describe("runSmokeTest — duplicates", () => {
  it("rejects duplicate primary keys", () => {
    const r = runSmokeTest(basicInput({
      payload: {
        kind: "convention_notes",
        notes: [
          { topic: "Dates", rule: "Entries are written as [YYYY-MM-DD]." },
          { topic: "Dates", rule: "Entries use ISO timestamps." },
        ],
      },
      rendered_md: "- ok",
      section_kind: "convention_notes",
      signal_ids: [seedSignal()],
    }));
    expect(r.failures.find((f) => f.check === "no_duplicate_entries")).toBeDefined();
  });
});

describe("runSmokeTest — frozen", () => {
  it("rejects when section is frozen", () => {
    const r = runSmokeTest(basicInput({
      payload: { kind: "convention_notes", notes: [{ topic: "T", rule: "Plain rule." }] },
      rendered_md: "- ok",
      section_kind: "convention_notes",
      signal_ids: [seedSignal()],
      frozen: true,
    }));
    expect(r.failures.find((f) => f.check === "frozen_sections_unchanged")).toBeDefined();
  });
});

describe("runSmokeTest — signal_citations_valid", () => {
  it("requires at least one signal_id", () => {
    const r = runSmokeTest(basicInput({
      payload: { kind: "convention_notes", notes: [{ topic: "T", rule: "Plain rule." }] },
      rendered_md: "- ok",
      section_kind: "convention_notes",
      signal_ids: [],
    }));
    expect(r.failures.find((f) => f.check === "signal_citations_valid")).toBeDefined();
  });

  it("rejects signals from a different skill", () => {
    const sig = recordSignal(db, { skill_slug: "other-skill", signal_type: "structure_diff", payload: { sub_kind: "heading_add" } });
    const r = runSmokeTest(basicInput({
      payload: { kind: "convention_notes", notes: [{ topic: "T", rule: "Plain rule." }] },
      rendered_md: "- ok",
      section_kind: "convention_notes",
      signal_ids: [sig],
    }));
    expect(r.failures.find((f) => f.check === "signal_citations_valid")).toBeDefined();
  });

  it("passes when signals exist, unconsumed, same skill", () => {
    const sig = seedSignal();
    const r = runSmokeTest(basicInput({
      payload: { kind: "convention_notes", notes: [{ topic: "T", rule: "Plain rule." }] },
      rendered_md: "- ok",
      section_kind: "convention_notes",
      signal_ids: [sig],
    }));
    expect(r.failures.find((f) => f.check === "signal_citations_valid")).toBeUndefined();
  });
});

describe("runSmokeTest — cross_section_consistency", () => {
  it("flags routing rule whose section is absent from this skill's knowledge_layout", () => {
    mkdirSync(join(contextDir, "identity"));
    writeFileSync(join(contextDir, "identity", "personal.md"), "## Health\n");
    const sibling: Record<string, CurationPayloadValue> = {
      "topic-files": {
        kind: "knowledge_layout",
        files: [{ path: "identity/personal.md", purpose: "habits and health", sections: [{ heading: "## Hobbies", contains: "art games" }] }],
      },
    };
    const r = runSmokeTest(basicInput({
      payload: {
        kind: "routing_table",
        rules: [{
          trigger_pattern: "user mentions a doctor visit",
          destination_path: "identity/personal.md",
          destination_section: "## Health",
          destination_mode: "append",
        }],
      },
      rendered_md: "- ok",
      section_kind: "routing_table",
      signal_ids: [seedSignal()],
      siblingPayloads: sibling,
    }));
    expect(r.failures.find((f) => f.check === "cross_section_consistency")).toBeDefined();
  });
});

describe("runSmokeTest — inverse cross_section_consistency with no siblings (line 188 ?? right-branch)", () => {
  it("knowledge_layout proposal with no siblingPayloads passes without cross_section_consistency failure", () => {
    // siblingPayloads is not set → input.siblingPayloads is undefined
    // → collectRoutingTableReferences(input.siblingPayloads ?? {}) fires the right side of ??
    // → referencedByRouting is empty → no inverse check failure.
    mkdirSync(join(contextDir, "identity"));
    writeFileSync(join(contextDir, "identity", "personal.md"), "## Health\n");
    const r = runSmokeTest(basicInput({
      payload: {
        kind: "knowledge_layout",
        files: [{
          path: "identity/personal.md",
          purpose: "health data",
          sections: [{ heading: "## Health", contains: "doctor visits" }],
        }],
      },
      rendered_md: "- ok",
      section_kind: "knowledge_layout",
      signal_ids: [seedSignal()],
      // siblingPayloads deliberately omitted → undefined
    }));
    expect(r.failures.find((f) => f.check === "cross_section_consistency")).toBeUndefined();
  });
});

describe("runSmokeTest — inverse cross_section_consistency (knowledge_layout)", () => {
  it("flags knowledge_layout that drops a section still referenced by sibling routing rules (covers 374-379)", () => {
    // The proposal removes "## Health" from user/personal.md but a sibling
    // routing_table still routes content there → must be rejected.
    mkdirSync(join(contextDir, "identity"));
    writeFileSync(join(contextDir, "identity", "personal.md"), "## Hobbies\n");
    const sibling: Record<string, CurationPayloadValue> = {
      "routing-rules": {
        kind: "routing_table",
        rules: [
          {
            // Non-append_to_file → its destination_section is collected.
            trigger_pattern: "user mentions a doctor visit",
            destination_path: "identity/personal.md",
            destination_section: "## Health",
            destination_mode: "append",
          },
          {
            // append_to_file mode → must be SKIPPED by collectRoutingTableReferences.
            trigger_pattern: "user mentions a journal entry",
            destination_path: "identity/personal.md",
            destination_section: "## Journal",
            destination_mode: "append_to_file",
          },
        ],
      },
    };
    const r = runSmokeTest(basicInput({
      payload: {
        kind: "knowledge_layout",
        files: [{
          path: "identity/personal.md",
          purpose: "habits and hobbies, no health",
          // Health was removed; only Hobbies remains.
          sections: [{ heading: "## Hobbies", contains: "art games" }],
        }],
      },
      rendered_md: "- ok",
      section_kind: "knowledge_layout",
      signal_ids: [seedSignal()],
      siblingPayloads: sibling,
    }));
    const inverse = r.failures.find((f) => f.check === "cross_section_consistency");
    expect(inverse).toBeDefined();
    expect(inverse?.message).toContain("Health");
    // append_to_file rule was skipped → no message about Journal.
    expect(r.failures.every((f) => !f.message.includes("Journal"))).toBe(true);
  });

  it("does not flag when sibling routing references are still satisfied", () => {
    mkdirSync(join(contextDir, "identity"));
    writeFileSync(join(contextDir, "identity", "personal.md"), "## Health\n");
    const sibling: Record<string, CurationPayloadValue> = {
      "routing-rules": {
        kind: "routing_table",
        rules: [{
          trigger_pattern: "user mentions a doctor visit",
          destination_path: "identity/personal.md",
          destination_section: "## Health",
          destination_mode: "append",
        }],
      },
    };
    const r = runSmokeTest(basicInput({
      payload: {
        kind: "knowledge_layout",
        files: [{
          path: "identity/personal.md",
          purpose: "habits and health",
          sections: [{ heading: "## Health", contains: "doctor visits" }],
        }],
      },
      rendered_md: "- ok",
      section_kind: "knowledge_layout",
      signal_ids: [seedSignal()],
      siblingPayloads: sibling,
    }));
    expect(r.failures.find((f) => f.check === "cross_section_consistency")).toBeUndefined();
  });
});

describe("runSmokeTest — decision_language_clean truncation (covers 387-389)", () => {
  it("truncates long offending strings with ellipsis in the failure message", () => {
    // The decision-language rule rejects imperative phrasing in free-text
    // fields. Trigger it with a phrase >60 chars so the truncate() helper
    // adds the ellipsis suffix.
    const longRule =
      "when the user mentions any of these specific topics then the agent must immediately update the relevant file";
    expect(longRule.length).toBeGreaterThan(60);
    const r = runSmokeTest(basicInput({
      payload: {
        kind: "convention_notes",
        notes: [{ topic: "rule", rule: longRule }],
      },
      rendered_md: "- ok",
      section_kind: "convention_notes",
      signal_ids: [seedSignal()],
    }));
    const decision = r.failures.find((f) => f.check === "decision_language_clean");
    expect(decision).toBeDefined();
    // truncate() appends a single "…" after slicing to 60 chars.
    expect(decision?.message).toMatch(/…$/);
    // The truncated portion should be exactly 60 chars before the ellipsis.
    const m = decision?.message.match(/imperative phrasing in field: (.+)$/);
    expect(m).not.toBeNull();
    if (m) {
      const shown = m[1];
      expect(shown.endsWith("…")).toBe(true);
      expect(shown.length).toBe(61); // 60 chars + the ellipsis character
    }
  });

  it("does not truncate strings within the 60-char limit", () => {
    // Sanity — short strings pass through verbatim, no ellipsis.
    const shortRule = "must add a tag immediately"; // 26 chars, contains "must"
    const r = runSmokeTest(basicInput({
      payload: {
        kind: "convention_notes",
        notes: [{ topic: "rule", rule: shortRule }],
      },
      rendered_md: "- ok",
      section_kind: "convention_notes",
      signal_ids: [seedSignal()],
    }));
    const decision = r.failures.find((f) => f.check === "decision_language_clean");
    expect(decision).toBeDefined();
    expect(decision?.message.endsWith("…")).toBe(false);
  });
});

describe("runSmokeTest — render_parses helpers", () => {
  it("rejects malformed markdown tables (covers isWellFormedTable false)", () => {
    // Header has 3 columns, separator has 3, but body row has only 2 → reject.
    const md = ["| a | b | c |", "| - | - | - |", "| 1 | 2 |"].join("\n");
    const r = runSmokeTest(basicInput({
      payload: { kind: "convention_notes", notes: [{ topic: "T", rule: "Plain rule." }] },
      rendered_md: md,
      section_kind: "convention_notes",
      signal_ids: [seedSignal()],
    }));
    expect(r.failures.find((f) => f.check === "render_parses")).toBeDefined();
  });

  it("accepts well-formed tables (covers the table walker happy path / line 266)", () => {
    // Header + separator + matching rows must complete the inner for-j loop
    // and fall through to `return true`.
    const md = [
      "| a | b | c |",
      "| - | - | - |",
      "| 1 | 2 | 3 |",
      "| 4 | 5 | 6 |",
      "trailing prose",
    ].join("\n");
    const r = runSmokeTest(basicInput({
      payload: { kind: "convention_notes", notes: [{ topic: "T", rule: "Plain rule." }] },
      rendered_md: md,
      section_kind: "convention_notes",
      signal_ids: [seedSignal()],
    }));
    expect(r.failures.find((f) => f.check === "render_parses")).toBeUndefined();
  });

  it("rejects unbalanced code fences (covers isFenceBalanced false)", () => {
    // Single triple-backtick — no closing fence.
    const md = "```\nopen but never closed";
    const r = runSmokeTest(basicInput({
      payload: { kind: "convention_notes", notes: [{ topic: "T", rule: "Plain rule." }] },
      rendered_md: md,
      section_kind: "convention_notes",
      signal_ids: [seedSignal()],
    }));
    expect(r.failures.find((f) => f.check === "render_parses")).toBeDefined();
  });
});

describe("runSmokeTest — search_recipes sections_resolve continue on missing path (line 141)", () => {
  it("skips sections_resolve for search_recipes recipe whose lookup_path does not exist in snapshot", () => {
    // lookup_section is non-empty (line 140 doesn't continue), but lookup_path
    // is absent from the snapshot → line 141's snapshotMatchesPath returns false
    // → continue fires, bypassing sections_resolve. paths_resolve catches it.
    const r = runSmokeTest(basicInput({
      payload: {
        kind: "search_recipes",
        recipes: [{
          question_shape: "where do I record meeting notes",
          lookup_path: "identity/nonexistent.md",
          lookup_section: "## Notes",
        }],
      },
      rendered_md: "- ok",
      section_kind: "search_recipes",
      signal_ids: [seedSignal()],
    }));
    expect(r.failures.find((f) => f.check === "paths_resolve")).toBeDefined();
    expect(r.failures.find((f) => f.check === "sections_resolve")).toBeUndefined();
  });
});

describe("runSmokeTest — search_recipes paths_resolve / sections_resolve", () => {
  it("flags search_recipes whose lookup_section is missing (covers 138-145)", () => {
    mkdirSync(join(contextDir, "identity"));
    writeFileSync(join(contextDir, "identity", "profile.md"), "## Other\n");
    const r = runSmokeTest(basicInput({
      payload: {
        kind: "search_recipes",
        recipes: [{
          question_shape: "where do I record meeting notes",
          lookup_path: "identity/profile.md",
          lookup_section: "## Notes",
        }],
      },
      rendered_md: "- ok",
      section_kind: "search_recipes",
      signal_ids: [seedSignal()],
    }));
    expect(r.failures.find((f) => f.check === "sections_resolve")).toBeDefined();
  });

  it("ignores search recipes without a lookup_section (early continue)", () => {
    mkdirSync(join(contextDir, "identity"));
    writeFileSync(join(contextDir, "identity", "profile.md"), "## Other\n");
    const r = runSmokeTest(basicInput({
      payload: {
        kind: "search_recipes",
        recipes: [{
          question_shape: "where do I record meeting notes",
          lookup_path: "identity/profile.md",
        }],
      },
      rendered_md: "- ok",
      section_kind: "search_recipes",
      signal_ids: [seedSignal()],
    }));
    expect(r.failures.find((f) => f.check === "sections_resolve")).toBeUndefined();
  });
});

describe("runSmokeTest — signal_citations_valid sub-paths", () => {
  it("flags missing signal ids (some not in DB, covers 233-234)", () => {
    const real = seedSignal();
    const r = runSmokeTest(basicInput({
      payload: { kind: "convention_notes", notes: [{ topic: "T", rule: "Plain rule." }] },
      rendered_md: "- ok",
      section_kind: "convention_notes",
      signal_ids: [real, 999_999],
    }));
    const f = r.failures.find((x) => x.check === "signal_citations_valid");
    expect(f?.message).toMatch(/not found/);
  });

  it("flags already-consumed signals (covers 240-241)", () => {
    const sig = seedSignal();
    db.prepare(
      `UPDATE skill_curation_signals SET consumed_at = ?, consumed_by_proposal_id = 1 WHERE id = ?`,
    ).run(Date.now(), sig);
    const r = runSmokeTest(basicInput({
      payload: { kind: "convention_notes", notes: [{ topic: "T", rule: "Plain rule." }] },
      rendered_md: "- ok",
      section_kind: "convention_notes",
      signal_ids: [sig],
    }));
    const f = r.failures.find((x) => x.check === "signal_citations_valid");
    expect(f?.message).toMatch(/already consumed/);
  });
});

describe("runSmokeTest — payload free-text + path coverage for non-convention kinds", () => {
  it("walks frontmatter_schema purpose strings + glob paths (covers 295-298, 323-324)", () => {
    // No imperative phrasing in purpose → decision_language passes; glob is
    // sandbox-shaped so paths_resolve walks the iterator.
    const r = runSmokeTest(basicInput({
      payload: {
        kind: "frontmatter_schema",
        file_types: [{
          glob: "projects/*.md",
          required: [{ key: "type", type: "enum", example: "project" }],
          conventional: [{ key: "owner", purpose: "free-form owner attribution string" }],
        }],
      },
      rendered_md: "- ok",
      section_kind: "frontmatter_schema",
      signal_ids: [seedSignal()],
    }));
    // We only need to ensure no surprise failure from these helper traversals.
    expect(r.failures.find((f) => f.check === "decision_language_clean")).toBeUndefined();
  });

  it("walks search_recipes free-text + lookup_path + note (covers 300-304, 326-327)", () => {
    mkdirSync(join(contextDir, "identity"));
    writeFileSync(join(contextDir, "identity", "profile.md"), "## Identity\n");
    const r = runSmokeTest(basicInput({
      payload: {
        kind: "search_recipes",
        recipes: [{
          question_shape: "where do entries live",
          lookup_path: "identity/profile.md",
          note: "free-form author note here",
        }],
      },
      rendered_md: "- ok",
      section_kind: "search_recipes",
      signal_ids: [seedSignal()],
    }));
    expect(r.failures.find((f) => f.check === "decision_language_clean")).toBeUndefined();
  });

  it("walks routing_table notes for free-text scan (covers 292-293)", () => {
    mkdirSync(join(contextDir, "identity"));
    writeFileSync(join(contextDir, "identity", "personal.md"), "## Health\n");
    const r = runSmokeTest(basicInput({
      payload: {
        kind: "routing_table",
        rules: [{
          trigger_pattern: "user mentions doctor visit",
          destination_path: "identity/personal.md",
          destination_section: "## Health",
          destination_mode: "append",
          note: "free-form clarification text",
        }],
      },
      rendered_md: "- ok",
      section_kind: "routing_table",
      signal_ids: [seedSignal()],
    }));
    expect(r.failures.find((f) => f.check === "decision_language_clean")).toBeUndefined();
  });

  it("walks cross_references relation strings + paths (covers 309-310, 331-335)", () => {
    mkdirSync(join(contextDir, "identity"));
    mkdirSync(join(contextDir, "state"));
    writeFileSync(join(contextDir, "identity", "profile.md"), "## Identity\n");
    writeFileSync(join(contextDir, "state", "today.md"), "## Plan\n");
    const r = runSmokeTest(basicInput({
      payload: {
        kind: "cross_references",
        refs: [{ from_path: "identity/profile.md", to_path: "state/today.md", relation: "see also for daily context" }],
      },
      rendered_md: "- ok",
      section_kind: "cross_references",
      signal_ids: [seedSignal()],
    }));
    expect(r.failures.find((f) => f.check === "paths_resolve")).toBeUndefined();
    expect(r.failures.find((f) => f.check === "decision_language_clean")).toBeUndefined();
  });
});

describe("runSmokeTest — happy path", () => {
  it("returns ok=true for a clean proposal", () => {
    mkdirSync(join(contextDir, "identity"));
    writeFileSync(join(contextDir, "identity", "profile.md"), "## Identity\n");
    const r = runSmokeTest(basicInput({
      payload: { kind: "convention_notes", notes: [{ topic: "Dates", rule: "Entries are written as [YYYY-MM-DD]." }] },
      rendered_md: "- **Dates.** Entries are written as [YYYY-MM-DD].",
      section_kind: "convention_notes",
      signal_ids: [seedSignal()],
    }));
    expect(r.ok).toBe(true);
    expect(r.failures).toHaveLength(0);
  });
});

describe("runSmokeTest — no_embedded_markers second pattern (covers || branch)", () => {
  it("rejects rendered MD containing <integration_modes tag (covers second || alternative)", () => {
    // The first regex in no_embedded_markers does NOT match here; only the second
    // pattern `/<\s*integration_modes\b/i` fires, covering the right-hand side of ||.
    const r = runSmokeTest(basicInput({
      payload: { kind: "convention_notes", notes: [{ topic: "T", rule: "Plain rule." }] },
      rendered_md: "<integration_modes type=\"external\">blocked</integration_modes>",
      section_kind: "convention_notes",
      signal_ids: [seedSignal()],
    }));
    expect(r.failures.find((f) => f.check === "no_embedded_markers")).toBeDefined();
  });
});

describe("runSmokeTest — isWellFormedTable edge cases", () => {
  it("does not flag a lone | line at EOF (no separator follows → !next branch, line 255)", () => {
    // A line starting with | but with no following separator line → the outer
    // `if (!next || !...)` triggers `continue`; the function must return true.
    const md = "prose\n| standalone row at eof";
    const r = runSmokeTest(basicInput({
      payload: { kind: "convention_notes", notes: [{ topic: "T", rule: "Plain rule." }] },
      rendered_md: md,
      section_kind: "convention_notes",
      signal_ids: [seedSignal()],
    }));
    expect(r.failures.find((f) => f.check === "render_parses")).toBeUndefined();
  });

  it("does not flag a | line whose next line is not a separator (covers !/^\\|.../.test(next) branch)", () => {
    // Two consecutive | lines but no separator between them → not a table.
    const md = "| first row |\n| also data, not a separator |";
    const r = runSmokeTest(basicInput({
      payload: { kind: "convention_notes", notes: [{ topic: "T", rule: "Plain rule." }] },
      rendered_md: md,
      section_kind: "convention_notes",
      signal_ids: [seedSignal()],
    }));
    expect(r.failures.find((f) => f.check === "render_parses")).toBeUndefined();
  });

  it("rejects single-column table (hcols < 2 branch, line 260)", () => {
    // Header and separator each have exactly 1 column. Both hcols === scols === 1,
    // so the `hcols < 2` short-circuit fires and returns false.
    const md = ["| a |", "| - |", "| 1 |"].join("\n");
    const r = runSmokeTest(basicInput({
      payload: { kind: "convention_notes", notes: [{ topic: "T", rule: "Plain rule." }] },
      rendered_md: md,
      section_kind: "convention_notes",
      signal_ids: [seedSignal()],
    }));
    expect(r.failures.find((f) => f.check === "render_parses")).toBeDefined();
  });

  it("rejects body row without trailing pipe (covers countTableColumns endsWith|=false branch, line 274)", () => {
    // "| 1 " trimmed → "| 1", inner = " 1" which does NOT end with "|"
    // → finalInner = " 1" → 1 column ≠ 2 columns in header → return false.
    const md = ["| a | b |", "| - | - |", "| 1 "].join("\n");
    const r = runSmokeTest(basicInput({
      payload: { kind: "convention_notes", notes: [{ topic: "T", rule: "Plain rule." }] },
      rendered_md: md,
      section_kind: "convention_notes",
      signal_ids: [seedSignal()],
    }));
    expect(r.failures.find((f) => f.check === "render_parses")).toBeDefined();
  });
});

describe("runSmokeTest — cross_section_consistency skillManagesPath=false (line 163)", () => {
  it("does not flag routing rule whose destination_path is absent from all sibling knowledge_layout files", () => {
    // The sibling knowledge_layout only describes "user/other.md", not "user/personal.md".
    // So skillManagesPath = Array.from(ownedSections).some(k => k.startsWith("user/personal.md#")) = false
    // → the inconsistency failure is NOT added.
    mkdirSync(join(contextDir, "identity"));
    writeFileSync(join(contextDir, "identity", "personal.md"), "## Health\n");
    writeFileSync(join(contextDir, "identity", "other.md"), "## Misc\n");
    const sibling: Record<string, CurationPayloadValue> = {
      "layout-sibling": {
        kind: "knowledge_layout",
        files: [{ path: "identity/other.md", purpose: "misc stuff", sections: [{ heading: "## Misc", contains: "misc" }] }],
      },
    };
    const r = runSmokeTest(basicInput({
      payload: {
        kind: "routing_table",
        rules: [{
          trigger_pattern: "user mentions doctor",
          destination_path: "identity/personal.md",
          destination_section: "## Health",
          destination_mode: "append",
        }],
      },
      rendered_md: "- ok",
      section_kind: "routing_table",
      signal_ids: [seedSignal()],
      siblingPayloads: sibling,
    }));
    expect(r.failures.find((f) => f.check === "cross_section_consistency")).toBeUndefined();
  });
});

describe("runSmokeTest — cross_section_consistency non-knowledge_layout sibling (line 355)", () => {
  it("skips non-knowledge_layout entries in collectKnowledgeLayoutSections and still catches a missing section", () => {
    // siblingPayloads has both a routing_table (skipped at line 355) and a
    // knowledge_layout (collected). The routing rule's section is NOT in the
    // knowledge_layout → failure added.
    mkdirSync(join(contextDir, "identity"));
    writeFileSync(join(contextDir, "identity", "personal.md"), "## Hobbies\n");
    const sibling: Record<string, CurationPayloadValue> = {
      "ignored-routing": {
        kind: "routing_table",   // NOT knowledge_layout → line 355 continue fires
        rules: [{
          trigger_pattern: "ignored",
          destination_path: "identity/personal.md",
          destination_section: "## Hobbies",
          destination_mode: "append",
        }],
      },
      "real-layout": {
        kind: "knowledge_layout",
        files: [{ path: "identity/personal.md", purpose: "hobbies", sections: [{ heading: "## Hobbies", contains: "art" }] }],
      },
    };
    const r = runSmokeTest(basicInput({
      payload: {
        kind: "routing_table",
        rules: [{
          trigger_pattern: "doctor visit",
          destination_path: "identity/personal.md",
          destination_section: "## Health",   // NOT in the knowledge_layout → failure
          destination_mode: "append",
        }],
      },
      rendered_md: "- ok",
      section_kind: "routing_table",
      signal_ids: [seedSignal()],
      siblingPayloads: sibling,
    }));
    expect(r.failures.find((f) => f.check === "cross_section_consistency")).toBeDefined();
  });
});

describe("runSmokeTest — inverse cross_section_consistency non-routing_table sibling (line 373)", () => {
  it("skips non-routing_table siblings in collectRoutingTableReferences — no false-positive failure", () => {
    // siblingPayloads contains only non-routing_table entries (knowledge_layout,
    // convention_notes). collectRoutingTableReferences fires the line-373 continue for
    // each, returning an empty set → no inverse check failure.
    mkdirSync(join(contextDir, "identity"));
    writeFileSync(join(contextDir, "identity", "personal.md"), "## Hobbies\n");
    const sibling: Record<string, CurationPayloadValue> = {
      "layout-only": {
        kind: "knowledge_layout",   // NOT routing_table → line 373 continue
        files: [{ path: "identity/other.md", purpose: "other", sections: [] }],
      },
      "notes-only": {
        kind: "convention_notes",   // NOT routing_table → line 373 continue
        notes: [{ topic: "T", rule: "A plain rule." }],
      },
    };
    const r = runSmokeTest(basicInput({
      payload: {
        kind: "knowledge_layout",
        files: [{
          path: "identity/personal.md",
          purpose: "hobbies",
          sections: [{ heading: "## Hobbies", contains: "art" }],
        }],
      },
      rendered_md: "- ok",
      section_kind: "knowledge_layout",
      signal_ids: [seedSignal()],
      siblingPayloads: sibling,
    }));
    expect(r.failures.find((f) => f.check === "cross_section_consistency")).toBeUndefined();
  });
});

describe("runSmokeTest — inverse cross_section_consistency proposalCoversPath=false (line ~197)", () => {
  it("does not flag routing reference to a path not covered by this knowledge_layout proposal", () => {
    // The sibling routing_table references "user/other.md" (non-append_to_file).
    // The knowledge_layout proposal only describes "user/personal.md".
    // proposalCoversPath for "user/other.md" = false → condition false → no failure.
    mkdirSync(join(contextDir, "identity"));
    writeFileSync(join(contextDir, "identity", "personal.md"), "## Health\n");
    writeFileSync(join(contextDir, "identity", "other.md"), "## Notes\n");
    const sibling: Record<string, CurationPayloadValue> = {
      "routing-rules": {
        kind: "routing_table",
        rules: [{
          trigger_pattern: "user mentions notes",
          destination_path: "identity/other.md",      // NOT in proposal
          destination_section: "## Notes",
          destination_mode: "append",
        }],
      },
    };
    const r = runSmokeTest(basicInput({
      payload: {
        kind: "knowledge_layout",
        files: [{
          path: "identity/personal.md",   // proposal only covers personal.md
          purpose: "health",
          sections: [{ heading: "## Health", contains: "doctor visits" }],
        }],
      },
      rendered_md: "- ok",
      section_kind: "knowledge_layout",
      signal_ids: [seedSignal()],
      siblingPayloads: sibling,
    }));
    expect(r.failures.find((f) => f.check === "cross_section_consistency")).toBeUndefined();
  });
});

function seedSignal(): number {
  return recordSignal(db, { skill_slug: "user-profile", signal_type: "structure_diff", payload: { sub_kind: "heading_add" } });
}
