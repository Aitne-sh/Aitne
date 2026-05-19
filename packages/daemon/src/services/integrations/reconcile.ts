import type Database from "better-sqlite3";
import {
  type IntegrationKey,
  type IntegrationNormalizer,
  type SnapshotActorHint,
} from "@aitne/shared";

/**
 * Integration drift-detection reconcile primitive
 * (INTEGRATION-DRIFT-DETECTION-PLAN.md §5).
 *
 * Pure module: takes a `better-sqlite3` Database for transactional
 * read/write only, returns a structured diff. No EventBus emit, no
 * observation insertion, no LLM call. Phase 1 keeps reconcile diff-only;
 * Phase 2's drift-effects.ts wraps the result and dispatches side effects.
 *
 * Idempotency: running reconcile twice with the same input on an
 * already-reconciled state returns `{created: [], modified: [], deleted:
 * [], unchanged: N}` — the second call only resets `fetched_at`.
 */

/**
 * One incoming item from the caller's fetch. `payload` carries the canonical
 * shape produced by `IntegrationNormalizer.payload()`. `contentHash` is
 * optional — the daemon-side caller pre-hashes via the shared normalizer for
 * speed; LLM-driven callers omit it and the route normalises server-side
 * (§5.2).
 */
export interface ReconcileItem {
  itemId: string;
  contentHash: string;
  payload: unknown;
  itemStart?: string | null;
  actorHint?: SnapshotActorHint;
}

export interface ReconcileRequest {
  integration: IntegrationKey;
  windowKey: string;
  windowMin: string;
  windowMax: string;
  fetchedAt: string;
  items: readonly ReconcileItem[];
  /** Caller hint that this is the first snapshot for the partition. The
   *  reconciler also auto-detects this when the prior set is empty so a
   *  forgetful caller still gets the silent-initial behaviour. */
  isInitialSnapshot?: boolean;
  /** INTEGRATION-DRIFT-PHASE-7-PLAN.md §3.7. When `'dry-run'`, reconcile
   *  computes the diff against the prior snapshot but writes nothing —
   *  no UPSERT, no DELETE, no `runtime_state` partition init, no
   *  `onDiffInTransaction`. Operators use this from the route handler's
   *  `?dry-run=1` flag to inspect what the next non-dry-run call would
   *  emit. Defaults to `'apply'`. */
  mode?: "apply" | "dry-run";
}

export interface ReconcileCreatedItem extends ReconcileItem {
  /** Resolved actor for the diff entry. `agent` when `integration_writes`
   *  has a non-expired row for `(integration, item_id)`; otherwise the
   *  caller's `actorHint`, defaulting to `'user'`. */
  actor: SnapshotActorHint;
}

export interface ReconcileModifiedItem {
  itemId: string;
  prior: { contentHash: string; payload: unknown };
  current: { contentHash: string; payload: unknown };
  itemStart: string | null;
  actor: SnapshotActorHint;
}

export interface ReconcileDeletedItem {
  itemId: string;
  payload: unknown;
  itemStart: string | null;
  actor: SnapshotActorHint;
}

export interface ReconcileDiff {
  created: ReconcileCreatedItem[];
  modified: ReconcileModifiedItem[];
  deleted: ReconcileDeletedItem[];
  unchanged: number;
  /** Items that disappeared from the new fetch but whose payload's time
   *  field falls outside `[windowMin, windowMax)` — the row was simply
   *  pruned because it slid out of the window we queried. Phase 2 ignores
   *  these (no observation emitted); surfaced for testability and for
   *  Phase 4 prompt-side reasoning. */
  prunedOutOfWindow: number;
  isInitialSnapshot: boolean;
}

interface PriorRow {
  itemId: string;
  contentHash: string;
  payloadJson: string;
  itemStart: string | null;
  actorHint: SnapshotActorHint;
}

const SELECT_PRIOR_SQL = `
  SELECT item_id   AS itemId,
         content_hash AS contentHash,
         payload_json AS payloadJson,
         item_start   AS itemStart,
         actor_hint   AS actorHint
  FROM integration_snapshots
  WHERE integration = ? AND window_key = ?
`;

const UPSERT_SQL = `
  INSERT INTO integration_snapshots
    (integration, window_key, item_id, content_hash, payload_json,
     item_start, fetched_at, actor_hint)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(integration, window_key, item_id) DO UPDATE SET
    content_hash = excluded.content_hash,
    payload_json = excluded.payload_json,
    item_start   = excluded.item_start,
    fetched_at   = excluded.fetched_at,
    actor_hint   = excluded.actor_hint
`;

const DELETE_SQL = `
  DELETE FROM integration_snapshots
  WHERE integration = ? AND window_key = ? AND item_id = ?
`;

