"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  ArrowUpRight,
  ChevronLeft,
  FileQuestion,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useDoc } from "@/lib/hooks/use-docs";
import {
  closeDocsHelpSlideover,
  useDocsHelpSlideoverState,
} from "@/lib/docs/slideover-cache";
import { DocsContent } from "./docs-content";
import { DocsQAPanel } from "./docs-qa-panel";
import { cn } from "@/lib/utils";

type SlideoverView = "docs" | "qa";

/**
 * The right-aligned ~520px sheet rendered globally by `<LayoutShell>`
 * (DOCS_QA_DASHBOARD_DESIGN.md §6.2). It is mounted exactly once and
 * driven by the `["docs-help-slideover"]` cache cell so any caller in
 * the app — `<DocsHelpButton>`, `Cmd+K` "Ask docs…", the global `?`
 * keypress — can open it without prop drilling.
 *
 * Two views share the slideover frame:
 *   docs : full-height `<DocsContent />` with an "Ask a question" CTA
 *          at the bottom that switches to the QA view
 *   qa   : full-height `<DocsQAPanel />` with a "Back" affordance in
 *          the header that switches back to the docs view
 *
 * Both views stay mounted (toggled with `hidden`) so scroll position
 * and the QA transcript survive a docs⇄qa toggle. The Sheet's built-in
 * top-right close button always closes the entire slideover.
 *
 * Default view: `qa` when the open call passed `autoFocusComposer:true`
 * (the Cmd+K "Ask docs…" path), otherwise `docs`.
 */
