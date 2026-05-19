"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useSearchParams } from "next/navigation";
import { docIdForPath } from "@/lib/docs/page-doc-map";
import {
  getDocsHelpSlideoverState,
  openDocsHelpSlideover,
} from "@/lib/docs/slideover-cache";

/**
 * Wires the global `?` keypress to open `<DocsHelpSlideover>` from any
 * dashboard screen (DOCS_QA_DASHBOARD_DESIGN.md §9 / §14 OQ#4).
 *
 * Skip rules — ALL must match before we act:
 *   - the active element is NOT a text-entry surface (input, textarea,
 *     contenteditable). Otherwise typing `?` in chat would open the
 *     slide-over, which is hostile to the operator.
 *   - no modifier keys (`meta`, `ctrl`, `alt`) — only `?` itself, which
 *     on US layouts is `Shift+/`. The `e.shiftKey === true` is implicit
 *     in the character `?`.
 *   - the slide-over isn't already open (avoid focus-trap re-entry).
 *
 * Routing rules:
 *   - on `/docs` the operator already has the inline `<DocsQAPanel>`
 *     onscreen; opening a slide-over with the same qa-cache conversation
 *     would render the transcript twice. Per §14 OQ#4 ("`?` always
 *     opens 'ask docs' — on `/docs` it focuses the composer") we focus
 *     the inline composer instead. If the composer textarea is not in
 *     the DOM (race during route transition) we fall through to the
 *     slide-over so the keystroke is never silently dropped.
 *   - everywhere else, open the slide-over with `autoFocusComposer:
 *     true`. Keyboard intent ⇒ type-now. The `<DocsHelpButton>` click
 *     path keeps `false` — that's the click/lookup posture.
 *
 * Renders nothing — it's a hook adapter.
 */
export function DocsHelpKeybinding() {
  const queryClient = useQueryClient();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== "?") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTextEntryElement(document.activeElement)) return;
      if (getDocsHelpSlideoverState(queryClient).open) return;

      if (pathname === "/docs" || pathname.startsWith("/docs/")) {
        const composer = document.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Question composer"]',
        );
        if (composer) {
          e.preventDefault();
          composer.focus();
          return;
        }
        // Fall through if the inline composer isn't mounted (e.g.
        // narrow-viewport tab-switch fallback hides the QA pane).
      }

      e.preventDefault();
      const docId = docIdForPath(pathname, searchParams);
      openDocsHelpSlideover(queryClient, { docId, autoFocusComposer: true });
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [pathname, queryClient, searchParams]);

  return null;
}

function isTextEntryElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}
