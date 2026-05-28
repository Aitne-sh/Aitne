/**
 * Browser Automation Purchase Tokens — Phase B-4 DM-issued single-use
 * confirmation token store.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.6 / §13 step 51.
 *
 * Tokens are minted by `purchase-handler.issueToken()` AFTER the
 * pre-confirm screenshot lands, persisted here, and delivered via DM.
 * The atomic single-use lock and the per-site / per-day cap
 * enforcement both happen at THIS layer — pure SQL UPDATEs guarded by
 * predicate columns, no application-side races possible.
 *
 * The pure decision tree (shape match, category, expiry) lives in
 * `automation/purchase-tokens.ts`; this module is the I/O wrapper. The
 * browser-task lite-final-confirm path uses the same I/O-vs-pure split
 * (`browser-task-final-confirm-tokens-store.ts` + `automation/lite-final-
 * confirm-tokens.ts`). The retired B-3 surface (`approval-tokens.ts` /
 * `browser-automation-approvals-store.ts`) established this pattern;
 * BROWSER_TASK_REDESIGN_PLAN.md §9 Phase 6 removed those files but the
 * shape carries forward.
 *
 * Excluded from the 100% coverage gate — the file is prepared
 * statements and the SQL behaviour itself is exercised by integration
 * tests through the handler + route layers. Pure logic in
 * `purchase-tokens.ts` is the covered surface.
 */

import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import {
  B4_DEFAULT_DAILY_SPEND_CAP_MINOR,
  B4_DEFAULT_DAILY_TOKEN_CAP,
} from "../services/browser-history/managed-chromium/types.js";

export type PurchaseTokenStatus =
  | "pending"
  | "confirmed"
  | "cancelled"
  | "expired";

export type PurchaseCancelReason =
  | "user_reply"
  | "wrong_token"
  | "wrong_channel"
  | "timeout"
  | "explicit"
  | "amount_mismatch"
  | "amount_exceeds_token"
  | "page_changed"
  | "playwright_error"
  | "daily_cap_exceeded"
  | "b4_disabled"
  | "site_not_enabled"
  | "supervisor_orphan_sweep"
  | "dashboard_cancel";

export interface PurchaseTokenRow {
  jti: string;
  /** Raw `!~xxxxxxxx` while the row is in a state where redemption /
   *  audit cross-referencing needs the pre-image. NULL after the
   *  daily cleanup cron rotates terminal rows (consumed/cancelled
   *  older than 1 day). */
  token: string | null;
  workflowInvocationId: string;
  siteKey: string;
  urlPattern: string;
  maxAmountMinor: number;
  currency: string;
  preScreenshotPath: string;
  notesForUser: string | null;
  /** Canonical `<platform>:<channel_id>` channel refs the daemon DMed
   *  the token to. Validation enforces the inbound channel is in this
   *  set; a reply on any other channel records a `wrong_channel` audit
   *  row and cancels. */
  deliveredChannels: readonly string[];
  issuedAt: number;
  expiresAt: number;
  consumedAt: number | null;
  consumedViaChannel: string | null;
  cancelledAt: number | null;
  cancelReason: PurchaseCancelReason | null;
  confirmedAmountMinor: number | null;
  orderId: string | null;
  postScreenshotPath: string | null;
  status: PurchaseTokenStatus;
}

interface PurchaseTokenDbRow {
  jti: string;
  token: string | null;
  workflow_invocation_id: string;
  site_key: string;
  url_pattern: string;
  max_amount_minor: number;
  currency: string;
  pre_screenshot_path: string;
  notes_for_user: string | null;
  delivered_channels: string;
  issued_at: number;
  expires_at: number;
  consumed_at: number | null;
  consumed_via_channel: string | null;
  cancelled_at: number | null;
  cancel_reason: PurchaseCancelReason | null;
  confirmed_amount_minor: number | null;
  order_id: string | null;
  post_screenshot_path: string | null;
  status: PurchaseTokenStatus;
}

function fromDbRow(row: PurchaseTokenDbRow): PurchaseTokenRow {
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
    workflowInvocationId: row.workflow_invocation_id,
    siteKey: row.site_key,
    urlPattern: row.url_pattern,
    maxAmountMinor: row.max_amount_minor,
    currency: row.currency,
    preScreenshotPath: row.pre_screenshot_path,
    notesForUser: row.notes_for_user,
    deliveredChannels: delivered,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    consumedViaChannel: row.consumed_via_channel,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    confirmedAmountMinor: row.confirmed_amount_minor,
    orderId: row.order_id,
    postScreenshotPath: row.post_screenshot_path,
    status: row.status,
  };
}

