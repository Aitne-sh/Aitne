import { describe, expect, it } from "vitest";
import {
  DASHBOARD_CHAT_SCOPE,
  DOCS_QA_SCOPE,
  DOCS_QA_SCOPE_KEY,
  getConversationScope,
  OWNER_DM_SCOPE,
  THREAD_SCOPE,
} from "./constants.js";

describe("getConversationScope", () => {
  it("routes dashboard DMs to dashboard_chat by default", () => {
    expect(
      getConversationScope({
        platform: "dashboard",
        channel: "dashboard",
        threadId: null,
        isDm: true,
      }),
    ).toEqual({ scope: DASHBOARD_CHAT_SCOPE, scopeKey: "dashboard" });
  });

  it("forks dashboard DMs onto docs_qa when intent is docs_qa", () => {
    expect(
      getConversationScope({
        platform: "dashboard",
        channel: "dashboard",
        threadId: null,
        isDm: true,
        intent: "docs_qa",
      }),
    ).toEqual({ scope: DOCS_QA_SCOPE, scopeKey: DOCS_QA_SCOPE_KEY });
  });

  it("treats explicit intent='chat' as the default chat path", () => {
    expect(
      getConversationScope({
        platform: "dashboard",
        channel: "dashboard",
        threadId: null,
        isDm: true,
        intent: "chat",
      }),
    ).toEqual({ scope: DASHBOARD_CHAT_SCOPE, scopeKey: "dashboard" });
  });

  it("ignores intent on non-dashboard DMs", () => {
    expect(
      getConversationScope({
        platform: "slack",
        channel: "D1",
        threadId: null,
        isDm: true,
        intent: "docs_qa",
      }),
    ).toEqual({ scope: OWNER_DM_SCOPE, scopeKey: "owner" });
  });

  it("ignores intent on channel threads", () => {
    expect(
      getConversationScope({
        platform: "slack",
        channel: "C1",
        threadId: "thread-1",
        isDm: false,
        intent: "docs_qa",
      }),
    ).toEqual({ scope: THREAD_SCOPE, scopeKey: "slack:C1:thread-1" });
  });
});
