"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

export interface LiveOpencodeModel {
  modelId: string;
  shortId: string;
  name: string;
  family: string;
  tier: "lite" | "medium" | "high";
  supportsToolUse: boolean;
  supportsAttachment: boolean;
  supportsReasoning: boolean;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  usdPer1kIn: number | null;
  usdPer1kOut: number | null;
  isFree: boolean;
  status: string;
}

export interface LiveOpencodeProviderGroup {
  id: string;
  name: string;
  source: string;
  models: LiveOpencodeModel[];
}

export interface LiveOpencodeModelsResponse {
  providers: LiveOpencodeProviderGroup[];
  fetchedAt: string;
  cached: boolean;
}

/**
 * Live enumeration of every model the running opencode server can route
 * to. Backed by the daemon's 5-min in-memory cache; the dashboard sets
 * its own staleTime to 5 min so repeated picker opens don't refetch.
 *
 * `enabled` defaults to false because the data is only needed when the
 * picker dialog opens — gate from the caller so the daemon's
 * `client.config.providers()` call doesn't fire on every page render.
 */
export function useOpencodeLiveModels(enabled: boolean) {
  return useQuery<LiveOpencodeModelsResponse>({
    queryKey: ["opencode-live-models"],
    queryFn: () => api.get<LiveOpencodeModelsResponse>("/backends/opencode/live-models"),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** Force-refresh by hitting `?refresh=1`. Use after the operator runs
 *  `opencode auth login` so a newly added provider lights up. */
export function useRefreshOpencodeLiveModels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.get<LiveOpencodeModelsResponse>("/backends/opencode/live-models?refresh=1"),
    onSuccess: (data) => {
      qc.setQueryData(["opencode-live-models"], data);
    },
  });
}
