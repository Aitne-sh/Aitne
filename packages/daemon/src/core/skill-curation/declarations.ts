// P22 §1.5, §1.6 — curation declaration loader.
//
// A skill declares its curatable sections via `curation.json` next to its
// `SKILL.md`. This loader:
//   - Resolves the file from `agent-assets/skills/<slug>/curation.json`.
//   - Validates against the `CurationDeclaration` Zod schema (kebab-case
//     section IDs, ≤4 sections per skill, etc.).
//   - Asserts §1.6 anchor placement contract on the SKILL.md body:
//       * Every declared section has exactly one anchor.
//       * Every anchor is preceded by a `## ` or `### ` heading.
//       * Anchor IDs are unique within the skill.
//       * Anchor kinds match the declaration's kind.
//       * Orphan anchors (no matching declaration) are flagged.
//
// Returns a `LoadedCurationDeclaration` with the parsed declaration plus
// any anchor-lint diagnostics. Callers decide whether to soft-warn or
// hard-reject based on context (CI lint = reject, runtime materialization
// = soft-warn + emit `skill_curation.declaration.*` log).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CurationDeclaration,
  type CurationDeclarationValue,
  SECTION_KINDS,
  type SectionKind,
} from "@aitne/shared";
import { listBuiltinSlugs, resolveBuiltinSkillDir } from "../skill-source-paths.js";

export interface AnchorOccurrence {
  /** 1-based line number of the anchor line in SKILL.md. */
  line: number;
  /** Raw anchor line (whitespace-stripped). */
  raw: string;
  /** Parsed anchor kind (`<!-- CURATION:knowledge_layout id="..." -->`). */
  kind: SectionKind;
  /** Parsed anchor id. */
  id: string;
}

export interface AnchorDiagnostic {
  level: "error" | "warning";
  code:
    | "anchor_missing_heading"
    | "anchor_kind_mismatch"
    | "anchor_orphan"
    | "anchor_id_duplicate"
    | "section_missing_anchor"
    | "anchor_count_exceeded";
  message: string;
  anchorId?: string;
  line?: number;
}

export interface LoadedCurationDeclaration {
  slug: string;
  declaration: CurationDeclarationValue | null; // null when curation.json absent
  anchors: AnchorOccurrence[];
  diagnostics: AnchorDiagnostic[];
}

const ANCHOR_RE = /<!--\s*CURATION:([a-z_]+)\s+id="([a-z0-9-]+)"\s*-->/i;

export function parseAnchorsFromMarkdown(md: string): AnchorOccurrence[] {
  const out: AnchorOccurrence[] = [];
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = ANCHOR_RE.exec(lines[i]);
    if (!m) continue;
    const kind = m[1].toLowerCase();
    if (!(SECTION_KINDS as readonly string[]).includes(kind)) continue;
    out.push({
      line: i + 1,
      raw: lines[i].trim(),
      kind: kind as SectionKind,
      id: m[2],
    });
  }
  return out;
}

function isHeadingLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("## ") || t.startsWith("### ");
}

