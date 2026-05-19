import { describe, expect, it } from "vitest";
import { reconcileLiveMessagesAfterHistoryReload } from "./chat-message-reconciliation";

describe("reconcileLiveMessagesAfterHistoryReload", () => {
  it("drops pre-sync and persisted live messages, but keeps post-sync messages", () => {
    const syncStartedAtMs = Date.parse("2026-04-14T10:00:05.000Z");

    const reconciled = reconcileLiveMessagesAfterHistoryReload(
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "new question" },
      ],
      [
        {
          id: "msg-1",
          role: "user",
          content: "hello",
          timestamp: new Date("2026-04-14T10:00:00.000Z"),
        },
        {
          id: "msg-2",
          role: "assistant",
          content: "hi",
          timestamp: new Date("2026-04-14T10:00:01.000Z"),
        },
        {
          id: "msg-3",
          role: "user",
          content: "new question",
          timestamp: new Date("2026-04-14T10:00:06.000Z"),
        },
        {
          id: "msg-4",
          role: "assistant",
          content: "fresh answer",
          timestamp: new Date("2026-04-14T10:00:07.000Z"),
        },
      ],
      syncStartedAtMs,
    );

    expect(reconciled.map((message) => message.id)).toEqual(["msg-4"]);
  });

  it("keeps error messages and drops incomplete streamed messages", () => {
    const syncStartedAtMs = Date.parse("2026-04-14T10:00:05.000Z");

    const reconciled = reconcileLiveMessagesAfterHistoryReload(
      [{ role: "assistant", content: "completed answer" }],
      [
        {
          id: "stream-10",
          role: "assistant",
          content: "partial answer",
          timestamp: new Date("2026-04-14T10:00:06.000Z"),
        },
        {
          id: "msg-11",
          role: "error",
          content: "temporary failure",
          timestamp: new Date("2026-04-14T10:00:07.000Z"),
        },
      ],
      syncStartedAtMs,
    );

    expect(reconciled.map((message) => message.id)).toEqual(["msg-11"]);
  });
});
