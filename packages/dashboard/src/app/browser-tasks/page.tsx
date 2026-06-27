"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Globe2, Search, Ban } from "lucide-react";
import {
  BROWSER_TASK_NON_TERMINAL_STATES,
  BROWSER_TASK_TERMINAL_STATES,
  useBrowserTasks,
  useCancelBrowserTask,
  type BrowserTaskRowWire,
  type BrowserTaskState,
} from "@/lib/hooks/use-browser-tasks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { QueryResult, TableSkeleton } from "@/components/shared/query-result";
import { BrowserTaskStateBadge } from "@/components/browser-tasks/state-badge";
import { AwaitingAttentionStrip } from "@/components/browser-tasks/awaiting-attention-strip";
import { formatAbsoluteTime, formatDuration, formatRelativeTime } from "@/lib/utils";

/**
 * BROWSER_TASK_REDESIGN_PLAN.md §9a.2 — `/browser-tasks` list page.
 *
 * Top-level sibling of Chat / Schedule / Activity per §9a.1 Option A
 * (resolved §12 Q#7). Real-time refresh via the global SSE
 * `browser_task` event (§9a.5 Shape B); poll cadence is the backstop.
 *
 * Filter chips for state + siteKey, free-text description search,
 * "Tasks awaiting you" strip pinned above the table.
 */

type StateFilter = "all" | "active" | "completed" | BrowserTaskState;

const STATE_FILTERS: readonly StateFilter[] = [
  "all",
  "active",
  "pending",
  "running",
  "awaiting_user",
  "final_confirm",
  "completed",
  "failed",
  "cancelled",
  "timeout",
  "abandoned",
];

const STATE_FILTER_LABELS: Record<StateFilter, string> = {
  all: "All",
  active: "Active",
  pending: "Pending",
  running: "Running",
  awaiting_user: "Awaiting you",
  final_confirm: "Final confirm",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  timeout: "Timeout",
  abandoned: "Abandoned",
};

function isNonTerminal(state: BrowserTaskState): boolean {
  return (BROWSER_TASK_NON_TERMINAL_STATES as readonly string[]).includes(
    state,
  );
}

function describeDuration(row: BrowserTaskRowWire): string {
  // running: time-since-start (now)
  // terminal: finishedAt - startedAt (or createdAt if never started)
  // pending: time-since-create (queue wait) + queue position when available
  if (row.state === "pending") {
    const base = `queued ${formatRelativeTime(new Date(row.createdAt))}`;
    const q = row.queueState;
    if (q && (q.sitePos > 0 || q.globalPos > 0 || q.blockedBy)) {
      const segs: string[] = [];
      if (q.sitePos > 0) segs.push(`site #${q.sitePos + 1}`);
      if (q.globalPos > 0) segs.push(`global #${q.globalPos + 1}`);
      if (q.blockedBy) segs.push("blocked");
      return segs.length > 0 ? `${base} (${segs.join(", ")})` : base;
    }
    return base;
  }
  if (row.startedAt) {
    const end = row.finishedAt ?? Date.now();
    return formatDuration(end - row.startedAt);
  }
  if (row.finishedAt) {
    return formatDuration(row.finishedAt - row.createdAt);
  }
  return "—";
}

export default function BrowserTasksPage() {
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [siteKeyFilter, setSiteKeyFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  // Build the daemon-side filter from the active chip. `all` and
  // `active` map to broader server-side queries; the specific states
  // map to the single-state path. We OVER-fetch slightly (no server-
  // side description search) and filter client-side — the list is
  // bounded to the most-recent 200 rows anyway.
  const states = useMemo<readonly BrowserTaskState[] | undefined>(() => {
    if (stateFilter === "all") return undefined;
    if (stateFilter === "active") return BROWSER_TASK_NON_TERMINAL_STATES;
    return [stateFilter];
  }, [stateFilter]);

  const { data, isLoading, isError, error, refetch } = useBrowserTasks({
    states,
    siteKey: siteKeyFilter === "all" ? undefined : siteKeyFilter,
    limit: 200,
  });

  // Wrap in useMemo so the empty-array fallback keeps a stable identity
  // across renders — otherwise a fresh `[]` each render would invalidate
  // the `knownSiteKeys` / `visible` memos below on every render.
  const rows = useMemo(() => data?.tasks ?? [], [data?.tasks]);

  // Collect all known siteKeys from the result for the filter chip
  // row. Sorted + deduped; "all" is the front-of-list.
  const knownSiteKeys = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.siteKey) set.add(r.siteKey);
    return Array.from(set).sort();
  }, [rows]);

  const visible = useMemo(() => {
    if (!search.trim()) return rows;
    const needle = search.trim().toLowerCase();
    return rows.filter((r) =>
      r.description.toLowerCase().includes(needle),
    );
  }, [rows, search]);

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Browser Tasks"
        description={
          <>
            Open-ended browser actions driven by a sandboxed sub-agent —
            one tab per task, allowlist enforcement, payment-path block,
            screenshot trace. Kick a task off in DM
            (&ldquo;send a contact form on amazon&rdquo;) or schedule one
            for later. The agent will DM you for clarification or
            confirmation when it needs your input.
          </>
        }
      />

      {/* "Tasks awaiting you" strip — renders nothing when empty. */}
      <AwaitingAttentionStrip variant="inline" />

      {/* Filter toolbar */}
      <div
        className="flex flex-wrap items-center gap-3"
        role="toolbar"
        aria-label="Browser-task filters"
      >
        <div className="flex flex-wrap gap-1">
          {STATE_FILTERS.map((s) => (
            <Button
              key={s}
              variant={stateFilter === s ? "default" : "outline"}
              size="sm"
              onClick={() => setStateFilter(s)}
              aria-pressed={stateFilter === s}
            >
              {STATE_FILTER_LABELS[s]}
            </Button>
          ))}
        </div>
        {knownSiteKeys.length > 0 && (
          <>
            <Separator orientation="vertical" className="h-6" />
            <div className="flex flex-wrap gap-1">
              <Button
                key="site-all"
                variant={siteKeyFilter === "all" ? "default" : "outline"}
                size="sm"
                onClick={() => setSiteKeyFilter("all")}
                aria-pressed={siteKeyFilter === "all"}
              >
                All sites
              </Button>
              {knownSiteKeys.map((k) => (
                <Button
                  key={k}
                  variant={siteKeyFilter === k ? "default" : "outline"}
                  size="sm"
                  onClick={() => setSiteKeyFilter(k)}
                  aria-pressed={siteKeyFilter === k}
                >
                  {k}
                </Button>
              ))}
            </div>
          </>
        )}
        <Separator orientation="vertical" className="h-6" />
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search description…"
            className="pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search browser-task descriptions"
          />
        </div>
      </div>

      <QueryResult
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={() => refetch()}
        skeleton={<TableSkeleton rows={5} />}
      >
        {visible.length === 0 ? (
          <EmptyState
            icon={Globe2}
            title="No browser tasks yet"
            description={`Ask Aitne in DM ("send a contact form on Amazon's contact-us page") or use /chat.`}
          />
        ) : (
          <BrowserTaskTable rows={visible} />
        )}
      </QueryResult>
    </div>
  );
}

