/**
 * `parseHandoff` — extract the `## Handoff` section's
 * `### Tomorrow` and `### Later` H3 sub-blocks from a `yesterday.md`
 * body string and return them as structured arrays.
 *
 * Spec: `docs/design/appendices/morning-routine-optimization.md`
 * §"Daemon-side modules to add" → handoff-parser (②). The orchestrator
 * reads yesterday.md and injects the parsed JSON as `<handoff_parsed>`
 * so Stage A can skip the prose parse step.
 *
 * Fail-soft contract: any structural anomaly (no `## Handoff` section,
 * input null/empty, unrecoverable parse error) returns `null` rather
 * than throwing. The orchestrator's fallback path is to omit the
 * `<handoff_parsed>` block — Stage A then reads `<yesterday>` raw and
 * pays one extra turn. This eliminates the silent-failure mode while
 * keeping the parser's surface minimal.
 *
 * Expected source structure (written by the previous day's evening
 * flow, mirrored in `agent-assets/task-flows/routine.morning_routine.md`
 * Step 6's ## Handoff initializer):
 *
 *     ## Handoff
 *     ### Tomorrow
 *     - item one
 *     - item two
 *     ### Later
 *     - (none)
 *
 * Semantics:
 *   - The `- (none)` placeholder (case-insensitive on "none") is
 *     dropped — an empty sub-section yields an empty array, not a
 *     `"(none)"` literal.
 *   - Non-bullet lines inside a sub-section body are silently skipped
 *     (the evening flow does not write any, but a stray operator edit
 *     should not crash the parser).
 *   - Sub-sections may appear in either order, or only one may be
 *     present; the parser returns whatever it found.
 */

const HANDOFF_HEADER = "## Handoff";
const TOMORROW_HEADER = "### Tomorrow";
const LATER_HEADER = "### Later";

const BULLET_RE = /^- (.*)$/;
const NONE_PLACEHOLDER_RE = /^\(?none\)?$/i;

export interface HandoffParsed {
  tomorrow: string[];
  later: string[];
}

export function parseHandoff(yesterdayMd: string | null): HandoffParsed | null {
  if (yesterdayMd === null || yesterdayMd.length === 0) return null;
  // Defensive guard around parseInner: its helpers (string split / regex
  // / findIndex) never throw on string input, but the catch upholds the
  // fail-soft contract if a future edit adds a throwing helper. The
  // catch arm and its return are intentionally unreachable from the
  // current code, so c8 skips them.
  /* c8 ignore start */
  try {
    return parseInner(yesterdayMd);
  } catch {
    return null;
  }
  /* c8 ignore stop */
}

function parseInner(body: string): HandoffParsed | null {
  // Accept both LF and CRLF — node:fs preserves `\r` on files authored on
  // Windows / mixed-line-ending operator edits, and the strict `===`
  // header match below would otherwise see `## Handoff\r` and bail.
  // Fail-soft still applies for malformed Handoff bodies; this just
  // closes the easy line-ending miss.
  const lines = body.split(/\r?\n/);
  const handoffStart = findHeaderLine(lines, HANDOFF_HEADER);
  if (handoffStart < 0) return null;
  const handoffEnd = findNextH2Boundary(lines, handoffStart + 1);

  const tomorrow = collectBulletsForSubsection(
    lines,
    handoffStart + 1,
    handoffEnd,
    TOMORROW_HEADER,
  );
  const later = collectBulletsForSubsection(
    lines,
    handoffStart + 1,
    handoffEnd,
    LATER_HEADER,
  );
  return { tomorrow, later };
}

function findHeaderLine(lines: string[], header: string): number {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === header) return i;
  }
  return -1;
}

function findNextH2Boundary(lines: string[], from: number): number {
  for (let i = from; i < lines.length; i++) {
    if (lines[i].startsWith("## ") && !lines[i].startsWith("### ")) {
      return i;
    }
  }
  return lines.length;
}

function collectBulletsForSubsection(
  lines: string[],
  sectionStart: number,
  sectionEnd: number,
  subHeader: string,
): string[] {
  const out: string[] = [];
  let inside = false;
  for (let i = sectionStart; i < sectionEnd; i++) {
    const line = lines[i];
    if (line === subHeader) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (line.startsWith("### ") || line.startsWith("## ")) break;
    const bulletMatch = BULLET_RE.exec(line);
    if (!bulletMatch) continue;
    const item = bulletMatch[1].trim();
    if (item.length === 0) continue;
    if (NONE_PLACEHOLDER_RE.test(item)) continue;
    out.push(item);
  }
  return out;
}
