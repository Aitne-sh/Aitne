"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { ScheduleNextResponse } from "@/lib/api-types";

export function useScheduleNext() {
  return useQuery({
    queryKey: ["schedule-next"],
    queryFn: () => api.get<ScheduleNextResponse>("/schedule/next"),
    refetchInterval: 30_000,
  });
}
