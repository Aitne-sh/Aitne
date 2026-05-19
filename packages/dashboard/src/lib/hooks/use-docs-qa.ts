"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  computeOrphanResetPatch,
  DOCS_QA_RESET_REASON_RECONNECT,
  DOCS_QA_RESET_REASON_STALE,
  DOCS_QA_STALE_BUSY_THRESHOLD_MS,
  getDocsQASessionId,
  patchDocsQAState,
  shouldFireStaleBusy,
  useDocsQAState,
  type DocsQAMessage,
  type DocsQAScope,
  type DocsQAState,
} from "@/lib/docs/qa-cache";

/**
 * How often the stale-busy interval ticks. The threshold check is
 * activity-based (`Date.now() - lastActivityRef`), so the tick rate
 * just bounds how late the recovery banner appears past the threshold.
 * 10s gives a worst-case ~130s wait — still well under the operator's
 * patience for a stuck spinner.
 */
const STALE_BUSY_TICK_MS = 10_000;

/**
 * A new channelId arriving while a turn is in flight implies the
 * previous channelId is dead and the dispatcher's chunks were silently
 * dropped on the adapter's no-op path. Captures both:
 *   - same-mount EventSource auto-reconnect (prev and new are both
 *     UUIDs that differ), and
 *   - new-mount remount with stuck `busy: true` from a previous mount
 *     (prev=null, new=UUID).
 *
 * Defined at module scope so the body is small enough to inline at the
 * call site if the hook ever gains a second consumer.
 */
function isOrphanReconnect(
  prevChannelId: string | null,
  newChannelId: string,
  current: DocsQAState,
): boolean {
  if (!current.busy) return false;
  return prevChannelId !== newChannelId;
}

export interface DocsQASendContextHint {
  currentSlug?: string;
  dashboardPath?: string;
  category?: string;
}

export interface DocsQASendOptions {
  /** Optional per-turn model id from the picker. Forwarded to the
   *  daemon's `qaMessageSchema.modelId` field; the daemon validates
   *  it against the bound backend's light-tier registry before
   *  routing. Omitted → daemon uses process_backend_config defaults. */
  modelId?: string;
}

/**
 * SSE-backed hook driving the Docs Q&A panel
 * (DOCS_QA_B7_DESIGN.md §S10).
 *
 * Intentionally simpler than `useChat`:
 *   - No localStorage / sessionStorage resume — QA is a stateless
 *     lookup, not a chat with persistent transcript (§11.6). The
 *     transcript lives in the cross-mount qa-cache for the lifetime
 *     of the tab session and resets on reload.
 *   - No `?sessionId=` query param on the SSE URL.
 *   - No mid-execute reconnect reconciliation. If the EventSource
 *     drops mid-stream we surface a recoverable error and let the
 *     operator retry; reconnection-with-resume is exactly the
 *     complexity QA opted out of.
 *   - No `continueSession` / `endSession`.
 *
 * Wire shape per the daemon's docs-qa adapter:
 *   - `session_info`: first frame after connect, carries the minted
 *     `channelId` the POST must echo. May fire a second time with
 *     {backend, model} after a turn resolves; we ignore that update
 *     (the chat_meta path covers it for the streaming message).
 *   - `chat_stream`: text deltas after the streaming citation
 *     validator splice. Appended to the trailing assistant message.
 *   - `stream_end`: clears the message's streaming flag and busy.
 *   - `chat_meta`: backend / model / cost for the just-finished turn.
 *   - `chat_error`: surfaces auth-recovery / persistence failures.
 *   - `ping`: keepalive — ignored.
 */
