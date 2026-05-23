/**
 * Phase B-4 purchase handler — orchestrates the DM-issued single-use
 * token flow that gates every B-4 workflow.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.3 / §17.4 / §13 step 50.
 *
 * The handler is the single chokepoint for issuing a `!~xxxxxxxx`
 * confirmation token. The workflow (`confirm-cart-checkout.ts`) calls
 * `issueToken()` AFTER the pre-confirm screenshot lands, then
 * `awaitReply()` until the user types the exact token back in DM, then
 * `finalize()` once the post-confirm click + screenshot are recorded.
 *
 * The agent CANNOT reach this module directly: it lives daemon-side
 * with no API route, the only entry point is the workflow's `run()`
 * (executed under `workflow-runner.ts`), and the system-message dispatch
 * goes through a module-level capability the agent cannot mint
 * (`PurchaseSystemMessageSender`). This is the structural anti-spoofing
 * layer §17.7 specifies: "agent tools cannot construct a fake
 * confirmation request because the credentialed sender refuses
 * unauthenticated callers".
 *
 * I/O-shaped (DB writes, async DM dispatch, polling timer). The
 * coverage gate excludes this module — the pure decision logic lives
 * in `purchase-tokens.ts` (shape parsing, classifyPurchaseReply,
 * classifyPurchaseTokenEcho) and is the covered surface. Integration
 * tests through the workflow runner exercise the full flow end-to-end.
 */

import type Database from "better-sqlite3";

// B4_TOKEN_TTL_MS is consumed indirectly via `computePurchaseExpiry`.
import {
  cancelPurchaseToken,
  consumePurchaseToken,
  finalizePurchaseToken,
  getPurchaseTokenByJti,
  getPurchaseTokenByRaw,
  issuePurchaseToken,
  listPendingTokensForChannel,
  type IssuePurchaseTokenResult,
  type PurchaseCancelReason,
  type PurchaseTokenRow,
} from "../../../db/browser-automation-purchase-tokens-store.js";
import {
  insertPurchaseReply,
  type PurchaseReplyOutcome,
} from "../../../db/browser-automation-purchase-replies-store.js";
import {
  getB4Enabled,
  getSiteB4Config,
} from "../../../db/browser-automation-b4-config-store.js";
import {
  listPrimaryChannels,
  channelRef,
} from "../../../db/browser-automation-purchase-primary-channels-store.js";
import { createLogger } from "../../../logging.js";
import {
  classifyPurchaseReply,
  computePurchaseExpiry,
  hashReplyBody,
  mintPurchaseToken,
  type PurchaseTokenRowView,
} from "./purchase-tokens.js";

const logger = createLogger("purchase-handler");

/** Default poll interval for `awaitReply`. The runner's
 *  `perWorkflowTimeoutMs` already caps the absolute wait, so a 500 ms
 *  cadence balances responsiveness against load (the user typically
 *  replies in ~30-60 s). */
const DEFAULT_POLL_INTERVAL_MS = 500;

/** Maximum number of token-mint retries on UNIQUE collision. 40-bit
 *  entropy makes a collision astronomically unlikely; 5 retries is
 *  defence against a defective CSPRNG without burning the workflow's
 *  perWorkflowTimeoutMs. */
const MAX_MINT_RETRIES = 5;

/**
 * Module-level capability symbol. Held ONLY by the sender
 * implementation paired with the handler at startup. The handler-side
 * call site is intentionally typed to require the capability so any
 * caller that does not hold it (i.e., everything outside the daemon's
 * bootstrap path) fails the type check. At runtime the symbol acts as
 * an unforgeable bearer credential — the symbol's identity is the
 * proof.
 *
 * Why not a string or an HMAC: a string can be hard-coded into a
 * misbehaving skill; an HMAC would still leave the verifier and the
 * signer in the same trust boundary the threat model already assumes
 * is honest (the daemon). A Symbol cannot be referenced from outside
 * the module that creates it, which matches the actual property we
 * want.
 */
const PURCHASE_HANDLER_CAPABILITY: symbol = Symbol(
  "aitne.b4.purchase-handler.capability",
);

