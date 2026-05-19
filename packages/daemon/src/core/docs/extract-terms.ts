import {
  slugifyAnchor,
  type DocsFrontmatter,
} from "@aitne/shared";

/**
 * Term-level row builder for the docs subindex
 * (DOCS-QA-SEARCH-PRECISION-PLAN.md §6).
 *
 * Pure module: lives outside `indexer.ts` so it lands inside the 100 %
 * coverage gate (`vitest.config.ts` excludes the indexer's I/O glue).
 *
 * Two consumers:
 *   1. `indexer.ts` calls `extractTerms()` to populate `fts_doc_terms`.
 *   2. `indexer.ts:extractAnchors` calls `iterateHeadings()` to enumerate
 *      the doc's H1/H2/H3 anchors. Sharing the helper guarantees the
 *      anchor set the citation post-processor validates against and the
 *      anchor set the QA agent sees in `term-search` results cannot drift.
 *
 * Code-fence handling: the previous `HEADING_RE` regex matched `#` lines
 * inside fenced code blocks and produced phantom anchors. The shared
 * walker tracks fence state so example MD inside ```` ``` ```` /
 * `~~~` blocks is treated as content.
 */

export interface ExtractedTerm {
  /** Empty string for the doc-level row; slugified heading otherwise. */
  anchor: string;
  /** Display label — frontmatter title or heading text. */
  term: string;
  /** Newline-joined aliases pool. May be empty. */
  aliases: string;
  /**
   * Section-leading content (see §6.2.1 of the plan), capped at
   * `LEADING_PARAGRAPH_MAX_LEN`. May be empty.
   */
  summary: string;
}

export interface HeadingRef {
  /** Heading depth: 1, 2, or 3. */
  level: 1 | 2 | 3;
  /** Raw heading text (after the `# ` markers, before slugify). */
  text: string;
  /** Index into the line array where this heading lives. */
  lineIndex: number;
}

/**
 * Cap on the per-section `summary` column. Picked to keep BM25 ranking
 * focused on the section's lead-in rather than diluting it with multi-
 * paragraph prose; `unicode61` tokens average ~5 chars, so 400 chars is
 * roughly the first 70-80 words.
 */
export const LEADING_PARAGRAPH_MAX_LEN = 400;

