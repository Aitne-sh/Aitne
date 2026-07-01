"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Play,
  Settings2,
  Trash2,
  Pencil,
  ChevronRight,
  Clock,
  Cpu,
  RotateCw,
} from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Card, CardHeader, CardStatLabel, CardTitle, CardValue } from "@/components/ui/card";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  RECHARTS_TOOLTIP_CONTENT_STYLE,
  RECHARTS_TOOLTIP_CURSOR_FILL,
  RECHARTS_TOOLTIP_ITEM_STYLE,
  RECHARTS_TOOLTIP_LABEL_STYLE,
} from "@/lib/recharts-theme";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { QueryResult } from "@/components/shared/query-result";
import { StopWarningModal } from "@/components/agents/StopWarningModal";
import { AgentEditor } from "@/components/agents/AgentEditor";
import { RulebookTab } from "@/components/agents/RulebookTab";
import { ScheduleWindowCard } from "@/components/agents/ScheduleWindowCard";
import { cn, niceAxisMax } from "@/lib/utils";
import { CATEGORY_META } from "@/lib/agents/categories";
import {
  useAgent,
  useAgentLiveRefresh,
  useDeleteAgent,
  usePatchAgent,
  useRunAgentNow,
  useRunningAgents,
} from "@/lib/hooks/use-agents";
import {
  describeInterval,
  describeSchedule,
  formatActiveHours,
  formatCostUsd,
  formatDurationSeconds,
  formatIntervalEvery,
  formatPercent,
  formatRelativeTime,
  resultBadgeVariant,
} from "@/lib/agents/format";
import type {
  AgentDetailResponse,
  AgentExecution,
  AgentMetricsWindow,
} from "@/lib/agents/types";

export default function AgentDetailPage() {
  // useSearchParams (deep-link ?tab=) requires a Suspense boundary for the
  // build-time CSR bailout — same idiom as the activity / knowledge pages.
  return (
    <Suspense>
      <AgentDetailPageInner />
    </Suspense>
  );
}

function AgentDetailPageInner() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  useAgentLiveRefresh();
  const running = useRunningAgents();
  const { data, isLoading, isError, error, refetch } = useAgent(slug);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-6 pb-10">
      <Link
        href="/agents"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> All agents
      </Link>

      <QueryResult isLoading={isLoading} isError={isError} error={error} onRetry={() => refetch()}>
        {data && <AgentDetail detail={data} running={running.has(slug)} />}
      </QueryResult>
    </div>
  );
}

