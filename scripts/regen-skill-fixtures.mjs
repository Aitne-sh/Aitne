#!/usr/bin/env node
// Regenerate __fixtures__/skill-bodies/<slug>-pre-migration.md after an
// intentional SKILL.md edit. See skills-compiler.test.ts:660 "If a fixture
// genuinely needs to change…" — this just automates that snippet.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderReferenceIncludes } from "../packages/daemon/dist/core/skills-compiler.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const skillsDir = join(repoRoot, "agent-assets", "skills");
const fixturesDir = join(
  repoRoot,
  "packages/daemon/src/core/__fixtures__/skill-bodies",
);

function stripFrontmatter(content) {
  if (!content.startsWith("---")) return content;
  const endIdx = content.indexOf("\n---", 3);
  if (endIdx < 0) return content;
  return content.slice(endIdx + 4).replace(/^\n+/, "");
}

const slugs = process.argv.slice(2);
if (slugs.length === 0) {
  console.error("usage: regen-skill-fixtures.mjs <slug> [slug ...]");
  process.exit(1);
}

for (const slug of slugs) {
  const skillPath = join(skillsDir, slug, "SKILL.md");
  const fixturePath = join(fixturesDir, `${slug}-pre-migration.md`);
  const skillContent = readFileSync(skillPath, "utf-8");
  const expanded = renderReferenceIncludes(skillContent, join(skillsDir, slug));
  const body = stripFrontmatter(expanded);
  writeFileSync(fixturePath, body);
  console.log(`wrote ${fixturePath} (${body.length} bytes)`);
}
