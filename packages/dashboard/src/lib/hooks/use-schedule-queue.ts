"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { ScheduleListResponse } from "@/lib/api-types";
import type { ScheduleQueueResponse } from "@/lib/schedule/queue";

/**
 * Upcoming queue — the agent-facing `GET /api/schedule` (defaults to
 * `pending,running`, `scheduled_for ASC`, limit 50): the soonest-first
 * ordering the Queue tab's Upcoming segment needs, which `/schedule/list`
 * (DESC history) cannot provide. Keyed under the `["schedule-list"]` prefix
 * so the existing schedule mutations' invalidation reaches it.
 */
export function useScheduleQueue() {
  return useQuery({
    queryKey: ["schedule-list", "queue"],
    queryFn: () => api.get<ScheduleQueueResponse>("/schedule"),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
}

/**
 * First (newest-first) page of failed runs, for the status strip's
 * "needs attention" figure — `countRecentFailures` trims it to the 24h
 * window client-side.
 */
export function useRecentFailedRuns() {
  return useQuery({
    queryKey: ["schedule-list", "failed-recent"],
    queryFn: () =>
      api.get<ScheduleListResponse>("/schedule/list", {
        page: 1,
        limit: 50,
        status: "failed",
      }),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
}
