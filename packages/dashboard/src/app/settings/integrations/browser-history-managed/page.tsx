"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  Download,
  Loader2,
  PlugZap,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import type {
  BrowserAutomationSiteActionResponse,
  BrowserAutomationSitesResponse,
  BrowserAutomationSiteStatusResponse,
  ChromiumInstallStartResponse,
  ChromiumInstallStatusResponse,
  ManagedChromiumActionResponse,
  ManagedChromiumSetupStatusResponse,
  ManagedChromiumStatusResponse,
} from "@aitne/shared";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { BrowserTaskHostnameDenylistCard } from "@/components/settings/browser-task-hostname-denylist-card";
import { api } from "@/lib/api-client";
import { formatTimestamp } from "@/lib/utils";
import {
  AUTOMATION_SITES_QUERY_KEY,
  MANAGED_STATUS_QUERY_KEY,
  useAutomationSites,
  useManagedStatus,
} from "@/lib/hooks/use-managed-chromium";

// useManagedStatus / useAutomationSites (and their query keys) are shared
// with the /browser hub — see lib/hooks/use-managed-chromium.ts
// (BROWSER_HUB_CONSOLIDATION_DESIGN.md). Keys are unchanged, so the
// invalidations below keep hitting the same cache entries.
const STATUS_QUERY_KEY = MANAGED_STATUS_QUERY_KEY;
const SITES_QUERY_KEY = AUTOMATION_SITES_QUERY_KEY;
const SETUP_QUERY_KEY = ["browser-history-managed-setup-status"] as const;
const INSTALL_STATUS_QUERY_KEY = [
  "managed-chromium-install-status",
] as const;

function useSetupStatus(enabled: boolean) {
  return useQuery({
    queryKey: SETUP_QUERY_KEY,
    queryFn: () =>
      api.get<ManagedChromiumSetupStatusResponse>(
        "/browser-history/managed/setup-status",
      ),
    refetchInterval: enabled ? 2_000 : false,
    enabled,
    staleTime: 1_000,
  });
}

/** Per-site bootstrap poll — fires only while the site card is in the
 *  `bootstrap_running` state. 2 s cadence mirrors the master sync-window
 *  poll. */
function useSiteSetupStatus(siteKey: string | null) {
  return useQuery({
    queryKey: ["browser-automation-site-status", siteKey] as const,
    queryFn: () =>
      api.get<BrowserAutomationSiteStatusResponse>(
        `/browser-automation/sites/${siteKey}/status`,
      ),
    refetchInterval: siteKey ? 2_000 : false,
    enabled: !!siteKey,
    staleTime: 1_000,
  });
}

/** Playwright Chromium install — progress poller. The cadence ramps
 *  up to 1 s while a download is mid-flight (so the progress bar feels
 *  live) and falls back to 5 s otherwise. The query is always mounted
 *  so the dashboard can read the "completed" / "failed" terminal state
 *  even after the user navigates away and comes back. */
function useInstallStatus() {
  return useQuery({
    queryKey: INSTALL_STATUS_QUERY_KEY,
    queryFn: () =>
      api.get<ChromiumInstallStatusResponse>(
        "/browser-history/managed/install-chromium/status",
      ),
    refetchInterval: (query) => {
      const s = query.state.data?.state;
      return s === "downloading" || s === "verifying" ? 1_000 : 5_000;
    },
    staleTime: 500,
  });
}

