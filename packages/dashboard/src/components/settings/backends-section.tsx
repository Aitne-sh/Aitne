"use client";

import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getBackendIds, type BackendId } from "@aitne/shared";
import { ADVISOR_ALLOWED_MODELS, isAdvisorModel } from "@aitne/shared";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, ApiError } from "@/lib/api-client";
import {
  BACKEND_PROVIDER_LABELS,
  BACKEND_PROVIDER_SHORT,
  isBackendSelectionDisabled,
  UI_PREVIEW_ONLY_REASON,
} from "@/lib/backend-ui";
import { useBackends } from "@/lib/hooks/use-backends";
import { useConfig } from "@/lib/hooks/use-config";
import type { SettingsToastState } from "./settings-navigation";
import { BackendCard } from "./backend-card";
import { BackendApiKeyPanel } from "./backend-api-key-panel";
import { SubscriptionAuthWarning } from "./subscription-auth-warning";

const BACKENDS = getBackendIds();

interface BackendsSectionProps {
  onToast: (type: SettingsToastState["type"], message: string) => void;
}

interface InstallCheckEntry {
  status: "idle" | "checking" | "ok" | "error";
  error?: string | null;
  version?: string | null;
}

interface AdvisorState {
  enabled: boolean;
  model: string | null;
}

/**
 * /settings/models top section. Replaces the legacy
 * `BackendsAndPlansSection` which embedded the (now removed) plan
 * picker. Surface area:
 *
 *  - One `BackendCard` per backend (CLI install, auth verify, enable
 *    toggle, web-search toggle).
 *  - "Set as main" button on non-main cards.
 *  - Advisor toggle (off by default; when on, picks from
 *    `ADVISOR_ALLOWED_MODELS`).
 */
