import { randomUUID } from "node:crypto";
import { EventPriority, createEvent } from "@aitne/shared";
import type { AttachmentRef, BackendId, Event } from "@aitne/shared";
import type { MessageAdapter, OnMessageCallback, OutboundAttachmentRef } from "./types.js";
import type { SessionInfoPayload } from "../api/chat-binding-query.js";
import type { AttachmentStore } from "../services/attachments/store.js";
import { createLogger } from "../logging.js";

const logger = createLogger("dashboard-adapter");

/** SSE client interface — provided by the SSE route handler */
interface SSEClient {
  writeSSE(event: string, data: string): Promise<void>;
  readonly closed: boolean;
}

/**
 * DashboardAdapter — SSE-based MessageAdapter for the Dashboard chat.
 *
 * Implements the same MessageAdapter interface as Slack/Discord/Telegram,
 * so Dashboard chat sessions go through the same EventBus → Dispatcher → handleMessage()
 * pipeline as all other platforms.
 *
 * Transport: SSE (server→client) + HTTP POST (client→server).
 */
export class DashboardAdapter implements MessageAdapter {
  readonly platformName = "dashboard";
  readonly notificationEligible = false;

  get primaryRecipient(): string | null {
    return this.getActiveChannels()[0] ?? null;
  }

  /**
   * P2-19 — channel → set of SSE clients. Previously a `Map<channelId,
   * SSEClient>` where a second `registerClient(channelId, ...)` for an
   * existing key silently replaced the first; the original tab kept its
   * EventSource open but received no further chunks. Switching to a set
   * lets the SSE route opt-in to fan-out (multiple tabs on one channel)
   * without changing callers that pass a fresh UUID per connect.
   */
  private readonly clients = new Map<string, Set<SSEClient>>();
  private onMessage: OnMessageCallback;
  private attachmentStore: AttachmentStore | null = null;

  constructor(onMessage: OnMessageCallback) {
    this.onMessage = onMessage;
  }

  /** Inject the AttachmentStore. Optional — callers without attachment
   *  support (older tests) skip this and POST /chat/messages rejects
   *  attachmentIds with 503. */
  setAttachmentStore(store: AttachmentStore): void {
    this.attachmentStore = store;
  }

  async start(): Promise<void> {
    logger.info("Dashboard adapter ready (awaiting SSE connections)");
  }

  async stop(): Promise<void> {
    this.clients.clear();
    logger.info("Dashboard adapter stopped");
  }

  /** Register a new SSE client and send the initial session_info event.
   *  Returns the channelId (UUID) assigned to this client. */
  registerClient(
    client: SSEClient,
    options?: {
      initialInfo?: SessionInfoPayload;
      /** DB session ID the client wants to restore. Echoed back only when
       *  `resumeSessionValid` is explicitly `true`. */
      resumeSessionId?: number;
      /** Must be explicitly `true` for sessionId to be included in the
       *  initial session_info event. `undefined` or `false` → omitted. */
      resumeSessionValid?: boolean;
    },
  ): string {
    const channelId = randomUUID();
    this.addClient(channelId, client);

    const includeSessionId =
      options?.resumeSessionId != null && options.resumeSessionValid === true;
    const info: SessionInfoPayload = {
      channelId,
      ...options?.initialInfo,
      ...(includeSessionId ? { sessionId: options!.resumeSessionId } : {}),
    };
    client
      .writeSSE("session_info", JSON.stringify(info))
      .catch((err) => logger.debug({ err, channelId, event: "session_info" }, "SSE write failed"));
    logger.debug(
      { channelId, resumeSessionId: options?.resumeSessionId, resumeSessionValid: options?.resumeSessionValid },
      "Dashboard client connected",
    );
    return channelId;
  }

  /** Unregister a client. Called from SSE route onAbort. */
  unregisterClient(channelId: string, client?: SSEClient): void {
    const set = this.clients.get(channelId);
    if (!set) return;
    if (client) {
      set.delete(client);
      if (set.size === 0) this.clients.delete(channelId);
    } else {
      this.clients.delete(channelId);
    }
    logger.debug({ channelId }, "Dashboard client disconnected");
  }

