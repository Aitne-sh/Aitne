"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
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
  });
}