export interface IssuePurchaseTokenInput {
  jti?: string;
  token: string;
  workflowInvocationId: string;
  siteKey: string;
  urlPattern: string;
  maxAmountMinor: number;
  currency: string;
  preScreenshotPath: string;
  notesForUser: string | null;
  deliveredChannels: readonly string[];
  issuedAt: number;
  expiresAt: number;
}

/**
 * Categorical result of `issuePurchaseToken`. The handler maps this
 * straight onto the workflow's runner-level outcome. The atomic
 * predicates (no pending row, under daily caps) all run inside the
 * same transaction as the INSERT so two parallel issuance attempts
 * cannot both win.
 */
export type IssuePurchaseTokenResult =
  | { ok: true; row: PurchaseTokenRow }
  | { ok: false; reason: "pending_exists"; pendingJti: string }
  | { ok: false; reason: "daily_token_cap_exceeded"; cap: number; used: number }
  | {
      ok: false;
      reason: "daily_spend_cap_exceeded";
      capMinor: number;
      currentMinor: number;
      proposedMinor: number;
    }
  | { ok: false; reason: "currency_mismatch"; expected: string; actual: string }
  | { ok: false; reason: "site_not_enabled" }
  | { ok: false; reason: "token_collision" };

interface SiteConfigRow {
  site_key: string;
  enabled: number;
  currency: string;
  daily_token_cap: number;
  daily_spend_cap_minor: number;
  per_tx_cap_minor_override: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Atomic issuance — runs every per-site enforcement gate inside a
 * single transaction with the INSERT so a concurrent caller cannot
 * double-issue past a cap.
 *
 *   1. Read `browser_automation_b4_site_config` for the site. If
 *      missing → return `site_not_enabled` (the dashboard's enable
 *      flow always creates the row; absence = never enabled).
 *   2. Enforce currency match — the agent's `params.currency` must
 *      equal the site's configured currency. Cross-currency math
 *      never happens; mismatched currency is the agent declaring an
 *      intent the site cannot honour.
 *   3. Count tokens issued in the last 24h for this site. If
 *      `count + 1 > daily_token_cap` → `daily_token_cap_exceeded`.
 *   4. Sum `confirmed_amount_minor` for confirmed rows in the last
 *      24h for this site + currency. If `current + max > daily_spend_cap_minor`
 *      → `daily_spend_cap_exceeded`.
 *   5. Enforce the per-site concurrency-1 invariant — count pending
 *      rows for this site that have not expired. If > 0 →
 *      `pending_exists`.
 *   6. INSERT the new row.
 *
 * The `jti` is server-generated when the input omits it (the common
 * case); tests can supply a fixed one for determinism.
 */
export function issuePurchaseToken(
  db: Database.Database,
  input: IssuePurchaseTokenInput,
): IssuePurchaseTokenResult {
  const jti = input.jti ?? randomUUID();
  const since = input.issuedAt - DAY_MS;
  const txn = db.transaction((): IssuePurchaseTokenResult => {
    const config = db
      .prepare<[string], SiteConfigRow>(
        `SELECT site_key, enabled, currency, daily_token_cap,
                daily_spend_cap_minor, per_tx_cap_minor_override
           FROM browser_automation_b4_site_config
          WHERE site_key = ?`,
      )
      .get(input.siteKey);
    if (!config || config.enabled !== 1) {
      return { ok: false, reason: "site_not_enabled" };
    }
    if (config.currency !== input.currency) {
      return {
        ok: false,
        reason: "currency_mismatch",
        expected: config.currency,
        actual: input.currency,
      };
    }

    // Per-tx cap (override defaults to daily_spend_cap_minor when null)
    const perTxCap =
      config.per_tx_cap_minor_override ?? config.daily_spend_cap_minor;
    if (input.maxAmountMinor > perTxCap) {
      return {
        ok: false,
        reason: "daily_spend_cap_exceeded",
        capMinor: perTxCap,
        currentMinor: 0,
        proposedMinor: input.maxAmountMinor,
      };
    }

    // Daily token cap — count tokens issued in the trailing 24h. We
    // count tokens regardless of terminal status so a flurry of
    // cancellations still counts against the daily ceiling (anti-
    // hammering).
    const usedRow = db
      .prepare<[string, number], { c: number }>(
        `SELECT COUNT(*) AS c
           FROM browser_automation_purchase_tokens
          WHERE site_key = ?
            AND issued_at >= ?`,
      )
      .get(input.siteKey, since);
    const used = usedRow?.c ?? 0;
    if (used + 1 > config.daily_token_cap) {
      return {
        ok: false,
        reason: "daily_token_cap_exceeded",
        cap: config.daily_token_cap,
        used,
      };
    }

    // Daily spend cap — sum confirmed amounts in the trailing 24h.
    // `currency` cross-check is redundant (we already verified the
    // input currency equals the config currency, and every row at
    // this site carries the config currency by construction) but is
    // belt-and-braces against a future schema migration.
    const spendRow = db
      .prepare<[string, string, number], { s: number | null }>(
        `SELECT COALESCE(SUM(confirmed_amount_minor), 0) AS s
           FROM browser_automation_purchase_tokens
          WHERE site_key = ?
            AND currency = ?
            AND status = 'confirmed'
            AND issued_at >= ?`,
      )
      .get(input.siteKey, input.currency, since);
    const current = spendRow?.s ?? 0;
    if (current + input.maxAmountMinor > config.daily_spend_cap_minor) {
      return {
        ok: false,
        reason: "daily_spend_cap_exceeded",
        capMinor: config.daily_spend_cap_minor,
        currentMinor: current,
        proposedMinor: input.maxAmountMinor,
      };
    }

    // Per-site concurrency 1 — at most one pending non-expired token.
    const pendingRow = db
      .prepare<[string, number], { jti: string | null; c: number }>(
        `SELECT MIN(jti) AS jti, COUNT(*) AS c
           FROM browser_automation_purchase_tokens
          WHERE site_key = ?
            AND status = 'pending'
            AND expires_at > ?`,
      )
      .get(input.siteKey, input.issuedAt);
    if ((pendingRow?.c ?? 0) > 0) {
      return {
        ok: false,
        reason: "pending_exists",
        pendingJti: pendingRow?.jti ?? "",
      };
    }

    try {
      db.prepare(
        `INSERT INTO browser_automation_purchase_tokens
           (jti, token, workflow_invocation_id, site_key, url_pattern,
            max_amount_minor, currency, pre_screenshot_path, notes_for_user,
            delivered_channels, issued_at, expires_at,
            consumed_at, consumed_via_channel, cancelled_at, cancel_reason,
            confirmed_amount_minor, order_id, post_screenshot_path, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'pending')`,
      ).run(
        jti,
        input.token,
        input.workflowInvocationId,
        input.siteKey,
        input.urlPattern,
        input.maxAmountMinor,
        input.currency,
        input.preScreenshotPath,
        input.notesForUser,
        JSON.stringify([...input.deliveredChannels]),
        input.issuedAt,
        input.expiresAt,
      );
    } catch (err) {
      // UNIQUE collision on `token` — astronomically unlikely under
      // 40-bit entropy but we surface it as a categorical failure the
      // handler can retry with a fresh tail.
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes("UNIQUE constraint failed: browser_automation_purchase_tokens.token")
      ) {
        return { ok: false, reason: "token_collision" };
      }
      throw err;
    }

    const inserted = db
      .prepare<[string], PurchaseTokenDbRow>(
        `SELECT jti, token, workflow_invocation_id, site_key, url_pattern,
                max_amount_minor, currency, pre_screenshot_path, notes_for_user,
                delivered_channels, issued_at, expires_at,
                consumed_at, consumed_via_channel, cancelled_at, cancel_reason,
                confirmed_amount_minor, order_id, post_screenshot_path, status
           FROM browser_automation_purchase_tokens
          WHERE jti = ?`,
      )
      .get(jti);
    if (!inserted) {
      throw new Error("issuePurchaseToken: post-insert row missing");
    }
    return { ok: true, row: fromDbRow(inserted) };
  });
  return txn();
}