export function BackendsSection({ onToast }: BackendsSectionProps) {
  const { data: backendsData, refetch: refetchBackends } = useBackends();
  const { data: config } = useConfig();
  const queryClient = useQueryClient();

  const [busyBackend, setBusyBackend] = useState<BackendId | null>(null);
  const [installCheck, setInstallCheck] = useState<
    Record<BackendId, InstallCheckEntry>
  >({
    claude: { status: "idle" },
    codex: { status: "idle" },
    gemini: { status: "idle" },
    opencode: { status: "idle" },
  });
  const [advisor, setAdvisor] = useState<AdvisorState | null>(null);
  const [advisorSaving, setAdvisorSaving] = useState(false);

  // Hydrate the advisor toggle from the backend on mount. Server is the
  // source of truth — the dashboard only reflects what the daemon says.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ enabled: boolean; model: string | null }>(
          "/backends/advisor",
        );
        if (cancelled) return;
        setAdvisor({ enabled: res.enabled, model: res.model });
      } catch {
        // Silently fall back to "off, no model" — the user can toggle it
        // and the next save will land the actual state.
        if (!cancelled) setAdvisor({ enabled: false, model: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const verifyInstall = useCallback(
    async (backendId: BackendId) => {
      setInstallCheck((prev) => ({
        ...prev,
        [backendId]: { status: "checking" },
      }));
      try {
        const res = await api.post<{
          ok: boolean;
          cliInstalled: boolean;
          cliCommand: string;
          exitCode: number | null;
          version: string | null;
          stdout: string;
          stderr: string;
          timedOut: boolean;
        }>(`/backends/${backendId}/verify-install`);
        await refetchBackends();
        if (res.ok) {
          setInstallCheck((prev) => ({
            ...prev,
            [backendId]: { status: "ok", version: res.version },
          }));
        } else {
          const reason = !res.cliInstalled
            ? `${res.cliCommand} not found on PATH`
            : res.timedOut
              ? `${res.cliCommand} --version timed out`
              : (res.stderr.trim() || res.stdout.trim() || "CLI failed to run");
          setInstallCheck((prev) => ({
            ...prev,
            [backendId]: { status: "error", error: reason },
          }));
        }
      } catch (err) {
        setInstallCheck((prev) => ({
          ...prev,
          [backendId]: {
            status: "error",
            error: err instanceof Error ? err.message : "Verify install failed",
          },
        }));
      }
    },
    [refetchBackends],
  );

  const setMain = useCallback(
    async (backendId: BackendId) => {
      setBusyBackend(backendId);
      try {
        // INTEGRATION_NATIVE_MODE_DESIGN.md §11.4 — the response body
        // carries `nativeUnbound` (one row per native integration the
        // switch cascaded to `disabled`). We surface that inline as part
        // of the toast so the user sees the consequence immediately,
        // rather than discovering silent disabled rows on the
        // /connections page later.
        const res = await api.put<{
          status?: string;
          nativeUnbound?: Array<{ key: string; priorNativeBackend: string }>;
        }>("/backends/main", { backendId });
        await refetchBackends();
        await queryClient.invalidateQueries({ queryKey: ["backends"] });
        // Surface the §11.4 cascade and the §11.5 banner immediately.
        await queryClient.invalidateQueries({ queryKey: ["integrations"] });
        await queryClient.invalidateQueries({ queryKey: ["health"] });
        await queryClient.invalidateQueries({
          queryKey: ["agent-actions", "native_unbound"],
        });
        const unbound = res?.nativeUnbound ?? [];
        if (unbound.length > 0) {
          const keys = unbound.map((u) => u.key).join(", ");
          onToast(
            "warning",
            `Main backend set to ${BACKEND_PROVIDER_LABELS[backendId]}. ${unbound.length} native integration${unbound.length === 1 ? "" : "s"} disabled (${keys}). Re-configure on /connections.`,
          );
        } else {
          onToast(
            "success",
            `Main backend set to ${BACKEND_PROVIDER_LABELS[backendId]}.`,
          );
        }
      } catch (err) {
        const message =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Failed to set main backend";
        onToast("error", message);
      } finally {
        setBusyBackend(null);
      }
    },
    [refetchBackends, queryClient, onToast],
  );

  const toggleEnable = useCallback(
    async (backendId: BackendId) => {
      const current = backendsData?.backends.find((b) => b.id === backendId);
      if (!current) return;
      const next = !current.enabled;
      setBusyBackend(backendId);
      try {
        await api.post(`/backends/${backendId}/${next ? "enable" : "disable"}`);
        await refetchBackends();
        onToast(
          "success",
          `${BACKEND_PROVIDER_LABELS[backendId]} ${next ? "enabled" : "disabled"}.`,
        );
      } catch (err) {
        onToast(
          "error",
          err instanceof Error ? err.message : "Failed to update backend",
        );
      } finally {
        setBusyBackend(null);
      }
    },
    [backendsData, refetchBackends, onToast],
  );

  const toggleWebSearch = useCallback(
    async (backendId: BackendId) => {
      const current = backendsData?.backends.find((b) => b.id === backendId);
      if (!current) return;
      const next = !current.webSearchEnabled;
      setBusyBackend(backendId);
      try {
        await api.post(`/backends/${backendId}/web-search`, { enabled: next });
        await refetchBackends();
      } catch (err) {
        onToast(
          "error",
          err instanceof Error ? err.message : "Failed to update web search",
        );
      } finally {
        setBusyBackend(null);
      }
    },
    [backendsData, refetchBackends, onToast],
  );

  const saveAdvisor = useCallback(
    async (next: AdvisorState) => {
      setAdvisorSaving(true);
      try {
        await api.put("/backends/advisor", {
          enabled: next.enabled,
          model: next.model,
        });
        setAdvisor(next);
        onToast(
          "success",
          `Advisor ${next.enabled ? "enabled" : "disabled"}.`,
        );
      } catch (err) {
        onToast(
          "error",
          err instanceof Error ? err.message : "Failed to save advisor",
        );
      } finally {
        setAdvisorSaving(false);
      }
    },
    [onToast],
  );

  const mainBackend = backendsData?.defaultBackend ?? null;

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Backends</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Install each backend&rsquo;s CLI, verify authentication, and pick
          the main backend. The main backend runs every configurable process
          by default; per-process overrides live in the Process Routing card
          below.
        </p>
      </div>

      <SubscriptionAuthWarning />

      <div className="space-y-3">
        {BACKENDS.map((backendId) => {
          const row = backendsData?.backends.find((b) => b.id === backendId);
          const isMain = mainBackend === backendId;
          // Two-layer gate (runtime + UI-only preview) — see
          // `backend-ui.ts` for the rationale.
          const controlsDisabled = isBackendSelectionDisabled(backendId);
          const permissionMode = config
            ? (config[
                `${backendId}ExecutionPermissionMode` as keyof typeof config
              ] as string | null | undefined)
            : null;
          return (
            <div key={backendId} className="space-y-2">
              <BackendCard
                backendId={backendId}
                mode="settings"
                isMain={isMain}
                authStatus={row?.authStatus ?? "unknown"}
                authStatusDetail={row?.authDetail ?? null}
                authFirstExpiredAt={row?.authFirstExpiredAt ?? null}
                authLastSuccessAt={row?.authLastSuccessAt ?? null}
                authNotificationCount={row?.authNotificationCount ?? 0}
                cliInstalled={row?.cliInstalled ?? true}
                enabled={row?.enabled ?? false}
                webSearchEnabled={row?.webSearchEnabled ?? false}
                webSearchSupported={row?.webSearchSupported ?? false}
                permissionMode={permissionMode}
                busy={busyBackend === backendId}
                controlsDisabled={controlsDisabled}
                disabledReason={controlsDisabled ? UI_PREVIEW_ONLY_REASON : undefined}
                installCheck={installCheck[backendId]}
                onCliInstalled={() => {
                  void refetchBackends();
                }}
                onVerifyInstall={() => {
                  void verifyInstall(backendId);
                }}
                onToggleEnable={() => {
                  void toggleEnable(backendId);
                }}
                onToggleWebSearch={() => {
                  void toggleWebSearch(backendId);
                }}
              />
              {!controlsDisabled && (
                <BackendApiKeyPanel
                  backendId={backendId}
                  onToast={onToast}
                />
              )}
              {!isMain && (
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      controlsDisabled || busyBackend !== null || !(row?.cliInstalled ?? false)
                    }
                    onClick={() => {
                      void setMain(backendId);
                    }}
                  >
                    Set {BACKEND_PROVIDER_SHORT[backendId]} as main
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Advisor — opt-in toggle, default disabled. */}
      {advisor && (
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <h3 className="text-sm font-semibold text-foreground">
                Advisor (Claude Agent SDK)
              </h3>
              <p className="text-xs text-muted-foreground">
                When enabled, the Claude Agent SDK&rsquo;s server-side advisor
                tool can offer a second-opinion model on long turns. Off by
                default; turn it on only when the extra cost is worth it.
              </p>
            </div>
            <Button
              size="sm"
              variant={advisor.enabled ? "outline" : "default"}
              disabled={advisorSaving}
              onClick={() => {
                const next: AdvisorState = advisor.enabled
                  ? { enabled: false, model: null }
                  : {
                      enabled: true,
                      model: advisor.model ?? ADVISOR_ALLOWED_MODELS[0],
                    };
                void saveAdvisor(next);
              }}
            >
              {advisorSaving && (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              )}
              {advisor.enabled ? "Disable advisor" : "Enable advisor"}
            </Button>
          </div>
          {advisor.enabled && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Model:</span>
              <Select
                value={advisor.model ?? ADVISOR_ALLOWED_MODELS[0]}
                onValueChange={(next) => {
                  if (!isAdvisorModel(next)) return;
                  void saveAdvisor({ enabled: true, model: next });
                }}
                disabled={advisorSaving}
              >
                <SelectTrigger className="h-8 w-auto min-w-[12rem] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ADVISOR_ALLOWED_MODELS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
