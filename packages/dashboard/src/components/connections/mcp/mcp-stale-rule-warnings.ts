/**
 * B-003 Phase 4 — stale-rule detection.
 *
 * Scan a `rules/mcp.md` body for references to server IDs and classify each
 * reference against the current `mcp_servers` table state the dashboard has
 * already loaded:
 *
 *   - enabled server  → OK, silent.
 *   - disabled server → warning ("rule mentions a server that is disabled").
 *   - unknown ID      → warning ("rule mentions a server that no longer exists").
 *
 * Reference patterns: backtick-quoted tokens `` `id` `` are the high-signal
 * anchor. We also catch hyphenated IDs in prose because hyphens are rare in
 * English and very common in server IDs (`home-assistant`, `task-master`),
 * so `home-assistant` without backticks is almost certainly a reference.
 * Single-word ids without hyphens (`monday`, `notion`) are ONLY flagged when
 * backtick-quoted — otherwise too much prose collides with dictionary words.
 *
 * This is pure frontend logic: no API surface, no DB schema change. The
 * cross-reference happens in-memory against the list already returned by
 * `GET /api/mcp/servers`. If the agent deletes a server mid-edit the user's
 * next server list refresh will re-run this check.
 */

export type McpStaleRuleSeverity = "disabled" | "unknown";

export interface McpStaleRuleWarning {
  /** Raw token matched in the rules text — always matches the server id regex. */
  id: string;
  /** "disabled": id exists in mcp_servers but enabled=0. "unknown": id not found. */
  severity: McpStaleRuleSeverity;
  /** Count of times the token appears in the file. */
  occurrences: number;
}

/** Server-id regex from `packages/daemon/src/services/mcp/types.ts` McpServerIdSchema. */
const SERVER_ID_RE = /[a-z0-9][a-z0-9-]{0,62}/g;
const BACKTICK_RE = /`([^`]+)`/g;

export function scanMcpRulesForStaleReferences(
  rulesBody: string,
  servers: ReadonlyArray<{ id: string; enabled: boolean }>,
): McpStaleRuleWarning[] {
  // Build lookup once.
  const knownEnabled = new Set<string>();
  const knownDisabled = new Set<string>();
  for (const s of servers) {
    if (s.enabled) knownEnabled.add(s.id);
    else knownDisabled.add(s.id);
  }
  const known = (id: string): "enabled" | "disabled" | "unknown" => {
    if (knownEnabled.has(id)) return "enabled";
    if (knownDisabled.has(id)) return "disabled";
    return "unknown";
  };

  const counts = new Map<string, number>();
  const severities = new Map<string, McpStaleRuleSeverity>();

  const record = (token: string) => {
    const kind = known(token);
    if (kind === "enabled") return;
    counts.set(token, (counts.get(token) ?? 0) + 1);
    severities.set(token, kind === "disabled" ? "disabled" : "unknown");
  };

  // Pass 1: all backtick-quoted tokens that look like server IDs.
  for (const [, inside] of rulesBody.matchAll(BACKTICK_RE)) {
    // Multiple tokens inside one code span (rare but possible): walk matches.
    for (const m of inside.matchAll(SERVER_ID_RE)) {
      const token = m[0];
      // Only accept full-span matches so "mcp_server_name" doesn't get sliced
      // into "mcp" + "server" + "name" — wait, underscore isn't in the regex,
      // so actually this is fine. We do require the candidate be the entire
      // backtick contents (modulo leading/trailing whitespace) OR be hyphenated.
      const isWholeSpan = inside.trim() === token;
      const isHyphenated = token.includes("-");
      if (isWholeSpan || isHyphenated) record(token);
    }
  }

  // Pass 2: bare hyphenated tokens outside backticks. A server ID with a
  // hyphen is extremely unlikely to collide with English prose (`home-assistant`,
  // `task-master`), so these are safe to flag even without backticks.
  // Strip code spans first so we don't double-count the Pass 1 hits.
  const stripped = rulesBody.replace(BACKTICK_RE, " ");
  for (const m of stripped.matchAll(SERVER_ID_RE)) {
    const token = m[0];
    if (!token.includes("-")) continue;
    record(token);
  }

  return Array.from(counts.entries())
    .map(([id, occurrences]) => ({
      id,
      severity: severities.get(id)!,
      occurrences,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
