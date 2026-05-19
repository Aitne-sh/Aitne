"use client";

import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { CHART_CATEGORY_PALETTE } from "@/lib/backend-ui";
import {
  RECHARTS_TOOLTIP_CONTENT_STYLE,
  RECHARTS_TOOLTIP_CURSOR_FILL,
  RECHARTS_TOOLTIP_ITEM_STYLE,
  RECHARTS_TOOLTIP_LABEL_STYLE,
} from "@/lib/recharts-theme";

interface EventTypeChartProps {
  data: { event_type: string; total_cost: number; session_count: number }[];
}

export function EventTypeChart({ data }: EventTypeChartProps) {
  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No data available</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={250}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis
          type="number"
          tick={{ fontSize: 12 }}
          className="fill-muted-foreground"
          tickFormatter={(v: number) => `$${v.toFixed(2)}`}
        />
        <YAxis
          dataKey="event_type"
          type="category"
          tick={{ fontSize: 11 }}
          className="fill-muted-foreground"
          width={140}
        />
        <Tooltip
          formatter={(value: number) => [`$${value.toFixed(4)}`, "Cost"]}
          contentStyle={RECHARTS_TOOLTIP_CONTENT_STYLE}
          itemStyle={RECHARTS_TOOLTIP_ITEM_STYLE}
          labelStyle={RECHARTS_TOOLTIP_LABEL_STYLE}
          cursor={RECHARTS_TOOLTIP_CURSOR_FILL}
        />
        <Bar dataKey="total_cost" radius={[0, 4, 4, 0]}>
          {data.map((row, i) => (
            <Cell
              key={row.event_type}
              fill={CHART_CATEGORY_PALETTE[i % CHART_CATEGORY_PALETTE.length]!}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
