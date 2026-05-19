"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
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
  });
}
