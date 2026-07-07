"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { BackendId } from "@aitne/shared";
import { api } from "@/lib/api-client";

// ── DTO mirrors of the daemon's repositories-store.ts ──

export type RepositoryClassification = "project" | "repo-only";
export type RepositoryCategory =
  | "work"
  | "personal"
  | "research"
  | "client"
  | "other";
export type RepositoryPollPriority = "high" | "normal";
export type TriggerWorkdirMode = "temp" | "local-clone";
export type TriggerBackend = BackendId;
export type LastScanStatus = "ok" | "failed" | "skipped_no_activity" | null;

export interface RepositoryDTO {
  id: string;
  githubOwner: string | null;
  githubRepo: string | null;
  githubAccount: string | null;
  localPath: string | null;
  localOnly: boolean;
  displayName: string | null;
  classification: RepositoryClassification;
  category: RepositoryCategory;
  pollPriority: RepositoryPollPriority;
  pollIntervalSec: number | null;
  slug: string;
  createdAt: number;
  updatedAt: number;
}

export interface RepositoryTriggerDTO {
  id: string;
  repositoryId: string;
  name: string;
  enabled: boolean;
  eventType: string;
  filters: Record<string, unknown>;
  backend: TriggerBackend;
  model: string;
  workdirMode: TriggerWorkdirMode;
  prompt: string;
  instructionMd: string | null;
  lastFiredAt: number | null;
  fireCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface RepositoryManagementDTO {
  repositoryId: string;
  enabled: boolean;
  initCompletedAt: number | null;
  lastScanAt: number | null;
  lastScanStatus: LastScanStatus;
  scanFailureCount: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface ArchitectureRefreshState {
  scheduleId: number;
  status: "pending" | "running";
}

export interface RepositoryManagementResponse {
  management: RepositoryManagementDTO;
  architectureRefresh: ArchitectureRefreshState | null;
}

export interface RepositoryCreateInput {
  githubOwner?: string | null;
  githubRepo?: string | null;
  githubAccount?: string | null;
  localPath?: string | null;
  localOnly?: boolean;
  displayName?: string | null;
  classification?: RepositoryClassification;
  category?: RepositoryCategory;
  pollPriority?: RepositoryPollPriority;
  pollIntervalSec?: number | null;
}

export type RepositoryUpdateInput = RepositoryCreateInput;

export interface RepositoryTriggerCreateInput {
  name: string;
  enabled?: boolean;
  eventType: string;
  filters?: Record<string, unknown>;
  backend: TriggerBackend;
  model: string;
  workdirMode: TriggerWorkdirMode;
  prompt: string;
  instructionMd?: string | null;
}

export type RepositoryTriggerUpdateInput = Partial<RepositoryTriggerCreateInput>;

export interface RepositoryRunInput {
  backend: TriggerBackend;
  model: string;
  workdirMode: TriggerWorkdirMode;
  prompt: string;
  instructionMd?: string;
}

export interface RepositoryManagementRunResult {
  status: "completed" | "scheduled" | "skipped_no_activity";
  correlationId: string;
  result?: "written" | "exists";
  overviewPath?: string;
  journalPath?: string;
  commitCount?: number;
  prEvents?: number;
  workflowEvents?: number;
  readmeCopiedTo?: string | null;
  architectureScheduleId?: number | null;
}

export interface ArchitectureRefreshResult {
  status: "scheduled";
  scheduleId: number;
  correlationId: string;
  readmeCopiedTo: string | null;
}

export interface RepositoryFilters {
  hasGithub?: boolean;
  hasLocal?: boolean;
  localOnly?: boolean;
  account?: string;
}

const REPOS_KEY = ["repositories"] as const;
const repoKey = (id: string) => [...REPOS_KEY, id] as const;
const triggersKey = (id: string) => [...repoKey(id), "triggers"] as const;
const managementKey = (id: string) => [...repoKey(id), "management"] as const;

function buildQuery(filters?: RepositoryFilters): Record<string, string | number> | undefined {
  if (!filters) return undefined;
  const out: Record<string, string | number> = {};
  if (filters.hasGithub !== undefined) out.has_github = filters.hasGithub ? "1" : "0";
  if (filters.hasLocal !== undefined) out.has_local = filters.hasLocal ? "1" : "0";
  if (filters.localOnly !== undefined) out.local_only = filters.localOnly ? "1" : "0";
  if (filters.account) out.account = filters.account;
  return Object.keys(out).length > 0 ? out : undefined;
}

// ── Repositories ──

export function useRepositories(filters?: RepositoryFilters) {
  return useQuery({
    queryKey: filters ? [...REPOS_KEY, filters] : [...REPOS_KEY],
    queryFn: () =>
      api.get<{ repositories: RepositoryDTO[] }>(
        "/repositories",
        buildQuery(filters),
      ),
    staleTime: 30_000,
  });
}

export function useCreateRepository() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RepositoryCreateInput) =>
      api.post<{ repository: RepositoryDTO }>("/repositories", body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: REPOS_KEY });
    },
  });
}

