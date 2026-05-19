"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type {
  DelegatedSyncActiveHoursPatch,
  DelegatedSyncCadencePatch,
  DelegatedSyncStatusResponse,
} from "@/lib/api-types";

/**
 * Delegated-sync opt-in dashboard hooks
 * (docs/design/appendices/delegated-sync-opt-in.md).
 *
 * The status query is cheap (read-only worker snapshot) and the dashboard
 * surfaces lastRun / nextRun / circuit state which the user expects to
 * update without a manual refresh — so the staleTime is short and the
 * mutations all invalidate `["delegated-sync"]` to keep the UI synced.
 */

const QUERY_KEY = ["delegated-sync"] as const;

export function useDelegatedSync() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api.get<DelegatedSyncStatusResponse>("/delegated-sync"),
    staleTime: 5_000,
    refetchInterval: 15_000,
  });
}

export function usePatchDelegatedSyncCadence() {
  const qc = useQueryClient();
  return useMutation<
    DelegatedSyncStatusResponse,
    Error,
    { cadenceId: string; body: DelegatedSyncCadencePatch }
  >({
    mutationFn: ({ cadenceId, body }) =>
      api.patch<DelegatedSyncStatusResponse>(
        `/delegated-sync/cadences/${encodeURIComponent(cadenceId)}`,
        body,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}

export function usePatchDelegatedSyncActiveHours() {
  const qc = useQueryClient();
  return useMutation<
    DelegatedSyncStatusResponse,
    Error,
    DelegatedSyncActiveHoursPatch
  >({
    mutationFn: (body) =>
      api.patch<DelegatedSyncStatusResponse>("/delegated-sync/active-hours", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}

export function useRunDelegatedSyncCadence() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, { cadenceId: string }>({
    mutationFn: ({ cadenceId }) =>
      api.post<{ ok: true }>(
        `/delegated-sync/cadences/${encodeURIComponent(cadenceId)}/run`,
        {},
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}
