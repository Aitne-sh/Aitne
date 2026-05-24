"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  shouldApplyReloadedHistory,
  shouldFetchHistoryOnSessionInfo,
} from "@/lib/chat-history-refresh";
import type { ConversationsResponse } from "@/lib/api-types";
import { reconcileLiveMessagesAfterHistoryReload } from "@/lib/chat-message-reconciliation";
import { fetchConversationHistory } from "@/lib/conversation-history";
import { parseUtcDate } from "@/lib/utils";

export interface ChatAttachment {
  id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  caption?: string;
  /** Only present on past-history messages. Live messages get either
   *  direction="inbound" (echoed from the user turn) or "outbound". */
  direction?: "inbound" | "outbound";
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
  timestamp: Date;
  /** Metadata for assistant messages — populated by chat_meta SSE event */
  meta?: {
    backend?: string;
    model?: string;
    durationMs?: number;
    costUsd?: number;
  };
  /** Inbound user-attached files OR outbound agent-generated files
   *  associated with this message. Rendered as thumbnails/download
   *  chips by `MessageBubble`. */
  attachments?: ChatAttachment[];
}

export interface ToolProgressItem {
  tool: string;
  status: string;
}

export interface SessionInfo {
  channelId: string;
  sessionId?: number;
  model?: string;
  backend?: string;
  modelLabel?: string;
  costUsd?: number;
}

// ── localStorage helpers for session persistence ──

const STORAGE_KEY = "pa-chat-sessionId";

function loadStoredSessionId(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const id = Number(raw);
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function saveStoredSessionId(id: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(id));
  } catch { /* quota exceeded — ignore */ }
}

function clearStoredSessionId(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
}

export async function fetchSessionMessages(
  sessionId: number,
  signal?: AbortSignal,
): Promise<ChatMessage[]> {
  const messages = await fetchConversationHistory(sessionId, { signal });

  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((m) => ({
      id: `restored-${m.id}`,
      role: m.role as "user" | "assistant",
      content: m.content,
      timestamp: parseUtcDate(m.timestamp),
      ...(m.attachments && m.attachments.length > 0
        ? {
            attachments: m.attachments.map((att) => ({
              id: att.id,
              originalFilename: att.originalFilename,
              mimeType: att.mimeType,
              sizeBytes: att.sizeBytes,
              direction: att.direction,
              ...(att.caption ? { caption: att.caption } : {}),
            })),
          }
        : {}),
    }));
}

async function fetchActiveDashboardSessionId(
  signal?: AbortSignal,
): Promise<number | null> {
  const params = new URLSearchParams({
    scope: "dashboard_chat",
    status: "active",
    limit: "1",
  });
  const res = await fetch(`/api/conversations?${params.toString()}`, { signal });
  if (!res.ok) {
    throw new Error("Failed to load active dashboard session");
  }

  const body = await res.json() as ConversationsResponse;
  const sessionId = body.conversations[0]?.id;
  return typeof sessionId === "number" && sessionId > 0 ? sessionId : null;
}

/**
 * Chat hook backed by SSE (server→client) + HTTP POST (client→server).
 *
 * Persists the DB session ID to localStorage so chat history survives
 * page reloads and SSE reconnects. On mount, if a stored sessionId exists,
 * the EventSource URL includes it as a query param so the backend can
 * rebind the session's channel_id and the frontend can restore history.
 *
 * On SSE reconnect (within the same component lifetime), the hook performs
 * a catch-up fetch to recover any agent responses that were written to the
 * DB while the connection was down.
 *
 */
