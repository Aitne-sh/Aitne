"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { CalendarResponse } from "@/lib/api-types";

export function useCalendarEvents() {
  return useQuery({
    queryKey: ["calendar"],
    queryFn: () => api.get<CalendarResponse>("/calendar/events", { date: "today", days: 1 }),
    refetchInterval: 300_000,
  });
}
