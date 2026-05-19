"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { ScheduleOptionsResponse } from "@/lib/api-types";

/**
 * SCHEDULE_API_REDESIGN_PLAN.md §4.4 — read-only discovery endpoint.
 *
 * Returns the canonical option payload the Schedule UI needs to compose
 * a valid POST: tiers, legacy aliases, registered models grouped by
 * backend (with deprecated flags), recurrence enums + bounds, and the
 * daemon's configured default timezone. The payload only changes when
 * the registry version bumps, so a long staleTime keeps every form
 * sheet from re-issuing the request.
 */
const KEY = ["schedule-options"] as const;

export function useScheduleOptions() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.get<ScheduleOptionsResponse>("/schedule/options"),
    staleTime: 5 * 60_000,
  });
}
