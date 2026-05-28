/**
 * Lite-final-confirm handler — BROWSER_TASK_REDESIGN_PLAN.md §5 / §14.11.
 *
 * Orchestrates the DM-issued single-use confirmation token for the
 * browser-task surface. Parallel to `purchase-handler.ts` (B-4 purchase
 * confirms), but intentionally narrower:
 *
 *   - No per-site config dependency — works for any siteKey the
 *     site-registry registers + the deferred anon path (out of scope
 *     for Phase 1).
 *   - No purchase amount, no currency, no spend cap. The single thing
 *     the user is confirming is "yes, click this button" — captured by
 *     the pre-confirm screenshot.
 *   - jti-prefix dispatcher coexistence with B-4 (§14.11 Q#6): the
 *     messaging adapter's inbound `!~xxxxxxxx` classifier looks up the
 *     token in BOTH stores (B-4 purchase + this one) and routes to
 *     whichever returns a row. Both stores' `jti`s are uuid v4 — so
 *     prefix-collision is bounded by random-uuid uniqueness — and the
 *     handler that holds the matching token wins.
 *
 * The agent CANNOT reach this module directly: it lives daemon-side
 * with no API route, the only entry point is the browser-task runner
 * (which the dispatcher invokes from `dispatcher.ts`'s ProcessKey
 * `browser_task` branch), and DM dispatch is gated by an unforgeable
 * module-private capability symbol minted here.
 *
 * I/O-shaped (DB writes, async DM dispatch, polling timer). Excluded
 * from the 100% coverage gate per vitest.config.ts; the pure decision
 * logic lives in `lite-final-confirm-tokens.ts` and is 100% covered.
 */

import type Database from "better-sqlite3";

import {
  cancelLiteFinalConfirmToken,
  consumeLiteFinalConfirmToken,
  getLiteFinalConfirmTokenByJti,
  getLiteFinalConfirmTokenByRaw,
  issueLiteFinalConfirmToken,
  listPendingLiteFinalConfirmTokensForChannel,
  type IssueLiteFinalConfirmTokenResult,
  type LiteFinalConfirmCancelReason,
  type LiteFinalConfirmTokenRow,
} from "../../../db/browser-task-final-confirm-tokens-store.js";
import {
  channelRef,
  listPrimaryChannels,
} from "../../../db/browser-automation-purchase-primary-channels-store.js";
import { createLogger } from "../../../logging.js";
import {
  classifyLiteFinalConfirmReply,
  computeLiteFinalConfirmExpiry,
  hashReplyBody,
  mintLiteFinalConfirmToken,
  type LiteFinalConfirmTokenRowView,
} from "./lite-final-confirm-tokens.js";

const logger = createLogger("final-confirm-handler");

/** Default poll interval for `awaitReply`. The runner's per-execute
 *  timeout bounds the absolute wait; 500 ms balances responsiveness
 *  against load. Matches `purchase-handler`. */
const DEFAULT_POLL_INTERVAL_MS = 500;

/** Maximum number of token-mint retries on UNIQUE collision. */
const MAX_MINT_RETRIES = 5;

/**
 * Module-level capability symbol. Held ONLY by the sender
 * implementation paired with the handler at startup. Same construction
 * as `purchase-handler.ts`'s `PURCHASE_HANDLER_CAPABILITY` — Symbol
 * identity is the unforgeable bearer credential.
 */
const FINAL_CONFIRM_HANDLER_CAPABILITY: symbol = Symbol(
  "aitne.browser-task.final-confirm-handler.capability",
);

export type FinalConfirmHandlerCapability = symbol;

/**
 * Bootstrap-only getter. Production callers: the daemon boot path
 * minting the sender + the handler factory. No other code path imports
 * this — the symbol identity is what makes the credential unforgeable.
 */
export function __aitneFinalConfirm_getCapability(): FinalConfirmHandlerCapability {
  return FINAL_CONFIRM_HANDLER_CAPABILITY;
}

