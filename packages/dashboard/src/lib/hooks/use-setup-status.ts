"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

interface SetupStatus {
  needsSetup: boolean;
  completedAt: string | null;
}

export function useSetupStatus() {
  return useQuery({
    queryKey: ["setup-status"],
    queryFn: () => api.get<SetupStatus>("/setup/status"),
    staleTime: 30_000,
  });
}
