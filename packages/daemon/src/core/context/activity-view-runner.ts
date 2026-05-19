import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { writeRuntimeState, getDegradedMode } from "../../db/runtime-state.js";
import type { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import { writeFileAtomically } from "../atomic-write.js";
import type { PromptContextChangedCallback } from "../context-staleness.js";
import { recordActivityViewRebuildDuration } from "../management-telemetry.js";
import { createLogger } from "../../logging.js";
import {
  enumerateActivitySources,
  type ActivitySourceRef,
} from "./activity-sources.js";
import type {
  ReconcilerRunRecord,
  ReconcilerTrigger,
} from "./reconciler-runner.js";
import {
  ACTIVITY_VIEW_WINDOW_DAYS,
  activityFileSlugFor,
  relativeActivityPath,
  renderActivityView,
  sortEntityActivityRows,
  sortRecentlyChangedRows,
  windowCutoffDate,
  type ActiveManagedTaskInput,
  type ActivitySnapshot,
  type EntityActivityInput,
  type RecentlyChangedInput,
} from "./activity-view-reconciler.js";

const logger = createLogger("activity-view-reconciler");

/** Runtime-state key for the activity-view reconciler's last run record. */
export const ACTIVITY_VIEW_RECONCILER_LAST_RUN_KEY =
  "reconciler.activity_view.last_run";

const ACTIVITY_DIR = "_activity";

let runnerMutex: Promise<void> = Promise.resolve();

export interface RunActivityViewReconcilerOptions {
  db: Database.Database;
  contextDir: string;
  writeTracker?: AgentWriteTracker;
  onPromptContextChanged?: PromptContextChangedCallback;
  timezone?: string;
  trigger: ReconcilerTrigger;
  /** Injectable clock for deterministic test output. */
  now?: () => Date;
}

/**
 * Drive one pass of the activity-view reconciler:
 *
 *   1. Early-exit when degraded mode is active.
 *   2. Enumerate the active source set:
 *        ∪ `managed_tasks.app_normalized`
 *        ∪ `entity_source_keys.source_key` (within window)
 *        ∪ `agent_actions.detail->>app_normalized` (within window).
 *   3. For each source, build the §9.6 snapshot and render the file.
 *   4. Compare to on-disk content; skip on no-op.
 *   5. Atomic write + write-tracker mark + snapshot prior contents.
 *   6. Garbage-collect activity files for sources that no longer
 *      appear in the active set (the §9.6 file would otherwise stay
 *      stale forever after a stop+rename cycle).
 *
 * Slot mapping in `ReconcilerRunRecord`:
 *   - `added`           → number of files written
 *   - `removed`         → number of stale files deleted
 *   - `refreshedMtime`  → number of files that already matched on disk
 */
export async function runActivityViewReconciler(
  opts: RunActivityViewReconcilerOptions,
): Promise<ReconcilerRunRecord> {
  const prev = runnerMutex;
  let releaseMutex!: () => void;
  runnerMutex = new Promise<void>((resolve) => {
    releaseMutex = resolve;
  });
  try {
    await prev;
    return await runOnce(opts);
  } finally {
    releaseMutex();
  }
}

async function runOnce(
  opts: RunActivityViewReconcilerOptions,
): Promise<ReconcilerRunRecord> {
  const now = opts.now ? opts.now() : new Date();
  const lastBuilt = now.toISOString();
  const cutoff = windowCutoffDate(now, ACTIVITY_VIEW_WINDOW_DAYS);
  const recordBase = {
    at: now.toISOString(),
    trigger: opts.trigger,
    added: 0,
    removed: 0,
    refreshedMtime: 0,
  };

  const degraded = getDegradedMode(opts.db);
  if (degraded) {
    const record: ReconcilerRunRecord = {
      ...recordBase,
      result: "noop",
      error: `degraded_mode:${degraded.reason}`,
    };
    persistRunRecord(opts.db, record);
    return record;
  }

  try {
    const sources = enumerateActivitySources(opts.db, cutoff);
    let written = 0;
    let unchanged = 0;
    const writtenSlugs = new Set<string>();

    for (const source of sources) {
      const slug = activityFileSlugFor(source.label);
      if (!slug) continue;
      // De-dup slug collisions (two different labels with the same
      // normalised form): the first source wins, the rest skip.
      if (writtenSlugs.has(slug)) continue;

      // §14.3 `aitne_activity_view_rebuild_seconds{source}` — measure
      // the full per-source loop (snapshot build + render + write or
      // unchanged-skip). The metric is recorded for both the rendered
      // and the byte-identical-skip path so the histogram reflects the
      // reconciler's actual wall-clock cost across active sources, not
      // just the slow paths.
      const sourceStartedAt = Date.now();
      const snapshot = buildActivitySnapshot(opts.db, source, cutoff);
      const body = renderActivityView(snapshot, lastBuilt);
      const relativePath = relativeActivityPath(slug);
      const absolutePath = join(opts.contextDir, relativePath);
      const previous = readIfExists(absolutePath);
      // Compare the body excluding the `last_built:` line so two
      // wall-clock-different runs with identical data don't churn the
      // file. Without this, every cron / fs-event chain rewrites every
      // activity file, bloating `md_file_snapshots` and firing
      // `onPromptContextChanged` for nothing.
      if (
        previous !== null &&
        stripLastBuilt(previous) === stripLastBuilt(body)
      ) {
        unchanged += 1;
        writtenSlugs.add(slug);
        recordActivityViewRebuildDuration(
          source.label,
          Date.now() - sourceStartedAt,
        );
        continue;
      }
      writeWithSnapshot(opts, absolutePath, relativePath, body, previous);
      opts.onPromptContextChanged?.(
        relativePath,
        "activity_view_reconciler",
        "quiet",
        { tierReason: "derived_activity_view" },
      );
      written += 1;
      writtenSlugs.add(slug);
      recordActivityViewRebuildDuration(
        source.label,
        Date.now() - sourceStartedAt,
      );
    }

    const removed = pruneStaleActivityFiles(opts, writtenSlugs);

    const record: ReconcilerRunRecord = {
      ...recordBase,
      result: written === 0 && removed === 0 ? "noop" : "applied",
      error: null,
      added: written,
      removed,
      refreshedMtime: unchanged,
    };
    persistRunRecord(opts.db, record);
    if (written > 0 || removed > 0) {
      logger.info(
        { trigger: opts.trigger, written, unchanged, removed },
        "Activity-view reconciler applied",
      );
    }
    return record;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const record: ReconcilerRunRecord = {
      ...recordBase,
      result: "error",
      error: message.slice(0, 200),
    };
    persistRunRecord(opts.db, record);
    logger.error(
      { err, trigger: opts.trigger },
      "Activity-view reconciler run failed",
    );
    return record;
  }
}

/**
 * Build the §9.6 snapshot for one source. Three queries:
 *
 *   1. Active managed tasks for the source.
 *   2. Recent `management_task.*` audit rows (for "Recently changed").
 *   3. Entities joined via `entity_source_keys` (for the per-day
 *      sections), windowed to the same 90-day cutoff.
 *
 * Source enumeration lives in `activity-sources.ts` so the dashboard's
 * `GET /api/activity-sources` endpoint shares the same union (followups
 * doc Issue 3).
 */
function buildActivitySnapshot(
  db: Database.Database,
  source: ActivitySourceRef,
  cutoffDate: string,
): ActivitySnapshot {
  const activeTasks = db
    .prepare(
      `SELECT id AS mtId, cadence, last_run_at AS lastRunAt, last_result AS lastResult
         FROM managed_tasks
        WHERE app_normalized = ?
        ORDER BY CAST(SUBSTR(id, 4) AS INTEGER) ASC`,
    )
    .all(source.normalized) as ActiveManagedTaskInput[];

  interface AuditRow {
    started_at: string;
    action_type: string;
    detail: string | null;
  }
  // Same OR shape as `enumerateActiveSources`: a rename event must
  // surface in BOTH the OLD and the NEW activity file. The rename row's
  // top-level `app_normalized` is the new label; `old_app_normalized` is
  // the old. Either may equal `source.normalized`, depending on which
  // file we're rendering.
  const auditRows = db
    .prepare(
      `SELECT started_at, action_type, detail
         FROM agent_actions
        WHERE action_type LIKE 'management_task.%'
          AND date(started_at) >= ?
          AND (
            json_extract(detail, '$.app_normalized')     = ?
            OR (
              action_type = 'management_task.app_renamed'
              AND json_extract(detail, '$.old_app_normalized') = ?
            )
          )
        ORDER BY started_at DESC`,
    )
    .all(cutoffDate, source.normalized, source.normalized) as AuditRow[];

  const recentlyChanged: RecentlyChangedInput[] = [];
  for (const row of auditRows) {
    let detail: Record<string, unknown> | null = null;
    if (row.detail) {
      try {
        const parsed = JSON.parse(row.detail);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          detail = parsed as Record<string, unknown>;
        }
      } catch {
        detail = null;
      }
    }
    const mtId = typeof detail?.mt_id === "string" ? detail.mt_id : null;
    recentlyChanged.push({
      date: row.started_at.slice(0, 10),
      mtId,
      actionType: row.action_type,
      note: extractAuditNote(row.action_type, detail),
    });
  }

  interface EntityRow {
    path: string;
    title: string;
    date: string | null;
    lastSyncedAt: string | null;
    sourcesJson: string;
  }
  // Match on `source_key_normalized` so all casing variants of the same
  // user-typed key (`Zoom` / `zoom` / `ZOOM`) collapse onto the same
  // bucket. The pre-normalised column is indexed (idx_entity_source_keys_
  // normalized) so this is a single seek + sort.
  //
  // `DISTINCT` collapses entities whose frontmatter declares more than
  // one casing of the same source (a single file with both
  // `sources.Zoom` and `sources.ZOOM` produces two sidecar rows because
  // the PK is `(path, source_key)` verbatim). Without DISTINCT the JOIN
  // would surface that entity twice in the rendered activity view.
  const entityRows = db
    .prepare(
      `SELECT DISTINCT e.path, e.title, e.date,
              e.last_synced_at AS lastSyncedAt, e.sources_json AS sourcesJson
         FROM entities e
         JOIN entity_source_keys k ON k.path = e.path
        WHERE k.source_key_normalized = ?
          AND COALESCE(e.date, e.last_synced_at, '0000-00-00') >= ?
        ORDER BY e.path ASC`,
    )
    .all(source.normalized, cutoffDate) as EntityRow[];

  const entities: EntityActivityInput[] = entityRows.map((row) => {
    const date = row.date ?? (row.lastSyncedAt ? row.lastSyncedAt.slice(0, 10) : "");
    const entry = readSourceEntry(row.sourcesJson, source.label, source.normalized);
    return {
      date,
      timeRange: typeof entry?.time_range === "string" ? entry.time_range : null,
      title: row.title,
      entityRelativePath: row.path,
      details: extractEntityDetails(entry),
      mtId: typeof entry?.fetched_by === "string" ? entry.fetched_by : null,
      fetchedAt: typeof entry?.fetched_at === "string" ? entry.fetched_at : null,
    };
  });

  return {
    source: source.label,
    sourceNormalized: source.normalized,
    activeTasks,
    recentlyChanged: sortRecentlyChangedRows(recentlyChanged),
    entities: sortEntityActivityRows(entities),
  };
}

