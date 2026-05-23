/**
 * Phase B-4 purchase-confirmation DM dispatcher.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.3 / §17.7 / §13 step 52.
 *
 * This module is the "sendSystemMessage" surface §17.7 specifies. The
 * agent cannot reach it: every exported method requires the unforgeable
 * capability symbol minted in `purchase-handler.ts`. The daemon
 * bootstrap path acquires the symbol via the dedicated getter and
 * passes it into both the handler and this sender; no other code path
 * can mint it.
 *
 * The classifier `classifyPurchaseConfirmationTemplate` defends the
 * other direction: any agent-tool-originated outbound message
 * containing the reserved structural markers ("Aitne purchase
 * confirmation", "[purchase-verify:", "Approved on …") is refused by
 * the agent-facing outbound chokepoint
 * (`safety/outbound-purchase-guard.ts`). Together, the two halves
 * close the structural-anti-spoofing surface.
 */

import { createLogger } from "../logging.js";
import {
  MessageDeliveryError,
  type MessageHub,
} from "../adapters/message-hub.js";
import {
  parseChannelRef,
} from "../db/browser-automation-purchase-primary-channels-store.js";
import {
  __aitneB4_getPurchaseHandlerCapability,
  type PurchaseHandlerCapability,
  type PurchaseSystemMessageSender,
} from "../services/browser-history/automation/purchase-handler.js";
import {
  PURCHASE_CONFIRMATION_HEADER,
  redactToken,
} from "../services/browser-history/automation/purchase-tokens.js";
import type { PurchaseCancelReason } from "../db/browser-automation-purchase-tokens-store.js";

const logger = createLogger("purchase-system-message-sender");

/** ISO-4217 currencies with 0 decimal places (subset; mirrors the
 *  purchase-handler's formatter). */
const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "JPY", "KRW", "VND", "CLP", "ISK", "PYG", "RWF", "UGX",
  "BIF", "DJF", "GNF", "KMF", "MGA", "XAF", "XOF", "XPF",
]);

function formatAmount(amountMinor: number, currency: string): string {
  const code = currency.toUpperCase();
  const zeroDecimal = ZERO_DECIMAL_CURRENCIES.has(code);
  const major = zeroDecimal
    ? amountMinor.toLocaleString("en-US")
    : (amountMinor / 100).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
  return code === "JPY" ? `¥${major}` : `${code} ${major}`;
}

