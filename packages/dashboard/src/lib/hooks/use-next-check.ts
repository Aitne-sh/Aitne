"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { NextCheckResponse } from "@/lib/api-types";

export function useNextCheck() {
  return useQuery({
    queryKey: ["next-check"],
    queryFn: () => api.get<NextCheckResponse>("/dashboard/next-check"),
    refetchInterval: 30_000,
  });
}