function AgentDetail({ detail, running }: { detail: AgentDetailResponse; running: boolean }) {
  const { row } = detail;
  const router = useRouter();
  const patch = usePatchAgent();
  const runNow = useRunAgentNow();
  const del = useDeleteAgent();

  const searchParams = useSearchParams();
  const [stopModalOpen, setStopModalOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  // Deep links (e.g. the retired /settings/journal redirect →
  // /agents/morning-routine?tab=rulebook) can open a specific tab.
  const [tab, setTab] = useState(() => {
    const requested = searchParams.get("tab");
    return requested && ["overview", "rulebook", "definition", "history", "metrics"].includes(requested)
      ? requested
      : "overview";
  });

  const isBuiltin = row.source === "builtin";
  const runnable = !row.invalid && row.process_key !== null;
  const hasRulebook = detail.policy_files.length > 0;
  const categoryMeta = row.category ? CATEGORY_META[row.category] : undefined;

  // Glanceable header metadata — the schedule, pinned model, and last run, shown
  // as a muted strip under the title (the Overview tab keeps the full reference).
  const scheduleLabel = row.schedule_interval
    ? describeInterval(row.schedule_interval)
    : describeSchedule({
        kind: row.schedule_kind,
        expression: row.schedule_expression,
        timezone: row.schedule_timezone,
      });
  const modelLabel = detail.agent?.backend.model ?? null;
  const lastRun = formatRelativeTime(detail.recent_executions[0]?.started_at);
  const status = running
    ? { dot: "bg-success animate-pulse", label: "Running" }
    : row.enabled
      ? { dot: "bg-success", label: "Enabled" }
      : { dot: "bg-muted-foreground", label: "Disabled" };

  const onToggle = () => {
    if (row.enabled) {
      // Disabling — surface the stop-warning modal when one is declared
      // (always present for System Agents; optional for User Agents).
      if (row.stop_warning) {
        setStopModalOpen(true);
      } else {
        patch.mutate({ slug: row.slug, body: { enabled: false } });
      }
    } else {
      patch.mutate({ slug: row.slug, body: { enabled: true } });
    }
  };

  const confirmStop = () => {
    patch.mutate(
      { slug: row.slug, body: { enabled: false, ack_warning: true } },
      { onSuccess: () => setStopModalOpen(false) },
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={isBuiltin ? Settings2 : undefined}
        eyebrow={
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {categoryMeta && <span>{categoryMeta.label}</span>}
            {categoryMeta && (
              <span aria-hidden className="text-muted-foreground/40">
                ·
              </span>
            )}
            <span className="inline-flex items-center gap-1.5">
              <span className={cn("h-1.5 w-1.5 rounded-full", status.dot)} aria-hidden />
              {status.label}
            </span>
          </div>
        }
        title={
          <span className="line-clamp-2" title={row.name}>
            {row.name}
          </span>
        }
        description={
          row.description && row.description !== row.name ? row.description : undefined
        }
        meta={
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 shrink-0" />
              {scheduleLabel}
            </span>
            {modelLabel && (
              <>
                <span aria-hidden className="text-muted-foreground/40">
                  ·
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Cpu className="h-3.5 w-3.5 shrink-0" />
                  <code className="font-mono text-[11px]">{modelLabel}</code>
                </span>
              </>
            )}
            {lastRun && (
              <>
                <span aria-hidden className="text-muted-foreground/40">
                  ·
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <RotateCw className="h-3.5 w-3.5 shrink-0" />
                  Last run {lastRun}
                </span>
              </>
            )}
          </div>
        }
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant={row.enabled ? "outline" : "default"}
              size="sm"
              onClick={onToggle}
              disabled={patch.isPending}
            >
              {row.enabled ? "Disable" : "Enable"}
            </Button>
            <RunNowButton
              runnable={runnable}
              invalid={row.invalid}
              nullKey={row.process_key === null}
              pending={runNow.isPending}
              onRun={() => runNow.mutate(row.slug)}
            />
            {!isBuiltin && (
              <Button variant="ghost" size="icon" aria-label="Delete agent" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        }
      />

      {row.invalid && (
        <Alert variant="error">
          This Agent&apos;s definition failed to load and will not fire until fixed.
        </Alert>
      )}
      {patch.isError && <Alert variant="error">{(patch.error as Error).message}</Alert>}
      {runNow.isSuccess && <Alert variant="success">Queued — it will fire on the next scheduler tick.</Alert>}
      {runNow.isError && <Alert variant="error">{(runNow.error as Error).message}</Alert>}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          {hasRulebook && <TabsTrigger value="rulebook">Rulebook</TabsTrigger>}
          <TabsTrigger value="definition">Definition</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6 space-y-6">
          <OverviewTab detail={detail} />
        </TabsContent>

        {hasRulebook && (
          <TabsContent value="rulebook" className="mt-6">
            <RulebookTab agentName={row.name} files={detail.policy_files} />
          </TabsContent>
        )}

        <TabsContent value="definition" className="mt-6 space-y-4">
          {detail.schedule_window && (
            <ScheduleWindowCard
              // Remount when the stored overrides change (save / reset round-trip)
              // so the form's local draft re-seeds from the fresh resolved values.
              key={JSON.stringify(detail.schedule_window.overrides)}
              slug={row.slug}
              window={detail.schedule_window}
            />
          )}
          {editing ? (
            <AgentEditor detail={detail} onClose={() => setEditing(false)} />
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">
                  {isBuiltin
                    ? "Shipped definition (read-only). Editable overrides apply on top."
                    : "User definition."}
                </span>
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                  <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
                </Button>
              </div>
              <pre className="max-h-[28rem] overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
                {detail.definition_yaml ?? "(no definition file on disk)"}
              </pre>
              <p className="text-xs text-muted-foreground">
                On-disk path: <code className="font-mono">{detail.definition_path}</code>
              </p>
            </div>
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-6 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Recent executions</span>
            <Link
              href={`/agents/${row.slug}/executions`}
              className="inline-flex items-center text-sm text-primary hover:underline"
            >
              View all <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <ExecutionsTable executions={detail.recent_executions} />
        </TabsContent>

        <TabsContent value="metrics" className="mt-6 space-y-6">
          <MetricsTab detail={detail} />
        </TabsContent>
      </Tabs>

      <StopWarningModal
        open={stopModalOpen}
        onOpenChange={setStopModalOpen}
        agentName={row.name}
        warning={row.stop_warning}
        onConfirm={confirmStop}
        pending={patch.isPending}
        error={patch.isError ? (patch.error as Error).message : null}
      />

      <DeleteAgentDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        agentName={row.name}
        pending={del.isPending}
        error={del.isError ? (del.error as Error).message : null}
        onConfirm={(keepHistory) =>
          del.mutate(
            { slug: row.slug, keepHistory },
            {
              onSuccess: () => {
                setDeleteOpen(false);
                router.push("/agents");
              },
            },
          )
        }
      />
    </div>
  );
}

// ── Run-now button (disabled for no-LLM passes / invalid) ───────────────────

function RunNowButton({
  runnable,
  invalid,
  nullKey,
  pending,
  onRun,
}: {
  runnable: boolean;
  invalid: boolean;
  nullKey: boolean;
  pending: boolean;
  onRun: () => void;
}) {
  const button = (
    <Button size="sm" onClick={onRun} disabled={!runnable || pending}>
      <Play className="mr-1 h-3.5 w-3.5" />
      {pending ? "Queuing…" : "Run now"}
    </Button>
  );
  if (runnable) return button;
  const reason = invalid
    ? "This Agent's definition is invalid."
    : nullKey
      ? "This built-in is a no-LLM in-process pass — fired by the scheduler, not run-now."
      : "Not runnable.";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0}>{button}</span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

// ── Overview tab ────────────────────────────────────────────────────────────

function OverviewTab({ detail }: { detail: AgentDetailResponse }) {
  const { row } = detail;
  const m = detail.metrics["7d"];
  return (
    <>
      <Card className="grid gap-4 text-sm sm:grid-cols-2">
        {row.schedule_interval ? (
          <>
            {/* Runtime-window Agent (e.g. activity scan): the interval and the
                active-hours window are shown as two separate fields. */}
            <Field label="Interval">{formatIntervalEvery(row.schedule_interval)}</Field>
            <Field label="Active hours">
              {formatActiveHours(row.schedule_interval) ?? "All day"}{" "}
              <span className="text-muted-foreground">({row.schedule_timezone})</span>
            </Field>
          </>
        ) : (
          <Field label="Schedule">
            {describeSchedule({
              kind: row.schedule_kind,
              expression: row.schedule_expression,
              timezone: row.schedule_timezone,
            })}{" "}
            <span className="text-muted-foreground">({row.schedule_timezone})</span>
          </Field>
        )}
        <Field label="Process key">
          {row.process_key ? <code>{row.process_key}</code> : <span className="text-muted-foreground">— (in-process pass)</span>}
        </Field>
        <Field label="Tier">{detail.agent?.backend.tier ?? "(default)"}</Field>
        <Field label="Model">
          {detail.agent?.backend.model ? <code>{detail.agent.backend.model}</code> : "(default)"}
        </Field>
        {row.tags.length > 0 && (
          <Field label="Tags">
            <span className="flex flex-wrap gap-1">
              {row.tags.map((t) => (
                <Badge key={t} variant="gray">{t}</Badge>
              ))}
            </span>
          </Field>
        )}
      </Card>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-foreground">7-day metrics</h3>
        <MetricGrid window={m} />
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-foreground">Last 5 executions</h3>
        <ExecutionsTable executions={detail.recent_executions.slice(0, 5)} />
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

// ── Shared metric grid ──────────────────────────────────────────────────────

function MetricGrid({ window }: { window: AgentMetricsWindow }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
      <Stat label="Executions" value={String(window.executions)} />
      <Stat label="Error rate" value={formatPercent(window.error_rate)} />
      <Stat label="Avg cost" value={formatCostUsd(window.avg_cost_usd)} />
      <Stat label="p95 duration" value={formatDurationSeconds(window.p95_duration_seconds)} />
      <Stat label="Criteria hit" value={formatPercent(window.criteria_hit_rate)} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4">
      <CardStatLabel>{label}</CardStatLabel>
      <CardValue className="mt-1.5 text-2xl">{value}</CardValue>
    </Card>
  );
}

// ── Metrics tab ─────────────────────────────────────────────────────────────

function MetricsTab({ detail }: { detail: AgentDetailResponse }) {
  const byKind = Object.entries(detail.metrics.by_error_kind_7d);
  const maxKind = byKind.reduce((m, [, n]) => Math.max(m, n), 0);
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">Last 7 days</h3>
        <MetricGrid window={detail.metrics["7d"]} />
      </section>
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-muted-foreground">Last 30 days</h3>
        <MetricGrid window={detail.metrics["30d"]} />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Errors by kind</CardTitle>
          <span className="text-xs text-muted-foreground">Last 7 days</span>
        </CardHeader>
        {byKind.length === 0 ? (
          <p className="text-sm text-muted-foreground">No errors recorded.</p>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              <span className="w-40 shrink-0">Error kind</span>
              <span className="flex-1" />
              <span className="w-12 text-right">Failures</span>
            </div>
            {byKind
              .sort((a, b) => b[1] - a[1])
              .map(([kind, count]) => (
                <div key={kind} className="flex items-center gap-3 text-sm">
                  <span className="w-40 shrink-0 truncate font-mono text-xs">{kind}</span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-destructive/70"
                      style={{ width: `${maxKind === 0 ? 0 : (count / maxKind) * 100}%` }}
                    />
                  </div>
                  <span className="w-12 text-right tabular-nums text-muted-foreground">{count}</span>
                </div>
              ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent execution cost</CardTitle>
        </CardHeader>
        <p className="mb-4 text-xs text-muted-foreground">
          Cost in USD per execution, oldest to newest.
        </p>
        <CostBars executions={detail.recent_executions} />
      </Card>
    </div>
  );
}

/** Compact "6/30 14:05" X-axis label for an execution's start time. */
function shortAxisTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Cost-per-execution bar chart with a labelled $ (Y) axis and a time (X) axis,
 * so the units read at a glance without hovering. Themed to match the app's
 * other Recharts panels (recharts-theme + niceAxisMax).
 */
function CostBars({ executions }: { executions: AgentExecution[] }) {
  const withCost = executions.filter((e) => typeof e.cost_usd === "number");
  if (withCost.length === 0) {
    return <p className="text-sm text-muted-foreground">No cost recorded yet.</p>;
  }
  // Oldest → newest so the X axis reads left-to-right in time.
  const chartData = [...withCost].reverse().map((e) => ({
    cost: e.cost_usd ?? 0,
    label: e.started_at ? shortAxisTime(e.started_at) : "—",
    fullLabel: e.started_at ? new Date(e.started_at).toLocaleString() : "—",
    result: e.result ?? "—",
  }));
  const yMax = niceAxisMax(chartData.map((d) => d.cost));
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={chartData} margin={{ top: 4, right: 8, left: 4, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 11 }}
          className="fill-muted-foreground"
          tickLine={false}
          interval="preserveStartEnd"
          minTickGap={16}
        />
        <YAxis
          width={56}
          tick={{ fontSize: 11 }}
          className="fill-muted-foreground"
          tickLine={false}
          domain={[0, yMax]}
          tickFormatter={(v: number) => formatCostUsd(v)}
        />
        <RechartsTooltip
          contentStyle={{ ...RECHARTS_TOOLTIP_CONTENT_STYLE, fontSize: "12px" }}
          itemStyle={RECHARTS_TOOLTIP_ITEM_STYLE}
          labelStyle={RECHARTS_TOOLTIP_LABEL_STYLE}
          cursor={RECHARTS_TOOLTIP_CURSOR_FILL}
          formatter={(value: number, _name: string, item: { payload?: { result?: string } }) => [
            `${formatCostUsd(value)} · ${item?.payload?.result ?? "—"}`,
            "Cost",
          ]}
          labelFormatter={(_label: string, payload: Array<{ payload?: { fullLabel?: string } }>) =>
            payload?.[0]?.payload?.fullLabel ?? ""
          }
        />
        <Bar
          dataKey="cost"
          fill="var(--color-primary)"
          fillOpacity={0.65}
          radius={[3, 3, 0, 0]}
          maxBarSize={40}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Executions table (shared by Overview + History) ─────────────────────────

export function ExecutionsTable({ executions }: { executions: AgentExecution[] }) {
  if (executions.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No executions yet.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/50 text-xs font-medium text-muted-foreground">
            <th className="px-3 py-2.5">Started</th>
            <th className="px-3 py-2.5">Result</th>
            <th className="px-3 py-2.5">Trigger</th>
            <th className="px-3 py-2.5 text-right">Cost</th>
            <th className="px-3 py-2.5">Summary</th>
          </tr>
        </thead>
        <tbody>
          {executions.map((e) => (
            <tr
              key={e.id}
              className="border-b border-border/60 transition-colors last:border-0 hover:bg-muted/30"
            >
              <td className="whitespace-nowrap px-3 py-2.5 text-xs tabular-nums text-muted-foreground">
                {e.started_at ? new Date(e.started_at).toLocaleString() : "—"}
              </td>
              <td className="px-3 py-2.5">
                <Badge variant={resultBadgeVariant(e.result)}>{e.result ?? "running"}</Badge>
              </td>
              <td className="px-3 py-2.5 text-xs text-muted-foreground">{e.trigger ?? "—"}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{formatCostUsd(e.cost_usd)}</td>
              <td className="max-w-md px-3 py-2.5 text-xs text-muted-foreground">
                <span className="line-clamp-2">{e.error_message ?? e.output_summary ?? "—"}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Delete dialog (user Agents) ─────────────────────────────────────────────

function DeleteAgentDialog({
  open,
  onOpenChange,
  agentName,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentName: string;
  pending: boolean;
  error: string | null;
  onConfirm: (keepHistory: boolean) => void;
}) {
  const [keepHistory, setKeepHistory] = useState(true);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {agentName}?</DialogTitle>
          <DialogDescription>
            Stops the Agent and removes it from the schedule.
          </DialogDescription>
        </DialogHeader>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={keepHistory}
            onChange={(e) => setKeepHistory(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">Keep history</span>
            <span className="block text-xs text-muted-foreground">
              Disable the Agent but retain its definition file and execution history. Uncheck to
              permanently delete the file and all executions.
            </span>
          </span>
        </label>
        {error && <Alert variant="error">{error}</Alert>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => onConfirm(keepHistory)} disabled={pending}>
            {pending ? "Working…" : keepHistory ? "Disable" : "Delete permanently"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
