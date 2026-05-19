// Decision-language linter (P22 §1.3, §1.4, §2.3 `decision_language_clean`).
//
// The optimizer agent submits typed JSON payloads describing knowledge
// cartography (file layouts, routing tables, conventions). It MUST NOT
// smuggle behavioural decision logic ("when X then Y", "must always do Z")
// into free-text fields — those belong in framework code, not in
// auto-curated skill content. Three layers of defence enforce this:
//
//   1. Zod refines on every free-text field at submission time.
//   2. Smoke-test re-check on the rendered markdown.
//   3. The optimizer-only skill body coaches paraphrase at proposal time.
//
// Patterns are intentionally narrow: descriptive prose like
// "All entries follow the [YYYY-MM-DD] prefix" must pass.

const DECISION_LANGUAGE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bwhen\s+[a-z]+.*\bthen\b/i,
  /\bif\s+[a-z]+.*\b(do|then|then\s+do)\b/i,
  /\bbefore\s+[a-z]+.*\byou\s+(should|must|need)\b/i,
  /\b(must|always|never)\b/i,
];

export function containsDecisionLanguage(value: string): boolean {
  return DECISION_LANGUAGE_PATTERNS.some((re) => re.test(value));
}

export function noDecisionLanguage(value: string): boolean {
  return !containsDecisionLanguage(value);
}

/** Embedded markers/anchors that the renderer would otherwise have to escape.
 *  Reject at the API edge so a renderer regression cannot silently pass them
 *  through into materialized SKILL.md (defence-in-depth). The first form
 *  catches HTML comments that the daemon parses; the second catches the
 *  `<integration_modes>` placeholder tag the SkillsCompiler substitutes. */
const EMBEDDED_MARKER_PATTERN =
  /(<!--\s*(?:CURATION|safety|integration_modes|mode:|today_write_lock_id))|(<\s*integration_modes\b)/i;

export function noEmbeddedMarkers(value: string): boolean {
  return !EMBEDDED_MARKER_PATTERN.test(value);
}

export const DECISION_LANGUAGE_MESSAGE =
  "convention rules cannot use imperative decision language (when/if/must/always/never). Restate as a description of the convention, not an instruction.";

export const EMBEDDED_MARKER_MESSAGE =
  "free-text fields cannot embed CURATION/safety/integration_modes/mode markers";