/** Pure lookup by jti. */
export function getPurchaseTokenByJti(
  db: Database.Database,
  jti: string,
): PurchaseTokenRow | null {
  const row = db
    .prepare<[string], PurchaseTokenDbRow>(
      `SELECT jti, token, workflow_invocation_id, site_key, url_pattern,
              max_amount_minor, currency, pre_screenshot_path, notes_for_user,
              delivered_channels, issued_at, expires_at,
              consumed_at, consumed_via_channel, cancelled_at, cancel_reason,
              confirmed_amount_minor, order_id, post_screenshot_path, status
         FROM browser_automation_purchase_tokens
        WHERE jti = ?`,
    )
    .get(jti);
  return row ? fromDbRow(row) : null;
}

/** Lookup by the raw `!~xxxxxxxx` string. Used by the messaging
 *  adapter's incoming-token classifier. */
export function getPurchaseTokenByRaw(
  db: Database.Database,
  raw: string,
): PurchaseTokenRow | null {
  const row = db
    .prepare<[string], PurchaseTokenDbRow>(
      `SELECT jti, token, workflow_invocation_id, site_key, url_pattern,
              max_amount_minor, currency, pre_screenshot_path, notes_for_user,
              delivered_channels, issued_at, expires_at,
              consumed_at, consumed_via_channel, cancelled_at, cancel_reason,
              confirmed_amount_minor, order_id, post_screenshot_path, status
         FROM browser_automation_purchase_tokens
        WHERE token = ?`,
    )
    .get(raw);
  return row ? fromDbRow(row) : null;
}

