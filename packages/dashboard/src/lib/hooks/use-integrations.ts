"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { BackendId, IntegrationKey } from "@aitne/shared";
import { api } from "@/lib/api-client";
import type {
  IntegrationListResponse,
  IntegrationPatchRequest,
  IntegrationPatchResponse,
  IntegrationProbeResponse,
  ProxyModelsResponse,
  RecentProxyCallsResponse,
} from "@/lib/api-types";

/**
 * Integration Delegation Framework — dashboard client hooks.
 *
 * The list + PATCH + probe endpoints live on the daemon; `/health.integrationModes`
 * carries the registry-keyed delegated-feature matrix alongside. Dashboards that
 * need the cached feature matrix should read from `useHealth().data.integrationModes`;
 * this file covers the mutation + fresh-probe paths.
 */

/** GET /api/integrations — list every registered integration with its descriptor + state. */
export function useIntegrations() {
  return useQuery({
    queryKey: ["integrations"],
    queryFn: () => api.get<IntegrationListResponse>("/integrations"),
    staleTime: 30_000,
  });
}

/**
 * GET /api/integrations/proxy-models/:backend — list known proxy-model
 * options for a backend (DELEGATED-PROXY-API-DESIGN.md §4.2 / §C2).
 * The result drives the IntegrationCard's model dropdown and the wizard's
 * collapsed "Advanced" section. `enabled: backend != null` so the hook
 * stays inert until the user actually flips into delegated mode.
 */
export function useProxyModels(backend: BackendId | null | undefined) {
  return useQuery({
    queryKey: ["proxy-models", backend ?? null],
    queryFn: () =>
      api.get<ProxyModelsResponse>(`/integrations/proxy-models/${backend}`),
    enabled: backend != null,
    staleTime: 60_000,
  });
}

/**
 * GET /api/integrations/:key/recent-proxy-calls — last N
 * `delegated_proxy.invoke` rows for the integration
 * (DELEGATED-PROXY-API-DESIGN.md §7).
 *
 * `enabled` defaults to `true` when `key` is non-null; the IntegrationCard
 * gates on `mode === "delegated"` itself before mounting the table so the
 * direct/disabled pages don't trigger a needless fetch.
 *
 * `staleTime` is short (10s) because the table is a debug surface — users
 * open it precisely to see whether a recent failure already shows up.
 */
export function useRecentProxyCalls(
  key: IntegrationKey | null,
  opts: { limit?: number; enabled?: boolean } = {},
) {
  const { limit, enabled = true } = opts;
  return useQuery({
    queryKey: ["recent-proxy-calls", key, limit ?? null],
    queryFn: () => {
      const qs = limit !== undefined ? `?limit=${limit}` : "";
      return api.get<RecentProxyCallsResponse>(
        `/integrations/${key}/recent-proxy-calls${qs}`,
      );
    },
    enabled: enabled && key !== null,
    staleTime: 10_000,
  });
}

/**
 * PATCH /api/integrations/:key — change one integration's mode.
 *
 * The daemon runs the §4.10 lifecycle (DB update → integrations.md rewrite →
 * observer flip → audit row → owner DM). Invalidates both `integrations` and
 * `health` so the card and the `/health.integrationModes` consumers both
 * re-render with the new mode + feature matrix.
 */