/**
 * Capability handle — opaque at the type level. The runtime check is
 * identity comparison against the module-private `PURCHASE_HANDLER_CAPABILITY`
 * symbol; the value-level identity is what makes the credential
 * unforgeable, not the TS type narrowing. Exposed as `symbol` (not
 * `unique symbol`) so callers can hold a reference without depending
 * on the const's exact typeof — the comparison still works.
 */
export type PurchaseHandlerCapability = symbol;

/**
 * Surface the sender side of the credential. The daemon-bootstrap
 * code grabs this once at startup, passes it into the
 * `createPurchaseHandler` factory + the sender implementation; nothing
 * else is permitted to import this getter.
 *
 * The function is intentionally side-effect free so the test layer can
 * still construct sender + handler in fixtures (and the daemon's
 * single boot is the only production caller).
 */
export function __aitneB4_getPurchaseHandlerCapability(): PurchaseHandlerCapability {
  return PURCHASE_HANDLER_CAPABILITY;
}

/**
 * Wire-shape of every DM the handler emits — never the LLM. The
 * implementation lives in `messaging/system-message-sender.ts` and is
 * the only place agentic outbound code paths intersect with this
 * surface; the capability arg guards entry.
 */
export interface PurchaseSystemMessageSender {
  /**
   * Deliver the pre-confirm screenshot + token + total + verify line
   * to each channel in `channels`. Return the channels actually
   * delivered to. The handler persists this list on the
   * `purchase_tokens.delivered_channels` JSON column; only those
   * channels can later validate a reply.
   *
   * On partial failure (some channels reachable, some not) returns
   * the delivered subset so the user can still confirm via whichever
   * channel the DM landed on. The handler logs the failure subset
   * but does not abort the workflow — the user-facing flow accepts
   * "any single primary channel delivers and the consent path works".
   */
  deliverPurchaseRequest(
    capability: PurchaseHandlerCapability,
    input: {
      channels: readonly string[];
      token: string;
      jti: string;
      siteKey: string;
      displayedTotalMinor: number;
      currency: string;
      notesForUser: string | null;
      preScreenshotPath: string;
      expiresAt: number;
    },
  ): Promise<{ delivered: readonly string[]; failed: readonly string[] }>;
  /**
   * After a reply consumes the token, post the "✅ Confirmed" reply on
   * the consumed channel and the "✅ Approved on <channel>" follow-up
   * to every other delivered channel. Idempotent — invoked exactly
   * once per consume.
   */
  deliverPostConsumeFollowup(
    capability: PurchaseHandlerCapability,
    input: {
      deliveredChannels: readonly string[];
      consumedChannel: string;
      jti: string;
      siteKey: string;
    },
  ): Promise<void>;
  /**
   * Post a "⚠️ Cancelled — <reason>" follow-up on every delivered
   * channel. Best-effort; failures are logged but do not propagate.
   */
  deliverCancellationFollowup(
    capability: PurchaseHandlerCapability,
    input: {
      deliveredChannels: readonly string[];
      jti: string;
      siteKey: string;
      reason: PurchaseCancelReason;
    },
  ): Promise<void>;
  /**
   * Reply on a single channel with a structured legitimacy line in
   * response to the user's `!verify <tail>` slash command (§17.3).
   * The handler invokes this from `handleVerifySlash`.
   */
  deliverVerifyReply(
    capability: PurchaseHandlerCapability,
    input: {
      channel: string;
      jti: string | null;
      ok: boolean;
      detail: string;
    },
  ): Promise<void>;
}

export interface PurchaseHandlerDeps {
  db: Database.Database;
  sender: PurchaseSystemMessageSender;
  /** Override for tests; production uses `Date.now`. */
  nowFn?: () => number;
  /** Override for tests; production uses 500 ms. */
  pollIntervalMs?: number;
}

