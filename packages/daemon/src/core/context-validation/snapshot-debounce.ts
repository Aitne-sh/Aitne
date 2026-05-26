/**
 * Pure helpers for context-file write debouncing and bullet-entry retention.
 *
 * `SNAPSHOT_DEBOUNCE_MS` is the floor the route handler enforces between
 * snapshot rows persisted to `md_file_snapshots`. Without it a busy section
 * (e.g. `journal/agent` Raw Signals) would write a new row per append.
 *
 * The trim/clear helpers run during PATCH against bullet-list sections
 * that grow unbounded — `journal/agent` Raw Signals (timestamp-clear) and
 * any section with a `maxEntries` cap (FIFO trim). They preserve
 * continuation lines (indented) and inter-entry blank lines, leaving
 * non-bullet decoration (headings, prose) untouched.
 */

/**
 * Minimum elapsed milliseconds between two snapshot rows for the same
 * file. 5 minutes — picked so a chatty section (`journal/agent`) does
 * not write a snapshot per append, while still capturing the dominant
 * state of the file every ~5 min for forensics.
 *
 * The route handler accepts a `force` flag for non-routine triggers
 * (e.g. archive-today, restore-snapshot) that must bypass the floor.
 */
export const SNAPSHOT_DEBOUNCE_MS = 5 * 60 * 1000;

/**
 * Bullet entries are expected to lead with `- [YYYY-MM-DD HH:MM:SS]`,
 * the canonical timestamp the agent emits when appending to a Log /
 * Raw Signals style section.
 */
const ENTRY_TIMESTAMP_RE = /^- \[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/;

/**
 * Parse a timestamp from a bullet entry like `- [2026-04-10 02:32:59] …`.
 * Returns the timestamp string or null if the line doesn't match
 * (plain bullets, blank lines, headers all return null).
 */
export function parseEntryTimestamp(line: string): string | null {
  const match = ENTRY_TIMESTAMP_RE.exec(line);
  return match ? match[1] : null;
}

/**
 * Remove entries whose `- [YYYY-MM-DD HH:MM:SS]` timestamp is ≤ cutoff.
 * Non-matching lines (blank lines, continuation lines, prose) are
 * preserved except for the trailing continuation/blank lines that
 * immediately follow a removed entry — those are dropped so the
 * section does not accumulate orphaned whitespace.
 */
export function clearEntriesBefore(
  sectionBody: string,
  cutoff: string,
): { remaining: string; removedCount: number } {
  const lines = sectionBody.split("\n");
  const kept: string[] = [];
  let removedCount = 0;
  let skipContinuation = false;

  for (const line of lines) {
    const ts = parseEntryTimestamp(line);
    if (ts !== null) {
      // This is a timestamped entry
      if (ts <= cutoff) {
        removedCount++;
        skipContinuation = true;
        continue;
      }
      skipContinuation = false;
      kept.push(line);
    } else if (skipContinuation && (line.startsWith("  ") || line.trim() === "")) {
      // Continuation or trailing blank line of a removed entry
      continue;
    } else {
      skipContinuation = false;
      kept.push(line);
    }
  }

  return { remaining: kept.join("\n"), removedCount };
}

/**
 * Trim oldest bullet entries (`- ` lines) from the top of a section
 * body to keep at most `maxEntries` entries. Continuation lines
 * (2-space indent) and inter-entry blank lines that belong to a removed
 * entry are dropped along with it; non-bullet decorations elsewhere
 * are preserved verbatim.
 */
export function trimBulletEntries(
  body: string,
  maxEntries: number,
): { body: string; trimmed: number } {
  const lines = body.split("\n");

  // Collect indices of bullet entry start lines
  const bulletIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("- ")) {
      bulletIndices.push(i);
    }
  }

  const excess = bulletIndices.length - maxEntries;
  if (excess <= 0) {
    return { body, trimmed: 0 };
  }

  // Remove the oldest (topmost) `excess` entries and their continuations.
  // Also remove blank lines between consecutive removed entries to avoid
  // orphaned whitespace accumulating over many trim cycles.
  const removeSet = new Set<number>();
  for (let i = 0; i < excess; i++) {
    const start = bulletIndices[i];
    const end = i + 1 < bulletIndices.length ? bulletIndices[i + 1] : lines.length;
    for (let j = start; j < end; j++) {
      if (j === start || lines[j].startsWith("  ") || lines[j].trim() === "") {
        removeSet.add(j);
      }
    }
  }

  const kept = lines.filter((_, i) => !removeSet.has(i));
  return { body: kept.join("\n"), trimmed: excess };
}
