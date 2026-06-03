"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, Plus, AlertTriangle, ArrowUpDown, Settings2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { EmptyState } from "@/components/shared/empty-state";
import { QueryResult, TableSkeleton } from "@/components/shared/query-result";
import { NewAgentDialog } from "@/components/agents/NewAgentDialog";
import { useAgents, useAgentLiveRefresh, useRunningAgents } from "@/lib/hooks/use-agents";
import {
  DEFAULT_FILTER_STATE,
  filterAgents,
  partitionByValidity,
  sortAgents,
  type AgentListFilterState,
  type AgentSortKey,
  type SortDirection,
} from "@/lib/agents/list-view";
import {
  describeSchedule,
  formatActiveHours,
  formatCostUsd,
  formatIntervalEvery,
  formatPercent,
  kindLabel,
} from "@/lib/agents/format";
import { cn } from "@/lib/utils";
import type { AgentListItem } from "@/lib/agents/types";

const KIND_FILTERS: { value: AgentListFilterState["kind"]; label: string }[] = [
  { value: "all", label: "All" },
  { value: "builtin", label: "System" },
  { value: "user", label: "User" },
];
const STATUS_FILTERS: { value: AgentListFilterState["status"]; label: string }[] = [
  { value: "all", label: "All" },
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled" },
];
const CADENCE_FILTERS: { value: AgentListFilterState["cadence"]; label: string }[] = [
  { value: "all", label: "All" },
  { value: "interval", label: "Interval" },
  { value: "scheduled", label: "Scheduled" },
];

interface Column {
  key: AgentSortKey;
  label: string;
  className?: string;
}
const COLUMNS: Column[] = [
  { key: "name", label: "Name" },
  { key: "kind", label: "Kind" },
  { key: "schedule", label: "Schedule" },
  { key: "status", label: "Status" },
  { key: "last", label: "Last run" },
  { key: "errorRate", label: "Err%" },
  { key: "cost", label: "$/exec" },
];

