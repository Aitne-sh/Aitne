"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  Bot,
  CalendarDays,
  CalendarRange,
  Clock,
  ListTree,
  Map as MapIcon,
  Plus,
  Sparkles,
  Sunrise,
  Sunset,
  UserCog,
  type LucideIcon,
} from "lucide-react";
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
  type AgentListFilterState,
} from "@/lib/agents/list-view";
import { groupByCategory, type AgentCategoryGroup } from "@/lib/agents/categories";
import {
  describeSchedule,
  formatActiveHours,
  formatCostUsd,
  formatIntervalEvery,
  formatPercent,
  kindLabel,
} from "@/lib/agents/format";
import { cn, formatRelativeTime } from "@/lib/utils";
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

/** Per-slug icon for the built-ins; user Agents and unknown slugs get Bot. */
const AGENT_ICONS: Record<string, LucideIcon> = {
  "morning-routine": Sunrise,
  "evening-review": Sunset,
  "weekly-review": CalendarRange,
  "monthly-review": CalendarDays,
  "activity-scan": Activity,
  "user-profile-sweep-morning": UserCog,
  "user-profile-sweep-evening": UserCog,
  "roadmap-maintenance": MapIcon,
  "context-index-reconcile": ListTree,
  "skill-curation": Sparkles,
};

export default function AgentsPage() {
  useAgentLiveRefresh();
  const running = useRunningAgents();
  const { data, isLoading, isError, error, refetch } = useAgents({ include_invalid: true });

  const [filters, setFilters] = useState<AgentListFilterState>(DEFAULT_FILTER_STATE);

  const { invalid, groups } = useMemo(() => {
    const all = data?.agents ?? [];
    const { invalid, valid } = partitionByValidity(all);
    const filtered = filterAgents(valid, filters);
    return { invalid, groups: groupByCategory(filtered) };
  }, [data?.agents, filters]);

  const visibleCount = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Agents"
        description={
          <>
            Everything that runs on your behalf lives here — the shipped{" "}
            <strong>System</strong> routines (synthesis, monitoring, maintenance) and your own{" "}
            <strong>User</strong> Agents, each with its schedule, rulebook, limits, and recent
            health. The{" "}
            <Link
              href="/tasks?tab=queue"
              className="underline underline-offset-2 hover:text-foreground"
            >
              queue
            </Link>{" "}
            on the Tasks page shows what is about to fire.
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
            <AlertTriangle className="h-4 w-4 text-warning" />
            Needs attention
          </h2>
          {invalid.map((agent) => (
            <Link key={agent.slug} href={`/agents/${agent.slug}`} className="block">
              <Alert variant="warning" className="hover:bg-warning/15">
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
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by cadence">
          {CADENCE_FILTERS.map((f) => (
            <Button
              key={f.value}
              variant={filters.cadence === f.value ? "default" : "outline"}
              size="sm"
              onClick={() => setFilters((prev) => ({ ...prev, cadence: f.value }))}
              aria-pressed={filters.cadence === f.value}
              title={
                f.value === "interval"
                  ? "Agents that fire every N minutes/hours (e.g. activity scan)"
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
        <div className="space-y-8">
          {groups.map((group) => (
            <CategorySection key={group.category} group={group} running={running} />
          ))}
        </div>

        {visibleCount === 0 && (
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

function CategorySection({
  group,
  running,
}: {
  group: AgentCategoryGroup;
  running: ReadonlySet<string>;
}) {
  return (
    <section aria-label={group.meta.label} className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{group.meta.label}</h2>
        <p className="text-xs text-muted-foreground">{group.meta.description}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {group.items.map((agent) => (
          <AgentCard key={agent.slug} agent={agent} running={running.has(agent.slug)} />
        ))}
      </div>
    </section>
  );
}

/** Dot color for the last execution result — semantic tokens only. */
function resultDotClass(result: string | null | undefined): string {
  switch (result) {
    case "success":
      return "bg-success";
    case "error":
    case "timeout":
      return "bg-destructive";
    case "skipped":
      return "bg-muted-foreground/50";
    default:
      return "bg-muted-foreground/30";
  }
}

function AgentCard({ agent, running }: { agent: AgentListItem; running: boolean }) {
  // Property-access lookup (not a call) — the static-components lint rule
  // accepts this idiom (mirrors settings-navigation's `item.icon`).
  const Icon = AGENT_ICONS[agent.slug] ?? Bot;
  const scheduleText = agent.schedule.interval
    ? `${formatIntervalEvery(agent.schedule.interval)}${
        formatActiveHours(agent.schedule.interval)
          ? `, ${formatActiveHours(agent.schedule.interval)}`
          : ""
      }`
    : describeSchedule(agent.schedule);
  const last = agent.last_execution;
  const hasMetrics = agent.metrics_7d.executions > 0;

  return (
    <Link
      href={`/agents/${agent.slug}`}
      className={cn(
        "group flex flex-col gap-3 rounded-xl border border-border bg-card p-4 transition-colors",
        "hover:border-primary/40 hover:bg-muted/30",
        !agent.enabled && "opacity-70",
      )}
      aria-label={`${agent.name} — ${agent.enabled ? "enabled" : "disabled"}`}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
            agent.enabled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
          )}
        >
          <Icon className="h-4.5 w-4.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-foreground">{agent.name}</span>
            {running && (
              <span
                className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-success"
                aria-label="executing"
              />
            )}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {agent.description || agent.slug}
          </p>
        </div>
        <Badge variant={agent.enabled ? "green" : "gray"} className="shrink-0">
          {agent.enabled ? "ON" : "OFF"}
        </Badge>
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Clock className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">{scheduleText}</span>
        </span>
        <span className="flex shrink-0 items-center gap-3 tabular-nums">
          <span className="inline-flex items-center gap-1.5" title="Last run">
            <span
              className={cn("h-1.5 w-1.5 rounded-full", resultDotClass(last?.result))}
              aria-hidden
            />
            {last?.started_at ? formatRelativeTime(last.started_at) : "never"}
          </span>
          {hasMetrics && (
            <>
              <span title="7-day error rate">{formatPercent(agent.metrics_7d.error_rate)}</span>
              <span title="Average cost per execution (7d)">
                {formatCostUsd(agent.metrics_7d.avg_cost_usd)}
              </span>
            </>
          )}
        </span>
      </div>
    </Link>
  );
}