/** Wire-shape of every DM the handler emits — never the LLM. The sender
 *  implementation lives alongside `purchase-system-message-sender.ts`
 *  and refuses any caller that does not hold the capability. */
export interface FinalConfirmSystemMessageSender {
  deliverConfirmRequest(
    capability: FinalConfirmHandlerCapability,
    input: {
      channels: readonly string[];
      token: string;
      jti: string;
      taskId: string;
      actionSummary: string;
      preScreenshotPath: string;
      expiresAt: number;
    },
  ): Promise<{ delivered: readonly string[]; failed: readonly string[] }>;
  deliverPostConsumeFollowup(
    capability: FinalConfirmHandlerCapability,
    input: {
      deliveredChannels: readonly string[];
      consumedChannel: string;
      jti: string;
      taskId: string;
    },
  ): Promise<void>;
  deliverCancellationFollowup(
    capability: FinalConfirmHandlerCapability,
    input: {
      deliveredChannels: readonly string[];
      jti: string;
      taskId: string;
      reason: LiteFinalConfirmCancelReason;
    },
  ): Promise<void>;
}

export interface FinalConfirmHandlerDeps {
  db: Database.Database;
  sender: FinalConfirmSystemMessageSender;
  /** Override for tests; production uses `Date.now`. */
  nowFn?: () => number;
  /** Override for tests; production uses 500 ms. */
  pollIntervalMs?: number;
}

export interface IssueTokenInput {
  taskId: string;
  actionSummary: string;
  preScreenshotPath: string;
  /** Originating channel for the parent task. When non-null AND the
   *  channel is in the primary set, the token is DMed ONLY to that
   *  channel (single-channel ergonomic flow). Otherwise fan out to
   *  every primary channel — same posture as `purchase-handler`. */
  originatingChannel: string | null;
}

export type IssueTokenResult =
  | {
      ok: true;
      jti: string;
      token: string;
      expiresAt: number;
      deliveredChannels: readonly string[];
    }
  | { ok: false; reason: "no_primary_channels" }
  | { ok: false; reason: "pending_exists"; pendingJti: string }
  | { ok: false; reason: "delivery_failed"; jti: string };

export type AwaitReplyResult =
  | { status: "confirmed"; row: LiteFinalConfirmTokenRow }
  | { status: "cancelled_by_user_reply"; row: LiteFinalConfirmTokenRow }
  | { status: "cancelled_wrong_token"; row: LiteFinalConfirmTokenRow }
  | { status: "cancelled_timeout"; row: LiteFinalConfirmTokenRow }
  | { status: "cancelled_explicit"; row: LiteFinalConfirmTokenRow }
  | { status: "cancelled_other"; row: LiteFinalConfirmTokenRow };

export interface AwaitReplyInput {
  jti: string;
  abortSignal?: AbortSignal;
}

export type HandleTokenReplyOutcome =
  | { kind: "consumed"; jti: string; row: LiteFinalConfirmTokenRow }
  | { kind: "wrong_channel" }
  | { kind: "expired" }
  | { kind: "already_consumed" }
  | { kind: "already_cancelled" }
  | { kind: "no_match" }
  | { kind: "shape_invalid" };

