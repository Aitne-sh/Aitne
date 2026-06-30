"use client";

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { TasksListResponse } from "@/lib/tasks/types";

const KEY = ["tasks"] as const;

/**
 * Unified Task Board inventory — `GET /api/tasks` (read-only, computed on
 * demand by the daemon). `keepPreviousData` keeps the list on screen across
 * refetches so a poll/refresh doesn't collapse `QueryResult` to a skeleton and
 * bounce the page scroll to the top (the documented dashboard pitfall).
 */
export function useTasks() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.get<TasksListResponse>("/tasks"),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}
