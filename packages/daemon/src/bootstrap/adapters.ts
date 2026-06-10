/**
 * Messaging-adapter bootstrap — Discord / Slack / Telegram / WhatsApp.
 *
 * Extracted from the `startup()` IIFE in `index.ts` per
 * `docs/design/appendices/file-split-plan.md` §10 (Tier 2, Pattern C).
 *
 * Goal: lift the four reload routines + the WhatsApp build/teardown
 * helpers out of the startup lambda so the lambda reads as a sequence
 * rather than a 3,000-line bag of closures.
 *
 * Shape: `createAdapterReloaders(deps)` is a factory that captures a
 * `BootstrapAdapterDeps` record once and returns the closures the IIFE
 * used to define inline. The mutable adapter references live in a
 * shared `AdapterState` object passed in via `deps.state`, which the
 * factory reads and writes — `index.ts` continues to inspect the same
 * state for pairing / `/health` reporting after the reload functions
 * complete. Captured references match the pre-extraction behavior:
 *  - The closures register / unregister with `messageHub`.
 *  - `onMessage` enqueues to `eventBus`.
 *  - Discovered owner ids flow back through `recordDetectedOwner`.
 *  - Attachment downloads use the shared `attachmentStore`.
 *  - WhatsApp logout fires `onWhatsAppLoggedOut`, which currently
 *    posts a fallback notification through the message hub.
 *
 * `whatsappQrResponseFromAdapter` is a pure projection from
 * adapter+snapshot → wire response and is exported separately so the
 * dashboard controls path can call it without going through the
 * factory.
 */

import { join } from "node:path";
import type { EventBus } from "../core/event-bus.js";
import type { AgentConfig } from "../config.js";
import type { SecretBroker } from "../secrets/secret-broker.js";
import type { MessageHub } from "../adapters/message-hub.js";
import type { AttachmentStore } from "../services/attachments/store.js";
import { DiscordAdapter } from "../adapters/discord.js";
import { SlackAdapter } from "../adapters/slack-adapter.js";
import { TelegramAdapter } from "../adapters/telegram-adapter.js";
import {
  WhatsAppAdapter,
  type WhatsAppQrSnapshot,
} from "../adapters/whatsapp-adapter.js";
import type { WhatsAppQrResponse } from "../api/server.js";
import { AdapterWatchdog } from "../adapters/adapter-watchdog.js";
import type { AdapterConnectionState } from "../adapters/types.js";
import { createLogger, toSafeErrorMessage } from "../logging.js";

const logger = createLogger("daemon-bootstrap-adapters");

/**
 * Mutable holder for the live adapter instances. The bootstrap factory
 * updates these fields in place; `index.ts` and the dashboard-controls
 * surface read them directly.
 */
export interface AdapterState {
  discord: DiscordAdapter | null;
  slack: SlackAdapter | null;
  telegram: TelegramAdapter | null;
  whatsapp: WhatsAppAdapter | null;
}

/**
 * Wide config-and-services bag that the reload routines used to close
 * over from the startup IIFE. Pattern C in the file-split plan: name
 * the bag once at call site, don't thread the fields through every
 * function.
 */
export interface BootstrapAdapterDeps {
  readonly config: AgentConfig;
  readonly secretBroker: SecretBroker;
  readonly messageHub: MessageHub;
  readonly eventBus: EventBus;
  readonly attachmentStore: AttachmentStore;
  readonly recordDetectedOwner: (
    platform: "slack" | "telegram" | "discord",
    ownerId: string,
  ) => Promise<void>;
  /**
   * Invoked from inside the WhatsApp adapter when Baileys reports a
   * logged-out session. The current implementation posts a fallback
   * notification through `messageHub.sendToUser`; isolated as a
   * callback so this module doesn't take a direct dependency on the
   * notification surface.
   */
  readonly onWhatsAppLoggedOut: () => Promise<void>;
  readonly state: AdapterState;
}

export interface AdapterReloaders {
  reloadDiscordAdapter(startNow: boolean): Promise<void>;
  reloadSlackAdapter(startNow: boolean): Promise<void>;
  reloadTelegramAdapter(startNow: boolean): Promise<void>;
  /**
   * Build (or rebuild) the WhatsApp adapter from current config and
   * register it with the MessageHub. Idempotent: returns the existing
   * adapter if it is already in the hub. Throws if
   * `whatsappOwnerPhone` is missing.
   */
  buildWhatsAppAdapter(): WhatsAppAdapter;
  /**
   * Tear down the WhatsApp adapter completely. Used by the dashboard
   * `whatsappEnabled=false` toggle so we don't keep a stale Baileys
   * socket around. Logs but does not throw on socket close errors.
   */
  teardownWhatsAppAdapter(): Promise<void>;
  /**
   * Dashboard "enable WhatsApp" control — builds the adapter (if not
   * already built) and starts it if the current Baileys status is
   * `disabled`. Separated from `buildWhatsAppAdapter` so the local
   * variable inside the controls registration object can avoid a
   * circular reference.
   */
  enableWhatsAppAdapter(): Promise<void>;
}

