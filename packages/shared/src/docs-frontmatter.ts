/**
 * Minimal YAML frontmatter parser scoped to the docs corpus shape
 * (DOCS_QA_DESIGN.md §7).
 *
 * Lives in `packages/shared` so the daemon (indexer) and the dashboard
 * (page-doc-map drift guard) can both validate fixture frontmatter
 * against the canonical Zod schema without two parsers drifting.
 *
 * Why hand-rolled. The codebase already carries two hand-rolled
 * frontmatter readers (`context-frontmatter.ts`, `custom-routine-scheduler.ts`)
 * but they are flat-scalar-only. Docs frontmatter needs arrays
 * (`aliases:`, `tags:`, `related:`, ...) and a block-scalar `summary:`.
 * Pulling in a full YAML library for this tightly-bounded use case is
 * unnecessary; the tighter parser here
 * fails loudly on shapes we don't expect (nested mappings, flow-style
 * arrays) so authors stay inside the supported subset.
 *
 * Supported shapes:
 *   - `key: scalar` (string, possibly quoted with `"` or `'`)
 *   - `key: [number]` parsed as number when the value is bare-numeric
 *   - `key: true` / `key: false` parsed as boolean
 *   - `key:\n  - item\n  - item` parsed as `string[]` (or empty array
 *     when followed by another key with no `-` lines in between)
 *   - `key: |` (or `key: |-`) followed by indented block, joined with
 *     `\n`. Trailing newline is dropped for `|-` and preserved for `|`.
 *   - `key: {}` parsed as `Record<string, never>` (used by `extra:`)
 *   - `# comment` and inline trailing `# comment` stripped
 *
 * Unsupported (rejected): nested mappings, flow-style arrays/objects
 * other than `{}`, anchor / alias references.
 *
 * Validation against the Zod schema is the caller's job — this parser
 * just produces a `Record<string, unknown>`.
 */

export interface ParsedFrontmatter {
  /** Parsed YAML mapping. */
  values: Record<string, unknown>;
  /** Body content after the closing `---`. */
  body: string;
}

export class FrontmatterParseError extends Error {
  constructor(
    public readonly line: number,
    public readonly raw: string,
    reason: string,
  ) {
    super(`Frontmatter parse error at line ${line}: ${reason} (${JSON.stringify(raw)})`);
    this.name = "FrontmatterParseError";
  }
}

/**
 * Split a Markdown source into `{ frontmatter, body }`. Returns `null`
 * when the file does not start with `---` (no frontmatter).
 */
export function parseFrontmatter(source: string): ParsedFrontmatter | null {
  const lines = source.split(/\r?\n/);
  // `split` always returns at least one element, so `lines[0]` is defined.
  if (lines[0]!.trim() !== "---") return null;
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (closeIdx < 0) {
    throw new FrontmatterParseError(1, "---", "missing closing '---'");
  }
  const fmLines = lines.slice(1, closeIdx);
  const body = lines.slice(closeIdx + 1).join("\n");
  const values = parseMapping(fmLines, /*lineOffset*/ 1);
  return { values, body };
}

function stripInlineComment(value: string): string {
  // Inline comments only count when preceded by whitespace; `#` inside a
  // quoted scalar is literal. Treat unquoted values: the first ` #`
  // sequence ends the value.
  if (value.startsWith('"') || value.startsWith("'")) return value;
  const idx = value.indexOf(" #");
  if (idx === -1) return value;
  return value.slice(0, idx).trimEnd();
}

function parseScalar(rawValue: string): unknown {
  const v = stripInlineComment(rawValue.trim());
  if (v === "" || v === "null" || v === "~") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  return v;
}

function parseMapping(
  lines: string[],
  lineOffset: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    // Skip blank + comment lines.
    if (trimmed === "" || trimmed.startsWith("#")) {
      i += 1;
      continue;
    }
    // Top-level keys must start at column 0.
    if (raw.startsWith(" ") || raw.startsWith("\t")) {
      throw new FrontmatterParseError(
        lineOffset + i,
        raw,
        "unexpected indentation at top level (nested mappings not supported)",
      );
    }
    const colon = raw.indexOf(":");
    if (colon < 0) {
      throw new FrontmatterParseError(
        lineOffset + i,
        raw,
        "expected 'key: value' at top level",
      );
    }
    const key = raw.slice(0, colon).trim();
    const valuePart = raw.slice(colon + 1);

    // Detect block-scalar marker (`|` or `|-`).
    const blockMatch = stripInlineComment(valuePart.trim());
    if (blockMatch === "|" || blockMatch === "|-") {
      const stripTrailingNewline = blockMatch === "|-";
      const collected: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j]!;
        if (next === "" || next.startsWith("  ") || next.startsWith("\t")) {
          // Strip the 2-space indent (tab counted as one indent level).
          const stripped = next.startsWith("\t") ? next.slice(1) : next.slice(2);
          collected.push(stripped);
          j += 1;
          continue;
        }
        break;
      }
      let joined = collected.join("\n");
      if (stripTrailingNewline) {
        joined = joined.replace(/\n+$/, "");
      } else {
        // `|` preserves a single trailing newline; multiple are folded
        // to one, no trailing newline → add one.
        joined = joined.replace(/\n+$/, "\n");
        if (!joined.endsWith("\n")) joined += "\n";
      }
      out[key] = joined;
      i = j;
      continue;
    }

    // Detect inline value vs list-form value.
    const inlineValue = stripInlineComment(valuePart).trim();
    if (inlineValue === "") {
      // List form: subsequent indented lines starting with `- ` are items.
      const items: unknown[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j]!;
        const t = next.trim();
        if (t === "" || t.startsWith("#")) {
          j += 1;
          continue;
        }
        if (!next.startsWith("  ") && !next.startsWith("\t")) {
          break;
        }
        const itemMatch = next.match(/^\s*-\s*(.*)$/);
        if (!itemMatch) {
          throw new FrontmatterParseError(
            lineOffset + j,
            next,
            "expected list item starting with '- ' under multi-line key",
          );
        }
        items.push(parseScalar(itemMatch[1]!));
        j += 1;
      }
      out[key] = items;
      i = j;
      continue;
    }

    if (inlineValue === "{}") {
      out[key] = {};
      i += 1;
      continue;
    }

    // Reject inline flow-style arrays / objects we don't support.
    if (inlineValue.startsWith("[") || inlineValue.startsWith("{")) {
      throw new FrontmatterParseError(
        lineOffset + i,
        raw,
        "flow-style array/object literals not supported (use list form)",
      );
    }

    out[key] = parseScalar(inlineValue);
    i += 1;
  }
  return out;
}
