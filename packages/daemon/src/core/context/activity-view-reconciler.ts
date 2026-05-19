import { normalizeAppLabel } from "@aitne/shared";

/**
 * Activity-view reconciler — pure render + snapshot helpers for
 * `<contextDir>/_activity/<source>.md`
 * (docs/design/21-management-registry-and-entities.md §7.2 / §9.6).
 *
 * Inputs:
 *   - L1 — active managed-task rows (one source = one rendered file).
 *   - L2 — entity rows joined via `entity_source_keys` to the source.
 *   - L4 — `agent_actions` history (`management_task.*`) for the
 *     "Recently changed" section.
 *
 * Output is a chronological per-source view; the LLM's query path
 * (§7.5) reads `_activity/<source>.md` for the date, then follows the
 * link into the entity file. The activity file is short on details
 * (entity title + per-entity source metadata + a managed-task tag) so
 * the prompt-injection budget stays modest even with hundreds of
 * entries (§NFR-5: ≤2 s rebuild for a 90-day window).
 *
 * Determinism contract: same snapshot + same `last_built` → byte-
 * identical render. The driver layer compares the rendered output to
 * the on-disk file and skips the write on noop.
 */

const EM_DASH = "—";

/**
 * Window for the "Recently changed" + per-day sections. The §7.6 spec
 * fixes this at 90 days; bump only with a schema_version bump because
 * the rendered frontmatter `window_days` is what consumers (the query
 * skill) read.
 */
export const ACTIVITY_VIEW_WINDOW_DAYS = 90;

// ── Snapshot model ─────────────────────────────────────────────────────────

/**
 * One active managed-task row pinned to the source (§9.6 "Active
 * managed tasks" section). The render only needs the bits the user
 * sees in the file; the upstream driver query in
 * `activity-view-runner.ts` joins `managed_tasks.app_normalized` to
 * the source label and selects only these columns.
 */
export interface ActiveManagedTaskInput {
  mtId: string;
  cadence: string;
  /** ISO-8601 — `null` until the first successful run. */
  lastRunAt: string | null;
  /** Free text — `null` when never run, or em-dash when caller passes it. */
  lastResult: string | null;
}

/**
 * Audit row from `agent_actions WHERE action_type LIKE 'management_task.%'
 * AND date(started_at) >= now-90d`. The §9.6 example renders these as
 * `<date> mt_<n> stopped by user`; the renderer formats per
 * `action_type`.
 */
export interface RecentlyChangedInput {
  /** ISO date (YYYY-MM-DD). */
  date: string;
  mtId: string | null;
  actionType: string;
  /** Optional human-readable detail, e.g. the prior cadence on a modify. */
  note: string | null;
}

/**
 * Per-entity row pinned to the source (the §9.6 chronological
 * section). The renderer expects rows pre-sorted by `date` descending
 * so the most-recent days appear at the top of each `## YYYY-MM-DD`.
 *
 * `mtId` is the managed task that fetched / refreshed the entity, when
 * one is known. The runner derives this by walking the entity's
 * `sources.<source>.fetched_by` field (when the skill recorded one);
 * unknowns render as em-dash.
 */
export interface EntityActivityInput {
  /** ISO date — primary sort key. */
  date: string;
  /** Optional time range like "14:00–15:00"; rendered when present. */
  timeRange: string | null;
  title: string;
  /** Forward-slashed relative path from the activity file's dir. */
  entityRelativePath: string;
  /** Free-form per-entity descriptors — rendered comma-separated. */
  details: string[];
  /** Managed-task id that fetched this entity, if known. */
  mtId: string | null;
  /** When the fetch happened, if known (ISO datetime). */
  fetchedAt: string | null;
}

export interface ActivitySnapshot {
  /** User-typed app label (the `App` column). */
  source: string;
  /** Lower-cased dedup form, used as the file slug + frontmatter key. */
  sourceNormalized: string;
  activeTasks: ActiveManagedTaskInput[];
  recentlyChanged: RecentlyChangedInput[];
  entities: EntityActivityInput[];
}

// ── Source helpers ────────────────────────────────────────────────────────

