"use client";

import { Button } from "@/components/ui/button";
import { Card, CardStatLabel } from "@/components/ui/card";
import { cn, formatCurrency, formatUptime } from "@/lib/utils";
import type { HealthResponse } from "@/lib/api-types";

export interface RunNowFeedback {
  tone: "success" | "warning" | "error";
  message: string;
}

interface StatusBarProps {
  health: HealthResponse | undefined;
  /** Hero label — relative ("in 23 minutes") or "Disabled". */
  nextCheckLabel: string;
  /** Absolute time of the next check, shown in the sub-line. */
  nextCheckAtLabel?: string | null;
  nextCheckActive: boolean;
  scheduledNextLabel?: string | null;
  onRunNow: () => void;
  runNowRunning: boolean;
  runNowFeedback: RunNowFeedback | null;
}

const FEEDBACK_TONE_CLASS: Record<RunNowFeedback["tone"], string> = {
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
};

function Segment({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 p-5">
      <CardStatLabel>{label}</CardStatLabel>
      {children}
    </div>
  );
}

/**
 * Single status strip at the top of the Overview — replaces the previous
 * pair of stat cards. Three segments: agent state, next activity scan
 * (with the manual trigger), and today's spend. Everything that needs
 * deeper inspection links out from the cards below instead of being
 * duplicated here.
 */
export function StatusBar({
  health,
  nextCheckLabel,
  nextCheckAtLabel,
  nextCheckActive,
  scheduledNextLabel,
  onRunNow,
  runNowRunning,
  runNowFeedback,
}: StatusBarProps) {
  const healthy = health?.status === "ok";

  return (
    <Card className="grid divide-y divide-border p-0 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
      <Segment label="Agent">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-block h-2.5 w-2.5 rounded-full",
              healthy ? "bg-success" : "bg-destructive",
              healthy && "animate-pulse",
            )}
          />
          <span className="font-display text-xl font-semibold tracking-tight text-foreground">
            {health ? (healthy ? "Operational" : "Attention needed") : "—"}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {health
            ? `Up ${formatUptime(health.uptime)} · ${health.activeSessions} active session${health.activeSessions !== 1 ? "s" : ""}`
            : "Waiting for daemon…"}
        </p>
      </Segment>

      <Segment label="Next check">
        <p className="font-display text-xl font-semibold tracking-tight text-foreground">
          {nextCheckLabel}
        </p>
        <p className="text-xs text-muted-foreground">
          {nextCheckAtLabel ? `${nextCheckAtLabel} · ` : ""}
          {nextCheckActive ? "Inside active window" : "Outside active window"}
          {scheduledNextLabel ? ` · next scheduled ${scheduledNextLabel}` : ""}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2.5 text-xs"
            onClick={onRunNow}
            disabled={runNowRunning}
            aria-busy={runNowRunning}
          >
            {runNowRunning ? "Running…" : "Run now"}
          </Button>
          {/* Persistent live region (matches the TipsCard aria-live pattern):
              conditionally mounting a role="status" node can be missed by
              screen readers — the region must exist before content lands. */}
          <p
            role="status"
            className={cn("text-xs", runNowFeedback && FEEDBACK_TONE_CLASS[runNowFeedback.tone])}
          >
            {runNowFeedback?.message}
          </p>
        </div>
      </Segment>

      <Segment label="Today">
        {/* No tabular-nums: Fraunces ships no `tnum` feature (see CardValue). */}
        <p className="font-display text-xl font-semibold tracking-tight text-foreground">
          {health ? formatCurrency(health.todayCostUsd) : "—"}
        </p>
        <p className="text-xs text-muted-foreground">
          {health?.todaySessions ?? 0} session{(health?.todaySessions ?? 0) !== 1 ? "s" : ""} so far today
        </p>
      </Segment>
    </Card>
  );
}
