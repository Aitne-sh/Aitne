import type Database from "better-sqlite3";
import {
  createEvent,
  EventPriority,
  type CalendarChangeEvent,
} from "@aitne/shared";
import type { EventBus } from "../core/event-bus.js";
import type { Observer } from "./manager.js";
import { createLogger } from "../logging.js";
import { PollGuard } from "./poll-guard.js";

const logger = createLogger("imminent-event-scheduler");

/**
 * Wall-clock cap per tick. The tick is mostly synchronous SQLite + a
 * handful of `eventBus.put` calls (in-process). A 30s cap is far above
 * the healthy upper bound (sub-second) but tight enough that two
 * consecutive ticks at the default 60s cadence cannot stack into the
 * next interval. PollGuard's overlap guard is the primary defense; the
 * timeout is the safety net for `eventBus.put` blocking on a full heap
 * during sustained bursts.
 */
const TICK_TIMEOUT_MS = 30_000;

interface CandidateRow {
  /**
   * `"snapshot"` rows have the canonical `CalendarSnapshotPayload` shape
   * — fields at the top level (`summary` / `start` / `end`). Written by
   * `CalendarPoller` (direct mode) and `DelegatedSyncWorker` (delegated
   * mode) into `integration_snapshots`.
   *
   * `"observation"` rows are agent POSTs to `/api/observations` from the
   * native-mode `routine.fetch_window` pre-pass for `imminent_2h`. The
   * payload shape is the calendar partial's contract:
   * `{ kind: "calendar", providerId, raw: { title, start, end, ... } }`.
   */
  source_kind: "snapshot" | "observation";
  item_id: string;
  payload_json: string;
  item_start: string;
}

/**
 * Tolerant extraction over the union of the snapshot payload shape
 * (`{summary, start, end}`) and the observation payload shape
 * (`{kind, providerId, raw: {title, start, end}}`). The scheduler
 * doesn't care which writer landed the row — both shapes carry the
 * same three fields it needs, just in different positions.
 *
 * For native-mode observation rows: title is in `raw.title`; the
 * snapshot writer normalises to `summary`. Fall back through both
 * keys so each writer's convention survives. End / start are the
 * same story.
 */
interface CalendarPayload {
  summary?: string | null;
  start?: string | null;
  end?: string | null;
  location?: string | null;
  // Native-mode observation payload shape.
  kind?: string | null;
  raw?: {
    title?: string | null;
    summary?: string | null;
    start?: string | null;
    end?: string | null;
    location?: string | null;
  } | null;
}

function extractCalendarPayload(parsed: CalendarPayload): {
  title: string | null;
  start: string | null;
  end: string | null;
} {
  // Observation `raw.title` wins for native rows; snapshot `summary` wins
  // for direct / delegated rows. The two writers never produce both keys,
  // so the precedence is informational rather than collision-resolving.
  const raw = parsed.raw ?? undefined;
  const title = raw?.title ?? raw?.summary ?? parsed.summary ?? null;
  const start = raw?.start ?? parsed.start ?? null;
  const end = raw?.end ?? parsed.end ?? null;
  return { title, start, end };
}

/**
 * 15-minute imminent-meeting reminder emitter.
 *
 * Reads two sources for upcoming Google Calendar events in `[now, now + 15min]`
 * and emits one `schedule.approaching` event per item via the EventBus:
 *
 *  - `integration_snapshots` rows for `integration = 'google_calendar'` —
 *    populated by `CalendarPoller` (direct mode) and `DelegatedSyncWorker`
 *    (delegated mode).
 *  - `observations` rows for `source LIKE 'google_calendar:%'` — populated
 *    by the agent's `/api/observations` POSTs during the native-mode
 *    `routine.fetch_window` pre-pass (`imminent_2h` window). In native
 *    mode the daemon does NOT poll and integration_snapshots stays empty
 *    by design (`INTEGRATION_SNAPSHOT_PARTITIONS_BY_MODE[google_calendar].native = []`);
 *    without this second source, native-mode users would silently lose
 *    every 15-minute reminder. Cadence note: native observations refresh
 *    on the hourly_check tick (60-min cadence) so events scheduled with
 *    less than ~60 min lead-time may miss their reminder. The 5-min
 *    direct-mode polling cadence does not have this limit.
 *
 * INTEGRATION-DRIFT-PHASE-7-PLAN.md §3.2 — dedup is persistent. Pre-
 * Phase-7 the scheduler kept an in-memory Set; daemon restarts re-DMed
 * every imminent event in flight. The new `imminent_event_notifications`
 * table records `(item_id, notified_at)` on each emit and is consulted
 * before each tick. Retention prunes rows older than 24 h via
 * retention.ts. Cross-source dedup is automatic: snapshot `item_id` and
 * observation `ref` both use the provider's stable event id, so the
 * same row in both tables resolves to a single `imminent_event_notifications`
 * entry.
 */
