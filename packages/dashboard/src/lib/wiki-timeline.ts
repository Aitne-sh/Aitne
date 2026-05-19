/**
 * Pure parser for the wiki `log.md` operational history file.
 *
 * Each log line is appended by the wiki API (`appendWikiLog` in
 * `packages/daemon/src/api/routes/wiki.ts`) in the shape:
 *
 *     - <ISO-timestamp> <process_key> <operation> <relPath>
 *
 * Example:
 *
 *     - 2026-05-12T18:42:01.123Z wiki.ingest_url post 10_raw/article.md
 *
 * The parser is co-located with the dashboard so the timeline page can
 * render the entries chronologically with a process-key filter. Kept
 * dependency-free and pure so it can be unit-tested without touching
 * the file system.
 */

export interface WikiLogEntry {
  /** ISO 8601 timestamp the daemon wrote. */
  timestamp: string;
  /** Process key (e.g. `wiki.ingest_url`, `wiki.compile`, `wiki.lint`). */
  processKey: string;
  /** Daemon-internal operation token (`post`, `patch`, etc.). */
  operation: string;
  /** Wiki-relative path of the affected file. */
  relPath: string;
  /** 1-indexed line number in the source `log.md`. Useful for keys. */
  lineNumber: number;
}

// Strict shape matcher — anchored so a malformed prefix cannot leak
// into `processKey` or `relPath`. The capture groups index 1:4 give
// timestamp, processKey, operation, relPath.
const LOG_LINE_RE = /^-\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/;

/**
 * Parse the full `log.md` body. Header lines (`# Wiki Log`), blank
 * lines, and any line that does not match the bullet shape are dropped
 * silently — they exist for human readability and have no structured
 * meaning for the timeline UI. We deliberately do not throw on a
 * malformed line: the file is append-only by the daemon and a single
 * corrupt entry should not break the whole timeline render.
 */
export function parseWikiLog(body: string): WikiLogEntry[] {
  if (!body) return [];
  const lines = body.split(/\r?\n/);
  const out: WikiLogEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = LOG_LINE_RE.exec(line);
    if (!match) continue;
    const [, timestamp, processKey, operation, relPath] = match;
    if (!isProbablyIsoTimestamp(timestamp)) continue;
    // The process_key portion must look like `wiki.<word>` or the
    // sentinel `unknown` the daemon falls back to when no process key
    // is supplied. Anything else is almost certainly a non-log
    // bullet (prose mistakenly indented with `- `).
    if (!isLikelyProcessKey(processKey)) continue;
    out.push({
      timestamp,
      processKey,
      operation,
      relPath,
      lineNumber: i + 1,
    });
  }
  return out;
}

/**
 * Sort newest-first. Ties (same millisecond) preserve daemon insertion
 * order, which `lineNumber` records — useful when a parallel `!ingest`
 * batch flushes several entries inside a single I/O slice.
 */
export function sortWikiLogEntries(entries: WikiLogEntry[]): WikiLogEntry[] {
  return [...entries].sort((a, b) => {
    if (a.timestamp === b.timestamp) return b.lineNumber - a.lineNumber;
    return a.timestamp < b.timestamp ? 1 : -1;
  });
}

/**
 * Distinct process keys present in the log, sorted alphabetically.
 * Used to populate the filter dropdown so the operator only sees keys
 * that actually appear in their own log.
 */
export function distinctProcessKeys(entries: readonly WikiLogEntry[]): string[] {
  const set = new Set<string>();
  for (const entry of entries) set.add(entry.processKey);
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/**
 * Apply the process-key filter. `"all"` (or `null`/`undefined`) returns
 * every entry; any other value selects the matching subset.
 */
export function filterByProcessKey(
  entries: readonly WikiLogEntry[],
  filter: string | null | undefined,
): WikiLogEntry[] {
  if (!filter || filter === "all") return [...entries];
  return entries.filter((e) => e.processKey === filter);
}

function isProbablyIsoTimestamp(value: string): boolean {
  // Match the canonical ISO 8601 prefix Node emits via Date.toISOString().
  // Year + month + day + 'T' + time + (optional fraction) + Z. We accept
  // the trailing offset variants `+HH:MM` / `-HH:MM` too in case a future
  // daemon switches to non-UTC.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
}

function isLikelyProcessKey(value: string): boolean {
  if (value === "unknown") return true;
  return /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(value);
}

// ── Health report parsing ─────────────────────────────────────────────

export interface WikiHealthReport {
  /** Date from the filename (`90_meta/health/<date>.md`). */
  date: string;
  /** Wiki-relative path of the report file. */
  path: string;
  /** Summary section bullets (rendered above the action items). */
  summary: string[];
  /** Action item bullets. */
  actionItems: string[];
  /** Raw report body, for the "View full report" expansion. */
  rawBody: string;
}

const HEALTH_PATH_RE = /^90_meta\/health\/(\d{4}-\d{2}-\d{2})\.md$/;

/** Returns the most-recent health report path from a wiki index list. */
export function findLatestHealthReportPath(
  files: readonly { path: string }[],
): string | null {
  const matches = files
    .map((f) => f.path)
    .filter((p) => HEALTH_PATH_RE.test(p))
    .sort((a, b) => (a < b ? 1 : -1));
  return matches[0] ?? null;
}

/**
 * Parse a `90_meta/health/<date>.md` body. The wiki-lint skill produces
 * a deterministic section ordering documented in the SKILL.md; the
 * parser extracts the two sections the dashboard renders prominently
 * (`## Summary` and `## Action items`) and preserves the full body for
 * an expand-on-click view.
 */
export function parseWikiHealthReport(
  path: string,
  body: string,
): WikiHealthReport | null {
  const dateMatch = HEALTH_PATH_RE.exec(path);
  if (!dateMatch) return null;
  return {
    date: dateMatch[1],
    path,
    summary: extractSection(body, "Summary"),
    actionItems: extractSection(body, "Action items"),
    rawBody: body,
  };
}

function extractSection(body: string, heading: string): string[] {
  const lines = body.split(/\r?\n/);
  const headingRe = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "i");
  let inSection = false;
  const out: string[] = [];
  for (const line of lines) {
    if (headingRe.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line)) break;
    if (!inSection) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "_(none)_") continue;
    const bulletMatch = /^[-*]\s+(.+)$/.exec(trimmed);
    if (bulletMatch) {
      out.push(bulletMatch[1].trim());
    } else if (out.length > 0) {
      // Continuation line for the previous bullet (rare). Append with a
      // space so multi-line bullet wraps render naturally.
      out[out.length - 1] += ` ${trimmed}`;
    }
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
