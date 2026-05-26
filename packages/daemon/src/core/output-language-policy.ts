/**
 * Output language policy — one source of truth for the rule injected into
 * every backend session.
 *
 * Design: `docs/design/appendices/output-language-policy.md`
 *
 * Two surfaces consume this module:
 *
 *   1. `ContextBuilder` (per-turn XML context). `renderOutputLanguagePolicyBlock`
 *      emits the full `<output_language_policy>` block alongside
 *      `<settings primary_language=…>`. Refreshes every turn, so it
 *      tracks runtime `PATCH /api/config` changes to `primaryLanguage`.
 *
 *   2. `skills-compiler` (persistent system prompt). The renderer in the
 *      instruction-file path emits the much shorter
 *      `## Output language` pointer paragraph. Identical byte-for-byte
 *      across CLAUDE.md / AGENTS.md / GEMINI.md so the agent reads the
 *      same rule on every backend; intentionally carries NO value
 *      substitutions (no inlined `primaryLanguage`) — the live value
 *      lives in the per-turn XML and would go stale here.
 *
 * Treat both renderers as the unique source of the policy text. The
 * grep guard in `output-language-policy.test.ts` enforces this — adding
 * the same prose elsewhere will fail CI.
 */

const POLICY_BLOCK_OPEN = "<output_language_policy>";
const POLICY_BLOCK_CLOSE = "</output_language_policy>";

/**
 * Sentinel substring that any duplicate of the policy text would contain.
 * The grep guard test scans `src/` and `agent-assets/` (excluding this
 * file and the related test) for the sentinel and fails CI if it
 * appears anywhere else.
 */
export const OUTPUT_LANGUAGE_POLICY_SENTINEL =
  "Apply primary_language to:";

/**
 * Full `<output_language_policy>` block, populated with the current
 * `primaryLanguage`. Injected by `ContextBuilder` once per turn,
 * immediately after the existing `<settings primary_language=… />`
 * line.
 */
export function renderOutputLanguagePolicyBlock(
  primaryLanguage: string,
): string {
  const lang = primaryLanguage.trim() || "en";
  return [
    POLICY_BLOCK_OPEN,
    `  Setting: primary_language="${lang}"`,
    "",
    "  Apply primary_language to:",
    "    - Body prose, bullets, summaries, and narrative written via",
    "      /api/context/* (knowledge files under ~/.personal-agent/context/)",
    "    - Notes the agent creates in the user's Obsidian vault or Notion",
    "    - Section content under user-customized headers (whatever language",
    "      the user wrote the header in, content matches)",
    "",
    "  DM replies to the owner:",
    "    - Match the language of the user's most recent message",
    "    - Fall back to primary_language when the input is ambiguous, empty,",
    "      or system-generated",
    "    - Character block (tone, formality, emoji, verbosity) overrides",
    "      locale defaults — preserve the user's chosen voice in any language",
    "",
    "  Do NOT translate:",
    "    - Structural H2/H3 headers that match the shipped template skeleton",
    "      (Identity, Work Pattern, Annual Goals, etc.) — keep English so",
    "      parsers (management-md, profile-importer, journal readers) keep",
    "      working",
    "    - YAML frontmatter keys, wiki-link targets ([[identity/profile]]),",
    "      file paths, tool names, identifiers, env vars",
    "    - Fenced code blocks, JSON, CLI commands, URLs",
    "    - The agent journal (journal/agent.md is English by",
    "      policies/journal-format.md)",
    "    - policies/*.md files (management, redaction, mcp, management-captures)",
    "      — these are a structured registry, not prose",
    "",
    "  User-customized headers win:",
    "    - If the running file already uses a translated header (e.g.",
    `      "## Identidad"), preserve it and write content under it;`,
    "      do not revert to the English template header",
    "",
    "  Skeleton precedence:",
    "    - When creating a fresh file, copy the template skeleton verbatim",
    "      (English H2s) and fill the body in primary_language",
    POLICY_BLOCK_CLOSE,
  ].join("\n");
}

/** Heading line used by the instruction-file pointer block. */
export const OUTPUT_LANGUAGE_POINTER_HEADING = "## Output language";

/** End-of-character-block sentinel emitted by `character-block.ts`. */
const CHARACTER_END_MARKER = "<!-- character:end -->";

/** End-of-safety-preamble sentinel emitted by `skills-compiler.ts`. */
const SAFETY_END_MARKER = "<!-- safety:end -->";

