/**
 * FTS5 query-string sanitization helpers.
 *
 * SQLite FTS5 MATCH accepts a small DSL with operators (`AND`, `OR`, `NOT`,
 * `NEAR/N`), column filters (`column:term`), wildcards (`prefix*`), and
 * quoted phrases (`"exact phrase"`). Punctuation like `"` and `:` carries
 * meaning; unsanitized user input either changes the search semantics
 * unintentionally (`OR` between unrelated terms) or trips
 * `SQLITE_ERROR: fts5: syntax error` and surfaces a 5xx.
 *
 * The chokepoint is `buildMatchExpression`: it tokenizes the user query on
 * whitespace, doubles any internal `"`, and wraps each token in double
 * quotes so the FTS5 parser sees a sequence of literal phrases AND-joined
 * (the implicit operator). Operator keywords (`OR`, `NEAR`) get the same
 * treatment as any other token — when wrapped in `"..."` they are phrase
 * tokens, not operators.
 *
 * Used by the multi-mail provider local search (`mail-search.ts`) and the
 * `/api/docs/search` endpoint. Any future FTS5 surface that takes a raw
 * user query MUST route through here.
 */

/**
 * Quote every whitespace-separated token as an FTS5 phrase so arbitrary
 * user input does not trip the operator grammar. Returns `null` when the
 * query has no tokens; callers should short-circuit to an empty result
 * (matches "nothing").
 */
export function buildMatchExpression(query: string): string | null {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

/**
 * Returns true when every code point in `q` is in the printable ASCII
 * range. Used by `/api/docs/search` (DOCS-QA-SEARCH-PRECISION-PLAN.md §7)
 * to dispatch ASCII-only queries to the `unicode61` word index and CJK /
 * mixed queries to the trigram substring index. Whitespace counts as
 * ASCII, so a Latin-only query with leading/trailing spaces still routes
 * to the word index. Empty input is ASCII-only by vacuous truth (the
 * caller separately short-circuits an empty query through
 * `buildMatchExpression`'s null return).
 */
export function isAsciiOnlyQuery(q: string): boolean {
  for (let i = 0; i < q.length; i += 1) {
    if (q.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}
