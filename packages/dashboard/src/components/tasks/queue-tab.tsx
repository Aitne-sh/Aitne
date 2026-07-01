"use client";

import { useState } from "react";
import { Clock, History as HistoryIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/shared/empty-state";
import { QueryResult, TableSkeleton } from "@/components/shared/query-result";
import { StatusBadge } from "@/components/shared/status-badge";
import { ScheduleDetailSheet } from "@/components/schedule/schedule-detail-sheet";
import { useScheduleList } from "@/lib/hooks/use-schedule-list";
import { useScheduleQueue } from "@/lib/hooks/use-schedule-queue";
import {
  humanizeTaskType,
  matchesQueueFilter,
  queueItemToScheduleRow,
  QUEUE_FILTERS,
  type QueueFilterValue,
} from "@/lib/schedule/queue";
import { formatTaskTime } from "@/lib/tasks/view";
import { formatShortModelName, modelBadgeVariant } from "@/lib/backend-ui";
import type { ScheduleRow } from "@/lib/api-types";

export type QueueSegment = "upcoming" | "history";

export const HISTORY_STATUS_FILTERS = ["all", "completed", "skipped", "failed"] as const;

/**
 * Queue tab of the Tasks page (DASHBOARD_AUTOMATION_IA_REDESIGN.md §3) —
 * the materialized runs, split into what the old /schedule page conflated:
 * **Upcoming** (agent-facing `GET /schedule`: pending+running, soonest first)
 * and **History** (`GET /schedule/list`: newest first, status-filterable).
 * Segment + history-status state is lifted so the status strip's
 * "needs attention" cell can jump straight to History → Failed.
 */
export function QueueTab({
  segment,
  onSegmentChange,
  historyStatus,
  onHistoryStatusChange,
}: {
  segment: QueueSegment;
  onSegmentChange: (segment: QueueSegment) => void;
  historyStatus: string;
  onHistoryStatusChange: (status: string) => void;
}) {
  const [typeFilter, setTypeFilter] = useState<QueueFilterValue>("all");
  const [selectedRow, setSelectedRow] = useState<ScheduleRow | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3" role="toolbar" aria-label="Queue filters">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Queue segment">
          {(
            [
              { value: "upcoming", label: "Upcoming", icon: Clock },
              { value: "history", label: "History", icon: HistoryIcon },
            ] as const
          ).map((s) => (
            <Button
              key={s.value}
              variant={segment === s.value ? "default" : "outline"}
              size="sm"
              onClick={() => onSegmentChange(s.value)}
              aria-pressed={segment === s.value}
            >
              <s.icon className="mr-1 h-3.5 w-3.5" aria-hidden />
              {s.label}
            </Button>
          ))}
        </div>
        {segment === "history" && (
          <>
            <Separator orientation="vertical" className="h-6" />
            <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by result">
              {HISTORY_STATUS_FILTERS.map((s) => (
                <Button
                  key={s}
                  variant={historyStatus === s ? "default" : "outline"}
                  size="sm"
                  onClick={() => onHistoryStatusChange(s)}
                  aria-pressed={historyStatus === s}
                >
                  {s === "all" ? "All results" : s[0].toUpperCase() + s.slice(1)}
                </Button>
              ))}
            </div>
          </>
        )}
        <Separator orientation="vertical" className="h-6" />
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by type">
          {QUEUE_FILTERS.map((f) => (
            <Button
              key={f.value}
              variant={typeFilter === f.value ? "default" : "outline"}
              size="sm"
              onClick={() => setTypeFilter(f.value)}
              aria-pressed={typeFilter === f.value}
            >
              {f.label}
            </Button>
          ))}
        </div>
      </div>

      {segment === "upcoming" ? (
        <UpcomingTable typeFilter={typeFilter} onSelect={setSelectedRow} />
      ) : (
        <HistoryTable
          statusFilter={historyStatus}
          typeFilter={typeFilter}
          onSelect={setSelectedRow}
        />
      )}

      <ScheduleDetailSheet
        row={selectedRow}
        open={selectedRow !== null}
        onOpenChange={(o) => {
          if (!o) setSelectedRow(null);
        }}
      />
    </div>
  );
}

