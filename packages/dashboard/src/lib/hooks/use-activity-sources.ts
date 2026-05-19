"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { ActivitySourceRef } from "@/lib/sources";

/**
 * `GET /api/activity-sources` — the wider activity-source union the
 * Memory → Activity tab needs (followups doc Issue 3).
 *
 * Settings → Management still uses `useManagedTasks()` (active rows
 * only) because its UI edits live rows; this hook is for read-only
 * surfaces that should keep showing a stopped task's
 * `_activity/<source>.md` for its 90-day window.
 */

export interface ActivitySourcesResponse {
  items: ActivitySourceRef[];
  windowDays: number;
  cutoffDate: string;
}

export function useActivitySources() {
  return useQuery({
    queryKey: ["activity-sources"],
    queryFn: () => api.get<ActivitySourcesResponse>("/activity-sources"),
    // The reconciler's GC interval is conservative (90-day windowed),
    // so a 60s stale window comfortably absorbs the user opening the
    // Activity tab repeatedly without re-hitting the daemon.
    staleTime: 60_000,
  });
}
