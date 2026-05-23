"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Loader2,
  PlugZap,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import type {
  BrowserAutomationApprovalDenyResponse,
  BrowserAutomationApprovalIssueResponse,
  BrowserAutomationApprovalRow,
  BrowserAutomationApprovalsListResponse,
  BrowserAutomationObservationGateResponse,
  BrowserAutomationSiteActionResponse,
  BrowserAutomationSitesResponse,
  BrowserAutomationSiteStatusResponse,
  ManagedChromiumActionResponse,
  ManagedChromiumSetupStatusResponse,
  ManagedChromiumStatusResponse,
} from "@aitne/shared";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { api } from "@/lib/api-client";

const STATUS_QUERY_KEY = ["browser-history-managed-status"] as const;
const SETUP_QUERY_KEY = ["browser-history-managed-setup-status"] as const;
const SITES_QUERY_KEY = ["browser-automation-sites"] as const;
const APPROVALS_QUERY_KEY = ["browser-automation-approvals"] as const;
const OBSERVATION_GATE_QUERY_KEY = [
  "browser-automation-observation-gate",
] as const;

function useManagedStatus(refetchIntervalMs?: number) {
  return useQuery({
    queryKey: STATUS_QUERY_KEY,
    queryFn: () =>
      api.get<ManagedChromiumStatusResponse>("/browser-history/managed/status"),
    refetchInterval: refetchIntervalMs ?? false,
    staleTime: 5_000,
  });
}

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

/** B-2.5 — list of registered per-site auth profiles. Refetched
 *  alongside the master managed-Chromium status so per-site state
 *  changes propagate without a hard reload. */
function useSites(enabled: boolean) {
  return useQuery({
    queryKey: SITES_QUERY_KEY,
    queryFn: () =>
      api.get<BrowserAutomationSitesResponse>("/browser-automation/sites"),
    refetchInterval: enabled ? 15_000 : false,
    enabled,
    staleTime: 5_000,
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

/** Phase B-3 — list of pending + recent approvals. Polled while
 *  managed Chromium is ready so the user sees new pending rows as
 *  they arrive from the agent. */
function useApprovals(enabled: boolean) {
  return useQuery({
    queryKey: APPROVALS_QUERY_KEY,
    queryFn: () =>
      api.get<BrowserAutomationApprovalsListResponse>(
        "/browser-automation/approvals",
      ),
    refetchInterval: enabled ? 5_000 : false,
    enabled,
    staleTime: 2_000,
  });
}

/** Phase B-3 — observation-gate panel data. Polled at a slow cadence
 *  (60 s) — the underlying aggregates change at the workflow run
 *  granularity, which is on the order of minutes. */
function useObservationGate(enabled: boolean) {
  return useQuery({
    queryKey: OBSERVATION_GATE_QUERY_KEY,
    queryFn: () =>
      api.get<BrowserAutomationObservationGateResponse>(
        "/browser-automation/observation-gate",
      ),
    refetchInterval: enabled ? 60_000 : false,
    enabled,
    staleTime: 30_000,
  });
}

export default function ManagedChromiumPage() {
  const queryClient = useQueryClient();
  const status = useManagedStatus(15_000);
  const data = status.data;

  const bootstrapInProgress = Boolean(data?.bootstrapInProgress);
  const setupPoll = useSetupStatus(bootstrapInProgress);
  // B-2.5 — per-site authenticated profiles list. Only meaningful when
  // the master managed-Chromium flow is `ready`; when it isn't, the
  // per-site UI is hidden (the user has to finish the B-1 sign-in
  // first because the underlying Chromium binary / sandbox primitive
  // checks are shared).
  const sitesEnabled = data?.state === "ready";
  const sitesQuery = useSites(Boolean(sitesEnabled));
  // B-3 surfaces — approvals + observation gate panels are visible once
  // the managed Chromium flow is ready. The agent's needs_approval
  // responses surface here; the §10 readiness panel reports whether
  // B-3 is on track to ship behind a green / amber / red rollup.
  const approvalsEnabled = sitesEnabled;
  const approvalsQuery = useApprovals(Boolean(approvalsEnabled));
  const observationGateQuery = useObservationGate(Boolean(approvalsEnabled));

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
          title="Browser History — Managed Chromium"
          description="Optional daemon-supervised Chromium for OAuth-bound sync + automation."
        />
        <Card>
          <CardHeader className="flex flex-row items-center gap-3">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Loading managed Chromium status…</span>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Browser History — Managed Chromium"
          description="Optional daemon-supervised Chromium for OAuth-bound sync + automation."
        />
        <Alert variant="error">
          <div className="font-medium">Status unavailable.</div>
          <p className="mt-1">
            The daemon did not return a managed-chromium status payload. Check the daemon logs
            and reload this page.
          </p>
        </Alert>
      </div>
    );
  }

  const consented = data.enabled;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Browser History — Managed Chromium"
        description="Optional daemon-supervised Chromium for OAuth-bound sync + automation."
      >
        <StatePill state={data.state} />
      </PageHeader>

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
        />
      )}

      {consented && (
        <>
          {data.state === "missing_binary" && (
            <Alert variant="error">
              <div className="font-medium">Chromium binary not found.</div>
              <p className="mt-1">
                Install Chromium first. On macOS: <code>brew install --cask chromium</code>.
                On Debian/Ubuntu: <code>sudo apt install chromium</code>. On Fedora: <code>
                  sudo dnf install chromium</code>.
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

          {approvalsEnabled && (
            <ApprovalsSection
              data={approvalsQuery.data}
              isLoading={approvalsQuery.isLoading}
              onMutated={() => {
                queryClient.invalidateQueries({
                  queryKey: APPROVALS_QUERY_KEY,
                });
              }}
            />
          )}

          {approvalsEnabled && (
            <ObservationGateSection
              data={observationGateQuery.data}
              isLoading={observationGateQuery.isLoading}
            />
          )}
        </>
      )}
    </div>
  );
}

