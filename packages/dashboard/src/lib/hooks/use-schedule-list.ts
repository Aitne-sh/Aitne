"use client";

import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { ScheduleListResponse } from "@/lib/api-types";

export function useScheduleList(filters?: { status?: string; type?: string }) {
  return useInfiniteQuery({
    queryKey: ["schedule-list", filters],
    queryFn: ({ pageParam = 1 }) =>
      api.get<ScheduleListResponse>("/schedule/list", {
        page: pageParam,
        limit: 20,
        status: filters?.status,
        type: filters?.type,
      }),
    getNextPageParam: (lastPage) =>
      lastPage.pagination.page < lastPage.pagination.totalPages
        ? lastPage.pagination.page + 1
        : undefined,
    initialPageParam: 1,
    // Keep the current list on screen while a new filter loads — otherwise
    // the key change clears data, QueryResult collapses to a skeleton, and
    // the page scrolls to the top on every status/type change.
    placeholderData: keepPreviousData,
  });
}
