"use client";

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { assignModelColors, formatModelName } from "@/lib/backend-ui";
import { formatCurrency } from "@/lib/utils";
import {
  legendLabel,
  RECHARTS_TOOLTIP_CONTENT_STYLE,
  RECHARTS_TOOLTIP_ITEM_STYLE,
  RECHARTS_TOOLTIP_LABEL_STYLE,
} from "@/lib/recharts-theme";

interface ModelBreakdownChartProps {
  data: { model: string; total_cost: number; session_count: number }[];
}

export function ModelBreakdownChart({ data }: ModelBreakdownChartProps) {
  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No data available</p>;
  }

  const colorByModel = assignModelColors(data.map((d) => d.model));
  const chartData = data.map((d) => ({
    name: formatModelName(d.model),
    value: d.total_cost,
    sessions: d.session_count,
    color: colorByModel[d.model] ?? "#6b7280",
    model: d.model,
  }));

  return (
    <ResponsiveContainer width="100%" height={250}>
      <PieChart>
        <Pie
          data={chartData}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          innerRadius={50}
          outerRadius={80}
          paddingAngle={2}
        >
          {chartData.map((entry) => (
            <Cell key={entry.model} fill={entry.color} />
          ))}
        </Pie>
        <Tooltip
          formatter={(value: number, _name, item) => [
            formatCurrency(value),
            typeof item?.payload?.name === "string" ? item.payload.name : "Model",
          ]}
          contentStyle={RECHARTS_TOOLTIP_CONTENT_STYLE}
          itemStyle={RECHARTS_TOOLTIP_ITEM_STYLE}
          labelStyle={RECHARTS_TOOLTIP_LABEL_STYLE}
        />
        <Legend formatter={legendLabel} />
      </PieChart>
    </ResponsiveContainer>
  );
}
