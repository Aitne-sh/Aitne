"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowUpRight, ChevronRight, ListChecks, Plus } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/status-badge";
import { QueryResult, TableSkeleton } from "@/components/shared/query-result";
import { RegenerateButton } from "@/components/regenerate-button";
import { CreateScheduleSheet } from "@/components/schedule/create-schedule-sheet";
import { ScheduledDmsTable } from "@/components/schedule/scheduled-dms-table";
import { QueueTab, type QueueSegment } from "@/components/tasks/queue-tab";
import { StatusStrip } from "@/components/tasks/status-strip";
import { useTasks } from "@/lib/hooks/use-tasks";
import { useScheduleNext } from "@/lib/hooks/use-schedule-next";
import { useRecentFailedRuns } from "@/lib/hooks/use-schedule-queue";
import { useRegenerate } from "@/lib/hooks/use-regenerate";
import { countRecentFailures } from "@/lib/schedule/queue";
import {
  boardStats,
  groupTasksByKind,
  kindLabel,
  originLabel,
  humanizeCadence,
  formatTaskTime,
  manageHref,
  manageLabel,
  type FormattedTime,
} from "@/lib/tasks/view";
import type { TaskBoardItem } from "@/lib/tasks/types";

/**
 * Tasks — the automation operations hub (DASHBOARD_AUTOMATION_IA_REDESIGN.md).
 * The former /schedule page is merged in here: one page answers "what is my
 * agent set up to do, what runs next, what happened, what needs attention".
 *
 *  - Status strip: live next-up countdown + running / recurring / failed-24h.
 *  - Board tab: the read-only Unified Task Board inventory (`GET /api/tasks`,
 *    docs/design/appendices/unified-task-board.md §5.2c). Writes stay on the
 *    owning surfaces; rows open a drawer that deep-links to them.
 *  - Queue tab: materialized runs — Upcoming (soonest first) | History.
 *  - Scheduled DMs tab: the recurring DM rules (the owning surface for
 *    `dm_session` rows, moved verbatim from /schedule).
 *
 * The active tab lives in `?tab=` so board drawer links, the strip's
 * attention cell, and external deep links (`/schedule` redirects here) all
 * address the same state.
 */
export default function TasksPage() {
  // useSearchParams needs a Suspense boundary for the build-time CSR bailout —
  // same idiom as the agent detail / activity pages.
  return (
    <Suspense>
      <TasksPageInner />
    </Suspense>
  );
}

type TabValue = "board" | "queue" | "dms";

function TasksPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: TabValue = tabParam === "queue" || tabParam === "dms" ? tabParam : "board";
  const setTab = (value: string) => {
    router.replace(value === "board" ? "/tasks" : `/tasks?tab=${value}`, { scroll: false });
  };

  const { data, isLoading, isError, error, refetch } = useTasks();
  const { data: nextData } = useScheduleNext();
  const { data: failedData } = useRecentFailedRuns();

  const groups = data ? groupTasksByKind(data.items) : [];
  const stats = boardStats(data?.items ?? []);
  const failed24h = failedData ? countRecentFailures(failedData.schedules) : null;

  const [selected, setSelected] = useState<TaskBoardItem | null>(null);
  const [queueSegment, setQueueSegment] = useState<QueueSegment>("upcoming");
  const [historyStatus, setHistoryStatus] = useState("all");

  const showFailures = () => {
    setQueueSegment("history");
    setHistoryStatus("failed");
    setTab("queue");
  };

  const { regenerate, target: regenTarget, status: regenStatus, error: regenError, dismiss } =
    useRegenerate();

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Tasks"
        description="Everything your agent has in motion — the standing board, the run queue, and your scheduled DMs. Times are shown in your timezone."
        actions={
          <>
            <RegenerateButton
              target="today"
              label="Refresh Today"
              currentTarget={regenTarget}
              status={regenStatus}
              error={regenError}
              onRegenerate={regenerate}
              onDismiss={dismiss}
            />
            <CreateScheduleSheet
              trigger={
                <Button>
                  <Plus className="mr-1 h-4 w-4" />
                  Schedule
                </Button>
              }
            />
          </>
        }
      />

      <StatusStrip
        nextUp={
          nextData?.next
            ? {
                description: nextData.next.task_description,
                scheduledFor: nextData.next.scheduled_for,
              }
            : null
        }
        running={stats.running}
        activeRecurring={stats.activeRecurring}
        failed24h={failed24h}
        onShowFailures={showFailures}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="board">Board</TabsTrigger>
          <TabsTrigger value="queue">Queue</TabsTrigger>
          <TabsTrigger value="dms">Scheduled DMs</TabsTrigger>
        </TabsList>

        <TabsContent value="board" className="mt-4">
          <QueryResult
            isLoading={isLoading}
            isError={isError}
            error={error}
            onRetry={() => refetch()}
            skeleton={<TableSkeleton rows={6} />}
          >
            {data && data.total === 0 ? (
              <EmptyState
                icon={ListChecks}
                title="Nothing scheduled yet"
                description="Recurring DMs, agents, managed fetches, reminders, and background work will appear here once set up."
              />
            ) : (
              <div className="space-y-8">
                <p className="text-xs text-muted-foreground">
                  Read-only inventory — open a row for details and to jump to where it&apos;s
                  managed.
                </p>
                {groups.map((group) => (
                  <section key={group.kind} className="space-y-2">
                    <div className="flex items-baseline gap-2">
                      <h2 className="text-sm font-semibold text-foreground">{group.label}</h2>
                      <span className="text-xs text-muted-foreground">{group.items.length}</span>
                    </div>
                    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                      {group.items.map((item) => (
                        <TaskRow key={item.ref} item={item} onSelect={setSelected} />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </QueryResult>
        </TabsContent>

        <TabsContent value="queue" className="mt-4">
          <QueueTab
            segment={queueSegment}
            onSegmentChange={setQueueSegment}
            historyStatus={historyStatus}
            onHistoryStatusChange={setHistoryStatus}
          />
        </TabsContent>

        <TabsContent value="dms" className="mt-4">
          <ScheduledDmsTable />
        </TabsContent>
      </Tabs>

      <Sheet
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <SheetContent className="flex flex-col overflow-y-auto">
          {selected && <TaskDetail item={selected} onClose={() => setSelected(null)} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function TaskRow({
  item,
  onSelect,
}: {
  item: TaskBoardItem;
  onSelect: (item: TaskBoardItem) => void;
}) {
  const cadence = humanizeCadence(item.cadence);
  const next = formatTaskTime(item.nextRunAt);
  const last = formatTaskTime(item.lastRunAt);
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(item)}
        className="group flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus:outline-none focus-visible:bg-muted/40"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{item.title}</p>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            {cadence && <span>{cadence}</span>}
            {next ? (
              <span title={next.iso}>{cadence ? "· " : ""}next {next.relative}</span>
            ) : (
              last && <span title={last.iso}>{cadence ? "· " : ""}ran {last.relative}</span>
            )}
          </p>
        </div>
        <Badge variant="gray" className="shrink-0">
          {originLabel(item.origin)}
        </Badge>
        <StatusBadge status={item.status} className="shrink-0" />
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
      </button>
    </li>
  );
}

function TaskDetail({ item, onClose }: { item: TaskBoardItem; onClose: () => void }) {
  const cadence = humanizeCadence(item.cadence);
  const next = formatTaskTime(item.nextRunAt);
  const last = formatTaskTime(item.lastRunAt);
  const href = manageHref(item);

  return (
    <>
      <SheetHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="gray">{kindLabel(item.kind)}</Badge>
          <Badge variant="gray">{originLabel(item.origin)}</Badge>
          <StatusBadge status={item.status} />
        </div>
        <SheetTitle className="pr-8 leading-snug">{item.title}</SheetTitle>
        <code className="font-mono text-xs text-muted-foreground">{item.ref}</code>
      </SheetHeader>

      <dl className="mt-6 space-y-4 text-sm">
        <Field label="Cadence">
          {cadence ?? <Muted>Not recurring</Muted>}
        </Field>
        <Field label="Next run">
          {next ? <TimeValue t={next} /> : <Muted>Not scheduled</Muted>}
        </Field>
        <Field label="Last run">{last ? <TimeValue t={last} /> : <Muted>—</Muted>}</Field>
        {item.lastResult && (
          <Field label="Last result">
            <span className="break-words">{item.lastResult}</span>
          </Field>
        )}
        <Field label="Fulfilled by">
          <code className="font-mono text-xs">{item.fulfilledBy}</code>
        </Field>
      </dl>

      {href && (
        <div className="mt-6 border-t border-border pt-4">
          <Link
            href={href}
            onClick={onClose}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            {manageLabel(item)}
            <ArrowUpRight className="h-4 w-4" />
          </Link>
          <p className="mt-1 text-xs text-muted-foreground">
            This board is read-only — changes happen on the owning surface.
          </p>
        </div>
      )}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground/70">{label}</dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  );
}

function TimeValue({ t }: { t: FormattedTime }) {
  return (
    <span title={t.iso}>
      {t.absolute} <span className="text-muted-foreground">({t.relative})</span>
    </span>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}
