/**
 * Lite-final-confirm tokens — BROWSER_TASK_REDESIGN_PLAN.md §5 / §14.11.
 *
 * Parallel primitive to B-4's `browser-automation-purchase-tokens-store`.
 * The wire shape and CAS contract intentionally mirror the B-4 path so
 * the messaging adapter's `jti`-prefix dispatcher (§14.11 Q#6) can fan
 * a single inbound `!~xxxxxxxx` reply to whichever handler holds the
 * matching token — without coupling lite-final-confirm to B-4's purchase
 * site config, currency, or spend caps.
 *
 * I/O-bound. Excluded from the coverage gate; the pure mint / classify
 * helpers live in
 * `services/browser-history/automation/lite-final-confirm-tokens.ts`
 * and are 100% covered (mirror of `purchase-tokens.ts`).
 */

import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

export type LiteFinalConfirmTokenStatus =
  | "pending"
  | "confirmed"
  | "cancelled"
  | "expired";

export type LiteFinalConfirmCancelReason =
  | "user_reply"
  | "wrong_token"
  | "wrong_channel"
  | "timeout"
  | "explicit"
  | "task_cancelled"
  | "dashboard_cancel";

export interface LiteFinalConfirmTokenRow {
  jti: string;
  /** Raw `!~xxxxxxxx` while the row is in a state where redemption /
   *  audit cross-referencing needs the pre-image. NULL after the daily
   *  cleanup cron rotates terminal rows. */
  token: string | null;
  taskId: string;
  actionSummary: string;
  preScreenshotPath: string;
  deliveredChannels: readonly string[];
  issuedAt: number;
  expiresAt: number;
  consumedAt: number | null;
  consumedViaChannel: string | null;
  cancelledAt: number | null;
  cancelReason: LiteFinalConfirmCancelReason | null;
  status: LiteFinalConfirmTokenStatus;
}

interface LiteFinalConfirmTokenDbRow {
  jti: string;
  token: string | null;
  task_id: string;
  action_summary: string;
  pre_screenshot_path: string;
  delivered_channels: string;
  issued_at: number;
  expires_at: number;
  consumed_at: number | null;
  consumed_via_channel: string | null;
  cancelled_at: number | null;
  cancel_reason: LiteFinalConfirmCancelReason | null;
  status: LiteFinalConfirmTokenStatus;
}

function fromDbRow(row: LiteFinalConfirmTokenDbRow): LiteFinalConfirmTokenRow {
  let delivered: string[];
  try {
    const parsed = JSON.parse(row.delivered_channels) as unknown;
    delivered = Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    delivered = [];
  }
  return {
    jti: row.jti,
    token: row.token,
    taskId: row.task_id,
    actionSummary: row.action_summary,
    preScreenshotPath: row.pre_screenshot_path,
    deliveredChannels: delivered,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    consumedViaChannel: row.consumed_via_channel,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    status: row.status,
  };
}

export interface IssueLiteFinalConfirmTokenInput {
  jti?: string;
  token: string;
  taskId: string;
  actionSummary: string;
  preScreenshotPath: string;
  deliveredChannels: readonly string[];
  issuedAt: number;
  expiresAt: number;
}

export type IssueLiteFinalConfirmTokenResult =
  | { ok: true; row: LiteFinalConfirmTokenRow }
  | { ok: false; reason: "pending_exists"; pendingJti: string }
  | { ok: false; reason: "token_collision" };

/**
 * Atomic issuance — per-task concurrency 1. Rejects when another
 * pending token exists for the same task (two parallel final-confirm
 * gate trips would silently corrupt the round-trip).
 */
