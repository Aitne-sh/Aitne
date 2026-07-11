/**
 * Dev-session escalations — the development-mode plan §1/§2.
 *
 * One row per mid-run critical question (loop-kit's NEEDS_SPEC_DECISION /
 * NEEDS_ARCHITECTURE_DECISION / RISK_REQUIRES_APPROVAL / gate ESCALATE). A
 * near-clone of `background-task-clarifications-store.ts` (CAS-resolve +
 * delivery recovery), with two deliberate differences:
 *
 *   1. `kind` records which loop-kit escalation state produced it.
 *   2. `deadline_at` is NULLABLE and dev escalations are NEVER auto-expired.
 *      The requirement is "no inactivity timeout until the pending question
 *      resolves or the user !exits", so there is no overdue sweep here and
 *      `resolveDevEscalation` does not reject on a deadline — only on an
 *      already-resolved row.
 *
 * The loop engine writes the row between legs (it inspects the deterministic
 * verdict + the agent-declared state), transitions the session to
 * `awaiting_user`, cancels the 30-min timeout, and surfaces the question via
 * the task.delivery boundary. The owner replies over DM; the DevMode
 * interceptor resolves the open row and resumes the loop from the checkpoint.
 *
 * I/O-bound. Excluded from the coverage gate.
 */

import type Database from "better-sqlite3";

export type DevEscalationKind =
  | "spec_decision"
  | "architecture_decision"
  | "risk_approval"
  | "review_escalation"
  /** Acceptance-checklist human-method closure — the loop is done except for
   *  expectations only the owner can judge; the answer closes the rows. */
  | "human_verify";

export interface DevEscalationRow {
  id: string;
  sessionId: string;
  /** Task-scoped escalation pointer; null = session-scoped. */
  taskId: string | null;
  kind: DevEscalationKind;
  question: string;
  contextSummary: string | null;
  askedAt: number;
  deadlineAt: number | null;
  deliveredAt: number | null;
  answer: string | null;
  answeredAt: number | null;
  resolved: boolean;
  /** Serialization marker (WP3 P0-5). `false` (queued = 0) = ACTIVE: the one
   *  escalation currently delivered to the owner and answerable by a bare DM.
   *  `true` (queued = 1) = held behind the active one; promoted to active on
   *  the active one's resolve. At most one active per session at a time. */
  queued: boolean;
}

interface DevEscalationDbRow {
  id: string;
  session_id: string;
  task_id: string | null;
  kind: DevEscalationKind;
  question: string;
  context_summary: string | null;
  asked_at: number;
  deadline_at: number | null;
  delivered_at: number | null;
  answer: string | null;
  answered_at: number | null;
  resolved: number;
  queued: number;
}

const SELECT_COLUMNS = `id, session_id, task_id, kind, question, context_summary,
        asked_at, deadline_at, delivered_at, answer, answered_at, resolved, queued`;

function fromDbRow(row: DevEscalationDbRow): DevEscalationRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    kind: row.kind,
    question: row.question,
    contextSummary: row.context_summary,
    askedAt: row.asked_at,
    deadlineAt: row.deadline_at,
    deliveredAt: row.delivered_at,
    answer: row.answer,
    answeredAt: row.answered_at,
    resolved: row.resolved === 1,
    queued: row.queued === 1,
  };
}

export interface CreateDevEscalationInput {
  id: string;
  sessionId: string;
  /** Omitted/null = session-scoped escalation (dev-flow: a task-scoped
   *  question carries its dev_session_tasks id). */
  taskId?: string | null;
  kind: DevEscalationKind;
  question: string;
  contextSummary: string | null;
  askedAt: number;
  /** Optional soft deadline (informational only — never auto-enforced). */
  deadlineAt?: number | null;
}

