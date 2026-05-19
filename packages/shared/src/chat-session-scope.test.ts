import { describe, expect, it } from "vitest";
import {
  CHAT_SIDEBAR_SCOPES,
  CHAT_SIDEBAR_SCOPE_PARAM,
  isChatSidebarScope,
} from "./chat-session-scope.js";

describe("chat sidebar scopes", () => {
  it("keeps the query-param form in sync with the source scopes", () => {
    expect(CHAT_SIDEBAR_SCOPE_PARAM).toBe(CHAT_SIDEBAR_SCOPES.join(","));
  });

  it("includes dashboard chat and owner DM sessions in sidebar-visible scopes", () => {
    expect(CHAT_SIDEBAR_SCOPES).toEqual([
      "dashboard_chat",
      "owner_dm",
    ]);
  });

  it("accepts only sidebar-visible session scopes", () => {
    for (const scope of CHAT_SIDEBAR_SCOPES) {
      expect(isChatSidebarScope(scope)).toBe(true);
    }

    expect(isChatSidebarScope("channel_thread")).toBe(false);
    expect(isChatSidebarScope("dashboard")).toBe(false);
    expect(isChatSidebarScope("")).toBe(false);
  });
});
