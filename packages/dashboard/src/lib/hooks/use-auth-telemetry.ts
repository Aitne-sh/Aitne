"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { AuthTelemetryResponse } from "@/lib/api-types";

export function useAuthTelemetry(hours = 72) {
  return useQuery({
    queryKey: ["auth-telemetry", hours],
    queryFn: () => api.get<AuthTelemetryResponse>(`/metrics/auth?hours=${hours}`),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
