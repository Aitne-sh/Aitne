"use client";

import { useEffect, useState } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { useSSE } from "@/providers/sse-provider";
import type {
  AgentDetailResponse,
  AgentExecutionsResponse,
  AgentListFilters,
  AgentListResponse,
  RunNowResponse,
} from "@/lib/agents/types";

/**
 * Data hooks for the `/agents` page tree (§9 API + §10 UI). Read queries are
 * keyed under `["agents", ...]`; mutations invalidate the relevant keys. Live
 * refresh comes from `useAgentLiveRefresh`, which subscribes to the daemon's
 * `agent.*` SSE events (broadcast on the default `event` stream with a `kind`
 * field) and invalidates the affected queries.
 *
 * Pure response/diff/validation logic lives under `@/lib/agents/*` (unit-tested
 * without a render harness); these hooks are the React-Query glue over the API
 * client.
 */

const AGENTS_KEY = ["agents"] as const;

export function agentListKey(filters?: AgentListFilters) {
  return ["agents", "list", filters ?? {}] as const;
}
export function agentDetailKey(slug: string) {
  return ["agents", "detail", slug] as const;
}
export function agentExecutionsKey(
  slug: string,
  opts?: { result?: string; before?: number; limit?: number },
) {
  return ["agents", "executions", slug, opts ?? {}] as const;
}

// ── Queries ──────────────────────────────────────────────────────────────

export function useAgents(filters?: AgentListFilters) {
  return useQuery({
    queryKey: agentListKey(filters),
    queryFn: () =>
      api.get<AgentListResponse>("/agents", {
        params: {
          source: filters?.source,
          enabled:
            filters?.enabled === undefined ? undefined : String(filters.enabled),
          include_invalid:
            filters?.include_invalid === undefined
              ? undefined
              : String(filters.include_invalid),
        },
      }),
    // Keep the current list on screen while a new filter loads — otherwise
    // the key change clears data, QueryResult collapses to a skeleton, and
    // the page scrolls to the top on every kind/status/cadence/search change.
    placeholderData: keepPreviousData,
  });
}

export function useAgent(slug: string | null | undefined) {
  return useQuery({
    queryKey: agentDetailKey(slug ?? ""),
    queryFn: () => api.get<AgentDetailResponse>(`/agents/${slug}`),
    enabled: !!slug,
  });
}

export function useAgentExecutions(
  slug: string | null | undefined,
  opts?: { result?: string; before?: number; limit?: number },
) {
  return useQuery({
    queryKey: agentExecutionsKey(slug ?? "", opts),
    queryFn: () =>
      api.get<AgentExecutionsResponse>(`/agents/${slug}/executions`, {
        params: {
          result: opts?.result,
          before: opts?.before,
          limit: opts?.limit,
        },
      }),
    enabled: !!slug,
  });
}

const EXECUTIONS_PAGE_SIZE = 50;

/**
 * Paginated execution history for the dedicated executions page (§9.3). Uses
 * the `before` keyset cursor (rows with `id < before`, newest-first); the next
 * cursor is the last id of a full page.
 */
export function useAgentExecutionsInfinite(
  slug: string | null | undefined,
  opts?: { result?: string },
) {
  return useInfiniteQuery({
    queryKey: ["agents", "executions-page", slug ?? "", opts ?? {}],
    queryFn: ({ pageParam }) =>
      api.get<AgentExecutionsResponse>(`/agents/${slug}/executions`, {
        params: {
          limit: EXECUTIONS_PAGE_SIZE,
          result: opts?.result,
          before: pageParam ?? undefined,
        },
      }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => {
      if (lastPage.executions.length < EXECUTIONS_PAGE_SIZE) return undefined;
      const last = lastPage.executions[lastPage.executions.length - 1];
      return last?.id;
    },
    enabled: !!slug,
    // Keep the current rows on screen while a new result filter loads —
    // otherwise the key change clears data, QueryResult collapses to a
    // skeleton, and the page scrolls to the top on every filter change.
    placeholderData: keepPreviousData,
  });
}

// ── Mutations ──────────────────────────────────────────────────────────────

interface PatchAgentInput {
  slug: string;
  body: Record<string, unknown>;
}

interface PatchAgentResponse {
  status: "updated";
  row: AgentDetailResponse["row"];
  stripped: string[];
}

/**
 * Generic `PATCH /api/agents/:slug` — backs the enabled toggle (with
 * `ack_warning`), built-in override save (nested field body), and override
 * reset (`{ reset: [...] }`). Callers build the body via the pure helpers in
 * `@/lib/agents/*`.
 */
export function usePatchAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, body }: PatchAgentInput) =>
      api.patch<PatchAgentResponse>(`/agents/${slug}`, body),
    onSuccess: (_data, { slug }) => {
      qc.invalidateQueries({ queryKey: agentDetailKey(slug) });
      qc.invalidateQueries({ queryKey: AGENTS_KEY });
    },
  });
}

