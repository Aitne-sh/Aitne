import { describe, expect, it } from "vitest";
import { buildChatDisplayState } from "./chat-display-state";

describe("buildChatDisplayState", () => {
  it("shows the current session by default and keeps restored app replies visible", () => {
    const state = buildChatDisplayState({
      manualPastSessionId: null,
      pastMessagesError: false,
      pastMessages: ["past-user", "past-assistant"],
      restoredMessages: ["restored-user", "restored-assistant"],
      liveMessages: ["live-user", "live-assistant"],
      busy: false,
    });

    expect(state.activePastId).toBeNull();
    expect(state.isViewingPastSession).toBe(false);
    expect(state.displayMessages).toEqual([
      "restored-user",
      "restored-assistant",
      "live-user",
      "live-assistant",
    ]);
    expect(state.currentSessionMessageCount).toBe(4);
    expect(state.showLiveSessionActivity).toBe(true);
    expect(state.showCurrentSessionControls).toBe(true);
  });

  it("switches to read-only history mode only for an explicit past-session selection", () => {
    const state = buildChatDisplayState({
      manualPastSessionId: 42,
      pastMessagesError: false,
      pastMessages: ["past-user", "past-assistant"],
      restoredMessages: ["restored-user"],
      liveMessages: ["live-assistant"],
      busy: false,
    });

    expect(state.activePastId).toBe(42);
    expect(state.isViewingPastSession).toBe(true);
    expect(state.displayMessages).toEqual(["past-user", "past-assistant"]);
    expect(state.inputDisabled).toBe(true);
    expect(state.inputDisabledMessage).toContain("Viewing history");
    expect(state.showLiveSessionActivity).toBe(false);
    expect(state.showCurrentSessionControls).toBe(false);
  });

  it("falls back to the current session when past-history loading fails", () => {
    const state = buildChatDisplayState({
      manualPastSessionId: 42,
      pastMessagesError: true,
      pastMessages: [],
      restoredMessages: ["restored-user"],
      liveMessages: ["live-assistant"],
      busy: true,
    });

    expect(state.activePastId).toBeNull();
    expect(state.isViewingPastSession).toBe(false);
    expect(state.displayMessages).toEqual(["restored-user", "live-assistant"]);
    expect(state.inputDisabled).toBe(true);
    expect(state.inputDisabledMessage).toBeUndefined();
    expect(state.showLiveSessionActivity).toBe(true);
  });
});
