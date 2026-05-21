"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  EyeOff,
  History,
  Loader2,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type {
  BrowserHistoryBrowserKey,
  BrowserHistoryBrowserOverride,
  BrowserHistoryCategory,
  BrowserHistoryDetectionStatus,
  BrowserHistoryLifecycleConfig,
  BrowserHistoryStatusResponse,
  IntegrationMode,
} from "@aitne/shared";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { PageHeader } from "@/components/ui/page-header";
import { SettingsToast } from "@/components/settings/settings-navigation";
import { api } from "@/lib/api-client";
import type {
  ConfigUpdateResponse,
  IntegrationListItem,
  IntegrationListResponse,
  IntegrationPatchResponse,
} from "@/lib/api-types";
import { useConfig } from "@/lib/hooks/use-config";
import { usePatchIntegration } from "@/lib/hooks/use-integrations";
import { useSaveConfig } from "@/lib/hooks/use-save-config";
import { cn } from "@/lib/utils";

const BROWSERS: Array<{ key: BrowserHistoryBrowserKey; label: string }> = [
  { key: "chrome", label: "Chrome" },
  { key: "chromium", label: "Chromium" },
  { key: "edge", label: "Edge" },
  { key: "brave", label: "Brave" },
  { key: "comet", label: "Comet" },
  { key: "atlas", label: "Atlas" },
];

const CATEGORIES: Array<{ key: BrowserHistoryCategory; label: string }> = [
  { key: "work", label: "Work" },
  { key: "research", label: "Research" },
  { key: "shopping", label: "Shopping" },
  { key: "news", label: "News" },
  { key: "dev", label: "Development" },
  { key: "cloud-console", label: "Cloud console" },
  { key: "localhost", label: "Localhost" },
  { key: "app-config", label: "App config" },
  { key: "other", label: "Other" },
];

const STATUS_COPY: Record<
  BrowserHistoryDetectionStatus,
  { label: string; tone: "default" | "amber" | "red" | "gray" }
> = {
  available: { label: "Available", tone: "default" },
  available_no_sync: { label: "No sync", tone: "amber" },
  available_sync_broken: { label: "Sync stale", tone: "amber" },
  permission_denied: { label: "Permission denied", tone: "red" },
  not_installed: { label: "Not installed", tone: "gray" },
  error: { label: "Error", tone: "red" },
};

const OVERRIDE_LABELS: Record<BrowserHistoryBrowserOverride, string> = {
  auto: "Auto",
  "forced-on": "Force on",
  "forced-off": "Force off",
};

const BROWSER_HISTORY_KEY = "browser_history";

function useBrowserHistoryStatus() {
  return useQuery({
    queryKey: ["browser-history-status"],
    queryFn: () => api.get<BrowserHistoryStatusResponse>("/browser-history/status"),
    staleTime: 15_000,
  });
}

function useBrowserHistoryIntegration() {
  return useQuery({
    queryKey: ["integrations"],
    queryFn: () => api.get<IntegrationListResponse>("/integrations"),
    staleTime: 30_000,
    select: (data) =>
      data.integrations.find((item) => item.key === BROWSER_HISTORY_KEY) ?? null,
  });
}

function formatTime(ms: number | null | undefined): string {
  if (!ms) return "Never";
  return new Date(ms).toLocaleString();
}

