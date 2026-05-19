"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useHealth } from "@/lib/hooks/use-health";
import { useSetupStatus } from "@/lib/hooks/use-setup-status";
import { useNextCheck } from "@/lib/hooks/use-next-check";
import { useScheduleNext } from "@/lib/hooks/use-schedule-next";
import { HealthCard } from "@/components/overview/health-card";
import { RecentEventsCard } from "@/components/overview/recent-events-card";
import { CalendarPreview } from "@/components/overview/calendar-preview";
import { CostSummaryCard } from "@/components/overview/cost-summary-card";
import { ReadingWidget } from "@/components/overview/reading-widget";
import { InlineApprovals } from "@/components/overview/inline-approvals";
import { NotificationsPanel } from "@/components/overview/notifications-panel";
import { DraftsAwaitingCard } from "@/components/overview/drafts-awaiting-card";
import { YourLife } from "@/components/overview/your-life";
import { TipsCard } from "@/components/overview/tips-card";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { CardSkeleton } from "@/components/shared/query-result";
import { Card, CardHeader, CardStatLabel, CardValue } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { api } from "@/lib/api-client";
import { formatCurrency, formatAbsoluteTime, parseUtcDate } from "@/lib/utils";
import type { EventsResponse } from "@/lib/api-types";
import { useQueryClient } from "@tanstack/react-query";

interface RunNowResponse {
  status: "queued" | "skipped";
  reason?: "morning_routine_active" | "hourly_check_in_progress" | "below_threshold";
}

const RUN_NOW_POLL_INTERVAL_MS = 1_500;
const RUN_NOW_POLL_TIMEOUT_MS = 60_000;

function getRunNowFeedback(result: RunNowResponse): { tone: "success" | "warning"; message: string } {
  if (result.status === "queued") {
    return { tone: "success", message: "Queued successfully." };
  }

  switch (result.reason) {
    case "morning_routine_active":
      return { tone: "warning", message: "Skipped: morning routine is still running." };
    case "hourly_check_in_progress":
      return { tone: "warning", message: "Skipped: a previous hourly check is still running." };
    case "below_threshold":
      return { tone: "warning", message: "Skipped: there were no reviewable pending observations." };
    default:
      return { tone: "warning", message: "Skipped: hourly check was not queued." };
  }
}

function hasCompletedHourlyCheckSince(events: EventsResponse["events"], requestedAtMs: number): boolean {
  const latest = events[0];
  if (!latest) return false;
  const completedAt = latest.completed_at ?? latest.started_at;
  return parseUtcDate(completedAt).getTime() >= requestedAtMs;
}