function StatePill({ state }: { state: ManagedChromiumStatusResponse["state"] }) {
  if (state === "ready") {
    return (
      <Badge variant="default" className="bg-emerald-100 text-emerald-900">
        <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Ready
      </Badge>
    );
  }
  if (state === "needs_setup") {
    return <Badge variant="gray"><PlugZap className="mr-1 h-3.5 w-3.5" /> Needs setup</Badge>;
  }
  if (state === "needs_reauth") {
    return (
      <Badge variant="gray" className="border-amber-500 text-amber-700">
        <ShieldAlert className="mr-1 h-3.5 w-3.5" /> Re-auth needed
      </Badge>
    );
  }
  if (state === "missing_binary" || state === "missing_sandbox") {
    return (
      <Badge variant="gray" className="border-red-500 text-red-700">
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
}: {
  status: ManagedChromiumStatusResponse;
  onAccept: () => void;
  pending: boolean;
}) {
  const sandboxNone = status.sandboxPrimitive === "none";
  return (
    <Card className="border-amber-300 bg-amber-50">
      <CardHeader>
        <div className="flex items-center gap-2 text-base font-semibold">
          <ShieldAlert className="h-5 w-5 text-amber-700" />
          Managed Chromium is off until you consent.
        </div>
        <div className="mt-3 space-y-3 text-sm leading-relaxed">
          <p>
            Enabling Managed Chromium gives Aitne control of a dedicated browser process signed
            in to your Google account. This allows continuous phone-history sync and, in later
            phases, opt-in automation workflows.
          </p>
          <p>
            <strong>What this means.</strong> Aitne will hold an OAuth refresh token for your
            Google account. If the Aitne daemon were ever compromised, an attacker could use
            that token to access your Gmail, Drive, Calendar, and other Google services.
          </p>
          <p>
            <strong>Mitigations.</strong> The Chromium process runs under an OS-level sandbox
            ({status.sandboxPrimitive}) and cannot exfiltrate to arbitrary networks. The agent
            layer has no tool capable of reading the profile directory. Disconnecting at any
            time removes the token from this machine.
          </p>
          {sandboxNone && (
            <Alert variant="warning">
              <div className="font-medium">No sandbox primitive detected on this host.</div>
              <p className="mt-1">
                Enabling will run Chromium unsandboxed. We strongly recommend installing
                <code className="mx-1">bubblewrap</code>or
                <code className="mx-1">systemd-run</code>before proceeding.
              </p>
            </Alert>
          )}
          <p>
            <strong>Alternative.</strong> The unmanaged Browser History integration on the
            other settings page works against your existing Chrome installation without holding
            an OAuth token.
          </p>
          <div className="pt-2">
            <Button onClick={onAccept} disabled={pending} size="sm">
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              I understand — enable Managed Chromium
            </Button>
          </div>
        </div>
      </CardHeader>
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
        <div className="text-base font-semibold">Sync status</div>
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Row label="Signed-in user" value={status.signedInUser ?? "—"} />
          <Row label="Sandbox" value={sandboxLabel} />
          <Row
            label="Last successful check"
            value={status.lastCheckAt ? formatTime(status.lastCheckAt) : "Never"}
          />
          <Row
            label="Last sync (History mtime)"
            value={status.lastSyncAt ? formatTime(status.lastSyncAt) : "Never"}
          />
          <Row
            label="Consecutive failures"
            value={String(status.consecutiveFailures)}
          />
          <Row
            label="Paused until"
            value={status.pausedUntil ? formatTime(status.pausedUntil) : "—"}
          />
          <Row
            label="Chromium binary"
            value={status.chromiumBinaryFound ? "Found" : "Not installed"}
          />
          <Row label="Display present" value={status.hasDisplay ? "Yes" : "No"} />
        </dl>
      </CardHeader>
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
        <div className="flex items-center gap-2 text-base font-semibold">
          <Clock3 className="h-5 w-5 text-blue-600" />
          Sign-in in progress
        </div>
        <p className="mt-2 text-sm">
          A Chromium window is open. Complete the Google sign-in (including 2FA if prompted).
          Once you&apos;re signed in, the dashboard will automatically detect the change and you
          can confirm below.
        </p>
        <div className="mt-3 flex items-center gap-3 text-sm">
          {signedIn ? (
            <Badge variant="default" className="bg-emerald-100 text-emerald-900">
              <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Signed in as {setupStatus?.observedUser ?? "(unknown)"}
            </Badge>
          ) : (
            <Badge variant="gray">
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Waiting for sign-in…
            </Badge>
          )}
        </div>
        <div className="mt-4">
          <Button onClick={onFinish} disabled={!signedIn || finishPending} size="sm">
            {finishPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Confirm + close sign-in window
          </Button>
        </div>
      </CardHeader>
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
        <div className="text-base font-semibold">Actions</div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onSetup} disabled={!canSetup || setupPending}>
            {setupPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
            Connect Google account
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onReconnect}
            disabled={!canReconnect || reconnectPending}
          >
            {reconnectPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Reconnect / re-authenticate
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="border-red-500 text-red-700 hover:bg-red-50"
            onClick={onDisconnect}
            disabled={disconnectPending}
          >
            {disconnectPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlertTriangle className="h-4 w-4" />}
            Disconnect
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Disconnect quits the managed Chromium, deletes the profile directory from this device,
          and clears the cached state. Revoke the OAuth grant separately at
          {" "}
          <a
            href="https://myaccount.google.com/permissions"
            className="underline"
            target="_blank"
            rel="noreferrer"
          >myaccount.google.com/permissions</a> for full account-side revocation.
        </p>
      </CardHeader>
    </Card>
  );
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

/**
 * Phase B-2.5 per-site authenticated-profile section. Renders one
 * card per registered site (the frozen `SITE_REGISTRY` —
 * `amazon_jp` / `amazon_com` / `netflix` at MVP). Each card surfaces
 * the connection state and exposes Connect / Re-auth / Disconnect
 * mutations against `/api/browser-automation/sites/{siteKey}/*`.
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
        <div className="text-base font-semibold">Authenticated sites (B-2.5)</div>
        <p className="mt-2 text-sm text-muted-foreground">
          Sign in once per site to let Aitne run authenticated workflows
          (e.g. fetch your Amazon order history). Each site keeps a
          separate profile dir under{" "}
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
            <SiteCard
              key={site.siteKey}
              site={site}
              onMutated={onMutated}
            />
          ))}
        </div>
      </CardHeader>
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
        <Badge variant="default" className="bg-emerald-100 text-emerald-900">
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
        <Badge variant="gray" className="border-amber-500 text-amber-700">
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
              ? ` · connected ${formatTime(site.connectedAt)}`
              : ""}
          </div>
        </div>
        {stateBadge}
      </div>

      {site.state === "bootstrap_running" && (
        <div className="mt-3 rounded-sm border border-blue-200 bg-blue-50 p-3 text-xs">
          <div className="flex items-center gap-2 font-medium text-blue-900">
            <Clock3 className="h-3.5 w-3.5" /> Sign-in window open
          </div>
          <p className="mt-1 text-blue-900">
            Complete the sign-in in the Chromium window that just
            opened. Aitne is watching for{" "}
            <code className="text-blue-900">
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
              disabled={
                !setup.data?.signedIn || finalizeMutation.isPending
              }
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
            className="border-red-500 text-red-700 hover:bg-red-50"
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

// ─────────────────────────────────────────────────────────────────────
// Phase B-3 — pending-approvals panel + observation-gate panel.
// MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §10 / §13 steps 43-46.
// ─────────────────────────────────────────────────────────────────────

function ApprovalsSection({
  data,
  isLoading,
  onMutated,
}: {
  data: BrowserAutomationApprovalsListResponse | undefined;
  isLoading: boolean;
  onMutated: () => void;
}) {
  const pending = data?.pending ?? [];
  const recent = data?.recent ?? [];
  return (
    <Card>
      <CardHeader>
        <div className="text-base font-semibold">
          Workflow approvals (B-3)
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          Phase B-3 write workflows (e.g. <code>subscribeToNewsletter</code>,
          <code>fillAndSaveForm</code>) ask for an explicit per-invocation
          approval. The agent requests; you approve below; you paste the
          minted token into the next agent prompt. Tokens are single-use,
          expire after 5 minutes, and are never re-shown.
        </p>
        <div className="mt-4 space-y-3">
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading approvals…
            </div>
          )}
          {!isLoading && pending.length === 0 && recent.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No pending or recent approval requests.
            </p>
          )}
          {pending.length > 0 && (
            <div className="space-y-2">
              <div className="text-sm font-medium">
                Pending ({pending.length})
              </div>
              {pending.map((row) => (
                <PendingApprovalCard
                  key={row.id}
                  row={row}
                  onMutated={onMutated}
                />
              ))}
            </div>
          )}
          {recent.length > 0 && (
            <div className="space-y-2">
              <div className="mt-4 text-sm font-medium">
                Recent ({recent.length})
              </div>
              {recent.map((row) => (
                <RecentApprovalCard key={row.id} row={row} />
              ))}
            </div>
          )}
        </div>
      </CardHeader>
    </Card>
  );
}

function PendingApprovalCard({
  row,
  onMutated,
}: {
  row: BrowserAutomationApprovalRow;
  onMutated: () => void;
}) {
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [denyReason, setDenyReason] = useState("");
  const [showDenyForm, setShowDenyForm] = useState(false);

  const approveMutation = useMutation({
    mutationFn: () =>
      api.post<BrowserAutomationApprovalIssueResponse>(
        `/browser-automation/approvals/${row.id}/approve`,
        {},
      ),
    onSuccess: (res) => {
      setIssuedToken(res.token);
      onMutated();
    },
    onSettled: onMutated,
  });

  const denyMutation = useMutation({
    mutationFn: () =>
      api.post<BrowserAutomationApprovalDenyResponse>(
        `/browser-automation/approvals/${row.id}/deny`,
        denyReason.trim().length > 0 ? { reason: denyReason.trim() } : {},
      ),
    onSettled: () => {
      setShowDenyForm(false);
      setDenyReason("");
      onMutated();
    },
  });

  // Display the absolute expiry timestamp; the parent polls every 5 s
  // so the user sees a fresh row well before the deadline. Render
  // purity rules forbid calling Date.now() during render, so we
  // intentionally avoid a "expires in Xs" countdown here.
  const expiresAtLabel = useMemo(
    () => new Date(row.expiresAt).toLocaleTimeString(),
    [row.expiresAt],
  );

  return (
    <div className="rounded border border-amber-200 bg-amber-50/50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="gray" className="border-amber-400 text-amber-800">
              <Clock3 className="mr-1 h-3 w-3" /> Pending
            </Badge>
            <code className="text-sm font-medium">{row.workflowName}</code>
            <span className="text-xs text-muted-foreground">
              requested by {row.origin}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            id: <code>{row.id.slice(0, 8)}…</code> · params hash:{" "}
            <code>{row.paramsHash.slice(0, 8)}</code> · expires at{" "}
            {expiresAtLabel}
          </p>
          <pre className="mt-2 max-h-32 overflow-auto rounded bg-white/60 p-2 text-xs">
            {row.paramsSummary || "(empty params)"}
          </pre>
        </div>
      </div>

      {issuedToken ? (
        <div className="mt-3 rounded border border-emerald-300 bg-emerald-50 p-3 text-sm">
          <div className="flex items-center gap-2 font-medium text-emerald-900">
            <CheckCircle2 className="h-4 w-4" /> Approved. Copy this token —
            it is shown only once.
          </div>
          <div className="mt-2 flex items-center gap-2">
            <code className="select-all rounded bg-white px-2 py-1 font-mono text-base">
              {issuedToken}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard?.writeText(issuedToken);
              }}
            >
              Copy
            </Button>
          </div>
          <p className="mt-2 text-xs text-emerald-900/80">
            Paste it back into the agent prompt so the workflow can proceed.
            The token is single-use, expires at the row&apos;s deadline,
            and is bound to this exact (workflow, params).
          </p>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => approveMutation.mutate()}
            disabled={approveMutation.isPending}
          >
            {approveMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            )}
            Approve & mint token
          </Button>
          {showDenyForm ? (
            <div className="flex flex-1 items-center gap-2">
              <input
                className="flex-1 rounded border px-2 py-1 text-sm"
                placeholder="Optional reason"
                value={denyReason}
                onChange={(e) => setDenyReason(e.target.value)}
                maxLength={200}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => denyMutation.mutate()}
                disabled={denyMutation.isPending}
              >
                {denyMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <XCircle className="h-4 w-4" />
                )}
                Deny
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowDenyForm(false)}
                disabled={denyMutation.isPending}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowDenyForm(true)}
            >
              <XCircle className="h-4 w-4" /> Deny…
            </Button>
          )}
        </div>
      )}
      {approveMutation.isError && (
        <p className="mt-2 text-xs text-red-700">
          Approval failed:{" "}
          {(approveMutation.error as Error | undefined)?.message ?? "unknown"}
        </p>
      )}
    </div>
  );
}

function RecentApprovalCard({ row }: { row: BrowserAutomationApprovalRow }) {
  const stateBadge = (() => {
    if (row.status === "consumed") {
      return (
        <Badge variant="default" className="bg-emerald-100 text-emerald-900">
          <CheckCircle2 className="mr-1 h-3 w-3" /> Consumed
        </Badge>
      );
    }
    if (row.status === "approved") {
      return (
        <Badge variant="gray" className="border-amber-400 text-amber-800">
          <Clock3 className="mr-1 h-3 w-3" /> Approved (unredeemed)
        </Badge>
      );
    }
    if (row.status === "denied") {
      return (
        <Badge variant="gray" className="border-red-400 text-red-700">
          <XCircle className="mr-1 h-3 w-3" /> Denied
        </Badge>
      );
    }
    return (
      <Badge variant="gray">
        <AlertTriangle className="mr-1 h-3 w-3" /> Expired
      </Badge>
    );
  })();
  const timestamp =
    row.consumedAt ??
    row.deniedAt ??
    row.approvedAt ??
    row.requestedAt;
  return (
    <div className="rounded border bg-muted/30 p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {stateBadge}
        <code className="font-medium">{row.workflowName}</code>
        <span className="text-xs text-muted-foreground">
          {new Date(timestamp).toLocaleString()}
        </span>
        <span className="text-xs text-muted-foreground">
          via {row.origin}
        </span>
      </div>
      {row.denialReason && (
        <p className="mt-1 text-xs text-muted-foreground">
          Reason: {row.denialReason}
        </p>
      )}
    </div>
  );
}

function ObservationGateSection({
  data,
  isLoading,
}: {
  data: BrowserAutomationObservationGateResponse | undefined;
  isLoading: boolean;
}) {
  const overallBadge = (() => {
    if (!data) return null;
    if (data.overall === "green") {
      return (
        <Badge variant="default" className="bg-emerald-100 text-emerald-900">
          <ShieldCheck className="mr-1 h-3.5 w-3.5" /> On track
        </Badge>
      );
    }
    if (data.overall === "amber") {
      return (
        <Badge variant="gray" className="border-amber-500 text-amber-700">
          <ShieldAlert className="mr-1 h-3.5 w-3.5" /> Trending
        </Badge>
      );
    }
    return (
      <Badge variant="gray" className="border-red-500 text-red-700">
        <XCircle className="mr-1 h-3.5 w-3.5" /> Gate failing
      </Badge>
    );
  })();

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="text-base font-semibold">
            B-3 readiness gate (§10)
          </div>
          {overallBadge}
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          Six-week observation window. B-3 advances to general
          availability only when every criterion below passes.
        </p>
        <div className="mt-4 space-y-2">
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          )}
          {!isLoading && data && (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="py-1 pr-2 font-normal">Criterion</th>
                  <th className="py-1 pr-2 font-normal">Value</th>
                  <th className="py-1 pr-2 font-normal">Threshold</th>
                  <th className="py-1 pr-2 font-normal">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.criteria.map((c) => (
                  <tr key={c.id} className="border-b last:border-b-0">
                    <td className="py-1.5 pr-2 align-top">
                      <div className="font-medium">{c.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {c.description}
                      </div>
                    </td>
                    <td className="whitespace-nowrap py-1.5 pr-2 align-top">
                      {c.value}
                    </td>
                    <td className="whitespace-nowrap py-1.5 pr-2 align-top">
                      {c.threshold === 0 ? "0" : `≤ ${c.threshold}`}
                    </td>
                    <td className="py-1.5 pr-2 align-top">
                      <CriterionStatusBadge status={c.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </CardHeader>
    </Card>
  );
}

function CriterionStatusBadge({
  status,
}: {
  status: "green" | "amber" | "red";
}) {
  if (status === "green") {
    return (
      <Badge variant="default" className="bg-emerald-100 text-emerald-900">
        Pass
      </Badge>
    );
  }
  if (status === "amber") {
    return (
      <Badge variant="gray" className="border-amber-500 text-amber-700">
        Watch
      </Badge>
    );
  }
  return (
    <Badge variant="gray" className="border-red-500 text-red-700">
      Fail
    </Badge>
  );
}
