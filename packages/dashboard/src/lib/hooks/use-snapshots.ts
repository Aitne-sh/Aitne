"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { SnapshotsResponse, SnapshotContentResponse } from "@/lib/api-types";

export function useSnapshots(filePath: string | null) {
  return useQuery({
    queryKey: ["snapshots", filePath],
    queryFn: () => api.get<SnapshotsResponse>(`/snapshots/${filePath}`),
    enabled: !!filePath,
  });
}

export function useSnapshotContent(id: number | null) {
  return useQuery({
    queryKey: ["snapshot-content", id],
    queryFn: () => api.get<SnapshotContentResponse>(`/snapshots/content/${id}`),
    enabled: id !== null,
  });
}
