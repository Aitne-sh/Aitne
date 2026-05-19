"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { EventsResponse } from "@/lib/api-types";

export function useEvents(
  filters?: { type?: string; result?: string; days?: string },
  options?: { enabled?: boolean },
) {
  return useInfiniteQuery({
    queryKey: ["events", filters],
    queryFn: ({ pageParam = 1 }) =>
      api.get<EventsResponse>("/events", {
        page: pageParam,
        limit: 50,
        type: filters?.type,
        result: filters?.result,
        days: filters?.days,
      }),
    getNextPageParam: (lastPage) =>
      lastPage.pagination.page < lastPage.pagination.totalPages
        ? lastPage.pagination.page + 1
        : undefined,
    initialPageParam: 1,
    enabled: options?.enabled,
  });
}
