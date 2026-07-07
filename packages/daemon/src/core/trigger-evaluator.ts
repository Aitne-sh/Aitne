/**
 * Trigger evaluator — see `docs/design/appendices/unified-repositories.md` §4.4.
 *
 * Pure module. Inputs:
 *   - a `RepositoryTriggerDTO[]` for a given `(repository_id, event_type)`,
 *     filtered by the caller via `listEnabledTriggersForEvent`.
 *   - the polled-event payload as a generic `Record<string, unknown>`.
 *
 * Output: the subset of triggers whose `filters_json` matches the payload.
 *
 * Filter language (v1):
 *   - flat key/value equality against scalar event-payload fields
 *     (`{"branch":"main"}`, `{"action":"opened"}`, …)
 *   - `path_pattern` — special key whose value is a glob string OR
 *     `string[]`. The minimatch-subset glob supports `**`, `*`, `?`,
 *     `[abc]`, `{a,b}`. The matcher walks the path list extracted by an
 *     event-type-specific extractor (see `EVENT_PATH_EXTRACTORS`).
 *   - All filter keys AND together. Within `path_pattern[]`, OR.
 *
 * The actual dispatch to a backend session lives in the route handler
 * (POST /api/repositories/:id/run); this module decides which triggers
 * fire — nothing else.
 */

import type { RepositoryTriggerDTO } from "../db/repositories-store.js";

// ── Path globbing (minimatch subset) ──────────────────────────────────

/**
 * Compile a single glob pattern into a RegExp. Supports:
 *   - `**` — any number of path segments (incl. zero)
 *   - `*`  — any chars except `/`
 *   - `?`  — single char except `/`
 *   - `[abc]` / `[!abc]` — character class
 *   - `{a,b}` — alternation
 *
 * Patterns are matched against the full path string (no implicit
 * prefix); a leading `**` is required to match arbitrary depth from
 * root.
 */
export function compileGlob(pattern: string): RegExp {
  let i = 0;
  const out: string[] = ["^"];
  let braceDepth = 0;

  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      // Detect `**`.
      if (pattern[i + 1] === "*") {
        // `**/` consumes the slash too so `**/foo` matches both
        // `foo` and `bar/foo`.
        if (pattern[i + 2] === "/") {
          out.push("(?:.*/)?");
          i += 3;
          continue;
        }
        out.push(".*");
        i += 2;
        continue;
      }
      out.push("[^/]*");
      i += 1;
      continue;
    }
    if (ch === "?") {
      out.push("[^/]");
      i += 1;
      continue;
    }
    if (ch === "[") {
      // Character class. Find closing `]`.
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) {
        // Unmatched `[` → literal.
        out.push("\\[");
        i += 1;
        continue;
      }
      let body = pattern.slice(i + 1, end);
      const negate = body.startsWith("!") || body.startsWith("^");
      if (negate) body = body.slice(1);
      out.push(`[${negate ? "^" : ""}${body}]`);
      i = end + 1;
      continue;
    }
    if (ch === "{") {
      braceDepth++;
      out.push("(?:");
      i += 1;
      continue;
    }
    if (ch === "}") {
      if (braceDepth > 0) {
        braceDepth--;
        out.push(")");
        i += 1;
        continue;
      }
      out.push("\\}");
      i += 1;
      continue;
    }
    if (ch === "," && braceDepth > 0) {
      out.push("|");
      i += 1;
      continue;
    }
    // Escape regex metacharacters.
    if (/[.+^$()|\\]/.test(ch)) {
      out.push("\\" + ch);
      i += 1;
      continue;
    }
    out.push(ch);
    i += 1;
  }
  // Close any unterminated braces by treating them as literal.
  while (braceDepth > 0) {
    out.push(")");
    braceDepth--;
  }
  out.push("$");
  return new RegExp(out.join(""));
}

export function matchGlob(pattern: string, path: string): boolean {
  return compileGlob(pattern).test(path);
}

export function matchAnyGlob(
  patterns: string | string[],
  paths: readonly string[],
): boolean {
  const patternList = Array.isArray(patterns) ? patterns : [patterns];
  for (const pattern of patternList) {
    const re = compileGlob(pattern);
    for (const path of paths) {
      if (re.test(path)) return true;
    }
  }
  return false;
}

// ── Path extraction by event type ────────────────────────────────────

