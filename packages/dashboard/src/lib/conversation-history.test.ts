import { describe, expect, it, vi } from "vitest";
import { fetchConversationHistory } from "./conversation-history";
import type { ConversationMessagesResponse } from "./api-types";

function makeResponse(body: ConversationMessagesResponse): Response {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe("fetchConversationHistory", () => {
  it("walks all pages and returns messages in chronological order", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({
        messages: [
          { id: 3, role: "user", content: "third", platform: "dashboard", sender_id: null, timestamp: "2026-04-14T10:02:00Z" },
          { id: 4, role: "assistant", content: "fourth", platform: "dashboard", sender_id: null, timestamp: "2026-04-14T10:03:00Z" },
        ],
        hasMore: true,
      }))
      .mockResolvedValueOnce(makeResponse({
        messages: [
          { id: 1, role: "user", content: "first", platform: "dashboard", sender_id: null, timestamp: "2026-04-14T10:00:00Z" },
          { id: 2, role: "assistant", content: "second", platform: "dashboard", sender_id: null, timestamp: "2026-04-14T10:01:00Z" },
        ],
        hasMore: false,
      }));

    const messages = await fetchConversationHistory(42, { fetchImpl: fetchMock as typeof fetch });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/conversations/42/messages?limit=200",
      { signal: undefined },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/conversations/42/messages?limit=200&before=3",
      { signal: undefined },
    );
    expect(messages.map((message) => message.id)).toEqual([1, 2, 3, 4]);
  });

  it("stops when the backend returns an empty page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({
        messages: [],
        hasMore: false,
      }));

    const messages = await fetchConversationHistory(7, { fetchImpl: fetchMock as typeof fetch });

    expect(messages).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops paging when the cursor would repeat", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({
        messages: [
          { id: 8, role: "user", content: "loop", platform: "dashboard", sender_id: null, timestamp: "2026-04-14T10:08:00Z" },
        ],
        hasMore: true,
      }))
      .mockResolvedValueOnce(makeResponse({
        messages: [
          { id: 8, role: "user", content: "loop", platform: "dashboard", sender_id: null, timestamp: "2026-04-14T10:08:00Z" },
        ],
        hasMore: true,
      }));

    const messages = await fetchConversationHistory(8, { fetchImpl: fetchMock as typeof fetch });

    expect(messages.map((message) => message.id)).toEqual([8, 8]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
