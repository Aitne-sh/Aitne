"use client";

import { ArrowUpRight } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { openDocsHelpSlideover } from "@/lib/docs/slideover-cache";
import { cn } from "@/lib/utils";

interface DocsLearnMoreProps {
  /** Doc to load when clicked. */
  docId: string;
  /** Optional anchor id (slugified heading) to deep-link into. */
  anchor?: string | null;
  /** Visible label. Default: "What is this?". */
  label?: string;
  className?: string;
}

/**
 * Text+arrow CTA used inside empty states, error toasts, and other
 * unobtrusive "operator might want context here" surfaces (DOCS_QA_DESIGN.md
 * §8.4 E7/E8). Opens the docs slide-over rather than navigating to /docs
 * so the operator does not lose place on the current screen.
 */
export function DocsLearnMore({
  docId,
  anchor = null,
  label = "What is this?",
  className,
}: DocsLearnMoreProps) {
  const queryClient = useQueryClient();
  return (
    <button
      type="button"
      onClick={() =>
        openDocsHelpSlideover(queryClient, {
          docId,
          anchor,
          autoFocusComposer: false,
        })
      }
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground",
        className,
      )}
      data-testid="docs-learn-more"
    >
      <span>{label}</span>
      <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
    </button>
  );
}
