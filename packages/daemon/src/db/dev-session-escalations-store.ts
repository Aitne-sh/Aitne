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
  | "review_escalation";

export interface DevEscalationRow {
  id: string;
  sessionId: string;
  kind: DevEscalationKind;
  question: string;
  contextSummary: string | null;
  askedAt: number;
  deadlineAt: number | null;
  deliveredAt: number | null;
  answer: string | null;
  answeredAt: number | null;
  resolved: boolean;
}

interface DevEscalationDbRow {
  id: string;
  session_id: string;
  kind: DevEscalationKind;
  question: string;
  context_summary: string | null;
  asked_at: number;
  deadline_at: number | null;
  delivered_at: number | null;
  answer: string | null;
  answered_at: number | null;
  resolved: number;
}

const SELECT_COLUMNS = `id, session_id, kind, question, context_summary,
        asked_at, deadline_at, delivered_at, answer, answered_at, resolved`;

function fromDbRow(row: DevEscalationDbRow): DevEscalationRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    question: row.question,
    contextSummary: row.context_summary,
    askedAt: row.asked_at,
    deadlineAt: row.deadline_at,
    deliveredAt: row.delivered_at,
    answer: row.answer,
    answeredAt: row.answered_at,
    resolved: row.resolved === 1,
  };
}

export interface CreateDevEscalationInput {
  id: string;
  sessionId: string;
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
  db.prepare(
    `INSERT INTO dev_session_escalations
       (id, session_id, kind, question, context_summary,
        asked_at, deadline_at, delivered_at, answer, answered_at, resolved)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0)`,
  ).run(
    input.id,
    input.sessionId,
    input.kind,
    input.question,
    input.contextSummary,
    input.askedAt,
    input.deadlineAt ?? null,
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

/** The most-recent unresolved escalation — the one a DM reply (without an
 *  explicit id) resolves against. */
export function getOpenDevEscalationForSession(
  db: Database.Database,
  sessionId: string,
): DevEscalationRow | null {
  const row = db
    .prepare<[string], DevEscalationDbRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM dev_session_escalations
        WHERE session_id = ? AND resolved = 0
        ORDER BY asked_at DESC
        LIMIT 1`,
    )
    .get(sessionId);
  return row ? fromDbRow(row) : null;
}

export interface ResolveDevEscalationResult {
  ok: boolean;
  row: DevEscalationRow | null;
  reason?: "not_found" | "already_resolved";
}

/** CAS-resolve an escalation with the owner's answer. Refuses only if
 *  already resolved (idempotent forwarding). Unlike a background-task
 *  clarification there is no deadline rejection — dev escalations do not
 *  expire. */
export function resolveDevEscalation(
  db: Database.Database,
  input: { id: string; answer: string; answeredAt: number },
): ResolveDevEscalationResult {
  const existing = getDevEscalation(db, input.id);
  if (!existing) return { ok: false, row: null, reason: "not_found" };
  if (existing.resolved) {
    return { ok: false, row: existing, reason: "already_resolved" };
  }
  const result = db
    .prepare(
      `UPDATE dev_session_escalations
          SET answer = ?, answered_at = ?, resolved = 1
        WHERE id = ? AND resolved = 0`,
    )
    .run(input.answer, input.answeredAt, input.id);
  if (result.changes === 0) {
    return { ok: false, row: getDevEscalation(db, input.id), reason: "already_resolved" };
  }
  return { ok: true, row: getDevEscalation(db, input.id) };
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

/** Delivery recovery target — undelivered, still-open escalations whose
 *  parent session is parked, joined with that session's delivery fields.
 *  No deadline filter (dev escalations never expire). */
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
      `SELECT e.id, e.session_id, e.kind, e.question, e.context_summary,
              e.asked_at, e.deadline_at, e.delivered_at,
              e.answer, e.answered_at, e.resolved,
              s.originating_channel, s.originating_platform, s.slug
         FROM dev_session_escalations e
         JOIN dev_sessions s ON s.id = e.session_id
        WHERE e.resolved = 0
          AND e.delivered_at IS NULL
          AND s.state = 'awaiting_user'
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
