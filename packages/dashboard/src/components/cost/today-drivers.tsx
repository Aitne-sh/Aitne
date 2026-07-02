"use client";

import { useState } from "react";
import { Info } from "lucide-react";
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

        <Card className="overflow-hidden p-0">
          <div className="border-b border-border p-5 py-4">
            <CardTitle>Today at a Glance</CardTitle>
          </div>
          {/* Hairline-tiled stat grid: the `gap-px` over a `bg-border` parent
              draws crisp 1px dividers between `bg-card` tiles, so each figure
              reads as its own scannable cell instead of a cramped list row. */}
          <dl className="grid grid-cols-2 gap-px bg-border">
            <GlanceStat
              label="Cache hit rate"
              value={formatShare(cacheHitRate)}
              hint="Cache-read share of all input-side tokens. Cache reads bill at a fraction of fresh input — a falling rate makes the same workload cost more."
            />
            <GlanceStat
              label="Autonomous share"
              value={formatShare(autonomousShare)}
              hint="Share of today's cost from background runs (routines, scans, scheduled tasks) rather than your own messages."
            />
            <GlanceStat
              label="Avg cost / run"
              value={avgCostPerRun != null ? formatCurrency(avgCostPerRun) : "—"}
              hint="Today's total divided by the number of costed runs."
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
            <TokensStat
              inValue={formatTokenCount(
                breakdown.tokens.input +
                  breakdown.tokens.cacheCreation +
                  breakdown.tokens.cacheRead,
              )}
              outValue={formatTokenCount(breakdown.tokens.output)}
              hint="Total input-side tokens (fresh + cache write + cache read) and output tokens across today's costed runs."
            />
          </dl>
        </Card>
      </div>
    </div>
  );
}

/**
 * Uppercase micro-label carrying the stat's tooltip. A small info glyph is
 * the hover affordance (replacing the old dotted underline, which read as a
 * broken link); the whole label is the trigger so the target stays large.
 */
function StatLabel({ label, hint }: { label: string; hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger className="inline-flex cursor-default items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {label}
        <Info className="h-3 w-3 opacity-50" aria-hidden />
      </TooltipTrigger>
      <TooltipContent className="max-w-64 font-normal normal-case tracking-normal">
        {hint}
      </TooltipContent>
    </Tooltip>
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
    <div className="flex flex-col gap-1.5 bg-card p-4">
      <dt>
        <StatLabel label={label} hint={hint} />
      </dt>
      <dd>
        {/* No tabular-nums: Fraunces (font-display) ships no `tnum` feature —
            see CardValue. Figures render with its proportional digits. */}
        <span
          className={cn(
            "font-display text-2xl font-semibold leading-none tracking-tight text-foreground",
            valueClassName,
          )}
        >
          {value}
        </span>
        {sub && <p className="mt-1.5 text-[11px] text-muted-foreground">{sub}</p>}
      </dd>
    </div>
  );
}

/**
 * Full-width tokens row: input and output are distinct magnitudes, so they
 * get their own figures rather than being crammed into one "X in / Y out"
 * string that overflowed the narrow column.
 */
function TokensStat({
  inValue,
  outValue,
  hint,
}: {
  inValue: string;
  outValue: string;
  hint: string;
}) {
  return (
    <div className="col-span-2 flex items-center justify-between gap-4 bg-card p-4">
      <dt>
        <StatLabel label="Tokens today" hint={hint} />
      </dt>
      <dd className="flex items-baseline gap-5">
        <TokenLeg value={inValue} caption="in" />
        <span className="text-border" aria-hidden>
          /
        </span>
        <TokenLeg value={outValue} caption="out" />
      </dd>
    </div>
  );
}

function TokenLeg({ value, caption }: { value: string; caption: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="font-display text-xl font-semibold tracking-tight text-foreground">
        {value}
      </span>
      <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {caption}
      </span>
    </span>
  );
}
