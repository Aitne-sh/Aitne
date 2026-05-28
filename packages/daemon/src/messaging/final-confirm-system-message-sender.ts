/**
 * Lite-final-confirm DM dispatcher — BROWSER_TASK_REDESIGN_PLAN.md §5 / §14.11.
 *
 * Parallel to `purchase-system-message-sender.ts` (B-4 purchase
 * confirmations). The two coexist because:
 *
 *  - B-4 dispatches "Aitne purchase confirmation" templates gated by a
 *    per-site config + amount + currency.
 *  - The lite path dispatches a narrower "Aitne confirmation required"
 *    template for any irreversible action the browser-task sub-agent
 *    flagged via the final-confirm gate — no purchase amount, no
 *    currency, no per-site B-4 config.
 *
 * Both share the `!~xxxxxxxx` envelope so the messaging adapter's
 * inbound jti-prefix dispatcher (§14.11 Q#6) can route a single reply
 * to whichever store holds the matching token. The DM header text
 * intentionally differs ("Aitne confirmation required" vs "Aitne
 * purchase confirmation") so the outbound purchase-guard's marker set
 * does not falsely flag the lite path, and so the user can tell the two
 * apart at a glance.
 *
 * Structural anti-spoofing mirrors B-4: every exported method asserts
 * the unforgeable capability symbol minted in `final-confirm-handler.ts`
 * — an agent tool that somehow obtains a reference to this sender still
 * cannot mint the symbol and the dispatch throws.
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
import { parseChannelRef } from "../db/browser-automation-purchase-primary-channels-store.js";
import {
  __aitneFinalConfirm_getCapability,
  type FinalConfirmHandlerCapability,
  type FinalConfirmSystemMessageSender,
} from "../services/browser-history/automation/final-confirm-handler.js";
import { redactToken } from "../services/browser-history/automation/lite-final-confirm-tokens.js";
import type { LiteFinalConfirmCancelReason } from "../db/browser-task-final-confirm-tokens-store.js";

const logger = createLogger("final-confirm-system-message-sender");

/** Header marker line distinct from B-4's `PURCHASE_CONFIRMATION_HEADER`
 *  so the agent-facing outbound guard's deny-list cannot collide. */
export const FINAL_CONFIRM_REQUEST_HEADER = "Aitne confirmation required";

function formatExpiry(expiresAtMs: number, nowMs: number): string {
  const remainingMs = Math.max(0, expiresAtMs - nowMs);
  const minutes = Math.floor(remainingMs / 60000);
  const seconds = Math.floor((remainingMs % 60000) / 1000);
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export interface CreateFinalConfirmSenderDeps {
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

export function createFinalConfirmSystemMessageSender(
  deps: CreateFinalConfirmSenderDeps,
): FinalConfirmSystemMessageSender {
  const expected = __aitneFinalConfirm_getCapability();
  const now = deps.nowFn ?? (() => Date.now());
  const paDataDir = deps.paDataDir ?? null;

  function assertCapability(received: FinalConfirmHandlerCapability): void {
    if (received !== expected) {
      throw new Error(
        "final-confirm-system-message-sender: capability mismatch — refusing dispatch",
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
    if (!parsed) return { ok: false, reason: "invalid_ref" };
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
      logger.warn(
        { ref, reason },
        "lite-final-confirm system DM dispatch failed",
      );
      return { ok: false, reason };
    }
  }

  return {
    async deliverConfirmRequest(capability, input): Promise<{
      delivered: readonly string[];
      failed: readonly string[];
    }> {
      assertCapability(capability);
      const lines = [
        `🔐 ${FINAL_CONFIRM_REQUEST_HEADER}`,
        `Task: ${input.taskId}`,
        `Action: ${input.actionSummary}`,
        `Expires in ${formatExpiry(input.expiresAt, now())} — reply with the exact token below to confirm.`,
        ``,
        input.token,
        ``,
        `jti=${input.jti}`,
      ].join("\n");
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
          taskId: input.taskId,
          tokenRedacted: redactToken(input.token),
          deliveredCount: delivered.length,
          failedCount: failed.length,
        },
        "lite-final-confirm request DM dispatched",
      );
      return { delivered, failed };
    },

    async deliverPostConsumeFollowup(capability, input): Promise<void> {
      assertCapability(capability);
      const consumedMsg = `✅ Confirmed. Aitne is proceeding with the action now. jti=${input.jti}`;
      const otherMsg = (consumedOn: string): string =>
        `✅ Confirmed on ${consumedOn} at ${new Date(now()).toISOString()}. No action needed here. jti=${input.jti}`;
      for (const ref of input.deliveredChannels) {
        const text =
          ref === input.consumedChannel
            ? consumedMsg
            : otherMsg(input.consumedChannel);
        const result = await dispatch(ref, text);
        if (!result.ok) {
          logger.warn(
            { jti: input.jti, ref, reason: result.reason },
            "lite-final-confirm post-consume follow-up dispatch failed (continuing)",
          );
        }
      }
    },

    async deliverCancellationFollowup(capability, input): Promise<void> {
      assertCapability(capability);
      const text = `⚠️ Confirmation cancelled (${describeLiteFinalConfirmCancelReason(input.reason)}). The pending action was NOT taken. jti=${input.jti}`;
      for (const ref of input.deliveredChannels) {
        const result = await dispatch(ref, text);
        if (!result.ok) {
          logger.warn(
            { jti: input.jti, ref, reason: result.reason },
            "lite-final-confirm cancellation follow-up dispatch failed (continuing)",
          );
        }
      }
    },
  };
}

/**
 * Human-readable cancel-reason renderer for the lite path. Mirrors
 * `describeCancelReason` in `purchase-system-message-sender.ts` so the
 * user sees consistent vocabulary across both surfaces.
 */
export function describeLiteFinalConfirmCancelReason(
  reason: LiteFinalConfirmCancelReason,
): string {
  switch (reason) {
    case "user_reply":
      return "you replied with non-token content";
    case "wrong_token":
      return "the token did not match";
    case "wrong_channel":
      return "the token was typed on a non-delivered channel";
    case "timeout":
      return "the 5-minute confirmation window elapsed";
    case "explicit":
      return "you issued an explicit cancel";
    case "task_cancelled":
      return "the parent task was cancelled or completed";
    case "dashboard_cancel":
      return "you clicked Cancel in the dashboard";
  }
}