export function usePatchIntegration() {
  const qc = useQueryClient();
  return useMutation<
    IntegrationPatchResponse,
    Error,
    { key: IntegrationKey; body: IntegrationPatchRequest }
  >({
    mutationFn: ({ key, body }) =>
      api.patch<IntegrationPatchResponse>(`/integrations/${key}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["integrations"] });
      qc.invalidateQueries({ queryKey: ["health"] });
    },
  });
}

/**
 * POST /api/integrations/:key/probe — cached read (body has no `tools`).
 *
 * Returns the latest stored probe row for `(key, backend)` without launching
 * a subprocess. When the cache is empty, `result` is `null`. The setup
 * wizard and settings card read cached/default features by default and let
 * live probes refresh the matrix explicitly or in the background after Apply.
 *
 * `backend` can be omitted when the integration already has a
 * `delegatedBackend` — the daemon defaults to that value.
 */
export function useIntegrationProbeCached(
  key: IntegrationKey | null,
  backend?: BackendId,
) {
  return useQuery({
    queryKey: ["integration-probe", key, backend ?? null],
    queryFn: () =>
      api.post<IntegrationProbeResponse>(`/integrations/${key}/probe`, {
        ...(backend !== undefined ? { backend } : {}),
      }),
    enabled: key !== null,
    staleTime: 60_000,
  });
}

/**
 * GET /api/agent/actions?kind=integration.native_unbound — recent main-backend
 * cascade rows (INTEGRATION_NATIVE_MODE_DESIGN.md §11.4). Drives the
 * IntegrationCard's "Re-configure" banner: when a row appears for `<key>`
 * and that integration's current mode is `disabled`, the user has not yet
 * re-bound the integration on the new main backend.
 *
 * `sinceHours` defaults to 168 (7 days) so a switch the operator made over
 * the weekend still surfaces on Monday. The hook stays light — pure read,
 * no mutation — and the dashboard derives the per-key set on the consumer
 * side.
 */
export interface NativeUnboundAction {
  id: number;
  key: IntegrationKey;
  priorNativeBackend: BackendId | null;
  newMainBackend: BackendId | null;
  priorDeniedTools: string[];
  startedAt: string | null;
}

export function useNativeUnboundActions(opts: { sinceHours?: number } = {}) {
  const sinceHours = opts.sinceHours ?? 168;
  return useQuery({
    queryKey: ["agent-actions", "native_unbound", sinceHours],
    queryFn: async () => {
      const since = new Date(
        Date.now() - sinceHours * 60 * 60 * 1000,
      ).toISOString();
      const qs = new URLSearchParams({ since, limit: "50" });
      qs.append("kind", "integration.native_unbound");
      const res = await api.get<{
        actions: Array<{
          id: number;
          detail: string | null;
          startedAt: string | null;
        }>;
      }>(`/agent/actions?${qs.toString()}`);
      const out: NativeUnboundAction[] = [];
      for (const row of res.actions) {
        if (!row.detail) continue;
        try {
          const parsed = JSON.parse(row.detail) as {
            key?: string;
            priorNativeBackend?: string | null;
            newMainBackend?: string | null;
            priorDeniedTools?: string[];
          };
          if (typeof parsed.key !== "string") continue;
          out.push({
            id: row.id,
            key: parsed.key as IntegrationKey,
            priorNativeBackend:
              (parsed.priorNativeBackend ?? null) as BackendId | null,
            newMainBackend:
              (parsed.newMainBackend ?? null) as BackendId | null,
            priorDeniedTools: parsed.priorDeniedTools ?? [],
            startedAt: row.startedAt,
          });
        } catch {
          // Skip rows with malformed detail JSON — the daemon writes a
          // schema-checked blob so this only fires on hand-edits.
          continue;
        }
      }
      return out;
    },
    staleTime: 60_000,
  });
}

/**
 * POST /api/integrations/:key/probe — live evaluation against a tool list.
 *
 * Two call conventions:
 *  - `{ tools: [...] }` — caller supplies the pre-collected MCP tool list
 *    (still supported for tests and external tooling).
 *  - `{ liveProbe: true }` — daemon spawns the target backend subprocess
 *    and enumerates tools itself. This is what the Re-probe button and
 *    post-Apply background refresh use. §4.11 restricts live probes to
 *    user-initiated UI flows (never boot or synchronous PATCH).
 */
export function useIntegrationProbeLive() {
  const qc = useQueryClient();
  return useMutation<
    IntegrationProbeResponse,
    Error,
    | { key: IntegrationKey; backend: BackendId; tools: string[] }
    | { key: IntegrationKey; backend?: BackendId; liveProbe: true }
  >({
    mutationFn: (args) => {
      const { key } = args;
      const body: Record<string, unknown> = {};
      if ("liveProbe" in args) {
        body.liveProbe = true;
        if (args.backend) body.backend = args.backend;
      } else {
        body.backend = args.backend;
        body.tools = args.tools;
      }
      return api.post<IntegrationProbeResponse>(
        `/integrations/${key}/probe`,
        body,
      );
    },
    onSuccess: (_data, args) => {
      qc.invalidateQueries({ queryKey: ["integration-probe", args.key] });
      qc.invalidateQueries({ queryKey: ["health"] });
    },
  });
}
