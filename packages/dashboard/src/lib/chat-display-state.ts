"use client";

export interface ChatDisplayStateInput<TMessage> {
  manualPastSessionId: number | null;
  pastMessagesError: boolean;
  pastMessages: TMessage[];
  restoredMessages: TMessage[];
  liveMessages: TMessage[];
  busy: boolean;
}

export interface ChatDisplayState<TMessage> {
  activePastId: number | null;
  currentSessionMessageCount: number;
  displayMessages: TMessage[];
  inputDisabled: boolean;
  inputDisabledMessage?: string;
  inputPlaceholder?: string;
  isViewingPastSession: boolean;
  showCurrentSessionControls: boolean;
  showLiveSessionActivity: boolean;
}

export function buildChatDisplayState<TMessage>({
  manualPastSessionId,
  pastMessagesError,
  pastMessages,
  restoredMessages,
  liveMessages,
  busy,
}: ChatDisplayStateInput<TMessage>): ChatDisplayState<TMessage> {
  const activePastId = manualPastSessionId && !pastMessagesError
    ? manualPastSessionId
    : null;
  const isViewingPastSession = activePastId !== null;
  const currentSessionMessages = [...restoredMessages, ...liveMessages];

  return {
    activePastId,
    currentSessionMessageCount: currentSessionMessages.length,
    displayMessages: isViewingPastSession ? pastMessages : currentSessionMessages,
    inputDisabled: busy || isViewingPastSession,
    inputDisabledMessage: isViewingPastSession
      ? "Viewing history — switch to Current Session to continue chatting"
      : undefined,
    inputPlaceholder: isViewingPastSession ? "Viewing history..." : undefined,
    isViewingPastSession,
    showCurrentSessionControls: !isViewingPastSession,
    showLiveSessionActivity: !isViewingPastSession,
  };
}
