/**
 * Browser Automation Approvals — Phase B-3 single-use, 5-min-TTL
 * approval gate. Typed read / write helpers for the
 * `browser_automation_approvals` table.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §10 / §13 steps 43-46.
 *
 * The store is intentionally pure-SQL — no Zod validation, no clock,
 * no defaulting. The API route layer Zod-validates inbound payloads;
 * the workflow runner enforces the atomic CAS at consume time; the
 * pure helpers in `approval-tokens.ts` handle token shape /
 * hashing / categorisation. Keeping this thin lets the coverage gate
 * hold on the schema's CHECK constraints (the safety floor) rather
 * than on Node-side guard code that would drift.
 *
 * Excluded from the 100% coverage gate — the file is pure SQL prepared
 * statements and the SQL behaviour itself is exercised by integration
 * tests through the runner + route layers. Pure logic in
 * `approval-tokens.ts` is the covered surface.
 */

import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { BrowserAutomationApprovalOrigin } from "@aitne/shared";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "consumed"
  | "denied"
  | "expired";

export interface ApprovalRow {
  id: string;
  workflowName: string;
  paramsHash: string;
  paramsSummary: string;
  origin: BrowserAutomationApprovalOrigin;
  status: ApprovalStatus;
  requestedAt: number;
  expiresAt: number;
  tokenHash: string | null;
  approvedAt: number | null;
  consumedAt: number | null;
  deniedAt: number | null;
  denialReason: string | null;
}

interface ApprovalDbRow {
  id: string;
  workflow_name: string;
  params_hash: string;
  params_summary: string;
  origin: BrowserAutomationApprovalOrigin;
  status: ApprovalStatus;
  requested_at: number;
  expires_at: number;
  token_hash: string | null;
  approved_at: number | null;
  consumed_at: number | null;
  denied_at: number | null;
  denial_reason: string | null;
}

function fromDbRow(row: ApprovalDbRow): ApprovalRow {
  return {
    id: row.id,
    workflowName: row.workflow_name,
    paramsHash: row.params_hash,
    paramsSummary: row.params_summary,
    origin: row.origin,
    status: row.status,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    tokenHash: row.token_hash,
    approvedAt: row.approved_at,
    consumedAt: row.consumed_at,
    deniedAt: row.denied_at,
    denialReason: row.denial_reason,
  };
}

const PARAMS_SUMMARY_MAX_BYTES = 8 * 1024;

/** Truncate the params snapshot to 8 KB so a degenerate workflow
 *  input (e.g., a giant URL) cannot bloat the approvals table. The
 *  hash is the load-bearing field for redemption — the summary is
 *  purely for the dashboard's "approve subscribeToNewsletter for
 *  https://...?" UX. */
export function truncateParamsSummary(value: unknown): string {
  let serialised: string;
  try {
    serialised = JSON.stringify(value);
  } catch {
    serialised = String(value);
  }
  if (typeof serialised !== "string") serialised = "";
  if (serialised.length <= PARAMS_SUMMARY_MAX_BYTES) return serialised;
  return `${serialised.slice(0, PARAMS_SUMMARY_MAX_BYTES - 1)}…`;
}

export interface CreateApprovalRequestInput {
  workflowName: string;
  paramsHash: string;
  paramsSummary: string;
  origin: BrowserAutomationApprovalOrigin;
  requestedAt: number;
  expiresAt: number;
}

/**
 * Insert a fresh `pending` row. Returns the generated UUID id so the
 * runner can carry it back to the caller in the `needs_approval`
 * response. Idempotency is NOT enforced here: a caller that fires the
 * same workflow twice gets two pending rows. The dashboard surfaces
 * both; the user picks which one to approve (typically the most
 * recent).
 */