function extractAuditNote(
  actionType: string,
  detail: Record<string, unknown> | null,
): string | null {
  if (!detail) return null;
  if (actionType === "management_task.modified") {
    // The route emits `from` / `to` as nested objects keyed by the
    // structured columns (intent / cadence / output_path), not the
    // flat `old_*`/`new_*` shape an earlier draft of this function
    // assumed. Read from the nested form so the reconciler's note
    // matches what landed in agent_actions.
    const fromObj = isRecord(detail.from) ? detail.from : null;
    const toObj = isRecord(detail.to) ? detail.to : null;
    if (fromObj && toObj) {
      const oldCadence =
        typeof fromObj.cadence === "string" ? fromObj.cadence : null;
      const newCadence =
        typeof toObj.cadence === "string" ? toObj.cadence : null;
      if (oldCadence && newCadence && oldCadence !== newCadence) {
        return `${oldCadence} → ${newCadence}`;
      }
    }
  }
  if (actionType === "management_task.app_renamed") {
    // The route emits the rename pair as `from` / `to` (string app
    // labels) — same key shape the integration tests pin. The note
    // surfaces both labels so the activity-view reader sees the full
    // transition.
    const oldApp = typeof detail.from === "string" ? detail.from : null;
    const newApp = typeof detail.to === "string" ? detail.to : null;
    if (oldApp && newApp) return `${oldApp} → ${newApp}`;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readSourceEntry(
  sourcesJson: string,
  primaryKey: string,
  fallbackKey: string,
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourcesJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const map = parsed as Record<string, unknown>;
  // Try the verbatim user label first, then the lower-cased dedup form,
  // then a case-insensitive scan so a third casing variant (`ZOOM`)
  // still resolves the per-source entry. Matches the §7.6 sidecar's
  // `source_key_normalized` join semantics.
  let candidate = map[primaryKey] ?? map[fallbackKey];
  if (candidate === undefined) {
    const target = fallbackKey.toLowerCase();
    for (const [key, value] of Object.entries(map)) {
      if (key.toLowerCase() === target) {
        candidate = value;
        break;
      }
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  return candidate as Record<string, unknown>;
}

function extractEntityDetails(
  entry: Record<string, unknown> | null,
): string[] {
  if (!entry) return [];
  const out: string[] = [];
  if (typeof entry.duration === "string") out.push(`duration ${entry.duration}`);
  if (typeof entry.recording === "string") out.push(`recording ${entry.recording}`);
  if (typeof entry.external_id === "string") out.push(`id ${entry.external_id}`);
  return out;
}

function pruneStaleActivityFiles(
  opts: RunActivityViewReconcilerOptions,
  knownSlugs: ReadonlySet<string>,
): number {
  const dirAbs = join(opts.contextDir, ACTIVITY_DIR);
  if (!existsSync(dirAbs)) return 0;
  let entries: string[];
  try {
    entries = readdirSync(dirAbs);
  } catch (err) {
    logger.warn({ err, dirAbs }, "Could not list activity-view dir");
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    if (name.startsWith("_")) continue;
    const slug = name.slice(0, -3);
    if (knownSlugs.has(slug)) continue;
    const absolutePath = join(dirAbs, name);
    const previous = readIfExists(absolutePath);
    try {
      unlinkSync(absolutePath);
      if (previous !== null) {
        try {
          opts.db
            .prepare(
              "INSERT INTO md_file_snapshots (file_path, content, trigger, session_id) VALUES (?, ?, ?, ?)",
            )
            .run(
              `${ACTIVITY_DIR}/${name}`,
              previous,
              "activity_view_reconciled_prune",
              null,
            );
        } catch (err) {
          logger.warn(
            { err, file: name },
            "Failed to snapshot activity file before pruning",
          );
        }
      }
      opts.onPromptContextChanged?.(
        `${ACTIVITY_DIR}/${name}`,
        "activity_view_reconciler_prune",
        "quiet",
        { tierReason: "derived_activity_view_prune" },
      );
      removed += 1;
    } catch (err) {
      logger.warn({ err, file: name }, "Failed to prune stale activity file");
    }
  }
  return removed;
}

/**
 * Replace the `last_built: <iso>` line with a stable sentinel so two
 * renders with identical data but different wall-clocks compare equal.
 * The renderer's other output is byte-deterministic for a given
 * snapshot, so this is the only varying line.
 */
function stripLastBuilt(content: string): string {
  return content.replace(/^last_built: .*$/m, "last_built: <stable>");
}

function readIfExists(absolutePath: string): string | null {
  if (!existsSync(absolutePath)) return null;
  try {
    return readFileSync(absolutePath, "utf-8");
  } catch (err) {
    logger.warn({ err, file: absolutePath }, "Reconciler could not read file");
    return null;
  }
}

function writeWithSnapshot(
  opts: RunActivityViewReconcilerOptions,
  absolutePath: string,
  relativePath: string,
  content: string,
  previousContent: string | null,
): void {
  if (previousContent !== null) {
    try {
      opts.db
        .prepare(
          "INSERT INTO md_file_snapshots (file_path, content, trigger, session_id) VALUES (?, ?, ?, ?)",
        )
        .run(relativePath, previousContent, "activity_view_reconciled", null);
    } catch (err) {
      logger.warn(
        { err, file: relativePath },
        "Failed to snapshot prior content before activity-view write",
      );
    }
  }
  // Mark before the rename so FS-watch consumers attribute the resulting
  // event to the agent. Roll back on failure (C2).
  opts.writeTracker?.markWriting(absolutePath, content);
  try {
    writeFileAtomically(absolutePath, content);
  } catch (writeErr) {
    opts.writeTracker?.unmark(absolutePath);
    throw writeErr;
  }
}

function persistRunRecord(
  db: Database.Database,
  record: ReconcilerRunRecord,
): void {
  try {
    writeRuntimeState(db, ACTIVITY_VIEW_RECONCILER_LAST_RUN_KEY, record);
  } catch (err) {
    logger.warn(
      { err, record },
      "Activity-view reconciler run record persistence failed",
    );
  }
}