export default function AgentsPage() {
  useAgentLiveRefresh();
  const running = useRunningAgents();
  const router = useRouter();
  const { data, isLoading, isError, error, refetch } = useAgents({ include_invalid: true });

  const [filters, setFilters] = useState<AgentListFilterState>(DEFAULT_FILTER_STATE);
  const [sortKey, setSortKey] = useState<AgentSortKey>("last");
  const [sortDir, setSortDir] = useState<SortDirection>("desc");

  const { invalid, visible } = useMemo(() => {
    const all = data?.agents ?? [];
    const { invalid, valid } = partitionByValidity(all);
    const filtered = filterAgents(valid, filters);
    return { invalid, visible: sortAgents(filtered, sortKey, sortDir) };
  }, [data?.agents, filters, sortKey, sortDir]);

  const toggleSort = (key: AgentSortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "last" ? "desc" : "asc");
    }
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Agents"
        description={
          <>
            Every Agent that exists — shipped <strong>System</strong> routines (morning routine,
            reviews, hourly check, …) and your own <strong>User</strong> Agents — with its schedule,
            status, and recent health. This is the identity view; the{" "}
            <Link href="/schedule" className="underline underline-offset-2 hover:text-foreground">
              queue view
            </Link>{" "}
            shows what is about to fire.
          </>
        }
        actions={
          <NewAgentDialog
            trigger={
              <Button>
                <Plus className="mr-1 h-4 w-4" />
                New Agent
              </Button>
            }
          />
        }
      />

      {/* Needs attention — invalid definitions (§10.1) */}
      {invalid.length > 0 && (
        <div className="space-y-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Needs attention
          </h2>
          {invalid.map((agent) => (
            <Link key={agent.slug} href={`/agents/${agent.slug}`} className="block">
              <Alert variant="warning" className="hover:bg-amber-100/60 dark:hover:bg-amber-950/60">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{agent.slug}</span>
                  <Badge variant={agent.kind === "builtin" ? "blue" : "gray"}>
                    {kindLabel(agent.kind)}
                  </Badge>
                  <span className="text-muted-foreground">
                    {agent.last_error ?? "Definition failed to load"}
                  </span>
                </div>
              </Alert>
            </Link>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3" role="toolbar" aria-label="Agent filters">
        <div className="flex flex-wrap gap-1">
          {KIND_FILTERS.map((f) => (
            <Button
              key={f.value}
              variant={filters.kind === f.value ? "default" : "outline"}
              size="sm"
              onClick={() => setFilters((prev) => ({ ...prev, kind: f.value }))}
              aria-pressed={filters.kind === f.value}
            >
              {f.label}
            </Button>
          ))}
        </div>
        <Separator orientation="vertical" className="h-6" />
        <div className="flex flex-wrap gap-1">
          {STATUS_FILTERS.map((f) => (
            <Button
              key={f.value}
              variant={filters.status === f.value ? "default" : "outline"}
              size="sm"
              onClick={() => setFilters((prev) => ({ ...prev, status: f.value }))}
              aria-pressed={filters.status === f.value}
            >
              {f.label}
            </Button>
          ))}
        </div>
        <Separator orientation="vertical" className="h-6" />
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label="Filter by cadence"
        >
          {CADENCE_FILTERS.map((f) => (
            <Button
              key={f.value}
              variant={filters.cadence === f.value ? "default" : "outline"}
              size="sm"
              onClick={() => setFilters((prev) => ({ ...prev, cadence: f.value }))}
              aria-pressed={filters.cadence === f.value}
              title={
                f.value === "interval"
                  ? "Agents that fire every N minutes/hours (e.g. hourly check)"
                  : f.value === "scheduled"
                    ? "Agents that fire at a fixed daily/weekly time"
                    : undefined
              }
            >
              {f.label}
            </Button>
          ))}
        </div>
        <input
          type="search"
          value={filters.search}
          onChange={(e) => setFilters((prev) => ({ ...prev, search: e.target.value }))}
          placeholder="Search agents…"
          aria-label="Search agents"
          className="ml-auto h-8 w-56 rounded-md border border-border bg-background px-2 text-sm"
        />
      </div>

      <QueryResult
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={() => refetch()}
        skeleton={<TableSkeleton rows={6} />}
      >
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-left" aria-label="Agents">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                {COLUMNS.map((col) => (
                  <th key={col.key} className="px-3 py-2 text-xs font-medium text-muted-foreground">
                    <button
                      type="button"
                      onClick={() => toggleSort(col.key)}
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      aria-label={`Sort by ${col.label}`}
                    >
                      {col.label}
                      <ArrowUpDown
                        className={cn(
                          "h-3 w-3",
                          sortKey === col.key ? "text-foreground" : "text-muted-foreground/40",
                        )}
                      />
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((agent) => (
                <AgentRow
                  key={agent.slug}
                  agent={agent}
                  running={running.has(agent.slug)}
                  onClick={() => router.push(`/agents/${agent.slug}`)}
                />
              ))}
            </tbody>
          </table>
        </div>

        {visible.length === 0 && (
          <EmptyState
            icon={Bot}
            title="No agents match"
            description="Adjust the filters, or create a new Agent."
          />
        )}
      </QueryResult>
    </div>
  );
}

function AgentRow({
  agent,
  running,
  onClick,
}: {
  agent: AgentListItem;
  running: boolean;
  onClick: () => void;
}) {
  return (
    <tr
      className="cursor-pointer border-b border-border hover:bg-muted/30"
      onClick={onClick}
    >
      <td className="px-3 py-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{agent.name}</span>
          <code className="text-xs text-muted-foreground">{agent.slug}</code>
        </div>
      </td>
      <td className="px-3 py-2">
        {agent.kind === "builtin" ? (
          <Badge variant="blue">
            <Settings2 className="mr-1 h-3 w-3" /> System
          </Badge>
        ) : (
          <Badge variant="gray">User</Badge>
        )}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {agent.schedule.interval ? (
          // Runtime-window Agent: interval on top, active-hours window below.
          <span className="flex flex-col leading-tight">
            <span className="text-foreground">{formatIntervalEvery(agent.schedule.interval)}</span>
            {formatActiveHours(agent.schedule.interval) && (
              <span>{formatActiveHours(agent.schedule.interval)}</span>
            )}
          </span>
        ) : (
          describeSchedule(agent.schedule)
        )}
      </td>
      <td className="px-3 py-2">
        <span className="flex items-center gap-1.5 text-sm">
          {running && (
            <span
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500"
              aria-label="executing"
            />
          )}
          <Badge variant={agent.enabled ? "green" : "gray"}>{agent.enabled ? "ON" : "OFF"}</Badge>
        </span>
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {agent.last_execution?.started_at
          ? new Date(agent.last_execution.started_at).toLocaleString()
          : "—"}
      </td>
      <td className="px-3 py-2 text-sm tabular-nums">{formatPercent(agent.metrics_7d.error_rate)}</td>
      <td className="px-3 py-2 text-sm tabular-nums">{formatCostUsd(agent.metrics_7d.avg_cost_usd)}</td>
    </tr>
  );
}
