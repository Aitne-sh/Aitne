/**
 * Quiet-hours DM deferral — QUIET_HOURS_HARDENING_PLAN.md Phase 1.
 *
 * When an autonomous outbound DM fires inside the quiet-hours window, the
 * message is NOT sent and NOT dropped: it is persisted as a
 * `task_type='dm'` `agent_schedule` row scheduled for the quiet-hours end
 * boundary. That reuses the existing zero-cost pre-composed-DM machinery
 * end to end — full message in `task_description` (no truncation),
 * restart-safe, visible on the `/schedule` dashboard page, delivered by
 * the scheduler's `handleDirectDm` (whose deliberate quiet-hours skip is
 * correct here: the row fires *at* the quiet-hours edge).
 *
 * Pile-up guard: a second deferral from the same origin (same
 * `deferred_from` + agent id / origin session id) appends to the existing
 * pending row (two-blank-line join, the batch-flush convention) instead
 * of inserting a sibling — an hourly Agent firing five times overnight
 * yields one combined DM at the edge, not five.
 *
 * Shared by the `/api/notify` gate (Phase 1) and, later, the
 * NotificationManager `scheduled.task` final-text branch (Phase 1b) —
 * one implementation instead of bespoke `agent_schedule` SQL per caller.
 */
import type Database from "better-sqlite3";
import { formatSqliteDatetime } from "@aitne/shared";
import {
  nextQuietHoursEndMs,
  type QuietHoursWindow,
} from "../core/quiet-hours.js";
import { createLogger } from "../logging.js";

const logger = createLogger("deferred-dm");

export interface DeferDmParams {
  /** Full message body — persisted untruncated in `task_description`. */
  message: string;
  /** Explicit platform targets; omitted → MessageHub default destinations. */
  platforms?: string[] | undefined;
  /** Origin marker for audit + coalescing, e.g. `"api.notify"`. */
  deferredFrom: string;
  /** Session that produced the message, when known. */
  originSessionId?: number | undefined;
  /** Owning user-Agent slug, when resolvable. */
  agentId?: string | null | undefined;
}

export interface DeferredDmResult {
  scheduleId: string;
  /** SQLite-format UTC datetime the row fires at (quiet-hours end). */
  deliverAfter: string;
  /** True when appended to an existing pending deferred row. */
  coalesced: boolean;
}

interface PendingDeferredRow {
  id: number;
  task_description: string;
  task_context: string | null;
  scheduled_for: string;
}

/**
 * Coalescing identity: prefer the Agent slug (stable across an Agent's
 * overnight firings), fall back to the origin session, else an anonymous
 * shared bucket. Unrelated anonymous system DMs deferring into one
 * combined message is intended — that's the pile-up guard, not a bug.
 */
function coalesceKey(
  agentId: string | null | undefined,
  originSessionId: number | null | undefined,
): string {
  if (agentId) return `agent:${agentId}`;
  if (originSessionId !== null && originSessionId !== undefined) {
    return `session:${originSessionId}`;
  }
  return "anonymous";
}

/** Union of explicit platform targets; either side defaulting (null /
 *  undefined = MessageHub default destinations) keeps the default. */
function mergePlatforms(
  existing: unknown,
  incoming: string[] | undefined,
): string[] | null {
  if (!Array.isArray(existing) || incoming === undefined) return null;
  return [...new Set([...(existing as string[]), ...incoming])];
}

/**
 * Gate decision + deferred-row insert. Returns `null` when `now` is NOT
 * inside the quiet-hours window (caller proceeds with the immediate
 * path); otherwise persists the message for the quiet-hours edge and
 * returns the row handle.
 */
