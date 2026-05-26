import { normalizeAppLabel, type ManagedTask } from "@aitne/shared";

/**
 * Activity / Entities sidebar source-list helper.
 *
 * Two consumers exist:
 *
 *   - `extractSources(tasks)` — active-only, rolled up from
 *     `useManagedTasks()`. Used by the Settings → Management page where
 *     edits are scoped to live rows only.
 *   - `mergeActivitySources(active, activitySources)` — union with
 *     recently-stopped sources from `GET /api/activity-sources` (the
 *     daemon's `enumerateActivitySources` mirror). Used by the
 *     Memory → Activity tab so a stopped task's `state/activity/<source>.md`
 *     stays reachable for its 90-day post-stop window (followups doc
 *     Issue 3).
 *
 * The label kept on each entry is the user-typed `App` value from the
 * first task that hit the bucket — the rest are folded in via `count`.
 * Sort is `localeCompare` on the label so the visual order matches what
 * the user typed, not the lower-cased dedup key.
 */
export interface SourceEntry {
  /** §7.6 dedup key — `LOWER(task.app)` via `normalizeAppLabel`. */
  normalized: string;
  /** First user-typed `App` value seen for this bucket. Display only. */
  label: string;
  /** Number of tasks rolled into this bucket (for the sidebar badge). */
  count: number;
  /**
   * Whether the source is currently editable through Settings →
   * Management (`active`) or only reachable via its activity file
   * (`stopped` — a recently-stopped task whose entity / audit history
   * still falls inside the 90-day window).
   */
  status: "active" | "stopped";
}

export function extractSources(
  tasks: ManagedTask[] | undefined,
): SourceEntry[] {
  if (!tasks) return [];
  const map = new Map<string, SourceEntry>();
  for (const task of tasks) {
    const normalized = normalizeAppLabel(task.app);
    const existing = map.get(normalized);
    if (existing) {
      existing.count += 1;
    } else {
      map.set(normalized, {
        normalized,
        label: task.app,
        count: 1,
        status: "active",
      });
    }
  }
  return Array.from(map.values()).sort((a, b) =>
    a.label.localeCompare(b.label),
  );
}

/**
 * Daemon `/api/activity-sources` payload. Mirrors
 * `core/context/activity-sources.ts:ActivitySourceRef` exactly.
 */
export interface ActivitySourceRef {
  label: string;
  normalized: string;
  status: "active" | "stopped";
}

/**
 * Merge the active-only managed-task sidebar with the daemon's
 * activity-source union. The active list wins the `count` (we don't
 * want to surface entity-only counts as "tasks"). Stopped entries
 * come back with `count: 0` and `status: "stopped"` so the sidebar
 * can render a quieter visual treatment.
 */
export function mergeActivitySources(
  active: SourceEntry[],
  activitySources: ActivitySourceRef[] | undefined,
): SourceEntry[] {
  if (!activitySources || activitySources.length === 0) return active;
  const byNormalized = new Map<string, SourceEntry>();
  for (const entry of active) {
    byNormalized.set(entry.normalized, entry);
  }
  for (const remote of activitySources) {
    if (byNormalized.has(remote.normalized)) continue;
    byNormalized.set(remote.normalized, {
      normalized: remote.normalized,
      label: remote.label,
      count: 0,
      status: remote.status,
    });
  }
  return Array.from(byNormalized.values()).sort((a, b) =>
    a.label.localeCompare(b.label),
  );
}