export function createDevEscalation(
  db: Database.Database,
  input: CreateDevEscalationInput,
): DevEscalationRow {
  // Serialization (WP3 P0-5): the new escalation is ACTIVE (queued = 0) only
  // if the session has no other unresolved active escalation; otherwise it is
  // held (queued = 1) behind the current one. The EXISTS check + INSERT run
  // within one synchronous better-sqlite3 call, so two concurrent fleet
  // escalations cannot both observe "no active" and both claim active.
  const hasActive = db
    .prepare<[string], { one: number }>(
      `SELECT 1 AS one FROM dev_session_escalations
        WHERE session_id = ? AND resolved = 0 AND queued = 0
        LIMIT 1`,
    )
    .get(input.sessionId);
  const queued = hasActive ? 1 : 0;
  db.prepare(
    `INSERT INTO dev_session_escalations
       (id, session_id, task_id, kind, question, context_summary,
        asked_at, deadline_at, delivered_at, answer, answered_at, resolved, queued)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?)`,
  ).run(
    input.id,
    input.sessionId,
    input.taskId ?? null,
    input.kind,
    input.question,
    input.contextSummary,
    input.askedAt,
    input.deadlineAt ?? null,
    queued,
  );
  const row = getDevEscalation(db, input.id);
  if (!row) {
    throw new Error(
      `createDevEscalation: post-insert row for ${input.id} missing`,
    );
  }
  return row;
}

export function getDevEscalation(
  db: Database.Database,
  id: string,
): DevEscalationRow | null {
  const row = db
    .prepare<[string], DevEscalationDbRow>(
      `SELECT ${SELECT_COLUMNS} FROM dev_session_escalations WHERE id = ?`,
    )
    .get(id);
  return row ? fromDbRow(row) : null;
}

export function listDevEscalationsForSession(
  db: Database.Database,
  sessionId: string,
): readonly DevEscalationRow[] {
  const rows = db
    .prepare<[string], DevEscalationDbRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM dev_session_escalations
        WHERE session_id = ?
        ORDER BY asked_at ASC`,
    )
    .all(sessionId);
  return rows.map(fromDbRow);
}

/** The single ACTIVE (delivered, owner-facing) escalation — the one a bare DM
 *  reply (without an explicit id) resolves against. Serialization (WP3 P0-5)
 *  guarantees at most one row satisfies `resolved = 0 AND queued = 0` per
 *  session, so this is unambiguous; `ORDER BY asked_at ASC LIMIT 1` is a
 *  defensive tiebreak (oldest wins) should the invariant ever be violated. */
export function getOpenDevEscalationForSession(
  db: Database.Database,
  sessionId: string,
): DevEscalationRow | null {
  const row = db
    .prepare<[string], DevEscalationDbRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM dev_session_escalations
        WHERE session_id = ? AND resolved = 0 AND queued = 0
        ORDER BY asked_at ASC
        LIMIT 1`,
    )
    .get(sessionId);
  return row ? fromDbRow(row) : null;
}

export interface ResolveDevEscalationResult {
  ok: boolean;
  row: DevEscalationRow | null;
  reason?: "not_found" | "already_resolved";
  /** Serialization (WP3 P0-5): the escalation just promoted from queued to
   *  active by this resolve (the oldest still-held question for the session),
   *  or null if none were queued. The caller delivers it to the owner. */
  promoted: DevEscalationRow | null;
}

/** CAS-resolve an escalation with the owner's answer, then promote the oldest
 *  still-queued escalation for the same session to active (WP3 P0-5) so the
 *  owner is asked exactly one question at a time. Refuses only if already
 *  resolved (idempotent forwarding). Unlike a background-task clarification
 *  there is no deadline rejection — dev escalations do not expire. */
export function resolveDevEscalation(
  db: Database.Database,
  input: { id: string; answer: string; answeredAt: number },
): ResolveDevEscalationResult {
  const existing = getDevEscalation(db, input.id);
  if (!existing) return { ok: false, row: null, reason: "not_found", promoted: null };
  if (existing.resolved) {
    return { ok: false, row: existing, reason: "already_resolved", promoted: null };
  }
  const result = db
    .prepare(
      `UPDATE dev_session_escalations
          SET answer = ?, answered_at = ?, resolved = 1
        WHERE id = ? AND resolved = 0`,
    )
    .run(input.answer, input.answeredAt, input.id);
  if (result.changes === 0) {
    return {
      ok: false,
      row: getDevEscalation(db, input.id),
      reason: "already_resolved",
      promoted: null,
    };
  }
  const promoted = promoteNextQueuedEscalation(db, existing.sessionId);
  return { ok: true, row: getDevEscalation(db, input.id), promoted };
}