const RESOLVE_AGENT_WRITE_SQL = `
  SELECT 1
  FROM integration_writes
  WHERE integration = ? AND item_id = ? AND expires_at > ?
  LIMIT 1
`;

const SELECT_PARTITION_INIT_SQL = `
  SELECT 1
  FROM runtime_state
  WHERE key = ?
  LIMIT 1
`;

const UPSERT_PARTITION_INIT_SQL = `
  INSERT INTO runtime_state (key, value_json, updated_at)
  VALUES (?, 'true', CURRENT_TIMESTAMP)
  ON CONFLICT(key) DO UPDATE SET
    value_json = excluded.value_json,
    updated_at = CURRENT_TIMESTAMP
`;

function partitionInitKey(integration: IntegrationKey, windowKey: string): string {
  return `integration_snapshot_initialized:${integration}:${windowKey}`;
}

export interface ReconcileDeps {
  /**
   * Per-integration normalizer used for the §5.1 sliding-window predicate.
   * Reconcile owns the SELECT/UPSERT plumbing; the normalizer owns the
   * payload semantics. The route handler resolves this from
   * `getSnapshotNormalizer(integration)` and passes it in so reconcile
   * stays a pure function (no shared-package side effects on import).
   */
  normalizer: IntegrationNormalizer;
  /**
   * Optional local actor resolver for daemon-internal callers that still
   * have a path-keyed attribution source (for example the direct calendar
   * route's AgentWriteTracker). `integration_writes` remains authoritative;
   * this resolver is only consulted when no non-expired persistent write
   * marker exists.
   */
  resolveActorHint?: (
    integration: IntegrationKey,
    itemId: string,
  ) => SnapshotActorHint | null | undefined;
  /**
   * Called inside the same SQLite write transaction after snapshot rows
   * have been reconciled and before the transaction commits. Phase 2 uses
   * this to apply observations / today-refresh scheduling atomically with
   * the snapshot write (§17.2).
   */
  onDiffInTransaction?: (diff: ReconcileDiff) => void;
}

/**
 * Reconcile new items against the prior snapshot for
 * `(integration, window_key)`. Single SQLite transaction; the calling
 * route is responsible for the chokepoint audit row (§6.0) and any
 * Phase-2 side effects.
 *
 * The function is exported as a regular function (not a class) so unit
 * tests can call it directly with an in-memory `better-sqlite3` instance.
 */
