/**
 * IMAP deletion-reconciliation planner (Phase 7, §3.1.1).
 *
 * The poll path cannot detect deletions on IMAP servers without QRESYNC
 * because `pollSince()` only walks UIDs strictly greater than the cursor
 * watermark. The reconcile job periodically re-lists UIDs in each folder and
 * diffs them against the local index so rows for messages the user has moved
 * or deleted get soft-flagged.
 *
 * This module is pure logic only — it does not talk to IMAP or SQLite. It
 * takes the parsed local provider_msg_ids and the server-reported UID set
 * for a folder and returns a list of missing ids. The I/O layer
 * (`observers/mail-reconciliation.ts`) calls ImapFlow and writes SQLite.
 */

import { parseImapProviderMsgId } from "./cursor.js";

export interface LocalIndexedMessage {
  providerMsgId: string;
  receivedAtUtc: string;
}

export interface ReconcilePlanInput {
  /** UIDVALIDITY the server reported for this folder on the live connection. */
  serverUidValidity: number;
  /** Full set of UIDs the server just reported for the folder. */
  serverUids: Iterable<number>;
  /**
   * Local rows for this `(account_id, folder)`, filtered to live rows
   * (`deleted_at_utc IS NULL`). Caller applies the live filter.
   */
  localMessages: Iterable<LocalIndexedMessage>;
  /**
   * Lower bound on the UID range the reconcile pass covered. Local rows with
   * a UID strictly below this are ignored (they are outside the pass's
   * attention window and we have no evidence about them this tick). Passing
   * `0` means "the entire folder was walked".
   */
  minUidWalked: number;
}

export interface ReconcilePlan {
  /**
   * provider_msg_ids that exist locally but not on the server — caller sets
   * `deleted_at_utc` on these.
   */
  missingIds: string[];
  /**
   * Rows whose `providerMsgId` could not be parsed, or whose UIDVALIDITY
   * segment did not match the server's current UIDVALIDITY. Callers should
   * leave these alone — they belong to a prior UIDVALIDITY epoch and the
   * poll path's resync branch is the right place to handle them.
   */
  skippedIds: string[];
}

/**
 * Compute which local rows are missing from the server's UID listing.
 * Deterministic and side-effect-free.
 */
export function planImapReconcile(
  input: ReconcilePlanInput,
): ReconcilePlan {
  const serverSet = new Set<number>();
  for (const uid of input.serverUids) {
    if (Number.isInteger(uid) && uid > 0) serverSet.add(uid);
  }

  const missingIds: string[] = [];
  const skippedIds: string[] = [];

  for (const row of input.localMessages) {
    const parsed = parseImapProviderMsgId(row.providerMsgId);
    if (!parsed) {
      // Legacy or non-IMAP id — outside this planner's contract.
      skippedIds.push(row.providerMsgId);
      continue;
    }
    if (parsed.uidValidity !== input.serverUidValidity) {
      // Different epoch; the poll path handles UIDVALIDITY mismatch via full
      // folder resync (§5). Don't declare these deleted.
      skippedIds.push(row.providerMsgId);
      continue;
    }
    if (parsed.uid < input.minUidWalked) {
      // Outside the window the server listing covers — no evidence.
      skippedIds.push(row.providerMsgId);
      continue;
    }
    if (!serverSet.has(parsed.uid)) {
      missingIds.push(row.providerMsgId);
    }
  }

  return { missingIds, skippedIds };
}