export interface FinalConfirmHandler {
  issueToken(input: IssueTokenInput): Promise<IssueTokenResult>;
  awaitReply(input: AwaitReplyInput): Promise<AwaitReplyResult>;
  cancel(
    jti: string,
    reason: LiteFinalConfirmCancelReason,
  ): Promise<LiteFinalConfirmTokenRow | null>;
  /**
   * Look up a token by raw `!~xxxxxxxx` string. The messaging
   * adapter's jti-prefix dispatcher calls this on the lite store
   * after the B-4 store returns null — whichever store returns a row
   * wins the routing. Returns null when no row matches.
   */
  lookupByRaw(raw: string): LiteFinalConfirmTokenRow | null;
  /** Adapter-side entry for an inbound `!~xxxxxxxx` reply that the
   *  dispatcher has already routed to this handler. */
  handleTokenReply(input: {
    body: string;
    channelRef: string;
    nowMs?: number;
  }): Promise<HandleTokenReplyOutcome>;
  /**
   * §14.11 Q#6 — strict cancel on non-token reply, replicating the
   * `purchase-handler.cancelPendingOnNonTokenReply` contract so the
   * two surfaces stay symmetric. Any reply that lands on a delivered
   * channel and is NOT a recognised shape cancels every pending
   * lite-final-confirm token delivered to that channel.
   */
  cancelPendingOnNonTokenReply(input: {
    channelRef: string;
  }): Promise<readonly LiteFinalConfirmTokenRow[]>;
  /** Cancel every pending token for a task — used when the parent
   *  task transitions to `cancelled` via `POST /:id/cancel` while a
   *  final-confirm gate is open. */
  cancelPendingForTask(taskId: string): Promise<readonly LiteFinalConfirmTokenRow[]>;
}

