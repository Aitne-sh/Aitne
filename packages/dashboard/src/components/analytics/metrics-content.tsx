"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useMetrics } from "@/lib/hooks/use-metrics";
import { useMetricsTimeseries } from "@/lib/hooks/use-metrics-timeseries";
import { QueryResult, CardSkeleton } from "@/components/shared/query-result";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { HealthIndicators } from "@/components/metrics/health-indicators";
import { ActivityHeatmap } from "@/components/metrics/activity-heatmap";
import { ContextUpdateCard } from "@/components/metrics/context-update-card";
import { ErrorSummary } from "@/components/metrics/error-summary";
import { AdvisorUsageCard } from "@/components/metrics/advisor-usage-card";
import { ProactiveForwardCard } from "@/components/metrics/proactive-forward-card";

// recharts charts are split into their own chunks so the synchronous
// render of MetricsContent doesn't block the route commit.
const ChartFallback = () => (
  <div className="h-[280px] animate-pulse rounded-lg bg-muted/20" />
);
const ExecutionBreakdownChart = dynamic(
  () => import("@/components/metrics/execution-breakdown-chart").then((m) => m.ExecutionBreakdownChart),
  { ssr: false, loading: ChartFallback },
);
// TODO(owner-feedback): re-enable when notification reactions are wired up.
// The chart consumes `notificationsDelivered` and `notificationsReacted` from
// MetricsDailyBucket — the delivered side works, but `notificationsReacted`
// is computed from `notification_log.user_reaction`, and nothing in the daemon
// currently writes to that column. Hidden until each notification platform
// (Slack/Telegram/Discord/WhatsApp) reports back when the owner reacts to or
// replies to a delivered notification, and an UPDATE on notification_log sets
// `user_reaction` + `reacted_at`. See the JSX block below for the previous
// rendering site.
// const NotificationTrendChart = dynamic(
//   () => import("@/components/metrics/notification-trend-chart").then((m) => m.NotificationTrendChart),
//   { ssr: false, loading: ChartFallback },
// );

const PERIODS = [
  { value: 0, label: "Today" },
  { value: 7, label: "7d" },
  { value: 30, label: "30d" },
] as const;

export function MetricsContent({ enabled = true }: { enabled?: boolean }) {
  const [days, setDays] = useState<number>(7);
  const { data, isLoading, isError, error, refetch } = useMetricsTimeseries(days, { enabled });
  const { data: snapshot } = useMetrics({ enabled });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <div className="flex gap-1">
          {PERIODS.map((p) => (
            <Button
              key={p.value}
              variant={days === p.value ? "default" : "outline"}
              size="sm"
              onClick={() => setDays(p.value)}
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
        skeleton={<CardSkeleton count={4} />}
      >
        {data && (
          <div className="space-y-6">
            <HealthIndicators daily={data.daily} days={days} snapshot={snapshot} />

            <ActivityHeatmap data={data.heatmap} />

            <div className="grid gap-6 lg:grid-cols-[2fr,1fr]">
              <Card>
                <CardHeader>
                  <CardTitle>Execution Breakdown</CardTitle>
                </CardHeader>
                <p className="-mt-2 mb-3 text-xs text-muted-foreground">
                  Reactive failures break owner dialogue; autonomous failures break background work.
                </p>
                <ExecutionBreakdownChart data={data.daily} />
              </Card>

              <ContextUpdateCard daily={data.daily} />
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <ErrorSummary errors={data.recentErrors} days={days} />

              <ProactiveForwardCard snapshot={snapshot} />
            </div>

            {/*
              TODO(owner-feedback): hidden until reaction tracking ships.
              The card renders delivered-notification counts as bars and the
              owner reaction rate as a line. The line is permanently empty
              today — `notification_log.user_reaction` is read by metrics
              aggregation but never written. To restore the card:
                1. Capture owner reactions/replies in the messaging adapters
                   (Slack/Telegram/Discord/WhatsApp) and tie them back to
                   the originating `notification_log.dispatch_id`.
                2. UPDATE `notification_log` with `user_reaction` +
                   `reacted_at` when a reaction lands.
                3. Uncomment the dynamic import above and the JSX block below.

              <Card>
                <CardHeader>
                  <CardTitle>Owner Feedback</CardTitle>
                </CardHeader>
                <p className="-mt-2 mb-3 text-xs text-muted-foreground">
                  Delivered notifications and the share the owner reacted to — the Quality signal.
                </p>
                <NotificationTrendChart data={data.daily} />
              </Card>
            */}

            <AdvisorUsageCard snapshot={snapshot} />
          </div>
        )}
      </QueryResult>
    </div>
  );
}