/**
 * Insert the `## Output language` pointer block into the rendered Claude
 * instruction body. Placement mirrors the design §13.3 stack ordering —
 * after safety, after the user-defined character block (if any), and
 * before the runtime profile body.
 *
 * Placement search order:
 *
 *   1. Right after the character-block end marker (`<!-- character:end -->`
 *      followed by the FOOTER paragraph and a blank line). When the
 *      character block is present this is the natural "below character"
 *      seam.
 *   2. Right after the safety-end sentinel when the character block is
 *      absent.
 *   3. Before the first `## ` section heading as a final fallback for
 *      legacy bodies that carry neither sentinel.
 *
 * Idempotent: a body that already contains the heading is returned
 * unchanged. This matters because `applyCharacterBlockRewrite` is
 * idempotent in the same way and the two helpers may run in succession
 * across re-materialization.
 */
export function applyOutputLanguagePointerRewrite(content: string): string {
  if (content.includes(OUTPUT_LANGUAGE_POINTER_HEADING)) {
    return content;
  }
  const block = renderOutputLanguagePolicyPointer();

  const characterEndIdx = content.indexOf(CHARACTER_END_MARKER);
  if (characterEndIdx >= 0) {
    // The character block ends with FOOTER prose after the end-marker.
    // Insert *after* the FOOTER, immediately before the next `## ` heading
    // so the pointer block becomes a peer section of Character (mirrors
    // the §13.3 stack ordering).
    const searchFrom = characterEndIdx + CHARACTER_END_MARKER.length;
    const tail = content.slice(searchFrom);
    const nextHeadingOffset = tail.search(/\n## /);
    if (nextHeadingOffset >= 0) {
      const insertAt = searchFrom + nextHeadingOffset + 1;
      const before = content.slice(0, insertAt);
      const after = content.slice(insertAt);
      return `${before}${block}\n\n${after}`;
    }
    const trimmed = content.replace(/\s+$/, "");
    return `${trimmed}\n\n${block}\n`;
  }

  const safetyEndIdx = content.indexOf(SAFETY_END_MARKER);
  if (safetyEndIdx >= 0) {
    const afterSentinel = safetyEndIdx + SAFETY_END_MARKER.length;
    let cursor = afterSentinel;
    while (cursor < content.length && /\s/.test(content[cursor])) cursor++;
    const before = content.slice(0, afterSentinel);
    const after = content.slice(cursor);
    return after ? `${before}\n\n${block}\n\n${after}` : `${before}\n\n${block}\n`;
  }

  const firstHeadingIdx = findFirstSectionHeading(content);
  if (firstHeadingIdx < 0) {
    const trimmed = content.replace(/\s+$/, "");
    if (!trimmed) return `${block}\n`;
    return `${trimmed}\n\n${block}\n`;
  }
  const before = content.slice(0, firstHeadingIdx);
  const after = content.slice(firstHeadingIdx);
  return `${before}${block}\n\n${after}`;
}

function findFirstSectionHeading(content: string): number {
  if (content.startsWith("## ")) return 0;
  const idx = content.indexOf("\n## ");
  return idx < 0 ? -1 : idx + 1;
}

/**
 * Short `## Output language` pointer paragraph inlined verbatim into
 * CLAUDE.md / AGENTS.md / GEMINI.md by `skills-compiler`. Declarative,
 * no value substitutions — the live `primaryLanguage` is carried by
 * the per-turn `<output_language_policy>` XML block instead, so the
 * instruction file never goes stale when the user PATCHes the setting
 * mid-session. See design §13.4 / §13.5.
 */
export function renderOutputLanguagePolicyPointer(): string {
  return [
    "## Output language",
    "",
    "Output language is governed by `<output_language_policy>` in your",
    "turn context (full text, refreshes on every turn so it tracks runtime",
    "setting changes). In short:",
    "",
    "- **Knowledge files** under `/api/context/*`, **Obsidian** notes,",
    "  **Notion** pages, and other user-facing notes → write the body in",
    "  `<settings primary_language>`; keep template H2/H3 headers in",
    "  English (or preserve user-customized headers verbatim).",
    "- **DM replies** to the owner → match the user's input language;",
    "  fall back to `<settings primary_language>` when input is ambiguous",
    "  or the turn is system-initiated. Character block (tone, formality,",
    "  emoji) overrides locale defaults.",
    "- **Agent-internal surfaces** (this file, skill bodies, the agent",
    "  journal, API/log/audit, `policies/*.md` registry) → English. Always.",
    "",
    "See `docs/design/appendices/output-language-policy.md` for the full",
    "rule and policy taxonomy.",
  ].join("\n");
}
