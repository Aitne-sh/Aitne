"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { MetricsTimeseriesResponse } from "@/lib/api-types";

export function useMetricsTimeseries(days: number = 30, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["metrics-timeseries", days],
    queryFn: () => api.get<MetricsTimeseriesResponse>("/metrics/timeseries", { days }),
    refetchInterval: 60_000,
    enabled: options?.enabled ?? true,
    // Keep the prior window's data on screen while the new range loads.
    // Without this the query key change clears `data`, the metrics block
    // unmounts into a short skeleton, the scroll container collapses, and
    // the page jumps to the top on every Today/7d/30d switch.
    placeholderData: keepPreviousData,
  });
}
