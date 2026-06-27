import type Database from "better-sqlite3";
import { computeObservationHash } from "@aitne/shared";
import { createLogger } from "../logging.js";

const logger = createLogger("observations-db");

type ObservationChangeType = "created" | "modified" | "deleted";
type ObservationActor = "user" | "agent" | "system" | "unknown";

export type SummaryStatus = "pending" | "done" | "skipped" | "failed";

interface ObservationRecord {
  id: number;
  source: string;
  ref: string;
  change_type: ObservationChangeType;
  actor: ObservationActor;
  observed_at: string;
  payload: string | null;
  consumed_at: string | null;
  consumed_by: string | null;
  summary_text: string | null;
  novelty_score: number | null;
  summary_status: SummaryStatus;
  summary_at: string | null;
  summary_backend: string | null;
}

export interface ObservationSummaryRow {
  id: number;
  source: string;
  ref: string;
  changeType: ObservationChangeType;
  actor: ObservationActor;
  observedAt: string;
  payload: unknown;
  summaryStatus: SummaryStatus;
}

export interface PendingObservationsByActorRow {
  actor: ObservationActor;
  pendingCount: number;
}

export interface RecordObservationParams {
  source: string;
  ref: string;
  changeType: ObservationChangeType;
  actor?: ObservationActor;
  payload?: unknown;
}

/**
 * Result of a `recordObservation` call. The `action` field is what
 * lets the API route (and the pre-pass fetcher consuming its
 * response) distinguish a real write from a no-op:
 *
 *  - `"created"`   — no pending row existed for `(source, ref)`; a
 *                    new row was inserted.
 *  - `"modified"`  — a pending row existed but the payload differed;
 *                    the row was updated and the summarizer
 *                    re-enqueued.
 *  - `"duplicate"` — a pending row exists with an identical payload
 *                    (same canonical contentHash). The DB was NOT
 *                    touched and the summarizer was NOT re-enqueued.
 *                    This is the signal `routine.fetch_window` counts
 *                    as `duplicates` in its JSON `<fetch_report>`.
 *
 * `contentHash` is the canonical SHA-256 over `(source, payload)` and
 * matches what `computeObservationHash` would produce client-side. It
 * is returned for every action — callers that surface a per-write
 * audit trail get the same hash whether they wrote, updated, or
 * coalesced.
 */
export interface RecordObservationResult {
  id: number;
  action: "created" | "modified" | "duplicate";
  contentHash: string;
}

interface GetPendingObservationsParams {
  pending?: boolean;
  limit?: number;
  offset?: number;
  /**
   * Single-source prefix match (`source LIKE '<sourceFilter>%'`). Retained
   * for the legacy `?source=<prefix>` query string the daemon-internal
   * callers and the dashboard rely on.
   */
  sourceFilter?: string;
  /**
   * docs/design/appendices/routine-data-acquisition.md §6.7 — multi-prefix match. Each
   * entry produces one `source LIKE '<entry>%'` predicate, joined with
   * `OR`. The route adapter parses the `?source_prefix=a:,b:` form into
   * this list. Callers may pass either `sourceFilter` or
   * `sourceFilterPrefixes`; if both are present the multi-prefix list
   * takes precedence and the single value is ignored (no silent AND of
   * the two — that would produce an empty result set whenever the two
   * disagree, which is harder to debug than the explicit precedence).
   */
  sourceFilterPrefixes?: readonly string[];
  actorFilter?: ObservationActor;
  since?: string;
}

const UPSERT_SQL = `
  INSERT INTO observations (source, ref, change_type, actor, observed_at, payload, summary_status)
  VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, 'pending')
  ON CONFLICT(source, ref) WHERE consumed_at IS NULL
  DO UPDATE SET
    change_type = excluded.change_type,
    actor = excluded.actor,
    observed_at = excluded.observed_at,
    payload = excluded.payload,
    -- Re-summarize on payload update: clear prior summary so the worker re-runs.
    summary_text = NULL,
    novelty_score = NULL,
    summary_at = NULL,
    summary_backend = NULL,
    summary_status = 'pending'
  RETURNING id
`;

/**
 * Hook called after a row is inserted/upserted, with the row id. The
 * summarizer worker uses this to enqueue without coupling the DB
 * helper to the observer module.
 */
export type ObservationEnqueueHook = (observationId: number) => void;

let enqueueHook: ObservationEnqueueHook | null = null;

