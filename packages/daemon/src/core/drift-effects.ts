import type Database from "better-sqlite3";
import {
  formatSqliteDatetime,
  localDateStr,
  type IntegrationKey,
  type SnapshotActorHint,
} from "@aitne/shared";
import { createLogger } from "../logging.js";
import type {
  ReconcileDiff,
  ReconcileRequest,
} from "../services/integrations/reconcile.js";
import {
  CALENDAR_HORIZON_MS,
  shouldTriggerRefreshForCalendarEvent,
  type TriggerRoadmapRefresh,
} from "./roadmap-refresh-triggers.js";
import {
  deleteRuntimeState,
  readRuntimeState,
  writeRuntimeState,
} from "../db/runtime-state.js";
import { notifyObservationSummarizer } from "../db/observations.js";
import type { TodayWriteLockManager } from "./today-write-lock.js";

const logger = createLogger("drift-effects");

const TODAY_REFRESH_AUTO_AT_KEY = "today_refresh_auto_at";
const TODAY_REFRESH_PENDING_KEY = "today_refresh_pending";
const TODAY_REFRESH_DEDUP_MS = 5 * 60 * 1000;
const TODAY_REFRESH_DELAY_MS = 30 * 1000;

type ObservationChangeType = "created" | "modified" | "deleted";
type CalendarDriftChange = {
  itemId: string;
  changeType: ObservationChangeType;
  actor: SnapshotActorHint;
  payload: unknown;
  itemStart: string | null;
  priorPayload?: unknown;
};

/**
 * Generic per-diff change row for the gmail / notion paths. They share the
 * same observation-write + coalesce contract; calendar gets its own type
 * because it additionally carries `itemStart` and `priorPayload` for the
 * roadmap-refresh + sliding-window predicates.
 */
type GenericDriftChange = {
  itemId: string;
  changeType: ObservationChangeType;
  actor: SnapshotActorHint;
  payload: unknown;
};

export interface DriftSideEffects {
  observationsWritten: number;
  scheduleApproachingEmitted: string[];
  roadmapRefreshTriggered: boolean;
  todayRefreshScheduled: boolean;
  todayRefreshPending: boolean;
}

export interface DriftEffectsDeps {
  db: Database.Database;
  calendarId?: string;
  timezone?: string;
  now?: () => Date;
  todayWriteLock?: TodayWriteLockManager;
  triggerRoadmapRefresh?: TriggerRoadmapRefresh;
}

interface PendingTodayRefresh {
  reason: string;
  requestedAt: string;
  integration: IntegrationKey;
  windowKey: string;
}

const EMPTY_EFFECTS: DriftSideEffects = {
  observationsWritten: 0,
  scheduleApproachingEmitted: [],
  roadmapRefreshTriggered: false,
  todayRefreshScheduled: false,
  todayRefreshPending: false,
};

export function emptyDriftSideEffects(): DriftSideEffects {
  return { ...EMPTY_EFFECTS, scheduleApproachingEmitted: [] };
}

export function applyDriftEffects(
  req: ReconcileRequest,
  diff: ReconcileDiff,
  deps: DriftEffectsDeps,
): DriftSideEffects {
  if (diff.isInitialSnapshot) return emptyDriftSideEffects();

  switch (req.integration) {
    case "google_calendar":
      return applyCalendarDriftEffects(req, diff, deps);
    case "gmail":
      return applyGmailDriftEffects(diff, deps);
    case "notion":
      return applyNotionDriftEffects(diff, deps);
    /* c8 ignore start — defensive against a future IntegrationKey
     *   landing before its drift handler is wired in `applyDriftEffects`. */
    default:
      return emptyDriftSideEffects();
    /* c8 ignore stop */
  }
}

function applyCalendarDriftEffects(
  req: ReconcileRequest,
  diff: ReconcileDiff,
  deps: DriftEffectsDeps,
): DriftSideEffects {
  const effects = emptyDriftSideEffects();
  const source = `calendar:${deps.calendarId ?? "primary"}`;
  const changes = calendarChangesFromDiff(diff);

  for (const change of changes) {
    effects.observationsWritten += recordCoalescedObservation(deps.db, {
      source,
      ref: change.itemId,
      changeType: change.changeType,
      actor: change.actor,
      payload: change.payload,
    });

    if (shouldTriggerRoadmapRefreshForCalendarChange(change, deps.now?.())) {
      effects.roadmapRefreshTriggered = true;
      try {
        deps.triggerRoadmapRefresh?.("calendar_event_detected");
      } catch (err) {
        logger.warn({ err }, "triggerRoadmapRefresh threw during drift effects");
      }
    }
  }

  const todayRefresh = maybeScheduleTodayRefresh(req, changes, deps);
  effects.todayRefreshScheduled = todayRefresh.scheduled;
  effects.todayRefreshPending = todayRefresh.pending;
  return effects;
}

