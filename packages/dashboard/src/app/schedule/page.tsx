"use client";

import { useEffect, useState } from "react";
import { useScheduleList } from "@/lib/hooks/use-schedule-list";
import { useScheduleNext } from "@/lib/hooks/use-schedule-next";
import { useRegenerate } from "@/lib/hooks/use-regenerate";
import { RegenerateButton } from "@/components/regenerate-button";
import { EmptyState } from "@/components/shared/empty-state";
import { QueryResult, TableSkeleton } from "@/components/shared/query-result";
import { StatusBadge } from "@/components/shared/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/page-header";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { formatRelativeTime, formatAbsoluteTime, parseUtcDate } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { formatShortModelName, modelBadgeVariant } from "@/lib/backend-ui";
import { Clock, AlarmClock, Plus } from "lucide-react";
import { CreateScheduleSheet } from "@/components/schedule/create-schedule-sheet";
import { ScheduleDetailSheet } from "@/components/schedule/schedule-detail-sheet";
import { ScheduledDmsTable } from "@/components/schedule/scheduled-dms-table";
import type { ScheduleRow } from "@/lib/api-types";

const TYPE_COLORS: Record<string, "blue" | "green" | "purple"> = {
  wake: "blue",
  dm: "blue",
  morning_routine: "green",
  evening_review: "green",
  custom: "purple",
};

const STATUSES = ["all", "pending", "running", "completed", "skipped", "failed"];
const TYPES = ["all", "wake", "dm", "morning_routine", "evening_review", "custom"];