/**
 * Map a user-typed source label to the activity-file slug. Two visually-
 * different inputs that map to the same normalised form share one
 * activity file (the same dedup behaviour as `managed_tasks.app_normalized`).
 *
 * The slug is sanitised so it makes a valid filename: spaces collapse
 * to `-`, characters outside `[a-z0-9-]` are stripped. An empty result
 * after sanitising returns `null` so the runner can skip the file.
 */
export function activityFileSlugFor(source: string): string | null {
  const normalised = normalizeAppLabel(source);
  const slug = normalised
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.length > 0 ? slug : null;
}

/**
 * Relative path under `<contextDir>` for the activity file. Matches
 * the §9.6 layout `_activity/<source>.md`. The leading underscore is
 * the convention for auto-generated views (same as `_index.md`).
 */
export function relativeActivityPath(slug: string): string {
  return `_activity/${slug}.md`;
}

// ── Render ────────────────────────────────────────────────────────────────

/**
 * Render the full §9.6 file body. `lastBuilt` populates the frontmatter
 * `last_built:` field (ISO-8601). `windowDays` is constant in v3 (= 90).
 */
export function renderActivityView(
  snapshot: ActivitySnapshot,
  lastBuilt: string,
): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push("type: activity-log");
  lines.push(`source: ${snapshot.sourceNormalized}`);
  lines.push("auto_generated: true");
  lines.push(`window_days: ${ACTIVITY_VIEW_WINDOW_DAYS}`);
  lines.push(`last_built: ${lastBuilt}`);
  lines.push("---");
  lines.push(`# ${capitalize(snapshot.source)} — Activity (last ${ACTIVITY_VIEW_WINDOW_DAYS} days)`);
  lines.push("");
  lines.push("## Active managed tasks");
  lines.push("");
  if (snapshot.activeTasks.length === 0) {
    lines.push("_No active managed tasks for this source._");
  } else {
    for (const task of snapshot.activeTasks) {
      lines.push(`- ${formatActiveTask(task)}`);
    }
  }
  lines.push("");
  lines.push(`## Recently changed (${ACTIVITY_VIEW_WINDOW_DAYS}d)`);
  lines.push("");
  if (snapshot.recentlyChanged.length === 0) {
    lines.push("_No recent changes._");
  } else {
    for (const row of snapshot.recentlyChanged) {
      lines.push(`- ${formatRecentlyChanged(row)}`);
    }
  }
  lines.push("");
  if (snapshot.entities.length === 0) {
    lines.push("## Entries");
    lines.push("");
    lines.push("_No entries yet — the next scheduled run will populate this section._");
  } else {
    appendEntityDays(lines, snapshot.entities);
  }
  lines.push("");
  return lines.join("\n");
}

function appendEntityDays(
  lines: string[],
  entities: readonly EntityActivityInput[],
): void {
  // Group by date; entities are pre-sorted by date desc so we can rely
  // on the input ordering inside each day.
  const days = new Map<string, EntityActivityInput[]>();
  const order: string[] = [];
  for (const entity of entities) {
    if (!days.has(entity.date)) {
      days.set(entity.date, []);
      order.push(entity.date);
    }
    const bucket = days.get(entity.date);
    /* c8 ignore start — `days.has(entity.date)` is true at this point
       (we just set it above), so the lookup never returns undefined.
       Defensive guard for the type narrowing only. */
    if (!bucket) continue;
    /* c8 ignore stop */
    bucket.push(entity);
  }
  for (const date of order) {
    lines.push(`## ${date}`);
    lines.push("");
    const bucket = days.get(date);
    /* c8 ignore start — `order` is built from `days.set` keys above; the
       lookup is guaranteed to succeed. Defensive only. */
    if (!bucket) continue;
    /* c8 ignore stop */
    for (const entity of bucket) {
      lines.push(`- ${formatEntity(entity)}`);
    }
    lines.push("");
  }
}

function formatActiveTask(task: ActiveManagedTaskInput): string {
  const last = task.lastRunAt
    ? `last ${task.lastRunAt} ${task.lastResult ?? "ok"}`
    : "never run";
  return `${task.mtId} ${task.cadence} — ${last}`;
}

