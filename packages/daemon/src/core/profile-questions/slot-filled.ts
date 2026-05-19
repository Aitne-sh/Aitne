/**
 * Profile-interview queue — heuristic slot-filled probe.
 *
 * Canonical implementation of the "is this section already answered"
 * heuristic used by every reconciliation layer (§3.5.6 of the design):
 *   - Layer 1: skeleton-time deterministic pre-tick (skeleton.ts → seed.ts)
 *   - Layer 2: morning-routine pre-pick verification (prose via HTTP)
 *   - Layer 3: scheduled.dm.md fire-time / opportunity-time abort (prose via HTTP)
 *   - Layer 5: setup.import_profile post-write tick (prose via HTTP)
 *
 * Layer 4 (LLM full sweep) deliberately uses model judgement instead of
 * this rule and may UNTICK rows tagged `(reconciled:skeleton|morning)`
 * if it finds a heuristic false positive.
 *
 * The function is **pure** (no fs / network) and **deterministic**.
 */

export interface SlotFilledResult {
  /**
   * True iff the section has at least one substantive bullet.
   *
   * - With `anchor`: a non-placeholder bullet whose key (text before the
   *   first `:`) matches `<anchor>` case-insensitively.
   * - Without `anchor`: any non-placeholder bullet counts.
   */
  filled: boolean;
  /**
   * True iff the requested section heading was found. When false,
   * `filled` is also false. Distinguishes "section missing entirely"
   * (typical for a freshly-created topic file with only an H1) from
   * "section exists but has no substantive content."
   */
  sectionPresent: boolean;
}

/**
 * Bullet contents (after stripping the leading `- ` / `* ` / `+ `) that
 * are placeholders rather than substantive content. The seed templates
 * shipped with the project use a few well-known phrasings; this list is
 * intentionally conservative — better to miss a placeholder than to
 * accidentally treat a real fact as one.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^\(none\)\s*$/i,
  /^\(leave blank\)\s*$/i,
  /^\(to be filled.*?\)\s*$/i,
  /^\(not yet configured\)\s*$/i,
  /^TBD\b/i,
  /^TODO\b/i,
  /^>\s*Add\b/i, // "- > Add a fact when you learn it"
];

const FRONTMATTER_RE = /^---\r?\n(?:.*\r?\n)*?---\r?\n/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const BULLET_RE = /^\s*[-*+]\s+(.+?)\s*$/;

/**
 * Probe a markdown file for whether the named section substantively
 * answers a profile-interview question.
 *
 * @param fileBody Full file content. YAML frontmatter (if present) is
 *                 stripped before parsing.
 * @param section  Heading text without the leading `## ` (e.g.
 *                 "Identity"). When `null`, the entire file body is
 *                 treated as the section.
 * @param anchor   Bullet key to match against the leading `<anchor>:`
 *                 portion of bullet text (case-insensitive). When
 *                 `null`, any non-placeholder bullet counts as filled.
 *                 Required whenever multiple queue rows share the same
 *                 target section, or whenever the section is
 *                 pre-seeded by setup with an unrelated bullet.
 */
export function isSlotFilled(
  fileBody: string,
  section: string | null,
  anchor: string | null,
): SlotFilledResult {
  const body = stripFrontmatter(fileBody);
  const sectionContent = section === null
    ? { found: true, content: body }
    : extractSection(body, section);
  if (!sectionContent.found) {
    return { filled: false, sectionPresent: false };
  }
  const filled = sectionContainsAnchor(sectionContent.content, anchor);
  return { filled, sectionPresent: true };
}

function stripFrontmatter(s: string): string {
  return s.replace(FRONTMATTER_RE, "");
}

/**
 * Extract the body of a section by heading text. The section ends at
 * the next heading of equal or shallower depth; deeper subheadings are
 * included in the returned content (they may carry the actual bullets).
 */
function extractSection(body: string, sectionName: string): {
  found: boolean;
  content: string;
} {
  const target = sectionName.trim().toLowerCase();
  const lines = body.split("\n");
  let inSection = false;
  let sectionDepth = 0;
  const collected: string[] = [];

  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      const depth = m[1].length;
      const norm = m[2].trim().toLowerCase();
      if (inSection && depth <= sectionDepth) break;
      if (!inSection && norm === target) {
        inSection = true;
        sectionDepth = depth;
        continue;
      }
      if (inSection) collected.push(line);
      continue;
    }
    if (inSection) collected.push(line);
  }

  return { found: inSection, content: collected.join("\n") };
}

function sectionContainsAnchor(
  sectionBody: string,
  anchor: string | null,
): boolean {
  const anchorLower = anchor?.trim().toLowerCase() ?? null;
  for (const rawLine of sectionBody.split("\n")) {
    const m = BULLET_RE.exec(rawLine);
    if (!m) continue;
    const text = m[1].trim();
    if (PLACEHOLDER_PATTERNS.some((re) => re.test(text))) continue;
    if (anchorLower === null) return true;
    const colonIdx = text.indexOf(":");
    if (colonIdx <= 0) continue;
    const key = text.slice(0, colonIdx).trim().toLowerCase();
    if (key === anchorLower) return true;
  }
  return false;
}