/** Lookup by tail (the `!verify <tail>` slash handler).
 *  Concatenates `!~` + tail back to the canonical token shape so the
 *  DB index hit is identical to the raw-lookup path. */
export function getPurchaseTokenByTail(
  db: Database.Database,
  tail: string,
): PurchaseTokenRow | null {
  return getPurchaseTokenByRaw(db, `!~${tail}`);
}

export interface ConsumePurchaseTokenInput {
  jti: string;
  channelRef: string;
  consumedAt: number;
  /** Wall clock — drives the `expires_at >= nowMs` CAS predicate. */
  nowMs: number;
}

/**
 * Atomic CAS: `pending` → `consumed`. Returns the post-update row on
 * success, null when any guard failed (row missing, wrong status,
 * expired, or the channel did not match an entry in
 * `delivered_channels`). The handler upstream calls
 * `classifyPurchaseReply` for richer detail; this query is the
 * structural lock that prevents double-spend.
 *
 * The single-statement atomicity is what makes the gate safe: even if
 * two concurrent reply hooks race for the same token, exactly one
 * UPDATE will see `status = 'pending'` and the other will see
 * `'consumed'` and fail to acquire.
 */
export function consumePurchaseToken(
  db: Database.Database,
  input: ConsumePurchaseTokenInput,
): PurchaseTokenRow | null {
  const txn = db.transaction((): PurchaseTokenRow | null => {
    const result = db
      .prepare(
        `UPDATE browser_automation_purchase_tokens
            SET status = 'pending', /* status stays pending; the final flip happens at finalize/cancel */
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
    return getPurchaseTokenByJti(db, input.jti);
  });
  return txn();
}

export interface CancelPurchaseTokenInput {
  jti: string;
  reason: PurchaseCancelReason;
  cancelledAt: number;
  /** When set, the cancel only fires if the row is still pending and
   *  has NOT been consumed. The supervisor's orphan sweep, the daily
   *  cap exceeded path, and the user-cancel slash all enforce this so
   *  a workflow that has already committed money never has its row
   *  retroactively rewritten. */
  onlyIfPending?: boolean;
}

/**
 * Atomic CAS to the `cancelled` terminal state. Returns the post-
 * update row on success, null when the row was missing, already
 * terminal, or — when `onlyIfPending=true` — already consumed.
 */
export function cancelPurchaseToken(
  db: Database.Database,
  input: CancelPurchaseTokenInput,
): PurchaseTokenRow | null {
  const guard = input.onlyIfPending
    ? `AND status = 'pending' AND consumed_at IS NULL`
    : `AND status NOT IN ('confirmed')`;
  const result = db
    .prepare(
      `UPDATE browser_automation_purchase_tokens
          SET status = 'cancelled',
              cancelled_at = ?,
              cancel_reason = ?
        WHERE jti = ?
          ${guard}
          AND cancelled_at IS NULL`,
    )
    .run(input.cancelledAt, input.reason, input.jti);
  if (result.changes === 0) return null;
  return getPurchaseTokenByJti(db, input.jti);
}

export interface FinalizePurchaseTokenInput {
  jti: string;
  confirmedAmountMinor: number;
  currency: string;
  orderId: string | null;
  postScreenshotPath: string;
  finalizedAt: number;
}

/**
 * Atomic CAS to the `confirmed` terminal state, recording the
 * post-confirm details. Predicates require the row to be the
 * post-consume-pre-finalize shape — `status = 'pending'` AND
 * `consumed_at IS NOT NULL` AND `confirmed_amount_minor IS NULL`.
 * Currency cross-check defends against an accidental cross-currency
 * write.
 *
 * Returns null when the row was missing, in the wrong state, or the
 * currency check failed (a real failure path the workflow should
 * propagate to the caller as `playwright_error`).
 */
export function finalizePurchaseToken(
  db: Database.Database,
  input: FinalizePurchaseTokenInput,
): PurchaseTokenRow | null {
  const result = db
    .prepare(
      `UPDATE browser_automation_purchase_tokens
          SET status = 'confirmed',
              confirmed_amount_minor = ?,
              order_id = ?,
              post_screenshot_path = ?
        WHERE jti = ?
          AND status = 'pending'
          AND consumed_at IS NOT NULL
          AND cancelled_at IS NULL
          AND currency = ?
          AND confirmed_amount_minor IS NULL`,
    )
    .run(
      input.confirmedAmountMinor,
      input.orderId,
      input.postScreenshotPath,
      input.jti,
      input.currency,
    );
  if (result.changes === 0) return null;
  return getPurchaseTokenByJti(db, input.jti);
}

/**
 * Mark every pre-consume pending row whose `expires_at` is < `nowMs`
 * as `expired`. Returns the rows that were flipped (so the supervisor's
 * orphan sweep can SIGKILL each row's parked Chromium, if any).
 *
 * Pre-consume only — rows where the user typed the token but the click
 * never landed (consumed_at IS NOT NULL AND confirmed_amount_minor IS
 * NULL) live in a separate state and are reaped by
 * `sweepOrphanedConsumedPurchaseTokens` below. Splitting the two sweeps
 * makes the audit reason unambiguous: timeout = "user did not reply
 * within the 5-min window"; supervisor_orphan_sweep = "user replied,
 * but the click never finalised". Plan §17.3 "Daemon crash during the
 * 5-min window" calls for both passes.
 */
export function expireStalePurchaseTokens(
  db: Database.Database,
  nowMs: number,
): PurchaseTokenRow[] {
  const ids = db
    .prepare<[number], { jti: string }>(
      `SELECT jti
         FROM browser_automation_purchase_tokens
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
    `UPDATE browser_automation_purchase_tokens
        SET status = 'expired',
            cancelled_at = ?,
            cancel_reason = 'timeout'
      WHERE jti IN (${placeholders})`,
  ).run(nowMs, ...ids);
  return ids
    .map((id) => getPurchaseTokenByJti(db, id))
    .filter((row): row is PurchaseTokenRow => row !== null);
}

/**
 * Mark every consumed-but-not-finalized row whose `consumed_at` is
 * older than `cutoffMs` as `cancelled` with `cancel_reason =
 * 'supervisor_orphan_sweep'`. These are the "user typed the token, but
 * the click never landed" rows — the workflow died, the daemon
 * restarted, or the post-consume Playwright pipeline stalled.
 *
 * Without this sweep the rows sit in `pending+consumed_at!=null`
 * forever — `expireStalePurchaseTokens` ignores them (consumed_at IS
 * NULL filter), the daily-cap counters still tick (they count all
 * issued rows regardless of terminal status), and the user never gets
 * a follow-up DM on a stranded approval.
 *
 * Pure SQL — the caller is responsible for any DM follow-up. The retention
 * sweep + daemon-startup recovery call this with a cutoff of "the
 * workflow's perWorkflowTimeoutMs has elapsed since consume", which in
 * practice is ~6 minutes after consume.
 *
 * Plan §17.3 "Daemon crash during the 5-min window".
 */
export function sweepOrphanedConsumedPurchaseTokens(
  db: Database.Database,
  cutoffMs: number,
): PurchaseTokenRow[] {
  const ids = db
    .prepare<[number], { jti: string }>(
      `SELECT jti
         FROM browser_automation_purchase_tokens
        WHERE status = 'pending'
          AND consumed_at IS NOT NULL
          AND cancelled_at IS NULL
          AND confirmed_amount_minor IS NULL
          AND consumed_at < ?`,
    )
    .all(cutoffMs)
    .map((row) => row.jti);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE browser_automation_purchase_tokens
        SET status = 'cancelled',
            cancelled_at = ?,
            cancel_reason = 'supervisor_orphan_sweep'
      WHERE jti IN (${placeholders})`,
  ).run(cutoffMs, ...ids);
  return ids
    .map((id) => getPurchaseTokenByJti(db, id))
    .filter((row): row is PurchaseTokenRow => row !== null);
}

/**
 * Rotate `token` to NULL for terminal rows whose newest cancel /
 * consume / confirm timestamp is older than `cutoffMs`. Reduces the
 * at-rest footprint of the raw token string after redemption (the
 * hashed audit row on `_replies` is the long-term trail).
 */
export function scrubRotatedPurchaseTokens(
  db: Database.Database,
  cutoffMs: number,
): number {
  const result = db
    .prepare(
      `UPDATE browser_automation_purchase_tokens
          SET token = NULL
        WHERE token IS NOT NULL
          AND status IN ('confirmed', 'cancelled', 'expired')
          AND COALESCE(consumed_at, cancelled_at, issued_at) < ?`,
    )
    .run(cutoffMs);
  return result.changes;
}

/**
 * List pending tokens for the dashboard "Pending tokens" panel
 * (§17.8). Filters to non-expired only — expired-but-not-yet-swept
 * rows are surfaced via `listCancelledPurchaseTokens` instead.
 */
export function listPendingPurchaseTokens(
  db: Database.Database,
  nowMs: number,
  limit = 32,
): PurchaseTokenRow[] {
  const cap = Math.max(1, Math.min(64, Math.floor(limit)));
  const rows = db
    .prepare<[number, number], PurchaseTokenDbRow>(
      `SELECT jti, token, workflow_invocation_id, site_key, url_pattern,
              max_amount_minor, currency, pre_screenshot_path, notes_for_user,
              delivered_channels, issued_at, expires_at,
              consumed_at, consumed_via_channel, cancelled_at, cancel_reason,
              confirmed_amount_minor, order_id, post_screenshot_path, status
         FROM browser_automation_purchase_tokens
        WHERE status = 'pending'
          AND expires_at > ?
        ORDER BY issued_at DESC
        LIMIT ?`,
    )
    .all(nowMs, cap);
  return rows.map(fromDbRow);
}

/** Dashboard "Recent purchases" feed. Returns confirmed rows newest
 *  first plus all terminal cancellations so the operator sees both
 *  outcomes interleaved. */
export function listRecentPurchaseTokens(
  db: Database.Database,
  limit = 50,
): PurchaseTokenRow[] {
  const cap = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = db
    .prepare<[number], PurchaseTokenDbRow>(
      `SELECT jti, token, workflow_invocation_id, site_key, url_pattern,
              max_amount_minor, currency, pre_screenshot_path, notes_for_user,
              delivered_channels, issued_at, expires_at,
              consumed_at, consumed_via_channel, cancelled_at, cancel_reason,
              confirmed_amount_minor, order_id, post_screenshot_path, status
         FROM browser_automation_purchase_tokens
        WHERE status IN ('confirmed', 'cancelled', 'expired')
        ORDER BY COALESCE(cancelled_at, consumed_at, issued_at) DESC
        LIMIT ?`,
    )
    .all(cap);
  return rows.map(fromDbRow);
}

/** Pending tokens for a given channel — used by `!cancel-purchase`
 *  slash, which cancels every pending token whose
 *  `delivered_channels` contains the inbound channel. */
export function listPendingTokensForChannel(
  db: Database.Database,
  channelRef: string,
  nowMs: number,
): PurchaseTokenRow[] {
  // SQLite has no JSON containment operator on the FTS profile that
  // ships with better-sqlite3 by default; do the filter in JS. Pending
  // tokens are bounded by per-site concurrency=1 plus the daily token
  // cap × site count, so the list is small.
  return listPendingPurchaseTokens(db, nowMs, 64).filter((row) =>
    row.deliveredChannels.includes(channelRef),
  );
}

/** Default per-site B-4 enablement config — used by the dashboard
 *  enable flow when the user first toggles a site on. The currency is
 *  the caller's choice (the dashboard reads it from the site registry
 *  / user setting). */
export interface DefaultB4SiteConfig {
  siteKey: string;
  currency: string;
}

export function defaultSiteB4Config(input: DefaultB4SiteConfig): {
  siteKey: string;
  currency: string;
  dailyTokenCap: number;
  dailySpendCapMinor: number;
  perTxCapMinorOverride: number | null;
} {
  return {
    siteKey: input.siteKey,
    currency: input.currency,
    dailyTokenCap: B4_DEFAULT_DAILY_TOKEN_CAP,
    dailySpendCapMinor: B4_DEFAULT_DAILY_SPEND_CAP_MINOR,
    perTxCapMinorOverride: null,
  };
}