export function issueLiteFinalConfirmToken(
  db: Database.Database,
  input: IssueLiteFinalConfirmTokenInput,
): IssueLiteFinalConfirmTokenResult {
  const jti = input.jti ?? randomUUID();
  const txn = db.transaction((): IssueLiteFinalConfirmTokenResult => {
    const pendingRow = db
      .prepare<[string, number], { jti: string | null; c: number }>(
        `SELECT MIN(jti) AS jti, COUNT(*) AS c
           FROM browser_task_final_confirm_tokens
          WHERE task_id = ?
            AND status = 'pending'
            AND expires_at > ?`,
      )
      .get(input.taskId, input.issuedAt);
    if ((pendingRow?.c ?? 0) > 0) {
      return {
        ok: false,
        reason: "pending_exists",
        pendingJti: pendingRow?.jti ?? "",
      };
    }
    try {
      db.prepare(
        `INSERT INTO browser_task_final_confirm_tokens
           (jti, token, task_id, action_summary, pre_screenshot_path,
            delivered_channels, issued_at, expires_at,
            consumed_at, consumed_via_channel,
            cancelled_at, cancel_reason, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'pending')`,
      ).run(
        jti,
        input.token,
        input.taskId,
        input.actionSummary,
        input.preScreenshotPath,
        JSON.stringify([...input.deliveredChannels]),
        input.issuedAt,
        input.expiresAt,
      );
    } catch (err) {
      // Detect the token-column UNIQUE collision robustly: better-sqlite3
      // surfaces the SQLite extended code on the error object as `.code`,
      // and the message still names the specific column when the error is
      // a UNIQUE violation. Requiring both removes brittleness against
      // SQLite versions that reformat the message text while still
      // pinning the collision to the `token` column (not e.g. `jti`).
      const sqliteCode =
        err instanceof Error && "code" in err
          ? (err as { code?: unknown }).code
          : undefined;
      const message = err instanceof Error ? err.message : String(err);
      if (
        sqliteCode === "SQLITE_CONSTRAINT_UNIQUE" &&
        message.includes("browser_task_final_confirm_tokens.token")
      ) {
        return { ok: false, reason: "token_collision" };
      }
      throw err;
    }
    const inserted = getLiteFinalConfirmTokenByJti(db, jti);
    if (!inserted) {
      throw new Error("issueLiteFinalConfirmToken: post-insert row missing");
    }
    return { ok: true, row: inserted };
  });
  return txn();
}

export function getLiteFinalConfirmTokenByJti(
  db: Database.Database,
  jti: string,
): LiteFinalConfirmTokenRow | null {
  const row = db
    .prepare<[string], LiteFinalConfirmTokenDbRow>(
      `SELECT jti, token, task_id, action_summary, pre_screenshot_path,
              delivered_channels, issued_at, expires_at,
              consumed_at, consumed_via_channel,
              cancelled_at, cancel_reason, status
         FROM browser_task_final_confirm_tokens
        WHERE jti = ?`,
    )
    .get(jti);
  return row ? fromDbRow(row) : null;
}

export function getLiteFinalConfirmTokenByRaw(
  db: Database.Database,
  raw: string,
): LiteFinalConfirmTokenRow | null {
  const row = db
    .prepare<[string], LiteFinalConfirmTokenDbRow>(
      `SELECT jti, token, task_id, action_summary, pre_screenshot_path,
              delivered_channels, issued_at, expires_at,
              consumed_at, consumed_via_channel,
              cancelled_at, cancel_reason, status
         FROM browser_task_final_confirm_tokens
        WHERE token = ?`,
    )
    .get(raw);
  return row ? fromDbRow(row) : null;
}

export interface ConsumeLiteFinalConfirmTokenInput {
  jti: string;
  channelRef: string;
  consumedAt: number;
  nowMs: number;
}

/** CAS consume — atomic UPDATE guarded by status='pending' AND
 *  consumed_at IS NULL AND cancelled_at IS NULL AND expires_at >= now.
 *  Two concurrent replies on different channels cannot both win. */
export function consumeLiteFinalConfirmToken(
  db: Database.Database,
  input: ConsumeLiteFinalConfirmTokenInput,
): LiteFinalConfirmTokenRow | null {
  const result = db
    .prepare(
      `UPDATE browser_task_final_confirm_tokens
          SET status = 'confirmed',
              consumed_at = ?,
              consumed_via_channel = ?
        WHERE jti = ?
          AND status = 'pending'
          AND consumed_at IS NULL
          AND cancelled_at IS NULL
          AND expires_at >= ?`,
    )
    .run(input.consumedAt, input.channelRef, input.jti, input.nowMs);
  if (result.changes === 0) return null;
  return getLiteFinalConfirmTokenByJti(db, input.jti);
}

export interface CancelLiteFinalConfirmTokenInput {
  jti: string;
  reason: LiteFinalConfirmCancelReason;
  cancelledAt: number;
  /** When true, refuse to cancel a row that has already been consumed. */
  onlyIfPending: boolean;
}

export function cancelLiteFinalConfirmToken(
  db: Database.Database,
  input: CancelLiteFinalConfirmTokenInput,
): LiteFinalConfirmTokenRow | null {
  const sql = input.onlyIfPending
    ? `UPDATE browser_task_final_confirm_tokens
         SET status = 'cancelled',
             cancelled_at = ?,
             cancel_reason = ?
       WHERE jti = ?
         AND status = 'pending'
         AND consumed_at IS NULL
         AND cancelled_at IS NULL`
    : `UPDATE browser_task_final_confirm_tokens
         SET status = 'cancelled',
             cancelled_at = ?,
             cancel_reason = ?
       WHERE jti = ?
         AND status IN ('pending')
         AND cancelled_at IS NULL`;
  const result = db
    .prepare(sql)
    .run(input.cancelledAt, input.reason, input.jti);
  if (result.changes === 0) return null;
  return getLiteFinalConfirmTokenByJti(db, input.jti);
}

