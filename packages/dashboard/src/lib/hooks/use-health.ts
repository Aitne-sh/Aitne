"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { HealthResponse } from "@/lib/api-types";

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => api.get<HealthResponse>("/health"),
    refetchInterval: 10_000,
  });
}
