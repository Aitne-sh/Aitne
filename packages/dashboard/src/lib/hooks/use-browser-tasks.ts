"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "@/lib/api-client";

/**
 * Dashboard hooks for BROWSER_TASK_REDESIGN_PLAN.md §3 surface.
 *
 * Three React Query keys — chosen so a single `browser_task` SSE event
 * (§9a.5 Shape B) invalidates exactly the three caches the dashboard
 * actually reads from:
 *
 *   ["browser-tasks"]                         — list page
 *   ["browser-tasks", "awaiting-count"]       — nav badge + shell banner
 *                                               + list-page strip
 *   ["browser-tasks", <taskId>]               — detail page
 *
 * Polling cadence matches the existing approvals pattern:
 *   - List: 5s while any non-terminal row is visible, 30s otherwise.
 *           (§9a.2 — the refetch interval is computed dynamically by the
 *           page from the list result.)
 *   - Awaiting count: 30s default. Cheap query (returns `total` only).
 *   - Detail: 5s while non-terminal, 30s otherwise. Same dynamic gate.
 *
 * The SSE invalidation makes the explicit refetch interval a backstop,
 * not the primary update channel.
 */

// ── Wire types — mirror the daemon's `toWire()` shape in
//    `packages/daemon/src/api/routes/browser-task.ts`. Kept narrow so
//    forward-compat additions on the daemon side don't break the
//    dashboard build. ──

export type BrowserTaskState =
  | "pending"
  | "running"
  | "awaiting_user"
  | "final_confirm"
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled"
  | "abandoned";

export const BROWSER_TASK_TERMINAL_STATES: readonly BrowserTaskState[] = [
  "completed",
  "failed",
  "timeout",
  "cancelled",
  "abandoned",
];

export const BROWSER_TASK_NON_TERMINAL_STATES: readonly BrowserTaskState[] = [
  "pending",
  "running",
  "awaiting_user",
  "final_confirm",
];

/** Convenience — the two parked states that mean "the user needs to
 *  act right now". Used by the awaiting-count + cross-cutting surfaces. */
export const BROWSER_TASK_ATTENTION_STATES: readonly BrowserTaskState[] = [
  "awaiting_user",
  "final_confirm",
];

export interface BrowserTaskQueueState {
  waitingForSlot: boolean;
  sitePos: number;
  globalPos: number;
  blockedBy?: string | null;
  blockedByPhase?: "running" | "parked" | null;
}

export interface BrowserTaskRowWire {
  id: string;
  description: string;
  siteKey: string | null;
  extraAllowedHosts: readonly string[];
  originatingChannel: string | null;
  scheduleRowId: number | null;
  requireFinalConfirm: boolean;
  state: BrowserTaskState;
  outcomeDetail: string | null;
  report: string | null;
  effectiveAllowlistRegex: string | null;
  blockedRequestsCount: number;
  extractCharsTotal: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  queueState?: BrowserTaskQueueState | null;
}

export interface BrowserTaskActionLogRow {
  id: number;
  taskId: string;
  stepIndex: number;
  toolName: string;
  args: unknown;
  outcome: string;
  blockedReason: string | null;
  screenshotKey: string | null;
  durationMs: number;
  at: number;
}

export interface BrowserTaskClarificationRow {
  id: string;
  taskId: string;
  question: string;
  contextSummary: string | null;
  screenshotKey: string | null;
  askedAt: number;
  deadlineAt: number;
  answer: string | null;
  answeredAt: number | null;
  resolved: boolean;
}

export interface BrowserTaskDetailWire extends BrowserTaskRowWire {
  actionLog: readonly BrowserTaskActionLogRow[];
  clarifications: readonly BrowserTaskClarificationRow[];
}

export interface BrowserTasksListResponse {
  tasks: readonly BrowserTaskRowWire[];
  total: number;
  limit: number;
  offset: number;
}

export interface BrowserTaskListFilter {
  states?: readonly BrowserTaskState[];
  siteKey?: string | null;
  limit?: number;
  offset?: number;
}

function listParams(filter: BrowserTaskListFilter | undefined): Record<
  string,
  string | number | undefined
> {
  if (!filter) return {};
  const out: Record<string, string | number | undefined> = {};
  if (filter.states && filter.states.length > 0) {
    out.state = filter.states.join(",");
  }
  if (filter.siteKey !== undefined && filter.siteKey !== null) {
    out.siteKey = filter.siteKey;
  }
  if (filter.limit !== undefined) out.limit = filter.limit;
  if (filter.offset !== undefined) out.offset = filter.offset;
  return out;
}

