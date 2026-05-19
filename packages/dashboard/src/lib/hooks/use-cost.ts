"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { CostResponse } from "@/lib/api-types";

export function useCost(period: string = "daily", options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["cost", period],
    queryFn: () => api.get<CostResponse>("/cost", { period }),
    refetchInterval: 60_000,
    enabled: options?.enabled ?? true,
  });
}