export function DocsHelpSlideover() {
  const queryClient = useQueryClient();
  const state = useDocsHelpSlideoverState();
  const pathname = usePathname();
  const composerWrapperRef = useRef<HTMLDivElement>(null);
  const ctaButtonRef = useRef<HTMLButtonElement>(null);

  const [view, setView] = useState<SlideoverView>(
    state.autoFocusComposer ? "qa" : "docs",
  );

  // Reset the view to its default each time the slideover is (re-)opened
  // while already mounted — e.g. the operator clicks `?` on a different
  // settings card after switching to QA. The Sheet unmounts content on
  // close so the from-closed path is handled by useState's lazy init.
  // adjust-state-during-render (React's blessed alternative to
  // setState-in-effect for derived state) — same pattern DocsQAPanel
  // uses for its IME composer-draft mirror.
  const [trackedOpenCount, setTrackedOpenCount] = useState(state.openCount);
  if (state.openCount !== trackedOpenCount) {
    setTrackedOpenCount(state.openCount);
    setView(state.autoFocusComposer ? "qa" : "docs");
  }

  const focusComposer = useCallback(() => {
    window.requestAnimationFrame(() => {
      const ta = composerWrapperRef.current?.querySelector("textarea");
      ta?.focus();
    });
  }, []);

  const onOpenChange = (next: boolean): void => {
    if (!next) closeDocsHelpSlideover(queryClient);
  };

  // When the palette opened us with autoFocusComposer, drop the focus
  // into the QA composer once the sheet has mounted.
  useEffect(() => {
    if (!state.open || !state.autoFocusComposer) return;
    focusComposer();
  }, [state.open, state.autoFocusComposer, focusComposer]);

  const onAskCtaClick = (): void => {
    setView("qa");
    focusComposer();
  };

  const onBackToDocs = (): void => {
    setView("docs");
    window.requestAnimationFrame(() => {
      ctaButtonRef.current?.focus();
    });
  };

  return (
    <Sheet open={state.open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="!p-0 flex w-full max-w-[520px] flex-col gap-0 sm:max-w-[520px]"
        aria-describedby={undefined}
      >
        <SlideoverHeader
          docId={state.docId}
          view={view}
          onBackToDocs={onBackToDocs}
        />

        {/* Docs view — kept mounted while in QA so scroll position
            survives a round trip. */}
        <div
          className={cn(
            "min-h-0 flex-1 flex-col border-t border-border",
            view === "docs" ? "flex" : "hidden",
          )}
        >
          <div className="min-h-0 flex-1 overflow-y-auto">
            {state.docId ? (
              <DocsContent
                slug={state.docId}
                compact
                initialAnchor={state.anchor}
                initialAnchorNonce={state.openCount}
                onAsk={onAskCtaClick}
              />
            ) : (
              <NoDocHint />
            )}
          </div>
          <div className="flex flex-shrink-0 flex-col items-center gap-1.5 border-t border-border bg-muted/20 px-4 py-3">
            {/* The CTA copy follows whether a doc is in context: the
                "about this" framing dangles when `<NoDocHint />` is shown
                because there is no "this" to refer to. */}
            <p className="text-[11px] text-muted-foreground">
              {state.docId
                ? "Have a question about this?"
                : "Have a question?"}
            </p>
            <button
              ref={ctaButtonRef}
              type="button"
              onClick={onAskCtaClick}
              className="inline-flex min-w-[200px] items-center justify-center gap-2 rounded-full bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
              aria-label="Switch to the agent chat to ask a question"
              data-testid="docs-help-ask-cta"
            >
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Ask a question</span>
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* QA view — kept mounted while in docs so the transcript and
            composer draft survive a round trip. */}
        <div
          ref={composerWrapperRef}
          className={cn(
            "min-h-0 flex-1 border-t border-border bg-muted/20",
            view === "qa" ? "block" : "hidden",
          )}
        >
          <DocsQAPanel
            scope="all"
            contextHint={{ slug: state.docId, dashboardPath: pathname }}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

interface SlideoverHeaderProps {
  docId: string | null;
  view: SlideoverView;
  onBackToDocs: () => void;
}

function SlideoverHeader({ docId, view, onBackToDocs }: SlideoverHeaderProps) {
  const { data } = useDoc(docId);
  const title = data?.frontmatter.title ?? "Help";
  const segments = docId ? docId.split("/") : [];
  const breadcrumb =
    segments.length > 1
      ? segments.slice(0, -1).join(" / ").replace(/-/g, " ")
      : null;

  return (
    <header className="flex items-start justify-between gap-3 px-5 py-3">
      {/* Both branches yield a single `flex-1` child so `justify-between`
          pushes "Open in /docs" + the close spacer to the right edge in
          either view. Without this, the QA branch (multiple intrinsic-
          width children) lets `justify-between` split the leftover gap
          evenly and "Open in /docs" floats toward the middle. */}
      {view === "qa" ? (
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={onBackToDocs}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground transition",
              "hover:bg-accent hover:text-foreground",
            )}
            aria-label="Close chat and return to the docs view"
            data-testid="docs-help-back-to-docs"
          >
            <ChevronLeft className="h-3 w-3" aria-hidden="true" />
            <span>Back to docs</span>
          </button>
          {/* sr-only title keeps Radix's DialogContent ↔ DialogTitle
              a11y contract intact when the visible heading is hidden
              by the back button. Exactly one SheetTitle is rendered. */}
          <SheetTitle className="sr-only">{title}</SheetTitle>
        </div>
      ) : (
        <div className="min-w-0 flex-1">
          {breadcrumb && (
            <p className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
              {breadcrumb}
            </p>
          )}
          <SheetTitle className="truncate text-base font-semibold">
            {title}
          </SheetTitle>
        </div>
      )}
      {docId && (
        <Link
          href={`/docs/${docId}`}
          className={cn(
            "inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground transition",
            "hover:bg-accent hover:text-foreground",
          )}
          aria-label={`Open ${title} in the full /docs view`}
        >
          <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
          <span>Open in /docs</span>
        </Link>
      )}
      {/* Spacer for the absolute close button (`right-4 top-4`) baked
          into SheetContent. Without it, "Open in /docs" would sit under
          the X. */}
      <DialogPrimitive.Close
        aria-hidden="true"
        tabIndex={-1}
        className="invisible h-7 w-7"
      />
    </header>
  );
}

function NoDocHint() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-8 text-center text-muted-foreground">
      <FileQuestion className="h-8 w-8 opacity-60" aria-hidden="true" />
      <p className="text-sm font-medium">No doc tied to this screen yet.</p>
      <p className="max-w-[300px] text-xs">
        You can still ask the agent — questions go against the entire docs
        corpus by default.
      </p>
    </div>
  );
}
