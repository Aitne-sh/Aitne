import { Badge } from "@/components/ui/badge";
import type { BrowserTaskState } from "@/lib/hooks/use-browser-tasks";

/**
 * BROWSER_TASK_REDESIGN_PLAN.md §9a.2 — color-coded state badge.
 * Mirrors the schedule page's STATUS_COLORS map so the dashboard
 * vocabulary stays internally consistent (pending = blue, running =
 * amber/pulse, completed = green, failed = red, etc.).
 *
 * `awaiting_user` + `final_confirm` use orange / pink to draw the
 * eye to the parked states — these are the rows the user must act
 * on for forward progress.
 */
const STATE_COLORS: Record<
  BrowserTaskState,
  "blue" | "amber" | "green" | "gray" | "red" | "orange" | "pink"
> = {
  pending: "blue",
  running: "amber",
  awaiting_user: "orange",
  final_confirm: "pink",
  completed: "green",
  failed: "red",
  timeout: "red",
  cancelled: "gray",
  abandoned: "gray",
};

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
  const isLive = state === "running";
  return (
    <Badge variant={STATE_COLORS[state]} className={className}>
      {isLive ? (
        <span className="flex items-center gap-1">
          <span
            aria-hidden
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500"
          />
          {STATE_LABELS[state]}
        </span>
      ) : (
        STATE_LABELS[state]
      )}
    </Badge>
  );
}