function humanDuration(seconds: number | null | undefined): string {
  if (!seconds) return "n/a";
  if (seconds < 90) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

function statusAlert(status: BrowserHistoryDetectionStatus | undefined): {
  variant: "info" | "warning" | "error";
  message: string;
} | null {
  if (status === "permission_denied") {
    return {
      variant: "error",
      message:
        "The profile path exists, but the daemon cannot read it. Grant the daemon user read access to that browser profile directory.",
    };
  }
  if (status === "available_sync_broken") {
    return {
      variant: "warning",
      message:
        "The profile is readable, but sync looks stale. Lifecycle launch can keep this browser fresh on unattended hosts.",
    };
  }
  return null;
}

function mergeLifecycleConfig(
  current: BrowserHistoryLifecycleConfig,
  patch: Partial<BrowserHistoryLifecycleConfig>,
): BrowserHistoryLifecycleConfig {
  return {
    ...current,
    ...patch,
    per_browser: patch.per_browser ?? current.per_browser ?? {},
  };
}

function BrowserStatusIcon({
  status,
}: {
  status: BrowserHistoryDetectionStatus | undefined;
}) {
  if (status === "available" || status === "available_no_sync") {
    return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
  }
  if (
    status === "permission_denied"
    || status === "available_sync_broken"
  ) {
    return <AlertTriangle className="h-4 w-4 text-amber-600" />;
  }
  if (status === "error") {
    return <XCircle className="h-4 w-4 text-red-600" />;
  }
  return <EyeOff className="h-4 w-4 text-muted-foreground" />;
}

function SectionLabel({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <div className="mt-0.5 rounded-md border bg-muted p-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          {description}
        </p>
      </div>
    </div>
  );
}

function ModePill({
  integration,
}: {
  integration: IntegrationListItem | null | undefined;
}) {
  const mode = integration?.state.mode ?? "disabled";
  const direct = mode === "direct";
  return (
    <Badge variant={direct ? "default" : "gray"}>
      {direct ? "Direct" : "Disabled"}
    </Badge>
  );
}

export default function BrowserHistorySettingsPage() {
  const queryClient = useQueryClient();
  const { data: config } = useConfig();
  const status = useBrowserHistoryStatus();
  const integrationQuery = useBrowserHistoryIntegration();
  const patchIntegration = usePatchIntegration();
  const { toast, showToast, saveField } = useSaveConfig();
  const [savingMode, setSavingMode] = useState<IntegrationMode | null>(null);

  const integration = integrationQuery.data;
  const capabilities = status.data?.capabilities ?? null;
  const lifecycle = status.data?.lifecycle ?? {};

  const redetect = useMutation({
    mutationFn: () =>
      api.post<{ capabilities: NonNullable<BrowserHistoryStatusResponse["capabilities"]> }>(
        "/setup/redetect-browsers",
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["browser-history-status"] });
      showToast("success", "Browser detection refreshed");
    },
    onError: (err) => {
      showToast(
        "error",
        `Failed to refresh detection: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    },
  });

  const availableCount = useMemo(() => {
    if (!capabilities) return 0;
    return Object.values(capabilities.browsers).filter((value) =>
      value === "available" || value === "available_no_sync",
    ).length;
  }, [capabilities]);

  const selectedCategorySet = new Set(config?.browserHistoryCategories ?? []);

  async function setMode(mode: IntegrationMode) {
    setSavingMode(mode);
    try {
      await patchIntegration.mutateAsync({
        key: BROWSER_HISTORY_KEY,
        body: { mode },
      });
      queryClient.invalidateQueries({ queryKey: ["browser-history-status"] });
      showToast(
        "success",
        mode === "direct" ? "Browser History enabled" : "Browser History disabled",
      );
    } catch (err) {
      showToast(
        "error",
        `Failed to update mode: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    } finally {
      setSavingMode(null);
    }
  }

  async function acceptConsent() {
    try {
      await api.patch<ConfigUpdateResponse>("/config", {
        browserHistoryConsentAccepted: true,
      });
      await api.patch<IntegrationPatchResponse>(`/integrations/${BROWSER_HISTORY_KEY}`, {
        mode: "direct",
      });
      queryClient.invalidateQueries({ queryKey: ["config"] });
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
      queryClient.invalidateQueries({ queryKey: ["health"] });
      queryClient.invalidateQueries({ queryKey: ["browser-history-status"] });
      showToast("success", "Consent recorded and Browser History enabled");
    } catch (err) {
      showToast(
        "error",
        `Failed to enable Browser History: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    }
  }

  async function updateOverride(
    browser: BrowserHistoryBrowserKey,
    override: BrowserHistoryBrowserOverride,
  ) {
    const next = {
      ...(config?.browserHistoryBrowserOverrides ?? {}),
      [browser]: override,
    };
    await saveField("browserHistoryBrowserOverrides", next);
    queryClient.invalidateQueries({ queryKey: ["browser-history-status"] });
  }

  async function updateLifecycle(patch: Partial<BrowserHistoryLifecycleConfig>) {
    if (!config) return;
    await saveField(
      "browserHistoryLifecycle",
      mergeLifecycleConfig(config.browserHistoryLifecycle, patch),
    );
    queryClient.invalidateQueries({ queryKey: ["browser-history-status"] });
  }

  async function updatePerBrowserLifecycle(
    browser: BrowserHistoryBrowserKey,
    patch: Partial<BrowserHistoryLifecycleConfig["per_browser"][string]>,
  ) {
    if (!config) return;
    const current = config.browserHistoryLifecycle;
    const currentBrowser = current.per_browser?.[browser] ?? {};
    await updateLifecycle({
      per_browser: {
        ...(current.per_browser ?? {}),
        [browser]: {
          ...currentBrowser,
          ...patch,
        },
      },
    });
  }

  async function updateCategory(category: BrowserHistoryCategory, enabled: boolean) {
    const current = new Set(config?.browserHistoryCategories ?? []);
    if (enabled) current.add(category);
    else current.delete(category);
    await saveField("browserHistoryCategories", Array.from(current));
  }

  if (!config || integrationQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading...
      </div>
    );
  }

  const consented = config.browserHistoryConsentAccepted;
  const currentMode = integration?.state.mode ?? "disabled";
  const lifecycleConfig = config.browserHistoryLifecycle;
  const lifecycleEnabled = lifecycleConfig.enabled;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Browser History"
        description="Local browser-history ingestion, consent, browser detection, lifecycle supervision, and retention controls."
      >
        <div className="flex flex-wrap items-center gap-2">
          <ModePill integration={integration} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => redetect.mutate()}
            disabled={redetect.isPending}
          >
            {redetect.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Re-detect
          </Button>
        </div>
      </PageHeader>

      <SettingsToast toast={toast} />

      {!consented && (
        <Alert variant="warning">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="font-medium">Browser History is off until you consent.</div>
              <p className="mt-1">
                Enabling this feature lets the daemon read local browser history databases and store normalized, retention-limited rows for research and summary features.
              </p>
            </div>
            <Button
              size="sm"
              onClick={acceptConsent}
              disabled={patchIntegration.isPending}
              className="shrink-0"
            >
              <ShieldCheck className="h-4 w-4" />
              Enable
            </Button>
          </div>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <SectionLabel
            icon={ShieldCheck}
            title="Consent & Mode"
            description="Consent is separate from detection. Browser reads start only when consent is accepted and the integration is in Direct mode."
          />
        </CardHeader>
        <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-center">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Consent</div>
              <div className="mt-1 text-sm font-medium">
                {consented ? "Accepted" : "Not accepted"}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Detected browsers</div>
              <div className="mt-1 text-sm font-medium">
                {status.isLoading ? "Checking..." : availableCount}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Last ingest</div>
              <div className="mt-1 truncate text-sm font-medium">
                {formatTime(status.data?.lastIngestAt)}
              </div>
            </div>
          </div>

          <div className="flex rounded-md border p-1">
            <Button
              size="sm"
              variant={currentMode === "direct" ? "default" : "ghost"}
              disabled={!consented || savingMode !== null}
              onClick={() => setMode("direct")}
            >
              {savingMode === "direct" && <Loader2 className="h-4 w-4 animate-spin" />}
              On
            </Button>
            <Button
              size="sm"
              variant={currentMode === "disabled" ? "default" : "ghost"}
              disabled={savingMode !== null}
              onClick={() => setMode("disabled")}
            >
              {savingMode === "disabled" && <Loader2 className="h-4 w-4 animate-spin" />}
              Off
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <SectionLabel
            icon={History}
            title="Browsers"
            description="Detection follows the host OS profile layout. Auto ingests readable, supported profiles when consent and Direct mode are active."
          />
        </CardHeader>
        {status.error && (
          <Alert variant="error" className="mb-4">
            Failed to read browser status: {status.error.message}
          </Alert>
        )}
        <div className="divide-y rounded-md border">
          {BROWSERS.map(({ key, label }) => {
            const browserStatus = capabilities?.browsers[key];
            const detail = capabilities?.details[key];
            const override = config.browserHistoryBrowserOverrides[key] ?? "auto";
            const alert = statusAlert(browserStatus);
            const browserLifecycle = lifecycle[key];
            return (
              <div
                key={key}
                className="grid gap-4 p-4 lg:grid-cols-[minmax(190px,1fr)_minmax(260px,1.5fr)_190px] lg:items-center"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <BrowserStatusIcon status={browserStatus} />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="font-medium">{label}</div>
                      {browserStatus && (
                        <Badge variant={STATUS_COPY[browserStatus].tone}>
                          {STATUS_COPY[browserStatus].label}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {detail?.message ?? `${detail?.readableProfiles ?? 0}/${detail?.profileCount ?? 0} readable profiles`}
                    </div>
                  </div>
                </div>

                <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                  <span>Signed in: {detail?.signedInProfiles ?? 0}</span>
                  <span>History mtime: {formatTime(detail?.lastHistoryMtimeMs)}</span>
                  <span>Lifecycle: {browserLifecycle?.state ?? "stopped"}</span>
                  <span>Last sync: {formatTime(browserLifecycle?.lastSuccessfulSyncAt)}</span>
                  <span>Failures: {browserLifecycle?.consecutiveFailures ?? 0}</span>
                  <span>Wait: {humanDuration(lifecycleConfig.per_browser?.[key]?.sync_flush_wait_seconds)}</span>
                </div>

                <div className="grid gap-2">
                  <NativeSelect
                    aria-label={`${label} override`}
                    value={override}
                    onChange={(event) =>
                      void updateOverride(
                        key,
                        event.target.value as BrowserHistoryBrowserOverride,
                      )
                    }
                  >
                    {Object.entries(OVERRIDE_LABELS).map(([value, optionLabel]) => (
                      <option key={value} value={value}>
                        {optionLabel}
                      </option>
                    ))}
                  </NativeSelect>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-input"
                      checked={lifecycleConfig.per_browser?.[key]?.enabled ?? true}
                      onChange={(event) =>
                        void updatePerBrowserLifecycle(key, {
                          enabled: event.target.checked,
                        })
                      }
                    />
                    Lifecycle
                  </label>
                </div>

                {alert && (
                  <Alert variant={alert.variant} className="lg:col-span-3">
                    {alert.message}
                  </Alert>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1fr_1fr]">
        <Card>
          <CardHeader>
            <SectionLabel
              icon={SlidersHorizontal}
              title="Retention & Categories"
              description="Keep normalized rows and raw search-query fragments on separate retention windows. Categories define the opt-in data classes eligible for downstream features."
            />
          </CardHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Normalized rows</span>
              <Input
                type="number"
                min={1}
                max={365}
                value={config.browserHistoryRetentionDays}
                onChange={(event) =>
                  void saveField(
                    "browserHistoryRetentionDays",
                    Number.parseInt(event.target.value, 10),
                  )
                }
              />
              <span className="text-xs text-muted-foreground">Days</span>
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Search-query fragments</span>
              <Input
                type="number"
                min={1}
                max={90}
                value={config.browserHistorySearchQueryRetentionDays}
                onChange={(event) =>
                  void saveField(
                    "browserHistorySearchQueryRetentionDays",
                    Number.parseInt(event.target.value, 10),
                  )
                }
              />
              <span className="text-xs text-muted-foreground">Days</span>
            </label>
          </div>
          <div className="mt-5 grid gap-2 sm:grid-cols-2">
            {CATEGORIES.map(({ key, label }) => (
              <label
                key={key}
                className={cn(
                  "flex items-center gap-2 rounded-md border px-3 py-2 text-sm",
                  selectedCategorySet.has(key) && "border-primary/40 bg-primary/5",
                )}
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-input"
                  checked={selectedCategorySet.has(key)}
                  onChange={(event) => void updateCategory(key, event.target.checked)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader>
            <SectionLabel
              icon={Clock3}
              title="Lifecycle"
              description="Launch and health-check enabled browsers on unattended hosts so cloud sync has a chance to flush before snapshots are read."
            />
          </CardHeader>
          <div className="space-y-4">
            <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
              <span className="font-medium">Supervisor</span>
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-input"
                checked={lifecycleEnabled}
                onChange={(event) =>
                  void updateLifecycle({ enabled: event.target.checked })
                }
              />
            </label>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1 text-sm">
                <span className="font-medium">Check interval</span>
                <Input
                  type="number"
                  min={5}
                  max={360}
                  value={lifecycleConfig.check_interval_minutes}
                  onChange={(event) =>
                    void updateLifecycle({
                      check_interval_minutes: Number.parseInt(event.target.value, 10),
                    })
                  }
                />
                <span className="text-xs text-muted-foreground">Minutes</span>
              </label>
              <label className="grid gap-1 text-sm">
                <span className="font-medium">Concurrent launches</span>
                <Input
                  type="number"
                  min={1}
                  max={4}
                  value={lifecycleConfig.max_concurrent_launches}
                  onChange={(event) =>
                    void updateLifecycle({
                      max_concurrent_launches: Number.parseInt(event.target.value, 10),
                    })
                  }
                />
                <span className="text-xs text-muted-foreground">Browsers</span>
              </label>
            </div>

            <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
              <span className="font-medium">Respect quiet hours</span>
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-input"
                checked={lifecycleConfig.respect_quiet_hours}
                onChange={(event) =>
                  void updateLifecycle({
                    respect_quiet_hours: event.target.checked,
                  })
                }
              />
            </label>

            <div className="rounded-md border p-3 text-xs text-muted-foreground">
              Failure escalation pauses a browser after repeated launch or sync validation failures and resumes automatically after the cooldown window.
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
