"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { BackendId } from "@aitne/shared";
import { api } from "@/lib/api-client";

export type McpTransport = "stdio" | "http" | "sse";
export type McpRiskTier = "read" | "approve";

export interface McpProbeTool {
  name: string;
  description?: string;
}

export interface McpProbeResult {
  ok: boolean;
  toolCount: number;
  tools: McpProbeTool[];
  error?: string;
  durationMs: number;
}

export interface McpServer {
  id: string;
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string[] | null;
  cwd: string | null;
  url: string | null;
  envKeys: string[];
  headerKeys: string[];
  backends: BackendId[];
  enabled: boolean;
  riskTier: McpRiskTier;
  toolAllowlist: string[] | null;
  lastProbeAt: number | null;
  lastProbeStatus: McpProbeResult | null;
  createdAt: number;
  updatedAt: number;
  /** Which declared envKey/headerKey has a value in the blob store. */
  secretsPresent: Record<string, boolean>;
}

export interface CreateMcpServerInput {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string | null;
  args?: string[] | null;
  cwd?: string | null;
  url?: string | null;
  envKeys?: string[];
  headerKeys?: string[];
  backends: BackendId[];
  enabled?: boolean;
  riskTier?: McpRiskTier;
  toolAllowlist?: string[] | null;
}

export type PatchMcpServerInput = Partial<
  Omit<CreateMcpServerInput, "id" | "enabled">
>;

export function useMcpServers() {
  return useQuery({
    queryKey: ["mcp", "servers"],
    queryFn: () => api.get<{ servers: McpServer[] }>("/mcp/servers"),
  });
}

export function useCreateMcpServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMcpServerInput) =>
      api.post<{ server: McpServer }>("/mcp/servers", input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mcp", "servers"] });
    },
  });
}

export function usePatchMcpServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: PatchMcpServerInput }) =>
      api.patch<{ server: McpServer }>(`/mcp/servers/${encodeURIComponent(id)}`, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mcp", "servers"] });
    },
  });
}

export function useDeleteMcpServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ status: "deleted"; id: string }>(
        `/mcp/servers/${encodeURIComponent(id)}`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mcp", "servers"] });
    },
  });
}

export function useEnableMcpServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.post<{ server: McpServer }>(
        `/mcp/servers/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mcp", "servers"] });
    },
  });
}

/**
 * B-003 Phase 3 — global MCP kill switch.
 *
 * One-shot flip of every `enabled=1` row to `enabled=0`. Intended for "cut
 * the extensions first, debug later" when an MCP-adjacent failure is
 * observed. Per-server enables stay Approve-tier because they expand the
 * agent's tool surface; this mutation contracts it, so the route is
 * classified Autonomous-tier on the daemon side (DELEGATED-MODE-V2 §4.5
 * collapsed the legacy Notify tier into Autonomous + deniedTools). The
 * dashboard should still gate it behind a confirm dialog so a stray click
 * doesn't silently kill the user's entire MCP fleet.
 */
export function useDisableAllMcpServers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ status: "disabled_all"; disabled: number }>(
        "/mcp/disable-all",
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mcp", "servers"] });
    },
  });
}

export function useProbeMcpServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ result: McpProbeResult; server: McpServer }>(
        `/mcp/servers/${encodeURIComponent(id)}/probe`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mcp", "servers"] });
    },
  });
}

export type GeminiInstallKind = "google-workspace" | "notion";

export interface GeminiInstallResult {
  ok: boolean;
  kind: GeminiInstallKind;
  command: string;
  /** True when the daemon detected the install was already applied and
   *  short-circuited without spawning the gemini CLI. */
  alreadyInstalled?: boolean;
  stdout: string;
  stderr: string;
  /** Present on failure. */
  error?: string;
  message?: string;
  exitCode?: number | null;
}

/**
 * One-button install for the Gemini-side MCP servers required by the
 * delegated Gmail / Calendar / Notion connectors. The daemon shells out
 * to `gemini extensions install` or `gemini mcp add` and returns the
 * subprocess output verbatim — surface stdout / stderr in the UI so
 * OAuth-required prompts and version mismatches are diagnosable.
 */
export function useGeminiInstall() {
  return useMutation({
    mutationFn: (kind: GeminiInstallKind) =>
      api.post<GeminiInstallResult>("/mcp/gemini-install", { kind }),
  });
}

export function useSetMcpSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      keyName,
      value,
    }: {
      id: string;
      keyName: string;
      value: string;
    }) =>
      api.put<{ status: "saved" }>(
        `/mcp/servers/${encodeURIComponent(id)}/secrets/${encodeURIComponent(keyName)}`,
        { value },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mcp", "servers"] });
    },
  });
}

export interface McpToolCallEntry {
  id: number;
  serverId: string;
  toolName: string;
  eventType: string | null;
  sessionId: string | null;
  /** null = result not yet received (Codex/Gemini backends). */
  ok: boolean | null;
  error: string | null;
  calledAt: number;
  /** Wall-clock ms from tool invocation to result. Only set for Claude backend. */
  durationMs: number | null;
}

/**
 * B-003 Phase 4.4 — per-server recent MCP tool call history.
 *
 * Polls the `/api/mcp/servers/:id/activity` endpoint (read-tier). Stale
 * after 60 s so the card auto-refreshes without manual reload.
 */
export function useMcpActivity(serverId: string, limit = 20) {
  return useQuery({
    queryKey: ["mcp", "activity", serverId, limit],
    queryFn: () =>
      api.get<{ serverId: string; calls: McpToolCallEntry[] }>(
        `/mcp/servers/${encodeURIComponent(serverId)}/activity?limit=${limit}`,
      ),
    staleTime: 15_000,
  });
}

export function useDeleteMcpSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, keyName }: { id: string; keyName: string }) =>
      api.delete<{ status: "deleted" }>(
        `/mcp/servers/${encodeURIComponent(id)}/secrets/${encodeURIComponent(keyName)}`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mcp", "servers"] });
    },
  });
}