export function lintAnchorPlacement(
  md: string,
  declaration: CurationDeclarationValue | null,
  anchors: AnchorOccurrence[],
): AnchorDiagnostic[] {
  const diags: AnchorDiagnostic[] = [];
  const lines = md.split("\n");

  // Rule 4 — anchor IDs are unique within a skill.
  const seenIds = new Map<string, number>();
  for (const a of anchors) {
    const prev = seenIds.get(a.id);
    if (prev !== undefined) {
      diags.push({
        level: "error",
        code: "anchor_id_duplicate",
        message: `duplicate anchor id "${a.id}" at lines ${prev} and ${a.line}`,
        anchorId: a.id,
        line: a.line,
      });
    } else {
      seenIds.set(a.id, a.line);
    }
  }

  // Rule 3 — soft cap of 4 anchors per skill.
  if (anchors.length > 4) {
    diags.push({
      level: "error",
      code: "anchor_count_exceeded",
      message: `skill has ${anchors.length} anchors (cap is 4)`,
    });
  }

  // Rule 1 — anchor preceded by ## or ### heading on the immediately previous
  // non-blank line.
  for (const a of anchors) {
    let prev = a.line - 2; // line - 1 is the anchor row index in 0-based
    while (prev >= 0 && lines[prev].trim() === "") prev--;
    if (prev < 0 || !isHeadingLine(lines[prev])) {
      diags.push({
        level: "error",
        code: "anchor_missing_heading",
        message: `anchor "${a.id}" is not preceded by a ## or ### heading`,
        anchorId: a.id,
        line: a.line,
      });
    }
  }

  if (declaration) {
    const declById = new Map(declaration.sections.map((s) => [s.id, s]));
    // Rule 5 — kind matches declaration; orphan anchors with no declaration.
    for (const a of anchors) {
      const d = declById.get(a.id);
      if (!d) {
        diags.push({
          level: "error",
          code: "anchor_orphan",
          message: `anchor "${a.id}" has no matching declaration`,
          anchorId: a.id,
          line: a.line,
        });
        continue;
      }
      if (d.kind !== a.kind) {
        diags.push({
          level: "error",
          code: "anchor_kind_mismatch",
          message: `anchor "${a.id}" kind=${a.kind} but declaration says kind=${d.kind}`,
          anchorId: a.id,
          line: a.line,
        });
      }
    }
    // Soft failure — declared section with no anchor in SKILL.md.
    const anchorIds = new Set(anchors.map((a) => a.id));
    for (const sec of declaration.sections) {
      if (!anchorIds.has(sec.id)) {
        diags.push({
          level: "warning",
          code: "section_missing_anchor",
          message: `declared section "${sec.id}" has no anchor in SKILL.md`,
          anchorId: sec.id,
        });
      }
    }
  } else if (anchors.length > 0) {
    // Anchors but no declaration → all orphans.
    for (const a of anchors) {
      diags.push({
        level: "error",
        code: "anchor_orphan",
        message: `anchor "${a.id}" present but no curation.json declaration found`,
        anchorId: a.id,
        line: a.line,
      });
    }
  }

  return diags;
}

export function loadCurationDeclaration(
  skillsRoot: string,
  slug: string,
): CurationDeclarationValue | null {
  // `resolveBuiltinSkillDir` lets wiki slugs (nested under
  // `skills/wiki/<slug>/` per WIKI_BUILDER_DESIGN.md §9.1) resolve to
  // the right curation.json without the loader needing to know the
  // wiki convention itself.
  const path = join(resolveBuiltinSkillDir(skillsRoot, slug), "curation.json");
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  const json = JSON.parse(raw);
  return CurationDeclaration.parse(json);
}

export function loadSkillCurationContext(
  skillsRoot: string,
  slug: string,
): LoadedCurationDeclaration {
  const declaration = loadCurationDeclaration(skillsRoot, slug);
  const skillPath = join(resolveBuiltinSkillDir(skillsRoot, slug), "SKILL.md");
  const md = existsSync(skillPath) ? readFileSync(skillPath, "utf-8") : "";
  const anchors = parseAnchorsFromMarkdown(md);
  const diagnostics = lintAnchorPlacement(md, declaration, anchors);
  return { slug, declaration, anchors, diagnostics };
}

/** Walk the skills root and return one record per slug — used by anchor-lint
 *  test and by `/health.skillCuration.misconfigured[]`. */
export function loadAllCurationDeclarations(
  skillsRoot: string,
): LoadedCurationDeclaration[] {
  // `listBuiltinSlugs` recurses one level into category subdirs so
  // wiki slugs are enumerated alongside flat skills.
  return listBuiltinSlugs(skillsRoot).map((slug) =>
    loadSkillCurationContext(skillsRoot, slug),
  );
}
