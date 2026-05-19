/**
 * Cross-mount slide-over open state.
 *
 * `<DocsHelpSlideover>` is mounted exactly once (by `<LayoutShell>`),
 * but multiple call sites need to open it imperatively from outside the
 * React tree — `<DocsHelpButton>`, the `Cmd+K` palette's "Ask docs…"
 * action, the global `?` keypress handler. They all converge on this
 * React Query cache cell.
 *
 * The shape mirrors `qa-cache.ts`: a typed state object stored under a
 * single query key, read via `useQuery` so subscribers stay reactive,
 * written via `setQueryData` from imperative call sites that already
 * have a `QueryClient` in hand. `openDocsHelpSlideover` does NOT call
 * any React hooks — it must be callable from `cmdk-palette.tsx`'s
 * `Command.Item.onSelect`, which runs outside the hook layer.
 *
 * Mirrors `patchDocsQAState`'s shape in `qa-cache.ts`. Don't invent a
 * third pattern (e.g. an `EventTarget`) — DOCS_QA_DASHBOARD_DESIGN.md
 * §6.2 / §9 expect cache-cell semantics so the open/close transitions
 * are visible to React Query devtools.
 */

import { useQuery, type QueryClient } from "@tanstack/react-query";

export interface DocsHelpSlideoverState {
  open: boolean;
  /**
   * `null` means "no docId for the current path". The slide-over still
   * opens but renders a friendly hint instead of a missing doc.
   */
  docId: string | null;
  /** When true, the QA composer auto-focuses on open (Cmd+K → Ask docs…). */
  autoFocusComposer: boolean;
  /**
   * Slugified heading id (e.g. `what-it-does`) to scroll to once the
   * doc loads. Used by the settings-label `?` (DOCS_QA_DESIGN.md §8.4
   * E6) to deep-link into a specific section instead of the doc top.
   * `null` = scroll to top.
   */
  anchor: string | null;
  /**
   * Bumped every time `openDocsHelpSlideover` is invoked so a re-open
   * with the same `(docId, anchor)` re-fires the scroll effect inside
   * `<DocsContent>`. Without this, clicking the same `?` icon a second
   * time after scrolling away would not re-scroll.
   */
  openCount: number;
}

const QUERY_KEY = ["docs-help-slideover"] as const;

const INITIAL: DocsHelpSlideoverState = {
  open: false,
  docId: null,
  autoFocusComposer: false,
  anchor: null,
  openCount: 0,
};

export function getDocsHelpSlideoverState(
  queryClient: QueryClient,
): DocsHelpSlideoverState {
  return (
    queryClient.getQueryData<DocsHelpSlideoverState>(QUERY_KEY) ?? INITIAL
  );
}

/**
 * Subscribe to the slide-over state. Identical pattern to
 * `useDocsQAState` — `useQuery` as a manual state cell.
 */
export function useDocsHelpSlideoverState(): DocsHelpSlideoverState {
  const { data } = useQuery<DocsHelpSlideoverState>({
    queryKey: [...QUERY_KEY],
    queryFn: () => INITIAL,
    initialData: INITIAL,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data ?? INITIAL;
}

/**
 * Imperative open. Used by `<DocsHelpButton>` (no autoFocus), by the
 * `Cmd+K` palette's "Ask docs…" action (autoFocus = true), and by the
 * `?` global keypress handler.
 */
export function openDocsHelpSlideover(
  queryClient: QueryClient,
  options: {
    docId: string | null;
    autoFocusComposer?: boolean;
    anchor?: string | null;
  },
): void {
  const current = getDocsHelpSlideoverState(queryClient);
  queryClient.setQueryData<DocsHelpSlideoverState>(QUERY_KEY, {
    open: true,
    docId: options.docId,
    autoFocusComposer: options.autoFocusComposer ?? false,
    anchor: options.anchor ?? null,
    openCount: current.openCount + 1,
  });
}

export function closeDocsHelpSlideover(queryClient: QueryClient): void {
  const current = getDocsHelpSlideoverState(queryClient);
  queryClient.setQueryData<DocsHelpSlideoverState>(QUERY_KEY, {
    ...current,
    open: false,
    autoFocusComposer: false,
  });
}
