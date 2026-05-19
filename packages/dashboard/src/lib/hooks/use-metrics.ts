"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { MetricsResponse } from "@/lib/api-types";

export function useMetrics(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["metrics"],
    queryFn: () => api.get<MetricsResponse>("/metrics"),
    refetchInterval: 30_000,
    enabled: options?.enabled ?? true,
  });
}