function formatExpiry(expiresAtMs: number, nowMs: number): string {
  const remainingMs = Math.max(0, expiresAtMs - nowMs);
  const minutes = Math.floor(remainingMs / 60000);
  const seconds = Math.floor((remainingMs % 60000) / 1000);
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export interface CreatePurchaseSenderDeps {
  messageHub: MessageHub;
  /** Base URL the daemon serves traces at — defaults to
   *  `http://localhost:<PA_API_PORT>`; injected so the dashboard can
   *  swap to a public-facing tunnel URL in tests. */
  traceUrlBase?: string;
  /** Override for tests; production uses Date.now. */
  nowFn?: () => number;
}

/**
 * Construct the credentialed sender. The factory grabs the capability
 * via the private getter — there's no other way to obtain one, which is
 * what makes the surface "module-level credential" §17.7 requires.
 *
 * Every method asserts the incoming `capability` matches the module's
 * minted symbol. A mismatched / forged capability throws; the throw is
 * the structural enforcement of "agent tools cannot mint this".
 */
export function createPurchaseSystemMessageSender(
  deps: CreatePurchaseSenderDeps,
): PurchaseSystemMessageSender {
  const expected = __aitneB4_getPurchaseHandlerCapability();
  const now = deps.nowFn ?? (() => Date.now());
  const base = deps.traceUrlBase ?? "";

  function assertCapability(received: PurchaseHandlerCapability): void {
    if (received !== expected) {
      throw new Error(
        "purchase-system-message-sender: capability mismatch — refusing dispatch",
      );
    }
  }

  function buildTraceUrl(path: string): string {
    if (!path) return "";
    if (path.startsWith("http://") || path.startsWith("https://")) return path;
    return base ? `${base}${path}` : path;
  }

  async function dispatch(
    ref: string,
    text: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const parsed = parseChannelRef(ref);
    if (!parsed) {
      return { ok: false, reason: "invalid_ref" };
    }
    try {
      await deps.messageHub.sendToPlatform(
        parsed.platform,
        parsed.channelId,
        text,
      );
      return { ok: true };
    } catch (err) {
      const reason =
        err instanceof MessageDeliveryError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      logger.warn({ ref, reason }, "B-4 system DM dispatch failed");
      return { ok: false, reason };
    }
  }

  return {
    async deliverPurchaseRequest(capability, input): Promise<{
      delivered: readonly string[];
      failed: readonly string[];
    }> {
      assertCapability(capability);
      const traceUrl = buildTraceUrl(input.preScreenshotPath);
      const headerLine = `🔐 ${PURCHASE_CONFIRMATION_HEADER}`;
      const lines = [
        headerLine,
        `Site: ${input.siteKey}`,
        `Total: ${formatAmount(input.displayedTotalMinor, input.currency)}`,
        `Pre-confirm screenshot: ${traceUrl}`,
        input.notesForUser
          ? `Agent's rationale: ${input.notesForUser}`
          : null,
        `Expires in ${formatExpiry(input.expiresAt, now())} — reply with the exact token below to confirm.`,
        ``,
        input.token,
        ``,
        `[purchase-verify: !verify ${input.token.slice(2)}] · [cancel: !cancel-purchase] · jti=${input.jti}`,
      ]
        .filter((s): s is string => s !== null)
        .join("\n");
      const delivered: string[] = [];
      const failed: string[] = [];
      for (const ref of input.channels) {
        const result = await dispatch(ref, lines);
        if (result.ok) delivered.push(ref);
        else failed.push(ref);
      }
      logger.info(
        {
          jti: input.jti,
          siteKey: input.siteKey,
          tokenRedacted: redactToken(input.token),
          deliveredCount: delivered.length,
          failedCount: failed.length,
        },
        "B-4 purchase request DM dispatched",
      );
      return { delivered, failed };
    },

    async deliverPostConsumeFollowup(capability, input): Promise<void> {
      assertCapability(capability);
      const consumedMsg =
        `✅ Confirmed. Aitne is finalising the purchase now. jti=${input.jti}`;
      const otherMsg = (consumedOn: string): string =>
        `✅ Approved on ${consumedOn} at ${new Date(now()).toISOString()}. No action needed here. jti=${input.jti}`;
      for (const ref of input.deliveredChannels) {
        const text =
          ref === input.consumedChannel
            ? consumedMsg
            : otherMsg(input.consumedChannel);
        const result = await dispatch(ref, text);
        if (!result.ok) {
          logger.warn(
            { jti: input.jti, ref, reason: result.reason },
            "post-consume follow-up dispatch failed (continuing)",
          );
        }
      }
    },

    async deliverCancellationFollowup(capability, input): Promise<void> {
      assertCapability(capability);
      const text =
        `⚠️ Purchase request cancelled (${input.reason}). No charge made. jti=${input.jti}`;
      for (const ref of input.deliveredChannels) {
        const result = await dispatch(ref, text);
        if (!result.ok) {
          logger.warn(
            { jti: input.jti, ref, reason: result.reason },
            "cancellation follow-up dispatch failed (continuing)",
          );
        }
      }
    },

    async deliverVerifyReply(capability, input): Promise<void> {
      assertCapability(capability);
      const marker = input.ok ? "✅" : "⚠️";
      const text = `${marker} ${input.detail}`;
      const result = await dispatch(input.channel, text);
      if (!result.ok) {
        logger.warn(
          { jti: input.jti, channel: input.channel, reason: result.reason },
          "verify reply dispatch failed",
        );
      }
    },
  };
}

/**
 * Convenience helper for the cancellation follow-up's audit message —
 * exported so other daemon-internal cancel paths (the supervisor's
 * orphan sweep, the dashboard's "cancel pending" action) format the
 * cancel reason identically. Pure — no I/O.
 */
export function describeCancelReason(reason: PurchaseCancelReason): string {
  switch (reason) {
    case "user_reply":
      return "user replied with non-token content";
    case "wrong_token":
      return "user replied with a different token";
    case "wrong_channel":
      return "token typed on a non-delivered channel";
    case "timeout":
      return "5-minute confirmation window elapsed";
    case "explicit":
      return "user issued !cancel-purchase";
    case "amount_mismatch":
      return "cart total changed under the confirmation pause";
    case "amount_exceeds_token":
      return "displayed total exceeded the confirmed amount";
    case "page_changed":
      return "cart page mutated during the pause";
    case "playwright_error":
      return "browser-automation error before confirm";
    case "daily_cap_exceeded":
      return "per-day spend cap reached at resume";
    case "b4_disabled":
      return "B-4 master toggle was turned off";
    case "site_not_enabled":
      return "site B-4 was disabled mid-flight";
    case "supervisor_orphan_sweep":
      return "daemon restart cleaned up an in-flight token";
    case "dashboard_cancel":
      return "user clicked Cancel in the dashboard";
  }
}
