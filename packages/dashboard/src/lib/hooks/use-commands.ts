"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type {
  CommandsResponse,
  UserBangCommandUpsert,
} from "@/lib/api-types";

const COMMANDS_QUERY_KEY = ["commands"] as const;

export function useCommands() {
  return useQuery({
    queryKey: COMMANDS_QUERY_KEY,
    queryFn: () => api.get<CommandsResponse>("/commands"),
  });
}

export function useCreateCommand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UserBangCommandUpsert) =>
      api.post<CommandsResponse>("/commands", body),
    onSuccess: (data) => {
      queryClient.setQueryData(COMMANDS_QUERY_KEY, data);
    },
  });
}

export function useUpdateCommand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: UserBangCommandUpsert }) =>
      api.put<CommandsResponse>(`/commands/${id}`, body),
    onSuccess: (data) => {
      queryClient.setQueryData(COMMANDS_QUERY_KEY, data);
    },
  });
}

export function useDeleteCommand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<CommandsResponse>(`/commands/${id}`),
    onSuccess: (data) => {
      queryClient.setQueryData(COMMANDS_QUERY_KEY, data);
    },
  });
}
