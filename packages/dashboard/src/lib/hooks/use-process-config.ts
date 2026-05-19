"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { ProcessConfigResponse } from "@/lib/api-types";

export function useProcessConfig(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["process-config"],
    queryFn: () => api.get<ProcessConfigResponse>("/process-config"),
    enabled: options?.enabled ?? true,
    staleTime: 60_000,
  });
}