/** Promote the oldest still-queued escalation for a session to active
 *  (queued -> 0). Idempotent no-op when one is already active or none are
 *  queued. Returns the promoted row (for delivery) or null. */
function promoteNextQueuedEscalation(
  db: Database.Database,
  sessionId: string,
): DevEscalationRow | null {
  // Never promote past an already-active question (defensive; serialization
  // keeps at most one active, but a manual/legacy state must not double-ask).
  const active = db
    .prepare<[string], { one: number }>(
      `SELECT 1 AS one FROM dev_session_escalations
        WHERE session_id = ? AND resolved = 0 AND queued = 0
        LIMIT 1`,
    )
    .get(sessionId);
  if (active) return null;
  const next = db
    .prepare<[string], DevEscalationDbRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM dev_session_escalations
        WHERE session_id = ? AND resolved = 0 AND queued = 1
        ORDER BY asked_at ASC
        LIMIT 1`,
    )
    .get(sessionId);
  if (!next) return null;
  db.prepare(
    `UPDATE dev_session_escalations SET queued = 0 WHERE id = ?`,
  ).run(next.id);
  return getDevEscalation(db, next.id);
}

export function markDevEscalationDelivered(
  db: Database.Database,
  id: string,
  deliveredAt: number,
): DevEscalationRow | null {
  const result = db
    .prepare(
      `UPDATE dev_session_escalations
          SET delivered_at = COALESCE(delivered_at, ?)
        WHERE id = ?`,
    )
    .run(deliveredAt, id);
  return result.changes > 0 ? getDevEscalation(db, id) : null;
}

/** A recovery-sweep escalation enriched with the parent session's delivery
 *  fields (the list query INNER JOINs dev_sessions on state='awaiting_user',
 *  so these fold in without a second fetch). */
export interface UndeliveredDevEscalationRow extends DevEscalationRow {
  sessionOriginatingChannel: string | null;
  sessionOriginatingPlatform: string | null;
  sessionSlug: string | null;
}

/** Delivery recovery target — undelivered, ACTIVE (not still-queued) open
 *  escalations whose parent session is still live, joined with that session's
 *  delivery fields. No deadline filter (dev escalations never expire).
 *
 *  The session-state filter is `running` OR `awaiting_user` (WP3 P1-18): a
 *  fleet task escalation is raised WHILE the session is still 'running' (its
 *  siblings keep working and the session only parks once nothing can progress),
 *  so limiting to 'awaiting_user' would strand a task escalation whose first
 *  best-effort delivery threw until the whole fleet later parks — or forever if
 *  it never does. `queued = 0` keeps a still-held (not-yet-promoted) question
 *  from being delivered ahead of its turn. Terminal / pre-run states are still
 *  excluded — they have no legitimately-open owner question. */
export function listUndeliveredDevEscalations(
  db: Database.Database,
  limit = 20,
): readonly UndeliveredDevEscalationRow[] {
  const rows = db
    .prepare<
      [number],
      DevEscalationDbRow & {
        originating_channel: string | null;
        originating_platform: string | null;
        slug: string | null;
      }
    >(
      `SELECT e.id, e.session_id, e.task_id, e.kind, e.question,
              e.context_summary, e.asked_at, e.deadline_at, e.delivered_at,
              e.answer, e.answered_at, e.resolved, e.queued,
              s.originating_channel, s.originating_platform, s.slug
         FROM dev_session_escalations e
         JOIN dev_sessions s ON s.id = e.session_id
        WHERE e.resolved = 0
          AND e.queued = 0
          AND e.delivered_at IS NULL
          AND s.state IN ('running', 'awaiting_user')
        ORDER BY e.asked_at ASC
        LIMIT ?`,
    )
    .all(limit);
  return rows.map((row) => ({
    ...fromDbRow(row),
    sessionOriginatingChannel: row.originating_channel,
    sessionOriginatingPlatform: row.originating_platform,
    sessionSlug: row.slug,
  }));
}