function hasNonTerminal(rows: readonly BrowserTaskRowWire[]): boolean {
  for (const r of rows) {
    if (!BROWSER_TASK_TERMINAL_STATES.includes(r.state)) return true;
  }
  return false;
}

/** List the most recent browser tasks. The page builds the filter chips
 *  + search box around this hook; passing the filter through means a
 *  state-narrowed query gets a smaller payload from the daemon. */
export function useBrowserTasks(filter?: BrowserTaskListFilter) {
  return useQuery({
    queryKey: ["browser-tasks", filter ?? null] as const,
    queryFn: () =>
      api.get<BrowserTasksListResponse>("/browser-task", listParams(filter)),
    // Dynamic refetch — 5s when any non-terminal row visible (active
    // tasks change state quickly), 30s otherwise. SSE invalidation is
    // the primary refresh channel; this is a backstop for SSE outages
    // and for the parked-state deadline countdowns that don't trigger
    // an SSE event on their own.
    refetchInterval: (query) => {
      const data = query.state.data as
        | BrowserTasksListResponse
        | undefined;
      return data && hasNonTerminal(data.tasks) ? 5_000 : 30_000;
    },
  });
}

/** Single-task detail — includes the action log + clarification queue. */
export function useBrowserTask(taskId: string | null | undefined) {
  return useQuery({
    queryKey: ["browser-tasks", taskId ?? "__none__"] as const,
    queryFn: () =>
      api.get<BrowserTaskDetailWire>(`/browser-task/${taskId}`),
    enabled: !!taskId,
    refetchInterval: (query) => {
      const data = query.state.data as BrowserTaskDetailWire | undefined;
      if (!data) return 5_000;
      return BROWSER_TASK_TERMINAL_STATES.includes(data.state)
        ? 30_000
        : 5_000;
    },
  });
}

/** Count + minimal data for tasks awaiting user action (§9a.4). One
 *  cheap query feeds the dashboard-shell banner, the nav-entry red
 *  dot, AND the list-page strip — single source of truth. */
export function useAwaitingBrowserTasksCount() {
  return useQuery({
    queryKey: ["browser-tasks", "awaiting-count"] as const,
    queryFn: () =>
      api.get<BrowserTasksListResponse>("/browser-task", {
        state: BROWSER_TASK_ATTENTION_STATES.join(","),
        // We want the IDs for the banner copy ("Task X is waiting…"),
        // but not the full action log per row. The list endpoint
        // doesn't carry action logs anyway — only the detail endpoint
        // does — so a low limit keeps the payload tiny.
        limit: 10,
      }),
    // 30s — the SSE invalidation drives the freshness; the poll is a
    // backstop for SSE outages and a cap on staleness when the tab
    // sits idle.
    refetchInterval: 30_000,
  });
}

/** Cancel an in-flight or queued task. POST /:id/cancel is `Autonomous`
 *  per §3 — the dashboard call lands as the bearer-authenticated user
 *  but the daemon's tier classification accepts it without a re-prompt. */
export function useCancelBrowserTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, reason }: { taskId: string; reason?: string }) =>
      api.post<{ ok: boolean; row: BrowserTaskRowWire | null }>(
        `/browser-task/${taskId}/cancel`,
        reason ? { reason } : undefined,
      ),
    onSuccess: (_, vars) => {
      // The SSE event will also fire, but invalidating on the mutation
      // round-trip makes the button feel snappy on a slow SSE link.
      queryClient.invalidateQueries({ queryKey: ["browser-tasks"] });
      queryClient.invalidateQueries({
        queryKey: ["browser-tasks", "awaiting-count"],
      });
      queryClient.invalidateQueries({
        queryKey: ["browser-tasks", vars.taskId],
      });
    },
  });
}

/** Re-run a completed/failed/cancelled task as a new POST. Convenience
 *  wrapper around POST /api/browser-task with the original task's body
 *  — the dashboard's "Re-run as new task" button calls this. */
export function useReRunBrowserTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      description: string;
      requireFinalConfirm: boolean;
    }) =>
      api.post<{ taskId: string; status: BrowserTaskState }>(
        "/browser-task",
        // Open-navigation re-run (2026-05-27 revision): the daemon only
        // honours `description` + `requireFinalConfirm`; siteKey /
        // extraAllowedHosts are no longer part of the request contract.
        {
          description: input.description,
          requireFinalConfirm: input.requireFinalConfirm,
        },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["browser-tasks"] });
      queryClient.invalidateQueries({
        queryKey: ["browser-tasks", "awaiting-count"],
      });
    },
  });
}
