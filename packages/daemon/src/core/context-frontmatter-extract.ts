/**
 * Shared YAML-frontmatter extractor used by both the legacy strict
 * validator (`context-frontmatter.ts`) and the new vault-contract parser
 * (`context-validation/frontmatter.ts`). Extracting this into its own
 * module is the prerequisite for keeping the two parsers in lock-step on
 * what they consider "frontmatter" while letting each interpret the
 * resulting key/value map under its own rules.
 *
 * The parser is intentionally minimal — it covers the line-scalar shapes
 * Aitne's frontmatter actually uses today (single-line strings, quoted or
 * unquoted, with `#`-anchored inline comments). YAML block scalars (`|`,
 * `>`) and nested mappings remain unsupported by design: every Aitne
 * frontmatter field is a single scalar today, and accepting richer YAML
 * here would silently parse multi-line `origin:` blocks as the literal
 * `"|"` value while losing the actual content — exactly the regression
 * the policy-file validator guards against.
 */

export interface ExtractedFrontmatter {
  values: Record<string, string>;
  body: string;
}

/**
 * Extract the YAML frontmatter from a Markdown file. Returns `null` if
 * the file does not start with `---\n` or never closes the block.
 */
export function extractContextFrontmatter(
  content: string,
): ExtractedFrontmatter | null {
  const lines = content.split(/\r?\n/);
  if (lines[0]!.trim() !== "---") return null;
  const end = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---",
  );
  if (end < 0) return null;

  const values: Record<string, string> = {};
  for (const rawLine of lines.slice(1, end)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(line);
    /* c8 ignore start — non-matching lines slip through as documentation;
       defensive guard for malformed YAML scalars. */
    if (!match) continue;
    /* c8 ignore stop */
    values[match[1]!] = parseYamlScalar(match[2]!);
  }

  return {
    values,
    body: lines.slice(end + 1).join("\n"),
  };
}

/**
 * Convenience wrapper — returns just the parsed scalar map (or `null` if
 * no frontmatter is present). Callers that only need to look up a field
 * value avoid the body-slice cost via this entry point.
 */
export function readContextFrontmatterValues(
  content: string,
): Record<string, string> | null {
  const extracted = extractContextFrontmatter(content);
  return extracted === null ? null : extracted.values;
}

function parseYamlScalar(value: string): string {
  return stripYamlQuotes(stripYamlInlineComment(value).trim());
}

function stripYamlInlineComment(value: string): string {
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        quote = null;
      }
      continue;
    }

    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "#" && (i === 0 || /\s/.test(value[i - 1]!))) {
      return value.slice(0, i).trimEnd();
    }
  }

  return value;
}

function stripYamlQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