export function reconcile(
  db: Database.Database,
  req: ReconcileRequest,
  deps: ReconcileDeps,
): ReconcileDiff {
  const created: ReconcileCreatedItem[] = [];
  const modified: ReconcileModifiedItem[] = [];
  const deleted: ReconcileDeletedItem[] = [];
  let unchanged = 0;
  let prunedOutOfWindow = 0;

  const isDryRun = req.mode === "dry-run";
  const txn = db.transaction(() => {
    const priorRows = db
      .prepare(SELECT_PRIOR_SQL)
      .all(req.integration, req.windowKey) as PriorRow[];
    const prior = new Map<string, PriorRow>();
    for (const row of priorRows) prior.set(row.itemId, row);

    const initKey = partitionInitKey(req.integration, req.windowKey);
    const partitionInitialized = db
      .prepare(SELECT_PARTITION_INIT_SQL)
      .get(initKey) !== undefined;
    const isInitialSnapshot
      = (!partitionInitialized && prior.size === 0)
        || req.isInitialSnapshot === true;

    const seenIds = new Set<string>();
    const upsert = db.prepare(UPSERT_SQL);
    const remove = db.prepare(DELETE_SQL);
    const resolveAgent = db.prepare(RESOLVE_AGENT_WRITE_SQL);
    const resolveActor = (
      itemId: string,
      fallback?: SnapshotActorHint,
      resolverBeforeFallback = false,
    ): SnapshotActorHint => {
      const writeRow = resolveAgent.get(
        req.integration,
        itemId,
        req.fetchedAt,
      );
      if (writeRow !== undefined) return "agent";
      const resolved = deps.resolveActorHint?.(req.integration, itemId);
      // The deleted-item caller always passes priorRow.actor_hint, which
      // is a NOT-NULL DEFAULT 'user' column → `fallback` is guaranteed
      // defined under resolverBeforeFallback=true. The trailing `?? "user"`
      // there is therefore unreachable; the live-item caller (=false) is
      // where the chain bottoms out at the literal default.
      return resolverBeforeFallback
        ? (resolved ?? /* c8 ignore next */ fallback ?? "user")
        : (fallback ?? resolved ?? "user");
    };

    for (const item of req.items) {
      seenIds.add(item.itemId);
      const priorRow = prior.get(item.itemId);
      const itemStart = item.itemStart ?? null;
      // Resolve actor: integration_writes wins, else caller hint, else
      // 'user'. Reconcile reads the table inside the same transaction so
      // a write-then-reconcile race within the same SQLite connection
      // sees the just-inserted row.
      const actor = resolveActor(item.itemId, item.actorHint);

      if (priorRow === undefined) {
        // New item.
        if (!isDryRun) {
          upsert.run(
            req.integration,
            req.windowKey,
            item.itemId,
            item.contentHash,
            JSON.stringify(item.payload),
            itemStart,
            req.fetchedAt,
            actor,
          );
        }
        if (!isInitialSnapshot) {
          created.push({
            itemId: item.itemId,
            contentHash: item.contentHash,
            payload: item.payload,
            itemStart,
            actorHint: item.actorHint,
            actor,
          });
        }
        continue;
      }

      if (priorRow.contentHash === item.contentHash) {
        // No-op for the diff, but bump fetched_at so the partition's
        // freshness signal stays current.
        if (!isDryRun) {
          upsert.run(
            req.integration,
            req.windowKey,
            item.itemId,
            item.contentHash,
            JSON.stringify(item.payload),
            itemStart,
            req.fetchedAt,
            actor,
          );
        }
        unchanged += 1;
        continue;
      }

      // Modified — hash differs.
      const priorPayload = JSON.parse(priorRow.payloadJson) as unknown;
      if (!isDryRun) {
        upsert.run(
          req.integration,
          req.windowKey,
          item.itemId,
          item.contentHash,
          JSON.stringify(item.payload),
          itemStart,
          req.fetchedAt,
          actor,
        );
      }
      if (!isInitialSnapshot) {
        modified.push({
          itemId: item.itemId,
          prior: {
            contentHash: priorRow.contentHash,
            payload: priorPayload,
          },
          current: {
            contentHash: item.contentHash,
            payload: item.payload,
          },
          itemStart,
          actor,
        });
      }
    }

    // Prior items missing from new fetch: distinguish "slid out of window"
    // from "truly deleted upstream" via the per-integration predicate
    // (§5.1). Both cases delete the snapshot row; only the second emits a
    // diff entry that Phase-2 effects will translate to an observation.
    for (const priorRow of priorRows) {
      if (seenIds.has(priorRow.itemId)) continue;
      const priorPayload = JSON.parse(priorRow.payloadJson) as unknown;
      const stillInWindow = deps.normalizer.inWindow(
        priorPayload,
        req.windowMin,
        req.windowMax,
      );
      if (!isDryRun) {
        remove.run(req.integration, req.windowKey, priorRow.itemId);
      }
      if (!stillInWindow) {
        prunedOutOfWindow += 1;
        continue;
      }
      if (!isInitialSnapshot) {
        const actor = resolveActor(priorRow.itemId, priorRow.actorHint, true);
        deleted.push({
          itemId: priorRow.itemId,
          payload: priorPayload,
          itemStart: priorRow.itemStart,
          actor,
        });
      }
    }

    if (!isDryRun) {
      deps.onDiffInTransaction?.({
        created,
        modified,
        deleted,
        unchanged,
        prunedOutOfWindow,
        isInitialSnapshot,
      });

      db.prepare(UPSERT_PARTITION_INIT_SQL).run(initKey);
    }

    return isInitialSnapshot;
  });

  const isInitialSnapshot = txn();

  return {
    created,
    modified,
    deleted,
    unchanged,
    prunedOutOfWindow,
    isInitialSnapshot,
  };
}

/**
 * Insert (or refresh) an `integration_writes` row tagging a given item as
 * agent-originated for the next `ttlMs` milliseconds. Called from route
 * handlers after a successful write to the upstream service so the next
 * reconcile diff resolves `actor='agent'`. Phase 1 exposes the helper
 * but no route calls it yet — Phase 4 wires up the calendar / mail /
 * notion write surfaces.
 */
export function markIntegrationWrite(
  db: Database.Database,
  params: {
    integration: IntegrationKey;
    itemId: string;
    ttlMs: number;
    nowIso: string;
  },
): void {
  const expiresAt = new Date(
    new Date(params.nowIso).getTime() + params.ttlMs,
  ).toISOString();
  db.prepare(
    `INSERT INTO integration_writes
       (integration, item_id, written_at, written_by, expires_at)
     VALUES (?, ?, ?, 'agent', ?)
     ON CONFLICT(integration, item_id) DO UPDATE SET
       written_at = excluded.written_at,
       written_by = excluded.written_by,
       expires_at = excluded.expires_at`,
  ).run(params.integration, params.itemId, params.nowIso, expiresAt);
}
