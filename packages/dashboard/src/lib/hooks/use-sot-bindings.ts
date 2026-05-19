"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SotBinding, SotBindings } from "@aitne/shared";
import { api } from "@/lib/api-client";

const KEY = ["sot-bindings"] as const;

export interface SotBindingsResponse {
  items: SotBindings;
}

interface UpdatedResponse {
  status: "updated";
  items: SotBindings;
  render_status?: string;
}

/** Read all SoT bindings (Section A of management.md). */
export function useSotBindings() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.get<SotBindingsResponse>("/sot-bindings"),
    staleTime: 30_000,
  });
}

/** PUT /sot-bindings — replace the entire list (§10.6 replace-semantics). */
export function useReplaceSotBindings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (items: SotBinding[]) =>
      api.put<UpdatedResponse>("/sot-bindings", items),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["management-history"] });
    },
  });
}
