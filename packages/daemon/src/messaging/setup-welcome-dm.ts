import type Database from "better-sqlite3";
import {
  MessageDeliveryError,
  type MessageDelivery,
  type MessageHub,
} from "../adapters/message-hub.js";
import { readRuntimeState, writeRuntimeState } from "../db/runtime-state.js";
import { createLogger } from "../logging.js";

const logger = createLogger("setup-welcome-dm");

// runtime_state latch key. Reset only on clean reinstall (db wipe).
export const WELCOME_DM_RUNTIME_STATE_KEY = "setup.welcome_dm_sent";

// Bang commands referenced below must stay in sync with the registry seeded
// in `core/bang-commands/index.ts:createDefaultBangCommandRegistry`. Wording
// stays in English on purpose: the welcome is daemon-emitted system copy
// (not LLM output), so the `<output_language_policy>` block that governs
// agent DMs does not apply here. Skill/system copy is English-only per the
// project's US-targeted positioning.
//
// `integrations` (not `commands`) is the configurable surface: integration
// modes (direct/delegated/native/disabled), backend bindings, quiet hours,
// budgets etc. are all toggled from the dashboard. Bang commands themselves
// are code-defined (auto-discovered handlers) and not user-tunable.
export const WELCOME_DM_TEXT = [
  "Welcome to Aitne — thanks for setting up!",
  "",
  "I'm your local-first assistant. I keep an eye on your calendar, mail, and notes, and help you stay on top of your day.",
  "",
  "A few quick commands:",
  "• `!cost` — today's spend",
  "• `!ingest` — pull notes in",
  "• `!compile` — rebuild your wiki",
  "• `!help` — see everything",
  "",
  "Toggle features and integrations from the dashboard → Docs.",
  "",
  "Send a message anytime — I'll take it from here.",
].join("\n");

interface WelcomeDmLatch {
  sentAt: string;
  platforms: string[];
}

/**
 * Fire the post-setup welcome DM to every connected external messaging
 * platform (Slack/Telegram/Discord/WhatsApp). Latched via runtime_state so
 * re-running setup or re-firing onSetupComplete never double-sends.
 *
 * Dashboard is intentionally excluded: it isn't in
 * `NOTIFICATION_DESTINATION_PLATFORMS` (see `messaging/constants.ts`) and
 * the dashboard's own setup wizard already greets the user in-app. If no
 * external messaging platform is configured at completion time, this is a
 * silent no-op.
 *
 * Idempotency: the latch is written ONLY on a non-empty successful delivery.
 * Partial failure (1 of N platforms) latches with just the delivered set —
 * the unreached platform is never retried (best-effort welcome).
 *
 * Durability caveat: `onSetupComplete` does not re-fire on daemon restart.
 * If the daemon crashes between the setup endpoint returning and the
 * welcome dispatching, the welcome is lost until the user re-runs the setup
 * wizard. This is accepted scope — making it durable would require an
 * orthogonal "pending welcome" reconciler.
 */
export async function sendSetupWelcomeDm(params: {
  db: Database.Database;
  messageHub: MessageHub;
}): Promise<MessageDelivery[] | null> {
  const { db, messageHub } = params;

  const existing = readRuntimeState<WelcomeDmLatch>(
    db,
    WELCOME_DM_RUNTIME_STATE_KEY,
  );
  if (existing) {
    logger.debug(
      { sentAt: existing.sentAt, platforms: existing.platforms },
      "Welcome DM already sent; skipping",
    );
    return null;
  }

  const eligible = messageHub.getNotificationEligiblePlatforms();
  if (eligible.length === 0) {
    logger.info(
      "No eligible messaging destination at setup completion; welcome DM skipped",
    );
    return null;
  }

  let deliveries: MessageDelivery[];
  try {
    deliveries = await messageHub.sendToUser(WELCOME_DM_TEXT);
  } catch (err) {
    if (err instanceof MessageDeliveryError) {
      logger.info(
        { reason: err.message },
        "Welcome DM not delivered (no destination)",
      );
      return null;
    }
    logger.warn(
      { err },
      "Welcome DM delivery failed; will retry on next setup completion",
    );
    return null;
  }

  const latch: WelcomeDmLatch = {
    sentAt: new Date().toISOString(),
    platforms: deliveries.map((d) => d.platform),
  };
  writeRuntimeState(db, WELCOME_DM_RUNTIME_STATE_KEY, latch);

  logger.info(
    { platforms: deliveries.map((d) => d.platform) },
    "Welcome DM sent",
  );
  return deliveries;
}
