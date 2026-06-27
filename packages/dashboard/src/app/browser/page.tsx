"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Globe2,
  History,
  MonitorCog,
  ShoppingCart,
} from "lucide-react";
import type { ManagedChromiumStateValue } from "@aitne/shared";
import { api } from "@/lib/api-client";
import type { IntegrationListResponse } from "@/lib/api-types";
import {
  useAutomationSites,
  useManagedStatus,
} from "@/lib/hooks/use-managed-chromium";
import { useBrowserTasks } from "@/lib/hooks/use-browser-tasks";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardStatLabel } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { AwaitingAttentionStrip } from "@/components/browser-tasks/awaiting-attention-strip";
import { BrowserTaskStateBadge } from "@/components/browser-tasks/state-badge";
import { formatRelativeTime } from "@/lib/utils";

/**
 * BROWSER_HUB_CONSOLIDATION_DESIGN.md — the `/browser` hub.
 *
 * Read-only composition over the four browser surfaces: one page that
 * answers "what can the browser agent do, and what has it done?" and
 * deep-links into the existing routes for anything actionable. No routes
 * moved; no new daemon API — every query reuses the owning page's query
 * key so the cache stays shared.
 */

interface B4EnabledSummary {
  enabled: boolean;
}

/**
 * Browser History on/off comes from the integration registry mode
 * (`browser_history` row of GET /api/integrations) — the same source the
 * Browser History settings page reads. `/browser-history/status` carries
 * lifecycle/capability detail but no top-level enabled flag.
 * Same query key as the settings page → shared cache entry.
 */
function useBrowserHistoryMode() {
  return useQuery({
    queryKey: ["integrations"],
    queryFn: () => api.get<IntegrationListResponse>("/integrations"),
    staleTime: 5_000,
    select: (data) =>
      data.integrations.find((item) => item.key === "browser_history")?.state
        .mode ?? null,
  });
}

/** Same query key as the B-4 settings sub-page (its ENABLED_KEY). */
function useB4Enabled(enabled: boolean) {
  return useQuery({
    queryKey: ["browser-automation-b4-enabled"],
    queryFn: () => api.get<B4EnabledSummary>("/browser-automation/b4/enabled"),
    enabled,
    staleTime: 5_000,
  });
}

const MANAGED_STATE_LABELS: Record<ManagedChromiumStateValue, string> = {
  off: "Off",
  needs_setup: "Needs setup",
  missing_binary: "Missing binary",
  missing_sandbox: "Missing sandbox",
  ready: "Ready",
  needs_reauth: "Needs re-auth",
  disconnected: "Disconnected",
};

const MANAGED_STATE_BADGE: Record<
  ManagedChromiumStateValue,
  "green" | "amber" | "red" | "gray"
> = {
  off: "gray",
  needs_setup: "amber",
  missing_binary: "amber",
  missing_sandbox: "amber",
  ready: "green",
  needs_reauth: "amber",
  disconnected: "red",
};

