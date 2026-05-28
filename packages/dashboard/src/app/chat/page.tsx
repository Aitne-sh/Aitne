"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CHAT_SIDEBAR_SCOPE_PARAM,
  DEFAULT_AGENT_DISPLAY_NAME,
} from "@aitne/shared";
import { type InfiniteData, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChatInput } from "@/components/chat/chat-input";
import { ChatModelPicker, type ChatModelOverride } from "@/components/chat/chat-model-picker";
import { MessageBubble } from "@/components/chat/message-bubble";
import { SessionInfoBar } from "@/components/chat/session-info-bar";
import { SessionSidebar, type PastSessionSelection } from "@/components/chat/session-sidebar";
import { ToolProgress } from "@/components/chat/tool-progress";
import { EmptyState } from "@/components/shared/empty-state";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api, ApiError } from "@/lib/api-client";
import type { ConversationsResponse } from "@/lib/api-types";
import { detectBackendFromModel, formatShortModelName } from "@/lib/backend-ui";
import { buildChatDisplayState } from "@/lib/chat-display-state";
import { buildChatHistorySessions } from "@/lib/chat-history-sessions";
import { useChatCurrentBinding } from "@/lib/hooks/use-chat-current-binding";
import { useChat, type ChatAttachment, type ChatMessage } from "@/lib/hooks/use-chat";
import { useConfig } from "@/lib/hooks/use-config";
import { useConversationHistory } from "@/lib/hooks/use-conversation-history";
import { useConversations } from "@/lib/hooks/use-conversations";
import { parseUtcDate } from "@/lib/utils";
import { MessageSquare } from "lucide-react";

/** Only auto-scroll when user is within this distance of the bottom */
const SCROLL_THRESHOLD = 100;