export default function ManagedChromiumPage() {
  const queryClient = useQueryClient();
  const status = useManagedStatus(15_000);
  const data = status.data;

  const bootstrapInProgress = Boolean(data?.bootstrapInProgress);
  const setupPoll = useSetupStatus(bootstrapInProgress);
  // Per-site authenticated profiles list. Only meaningful once the master
  // managed-Chromium flow is `ready` — the underlying Chromium binary /
  // sandbox primitives are shared with the master sign-in, so the
  // per-site UI is hidden until that prerequisite is satisfied.
  const sitesEnabled = data?.state === "ready";
  const sitesQuery = useAutomationSites(Boolean(sitesEnabled));

  // Install state — auto-ramps cadence to 1 s when downloading.
  const installStatusQuery = useInstallStatus();
  const installActive =
    installStatusQuery.data?.state === "downloading" ||
    installStatusQuery.data?.state === "verifying";
  const installStatusData = installStatusQuery.data;

  // Install transitions on its own cadence — the install mutation
  // resolves the moment `playwright install` spawns, NOT when it
  // finishes. Without this, the managed-Chromium status would only
  // notice `chromiumBinaryFound: true` on its 15 s poll, delaying both
  // the ConsentCard's `chromiumMissing` flip and the deferred-enable
  // effect inside it.
  const installCompleted = installStatusData?.state === "completed";
  useEffect(() => {
    if (installCompleted) {
      queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
    }
  }, [installCompleted, queryClient]);

  const installMutation = useMutation({
    mutationFn: () =>
      api.post<ChromiumInstallStartResponse>(
        "/browser-history/managed/install-chromium",
        {},
      ),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: INSTALL_STATUS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
    },
  });

  const enableMutation = useMutation({
    mutationFn: (body: { enabled: boolean; unsandboxedOptIn?: boolean }) =>
      api.post<ManagedChromiumActionResponse>(
        "/browser-history/managed/enable",
        body,
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY }),
  });

  const setupMutation = useMutation({
    mutationFn: () =>
      api.post<ManagedChromiumActionResponse>(
        "/browser-history/managed/setup",
        {},
      ),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: SETUP_QUERY_KEY });
    },
  });

  const finishMutation = useMutation({
    mutationFn: () =>
      api.post<ManagedChromiumActionResponse>(
        "/browser-history/managed/setup-finish",
        {},
      ),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: SETUP_QUERY_KEY });
    },
  });

  const reconnectMutation = useMutation({
    mutationFn: () =>
      api.post<ManagedChromiumActionResponse>(
        "/browser-history/managed/reconnect",
        {},
      ),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: SETUP_QUERY_KEY });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () =>
      api.post<ManagedChromiumActionResponse>(
        "/browser-history/managed/disconnect",
        {},
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY }),
  });

  const sandboxLabel = useMemo(() => {
    const kind = data?.sandboxPrimitive ?? "none";
    if (kind === "none") return "None (unsandboxed)";
    if (kind === "sandbox-exec") return "macOS sandbox-exec";
    if (kind === "bubblewrap") return "Linux bubblewrap";
    if (kind === "systemd-run") return "Linux systemd-run";
    if (kind === "appcontainer-jobobject") return "Windows AppContainer";
    return kind;
  }, [data?.sandboxPrimitive]);

  if (status.isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Browser Automation"
          description="Optional daemon-supervised Chromium for OAuth-bound sync + automation."
        />
        <Card>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Loading managed Chromium status…</span>
          </div>
        </Card>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Browser Automation"
          description="Optional daemon-supervised Chromium for OAuth-bound sync + automation."
        />
        <Alert variant="error">
          <div className="font-medium">Status unavailable.</div>
          <p className="mt-1">
            The daemon did not return a status payload for Browser
            Automation. Check the daemon logs and reload this page.
          </p>
        </Alert>
      </div>
    );
  }

  const consented = data.enabled;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Browser Automation"
        description="Optional daemon-supervised Chromium for OAuth-bound sync + automation."
        actions={<StatePill state={data.state} />}
      />

      {!consented && (
        <ConsentCard
          status={data}
          onAccept={() =>
            enableMutation.mutate({
              enabled: true,
              unsandboxedOptIn: data.sandboxPrimitive === "none" ? true : undefined,
            })
          }
          pending={enableMutation.isPending}
          enableError={enableMutation.error}
          installStatus={installStatusData ?? null}
          onInstall={() => installMutation.mutate()}
          installPending={installMutation.isPending || installActive}
        />
      )}

      {consented && (
        <>
          {data.state === "missing_binary" && (
            <Alert variant="error">
              <div className="font-medium">Chromium binary not found.</div>
              <p className="mt-1">
                Aitne can download the Playwright-managed Chromium build
                (~150 MiB) into your Playwright cache, or you can install
                Chromium via your OS package manager.
              </p>
              <InstallChromiumPanel
                status={installStatusData ?? null}
                onInstall={() => installMutation.mutate()}
                pending={installMutation.isPending}
              />
              <p className="mt-3 text-xs text-muted-foreground">
                OS-package alternative — macOS:{" "}
                <code>brew install --cask chromium</code>; Debian/Ubuntu:{" "}
                <code>sudo apt install chromium</code>; Fedora:{" "}
                <code>sudo dnf install chromium</code>; Windows:{" "}
                <code>winget install Hibbiki.Chromium</code> (or{" "}
                <code>choco install chromium</code>).
              </p>
            </Alert>
          )}

          {data.state === "missing_sandbox" && (
            <Alert variant="warning">
              <div className="font-medium">No OS sandbox primitive available.</div>
              <p className="mt-1">
                The host has neither <code>bwrap</code> nor <code>systemd-run</code> on PATH.
                Install <code>bubblewrap</code> (<code>sudo apt install bubblewrap</code>)
                or explicitly opt in to unsandboxed mode below.
              </p>
              <div className="mt-3">
                <Button
                  size="sm"
                  onClick={() =>
                    enableMutation.mutate({ enabled: true, unsandboxedOptIn: true })
                  }
                  disabled={enableMutation.isPending}
                >
                  Enable unsandboxed (not recommended)
                </Button>
              </div>
            </Alert>
          )}

          <StatusCard status={data} sandboxLabel={sandboxLabel} />

          {bootstrapInProgress ? (
            <BootstrapCard
              setupStatus={setupPoll.data}
              onFinish={() => finishMutation.mutate()}
              finishPending={finishMutation.isPending}
            />
          ) : (
            <ActionCard
              status={data}
              onSetup={() => setupMutation.mutate()}
              setupPending={setupMutation.isPending}
              onReconnect={() => reconnectMutation.mutate()}
              reconnectPending={reconnectMutation.isPending}
              onDisconnect={() => disconnectMutation.mutate()}
              disconnectPending={disconnectMutation.isPending}
            />
          )}

          {sitesEnabled && (
            <SitesSection
              sites={sitesQuery.data?.sites ?? []}
              isLoading={sitesQuery.isLoading}
              onMutated={() => {
                queryClient.invalidateQueries({ queryKey: SITES_QUERY_KEY });
              }}
            />
          )}

          {sitesEnabled && <B4SubpageCard />}
        </>
      )}

      {/*
        2026-05-27 open-navigation revision — user-curated hostname
        exclusion list for the browser-task surface. Replaces the
        previously-hardcoded HOSTNAME_DENYLIST. Surface lives here
        (under Browser Automation settings) because browser-task is
        the surface the list gates. Empty by default.
       */}
      <BrowserTaskHostnameDenylistCard />
    </div>
  );
}