export function setObservationEnqueueHook(hook: ObservationEnqueueHook | null): void {
  enqueueHook = hook;
}

/**
 * Fire the observation-enqueue hook for a row id. Exposed for callers that
 * insert/update observation rows through paths other than `recordObservation`
 * (currently the coalescing UPSERT in `drift-effects.ts`). The summarizer
 * worker dedupes internally on its own `enqueued`/`inFlight` sets, so calling
 * this for an id already in flight is a safe no-op.
 *
 * Errors thrown by the hook are swallowed and logged for the same reason as
 * in `recordObservation`: observation writers are best-effort, and a
 * downstream summarizer fault must not abort the caller's transaction.
 */
export function notifyObservationSummarizer(observationId: number): void {
  if (!enqueueHook) return;
  try {
    enqueueHook(observationId);
  } catch (err) {
    logger.error({ err, observationId }, "observation enqueue hook threw");
  }
}

export function recordObservation(
  db: Database.Database,
  params: RecordObservationParams,
): RecordObservationResult {
  const actor = params.actor ?? "user";
  const incomingPayload = params.payload === undefined ? null : params.payload;
  const incomingHash = computeObservationHash(params.source, incomingPayload);

  // docs/design/appendices/routine-data-acquisition.md CR1 — dedup short-circuit. The
  // legacy UPSERT path silently coalesced (source, ref) collisions and
  // (worse) cleared `summary_text` so the summarizer re-ran on every
  // identical re-post. The pre-existing payload comparison below skips
  // the write entirely when the new payload's canonical hash matches
  // the stored one — saves a re-summarize round and gives the caller
  // (the POST route) an actionable signal for the dedup counter the
  // partials' `<fetch_report>` shape requires.
  //
  // The conditional UNIQUE index `(source, ref) WHERE consumed_at IS NULL`
  // (db/schema.ts:285) is what guarantees at most one matching row.
  const existing = db
    .prepare(
      "SELECT id, payload, actor, change_type FROM observations WHERE source = ? AND ref = ? AND consumed_at IS NULL",
    )
    .get(params.source, params.ref) as
    | {
        id: number;
        payload: string | null;
        actor: ObservationActor;
        change_type: ObservationChangeType;
      }
    | undefined;

  if (existing) {
    const existingPayload = parseStoredPayload(existing.payload);
    const existingHash = computeObservationHash(params.source, existingPayload);
    // Only coalesce when payload AND attribution both match. An
    // attribution- (actor) or change_type-correcting re-record carries
    // the same payload hash but differing columns; it must fall through
    // to the UPSERT so `actor = excluded.actor` / `change_type =
    // excluded.change_type` actually corrects the stored row. Otherwise
    // a daemon write first recorded as actor='user'/'unknown' (before
    // AgentWriteTracker/isMarked flipped it) would stay mis-attributed
    // and activity_scan would count it as user activity.
    if (
      existingHash === incomingHash &&
      existing.actor === actor &&
      existing.change_type === params.changeType
    ) {
      return {
        id: existing.id,
        action: "duplicate",
        contentHash: incomingHash,
      };
    }
  }

  const payloadJson =
    incomingPayload === null ? null : JSON.stringify(incomingPayload);
  const row = db
    .prepare(UPSERT_SQL)
    .get(
      params.source,
      params.ref,
      params.changeType,
      actor,
      payloadJson,
    ) as { id: number } | undefined;

  // The UPSERT's `RETURNING id` always emits a row whether it INSERT'd
  // or UPDATE'd. The fallback to `existing.id` is purely defensive —
  // the SELECT-then-UPSERT path is not atomic across transactions, but
  // the route uses a single short-lived transaction so the race
  // window is effectively zero. The fallback keeps TypeScript happy.
  const id = row?.id ?? existing?.id ?? -1;
  const action: "created" | "modified" = existing ? "modified" : "created";

  if (row && enqueueHook) {
    try {
      enqueueHook(row.id);
    } catch (err) {
      // Worker errors must not propagate to the caller (the observer is
      // best-effort writing observations; downstream summarization is
      // out-of-band). Log and move on.
      logger.error({ err, observationId: row.id }, "observation enqueue hook threw");
    }
  }

  return { id, action, contentHash: incomingHash };
}

