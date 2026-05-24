"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import Link from "next/link";
import { AlertTriangle, ChevronRight, FileText, Loader2 } from "lucide-react";
import { APP_NAME } from "@aitne/shared";
import { useDoc, useDocsHealth, useDocsTree } from "@/lib/hooks/use-docs";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { DocsContentFooter } from "./docs-content-footer";
import { DocsToc } from "./docs-toc";
import { SelectionAskButton } from "./selection-ask-button";
import {
  scrollToAnchor,
  slugifyAnchor,
  stripLeadingTitleH1,
} from "@/lib/docs/anchor";
import type { DocsTreeItem } from "@/lib/api-types";
import { cn } from "@/lib/utils";

// react-markdown + remark plugins are heavy. Splitting the render
// subtree into its own chunk lets the route commit faster and shows a
// short skeleton while the chunk + parse complete.
function MarkdownSkeleton() {
  return (
    <div className="space-y-2 py-2" aria-hidden="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="h-4 animate-pulse rounded bg-muted/30"
          style={{ width: `${70 + ((i * 13) % 25)}%` }}
        />
      ))}
    </div>
  );
}
const DocsMarkdownBody = dynamic(
  () => import("./docs-markdown-body").then((m) => m.DocsMarkdownBody),
  { ssr: false, loading: MarkdownSkeleton },
);

interface DocsContentProps {
  slug: string | null;
  /**
   * When true, lays out for the slide-over (DOCS_QA_DASHBOARD_DESIGN
   * §6.2): no sticky TOC, no breadcrumb (the slide-over header shows
   * the title), no related/neighbors footer (navigating away from a
   * single-page lookup defeats the help affordance), and a tighter
   * container padding.
   */
  compact?: boolean;
  /** Optional callback invoked when the selection-ask button fires. */
  onAsk?: () => void;
  /**
   * Slugified heading id to scroll to once the doc loads. Used by the
   * slide-over (DOCS_QA_DESIGN.md §8.4 E6 — settings-label `?`) where
   * `window.location.hash` is not the right channel because the page
   * the operator is on does not change. `nonce` lets the parent force
   * a re-scroll on repeat opens with the same anchor.
   */
  initialAnchor?: string | null;
  /** Bump to force the scroll effect to re-fire even when anchor is unchanged. */
  initialAnchorNonce?: number;
}