export class ImminentEventScheduler implements Observer {
  readonly name = "imminent-event-scheduler";

  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly guard = new PollGuard({
    name: "imminent-event-scheduler",
    tickTimeoutMs: TICK_TIMEOUT_MS,
  });

  constructor(
    private readonly db: Database.Database,
    private readonly eventBus: EventBus,
    private readonly calendarId: string,
    private readonly intervalSeconds = 60,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async start(): Promise<void> {
    await this.tick();
    this.timer = setInterval(
      () => void this.tick(),
      this.intervalSeconds * 1000,
    );
    logger.info(
      { intervalSeconds: this.intervalSeconds },
      "Imminent event scheduler started",
    );
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.guard.abortInFlight(new Error("imminent_event_scheduler_stopped"));
    logger.info("Imminent event scheduler stopped");
  }

  async tick(): Promise<void> {
    try {
      await this.guard.run((signal) => this.runTick(signal));
    } catch (err) {
      logger.error({ err }, "Imminent event scheduler tick failed");
    }
  }

  private async runTick(signal: AbortSignal): Promise<void> {
    const now = this.now();
    const max = new Date(now.getTime() + 15 * 60 * 1000);
    const nowIso = now.toISOString();
    const maxIso = max.toISOString();
    // UNION ALL across the two writers (snapshot table for direct /
    // delegated; observations table for native). LEFT-JOIN against the
    // dedup table at the outer level so a row already notified is
    // skipped regardless of which source produced it. Cross-source
    // duplicates (same provider event id appearing in both tables, e.g.
    // briefly during a mode flip) collapse via the JS-side `seen` set
    // below — we emit at most one `schedule.approaching` event per
    // item_id even if both queries surface it.
    //
    // The observation branch is keyed by `o.consumed_at IS NULL` so we
    // don't fire reminders for events the morning routine already
    // consumed (the pending-observations filter). Direct/delegated
    // snapshots have no consumed_at column — the writer reconciles
    // in-place, so the snapshot row always reflects the current state.
    // Timestamp normalisation rationale:
    //
    // Snapshot path: the writer normalises `item_start` to UTC ISO with
    // Z suffix via `normalizeTimeForRange` (integrations-snapshot.ts)
    // before insert, so raw string compare on snapshots is correct AND
    // can use the `idx_integration_snapshots_imminent` covering index
    // (a `datetime()` wrapper would block the index per SQLite's
    // "expressions on indexed column" rule).
    //
    // Observation path: the writer is the agent's `/api/observations`
    // POST — the partial's contract is "the response from the upstream
    // call IS the payload, do not summarise or rank", so the start
    // timestamp inherits whatever format the bound Calendar MCP
    // emitted. Google Calendar MCPs typically return RFC 3339 with
    // timezone offset (`2026-04-29T08:00:00-04:00`). A lexicographic
    // compare of those against the UTC-Z `now.toISOString()` parameter
    // mis-orders rows across the dateline / DST boundary and silently
    // drops imminent reminders. SQLite's `datetime()` normalises both
    // forms to the canonical `'YYYY-MM-DD HH:MM:SS'` UTC string; NULL
    // / unparseable inputs return NULL which the WHERE filter
    // discards.
    //
    // ORDER BY: `datetime()`-normalised on both sides so the
    // cross-source dedup case (snapshot + observation rows for the
    // same event id appearing during a mode flip) deterministically
    // picks the same winner regardless of which format the
    // observation row carries. The set ordered here is already
    // narrowed by the WHERE filter to rows in [now, now+15min] — a
    // handful, not the full table — so the per-row `datetime()` cost
    // is negligible.
    const rows = this.db
      .prepare(
        `SELECT candidates.source_kind  AS source_kind,
                candidates.item_id      AS item_id,
                candidates.payload_json AS payload_json,
                candidates.item_start   AS item_start
         FROM (
           SELECT 'snapshot' AS source_kind,
                  s.item_id  AS item_id,
                  s.payload_json AS payload_json,
                  s.item_start AS item_start
           FROM integration_snapshots s
           WHERE s.integration = 'google_calendar'
             AND s.item_start IS NOT NULL
             AND s.item_start > ?
             AND s.item_start <= ?
           UNION ALL
           SELECT 'observation' AS source_kind,
                  o.ref      AS item_id,
                  o.payload  AS payload_json,
                  json_extract(o.payload, '$.raw.start') AS item_start
           FROM observations o
           WHERE o.source LIKE 'google_calendar:%'
             AND o.consumed_at IS NULL
             -- json_valid guards against the SQLite json_extract runtime
             -- error when the payload column happens to contain non-JSON
             -- text. The agent's /api/observations POST handler rejects
             -- malformed bodies, so production never hits this branch.
             -- The gate matches the snapshot path's recovery contract:
             -- skip the row, do NOT write a dedup entry, let the next
             -- tick reprocess if the upstream row gets repaired.
             AND json_valid(o.payload) = 1
             AND json_extract(o.payload, '$.kind') = 'calendar'
             AND json_extract(o.payload, '$.raw.start') IS NOT NULL
             AND datetime(json_extract(o.payload, '$.raw.start')) > datetime(?)
             AND datetime(json_extract(o.payload, '$.raw.start')) <= datetime(?)
         ) AS candidates
         LEFT JOIN imminent_event_notifications n
           ON n.item_id = candidates.item_id
         WHERE n.notified_at IS NULL
         ORDER BY datetime(candidates.item_start) ASC`,
      )
      .all(nowIso, maxIso, nowIso, maxIso) as CandidateRow[];

    if (rows.length === 0) return;

    const insertNotification = this.db.prepare(
      `INSERT INTO imminent_event_notifications (item_id, notified_at)
       VALUES (?, ?)
       ON CONFLICT(item_id) DO NOTHING`,
    );

    // Cross-source dedup: the snapshot writer and the observation writer
    // can briefly carry the same provider event id during a direct↔native
    // mode flip (snapshot purge is best-effort, agent posts happen in-turn).
    // The DB-level `imminent_event_notifications` dedup catches this once
    // the first row is processed, but on a single tick where both rows
    // pass the WHERE filter we'd otherwise emit twice before the INSERT
    // commits. Track item_ids in-loop and skip the second occurrence.
    const seen = new Set<string>();
    for (const row of rows) {
      // PollGuard's tick-timeout (or observer stop) — drop out cleanly
      // mid-row so we don't keep emitting after the tick window has
      // already expired.
      if (signal.aborted) return;
      if (seen.has(row.item_id)) continue;
      seen.add(row.item_id);
      const startMs = Date.parse(row.item_start);
      if (!Number.isFinite(startMs)) continue;
      const minutesUntil = (startMs - now.getTime()) / 60_000;
      if (minutesUntil <= 0 || minutesUntil > 15) continue;

      let parsed: CalendarPayload;
      try {
        parsed = JSON.parse(row.payload_json) as CalendarPayload;
      } catch (err) {
        logger.warn(
          { err, itemId: row.item_id, sourceKind: row.source_kind },
          "Skipping imminent event with invalid payload",
        );
        continue;
      }
      const payload = extractCalendarPayload(parsed);

      // Mark notified BEFORE the EventBus put. If the put throws, a
      // duplicate emit on the next tick is preferable to losing the row
      // here, but the put path itself is in-memory and synchronous —
      // the failure mode is vanishingly rare. Pairing the insert with
      // ON CONFLICT DO NOTHING means a concurrent emit attempt by a
      // second scheduler instance (defensive — only one runs in
      // production) is also a no-op.
      insertNotification.run(row.item_id, now.toISOString());

      const event = {
        ...createEvent({
          type: "schedule.approaching",
          source: "google_calendar",
          priority: EventPriority.HIGH,
          data: {
            calendarEventId: row.item_id,
            summary: payload.title ?? "",
            startTime: payload.start ?? row.item_start,
            endTime: payload.end ?? null,
            minutesUntil: Math.round(minutesUntil),
          },
        }),
        calendarId: this.calendarId,
        eventTitle: payload.title ?? "Untitled Event",
        startTime: new Date(startMs),
        endTime: payload.end ? new Date(payload.end) : null,
        changeType: "approaching",
      } as CalendarChangeEvent;

      await this.eventBus.put(event);
      logger.info(
        {
          itemId: row.item_id,
          sourceKind: row.source_kind,
          event: payload.title,
          minutesUntil: Math.round(minutesUntil),
        },
        "Approaching calendar event",
      );
    }
  }
}
