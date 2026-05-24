"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type {
  RecurrenceRule,
  RecurringScheduleDTO,
  RecurringSchedulesListResponse,
  ScheduleWarningIssue,
} from "@/lib/api-types";
import type { ScheduleTier } from "@/lib/hooks/use-schedule-mutations";

const KEY = ["recurring-schedules"] as const;

export interface RecurringScheduleCreateInput {
  taskType: string;
  description: string;
  /** Optional override for the agent body. Min 20 chars when set. */
  prompt?: string;
  recurrenceRule: RecurrenceRule;
  /** Free-form model token (alias or registered id). Mutually exclusive with `tier`. */
  model?: string;
  tier?: ScheduleTier;
  taskContext?: Record<string, unknown>;
}

export interface RecurringScheduleUpdateInput {
  id: number;
  description?: string;
  /** `string` sets the override; `null` clears it; omit for no change. */
  prompt?: string | null;
  recurrenceRule?: RecurrenceRule;
  /** Free-form model token; `null` clears any prior pin. */
  model?: string | null;
  /** `null` clears any prior tier pin. */
  tier?: ScheduleTier | null;
  taskContext?: Record<string, unknown>;
  enabled?: boolean;
}

/**
 * The recurring-schedules route always includes `warnings[]` in the
 * 201/200 envelope (concatenation of `resolved.warnings` and
 * `detectOnMissingDayUnusedWarnings(rule)`). Dashboard surfaces them
 * inline so the user sees model-deprecation and no-op-onMissingDay
 * advisories without round-tripping the audit log.
 */
export interface RecurringScheduleCreateResponse {
  status: "created";
  item: RecurringScheduleDTO;
  warnings: ScheduleWarningIssue[];
}

export interface RecurringScheduleUpdateResponse {
  status: "updated";
  item: RecurringScheduleDTO;
  warnings: ScheduleWarningIssue[];
}

export function useRecurringSchedules() {
  return useQuery({
    queryKey: KEY,
    queryFn: () =>
      api.get<RecurringSchedulesListResponse>("/recurring-schedules"),
    staleTime: 30_000,
  });
}

export function useCreateRecurringSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RecurringScheduleCreateInput) =>
      api.post<RecurringScheduleCreateResponse>(
        "/recurring-schedules",
        input,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["schedule-list"] });
      qc.invalidateQueries({ queryKey: ["schedule-next"] });
    },
  });
}

export function useUpdateRecurringSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: RecurringScheduleUpdateInput) =>
      api.patch<RecurringScheduleUpdateResponse>(
        `/recurring-schedules/${id}`,
        body,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["schedule-list"] });
      qc.invalidateQueries({ queryKey: ["schedule-next"] });
    },
  });
}

export function useDeleteRecurringSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      api.delete<{ status: "deleted"; id: number }>(
        `/recurring-schedules/${id}`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["schedule-list"] });
      qc.invalidateQueries({ queryKey: ["schedule-next"] });
    },
  });
}
