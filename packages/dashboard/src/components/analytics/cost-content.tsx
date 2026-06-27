"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { getBackendIds } from "@aitne/shared";
import { useCost } from "@/lib/hooks/use-cost";
import { useMetrics } from "@/lib/hooks/use-metrics";
import { QueryResult, CardSkeleton } from "@/components/shared/query-result";
import { Card, CardHeader, CardTitle, CardStatLabel, CardValue } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { BACKEND_BADGE_VARIANTS, getBackendShortLabel } from "@/lib/backend-ui";
import { TodayDrivers } from "@/components/cost/today-drivers";

// recharts is heavy and only mounts after data resolves — code-split it
// so the synchronous render of CostContent doesn't block the route
// commit. ssr: false because charts compute layout via ResizeObserver.
const ChartFallback = () => (
  <div className="h-[300px] animate-pulse rounded-lg bg-muted/20" />
);
const CostTrendChart = dynamic(
  () => import("@/components/cost/cost-trend-chart").then((m) => m.CostTrendChart),
  { ssr: false, loading: ChartFallback },
);
const ModelBreakdownChart = dynamic(
  () => import("@/components/cost/model-breakdown-chart").then((m) => m.ModelBreakdownChart),
  { ssr: false, loading: ChartFallback },
);
const EventTypeChart = dynamic(
  () => import("@/components/cost/event-type-chart").then((m) => m.EventTypeChart),
  { ssr: false, loading: ChartFallback },
);
const BackendCostChart = dynamic(
  () => import("@/components/cost/backend-cost-chart").then((m) => m.BackendCostChart),
  { ssr: false, loading: ChartFallback },
);

const PERIODS = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
] as const;

export function CostContent({ enabled = true }: { enabled?: boolean }) {
  const [period, setPeriod] = useState("daily");
  const [view, setView] = useState("overview");
  const { data: costData, isLoading, isError, error, refetch } = useCost(period, { enabled });
  const { data: metrics } = useMetrics({ enabled });

  const summaryCards = [
    { label: "Today", value: costData?.today.costUsd ?? 0, sub: `${costData?.today.sessions ?? 0} sessions` },
    { label: "Last 7 Days", value: metrics?.cost.last7dUsd ?? 0 },
    { label: "Last 30 Days", value: metrics?.cost.last30dUsd ?? 0 },
  ];
  const backendSummary = getBackendIds().map((backendId) => {
    const row = costData?.byBackend.find((entry) => entry.backend === backendId);
    return {
      backendId,
      totalCost: row?.total_cost ?? 0,
      sessions: row?.session_count ?? 0,
    };
  });
  const totalBackendCost = backendSummary.reduce((sum, row) => sum + row.totalCost, 0);

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <QueryResult
        isLoading={isLoading && !costData}
        isError={false}
        skeleton={<CardSkeleton count={3} />}
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {summaryCards.map((c) => (
            <Card key={c.label}>
              <CardHeader>
                <CardStatLabel>{c.label}</CardStatLabel>
              </CardHeader>
              <CardValue>{formatCurrency(c.value)}</CardValue>
              {c.sub && <p className="mt-1 text-xs text-muted-foreground">{c.sub}</p>}
            </Card>
          ))}
        </div>
      </QueryResult>

      {/* Today's spend drivers — agent-day scoped, independent of the
          period selector below (which only drives the trend charts). */}
      {costData?.todayBreakdown && (
        <TodayDrivers
          breakdown={costData.todayBreakdown}
          todayCostUsd={costData.today.costUsd}
          todaySessions={costData.today.sessions}
        />
      )}

      {/* Period selector */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1">
          {PERIODS.map((p) => (
            <Button
              key={p.value}
              variant={period === p.value ? "default" : "outline"}
              size="sm"
              onClick={() => setPeriod(p.value)}
            >
              {p.label}
            </Button>
          ))}
        </div>
      </div>

      <QueryResult
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={() => refetch()}
        skeleton={<CardSkeleton count={3} />}
      >
        <Tabs value={view} onValueChange={setView}>
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="backend">By Backend</TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <div className="grid gap-6 lg:grid-cols-2">
              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle>Cost Trend</CardTitle>
                </CardHeader>
                <CostTrendChart data={costData?.byPeriod ?? []} />
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Model Breakdown</CardTitle>
                </CardHeader>
                <ModelBreakdownChart data={costData?.byModel ?? []} />
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>By Event Type</CardTitle>
                </CardHeader>
                <EventTypeChart data={costData?.byEventType ?? []} />
              </Card>
            </div>

            <DelegatedProxyAsymmetryFootnote />
          </TabsContent>

          <TabsContent value="backend">
            <div className="space-y-6">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                {backendSummary.map((row) => (
                  <Card key={row.backendId}>
                    <CardHeader>
                      <div className="flex items-center gap-2">
                        <CardStatLabel>{getBackendShortLabel(row.backendId)}</CardStatLabel>
                        <Badge variant={BACKEND_BADGE_VARIANTS[row.backendId]}>
                          {row.sessions} sessions
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardValue>{formatCurrency(row.totalCost)}</CardValue>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {totalBackendCost > 0
                        ? `${((row.totalCost / totalBackendCost) * 100).toFixed(1)}% of selected window`
                        : "No spend in selected window"}
                    </p>
                  </Card>
                ))}
              </div>

              <div className="grid gap-6 lg:grid-cols-[2fr,1fr]">
                <Card>
                  <CardHeader>
                    <CardTitle>
                      Backend Cost Trend
                    </CardTitle>
                  </CardHeader>
                  <BackendCostChart data={costData?.byBackendPeriod ?? []} />
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>
                      Backend Totals
                    </CardTitle>
                  </CardHeader>
                  <div className="space-y-3">
                    {backendSummary.map((row) => (
                      <div
                        key={row.backendId}
                        className="flex items-center justify-between rounded-lg border border-border/70 px-3 py-2"
                      >
                        <div>
                          <div className="flex items-center gap-2">
                            <Badge variant={BACKEND_BADGE_VARIANTS[row.backendId]}>
                              {getBackendShortLabel(row.backendId)}
                            </Badge>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {row.sessions} runs
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-semibold text-foreground">
                            {formatCurrency(row.totalCost)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Avg {formatCurrency(row.sessions > 0 ? row.totalCost / row.sessions : 0)}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="mt-4 text-xs text-muted-foreground">
                    Backend analytics reflect the backend that actually executed each run, not just the configured preferred backend.
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Gemini may auto-route to a different runtime model than the configured preferred model. The totals here reflect the model and backend that actually ran.
                  </p>
                </Card>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </QueryResult>
    </div>
  );
}

/**
 * DELEGATED-MODE-V2-DESIGN.md §7.2 — cross- vs same-backend asymmetry
 * footnote. Anchored below the overview charts so the user reads it
 * before drawing conclusions about "missing" delegated-proxy spend.
 * Same-backend native MCP rolls up under the parent session's totals
 * and is not separately attributable. Exported for the literal-copy
 * contract test (Decision Log #11 — verbatim US English).
 */
export function DelegatedProxyAsymmetryFootnote() {
  return (
    <p className="mt-4 text-xs text-muted-foreground">
      Only <strong>cross-backend</strong> delegated calls show up
      under per-tool delegated-proxy telemetry — calls where your DM
      session runs on a different backend than the connector&apos;s
      owner. Same-backend delegated calls (for example, a Codex DM
      session using Codex&apos;s own Gmail connector) skip the proxy
      and roll up under the parent session&apos;s totals.
      Per-tool cost isn&apos;t measurable in those cases.
    </p>
  );
}
