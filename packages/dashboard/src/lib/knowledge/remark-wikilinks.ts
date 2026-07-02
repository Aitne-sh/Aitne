/**
 * remark plugin that rewrites Obsidian-style `[[target]]` / `[[target|alias]]`
 * wikilinks inside plain text mdast nodes as `link` nodes pointing at the
 * `pa-wiki:` scheme. The `<a>` component override in the knowledge preview
 * renderer detects the scheme and navigates the Context Files viewer via its
 * `?path=` deep-link.
 *
 * Operating on the mdast tree (not the source string) keeps wikilink syntax
 * inside fenced code blocks and inline `code` spans untouched — vault files
 * (skills docs, journal-format policy) quote the grammar in examples.
 *
 * Known v1 limitation: inside GFM tables the `|` in `[[a|b]]` is consumed by
 * the table parser before this plugin runs (Obsidian escapes it as `\|`), so
 * aliased wikilinks in table cells render split.
 */

import { defaultUrlTransform } from "react-markdown";
import type { MdastNode } from "@/lib/docs/remark-citations";

// `(?<!!)` skips embeds `![[...]]` — those reference binaries in the external
// Obsidian vault and have no dashboard-servable target.
const WIKILINK_RE = /(?<!!)\[\[([^[\]]+)\]\]/g;

export function remarkWikilinks(): (tree: MdastNode) => void {
  return (tree) => transformWikilinks(tree);
}

export function transformWikilinks(node: MdastNode): void {
  // Code blocks and inline code are leaves; their content is not prose.
  if (node.type === "code" || node.type === "inlineCode") return;
  // Never linkify inside an existing link — nested <a> is invalid HTML.
  if (node.type === "link") return;
  if (!Array.isArray(node.children)) return;
  let i = 0;
  while (i < node.children.length) {
    const child = node.children[i]!;
    if (
      child.type === "text" &&
      typeof child.value === "string" &&
      child.value.includes("[[")
    ) {
      const replacement = splitWikilinksInText(child.value);
      if (replacement.length > 1 || replacement[0] !== child) {
        node.children.splice(i, 1, ...replacement);
        i += replacement.length;
        continue;
      }
    }
    transformWikilinks(child);
    i++;
  }
}

export function splitWikilinksInText(value: string): MdastNode[] {
  const out: MdastNode[] = [];
  let last = 0;
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(value)) !== null) {
    const inner = m[1]!;
    const pipeIdx = inner.indexOf("|");
    const targetRaw = pipeIdx === -1 ? inner : inner.slice(0, pipeIdx);
    const alias = pipeIdx === -1 ? null : inner.slice(pipeIdx + 1).trim();
    const target = normalizeWikiTarget(targetRaw);
    if (!target) {
      // Pure-anchor self links (`[[#heading]]`) have no file target — leave
      // the token as plain text rather than emitting a dead link.
      continue;
    }
    if (m.index > last) {
      out.push({ type: "text", value: value.slice(last, m.index) });
    }
    out.push({
      type: "link",
      url: `pa-wiki:${encodeURIComponent(target)}`,
      title: null,
      children: [{ type: "text", value: alias || target }],
    });
    last = m.index + m[0].length;
  }
  if (out.length === 0) {
    return [{ type: "text", value }];
  }
  if (last < value.length) {
    out.push({ type: "text", value: value.slice(last) });
  }
  return out;
}

/**
 * Reduce a raw wikilink target to a vault-relative selection path: drop a
 * `#heading` suffix (the viewer has no anchor scrolling) and the `.md`
 * extension (the Context Files `?path=` deep-link is extension-stripped).
 * Returns null when nothing remains (pure-anchor links).
 */
export function normalizeWikiTarget(raw: string): string | null {
  const hashIdx = raw.indexOf("#");
  const path = (hashIdx === -1 ? raw : raw.slice(0, hashIdx)).trim();
  const stripped = path.replace(/\.md$/, "");
  return stripped.length > 0 ? stripped : null;
}

/**
 * `defaultUrlTransform` strips unknown schemes — without this passthrough
 * every `pa-wiki:` href reaches the component map as an empty string.
 */
export function knowledgeUrlTransform(url: string): string {
  if (url.startsWith("pa-wiki:")) return url;
  return defaultUrlTransform(url);
}

/**
 * Decode a `pa-wiki:<target>` href back to its vault-relative target.
 * Returns null for non-wiki hrefs and for malformed percent-encoding —
 * a hand-written `[x](pa-wiki:%)` in vault content must degrade to a
 * plain anchor, not throw URIError mid-render (the knowledge page has
 * no error boundary).
 */
export function parsePaWikiHref(href: string): { target: string } | null {
  if (!href.startsWith("pa-wiki:")) return null;
  try {
    const target = decodeURIComponent(href.slice("pa-wiki:".length));
    return target.length > 0 ? { target } : null;
  } catch {
    return null;
  }
}

/** Context Files deep-link for a vault-relative target. */
export function wikiTargetHref(target: string): string {
  return `/knowledge?tab=context-files&path=${encodeURIComponent(target)}`;
}

/**
 * Bare-slug wikilinks (`[[acme-launch]]`) rely on Obsidian's basename
 * resolution. The dashboard tries the conventional homes in order —
 * projects first (source cards link `Project: [[<slug>]]`), then wiki and
 * dossier entries (the wiki-compile skill emits bare `[[<slug>]]` index
 * lines).
 */
export function bareSlugCandidates(slug: string): string[] {
  return [
    `plans/projects/${slug}`,
    `knowledge/wiki/${slug}`,
    `knowledge/dossiers/${slug}`,
  ];
}

/**
 * Resolve a bare slug to the first candidate path that exists, by probing
 * the wildcard `GET /api/context/<path>` read route (404 → next candidate).
 * Returns null when nothing resolves.
 */
export async function resolveBareSlug(
  slug: string,
  getFile: (path: string) => Promise<unknown>,
): Promise<string | null> {
  for (const candidate of bareSlugCandidates(slug)) {
    try {
      await getFile(candidate);
      return candidate;
    } catch {
      // 404 (or any fetch failure) — fall through to the next candidate.
    }
  }
  return null;
}
