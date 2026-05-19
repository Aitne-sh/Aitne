import type Database from "better-sqlite3";

/**
 * Citation post-processor (DOCS_QA_DESIGN.md §9.6).
 *
 * The QA model is prompted to embed `[doc:slug#anchor]` tokens for every
 * claim it makes. The renderer turns those into clickable pills, which
 * means hallucinated citations would be silently rendered as broken
 * links if no validation took place.
 *
 * This module is the validation layer. It is invoked twice in the daemon:
 *
 *   1. **Streaming (`createStreamingValidator`)** — wraps the SSE token
 *      stream so each text delta passes through `feed()`, which buffers
 *      only across the byte range of an in-progress `[doc:` token and
 *      flushes everything else immediately. The output is the validated
 *      stream the dashboard sees.
 *
 *   2. **Final pass (`validateAndRewrite`)** — applied to the full
 *      assembled reply text before persisting to `messages.content`, so
 *      what is stored matches what the dashboard rendered.
 *
 * Validation outcomes (per §9.6 table):
 *   - slug + anchor both valid → forward unchanged
 *   - slug valid, anchor missing → rewrite to `[doc:slug]`, tag pill
 *     `anchor-not-found` for dashboard rendering
 *   - slug invalid → strip the token entirely + log to `agent_actions`
 */

import { parseCitationTokens } from "@aitne/shared";
import { createLogger } from "../../logging.js";

const logger = createLogger("citation-validator");

export interface DocsCitationLookup {
  /** Returns the indexed anchors for `slug`, or `null` if the slug is unknown. */
  anchorsForSlug(slug: string): string[] | null;
}

/**
 * Lookup-by-DB factory. `fts_docs.anchors` stores anchors as a
 * newline-joined string (the indexer flattens the array on insert), so
 * we split on `\n` and trim. Returns `null` when no row matches the slug.
 */
export function makeDbLookup(db: Database.Database): DocsCitationLookup {
  return {
    anchorsForSlug(slug: string): string[] | null {
      const row = db
        .prepare("SELECT anchors FROM fts_docs WHERE slug = ?")
        .get(slug) as { anchors: string | null } | undefined;
      if (!row) return null;
      return (row.anchors ?? "")
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    },
  };
}

export interface ValidationResult {
  /** Output text with invalid citations rewritten / stripped. */
  text: string;
  /** Number of citations that survived intact. */
  validCount: number;
  /** Citations whose anchor was unknown (still rendered, slug-only). */
  anchorMissing: { slug: string; anchor: string }[];
  /** Citations whose slug was unknown (stripped from output). */
  slugMissing: { slug: string; anchor: string | null }[];
}

/**
 * One-shot validator for already-assembled reply text. Returns the
 * rewritten text plus per-category counts so callers can attach a
 * `qa_invalid_citation` row to `agent_actions` when slug-missing
 * tokens are present.
 */
export function validateAndRewrite(
  text: string,
  lookup: DocsCitationLookup,
): ValidationResult {
  const tokens = parseCitationTokens(text);
  if (tokens.length === 0) {
    return { text, validCount: 0, anchorMissing: [], slugMissing: [] };
  }

  // Walk tokens in order, slicing the input around them.
  const out: string[] = [];
  const anchorMissing: { slug: string; anchor: string }[] = [];
  const slugMissing: { slug: string; anchor: string | null }[] = [];
  let validCount = 0;
  let cursor = 0;

  for (const tok of tokens) {
    out.push(text.slice(cursor, tok.start));
    cursor = tok.end;

    const anchors = lookup.anchorsForSlug(tok.slug);
    if (anchors === null) {
      // Unknown slug — strip entirely.
      slugMissing.push({ slug: tok.slug, anchor: tok.anchor });
      continue;
    }
    if (tok.anchor === null || anchors.includes(tok.anchor)) {
      out.push(tok.raw);
      validCount += 1;
      continue;
    }
    // Slug exists but anchor is unknown — rewrite to slug-only.
    out.push(`[doc:${tok.slug}]`);
    anchorMissing.push({ slug: tok.slug, anchor: tok.anchor });
  }

  out.push(text.slice(cursor));
  return { text: out.join(""), validCount, anchorMissing, slugMissing };
}

/**
 * Streaming validator. Emits validated text deltas as the upstream stream
 * pushes raw deltas through `feed()`. The buffer holds only across the
 * byte range of an in-progress `[doc:` token — every non-token byte is
 * forwarded immediately so latency overhead is negligible.
 *
 * Invariants:
 *   - `feed(delta)` returns the validated suffix that is safe to flush
 *     downstream; bytes that belong to a partial token are retained in
 *     the buffer and emitted once the token closes (or the buffer length
 *     exceeds `MAX_TOKEN_LEN`, in which case it is treated as not a
 *     citation and forwarded raw).
 *   - `flush()` drains the buffer at end-of-stream; any unterminated
 *     `[doc:` content is forwarded raw because it cannot be a valid
 *     citation by definition.
 *   - The validator MUST NOT cross-call `feed()` and `flush()` in
 *     parallel; the underlying parser uses a moving cursor.
 */
