// P22 §2.2 step 6 — kind-dispatched renderer entry point.
//
// `renderCurationSection(kind, payload)` is the only function the API hot
// path calls. Each per-kind module exports `RENDERER_VERSION` so we can
// pin proposals to the renderer revision they were generated with (§5.4).

import type { CurationPayloadValue, SectionKind } from "@aitne/shared";
import {
  renderConventionNotes,
  RENDERER_VERSION as CONVENTION_NOTES_VERSION,
} from "./convention-notes.js";
import {
  renderCrossReferences,
  RENDERER_VERSION as CROSS_REFERENCES_VERSION,
} from "./cross-references.js";
import {
  renderFrontmatterSchema,
  RENDERER_VERSION as FRONTMATTER_SCHEMA_VERSION,
} from "./frontmatter-schema.js";
import {
  renderKnowledgeLayout,
  RENDERER_VERSION as KNOWLEDGE_LAYOUT_VERSION,
} from "./knowledge-layout.js";
import {
  renderRoutingTable,
  RENDERER_VERSION as ROUTING_TABLE_VERSION,
} from "./routing-table.js";
import {
  renderSearchRecipes,
  RENDERER_VERSION as SEARCH_RECIPES_VERSION,
} from "./search-recipes.js";

export const RENDERER_VERSIONS: Record<SectionKind, string> = {
  knowledge_layout: KNOWLEDGE_LAYOUT_VERSION,
  routing_table: ROUTING_TABLE_VERSION,
  frontmatter_schema: FRONTMATTER_SCHEMA_VERSION,
  search_recipes: SEARCH_RECIPES_VERSION,
  convention_notes: CONVENTION_NOTES_VERSION,
  cross_references: CROSS_REFERENCES_VERSION,
};

export function rendererVersionFor(kind: SectionKind): string {
  return RENDERER_VERSIONS[kind];
}

export function renderCurationSection(
  kind: SectionKind,
  payload: CurationPayloadValue,
): string {
  if (payload.kind !== kind) {
    throw new Error(
      `renderCurationSection: kind mismatch (expected ${kind}, got ${payload.kind})`,
    );
  }
  switch (payload.kind) {
    case "knowledge_layout":
      return renderKnowledgeLayout(payload);
    case "routing_table":
      return renderRoutingTable(payload);
    case "frontmatter_schema":
      return renderFrontmatterSchema(payload);
    case "search_recipes":
      return renderSearchRecipes(payload);
    case "convention_notes":
      return renderConventionNotes(payload);
    case "cross_references":
      return renderCrossReferences(payload);
  }
}
