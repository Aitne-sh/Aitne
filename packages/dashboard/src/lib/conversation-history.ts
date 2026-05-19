"use client";

import type { ConversationMessagesResponse, MessageRow } from "@/lib/api-types";

const PAGE_LIMIT = 200;

function buildConversationMessagesUrl(conversationId: number, before?: number): string {
  const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  if (before !== undefined) {
    params.set("before", String(before));
  }
  return `/api/conversations/${conversationId}/messages?${params.toString()}`;
}

export async function fetchConversationHistory(
  conversationId: number,
  options?: {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  },
): Promise<MessageRow[]> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const chunks: MessageRow[][] = [];
  let before: number | undefined;

  while (true) {
    const res = await fetchImpl(buildConversationMessagesUrl(conversationId, before), {
      signal: options?.signal,
    });
    if (!res.ok) {
      throw new Error(`Failed to load conversation ${conversationId} history`);
    }

    const data = await res.json() as ConversationMessagesResponse;
    if (data.messages.length === 0) {
      break;
    }

    chunks.push(data.messages);

    if (!data.hasMore) {
      break;
    }

    const oldestMessageId = data.messages[0]?.id;
    if (!oldestMessageId || oldestMessageId === before) {
      break;
    }
    before = oldestMessageId;
  }

  return chunks.reverse().flat();
}