export function createFinalConfirmHandler(
  deps: FinalConfirmHandlerDeps,
): FinalConfirmHandler {
  const now = deps.nowFn ?? (() => Date.now());
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const capability = FINAL_CONFIRM_HANDLER_CAPABILITY;

  async function issueToken(input: IssueTokenInput): Promise<IssueTokenResult> {
    // Resolve delivery set — same posture as B-4. Falling back to the
    // shared primary-channels table is deliberate: the user has at
    // most one consent surface for `!~xxxxxxxx` tokens regardless of
    // origin (purchase OR lite-final-confirm).
    const primary = listPrimaryChannels(deps.db).map((row) =>
      channelRef(row.platform, row.channelId),
    );
    if (primary.length === 0) {
      return { ok: false, reason: "no_primary_channels" };
    }
    const delivery =
      input.originatingChannel && primary.includes(input.originatingChannel)
        ? [input.originatingChannel]
        : primary;

    const issuedAt = now();
    const expiresAt = computeLiteFinalConfirmExpiry(issuedAt);

    let attempt = 0;
    let issuedRow: LiteFinalConfirmTokenRow | null = null;
    let lastFailure: IssueLiteFinalConfirmTokenResult | null = null;
    while (attempt < MAX_MINT_RETRIES) {
      attempt += 1;
      const token = mintLiteFinalConfirmToken();
      const result = issueLiteFinalConfirmToken(deps.db, {
        token,
        taskId: input.taskId,
        actionSummary: input.actionSummary,
        preScreenshotPath: input.preScreenshotPath,
        deliveredChannels: delivery,
        issuedAt,
        expiresAt,
      });
      lastFailure = result;
      if (result.ok) {
        issuedRow = result.row;
        break;
      }
      if (result.reason !== "token_collision") break;
    }

    if (!issuedRow) {
      if (!lastFailure || lastFailure.ok) {
        return { ok: false, reason: "delivery_failed", jti: "" };
      }
      if (lastFailure.reason === "pending_exists") {
        return {
          ok: false,
          reason: "pending_exists",
          pendingJti: lastFailure.pendingJti,
        };
      }
      logger.error(
        { taskId: input.taskId, attempt },
        "lite-final-confirm token collision exhausted retries; refusing to issue",
      );
      return { ok: false, reason: "delivery_failed", jti: "" };
    }

    let delivered: readonly string[] = [];
    let failed: readonly string[] = [];
    try {
      const result = await deps.sender.deliverConfirmRequest(capability, {
        channels: issuedRow.deliveredChannels,
        token: issuedRow.token ?? "",
        jti: issuedRow.jti,
        taskId: issuedRow.taskId,
        actionSummary: issuedRow.actionSummary,
        preScreenshotPath: issuedRow.preScreenshotPath,
        expiresAt: issuedRow.expiresAt,
      });
      delivered = result.delivered;
      failed = result.failed;
    } catch (err) {
      logger.error(
        { err, jti: issuedRow.jti, taskId: issuedRow.taskId },
        "lite-final-confirm DM delivery threw; cancelling token",
      );
      cancelLiteFinalConfirmToken(deps.db, {
        jti: issuedRow.jti,
        reason: "task_cancelled",
        cancelledAt: now(),
        onlyIfPending: true,
      });
      return { ok: false, reason: "delivery_failed", jti: issuedRow.jti };
    }
    if (delivered.length === 0) {
      logger.error(
        {
          jti: issuedRow.jti,
          taskId: issuedRow.taskId,
          attempted: issuedRow.deliveredChannels,
          failed,
        },
        "lite-final-confirm DM delivery failed on all channels; cancelling token",
      );
      cancelLiteFinalConfirmToken(deps.db, {
        jti: issuedRow.jti,
        reason: "task_cancelled",
        cancelledAt: now(),
        onlyIfPending: true,
      });
      return { ok: false, reason: "delivery_failed", jti: issuedRow.jti };
    }
    if (failed.length > 0) {
      logger.warn(
        { jti: issuedRow.jti, failed },
        "lite-final-confirm DM partial delivery — proceeding with subset",
      );
    }
    logger.info(
      {
        jti: issuedRow.jti,
        taskId: issuedRow.taskId,
        deliveredCount: delivered.length,
        expiresAt: issuedRow.expiresAt,
      },
      "lite-final-confirm token issued and DM delivered",
    );
    return {
      ok: true,
      jti: issuedRow.jti,
      token: issuedRow.token ?? "",
      expiresAt: issuedRow.expiresAt,
      deliveredChannels: delivered,
    };
  }

  async function awaitReply(input: AwaitReplyInput): Promise<AwaitReplyResult> {
    while (true) {
      if (input.abortSignal?.aborted) {
        const row = getLiteFinalConfirmTokenByJti(deps.db, input.jti);
        // Map the abort reason → cancel reason so the audit trail
        // distinguishes user-cancel (parent task cancel / SDK abort)
        // from clock-driven timeout. The driver sets a custom Error
        // message when it aborts; everything else (`null`,
        // unknown shape) falls back to `task_cancelled`.
        const abortMessage =
          input.abortSignal.reason instanceof Error
            ? input.abortSignal.reason.message
            : typeof input.abortSignal.reason === "string"
              ? input.abortSignal.reason
              : "";
        const isClockTimeout = /timeout/i.test(abortMessage);
        const cancelReason: LiteFinalConfirmCancelReason = isClockTimeout
          ? "timeout"
          : "task_cancelled";
        cancelLiteFinalConfirmToken(deps.db, {
          jti: input.jti,
          reason: cancelReason,
          cancelledAt: now(),
          onlyIfPending: true,
        });
        const resolvedRow =
          row ??
          ((): LiteFinalConfirmTokenRow => {
            throw new Error("awaitReply: token row vanished mid-await");
          })();
        return {
          status: isClockTimeout ? "cancelled_timeout" : "cancelled_explicit",
          row: resolvedRow,
        };
      }
      const row = getLiteFinalConfirmTokenByJti(deps.db, input.jti);
      if (!row) {
        throw new Error(`awaitReply: token row for jti=${input.jti} missing`);
      }
      if (row.status === "confirmed") {
        return { status: "confirmed", row };
      }
      if (row.consumedAt !== null && row.cancelledAt === null) {
        return { status: "confirmed", row };
      }
      if (row.cancelledAt !== null) {
        switch (row.cancelReason) {
          case "user_reply":
            return { status: "cancelled_by_user_reply", row };
          case "wrong_token":
          case "wrong_channel":
            return { status: "cancelled_wrong_token", row };
          case "timeout":
            return { status: "cancelled_timeout", row };
          case "explicit":
          case "dashboard_cancel":
          case "task_cancelled":
            return { status: "cancelled_explicit", row };
          default:
            return { status: "cancelled_other", row };
        }
      }
      if (now() > row.expiresAt) {
        cancelLiteFinalConfirmToken(deps.db, {
          jti: input.jti,
          reason: "timeout",
          cancelledAt: now(),
          onlyIfPending: true,
        });
        const expired = getLiteFinalConfirmTokenByJti(deps.db, input.jti) ?? row;
        return { status: "cancelled_timeout", row: expired };
      }
      await sleep(pollIntervalMs, input.abortSignal);
    }
  }

  async function cancel(
    jti: string,
    reason: LiteFinalConfirmCancelReason,
  ): Promise<LiteFinalConfirmTokenRow | null> {
    const row = cancelLiteFinalConfirmToken(deps.db, {
      jti,
      reason,
      cancelledAt: now(),
      onlyIfPending: true,
    });
    if (row) {
      try {
        await deps.sender.deliverCancellationFollowup(capability, {
          deliveredChannels: row.deliveredChannels,
          jti: row.jti,
          taskId: row.taskId,
          reason,
        });
      } catch (err) {
        logger.warn(
          { err, jti, reason },
          "lite-final-confirm cancellation follow-up DM failed (continuing)",
        );
      }
    }
    return row;
  }

  function lookupByRaw(raw: string): LiteFinalConfirmTokenRow | null {
    return getLiteFinalConfirmTokenByRaw(deps.db, raw);
  }

  async function handleTokenReply(input: {
    body: string;
    channelRef: string;
    nowMs?: number;
  }): Promise<HandleTokenReplyOutcome> {
    const nowMs = input.nowMs ?? now();
    const bodyHash = hashReplyBody(input.body);
    void bodyHash; // intentionally unused — Phase 1 ships without a replies audit table for lite-final-confirm; future surface unification (Open Q#8) folds replies into one cross-domain audit.

    const parsed = input.body.trim();
    const isShape = /^!~[A-Z2-7]{8}$/.test(parsed);
    const row = isShape
      ? lookupView(deps.db, parsed)
      : null;
    const decision = classifyLiteFinalConfirmReply({
      body: input.body,
      channelRef: input.channelRef,
      row,
      nowMs,
    });

    if (decision.kind === "consume") {
      const consumed = consumeLiteFinalConfirmToken(deps.db, {
        jti: decision.row.jti,
        channelRef: input.channelRef,
        consumedAt: nowMs,
        nowMs,
      });
      if (!consumed) {
        return { kind: "already_consumed" };
      }
      try {
        await deps.sender.deliverPostConsumeFollowup(capability, {
          deliveredChannels: consumed.deliveredChannels,
          consumedChannel: input.channelRef,
          jti: consumed.jti,
          taskId: consumed.taskId,
        });
      } catch (err) {
        logger.warn(
          { err, jti: consumed.jti },
          "post-consume follow-up DM failed (continuing)",
        );
      }
      return { kind: "consumed", jti: consumed.jti, row: consumed };
    }

    if (decision.kind === "wrong_channel") {
      cancelLiteFinalConfirmToken(deps.db, {
        jti: decision.row.jti,
        reason: "wrong_channel",
        cancelledAt: nowMs,
        onlyIfPending: true,
      });
      return { kind: "wrong_channel" };
    }
    if (decision.kind === "expired") return { kind: "expired" };
    if (decision.kind === "already_consumed") return { kind: "already_consumed" };
    if (decision.kind === "already_cancelled") return { kind: "already_cancelled" };
    if (decision.kind === "no_match") return { kind: "no_match" };
    return { kind: "shape_invalid" };
  }

  async function cancelPendingOnNonTokenReply(input: {
    channelRef: string;
  }): Promise<readonly LiteFinalConfirmTokenRow[]> {
    const nowMs = now();
    const pending = listPendingLiteFinalConfirmTokensForChannel(
      deps.db,
      input.channelRef,
      nowMs,
    );
    if (pending.length === 0) return [];
    const cancelled: LiteFinalConfirmTokenRow[] = [];
    for (const row of pending) {
      const updated = cancelLiteFinalConfirmToken(deps.db, {
        jti: row.jti,
        reason: "user_reply",
        cancelledAt: nowMs,
        onlyIfPending: true,
      });
      if (updated) {
        cancelled.push(updated);
        try {
          await deps.sender.deliverCancellationFollowup(capability, {
            deliveredChannels: updated.deliveredChannels,
            jti: updated.jti,
            taskId: updated.taskId,
            reason: "user_reply",
          });
        } catch (err) {
          logger.warn(
            { err, jti: updated.jti, channel: input.channelRef },
            "non-token-reply cancellation DM failed (continuing)",
          );
        }
      }
    }
    if (cancelled.length > 0) {
      logger.info(
        {
          channel: input.channelRef,
          cancelledCount: cancelled.length,
          jtis: cancelled.map((r) => r.jti),
        },
        "lite-final-confirm strict-cancel: non-token reply cancelled pending tokens",
      );
    }
    return cancelled;
  }

  async function cancelPendingForTask(
    taskId: string,
  ): Promise<readonly LiteFinalConfirmTokenRow[]> {
    // The runner calls this on `POST /:id/cancel` and on the task's
    // own terminal transition (release-the-context cleanup). Walk the
    // pending set for the task — `listPendingLiteFinalConfirmTokens`
    // is bounded by `browserTaskMaxConcurrent` so the JS-side filter
    // here is fine.
    const nowMs = now();
    // We can't query by task_id directly without a helper; use the
    // by-channel iteration: pending tokens for this task will appear
    // on every primary channel they were delivered to. A simpler
    // approach is to walk pending and filter by taskId — that's the
    // shape used here.
    const rows = pendingTokensForTask(deps.db, taskId, nowMs);
    const cancelled: LiteFinalConfirmTokenRow[] = [];
    for (const row of rows) {
      const updated = cancelLiteFinalConfirmToken(deps.db, {
        jti: row.jti,
        reason: "task_cancelled",
        cancelledAt: nowMs,
        onlyIfPending: true,
      });
      if (updated) {
        cancelled.push(updated);
        try {
          await deps.sender.deliverCancellationFollowup(capability, {
            deliveredChannels: updated.deliveredChannels,
            jti: updated.jti,
            taskId: updated.taskId,
            reason: "task_cancelled",
          });
        } catch (err) {
          logger.warn(
            { err, jti: updated.jti, taskId },
            "task-cancel follow-up DM failed (continuing)",
          );
        }
      }
    }
    return cancelled;
  }

  return {
    issueToken,
    awaitReply,
    cancel,
    lookupByRaw,
    handleTokenReply,
    cancelPendingOnNonTokenReply,
    cancelPendingForTask,
  };
}

