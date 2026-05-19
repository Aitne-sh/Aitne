"use client";

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { ConfigDefaultsResponse, ConfigResponse } from "@/lib/api-types";

export function useConfig() {
  return useQuery({
    queryKey: ["config"],
    queryFn: () => api.get<ConfigResponse>("/config"),
    staleTime: 60_000,
  });
}

export function useConfigDefaults() {
  const query = useQuery({
    queryKey: ["config-defaults"],
    queryFn: () => api.get<ConfigDefaultsResponse>("/config/defaults"),
    staleTime: Infinity, // defaults never change at runtime
  });

  /** Type-safe default lookup — returns `undefined` when defaults haven't loaded. */
  const df = useCallback(
    <K extends keyof ConfigDefaultsResponse>(key: K): ConfigDefaultsResponse[K] | undefined =>
      query.data?.[key],
    [query.data],
  );

  return { ...query, df };
}
