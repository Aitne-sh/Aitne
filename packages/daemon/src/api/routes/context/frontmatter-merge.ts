import yaml from "js-yaml";

/**
 * Deep-merge a partial frontmatter object into a markdown file's existing
 * YAML frontmatter, preserving the body verbatim.
 *
 * Drives the `frontmatterMerge` PATCH mode (docs/design/21-management-
 * registry-and-entities.md §10.4 step 4b): the scheduled-managed-task flow
 * links each contributing app into an entity file's nested `sources.<app>`
 * map (plus scalars like `last_synced_at`) without clobbering other apps'
 * source ids, other frontmatter keys, or the markdown body. The section /
 * append PATCH modes only ever touch the body, so before this mode the agent
 * had no chokepoint-safe way to edit nested frontmatter.
 *
 * Merge semantics: plain objects merge key-by-key recursively; every other
 * value (scalar, array, null) from `partial` REPLACES the base value. This is
 * exactly what "set sources.<app>.<id> = …" needs — a new app key is added,
 * an existing app's fields are merged, and a scalar like `last_synced_at` is
 * overwritten.
 */

export type FrontmatterMergeResult =
  | { ok: true; content: string }
  | { ok: false; message: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Recursively merge `partial` into `base`; returns a new object (inputs untouched). */
export function deepMergePlainObjects(
  base: Record<string, unknown>,
  partial: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(partial)) {
    const existing = out[key];
    out[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? deepMergePlainObjects(existing, value)
        : value;
  }
  return out;
}

// Matches a leading YAML frontmatter block: `---\n … \n---\n?`. The body is
// everything after the closing fence. Tolerant of CRLF.
const FRONTMATTER_BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function mergeFrontmatter(
  fileContent: string,
  partial: Record<string, unknown>,
): FrontmatterMergeResult {
  const eol = /\r\n/.test(fileContent) ? "\r\n" : "\n";

  let base: Record<string, unknown> = {};
  let body = fileContent;

  const match = FRONTMATTER_BLOCK_RE.exec(fileContent);
  if (match) {
    let parsed: unknown;
    try {
      // js-yaml v4 `load` is the safe loader (no code execution).
      parsed = yaml.load(match[1]);
    } catch (err) {
      return {
        ok: false,
        message: `existing frontmatter is not valid YAML: ${String(err)}`,
      };
    }
    if (parsed != null) {
      if (!isPlainObject(parsed)) {
        return {
          ok: false,
          message: "existing frontmatter is not a YAML mapping (object)",
        };
      }
      base = parsed;
    }
    body = fileContent.slice(match[0].length);
  }

  const merged = deepMergePlainObjects(base, partial);

  // `lineWidth: -1` keeps long scalars (ids, paths) unwrapped; `sortKeys:
  // false` preserves insertion order (existing keys first, then new ones).
  const dumped = yaml.dump(merged, { lineWidth: -1, noRefs: true, sortKeys: false });
  // yaml.dump always emits LF; rewrite to the file's EOL so a CRLF vault file
  // (Obsidian on Windows) does not round-trip dirty under git autocrlf.
  const dumpedEol = eol === "\r\n" ? dumped.replace(/\n/g, "\r\n") : dumped;

  return { ok: true, content: `---${eol}${dumpedEol}---${eol}${body}` };
}
