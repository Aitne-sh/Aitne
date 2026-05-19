"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MessageCircleQuestion } from "lucide-react";
import { prefillComposerWithSelection } from "@/lib/docs/qa-cache";

interface SelectionAskButtonProps {
  /**
   * Element whose contained selection should anchor the floating button.
   * Selections that span outside the container are ignored — the operator
   * may have selected dashboard chrome or the QA transcript itself.
   */
  containerRef: React.RefObject<HTMLElement | null>;
  /**
   * Optional hook so the parent can scroll the QA composer into view
   * (useful in the slide-over) or open a slide-over from a docs page
   * that doesn't already have the QA panel mounted.
   */
  onAsk?: () => void;
}

interface FloatingPosition {
  top: number;
  left: number;
}

const SELECTION_MIN_LENGTH = 3;

/**
 * Renders a small "Ask about this passage" pill anchored to the end of
 * the current text selection inside `containerRef`. Clicking writes the
 * selected text to the QA cache as a blockquote-prefilled composer
 * draft (DOCS_QA_DESIGN.md §8.2 selection-anchored asking) and invokes
 * the optional `onAsk` callback so the parent can scroll/focus.
 */
export function SelectionAskButton({ containerRef, onAsk }: SelectionAskButtonProps) {
  const [position, setPosition] = useState<FloatingPosition | null>(null);
  const [selectedText, setSelectedText] = useState<string>("");
  const queryClient = useQueryClient();
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    let raf = 0;

    const update = (): void => {
      const sel = document.getSelection();
      const container = containerRef.current;
      if (!sel || sel.isCollapsed || !container) {
        setPosition(null);
        setSelectedText("");
        return;
      }
      const text = sel.toString().trim();
      if (text.length < SELECTION_MIN_LENGTH) {
        setPosition(null);
        setSelectedText("");
        return;
      }
      // Reject selections that don't live inside the content container.
      // `Range.commonAncestorContainer` is a Text node when the selection
      // is fully inside one paragraph, otherwise an Element. Walk up to
      // verify containment — `Node.contains` handles both cases cleanly.
      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        setPosition(null);
        setSelectedText("");
        return;
      }
      const rects = range.getClientRects();
      const last = rects[rects.length - 1];
      if (!last) {
        setPosition(null);
        return;
      }
      // Position the floating button just below the end of the last
      // selection rect, in viewport coordinates. We render it as a
      // `position: fixed` element so the rect doesn't need to be
      // converted into the container's frame. `getClientRects` returns
      // viewport-relative rects so re-reading them on scroll keeps the
      // pill anchored to the selection rather than to the viewport.
      setPosition({ top: last.bottom + 6, left: last.right });
      setSelectedText(text);
    };

    const schedule = (): void => {
      // Debounce to one frame so click + drag selections (and rapid
      // scroll fires) don't jitter.
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };

    document.addEventListener("selectionchange", schedule);
    // Capture-phase scroll listener so we catch scrolls in any
    // ancestor scroll container (the dashboard's `<main>` element is
    // the actual scroller; the article does not get its own scroll).
    // Without this the floating pill drifts away from the selection
    // as soon as the operator scrolls.
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      document.removeEventListener("selectionchange", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(raf);
    };
  }, [containerRef]);

  if (!position) return null;

  return (
    <button
      ref={buttonRef}
      type="button"
      onMouseDown={(e) => {
        // Prevent the click from collapsing the selection before we read it.
        e.preventDefault();
      }}
      onClick={() => {
        prefillComposerWithSelection(queryClient, selectedText);
        // Clear the selection so the floating button vanishes.
        document.getSelection()?.removeAllRanges();
        setPosition(null);
        setSelectedText("");
        onAsk?.();
      }}
      style={{ top: position.top, left: position.left }}
      className="fixed z-30 inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs shadow-md transition hover:bg-accent"
      aria-label="Ask about the selected passage"
    >
      <MessageCircleQuestion className="h-3.5 w-3.5" aria-hidden="true" />
      Ask about this passage
    </button>
  );
}
