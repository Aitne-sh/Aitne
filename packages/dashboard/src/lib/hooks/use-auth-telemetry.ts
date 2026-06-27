"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { AuthTelemetryResponse } from "@/lib/api-types";

export function useAuthTelemetry(hours = 72) {
  return useQuery({
    queryKey: ["auth-telemetry", hours],
    queryFn: () => api.get<AuthTelemetryResponse>(`/metrics/auth?hours=${hours}`),
    staleTime: 60_000,
    refetchInterval: 60_000,
    // Keep the prior window visible while the new hours load — otherwise
    // the key change clears data, the panel collapses to a loading card,
    // and the page scrolls to the top on every 24h/72h toggle.
    placeholderData: keepPreviousData,
  });
}