export default function SchedulePage() {
  const [tab, setTab] = useState<"upcoming" | "dms">("upcoming");
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [selectedRow, setSelectedRow] = useState<ScheduleRow | null>(null);
  const { data: nextData } = useScheduleNext();
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, isError, error, refetch } = useScheduleList({
    status: statusFilter === "all" ? undefined : statusFilter,
    type: typeFilter === "all" ? undefined : typeFilter,
  });

  const schedules = data?.pages.flatMap((p) => p.schedules) ?? [];
  const [countdown, setCountdown] = useState("");

  useEffect(() => {
    if (!nextData?.next) return;
    const update = () => {
      const diff = parseUtcDate(nextData.next!.scheduled_for).getTime() - Date.now();
      if (diff <= 0) { setCountdown("Now"); return; }
      const h = Math.floor(diff / 3_600_000);
      const m = Math.floor((diff % 3_600_000) / 60_000);
      const s = Math.floor((diff % 60_000) / 1_000);
      setCountdown(h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`);
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [nextData?.next]);

  const { regenerate, target: regenTarget, status: regenStatus, error: regenError, dismiss } = useRegenerate();

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Schedule"
        description={
          <>
            The scheduling queue plus recurring DM rules. <strong>Upcoming</strong>
            is every materialized invocation about to run or recently run — wakes
            (<code>wake</code>), DMs (<code>dm</code>), one-off
            <code> custom</code> tasks, and routine / recurring-DM instances.
            <strong> Scheduled DMs</strong> lists the recurring DM rules (e.g. the
            morning briefing) you can retime or turn off. Recurring <em>work</em>
            runs as an Agent on the Agents page.
          </>
        }
        actions={
          <>
            <CreateScheduleSheet
              trigger={
                <Button>
                  <Plus className="mr-1 h-4 w-4" />
                  Schedule
                </Button>
              }
            />
            <RegenerateButton
              target="today"
              label="Refresh Today"
              currentTarget={regenTarget}
              status={regenStatus}
              error={regenError}
              onRegenerate={regenerate}
              onDismiss={dismiss}
            />
          </>
        }
      />

      {/* Next task highlight */}
      {nextData?.next && (
        <Card className="border-primary/30 bg-primary/10 dark:bg-primary/15">
          <CardHeader>
            <CardTitle>Next Up</CardTitle>
            <AlarmClock className="h-4 w-4 text-primary" />
          </CardHeader>
          <div className="flex items-center gap-4">
            <span className="font-mono text-2xl font-bold text-foreground">{countdown}</span>
            <div>
              <p className="text-sm text-foreground">{nextData.next.task_description}</p>
              <p className="text-xs text-muted-foreground">{formatAbsoluteTime(nextData.next.scheduled_for)}</p>
            </div>
          </div>
        </Card>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as "upcoming" | "dms")}>
        <TabsList>
          <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
          <TabsTrigger value="dms">Scheduled DMs</TabsTrigger>
        </TabsList>

        <TabsContent value="upcoming" className="mt-4 space-y-4">
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3" role="toolbar" aria-label="Schedule filters">
            <div className="flex flex-wrap gap-1">
              {STATUSES.map((s) => (
                <Button
                  key={s}
                  variant={statusFilter === s ? "default" : "outline"}
                  size="sm"
                  onClick={() => setStatusFilter(s)}
                  aria-pressed={statusFilter === s}
                >
                  {s === "all" ? "All" : s}
                </Button>
              ))}
            </div>
            <Separator orientation="vertical" className="h-6" />
            <div className="flex flex-wrap gap-1">
              {TYPES.map((t) => (
                <Button
                  key={t}
                  variant={typeFilter === t ? "default" : "outline"}
                  size="sm"
                  onClick={() => setTypeFilter(t)}
                  aria-pressed={typeFilter === t}
                >
                  {t === "all" ? "All types" : t}
                </Button>
              ))}
            </div>
          </div>

          <QueryResult
            isLoading={isLoading}
            isError={isError}
            error={error}
            onRetry={() => refetch()}
            skeleton={<TableSkeleton rows={5} />}
          >
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-left" aria-label="Scheduled tasks">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Scheduled For</th>
                    <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Type</th>
                    <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Description</th>
                    <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Model</th>
                    <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Status</th>
                    <th className="hidden px-3 py-2 text-xs font-medium text-muted-foreground lg:table-cell">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {schedules.map((s) => (
                    <tr
                      key={s.id}
                      className="cursor-pointer border-b border-border hover:bg-muted/30"
                      onClick={() => setSelectedRow(s)}
                    >
                      <td className="px-3 py-2 text-sm">
                        <Tooltip>
                          <TooltipTrigger>{formatAbsoluteTime(s.scheduled_for)}</TooltipTrigger>
                          <TooltipContent>{formatRelativeTime(s.scheduled_for)}</TooltipContent>
                        </Tooltip>
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={TYPE_COLORS[s.task_type] ?? "gray"}>{s.task_type}</Badge>
                      </td>
                      <td className="max-w-md px-3 py-2 text-sm text-foreground">
                        <div className="flex items-start gap-2">
                          <span className="line-clamp-2 flex-1">
                            {s.task_description || s.task_prompt || "—"}
                          </span>
                          {s.task_prompt &&
                          s.task_description &&
                          s.task_prompt !== s.task_description ? (
                            <Tooltip>
                              <TooltipTrigger>
                                <Badge variant="purple" className="shrink-0">prompt</Badge>
                              </TooltipTrigger>
                              <TooltipContent>
                                Description above is the list label; a separate prompt is what the agent receives. Open the row to view or edit.
                              </TooltipContent>
                            </Tooltip>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        {s.model && (
                          <Badge variant={modelBadgeVariant(s.model)}>
                            {formatShortModelName(s.model)}
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge status={s.status} />
                      </td>
                      <td className="hidden whitespace-nowrap px-3 py-2 font-mono text-xs tabular-nums text-muted-foreground lg:table-cell">
                        <Tooltip>
                          <TooltipTrigger>{formatAbsoluteTime(s.created_at)}</TooltipTrigger>
                          <TooltipContent>{formatRelativeTime(s.created_at)}</TooltipContent>
                        </Tooltip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {schedules.length === 0 ? (
              <EmptyState
                icon={Clock}
                title="No scheduled tasks"
                description="Tasks will appear here when the agent schedules wake-ups or routines"
              />
            ) : null}

            {hasNextPage && (
              <div className="flex justify-center">
                <Button variant="outline" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
                  {isFetchingNextPage ? "Loading..." : "Load More"}
                </Button>
              </div>
            )}
          </QueryResult>
        </TabsContent>

        <TabsContent value="dms" className="mt-4 space-y-4">
          <ScheduledDmsTable />
        </TabsContent>
      </Tabs>

      <ScheduleDetailSheet
        row={selectedRow}
        open={selectedRow !== null}
        onOpenChange={(o) => { if (!o) setSelectedRow(null); }}
      />
    </div>
  );
}
