"use client";

import { useState } from "react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { EventRow } from "@/components/logs/event-row";
import { EventDetailSheet } from "@/components/logs/event-detail-sheet";
import { formatCurrency, formatTokenCount, cn } from "@/lib/utils";
import {
  computeProcessShares,
  computeCacheHitRate,
  computeAutonomousShare,
  computeAvgCostPerRun,
  formatShare,
} from "./today-drivers.logic";
import type { EventRow as EventRowType, TodayBreakdown } from "@/lib/api-types";

interface TodayDriversProps {
  breakdown: TodayBreakdown;
  todayCostUsd: number;
  todaySessions: number;
}

/**
 * "Today's Spend Drivers" — answers the question the Today summary card
 * raises: *what* is costing money right now. A ranked per-run table (top
 * costed runs, reusing the activity log's EventRow + detail sheet) next to
 * a per-process share panel and the day's efficiency stats. All numbers
 * share the Today card's agent-day bounds, so they reconcile.
 */
export function TodayDrivers({ breakdown, todayCostUsd, todaySessions }: TodayDriversProps) {
  const [selectedEvent, setSelectedEvent] = useState<EventRowType | null>(null);

  const processShares = computeProcessShares(breakdown.byEventType, todayCostUsd);
  const cacheHitRate = computeCacheHitRate(breakdown.tokens);
  const autonomousShare = computeAutonomousShare(breakdown.byTrigger);
  const avgCostPerRun = computeAvgCostPerRun(todayCostUsd, todaySessions);

  return (
    <div className="grid gap-6 lg:grid-cols-[2fr,1fr]">
      <Card>
        <CardHeader>
          <CardTitle>Most Expensive Runs Today</CardTitle>
        </CardHeader>
        <p className="-mt-2 mb-3 text-xs text-muted-foreground">
          The most expensive runs this agent day (top 15 shown — the panel on
          the right covers aggregate share). Click a row for the full detail.
        </p>
        {breakdown.topActions.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No spend recorded today yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-left" aria-label="Most expensive runs today">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Time</th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Type</th>
                  <th className="hidden xl:table-cell px-3 py-2 text-xs font-medium text-muted-foreground">Trigger</th>
                  <th className="hidden lg:table-cell px-3 py-2 text-xs font-medium text-muted-foreground">Model</th>
                  <th className="hidden xl:table-cell px-3 py-2 text-xs font-medium text-muted-foreground">In / Out</th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Cost</th>
                  <th className="hidden lg:table-cell px-3 py-2 text-xs font-medium text-muted-foreground">Duration</th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Result</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.topActions.map((event) => (
                  <EventRow
                    key={event.id}
                    event={event}
                    onClick={() => setSelectedEvent(event)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <EventDetailSheet event={selectedEvent} onClose={() => setSelectedEvent(null)} />
      </Card>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>By Process Today</CardTitle>
          </CardHeader>
          {processShares.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No spend recorded today yet.
            </p>
          ) : (
            <div className="space-y-3">
              {processShares.map((share) => (
                <div key={share.eventType}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-mono text-xs text-foreground">
                      {share.eventType}
                    </span>
                    <span className="shrink-0 text-xs font-semibold tabular-nums text-foreground">
                      {formatCurrency(share.totalCost)}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${share.pct}%` }}
                    />
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {share.pct.toFixed(0)}% of today · {share.sessionCount}{" "}
                    {share.sessionCount === 1 ? "run" : "runs"} · avg{" "}
                    {formatCurrency(share.avgCost)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Today at a Glance</CardTitle>
          </CardHeader>
          <dl className="space-y-3">
            <GlanceStat
              label="Cache hit rate"
              value={formatShare(cacheHitRate)}
              hint="Cache-read share of all input-side tokens. Cache reads bill at a fraction of fresh input — a falling rate makes the same workload cost more."
            />
            <GlanceStat
              label="Autonomous spend share"
              value={formatShare(autonomousShare)}
              hint="Share of today's cost from background runs (routines, scans, scheduled tasks) rather than your own messages."
            />
            <GlanceStat
              label="Failed-run spend"
              value={formatCurrency(breakdown.failed.costUsd)}
              valueClassName={breakdown.failed.costUsd > 0 ? "text-destructive" : undefined}
              hint="Money spent on runs that ended in failure — paid for but produced no result."
              sub={
                breakdown.failed.sessions > 0
                  ? `${breakdown.failed.sessions} failed ${breakdown.failed.sessions === 1 ? "run" : "runs"}`
                  : undefined
              }
            />
            <GlanceStat
              label="Avg cost per run"
              value={avgCostPerRun != null ? formatCurrency(avgCostPerRun) : "—"}
              hint="Today's total divided by the number of costed runs."
            />
            <GlanceStat
              label="Tokens today"
              value={`${formatTokenCount(
                breakdown.tokens.input + breakdown.tokens.cacheCreation + breakdown.tokens.cacheRead,
              )} in / ${formatTokenCount(breakdown.tokens.output)} out`}
              hint="Total input-side tokens (fresh + cache write + cache read) and output tokens across today's costed runs."
            />
          </dl>
        </Card>
      </div>
    </div>
  );
}

function GlanceStat({
  label,
  value,
  hint,
  sub,
  valueClassName,
}: {
  label: string;
  value: string;
  hint: string;
  sub?: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-xs text-muted-foreground">
        <Tooltip>
          <TooltipTrigger className="cursor-default underline decoration-dotted underline-offset-2">
            {label}
          </TooltipTrigger>
          <TooltipContent className="max-w-64">{hint}</TooltipContent>
        </Tooltip>
      </dt>
      <dd className="text-right">
        <span className={cn("text-sm font-semibold tabular-nums text-foreground", valueClassName)}>
          {value}
        </span>
        {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
      </dd>
    </div>
  );
}
