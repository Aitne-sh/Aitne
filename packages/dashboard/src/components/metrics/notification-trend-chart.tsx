"use client";

/**
 * NOTE: currently unmounted from MetricsContent — see
 * `analytics/metrics-content.tsx` "TODO(owner-feedback)" block. The
 * "Owner Feedback" card is hidden because the `confirmRate` line
 * depends on `notification_log.user_reaction`, which the daemon
 * never writes today. Kept here, ready to remount once each
 * messaging adapter reports owner reactions back to `dispatch_id`
 * and an UPDATE on `notification_log` lands `user_reaction` +
 * `reacted_at`. Do not delete without removing the matching TODO
 * in metrics-content.tsx.
 */

import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { MetricsDailyBucket } from "@/lib/api-types";
import {
  RECHARTS_TOOLTIP_CONTENT_STYLE,
  RECHARTS_TOOLTIP_CURSOR_FILL,
  RECHARTS_TOOLTIP_ITEM_STYLE,
  RECHARTS_TOOLTIP_LABEL_STYLE,
} from "@/lib/recharts-theme";

interface NotificationTrendChartProps {
  data: MetricsDailyBucket[];
}

export function NotificationTrendChart({ data }: NotificationTrendChartProps) {
  const hasNotifications = data.some((d) => d.notificationsDelivered > 0);

  if (!hasNotifications) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No notification data</p>;
  }

  const chartData = data.map((d) => ({
    date: d.date.slice(5),
    fullDate: d.date,
    delivered: d.notificationsDelivered,
    confirmRate:
      d.notificationsDelivered > 0
        ? Math.round((d.notificationsReacted / d.notificationsDelivered) * 100)
        : null,
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11 }}
          className="fill-muted-foreground"
        />
        <YAxis
          yAxisId="count"
          tick={{ fontSize: 11 }}
          className="fill-muted-foreground"
          allowDecimals={false}
        />
        <YAxis
          yAxisId="rate"
          orientation="right"
          tick={{ fontSize: 11 }}
          className="fill-muted-foreground"
          domain={[0, 100]}
          tickFormatter={(v: number) => `${v}%`}
        />
        <Tooltip
          contentStyle={{ ...RECHARTS_TOOLTIP_CONTENT_STYLE, fontSize: "12px" }}
          itemStyle={RECHARTS_TOOLTIP_ITEM_STYLE}
          labelStyle={RECHARTS_TOOLTIP_LABEL_STYLE}
          cursor={RECHARTS_TOOLTIP_CURSOR_FILL}
          formatter={(value: number, name: string) => {
            if (name === "confirmRate") return [`${value}%`, "Confirm Rate"];
            return [value, "Delivered"];
          }}
          labelFormatter={(label: string, payload: Array<{ payload?: { fullDate?: string } }>) => {
            return payload?.[0]?.payload?.fullDate ?? label;
          }}
        />
        <Bar
          yAxisId="count"
          dataKey="delivered"
          fill="#a78bfa"
          opacity={0.6}
          name="delivered"
          radius={[2, 2, 0, 0]}
        />
        <Line
          yAxisId="rate"
          type="monotone"
          dataKey="confirmRate"
          stroke="#10b981"
          strokeWidth={2}
          dot={false}
          connectNulls={false}
          name="confirmRate"
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