export default function ChatPage() {
  const [manualPastSession, setManualPastSession] = useState<PastSessionSelection | null>(null);
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const { data: config } = useConfig();
  const { data: currentBinding } = useChatCurrentBinding();
  const { data: conversationsData } = useConversations({ scope: CHAT_SIDEBAR_SCOPE_PARAM });
  const {
    messages: liveMessages,
    restoredMessages,
    streaming,
    busy,
    toolProgress,
    sessionInfo,
    sendMessage,
    endSession,
    continueSession,
    connected,
    ready,
  } = useChat();
  // Session-scoped model override. `null` means no override — BackendRouter
  // resolves the model from `process_backend_config` for `dashboard.chat`.
  // A non-null `{ backendId, modelId }` is the superset of the legacy
  // sonnet/opus hatch: lets the user pick any registered model on any
  // enabled backend (validated server-side against the enabled-backends +
  // model registry). Resets on session switch.
  const [modelOverride, setModelOverride] = useState<ChatModelOverride>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const pastSessions = useMemo(
    () => buildChatHistorySessions(conversationsData?.pages.flatMap((page) => page.conversations) ?? []),
    [conversationsData],
  );

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    isNearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  const { data: pastMessagesData, isError: pastMessagesError } = useConversationHistory(
    manualPastSession?.id ?? 0,
    {
      enabled: manualPastSession !== null,
    },
  );
  const pastMessages = useMemo<ChatMessage[]>(
    () =>
      manualPastSession
        ? (pastMessagesData ?? []).map((message) => ({
            id: `past-${message.id}`,
            role: message.role as "user" | "assistant",
            content: message.content,
            timestamp: parseUtcDate(message.timestamp),
            ...(message.attachments && message.attachments.length > 0
              ? {
                  attachments: message.attachments.map((att) => ({
                    id: att.id,
                    originalFilename: att.originalFilename,
                    mimeType: att.mimeType,
                    sizeBytes: att.sizeBytes,
                    direction: att.direction,
                    ...(att.caption ? { caption: att.caption } : {}),
                  })),
                }
              : {}),
          }))
        : [],
    [manualPastSession, pastMessagesData],
  );
  const displayState = useMemo(
    () =>
      buildChatDisplayState({
        manualPastSessionId: manualPastSession?.id ?? null,
        pastMessagesError,
        pastMessages,
        restoredMessages,
        liveMessages,
        busy,
      }),
    [busy, liveMessages, manualPastSession, pastMessages, pastMessagesError, restoredMessages],
  );
  const activePastMeta = displayState.activePastId
    ? pastSessions.find((session) => session.id === displayState.activePastId)
    : null;
  const assistantLabel = config?.agentDisplayName ?? DEFAULT_AGENT_DISPLAY_NAME;

  // What to render in the top bar. Priority is past > override > live:
  //   - past: viewing a closed/browser-history session — model comes from
  //     the stored `conversation_sessions.model` row, translated via
  //     formatShortModelName so the raw id ("claude-opus-4-8") renders as
  //     "Opus 4.7" with the correct backend badge color.
  //   - override: the user picked a non-default model in the picker but
  //     hasn't sent a turn yet (sessionInfo still reflects the last
  //     actually-used model). Show the picker's choice so the bar matches
  //     what the next POST will use. After the first turn post-override,
  //     the dispatcher's session_info event updates sessionInfo to the
  //     same values, making this branch redundant but consistent.
  //   - live: no override, no past — pass through the real sessionInfo.
  const effectiveSessionInfo = useMemo(() => {
    if (activePastMeta) {
      return {
        channelId: sessionInfo?.channelId ?? "",
        model: activePastMeta.model,
        modelLabel: formatShortModelName(activePastMeta.model),
        backend: detectBackendFromModel(activePastMeta.model) ?? undefined,
      };
    }
    if (modelOverride) {
      return {
        ...(sessionInfo ?? { channelId: "" }),
        channelId: sessionInfo?.channelId ?? "",
        model: modelOverride.modelId,
        modelLabel: formatShortModelName(modelOverride.modelId),
        backend: modelOverride.backendId,
      };
    }
    return sessionInfo;
  }, [activePastMeta, modelOverride, sessionInfo]);

  // Null the binding when an override or past session is in scope — the
  // binding describes the server-side process-config default, which the
  // user has explicitly overridden (picker) or stepped away from (past).
  const effectiveBinding = useMemo(() => {
    if (displayState.isViewingPastSession || modelOverride) return null;
    return currentBinding ?? null;
  }, [currentBinding, displayState.isViewingPastSession, modelOverride]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && isNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [displayState.displayMessages.length, toolProgress]);

  const handleSend = useCallback(
    (content: string, attachments: ChatAttachment[]) => {
      isNearBottomRef.current = true;
      sendMessage(content, {
        ...(modelOverride
          ? {
              requestedBackendId: modelOverride.backendId,
              requestedModelId: modelOverride.modelId,
            }
          : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      });
    },
    [modelOverride, sendMessage],
  );

  const handleSelectPast = (session: PastSessionSelection) => {
    setManualPastSession(session);
    setModelOverride(null);
  };

  const handleSelectCurrent = () => {
    setManualPastSession(null);
    setModelOverride(null);
  };

  const handleEndSession = useCallback(async () => {
    setManualPastSession(null);
    setModelOverride(null);
    await endSession();
  }, [endSession]);

  const [deleteError, setDeleteError] = useState<string | null>(null);
  useEffect(() => {
    if (!deleteError) return;
    const id = window.setTimeout(() => setDeleteError(null), 5000);
    return () => window.clearTimeout(id);
  }, [deleteError]);

  // ── Optimistic delete helpers ──────────────────────────────────────────
  // The conversations query is an infinite query keyed by ["conversations",
  // { scope, ... }]. Both mutations speak through react-query's optimistic
  // pattern: cancel in-flight refetches, snapshot every matching variant,
  // apply the predicted post-delete state, roll back on error, invalidate
  // on settle. This way the sidebar list reacts to the click immediately
  // (~0 ms) instead of waiting for the server round-trip, and the user
  // doesn't see a misleading "still there" flash before invalidation.
  type ConversationsInfinite = InfiniteData<ConversationsResponse>;
  const snapshotConversationQueries = () =>
    queryClient.getQueriesData<ConversationsInfinite>({
      queryKey: ["conversations"],
    });
  const restoreConversationQueries = (
    snapshot: ReturnType<typeof snapshotConversationQueries>,
  ) => {
    for (const [key, data] of snapshot) {
      queryClient.setQueryData(key, data);
    }
  };

  const deleteOne = useMutation({
    mutationFn: (sessionId: number) =>
      api.delete<{ status: string; deleted: number }>(`/conversations/${sessionId}`),
    onMutate: async (sessionId) => {
      await queryClient.cancelQueries({ queryKey: ["conversations"] });
      const previous = snapshotConversationQueries();
      queryClient.setQueriesData<ConversationsInfinite>(
        { queryKey: ["conversations"] },
        (old) =>
          old && {
            ...old,
            pages: old.pages.map((page) => {
              const kept = page.conversations.filter((c) => c.id !== sessionId);
              const removed = page.conversations.length - kept.length;
              return {
                ...page,
                conversations: kept,
                pagination: {
                  ...page.pagination,
                  total: Math.max(0, page.pagination.total - removed),
                },
              };
            }),
          },
      );
      return { previous };
    },
    onError: (_err, _sessionId, ctx) => {
      if (ctx) restoreConversationQueries(ctx.previous);
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["conversations"] }),
  });

  const deleteAll = useMutation({
    mutationFn: () => api.delete<{ status: string; deleted: number }>("/conversations"),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["conversations"] });
      const previous = snapshotConversationQueries();
      queryClient.setQueriesData<ConversationsInfinite>(
        { queryKey: ["conversations"] },
        (old) =>
          old && {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              conversations: [],
              pagination: { ...page.pagination, total: 0, totalPages: 0 },
            })),
          },
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx) restoreConversationQueries(ctx.previous);
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["conversations"] }),
  });
  const deleteInFlight = deleteOne.isPending || deleteAll.isPending;

  const handleDeletePast = useCallback(
    async (session: PastSessionSelection) => {
      const ok = await confirm({
        title: `Delete session #${session.id}?`,
        description:
          "The transcript and any cached workdir will be removed. This cannot be undone.",
        confirmLabel: "Delete",
        variant: "destructive",
      });
      if (!ok) return;
      setDeleteError(null);
      try {
        await deleteOne.mutateAsync(session.id);
      } catch (err) {
        setDeleteError(err instanceof ApiError ? err.message : "Failed to delete session");
        return;
      }
      // Clear the viewer AFTER the server confirms the delete. The
      // `useConversationHistory` query keys on the session id, not on
      // ["conversations"], so the onSettled invalidate above doesn't
      // trigger a refetch against a now-404 id. Flipping to null only on
      // success preserves the user's view when the delete is rejected
      // (409 active / 403 scope / network error) — rollback restores the
      // list and they can see exactly which session they were trying to
      // delete without having to re-open it.
      setManualPastSession((current) => (current?.id === session.id ? null : current));
    },
    [confirm, deleteOne],
  );

  const handleCleanAll = useCallback(async () => {
    // Show the loaded-page count so the operator has some concrete sense of
    // scale. The server deletes every matching row regardless of pagination,
    // and the description calls that out explicitly.
    const visibleCount = pastSessions.length;
    const ok = await confirm({
      title:
        visibleCount > 0
          ? `Delete all ${visibleCount} past session${visibleCount === 1 ? "" : "s"}?`
          : "Delete all past sessions?",
      description:
        "This removes every past dashboard chat AND every owner DM transcript (Telegram/Slack/Discord/WhatsApp) stored on this device. The current active session is kept. If the sidebar has more pages than are loaded, those are deleted too. This cannot be undone.",
      confirmLabel: "Delete all",
      variant: "destructive",
    });
    if (!ok) return;
    setDeleteError(null);
    try {
      await deleteAll.mutateAsync();
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Failed to delete sessions");
      return;
    }
    setManualPastSession(null);
  }, [confirm, deleteAll, pastSessions.length]);

  const handleContinuePast = useCallback(async (session: PastSessionSelection) => {
    // Wait for the server round-trip before leaving the past-session view.
    // If the server rejects the resume (403/404/409/503) we stay on the
    // past-session tab so the operator can see which session they were
    // trying to resume and retry; flipping to the current-session tab
    // eagerly would drop that context and leave only a disconnected
    // error message in the otherwise empty live view.
    const ok = await continueSession(session.id);
    if (ok) {
      setManualPastSession(null);
      setModelOverride(null);
    }
  }, [continueSession]);

  const inputDisabled = displayState.inputDisabled || !ready;
  const inputDisabledMessage = displayState.inputDisabled
    ? activePastMeta
      ? activePastMeta.readOnlyFromDashboard
        ? `Viewing ${activePastMeta.sourceSummary} history — read-only`
        : activePastMeta.continueAvailable
          ? "Viewing browser history — use Continue to resume this session"
          : "Viewing browser history — this session can no longer be resumed"
      : displayState.inputDisabledMessage
    : "Connecting — please wait a moment";
  const inputPlaceholder = ready
    ? activePastMeta
      ? `Viewing ${activePastMeta.sourceSummary} history...`
      : displayState.inputPlaceholder
    : "Connecting...";

  return (
    <div className="flex h-full">
      <SessionSidebar
        pastSessions={pastSessions}
        currentSessionInfo={connected ? sessionInfo : null}
        currentMessageCount={displayState.currentSessionMessageCount}
        activePastId={displayState.activePastId}
        onSelectPast={handleSelectPast}
        onContinuePast={handleContinuePast}
        onSelectCurrent={handleSelectCurrent}
        onEndSession={handleEndSession}
        onDeletePast={handleDeletePast}
        onCleanAll={handleCleanAll}
        deleteInFlight={deleteInFlight}
        deleteError={deleteError}
        onDismissDeleteError={() => setDeleteError(null)}
      />

      <div className="flex flex-1 flex-col">
        <SessionInfoBar
          sessionInfo={effectiveSessionInfo}
          binding={effectiveBinding}
          sessionSourceLabel={activePastMeta ? `${activePastMeta.sourceSummary} history` : null}
          readOnly={activePastMeta?.readOnlyFromDashboard ?? false}
          messageCount={displayState.displayMessages.length}
          onEndSession={handleEndSession}
          showEndSession={displayState.showCurrentSessionControls && ready}
        />

        <ScrollArea ref={scrollRef} className="flex-1 p-4">
          <div className="mx-auto max-w-4xl space-y-4">
            {displayState.displayMessages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                assistantLabel={assistantLabel}
              />
            ))}

            {displayState.showLiveSessionActivity && <ToolProgress items={toolProgress} />}

            {displayState.showLiveSessionActivity && busy && !streaming && toolProgress.length === 0 && (
              <div className="flex items-center gap-2 px-2 py-1">
                <span className="flex gap-1">
                  <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground [animation-delay:0ms]" />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground [animation-delay:150ms]" />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground [animation-delay:300ms]" />
                </span>
                <span className="text-xs text-muted-foreground">
                  Agent is processing…
                </span>
              </div>
            )}

            {displayState.showLiveSessionActivity && streaming && (
              <div className="flex justify-start">
                <span className="inline-block h-5 w-1 animate-pulse rounded-full bg-foreground" />
              </div>
            )}

            {displayState.displayMessages.length === 0 && (
              <div className="flex min-h-[60vh] items-center justify-center">
                <EmptyState
                  icon={MessageSquare}
                  title={displayState.isViewingPastSession ? "No saved messages in this session" : "Send a message to start chatting"}
                  description={displayState.isViewingPastSession
                    ? "This saved session has no persisted messages."
                    : "Direct chat with the agent — uses the same backend, context files, and memory as DMs from messaging apps. Long tasks (file edits, tool chains) can take tens of seconds; you'll see live tool progress above. Use the sidebar to open past sessions or end the current one (clears in-memory context but keeps the transcript in Activity → Conversations)."}
                />
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="border-t border-border bg-background">
          <div className="px-4 pt-3">
            <ChatModelPicker
              value={modelOverride}
              onChange={setModelOverride}
              disabled={inputDisabled}
            />
          </div>
          <ChatInput
            onSend={handleSend}
            disabled={inputDisabled}
            className="border-t-0"
            disabledMessage={inputDisabledMessage}
            placeholder={inputPlaceholder}
          />
        </div>
      </div>
    </div>
  );
}
