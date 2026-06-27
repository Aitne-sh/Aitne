import { StatusBadge } from "@/components/shared/status-badge";
import type { BrowserTaskState } from "@/lib/hooks/use-browser-tasks";

/**
 * BROWSER_TASK_REDESIGN_PLAN.md §9a.2 — color-coded state badge.
 * Colors come from the shared `STATUS_BADGE_VARIANTS` vocabulary
 * (lib/status-badge.ts), which also drives the schedule page —
 * `awaiting_user` / `final_confirm` use orange / pink to draw the eye
 * to the parked states the user must act on for forward progress.
 */
const STATE_LABELS: Record<BrowserTaskState, string> = {
  pending: "Pending",
  running: "Running",
  awaiting_user: "Awaiting you",
  final_confirm: "Final confirm",
  completed: "Completed",
  failed: "Failed",
  timeout: "Timeout",
  cancelled: "Cancelled",
  abandoned: "Abandoned",
};

interface Props {
  state: BrowserTaskState;
  className?: string;
}

export function BrowserTaskStateBadge({ state, className }: Props) {
  return (
    <StatusBadge status={state} label={STATE_LABELS[state]} className={className} />
  );
}
