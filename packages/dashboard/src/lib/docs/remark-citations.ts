/**
 * remark plugin that rewrites `[doc:slug#anchor]` tokens inside plain
 * text mdast nodes as `link` nodes pointing at the `pa-doc:` scheme.
 * The `<a>` component override in the docs renderer detects the scheme
 * and substitutes a `<CitationPill>`.
 *
 * Operating on the mdast tree (not the source string) means citation
 * syntax inside fenced code blocks and inline `code` spans is left
 * alone — important once `reference/*` docs quote citation grammar in
 * examples.
 */

const CITATION_RE =
  /\[doc:([a-z0-9][a-z0-9\-_/]*)(?:#([a-z0-9][a-z0-9-]*))?\]/g;

export interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MdastNode[];
}

export function remarkCitations(): (tree: MdastNode) => void {
  return (tree) => transformCitations(tree);
}

export function transformCitations(node: MdastNode): void {
  // Code blocks and inline code are leaves; their content is not prose.
  if (node.type === "code" || node.type === "inlineCode") return;
  if (!Array.isArray(node.children)) return;
  let i = 0;
  while (i < node.children.length) {
    const child = node.children[i]!;
    if (
      child.type === "text" &&
      typeof child.value === "string" &&
      child.value.includes("[doc:")
    ) {
      const replacement = splitCitationsInText(child.value);
      if (replacement.length > 1) {
        node.children.splice(i, 1, ...replacement);
        i += replacement.length;
        continue;
      }
    }
    transformCitations(child);
    i++;
  }
}

export function splitCitationsInText(value: string): MdastNode[] {
  const out: MdastNode[] = [];
  let last = 0;
  CITATION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CITATION_RE.exec(value)) !== null) {
    if (m.index > last) {
      out.push({ type: "text", value: value.slice(last, m.index) });
    }
    const citationSlug = m[1]!;
    const anchor = m[2] ?? null;
    const url = `pa-doc:${encodeURIComponent(citationSlug)}${anchor ? `#${encodeURIComponent(anchor)}` : ""}`;
    out.push({
      type: "link",
      url,
      title: null,
      children: [{ type: "text", value: m[0]! }],
    });
    last = m.index + m[0].length;
  }
  if (last < value.length) {
    out.push({ type: "text", value: value.slice(last) });
  }
  return out;
}

/** Decode a `pa-doc:slug[#anchor]` href back to its parts. */
export function parsePaDocHref(
  href: string,
): { slug: string; anchor: string | null } | null {
  if (!href.startsWith("pa-doc:")) return null;
  const rest = href.slice("pa-doc:".length);
  const hashIdx = rest.indexOf("#");
  const slug = hashIdx === -1 ? rest : rest.slice(0, hashIdx);
  const anchor = hashIdx === -1 ? null : rest.slice(hashIdx + 1);
  return {
    slug: decodeURIComponent(slug),
    anchor: anchor ? decodeURIComponent(anchor) : null,
  };
}
