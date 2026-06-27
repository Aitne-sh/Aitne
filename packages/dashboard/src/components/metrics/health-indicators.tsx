"use client";

import { Card, CardHeader, CardStatLabel, CardValue } from "@/components/ui/card";
import { Sparkline } from "@/components/metrics/sparkline";
import {
  computeHealthKpis,
  type KpiLevel,
} from "@/lib/health-kpis";
import type { MetricsDailyBucket, MetricsResponse } from "@/lib/api-types";

interface HealthIndicatorsProps {
  daily: MetricsDailyBucket[];
  days: number;
  snapshot: MetricsResponse | undefined;
}

const LEVEL_LABELS: Record<Exclude<KpiLevel, "neutral">, string> = {
  good: "Good",
  warn: "Warning",
  crit: "Critical",
};

const SPARKLINE_COLORS: Record<KpiLevel, string> = {
  good: "#10b981",
  warn: "#f59e0b",
  crit: "#ef4444",
  neutral: "#94a3b8",
};

function StatusDot({ level }: { level: KpiLevel }) {
  if (level === "neutral") return null;
  return (
    <span className="flex items-center gap-1.5 text-xs">
      <span
        className={`inline-block h-2 w-2 rounded-full ${
          level === "good"
            ? "bg-success"
            : level === "warn"
              ? "bg-warning"
              : "bg-destructive"
        }`}
      />
      <span
        className={
          level === "good"
            ? "text-success"
            : level === "warn"
              ? "text-warning"
              : "text-destructive"
        }
      >
        {LEVEL_LABELS[level]}
      </span>
    </span>
  );
}

export function HealthIndicators({ daily, days, snapshot }: HealthIndicatorsProps) {
  const cards = computeHealthKpis(daily, days, snapshot);

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {cards.map((c) => (
        <Card key={c.title}>
          <CardHeader>
            <CardStatLabel>{c.title}</CardStatLabel>
          </CardHeader>
          <CardValue className="text-2xl">{c.value}</CardValue>
          <p className="mt-1 text-[11px] text-muted-foreground">{c.subtitle}</p>
          <div className="mt-2 flex items-end justify-between">
            {c.sparkline !== null ? (
              <Sparkline
                values={c.sparkline}
                color={SPARKLINE_COLORS[c.level]}
                ariaLabel={`${c.title} trend`}
              />
            ) : (
              <div className="flex-1" />
            )}
            <StatusDot level={c.level} />
          </div>
        </Card>
      ))}
    </div>
  );
}