export default function OverviewPage() {
  const router = useRouter();
  const { data: health, isLoading: healthLoading } = useHealth();
  const { data: setupStatus } = useSetupStatus();
  const { data: nextCheck } = useNextCheck();
  const { data: scheduleNext } = useScheduleNext();
  const queryClient = useQueryClient();
  const [runNowState, setRunNowState] = useState<"idle" | "running">("idle");
  const [runNowFeedback, setRunNowFeedback] = useState<{ tone: "success" | "warning" | "error"; message: string } | null>(null);
  const runNowPollTokenRef = useRef(0);
  const runNowPollTimerRef = useRef<number | null>(null);

  // Auto-redirect to setup wizard if initial setup is needed
  useEffect(() => {
    if (setupStatus?.needsSetup) {
      router.push("/setup");
    }
  }, [setupStatus?.needsSetup, router]);

  const nextCheckLabel = useMemo(() => {
    if (!nextCheck?.nextRunAt) return "Disabled";
    return parseUtcDate(nextCheck.nextRunAt).toLocaleString();
  }, [nextCheck?.nextRunAt]);

  const confirm = useConfirm();

  const stopRunNowPolling = useCallback(() => {
    runNowPollTokenRef.current += 1;
    if (runNowPollTimerRef.current !== null) {
      window.clearTimeout(runNowPollTimerRef.current);
      runNowPollTimerRef.current = null;
    }
  }, []);

  useEffect(() => stopRunNowPolling, [stopRunNowPolling]);

  const refetchOverviewCards = useCallback(async () => {
    await queryClient.refetchQueries({ queryKey: ["next-check"], type: "active" });
  }, [queryClient]);

  const pollRunNowCompletion = useCallback(async (requestedAtMs: number, token: number) => {
    await refetchOverviewCards();

    try {
      const events = await api.get<EventsResponse>("/events", {
        type: "routine.hourly_check",
        days: "1",
        page: 1,
        limit: 1,
      });
      if (token !== runNowPollTokenRef.current) return;
      if (hasCompletedHourlyCheckSince(events.events, requestedAtMs)) {
        return;
      }
    } catch {
      // Keep the polling loop best-effort — summary refresh already ran.
    }

    if (token !== runNowPollTokenRef.current) return;
    if (Date.now() - requestedAtMs >= RUN_NOW_POLL_TIMEOUT_MS) {
      return;
    }

    runNowPollTimerRef.current = window.setTimeout(() => {
      void pollRunNowCompletion(requestedAtMs, token);
    }, RUN_NOW_POLL_INTERVAL_MS);
  }, [refetchOverviewCards]);

  const handleRunNow = async () => {
    const ok = await confirm({
      title: "Trigger hourly check now?",
      description: "This will run the reviewable observation queue immediately instead of waiting for the next scheduled check.",
      confirmLabel: "Run now",
    });
    if (!ok) return;
    stopRunNowPolling();
    setRunNowState("running");
    let dismissMs = 3000;
    try {
      const requestedAtMs = Date.now();
      const result = await api.post<RunNowResponse>("/agent/run-now", { reason: "dashboard" });
      setRunNowFeedback(getRunNowFeedback(result));
      await refetchOverviewCards();
      if (result.status === "queued") {
        runNowPollTokenRef.current += 1;
        const token = runNowPollTokenRef.current;
        void pollRunNowCompletion(requestedAtMs, token);
      }
    } catch {
      setRunNowFeedback({ tone: "error", message: "Failed to queue." });
      dismissMs = 10_000;
    } finally {
      setRunNowState("idle");
      setTimeout(() => setRunNowFeedback(null), dismissMs);
    }
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Overview"
        description={
          <>
            Live snapshot of your agent. The cards below show when the next automatic hourly check will run and today&rsquo;s spend. Everything auto-refreshes. Use <em>Run now</em> to trigger the hourly check immediately when you&rsquo;re impatient.
          </>
        }
      />

      <NotificationsPanel />

      {healthLoading ? (
        <CardSkeleton count={3} />
      ) : (
        <>
          {/* ① Status Strip — Next Check (with manual trigger) + Today's Cost */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardStatLabel>Next Check</CardStatLabel>
              </CardHeader>
              <p className="text-sm font-medium text-foreground">{nextCheckLabel}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {nextCheck?.active ? "Active window" : "Outside active window"}
              </p>
              {scheduleNext?.next && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Wake-up: {formatAbsoluteTime(scheduleNext.next.scheduled_for)}
                </p>
              )}
              <Button
                size="sm"
                variant="outline"
                className="mt-3 w-full"
                onClick={handleRunNow}
                disabled={runNowState === "running"}
              >
                {runNowState === "running" ? "Running..." : "Run hourly check now"}
              </Button>
              {runNowFeedback?.tone === "success" && (
                <p className="mt-1 text-xs text-emerald-600 dark:text-emerald-400">
                  {runNowFeedback.message}
                </p>
              )}
              {runNowFeedback?.tone === "warning" && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  {runNowFeedback.message}
                </p>
              )}
              {runNowFeedback?.tone === "error" && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                  {runNowFeedback.message}
                </p>
              )}
            </Card>

            <Card>
              <CardHeader>
                <CardStatLabel>Today&apos;s Cost</CardStatLabel>
              </CardHeader>
              <CardValue>{health ? formatCurrency(health.todayCostUsd) : "—"}</CardValue>
              <p className="mt-1 text-xs text-muted-foreground">
                {health?.todaySessions ?? 0} session{(health?.todaySessions ?? 0) !== 1 ? "s" : ""}
              </p>
            </Card>
          </div>

          {/* Tips — randomly surface a buried capability per page load */}
          <TipsCard />

          {/* Your Life — Lens cards into MY LIFE pages */}
          <YourLife />

          <div className="grid gap-6 lg:grid-cols-3">
            {/* Left column (2/3) */}
            <div className="space-y-6 lg:col-span-2">
              {/* ② Inline Approvals (conditional — hidden when 0) */}
              <InlineApprovals />

              {/* ③ Recent Activity */}
              <RecentEventsCard />
            </div>

            {/* Right column (1/3) */}
            <div className="space-y-6">
              <HealthCard health={health} />
              <CalendarPreview />
              <DraftsAwaitingCard />
              <ReadingWidget />
              <CostSummaryCard />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