/**
 * Inline panel surfacing the Playwright opt-in install button + live
 * progress bar. Re-used inside the `missing_binary` alert and inside
 * the ConsentCard's sandbox-warning block so the operator can trigger
 * the download in either place.
 */
function InstallChromiumPanel({
  status,
  onInstall,
  pending,
}: {
  status: ChromiumInstallStatusResponse | null;
  onInstall: () => void;
  pending: boolean;
}) {
  const state = status?.state ?? "idle";
  const downloading = state === "downloading" || state === "verifying";
  const percent = status?.progressPercent ?? 0;
  const total = status?.totalMib;
  const downloaded = status?.downloadedMib;
  // Throughput + elapsed surface so the user can tell a slow download
  // from a stuck one. Playwright's CDN can take 30+ seconds to start
  // serving bytes; without these numbers the panel looks frozen.
  // Re-render every second while downloading so the elapsed clock ticks
  // even when no fresh `/status` payload arrived this poll cycle.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!downloading) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [downloading]);
  const elapsedMs =
    status?.startedAt != null ? Math.max(0, now - status.startedAt) : 0;
  const elapsedLabel = formatElapsed(elapsedMs);
  const speedMibPerSec =
    downloaded != null && elapsedMs > 1000
      ? downloaded / (elapsedMs / 1000)
      : null;
  const speedLabel =
    speedMibPerSec != null && speedMibPerSec > 0
      ? `${speedMibPerSec.toFixed(1)} MiB/s`
      : null;
  return (
    <div className="mt-3 space-y-2">
      {state === "completed" ? (
        <div className="inline-flex items-center gap-2 rounded-md bg-success/10 px-3 py-1.5 text-sm text-success">
          <CheckCircle2 className="h-4 w-4" />
          Chromium installed
          {status?.binaryPath ? (
            <code className="ml-1 text-xs text-success/70">
              {shortPath(status.binaryPath)}
            </code>
          ) : null}
        </div>
      ) : downloading ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {state === "verifying"
                ? "Verifying download…"
                : "Downloading Chromium…"}
            </span>
            <span>
              {percent}%
              {downloaded != null && total != null
                ? ` (${downloaded} / ${total} MiB)`
                : null}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-500"
              style={{ width: `${Math.max(2, percent)}%` }}
              aria-label={`Install progress ${percent}%`}
            />
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Elapsed {elapsedLabel}</span>
            {speedLabel ? <span>{speedLabel}</span> : <span>connecting…</span>}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={onInstall}
            disabled={pending}
          >
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {state === "failed"
              ? "Retry download (~150 MiB)"
              : "Download Chromium (~150 MiB)"}
          </Button>
          {state === "failed" && status?.errorMessage ? (
            <span className="text-xs text-destructive">{status.errorMessage}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}m ${sec.toString().padStart(2, "0")}s` : `${sec}s`;
}

function shortPath(p: string): string {
  if (p.length <= 60) return p;
  return `…${p.slice(p.length - 57)}`;
}

function B4SubpageCard() {
  return (
    <Card tone="warning">
      <CardHeader className="items-start">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-warning" />
            <CardTitle className="text-base">
              Experimental purchase confirmations (B-4)
            </CardTitle>
          </div>
          <p className="text-sm text-muted-foreground">
            DM-token-gated checkout flows. Default off — every safety gate
            (master toggle, per-site caps, primary DM channel, §23 hard-deny
            categories) is configured on a dedicated page.
          </p>
        </div>
        <Link
          href="/settings/integrations/browser-history-managed/b4"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent"
        >
          Open B-4 settings
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </CardHeader>
    </Card>
  );
}

function StatePill({ state }: { state: ManagedChromiumStatusResponse["state"] }) {
  if (state === "ready") {
    return (
      <Badge variant="green">
        <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Ready
      </Badge>
    );
  }
  if (state === "needs_setup") {
    return (
      <Badge variant="gray">
        <PlugZap className="mr-1 h-3.5 w-3.5" /> Needs setup
      </Badge>
    );
  }
  if (state === "needs_reauth") {
    return (
      <Badge variant="amber">
        <ShieldAlert className="mr-1 h-3.5 w-3.5" /> Re-auth needed
      </Badge>
    );
  }
  if (state === "missing_binary" || state === "missing_sandbox") {
    return (
      <Badge variant="red">
        <XCircle className="mr-1 h-3.5 w-3.5" /> {state.replace("_", " ")}
      </Badge>
    );
  }
  if (state === "disconnected") {
    return <Badge variant="gray">Disconnected</Badge>;
  }
  return <Badge variant="gray">Off</Badge>;
}

function ConsentCard({
  status,
  onAccept,
  pending,
  enableError,
  installStatus,
  onInstall,
  installPending,
}: {
  status: ManagedChromiumStatusResponse;
  onAccept: () => void;
  pending: boolean;
  enableError: unknown;
  installStatus: ChromiumInstallStatusResponse | null;
  onInstall: () => void;
  installPending: boolean;
}) {
  const sandboxNone = status.sandboxPrimitive === "none";
  const chromiumMissing = !status.chromiumBinaryFound;
  const installState = installStatus?.state ?? "idle";
  const installing =
    installState === "downloading" || installState === "verifying";

  // Auto-install-then-enable flow. Clicking the consent button when
  // Chromium is missing triggers `playwright install chromium` first;
  // when the install completes and the status query re-fetches with
  // `chromiumBinaryFound=true`, the effect below fires the deferred
  // enable call. Without this, the daemon's enable handler 409s on
  // `missing_binary` and the click appears to do nothing.
  const [deferredEnable, setDeferredEnable] = useState(false);
  const onAcceptRef = useRef(onAccept);
  useEffect(() => {
    onAcceptRef.current = onAccept;
  }, [onAccept]);
  useEffect(() => {
    if (!deferredEnable) return;
    if (chromiumMissing) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing a one-shot trigger after firing it is the documented pattern; mirrors managed-tasks-card.tsx:412
    setDeferredEnable(false);
    onAcceptRef.current();
  }, [chromiumMissing, deferredEnable]);
  useEffect(() => {
    if (installState === "failed" && deferredEnable) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing a deferred opt-in when its precondition (install success) is no longer reachable
      setDeferredEnable(false);
    }
  }, [installState, deferredEnable]);

  const installFailed = installState === "failed";
  const handleAccept = () => {
    if (chromiumMissing) {
      setDeferredEnable(true);
      if (!installing) onInstall();
      return;
    }
    onAccept();
  };

  const showInstalling = chromiumMissing && (installing || deferredEnable);
  const buttonLabel = chromiumMissing
    ? showInstalling
      ? "Installing Chromium…"
      : installFailed
        ? "Retry: download Chromium then enable"
        : "Download Chromium (~150 MiB) then enable"
    : "I understand — enable Browser Automation";

  const buttonDisabled = pending || installPending || showInstalling;

  const enableErrorMessage =
    enableError instanceof Error ? enableError.message : null;

  return (
    <Card tone="warning">
      <CardHeader>
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-warning" />
          <CardTitle className="text-base">
            Consent required to enable Browser Automation
          </CardTitle>
        </div>
      </CardHeader>

      <div className="space-y-4 text-sm leading-relaxed text-foreground">
        <p>
          Aitne wants to run a dedicated Chromium browser signed in to your
          Google account so it can continuously sync your phone&apos;s browser
          history and, on opt-in, drive open-ended tasks on signed-in sites.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-border bg-background/60 p-3 dark:bg-background/30">
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-warning">
              <ShieldAlert className="h-3.5 w-3.5" /> Risk
            </div>
            <p className="mt-1.5">
              Aitne holds an OAuth refresh token for your Google account. If
              the daemon were ever compromised, an attacker could use that
              token to access your Gmail, Drive, Calendar, and other Google
              services.
            </p>
          </div>
          <div className="rounded-md border border-border bg-background/60 p-3 dark:bg-background/30">
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-success">
              <ShieldCheck className="h-3.5 w-3.5" /> Mitigations
            </div>
            <p className="mt-1.5">
              Chromium runs under an OS-level sandbox (
              <code className="font-mono text-xs">{status.sandboxPrimitive}</code>
              ) and cannot exfiltrate to arbitrary networks. The agent layer
              has no tool capable of reading the profile directory.
              Disconnecting at any time removes the token from this machine.
            </p>
          </div>
        </div>

        {sandboxNone && (
          <Alert variant="warning">
            <div className="font-medium">
              No sandbox primitive detected on this host.
            </div>
            <p className="mt-1">
              Enabling will run Chromium unsandboxed. We strongly recommend
              installing <code className="mx-1">bubblewrap</code> or{" "}
              <code className="mx-1">systemd-run</code> before proceeding.
            </p>
          </Alert>
        )}

        {chromiumMissing && (
          <Alert variant="warning">
            <div className="font-medium">Chromium isn&apos;t installed yet.</div>
            <p className="mt-1">
              Clicking the button below will download the Playwright-managed
              Chromium build (~150 MiB) into your Playwright cache and then
              enable Browser Automation. You can also start the download
              manually here:
            </p>
            <InstallChromiumPanel
              status={installStatus}
              onInstall={onInstall}
              pending={installPending}
            />
            <p className="mt-3 text-xs text-muted-foreground">
              OS-package alternative — macOS:{" "}
              <code>brew install --cask chromium</code>; Debian/Ubuntu:{" "}
              <code>sudo apt install chromium</code>; Fedora:{" "}
              <code>sudo dnf install chromium</code>; Windows:{" "}
              <code>winget install Hibbiki.Chromium</code> (or{" "}
              <code>choco install chromium</code>).
            </p>
          </Alert>
        )}

        {enableErrorMessage && (
          <Alert variant="error">
            <div className="font-medium">Enable failed.</div>
            <p className="mt-1">{enableErrorMessage}</p>
          </Alert>
        )}

        <p className="text-muted-foreground">
          <strong className="font-medium text-foreground">Alternative.</strong>{" "}
          The unmanaged Browser History integration on the other settings page
          works against your existing Chrome installation without holding an
          OAuth token.
        </p>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button onClick={handleAccept} disabled={buttonDisabled} size="sm">
            {pending || showInstalling ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            )}
            {buttonLabel}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function StatusCard({
  status,
  sandboxLabel,
}: {
  status: ManagedChromiumStatusResponse;
  sandboxLabel: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Sync status</CardTitle>
      </CardHeader>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Row label="Signed-in user" value={status.signedInUser ?? "—"} />
        <Row label="Sandbox" value={sandboxLabel} />
        <Row
          label="Last successful check"
          value={formatTimestamp(status.lastCheckAt, "Never")}
        />
        <Row
          label="Last sync (History mtime)"
          value={formatTimestamp(status.lastSyncAt, "Never")}
        />
        <Row
          label="Consecutive failures"
          value={String(status.consecutiveFailures)}
        />
        <Row
          label="Paused until"
          value={formatTimestamp(status.pausedUntil)}
        />
        <Row
          label="Chromium binary"
          value={status.chromiumBinaryFound ? "Found" : "Not installed"}
        />
        <Row label="Display present" value={status.hasDisplay ? "Yes" : "No"} />
      </dl>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-44 shrink-0 text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  );
}

function BootstrapCard({
  setupStatus,
  onFinish,
  finishPending,
}: {
  setupStatus: ManagedChromiumSetupStatusResponse | undefined;
  onFinish: () => void;
  finishPending: boolean;
}) {
  const signedIn = setupStatus?.state === "running" && setupStatus.signedIn;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Clock3 className="h-5 w-5 text-primary" />
          <CardTitle className="text-base">Sign-in in progress</CardTitle>
        </div>
      </CardHeader>

      <div className="space-y-3 text-sm">
        <p>
          A Chromium window is open. Complete the Google sign-in (including
          2FA if prompted). Once you&apos;re signed in, the dashboard will
          automatically detect the change and you can confirm below.
        </p>
        <div className="flex items-center gap-3">
          {signedIn ? (
            <Badge variant="green">
              <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Signed in as{" "}
              {setupStatus?.observedUser ?? "(unknown)"}
            </Badge>
          ) : (
            <Badge variant="gray">
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Waiting for
              sign-in…
            </Badge>
          )}
        </div>
        <div>
          <Button
            onClick={onFinish}
            disabled={!signedIn || finishPending}
            size="sm"
          >
            {finishPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            Confirm + close sign-in window
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ActionCard({
  status,
  onSetup,
  setupPending,
  onReconnect,
  reconnectPending,
  onDisconnect,
  disconnectPending,
}: {
  status: ManagedChromiumStatusResponse;
  onSetup: () => void;
  setupPending: boolean;
  onReconnect: () => void;
  reconnectPending: boolean;
  onDisconnect: () => void;
  disconnectPending: boolean;
}) {
  const canSetup =
    status.state === "needs_setup"
    && status.chromiumBinaryFound
    && status.sandboxPrimitive !== "none";
  const canReconnect =
    status.state === "needs_reauth" || status.state === "ready";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Actions</CardTitle>
      </CardHeader>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onSetup} disabled={!canSetup || setupPending}>
          {setupPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <PlugZap className="h-4 w-4" />
          )}
          Connect Google account
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onReconnect}
          disabled={!canReconnect || reconnectPending}
        >
          {reconnectPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Reconnect / re-authenticate
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-destructive text-destructive hover:bg-destructive/10"
          onClick={onDisconnect}
          disabled={disconnectPending}
        >
          {disconnectPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <AlertTriangle className="h-4 w-4" />
          )}
          Disconnect
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Disconnect quits the managed Chromium, deletes the profile directory
        from this device, and clears the cached state. Revoke the OAuth grant
        separately at{" "}
        <a
          href="https://myaccount.google.com/permissions"
          className="underline"
          target="_blank"
          rel="noreferrer"
        >
          myaccount.google.com/permissions
        </a>{" "}
        for full account-side revocation.
      </p>
    </Card>
  );
}

/**
 * Phase B-2.5 per-site authenticated-profile section. Renders one
 * card per registered site (the frozen `SITE_REGISTRY` — at the time
 * of writing: `amazon_jp`, `amazon_com`, `netflix`, `x_com`,
 * `facebook`, `instagram`, `linkedin`; the canonical list is whatever
 * `/api/browser-automation/sites` returns, not this comment). Each
 * card surfaces the connection state and exposes Connect / Re-auth /
 * Disconnect mutations against `/api/browser-automation/sites/{siteKey}/*`.
 *
 * Per §16.3 of MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md the dashboard
 * is the only place these mutations can originate; the agent has no
 * `Approve`-tier credential and the workflow runner returns
 * `site_not_connected` until the user finishes the flow here.
 */
function SitesSection({
  sites,
  isLoading,
  onMutated,
}: {
  sites: BrowserAutomationSitesResponse["sites"];
  isLoading: boolean;
  onMutated: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Authenticated sites</CardTitle>
      </CardHeader>

      <p className="text-sm text-muted-foreground">
        Sign in once per site to let Aitne run authenticated browser tasks
        (e.g. fetch your Amazon order history). Each site keeps a separate
        profile dir under{" "}
        <code>~/.personal-agent/chromium-automation-auth/&lt;site&gt;/</code>;
        cookies for one site are never reachable from another.
      </p>
      <div className="mt-4 space-y-3">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading sites…
          </div>
        )}
        {!isLoading && sites.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No sites registered. Add an entry to{" "}
            <code>site-registry.ts</code> and rebuild the daemon.
          </p>
        )}
        {sites.map((site) => (
          <SiteCard key={site.siteKey} site={site} onMutated={onMutated} />
        ))}
      </div>
    </Card>
  );
}

function SiteCard({
  site,
  onMutated,
}: {
  site: BrowserAutomationSitesResponse["sites"][number];
  onMutated: () => void;
}) {
  // Only poll the per-site bootstrap status endpoint while the card is
  // actually in the bootstrap_running state — otherwise we'd issue an
  // extra fetch per site every 2 s for nothing.
  const polledSiteKey = site.state === "bootstrap_running" ? site.siteKey : null;
  const setup = useSiteSetupStatus(polledSiteKey);

  const connectMutation = useMutation({
    mutationFn: () =>
      api.post<BrowserAutomationSiteActionResponse>(
        `/browser-automation/sites/${site.siteKey}/connect`,
        {},
      ),
    onSettled: onMutated,
  });
  const finalizeMutation = useMutation({
    mutationFn: () =>
      api.post<BrowserAutomationSiteActionResponse>(
        `/browser-automation/sites/${site.siteKey}/finalize`,
        {},
      ),
    onSettled: onMutated,
  });
  const reauthMutation = useMutation({
    mutationFn: () =>
      api.post<BrowserAutomationSiteActionResponse>(
        `/browser-automation/sites/${site.siteKey}/reauth`,
        {},
      ),
    onSettled: onMutated,
  });
  const disconnectMutation = useMutation({
    mutationFn: () =>
      api.post<BrowserAutomationSiteActionResponse>(
        `/browser-automation/sites/${site.siteKey}/disconnect`,
        {},
      ),
    onSettled: onMutated,
  });

  const stateBadge = (() => {
    if (site.state === "connected") {
      return (
        <Badge variant="green">
          <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Connected
        </Badge>
      );
    }
    if (site.state === "bootstrap_running") {
      return (
        <Badge variant="gray">
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Signing in…
        </Badge>
      );
    }
    if (site.state === "needs_reauth") {
      return (
        <Badge variant="amber">
          <ShieldAlert className="mr-1 h-3.5 w-3.5" /> Re-auth needed
        </Badge>
      );
    }
    return <Badge variant="gray">Not connected</Badge>;
  })();

  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">{site.displayName}</div>
          <div className="text-xs text-muted-foreground">
            <code>{site.siteKey}</code> · session max{" "}
            {site.sessionMaxAgeDays} d
            {site.accountLabel ? ` · ${site.accountLabel}` : ""}
            {site.connectedAt
              ? ` · connected ${formatTimestamp(site.connectedAt)}`
              : ""}
          </div>
        </div>
        {stateBadge}
      </div>

      {site.state === "bootstrap_running" && (
        <div className="mt-3 rounded-md border border-primary/40 bg-primary/10 p-3 text-xs text-primary">
          <div className="flex items-center gap-2 font-medium">
            <Clock3 className="h-3.5 w-3.5" /> Sign-in window open
          </div>
          <p className="mt-1">
            Complete the sign-in in the Chromium window that just opened.
            Aitne is watching for{" "}
            <code className="font-mono">
              {setup.data?.signedIn
                ? `the signed-in selector (detected${
                    setup.data.accountLabel
                      ? ` as ${setup.data.accountLabel}`
                      : ""
                  })`
                : "the signed-in selector to resolve"}
            </code>
            .
          </p>
          <div className="mt-2">
            <Button
              size="sm"
              onClick={() => finalizeMutation.mutate()}
              disabled={!setup.data?.signedIn || finalizeMutation.isPending}
            >
              {finalizeMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              Confirm + close window
            </Button>
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {site.state === "not_connected" && (
          <Button
            size="sm"
            onClick={() => connectMutation.mutate()}
            disabled={connectMutation.isPending}
          >
            {connectMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <PlugZap className="h-4 w-4" />
            )}
            Connect {site.displayName}
          </Button>
        )}
        {(site.state === "needs_reauth" || site.state === "connected") && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => reauthMutation.mutate()}
            disabled={reauthMutation.isPending}
          >
            {reauthMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Re-authenticate
          </Button>
        )}
        {(site.state === "connected"
          || site.state === "needs_reauth"
          || site.state === "bootstrap_running") && (
          <Button
            size="sm"
            variant="outline"
            className="border-destructive text-destructive hover:bg-destructive/10"
            onClick={() => disconnectMutation.mutate()}
            disabled={disconnectMutation.isPending}
          >
            {disconnectMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <AlertTriangle className="h-4 w-4" />
            )}
            Disconnect
          </Button>
        )}
      </div>
    </div>
  );
}

