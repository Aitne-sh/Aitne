/**
 * Scroll-to-anchor helper for the docs content pane.
 *
 * The slugify implementation lives in `@aitne/shared` so the
 * citation post-processor (daemon), the FTS5 anchor extraction (daemon),
 * and the anchor ids the dashboard renders into the DOM all use the
 * same rule. Re-exported here for callers that don't want to depend on
 * the shared package directly.
 */

import { slugifyAnchor } from "@aitne/shared";

export { slugifyAnchor };

/**
 * Scroll the page (or `container`, if provided) to the heading whose id
 * matches `anchor`. Returns `true` on success, `false` if the id was not
 * found in the DOM — the caller is expected to surface a toast in that
 * case so the operator knows the citation was approximate.
 *
 * Anchor ids are produced by the same `slugifyAnchor` rule used by the
 * indexer; callers should pass the rendered anchor id (already slugified),
 * not the raw heading text.
 */
export function scrollToAnchor(anchor: string, container?: HTMLElement | null): boolean {
  if (!anchor) return false;
  const root: ParentNode = container ?? document;
  const target = root.querySelector<HTMLElement>(`#${cssEscape(anchor)}`);
  if (!target) return false;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  return true;
}

/**
 * Minimal CSS.escape polyfill for the subset of characters we ever embed
 * in anchor ids (lowercase ASCII alphanumerics + `-`). Built-in
 * `CSS.escape` exists in every browser the dashboard targets, but this
 * file is also imported by Vitest tests in jsdom where `CSS` is set up
 * lazily — calling it directly is fine, but exposing a tiny helper keeps
 * the tests self-contained and the call sites readable.
 */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

/**
 * Strip a leading `# {title}` heading from a Markdown body when it
 * matches the frontmatter title. The `<DocsContent>` page header already
 * renders the title, and authors conventionally also open the body with
 * `# Title` — without this strip the page shows the title twice.
 *
 * Match logic uses `slugifyAnchor` so the comparison is whitespace- and
 * case-insensitive (e.g., `Morning Routine` vs `morning routine`). A
 * leading H1 with different text is preserved; that case is rare and
 * may be intentional (e.g., a title-vs-body distinction).
 */
export function stripLeadingTitleH1(body: string, title: string): string {
  const targetSlug = slugifyAnchor(title);
  if (!targetSlug) return body;
  const match = body.match(/^[ \t]*#[ \t]+([^\n]+)\n?/);
  if (!match) return body;
  const heading = match[1]!.replace(/[ \t]+#*[ \t]*$/, "").trim();
  if (slugifyAnchor(heading) !== targetSlug) return body;
  return body.slice(match[0].length).replace(/^\n+/, "");
}
