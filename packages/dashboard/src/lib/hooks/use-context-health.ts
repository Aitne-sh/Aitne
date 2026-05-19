"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type {
  ContextHealthReport,
  ContextRepairStubResponse,
} from "@/lib/api-types";

export function useContextHealth() {
  return useQuery({
    queryKey: ["context-health"],
    queryFn: () => api.get<ContextHealthReport>("/context/health"),
    refetchInterval: 30_000,
  });
}

export function useRepairContextStub() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path }: { path: string }) =>
      api.post<ContextRepairStubResponse>("/context/repair/stub", { path }),
    onSuccess: (_data, { path }) => {
      qc.invalidateQueries({ queryKey: ["context-health"] });
      const dir = path.includes("/") ? path.split("/")[0] : null;
      if (dir) qc.invalidateQueries({ queryKey: ["context-list", dir] });
      qc.invalidateQueries({ queryKey: ["context", path.replace(/\.md$/, "")] });
    },
  });
}
