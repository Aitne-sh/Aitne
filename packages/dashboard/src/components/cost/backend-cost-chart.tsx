"use client";

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
import { BACKEND_COLORS, getBackendShortLabel } from "@/lib/backend-ui";
import { formatCurrency, niceAxisMax } from "@/lib/utils";
import {
  legendLabel,
  RECHARTS_TOOLTIP_CONTENT_STYLE,
  RECHARTS_TOOLTIP_CURSOR_FILL,
  RECHARTS_TOOLTIP_ITEM_STYLE,
  RECHARTS_TOOLTIP_LABEL_STYLE,
} from "@/lib/recharts-theme";

interface BackendCostChartProps {
  data: { period: string; backend: BackendId; total_cost: number; session_count: number }[];
}

export function BackendCostChart({ data }: BackendCostChartProps) {
  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No backend cost data available</p>;
  }

  const periods = Array.from(new Set(data.map((row) => row.period))).reverse();
  const chartData = periods.map((period) => {
    const row = { period } as { period: string } & Record<BackendId, number>;
    for (const backend of getBackendIds()) {
      row[backend] = 0;
    }
    for (const entry of data) {
      if (entry.period !== period) continue;
      row[entry.backend] = entry.total_cost;
    }
    return row;
  });

  // Bars are stacked, so the YAxis needs to fit the per-period sum, not the
  // single largest backend value.
  const yMax = niceAxisMax(
    chartData.map((row) =>
      getBackendIds().reduce((sum, backend) => sum + (row[backend] ?? 0), 0),
    ),
  );

  return (
    <ResponsiveContainer width="100%" height={320}>
      <BarChart data={chartData} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis dataKey="period" tick={{ fontSize: 12 }} className="fill-muted-foreground" />
        <YAxis
          tick={{ fontSize: 12 }}
          className="fill-muted-foreground"
          domain={[0, yMax]}
          allowDataOverflow={false}
          tickFormatter={(value: number) => formatCurrency(value)}
        />
        <Tooltip
          formatter={(value: number, name: string) => [
            formatCurrency(value),
            getBackendShortLabel(name as BackendId),
          ]}
          contentStyle={RECHARTS_TOOLTIP_CONTENT_STYLE}
          itemStyle={RECHARTS_TOOLTIP_ITEM_STYLE}
          labelStyle={RECHARTS_TOOLTIP_LABEL_STYLE}
          cursor={RECHARTS_TOOLTIP_CURSOR_FILL}
        />
        <Legend
          formatter={(value) => legendLabel(getBackendShortLabel(value as BackendId))}
        />
        {getBackendIds().map((backendId) => (
          <Bar
            key={backendId}
            dataKey={backendId}
            stackId="backend-cost"
            fill={BACKEND_COLORS[backendId]}
            radius={[4, 4, 0, 0]}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
