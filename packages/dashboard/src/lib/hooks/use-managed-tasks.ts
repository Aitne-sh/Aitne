"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  ManagedTask,
  ManagedTaskCreate,
  ManagedTaskPatch,
} from "@aitne/shared";
import type { RecurrenceRule } from "@/lib/api-types";
import { api } from "@/lib/api-client";

const LIST_KEY = ["managed-tasks"] as const;
const HISTORY_KEY = ["management-history"] as const;

export interface ManagedTasksListResponse {
  items: ManagedTask[];
  count: number;
}

export interface ManagedTaskRunHistoryEntry {
  id: number;
  kind: string;
  result: string | null;
  detail: unknown;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ManagementHistoryResponse {
  events: ManagedTaskRunHistoryEntry[];
  /** Smallest id in the page when more rows may exist; `null` at tail. */
  nextCursor: number | null;
}

export interface ManagedTaskRunsResponse {
  runs: ManagedTaskRunHistoryEntry[];
}

/** List active managed tasks (§14.2 GET /managed-tasks). */
export function useManagedTasks() {
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: () => api.get<ManagedTasksListResponse>("/managed-tasks"),
    staleTime: 30_000,
  });
}

/**
 * Fetch a single managed task with its structured `recurrenceRule`.
 * Used by the modify sheet's cadence editor — the rule is read from
 * the joined `recurring_schedules` row server-side, so this is a
 * one-round-trip alternative to GET /recurring-schedules/:id followed
 * by GET /managed-tasks/:id.
 */
export interface ManagedTaskDetailResponse {
  item: ManagedTask;
  recurrenceRule: RecurrenceRule | null;
}

export function useManagedTask(id: string | null) {
  return useQuery({
    queryKey: ["managed-task", id],
    queryFn: () =>
      api.get<ManagedTaskDetailResponse>(`/managed-tasks/${id}`),
    enabled: !!id,
    staleTime: 15_000,
  });
}

/**
 * Aggregate management history (management_task.% + sot_binding.%).
 *
 * Cursor-paginated via `before_id` so the History card can `Load more`
 * past the default 50-row window. The first page comes back without a
 * cursor; each subsequent page sends `before_id = previous nextCursor`.
 * `getNextPageParam` returns `null` at the tail, which React Query
 * surfaces as `hasNextPage === false`.
 */
export function useManagementHistory(limit = 50) {
  return useInfiniteQuery({
    queryKey: [...HISTORY_KEY, limit],
    queryFn: ({ pageParam }) =>
      api.get<ManagementHistoryResponse>("/management-history", {
        limit,
        ...(pageParam ? { before_id: pageParam } : {}),
      }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 15_000,
  });
}

/** Per-row run history (§14.2 GET /managed-tasks/:id/runs). */
export function useManagedTaskRuns(id: string | null, limit = 25) {
  return useQuery({
    queryKey: ["managed-task-runs", id, limit],
    queryFn: () =>
      api.get<ManagedTaskRunsResponse>(`/managed-tasks/${id}/runs`, { limit }),
    enabled: !!id,
    staleTime: 15_000,
  });
}

interface CreatedResponse {
  status: "created" | "idempotent_replay";
  item: ManagedTask;
  render_status?: string;
}

interface UpdatedResponse {
  status: "updated";
  item: ManagedTask;
  render_status?: string;
}

interface DeletedResponse {
  status: "deleted";
  id: string;
  render_status?: string;
}

interface RunNowResponse {
  status: "queued";
  mt_id: string;
  scheduled_row_id: number;
}

function invalidateAll(qc: ReturnType<typeof useQueryClient>): void {
  qc.invalidateQueries({ queryKey: LIST_KEY });
  qc.invalidateQueries({ queryKey: HISTORY_KEY });
  // Single-task detail (item + recurrenceRule) — invalidated as a
  // prefix so any open modify sheet picks up rename / cadence edits.
  qc.invalidateQueries({ queryKey: ["managed-task"] });
  // Recurring schedules are the FK target; create/modify/delete affects them.
  qc.invalidateQueries({ queryKey: ["recurring-schedules"] });
  qc.invalidateQueries({ queryKey: ["schedule-list"] });
  qc.invalidateQueries({ queryKey: ["schedule-next"] });
}

export function useCreateManagedTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ManagedTaskCreate) =>
      api.post<CreatedResponse>("/managed-tasks", input),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useUpdateManagedTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & ManagedTaskPatch) =>
      api.patch<UpdatedResponse>(`/managed-tasks/${id}`, patch),
    onSuccess: (_data, vars) => {
      invalidateAll(qc);
      qc.invalidateQueries({ queryKey: ["managed-task-runs", vars.id] });
    },
  });
}

