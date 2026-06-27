"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { CostResponse } from "@/lib/api-types";

export function useCost(period: string = "daily", options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["cost", period],
    queryFn: () => api.get<CostResponse>("/cost", { period }),
    refetchInterval: 60_000,
    enabled: options?.enabled ?? true,
    // Keep the prior period's data on screen while the new window loads.
    // Without this the query key change clears `data`, the charts block
    // unmounts into a short skeleton, the scroll container collapses, and
    // the page jumps to the top on every Daily/Weekly/Monthly switch.
    placeholderData: keepPreviousData,
  });
}
