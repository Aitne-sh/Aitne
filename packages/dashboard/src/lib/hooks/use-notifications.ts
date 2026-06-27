"use client";

import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { NotificationsResponse } from "@/lib/api-types";

export function useNotifications(
  filters?: { status?: string; priority?: string },
  options?: { enabled?: boolean },
) {
  return useInfiniteQuery({
    queryKey: ["notifications", filters],
    enabled: options?.enabled ?? true,
    queryFn: ({ pageParam = 1 }) =>
      api.get<NotificationsResponse>("/notifications", {
        page: pageParam,
        limit: 50,
        status: filters?.status,
        priority: filters?.priority,
      }),
    getNextPageParam: (lastPage) =>
      lastPage.pagination.page < lastPage.pagination.totalPages
        ? lastPage.pagination.page + 1
        : undefined,
    initialPageParam: 1,
    // Keep the current list on screen while a new filter loads — otherwise
    // the key change clears data, QueryResult collapses to a skeleton, and
    // the page scrolls to the top on every status/priority change.
    placeholderData: keepPreviousData,
  });
}
