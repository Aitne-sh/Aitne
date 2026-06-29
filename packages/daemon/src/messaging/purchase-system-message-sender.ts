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
import type { OutboundAttachmentRef } from "../adapters/types.js";
import {
  resolveScreenshotAttachment,
  type IngestOutboundImage,
} from "./browser-task-screenshot-attachment.js";
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
  /** Daemon data directory (`PA_DATA_DIR`). Resolves the pre-confirm
   *  screenshot key to its on-disk trace file so the bytes are attached
   *  inline (messaging native upload / dashboard ingest) rather than sent
   *  as a loopback URL the user cannot reach. */
  paDataDir?: string;
  /** Ingest hook for the `dashboard` platform — see
   *  `browser-task-screenshot-attachment.ts`. */
  ingestOutboundImage?: IngestOutboundImage;
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
  const paDataDir = deps.paDataDir ?? null;

  function assertCapability(received: PurchaseHandlerCapability): void {
    if (received !== expected) {
      throw new Error(
        "purchase-system-message-sender: capability mismatch — refusing dispatch",
      );
    }
  }

  // The pre-confirm screenshot is delivered as actual image bytes — native
  // upload for messaging adapters, AttachmentStore ingest for the dashboard —
  // never a loopback trace URL (a phone cannot reach it; a raw dashboard
  // <img> cannot authenticate it). See `browser-task-screenshot-attachment`.
  async function dispatch(
    ref: string,
    text: string,
    screenshotKey?: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const parsed = parseChannelRef(ref);
    if (!parsed) {
      return { ok: false, reason: "invalid_ref" };
    }
    let attachments: OutboundAttachmentRef[] | undefined;
    if (screenshotKey) {
      const att = await resolveScreenshotAttachment({
        platform: parsed.platform,
        key: screenshotKey,
        paDataDir,
        ingestOutboundImage: deps.ingestOutboundImage,
      });
      if (att) attachments = [att];
    }
    try {
      await deps.messageHub.sendToPlatform(
        parsed.platform,
        parsed.channelId,
        text,
        undefined,
        attachments,
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
      const headerLine = `🔐 ${PURCHASE_CONFIRMATION_HEADER}`;
      const lines = [
        headerLine,
        `Site: ${input.siteKey}`,
        `Total: ${formatAmount(input.displayedTotalMinor, input.currency)}`,
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
      const screenshotKey = input.preScreenshotPath || undefined;
      const delivered: string[] = [];
      const failed: string[] = [];
      for (const ref of input.channels) {
        const result = await dispatch(ref, lines, screenshotKey);
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
