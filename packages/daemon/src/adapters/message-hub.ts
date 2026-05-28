import type Database from "better-sqlite3";
import type { AgentConfig } from "../config.js";
import {
  NOTIFICATION_DESTINATION_PLATFORMS,
  type NotificationDestinationPlatform,
} from "../messaging/constants.js";
import { formatAgentOutboundLabel } from "@aitne/shared";
import { getOwnerChannel, upsertOwnerChannel } from "../messaging/owner-channels.js";
import type {
  MessageAdapter,
  OutboundAttachmentRef,
  ProcessingIndicatorHandle,
} from "./types.js";
import { createLogger } from "../logging.js";

const logger = createLogger("message-hub");
const NOOP_PROCESSING_INDICATOR: ProcessingIndicatorHandle = {
  stop: async () => {},
};

export class MessageDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageDeliveryError";
  }
}

export interface MessageDelivery {
  platform: string;
  channel: string;
  messageId?: string;
}

export interface AdapterRuntimeStatus {
  runtimeState: "ok" | "error" | "connecting";
  error: string | null;
}

export interface PlatformRuntimeStatus {
  runtimeState: "ok" | "error" | "not_configured" | "connecting";
  error: string | null;
}

interface ProactiveLogContext {
  dispatchId: string;
  notificationType: string;
  priority: string;
  contentSummary: string;
}

/**
 * MessageHub — central registry for all messaging adapters.
 *
 * Replies to inbound events stay targeted to the originating platform/channel.
 * Proactive notifications fan out to the configured destination set.
 */
export class MessageHub {
  private readonly adapters = new Map<string, MessageAdapter>();
  private readonly adapterStatus = new Map<string, AdapterRuntimeStatus>();
  private readonly configuredPlatforms = new Map<string, boolean>();

  constructor(
    private readonly config: AgentConfig,
    private readonly db?: Database.Database,
  ) {
    this.configuredPlatforms.set("dashboard", true);
  }

  register(adapter: MessageAdapter): void {
    if (this.adapters.has(adapter.platformName)) {
      logger.warn(
        { platform: adapter.platformName },
        "Adapter already registered, replacing",
      );
    }
    this.adapters.set(adapter.platformName, adapter);
    // Seed as "connecting" — not "ok". The API server starts listening
    // before startAll() runs during boot, so /health (and the dashboard
    // status card) polled in the multi-second window between register() and
    // startAll() would otherwise claim a live connection that hadn't
    // happened yet. startAll() promotes each entry to "ok" / "error" once
    // the adapter's start() resolves.
    this.adapterStatus.set(adapter.platformName, {
      runtimeState: "connecting",
      error: null,
    });
    logger.info({ platform: adapter.platformName }, "Adapter registered");
  }

  unregister(platform: string): MessageAdapter | undefined {
    const adapter = this.adapters.get(platform);
    if (!adapter) return undefined;
    this.adapters.delete(platform);
    this.adapterStatus.delete(platform);
    logger.info({ platform }, "Adapter unregistered");
    return adapter;
  }

  getAdapter(platform: string): MessageAdapter | undefined {
    return this.adapters.get(platform);
  }

  getPlatforms(): string[] {
    return [...this.adapters.keys()];
  }

  getPrimaryPlatform(): string {
    return this.config.primaryPlatform;
  }

  setPrimaryPlatform(platform: string): void {
    this.config.primaryPlatform = platform;
  }

  getAdapterStatuses(): Record<string, AdapterRuntimeStatus> {
    return Object.fromEntries(this.adapterStatus.entries());
  }

  setPlatformConfigured(platform: string, configured: boolean): void {
    this.configuredPlatforms.set(platform, configured);
  }

  setPlatformRuntimeStatus(platform: string, status: AdapterRuntimeStatus): void {
    this.adapterStatus.set(platform, status);
  }

  isPlatformConfigured(platform: string): boolean {
    if (platform === "whatsapp") {
      return !!this.config.whatsappEnabled;
    }
    return this.configuredPlatforms.get(platform) ?? false;
  }

  isOwnerConfigured(platform: string): boolean {
    switch (platform) {
      case "dashboard":
        return true;
      case "slack":
        return !!this.config.slackOwnerUserId;
      case "telegram":
        return !!this.config.telegramOwnerChatId;
      case "discord":
        return !!this.config.discordOwnerUserId;
      case "whatsapp":
        return !!this.config.whatsappOwnerPhone;
      default:
        return false;
    }
  }

  getPlatformRuntimeStatus(platform: string): PlatformRuntimeStatus {
    if (!this.isPlatformConfigured(platform)) {
      return {
        runtimeState: "not_configured",
        error: null,
      };
    }

    const adapter = this.adapters.get(platform);
    if (!adapter) {
      return {
        runtimeState: "error",
        error: "Adapter not registered",
      };
    }

    if (adapter.getNotificationRuntimeStatus) {
      return adapter.getNotificationRuntimeStatus();
    }

    return this.adapterStatus.get(platform) ?? {
      runtimeState: "error",
      error: "Adapter not registered",
    };
  }

