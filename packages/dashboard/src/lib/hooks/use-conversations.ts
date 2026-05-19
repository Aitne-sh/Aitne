"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { ConversationsResponse } from "@/lib/api-types";

export function useConversations(
  filters?: { platform?: string; status?: string; scope?: string },
  options?: { enabled?: boolean },
) {
  return useInfiniteQuery({
    queryKey: ["conversations", filters],
    queryFn: ({ pageParam = 1 }) =>
      api.get<ConversationsResponse>("/conversations", {
        page: pageParam,
        limit: 20,
        platform: filters?.platform,
        status: filters?.status,
        scope: filters?.scope,
      }),
    getNextPageParam: (lastPage) =>
      lastPage.pagination.page < lastPage.pagination.totalPages
        ? lastPage.pagination.page + 1
        : undefined,
    initialPageParam: 1,
    enabled: options?.enabled ?? true,
  });
}