export function createAdapterReloaders(
  deps: BootstrapAdapterDeps,
): AdapterReloaders {
  const {
    config,
    secretBroker,
    messageHub,
    eventBus,
    attachmentStore,
    recordDetectedOwner,
    onWhatsAppLoggedOut,
    state,
  } = deps;

  async function reloadDiscordAdapter(startNow: boolean): Promise<void> {
    const botToken = await secretBroker.getDiscordBotToken();
    const configured = !!botToken;
    messageHub.setPlatformConfigured("discord", configured);

    if (state.discord) {
      try {
        await state.discord.stop();
      } catch (err) {
        logger.warn({ err }, "Failed to stop Discord adapter during reload");
      }
      messageHub.unregister("discord");
      state.discord = null;
    }

    if (!botToken) {
      return;
    }

    state.discord = new DiscordAdapter({
      botToken,
      ownerUserId: config.discordOwnerUserId,
      onMessage: (event) => void eventBus.put(event),
      onOwnerDetected: (userId) => recordDetectedOwner("discord", userId),
      attachmentStore,
    });
    messageHub.register(state.discord);

    if (startNow) {
      // P2-04: `register()` now seeds the status as "connecting" too, so
      // this explicit set is redundant in the happy path. Kept as a
      // defensive marker that the await-start() block below is the
      // single transition site to "ok" / "error" for this adapter — a
      // future refactor that adds work between `register()` and `start()`
      // (e.g. token validation) won't accidentally let /health observe
      // an "ok" status during that gap.
      messageHub.setPlatformRuntimeStatus("discord", { runtimeState: "connecting", error: null });
      try {
        await state.discord.start();
        messageHub.setPlatformRuntimeStatus("discord", { runtimeState: "ok", error: null });
      } catch (err) {
        const message = toSafeErrorMessage(err, "Discord adapter failed to start");
        messageHub.setPlatformRuntimeStatus("discord", { runtimeState: "error", error: message });
        logger.error({ err }, "Failed to start Discord adapter during reload");
      }
    }
  }

  async function reloadSlackAdapter(startNow: boolean): Promise<void> {
    const [botToken, appToken] = await Promise.all([
      secretBroker.getSlackBotToken(),
      secretBroker.getSlackAppToken(),
    ]);
    const configured = !!(botToken && appToken);
    messageHub.setPlatformConfigured("slack", configured);

    if (state.slack) {
      try {
        await state.slack.stop();
      } catch (err) {
        logger.warn({ err }, "Failed to stop Slack adapter during reload");
      }
      messageHub.unregister("slack");
      state.slack = null;
    }

    if (!botToken || !appToken) {
      return;
    }

    state.slack = new SlackAdapter({
      botToken,
      appToken,
      ownerUserId: config.slackOwnerUserId,
      onMessage: (event) => void eventBus.put(event),
      onOwnerDetected: (userId) => recordDetectedOwner("slack", userId),
      attachmentStore,
    });
    messageHub.register(state.slack);

    if (startNow) {
      messageHub.setPlatformRuntimeStatus("slack", { runtimeState: "connecting", error: null });
      try {
        await state.slack.start();
        messageHub.setPlatformRuntimeStatus("slack", { runtimeState: "ok", error: null });
      } catch (err) {
        const message = toSafeErrorMessage(err, "Slack adapter failed to start");
        messageHub.setPlatformRuntimeStatus("slack", { runtimeState: "error", error: message });
        logger.error({ err }, "Failed to start Slack adapter during reload");
      }
    }
  }

  async function reloadTelegramAdapter(startNow: boolean): Promise<void> {
    const botToken = await secretBroker.getTelegramBotToken();
    const configured = !!botToken;
    messageHub.setPlatformConfigured("telegram", configured);

    if (state.telegram) {
      try {
        await state.telegram.stop();
      } catch (err) {
        logger.warn({ err }, "Failed to stop Telegram adapter during reload");
      }
      messageHub.unregister("telegram");
      state.telegram = null;
    }

    if (!botToken) {
      return;
    }

    state.telegram = new TelegramAdapter({
      botToken,
      ownerChatId: config.telegramOwnerChatId,
      onMessage: (event) => void eventBus.put(event),
      onOwnerDetected: (chatId) => recordDetectedOwner("telegram", chatId),
      attachmentStore,
    });
    messageHub.register(state.telegram);

    if (startNow) {
      messageHub.setPlatformRuntimeStatus("telegram", { runtimeState: "connecting", error: null });
      try {
        await state.telegram.start();
        messageHub.setPlatformRuntimeStatus("telegram", { runtimeState: "ok", error: null });
      } catch (err) {
        const message = toSafeErrorMessage(err, "Telegram adapter failed to start");
        messageHub.setPlatformRuntimeStatus("telegram", { runtimeState: "error", error: message });
        logger.error({ err }, "Failed to start Telegram adapter during reload");
      }
    }
  }

  function buildWhatsAppAdapter(): WhatsAppAdapter {
    if (!config.whatsappOwnerPhone) {
      throw new Error(
        "Cannot enable WhatsApp: PA_WHATSAPP_OWNER_PHONE is not set",
      );
    }
    const existing = messageHub.getAdapter("whatsapp");
    if (existing && state.whatsapp && existing === state.whatsapp) {
      return state.whatsapp;
    }
    const adapter = new WhatsAppAdapter({
      ownerPhone: config.whatsappOwnerPhone,
      authDir: config.whatsappAuthDir ?? join(config.dataDir, "whatsapp", "auth"),
      onMessage: (event) => void eventBus.put(event),
      attachmentStore,
      onLoggedOut: onWhatsAppLoggedOut,
    });
    messageHub.register(adapter);
    state.whatsapp = adapter;
    return adapter;
  }

  async function teardownWhatsAppAdapter(): Promise<void> {
    if (!state.whatsapp) return;
    try {
      await state.whatsapp.stop();
    } catch (err) {
      logger.warn({ err }, "Error stopping WhatsApp adapter during teardown");
    }
    messageHub.unregister("whatsapp");
    state.whatsapp = null;
  }

  async function enableWhatsAppAdapter(): Promise<void> {
    const adapter = buildWhatsAppAdapter();
    if (adapter.getStatus() === "disabled") {
      await adapter.start();
    }
  }

  return {
    reloadDiscordAdapter,
    reloadSlackAdapter,
    reloadTelegramAdapter,
    buildWhatsAppAdapter,
    teardownWhatsAppAdapter,
    enableWhatsAppAdapter,
  };
}

