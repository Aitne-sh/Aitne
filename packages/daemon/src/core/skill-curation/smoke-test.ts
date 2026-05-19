// P22 §2.3 — smoke-test runner.
//
// Runs deterministic checks on a *validated and rendered* proposal before
// the chokepoint applies the overlay atomically. Failure produces a
// `failures[]` list the API caller (and the dashboard's "why did the
// optimizer give up on X?" view) can show verbatim. A failed smoke test
// persists the proposal with `status='smoke_failed'` and the failures
// JSON; no overlay is written.
//
// Checks (all hard rejects):
//   render_parses              — CommonMark round-trip
//   render_within_budget       — byte budget (also enforced at API step 6)
//   no_embedded_markers        — final MD has no marker injection
//   decision_language_clean    — free-text fields pass linter post-render
//   paths_resolve              — payload paths resolve in current snapshot
//   sections_resolve           — referenced sections exist (or mode allows create)
//   cross_section_consistency  — destination_section also exists in some
//                                knowledge_layout payload owned by same skill
//   no_duplicate_entries       — primary keys unique within payload
//   frozen_sections_unchanged  — section is not frozen
//   signal_citations_valid     — every signal_id exists, unconsumed, same skill

import type Database from "better-sqlite3";
import {
  containsDecisionLanguage,
  type CurationPayloadValue,
  type SectionKind,
  SKILL_CURATION_BYTE_BUDGET,
} from "@aitne/shared";
import {
  type KnowledgeMapSnapshot,
  snapshotMatchesPath,
  snapshotMatchesSection,
} from "./knowledge-map.js";
import { OverlayStore } from "./overlay-store.js";

export interface SmokeFailure {
  check: SmokeCheck;
  message: string;
}

export type SmokeCheck =
  | "render_parses"
  | "render_within_budget"
  | "no_embedded_markers"
  | "decision_language_clean"
  | "paths_resolve"
  | "sections_resolve"
  | "cross_section_consistency"
  | "no_duplicate_entries"
  | "frozen_sections_unchanged"
  | "signal_citations_valid";

export interface SmokeResult {
  ok: boolean;
  failures: SmokeFailure[];
}

export interface RunSmokeTestInput {
  db: Database.Database;
  skill_slug: string;
  section_id: string;
  section_kind: SectionKind;
  payload: CurationPayloadValue;
  rendered_md: string;
  signal_ids: number[];
  snapshot: KnowledgeMapSnapshot;
  /** Reserved for v2 extensions that need read access to overlays/seeds
   *  during the smoke check (e.g. comparing payload across multiple
   *  sections of the same skill). v1 routes use it indirectly via
   *  `siblingPayloads`. */
  overlay: OverlayStore;
  /** Set of "frozen" section keys (`<slug>:<section_id>`) from runtime_state. */
  frozenSet: Set<string>;
  /** Other curated sections this skill owns, by id. The smoke test uses
   *  this for `cross_section_consistency`: a routing_table proposal
   *  references sections that must also exist in the same skill's
   *  knowledge_layout payload (current overlay OR co-submitted in this
   *  same run). The caller (API hot path) builds this map from the
   *  loaded curation declaration. */
  siblingPayloads?: Record<string, CurationPayloadValue>;
}

