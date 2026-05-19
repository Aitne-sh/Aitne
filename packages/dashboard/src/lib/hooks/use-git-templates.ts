"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

export type GitTemplateKind = "project" | "git-repo";

export interface GitTemplateDetail {
  kind: GitTemplateKind;
  active: string;
  bundled: string;
  override: string | null;
  hasOverride: boolean;
  path: string;
}

const TEMPLATE_KEY = (kind: GitTemplateKind) => ["git-template", kind];
const STATUS_KEY = ["git-template", "retemplate-status"] as const;

export function useGitTemplate(kind: GitTemplateKind) {
  return useQuery({
    queryKey: TEMPLATE_KEY(kind),
    queryFn: () =>
      api.get<GitTemplateDetail>(
        `/git/templates/${encodeURIComponent(kind)}`,
      ),
    staleTime: 5_000,
  });
}

export function useSaveGitTemplate(kind: GitTemplateKind) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (content: string) =>
      api.put<{ ok: boolean; bytes: number; path: string }>(
        `/git/templates/${encodeURIComponent(kind)}`,
        { content },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TEMPLATE_KEY(kind) });
    },
  });
}

export interface GitRetemplateApplyResponse {
  ok: true;
  kind: GitTemplateKind;
  scheduleId: number;
  correlationId: string;
  backupRoot: string;
  targets: Array<{
    slug: string;
    contextFile: string;
    backupRelPath: string;
  }>;
}

export function useApplyGitTemplate(kind: GitTemplateKind) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<GitRetemplateApplyResponse>(
        `/git/templates/${encodeURIComponent(kind)}/apply`,
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
  });
}

export type RetemplateFileStatus =
  | "pending"
  | "started"
  | "completed"
  | "skipped"
  | "failed"
  | "rolled_back";

export type RetemplateRunStatus = "running" | "success" | "partial" | "failed";

export interface RetemplateFileEntry {
  slug: string;
  contextPath: string;
  contextFile: string;
  backupRelPath: string;
  classification: "project" | "repo-only";
  status: RetemplateFileStatus;
  reason?: string;
  error?: string;
  beforeBytes?: number;
  afterBytes?: number;
  startedAt?: string;
  completedAt?: string;
}

export interface RetemplateStatusRecord {
  scheduleId: number;
  correlationId: string;
  kind: GitTemplateKind;
  backupRoot: string;
  startedAt: string;
  finalizedAt?: string;
  finalStatus?: RetemplateRunStatus;
  files: Record<string, RetemplateFileEntry>;
}

export function useRetemplateStatus() {
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: () =>
      api.get<{ status: RetemplateStatusRecord | null }>(
        "/git/templates/retemplate/status",
      ),
    // Live-refresh while a run is in flight; the dashboard renders the
    // status grid as it changes.
    refetchInterval: (query) => {
      const data = query.state.data as
        | { status: RetemplateStatusRecord | null }
        | undefined;
      const inFlight = data?.status && !data.status.finalizedAt;
      return inFlight ? 2_000 : false;
    },
    staleTime: 1_000,
  });
}