/**
 * Gmail drift → `mail:lifecycle` observations (matches MailPoller's existing
 * source so consumers of the `observations` skill don't need a special-case
 * for delegated mode). `ref` is the threadId — drift granularity is thread-
 * level (§15.4); a new message landing in an existing thread surfaces as a
 * `modified` diff and gets coalesced onto the same `(source, ref)`.
 *
 * Roadmap refresh and today_refresh both stay calendar-only — Gmail drift
 * doesn't have the time-bound semantics either depends on. Plan §7.1 floats
 * "maybe today_refresh if mail mentions today's User Tasks" as a future
 * extension; that requires NLP and is explicitly out of Phase 5 scope.
 */
function applyGmailDriftEffects(
  diff: ReconcileDiff,
  deps: DriftEffectsDeps,
): DriftSideEffects {
  const effects = emptyDriftSideEffects();
  const source = "mail:lifecycle";
  for (const change of genericChangesFromDiff(diff)) {
    effects.observationsWritten += recordCoalescedObservation(deps.db, {
      source,
      ref: change.itemId,
      changeType: change.changeType,
      actor: change.actor,
      payload: change.payload,
    });
  }
  return effects;
}

/**
 * Notion drift → `notion:<parentDatabaseId>` observations when the page is
 * database-rooted (matches NotionPoller's source key, so multi-database
 * filtering downstream works cross-mode), or `notion:lifecycle` when the
 * page is workspace- or page-rooted (the poller never produces such rows
 * because it iterates by database, but the delegated worker can surface
 * them). `ref` is the pageId.
 */
function applyNotionDriftEffects(
  diff: ReconcileDiff,
  deps: DriftEffectsDeps,
): DriftSideEffects {
  const effects = emptyDriftSideEffects();
  for (const change of genericChangesFromDiff(diff)) {
    const source = notionObservationSource(change.payload);
    effects.observationsWritten += recordCoalescedObservation(deps.db, {
      source,
      ref: change.itemId,
      changeType: change.changeType,
      actor: change.actor,
      payload: change.payload,
    });
  }
  return effects;
}

function notionObservationSource(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const parent = (payload as { parentDatabase?: unknown }).parentDatabase;
    if (typeof parent === "string" && parent.length > 0) {
      return `notion:${parent}`;
    }
  }
  return "notion:lifecycle";
}

function genericChangesFromDiff(diff: ReconcileDiff): GenericDriftChange[] {
  return [
    ...diff.created.map((item): GenericDriftChange => ({
      itemId: item.itemId,
      changeType: "created",
      actor: item.actor,
      payload: item.payload,
    })),
    ...diff.modified.map((item): GenericDriftChange => ({
      itemId: item.itemId,
      changeType: "modified",
      actor: item.actor,
      payload: item.current.payload,
    })),
    ...diff.deleted.map((item): GenericDriftChange => ({
      itemId: item.itemId,
      changeType: "deleted",
      actor: item.actor,
      payload: item.payload,
    })),
  ];
}

function calendarChangesFromDiff(diff: ReconcileDiff): CalendarDriftChange[] {
  return [
    ...diff.created.map((item): CalendarDriftChange => ({
      itemId: item.itemId,
      changeType: "created",
      actor: item.actor,
      payload: item.payload,
      itemStart: item.itemStart ?? null,
    })),
    ...diff.modified.map((item): CalendarDriftChange => ({
      itemId: item.itemId,
      changeType: "modified",
      actor: item.actor,
      payload: item.current.payload,
      itemStart: item.itemStart,
      priorPayload: item.prior.payload,
    })),
    ...diff.deleted.map((item): CalendarDriftChange => ({
      itemId: item.itemId,
      changeType: "deleted",
      actor: item.actor,
      payload: item.payload,
      itemStart: item.itemStart,
    })),
  ];
}

function shouldTriggerRoadmapRefreshForCalendarChange(
  change: CalendarDriftChange,
  now: Date = new Date(),
): boolean {
  if (change.changeType === "created") {
    return shouldTriggerRefreshForCalendarEvent({
      startIso: change.itemStart,
      actor: change.actor,
      changeType: "created",
      now: now.getTime(),
    });
  }
  if (change.changeType !== "modified") return false;
  if (change.actor === "agent") return false;

  const currentStart = change.itemStart ?? extractPayloadStart(change.payload);
  if (!isBeyondCalendarHorizon(currentStart, now)) return false;
  const priorStart = extractPayloadStart(change.priorPayload);
  return !isBeyondCalendarHorizon(priorStart, now);
}

