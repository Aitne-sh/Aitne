"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

export interface AdvisorResponse {
  enabled: boolean;
  model: string | null;
}

export function useAdvisor(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["backends", "advisor"],
    queryFn: () => api.get<AdvisorResponse>("/backends/advisor"),
    enabled: options?.enabled ?? true,
    staleTime: 60_000,
    retry: false,
  });
}
