/**
 * Queue tab (Tasks page) — pure helpers + DTOs for the agent-facing
 * `GET /api/schedule` route (DASHBOARD_AUTOMATION_IA_REDESIGN.md §3/§4).
 *
 * The daemon exposes two list shapes: `/schedule/list` (dashboard route,
 * snake_case `ScheduleRow`, `scheduled_for DESC` — history) and `/schedule`
 * (agent route, camelCase, `pending,running ASC` limit 50 — the true
 * "upcoming" ordering). The Upcoming segment consumes the latter; these
 * helpers keep the mapping and labelling unit-testable without a render
 * harness (dashboard testing convention).
 */

import type { ScheduleRow } from "@/lib/api-types";
import { parseUtcTimestamp } from "@/lib/tasks/view";

/** One row of the agent-facing `GET /api/schedule` response. */
export interface ScheduleQueueItem {
  id: number;
  scheduledFor: string;
  taskType: string;
  description: string;
  prompt: string | null;
  status: string;
  model: string | null;
  tier: string | null;
  backendId: string | null;
  taskContext: Record<string, unknown>;
  createdAt: string;
}

export interface ScheduleQueueResponse {
  items: ScheduleQueueItem[];
}

/**
 * Human labels for the `task_type` enum — the raw tokens (`wake`,
 * `morning_routine`, `agent.task`) are dispatcher vocabulary, not user
 * vocabulary. Full vocabulary per the scheduler's dispatch switch
 * (`core/scheduler.ts`): wake / dm / dm_session / morning_routine /
 * evening_review / custom / agent.task / browser_task / background_task.
 */
const TASK_TYPE_LABELS: Record<string, string> = {
  wake: "Wake-up",
  dm: "DM",
  dm_session: "Scheduled DM",
  morning_routine: "Morning routine",
  evening_review: "Evening review",
  custom: "One-off",
  "agent.task": "Agent run",
  browser_task: "Browser task",
  background_task: "Background task",
};

export function humanizeTaskType(taskType: string): string {
  const known = TASK_TYPE_LABELS[taskType];
  if (known) return known;
  // Forward-compat: snake_case / dotted → "Sentence case" rather than a raw token.
  const words = taskType.replace(/[._]/g, " ").trim();
  return words.length > 0 ? words[0].toUpperCase() + words.slice(1) : taskType;
}

/**
 * Queue filter chips — user-vocabulary categories over the raw `task_type`
 * tokens, aligned with the Board's kind labels (reminders vs routines vs
 * scheduled-DM instances vs agent runs vs background/browser work). Filtering
 * is client-side in BOTH segments so a category can span several raw types
 * (the server's `type` param matches a single token only).
 */
export const QUEUE_FILTERS = [
  { value: "all", label: "All types" },
  { value: "reminders", label: "Reminders" },
  { value: "routines", label: "Routines" },
  { value: "dms", label: "Scheduled DMs" },
  { value: "agents", label: "Agent runs" },
  { value: "work", label: "Background & browser" },
] as const;

export type QueueFilterValue = (typeof QUEUE_FILTERS)[number]["value"];

const FILTER_TYPES: Record<Exclude<QueueFilterValue, "all">, readonly string[]> = {
  // Self-scheduled one-off wake-ups / DMs / custom prompts — the board's
  // "Reminders" kind.
  reminders: ["wake", "dm", "custom"],
  routines: ["morning_routine", "evening_review"],
  dms: ["dm_session"],
  agents: ["agent.task"],
  work: ["background_task", "browser_task"],
};

export function matchesQueueFilter(taskType: string, filter: QueueFilterValue): boolean {
  if (filter === "all") return true;
  return FILTER_TYPES[filter].includes(taskType);
}

/**
 * Adapt an agent-route queue item to the snake_case `ScheduleRow` the shared
 * `ScheduleDetailSheet` (and its PATCH/DELETE flows) consumes. `taskContext`
 * arrives parsed; the sheet expects the stored JSON string (it re-parses),
 * so serialize — `null` when empty keeps the sheet's "no context" branch.
 */
export function queueItemToScheduleRow(item: ScheduleQueueItem): ScheduleRow {
  const hasContext =
    item.taskContext && Object.keys(item.taskContext).length > 0;
  return {
    id: item.id,
    scheduled_for: item.scheduledFor,
    task_type: item.taskType,
    task_description: item.description,
    task_prompt: item.prompt,
    model: item.model,
    status: item.status,
    task_context: hasContext ? JSON.stringify(item.taskContext) : null,
    created_at: item.createdAt,
  };
}

/**
 * Count failed runs inside the trailing window from the first (DESC) page of
 * `GET /schedule/list?status=failed`. The page is newest-first, so rows
 * within the window are a prefix — a single pass is exact up to the page
 * size (50); beyond that the strip shows the capped figure.
 */
export function countRecentFailures(
  rows: readonly Pick<ScheduleRow, "status" | "scheduled_for">[],
  opts: { now?: Date; windowHours?: number } = {},
): number {
  const now = opts.now ?? new Date();
  const windowMs = (opts.windowHours ?? 24) * 3_600_000;
  const cutoff = now.getTime() - windowMs;
  let count = 0;
  for (const row of rows) {
    if (row.status !== "failed") continue;
    const at = parseUtcTimestamp(row.scheduled_for);
    if (at && at.getTime() >= cutoff && at.getTime() <= now.getTime()) count++;
  }
  return count;
}
