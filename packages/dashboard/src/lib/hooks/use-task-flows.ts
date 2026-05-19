"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { TaskFlowListEntry } from "@/lib/api-types";

const LIST_KEY = ["task-flows"];

interface ListResponse {
  userDir: string | null;
  flows: TaskFlowListEntry[];
}

export function useTaskFlows() {
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: () => api.get<ListResponse>("/task-flows"),
    staleTime: 30_000,
  });
}

interface DetailResponse {
  key: string;
  bundled: string | null;
  override: string | null;
  hasOverride: boolean;
}

export function useTaskFlowDetail(key: string | null) {
  return useQuery({
    queryKey: ["task-flow", key],
    queryFn: () =>
      key === null
        ? Promise.reject(new Error("no_key"))
        : api.get<DetailResponse>(`/task-flows/${encodeURIComponent(key)}`),
    enabled: key !== null,
    staleTime: 5_000,
  });
}

export function useUpsertTaskFlow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, content }: { key: string; content: string }) =>
      api.put<{ ok: boolean }>(`/task-flows/${encodeURIComponent(key)}`, {
        content,
      }),
    onSuccess: (_data, { key }) => {
      void qc.invalidateQueries({ queryKey: LIST_KEY });
      void qc.invalidateQueries({ queryKey: ["task-flow", key] });
    },
  });
}

export function useDeleteTaskFlowOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) =>
      api.delete<{ ok: boolean; removed: boolean }>(
        `/task-flows/${encodeURIComponent(key)}`,
      ),
    onSuccess: (_data, key) => {
      void qc.invalidateQueries({ queryKey: LIST_KEY });
      void qc.invalidateQueries({ queryKey: ["task-flow", key] });
    },
  });
}