/** Pure shape-narrowing on the DB row → the classifier view. Decoupled
 *  from the full row so a future column add doesn't ripple. */
function lookupView(
  db: Database.Database,
  raw: string,
): LiteFinalConfirmTokenRowView | null {
  const row = getLiteFinalConfirmTokenByRaw(db, raw);
  if (!row) return null;
  return {
    jti: row.jti,
    token: row.token,
    taskId: row.taskId,
    status: row.status,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    cancelledAt: row.cancelledAt,
    deliveredChannels: row.deliveredChannels,
  };
}

/** Pending tokens for a task — used by `cancelPendingForTask`. Walks
 *  the bounded pending set. */
function pendingTokensForTask(
  db: Database.Database,
  taskId: string,
  nowMs: number,
): readonly LiteFinalConfirmTokenRow[] {
  return db
    .prepare<[string, number], unknown>(
      `SELECT jti FROM browser_task_final_confirm_tokens
        WHERE task_id = ?
          AND status = 'pending'
          AND consumed_at IS NULL
          AND cancelled_at IS NULL
          AND expires_at > ?`,
    )
    .all(taskId, nowMs)
    .map((r) => getLiteFinalConfirmTokenByJti(db, (r as { jti: string }).jti))
    .filter((r): r is LiteFinalConfirmTokenRow => r !== null);
}

/** AbortSignal-aware sleep. Mirrors purchase-handler's helper. */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