export function useRunAgentNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) =>
      api.post<RunNowResponse>(`/agents/${slug}/run-now`, {}),
    onSuccess: (_data, slug) => {
      qc.invalidateQueries({ queryKey: agentDetailKey(slug) });
    },
  });
}

interface DeleteAgentInput {
  slug: string;
  /** false → hard delete (snapshot + remove file + cascade row). */
  keepHistory: boolean;
}

export function useDeleteAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, keepHistory }: DeleteAgentInput) =>
      api.delete<{ status: string; slug: string }>(`/agents/${slug}`, {
        body: { keep_history: keepHistory },
      }),
    onSuccess: (_data, { slug }) => {
      qc.invalidateQueries({ queryKey: agentDetailKey(slug) });
      qc.invalidateQueries({ queryKey: AGENTS_KEY });
    },
  });
}

interface SaveUserAgentInput {
  slug: string;
  content: string;
  /** Optimistic-concurrency token (the file's current mtime). */
  expectedMtime?: string;
}

/**
 * Persist a user-Agent `agent.md` via the context-vault write chokepoint — the
 * ONLY legal agent-definition write path (§10.4). A full-content replace is a
 * PUT (`mode:"replace"` PATCH is section-scoped; the context PUT does the
 * whole-file write). Used by both the editor save and the "+ New Agent" create.
 */
export function useSaveUserAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, content, expectedMtime }: SaveUserAgentInput) =>
      api.put<unknown>(`/context/policies/agents/${slug}/agent.md`, {
        content,
        ...(expectedMtime ? { expectedMtime } : {}),
      }),
    onSuccess: (_data, { slug }) => {
      // The daemon watcher reloads + emits an SSE event; invalidate eagerly too
      // so the page refreshes even if the SSE round-trip lags.
      qc.invalidateQueries({ queryKey: agentDetailKey(slug) });
      qc.invalidateQueries({ queryKey: AGENTS_KEY });
    },
  });
}

// ── Live refresh via SSE ─────────────────────────────────────────────────

/**
 * Subscribe to the daemon's `agent.*` events and invalidate the agents
 * queries so the index + detail stay live (file-watcher reloads, enabled
 * toggles, and execution start/complete). The daemon broadcasts these on the
 * default `event` SSE stream with a `kind` of `agent.updated` /
 * `agent.enabled_changed` / `agent.execution.started` /
 * `agent.execution.completed`.
 */
export function useAgentLiveRefresh(): void {
  const { subscribeEvent } = useSSE();
  const qc = useQueryClient();
  useEffect(() => {
    return subscribeEvent((data) => {
      const kind = (data as { kind?: unknown }).kind;
      if (typeof kind !== "string" || !kind.startsWith("agent.")) return;
      const slug = (data as { slug?: unknown }).slug;
      if (typeof slug === "string") {
        qc.invalidateQueries({ queryKey: agentDetailKey(slug) });
        qc.invalidateQueries({ queryKey: agentExecutionsKey(slug) });
      }
      qc.invalidateQueries({ queryKey: AGENTS_KEY });
    });
  }, [subscribeEvent, qc]);
}

/**
 * Track which Agents are mid-execution, for the "status pulse" dot (§10.1) —
 * the list API carries no running flag (`last_execution_id` is set only at
 * completion), so we derive it from the `agent.execution.started` /
 * `agent.execution.completed` SSE events. Ephemeral client state, reset on
 * reconnect.
 */
export function useRunningAgents(): ReadonlySet<string> {
  const { subscribeEvent } = useSSE();
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    return subscribeEvent((data) => {
      const kind = (data as { kind?: unknown }).kind;
      const slug = (data as { slug?: unknown }).slug;
      if (typeof slug !== "string") return;
      if (kind === "agent.execution.started") {
        setRunning((prev) => new Set(prev).add(slug));
      } else if (kind === "agent.execution.completed") {
        setRunning((prev) => {
          if (!prev.has(slug)) return prev;
          const next = new Set(prev);
          next.delete(slug);
          return next;
        });
      }
    });
  }, [subscribeEvent]);
  return running;
}
