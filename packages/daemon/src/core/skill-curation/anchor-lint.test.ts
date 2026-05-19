// P22 §1.6 — build-time anchor placement lint.
//
// Runs over `agent-assets/skills/<slug>/` for every slug that ships
// `curation.json`. Fails the test (and therefore CI) when any anchor
// violates the placement contract:
//
//   1. Anchor preceded by `## ` or `### ` heading.
//   2. Anchor is the only content under its owning heading.
//   3. ≤ 4 anchors per skill.
//   4. Unique IDs within a skill.
//   5. Anchor kind matches its declaration.
//
// Plus, every seed JSON the skill ships validates against `CurationPayload`.
//
// This is the canonical guard for the "framework PR adds anchors / seeds"
// path. Without it, a typo in a curation.json would surface only at
// session-materialization time as a `splicer_orphan_anchor` log.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CurationPayload } from "@aitne/shared";
import { loadAllCurationDeclarations } from "./declarations.js";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..", "..");
const SKILLS_ROOT = join(REPO_ROOT, "agent-assets", "skills");

describe("P22 §1.6 — anchor placement contract on shipped skills", () => {
  const decls = loadAllCurationDeclarations(SKILLS_ROOT).filter(
    (d) => d.declaration !== null,
  );

  it("at least one skill ships curation.json (MVP cohort)", () => {
    expect(decls.length).toBeGreaterThan(0);
  });

  for (const d of decls) {
    describe(d.slug, () => {
      it("has zero anchor-lint errors", () => {
        const errors = d.diagnostics.filter((diag) => diag.level === "error");
        expect(errors).toEqual([]);
      });

      it("declares ≤ 4 sections", () => {
        expect(d.declaration!.sections.length).toBeLessThanOrEqual(4);
      });

      it("every declared section has a matching anchor in SKILL.md", () => {
        const anchorIds = new Set(d.anchors.map((a) => a.id));
        for (const s of d.declaration!.sections) {
          expect(anchorIds.has(s.id)).toBe(true);
        }
      });

      it("every declared section has a valid seed JSON", () => {
        for (const s of d.declaration!.sections) {
          const seedPath = join(SKILLS_ROOT, d.slug, "seeds", `${s.id}.seed.json`);
          if (!existsSync(seedPath)) continue; // seeds are optional for v1
          const raw = readFileSync(seedPath, "utf-8");
          const result = CurationPayload.safeParse(JSON.parse(raw));
          if (!result.success) {
            throw new Error(
              `seed validation failed for ${d.slug}/${s.id}: ${JSON.stringify(result.error.issues)}`,
            );
          }
          expect(result.data.kind).toBe(s.kind);
        }
      });
    });
  }
});
