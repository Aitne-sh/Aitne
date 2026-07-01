/**
 * Canonical status → badge-variant vocabulary for the dashboard.
 *
 * Previously each surface (schedule queue, browser tasks, git
 * re-template runs, notification log, reading list) carried its own
 * copy of this map — browser-tasks/state-badge.tsx even documented
 * that it "mirrors the schedule page's STATUS_COLORS". One table keeps
 * the color language consistent everywhere: blue = queued, amber = in
 * flight, green = done, red = failed, gray = inert, orange / pink =
 * parked on the user.
 *
 * Domain vocabularies with conflicting semantics (e.g. connection
 * cards' `configured` = amber vs integration-status' `configured` =
 * gray) intentionally stay local — only add a status here when its
 * color reads the same on every surface.
 */
export type StatusBadgeVariant =
  | "blue"
  | "amber"
  | "green"
  | "red"
  | "gray"
  | "orange"
  | "pink";

export const STATUS_BADGE_VARIANTS: Record<string, StatusBadgeVariant> = {
  // Enablement lifecycle (Task board: agents / recurring DMs). active = on and
  // healthy, paused = intentionally inert, invalid = broken definition.
  active: "green",
  paused: "gray",
  invalid: "red",
  // Run lifecycle (schedule queue, browser tasks, git re-template runs)
  pending: "blue",
  started: "blue",
  running: "amber",
  completed: "green",
  failed: "red",
  timeout: "red",
  skipped: "gray",
  cancelled: "gray",
  abandoned: "gray",
  rolled_back: "amber",
  // Browser-task parked states — the rows the user must act on
  awaiting_user: "orange",
  final_confirm: "pink",
  // Notification delivery
  delivered: "green",
  batched: "blue",
  suppressed: "gray",
  // Reading list
  reading: "blue",
};

export function statusBadgeVariant(status: string): StatusBadgeVariant {
  return STATUS_BADGE_VARIANTS[status] ?? "gray";
}