export function useDeleteManagedTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<DeletedResponse>(`/managed-tasks/${id}`),
    onSuccess: () => invalidateAll(qc),
  });
}

/**
 * `/metrics/managed-tasks` (docs/design/21 §14.3).
 *
 * Returned shape mirrors `ManagementMetricsSnapshot` from the daemon
 * core. Kept structurally typed (Record<string, unknown>) so the
 * dashboard side does not import the daemon's `MetricsCollector`
 * types — tracking that across packages buys little compared with the
 * one source-of-truth type living next to the route.
 */
export interface ManagementMetricsHistogram {
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
}

export interface ManagementMetricsResponse {
  collectedAt: string;
  windowDays: number;
  active: number;
  softWarningThreshold: number;
  hardCap: number;
  runs: { ok: number; failed: number; skipped: number; unknown: number };
  consecutiveFailures: { mtId: string; app: string; count: number }[];
  failureNotifyThreshold: number;
  failingNow: number;
  managementMdRenderMs: ManagementMetricsHistogram;
  activityViewRebuildMs: {
    source: string;
    histogram: ManagementMetricsHistogram;
  }[];
  entityMirrorLag: { lastMs: number | null; observedAt: string | null };
}

export function useManagementMetrics(windowDays = 30) {
  return useQuery({
    queryKey: ["management-metrics", windowDays],
    queryFn: () =>
      api.get<ManagementMetricsResponse>(
        "/metrics/managed-tasks",
        { days: windowDays },
      ),
    // Metrics are best-effort and reset on daemon restart — stale data
    // is harmless. 60s mirrors the cadence of other dashboard metric
    // hooks (use-cost.ts, use-metrics-timeseries.ts).
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

/**
 * Rename a managed task's `app` label (§12 failure-mode recovery).
 *
 * Atomic on the daemon side: the DB rename, audit row, entity-file
 * frontmatter rewrites, and `rules/management.md` re-render are
 * sequenced inside a single route handler. The response carries a
 * `rewrite` summary so the UI can flag entity files that were skipped
 * (e.g. because the new key already exists in their frontmatter).
 *
 * Invalidates both `managed-tasks` and `entities` query keys — the
 * latter so the entity-browser sidebar reflects the new label.
 */
interface RenameAppRewriteSummary {
  rewrote: string[];
  skippedNewKeyExists: string[];
  skippedMultipleVariants: { path: string; variants: string[] }[];
  skippedOldKeyMissing: string[];
  errors: { path: string; reason: string }[];
}

interface RenameAppResponse {
  status: "renamed" | "noop";
  item: ManagedTask | null;
  rewrite?: RenameAppRewriteSummary;
  render_status?: string;
}

export function useRenameManagedTaskApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, newApp }: { id: string; newApp: string }) =>
      api.post<RenameAppResponse>(`/managed-tasks/${id}/rename-app`, {
        newApp,
      }),
    onSuccess: (_data, vars) => {
      invalidateAll(qc);
      qc.invalidateQueries({ queryKey: ["managed-task-runs", vars.id] });
      // The entity browser's "By source" sidebar keys off the user-typed
      // app label; invalidating the entities prefix forces a refetch.
      qc.invalidateQueries({ queryKey: ["entities"] });
      qc.invalidateQueries({ queryKey: ["entities-by-source"] });
    },
  });
}

export function useRunManagedTaskNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.post<RunNowResponse>(`/managed-tasks/${id}/run-now`, { reason }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: HISTORY_KEY });
      qc.invalidateQueries({ queryKey: ["managed-task-runs", vars.id] });
      qc.invalidateQueries({ queryKey: ["schedule-list"] });
    },
  });
}
