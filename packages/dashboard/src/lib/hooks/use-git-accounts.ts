"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type {
  GitAccountConfig,
  GitAccountsListEntry,
} from "@/lib/api-types";

const QUERY_KEY = ["git-accounts"];

interface ListResponse {
  accounts: GitAccountsListEntry[];
}

export function useGitAccounts() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api.get<ListResponse>("/git-accounts"),
    staleTime: 30_000,
  });
}

export function useUpsertGitAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      alias,
      payload,
    }: {
      alias: string;
      payload: GitAccountConfig & { token?: string };
    }) =>
      api.put<{ ok: boolean; alias: string }>(`/git-accounts/${alias}`, payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      // Also bust the config query so any consumer that reads
      // `config.gitAccounts` re-renders.
      void qc.invalidateQueries({ queryKey: ["config"] });
    },
  });
}

export function useDeleteGitAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (alias: string) =>
      api.delete<{ ok: boolean }>(`/git-accounts/${alias}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ["config"] });
    },
  });
}

export interface ProbeResponse {
  ok: boolean;
  login?: string;
  host?: string;
  reason?: string;
}

export function useProbeGitAccount() {
  return useMutation({
    mutationFn: (alias: string) =>
      api.post<ProbeResponse>(`/git-accounts/${alias}/probe`, {}),
  });
}