export interface IssueTokenInput {
  workflowInvocationId: string;
  siteKey: string;
  urlPattern: string;
  /** Actual displayed total at screenshot time, in minor units. Becomes
   *  the token's `max_amount_minor`. */
  displayedTotalMinor: number;
  currency: string;
  preScreenshotPath: string;
  notesForUser: string | null;
  /** Originating channel for user-initiated workflows (DM → workflow);
   *  null for scheduled / autonomous invocations. When non-null AND
   *  the channel is in the primary set, the token is DMed ONLY to
   *  that channel (single-channel ergonomic flow). Otherwise fan out
   *  to every primary channel. */
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
  | { ok: false; reason: "b4_disabled" }
  | { ok: false; reason: "site_not_enabled" }
  | { ok: false; reason: "no_primary_channels" }
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
  | { ok: false; reason: "delivery_failed"; jti: string };

export type AwaitReplyResult =
  | { status: "confirmed"; row: PurchaseTokenRow }
  | { status: "cancelled_by_user_reply"; row: PurchaseTokenRow }
  | { status: "cancelled_wrong_token"; row: PurchaseTokenRow }
  | { status: "cancelled_timeout"; row: PurchaseTokenRow }
  | { status: "cancelled_explicit"; row: PurchaseTokenRow }
  | { status: "cancelled_other"; row: PurchaseTokenRow };

export interface AwaitReplyInput {
  jti: string;
  abortSignal?: AbortSignal;
}

export interface FinalizeInput {
  jti: string;
  confirmedAmountMinor: number;
  currency: string;
  orderId: string | null;
  postScreenshotPath: string;
}

/**
 * Inbound-reply handler invoked from the messaging adapter when a
 * body classifies as `token_reply`. Encapsulates: (a) the atomic
 * consume CAS, (b) the audit-row insert, (c) the post-consume DM
 * follow-up dispatch.
 *
 * Returns the categorical outcome for the adapter to render its
 * one-line reply on the originating channel.
 */
export type HandleTokenReplyOutcome =
  | { kind: "consumed"; jti: string; row: PurchaseTokenRow }
  | { kind: "wrong_channel" }
  | { kind: "expired" }
  | { kind: "already_consumed" }
  | { kind: "already_cancelled" }
  | { kind: "no_match" }
  | { kind: "shape_invalid" };

/**
 * Inbound `!verify <tail>` handler — looks up the pending token by
 * tail and replies on the originating channel with the legitimacy
 * line. Pure-ish: writes only the verify-reply DM, no DB mutations.
 */
export type HandleVerifySlashOutcome =
  | { kind: "verified"; jti: string; row: PurchaseTokenRow }
  | { kind: "no_match" };

/**
 * Cancellation modes — see `cancel()` JSDoc.
 *
 * `pending-only` (default) — pre-consume cancel, refuses if the user
 * already typed the token (consumed_at IS NOT NULL). Used by the
 * adapter-side cancel slash, the dashboard "Cancel pending" button,
 * and DM-delivery failure paths.
 *
 * `any-non-terminal` — post-consume cancel, accepts the consumed-but-
 * not-finalized state so the workflow can mark the row terminal when
 * the click fails / cart drifts under the pause. Without this the row
 * sticks in `pending+consumed_at!=null` forever and the user never
 * gets a follow-up DM. MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.3
 * cancellation table: rows for `cancel_reason in (amount_mismatch,
 * amount_exceeds_token, page_changed, playwright_error)` are reached
 * via this mode.
 */
export type CancelMode = "pending-only" | "any-non-terminal";

export interface PurchaseHandler {
  issueToken(input: IssueTokenInput): Promise<IssueTokenResult>;
  awaitReply(input: AwaitReplyInput): Promise<AwaitReplyResult>;
  finalize(input: FinalizeInput): Promise<PurchaseTokenRow | null>;
  /**
   * Cancel a pending or consumed-but-not-finalized purchase token.
   * `mode` defaults to `"pending-only"` (race-safe pre-consume); use
   * `"any-non-terminal"` from inside the workflow's post-consume
   * failure paths (page_changed / amount_mismatch / playwright_error
   * after consume) so the CAS does not silently miss when consumed_at
   * is set.
   */
  cancel(
    jti: string,
    reason: PurchaseCancelReason,
    mode?: CancelMode,
  ): Promise<PurchaseTokenRow | null>;
  /** Adapter-side entry — see HandleTokenReplyOutcome above. */
  handleTokenReply(input: {
    body: string;
    channelRef: string;
    nowMs?: number;
  }): Promise<HandleTokenReplyOutcome>;
  /** Adapter-side entry for `!verify <tail>`. */
  handleVerifySlash(input: {
    tail: string;
    channelRef: string;
  }): Promise<HandleVerifySlashOutcome>;
  /** Adapter-side entry for `!cancel-purchase` slash — cancels every
   *  pending token whose delivered_channels includes the inbound
   *  channel. */
  handleCancelPurchaseSlash(input: {
    channelRef: string;
  }): Promise<readonly PurchaseTokenRow[]>;
  /**
   * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.3 cancellation row 1 —
   * strict-cancel on non-token reply.
   *
   * When the user sends ANY message on a channel that received a
   * pending purchase token AND the message is NOT one of the three
   * recognised shapes (`!~xxxxxxxx` reply, `!verify <tail>`,
   * `!cancel-purchase`), every pending token delivered to that channel
   * is cancelled with reason `user_reply`. The user explicitly accepted
   * this strict UX in rev3's directive ("それ以外が送られた場合は、決済を
   * 取り消しする") — anything but the exact token aborts the workflow.
   *
   * Returns the rows that were cancelled (empty if none pending on the
   * channel). Best-effort — DM dispatch failures are logged but do not
   * propagate; the in-flight workflow's `awaitReply` poll sees the
   * `cancelled_at` timestamp on its next 500ms tick and returns
   * `cancelled_by_user_reply`.
   *
   * The adapter still forwards the inbound message to the DM agent —
   * the cancel is silent from the LLM's perspective (the agent never
   * sees the token / didn't know there was a pending purchase). The
   * user sees the cancellation follow-up DM from
   * `sendSystemMessage.deliverCancellationFollowup` so they know the
   * purchase was aborted.
   */
  cancelPendingOnNonTokenReply(input: {
    channelRef: string;
  }): Promise<readonly PurchaseTokenRow[]>;
}

export function createPurchaseHandler(
  deps: PurchaseHandlerDeps,
): PurchaseHandler {
  const now = deps.nowFn ?? (() => Date.now());
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const capability = PURCHASE_HANDLER_CAPABILITY;

  async function issueToken(input: IssueTokenInput): Promise<IssueTokenResult> {
    if (!getB4Enabled(deps.db)) {
      return { ok: false, reason: "b4_disabled" };
    }
    const siteConfig = getSiteB4Config(deps.db, input.siteKey);
    if (!siteConfig || !siteConfig.enabled) {
      return { ok: false, reason: "site_not_enabled" };
    }

    // Resolve delivery set:
    //   - originatingChannel non-null AND primary → that one channel only
    //   - otherwise → fan out to every primary channel
    // No primary channels at all → refuse to issue.
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
    const expiresAt = computePurchaseExpiry(issuedAt);

    // Mint loop with collision retries.
    let attempt = 0;
    let issuedRow: PurchaseTokenRow | null = null;
    let lastFailure: IssuePurchaseTokenResult | null = null;
    while (attempt < MAX_MINT_RETRIES) {
      attempt += 1;
      const token = mintPurchaseToken();
      const result = issuePurchaseToken(deps.db, {
        token,
        workflowInvocationId: input.workflowInvocationId,
        siteKey: input.siteKey,
        urlPattern: input.urlPattern,
        maxAmountMinor: input.displayedTotalMinor,
        currency: input.currency,
        preScreenshotPath: input.preScreenshotPath,
        notesForUser: input.notesForUser,
        deliveredChannels: delivery,
        issuedAt,
        expiresAt,
      });
      lastFailure = result;
      if (result.ok) {
        issuedRow = result.row;
        break;
      }
      if (result.reason !== "token_collision") {
        // Non-collision failure → no point retrying.
        break;
      }
    }

    if (!issuedRow) {
      // Map the DB-layer categorical failures onto the wire-shape.
      if (!lastFailure || lastFailure.ok) {
        // c8 ignore — every loop iteration writes a non-ok lastFailure
        // when the row stays null; defensive default for type narrowing.
        return { ok: false, reason: "delivery_failed", jti: "" };
      }
      switch (lastFailure.reason) {
        case "site_not_enabled":
          return { ok: false, reason: "site_not_enabled" };
        case "currency_mismatch":
          return {
            ok: false,
            reason: "currency_mismatch",
            expected: lastFailure.expected,
            actual: lastFailure.actual,
          };
        case "daily_token_cap_exceeded":
          return {
            ok: false,
            reason: "daily_token_cap_exceeded",
            cap: lastFailure.cap,
            used: lastFailure.used,
          };
        case "daily_spend_cap_exceeded":
          return {
            ok: false,
            reason: "daily_spend_cap_exceeded",
            capMinor: lastFailure.capMinor,
            currentMinor: lastFailure.currentMinor,
            proposedMinor: lastFailure.proposedMinor,
          };
        case "pending_exists":
          return {
            ok: false,
            reason: "pending_exists",
            pendingJti: lastFailure.pendingJti,
          };
        case "token_collision":
          // Exhausted retries — fail closed so the workflow surfaces
          // playwright_error rather than spinning forever.
          logger.error(
            { siteKey: input.siteKey, attempt },
            "purchase token collision exhausted retries; refusing to issue",
          );
          return { ok: false, reason: "delivery_failed", jti: "" };
      }
    }

    // Deliver the DM. We post BEFORE returning so that on delivery
    // failure we can cancel the token immediately and surface the
    // failure to the workflow as a wire-level outcome — the workflow
    // must NOT proceed to await a reply on a token the user never
    // received.
    let delivered: readonly string[] = [];
    let failed: readonly string[] = [];
    try {
      const result = await deps.sender.deliverPurchaseRequest(capability, {
        channels: issuedRow.deliveredChannels,
        token: issuedRow.token ?? "",
        jti: issuedRow.jti,
        siteKey: issuedRow.siteKey,
        displayedTotalMinor: issuedRow.maxAmountMinor,
        currency: issuedRow.currency,
        notesForUser: issuedRow.notesForUser,
        preScreenshotPath: issuedRow.preScreenshotPath,
        expiresAt: issuedRow.expiresAt,
      });
      delivered = result.delivered;
      failed = result.failed;
    } catch (err) {
      logger.error(
        { err, jti: issuedRow.jti, siteKey: issuedRow.siteKey },
        "purchase DM delivery threw; cancelling token",
      );
      cancelPurchaseToken(deps.db, {
        jti: issuedRow.jti,
        reason: "playwright_error",
        cancelledAt: now(),
        onlyIfPending: true,
      });
      return { ok: false, reason: "delivery_failed", jti: issuedRow.jti };
    }
    if (delivered.length === 0) {
      logger.error(
        {
          jti: issuedRow.jti,
          siteKey: issuedRow.siteKey,
          attempted: issuedRow.deliveredChannels,
          failed,
        },
        "purchase DM delivery failed on all channels; cancelling token",
      );
      cancelPurchaseToken(deps.db, {
        jti: issuedRow.jti,
        reason: "playwright_error",
        cancelledAt: now(),
        onlyIfPending: true,
      });
      return { ok: false, reason: "delivery_failed", jti: issuedRow.jti };
    }
    if (failed.length > 0) {
      logger.warn(
        { jti: issuedRow.jti, failed },
        "purchase DM partial delivery — proceeding with the subset that landed",
      );
    }
    logger.info(
      {
        jti: issuedRow.jti,
        siteKey: issuedRow.siteKey,
        deliveredCount: delivered.length,
        expiresAt: issuedRow.expiresAt,
      },
      "B-4 purchase token issued and DM delivered",
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
        const row = getPurchaseTokenByJti(deps.db, input.jti);
        cancelPurchaseToken(deps.db, {
          jti: input.jti,
          reason: "timeout",
          cancelledAt: now(),
          onlyIfPending: true,
        });
        return {
          status: "cancelled_timeout",
          row:
            row ??
            ((): PurchaseTokenRow => {
              throw new Error("awaitReply: token row vanished mid-await");
            })(),
        };
      }
      const row = getPurchaseTokenByJti(deps.db, input.jti);
      if (!row) {
        throw new Error(`awaitReply: token row for jti=${input.jti} missing`);
      }
      // Confirmed terminal (the finalize side has already run — possible
      // when the messaging adapter's consume + the workflow's finalize
      // both fire before our next tick).
      if (row.status === "confirmed") {
        return { status: "confirmed", row };
      }
      // Consumed but not yet finalized → workflow can proceed.
      if (row.consumedAt !== null && row.cancelledAt === null) {
        return { status: "confirmed", row };
      }
      // Cancelled by adapter (wrong reply / wrong token / explicit).
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
            return { status: "cancelled_explicit", row };
          default:
            return { status: "cancelled_other", row };
        }
      }
      // Local TTL — beat the supervisor sweep so the workflow doesn't
      // wait for the next sweep cycle.
      if (now() > row.expiresAt) {
        cancelPurchaseToken(deps.db, {
          jti: input.jti,
          reason: "timeout",
          cancelledAt: now(),
          onlyIfPending: true,
        });
        const expired = getPurchaseTokenByJti(deps.db, input.jti) ?? row;
        return { status: "cancelled_timeout", row: expired };
      }
      await sleep(pollIntervalMs, input.abortSignal);
    }
  }

  async function finalize(
    input: FinalizeInput,
  ): Promise<PurchaseTokenRow | null> {
    const row = finalizePurchaseToken(deps.db, {
      jti: input.jti,
      confirmedAmountMinor: input.confirmedAmountMinor,
      currency: input.currency,
      orderId: input.orderId,
      postScreenshotPath: input.postScreenshotPath,
      finalizedAt: now(),
    });
    if (!row) {
      logger.warn(
        { jti: input.jti },
        "purchase-handler.finalize CAS missed — already terminal?",
      );
    }
    return row;
  }

  async function cancel(
    jti: string,
    reason: PurchaseCancelReason,
    mode: CancelMode = "pending-only",
  ): Promise<PurchaseTokenRow | null> {
    const row = cancelPurchaseToken(deps.db, {
      jti,
      reason,
      cancelledAt: now(),
      onlyIfPending: mode === "pending-only",
    });
    if (row) {
      try {
        await deps.sender.deliverCancellationFollowup(capability, {
          deliveredChannels: row.deliveredChannels,
          jti: row.jti,
          siteKey: row.siteKey,
          reason,
        });
      } catch (err) {
        logger.warn(
          { err, jti, reason },
          "cancellation follow-up DM failed (continuing)",
        );
      }
    }
    return row;
  }

  async function handleTokenReply(input: {
    body: string;
    channelRef: string;
    nowMs?: number;
  }): Promise<HandleTokenReplyOutcome> {
    const nowMs = input.nowMs ?? now();
    const bodyHash = hashReplyBody(input.body);
    // Lookup the row by raw token. The pure classifier needs the row.
    // We re-parse to also handle the `shape_invalid` short circuit
    // without a DB roundtrip.
    const parsed = input.body.trim();
    const isShape = /^!~[A-Z2-7]{8}$/.test(parsed);
    const row = isShape
      ? lookupPurchaseTokenView(deps.db, parsed)
      : null;
    const decision = classifyPurchaseReply({
      body: input.body,
      channelRef: input.channelRef,
      row,
      nowMs,
    });
    const auditOutcome: PurchaseReplyOutcome =
      decision.kind === "consume"
        ? "consumed"
        : decision.kind === "wrong_channel"
          ? "wrong_channel"
          : decision.kind === "expired"
            ? "expired"
            : decision.kind === "already_consumed"
              ? "already_consumed"
              : decision.kind === "already_cancelled"
                ? "already_cancelled"
                : decision.kind === "no_match"
                  ? "no_match"
                  : "shape_invalid";
    const matchedJti =
      decision.kind === "consume" ||
      decision.kind === "wrong_channel" ||
      decision.kind === "expired" ||
      decision.kind === "already_consumed" ||
      decision.kind === "already_cancelled"
        ? decision.row.jti
        : null;

    if (decision.kind === "consume") {
      const consumed = consumePurchaseToken(deps.db, {
        jti: decision.row.jti,
        channelRef: input.channelRef,
        consumedAt: nowMs,
        nowMs,
      });
      if (!consumed) {
        // Race lost to another concurrent reply on a different channel.
        insertPurchaseReply(deps.db, {
          receivedAt: nowMs,
          channelRef: input.channelRef,
          messageBodyHash: bodyHash,
          matchedJti: decision.row.jti,
          outcome: "already_consumed",
        });
        return { kind: "already_consumed" };
      }
      insertPurchaseReply(deps.db, {
        receivedAt: nowMs,
        channelRef: input.channelRef,
        messageBodyHash: bodyHash,
        matchedJti: consumed.jti,
        outcome: "consumed",
      });
      try {
        await deps.sender.deliverPostConsumeFollowup(capability, {
          deliveredChannels: consumed.deliveredChannels,
          consumedChannel: input.channelRef,
          jti: consumed.jti,
          siteKey: consumed.siteKey,
        });
      } catch (err) {
        logger.warn(
          { err, jti: consumed.jti },
          "post-consume follow-up DM failed (continuing)",
        );
      }
      return { kind: "consumed", jti: consumed.jti, row: consumed };
    }

    insertPurchaseReply(deps.db, {
      receivedAt: nowMs,
      channelRef: input.channelRef,
      messageBodyHash: bodyHash,
      matchedJti,
      outcome: auditOutcome,
    });
    if (decision.kind === "wrong_channel") {
      // Channel leak / spoof — cancel the token defensively. The user
      // typed the correct token but on a non-delivered channel, which
      // either means they fat-fingered the channel or someone forwarded
      // the DM. Either way it's safer to abort than confirm.
      cancelPurchaseToken(deps.db, {
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

  async function handleVerifySlash(input: {
    tail: string;
    channelRef: string;
  }): Promise<HandleVerifySlashOutcome> {
    const candidate = `!~${input.tail}`;
    const row = lookupPurchaseTokenView(deps.db, candidate);
    if (!row) {
      await deps.sender.deliverVerifyReply(capability, {
        channel: input.channelRef,
        jti: null,
        ok: false,
        detail: "No pending purchase request matches that token.",
      });
      return { kind: "no_match" };
    }
    const full = getPurchaseTokenByJti(deps.db, row.jti);
    if (!full) {
      await deps.sender.deliverVerifyReply(capability, {
        channel: input.channelRef,
        jti: row.jti,
        ok: false,
        detail: "Token row vanished between lookup and verify.",
      });
      return { kind: "no_match" };
    }
    const lines: string[] = [
      `Legitimate purchase request from Aitne.`,
      `workflow=confirmCartCheckout site=${full.siteKey} jti=${full.jti}`,
      `amount=${formatMinor(full.maxAmountMinor, full.currency)} expires=${new Date(full.expiresAt).toISOString()}`,
    ];
    if (full.notesForUser) lines.push(`notes=${full.notesForUser}`);
    await deps.sender.deliverVerifyReply(capability, {
      channel: input.channelRef,
      jti: full.jti,
      ok: true,
      detail: lines.join("\n"),
    });
    return { kind: "verified", jti: full.jti, row: full };
  }

  async function handleCancelPurchaseSlash(input: {
    channelRef: string;
  }): Promise<readonly PurchaseTokenRow[]> {
    const nowMs = now();
    const pending = listPendingTokensForChannel(deps.db, input.channelRef, nowMs);
    const cancelled: PurchaseTokenRow[] = [];
    for (const row of pending) {
      const updated = cancelPurchaseToken(deps.db, {
        jti: row.jti,
        reason: "explicit",
        cancelledAt: nowMs,
        onlyIfPending: true,
      });
      if (updated) {
        cancelled.push(updated);
        try {
          await deps.sender.deliverCancellationFollowup(capability, {
            deliveredChannels: updated.deliveredChannels,
            jti: updated.jti,
            siteKey: updated.siteKey,
            reason: "explicit",
          });
        } catch (err) {
          logger.warn(
            { err, jti: updated.jti },
            "explicit-cancel follow-up DM failed (continuing)",
          );
        }
      }
    }
    insertPurchaseReply(deps.db, {
      receivedAt: nowMs,
      channelRef: input.channelRef,
      messageBodyHash: hashReplyBody("!cancel-purchase"),
      matchedJti: cancelled[0]?.jti ?? null,
      outcome: "cancel_workflow",
    });
    return cancelled;
  }

  async function cancelPendingOnNonTokenReply(input: {
    channelRef: string;
  }): Promise<readonly PurchaseTokenRow[]> {
    const nowMs = now();
    const pending = listPendingTokensForChannel(deps.db, input.channelRef, nowMs);
    if (pending.length === 0) return [];
    const cancelled: PurchaseTokenRow[] = [];
    for (const row of pending) {
      // `onlyIfPending: true` — refuse to retroactively cancel a row
      // the user has already typed the token for. Without this, a
      // race between the user's `!~xxxxxxxx` reply and a tail-message
      // arriving on the same channel could cancel a row that just
      // CAS-consumed.
      const updated = cancelPurchaseToken(deps.db, {
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
            siteKey: updated.siteKey,
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
      // Audit-trail: record one `_replies` row per cancelled token so
      // the dashboard's spoofing/replay analysis surface can correlate
      // the cancellation back to the inbound message. We do not store
      // the message body (could contain attacker-controlled text); the
      // hash domain is the literal sentinel string instead — enough
      // to bucket non-token cancellations without leaking content.
      for (const row of cancelled) {
        insertPurchaseReply(deps.db, {
          receivedAt: nowMs,
          channelRef: input.channelRef,
          messageBodyHash: hashReplyBody(
            "[non-token-reply-strict-cancel-sentinel]",
          ),
          matchedJti: row.jti,
          outcome: "cancel_workflow",
        });
      }
      logger.info(
        {
          channel: input.channelRef,
          cancelledCount: cancelled.length,
          jtis: cancelled.map((r) => r.jti),
        },
        "B-4 strict-cancel: non-token reply cancelled pending tokens (§17.3)",
      );
    }
    return cancelled;
  }

  return {
    issueToken,
    awaitReply,
    finalize,
    cancel,
    handleTokenReply,
    handleVerifySlash,
    handleCancelPurchaseSlash,
    cancelPendingOnNonTokenReply,
  };
}

/** Pure shape-narrowing on the DB row → the validator view. Lives
 *  inline so the messaging adapter can also call it via the
 *  re-exported store helpers. */
function lookupPurchaseTokenView(
  db: Database.Database,
  raw: string,
): PurchaseTokenRowView | null {
  const row = getPurchaseTokenByRaw(db, raw);
  if (!row) return null;
  return {
    jti: row.jti,
    token: row.token,
    workflowInvocationId: row.workflowInvocationId,
    siteKey: row.siteKey,
    status: row.status,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    cancelledAt: row.cancelledAt,
    deliveredChannels: row.deliveredChannels,
  };
}

/** ISO-4217 currencies with 0 decimal places. The default is 2; this
 *  set is the subset where dividing by 100 would mis-format the major
 *  unit. JPY is the only one in scope at MVP (B-4's first registered
 *  site is amazon_jp); the others stay here so a future site addition
 *  doesn't reintroduce the bug. Source: ISO-4217. */
const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "JPY",
  "KRW",
  "VND",
  "CLP",
  "ISK",
  "PYG",
  "RWF",
  "UGX",
  "BIF",
  "DJF",
  "GNF",
  "KMF",
  "MGA",
  "XAF",
  "XOF",
  "XPF",
]);

function formatMinor(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  const zeroDecimal = ZERO_DECIMAL_CURRENCIES.has(code);
  const major = zeroDecimal
    ? String(amount)
    : (amount / 100).toFixed(2);
  return `${code} ${major} (minor=${amount})`;
}

/** AbortSignal-aware sleep. Throws nothing on abort — the caller's
 *  outer loop checks `aborted` and handles the abort path explicitly. */
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
