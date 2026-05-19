/**
 * Cross-mount QA conversation state.
 *
 * The same conversation must be readable from two mount points
 * (`<DocsQAPanel>` on `/docs` and `<DocsHelpSlideover>` on every other
 * page — DOCS_QA_DASHBOARD_DESIGN.md §6.2). React component state can't
 * cross those boundaries, so we use the React Query cache as a shared
 * state cell keyed by `["docs-qa", sessionId]`.
 *
 * The streaming SSE wiring is deferred until the daemon ships
 * `/api/docs/qa/{messages,stream}`. This module only defines the
 * data shape and the read/write helpers so the SSE swap is additive.
 */

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

export type DocsQAScope = "all" | "current" | "category";

export interface DocsQAMessage {
  /** mulberry-stable across renders (NOT crypto-random per render). */
  id: string;
  role: "user" | "assistant";
  /** Markdown source (assistant text may include `[doc:slug#anchor]` tokens). */
  content: string;
  /** Set on the assistant message while it is streaming. */
  streaming?: boolean;
}

export interface DocsQAState {
  sessionId: string;
  /** Active scope of the QA panel. */
  scope: DocsQAScope;
  /** Conversation transcript. Empty until the operator sends. */
  messages: DocsQAMessage[];
  /** Operator-prefilled composer text (e.g. from selection-ask). */
  composerDraft: string;
  /** True between the moment we POST and the SSE stream end. */
  busy: boolean;
  /** Most recent send error, if any. */
  error: string | null;
}

const SESSION_STORAGE_KEY = "pa-docs-qa-session";

