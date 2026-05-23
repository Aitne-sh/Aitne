/**
 * Outbound-purchase-template guard — the daemon-internal chokepoint
 * that refuses any agent-tool-originated outbound message carrying the
 * §17.7 reserved structural markers.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.7 / §13 step 54.
 *
 * The classifier (`automation/purchase-tokens.ts:classifyPurchaseConfirmationTemplate`)
 * detects the markers. This module is the wiring layer that asserts /
 * audits / refuses. Daemon-side outbound (the
 * `purchase-system-message-sender` module) bypasses this guard because
 * its `sendSystemMessage` requires the unforgeable handler capability.
 *
 * Wired in two places:
 *   - POST /api/notify (the LLM's primary "send DM" route)
 *   - The bang-command `notify()` wrapper (LLM-driven `!`-command
 *     replies — defence-in-depth in case a future bang handler echoes
 *     attacker-controlled content)
 *
 * The wrapper writes an `agent_actions` audit row on a match so an
 * operator can see exactly which agent path tried to spoof.
 */

import type Database from "better-sqlite3";

import { createLogger } from "../logging.js";
import {
  classifyPurchaseConfirmationTemplate,
  type PurchaseConfirmationTemplateMatch,
} from "../services/browser-history/automation/purchase-tokens.js";

const logger = createLogger("outbound-purchase-guard");

export class OutboundPurchaseTemplateError extends Error {
  constructor(
    public readonly match: PurchaseConfirmationTemplateMatch,
    public readonly origin: string,
  ) {
    super(
      `outbound message refused — reserved purchase-template marker "${match.marker}" detected (origin=${origin})`,
    );
    this.name = "OutboundPurchaseTemplateError";
  }
}

export interface AuditOutboundRefusalInput {
  db: Database.Database;
  origin: string;
  marker: string;
  /** Truncated preview of the offending body — first 80 chars. NEVER
   *  log the full message; an attacker-controlled body that smuggles a
   *  legitimate-looking marker should not bloat the audit. */
  preview: string;
}

/** Persist a structured `agent_actions` row so the dashboard's
 *  "Recent agent activity" view surfaces the refusal. Best-effort —
 *  a DB write failure is logged but never re-thrown (the caller's
 *  refusal path is the load-bearing signal).
 *
 *  Implementation note: `result` is `'failed'` (not `'blocked'`) because
 *  the `agent_actions.result` CHECK constraint only permits the canonical
 *  settle states (success / failed / partial / skipped / in_progress).
 *  A literal `'blocked'` would silently violate the constraint and the
 *  try/catch would swallow the audit — losing every refusal row. The
 *  `action_type='purchase_template_refused'` is the discriminator that
 *  lets dashboards / queries distinguish this from a real agent failure.
 *  Mirrors the `blocked_absolute` precedent in `absolute-block-audit.ts`. */
export function auditOutboundRefusal(input: AuditOutboundRefusalInput): void {
  try {
    input.db
      .prepare(
        `INSERT INTO agent_actions
           (action_type, trigger, result, detail, completed_at, source_kind)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
      )
      .run(
        "purchase_template_refused",
        input.origin,
        "failed",
        JSON.stringify({ marker: input.marker, preview: input.preview }),
        "agent",
      );
  } catch (err) {
    logger.warn(
      { err, origin: input.origin },
      "failed to write purchase_template_refused audit row",
    );
  }
}

/**
 * Throw `OutboundPurchaseTemplateError` if the message body carries a
 * reserved marker. Pure-ish — when given a DB handle, also audits the
 * refusal. The `origin` argument identifies which agent path is the
 * caller (e.g., `"api.notify"`, `"bang.commands"`) so the audit row
 * can pinpoint the surface that mis-routed.
 */
export function assertOutboundAllowedForAgent(
  body: string,
  origin: string,
  db?: Database.Database,
): void {
  const match = classifyPurchaseConfirmationTemplate(body);
  if (!match) return;
  if (db) {
    auditOutboundRefusal({
      db,
      origin,
      marker: match.marker,
      preview: body.slice(0, 80),
    });
  }
  logger.warn(
    { origin, marker: match.marker, preview: body.slice(0, 80) },
    "outbound message refused — reserved purchase-template marker",
  );
  throw new OutboundPurchaseTemplateError(match, origin);
}
