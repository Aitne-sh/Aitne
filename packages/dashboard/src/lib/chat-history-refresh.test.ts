import { describe, expect, it } from "vitest";
import {
  shouldApplyReloadedHistory,
  shouldFetchHistoryOnSessionInfo,
} from "./chat-history-refresh";

describe("shouldFetchHistoryOnSessionInfo", () => {
  it("restores history on the first binding when the server confirms a session", () => {
    expect(
      shouldFetchHistoryOnSessionInfo({
        isInitialBinding: true,
        isReconnect: false,
        confirmedSessionId: 42,
      }),
    ).toBe(true);
  });

  it("restores history after SSE reconnects", () => {
    expect(
      shouldFetchHistoryOnSessionInfo({
        isInitialBinding: false,
        isReconnect: true,
        confirmedSessionId: 42,
      }),
    ).toBe(true);
  });

  it("skips history fetches when no session is confirmed", () => {
    expect(
      shouldFetchHistoryOnSessionInfo({
        isInitialBinding: true,
        isReconnect: false,
        confirmedSessionId: null,
      }),
    ).toBe(false);
  });
});

describe("shouldApplyReloadedHistory", () => {
  it("accepts non-empty history reloads", () => {
    expect(
      shouldApplyReloadedHistory({
        fetchedMessageCount: 2,
        currentRestoredCount: 1,
        currentLiveCount: 1,
      }),
    ).toBe(true);
  });

  it("rejects empty reloads while a transcript is already visible", () => {
    expect(
      shouldApplyReloadedHistory({
        fetchedMessageCount: 0,
        currentRestoredCount: 1,
        currentLiveCount: 1,
      }),
    ).toBe(false);
  });

  it("allows an empty reload only when the current view is already empty", () => {
    expect(
      shouldApplyReloadedHistory({
        fetchedMessageCount: 0,
        currentRestoredCount: 0,
        currentLiveCount: 0,
      }),
    ).toBe(true);
  });
});
