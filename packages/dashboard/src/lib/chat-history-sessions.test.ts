import { describe, expect, it } from "vitest";
import {
  buildChatHistorySessions,
  formatSessionSourcePlatform,
} from "./chat-history-sessions";
import type { ConversationRow } from "./api-types";

function makeConversation(
  overrides: Partial<ConversationRow> = {},
): ConversationRow {
  return {
    id: 1,
    platform: "owner",
    channel_id: "owner",
    thread_id: null,
    model: "gpt-5.4",
    status: "closed",
    message_count: 4,
    started_at: "2026-04-14 08:00:00",
    last_message_at: "2026-04-14 08:10:00",
    summary: null,
    source_platforms: ["dashboard"],
    read_only_from_dashboard: false,
    continue_available: true,
    ...overrides,
  };
}

describe("buildChatHistorySessions", () => {
  it("filters active sessions and keeps browser-only sessions writable in metadata", () => {
    const sessions = buildChatHistorySessions([
      makeConversation({ id: 1, status: "active" }),
      makeConversation({ id: 2, source_platforms: ["dashboard"] }),
    ]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(2);
    expect(sessions[0].sourcePlatforms).toEqual(["dashboard"]);
    expect(sessions[0].sourceSummary).toBe("Browser");
    expect(sessions[0].readOnlyFromDashboard).toBe(false);
    expect(sessions[0].continueAvailable).toBe(true);
  });

  it("marks non-browser and mixed-source sessions read-only", () => {
    const sessions = buildChatHistorySessions([
      makeConversation({ id: 3, source_platforms: ["telegram"] }),
      makeConversation({ id: 4, source_platforms: ["telegram", "dashboard"] }),
    ]);

    expect(sessions[0].readOnlyFromDashboard).toBe(true);
    expect(sessions[0].continueAvailable).toBe(false);
    expect(sessions[0].sourceSummary).toBe("Telegram");
    expect(sessions[1].sourcePlatforms).toEqual(["dashboard", "telegram"]);
    expect(sessions[1].sourceSummary).toBe("Browser + Telegram");
    expect(sessions[1].readOnlyFromDashboard).toBe(true);
    expect(sessions[1].continueAvailable).toBe(false);
  });

  it("falls back to the session platform when message-derived platforms are missing", () => {
    const sessions = buildChatHistorySessions([
      makeConversation({
        id: 5,
        platform: "telegram",
        channel_id: "T1",
        source_platforms: [],
      }),
    ]);

    expect(sessions[0].sourcePlatforms).toEqual(["telegram"]);
    expect(sessions[0].sourceSummary).toBe("Telegram");
  });
});

describe("formatSessionSourcePlatform", () => {
  it("maps known platforms to user-facing labels", () => {
    expect(formatSessionSourcePlatform("dashboard")).toBe("Browser");
    expect(formatSessionSourcePlatform("whatsapp")).toBe("WhatsApp");
  });
});
