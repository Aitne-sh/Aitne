/**
 * Pure helpers for locating `## Section` blocks in context-file markdown.
 *
 * Used by `/api/context` PATCH handlers and by `journal/agent` trim/clear
 * logic. No I/O, no Hono — keep these importable from any layer.
 *
 * Section names are normalized case- and whitespace-insensitively so that
 * the agent's freeform `## Raw signals` matches the literal `## Raw Signals`
 * in the file. See `docs/design/06-memory.md` for the section vocabulary.
 */

/**
 * Normalize a section name for matching:
 * lowercase, spaces → underscores, strip leading `## `.
 */
export function normalizeSection(name: string): string {
  return name
    .replace(/^#+\s*/, "")
    .toLowerCase()
    .replace(/\s+/g, "_");
}

/**
 * Find a section in markdown content and return its boundaries.
 * Returns `{ start, end, headerEnd }` where the section body sits between
 * this `## ` header and the next `## ` header (or EOF). `start` and
 * `headerEnd` both point at the first character after the `## …\n` line;
 * they exist as separate fields so callers can distinguish "where the body
 * starts" from "where to anchor inserts".
 */
export function findSection(
  content: string,
  sectionName: string,
): { start: number; end: number; headerEnd: number } | null {
  const normalized = normalizeSection(sectionName);
  const lines = content.split("\n");
  let sectionStart = -1;
  let headerEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      const lineNormalized = normalizeSection(lines[i]);
      if (lineNormalized === normalized) {
        sectionStart = i;
        const lineStart = sumLength(lines, i);
        const nlPos = content.indexOf("\n", lineStart);
        // Handle file ending without trailing newline
        headerEnd = nlPos === -1 ? content.length : nlPos + 1;
        break;
      }
    }
  }

  if (sectionStart === -1) return null;

  // Find end: next ## header or EOF
  let sectionEnd = content.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      sectionEnd = sumLength(lines, i);
      break;
    }
  }

  return { start: headerEnd, end: sectionEnd, headerEnd };
}

/**
 * Sum the byte length (including line terminators) of the first
 * `upToIndex` lines. Used to convert a (lines, lineIndex) position back
 * into an offset into the original string after `split("\n")`.
 */
export function sumLength(lines: string[], upToIndex: number): number {
  let len = 0;
  for (let i = 0; i < upToIndex; i++) {
    len += lines[i].length + 1; // +1 for \n
  }
  return len;
}

/**
 * Enumerate every `## ` section header in the file in document order,
 * returning their normalized names. Used to surface "did you mean X?"
 * style hints when a PATCH targets a section that does not exist.
 */
export function getAvailableSections(content: string): string[] {
  return content
    .split("\n")
    .filter((l) => l.startsWith("## "))
    .map((l) => normalizeSection(l));
}
