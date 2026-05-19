"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { ConversationMessagesResponse } from "@/lib/api-types";

export function useConversationMessages(id: number) {
  return useInfiniteQuery({
    queryKey: ["conversation-messages", id],
    queryFn: ({ pageParam }) =>
      api.get<ConversationMessagesResponse>(`/conversations/${id}/messages`, {
        limit: 50,
        before: pageParam,
      }),
    getNextPageParam: (lastPage) => {
      if (!lastPage.hasMore || lastPage.messages.length === 0) return undefined;
      return lastPage.messages[0].id;
    },
    initialPageParam: undefined as number | undefined,
  });
}
