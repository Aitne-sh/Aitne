"use client";

import { ListChecks } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/status-badge";
import { QueryResult, TableSkeleton } from "@/components/shared/query-result";
import { useTasks } from "@/lib/hooks/use-tasks";
import { groupTasksByKind, originLabel } from "@/lib/tasks/view";
import type { TaskBoardItem } from "@/lib/tasks/types";

/**
 * Unified Task Board — read-only `/tasks` page
 * (docs/design/appendices/unified-task-board.md §5.2c). A single inventory of
 * everything the agent has in motion, computed on demand from the daemon's
 * `GET /api/tasks`. Writes still go through the owning surfaces (Agents,
 * Schedule, …) — this page is the read/overview half of the board.
 */
export default function TasksPage() {
  const { data, isLoading, isError, error, refetch } = useTasks();
  const groups = data ? groupTasksByKind(data.items) : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tasks"
        description="Everything the agent has in motion — recurring DMs, agents, app fetches, reminders, and in-flight work. Read-only; manage each item on its own surface."
      />

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
            {groups.map((group) => (
              <section key={group.kind} className="space-y-2">
                <div className="flex items-baseline gap-2">
                  <h2 className="text-sm font-semibold text-foreground">{group.label}</h2>
                  <span className="text-xs text-muted-foreground">{group.items.length}</span>
                </div>
                <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                  {group.items.map((item) => (
                    <TaskRow key={item.ref} item={item} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </QueryResult>
    </div>
  );
}

function TaskRow({ item }: { item: TaskBoardItem }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{item.title}</p>
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <code className="font-mono">{item.ref}</code>
          {item.cadence && <span>· {item.cadence}</span>}
          {item.nextRunAt && <span>· next {item.nextRunAt}</span>}
          {item.lastResult && <span>· last: {item.lastResult}</span>}
        </p>
      </div>
      <Badge variant="gray" className="shrink-0">
        {originLabel(item.origin)}
      </Badge>
      <StatusBadge status={item.status} className="shrink-0" />
    </li>
  );
}
