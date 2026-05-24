"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { ScheduleWarningIssue } from "@/lib/api-types";

const SCHEDULE_KEYS = ["schedule-list", "schedule-next"] as const;

function invalidateAllSchedule(qc: ReturnType<typeof useQueryClient>) {
  for (const key of SCHEDULE_KEYS) {
    qc.invalidateQueries({ queryKey: [key] });
  }
}

/**
 * Tier is a closed enum (`lite`/`medium`/`high`) — keep the literal
 * union so accidental typos at call sites surface at compile-time. Model
 * is free-form per SCHEDULE_API_REDESIGN_PLAN.md §4.3: legacy aliases
 * (`sonnet`/`opus`), registered IDs (`claude-opus-4-7`), and composite
 * disambiguators (`<backend>/<model>`) are all valid wire values. Server
 * validates and surfaces `schedule.model_unknown` on bad tokens.
 */
export type ScheduleTier = "lite" | "medium" | "high";

export interface ScheduleCreateInput {
  /** ISO8601, must be ≥ 1 minute in the future. */
  time: string;
  taskType: string;
  description: string;
  /** Optional override for the agent body. Min 20 chars when set. */
  prompt?: string;
  /** Free-form model token (alias or registered id). Mutually exclusive with `tier`. */
  model?: string;
  tier?: ScheduleTier;
  taskContext?: Record<string, unknown>;
}

export interface ScheduleUpdateInput {
  id: number;
  /** ISO8601 — only valid for `dm` rows on the daemon side; for non-dm rows time is fixed. */
  time?: string;
  description?: string;
  /** `string` sets the override; `null` clears it; omit for no change. */
  prompt?: string | null;
  message?: string;
  /** Free-form model token; `null` clears any prior pin. */
  model?: string | null;
  /** `null` clears any prior tier pin. */
  tier?: ScheduleTier | null;
  taskContext?: Record<string, unknown>;
}

/**
 * Shape of the daemon's `POST /api/schedule` success response. The
 * route always returns an explicit `warnings: resolved.warnings`, never
 * undefined, so the dashboard can surface §5.0.5 advisories
 * (`schedule.model_deprecated`) without branching on shape.
 */
export interface ScheduleCreateResponse {
  status: "scheduled";
  scheduleId: string;
  scheduledFor?: string;
  warnings: ScheduleWarningIssue[];
}

export interface ScheduleUpdateResponse {
  status: "updated";
  id: number;
  warnings: ScheduleWarningIssue[];
}

export function useCreateSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ScheduleCreateInput) =>
      api.post<ScheduleCreateResponse>("/schedule", input),
    onSuccess: () => invalidateAllSchedule(qc),
  });
}

export function useUpdateSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: ScheduleUpdateInput) =>
      api.patch<ScheduleUpdateResponse>(`/schedule/${id}`, body),
    onSuccess: () => invalidateAllSchedule(qc),
  });
}

export function useCancelSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      api.delete<{ status: "cancelled"; id: number }>(`/schedule/${id}`),
    onSuccess: () => invalidateAllSchedule(qc),
  });
}
