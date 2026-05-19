"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { MetricsTimeseriesResponse } from "@/lib/api-types";

export function useMetricsTimeseries(days: number = 30, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["metrics-timeseries", days],
    queryFn: () => api.get<MetricsTimeseriesResponse>("/metrics/timeseries", { days }),
    refetchInterval: 60_000,
    enabled: options?.enabled ?? true,
  });
}