function extractPayloadStart(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const start = (payload as { start?: unknown }).start;
  return typeof start === "string" && start.length > 0 ? start : null;
}

function isBeyondCalendarHorizon(
  startIso: string | null | undefined,
  now: Date,
): boolean {
  if (!startIso) return false;
  const startMs = Date.parse(startIso);
  if (!Number.isFinite(startMs)) return false;
  return startMs - now.getTime() > CALENDAR_HORIZON_MS;
}

function mergeActor(
  prior: SnapshotActorHint,
  next: SnapshotActorHint,
): SnapshotActorHint {
  if (prior === "user" || next === "user") return "user";
  if (next === "unknown") return prior;
  return next;
}

function recordCoalescedObservation(
  db: Database.Database,
  params: {
    source: string;
    ref: string;
    changeType: ObservationChangeType;
    actor: SnapshotActorHint;
    payload: unknown;
  },
): number {
  const payload = JSON.stringify(params.payload);
  const existing = db
    .prepare(
      `SELECT id, change_type AS changeType, actor
       FROM observations
       WHERE source = ? AND ref = ? AND consumed_at IS NULL
       LIMIT 1`,
    )
    .get(params.source, params.ref) as
    | { id: number; changeType: ObservationChangeType; actor: SnapshotActorHint }
    | undefined;

  if (!existing) {
    const inserted = db.prepare(
      `INSERT INTO observations
         (source, ref, change_type, actor, observed_at, payload)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
       RETURNING id`,
    ).get(
      params.source,
      params.ref,
      params.changeType,
      params.actor,
      payload,
    ) as { id: number } | undefined;
    // Wake the summarizer worker so the new row gets summary_text /
    // novelty_score populated. Without this, coalesced inserts only get
    // summarized via the daemon-startup reclaim sweep — a row that lands
    // mid-run sits at `summary_status='pending'` forever and the
    // activity_scan skill is forced into the legacy fetch-on-doubt path.
    if (inserted) notifyObservationSummarizer(inserted.id);
    return 1;
  }

  const actor = mergeActor(existing.actor, params.actor);
  const prior = existing.changeType;
  const next = params.changeType;

  if (prior === "created" && next === "deleted") {
    db.prepare("DELETE FROM observations WHERE id = ?").run(existing.id);
    return 0;
  }

  let coalesced: ObservationChangeType = next;
  if (prior === "created" && next === "modified") {
    coalesced = "created";
  } else if (prior === "modified" && next === "modified") {
    coalesced = "modified";
  } else if (prior === "modified" && next === "deleted") {
    coalesced = "deleted";
  } else if (prior === "deleted" && next === "created") {
    coalesced = "modified";
  } else if (prior === "deleted" && next === "modified") {
    logger.warn(
      { source: params.source, ref: params.ref },
      "deleted observation followed by modified drift; treating as modified",
    );
    coalesced = "modified";
  }

  // Re-coalesce overwrites the stored payload, so the previously-computed
  // summary describes obsolete content. Reset the summarizer-owned columns
  // to mirror `recordObservation`'s UPSERT on payload change — without
  // this, `summary_text` / `novelty_score` linger from the prior payload
  // and the activity_scan skill consumes a stale summary as if it were
  // current (`summary_status='done'` with `summaryStale=false`).
  db.prepare(
    `UPDATE observations
     SET change_type = ?,
         actor = ?,
         observed_at = CURRENT_TIMESTAMP,
         payload = ?,
         summary_text = NULL,
         novelty_score = NULL,
         summary_at = NULL,
         summary_backend = NULL,
         summary_status = 'pending'
     WHERE id = ?`,
  ).run(coalesced, actor, payload, existing.id);
  notifyObservationSummarizer(existing.id);
  return 1;
}

function maybeScheduleTodayRefresh(
  req: ReconcileRequest,
  changes: CalendarDriftChange[],
  deps: DriftEffectsDeps,
): { scheduled: boolean; pending: boolean } {
  if (req.windowKey !== "primary:24h" && req.windowKey !== "primary:14d") {
    return { scheduled: false, pending: false };
  }

  const now = deps.now?.() ?? new Date();
  const timezone = deps.timezone;
  const today = localDateStr(now, timezone);
  const materialTodayDrift = changes.some((change) =>
    startsOnLocalDate(change.payload, change.itemStart, today, timezone),
  );
  if (!materialTodayDrift) return { scheduled: false, pending: false };

  const lastAt = readLastAutoRefreshAt(deps.db);
  if (lastAt !== null && now.getTime() - lastAt.getTime() < TODAY_REFRESH_DEDUP_MS) {
    return { scheduled: false, pending: false };
  }

  const requestedAt = now.toISOString();
  if (deps.todayWriteLock?.getHolder()) {
    writeRuntimeState(deps.db, TODAY_REFRESH_PENDING_KEY, {
      reason: "calendar_drift_while_morning_lock_held",
      requestedAt,
      integration: req.integration,
      windowKey: req.windowKey,
    } satisfies PendingTodayRefresh);
    return { scheduled: false, pending: true };
  }

  const enqueueResult = enqueueTodayRefresh(deps.db, {
    requestedAt,
    scheduledFor: new Date(now.getTime() + TODAY_REFRESH_DELAY_MS),
    integration: req.integration,
    windowKey: req.windowKey,
    reason: "calendar_drift",
  });
  if (enqueueResult.inserted || enqueueResult.existing) {
    writeRuntimeState(deps.db, TODAY_REFRESH_AUTO_AT_KEY, requestedAt);
  }
  return { scheduled: enqueueResult.inserted, pending: false };
}

