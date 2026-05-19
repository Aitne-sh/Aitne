"use client";

import Link from "next/link";
import { ArrowLeft, ArrowRight, FileText, Link2 } from "lucide-react";
import { useDocsTree } from "@/lib/hooks/use-docs";
import { flattenDocOrder, prevNext } from "@/lib/docs/doc-order";
import type { DocsTreeItem } from "@/lib/api-types";

interface DocsContentFooterProps {
  /** Slug of the doc currently rendered. */
  currentSlug: string;
  /** Frontmatter `related` slugs from the open doc. */
  related: string[];
}

/**
 * Pure visibility derivation — exported for unit tests so the
 * "don't render until tree.isFetched" invariant is regression-guarded
 * (without a flash of "Not yet authored" cards while the tree query
 * is in flight).
 */
export function deriveFooterVisibility(input: {
  treeIsFetched: boolean;
  hasPrev: boolean;
  hasNext: boolean;
  relatedCount: number;
}): { showNeighbors: boolean; showRelated: boolean } {
  const { treeIsFetched, hasPrev, hasNext, relatedCount } = input;
  return {
    showNeighbors: treeIsFetched && (hasPrev || hasNext),
    showRelated: treeIsFetched && relatedCount > 0,
  };
}

/**
 * The bottom slab of `<DocsContent>`:
 *   1. Prev/Next pair (linear order matches the tree).
 *   2. Related-docs card list driven by `frontmatter.related`.
 *
 * Both sections look up titles from the already-loaded tree response
 * (`useDocsTree`) so adding them does not introduce per-doc fetches.
 * Related slugs that aren't in the tree (e.g. authored ahead of P4)
 * fall back to slug-as-title with a muted style so the operator sees
 * the gap rather than a broken link.
 */
export function DocsContentFooter({
  currentSlug,
  related,
}: DocsContentFooterProps) {
  const tree = useDocsTree();
  const docs = tree.data?.docs ?? [];
  const ordered = flattenDocOrder(docs);
  const { prev, next } = prevNext(ordered, currentSlug);

  // Tree-based title lookup. Avoids N+1 useDoc calls for the related
  // section when the corpus is small (~65 docs at MVP).
  const byslug = new Map<string, DocsTreeItem>();
  for (const d of docs) byslug.set(d.slug, d);

  // Gate both sub-sections on `tree.isFetched` so the footer does not
  // render a transient state where every related card claims "Not yet
  // authored" and prev/next vanish — that flashes for the entire
  // tree-fetch latency window when the operator deep-links to
  // `/docs/<slug>` and the tree query is cold-started in parallel.
  const { showNeighbors, showRelated } = deriveFooterVisibility({
    treeIsFetched: tree.isFetched,
    hasPrev: prev !== null,
    hasNext: next !== null,
    relatedCount: related.length,
  });
  if (!showNeighbors && !showRelated) return null;

  return (
    <footer className="mt-10 space-y-8 border-t border-border pt-6">
      {showNeighbors && <NeighborsRow prev={prev} next={next} />}
      {showRelated && (
        <RelatedList relatedSlugs={related} resolve={(s) => byslug.get(s)} />
      )}
    </footer>
  );
}

function NeighborsRow({
  prev,
  next,
}: {
  prev: DocsTreeItem | null;
  next: DocsTreeItem | null;
}) {
  return (
    <nav
      aria-label="Adjacent docs"
      className="grid gap-3 sm:grid-cols-2"
    >
      {prev ? (
        <NeighborCard direction="prev" target={prev} />
      ) : (
        <span aria-hidden="true" />
      )}
      {next ? (
        <NeighborCard direction="next" target={next} />
      ) : (
        <span aria-hidden="true" />
      )}
    </nav>
  );
}

function NeighborCard({
  direction,
  target,
}: {
  direction: "prev" | "next";
  target: DocsTreeItem;
}) {
  const isPrev = direction === "prev";
  return (
    <Link
      href={`/docs/${target.slug}`}
      className="group flex flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3 text-sm transition hover:border-primary/40 hover:bg-accent"
    >
      <span
        className={`flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground ${isPrev ? "" : "justify-end"}`}
      >
        {isPrev ? (
          <>
            <ArrowLeft className="h-3 w-3" aria-hidden="true" />
            Previous
          </>
        ) : (
          <>
            Next
            <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </>
        )}
      </span>
      <span
        className={`font-medium text-foreground group-hover:text-primary ${isPrev ? "" : "text-right"}`}
      >
        {target.title}
      </span>
    </Link>
  );
}

interface RelatedListProps {
  relatedSlugs: string[];
  resolve: (slug: string) => DocsTreeItem | undefined;
}

function RelatedList({ relatedSlugs, resolve }: RelatedListProps) {
  return (
    <section aria-label="Related docs">
      <p className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Link2 className="h-3 w-3" aria-hidden="true" />
        Related
      </p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {relatedSlugs.map((slug) => {
          const target = resolve(slug);
          return (
            <li key={slug}>
              <Link
                href={`/docs/${slug}`}
                className="flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm transition hover:border-primary/40 hover:bg-accent"
              >
                <FileText
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-60"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {target?.title ?? slug}
                  </span>
                  {target?.summary ? (
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {target.summary}
                    </span>
                  ) : !target ? (
                    <span className="mt-0.5 block text-[10px] uppercase tracking-wide text-muted-foreground/70">
                      Not yet authored
                    </span>
                  ) : null}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
