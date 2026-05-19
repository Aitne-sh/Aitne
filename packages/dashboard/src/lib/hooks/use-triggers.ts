"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

export type TriggerDomain = "git";
export type TriggerEventType = "cron.daily" | "cron.weekly";

export interface RecurrenceShape {
  frequency: "daily" | "weekly" | "monthly";
  time: string;
  timezone?: string;
  daysOfWeek?: number[];
  daysOfMonth?: number[];
}

export interface AutomationTriggerDTO {
  id: number;
  domain: TriggerDomain;
  eventType: TriggerEventType;
  prompt: string;
  enabled: boolean;
  recurringScheduleId: number | null;
  recurrence: RecurrenceShape | null;
  nextRunAt: string | null;
  lastRunActionId: number | null;
  lastRunStartedAt: string | null;
  lastRunResult: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TriggerCatalog {
  domain: TriggerDomain;
  events: Array<{
    type: TriggerEventType;
    label: string;
    needsTime: boolean;
    needsDayOfWeek: boolean;
  }>;
}

interface TriggersListResponse {
  items: AutomationTriggerDTO[];
}

interface TriggerCreateInput {
  domain: TriggerDomain;
  eventType: TriggerEventType;
  prompt: string;
  time: string;
  daysOfWeek?: number[];
}

interface TriggerUpdateInput {
  id: number;
  prompt?: string;
  enabled?: boolean;
  time?: string;
  daysOfWeek?: number[];
}

const TRIGGERS_KEY = ["triggers"] as const;
const CATALOG_KEY = (domain: TriggerDomain) => ["triggers", "catalog", domain] as const;

export function useTriggers(domain?: TriggerDomain) {
  return useQuery({
    queryKey: domain ? [...TRIGGERS_KEY, domain] : [...TRIGGERS_KEY],
    queryFn: () =>
      api.get<TriggersListResponse>("/triggers", domain ? { domain } : undefined),
    staleTime: 30_000,
  });
}

export function useTriggerCatalog(domain: TriggerDomain) {
  return useQuery({
    queryKey: CATALOG_KEY(domain),
    queryFn: () => api.get<TriggerCatalog>("/triggers/catalog", { domain }),
    staleTime: 5 * 60_000,
  });
}

export function useCreateTrigger() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TriggerCreateInput) =>
      api.post<{ status: "created"; item: AutomationTriggerDTO }>("/triggers", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TRIGGERS_KEY });
    },
  });
}

export function useUpdateTrigger() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: TriggerUpdateInput) =>
      api.patch<{ status: "updated"; item: AutomationTriggerDTO }>(
        `/triggers/${id}`,
        body,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TRIGGERS_KEY });
    },
  });
}

export function useDeleteTrigger() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<{ status: "deleted"; id: number }>(`/triggers/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TRIGGERS_KEY });
    },
  });
}
