"use client";

import { useState } from "react";
import { getBackendIds, type BackendId } from "@aitne/shared";
import {
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuthTelemetry } from "@/lib/hooks/use-auth-telemetry";
import { getBackendShortLabel } from "@/lib/backend-ui";
import type { AuthCounterKey } from "@/lib/api-types";
import {
  legendLabel,
  RECHARTS_TOOLTIP_CONTENT_STYLE,
  RECHARTS_TOOLTIP_CURSOR_FILL,
  RECHARTS_TOOLTIP_ITEM_STYLE,
  RECHARTS_TOOLTIP_LABEL_STYLE,
} from "@/lib/recharts-theme";

const COUNTER_LABELS: Partial<Record<AuthCounterKey, string>> = {
  probe_ok: "Probe OK",
  probe_unauthorized: "Probe Failed",
  probe_network_error: "Network Error",
  self_heal_observed: "Self-Heal",
  reactive_expired: "Reactive Expired",
  keepalive_reminder_sent: "Keepalive Sent",
  preflight_skipped_main: "Pre-flight Skip",
  recovery_started: "Recovery Started",
  recovery_success: "Recovery Success",
  recovery_timeout: "Recovery Timeout",
  recovery_failed: "Recovery Failed",
};

const PROBE_COUNTERS: AuthCounterKey[] = [
  "probe_ok",
  "probe_unauthorized",
  "probe_network_error",
];

const EVENT_COUNTERS: AuthCounterKey[] = [
  "self_heal_observed",
  "reactive_expired",
  "keepalive_reminder_sent",
  "preflight_skipped_main",
];

const COUNTER_COLORS: Partial<Record<AuthCounterKey, string>> = {
  probe_ok: "#10b981",
  probe_unauthorized: "#ef4444",
  probe_network_error: "#f59e0b",
  self_heal_observed: "#3b82f6",
  reactive_expired: "#ef4444",
  keepalive_reminder_sent: "#8b5cf6",
  preflight_skipped_main: "#f97316",
  recovery_started: "#3b82f6",
  recovery_success: "#10b981",
  recovery_timeout: "#f59e0b",
  recovery_failed: "#ef4444",
};

type TimeRange = 24 | 72;

/**
 * Auth telemetry analytics panel for the dashboard.
 *
 * Shows probe results, recovery events, and health metrics per backend
 * with 24h / 72h time range toggle.
 *
 * Phase 8 §7.3.
 */