const HEADING_LINE_RE = /^(#{1,3})\s+(.+?)\s*$/;
const FENCE_LINE_RE = /^\s*(```|~~~)/;

/**
 * Walk `body` line by line and yield every H1/H2/H3 heading that lives
 * **outside** a fenced code block. Lines starting with ```` ``` ```` or
 * `~~~` toggle a `insideFence` flag; nested or unbalanced fences
 * default to "remain inside" until the next matching closer or EOF
 * (FTS impact is bounded — at worst a closing-fence-less doc loses its
 * post-fence anchors).
 */
export function iterateHeadings(body: string): HeadingRef[] {
  const lines = body.split(/\r?\n/);
  const out: HeadingRef[] = [];
  let insideFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (FENCE_LINE_RE.test(line)) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;
    const m = HEADING_LINE_RE.exec(line);
    if (!m) continue;
    const level = m[1]!.length as 1 | 2 | 3;
    const text = m[2]!;
    out.push({ level, text, lineIndex: i });
  }
  return out;
}

/**
 * Build term-index rows for a single doc.
 *
 * Rows produced:
 *   1. **Doc-level row** (always emitted). `anchor=""`, `term=fm.title`,
 *      `aliases = fm.aliases ∪ fm.keywords ∪ fm.ask_examples`
 *      (joined by `\n`), `summary = fm.summary`.
 *   2. **One row per H2 / H3 in the body.** `anchor = slugifyAnchor(text)`,
 *      `term = heading_text`, `aliases = ""`, `summary = section-leading
 *      content` (see §6.2.1) trimmed and capped at
 *      `LEADING_PARAGRAPH_MAX_LEN`.
 *
 * H1 is intentionally not promoted to its own row — the doc-level row
 * already covers it (and the H1 anchor exists in `fts_docs.anchors` for
 * citation validation via `iterateHeadings`).
 *
 * Sections with an empty leading paragraph still emit a row (so the
 * heading text itself is searchable as a `term`).
 */
export function extractTerms(
  fm: DocsFrontmatter,
  body: string,
): ExtractedTerm[] {
  const out: ExtractedTerm[] = [];

  const aliasPool = [
    ...(fm.aliases ?? []),
    ...(fm.keywords ?? []),
    ...(fm.ask_examples ?? []),
  ].join("\n");

  out.push({
    anchor: "",
    term: fm.title,
    aliases: aliasPool,
    summary: fm.summary,
  });

  const lines = body.split(/\r?\n/);
  const headings = iterateHeadings(body);
  // First-wins dedup on slugified anchor. `slugifyAnchor` is lossy
  // (drops non-ASCII, collapses whitespace), so two H2s with different
  // raw text can collide ("Why?" / "Why!" → both "why"). Without
  // dedup, /api/docs/term-search returns multiple rows whose `citation`
  // string is byte-identical — the operator clicks two distinct cards
  // that scroll to the same anchor. Keeping the first occurrence is
  // the standard convention: docs put the definition before examples,
  // so the earlier section-lead is usually the more useful one.
  const seenAnchors = new Set<string>();

  for (let h = 0; h < headings.length; h += 1) {
    const heading = headings[h]!;
    if (heading.level === 1) continue;

    const anchor = slugifyAnchor(heading.text);
    if (anchor.length === 0) continue;
    if (seenAnchors.has(anchor)) continue;
    seenAnchors.add(anchor);

    const nextHeading = headings[h + 1];
    const sectionEnd = nextHeading?.lineIndex ?? lines.length;
    const summary = collectSectionLead(
      lines,
      heading.lineIndex + 1,
      sectionEnd,
    );

    out.push({
      anchor,
      term: heading.text,
      aliases: "",
      summary,
    });
  }

  return out;
}

/**
 * Extract the "section-lead" text for a single H2/H3 row.
 *
 * Walks `lines[start..end)`, tracking fence state, and joins every
 * non-blank source line up to (but not including) the first **top-level**
 * blank line — i.e. a blank line outside any fenced code block. A blank
 * line *inside* a fence does not terminate the lead-in (a fenced example
 * directly under the heading stays whole).
 *
 * Lines are joined with a single space; the result is trimmed and capped
 * at `LEADING_PARAGRAPH_MAX_LEN`. List markers, table rows, inline code,
 * and the **bodies of** fenced code blocks that begin immediately under
 * the heading with no preceding blank line are all treated as section-
 * lead content. The fence delimiter lines themselves (` ``` `, `~~~`)
 * are not included — they are markup, not content, and would otherwise
 * surface as literal backticks in the API response and any UI rendering
 * of the term-search summary. This is intentional — the corpus commonly
 * places a definition list or example block directly under a heading
 * with no leading prose.
 *
 * A heading whose first non-heading line **is** a blank line yields an
 * empty summary (the blank line terminates the lead-in immediately).
 */
function collectSectionLead(
  lines: string[],
  start: number,
  end: number,
): string {
  const collected: string[] = [];
  let insideFence = false;
  for (let i = start; i < end; i += 1) {
    const line = lines[i]!;
    if (FENCE_LINE_RE.test(line)) {
      insideFence = !insideFence;
      continue;
    }
    if (!insideFence && line.trim() === "") {
      break;
    }
    collected.push(line);
  }
  const joined = collected.join(" ").trim();
  if (joined.length <= LEADING_PARAGRAPH_MAX_LEN) return joined;
  return joined.slice(0, LEADING_PARAGRAPH_MAX_LEN);
}
