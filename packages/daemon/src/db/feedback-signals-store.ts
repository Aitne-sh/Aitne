import type Database from "better-sqlite3";

export type FeedbackSignalSource = "behavioral" | "explicit" | "self_critique";
export type FeedbackSignalValence = "positive" | "negative" | "neutral" | "correction";
export type FeedbackScopeType =
  | "user"
  | "agent"
  | "agent_slug"
  | "channel"
  | "task"
  | "integration";
export type FeedbackActionKind =
  | "notification"
  | "agent_execution"
  | "vault_write"
  | "dm_reply";

export interface FeedbackSignalRow {
  id: number;
  created_at: string;
  source: FeedbackSignalSource;
  valence: FeedbackSignalValence | null;
  scope_type: FeedbackScopeType;
  scope_ref: string | null;
  action_kind: FeedbackActionKind | null;
  action_ref: string | null;
  agent_id: string | null;
  summary: string;
  evidence_json: string | null;
  consumed_at: string | null;
  lesson_ref: string | null;
}

export interface RecordFeedbackSignalParams {
  source: FeedbackSignalSource;
  valence?: FeedbackSignalValence | null;
  scopeType: FeedbackScopeType;
  scopeRef?: string | null;
  actionKind?: FeedbackActionKind | null;
  actionRef?: string | null;
  agentId?: string | null;
  summary: string;
  evidence?: unknown;
}

export interface RecentFeedbackSignalLookup {
  scopeType: FeedbackScopeType;
  scopeRef?: string | null;
  summary: string;
  withinSeconds: number;
}

export function recordFeedbackSignal(
  db: Database.Database,
  params: RecordFeedbackSignalParams,
): number {
  const evidenceJson =
    params.evidence === undefined ? "{}" : JSON.stringify(params.evidence);
  const row = db
    .prepare(
      `INSERT INTO feedback_signals (
         source,
         valence,
         scope_type,
         scope_ref,
         action_kind,
         action_ref,
         agent_id,
         summary,
         evidence_json
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      params.source,
      params.valence ?? null,
      params.scopeType,
      params.scopeRef ?? null,
      params.actionKind ?? null,
      params.actionRef ?? null,
      params.agentId ?? null,
      params.summary,
      evidenceJson,
    ) as { id: number };
  return row.id;
}

export function findRecentFeedbackSignal(
  db: Database.Database,
  params: RecentFeedbackSignalLookup,
): FeedbackSignalRow | null {
  const row = db
    .prepare(
      `SELECT *
       FROM feedback_signals
       WHERE scope_type = ?
         AND COALESCE(scope_ref, '') = COALESCE(?, '')
         AND summary = ?
         AND datetime(created_at) >= datetime('now', '-' || ? || ' seconds')
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT 1`,
    )
    .get(
      params.scopeType,
      params.scopeRef ?? null,
      params.summary,
      Math.max(0, Math.floor(params.withinSeconds)),
    ) as FeedbackSignalRow | undefined;
  return row ?? null;
}

export function hasFeedbackSignalForAction(
  db: Database.Database,
  params: {
    source: FeedbackSignalSource;
    actionKind: FeedbackActionKind;
    actionRef: string;
    valence?: FeedbackSignalValence | null;
    userReaction?: string;
  },
): boolean {
  const where = [
    "source = ?",
    "action_kind = ?",
    "action_ref = ?",
  ];
  const values: unknown[] = [params.source, params.actionKind, params.actionRef];
  if (params.valence !== undefined) {
    where.push(params.valence === null ? "valence IS NULL" : "valence = ?");
    if (params.valence !== null) values.push(params.valence);
  }
  if (params.userReaction !== undefined) {
    where.push("json_extract(evidence_json, '$.userReaction') = ?");
    values.push(params.userReaction);
  }
  const row = db
    .prepare(
      `SELECT 1 AS present
       FROM feedback_signals
       WHERE ${where.join(" AND ")}
       LIMIT 1`,
    )
    .get(...values) as { present: number } | undefined;
  return row !== undefined;
}

export function getPendingFeedbackSignals(
  db: Database.Database,
  params: {
    scopeType?: FeedbackScopeType;
    scopeRef?: string | null;
    limit?: number;
    offset?: number;
  } = {},
): FeedbackSignalRow[] {
  const where = ["consumed_at IS NULL"];
  const values: unknown[] = [];
  if (params.scopeType !== undefined) {
    where.push("scope_type = ?");
    values.push(params.scopeType);
  }
  if (params.scopeRef !== undefined) {
    where.push("COALESCE(scope_ref, '') = COALESCE(?, '')");
    values.push(params.scopeRef);
  }
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
  const offset = Math.max(params.offset ?? 0, 0);
  values.push(limit, offset);
  return db
    .prepare(
      `SELECT *
       FROM feedback_signals
       WHERE ${where.join(" AND ")}
       ORDER BY datetime(created_at) ASC, id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...values) as FeedbackSignalRow[];
}

/**
 * Count unconsumed signals, optionally narrowed to one scope type. Drives the
 * `GET /api/feedback/lessons` "N signals awaiting tonight's consolidation"
 * health figure (FEEDBACK_LEARNING_LOOP_DESIGN.md §9 Phase 5) without loading
 * the rows. Uses the same `consumed_at IS NULL` partial index as
 * {@link getPendingFeedbackSignals}.
 */
export function countPendingFeedbackSignals(
  db: Database.Database,
  params: { scopeType?: FeedbackScopeType } = {},
): number {
  const where = ["consumed_at IS NULL"];
  const values: unknown[] = [];
  if (params.scopeType !== undefined) {
    where.push("scope_type = ?");
    values.push(params.scopeType);
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM feedback_signals
       WHERE ${where.join(" AND ")}`,
    )
    .get(...values) as { n: number };
  return row.n;
}

export function consumeFeedbackSignals(
  db: Database.Database,
  ids: number[],
  lessonRef?: string | null,
): { consumed: number; notFound: number[] } {
  if (ids.length === 0) return { consumed: 0, notFound: [] };

  const placeholders = ids.map(() => "?").join(",");
  const existing = db
    .prepare(
      `SELECT id
       FROM feedback_signals
       WHERE id IN (${placeholders}) AND consumed_at IS NULL`,
    )
    .all(...ids) as { id: number }[];
  const existingIds = new Set(existing.map((row) => row.id));
  const notFound = ids.filter((id) => !existingIds.has(id));
  if (existingIds.size === 0) return { consumed: 0, notFound };

  const updateIds = Array.from(existingIds);
  const updatePlaceholders = updateIds.map(() => "?").join(",");
  const consumed = db
    .prepare(
      `UPDATE feedback_signals
       SET consumed_at = CURRENT_TIMESTAMP, lesson_ref = COALESCE(?, lesson_ref)
       WHERE id IN (${updatePlaceholders}) AND consumed_at IS NULL`,
    )
    .run(lessonRef ?? null, ...updateIds).changes;
  return { consumed, notFound };
}

export function sweepConsumedFeedbackSignals(
  db: Database.Database,
  cutoff: string,
): number {
  return db
    .prepare(
      `DELETE FROM feedback_signals
       WHERE consumed_at IS NOT NULL
         AND datetime(consumed_at) < datetime(?)`,
    )
    .run(cutoff).changes;
}