export function AuthAnalyticsPanel() {
  const [hours, setHours] = useState<TimeRange>(72);
  const { data, isLoading, error } = useAuthTelemetry(hours);

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Auth Analytics</CardTitle>
        </CardHeader>
        <p className="text-sm text-muted-foreground">
          Failed to load auth telemetry.
        </p>
      </Card>
    );
  }

  if (isLoading || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Auth Analytics</CardTitle>
        </CardHeader>
        <p className="text-sm text-muted-foreground">Loading telemetry...</p>
      </Card>
    );
  }

  const backendIds = getBackendIds();
  const hasAnyData = Object.values(data.counters).some((c) =>
    Object.values(c).some((v) => (v ?? 0) > 0),
  );

  // Build chart data for probe results (grouped bars per backend)
  const probeChartData = backendIds.map((bid) => {
    const c = data.counters[bid] ?? {};
    return {
      backend: getBackendShortLabel(bid),
      backendId: bid,
      probe_ok: c.probe_ok ?? 0,
      probe_unauthorized: c.probe_unauthorized ?? 0,
      probe_network_error: c.probe_network_error ?? 0,
    };
  });

  // Build chart data for events
  const eventChartData = backendIds.map((bid) => {
    const c = data.counters[bid] ?? {};
    return {
      backend: getBackendShortLabel(bid),
      backendId: bid,
      self_heal_observed: c.self_heal_observed ?? 0,
      reactive_expired: c.reactive_expired ?? 0,
      keepalive_reminder_sent: c.keepalive_reminder_sent ?? 0,
      preflight_skipped_main: c.preflight_skipped_main ?? 0,
    };
  });

  // Self-heal ratio with source breakdown
  const selfHealRatios = backendIds
    .map((bid) => {
      const c = data.counters[bid] ?? {};
      const heals = c.self_heal_observed ?? 0;
      const failures = c.probe_unauthorized ?? 0;
      if (failures === 0 && heals === 0) return null;
      const ratio = failures > 0 ? heals / failures : heals > 0 ? 1 : 0;
      // Source breakdown from bySource data
      const bySource = data.bySource[bid] ?? {};
      const reactiveHeals = bySource.reactive?.self_heal_observed ?? 0;
      const probeHeals = bySource.probe?.self_heal_observed ?? 0;
      return { backendId: bid, heals, failures, ratio, reactiveHeals, probeHeals };
    })
    .filter(Boolean) as Array<{
      backendId: BackendId;
      heals: number;
      failures: number;
      ratio: number;
      reactiveHeals: number;
      probeHeals: number;
    }>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Auth Analytics</h3>
          <p className="text-sm text-muted-foreground">
            Authentication probe results, recovery events, and health indicators.
          </p>
        </div>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={hours === 24 ? "default" : "outline"}
            onClick={() => setHours(24)}
          >
            24h
          </Button>
          <Button
            size="sm"
            variant={hours === 72 ? "default" : "outline"}
            onClick={() => setHours(72)}
          >
            72h
          </Button>
        </div>
      </div>

      {!hasAnyData ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No auth telemetry data in the last {hours} hours. The hourly probe
          will start generating data once it runs.
        </p>
      ) : (
        <>
          {/* Probe Results Chart */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Probe Results</CardTitle>
            </CardHeader>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart
                data={probeChartData}
                margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  className="stroke-border"
                />
                <XAxis
                  dataKey="backend"
                  tick={{ fontSize: 12 }}
                  className="fill-muted-foreground"
                />
                <YAxis
                  tick={{ fontSize: 12 }}
                  className="fill-muted-foreground"
                  allowDecimals={false}
                />
                <Tooltip
                  formatter={(value: number, name: string) => [
                    value,
                    COUNTER_LABELS[name as AuthCounterKey] ?? name,
                  ]}
                  contentStyle={RECHARTS_TOOLTIP_CONTENT_STYLE}
                  itemStyle={RECHARTS_TOOLTIP_ITEM_STYLE}
                  labelStyle={RECHARTS_TOOLTIP_LABEL_STYLE}
                  cursor={RECHARTS_TOOLTIP_CURSOR_FILL}
                />
                <Legend
                  formatter={(value) =>
                    legendLabel(COUNTER_LABELS[value as AuthCounterKey] ?? value)
                  }
                />
                {PROBE_COUNTERS.map((key) => (
                  <Bar
                    key={key}
                    dataKey={key}
                    fill={COUNTER_COLORS[key]}
                    radius={[4, 4, 0, 0]}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </Card>

          {/* Events Chart */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Auth Events</CardTitle>
            </CardHeader>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart
                data={eventChartData}
                margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  className="stroke-border"
                />
                <XAxis
                  dataKey="backend"
                  tick={{ fontSize: 12 }}
                  className="fill-muted-foreground"
                />
                <YAxis
                  tick={{ fontSize: 12 }}
                  className="fill-muted-foreground"
                  allowDecimals={false}
                />
                <Tooltip
                  formatter={(value: number, name: string) => [
                    value,
                    COUNTER_LABELS[name as AuthCounterKey] ?? name,
                  ]}
                  contentStyle={RECHARTS_TOOLTIP_CONTENT_STYLE}
                  itemStyle={RECHARTS_TOOLTIP_ITEM_STYLE}
                  labelStyle={RECHARTS_TOOLTIP_LABEL_STYLE}
                  cursor={RECHARTS_TOOLTIP_CURSOR_FILL}
                />
                <Legend
                  formatter={(value) =>
                    legendLabel(COUNTER_LABELS[value as AuthCounterKey] ?? value)
                  }
                />
                {EVENT_COUNTERS.map((key) => (
                  <Bar
                    key={key}
                    dataKey={key}
                    fill={COUNTER_COLORS[key]}
                    radius={[4, 4, 0, 0]}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </Card>

          {/* Self-Heal Ratio + Recovery Summary */}
          <div className="grid gap-4 md:grid-cols-2">
            {/* Self-Heal Ratio */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Self-Heal Ratio</CardTitle>
              </CardHeader>
              <div className="space-y-2 px-4 pb-4">
                {selfHealRatios.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No self-heal or probe failure data yet.
                  </p>
                ) : (
                  selfHealRatios.map((entry) => (
                    <div
                      key={entry.backendId}
                      className="space-y-0.5"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm">
                          {getBackendShortLabel(entry.backendId)}
                        </span>
                        <div className="flex items-center gap-2">
                          <Badge
                            variant={
                              entry.ratio >= 0.5
                                ? "green"
                                : entry.ratio > 0
                                  ? "amber"
                                  : "red"
                            }
                          >
                            {(entry.ratio * 100).toFixed(0)}%
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {entry.heals} heals / {entry.failures} failures
                          </span>
                        </div>
                      </div>
                      {entry.heals > 0 && (entry.reactiveHeals > 0 || entry.probeHeals > 0) && (
                        <p className="text-xs text-muted-foreground pl-1">
                          reactive {entry.reactiveHeals} / probe {entry.probeHeals}
                        </p>
                      )}
                    </div>
                  ))
                )}
                <p className="text-xs text-muted-foreground">
                  Ratio of self-heal observations to probe failures. Higher is
                  better — it means credentials recovered on their own before
                  manual intervention.
                </p>
              </div>
            </Card>

            {/* Recovery Summary */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Recovery Sessions</CardTitle>
              </CardHeader>
              <div className="space-y-2 px-4 pb-4">
                {backendIds.map((bid) => {
                  const c = data.counters[bid] ?? {};
                  const started = c.recovery_started ?? 0;
                  const success = c.recovery_success ?? 0;
                  const timeout = c.recovery_timeout ?? 0;
                  const failed = c.recovery_failed ?? 0;
                  if (started === 0 && success === 0 && timeout === 0 && failed === 0) {
                    return null;
                  }
                  return (
                    <div key={bid} className="space-y-0.5">
                      <p className="text-sm font-medium">
                        {getBackendShortLabel(bid)}
                      </p>
                      <div className="flex flex-wrap gap-2 text-xs">
                        <span>Started: {started}</span>
                        <Badge variant="green">{success} OK</Badge>
                        {timeout > 0 && <Badge variant="amber">{timeout} timeout</Badge>}
                        {failed > 0 && <Badge variant="red">{failed} failed</Badge>}
                      </div>
                    </div>
                  );
                })}
                {backendIds.every((bid) => {
                  const c = data.counters[bid] ?? {};
                  return (
                    (c.recovery_started ?? 0) === 0 &&
                    (c.recovery_success ?? 0) === 0 &&
                    (c.recovery_timeout ?? 0) === 0 &&
                    (c.recovery_failed ?? 0) === 0
                  );
                }) && (
                  <p className="text-xs text-muted-foreground">
                    No recovery sessions in the last {hours} hours.
                  </p>
                )}
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
