"use client";

export interface SessionHistoryFetchDecisionInput {
  isInitialBinding: boolean;
  isReconnect: boolean;
  confirmedSessionId: number | null;
}

export function shouldFetchHistoryOnSessionInfo({
  isInitialBinding,
  isReconnect,
  confirmedSessionId,
}: SessionHistoryFetchDecisionInput): boolean {
  return confirmedSessionId !== null && (isInitialBinding || isReconnect);
}

export interface HistoryReloadAcceptanceInput {
  fetchedMessageCount: number;
  currentRestoredCount: number;
  currentLiveCount: number;
}

export function shouldApplyReloadedHistory({
  fetchedMessageCount,
  currentRestoredCount,
  currentLiveCount,
}: HistoryReloadAcceptanceInput): boolean {
  if (fetchedMessageCount > 0) {
    return true;
  }

  return currentRestoredCount + currentLiveCount === 0;
}