  isPlatformNotificationEligible(platform: string): boolean {
    if (!(NOTIFICATION_DESTINATION_PLATFORMS as readonly string[]).includes(platform)) {
      return false;
    }

    const adapter = this.adapters.get(platform);
    if (!adapter || adapter.notificationEligible === false) {
      return false;
    }

    return this.isPlatformConfigured(platform)
      && this.isOwnerConfigured(platform)
      && this.getPlatformRuntimeStatus(platform).runtimeState === "ok";
  }

  getNotificationEligiblePlatforms(): NotificationDestinationPlatform[] {
    return NOTIFICATION_DESTINATION_PLATFORMS.filter((platform) =>
      this.isPlatformNotificationEligible(platform),
    );
  }

  getEffectiveFallbackPlatforms(): NotificationDestinationPlatform[] {
    return this.resolveDestinationPlatforms();
  }

  private decorateOutboundText(platform: string, text: string): string {
    if (platform !== "whatsapp") {
      return text;
    }
    const prefix = formatAgentOutboundLabel(this.config.agentDisplayName);
    if (text === prefix || text.startsWith(`${prefix}\n`) || text.startsWith(`${prefix} `)) {
      return text;
    }
    return text ? `${prefix}\n${text}` : prefix;
  }

  private async resolveUserChannel(
    adapter: MessageAdapter,
  ): Promise<string | null> {
    if (adapter.primaryRecipient) {
      return adapter.primaryRecipient;
    }

    if (this.db) {
      const ownerChannel = getOwnerChannel(this.db, adapter.platformName);
      if (ownerChannel?.channel_id) {
        return ownerChannel.channel_id;
      }
    }

    if (adapter.resolveUserChannel) {
      return adapter.resolveUserChannel();
    }

    return null;
  }

  private resolveDestinationPlatforms(
    requested?: string[],
  ): NotificationDestinationPlatform[] {
    const eligible = this.getNotificationEligiblePlatforms();
    if (eligible.length === 0) {
      return [];
    }

    const filterKnown = (platforms: readonly string[]) =>
      this.filterEligibleDestinationPlatforms(platforms, eligible);

    if (requested && requested.length > 0) {
      return [...new Set(filterKnown(requested))];
    }

    const configuredDefaults = filterKnown(
      this.config.defaultNotificationPlatforms,
    );
    if (configuredDefaults.length > 0) {
      return configuredDefaults;
    }

    const primary = filterKnown([this.config.primaryPlatform]);
    if (primary.length > 0) {
      return primary;
    }

    return [eligible[0]];
  }

  private filterEligibleDestinationPlatforms(
    platforms: readonly string[],
    eligible = this.getNotificationEligiblePlatforms(),
  ): NotificationDestinationPlatform[] {
    return platforms.filter(
      (platform): platform is NotificationDestinationPlatform =>
        eligible.includes(platform as NotificationDestinationPlatform),
    );
  }

  private logFailedDelivery(
    platform: string,
    reason: string,
    context?: ProactiveLogContext,
  ): void {
    if (!this.db || !context) return;

    const summaryBase = `delivery failed: ${reason}; ${context.contentSummary}`;
    const summary =
      summaryBase.length > 200 ? `${summaryBase.slice(0, 197)}...` : summaryBase;

    this.db
      .prepare(
        `INSERT INTO notification_log (
           dispatch_id,
           notification_type,
           priority,
           platform,
           content_summary,
           status
         )
         VALUES (?, ?, ?, ?, ?, 'failed')`,
      )
      .run(
        context.dispatchId,
        context.notificationType,
        context.priority,
        platform,
        summary,
      );
  }

  async sendToUserDestinations(
    text: string,
    platforms?: string[],
    logContext?: ProactiveLogContext,
  ): Promise<MessageDelivery[]> {
    const targets = this.resolveDestinationPlatforms(platforms);
    if (targets.length === 0) {
      throw new MessageDeliveryError("No eligible notification destination is configured");
    }
    return this.deliverToResolvedPlatforms(text, targets, logContext);
  }

  async sendToExactUserDestinations(
    text: string,
    platforms: readonly string[],
    logContext?: ProactiveLogContext,
  ): Promise<MessageDelivery[]> {
    const targets = this.filterEligibleDestinationPlatforms(platforms);
    if (targets.length === 0) {
      throw new MessageDeliveryError(
        "No eligible configured notification destination is available",
      );
    }
    return this.deliverToResolvedPlatforms(text, targets, logContext);
  }