export function runSmokeTest(input: RunSmokeTestInput): SmokeResult {
  const failures: SmokeFailure[] = [];
  const add = (check: SmokeCheck, message: string) => failures.push({ check, message });

  // 1. render_parses — minimal CommonMark sanity. Full CommonMark-AST round-
  //    trip would pull in another dep; the lightweight checks below catch the
  //    breakages we actually see (table column count, fence balance).
  if (!isWellFormedTable(input.rendered_md)) {
    add("render_parses", "rendered markdown has malformed table structure");
  }
  if (!isFenceBalanced(input.rendered_md)) {
    add("render_parses", "rendered markdown has unbalanced code fence");
  }

  // 2. render_within_budget
  const bytes = Buffer.byteLength(input.rendered_md, "utf-8");
  const budget = SKILL_CURATION_BYTE_BUDGET[input.section_kind];
  if (bytes > budget) {
    add("render_within_budget", `rendered ${bytes}B exceeds ${budget}B budget for kind=${input.section_kind}`);
  }

  // 3. no_embedded_markers — schema-level guard restated post-render in case
  //    a future renderer expansion injects new prose.
  if (
    /<!--\s*(CURATION|safety|integration_modes|mode:|today_write_lock_id)/i.test(input.rendered_md) ||
    /<\s*integration_modes\b/i.test(input.rendered_md)
  ) {
    add("no_embedded_markers", "rendered markdown contains a reserved marker pattern");
  }

  // 4. decision_language_clean
  for (const text of freeTextFields(input.payload)) {
    if (containsDecisionLanguage(text)) {
      add("decision_language_clean", `imperative phrasing in field: ${truncate(text, 60)}`);
      break;
    }
  }

  // 5. paths_resolve
  for (const p of payloadPaths(input.payload)) {
    if (!snapshotMatchesPath(input.snapshot, p)) {
      add("paths_resolve", `path "${p}" does not resolve under context dir`);
    }
  }

  // 6. sections_resolve — only meaningful for routing_table + search_recipes.
  if (input.payload.kind === "routing_table") {
    for (const r of input.payload.rules) {
      if (r.destination_mode === "append_to_file") continue;
      if (!snapshotMatchesPath(input.snapshot, r.destination_path)) continue; // captured by paths_resolve
      if (!snapshotMatchesSection(input.snapshot, r.destination_path, r.destination_section)) {
        add("sections_resolve", `section "${r.destination_section}" missing in ${r.destination_path}`);
      }
    }
  } else if (input.payload.kind === "search_recipes") {
    for (const r of input.payload.recipes) {
      if (!r.lookup_section) continue;
      if (!snapshotMatchesPath(input.snapshot, r.lookup_path)) continue;
      if (!snapshotMatchesSection(input.snapshot, r.lookup_path, r.lookup_section)) {
        add("sections_resolve", `section "${r.lookup_section}" missing in ${r.lookup_path}`);
      }
    }
  }

  // 7. cross_section_consistency — when curating routing_table, every
  //    destination_section referenced must also exist in some
  //    knowledge_layout payload owned by the same skill.
  if (input.payload.kind === "routing_table") {
    const ownedSections = collectKnowledgeLayoutSections(input.siblingPayloads ?? {});
    if (ownedSections.size > 0) {
      for (const r of input.payload.rules) {
        const section = stripHeading(r.destination_section);
        const targetKey = `${r.destination_path.toLowerCase()}#${section}`;
        if (!ownedSections.has(targetKey)) {
          // It's only an inconsistency if the path is one this skill manages
          // — heuristic: at least one knowledge_layout file matches the path.
          const skillManagesPath = Array.from(ownedSections).some(
            (k) => k.startsWith(r.destination_path.toLowerCase() + "#"),
          );
          if (skillManagesPath) {
            add(
              "cross_section_consistency",
              `routing rule references "${r.destination_path}#${section}" not in this skill's knowledge_layout`,
            );
          }
        }
      }
    }
  }

  // 7b. cross_section_consistency (inverse) — when curating knowledge_layout,
  //     reject removals of sections still referenced by an existing
  //     routing_table sibling. Per §2.3: "the inverse: a knowledge_layout
  //     removal that drops a section still referenced by an unconsidered
  //     routing rule is rejected". The optimizer is supposed to co-submit
  //     a routing_table proposal in the same run; without that, the
  //     knowledge_layout proposal alone would silently break navigation.
  if (input.payload.kind === "knowledge_layout") {
    const newSectionKeys = new Set<string>();
    for (const f of input.payload.files) {
      for (const s of f.sections) {
        newSectionKeys.add(`${f.path.toLowerCase()}#${stripHeading(s.heading)}`);
      }
    }
    const referencedByRouting = collectRoutingTableReferences(input.siblingPayloads ?? {});
    for (const ref of referencedByRouting) {
      // Only flag references whose destination_path is one this proposal
      // describes — references to paths owned by other skills are out of
      // scope (§9 risk #3 cross-skill is not arbitrated here).
      const refPath = ref.split("#")[0];
      const proposalCoversPath = input.payload.files.some(
        (f) => f.path.toLowerCase() === refPath,
      );
      if (proposalCoversPath && !newSectionKeys.has(ref)) {
        add(
          "cross_section_consistency",
          `knowledge_layout removes "${ref}" but a sibling routing_table rule still references it`,
        );
      }
    }
  }

  // 8. no_duplicate_entries — primary keys unique within the payload.
  const keys = primaryKeys(input.payload);
  const seen = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) {
      add("no_duplicate_entries", `duplicate primary key "${k}" within payload`);
      break;
    }
    seen.add(k);
  }

  // 9. frozen_sections_unchanged
  if (input.frozenSet.has(`${input.skill_slug}:${input.section_id}`)) {
    add("frozen_sections_unchanged", `section ${input.skill_slug}:${input.section_id} is frozen`);
  }

  // 10. signal_citations_valid
  if (input.signal_ids.length === 0) {
    add("signal_citations_valid", "proposal must cite at least one signal");
  } else {
    const placeholders = input.signal_ids.map(() => "?").join(",");
    const rows = input.db
      .prepare(
        `SELECT id, skill_slug, consumed_at FROM skill_curation_signals WHERE id IN (${placeholders})`,
      )
      .all(...input.signal_ids) as { id: number; skill_slug: string; consumed_at: number | null }[];
    if (rows.length !== input.signal_ids.length) {
      add("signal_citations_valid", "one or more signal_ids not found");
    }
    for (const row of rows) {
      if (row.skill_slug !== input.skill_slug) {
        add("signal_citations_valid", `signal ${row.id} belongs to skill ${row.skill_slug}, not ${input.skill_slug}`);
      }
      if (row.consumed_at !== null) {
        add("signal_citations_valid", `signal ${row.id} already consumed`);
      }
    }
  }

  return { ok: failures.length === 0, failures };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function isWellFormedTable(md: string): boolean {
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("|")) continue;
    const next = lines[i + 1];
    if (!next || !/^\|\s*[-:]+/.test(next)) continue;
    // Count columns in header and separator
    const hcols = countTableColumns(line);
    const scols = countTableColumns(next);
    if (hcols !== scols || hcols < 2) return false;
    // Walk subsequent rows until non-table line; column counts must match
    for (let j = i + 2; j < lines.length; j++) {
      if (!lines[j].startsWith("|")) break;
      if (countTableColumns(lines[j]) !== hcols) return false;
    }
  }
  return true;
}

