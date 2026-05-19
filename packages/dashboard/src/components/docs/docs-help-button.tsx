"use client";

import { HelpCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { openDocsHelpSlideover } from "@/lib/docs/slideover-cache";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface DocsHelpButtonProps {
  /**
   * Doc to load when the slide-over opens. `null` hides the button —
   * matches DOCS_QA_DASHBOARD_DESIGN.md §6.3 ("Pages opt out by passing
   * `docId={null}` … the strip stays mounted but visually empty").
   */
  docId: string | null;
}

/**
 * The `?` icon mounted in the global action strip on every dashboard
 * screen. Renders nothing when `docId === null` so `/docs` (where the
 * help button is redundant) keeps the strip empty rather than offering
 * an open-the-page-you-are-already-on action.
 */
export function DocsHelpButton({ docId }: DocsHelpButtonProps) {
  const queryClient = useQueryClient();
  if (docId === null) return null;

  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() =>
            openDocsHelpSlideover(queryClient, {
              docId,
              autoFocusComposer: false,
            })
          }
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
          aria-label="Open contextual help for this page"
          data-testid="docs-help-button"
        >
          <HelpCircle className="h-4 w-4" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <span>Help · ?</span>
      </TooltipContent>
    </Tooltip>
  );
}