export function useDocsQA(): {
  state: DocsQAState;
  ready: boolean;
  busy: boolean;
  sendMessage(
    content: string,
    contextHint?: DocsQASendContextHint,
    options?: DocsQASendOptions,
  ): Promise<void>;
} {
  const queryClient = useQueryClient();
  const state = useDocsQAState();

  const channelIdRef = useRef<string | null>(null);
  const idCounterRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  // `ready` mirrors `channelIdRef` but as state so the panel re-renders
  // when the SSE first session_info lands. The ref stays as the source
  // of truth for `sendMessage` (no read-during-render).
  const [ready, setReady] = useState(false);
  // Mount timestamp captured once via useState's lazy initializer (the
  // React-blessed way to derive a stable initial value from an impure
  // source — `Date.now()` cannot be called during render directly per
  // the components-and-hooks-must-be-pure rule). Used as the fallback
  // floor for the stale-busy timer before the first SSE activity lands.
  const [mountedAt] = useState<number>(() => Date.now());
  // Last time any signal of progress was observed (POST returning OK,
  // chat_stream / stream_end / chat_meta / chat_error / session_info).
  // Used by the stale-busy interval to decide when an in-flight turn
  // has gone silent past the recovery threshold. Starts `null` so the
  // initial value isn't computed during render; consumers fall back to
  // `mountedAt` while no activity has been observed yet — preserving
  // the "fresh mount doesn't immediately trip the timer" semantic.
  const lastActivityRef = useRef<number | null>(null);

  const nextId = (): string => `qa-${++idCounterRef.current}`;

  // ── Open the SSE channel once per mount ──
  useEffect(() => {
    // Capture the cache key once per effect so it stays referentially
    // stable for the lifetime of this EventSource. Re-reading the
    // sessionId on every render would invalidate `useCallback` deps
    // and resubscribe the stream.
    const sessionId = getDocsQASessionId();
    const queryKey = ["docs-qa", sessionId] as const;
    const readState = (): DocsQAState | undefined =>
      queryClient.getQueryData<DocsQAState>(queryKey);

    const es = new EventSource("/api/docs/qa/stream");
    esRef.current = es;

    es.addEventListener("session_info", (e) => {
      lastActivityRef.current = Date.now();
      try {
        const data = JSON.parse((e as MessageEvent).data) as {
          channelId?: string;
        };
        // The daemon emits two flavors of session_info on this stream:
        //   (1) initial bind from `DocsQAAdapter.registerClient` —
        //       always carries `channelId`, fires once per
        //       open-or-reconnect of the EventSource.
        //   (2) dispatcher mid- or post-execute updates —
        //       carry `{sessionId, model, backend, ...}` but no
        //       `channelId`. The QA panel doesn't surface those today,
        //       so we silently ignore them.
        if (!data.channelId) return;

        const prevChannelId = channelIdRef.current;
        channelIdRef.current = data.channelId;
        setReady(true);

        // Orphan detection (DOCS_QA_B7_DESIGN.md §11.6 / §11.14). When
        // a NEW channelId arrives while a turn is in flight, the
        // dispatcher was streaming chunks to the previous (now-dead)
        // channelId — they were silently dropped on the adapter's
        // `clients.get()` no-op path. Without this gate, `busy` would
        // stay stuck forever and the operator would see "Thinking…"
        // with no recovery path short of a hard refresh. Two real
        // cases:
        //   (a) same-mount EventSource auto-reconnect during a turn
        //       (laptop wake, network blip, proxy idle-timeout) — prev
        //       and new are both UUIDs but differ.
        //   (b) tab navigation away mid-turn → remount → fresh ref →
        //       prev=null, new=UUID; the qa-cache still says busy=true
        //       from the previous mount.
        // Both are captured by the single condition
        // `prevChannelId !== data.channelId`.
        const cur = readState();
        if (cur) {
          const orphanPatch = isOrphanReconnect(prevChannelId, data.channelId, cur)
            ? computeOrphanResetPatch(cur, DOCS_QA_RESET_REASON_RECONNECT)
            : null;
          if (orphanPatch) {
            patchDocsQAState(queryClient, orphanPatch);
            return;
          }
          // Idle reconnect (no turn in flight) — clear the soft
          // "Lost connection — reconnecting…" banner the `onerror`
          // handler set, so it doesn't persist after recovery.
          if (cur.error) {
            patchDocsQAState(queryClient, { error: null });
          }
        }
      } catch {
        // Malformed payload — ignore. The caller will see ready=false
        // and the send button stays disabled.
      }
    });

    es.addEventListener("chat_stream", (e) => {
      lastActivityRef.current = Date.now();
      try {
        const { chunk } = JSON.parse((e as MessageEvent).data) as {
          chunk: string;
        };
        const cur = readState();
        if (!cur) return;
        const last = cur.messages[cur.messages.length - 1];
        if (last && last.role === "assistant" && last.streaming) {
          const updated: DocsQAMessage[] = [
            ...cur.messages.slice(0, -1),
            { ...last, content: last.content + chunk },
          ];
          patchDocsQAState(queryClient, { messages: updated });
        }
        // No streaming placeholder yet — discard. Stream chunks
        // arriving without an open turn are a backend bug; logging is
        // overkill for the dashboard's defense-in-depth posture.
      } catch {
        // ignore
      }
    });

    es.addEventListener("stream_end", () => {
      lastActivityRef.current = Date.now();
      const cur = readState();
      if (!cur) return;
      const last = cur.messages[cur.messages.length - 1];
      if (last && last.role === "assistant" && last.streaming) {
        const updated: DocsQAMessage[] = [
          ...cur.messages.slice(0, -1),
          { ...last, streaming: false },
        ];
        patchDocsQAState(queryClient, { messages: updated, busy: false });
      } else {
        patchDocsQAState(queryClient, { busy: false });
      }
    });

    // The dispatcher emits `chat_meta` (per-turn backend/model/cost)
    // after stream_end. The QA panel doesn't surface that today — the
    // disclaimer at the top renders the binding once — but we still
    // attach a listener that treats it as activity so the stale-busy
    // interval doesn't fire during the brief finalisation window
    // between stream_end and the dispatcher's later sendSessionInfo
    // (cost update). Add real handling here if a future feature needs
    // the per-message model label.
    es.addEventListener("chat_meta", () => {
      lastActivityRef.current = Date.now();
    });

    es.addEventListener("chat_error", (e) => {
      lastActivityRef.current = Date.now();
      try {
        const { message } = JSON.parse((e as MessageEvent).data) as {
          message: string;
        };
        const cur = readState();
        if (cur) {
          const last = cur.messages[cur.messages.length - 1];
          let trimmed = cur.messages;
          if (last && last.role === "assistant" && last.streaming) {
            // Drop an empty placeholder; otherwise the user sees a
            // ghost "Thinking…" bubble alongside the error banner.
            // For a half-streamed bubble, keep the partial content but
            // clear the streaming flag so it stops looking live.
            trimmed
              = last.content.length === 0
                ? cur.messages.slice(0, -1)
                : [
                    ...cur.messages.slice(0, -1),
                    { ...last, streaming: false },
                  ];
          }
          patchDocsQAState(queryClient, {
            messages: trimmed,
            busy: false,
            error: message,
          });
        } else {
          patchDocsQAState(queryClient, { busy: false, error: message });
        }
      } catch {
        // ignore
      }
    });

    es.addEventListener("ping", () => {
      // Pings only count as transport health, not turn progress, so
      // they intentionally do NOT update lastActivityRef — the
      // stale-busy interval should still fire during a turn that has
      // gone silent on the chunks side, even if pings keep arriving.
    });

    es.onerror = () => {
      // Browser auto-reconnects EventSource on its own. Surface a soft
      // warning so a permanently-down stream is visible without
      // declaring the in-flight turn lost yet — the orphan-reconnect
      // path (or, as a fallback, the stale-busy interval below) is what
      // actually clears `busy` and prompts the operator to re-ask.
      const cur = readState();
      if (cur && !cur.error) {
        patchDocsQAState(queryClient, {
          error: "Lost connection to the docs assistant — reconnecting…",
        });
      }
    };

    return () => {
      es.close();
      esRef.current = null;
      channelIdRef.current = null;
      setReady(false);
    };
  }, [queryClient]);

  // ── Stale-busy recovery (DOCS_QA_B7_DESIGN.md §11.14) ──
  //
  // Defense-in-depth for the case the orphan-on-session_info path
  // can't cover: the EventSource fails permanently (no reconnect
  // succeeds, so no fresh session_info ever arrives) AND the daemon
  // still considers the turn in flight. Without this fallback, `busy`
  // stays true forever and the operator sees "Thinking…" with the
  // soft "Lost connection" banner — no recovery short of a hard
  // refresh.
  //
  // Implemented as an interval that ticks every STALE_BUSY_TICK_MS
  // and calls the pure `shouldFireStaleBusy` predicate. When it fires,
  // the same `computeOrphanResetPatch` helper drops the placeholder /
  // preserves partial content / clears busy, and `lastActivityRef` is
  // pushed forward so the recovery message doesn't immediately re-fire
  // on the next tick before React has flushed the patch.
  useEffect(() => {
    const sessionId = getDocsQASessionId();
    const queryKey = ["docs-qa", sessionId] as const;
    const id = setInterval(() => {
      const cur = queryClient.getQueryData<DocsQAState>(queryKey);
      if (!cur) return;
      // `lastActivityRef` is null until the first SSE event lands; fall
      // back to the mount timestamp so the timer doesn't trip during the
      // initial connect window.
      const lastActivity = lastActivityRef.current ?? mountedAt;
      if (!shouldFireStaleBusy(cur, lastActivity, Date.now())) {
        return;
      }
      const patch = computeOrphanResetPatch(cur, DOCS_QA_RESET_REASON_STALE);
      if (patch) {
        patchDocsQAState(queryClient, patch);
        // Suppress an immediate re-fire on the very next tick; the
        // patch itself already cleared `busy`, but keeping the
        // activity timestamp fresh avoids edge cases where a slow
        // React render or an out-of-band cache update leaves the
        // predicate momentarily true again.
        lastActivityRef.current = Date.now();
      }
    }, STALE_BUSY_TICK_MS);
    return () => clearInterval(id);
  }, [queryClient, mountedAt]);

  const sendMessage = useCallback(
    async (
      content: string,
      contextHint?: DocsQASendContextHint,
      options?: DocsQASendOptions,
    ): Promise<void> => {
      const channelId = channelIdRef.current;
      if (!channelId) {
        patchDocsQAState(queryClient, {
          error: "Not connected to the docs assistant. Try refreshing the page.",
        });
        return;
      }
      const trimmed = content.trim();
      if (trimmed.length === 0) return;

      const sessionId = getDocsQASessionId();
      const queryKey = ["docs-qa", sessionId] as const;
      const cur = queryClient.getQueryData<DocsQAState>(queryKey);
      const baseMessages = cur?.messages ?? [];
      const scope: DocsQAScope = cur?.scope ?? "all";

      // Optimistically append the user turn + a streaming placeholder.
      // The SSE chat_stream handler will fill the placeholder in place
      // (no per-chunk array shuffling). On POST failure we strip the
      // placeholder so the user can retry without a stale empty bubble.
      const userMsg: DocsQAMessage = {
        id: nextId(),
        role: "user",
        content: trimmed,
      };
      const placeholder: DocsQAMessage = {
        id: nextId(),
        role: "assistant",
        content: "",
        streaming: true,
      };
      patchDocsQAState(queryClient, {
        messages: [...baseMessages, userMsg, placeholder],
        composerDraft: "",
        busy: true,
        error: null,
      });
      // Reset the stale-busy clock so the 2-minute timer starts from
      // POST time, not from the last unrelated SSE event before this
      // turn began.
      lastActivityRef.current = Date.now();

      try {
        const res = await fetch("/api/docs/qa/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channelId,
            content: trimmed,
            scope,
            ...(contextHint && Object.keys(contextHint).length > 0
              ? { context: contextHint }
              : {}),
            ...(options?.modelId ? { modelId: options.modelId } : {}),
          }),
        });
        if (!res.ok) {
          const errBody = (await res.json().catch(() => null)) as {
            error?: string;
            message?: string;
          } | null;
          // 404 channel_not_connected is the canonical reconnect cue —
          // EventSource auto-reconnects on its own; the operator can
          // retry on the next render.
          const message =
            errBody?.message
            ?? errBody?.error
            ?? `Send failed (HTTP ${res.status})`;
          rollbackOptimisticTurn(queryClient, queryKey, placeholder.id, message);
        }
      } catch (err) {
        const detail = err instanceof TypeError ? err.message : String(err);
        rollbackOptimisticTurn(
          queryClient,
          queryKey,
          placeholder.id,
          `Failed to send question: ${detail}`,
        );
      }
    },
    [queryClient],
  );

  return {
    state,
    ready,
    busy: state.busy,
    sendMessage,
  };
}

/**
 * Drop the optimistic streaming placeholder when the POST fails or
 * throws so the user isn't left staring at an empty assistant bubble
 * that will never fill in. The user message stays — it's a real
 * artifact of the operator's intent and reads naturally as "I asked
 * X, got an error, will try again."
 */
function rollbackOptimisticTurn(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  placeholderId: string,
  errorMessage: string,
): void {
  const cur = queryClient.getQueryData<DocsQAState>(queryKey);
  if (!cur) return;
  patchDocsQAState(queryClient, {
    messages: cur.messages.filter((m) => m.id !== placeholderId),
    busy: false,
    error: errorMessage,
  });
}