export function deferDmToQuietHoursEnd(
  db: Database.Database,
  window: QuietHoursWindow,
  params: DeferDmParams,
  now: Date = new Date(),
): DeferredDmResult | null {
  const quietEndMs = nextQuietHoursEndMs(now, window);
  if (quietEndMs === null) return null;

  const key = coalesceKey(params.agentId, params.originSessionId);
  // `json_valid` guard first: a hand-edited row with broken JSON would
  // otherwise make `json_extract` throw for the whole query. Such a row
  // simply never coalesces; a fresh row carries this message.
  const pending = db
    .prepare(
      `SELECT id, task_description, task_context, scheduled_for
         FROM agent_schedule
        WHERE status = 'pending'
          AND task_type = 'dm'
          AND task_context IS NOT NULL
          AND json_valid(task_context)
          AND json_extract(task_context, '$.deferred_from') = ?
        ORDER BY id ASC`,
    )
    .all(params.deferredFrom) as PendingDeferredRow[];

  for (const row of pending) {
    // json_valid in the WHERE clause guarantees parseability here.
    const ctx = JSON.parse(row.task_context!) as Record<string, unknown>;
    const rowKey = coalesceKey(
      typeof ctx.agent_id === "string" ? ctx.agent_id : null,
      typeof ctx.origin_session_id === "number" ? ctx.origin_session_id : null,
    );
    if (rowKey !== key) continue;

    ctx.platforms = mergePlatforms(ctx.platforms, params.platforms);
    db.prepare(
      `UPDATE agent_schedule
          SET task_description = ?, task_context = ?
        WHERE id = ?`,
    ).run(
      `${row.task_description}\n\n${params.message}`,
      JSON.stringify(ctx),
      row.id,
    );
    const result: DeferredDmResult = {
      scheduleId: String(row.id),
      deliverAfter: row.scheduled_for,
      coalesced: true,
    };
    recordDeferralAudit(db, window, params, result);
    return result;
  }

  const deliverAfter = formatSqliteDatetime(new Date(quietEndMs));
  const taskContext: Record<string, unknown> = {
    platforms: params.platforms ?? null,
    // Matches the `/schedule/dm` default — deferred pings stay out of
    // roadmap `Scheduled:` entries.
    importance: "transient",
    deferred_from: params.deferredFrom,
    ...(params.originSessionId !== undefined
      ? { origin_session_id: params.originSessionId }
      : {}),
    ...(params.agentId ? { agent_id: params.agentId } : {}),
  };
  const inserted = db
    .prepare(
      // task_type='dm' is consumed directly by `handleDirectDm` — the LLM
      // never runs, so `model` is NULL (same shape as POST /schedule/dm).
      `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, model, status)
       VALUES (?, 'dm', ?, ?, NULL, 'pending')`,
    )
    .run(deliverAfter, params.message, JSON.stringify(taskContext));

  const result: DeferredDmResult = {
    scheduleId: String(inserted.lastInsertRowid),
    deliverAfter,
    coalesced: false,
  };
  recordDeferralAudit(db, window, params, result);
  return result;
}

/**
 * Retime pending quiet-hours-deferred DM rows after a quiet-hours config
 * change (the `syncDmSessionTimesToQuietHours` sibling for this module's
 * rows). The deferral premise — "the row fires *at* the quiet-hours edge,
 * so `handleDirectDm`'s quiet-hours skip is correct" — only holds while
 * the window that produced `scheduled_for` is still the configured one:
 *
 *   - window extended (end moved later) → without retiming the row fires
 *     *inside* the new quiet window;
 *   - window shortened (end moved earlier) → the row waits past the new
 *     edge for no reason.
 *
 * Rule: inside the new window every deferred row moves to the new edge;
 * outside it, future-dated rows are pulled up to `now` (the next scheduler
 * tick delivers them) and already-due rows are left for the tick to claim.
 * User-scheduled `dm` rows (no `deferred_from` marker) are never touched.
 * Returns the number of rows retimed.
 */
export function retimeDeferredDmRows(
  db: Database.Database,
  window: QuietHoursWindow,
  now: Date = new Date(),
): number {
  const rows = db
    .prepare(
      `SELECT id, scheduled_for
         FROM agent_schedule
        WHERE status = 'pending'
          AND task_type = 'dm'
          AND task_context IS NOT NULL
          AND json_valid(task_context)
          AND json_extract(task_context, '$.deferred_from') IS NOT NULL`,
    )
    .all() as { id: number; scheduled_for: string }[];
  return retimeRowsToWindowEdge(db, window, now, rows, "dm");
}

