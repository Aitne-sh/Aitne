import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Drift guard between the canonical `user/*.md` schema (the single source
 * of truth) and the shipped templates.
 *
 * The seed file `agent-assets/skills/user-profile/seeds/topic-files.seed.json`
 * is rendered into `user-profile/SKILL.md` via the curation system and is
 * relied on by:
 *
 *  - `knowledge.import` task-flow (Step 4 reads the existing file to
 *    discover canonical H2 names; if the template ships those H2s seeded,
 *    the importer never has to invent section names and never falls
 *    through to the `section_not_found` → `append_to_file` path that lets
 *    LLMs create variants like `## Family Members` instead of `## Family`).
 *  - `user-profile` skill (the DM handler + `routine.user_profile_sweep`
 *    write to the canonical headings).
 *
 * This test enforces the coupling: every section declared in the seed
 * must literally appear as an H2 in the shipped template. A regression
 * here (template drops a heading, seed adds one without a template
 * update) lets the importer's section-name invention drift back in.
 */
describe("user/*.md template canonical-section drift", () => {
  const repoRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
  );
  const seedPath = join(
    repoRoot,
    "agent-assets",
    "skills",
    "user-profile",
    "seeds",
    "topic-files.seed.json",
  );
  const templatesRoot = join(repoRoot, "agent-assets", "templates");

  interface SeedSection {
    heading: string;
    contains: string;
  }
  interface SeedFile {
    path: string;
    purpose: string;
    sections: SeedSection[];
  }
  interface Seed {
    kind: string;
    files: SeedFile[];
  }

  const seed = JSON.parse(readFileSync(seedPath, "utf-8")) as Seed;

  it("seed is well-formed (kind=knowledge_layout, files non-empty)", () => {
    expect(seed.kind).toBe("knowledge_layout");
    expect(Array.isArray(seed.files)).toBe(true);
    expect(seed.files.length).toBeGreaterThan(0);
  });

  it("every section in topic-files.seed.json is present as an H2 in its template", () => {
    const mismatches: string[] = [];
    for (const file of seed.files) {
      const tmplPath = join(templatesRoot, file.path);
      const body = readFileSync(tmplPath, "utf-8");
      const headings = new Set(
        body
          .split("\n")
          .filter((line) => line.startsWith("## "))
          .map((line) => line.trim()),
      );
      for (const section of file.sections) {
        if (!headings.has(section.heading)) {
          mismatches.push(
            `${file.path}: missing "${section.heading}" (template H2s: ${[...headings].join(", ") || "<none>"})`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("every user/*.md template covered by the seed carries `template_version` and `type: user` frontmatter", () => {
    // Defense-in-depth: a template that ships canonical sections but
    // forgets to carry template_version would silently exit the
    // template-versions upgrade-tracking system. type: user is the
    // discriminator the dashboard's Knowledge → Context Files view
    // routes on. A regression here breaks both surfaces.
    const issues: string[] = [];
    for (const file of seed.files) {
      const body = readFileSync(join(templatesRoot, file.path), "utf-8");
      if (!/^type:\s*user\s*$/m.test(body)) {
        issues.push(`${file.path}: missing 'type: user' frontmatter`);
      }
      if (!/^template_version:\s*\d+\s*$/m.test(body)) {
        issues.push(`${file.path}: missing 'template_version: <N>' frontmatter`);
      }
    }
    expect(issues).toEqual([]);
  });

  it("seed enumerates every shipped user/*.md profile + topic template", () => {
    // Reverse direction: the seed must not lag behind the templates.
    // user/_index.md is excluded — it is the dictionary, not a content
    // file with H2 sections to track.
    const expectedSeedPaths = [
      "user/profile.md",
      "user/people.md",
      "user/work.md",
      "user/expertise.md",
      "user/personal.md",
      "user/goals.md",
    ];
    const seedPaths = new Set(seed.files.map((f) => f.path));
    const missing = expectedSeedPaths.filter((p) => !seedPaths.has(p));
    expect(missing).toEqual([]);
  });
});