/**
 * Parse a stored payload column back into a JS value. The column is
 * TEXT (JSON-encoded) or NULL. Anything malformed (legacy rows
 * written before the UPSERT path was strict, or a future schema
 * migration mid-flight) collapses to `null` so the hash comparison
 * still proceeds — at worst we trigger a "modified" write that
 * fixes the malformed row.
 */
function parseStoredPayload(payload: string | null): unknown {
  if (payload === null) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * Push the per-source LIKE predicates onto a shared `where` / `values`
 * pair. The two helpers (`getPendingObservations`, `getPendingCount`)
 * share this so the multi-prefix semantics stay in lock-step. Empty /
 * whitespace-only prefixes are dropped — they would otherwise produce
 * `LIKE '%'` which matches every row and silently un-narrows the query.
 */
function applySourceFilters(
  params: Pick<GetPendingObservationsParams, "sourceFilter" | "sourceFilterPrefixes">,
  where: string[],
  values: unknown[],
): void {
  if (params.sourceFilterPrefixes && params.sourceFilterPrefixes.length > 0) {
    const prefixes = params.sourceFilterPrefixes
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (prefixes.length === 0) return;
    const conds = prefixes.map(() => "source LIKE ?").join(" OR ");
    where.push(`(${conds})`);
    for (const prefix of prefixes) {
      values.push(`${prefix}%`);
    }
    return;
  }
  if (params.sourceFilter) {
    where.push("source LIKE ?");
    values.push(`${params.sourceFilter}%`);
  }
}

export function getPendingObservations(
  db: Database.Database,
  params: GetPendingObservationsParams = {},
): ObservationRecord[] {
  const where: string[] = [];
  const values: unknown[] = [];

  if (params.pending !== false) {
    where.push("consumed_at IS NULL");
  }
  applySourceFilters(params, where, values);
  if (params.actorFilter) {
    where.push("actor = ?");
    values.push(params.actorFilter);
  }
  if (params.since) {
    applySinceFilter(params.since, where, values);
  }

  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const offset = Math.max(params.offset ?? 0, 0);
  values.push(limit, offset);

  const sql = `
    SELECT id, source, ref, change_type, actor, observed_at, payload, consumed_at, consumed_by,
           summary_text, novelty_score, summary_status, summary_at, summary_backend
    FROM observations
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY observed_at ASC, id ASC
    LIMIT ? OFFSET ?
  `;

  return db.prepare(sql).all(...values) as ObservationRecord[];
}

/**
 * SQLite stores `observed_at` in two shapes:
 *   - `CURRENT_TIMESTAMP` writes the SQL form `'YYYY-MM-DD HH:MM:SS'`
 *     (assumed UTC; what `recordObservation` produces).
 *   - The summarizer / fixture writes can also use ISO 8601 with `T`
 *     and `Z` (`'2026-05-11T13:00:00.000Z'`).
 *
 * Callers pass `since` in **either** shape — the route adapter forwards
 * the agent's ISO string verbatim, and internal callers (today only the
 * tests) sometimes pass the SQL form. A naïve `observed_at >= ?`
 * predicate compares the strings byte-for-byte, and the SQL-form's
 * space (0x20) sorts before ISO-form's `T` (0x54), so
 * `'2026-05-11 12:00:00' < '2026-05-11T00:00:00.000Z'` evaluates true
 * and we'd silently drop rows.
 *
 * Routing both sides through SQLite's `datetime()` parser normalises
 * both shapes to the SQL canonical form (`YYYY-MM-DD HH:MM:SS`) before
 * comparison, so the predicate works regardless of which form the
 * caller / row provides.
 */
function applySinceFilter(
  since: string,
  where: string[],
  values: unknown[],
): void {
  where.push("datetime(observed_at) >= datetime(?)");
  values.push(since);
}

export function consumeObservations(
  db: Database.Database,
  ids: number[],
  correlationId: string,
): { consumed: number; notFound: number[] } {
  if (ids.length === 0) {
    return { consumed: 0, notFound: [] };
  }

  const placeholders = ids.map(() => "?").join(",");
  const existing = db.prepare(
    `SELECT id FROM observations WHERE id IN (${placeholders}) AND consumed_at IS NULL`,
  ).all(...ids) as { id: number }[];
  const existingIds = new Set(existing.map((row) => row.id));
  const notFound = ids.filter((id) => !existingIds.has(id));

  if (existingIds.size === 0) {
    return { consumed: 0, notFound };
  }

  const updatePlaceholders = Array.from(existingIds).map(() => "?").join(",");
  const consumed = db.prepare(
    `UPDATE observations
     SET consumed_at = CURRENT_TIMESTAMP, consumed_by = ?
     WHERE id IN (${updatePlaceholders}) AND consumed_at IS NULL`,
  ).run(correlationId, ...existingIds).changes;

  if (notFound.length > 0) {
    logger.debug({ consumed, notFound, correlationId }, "Some observation IDs not found during consume");
  }

  return { consumed, notFound };
}

export function getPendingCount(
  db: Database.Database,
  params: Pick<
    GetPendingObservationsParams,
    "sourceFilter" | "sourceFilterPrefixes" | "actorFilter" | "since"
  > = {},
): number {
  const where = ["consumed_at IS NULL"];
  const values: unknown[] = [];

  applySourceFilters(params, where, values);
  if (params.actorFilter) {
    where.push("actor = ?");
    values.push(params.actorFilter);
  }
  if (params.since) {
    applySinceFilter(params.since, where, values);
  }

  const row = db.prepare(
    `SELECT COUNT(*) as count FROM observations WHERE ${where.join(" AND ")}`,
  ).get(...values) as { count: number };
  return row.count;
}

export function getObservationStats(
  db: Database.Database,
  params: Pick<GetPendingObservationsParams, "actorFilter"> = {},
): {
  totalPending: number;
  oldestPendingObservedAt: string | null;
  bySource: Array<{ source: string; pendingCount: number; oldestObservedAt: string | null }>;
} {
  const where = ["consumed_at IS NULL"];
  const values: unknown[] = [];

  if (params.actorFilter) {
    where.push("actor = ?");
    values.push(params.actorFilter);
  }

  const whereClause = where.join(" AND ");
  const total = db.prepare(
    `SELECT COUNT(*) as count, MIN(observed_at) as oldest
     FROM observations
     WHERE ${whereClause}`,
  ).get(...values) as { count: number; oldest: string | null };

  const bySource = db.prepare(
    `SELECT source, COUNT(*) as pendingCount, MIN(observed_at) as oldestObservedAt
     FROM observations
     WHERE ${whereClause}
     GROUP BY source
     ORDER BY pendingCount DESC, source ASC`,
  ).all(...values) as Array<{ source: string; pendingCount: number; oldestObservedAt: string | null }>;

  return {
    totalPending: total.count,
    oldestPendingObservedAt: total.oldest,
    bySource,
  };
}

export function getPendingCountsByActor(
  db: Database.Database,
): PendingObservationsByActorRow[] {
  return db.prepare(
    `SELECT actor, COUNT(*) as pendingCount
     FROM observations
     WHERE consumed_at IS NULL
     GROUP BY actor
     ORDER BY pendingCount DESC, actor ASC`,
  ).all() as PendingObservationsByActorRow[];
}

export function cleanupConsumedObservations(
  db: Database.Database,
  olderThanDays = 7,
): number {
  return db.prepare(
    "DELETE FROM observations WHERE consumed_at IS NOT NULL AND consumed_at < datetime('now', '-' || ? || ' days')",
  ).run(olderThanDays).changes;
}

// ── Summarizer support (cost-reduction-structural §A) ─────────────────

/**
 * Read one observation by id along with its summarizer state. Returns
 * null when the row was already consumed or no longer exists.
 */
export function getObservationForSummarization(
  db: Database.Database,
  id: number,
): ObservationSummaryRow | null {
  const row = db.prepare(
    `SELECT id, source, ref, change_type, actor, observed_at, payload, summary_status
     FROM observations
     WHERE id = ? AND consumed_at IS NULL`,
  ).get(id) as
    | {
        id: number;
        source: string;
        ref: string;
        change_type: ObservationChangeType;
        actor: ObservationActor;
        observed_at: string;
        payload: string | null;
        summary_status: SummaryStatus;
      }
    | undefined;
  if (!row) return null;
  let payload: unknown = null;
  if (row.payload) {
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = null;
    }
  }
  return {
    id: row.id,
    source: row.source,
    ref: row.ref,
    changeType: row.change_type,
    actor: row.actor,
    observedAt: row.observed_at,
    payload,
    summaryStatus: row.summary_status,
  };
}