export default function BrowserHubPage() {
  const managed = useManagedStatus(15_000);
  // Mirror the Browser Automation settings page: per-site profiles (and the
  // B-4 surface that builds on them) only exist once the managed flow is
  // fully `ready` — not merely toggled on.
  const sitesEnabled = managed.data?.state === "ready";
  const sites = useAutomationSites(sitesEnabled);
  const historyMode = useBrowserHistoryMode();
  const b4 = useB4Enabled(sitesEnabled);
  const tasks = useBrowserTasks();

  const recentTasks = (tasks.data?.tasks ?? []).slice(0, 5);
  const siteCount = sites.data?.sites?.length ?? 0;
  const managedState = managed.data?.state;

  return (
    // Top-level pages provide their own padding (same wrapper as
    // /browser-tasks) — only /settings/* pages inherit it from
    // SettingsShell. `space-y-6` owns all vertical rhythm here, so the
    // children carry no ad-hoc mt-*/mb-* margins.
    <div className="space-y-6 p-6">
      <PageHeader
        title="Browser"
        description="Everything the agent does with a browser — reading your history, automating a dedicated Chromium, and the tasks it has run."
      />

      {/* Parked tasks needing the owner — same strip as /browser-tasks,
          self-hides when clear. */}
      <AwaitingAttentionStrip />

      {/* Capability cards — status summary + deep link per surface. */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <CapabilityCard
          icon={<History className="h-4 w-4" />}
          title="Browser History"
          href="/settings/integrations/browser-history"
          status={
            historyMode.data !== undefined && historyMode.data !== null ? (
              <Badge variant={historyMode.data === "disabled" ? "gray" : "green"}>
                {historyMode.data === "disabled" ? "Disabled" : "Enabled"}
              </Badge>
            ) : null
          }
          description="Read from your existing Chrome — research clusters and revisit nudges for the morning digest."
        />
        <CapabilityCard
          icon={<MonitorCog className="h-4 w-4" />}
          title="Browser Automation"
          href="/settings/integrations/browser-history-managed"
          status={
            managed.data && managedState ? (
              <span className="flex items-center gap-2">
                <Badge variant={MANAGED_STATE_BADGE[managedState]}>
                  {MANAGED_STATE_LABELS[managedState]}
                </Badge>
                {sitesEnabled && (
                  <span className="text-xs text-muted-foreground">
                    {siteCount} authenticated site{siteCount === 1 ? "" : "s"}
                  </span>
                )}
              </span>
            ) : null
          }
          description="A dedicated, sandboxed Chromium the agent drives — OAuth sites, task slots, and the hostname denylist."
        />
        {/* B-4 stays low-key by design (§17.9 observation gate): the card
            renders only once the managed-Chromium flow is fully ready —
            the same prerequisite its settings sub-page is gated on. */}
        {sitesEnabled && (
          <CapabilityCard
            icon={<ShoppingCart className="h-4 w-4" />}
            title="Purchase Confirmations"
            href="/settings/integrations/browser-history-managed/b4"
            status={
              b4.data ? (
                <Badge variant={b4.data.enabled ? "amber" : "gray"}>
                  {b4.data.enabled ? "Enabled (experimental)" : "Disabled"}
                </Badge>
              ) : null
            }
            description="Experimental B-4 flow — DM-delivered single-use tokens gate any purchase. Default off."
          />
        )}
      </div>

      {/* Recent tasks preview — the operational surface stays /browser-tasks.
          CardHeader is itself `flex justify-between`; title and link must be
          its direct children (an intermediate div would shrink to content
          width and glue them together). */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe2 className="h-4 w-4" />
            Recent tasks
          </CardTitle>
          <Link
            href="/browser-tasks"
            className="flex items-center gap-1 text-xs text-primary hover:underline"
          >
            View all tasks
            <ArrowRight className="h-3 w-3" />
          </Link>
        </CardHeader>
        {recentTasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No browser tasks yet. Ask the agent to do something on the web —
            &ldquo;check the price of X on Amazon&rdquo; — and the run shows up
            here.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {recentTasks.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/browser-tasks/${t.id}`}
                  className="flex items-center gap-3 py-2 text-sm hover:bg-muted/50"
                >
                  <BrowserTaskStateBadge state={t.state} />
                  <span className="min-w-0 flex-1 truncate">{t.description}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatRelativeTime(new Date(t.createdAt))}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function CapabilityCard({
  icon,
  title,
  href,
  status,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  href: string;
  status: React.ReactNode;
  description: string;
}) {
  return (
    <Card interactive>
      <Link href={href} className="block">
        <CardStatLabel className="flex items-center gap-1.5">
          {icon}
          {title}
        </CardStatLabel>
        <div className="mt-2 min-h-6">{status}</div>
        <p className="mt-2 text-xs text-muted-foreground">{description}</p>
        <span className="mt-3 flex items-center gap-1 text-xs text-primary">
          Configure
          <ArrowRight className="h-3 w-3" />
        </span>
      </Link>
    </Card>
  );
}
