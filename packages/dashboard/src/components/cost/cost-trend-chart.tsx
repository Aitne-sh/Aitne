"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  RECHARTS_TOOLTIP_CONTENT_STYLE,
  RECHARTS_TOOLTIP_CURSOR_STROKE,
  RECHARTS_TOOLTIP_ITEM_STYLE,
  RECHARTS_TOOLTIP_LABEL_STYLE,
} from "@/lib/recharts-theme";
import { niceAxisMax } from "@/lib/utils";

interface CostTrendChartProps {
  data: { period: string; total_cost: number; session_count: number }[];
}

export function CostTrendChart({ data }: CostTrendChartProps) {
  const chartData = [...data].reverse();

  if (chartData.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No data available</p>;
  }

  const yMax = niceAxisMax(chartData.map((d) => d.total_cost));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="costGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis
          dataKey="period"
          tick={{ fontSize: 12 }}
          className="fill-muted-foreground"
        />
        <YAxis
          tick={{ fontSize: 12 }}
          className="fill-muted-foreground"
          domain={[0, yMax]}
          allowDataOverflow={false}
          tickFormatter={(v: number) => `$${v.toFixed(2)}`}
        />
        <Tooltip
          formatter={(value: number) => [`$${value.toFixed(4)}`, "Cost"]}
          contentStyle={RECHARTS_TOOLTIP_CONTENT_STYLE}
          itemStyle={RECHARTS_TOOLTIP_ITEM_STYLE}
          labelStyle={RECHARTS_TOOLTIP_LABEL_STYLE}
          cursor={RECHARTS_TOOLTIP_CURSOR_STROKE}
        />
        <Area
          type="monotone"
          dataKey="total_cost"
          stroke="#3b82f6"
          fillOpacity={1}
          fill="url(#costGrad)"
          strokeWidth={2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
