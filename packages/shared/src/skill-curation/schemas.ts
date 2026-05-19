// Skill-curation typed payloads (P22 §1.4 — normative).
//
// These are the ONLY shapes the curation API accepts. The optimizer agent
// has no Edit/Write tools — its sole mutation surface is `POST /api/skill-
// curation/proposals` with one of the six `kind` payloads below. Bounds on
// every string and array exist to cap blast radius.

import { z } from "zod";
import {
  DECISION_LANGUAGE_MESSAGE,
  EMBEDDED_MARKER_MESSAGE,
  noDecisionLanguage,
  noEmbeddedMarkers,
} from "./decision-language.js";
import { BACKEND_IDS } from "../backend.js";

/** Bumped when the typed-payload shape changes in a non-additive way. */
export const SKILL_CURATION_SCHEMA_VERSION = 1;

/** Allowed section kinds (discriminator on `payload.kind`). */
export const SECTION_KINDS = [
  "knowledge_layout",
  "routing_table",
  "frontmatter_schema",
  "search_recipes",
  "convention_notes",
  "cross_references",
] as const;

export type SectionKind = (typeof SECTION_KINDS)[number];

// Path-shape characters that the optimizer is allowed to submit. `*` is in
// the set because `knowledge_layout.files[].path` legitimately holds glob
// entries (`projects/*.md`, `user/*.md`) per design §1.2's seed rows; the
// smoke test's `paths_resolve` check already understands globs via
// `snapshotMatchesPath`. The renderer wraps the value in backticks unchanged.
const PathRegex = /^[a-z0-9_./*-]+$/i;

const noMarkersField = (max: number) =>
  z.string().max(max).refine(noEmbeddedMarkers, { message: EMBEDDED_MARKER_MESSAGE });

const descriptiveField = (min: number, max: number) =>
  z.string().min(min).max(max)
    .refine(noEmbeddedMarkers, { message: EMBEDDED_MARKER_MESSAGE })
    .refine(noDecisionLanguage, { message: DECISION_LANGUAGE_MESSAGE });

// ── knowledge_layout ─────────────────────────────────────────────────────

export const KnowledgeLayoutSection = z.object({
  heading: z.string().min(1).max(80).refine(noEmbeddedMarkers, { message: EMBEDDED_MARKER_MESSAGE }),
  contains: descriptiveField(5, 200),
  example_entry: noMarkersField(200).optional(),
  writers: z.array(z.string().min(1).max(40)).max(10).optional(),
});

export const KnowledgeLayoutFile = z.object({
  path: z.string().regex(PathRegex).max(120),
  purpose: descriptiveField(5, 200),
  sections: z.array(KnowledgeLayoutSection).max(20),
});

export const KnowledgeLayoutPayload = z.object({
  kind: z.literal("knowledge_layout"),
  files: z.array(KnowledgeLayoutFile).min(1).max(50),
});

// ── routing_table ────────────────────────────────────────────────────────

export const RoutingTableRule = z.object({
  trigger_pattern: z.string().min(5).max(200)
    .refine(noEmbeddedMarkers, { message: EMBEDDED_MARKER_MESSAGE }),
  destination_path: z.string().regex(PathRegex).max(120),
  destination_section: z.string().min(1).max(80),
  destination_mode: z.enum(["append", "replace", "append_to_file", "patch_section"]),
  note: z.string().max(150)
    .refine(noEmbeddedMarkers, { message: EMBEDDED_MARKER_MESSAGE })
    .refine(noDecisionLanguage, { message: DECISION_LANGUAGE_MESSAGE })
    .optional(),
});

export const RoutingTablePayload = z.object({
  kind: z.literal("routing_table"),
  rules: z.array(RoutingTableRule).min(1).max(50),
});

// ── frontmatter_schema ───────────────────────────────────────────────────

export const FrontmatterRequiredField = z.object({
  key: z.string().min(1).max(40),
  type: z.enum(["string", "iso-date", "enum", "array"]),
  example: z.string().min(1).max(120),
});

export const FrontmatterConventionalField = z.object({
  key: z.string().min(1).max(40),
  purpose: z.string().min(3).max(120)
    .refine(noEmbeddedMarkers, { message: EMBEDDED_MARKER_MESSAGE })
    .refine(noDecisionLanguage, { message: DECISION_LANGUAGE_MESSAGE }),
});

export const FrontmatterFileType = z.object({
  glob: z.string().min(1).max(80),
  required: z.array(FrontmatterRequiredField).max(10),
  conventional: z.array(FrontmatterConventionalField).max(20),
});

export const FrontmatterSchemaPayload = z.object({
  kind: z.literal("frontmatter_schema"),
  file_types: z.array(FrontmatterFileType).min(1).max(20),
});

// ── search_recipes ───────────────────────────────────────────────────────

export const SearchRecipe = z.object({
  question_shape: descriptiveField(5, 200),
  lookup_path: z.string().regex(PathRegex).max(120),
  lookup_section: z.string().min(1).max(80).optional(),
  note: z.string().max(200)
    .refine(noEmbeddedMarkers, { message: EMBEDDED_MARKER_MESSAGE })
    .refine(noDecisionLanguage, { message: DECISION_LANGUAGE_MESSAGE })
    .optional(),
});

export const SearchRecipesPayload = z.object({
  kind: z.literal("search_recipes"),
  recipes: z.array(SearchRecipe).min(1).max(50),
});

// ── convention_notes ─────────────────────────────────────────────────────

export const ConventionNote = z.object({
  topic: z.string().min(3).max(80).refine(noEmbeddedMarkers, { message: EMBEDDED_MARKER_MESSAGE }),
  // Tightened from 300 → 180: conventions are short statements of fact, not
  // how-to instructions.
  rule: descriptiveField(5, 180),
  example: noMarkersField(200).optional(),
});

export const ConventionNotesPayload = z.object({
  kind: z.literal("convention_notes"),
  notes: z.array(ConventionNote).min(1).max(20),
});

// ── cross_references ─────────────────────────────────────────────────────

export const CrossReference = z.object({
  from_path: z.string().regex(PathRegex).max(120),
  to_path: z.string().regex(PathRegex).max(120),
  relation: z.string().min(3).max(120)
    .refine(noEmbeddedMarkers, { message: EMBEDDED_MARKER_MESSAGE })
    .refine(noDecisionLanguage, { message: DECISION_LANGUAGE_MESSAGE }),
});

export const CrossReferencesPayload = z.object({
  kind: z.literal("cross_references"),
  refs: z.array(CrossReference).min(1).max(50),
});

// ── Discriminated union over all kinds ───────────────────────────────────

export const CurationPayload = z.discriminatedUnion("kind", [
  KnowledgeLayoutPayload,
  RoutingTablePayload,
  FrontmatterSchemaPayload,
  SearchRecipesPayload,
  ConventionNotesPayload,
  CrossReferencesPayload,
]);

export type CurationPayloadValue = z.infer<typeof CurationPayload>;
export type KnowledgeLayoutValue = z.infer<typeof KnowledgeLayoutPayload>;
export type RoutingTableValue = z.infer<typeof RoutingTablePayload>;
export type FrontmatterSchemaValue = z.infer<typeof FrontmatterSchemaPayload>;
export type SearchRecipesValue = z.infer<typeof SearchRecipesPayload>;
export type ConventionNotesValue = z.infer<typeof ConventionNotesPayload>;
export type CrossReferencesValue = z.infer<typeof CrossReferencesPayload>;

// ── Per-kind byte budgets (P22 §1.4.5) ───────────────────────────────────

export const BYTE_BUDGET: Record<SectionKind, number> = {
  knowledge_layout: 3 * 1024,
  routing_table: 2 * 1024,
  frontmatter_schema: 2 * 1024,
  search_recipes: 2 * 1024,
  convention_notes: 1.5 * 1024,
  cross_references: 1 * 1024,
};

// ── Curation declaration sidecar (curation.json) ─────────────────────────

export const CurationDeclarationSection = z.object({
  id: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
  kind: z.enum(SECTION_KINDS),
  anchor: z.string().min(1).max(200),
  human_label: z.string().min(1).max(80),
  description: z.string().min(1).max(200),
  scope_paths: z.array(z.string().min(1).max(120)).min(1).max(20),
});

export const CurationDeclaration = z.object({
  version: z.literal(1),
  sections: z.array(CurationDeclarationSection).min(1).max(4),
});

export type CurationDeclarationValue = z.infer<typeof CurationDeclaration>;
export type CurationDeclarationSectionValue = z.infer<typeof CurationDeclarationSection>;

// ── Settings (`runtime_state.skill_curation.config`) ─────────────────────

// P22 §6.2 — operator-facing config. Auto-apply is the implicit behaviour
// (every passing proposal applies); the only opt-out is `enabled = false`,
// which both stops new runs AND tells SkillsCompiler to render seed-only.
export const SkillCurationConfig = z.object({
  enabled: z.boolean().default(false),
  cadence: z.enum(["daily", "weekly", "monthly"]).default("weekly"),
  backend: z.enum(BACKEND_IDS).default("claude"),
  model: z.string().min(1).max(120).default("claude-sonnet-4-6"),
  excluded_skills: z.array(z.string().min(1).max(80)).default([]),
});

export type SkillCurationConfigValue = z.infer<typeof SkillCurationConfig>;

export const DEFAULT_SKILL_CURATION_CONFIG: SkillCurationConfigValue = {
  enabled: false,
  cadence: "weekly",
  backend: "claude",
  model: "claude-sonnet-4-6",
  excluded_skills: [],
};

// ── Overlay envelope written to disk ─────────────────────────────────────

export const OverlayEnvelope = z.object({
  schema_version: z.number().int().positive(),
  skill_slug: z.string().min(1).max(80),
  section_id: z.string().min(1).max(80),
  kind: z.enum(SECTION_KINDS),
  payload: CurationPayload,
  applied_proposal_id: z.number().int().nullable(),
  applied_at: z.number().int().nullable(),
});

export type OverlayEnvelopeValue = z.infer<typeof OverlayEnvelope>;

// ── Proposal submission body (POST /api/skill-curation/proposals) ───────

export const SubmitProposalRequest = z.object({
  runId: z.string().min(1).max(120),
  skill_slug: z.string().min(1).max(80),
  section_id: z.string().min(1).max(80),
  payload: CurationPayload,
  rationale: z.string().min(1).max(500),
  signal_ids: z.array(z.number().int().positive()).min(1).max(50),
});

export type SubmitProposalRequestValue = z.infer<typeof SubmitProposalRequest>;

// ── §6.4 manual run trigger ──────────────────────────────────────────────

/** Manual on-demand run — `POST /api/skill-curation/runs/manual`. The
 *  dashboard fires this when the owner clicks "Run optimization now".
 *  Bypasses the per-skill weight threshold and the per-section cooldown
 *  for skill SELECTION (see signals.ts), but proposals still require
 *  signal citations via the `signal_citations_valid` smoke check.
 *
 *  Body is intentionally empty in v1 — server reads cadence/backend/model
 *  from `runtime_state.skill_curation.config`. Reserved for future use
 *  (e.g. owner-narrowed manual run targeting a specific skill). */
export const ManualRunRequest = z.object({
  /** Optional override — restrict the run to these skills only. When
   *  omitted, every skill with ≥1 unconsumed signal becomes a target.
   *  Slugs the operator excluded via /settings/self-learning are still
   *  filtered out regardless of this list. */
  target_skills: z.array(z.string().min(1).max(80)).max(20).optional(),
});

export type ManualRunRequestValue = z.infer<typeof ManualRunRequest>;

// ── §5.4 orphan-overlay discard ────────────────────────────────────────

export const DiscardOrphanRequest = z.object({
  slug: z.string().min(1).max(80),
  section_id: z.string().min(1).max(80),
});

export type DiscardOrphanRequestValue = z.infer<typeof DiscardOrphanRequest>;