// ── Table ──────────────────────────────────────────────────────────────

function BrowserTaskTable({ rows }: { rows: readonly BrowserTaskRowWire[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-left" aria-label="Browser tasks">
        <thead>
          <tr className="border-b border-border bg-muted/50">
            <th className="px-3 py-2 text-xs font-medium text-muted-foreground">
              State
            </th>
            <th className="px-3 py-2 text-xs font-medium text-muted-foreground">
              Description
            </th>
            <th className="hidden px-3 py-2 text-xs font-medium text-muted-foreground sm:table-cell">
              Site
            </th>
            <th className="hidden px-3 py-2 text-xs font-medium text-muted-foreground lg:table-cell">
              Channel
            </th>
            <th className="px-3 py-2 text-xs font-medium text-muted-foreground">
              Created
            </th>
            <th className="px-3 py-2 text-xs font-medium text-muted-foreground">
              Duration
            </th>
            <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <BrowserTaskRow key={r.id} row={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BrowserTaskRow({ row }: { row: BrowserTaskRowWire }) {
  const cancel = useCancelBrowserTask();
  const truncated = row.description.length > 80
    ? `${row.description.slice(0, 80)}…`
    : row.description;
  const isCancellable = isNonTerminal(row.state);

  const handleCancel = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (
      !window.confirm(
        `Cancel task ${row.id.slice(0, 8)}? The browser context will be released and the user will be DMed.`,
      )
    ) {
      return;
    }
    cancel.mutate({ taskId: row.id, reason: "user_cancel_from_dashboard" });
  };

  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-muted/30">
      <td className="px-3 py-2">
        <BrowserTaskStateBadge state={row.state} />
        {row.outcomeDetail && (BROWSER_TASK_TERMINAL_STATES as readonly string[]).includes(row.state) && (
          <div className="mt-1 text-[10px] text-muted-foreground">
            {row.outcomeDetail}
          </div>
        )}
      </td>
      <td className="max-w-md px-3 py-2 text-sm">
        <Link
          href={`/browser-tasks/${row.id}`}
          className="block text-foreground hover:underline"
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="line-clamp-2">{truncated}</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-md">
              {row.description}
            </TooltipContent>
          </Tooltip>
        </Link>
      </td>
      <td className="hidden px-3 py-2 sm:table-cell">
        {row.siteKey ? (
          <Badge variant="gray">{row.siteKey}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
      <td className="hidden px-3 py-2 text-xs text-muted-foreground lg:table-cell">
        {row.originatingChannel ?? "—"}
      </td>
      <td className="px-3 py-2 text-xs">
        <Tooltip>
          <TooltipTrigger>{formatRelativeTime(new Date(row.createdAt))}</TooltipTrigger>
          <TooltipContent>{formatAbsoluteTime(new Date(row.createdAt))}</TooltipContent>
        </Tooltip>
      </td>
      <td className="px-3 py-2 font-mono text-xs tabular-nums text-muted-foreground">
        {describeDuration(row)}
      </td>
      <td className="px-3 py-2 text-right">
        <div className="flex items-center justify-end gap-2">
          <Link
            href={`/browser-tasks/${row.id}`}
            className="text-xs underline-offset-4 hover:underline"
          >
            View
          </Link>
          {isCancellable && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCancel}
              disabled={cancel.isPending}
              title="Cancel task"
            >
              <Ban className="h-3.5 w-3.5" />
              <span className="sr-only">Cancel</span>
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}