export interface StreamingValidator {
  feed(delta: string): string;
  flush(): string;
  /** Aggregate results so far — useful for emitting a final summary
   *  event over SSE and persisting the rewritten message in one shot. */
  snapshot(): { validCount: number; anchorMissing: number; slugMissing: number };
}

const TOKEN_OPEN = "[doc:";
const MAX_TOKEN_LEN = 256; // beyond this, treat as not a citation and forward

/**
 * Returns the length of the longest TOKEN_OPEN prefix that ends `buffer`.
 * E.g. for `"...x[do"` returns 3 (matching the `[do` prefix); for
 * `"hello"` returns 0. Used by `feed()` to retain tail bytes that might
 * complete a `[doc:` opener in the next delta.
 */
function countTokenOpenPrefix(buffer: string): number {
  for (let len = TOKEN_OPEN.length - 1; len > 0; len -= 1) {
    if (buffer.endsWith(TOKEN_OPEN.slice(0, len))) return len;
  }
  return 0;
}

export function createStreamingValidator(
  lookup: DocsCitationLookup,
): StreamingValidator {
  let buffer = "";
  let validCount = 0;
  let anchorMissing = 0;
  let slugMissing = 0;

  function processChunk(chunk: string): string {
    if (chunk.length === 0) return "";
    const result = validateAndRewrite(chunk, lookup);
    validCount += result.validCount;
    anchorMissing += result.anchorMissing.length;
    slugMissing += result.slugMissing.length;
    return result.text;
  }

  function feed(delta: string): string {
    buffer += delta;
    let safeUpTo = 0;
    let i = 0;
    let runaway = false;
    while (i < buffer.length) {
      const openIdx = buffer.indexOf(TOKEN_OPEN, i);
      if (openIdx === -1) {
        // No complete `[doc:` open at or after `i`. But the tail of
        // `buffer` may contain a *prefix* of `[doc:` (e.g. "[", "[d",
        // "[do", "[doc") that completes in the next delta — flushing
        // those bytes as plaintext now would lose the citation when
        // the closing `]` arrives. Retain only the smallest suffix
        // that matches a TOKEN_OPEN prefix; flush the rest.
        const retain = countTokenOpenPrefix(buffer);
        safeUpTo = Math.max(safeUpTo, buffer.length - retain);
        break;
      }
      // Up to `openIdx` is unambiguously safe to flush.
      safeUpTo = openIdx;
      const closeIdx = buffer.indexOf("]", openIdx);
      if (closeIdx === -1) {
        if (buffer.length - openIdx > MAX_TOKEN_LEN) {
          // Runaway — forward as-is; this is not a citation.
          safeUpTo = buffer.length;
          runaway = true;
          break;
        }
        // Token is still in flight — wait for more data.
        break;
      }
      // Token spans [openIdx, closeIdx]; everything up to closeIdx+1 is
      // safe once we process this chunk. Loop continues to look for more
      // tokens after this one.
      safeUpTo = closeIdx + 1;
      i = closeIdx + 1;
    }
    void runaway;
    const safeChunk = buffer.slice(0, safeUpTo);
    buffer = buffer.slice(safeUpTo);
    return processChunk(safeChunk);
  }

  function flush(): string {
    // End-of-stream — anything left in the buffer cannot be a valid
    // citation (no closing `]`). Forward as-is.
    const tail = buffer;
    buffer = "";
    return processChunk(tail);
  }

  function snapshot() {
    return { validCount, anchorMissing, slugMissing };
  }

  return { feed, flush, snapshot };
}

/**
 * Persist `qa_invalid_citation` audit rows. Pure-function form so
 * callers can decide *when* to flush (per turn, per session, etc.).
 */
export function logInvalidCitations(
  db: Database.Database,
  result: Pick<ValidationResult, "anchorMissing" | "slugMissing">,
  context: { sessionId?: number | null; turnNumber?: number | null } = {},
): void {
  if (result.anchorMissing.length === 0 && result.slugMissing.length === 0) {
    return;
  }
  try {
    db.prepare(
      `INSERT INTO agent_actions (action_type, detail)
       VALUES (?, ?)`,
    ).run(
      "qa_invalid_citation",
      JSON.stringify({
        sessionId: context.sessionId ?? null,
        turnNumber: context.turnNumber ?? null,
        anchorMissing: result.anchorMissing,
        slugMissing: result.slugMissing,
      }),
    );
  } catch (err) {
    // Audit logging is best-effort. The agent_actions schema may evolve
    // (additional NOT NULL columns); a write failure must not break the
    // QA reply path.
    logger.debug({ err }, "Failed to log qa_invalid_citation audit row");
  }
}