export function createApprovalRequest(
  db: Database.Database,
  input: CreateApprovalRequestInput,
): ApprovalRow {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO browser_automation_approvals
       (id, workflow_name, params_hash, params_summary, origin,
        status, requested_at, expires_at,
        token_hash, approved_at, consumed_at, denied_at, denial_reason)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, NULL, NULL)`,
  ).run(
    id,
    input.workflowName,
    input.paramsHash,
    input.paramsSummary,
    input.origin,
    input.requestedAt,
    input.expiresAt,
  );
  const row = db
    .prepare(
      `SELECT id, workflow_name, params_hash, params_summary, origin,
              status, requested_at, expires_at,
              token_hash, approved_at, consumed_at, denied_at, denial_reason
         FROM browser_automation_approvals
        WHERE id = ?`,
    )
    .get(id) as ApprovalDbRow;
  return fromDbRow(row);
}

export function getApprovalById(
  db: Database.Database,
  id: string,
): ApprovalRow | null {
  const row = db
    .prepare(
      `SELECT id, workflow_name, params_hash, params_summary, origin,
              status, requested_at, expires_at,
              token_hash, approved_at, consumed_at, denied_at, denial_reason
         FROM browser_automation_approvals
        WHERE id = ?`,
    )
    .get(id) as ApprovalDbRow | undefined;
  return row ? fromDbRow(row) : null;
}

export function listPendingApprovals(
  db: Database.Database,
  nowMs: number,
  limit = 64,
): ApprovalRow[] {
  const cap = Math.max(1, Math.min(64, Math.floor(limit)));
  const rows = db
    .prepare(
      `SELECT id, workflow_name, params_hash, params_summary, origin,
              status, requested_at, expires_at,
              token_hash, approved_at, consumed_at, denied_at, denial_reason
         FROM browser_automation_approvals
        WHERE status = 'pending' AND expires_at > ?
        ORDER BY requested_at DESC
        LIMIT ?`,
    )
    .all(nowMs, cap) as ApprovalDbRow[];
  return rows.map(fromDbRow);
}

export function listRecentApprovals(
  db: Database.Database,
  limit = 50,
): ApprovalRow[] {
  const cap = Math.max(1, Math.min(50, Math.floor(limit)));
  const rows = db
    .prepare(
      `SELECT id, workflow_name, params_hash, params_summary, origin,
              status, requested_at, expires_at,
              token_hash, approved_at, consumed_at, denied_at, denial_reason
         FROM browser_automation_approvals
        WHERE status IN ('approved', 'consumed', 'denied', 'expired')
        ORDER BY
          COALESCE(consumed_at, denied_at, approved_at, requested_at) DESC
        LIMIT ?`,
    )
    .all(cap) as ApprovalDbRow[];
  return rows.map(fromDbRow);
}

export interface ApproveApprovalInput {
  id: string;
  tokenHash: string;
  approvedAt: number;
  /** Fresh deadline applied to the row on approve. The spec defines the
   *  "5-min TTL approval token" as the lifetime of the minted token —
   *  measured from approval, not from the original request. The route
   *  layer computes this via `computeApprovalExpiry(approvedAt)` so the
   *  agent always gets the full TTL to redeem regardless of how long
   *  the user took to triage in the dashboard. */
  newExpiresAt: number;
  /** Caller's wall clock; we use it to verify expires_at > nowMs so a
   *  stale pending row cannot be approved-then-immediately-expired. */
  nowMs: number;
}

/**
 * Atomic UPDATE on a `pending` row → `approved`. Returns the post-
 * update row on success, null when the row was missing, already
 * terminal, or expired. The CHECK on `status` (in schema.ts) is the
 * structural defence; this query layers the CAS on top.
 *
 * On success the row's `expires_at` is rewritten to `newExpiresAt`
 * (typically `approvedAt + APPROVAL_TTL_MS`) so the minted token has a
 * full TTL from issuance. Without this, a row approved late in the
 * pending window would give the agent only a few seconds to redeem.
 */
export function approveApproval(
  db: Database.Database,
  input: ApproveApprovalInput,
): ApprovalRow | null {
  const result = db
    .prepare(
      `UPDATE browser_automation_approvals
         SET status = 'approved',
             token_hash = ?,
             approved_at = ?,
             expires_at = ?
       WHERE id = ?
         AND status = 'pending'
         AND expires_at > ?`,
    )
    .run(
      input.tokenHash,
      input.approvedAt,
      input.newExpiresAt,
      input.id,
      input.nowMs,
    );
  if (result.changes === 0) return null;
  return getApprovalById(db, input.id);
}

export interface DenyApprovalInput {
  id: string;
  reason: string | null;
  deniedAt: number;
}

/**
 * Atomic UPDATE: `pending` → `denied`. Permitted regardless of
 * `expires_at` since the user may be triaging old pending rows and
 * we want an explicit denial trail even when the TTL has elapsed.
 * Returns null when the row was missing or already terminal.
 */
export function denyApproval(
  db: Database.Database,
  input: DenyApprovalInput,
): ApprovalRow | null {
  const result = db
    .prepare(
      `UPDATE browser_automation_approvals
         SET status = 'denied',
             denied_at = ?,
             denial_reason = ?
       WHERE id = ?
         AND status = 'pending'`,
    )
    .run(input.deniedAt, input.reason, input.id);
  if (result.changes === 0) return null;
  return getApprovalById(db, input.id);
}

export interface ConsumeApprovalInput {
  id: string;
  tokenHash: string;
  workflowName: string;
  paramsHash: string;
  consumedAt: number;
  /** Caller's wall clock — drives the `expires_at > nowMs` predicate. */
  nowMs: number;
}

/**
 * Atomic UPDATE: `approved` → `consumed`. Returns the post-update row
 * on success, null when any guard failed (row missing, wrong status,
 * expired, workflow / params binding mismatch, or token-hash
 * mismatch). The runner upstream calls `classifyApprovalValidation`
 * for richer detail; this query is the structural CAS that prevents
 * double-spend, race conditions, and binding violations.
 *
 * The single-statement atomicity is what makes the gate safe: even if
 * two concurrent workflow invocations race to consume the same
 * approval, exactly one UPDATE will see `status = 'approved'` and the
 * other will see `status = 'consumed'` (or `'pending'`, depending on
 * scheduling) and fail to acquire.
 */
export function consumeApproval(
  db: Database.Database,
  input: ConsumeApprovalInput,
): ApprovalRow | null {
  const result = db
    .prepare(
      `UPDATE browser_automation_approvals
         SET status = 'consumed',
             consumed_at = ?
       WHERE id = ?
         AND status = 'approved'
         AND expires_at > ?
         AND token_hash = ?
         AND workflow_name = ?
         AND params_hash = ?`,
    )
    .run(
      input.consumedAt,
      input.id,
      input.nowMs,
      input.tokenHash,
      input.workflowName,
      input.paramsHash,
    );
  if (result.changes === 0) return null;
  return getApprovalById(db, input.id);
}

/**
 * Look up the (single) approved row whose token-hash matches. Returns
 * `null` when no row matches — defence against a token-shape replay
 * where the agent submits a stale hash that no longer maps to an
 * approved row.
 */
export function findApprovedRowByTokenHash(
  db: Database.Database,
  tokenHash: string,
): ApprovalRow | null {
  const row = db
    .prepare(
      `SELECT id, workflow_name, params_hash, params_summary, origin,
              status, requested_at, expires_at,
              token_hash, approved_at, consumed_at, denied_at, denial_reason
         FROM browser_automation_approvals
        WHERE token_hash = ? AND status = 'approved'
        LIMIT 1`,
    )
    .get(tokenHash) as ApprovalDbRow | undefined;
  return row ? fromDbRow(row) : null;
}

/**
 * Mark every pending / approved row whose `expires_at` is < `nowMs`
 * as `expired`. Returns the number of rows flipped. Called by the
 * retention sweep (src/core/retention.ts) so the dashboard's pending
 * panel stays accurate without per-request server-side filtering.
 *
 * `approved` rows also expire — even after the dashboard issued a
 * token, if the agent never redeemed it within the TTL the token is
 * useless and the row should land in the terminal-expired bucket.
 */
export function expireStaleApprovals(
  db: Database.Database,
  nowMs: number,
): number {
  const result = db
    .prepare(
      `UPDATE browser_automation_approvals
         SET status = 'expired'
       WHERE status IN ('pending', 'approved')
         AND expires_at < ?`,
    )
    .run(nowMs);
  return result.changes;
}

/**
 * Rotate `token_hash` to NULL for terminal rows older than the cutoff.
 * Reduces the at-rest footprint of even the hashed token after
 * redemption. Called by the retention sweep after the expire-stale
 * pass.
 */
export function scrubConsumedTokenHashes(
  db: Database.Database,
  consumedBeforeMs: number,
): number {
  const result = db
    .prepare(
      `UPDATE browser_automation_approvals
         SET token_hash = NULL
       WHERE token_hash IS NOT NULL
         AND status IN ('consumed', 'denied', 'expired')
         AND COALESCE(consumed_at, denied_at, approved_at, requested_at) < ?`,
    )
    .run(consumedBeforeMs);
  return result.changes;
}

/**
 * Delete terminal rows whose newest timestamp is older than `cutoffMs`.
 * Caps the table size — without this, the audit history grows
 * unbounded.
 */
export function deleteApprovalsOlderThan(
  db: Database.Database,
  cutoffMs: number,
): number {
  const result = db
    .prepare(
      `DELETE FROM browser_automation_approvals
        WHERE status IN ('consumed', 'denied', 'expired')
          AND COALESCE(consumed_at, denied_at, approved_at, requested_at) < ?`,
    )
    .run(cutoffMs);
  return result.changes;
}
