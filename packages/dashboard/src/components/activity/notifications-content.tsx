"use client";

import { useState } from "react";
import { useNotifications } from "@/lib/hooks/use-notifications";
import { useMetrics } from "@/lib/hooks/use-metrics";
import { EmptyState } from "@/components/shared/empty-state";
import { DocsLearnMore } from "@/components/docs/docs-learn-more";
import { QueryResult, CardSkeleton } from "@/components/shared/query-result";
import { StatusBadge } from "@/components/shared/status-badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardStatLabel, CardValue } from "@/components/ui/card";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { formatRelativeTime, formatAbsoluteTime } from "@/lib/utils";
import { Bell } from "lucide-react";

const PRIORITY_COLORS: Record<string, "red" | "amber" | "blue" | "gray"> = {
  critical: "red",
  high: "amber",
  normal: "blue",
  low: "gray",
};

export function NotificationsContent({ enabled = true }: { enabled?: boolean }) {
  const [status, setStatus] = useState("all");
  const [priority, setPriority] = useState("all");

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, isError, error, refetch } = useNotifications(
    {
      status: status === "all" ? undefined : status,
      priority: priority === "all" ? undefined : priority,
    },
    { enabled },
  );
  const { data: metrics, isLoading: metricsLoading } = useMetrics({ enabled });

  const notifications = data?.pages.flatMap((p) => p.notifications) ?? [];

  return (
    <div className="space-y-6">
      {/* Summary stats */}
      <QueryResult isLoading={metricsLoading} isError={false} skeleton={<CardSkeleton count={4} />}>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Card>
            <CardHeader><CardStatLabel>Delivered</CardStatLabel></CardHeader>
            <CardValue className="text-2xl">{metrics?.notificationCounts.delivered ?? 0}</CardValue>
          </Card>
          <Card>
            <CardHeader><CardStatLabel>Reacted</CardStatLabel></CardHeader>
            <CardValue className="text-2xl">{metrics?.notificationCounts.reacted ?? 0}</CardValue>
          </Card>
          <Card>
            <CardHeader><CardStatLabel>Suppressed</CardStatLabel></CardHeader>
            <CardValue className="text-2xl">{metrics?.notificationCounts.suppressed ?? 0}</CardValue>
          </Card>
          <Card>
            <CardHeader><CardStatLabel>Confirm Rate</CardStatLabel></CardHeader>
            <CardValue className="text-2xl">
              {metrics?.notificationConfirmRate !== null && metrics?.notificationConfirmRate !== undefined
                ? `${(metrics.notificationConfirmRate * 100).toFixed(0)}%`
                : "\u2014"}
            </CardValue>
          </Card>
        </div>
      </QueryResult>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3" role="toolbar" aria-label="Notification filters">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            {["all", "delivered", "batched", "suppressed", "failed"].map((s) => (
              <SelectItem key={s} value={s}>{s === "all" ? "All Status" : s}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={priority} onValueChange={setPriority}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Priority" />
          </SelectTrigger>
          <SelectContent>
            {["all", "critical", "high", "normal", "low"].map((p) => (
              <SelectItem key={p} value={p}>{p === "all" ? "All Priority" : p}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <QueryResult
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={() => refetch()}
      >
        {/* Table */}
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-left" aria-label="Notifications">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Time</th>
                <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Priority</th>
                <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Message</th>
                <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Platform</th>
                <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Status</th>
              </tr>
            </thead>
            <tbody>
              {notifications.map((n) => (
                <tr key={n.id} className="border-b border-border">
                  <td className="px-3 py-2 text-xs font-mono tabular-nums text-muted-foreground whitespace-nowrap">
                    <Tooltip>
                      <TooltipTrigger>{formatAbsoluteTime(n.created_at)}</TooltipTrigger>
                      <TooltipContent>{formatRelativeTime(n.created_at)}</TooltipContent>
                    </Tooltip>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={PRIORITY_COLORS[n.priority] ?? "gray"}>{n.priority}</Badge>
                  </td>
                  <td className="max-w-md truncate px-3 py-2 text-sm text-foreground">{n.message}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{n.platform}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={n.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {notifications.length === 0 ? (
          <EmptyState
            icon={Bell}
            title="No notifications yet"
            description="Notifications will appear here as the agent sends them"
          >
            <div className="mt-4">
              <DocsLearnMore docId="features/operations/notifications" />
            </div>
          </EmptyState>
        ) : null}

        {hasNextPage && (
          <div className="flex justify-center">
            <Button variant="outline" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
              {isFetchingNextPage ? "Loading..." : "Load More"}
            </Button>
          </div>
        )}
      </QueryResult>
    </div>
  );
}