  private async deliverToResolvedPlatforms(
    text: string,
    targets: readonly NotificationDestinationPlatform[],
    logContext?: ProactiveLogContext,
  ): Promise<MessageDelivery[]> {
    const deliveries: MessageDelivery[] = [];
    const errors: string[] = [];

    for (const platform of targets) {
      const adapter = this.adapters.get(platform);
      if (!adapter) {
        const reason = "adapter not registered";
        errors.push(`${platform}: ${reason}`);
        this.logFailedDelivery(platform, reason, logContext);
        continue;
      }

      const channel = await this.resolveUserChannel(adapter);
      if (!channel) {
        const reason = "owner channel could not be resolved";
        errors.push(`${platform}: ${reason}`);
        this.logFailedDelivery(platform, reason, logContext);
        continue;
      }

      try {
        const result = await adapter.sendMessage({
          channel,
          text: this.decorateOutboundText(platform, text),
        });
        deliveries.push({
          platform,
          channel,
          messageId: result?.messageId,
        });
        if (this.db) {
          upsertOwnerChannel(this.db, {
            platform,
            channelId: channel,
            touchOutbound: true,
          });
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        errors.push(`${platform}: ${reason}`);
        this.logFailedDelivery(platform, reason, logContext);
        logger.warn({ platform, error: reason }, "Failed proactive delivery");
      }
    }

    if (deliveries.length === 0) {
      throw new MessageDeliveryError(
        `Unable to deliver proactive message (${errors.join("; ")})`,
      );
    }

    return deliveries;
  }

  async sendToUser(
    text: string,
    platforms?: string[],
    logContext?: ProactiveLogContext,
  ): Promise<MessageDelivery[]> {
    return this.sendToUserDestinations(text, platforms, logContext);
  }

  async sendToPlatform(
    platform: string,
    channel: string,
    text: string,
    threadId?: string,
    attachments?: OutboundAttachmentRef[],
  ): Promise<MessageDelivery> {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      throw new MessageDeliveryError(`Adapter not found for platform "${platform}"`);
    }

    const resolvedChannel =
      channel === "user" ? await this.resolveUserChannel(adapter) : channel;
    if (!resolvedChannel) {
      throw new MessageDeliveryError(
        `No default recipient available for platform "${platform}"`,
      );
    }

    const result = await adapter.sendMessage({
      channel: resolvedChannel,
      text: this.decorateOutboundText(platform, text),
      threadId,
      attachments,
    });

    if (channel === "user" && this.db) {
      upsertOwnerChannel(this.db, {
        platform,
        channelId: resolvedChannel,
        touchOutbound: true,
      });
    }

    return {
      platform: adapter.platformName,
      channel: resolvedChannel,
      messageId: result?.messageId,
    };
  }

  async beginProcessingIndicator(
    platform: string,
    channel: string,
    threadId?: string,
  ): Promise<ProcessingIndicatorHandle> {
    const adapter = this.adapters.get(platform);
    if (!adapter?.beginProcessingIndicator) {
      return NOOP_PROCESSING_INDICATOR;
    }

    const resolvedChannel =
      channel === "user" ? await this.resolveUserChannel(adapter) : channel;
    if (!resolvedChannel) {
      return NOOP_PROCESSING_INDICATOR;
    }

    try {
      return (
        await adapter.beginProcessingIndicator({
          channel: resolvedChannel,
          threadId,
        })
      ) ?? NOOP_PROCESSING_INDICATOR;
    } catch (err) {
      logger.debug(
        { platform, channel: resolvedChannel, error: err instanceof Error ? err.message : String(err) },
        "Failed to start processing indicator",
      );
      return NOOP_PROCESSING_INDICATOR;
    }
  }

  async startAll(): Promise<void> {
    const adapters = [...this.adapters.values()];
    // Mark every adapter as "connecting" before launching their start() in
    // parallel. The API server typically starts listening before startAll()
    // runs during boot, so /health polled in the multi-second start window
    // would otherwise report the register() default of "ok" — claiming a
    // live connection that hasn't happened yet. The per-adapter result loop
    // below transitions each one to "ok" or "error" as their start resolves.
    for (const adapter of adapters) {
      this.adapterStatus.set(adapter.platformName, {
        runtimeState: "connecting",
        error: null,
      });
    }
    const results = await Promise.allSettled(adapters.map((adapter) => adapter.start()));
    for (const [index, result] of results.entries()) {
      const platform = adapters[index]?.platformName;
      /* v8 ignore next 1 — index always in bounds (results.length === adapters.length) */
      if (!platform) continue;

      if (result.status === "rejected") {
        const reason =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        this.adapterStatus.set(platform, {
          runtimeState: "error",
          error: reason,
        });
        logger.error({ platform, error: reason }, "Failed to start adapter");
        continue;
      }

      this.adapterStatus.set(platform, {
        runtimeState: "ok",
        error: null,
      });
    }
  }

  async stopAll(): Promise<void> {
    const adapters = [...this.adapters.values()];
    const results = await Promise.allSettled(adapters.map((adapter) => adapter.stop()));
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        const platform = adapters[index]?.platformName;
        logger.error(
          { platform, error: result.reason },
          "Failed to stop adapter",
        );
      }
    }
  }
}
