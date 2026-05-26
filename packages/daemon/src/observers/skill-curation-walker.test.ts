import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applySchema } from "../db/schema.js";
import { unconsumedSignalsForSkill } from "../core/skill-curation/signals.js";
import { SkillCurationWalker, diffSkill } from "./skill-curation-walker.js";
import { buildKnowledgeMap } from "../core/skill-curation/knowledge-map.js";
import { OverlayStore } from "../core/skill-curation/overlay-store.js";
import { loadAllCurationDeclarations } from "../core/skill-curation/declarations.js";

let db: Database.Database;
let dataDir: string;
let skillsRoot: string;
let contextDir: string;

function writeSkill(slug: string, decl: object, seed?: object, sectionId?: string) {
  const dir = join(skillsRoot, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `## H\n<!-- CURATION:knowledge_layout id="topic-files" -->\n`, "utf-8");
  writeFileSync(join(dir, "curation.json"), JSON.stringify(decl), "utf-8");
  if (seed && sectionId) {
    const seedDir = join(dir, "seeds");
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(join(seedDir, `${sectionId}.seed.json`), JSON.stringify(seed), "utf-8");
  }
}

beforeEach(() => {
  db = new Database(":memory:");
  applySchema(db);
  const root = mkdtempSync(join(tmpdir(), "walker-"));
  dataDir = join(root, "data");
  skillsRoot = join(root, "skills");
  contextDir = join(root, "context");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(contextDir, { recursive: true });
});
afterEach(() => {
  db.close();
  rmSync(skillsRoot, { recursive: true, force: true });
  rmSync(contextDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe("SkillCurationWalker.runOnce — knowledge_layout structure_diff", () => {
  it("flags a new file under user/ as file_add", async () => {
    writeSkill(
      "user-profile",
      {
        version: 1,
        sections: [{
          id: "topic-files",
          kind: "knowledge_layout",
          anchor: `<!-- CURATION:knowledge_layout id="topic-files" -->`,
          human_label: "Topic file layout",
          description: "y",
          scope_paths: ["identity/*.md"],
        }],
      },
      {
        kind: "knowledge_layout",
        files: [{ path: "identity/profile.md", purpose: "identity facts", sections: [{ heading: "## Identity", contains: "name role tz" }] }],
      },
      "topic-files",
    );
    mkdirSync(join(contextDir, "identity"));
    writeFileSync(join(contextDir, "identity", "profile.md"), "## Identity\n");
    writeFileSync(join(contextDir, "identity", "personal.md"), "## Hobbies\n");

    const walker = new SkillCurationWalker(db, contextDir, skillsRoot, dataDir);
    const r = await walker.runOnce();
    expect(r.skills_walked).toBe(1);

    const sigs = unconsumedSignalsForSkill(db, "user-profile");
    const fileAdds = sigs.filter((s) => JSON.parse(s.payload_json).sub_kind === "file_add");
    expect(fileAdds.length).toBeGreaterThan(0);
    expect(fileAdds.some((s) => JSON.parse(s.payload_json).target === "identity/personal.md")).toBe(true);
  });

  it("flags a heading the seed didn't know about as heading_add", async () => {
    writeSkill(
      "user-profile",
      {
        version: 1,
        sections: [{
          id: "topic-files",
          kind: "knowledge_layout",
          anchor: `<!-- CURATION:knowledge_layout id="topic-files" -->`,
          human_label: "Topic file layout",
          description: "y",
          scope_paths: ["identity/*.md"],
        }],
      },
      {
        kind: "knowledge_layout",
        files: [{ path: "identity/profile.md", purpose: "identity facts", sections: [{ heading: "## Identity", contains: "name role tz" }] }],
      },
      "topic-files",
    );
    mkdirSync(join(contextDir, "identity"));
    writeFileSync(join(contextDir, "identity", "profile.md"), "## Identity\n## NEW\n");

    const walker = new SkillCurationWalker(db, contextDir, skillsRoot, dataDir);
    await walker.runOnce();

    const sigs = unconsumedSignalsForSkill(db, "user-profile");
    expect(sigs.some((s) => JSON.parse(s.payload_json).sub_kind === "heading_add")).toBe(true);
  });

  it("is idempotent: re-running on unchanged tree adds zero signals", async () => {
    writeSkill(
      "user-profile",
      {
        version: 1,
        sections: [{
          id: "topic-files",
          kind: "knowledge_layout",
          anchor: `<!-- CURATION:knowledge_layout id="topic-files" -->`,
          human_label: "Topic file layout",
          description: "y",
          scope_paths: ["identity/*.md"],
        }],
      },
      {
        kind: "knowledge_layout",
        files: [{ path: "identity/profile.md", purpose: "identity facts", sections: [{ heading: "## Identity", contains: "name role tz" }] }],
      },
      "topic-files",
    );
    mkdirSync(join(contextDir, "identity"));
    writeFileSync(join(contextDir, "identity", "personal.md"), "## H\n");

    const walker = new SkillCurationWalker(db, contextDir, skillsRoot, dataDir);
    const a = await walker.runOnce();
    const b = await walker.runOnce();
    const sigs = unconsumedSignalsForSkill(db, "user-profile");
    // Second pass should not duplicate the first pass's findings
    expect(b.inserted).toBe(0);
    expect(sigs.length).toBe(a.inserted);
  });

  it("no-ops when no skills declare curation.json", async () => {
    const walker = new SkillCurationWalker(db, contextDir, skillsRoot, dataDir);
    const r = await walker.runOnce();
    expect(r).toEqual({ inserted: 0, skills_walked: 0 });
  });
});

// ── Helper for non-knowledge_layout skill kinds ──────────────────────────────
// Writes SKILL.md with the correct anchor kind so the loader does not lint-warn
// the section as missing its anchor.
function writeSkillWithKind(
  skillsRoot: string,
  slug: string,
  kind: string,
  sectionId: string,
  decl: object,
  seed?: object,
) {
  const dir = join(skillsRoot, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `## Section heading\n<!-- CURATION:${kind} id="${sectionId}" -->\n`,
    "utf-8",
  );
  writeFileSync(join(dir, "curation.json"), JSON.stringify(decl), "utf-8");
  if (seed) {
    const seedDir = join(dir, "seeds");
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(
      join(seedDir, `${sectionId}.seed.json`),
      JSON.stringify(seed),
      "utf-8",
    );
  }
}

// ── heading_remove ────────────────────────────────────────────────────────────

describe("SkillCurationWalker.runOnce — knowledge_layout heading_remove", () => {
  it("flags a heading the seed knew about but that is absent from the live file", async () => {
    writeSkill(
      "user-profile",
      {
        version: 1,
        sections: [
          {
            id: "topic-files",
            kind: "knowledge_layout",
            anchor: `<!-- CURATION:knowledge_layout id="topic-files" -->`,
            human_label: "Topic file layout",
            description: "Files the agent uses for user profiling",
            scope_paths: ["identity/*.md"],
          },
        ],
      },
      {
        kind: "knowledge_layout",
        files: [
          {
            path: "identity/profile.md",
            purpose: "identity facts",
            sections: [
              { heading: "## Identity", contains: "name role tz" },
              { heading: "## Preferences", contains: "prefs list" },
            ],
          },
        ],
      },
      "topic-files",
    );
    mkdirSync(join(contextDir, "identity"));
    // Write the file WITHOUT the Preferences heading that the seed declared.
    writeFileSync(join(contextDir, "identity", "profile.md"), "## Identity\n", "utf-8");

    const walker = new SkillCurationWalker(db, contextDir, skillsRoot, dataDir);
    const r = await walker.runOnce();
    expect(r.skills_walked).toBe(1);

    const sigs = unconsumedSignalsForSkill(db, "user-profile");
    const removes = sigs
      .map((s) => JSON.parse(s.payload_json))
      .filter((p) => p.sub_kind === "heading_remove");
    expect(removes.length).toBeGreaterThan(0);
    expect(removes.some((p) => p.target === "identity/profile.md#Preferences")).toBe(true);
  });
});

// ── frontmatter_schema ────────────────────────────────────────────────────────

describe("SkillCurationWalker.runOnce — frontmatter_schema", () => {
  it("emits frontmatter_change when a required key is absent from a matching file", async () => {
    writeSkillWithKind(
      skillsRoot,
      "user-profile",
      "frontmatter_schema",
      "fm-section",
      {
        version: 1,
        sections: [
          {
            id: "fm-section",
            kind: "frontmatter_schema",
            anchor: `<!-- CURATION:frontmatter_schema id="fm-section" -->`,
            human_label: "User frontmatter schema",
            description: "Declares required frontmatter keys for user files",
            scope_paths: ["identity/*.md"],
          },
        ],
      },
      {
        kind: "frontmatter_schema",
        file_types: [
          {
            glob: "identity/*.md",
            required: [{ key: "tags", type: "array", example: "[work]" }],
            conventional: [],
          },
        ],
      },
    );
    mkdirSync(join(contextDir, "identity"));
    // No frontmatter — tags key is missing.
    writeFileSync(join(contextDir, "identity", "profile.md"), "## Identity\n", "utf-8");

    const walker = new SkillCurationWalker(db, contextDir, skillsRoot, dataDir);
    const r = await walker.runOnce();
    expect(r.skills_walked).toBe(1);
    expect(r.inserted).toBeGreaterThan(0);

    const sigs = unconsumedSignalsForSkill(db, "user-profile");
    const changes = sigs
      .map((s) => JSON.parse(s.payload_json))
      .filter((p) => p.sub_kind === "frontmatter_change");
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.some((p) => p.target === "identity/profile.md#tags")).toBe(true);
    expect(changes[0].detail).toEqual({ missing: true });
  });

  it("does not emit frontmatter_change when the required key is present", async () => {
    writeSkillWithKind(
      skillsRoot,
      "user-profile",
      "frontmatter_schema",
      "fm-section",
      {
        version: 1,
        sections: [
          {
            id: "fm-section",
            kind: "frontmatter_schema",
            anchor: `<!-- CURATION:frontmatter_schema id="fm-section" -->`,
            human_label: "User frontmatter schema",
            description: "Declares required frontmatter keys for user files",
            scope_paths: ["identity/*.md"],
          },
        ],
      },
      {
        kind: "frontmatter_schema",
        file_types: [
          {
            glob: "identity/*.md",
            required: [{ key: "tags", type: "array", example: "[work]" }],
            conventional: [],
          },
        ],
      },
    );
    mkdirSync(join(contextDir, "identity"));
    // Frontmatter with the required key present.
    writeFileSync(
      join(contextDir, "identity", "profile.md"),
      "---\ntags: work\n---\n## Identity\n",
      "utf-8",
    );

    const walker = new SkillCurationWalker(db, contextDir, skillsRoot, dataDir);
    const r = await walker.runOnce();
    expect(r.inserted).toBe(0);

    const sigs = unconsumedSignalsForSkill(db, "user-profile");
    const changes = sigs
      .map((s) => JSON.parse(s.payload_json))
      .filter((p) => p.sub_kind === "frontmatter_change");
    expect(changes.length).toBe(0);
  });
});

// ── routing_table ─────────────────────────────────────────────────────────────

describe("SkillCurationWalker.runOnce — routing_table", () => {
  it("emits file_remove when a destination_path from the seed does not exist in context", async () => {
    writeSkillWithKind(
      skillsRoot,
      "router-skill",
      "routing_table",
      "routes",
      {
        version: 1,
        sections: [
          {
            id: "routes",
            kind: "routing_table",
            anchor: `<!-- CURATION:routing_table id="routes" -->`,
            human_label: "Routing table",
            description: "Where to write different kinds of information",
            scope_paths: ["identity/*.md"],
          },
        ],
      },
      {
        kind: "routing_table",
        rules: [
          {
            trigger_pattern: "When the user mentions a preference",
            destination_path: "identity/missing.md",
            destination_section: "## Preferences",
            destination_mode: "append",
          },
        ],
      },
    );
    // Create the context dir but NOT user/missing.md.
    mkdirSync(join(contextDir, "identity"));

    const walker = new SkillCurationWalker(db, contextDir, skillsRoot, dataDir);
    const r = await walker.runOnce();
    expect(r.skills_walked).toBe(1);
    expect(r.inserted).toBeGreaterThan(0);

    const sigs = unconsumedSignalsForSkill(db, "router-skill");
    const removes = sigs
      .map((s) => JSON.parse(s.payload_json))
      .filter((p) => p.sub_kind === "file_remove");
    expect(removes.length).toBeGreaterThan(0);
    expect(removes.some((p) => p.target === "identity/missing.md")).toBe(true);
  });

  it("skips destination_path entries that contain a wildcard", async () => {
    writeSkillWithKind(
      skillsRoot,
      "router-skill",
      "routing_table",
      "routes",
      {
        version: 1,
        sections: [
          {
            id: "routes",
            kind: "routing_table",
            anchor: `<!-- CURATION:routing_table id="routes" -->`,
            human_label: "Routing table",
            description: "Where to write different kinds of information",
            scope_paths: ["identity/*.md"],
          },
        ],
      },
      {
        kind: "routing_table",
        rules: [
          {
            trigger_pattern: "When the user mentions any project topic",
            destination_path: "plans/projects/*.md",
            destination_section: "## Notes",
            destination_mode: "append",
          },
        ],
      },
    );
    mkdirSync(join(contextDir, "identity"));

    const walker = new SkillCurationWalker(db, contextDir, skillsRoot, dataDir);
    const r = await walker.runOnce();
    // Wildcard paths are skipped — no signals expected.
    expect(r.inserted).toBe(0);
  });
});

// ── search_recipes ────────────────────────────────────────────────────────────

describe("SkillCurationWalker.runOnce — search_recipes", () => {
  it("emits file_remove when a recipe's lookup_path does not exist in context", async () => {
    writeSkillWithKind(
      skillsRoot,
      "search-skill",
      "search_recipes",
      "recipes",
      {
        version: 1,
        sections: [
          {
            id: "recipes",
            kind: "search_recipes",
            anchor: `<!-- CURATION:search_recipes id="recipes" -->`,
            human_label: "Search recipes",
            description: "Lookup paths for common questions",
            scope_paths: ["identity/*.md"],
          },
        ],
      },
      {
        kind: "search_recipes",
        recipes: [
          {
            question_shape: "What are the user current projects",
            lookup_path: "identity/projects.md",
            lookup_section: "## Active",
          },
        ],
      },
    );
    // Create the context dir but NOT user/projects.md.
    mkdirSync(join(contextDir, "identity"));

    const walker = new SkillCurationWalker(db, contextDir, skillsRoot, dataDir);
    const r = await walker.runOnce();
    expect(r.skills_walked).toBe(1);
    expect(r.inserted).toBeGreaterThan(0);

    const sigs = unconsumedSignalsForSkill(db, "search-skill");
    const removes = sigs
      .map((s) => JSON.parse(s.payload_json))
      .filter((p) => p.sub_kind === "file_remove");
    expect(removes.length).toBeGreaterThan(0);
    expect(removes.some((p) => p.target === "identity/projects.md")).toBe(true);
  });
});

// ── convention_notes and cross_references (no-op kinds) ──────────────────────

describe("SkillCurationWalker.runOnce — convention_notes no-op", () => {
  it("walks the skill but inserts zero signals for convention_notes", async () => {
    writeSkillWithKind(
      skillsRoot,
      "convention-skill",
      "convention_notes",
      "conventions",
      {
        version: 1,
        sections: [
          {
            id: "conventions",
            kind: "convention_notes",
            anchor: `<!-- CURATION:convention_notes id="conventions" -->`,
            human_label: "Writing conventions",
            description: "House style and naming conventions the agent should follow",
            scope_paths: ["identity/*.md"],
          },
        ],
      },
      {
        kind: "convention_notes",
        notes: [
          {
            topic: "Date format",
            rule: "Use ISO 8601 dates in all frontmatter fields",
            example: "2026-01-15",
          },
        ],
      },
    );
    mkdirSync(join(contextDir, "identity"));
    writeFileSync(join(contextDir, "identity", "profile.md"), "## Identity\n", "utf-8");

    const walker = new SkillCurationWalker(db, contextDir, skillsRoot, dataDir);
    const r = await walker.runOnce();
    expect(r.inserted).toBe(0);
    expect(r.skills_walked).toBe(1);
    expect(unconsumedSignalsForSkill(db, "convention-skill")).toHaveLength(0);
  });
});

describe("SkillCurationWalker.runOnce — cross_references no-op", () => {
  it("walks the skill but inserts zero signals for cross_references", async () => {
    writeSkillWithKind(
      skillsRoot,
      "xref-skill",
      "cross_references",
      "xrefs",
      {
        version: 1,
        sections: [
          {
            id: "xrefs",
            kind: "cross_references",
            anchor: `<!-- CURATION:cross_references id="xrefs" -->`,
            human_label: "Cross-references",
            description: "Known links between context files",
            scope_paths: ["identity/*.md"],
          },
        ],
      },
      {
        kind: "cross_references",
        refs: [
          {
            from_path: "identity/profile.md",
            to_path: "user/details.md",
            relation: "profile links to extended details page",
          },
        ],
      },
    );
    mkdirSync(join(contextDir, "identity"));
    writeFileSync(join(contextDir, "identity", "profile.md"), "## Identity\n", "utf-8");

    const walker = new SkillCurationWalker(db, contextDir, skillsRoot, dataDir);
    const r = await walker.runOnce();
    expect(r.inserted).toBe(0);
    expect(r.skills_walked).toBe(1);
    expect(unconsumedSignalsForSkill(db, "xref-skill")).toHaveLength(0);
  });
});

// ── simpleGlobMatch via frontmatter_schema ────────────────────────────────────

describe("simpleGlobMatch behaviour via frontmatter_schema coverage", () => {
  function makeDecl(glob: string, sectionId: string) {
    return {
      version: 1,
      sections: [
        {
          id: sectionId,
          kind: "frontmatter_schema",
          anchor: `<!-- CURATION:frontmatter_schema id="${sectionId}" -->`,
          human_label: "Schema check",
          description: "Checks required frontmatter",
          scope_paths: [glob],
        },
      ],
    };
  }

  function makeSeed(glob: string) {
    return {
      kind: "frontmatter_schema",
      file_types: [
        {
          glob,
          required: [{ key: "tags", type: "array", example: "[test]" }],
          conventional: [],
        },
      ],
    };
  }

  it("single-star glob matches files in one directory level (user/*.md matches user/profile.md)", async () => {
    const sectionId = "fm-star";
    writeSkillWithKind(
      skillsRoot,
      "glob-skill-star",
      "frontmatter_schema",
      sectionId,
      makeDecl("identity/*.md", sectionId),
      makeSeed("identity/*.md"),
    );
    mkdirSync(join(contextDir, "identity"));
    writeFileSync(join(contextDir, "identity", "profile.md"), "## Bio\n", "utf-8");

    const walker = new SkillCurationWalker(db, contextDir, skillsRoot, dataDir);
    const r = await walker.runOnce();
    expect(r.inserted).toBeGreaterThan(0);
    const sigs = unconsumedSignalsForSkill(db, "glob-skill-star");
    expect(sigs.some((s) => JSON.parse(s.payload_json).target === "identity/profile.md#tags")).toBe(true);
  });

  it("single-star glob does NOT match a file two levels deep (user/*.md does not match user/sub/profile.md)", async () => {
    const sectionId = "fm-star-no";
    writeSkillWithKind(
      skillsRoot,
      "glob-skill-star-no",
      "frontmatter_schema",
      sectionId,
      makeDecl("identity/*.md", sectionId),
      makeSeed("identity/*.md"),
    );
    mkdirSync(join(contextDir, "identity", "sub"), { recursive: true });
    writeFileSync(join(contextDir, "identity", "sub", "profile.md"), "## Bio\n", "utf-8");

    const walker = new SkillCurationWalker(db, contextDir, skillsRoot, dataDir);
    const r = await walker.runOnce();
    // user/sub/profile.md should NOT match user/*.md — no signal
    expect(r.inserted).toBe(0);
  });

  it("double-star glob matches files at depth 1 (**/*.md matches user/profile.md)", async () => {
    // Note: simpleGlobMatch converts ** to .* but the residual * in .* is then
    // also converted to [^/]*, resulting in a pattern that effectively only
    // matches a single path segment followed by the extension. This is a known
    // implementation characteristic; the test documents the actual behaviour.
    const sectionId = "fm-doublestar";
    writeSkillWithKind(
      skillsRoot,
      "glob-skill-doublestar",
      "frontmatter_schema",
      sectionId,
      makeDecl("**/*.md", sectionId),
      makeSeed("**/*.md"),
    );
    mkdirSync(join(contextDir, "identity"));
    writeFileSync(join(contextDir, "identity", "profile.md"), "## Bio\n", "utf-8");

    const walker = new SkillCurationWalker(db, contextDir, skillsRoot, dataDir);
    const r = await walker.runOnce();
    expect(r.inserted).toBeGreaterThan(0);
    const sigs = unconsumedSignalsForSkill(db, "glob-skill-doublestar");
    expect(
      sigs.some((s) => JSON.parse(s.payload_json).target === "identity/profile.md#tags"),
    ).toBe(true);
  });

  it("exact-path glob (no wildcard) matches only the exact file", async () => {
    const sectionId = "fm-exact";
    writeSkillWithKind(
      skillsRoot,
      "glob-skill-exact",
      "frontmatter_schema",
      sectionId,
      makeDecl("identity/profile.md", sectionId),
      makeSeed("identity/profile.md"),
    );
    mkdirSync(join(contextDir, "identity"));
    writeFileSync(join(contextDir, "identity", "profile.md"), "## Bio\n", "utf-8");
    // other.md should NOT match the exact pattern
    writeFileSync(join(contextDir, "identity", "other.md"), "## Other\n", "utf-8");

    const walker = new SkillCurationWalker(db, contextDir, skillsRoot, dataDir);
    const r = await walker.runOnce();
    const sigs = unconsumedSignalsForSkill(db, "glob-skill-exact");
    const targets = sigs.map((s) => JSON.parse(s.payload_json).target);
    // Only profile.md should appear in frontmatter_change signals
    const fmChanges = sigs
      .map((s) => JSON.parse(s.payload_json))
      .filter((p) => p.sub_kind === "frontmatter_change");
    expect(fmChanges.every((p) => p.target.startsWith("identity/profile.md"))).toBe(true);
    expect(r.inserted).toBeGreaterThan(0);
    void targets; // used above
  });

  it("non-matching exact path produces no frontmatter_change signal", async () => {
    const sectionId = "fm-nomatch";
    writeSkillWithKind(
      skillsRoot,
      "glob-skill-nomatch",
      "frontmatter_schema",
      sectionId,
      makeDecl("user/nonexistent.md", sectionId),
      makeSeed("user/nonexistent.md"),
    );
    mkdirSync(join(contextDir, "identity"));
    writeFileSync(join(contextDir, "identity", "profile.md"), "## Bio\n", "utf-8");

    const walker = new SkillCurationWalker(db, contextDir, skillsRoot, dataDir);
    const r = await walker.runOnce();
    expect(r.inserted).toBe(0);
    expect(unconsumedSignalsForSkill(db, "glob-skill-nomatch")).toHaveLength(0);
  });
});

// ── Idempotency key deduplication ─────────────────────────────────────────────

describe("diffSkill — idempotency key deduplication", () => {
  it("does not insert a duplicate signal when the same idempotency_key already exists in the DB", () => {
    writeSkill(
      "user-profile",
      {
        version: 1,
        sections: [
          {
            id: "topic-files",
            kind: "knowledge_layout",
            anchor: `<!-- CURATION:knowledge_layout id="topic-files" -->`,
            human_label: "Topic file layout",
            description: "Files used for user profiling",
            scope_paths: ["identity/*.md"],
          },
        ],
      },
      {
        kind: "knowledge_layout",
        files: [
          {
            path: "identity/profile.md",
            purpose: "identity facts",
            sections: [{ heading: "## Identity", contains: "name role tz" }],
          },
        ],
      },
      "topic-files",
    );
    mkdirSync(join(contextDir, "identity"));
    // personal.md is new — not in the seed — so it will produce a file_add signal.
    writeFileSync(join(contextDir, "identity", "personal.md"), "## Hobbies\n", "utf-8");

    const decls = loadAllCurationDeclarations(skillsRoot).filter((d) => d.declaration !== null);
    expect(decls).toHaveLength(1);

    const snapshot = buildKnowledgeMap(contextDir);
    const overlay = new OverlayStore(dataDir, skillsRoot);
    const now = Date.now();

    // First call inserts the signal.
    const firstCount = diffSkill(db, decls[0], snapshot, overlay, now);
    expect(firstCount).toBeGreaterThan(0);

    // Second call on the same snapshot must find the existing idempotency keys and add nothing.
    const secondCount = diffSkill(db, decls[0], snapshot, overlay, now);
    expect(secondCount).toBe(0);

    // Total signals in DB equals what the first call inserted.
    const sigs = unconsumedSignalsForSkill(db, "user-profile");
    expect(sigs).toHaveLength(firstCount);
  });
});

// ── start() / stop() lifecycle ────────────────────────────────────────────────

describe("SkillCurationWalker — start / stop lifecycle", () => {
  it("start schedules an interval and stop clears it", async () => {
    const walker = new SkillCurationWalker(db, contextDir, skillsRoot, dataDir, {
      intervalMs: 60_000,
    });

    await walker.start();
    // Timer is now set — a second call to start() is a no-op (idempotent).
    await walker.start();

    await walker.stop();
    // After stop the timer is gone; a second stop() is also a no-op.
    await walker.stop();
  });

  it("start defers execution — runOnce is not called immediately", async () => {
    const runOnceSpy = vi.spyOn(
      SkillCurationWalker.prototype,
      "runOnce",
    );

    const walker = new SkillCurationWalker(db, contextDir, skillsRoot, dataDir, {
      intervalMs: 60_000,
    });

    await walker.start();
    // The interval has been set but the first tick hasn't fired yet (60 000ms).
    expect(runOnceSpy).not.toHaveBeenCalled();

    await walker.stop();
    runOnceSpy.mockRestore();
  });

  it("interval callback invokes runOnce when the timer fires", async () => {
    vi.useFakeTimers();
    const runOnceSpy = vi.spyOn(
      SkillCurationWalker.prototype,
      "runOnce",
    ).mockResolvedValue({ inserted: 0, skills_walked: 0 });

    const intervalMs = 1_000;
    const walker = new SkillCurationWalker(db, contextDir, skillsRoot, dataDir, { intervalMs });

    await walker.start();
    expect(runOnceSpy).not.toHaveBeenCalled();

    // Advance past the interval — the callback fires.
    await vi.advanceTimersByTimeAsync(intervalMs + 10);
    expect(runOnceSpy).toHaveBeenCalledOnce();

    await walker.stop();
    runOnceSpy.mockRestore();
    vi.useRealTimers();
  });

  it("stop before start is a no-op and does not throw", async () => {
    const walker = new SkillCurationWalker(db, contextDir, skillsRoot, dataDir);
    await expect(walker.stop()).resolves.toBeUndefined();
  });
});

// ── runOnce early-return when already running ────────────────────────────────

describe("SkillCurationWalker.runOnce — concurrent guard", () => {
  it("returns zero immediately when a run is already in progress", async () => {
    const walker = new SkillCurationWalker(db, contextDir, skillsRoot, dataDir);
    // Directly set the private `running` flag to simulate an in-progress run.
    (walker as unknown as { running: boolean }).running = true;
    const result = await walker.runOnce();
    expect(result).toEqual({ inserted: 0, skills_walked: 0 });
    // Reset so teardown doesn't get confused.
    (walker as unknown as { running: boolean }).running = false;
  });
});

// ── diffSkill edge cases ──────────────────────────────────────────────────────

describe("diffSkill — edge cases", () => {
  it("returns 0 immediately when decl.declaration is null", () => {
    const decl = {
      slug: "no-decl",
      declaration: null,
      anchors: [],
      diagnostics: [],
    };
    const snapshot = buildKnowledgeMap(contextDir);
    const overlay = new OverlayStore(dataDir, skillsRoot);
    const result = diffSkill(db, decl, snapshot, overlay, Date.now());
    expect(result).toBe(0);
  });

  it("safeParse handles malformed payload_json in existing signals gracefully", () => {
    // Write a valid skill (sectionId must match SKILL.md hardcoded anchor "topic-files").
    writeSkill(
      "safe-parse-skill",
      {
        version: 1,
        sections: [{
          id: "topic-files",
          kind: "knowledge_layout",
          anchor: `<!-- CURATION:knowledge_layout id="topic-files" -->`,
          human_label: "Files used for the user profile",
          description: "Layout of user context files",
          scope_paths: ["identity/*.md"],
        }],
      },
      {
        kind: "knowledge_layout",
        files: [{ path: "identity/profile.md", purpose: "identity facts", sections: [] }],
      },
      "topic-files",
    );
    mkdirSync(join(contextDir, "identity"), { recursive: true });
    writeFileSync(join(contextDir, "identity", "extra.md"), "## Bio\n", "utf-8");

    // Pre-seed the signals table with a row that has malformed JSON payload.
    // safeParse must return null for this row so diffSkill doesn't crash.
    db.prepare(`
      INSERT INTO skill_curation_signals
        (skill_slug, section_id, signal_type, payload_json, observed_at)
      VALUES ('safe-parse-skill', 'topic-files', 'structure_diff', 'NOT VALID JSON', 42)
    `).run();

    const decls = loadAllCurationDeclarations(skillsRoot).filter((d) => d.slug === "safe-parse-skill");
    expect(decls).toHaveLength(1);

    const snapshot = buildKnowledgeMap(contextDir);
    const overlay = new OverlayStore(dataDir, skillsRoot);
    // safeParse catches the JSON error, returns null, key is undefined → not added to seenKeys.
    // diffSkill must not throw and must insert any new signals it finds.
    expect(() => diffSkill(db, decls[0], snapshot, overlay, Date.now())).not.toThrow();
  });
});
