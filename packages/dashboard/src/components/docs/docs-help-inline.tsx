"use client";

import { HelpCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { openDocsHelpSlideover } from "@/lib/docs/slideover-cache";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface DocsHelpInlineProps {
  /** Doc to load when the slide-over opens. */
  docId: string;
  /**
   * Optional slugified heading id to scroll to once the doc loads
   * (e.g. `what-it-does`). Lets a settings label deep-link into a
   * specific section of the relevant doc.
   */
  anchor?: string | null;
  /** Tooltip label. Falls back to `Help` for an icon-only affordance. */
  label?: string;
  /** Tightens spacing for inline use against a label or value. */
  className?: string;
}

/**
 * Small `?` icon for inline placement next to a settings label, an
 * empty-state title, or any other dense control where the global header
 * help button is too far away (DOCS_QA_DESIGN.md §8.4 E6, P5 polish).
 *
 * Reuses the `<DocsHelpSlideover>` mounted by `<LayoutShell>`; the
 * `?` icon is purely an opener that pushes a state update through the
 * shared `["docs-help-slideover"]` cache cell.
 */
export function DocsHelpInline({
  docId,
  anchor = null,
  label,
  className,
}: DocsHelpInlineProps) {
  const queryClient = useQueryClient();
  const tip = label ?? "Help";

  // Self-wrap in TooltipProvider so callers (including direct test
  // renders of a settings card) do not need to ship one. Radix supports
  // nesting; the global `<LayoutShell>` provider stays in effect.
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openDocsHelpSlideover(queryClient, {
                docId,
                anchor,
                autoFocusComposer: false,
              });
            }}
            className={cn(
              "inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground/70 transition hover:bg-accent hover:text-foreground",
              className,
            )}
            aria-label={`Open help — ${tip}`}
            data-testid="docs-help-inline"
          >
            <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">
          <span>{tip}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