/**
 * Pending-row counts grouped by `summary_status`. Used by the
 * dashboard to surface summarizer health without scanning rows.
 */
export function getSummaryStatusCounts(
  db: Database.Database,
): Record<SummaryStatus, number> {
  const rows = db.prepare(
    `SELECT summary_status AS status, COUNT(*) AS count
     FROM observations
     WHERE consumed_at IS NULL
     GROUP BY summary_status`,
  ).all() as Array<{ status: SummaryStatus; count: number }>;
  const result: Record<SummaryStatus, number> = {
    pending: 0,
    done: 0,
    skipped: 0,
    failed: 0,
  };
  for (const row of rows) {
    result[row.status] = row.count;
  }
  return result;
}

/**
 * Distribution of `novelty_score` values across pending observations
 * with `summary_status='done'`. Drives the dashboard novelty-histogram
 * card and the activity_scan fetch-rate evaluation.
 */
export function getNoveltyDistribution(
  db: Database.Database,
): { score: 0 | 1 | 2 | 3; count: number }[] {
  const rows = db.prepare(
    `SELECT novelty_score AS score, COUNT(*) AS count
     FROM observations
     WHERE consumed_at IS NULL AND summary_status = 'done' AND novelty_score IS NOT NULL
     GROUP BY novelty_score
     ORDER BY novelty_score ASC`,
  ).all() as Array<{ score: number; count: number }>;
  return rows
    .filter((r) => r.score >= 0 && r.score <= 3)
    .map((r) => ({ score: r.score as 0 | 1 | 2 | 3, count: r.count }));
}