export function DocsContent({
  slug,
  compact = false,
  onAsk,
  initialAnchor = null,
  initialAnchorNonce = 0,
}: DocsContentProps) {
  const { data, isLoading, error } = useDoc(slug);
  const router = useRouter();
  const articleRef = useRef<HTMLElement>(null);
  // Bumped by DocsMarkdownBody#onRendered so the scroll-to-anchor
  // effect retriggers once the dynamically-loaded markdown chunk
  // commits. Without this, `/docs/foo#section` lands at the top of
  // the page on first visit because the heading isn't in the DOM
  // when the page-level effect first runs.
  const [bodyRenderedNonce, setBodyRenderedNonce] = useState(0);
  const onMarkdownRendered = useCallback(() => {
    setBodyRenderedNonce((n) => n + 1);
  }, []);

  const onCitationClick = useCallback(
    (citationSlug: string, anchor: string | null) => {
      if (citationSlug === slug) {
        if (anchor) scrollToAnchor(anchor);
        return;
      }
      const target = anchor
        ? `/docs/${citationSlug}#${anchor}`
        : `/docs/${citationSlug}`;
      router.push(target);
    },
    [slug, router],
  );

  // Cross-doc citation clicks navigate to `/docs/<slug>#<anchor>`. The
  // browser tries to scroll to the hash on initial paint, but `useDoc`
  // is still loading at that point so the heading element does not yet
  // exist. Once the body is rendered we apply the hash scroll ourselves.
  // Triggers on every doc-load so back-button navigation also re-anchors.
  //
  // `initialAnchor` is the prop-driven channel used by the slide-over
  // (DOCS_QA_DESIGN.md §8.4 E6). In compact mode we deliberately ignore
  // `window.location.hash` — the slide-over is mounted globally over
  // every page, so a stale `#section` from `/docs/foo#section` would
  // otherwise scroll an unrelated slide-over doc to the wrong place.
  useEffect(() => {
    if (!data) return;
    if (typeof window === "undefined") return;
    const fallback = compact ? "" : window.location.hash.slice(1);
    const target = initialAnchor ?? fallback;
    if (!target) return;
    const id = window.requestAnimationFrame(() => {
      scrollToAnchor(target, articleRef.current);
    });
    return () => window.cancelAnimationFrame(id);
  }, [data, initialAnchor, initialAnchorNonce, compact, bodyRenderedNonce]);

  if (slug === null) {
    return <DocsLanding />;
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        <span className="ml-2 text-sm">Loading…</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6">
        <Alert variant="error">
          Couldn&rsquo;t load this doc. The slug{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">{slug}</code>{" "}
          may have been renamed or removed.
        </Alert>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "mx-auto flex w-full gap-6",
        compact ? "max-w-none px-4 py-4" : "max-w-5xl px-6 py-6",
      )}
    >
      <article
        ref={articleRef}
        // max-w-3xl keeps body line length in the readable 60–75ch
        // band whether the sticky TOC is showing or not. The flex
        // parent's max-w-5xl bounds the (article + TOC) pair instead.
        // In compact mode the slide-over is ~520px wide so the article
        // takes the full width.
        className={cn("min-w-0 flex-1", compact ? "max-w-none" : "max-w-3xl")}
      >
        {!compact && <Breadcrumb slug={data.slug} title={data.frontmatter.title} />}

        <header className={cn(compact ? "mb-4 mt-1" : "mb-6 mt-2")}>
          <h1
            id={slugifyAnchor(data.frontmatter.title)}
            className={cn(
              "font-semibold tracking-tight",
              compact ? "text-lg" : "text-2xl",
            )}
          >
            {data.frontmatter.title}
          </h1>
          {data.frontmatter.summary && (
            <p
              className={cn(
                "mt-2 text-muted-foreground",
                compact ? "text-xs" : "text-sm",
              )}
            >
              {data.frontmatter.summary}
            </p>
          )}
          <DocStatusRow frontmatter={data.frontmatter} />
        </header>

        <div
          className={cn(
            "markdown-body docs-prose text-foreground",
            compact ? "text-sm" : "text-[15px]",
          )}
        >
          <DocsMarkdownBody
            body={stripLeadingTitleH1(data.body, data.frontmatter.title)}
            currentSlug={slug}
            onCitationClick={onCitationClick}
            onRendered={onMarkdownRendered}
          />
        </div>
        {!compact && (
          <DocsContentFooter
            currentSlug={data.slug}
            related={data.frontmatter.related}
          />
        )}
      </article>
      {!compact && <DocsToc body={data.body} scopeRef={articleRef} />}
      <SelectionAskButton containerRef={articleRef} onAsk={onAsk} />
    </div>
  );
}


interface BreadcrumbProps {
  slug: string;
  title: string;
}

/**
 * Breadcrumb at the top of the content pane (DOCS_QA_DASHBOARD_DESIGN
 * §5.3). The design says "each segment is a link", but `/docs/<slug>`
 * is the only navigable route in this implementation — there is no
 * dedicated `/docs/<category>` landing page (the route would 404
 * against `useDoc`). The only link with a real target is the leading
 * "Docs" → `/docs` (which renders the category-card landing). The
 * intermediate segments are display-only; the tree on the left is the
 * real category-level navigation surface.
 */