export function useUpdateRepository() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: RepositoryUpdateInput }) =>
      api.patch<{ repository: RepositoryDTO }>(
        `/repositories/${encodeURIComponent(id)}`,
        body,
      ),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: REPOS_KEY });
      void qc.invalidateQueries({ queryKey: repoKey(vars.id) });
    },
  });
}

export function useDeleteRepository() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ status: "deleted" }>(`/repositories/${encodeURIComponent(id)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: REPOS_KEY });
    },
  });
}

export function useLinkGithub() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      owner,
      repo,
      account,
    }: {
      id: string;
      owner: string;
      repo: string;
      account?: string;
    }) =>
      api.post<{ repository: RepositoryDTO }>(
        `/repositories/${encodeURIComponent(id)}/link-github`,
        { owner, repo, account },
      ),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: REPOS_KEY });
      void qc.invalidateQueries({ queryKey: repoKey(vars.id) });
    },
  });
}

export function useLinkLocal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, localPath }: { id: string; localPath: string }) =>
      api.post<{ repository: RepositoryDTO }>(
        `/repositories/${encodeURIComponent(id)}/link-local`,
        { localPath },
      ),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: REPOS_KEY });
      void qc.invalidateQueries({ queryKey: repoKey(vars.id) });
    },
  });
}

// ── Repository triggers ──

export function useRepositoryTriggers(repositoryId: string | null | undefined) {
  return useQuery({
    queryKey: repositoryId ? triggersKey(repositoryId) : [...REPOS_KEY, "missing", "triggers"],
    queryFn: () =>
      api.get<{ triggers: RepositoryTriggerDTO[] }>(
        `/repositories/${encodeURIComponent(repositoryId!)}/triggers`,
      ),
    enabled: Boolean(repositoryId),
    staleTime: 15_000,
  });
}

export function useCreateRepoTrigger() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      repositoryId,
      body,
    }: {
      repositoryId: string;
      body: RepositoryTriggerCreateInput;
    }) =>
      api.post<{ trigger: RepositoryTriggerDTO }>(
        `/repositories/${encodeURIComponent(repositoryId)}/triggers`,
        body,
      ),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: triggersKey(vars.repositoryId) });
    },
  });
}

export function useUpdateRepoTrigger() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      repositoryId,
      triggerId,
      body,
    }: {
      repositoryId: string;
      triggerId: string;
      body: RepositoryTriggerUpdateInput;
    }) =>
      api.patch<{ trigger: RepositoryTriggerDTO }>(
        `/repositories/${encodeURIComponent(repositoryId)}/triggers/${encodeURIComponent(triggerId)}`,
        body,
      ),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: triggersKey(vars.repositoryId) });
    },
  });
}

export function useDeleteRepoTrigger() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      repositoryId,
      triggerId,
    }: {
      repositoryId: string;
      triggerId: string;
    }) =>
      api.delete<{ status: "deleted" }>(
        `/repositories/${encodeURIComponent(repositoryId)}/triggers/${encodeURIComponent(triggerId)}`,
      ),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: triggersKey(vars.repositoryId) });
    },
  });
}

export function useTestRepoTrigger() {
  return useMutation({
    mutationFn: ({
      repositoryId,
      triggerId,
      eventType,
      payload,
    }: {
      repositoryId: string;
      triggerId: string;
      eventType?: string;
      payload?: Record<string, unknown>;
    }) =>
      api.post<{ matched: boolean; trigger: RepositoryTriggerDTO; eventType: string }>(
        `/repositories/${encodeURIComponent(repositoryId)}/triggers/${encodeURIComponent(triggerId)}/test`,
        { eventType, payload },
      ),
  });
}

export function useFireRepoTrigger() {
  return useMutation({
    mutationFn: ({
      repositoryId,
      triggerId,
    }: {
      repositoryId: string;
      triggerId: string;
    }) =>
      api.post<{ status: "scheduled"; correlationId: string }>(
        `/repositories/${encodeURIComponent(repositoryId)}/triggers/${encodeURIComponent(triggerId)}/run`,
        {},
      ),
  });
}

// ── Repository management ──

export function useRepositoryManagement(repositoryId: string | null | undefined) {
  return useQuery({
    queryKey: repositoryId ? managementKey(repositoryId) : [...REPOS_KEY, "missing", "management"],
    queryFn: () =>
      api.get<RepositoryManagementResponse>(
        `/repositories/${encodeURIComponent(repositoryId!)}/management`,
      ),
    enabled: Boolean(repositoryId),
    staleTime: 15_000,
    // Poll while an architecture-refresh agent run is pending or running so
    // the dashboard can re-enable buttons promptly when it completes. Idle
    // state stays event-driven (mutation invalidates the key on click).
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.architectureRefresh ? 3000 : false;
    },
  });
}

export function useSetRepositoryManagement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.put<{ management: RepositoryManagementDTO }>(
        `/repositories/${encodeURIComponent(id)}/management`,
        { enabled },
      ),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: managementKey(vars.id) });
    },
  });
}

export function useRunRepoManagementInit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<RepositoryManagementRunResult>(
        `/repositories/${encodeURIComponent(id)}/management/init`,
        {},
      ),
    // Awaiting the refetch ensures the management query latches onto
    // `architectureRefresh != null` before `mutateAsync` resolves, so the
    // UI's "busy" state hands off cleanly from `isPending` to the polled
    // in-flight flag without a re-enable flicker. The refetch is best-
    // effort: a transient GET failure must not turn a successful mutation
    // into a perceived failure, so we swallow it — the next poll tick
    // (every 3 s while the row is in-flight) recovers state.
    onSuccess: async (_data, id) => {
      try {
        await qc.refetchQueries({ queryKey: managementKey(id) });
      } catch {
        /* refetch is best-effort; polling will recover state */
      }
    },
  });
}

export function useRefreshRepositoryArchitecture() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<ArchitectureRefreshResult>(
        `/repositories/${encodeURIComponent(id)}/management/refresh-architecture`,
        {},
      ),
    onSuccess: async (_data, id) => {
      try {
        await qc.refetchQueries({ queryKey: managementKey(id) });
      } catch {
        /* refetch is best-effort; polling will recover state */
      }
    },
  });
}

export function useRunRepoManagementScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<RepositoryManagementRunResult>(
        `/repositories/${encodeURIComponent(id)}/management/scan`,
        {},
      ),
    onSuccess: async (_data, id) => {
      try {
        await qc.refetchQueries({ queryKey: managementKey(id) });
      } catch {
        /* refetch is best-effort; polling will recover state */
      }
    },
  });
}

// ── Helpers ──

export function repositoryHasGithub(repo: RepositoryDTO): boolean {
  return Boolean(repo.githubOwner && repo.githubRepo);
}

export function repositoryHasLocal(repo: RepositoryDTO): boolean {
  return Boolean(repo.localPath);
}

export function repositoryDisplayName(repo: RepositoryDTO): string {
  if (repo.displayName) return repo.displayName;
  if (repositoryHasGithub(repo)) return `${repo.githubOwner}/${repo.githubRepo}`;
  if (repo.localPath) {
    const parts = repo.localPath.replace(/[\\/]+$/g, "").split(/[\\/]+/).filter(Boolean);
    return parts[parts.length - 1] ?? repo.localPath;
  }
  return repo.slug;
}

/** Source prefixes for the observations API tail per repository. */
export function observationSourcesForRepo(repo: RepositoryDTO): string[] {
  const sources: string[] = [];
  if (repo.localPath) sources.push(`git:${repo.localPath}`);
  if (repositoryHasGithub(repo)) {
    const slug = `${repo.githubOwner}/${repo.githubRepo}`;
    sources.push(`github:notification:${slug}`);
    sources.push(`github:workflow:${slug}`);
  }
  return sources;
}
