/**
 * Resolve a relative `*.md` Markdown link against a doc's slug to the
 * target doc's slug, so the renderer can route it via Next.js navigation
 * instead of treating it as an external anchor.
 *
 * Returns `null` for anything that should NOT be rewritten as an internal
 * doc link — absolute URLs, non-`.md` paths, or relative paths that walk
 * outside the corpus root. Callers render those as plain text (or as an
 * external `<a>` for `http(s)` / `mailto`, handled separately upstream).
 */

export interface ResolvedDocLink {
  slug: string;
  anchor: string | null;
}

const ABSOLUTE_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

export function resolveRelativeDocLink(
  currentSlug: string,
  href: string,
): ResolvedDocLink | null {
  if (!href) return null;
  // Absolute URL (http, https, mailto, pa-doc, etc.) — not a relative path.
  if (ABSOLUTE_SCHEME_RE.test(href)) return null;
  // Anchor-only or root-absolute paths are not the relative-doc shape.
  if (href.startsWith("#")) return null;
  if (href.startsWith("/")) return null;

  const hashIdx = href.indexOf("#");
  const path = hashIdx === -1 ? href : href.slice(0, hashIdx);
  const anchor = hashIdx === -1 ? null : href.slice(hashIdx + 1) || null;
  if (!path.endsWith(".md")) return null;

  const baseDir = currentSlug.split("/").slice(0, -1);
  const stack = [...baseDir];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (stack.length === 0) return null; // escapes corpus root
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  if (stack.length === 0) return null;
  const last = stack[stack.length - 1]!;
  if (!last.endsWith(".md")) return null;
  const stripped = last.slice(0, -3);
  // `[link](.md)` or `[link](foo/.md)` — the path strips to an empty
  // trailing segment. Reject so we never produce a slug like `foo/`.
  if (!stripped) return null;
  stack[stack.length - 1] = stripped;
  return { slug: stack.join("/"), anchor };
}
