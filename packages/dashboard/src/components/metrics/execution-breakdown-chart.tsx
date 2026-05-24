"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { MetricsDailyBucket } from "@/lib/api-types";
import { RECHARTS_TOOLTIP_CURSOR_FILL } from "@/lib/recharts-theme";
import { cn } from "@/lib/utils";

interface ExecutionBreakdownChartProps {
  data: MetricsDailyBucket[];
}

interface BreakdownDatum {
  date: string;
  fullDate: string;
  autonomous: number;
  reactive: number;
  failures: number;
}

const SERIES_COLORS: Record<string, string> = {
  Autonomous: "#14b8a6",
  Reactive: "#3b82f6",
};

function ExecutionTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; payload?: BreakdownDatum }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const datum = payload[0]?.payload;
  if (!datum) return null;
  const total = datum.autonomous + datum.reactive;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs text-foreground shadow-md">
      <div className="mb-1.5 font-medium">{datum.fullDate}</div>
      {payload.map((entry) => {
        const name = entry.name ?? "";
        return (
          <div key={name} className="flex items-center gap-2">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-sm"
              style={{ backgroundColor: SERIES_COLORS[name] }}
            />
            <span className="text-muted-foreground">{name}</span>
            <span className="ml-auto tabular-nums">{entry.value}</span>
          </div>
        );
      })}
      <div className="mt-1.5 flex items-center gap-2 border-t border-border/60 pt-1.5">
        <span className="text-muted-foreground">Failures</span>
        <span
          className={cn(
            "ml-auto tabular-nums",
            datum.failures > 0 && "text-destructive",
          )}
        >
          {datum.failures}
          {total > 0 && datum.failures > 0 && (
            <span className="ml-1 text-muted-foreground">
              ({Math.round((datum.failures / total) * 100)}%)
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

export function ExecutionBreakdownChart({ data }: ExecutionBreakdownChartProps) {
  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No data available</p>;
  }

  const chartData: BreakdownDatum[] = data.map((d) => ({
    date: d.date.slice(5),
    fullDate: d.date,
    autonomous: d.executionsAutonomous,
    reactive: d.executionsReactive,
    failures: d.failures,
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11 }}
          className="fill-muted-foreground"
        />
        <YAxis
          tick={{ fontSize: 11 }}
          className="fill-muted-foreground"
          allowDecimals={false}
        />
        <Tooltip cursor={RECHARTS_TOOLTIP_CURSOR_FILL} content={<ExecutionTooltip />} />
        <Bar
          dataKey="autonomous"
          stackId="exec"
          fill={SERIES_COLORS.Autonomous}
          name="Autonomous"
          radius={[0, 0, 0, 0]}
        />
        <Bar
          dataKey="reactive"
          stackId="exec"
          fill={SERIES_COLORS.Reactive}
          name="Reactive"
          radius={[2, 2, 0, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
