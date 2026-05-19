"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { BackendsResponse } from "@/lib/api-types";

export function useBackends(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["backends"],
    queryFn: () => api.get<BackendsResponse>("/backends"),
    enabled: options?.enabled ?? true,
    staleTime: 60_000,
  });
}