/**
 * Bulk-fetch pending observation ids for the summarizer worker — used
 * by the startup reclaim sweep and by recovery after a worker crash.
 */
export function listObservationsAwaitingSummary(
  db: Database.Database,
  options: { limit?: number; olderThan?: string } = {},
): number[] {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const where = ["consumed_at IS NULL", "summary_status = 'pending'"];
  const values: unknown[] = [];
  if (options.olderThan) {
    where.push("observed_at < ?");
    values.push(options.olderThan);
  }
  values.push(limit);
  const rows = db.prepare(
    `SELECT id FROM observations
     WHERE ${where.join(" AND ")}
     ORDER BY observed_at ASC, id ASC
     LIMIT ?`,
  ).all(...values) as { id: number }[];
  return rows.map((r) => r.id);
}

interface UpdateSummaryParams {
  id: number;
  summaryText: string | null;
  noveltyScore: number | null;
  summaryStatus: SummaryStatus;
  summaryBackend?: string | null;
  summaryAt?: string;
}

/**
 * Persist the summarizer's verdict to the observations row. Idempotent
 * — a same-id repeat overwrites with the latest values.
 */
export function updateObservationSummary(
  db: Database.Database,
  params: UpdateSummaryParams,
): void {
  const summaryAt = params.summaryAt ?? new Date().toISOString();
  db.prepare(
    `UPDATE observations
     SET summary_text = ?,
         novelty_score = ?,
         summary_status = ?,
         summary_backend = ?,
         summary_at = ?
     WHERE id = ? AND consumed_at IS NULL`,
  ).run(
    params.summaryText,
    params.noveltyScore,
    params.summaryStatus,
    params.summaryBackend ?? null,
    summaryAt,
    params.id,
  );
}

/**
 * Count pending observations that are older than `olderThanDays`.
 *
 * Pending observations are intentionally never auto-deleted (the activity_scan
 * dispatcher is the only consumer; silently dropping them would hide
 * operational bugs). However, if a row stays pending for many days it usually
 * indicates that the dispatcher is consistently below threshold or otherwise
 * stalled. Retention surfaces this via a warning so the operator can react.
 *
 * Returns the count and the oldest observed_at among stale pending rows.
 */
export function getStalePendingObservationStats(
  db: Database.Database,
  olderThanDays: number,
  options: { actorFilter?: "user" | "agent" | "system" | "unknown" } = {},
): { count: number; oldestObservedAt: string | null } {
  const where = [
    "consumed_at IS NULL",
    "observed_at < datetime('now', '-' || ? || ' days')",
  ];
  const values: unknown[] = [olderThanDays];
  if (options.actorFilter) {
    where.push("actor = ?");
    values.push(options.actorFilter);
  }
  const row = db.prepare(
    `SELECT COUNT(*) AS count, MIN(observed_at) AS oldest
     FROM observations
     WHERE ${where.join(" AND ")}`,
  ).get(...values) as { count: number; oldest: string | null };
  return { count: row.count, oldestObservedAt: row.oldest };
}
