"use client";

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type {
  DevSessionsResponse,
  DevSessionDetailResponse,
} from "@/lib/dev-sessions/types";

/**
 * Development-mode session list — `GET /api/dev-sessions`. Polls while the page
 * is open (running sessions advance a leg at a time). `keepPreviousData` keeps
 * the list on screen across the poll so `QueryResult` doesn't collapse to a
 * skeleton and bounce the scroll to the top (the documented dashboard pitfall).
 */
export function useDevSessions(filters?: { state?: string; repositoryId?: string }) {
  return useQuery({
    queryKey: ["dev-sessions", filters ?? {}] as const,
    queryFn: () =>
      api.get<DevSessionsResponse>("/dev-sessions", {
        ...(filters?.state ? { state: filters.state } : {}),
        ...(filters?.repositoryId ? { repository_id: filters.repositoryId } : {}),
      }),
    staleTime: 10_000,
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  });
}

/** One session's full projection — `GET /api/dev-sessions/:id`. Polls faster
 *  than the list since the detail view is where the owner watches progress. */
export function useDevSession(id: string | null) {
  return useQuery({
    queryKey: ["dev-session", id] as const,
    queryFn: () => api.get<DevSessionDetailResponse>(`/dev-sessions/${id}`),
    enabled: !!id,
    staleTime: 5_000,
    refetchInterval: 5_000,
    placeholderData: keepPreviousData,
  });
}