/**
 * Extracts the file-path list for an event payload. Returns null when
 * the event type carries no file list (e.g. `github.workflow_run.failed`,
 * `github.security_alert`); a `path_pattern` filter on that event type
 * never matches and the trigger does not fire.
 */
export type EventPathExtractor = (
  payload: Record<string, unknown>,
) => readonly string[] | null;

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function extractFromCommits(payload: Record<string, unknown>): string[] {
  const commits = Array.isArray(payload.commits)
    ? (payload.commits as Array<Record<string, unknown>>)
    : [];
  const set = new Set<string>();
  for (const commit of commits) {
    for (const file of asStringArray(commit.added)) set.add(file);
    for (const file of asStringArray(commit.modified)) set.add(file);
    for (const file of asStringArray(commit.removed)) set.add(file);
  }
  // Some classifiers / observers also stash the union under
  // `changedFiles` — fall back to that when no per-commit detail.
  if (set.size === 0) {
    for (const file of asStringArray(payload.changedFiles)) set.add(file);
  }
  return [...set];
}

function extractFromMergeCommit(
  payload: Record<string, unknown>,
): string[] {
  // Merge events from git-watcher record the merged commit's file list
  // under either `files` or `changedFiles` depending on classifier
  // version. Tolerate both.
  const files = asStringArray(payload.files);
  if (files.length > 0) return files;
  return asStringArray(payload.changedFiles);
}

function extractFromPullRequest(
  payload: Record<string, unknown>,
): string[] | null {
  // Webhook-emitted PR events sometimes include a `files` array
  // synthesized by the poller; absent that, the trigger evaluator
  // returns null and the path_pattern filter is skipped (trigger
  // does not fire). Up to the route handler to enrich payloads
  // with PR file lists when the user wires path-pattern filters
  // on PR events.
  const files = asStringArray(payload.files);
  return files.length > 0 ? files : null;
}

export const EVENT_PATH_EXTRACTORS: Readonly<
  Record<string, EventPathExtractor>
> = {
  "git.push.detected": extractFromCommits,
  "git.push.force_pushed": extractFromCommits,
  "git.merge_to_default": extractFromMergeCommit,
  "github.pull_request.opened": extractFromPullRequest,
  "github.pull_request.synchronize": extractFromPullRequest,
  "github.pull_request.review_requested": extractFromPullRequest,
  "github.pull_request.closed": extractFromPullRequest,
};

// ── Match logic ──────────────────────────────────────────────────────

function readScalar(payload: Record<string, unknown>, key: string): unknown {
  // Top-level shorthand. Triggers cannot reach into nested objects in
  // v1; a richer DSL grows into a task-flow override.
  return payload[key];
}

function scalarEquals(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === "number" && typeof b === "number") return a === b;
  return String(a) === String(b);
}

/**
 * Decide whether a single trigger's filters match the given event
 * payload.
 */
export function matchesFilters(
  filters: Record<string, unknown>,
  eventType: string,
  payload: Record<string, unknown>,
): boolean {
  for (const [key, expected] of Object.entries(filters)) {
    if (key === "path_pattern") {
      const extractor = EVENT_PATH_EXTRACTORS[eventType];
      if (!extractor) return false;
      const paths = extractor(payload);
      if (!paths) return false;
      if (paths.length === 0) return false;
      const patterns = expected as string | string[];
      if (!matchAnyGlob(patterns, paths)) return false;
      continue;
    }
    const actual = readScalar(payload, key);
    if (!scalarEquals(actual, expected)) return false;
  }
  return true;
}

/**
 * Filter `triggers` to those whose filters match the event. Triggers
 * are returned in the input order (caller controls the order via
 * `listEnabledTriggersForEvent`'s `ORDER BY created_at`).
 */
export function evaluateTriggers(
  triggers: readonly RepositoryTriggerDTO[],
  eventType: string,
  payload: Record<string, unknown>,
): RepositoryTriggerDTO[] {
  return triggers.filter((trigger) => {
    if (!trigger.enabled) return false;
    if (trigger.eventType !== eventType) return false;
    // Per-trigger isolation: `validateTriggerFilters` compile-checks
    // path_pattern globs at write time, but rows created before that
    // gate (or edited out-of-band) can still carry a pattern whose
    // compiled RegExp throws. Treat a throwing matcher as "no match"
    // so one bad trigger cannot abort evaluation for its siblings or
    // 500 the /triggers/:id/test endpoint.
    try {
      return matchesFilters(trigger.filters, eventType, payload);
    } catch {
      return false;
    }
  });
}