function Breadcrumb({ slug, title }: BreadcrumbProps) {
  const segments = slug.split("/");
  const crumbs = segments.slice(0, -1);
  if (crumbs.length === 0) {
    return (
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        <Link href="/docs" className="hover:text-foreground">
          Docs
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground">{title}</span>
      </p>
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      <Link href="/docs" className="hover:text-foreground">
        Docs
      </Link>
      {crumbs.map((seg) => (
        <span key={seg} className="contents">
          <ChevronRight className="h-3 w-3" />
          <span className="capitalize">{seg.replace(/-/g, " ")}</span>
        </span>
      ))}
      <ChevronRight className="h-3 w-3" />
      <span className="text-foreground">{title}</span>
    </p>
  );
}

interface DocStatusRowProps {
  frontmatter: import("@/lib/api-types").DocsDetailFrontmatter;
}

function DocStatusRow({ frontmatter }: DocStatusRowProps) {
  const showStatus =
    frontmatter.status && frontmatter.status !== "stable";
  const tags = frontmatter.tags ?? [];
  if (!showStatus && tags.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {showStatus && (
        <Badge
          variant={frontmatter.status === "deprecated" ? "red" : "amber"}
          className="capitalize"
        >
          {frontmatter.status}
        </Badge>
      )}
      {tags.slice(0, 6).map((t) => (
        <Badge key={t} variant="gray" className="font-normal">
          {t}
        </Badge>
      ))}
    </div>
  );
}

function DocsLanding() {
  const health = useDocsHealth();
  const tree = useDocsTree();

  if (health.data?.status === "degraded") {
    return <DegradedHero health={health.data} onRetry={() => health.refetch()} />;
  }
  // status === "empty" with errorCount === 0 means seed succeeded but the
  // corpus contains no docs.
  if (health.data?.status === "empty" && health.data.errorCount === 0) {
    return <EmptyCorpusHero />;
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-12 text-center">
      <FileText className="mx-auto h-10 w-10 text-muted-foreground/60" />
      <h2 className="mt-4 text-xl font-semibold">Docs</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        Operator-facing reference for {APP_NAME}. Pick a doc from the tree
        on the left, or search by typing in the filter box.
      </p>
      <CategoryGrid docs={tree.data?.docs ?? []} />
    </div>
  );
}

const LANDING_CATEGORIES: Array<{ key: string; label: string; blurb: string }> = [
  { key: "getting-started", label: "Get Started",     blurb: "Install, set up, first day." },
  { key: "concepts",        label: "Concepts",        blurb: "Vocabulary of the system." },
  { key: "features",        label: "Features",        blurb: "Per-feature operator docs." },
  { key: "guides",          label: "Guides",          blurb: "Task-oriented playbooks." },
  { key: "troubleshooting", label: "Troubleshooting", blurb: "Symptom-indexed fixes." },
  { key: "reference",       label: "Reference",       blurb: "Lookup tables." },
];

function CategoryGrid({ docs }: { docs: DocsTreeItem[] }) {
  // Pick a representative landing slug per category — the first indexed
  // doc (already sorted server-side). Categories with zero docs render as
  // muted placeholders so the grid stays a stable shape regardless of how
  // much content P4 has authored.
  const firstByCategory = useMemo(() => {
    const m = new Map<string, DocsTreeItem>();
    for (const d of docs) {
      if (!m.has(d.category)) m.set(d.category, d);
    }
    return m;
  }, [docs]);

  return (
    <div className="mx-auto mt-8 grid max-w-xl grid-cols-1 gap-3 text-left sm:grid-cols-2">
      {LANDING_CATEGORIES.map((cat) => {
        const target = firstByCategory.get(cat.key);
        if (!target) {
          return (
            <div
              key={cat.key}
              className={cn(
                "rounded-lg border border-dashed border-border bg-muted/30 px-4 py-3 text-muted-foreground",
              )}
              aria-disabled="true"
            >
              <p className="text-sm font-medium">{cat.label}</p>
              <p className="mt-0.5 text-xs">{cat.blurb}</p>
              <p className="mt-1 text-[10px] uppercase tracking-wide opacity-70">
                Not yet authored
              </p>
            </div>
          );
        }
        return (
          <Link
            key={cat.key}
            href={`/docs/${target.slug}`}
            className={cn(
              "block rounded-lg border border-border bg-card px-4 py-3 transition-colors",
              "hover:border-primary/50 hover:bg-accent",
            )}
          >
            <p className="text-sm font-medium">{cat.label}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{cat.blurb}</p>
          </Link>
        );
      })}
    </div>
  );
}

function DegradedHero({
  health,
  onRetry,
}: {
  health: import("@/lib/api-types").DocsHealthResponse;
  onRetry: () => void;
}) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-12 text-center">
      <AlertTriangle className="mx-auto h-10 w-10 text-amber-500" />
      <h2 className="mt-4 text-xl font-semibold">Docs failed to seed</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        The docs corpus did not initialize. QA and browse are unavailable
        until the indexer can read{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">
          agent-assets/docs/
        </code>{" "}
        and seed{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">docs/user/</code>.
      </p>
      {health.errors.length > 0 && (
        <ul className="mx-auto mt-4 max-w-md space-y-1 text-left text-xs text-muted-foreground">
          {health.errors.slice(0, 5).map((e, i) => (
            <li
              key={`${e.slug ?? e.path ?? "_"}-${i}`}
              className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200"
            >
              <span className="font-mono">{e.slug ?? e.path ?? "?"}</span>: {e.message}
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={onRetry}
        className="mt-6 rounded-md border border-border bg-card px-4 py-1.5 text-sm hover:bg-accent"
      >
        Retry
      </button>
    </div>
  );
}

function EmptyCorpusHero() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-12 text-center">
      <FileText className="mx-auto h-10 w-10 text-muted-foreground/60" />
      <h2 className="mt-4 text-xl font-semibold">No docs indexed yet</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        The corpus seeded successfully but contains no Markdown files. Add
        operator-facing docs to{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">docs/user/</code>{" "}
        and the indexer will pick them up on save.
      </p>
    </div>
  );
}
