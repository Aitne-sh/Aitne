import type { Event } from "@aitne/shared";

interface SendMessageResult {
  messageId?: string;
}

/**
 * Outbound attachment reference — handed to an adapter's `sendMessage` when
 * the agent has generated one or more files during the turn. Each platform
 * adapter translates this into its native upload flow. Phase 1 only wires
 * the Dashboard adapter; other adapters ignore the field until Phase 2.
 */
export interface OutboundAttachmentRef {
  id: string;
  /** Absolute path under `<dataDir>/attachments/<id>/<safeFilename>`. */
  path: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  caption?: string;
}

export interface ProcessingIndicatorHandle {
  stop(): Promise<void>;
}

export interface NotificationRuntimeStatus {
  runtimeState: "ok" | "error" | "connecting";
  error: string | null;
}

/**
 * MessageAdapter — platform-specific messaging integration.
 *
 * Each adapter handles one platform (Slack, Telegram, Dashboard, etc.)
 * and converts platform-specific events into the unified Event format.
 */
export interface MessageAdapter {
  /** Platform identifier (e.g., "slack", "telegram", "dashboard") */
  readonly platformName: string;
  /** Whether the adapter can be used for default reminder delivery. */
  readonly notificationEligible?: boolean;

  /**
   * Default outbound recipient for the "user" pseudo-channel.
   * Adapters with a stable owner/user target can expose it here.
   */
  readonly primaryRecipient?: string | null;
  /**
   * Resolve the owner's DM destination lazily when a stable recipient
   * identifier is not enough (e.g. Slack/Discord DM channels).
   */
  resolveUserChannel?(): Promise<string | null>;
  /**
   * Expose adapter-specific delivery health when it differs from the
   * generic registered/error state tracked by MessageHub.
   */
  getNotificationRuntimeStatus?(): NotificationRuntimeStatus;

  /** Start receiving messages (connects to platform) */
  start(): Promise<void>;

  /** Graceful shutdown */
  stop(): Promise<void>;

  /** Send a message to a specific channel/user */
  sendMessage(params: {
    channel: string;
    text: string;
    threadId?: string;
    /** Outbound files produced by the agent during this turn. Adapters
     *  that have not yet implemented attachment delivery ignore this
     *  field; Phase 1 wires only the Dashboard adapter. */
    attachments?: OutboundAttachmentRef[];
  }): Promise<SendMessageResult | void>;

  /**
   * Begin a transient "processing" UI state for a pending reply.
   * Platforms that do not support typing/presence indicators can omit this.
   */
  beginProcessingIndicator?(params: {
    channel: string;
    threadId?: string;
  }): Promise<ProcessingIndicatorHandle | void>;

  /**
   * Stream a message to a specific channel/user (optional).
   * Platforms that support streaming (e.g., Dashboard SSE) implement this.
   * Falls back to sendMessage for non-streaming platforms.
   */
  streamMessage?(params: {
    channel: string;
    text: string;
    threadId?: string;
  }): AsyncGenerator<string, void, unknown>;
}

/**
 * Callback type for when a message is received from a platform.
 * The adapter calls this to push events into the EventBus.
 */
export type OnMessageCallback = (event: Event) => void;