/**
 * Build the connection watchdog for the library-managed adapters
 * (Slack socket-mode, Discord gateway, Telegram long-poll).
 *
 * Each entry reads the live instance out of the mutable `AdapterState`
 * slot — a reload that swaps the instance is picked up on the next probe
 * automatically — and restarts through the bootstrap reloader so the
 * stop→register→start lifecycle (and its MessageHub status transitions)
 * stays in one place. WhatsApp is deliberately NOT watched: the Baileys
 * adapter owns a sustained reconnect watch with ban-risk-aware pacing
 * that a blunt stop→start cycle would fight against.
 *
 * On a down/recovery transition the hub status flips to error/ok so
 * `/health` and notification-eligibility reflect the live socket state
 * instead of the boot-time snapshot (pre-watchdog, a dead socket kept
 * reporting "ok" forever).
 */
export function createAdapterWatchdog(
  deps: Pick<BootstrapAdapterDeps, "messageHub" | "state">,
  reloaders: Pick<
    AdapterReloaders,
    "reloadDiscordAdapter" | "reloadSlackAdapter" | "reloadTelegramAdapter"
  >,
): AdapterWatchdog {
  const { messageHub, state } = deps;
  const watchdog = new AdapterWatchdog();

  const entries: Array<{
    platform: "discord" | "slack" | "telegram";
    getConnectionState: () => AdapterConnectionState;
    restart: () => Promise<void>;
  }> = [
    {
      platform: "discord",
      getConnectionState: () => state.discord?.getConnectionState() ?? "unknown",
      restart: () => reloaders.reloadDiscordAdapter(true),
    },
    {
      platform: "slack",
      getConnectionState: () => state.slack?.getConnectionState() ?? "unknown",
      restart: () => reloaders.reloadSlackAdapter(true),
    },
    {
      platform: "telegram",
      getConnectionState: () => state.telegram?.getConnectionState() ?? "unknown",
      restart: () => reloaders.reloadTelegramAdapter(true),
    },
  ];

  for (const entry of entries) {
    watchdog.register({
      platform: entry.platform,
      getConnectionState: entry.getConnectionState,
      restart: entry.restart,
      onStateChange: (connectionState) => {
        if (connectionState === "down") {
          messageHub.setPlatformRuntimeStatus(entry.platform, {
            runtimeState: "error",
            error: "Connection lost — watchdog will restart the adapter if it does not self-recover",
          });
        } else if (connectionState === "ok") {
          messageHub.setPlatformRuntimeStatus(entry.platform, {
            runtimeState: "ok",
            error: null,
          });
        }
      },
    });
  }

  return watchdog;
}

/**
 * Pure projection of the WhatsApp adapter (+ optional snapshot
 * override) into the `WhatsAppQrResponse` wire shape. Lives outside
 * `createAdapterReloaders` because the dashboard controls path needs
 * to call it after the factory has returned; it has no state of its
 * own.
 */
export function whatsappQrResponseFromAdapter(
  adapter: WhatsAppAdapter | null,
  snapshotOverride?: WhatsAppQrSnapshot | null,
): WhatsAppQrResponse {
  if (!adapter) {
    return {
      dataUrl: null,
      payload: null,
      generatedAt: null,
      expiresAt: null,
      state: "not_initialized",
      error: "WhatsApp adapter not enabled",
    };
  }
  const snapshot = snapshotOverride !== undefined
    ? snapshotOverride
    : adapter.getQrSnapshot();
  return {
    dataUrl: snapshot?.dataUrl ?? null,
    payload: snapshot?.payload ?? null,
    generatedAt: snapshot?.generatedAt ?? null,
    expiresAt: snapshot?.expiresAt ?? null,
    state: adapter.getStatus(),
    error: adapter.getStatusError(),
  };
}