/** Pending tokens whose `delivered_channels` JSON contains the given
 *  channel ref. Used by the non-token-reply strict-cancel path. */
export function listPendingLiteFinalConfirmTokensForChannel(
  db: Database.Database,
  channelRef: string,
  nowMs: number,
): readonly LiteFinalConfirmTokenRow[] {
  // SQLite's JSON1 `json_each` lets the index walk row-by-row; for
  // the small in-flight set (≤ browserTaskMaxConcurrent rows) the
  // straightforward "load and filter in JS" is the simpler shape.
  const rows = db
    .prepare<[number], LiteFinalConfirmTokenDbRow>(
      `SELECT jti, token, task_id, action_summary, pre_screenshot_path,
              delivered_channels, issued_at, expires_at,
              consumed_at, consumed_via_channel,
              cancelled_at, cancel_reason, status
         FROM browser_task_final_confirm_tokens
        WHERE status = 'pending'
          AND consumed_at IS NULL
          AND cancelled_at IS NULL
          AND expires_at > ?`,
    )
    .all(nowMs);
  return rows
    .map(fromDbRow)
    .filter((r) => r.deliveredChannels.includes(channelRef));
}

export function listPendingLiteFinalConfirmTokens(
  db: Database.Database,
  nowMs: number,
  limit = 32,
): readonly LiteFinalConfirmTokenRow[] {
  const rows = db
    .prepare<[number, number], LiteFinalConfirmTokenDbRow>(
      `SELECT jti, token, task_id, action_summary, pre_screenshot_path,
              delivered_channels, issued_at, expires_at,
              consumed_at, consumed_via_channel,
              cancelled_at, cancel_reason, status
         FROM browser_task_final_confirm_tokens
        WHERE status = 'pending'
          AND consumed_at IS NULL
          AND cancelled_at IS NULL
          AND expires_at > ?
        ORDER BY issued_at DESC
        LIMIT ?`,
    )
    .all(nowMs, limit);
  return rows.map(fromDbRow);
}

/**
 * Retention sweep helpers — mirror the B-4 trio in
 * `browser-automation-purchase-tokens-store.ts`. Three passes match the
 * BROWSER_TASK_REDESIGN_PLAN.md §6.5 "Phase 6.5 deferred follow-up" + §14.7
 * posture:
 *   1. `expireStaleLiteFinalConfirmTokens` — flip past-TTL pending rows to
 *      `expired` so a daemon restart or runner stall does not leave a
 *      pending row behind the dashboard's "Pending tokens" view.
 *   2. `scrubRotatedLiteFinalConfirmTokens` — set `token = NULL` on
 *      terminal rows older than `cutoffMs`. Reduces at-rest raw-token
 *      footprint, matching B-4's
 *      `browserAutomationPurchaseTokenScrub: 1` day window.
 *
 * No counterpart to B-4's `sweepOrphanedConsumedPurchaseTokens` is
 * needed: the lite token's contract is single-use CAS at consume time —
 * there is no separate "consumed but not finalized" window. The driver
 * either confirms (status -> 'confirmed', cancel_reason NULL) or the
 * confirm path bails and cancels the row directly.
 */
export function expireStaleLiteFinalConfirmTokens(
  db: Database.Database,
  nowMs: number,
): readonly LiteFinalConfirmTokenRow[] {
  const ids = db
    .prepare<[number], { jti: string }>(
      `SELECT jti
         FROM browser_task_final_confirm_tokens
        WHERE status = 'pending'
          AND consumed_at IS NULL
          AND cancelled_at IS NULL
          AND expires_at < ?`,
    )
    .all(nowMs)
    .map((row) => row.jti);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE browser_task_final_confirm_tokens
        SET status = 'expired',
            cancelled_at = ?,
            cancel_reason = 'timeout'
      WHERE jti IN (${placeholders})`,
  ).run(nowMs, ...ids);
  return ids
    .map((id) => getLiteFinalConfirmTokenByJti(db, id))
    .filter((row): row is LiteFinalConfirmTokenRow => row !== null);
}

export function scrubRotatedLiteFinalConfirmTokens(
  db: Database.Database,
  cutoffMs: number,
): number {
  const result = db
    .prepare(
      `UPDATE browser_task_final_confirm_tokens
          SET token = NULL
        WHERE token IS NOT NULL
          AND status IN ('confirmed', 'cancelled', 'expired')
          AND COALESCE(consumed_at, cancelled_at, issued_at) < ?`,
    )
    .run(cutoffMs);
  return result.changes;
}
