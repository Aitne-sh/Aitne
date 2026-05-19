/**
 * Canonical doc-ordering rules shared by the tree (left pane) and the
 * Prev/Next neighbors footer (bottom of the content pane).
 *
 * Without a single source of truth here the two surfaces drift: the
 * operator scrolls down to a "Next: Hourly Check" link that doesn't
 * match the order they see in the tree on the left.
 */

import type { DocsTreeItem } from "@/lib/api-types";

/**
 * Top-level reading order. Mirrors DOCS_QA_DESIGN.md §6 (the "Why this
 * shape" reading: getting-started before concepts, troubleshooting after
 * guides, glossary last). The backend returns rows alphabetically so
 * we re-sort here.
 */
export const CATEGORY_ORDER: ReadonlyArray<string> = [
  "getting-started",
  "concepts",
  "features",
  "guides",
  "troubleshooting",
  "reference",
  "glossary",
];

/**
 * Per-category section ordering. Only `features/` has multiple sections
 * today; other categories are flat. Adding a new section without
 * registering it here lands it at the end of its category, which is
 * the right default — non-canonical sections shouldn't outrank the
 * curated reading order.
 */
export const SECTION_ORDER: Record<string, ReadonlyArray<string>> = {
  features: [
    "routines",
    "memory-files",
    "integrations",
    "messaging",
    "lifestyle",
    "operations",
  ],
};

export function orderIndex(order: ReadonlyArray<string>, key: string): number {
  const i = order.indexOf(key);
  return i === -1 ? order.length : i;
}

/**
 * Flatten the tree into a single linear reading order:
 *   category (CATEGORY_ORDER) > section (SECTION_ORDER) > slug (lex).
 *
 * Stable for a given input array — same docs in same input order
 * produce the same flat list across calls.
 */
export function flattenDocOrder(docs: DocsTreeItem[]): DocsTreeItem[] {
  return [...docs].sort((a, b) => {
    const ca = orderIndex(CATEGORY_ORDER, a.category);
    const cb = orderIndex(CATEGORY_ORDER, b.category);
    if (ca !== cb) return ca - cb;

    const sectionsForA = SECTION_ORDER[a.category] ?? [];
    const sectionsForB = SECTION_ORDER[b.category] ?? [];
    // Untyped (null/undefined) sections sort first within a category
    // — they hold top-level docs that the category landing should
    // surface above sub-grouped content (e.g. `concepts/agent-day`
    // above any future `concepts/<sub>/...`).
    const sa = a.section ? orderIndex(sectionsForA, a.section) : -1;
    const sb = b.section ? orderIndex(sectionsForB, b.section) : -1;
    if (sa !== sb) return sa - sb;

    return a.slug.localeCompare(b.slug);
  });
}

/**
 * Find the linear neighbors of `slug` in the flattened order. Returns
 * `null` for the prev side when `slug` is the first doc and for the
 * next side when it is the last doc. If the slug is not found at all,
 * both sides are `null` (caller renders no footer).
 */
export function prevNext(
  ordered: DocsTreeItem[],
  slug: string | null,
): { prev: DocsTreeItem | null; next: DocsTreeItem | null } {
  if (!slug) return { prev: null, next: null };
  const idx = ordered.findIndex((d) => d.slug === slug);
  if (idx < 0) return { prev: null, next: null };
  return {
    prev: idx > 0 ? ordered[idx - 1]! : null,
    next: idx < ordered.length - 1 ? ordered[idx + 1]! : null,
  };
}
