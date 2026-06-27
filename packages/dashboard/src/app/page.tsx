"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useHealth } from "@/lib/hooks/use-health";
import { useSetupStatus } from "@/lib/hooks/use-setup-status";
import { useNextCheck } from "@/lib/hooks/use-next-check";
import { useScheduleNext } from "@/lib/hooks/use-schedule-next";
import { HealthCard } from "@/components/overview/health-card";
import { RecentEventsCard } from "@/components/overview/recent-events-card";
import { CalendarPreview } from "@/components/overview/calendar-preview";
import { CostSummaryCard } from "@/components/overview/cost-summary-card";
import { InlineApprovals } from "@/components/overview/inline-approvals";
import { NotificationsPanel } from "@/components/overview/notifications-panel";
import { DraftsAwaitingCard } from "@/components/overview/drafts-awaiting-card";
import { StatusBar } from "@/components/overview/status-bar";
import { YourLife } from "@/components/overview/your-life";
import { TipsCard } from "@/components/overview/tips-card";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { CardSkeleton } from "@/components/shared/query-result";
import { PageHeader } from "@/components/ui/page-header";
import { api } from "@/lib/api-client";
import { formatRelativeTime, formatShortDateTime, parseUtcDate } from "@/lib/utils";
import type { EventsResponse } from "@/lib/api-types";
import { useQueryClient } from "@tanstack/react-query";

interface RunNowResponse {
  status: "queued" | "skipped";
  reason?: "morning_routine_active" | "activity_scan_in_progress" | "below_threshold";
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
    case "activity_scan_in_progress":
      return { tone: "warning", message: "Skipped: a previous activity scan is still running." };
    case "below_threshold":
      return { tone: "warning", message: "Skipped: there were no reviewable pending observations." };
    default:
      return { tone: "warning", message: "Skipped: activity scan was not queued." };
  }
}

function hasCompletedActivityScanSince(events: EventsResponse["events"], requestedAtMs: number): boolean {
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

  // Relative hero label ("in 23 minutes") recomputed on every render — the
  // 10s health poll keeps it fresh without a dedicated ticker. Deliberately
  // NOT memoized: nextRunAt stays constant between checks, so a useMemo
  // keyed on it would freeze the relative phrasing.
  const nextCheckLabel = nextCheck?.nextRunAt
    ? formatRelativeTime(nextCheck.nextRunAt)
    : "Disabled";
  const nextCheckAtLabel = nextCheck?.nextRunAt
    ? formatShortDateTime(nextCheck.nextRunAt)
    : null;

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
        type: "routine.activity_scan",
        days: "1",
        page: 1,
        limit: 1,
      });
      if (token !== runNowPollTokenRef.current) return;
      if (hasCompletedActivityScanSince(events.events, requestedAtMs)) {
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
      title: "Trigger activity scan now?",
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
    <div className="mx-auto w-full max-w-7xl space-y-8 p-6">
      <PageHeader
        title="Overview"
        description="Your agent at a glance — current status, today's activity, and anything that needs you."
      />

      {/* ① Needs attention — system warnings + pending approvals.
          Both render nothing when there is nothing to act on. */}
      <NotificationsPanel />
      <InlineApprovals />

      {healthLoading ? (
        <CardSkeleton count={3} />
      ) : (
        <>
          {/* ② Status bar — agent state, next check (manual trigger), today's spend */}
          <StatusBar
            health={health}
            nextCheckLabel={nextCheckLabel}
            nextCheckAtLabel={nextCheckAtLabel}
            nextCheckActive={nextCheck?.active ?? false}
            scheduledNextLabel={
              scheduleNext?.next ? formatShortDateTime(scheduleNext.next.scheduled_for) : null
            }
            onRunNow={handleRunNow}
            runNowRunning={runNowState === "running"}
            runNowFeedback={runNowFeedback}
          />

          {/* ③ Activity (left) + today's context and system detail (right) */}
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
              <RecentEventsCard />
            </div>
            <div className="space-y-6">
              <CalendarPreview />
              <DraftsAwaitingCard />
              <HealthCard health={health} />
              <CostSummaryCard />
            </div>
          </div>

          {/* ④ Your Life shortcuts + one rotating capability hint */}
          <YourLife />
          <TipsCard />
        </>
      )}
    </div>
  );
}
