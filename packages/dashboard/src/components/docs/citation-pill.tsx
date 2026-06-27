"use client";

import { AlertCircle, FileText } from "lucide-react";
import { ApiError } from "@/lib/api-client";
import { useDoc } from "@/lib/hooks/use-docs";
import { cn } from "@/lib/utils";

interface CitationPillProps {
  slug: string;
  anchor: string | null;
  onClick(slug: string, anchor: string | null): void;
}

/**
 * Inline pill rendered for a `[doc:slug#anchor]` citation token. The
 * doc title is fetched via `useDoc` so the pill displays the human label
 * (`Morning Routine · What It Outputs`) rather than the raw slug. While
 * the lookup is in flight the slug is shown as a graceful fallback. If
 * the doc 404s (server-side validator should have caught this, but we
 * defend in depth — see DOCS_QA_DESIGN.md §9.6 hallucination guardrail),
 * the pill renders in a "broken" state and the click handler is disabled.
 */
export function CitationPill({ slug, anchor, onClick }: CitationPillProps) {
  const { data, error } = useDoc(slug);
  const broken = error instanceof ApiError && error.status === 404;
  const title = data?.frontmatter.title;
  const anchorLabel = anchor ? humanizeAnchor(anchor) : null;

  if (broken) {
    return (
      <span
        title={`Citation refers to a missing doc: ${slug}`}
        className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md border border-warning/40 bg-warning/10 px-1.5 py-0.5 align-baseline text-[11px] text-warning line-through decoration-warning/40"
      >
        <AlertCircle className="h-3 w-3 shrink-0 opacity-80" aria-hidden="true" />
        <span className="truncate">{slug}</span>
      </span>
    );
  }

  const aria = title
    ? anchorLabel
      ? `Open “${title}” at section “${anchorLabel}”`
      : `Open “${title}”`
    : `Open ${slug}`;

  return (
    <button
      type="button"
      onClick={() => onClick(slug, anchor)}
      aria-label={aria}
      title={aria}
      className={cn(
        // `max-w-full` lets the pill shrink in narrow bubbles (the QA
        // panel column is 360px on docs-shell). Without it, a long doc
        // title pushes the bubble wider than its grid column and the
        // parent `<aside>` exposes horizontal scroll. The inner
        // `<span class="truncate">` handles the ellipsis once max-width
        // clamps the pill.
        "mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0.5 align-baseline text-[11px] text-primary transition hover:bg-primary/15",
      )}
    >
      <FileText className="h-3 w-3 shrink-0 opacity-80" aria-hidden="true" />
      <span className="truncate">
        {title ?? slug}
        {anchorLabel ? <span className="opacity-60"> · {anchorLabel}</span> : null}
      </span>
    </button>
  );
}

function humanizeAnchor(anchor: string): string {
  return anchor
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