function readSessionId(): string {
  if (typeof window === "undefined") return "ssr";
  const existing = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (existing) return existing;
  // Prefer crypto.randomUUID; fall back to a Math.random-derived id when
  // the environment doesn't provide one (older test envs).
  const fresh =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `s-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
  window.sessionStorage.setItem(SESSION_STORAGE_KEY, fresh);
  return fresh;
}

export function getDocsQASessionId(): string {
  return readSessionId();
}

export function clearDocsQASession(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
}

function emptyState(sessionId: string): DocsQAState {
  return {
    sessionId,
    scope: "all",
    messages: [],
    composerDraft: "",
    busy: false,
    error: null,
  };
}

function queryKey(sessionId: string): readonly unknown[] {
  return ["docs-qa", sessionId] as const;
}

/**
 * Read or initialise the QA state for the current tab session.
 *
 * Implementation note: React Query doesn't have a first-class
 * "non-fetching state cell" primitive. We use `useQuery` with a
 * `queryFn` that returns the current cached value (or the empty
 * initial state) so subscribers stay reactive when other code paths
 * call `setQueryData`. The mutation primitive isn't appropriate here
 * because mutations don't have query-key caches.
 */
export function useDocsQAState(): DocsQAState {
  const queryClient = useQueryClient();
  const sessionId = getDocsQASessionId();
  const initial = emptyState(sessionId);
  const { data } = useQuery<DocsQAState>({
    queryKey: queryKey(sessionId),
    queryFn: () =>
      queryClient.getQueryData<DocsQAState>(queryKey(sessionId)) ?? initial,
    initialData: initial,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data ?? initial;
}

/** Imperative writer used by selection-ask and the (future) SSE hook. */
export function patchDocsQAState(
  queryClient: QueryClient,
  patch: Partial<DocsQAState>,
): void {
  const sessionId = getDocsQASessionId();
  const current =
    queryClient.getQueryData<DocsQAState>(queryKey(sessionId)) ??
    emptyState(sessionId);
  const next: DocsQAState = { ...current, ...patch, sessionId };
  queryClient.setQueryData(queryKey(sessionId), next);
}

/** Reset the conversation but keep the sessionId. */
export function resetDocsQATranscript(queryClient: QueryClient): void {
  patchDocsQAState(queryClient, {
    messages: [],
    composerDraft: "",
    busy: false,
    error: null,
  });
}

/**
 * User-facing reasons surfaced when an in-flight QA turn is recovered
 * from an orphaned wire. Exported as constants so the SSE hook and
 * unit tests share a single source of truth.
 *
 * Reconnect: the EventSource auto-reconnected during a turn (laptop
 * wake, network blip, proxy idle-timeout). The new channelId is fresh,
 * so the chunks the dispatcher emitted to the dead old channelId were
 * silently dropped. Re-ask is the only safe recovery — we don't fetch
 * the persisted assistant row from the daemon because §11.6 declared
 * QA stateless.
 *
 * Stale: no SSE activity within the threshold while busy. Either the
 * server crashed mid-turn or the EventSource never reconnected after
 * `onerror`. Same recovery path.
 */
export const DOCS_QA_RESET_REASON_RECONNECT =
  "Connection dropped before the answer finished. Please re-ask.";
export const DOCS_QA_RESET_REASON_STALE =
  "No response received within 2 minutes. The connection may have been lost — please re-ask.";

/** Default threshold for `shouldFireStaleBusy` — 2 minutes. */
export const DOCS_QA_STALE_BUSY_THRESHOLD_MS = 120_000;

/**
 * Compute the state patch to recover from an orphaned in-flight turn.
 *
 * Returns `null` when no patch is needed (the turn is not in flight, or
 * recovery has already been applied). When in flight, drops an empty
 * streaming placeholder entirely (avoids a ghost "Thinking…" bubble
 * next to the error banner) and otherwise keeps any partially-streamed
 * content visible by clearing the `streaming` flag — the partial
 * content represents work the user already saw on the wire and
 * shouldn't be silently erased.
 *
 * Pure function so the SSE hook can inline both call sites (orphan
 * reconnect + stale-busy timeout) and the unit tests can exercise
 * every branch without mocking React or EventSource.
 */
export function computeOrphanResetPatch(
  current: DocsQAState,
  reason: string,
): Partial<DocsQAState> | null {
  if (!current.busy) return null;
  const last = current.messages[current.messages.length - 1];
  const isStreamingPlaceholder =
    last !== undefined && last.role === "assistant" && last.streaming === true;
  const messages = isStreamingPlaceholder
    ? last.content.length === 0
      ? current.messages.slice(0, -1)
      : [
          ...current.messages.slice(0, -1),
          { ...last, streaming: false } satisfies DocsQAMessage,
        ]
    : current.messages;
  return { messages, busy: false, error: reason };
}

/**
 * Decide whether the stale-busy timer should reset the in-flight turn.
 *
 * True when a turn is in flight (busy = true) AND no SSE activity has
 * been observed within `thresholdMs`. The default (2 minutes) is
 * comfortable for a max-20-turn QA session (typical 10–30 s; worst
 * case ~60 s); anything longer indicates the SSE connection died
 * without the browser noticing — `onerror` would have flipped the
 * soft "Lost connection" banner, but with no subsequent reconnect the
 * `session_info`-orphan path never fires and the user is stuck.
 */
export function shouldFireStaleBusy(
  current: DocsQAState,
  lastActivityMs: number,
  nowMs: number,
  thresholdMs: number = DOCS_QA_STALE_BUSY_THRESHOLD_MS,
): boolean {
  if (!current.busy) return false;
  return nowMs - lastActivityMs >= thresholdMs;
}

/**
 * Append `text` to the composer draft as a Markdown blockquote, soft-
 * capped at 2000 characters per DOCS_QA_DESIGN.md §8.2 selection-anchored
 * asking. The composer auto-focuses (the consumer hooks the `composerDraft`
 * state and focuses on change).
 */
export function prefillComposerWithSelection(
  queryClient: QueryClient,
  selection: string,
): void {
  const SELECTION_MAX = 2000;
  let trimmed = selection.replace(/\s+$/g, "");
  let truncated = false;
  if (trimmed.length > SELECTION_MAX) {
    trimmed = trimmed.slice(0, SELECTION_MAX);
    truncated = true;
  }
  const blockquoted = trimmed
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const draft =
    `${blockquoted}${truncated ? "\n> … [selection truncated]" : ""}\n\nWhat does this mean?`;
  patchDocsQAState(queryClient, { composerDraft: draft });
}