function startsOnLocalDate(
  payload: unknown,
  itemStart: string | null,
  localDate: string,
  timezone?: string,
): boolean {
  const start = payload && typeof payload === "object"
    ? (payload as { start?: unknown }).start
    : undefined;
  if (typeof start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(start)) {
    return start === localDate;
  }
  const candidate = typeof start === "string" ? start : itemStart;
  if (!candidate) return false;
  const ms = Date.parse(candidate);
  if (!Number.isFinite(ms)) return false;
  return localDateStr(new Date(ms), timezone) === localDate;
}

function readLastAutoRefreshAt(db: Database.Database): Date | null {
  const raw = readRuntimeState<string | { at?: string }>(
    db,
    TODAY_REFRESH_AUTO_AT_KEY,
  );
  const iso = typeof raw === "string" ? raw : raw?.at;
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function enqueueTodayRefresh(
  db: Database.Database,
  params: {
    requestedAt: string;
    scheduledFor: Date;
    integration: IntegrationKey;
    windowKey: string;
    reason: string;
  },
): { inserted: boolean; existing: boolean } {
  const existing = db
    .prepare(
      `SELECT id
       FROM agent_schedule
       WHERE task_type = 'wake'
         AND status IN ('pending', 'running')
         AND json_extract(task_context, '$.routine') = 'today_refresh'
       LIMIT 1`,
    )
    .get() as { id: number } | undefined;
  if (existing) return { inserted: false, existing: true };

  // correlation_id mirrors morning_routine's queueMorningRoutineWake
  // pattern (scheduler.ts) — a stable per-trigger id lets operators tie
  // the resulting agent_actions row back to the drift POST that scheduled
  // it. Drift can fire from CalendarPoller, the reconcile route, or a
  // post-morning flush; the prefix encodes which.
  const correlationId
    = `drift:${params.integration}:${params.windowKey}:${params.requestedAt}`;
  const driftInstruction =
    "Refresh today.md User Schedule after calendar drift.";
  db.prepare(
    `INSERT INTO agent_schedule
       (scheduled_for, task_type, task_description, task_prompt, task_context, correlation_id, model, status)
     VALUES (?, 'wake', ?, ?, ?, ?, NULL, 'pending')`,
  ).run(
    formatSqliteDatetime(params.scheduledFor),
    // task_description (label) doubles as task_prompt (agent instruction);
    // routing is via task_context.routine = "today_refresh".
    driftInstruction,
    driftInstruction,
    JSON.stringify({
      routine: "today_refresh",
      source: "integration_drift",
      reason: params.reason,
      requestedAt: params.requestedAt,
      integration: params.integration,
      windowKey: params.windowKey,
      importance: "low",
    }),
    correlationId,
  );
  return { inserted: true, existing: false };
}

export function flushPendingTodayRefresh(
  db: Database.Database,
  now: Date = new Date(),
): { scheduled: boolean; hadPending: boolean } {
  const pending = readRuntimeState<PendingTodayRefresh>(
    db,
    TODAY_REFRESH_PENDING_KEY,
  );
  if (!pending) return { scheduled: false, hadPending: false };

  const enqueueResult = enqueueTodayRefresh(db, {
    requestedAt: pending.requestedAt,
    scheduledFor: new Date(now.getTime() + TODAY_REFRESH_DELAY_MS),
    integration: pending.integration,
    windowKey: pending.windowKey,
    reason: pending.reason,
  });
  writeRuntimeState(db, TODAY_REFRESH_AUTO_AT_KEY, now.toISOString());
  deleteRuntimeState(db, TODAY_REFRESH_PENDING_KEY);
  return { scheduled: enqueueResult.inserted, hadPending: true };
}

export const __driftEffectsTestExports = {
  TODAY_REFRESH_AUTO_AT_KEY,
  TODAY_REFRESH_PENDING_KEY,
};
