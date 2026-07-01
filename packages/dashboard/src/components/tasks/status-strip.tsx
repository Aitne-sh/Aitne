"use client";

import { useEffect, useState } from "react";
import { AlarmClock, AlertTriangle, ArrowUpRight, CircleCheck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn, parseUtcDate } from "@/lib/utils";
import { formatTaskTime } from "@/lib/tasks/view";

/**
 * Tasks status strip (DASHBOARD_AUTOMATION_IA_REDESIGN.md §3) — one
 * console-style card answering "what's next / what's running / what's on /
 * what broke" at a glance. Hairline cell separation via the gap-px trick so
 * the grid stays clean at any wrap point.
 */
export interface StatusStripProps {
  /** Next pending queue row, or null when nothing is queued / still loading. */
  nextUp: { description: string; scheduledFor: string } | null;
  running: number;
  activeRecurring: number;
  /** Failed runs in the last 24h; null while the query is in flight. */
  failed24h: number | null;
  /** Jump to Queue → History → Failed. */
  onShowFailures: () => void;
}

function formatCountdown(diffMs: number): string {
  if (diffMs <= 0) return "Now";
  const h = Math.floor(diffMs / 3_600_000);
  const m = Math.floor((diffMs % 3_600_000) / 60_000);
  const s = Math.floor((diffMs % 60_000) / 1_000);
  if (h > 24) {
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}

function useCountdown(scheduledFor: string | undefined): string {
  const [countdown, setCountdown] = useState("");
  useEffect(() => {
    if (!scheduledFor) return;
    const update = () =>
      setCountdown(formatCountdown(parseUtcDate(scheduledFor).getTime() - Date.now()));
    update();
    const id = setInterval(update, 1_000);
    return () => clearInterval(id);
  }, [scheduledFor]);
  return scheduledFor ? countdown : "";
}

function StatLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
      {children}
    </span>
  );
}

function StatValue({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("font-display text-3xl font-semibold tracking-tight text-foreground", className)}>
      {children}
    </div>
  );
}

export function StatusStrip({
  nextUp,
  running,
  activeRecurring,
  failed24h,
  onShowFailures,
}: StatusStripProps) {
  const countdown = useCountdown(nextUp?.scheduledFor);
  const hasFailures = (failed24h ?? 0) > 0;

  return (
    <Card className="overflow-hidden p-0">
      <div className="grid grid-cols-2 gap-px bg-border/60 lg:grid-cols-[minmax(0,2fr)_1fr_1fr_1fr]">
        {/* Next up */}
        <div className="col-span-2 flex flex-col gap-1 bg-card p-4 lg:col-span-1">
          <div className="flex items-center justify-between">
            <StatLabel>Next up</StatLabel>
            <AlarmClock className="h-3.5 w-3.5 text-primary" aria-hidden />
          </div>
          {nextUp ? (
            <>
              <StatValue>{countdown || "…"}</StatValue>
              <p className="truncate text-sm text-foreground" title={nextUp.description}>
                {nextUp.description}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatTaskTime(nextUp.scheduledFor)?.absolute}
              </p>
            </>
          ) : (
            <>
              <StatValue className="text-muted-foreground">—</StatValue>
              <p className="text-sm text-muted-foreground">Nothing queued</p>
            </>
          )}
        </div>

        {/* Running now */}
        <div className="flex flex-col gap-1 bg-card p-4">
          <StatLabel>Running</StatLabel>
          <StatValue className={running === 0 ? "text-muted-foreground" : undefined}>
            <span className="inline-flex items-center gap-2">
              {running}
              {running > 0 && (
                <span
                  className="h-2 w-2 animate-pulse rounded-full bg-success"
                  aria-label="work in flight"
                />
              )}
            </span>
          </StatValue>
          <p className="text-xs text-muted-foreground">in flight now</p>
        </div>

        {/* Active recurring */}
        <div className="flex flex-col gap-1 bg-card p-4">
          <StatLabel>Recurring</StatLabel>
          <StatValue className={activeRecurring === 0 ? "text-muted-foreground" : undefined}>
            {activeRecurring}
          </StatValue>
          <p className="text-xs text-muted-foreground">standing tasks on</p>
        </div>

        {/* Needs attention */}
        <button
          type="button"
          onClick={onShowFailures}
          disabled={!hasFailures}
          className={cn(
            "group flex flex-col gap-1 bg-card p-4 text-left",
            hasFailures &&
              "cursor-pointer transition-colors hover:bg-destructive/5 focus:outline-none focus-visible:bg-destructive/10",
          )}
          aria-label={
            hasFailures
              ? `${failed24h} failed run(s) in the last 24 hours — view them`
              : "No failed runs in the last 24 hours"
          }
        >
          <div className="flex items-center justify-between">
            <StatLabel>Attention</StatLabel>
            {hasFailures ? (
              <AlertTriangle className="h-3.5 w-3.5 text-destructive" aria-hidden />
            ) : (
              <CircleCheck className="h-3.5 w-3.5 text-success" aria-hidden />
            )}
          </div>
          <StatValue className={hasFailures ? "text-destructive" : "text-muted-foreground"}>
            {failed24h ?? "—"}
          </StatValue>
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            failed · 24h
            {hasFailures && (
              <ArrowUpRight
                className="h-3 w-3 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                aria-hidden
              />
            )}
          </p>
        </button>
      </div>
    </Card>
  );
}