  private addClient(channelId: string, client: SSEClient): void {
    const existing = this.clients.get(channelId);
    if (existing) {
      existing.add(client);
    } else {
      this.clients.set(channelId, new Set([client]));
    }
  }

  /**
   * Iterate every live client for `channelId`, invoking `cb` and reaping
   * any client whose `closed` flag is true. Used by all `send*` methods
   * so a stale (closed) client is collected on the next outbound write
   * rather than lingering until explicit unregister.
   */
  private fanOut(channelId: string, cb: (client: SSEClient) => void): void {
    const set = this.clients.get(channelId);
    if (!set || set.size === 0) return;
    let reaped = 0;
    for (const client of [...set]) {
      if (client.closed) {
        set.delete(client);
        reaped += 1;
        continue;
      }
      try {
        cb(client);
      } catch (err) {
        logger.warn(
          { err, channelId },
          "Dashboard SSE write failed for one client (continuing fan-out)",
        );
      }
    }
    if (set.size === 0) this.clients.delete(channelId);
    if (reaped > 0) {
      logger.debug({ channelId, reaped }, "Reaped closed SSE clients");
    }
  }

  /** Handle an incoming message from HTTP POST.
   *  Optional metadata is attached to event.data for downstream consumers (e.g. Dispatcher setup mode).
   *  Optional requestedModel / requestedBackendId+requestedModelId are set
   *  directly on the event (MessageEvent fields). These are the ONLY
   *  client-provided fields allowed on this path — they are bounded values
   *  (requestedModel is an enum; the backend+model pair is validated
   *  against the registry on the SSE boundary) and affect only backend
   *  routing, not prompt content, so they cannot carry a prompt-injection
   *  payload. See the comment on the POST /chat/messages handler in
   *  `api/routes/sse.ts`. */
  handleIncomingMessage(
    channelId: string,
    content: string,
    options?: {
      metadata?: Record<string, unknown>;
      requestedModel?: "sonnet" | "opus";
      requestedBackendId?: BackendId;
      requestedModelId?: string;
      attachmentIds?: string[];
    },
  ): void {
    const event: Event = createEvent({
      type: "message.received",
      source: "dashboard",
      priority: EventPriority.HIGH,
    });

    const attachments = this.resolveInboundAttachments(options?.attachmentIds);

    Object.assign(event, {
      sender: "user",
      channel: channelId,
      content,
      platform: "dashboard",
      threadId: null,
      isDm: true,
      isMention: false,
      ...(options?.requestedModel ? { requestedModel: options.requestedModel } : {}),
      ...(options?.requestedBackendId && options?.requestedModelId
        ? {
            requestedBackendId: options.requestedBackendId,
            requestedModelId: options.requestedModelId,
          }
        : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    });

    if (options?.metadata) {
      event.data = { ...event.data, ...options.metadata };
    }

    this.onMessage(event);
  }

  private resolveInboundAttachments(
    attachmentIds: string[] | undefined,
  ): AttachmentRef[] {
    if (!attachmentIds || attachmentIds.length === 0) return [];
    const store = this.attachmentStore;
    if (!store) {
      logger.warn({ count: attachmentIds.length }, "Dropping attachmentIds — store not wired");
      return [];
    }
    const resolved: AttachmentRef[] = [];
    for (const id of attachmentIds) {
      const row = store.get(id);
      if (!row) continue;
      resolved.push({
        id: row.id,
        originalFilename: row.originalFilename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        ...(row.caption ? { caption: row.caption } : {}),
      });
    }
    return resolved;
  }

  /** Send a complete message to a specific channel */
  async sendMessage(params: {
    channel: string;
    text: string;
    threadId?: string;
    attachments?: OutboundAttachmentRef[];
  }): Promise<void> {
    const set = this.clients.get(params.channel);
    const liveClients = set ? [...set].filter((c) => !c.closed) : [];
    if (liveClients.length === 0) {
      throw new Error(`Dashboard channel "${params.channel}" is not connected`);
    }
    const payload: {
      role: "assistant";
      content: string;
      attachments?: Array<{
        id: string;
        originalFilename: string;
        mimeType: string;
        sizeBytes: number;
        caption?: string;
      }>;
    } = { role: "assistant", content: params.text };
    if (params.attachments && params.attachments.length > 0) {
      payload.attachments = params.attachments.map((att) => ({
        id: att.id,
        originalFilename: att.originalFilename,
        mimeType: att.mimeType,
        sizeBytes: att.sizeBytes,
        ...(att.caption ? { caption: att.caption } : {}),
      }));
    }
    const serialised = JSON.stringify(payload);
    await Promise.all(liveClients.map((c) => c.writeSSE("chat", serialised)));
  }

  /** Send a streaming chunk to a specific channel */
  sendStreamChunk(channelId: string, chunk: string): void {
    const serialised = JSON.stringify({ chunk });
    this.fanOut(channelId, (c) => {
      c.writeSSE("chat_stream", serialised).catch((err) =>
        logger.debug({ err, channelId, event: "chat_stream" }, "SSE write failed"),
      );
    });
  }

  /** Signal end of stream to a specific channel */
  sendStreamEnd(channelId: string): void {
    this.fanOut(channelId, (c) => {
      c.writeSSE("stream_end", "").catch((err) =>
        logger.debug({ err, channelId, event: "stream_end" }, "SSE write failed"),
      );
    });
  }

  /** Ship the outbound attachment list for the just-completed assistant
   *  turn — dashboard transcript reads this and renders inline thumbnails /
   *  download chips alongside the streamed message text. */
  sendAttachments(
    channelId: string,
    attachments: Array<{
      id: string;
      originalFilename: string;
      mimeType: string;
      sizeBytes: number;
      caption?: string;
    }>,
  ): void {
    const serialised = JSON.stringify({ attachments });
    this.fanOut(channelId, (c) => {
      c.writeSSE("chat_attachments", serialised).catch((err) =>
        logger.debug({ err, channelId, event: "chat_attachments" }, "SSE write failed"),
      );
    });
  }

  /** Send metadata for the last assistant message (backend, model, duration, cost) */
  sendMessageMeta(channelId: string, meta: { backend?: string; model?: string; durationMs?: number; costUsd?: number }): void {
    const serialised = JSON.stringify(meta);
    this.fanOut(channelId, (c) => {
      c.writeSSE("chat_meta", serialised).catch((err) =>
        logger.debug({ err, channelId, event: "chat_meta" }, "SSE write failed"),
      );
    });
  }

  /** Send tool progress to a specific channel */
  sendToolProgress(channelId: string, tool: string, status: string): void {
    const serialised = JSON.stringify({ tool, status });
    this.fanOut(channelId, (c) => {
      c.writeSSE("tool_progress", serialised).catch((err) =>
        logger.debug({ err, channelId, event: "tool_progress" }, "SSE write failed"),
      );
    });
  }

  /** Send session info update to a specific channel (partial — frontend merges) */
  sendSessionInfo(
    channelId: string,
    info: SessionInfoPayload,
  ): void {
    const serialised = JSON.stringify(info);
    this.fanOut(channelId, (c) => {
      c.writeSSE("session_info", serialised).catch((err) =>
        logger.debug({ err, channelId, event: "session_info" }, "SSE write failed"),
      );
    });
  }

  /** Send error to a specific channel (named "chat_error" to avoid EventSource built-in "error" collision) */
  sendError(channelId: string, message: string): void {
    const serialised = JSON.stringify({ message });
    this.fanOut(channelId, (c) => {
      c.writeSSE("chat_error", serialised).catch((err) =>
        logger.debug({ err, channelId, event: "chat_error" }, "SSE write failed"),
      );
    });
  }

  /** Check if a channel has at least one active SSE connection */
  isConnected(channelId: string): boolean {
    const set = this.clients.get(channelId);
    if (!set) return false;
    for (const c of set) {
      if (!c.closed) return true;
    }
    return false;
  }

  /** Get all active channel IDs */
  getActiveChannels(): string[] {
    return [...this.clients.keys()].filter((id) => this.isConnected(id));
  }
}