function countTableColumns(line: string): number {
  // Count `|` separators, stripping one leading and one trailing pipe when
  // present. Using replace() avoids branch coverage issues from dead ternaries.
  const s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return s.split("|").length;
}

function isFenceBalanced(md: string): boolean {
  const m = md.match(/```/g);
  return !m || m.length % 2 === 0;
}

function* freeTextFields(p: CurationPayloadValue): Iterable<string> {
  switch (p.kind) {
    case "knowledge_layout":
      for (const f of p.files) {
        yield f.purpose;
        for (const s of f.sections) yield s.contains;
      }
      return;
    case "routing_table":
      for (const r of p.rules) if (r.note) yield r.note;
      return;
    case "frontmatter_schema":
      for (const ft of p.file_types) {
        for (const c of ft.conventional) yield c.purpose;
      }
      return;
    case "search_recipes":
      for (const r of p.recipes) {
        yield r.question_shape;
        if (r.note) yield r.note;
      }
      return;
    case "convention_notes":
      for (const n of p.notes) yield n.rule;
      return;
    case "cross_references":
      for (const r of p.refs) yield r.relation;
      return;
  }
}

function* payloadPaths(p: CurationPayloadValue): Iterable<string> {
  switch (p.kind) {
    case "knowledge_layout":
      for (const f of p.files) yield f.path;
      return;
    case "routing_table":
      for (const r of p.rules) yield r.destination_path;
      return;
    case "frontmatter_schema":
      for (const ft of p.file_types) yield ft.glob;
      return;
    case "search_recipes":
      for (const r of p.recipes) yield r.lookup_path;
      return;
    case "convention_notes":
      return;
    case "cross_references":
      for (const r of p.refs) {
        yield r.from_path;
        yield r.to_path;
      }
      return;
  }
}

function primaryKeys(p: CurationPayloadValue): string[] {
  switch (p.kind) {
    case "knowledge_layout": return p.files.map((f) => f.path.toLowerCase());
    case "routing_table":    return p.rules.map((r) => `${r.trigger_pattern}|${r.destination_path.toLowerCase()}|${r.destination_section}`);
    case "frontmatter_schema": return p.file_types.map((ft) => ft.glob.toLowerCase());
    case "search_recipes":   return p.recipes.map((r) => r.question_shape.toLowerCase());
    case "convention_notes": return p.notes.map((n) => n.topic.toLowerCase());
    case "cross_references": return p.refs.map((r) => `${r.from_path.toLowerCase()}|${r.to_path.toLowerCase()}`);
  }
}

function collectKnowledgeLayoutSections(
  siblingPayloads: Record<string, CurationPayloadValue>,
): Set<string> {
  const out = new Set<string>();
  for (const payload of Object.values(siblingPayloads)) {
    if (payload.kind !== "knowledge_layout") continue;
    for (const f of payload.files) {
      for (const s of f.sections) {
        out.add(`${f.path.toLowerCase()}#${stripHeading(s.heading)}`);
      }
    }
  }
  return out;
}

/** Collect every (destination_path, destination_section) pair referenced by
 *  routing_table siblings — used by the inverse cross_section_consistency
 *  check to refuse a knowledge_layout removal that would orphan a routing
 *  rule. Excludes `append_to_file` rules whose section is implicit. */
function collectRoutingTableReferences(
  siblingPayloads: Record<string, CurationPayloadValue>,
): Set<string> {
  const out = new Set<string>();
  for (const payload of Object.values(siblingPayloads)) {
    if (payload.kind !== "routing_table") continue;
    for (const r of payload.rules) {
      if (r.destination_mode === "append_to_file") continue;
      out.add(`${r.destination_path.toLowerCase()}#${stripHeading(r.destination_section)}`);
    }
  }
  return out;
}

function stripHeading(s: string): string {
  return s.replace(/^##{1,2}\s+/, "").trim();
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
