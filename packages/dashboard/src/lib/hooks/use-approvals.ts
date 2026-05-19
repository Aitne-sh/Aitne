"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { ApprovalsResponse } from "@/lib/api-types";

export function useApprovals() {
  return useQuery({
    queryKey: ["approvals"],
    queryFn: () => api.get<ApprovalsResponse>("/approvals"),
    refetchInterval: 15_000,
  });
}

export function useApproveAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post(`/approvals/${id}/approve`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["approvals"] }),
  });
}

export function useDenyAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post(`/approvals/${id}/deny`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["approvals"] }),
  });
}