const ACTION_VERBS: Record<string, string> = {
  "management_task.created": "registered",
  "management_task.modified": "modified",
  "management_task.deleted": "stopped by user",
  "management_task.app_renamed": "app renamed",
  "management_task.run_now": "run on demand",
};

function formatRecentlyChanged(row: RecentlyChangedInput): string {
  const verb = ACTION_VERBS[row.actionType] ?? row.actionType;
  const id = row.mtId ?? EM_DASH;
  const note = row.note ? ` (${row.note})` : "";
  return `${row.date} ${id} ${verb}${note}`;
}

function formatEntity(entity: EntityActivityInput): string {
  const head = entity.timeRange ? `${entity.timeRange} ` : "";
  // The activity file lives at `_activity/<slug>.md`; entity files
  // live at `<domain>/<type-plural>/<slug>.md`. From the activity
  // file's perspective an entity at `work/meetings/foo.md` is at
  // `../work/meetings/foo.md`.
  const link = `../${entity.entityRelativePath}`;
  const title = `[${escapeMd(entity.title)}](${link})`;
  const tail = formatEntityTail(entity);
  return `${head}${title}${tail}`;
}

function formatEntityTail(entity: EntityActivityInput): string {
  const parts: string[] = [];
  if (entity.details.length > 0) {
    parts.push(entity.details.map(escapeMd).join(" · "));
  }
  if (entity.mtId) {
    const stamp = entity.fetchedAt ? ` @ ${entity.fetchedAt}` : "";
    parts.push(`fetched by ${entity.mtId}${stamp}`);
  }
  if (parts.length === 0) return "";
  return `\n  ${parts.join(" · ")}`;
}

function escapeMd(value: string): string {
  // Caller paths only ever pass non-empty strings. The trim()/replace
  // pair preserves single-line content; multi-whitespace inputs are
  // exercised by the renderer tests via the entity-detail formatting.
  return value.replace(/\s+/g, " ").trim();
}

function capitalize(value: string): string {
  // Caller paths always pass a non-empty source label because
  // `activityFileSlugFor` returns null for empty input and the runner
  // skips the render in that case.
  /* c8 ignore next */
  if (value.length === 0) return value;
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

// ── Snapshot bucketing (helper for the runner) ────────────────────────────

/**
 * Sort entity-activity rows in render order: date descending, then
 * `timeRange` ascending so within a day the earliest event renders
 * first. `null` time ranges sort after any string time so they appear
 * at the end of their day's bucket.
 */
export function sortEntityActivityRows(
  rows: readonly EntityActivityInput[],
): EntityActivityInput[] {
  return [...rows].sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    // Null `timeRange` always sorts after any string time. Using a
    // sentinel character is brittle: "10:00–11:00" embeds the en-dash
    // (U+2013, codepoint 8211), which compares ABOVE both `~` (U+007E)
    // and `￿` under `localeCompare` for some Unicode collations.
    // An explicit null check is cheaper and free of locale surprises.
    if (a.timeRange === null && b.timeRange === null) {
      return a.title.localeCompare(b.title);
    }
    if (a.timeRange === null) return 1;
    if (b.timeRange === null) return -1;
    if (a.timeRange !== b.timeRange) {
      return a.timeRange.localeCompare(b.timeRange);
    }
    return a.title.localeCompare(b.title);
  });
}

/**
 * Sort recently-changed rows: date descending, then mt_id ascending so
 * a single day's entries are grouped consistently.
 */
export function sortRecentlyChangedRows(
  rows: readonly RecentlyChangedInput[],
): RecentlyChangedInput[] {
  return [...rows].sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    const aId = a.mtId === null ? "" : a.mtId;
    const bId = b.mtId === null ? "" : b.mtId;
    return aId.localeCompare(bId);
  });
}

// ── Entry-point helper for the runner ────────────────────────────────────

/**
 * Compute the windowed cutoff (`now - windowDays`) as ISO-`YYYY-MM-DD`.
 * Used by the runner's SQL queries. Pure so tests can pin the cutoff
 * deterministically.
 */
export function windowCutoffDate(now: Date, windowDays: number): string {
  const cutoff = new Date(now.getTime() - windowDays * 86400_000);
  return cutoff.toISOString().slice(0, 10);
}
