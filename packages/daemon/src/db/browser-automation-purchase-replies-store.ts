/**
 * Browser Automation Purchase Replies — Phase B-4 audit trail for every
 * inbound `!~xxxxxxxx`-shaped reply.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.6 / §13 steps 51, 60.
 *
 * Each row records:
 *   - `received_at` — epoch ms
 *   - `channel_ref` — `<platform>:<channel_id>`
 *   - `message_body_hash` — sha256 of the raw inbound body (NOT the
 *     parsed token; gives the dashboard's replay-analysis view a stable
 *     dedup key without persisting the secret)
 *   - `matched_jti` — non-null when the lookup found a row, null on
 *     `shape_invalid` / `no_match`
 *   - `outcome` — categorical decision the adapter handler emitted
 *
 * Row retention: pruned by the daily cleanup cron (§13 step 60) after
 * 90 days. Older audit rows live in the dashboard's audit-export
 * surface; this table caps growth.
 *
 * Excluded from the 100% coverage gate — prepared statements only; the
 * decision logic that drives `outcome` lives in `purchase-tokens.ts` and
 * is the covered surface.
 */

import type Database from "better-sqlite3";

export type PurchaseReplyOutcome =
  | "consumed"
  | "wrong_channel"
  | "expired"
  | "already_consumed"
  | "already_cancelled"
  | "no_match"
  | "cancel_workflow"
  | "shape_invalid";

export interface PurchaseReplyRow {
  id: number;
  receivedAt: number;
  channelRef: string;
  messageBodyHash: string;
  matchedJti: string | null;
  outcome: PurchaseReplyOutcome;
}

interface PurchaseReplyDbRow {
  id: number;
  received_at: number;
  channel_ref: string;
  message_body_hash: string;
  matched_jti: string | null;
  outcome: PurchaseReplyOutcome;
}

function fromDbRow(row: PurchaseReplyDbRow): PurchaseReplyRow {
  return {
    id: row.id,
    receivedAt: row.received_at,
    channelRef: row.channel_ref,
    messageBodyHash: row.message_body_hash,
    matchedJti: row.matched_jti,
    outcome: row.outcome,
  };
}

export interface InsertPurchaseReplyInput {
  receivedAt: number;
  channelRef: string;
  messageBodyHash: string;
  matchedJti: string | null;
  outcome: PurchaseReplyOutcome;
}

export function insertPurchaseReply(
  db: Database.Database,
  input: InsertPurchaseReplyInput,
): PurchaseReplyRow {
  const result = db
    .prepare(
      `INSERT INTO browser_automation_purchase_replies
         (received_at, channel_ref, message_body_hash, matched_jti, outcome)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.receivedAt,
      input.channelRef,
      input.messageBodyHash,
      input.matchedJti,
      input.outcome,
    );
  const row = db
    .prepare<[number], PurchaseReplyDbRow>(
      `SELECT id, received_at, channel_ref, message_body_hash, matched_jti, outcome
         FROM browser_automation_purchase_replies
        WHERE id = ?`,
    )
    .get(Number(result.lastInsertRowid));
  if (!row) {
    throw new Error("insertPurchaseReply: post-insert lookup missing");
  }
  return fromDbRow(row);
}

export function listRecentPurchaseReplies(
  db: Database.Database,
  limit = 100,
): PurchaseReplyRow[] {
  const cap = Math.max(1, Math.min(500, Math.floor(limit)));
  const rows = db
    .prepare<[number], PurchaseReplyDbRow>(
      `SELECT id, received_at, channel_ref, message_body_hash, matched_jti, outcome
         FROM browser_automation_purchase_replies
        ORDER BY received_at DESC
        LIMIT ?`,
    )
    .all(cap);
  return rows.map(fromDbRow);
}

/**
 * Prune audit rows older than `cutoffMs`. Default retention is 90
 * days; the caller (retention sweep) supplies the precise cutoff.
 */
export function deletePurchaseRepliesOlderThan(
  db: Database.Database,
  cutoffMs: number,
): number {
  const result = db
    .prepare(
      `DELETE FROM browser_automation_purchase_replies
        WHERE received_at < ?`,
    )
    .run(cutoffMs);
  return result.changes;
}