/**
 * Retime pending quiet-hours-deferred RUN rows (`agent.task` opt-in and
 * `browser_task`) after a quiet-hours config change — the
 * `retimeDeferredDmRows` sibling for rows the ScheduleWatcher's
 * `deferClaimedRowForQuietHours` pushed to the old window's end. That helper
 * stamps `task_context.quiet_hours_deferred` at deferral time for exactly
 * this purpose: rows that merely *carry* the `defer_in_quiet_hours` opt-in on
 * a future cron slot were never deferred and keep their cron-scheduled time.
 *
 * Unlike deferred DM rows (delivered by `handleDirectDm`, which skips the
 * quiet-hours check by design), run rows re-check the window at claim time,
 * so a *widened* window self-corrects — retiming it here merely skips the
 * wasted claim/re-defer cycle and its duplicate audit row. The
 * narrowed/disabled direction is the real fix: without retiming, the run
 * waits at the old window's end for no reason.
 */
export function retimeDeferredRunRows(
  db: Database.Database,
  window: QuietHoursWindow,
  now: Date = new Date(),
): number {
  const rows = db
    .prepare(
      `SELECT id, scheduled_for
         FROM agent_schedule
        WHERE status = 'pending'
          AND task_context IS NOT NULL
          AND json_valid(task_context)
          AND json_extract(task_context, '$.quiet_hours_deferred') = 1`,
    )
    .all() as { id: number; scheduled_for: string }[];
  return retimeRowsToWindowEdge(db, window, now, rows, "run");
}

/**
 * Shared retime rule: inside the new window every row moves to the new edge;
 * outside it, future-dated rows are pulled up to `now` (the next scheduler
 * tick handles them) and already-due rows are left for the tick to claim.
 */
function retimeRowsToWindowEdge(
  db: Database.Database,
  window: QuietHoursWindow,
  now: Date,
  rows: { id: number; scheduled_for: string }[],
  kind: "dm" | "run",
): number {
  if (rows.length === 0) return 0;

  const quietEndMs = nextQuietHoursEndMs(now, window);
  const target = formatSqliteDatetime(
    quietEndMs !== null ? new Date(quietEndMs) : now,
  );
  const update = db.prepare(
    "UPDATE agent_schedule SET scheduled_for = ? WHERE id = ?",
  );
  let retimed = 0;
  for (const row of rows) {
    // Outside quiet hours only future rows move — an already-due row is
    // the scheduler's to claim; rewriting it would just delay delivery.
    if (quietEndMs === null && row.scheduled_for <= target) continue;
    if (row.scheduled_for === target) continue;
    update.run(target, row.id);
    retimed++;
  }
  if (retimed > 0) {
    logger.info(
      { retimed, target, insideQuietHours: quietEndMs !== null, kind },
      "Retimed pending quiet-hours-deferred rows after quiet-hours change",
    );
  }
  return retimed;
}

/** One `agent_actions` row per deferral so the user can see the delay —
 *  mirrors the scheduler's `browser_task.deferred_for_quiet_hours`. */
function recordDeferralAudit(
  db: Database.Database,
  window: QuietHoursWindow,
  params: DeferDmParams,
  result: DeferredDmResult,
): void {
  try {
    db.prepare(
      `INSERT INTO agent_actions
         (action_type, detail, result, started_at, completed_at)
       VALUES (?, ?, 'success', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run(
      "notify.deferred_for_quiet_hours",
      JSON.stringify({
        scheduleId: result.scheduleId,
        deferredFrom: params.deferredFrom,
        originSessionId: params.originSessionId ?? null,
        agentId: params.agentId ?? null,
        deliverAfter: result.deliverAfter,
        coalesced: result.coalesced,
        quietHoursStart: window.start,
        quietHoursEnd: window.end,
      }),
    );
  } catch (err) {
    logger.warn(
      { err, scheduleId: result.scheduleId },
      "Failed to record notify.deferred_for_quiet_hours audit — deferred row already persisted",
    );
  }
}
