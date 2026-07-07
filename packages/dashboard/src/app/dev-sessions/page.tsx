"use client";

import { useState } from "react";
import { GitBranch, ListChecks, Network, Terminal } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EmptyState } from "@/components/shared/empty-state";
import { QueryResult, TableSkeleton } from "@/components/shared/query-result";
import { useDevSessions, useDevSession } from "@/lib/hooks/use-dev-sessions";
import {
  devStateBadgeVariant,
  devStateLabel,
  devLoopStateLabel,
  devReqStatusBadgeVariant,
  devPhaseLabel,
  devTaskStateBadgeVariant,
  devTaskStateLabel,
  groupTasksByLayer,
  reqSummary,
  formatCost,
  formatDevTime,
} from "@/lib/dev-sessions/view";
import type { DevSessionSummary, DevSessionDetailResponse } from "@/lib/dev-sessions/types";

/**
 * Dev Sessions — visibility into the development-mode loop (drive Claude Code
 * from chat to build in a registered repo). Each session shows its state, the
 * REQ ledger progress, cost, and — in the drawer — the per-leg iteration
 * timeline + escalations. Read-only: the loop is driven from chat
 * (`!repo` / `!approve` / `!exit`), not here.
 */
export default function DevSessionsPage() {
  const { data, isLoading, isError, error, refetch } = useDevSessions();
  const [selected, setSelected] = useState<DevSessionSummary | null>(null);

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Dev Sessions"
        description="Autonomous build loops running inside your registered repos. Drive them from chat with !repo, !approve, and !exit."
        badge={
          <Badge variant="amber" className="uppercase tracking-wide">
            Experimental
          </Badge>
        }
      />

      <QueryResult
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={() => refetch()}
        skeleton={<TableSkeleton rows={5} />}
      >
        {data && data.sessions.length === 0 ? (
          <EmptyState
            icon={Terminal}
            title="No dev sessions yet"
            description="Message your agent `!repo <name>` to start building in a registered repository."
          />
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {data?.sessions.map((session) => {
              const created = formatDevTime(session.createdAt);
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(session)}
                    className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-muted/50"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium text-foreground">
                          {session.slug ?? session.repositoryId}
                        </span>
                        <Badge variant={devStateBadgeVariant(session.state)}>
                          {devStateLabel(session.state)}
                        </Badge>
                        {devLoopStateLabel(session.loopState) ? (
                          <Badge variant="gray">{devLoopStateLabel(session.loopState)}</Badge>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <ListChecks className="h-3.5 w-3.5" />
                          {reqSummary(session.requirementsMet, session.requirementsTotal)}
                        </span>
                        {session.tasksTotal > 0 ? (
                          <span className="inline-flex items-center gap-1">
                            <Network className="h-3.5 w-3.5" />
                            {session.tasksMerged}/{session.tasksTotal} tasks
                          </span>
                        ) : null}
                        {session.branch ? (
                          <span className="inline-flex items-center gap-1">
                            <GitBranch className="h-3.5 w-3.5" />
                            {session.branch}
                          </span>
                        ) : null}
                        <span>iter {session.iteration}</span>
                        <span>{formatCost(session.costUsd)}</span>
                        <span title={created.absolute}>{created.relative}</span>
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </QueryResult>

      <DevSessionDrawer
        summary={selected}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

function DevSessionDrawer({
  summary,
  onClose,
}: {
  summary: DevSessionSummary | null;
  onClose: () => void;
}) {
  const { data } = useDevSession(summary?.id ?? null);

  return (
    <Sheet open={!!summary} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {summary ? (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                {summary.slug ?? summary.repositoryId}
                <Badge variant={devStateBadgeVariant(summary.state)}>
                  {devStateLabel(summary.state)}
                </Badge>
              </SheetTitle>
            </SheetHeader>

            <div className="mt-4 space-y-6">
              <section className="grid grid-cols-2 gap-3 text-sm">
                <Meta label="Branch" value={summary.branch ?? "—"} />
                <Meta label="Iteration" value={String(summary.iteration)} />
                <Meta
                  label="Requirements"
                  value={reqSummary(summary.requirementsMet, summary.requirementsTotal)}
                />
                <Meta label="Cost" value={formatCost(summary.costUsd)} />
                {devLoopStateLabel(summary.loopState) ? (
                  <Meta label="Verdict" value={devLoopStateLabel(summary.loopState)!} />
                ) : null}
              </section>

              {data && data.requirements.length > 0 ? (
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold text-foreground">Requirements</h3>
                  <ul className="space-y-1">
                    {data.requirements.map((req) => (
                      <li key={req.id} className="flex items-start gap-2 text-sm">
                        <Badge variant={devReqStatusBadgeVariant(req.status)}>{req.reqId}</Badge>
                        <span className="min-w-0 flex-1 text-muted-foreground">
                          {req.title ?? "—"}
                          {req.evidence ? (
                            <span className="block text-xs opacity-80">{req.evidence}</span>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {data && data.tasks.length > 0 ? <FlowSection data={data} /> : null}

              {data && data.escalations.some((e) => !e.resolved) ? (
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold text-foreground">Open decisions</h3>
                  {data.escalations
                    .filter((e) => !e.resolved)
                    .map((e) => (
                      <div
                        key={e.id}
                        className="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm"
                      >
                        <p className="text-foreground">{e.question}</p>
                        {e.contextSummary ? (
                          <p className="mt-1 text-xs text-muted-foreground">{e.contextSummary}</p>
                        ) : null}
                        <p className="mt-1 text-xs text-muted-foreground">
                          Reply in chat to continue.
                        </p>
                      </div>
                    ))}
                </section>
              ) : null}

              {data && data.iterations.length > 0 ? (
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold text-foreground">Iteration timeline</h3>
                  <ul className="space-y-1">
                    {data.iterations.map((it) => {
                      const t = formatDevTime(it.createdAt);
                      const taskKey = it.taskId
                        ? data.tasks.find((task) => task.id === it.taskId)?.taskKey ?? null
                        : null;
                      return (
                        <li
                          key={it.id}
                          className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-1.5 text-sm"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="text-muted-foreground">#{it.iteration}</span>
                            <Badge variant="gray">{devPhaseLabel(it.phase)}</Badge>
                            {taskKey ? (
                              <Badge variant="blue">{taskKey}</Badge>
                            ) : null}
                            {it.verdict ? (
                              <span className="truncate text-xs text-muted-foreground">{it.verdict}</span>
                            ) : null}
                          </span>
                          <span className="text-xs text-muted-foreground" title={t.absolute}>
                            {t.relative}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/** The decomposed task DAG, rendered as topological layers (tasks in one layer
 *  ran in parallel; a layer separator means "runs after the layer above"). */
function FlowSection({ data }: { data: DevSessionDetailResponse }) {
  const layers = groupTasksByLayer(data.tasks);
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">Flow</h3>
      <div className="space-y-2">
        {layers.map((layer, i) => (
          <div key={i} className="space-y-1">
            {i > 0 ? (
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                runs after ↑
              </p>
            ) : null}
            {layer.map((task) => (
              <div
                key={task.id}
                className="rounded-md border border-border px-3 py-1.5 text-sm"
              >
                <div className="flex items-center gap-2">
                  <Badge variant={devTaskStateBadgeVariant(task.state)}>
                    {devTaskStateLabel(task.state)}
                  </Badge>
                  <span className="truncate font-medium text-foreground">{task.taskKey}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {formatCost(task.costUsd)}
                  </span>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">{task.summary}</p>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                  <span>{task.reqs.join(", ")}</span>
                  {task.dependsOn.length > 0 ? (
                    <span>· needs {task.dependsOn.join(", ")}</span>
                  ) : null}
                  <span>· iter {task.iteration}</span>
                  {task.origin !== "plan" ? <span>· {task.origin}</span> : null}
                  {task.failReason ? (
                    <span className="text-destructive">· {task.failReason}</span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-foreground">{value}</p>
    </div>
  );
}
