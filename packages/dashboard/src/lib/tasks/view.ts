/**
 * Unified Task Board — pure view helpers for the `/tasks` page.
 *
 * Kept out of the page component so the grouping/labelling is unit-tested
 * without a render harness (dashboard convention — see use-agents.ts docstring).
 */

import type { TaskBoardItem, TaskKind, TaskOrigin } from "./types.js";

/** Display order of the kind groups on the board. */
export const KIND_ORDER: readonly TaskKind[] = [
  "dm",
  "agent",
  "app_fetch",
  "reminder",
  "background",
  "browser",
  "research",
] as const;

const KIND_LABELS: Record<TaskKind, string> = {
  dm: "Recurring DMs",
  agent: "Agents",
  app_fetch: "App fetch",
  reminder: "Reminders",
  background: "Background tasks",
  browser: "Browser tasks",
  research: "Research",
};

const ORIGIN_LABELS: Record<TaskOrigin, string> = {
  system: "System",
  user: "You",
  agent: "Agent",
};

export function kindLabel(kind: TaskKind): string {
  return KIND_LABELS[kind];
}

export function originLabel(origin: TaskOrigin): string {
  return ORIGIN_LABELS[origin];
}

export interface TaskKindGroup {
  kind: TaskKind;
  label: string;
  items: TaskBoardItem[];
}

/**
 * Group the flat inventory by kind in {@link KIND_ORDER}, preserving the
 * server's within-kind ordering and dropping empty groups. Unknown kinds (a
 * forward-compat safeguard) are appended after the known ones, alphabetically.
 */
export function groupTasksByKind(items: readonly TaskBoardItem[]): TaskKindGroup[] {
  const buckets = new Map<TaskKind, TaskBoardItem[]>();
  for (const item of items) {
    const bucket = buckets.get(item.kind);
    if (bucket) bucket.push(item);
    else buckets.set(item.kind, [item]);
  }

  const groups: TaskKindGroup[] = [];
  for (const kind of KIND_ORDER) {
    const bucket = buckets.get(kind);
    if (bucket && bucket.length > 0) {
      groups.push({ kind, label: kindLabel(kind), items: bucket });
      buckets.delete(kind);
    }
  }
  // Any kind not in KIND_ORDER (shouldn't happen) — surface it rather than hide it.
  for (const kind of [...buckets.keys()].sort()) {
    groups.push({ kind, label: kind, items: buckets.get(kind) as TaskBoardItem[] });
  }
  return groups;
}