function DescriptionCell({
  description,
  prompt,
}: {
  description: string | null;
  prompt: string | null;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="line-clamp-2 flex-1">{description || prompt || "—"}</span>
      {prompt && description && prompt !== description ? (
        <Tooltip>
          <TooltipTrigger>
            <Badge variant="purple" className="shrink-0">
              prompt
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            Description above is the list label; a separate prompt is what the
            agent receives. Open the row to view or edit.
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

function QueueTableShell({
  label,
  whenHeader,
  children,
}: {
  label: string;
  whenHeader: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-left" aria-label={label}>
        <thead>
          <tr className="border-b border-border bg-muted/50">
            <th className="px-3 py-2 text-xs font-medium text-muted-foreground">{whenHeader}</th>
            <th className="px-3 py-2 text-xs font-medium text-muted-foreground">What</th>
            <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Type</th>
            <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Model</th>
            <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Status</th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function QueueRow({ row, onSelect }: { row: ScheduleRow; onSelect: (row: ScheduleRow) => void }) {
  const when = formatTaskTime(row.scheduled_for);
  return (
    <tr
      className="cursor-pointer border-b border-border last:border-b-0 hover:bg-muted/30"
      onClick={() => onSelect(row)}
    >
      <td className="whitespace-nowrap px-3 py-2 text-sm" title={when?.iso}>
        <div>{when?.absolute ?? "—"}</div>
        <div className="text-xs text-muted-foreground">{when?.relative}</div>
      </td>
      <td className="max-w-md px-3 py-2 text-sm text-foreground">
        <DescriptionCell description={row.task_description} prompt={row.task_prompt} />
      </td>
      <td className="px-3 py-2">
        <Badge variant="gray">{humanizeTaskType(row.task_type)}</Badge>
      </td>
      <td className="px-3 py-2">
        {row.model && (
          <Badge variant={modelBadgeVariant(row.model)}>{formatShortModelName(row.model)}</Badge>
        )}
      </td>
      <td className="px-3 py-2">
        <StatusBadge status={row.status} />
      </td>
    </tr>
  );
}

function UpcomingTable({
  typeFilter,
  onSelect,
}: {
  typeFilter: QueueFilterValue;
  onSelect: (row: ScheduleRow) => void;
}) {
  const { data, isLoading, isError, error, refetch } = useScheduleQueue();
  const rows = (data?.items ?? [])
    .filter((it) => matchesQueueFilter(it.taskType, typeFilter))
    .map(queueItemToScheduleRow);

  return (
    <QueryResult
      isLoading={isLoading}
      isError={isError}
      error={error}
      onRetry={() => refetch()}
      skeleton={<TableSkeleton rows={5} />}
    >
      {rows.length === 0 ? (
        <EmptyState
          icon={Clock}
          title="Nothing queued"
          description="Upcoming runs appear here when a routine, reminder, or scheduled DM is about to fire."
        />
      ) : (
        <QueueTableShell label="Upcoming runs" whenHeader="Runs at">
          {rows.map((row) => (
            <QueueRow key={row.id} row={row} onSelect={onSelect} />
          ))}
        </QueueTableShell>
      )}
    </QueryResult>
  );
}

function HistoryTable({
  statusFilter,
  typeFilter,
  onSelect,
}: {
  statusFilter: string;
  typeFilter: QueueFilterValue;
  onSelect: (row: ScheduleRow) => void;
}) {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, isError, error, refetch } =
    useScheduleList({
      status: statusFilter === "all" ? undefined : statusFilter,
    });
  // Two client-side trims: (1) "All results" hits /schedule/list unfiltered,
  // which also returns queued (pending/running) rows — those belong to
  // Upcoming, so drop them to keep History strictly "what happened";
  // (2) the type categories span several raw tokens, which the server's
  // single-token `type` param can't express.
  const rows = (data?.pages.flatMap((p) => p.schedules) ?? []).filter(
    (r) =>
      r.status !== "pending" &&
      r.status !== "running" &&
      matchesQueueFilter(r.task_type, typeFilter),
  );

  const loadMore = hasNextPage ? (
    <div className="mt-3 flex justify-center">
      <Button variant="outline" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
        {isFetchingNextPage ? "Loading…" : "Load more"}
      </Button>
    </div>
  ) : null;

  return (
    <QueryResult
      isLoading={isLoading}
      isError={isError}
      error={error}
      onRetry={() => refetch()}
      skeleton={<TableSkeleton rows={5} />}
    >
      {rows.length === 0 ? (
        <>
          <EmptyState
            icon={HistoryIcon}
            title="No past runs match"
            description="Completed, skipped, and failed runs land here. Adjust the filters to widen the view."
          />
          {loadMore}
        </>
      ) : (
        <>
          <QueueTableShell label="Run history" whenHeader="Ran at">
            {rows.map((row) => (
              <QueueRow key={row.id} row={row} onSelect={onSelect} />
            ))}
          </QueueTableShell>
          {loadMore}
        </>
      )}
    </QueryResult>
  );
}