export function useChat({ disableHistory = false }: { disableHistory?: boolean } = {}) {
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [toolProgress, setToolProgress] = useState<ToolProgressItem[]>([]);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionVersion, setConnectionVersion] = useState(0);
  /** Messages restored from the DB — baseline history. */
  const [restoredMessages, setRestoredMessages] = useState<ChatMessage[]>([]);
  const streamBufferRef = useRef("");
  const idCounterRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const waitingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const restoredMessagesRef = useRef<ChatMessage[]>([]);
  // Mirrors `sessionInfo.sessionId` so the SSE event handlers — which capture
  // only the first mount's `sessionInfo` — can read the live value. Updated
  // by a dedicated effect below whenever `sessionInfo` changes.
  const sessionIdRef = useRef<number | null>(null);

  const nextId = () => `msg-${++idCounterRef.current}`;

  const WAITING_TIMEOUT_MS = 120_000; // 2 minutes safety net

  const getErrorMessage = useCallback(
    (body: unknown, fallback: string) => {
      const record = body as Record<string, unknown> | null;
      if (typeof record?.message === "string") return record.message;
      if (typeof record?.error === "string") return record.error;
      return fallback;
    },
    [],
  );

  const clearWaitingTimeout = useCallback(() => {
    if (waitingTimeoutRef.current) {
      clearTimeout(waitingTimeoutRef.current);
      waitingTimeoutRef.current = null;
    }
  }, []);

  const startWaiting = useCallback(() => {
    setWaiting(true);
    clearWaitingTimeout();
    waitingTimeoutRef.current = setTimeout(() => {
      setWaiting(false);
    }, WAITING_TIMEOUT_MS);
  }, [clearWaitingTimeout]);

  const stopWaiting = useCallback(() => {
    setWaiting(false);
    clearWaitingTimeout();
  }, [clearWaitingTimeout]);

  const restartClientSession = useCallback((options?: { resumeSessionId?: number }) => {
    if (typeof options?.resumeSessionId === "number" && options.resumeSessionId > 0) {
      saveStoredSessionId(options.resumeSessionId);
    } else {
      clearStoredSessionId();
    }
    streamBufferRef.current = "";
    messagesRef.current = [];
    restoredMessagesRef.current = [];
    sessionIdRef.current = options?.resumeSessionId ?? null;
    stopWaiting();
    setMessages([]);
    setRestoredMessages([]);
    setToolProgress([]);
    setSessionInfo(null);
    setStreaming(false);
    setConnected(false);
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    setConnectionVersion((prev) => prev + 1);
  }, [stopWaiting]);

  // Keep the ref in sync with state so SSE handlers can read the live
  // sessionId without needing to be re-created on every change.
  useEffect(() => {
    sessionIdRef.current = sessionInfo?.sessionId ?? null;
  }, [sessionInfo]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    restoredMessagesRef.current = restoredMessages;
  }, [restoredMessages]);

  useEffect(() => {
    // Check localStorage for a previously active session (skipped when disableHistory=true)
    const storedSessionId = disableHistory ? null : loadStoredSessionId();
    const bootstrapAbort = new AbortController();

    // Build SSE URL with optional sessionId for session rebind
    const sseUrl = storedSessionId
      ? `/api/chat/stream?sessionId=${storedSessionId}`
      : "/api/chat/stream";

    const es = new EventSource(sseUrl);
    esRef.current = es;

    // Track connect count to distinguish initial connect from auto-reconnect.
    // EventSource auto-reconnect fires onopen again with the same URL.
    let connectCount = 0;

    if (!disableHistory) {
      fetchActiveDashboardSessionId(bootstrapAbort.signal).then((activeSessionId) => {
        if (!activeSessionId) {
          clearStoredSessionId();
          return;
        }

        saveStoredSessionId(activeSessionId);
        const syncStartedAtMs = Date.now();
        return fetchSessionMessages(activeSessionId, bootstrapAbort.signal).then((restored) => {
          if (!shouldApplyReloadedHistory({
            fetchedMessageCount: restored.length,
            currentRestoredCount: restoredMessagesRef.current.length,
            currentLiveCount: messagesRef.current.length,
          })) {
            return;
          }
          setRestoredMessages(restored);
          setMessages((prev) =>
            reconcileLiveMessagesAfterHistoryReload(restored, prev, syncStartedAtMs),
          );
        });
      }).catch(() => {});
    }

    es.onopen = () => {
      connectCount++;
      setConnected(true);
      if (connectCount > 1) {
        console.debug("[chat] SSE reconnected");
      } else {
        console.debug("[chat] SSE connected");
      }
    };
    es.onerror = () => {
      setConnected(false);
      setStreaming(false);
      stopWaiting();
      streamBufferRef.current = "";
      console.warn("[chat] SSE connection lost — will auto-reconnect");
    };

    es.addEventListener("session_info", (e) => {
      try {
        const data = JSON.parse(e.data);
        // The server emits two kinds of `session_info` frames:
        //   (1) Initial binding from `DashboardAdapter.registerClient` —
        //       always carries `channelId` and may include `sessionId`
        //       when the resumed id was validated, or omit it when the
        //       adapter considered the stored session stale.
        //   (2) Dispatcher partial updates after resolving the route
        //       (backend/model/modelLabel) or finishing a turn (costUsd).
        //       These never carry `channelId`.
        // Merging (1) over prev silently preserves a stale `sessionId`
        // when the server deliberately omitted it. Replace on initial
        // binding; merge only for dispatcher updates.
        const isInitialBinding = "channelId" in data;
        setSessionInfo((prev) =>
          isInitialBinding ? { ...data } : { ...prev, ...data },
        );

        if (!disableHistory) {
          // Persist sessionId to localStorage for reload resilience
          if (typeof data.sessionId === "number" && data.sessionId > 0) {
            saveStoredSessionId(data.sessionId);
          }

          // If the initial session_info has channelId but no sessionId, and we
          // had a storedSessionId, the backend couldn't rebind (expired/closed).
          // Clear storage so we don't keep retrying a dead session.
          if (
            storedSessionId &&
            "channelId" in data &&
            !("sessionId" in data)
          ) {
            clearStoredSessionId();
          }
        }

        const isReconnect = connectCount > 1;
        const confirmedSessionId =
          typeof data.sessionId === "number" ? data.sessionId : null;

        if (!disableHistory && shouldFetchHistoryOnSessionInfo({
          isInitialBinding,
          isReconnect,
          confirmedSessionId,
        })) {
          const restoreSessionId = confirmedSessionId;
          if (restoreSessionId !== null) {
            const syncStartedAtMs = Date.now();
            fetchSessionMessages(restoreSessionId).then((restored) => {
              if (!shouldApplyReloadedHistory({
                fetchedMessageCount: restored.length,
                currentRestoredCount: restoredMessagesRef.current.length,
                currentLiveCount: messagesRef.current.length,
              })) {
                return;
              }
              setRestoredMessages(restored);
              setMessages((prev) =>
                reconcileLiveMessagesAfterHistoryReload(restored, prev, syncStartedAtMs),
              );
            }).catch(() => {});
          }
        }
      } catch { /* ignore */ }
    });

    es.addEventListener("chat", (e) => {
      try {
        const payload = JSON.parse(e.data) as {
          role: "user" | "assistant";
          content: string;
          attachments?: Omit<ChatAttachment, "direction">[];
        };
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: payload.role,
            content: payload.content,
            timestamp: new Date(),
            ...(payload.attachments && payload.attachments.length > 0
              ? {
                  attachments: payload.attachments.map((att) => ({
                    ...att,
                    direction: "outbound" as const,
                  })),
                }
              : {}),
          },
        ]);
        setToolProgress([]);
        stopWaiting();
      } catch { /* ignore */ }
    });

    es.addEventListener("chat_attachments", (e) => {
      try {
        const { attachments } = JSON.parse((e as MessageEvent).data) as {
          attachments: Array<Omit<ChatAttachment, "direction">>;
        };
        if (!Array.isArray(attachments) || attachments.length === 0) return;
        // Attach to the last assistant message (most recent). If the
        // stream already wrote the assistant bubble via chat_stream, it
        // was tagged with id="stream-*"; if it was a one-shot `chat`
        // event, the attachments field there already handles it.
        setMessages((prev) => {
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].role === "assistant") {
              const updated = [...prev];
              updated[i] = {
                ...updated[i],
                attachments: attachments.map((att) => ({
                  ...att,
                  direction: "outbound" as const,
                })),
              };
              return updated;
            }
          }
          return prev;
        });
      } catch { /* ignore */ }
    });

    es.addEventListener("chat_stream", (e) => {
      try {
        const { chunk } = JSON.parse(e.data);
        setStreaming(true);
        stopWaiting();
        streamBufferRef.current += chunk;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant" && last.id.startsWith("stream-")) {
            return [
              ...prev.slice(0, -1),
              { ...last, content: streamBufferRef.current },
            ];
          }
          return [
            ...prev,
            {
              id: `stream-${idCounterRef.current}`,
              role: "assistant" as const,
              content: streamBufferRef.current,
              timestamp: new Date(),
            },
          ];
        });
      } catch { /* ignore */ }
    });

    es.addEventListener("stream_end", () => {
      setStreaming(false);
      streamBufferRef.current = "";
    });

    es.addEventListener("tool_progress", (e) => {
      try {
        const progress = JSON.parse(e.data) as ToolProgressItem;
        setToolProgress((prev) => {
          const idx = prev.findIndex((p) => p.tool === progress.tool);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = progress;
            return next;
          }
          return [...prev, progress];
        });
      } catch { /* ignore */ }
    });

    es.addEventListener("chat_meta", (e) => {
      try {
        const meta = JSON.parse(e.data);
        setMessages((prev) => {
          // Attach meta to the last assistant message
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].role === "assistant") {
              const updated = [...prev];
              updated[i] = { ...updated[i], meta };
              return updated;
            }
          }
          return prev;
        });

        // `chat_meta` fires after the dispatcher has recorded the complete
        // assistant message to the DB. If the user navigated away and came
        // back mid-execute, stream chunks that were dispatched BEFORE they
        // reconnected went to the old channel and were dropped, so the
        // local `messages` state is missing the head of the reply (or the
        // reply entirely). Refetch history and reconcile so the full
        // assistant turn is surfaced from `messages` rows.
        const sid = sessionIdRef.current;
        if (sid) {
          const syncStartedAtMs = Date.now();
          fetchSessionMessages(sid).then((restored) => {
            if (!shouldApplyReloadedHistory({
              fetchedMessageCount: restored.length,
              currentRestoredCount: restoredMessagesRef.current.length,
              currentLiveCount: messagesRef.current.length,
            })) {
              return;
            }
            setRestoredMessages(restored);
            setMessages((prev) =>
              reconcileLiveMessagesAfterHistoryReload(restored, prev, syncStartedAtMs),
            );
          }).catch(() => { /* network blip — initial connect already fetched; next event retries */ });
        }
      } catch { /* ignore */ }
    });

    es.addEventListener("chat_error", (e) => {
      try {
        const { message } = JSON.parse((e as MessageEvent).data);
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "error", content: message, timestamp: new Date() },
        ]);
        setStreaming(false);
        stopWaiting();
      } catch { /* ignore */ }
    });

    es.addEventListener("ping", () => {});

    return () => {
      bootstrapAbort.abort();
      es.close();
      esRef.current = null;
      setConnected(false);
      clearWaitingTimeout();
    };
  }, [stopWaiting, clearWaitingTimeout, connectionVersion, disableHistory]);

  const sendMessage = useCallback(
    async (
      content: string,
      options?: {
        requestedModel?: "sonnet" | "opus";
        requestedBackendId?: string;
        requestedModelId?: string;
        attachments?: ChatAttachment[];
      },
    ) => {
      if (!sessionInfo?.channelId) return;

      startWaiting();
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: "user",
          content,
          timestamp: new Date(),
          ...(options?.attachments && options.attachments.length > 0
            ? {
                attachments: options.attachments.map((att) => ({
                  ...att,
                  direction: "inbound" as const,
                })),
              }
            : {}),
        },
      ]);

      try {
        const res = await fetch("/api/chat/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channelId: sessionInfo.channelId,
            content,
            ...(options?.requestedModel
              ? { requestedModel: options.requestedModel }
              : {}),
            ...(options?.requestedBackendId && options?.requestedModelId
              ? {
                  requestedBackendId: options.requestedBackendId,
                  requestedModelId: options.requestedModelId,
                }
              : {}),
            ...(options?.attachments && options.attachments.length > 0
              ? { attachmentIds: options.attachments.map((a) => a.id) }
              : {}),
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => null);
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: "error",
              content: getErrorMessage(err, "send failed"),
              timestamp: new Date(),
            },
          ]);
          stopWaiting();
        }
      } catch (err) {
        const detail = err instanceof TypeError ? err.message : String(err);
        console.error("[chat] POST /api/chat/messages failed:", detail);
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "error", content: `Failed to send message: ${detail}`, timestamp: new Date() },
        ]);
        stopWaiting();
      }
    },
    [getErrorMessage, sessionInfo, startWaiting, stopWaiting],
  );

  const endSession = useCallback(async () => {
    if (!sessionInfo?.channelId) return;
    try {
      const res = await fetch("/api/chat/end-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: sessionInfo.channelId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "error",
            content: getErrorMessage(err, "failed to end session"),
            timestamp: new Date(),
          },
        ]);
        return;
      }

      queryClient.invalidateQueries({ queryKey: ["conversations"] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ["chat-current-binding"] }).catch(() => {});
      restartClientSession();
    } catch (err) {
      const detail = err instanceof TypeError ? err.message : String(err);
      console.error("[chat] POST /api/chat/end-session failed:", detail);
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: "error",
          content: `Failed to end session: ${detail}`,
          timestamp: new Date(),
        },
      ]);
    }
  }, [getErrorMessage, queryClient, restartClientSession, sessionInfo]);

  const continueSession = useCallback(async (sessionId: number) => {
    // Emit a one-line trace so DevTools shows the stack that initiated
    // the resume — useful when triaging "my new session got swallowed
    // by an old one" reports. Console-only — no network cost.
    console.debug("[chat] continueSession()", { sessionId });
    try {
      const res = await fetch("/api/chat/continue-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "error",
            content: getErrorMessage(err, "failed to continue session"),
            timestamp: new Date(),
          },
        ]);
        return false;
      }

      const body = await res.json().catch(() => null) as { sessionId?: number } | null;
      const resumedSessionId =
        typeof body?.sessionId === "number" && body.sessionId > 0
          ? body.sessionId
          : sessionId;
      queryClient.invalidateQueries({ queryKey: ["conversations"] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ["chat-current-binding"] }).catch(() => {});
      restartClientSession({ resumeSessionId: resumedSessionId });
      return true;
    } catch (err) {
      const detail = err instanceof TypeError ? err.message : String(err);
      console.error("[chat] POST /api/chat/continue-session failed:", detail);
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: "error",
          content: `Failed to continue session: ${detail}`,
          timestamp: new Date(),
        },
      ]);
      return false;
    }
  }, [getErrorMessage, queryClient, restartClientSession]);

  /** True while the agent is processing (waiting for response or actively streaming) */
  const busy = waiting || streaming;
  const ready = connected && !!sessionInfo?.channelId;

  return {
    messages,
    setMessages,
    restoredMessages,
    setRestoredMessages,
    streaming,
    waiting,
    busy,
    toolProgress,
    sessionInfo,
    sendMessage,
    endSession,
    continueSession,
    connected,
    ready,
  };
}
