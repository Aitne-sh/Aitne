import { randomUUID } from "node:crypto";
import {
  EventPriority,
  createEvent,
  type BackendId,
  type Event,
  type MessageEvent,
} from "@aitne/shared";
import type { MessageAdapter, OnMessageCallback } from "./types.js";
import type { IDashboardStream } from "../core/dispatcher.js";
import type { SessionInfoPayload } from "../api/chat-binding-query.js";
import {
  createStreamingValidator,
  type DocsCitationLookup,
  type StreamingValidator,
} from "../core/docs/citation-validator.js";
import { createLogger } from "../logging.js";

const logger = createLogger("docs-qa-adapter");

/** SSE client interface — provided by the SSE route handler. Mirrors
 *  `dashboard-adapter.ts`'s shape so the route's stream wrapper can be
 *  reused unchanged. */
interface SSEClient {
  writeSSE(event: string, data: string): Promise<void>;
  readonly closed: boolean;
}

interface ClientEntry {
  client: SSEClient;
  /** Streaming citation validator — created lazily on the first
   *  `sendStreamChunk` of a turn, disposed on `sendStreamEnd` so the
   *  next turn on the same channel starts with a fresh buffer. */
  validator: StreamingValidator | null;
}

export interface DocsQAScopeOptions {
  scope: "all" | "current" | "category";
  contextHint?: {
    currentSlug?: string;
    dashboardPath?: string;
    category?: string;
  };
  /**
   * Per-turn model override sent by the QA panel's model picker. The
   * docs route validates `(backendId, modelId)` against the registered
   * light-tier models for the bound backend before forwarding, so by
   * the time the adapter sees this field both fields are guaranteed
   * to round-trip cleanly through `requestedBackendId` /
   * `requestedModelId` on the MessageEvent. The dispatcher's hard-
   * override path (`backend-router.ts:618`) then routes the turn on
   * the picked model regardless of `process_backend_config` pins.
   */
  modelOverride?: {
    backendId: BackendId;
    modelId: string;
  };
}

/**
 * DocsQAAdapter — SSE-based MessageAdapter for the operator-facing
 * Docs Q&A panel (DOCS_QA_B7_DESIGN.md §3.2).
 *
 * Parallel to `DashboardAdapter`: same SSE/HTTP transport, same
 * dispatcher entry point, but a separate channel registry and a
 * per-channel streaming-citation validator spliced into outbound
 * deltas. Inbound messages are tagged with `intent: "docs_qa"` so
 * `resolveProcessKey` returns `dashboard.docs_qa` and the dispatcher
 * loads the docs-qa task flow + skill set + light-tier clamp.
 *
 * Implements:
 *   - `IDashboardStream`: dispatcher fans outbound calls out to this
 *     adapter via `CompositeDashboardStream`. The streaming validator
 *     splice lives inside `sendStreamChunk` per §11.3. The
 *     persistence-side `validateAndRewrite` runs in the dispatcher
 *     (gated on `isDocsQAMessage(event)` per §11.1) — not here — so
 *     this adapter never sees the full assembled output.
 *   - `MessageAdapter`: registered with `MessageHub` so the standard
 *     adapter lifecycle (`start`/`stop`) and `notificationEligible`
 *     contract apply. `sendMessage` is required by the interface but
 *     unused on this path (the QA model streams; it never lands a
 *     non-streaming reply), so the implementation rejects to surface
 *     misrouting early.
 */
export class DocsQAAdapter implements MessageAdapter, IDashboardStream {
  readonly platformName = "dashboard";
  /** QA replies are not eligible for owner-DM notification fan-out —
   *  the panel renders them inline; the user is right there. */
  readonly notificationEligible = false;

  private readonly clients = new Map<string, ClientEntry>();
  private readonly onMessage: OnMessageCallback;
  private readonly citationLookup: DocsCitationLookup;

  constructor(onMessage: OnMessageCallback, citationLookup: DocsCitationLookup) {
    this.onMessage = onMessage;
    this.citationLookup = citationLookup;
  }

  async start(): Promise<void> {
    logger.info("Docs QA adapter ready (awaiting SSE connections)");
  }

  async stop(): Promise<void> {
    this.clients.clear();
    logger.info("Docs QA adapter stopped");
  }

  /**
   * Register a new SSE client. Mints a `channelId`, emits the initial
   * `session_info` event so the dashboard knows the id to echo on
   * subsequent POSTs (D5 — SSE-first channelId minting), and returns
   * the id for the route's `onAbort` to unregister with.
   *
   * No `resumeSessionId` parameter (§11.6): QA panel state lives in
   * React state in-memory; the panel does not persist transcripts
   * across reload.
   */
  registerClient(client: SSEClient): string {
    const channelId = randomUUID();
    this.clients.set(channelId, { client, validator: null });

    const info: SessionInfoPayload = { channelId };
    client
      .writeSSE("session_info", JSON.stringify(info))
      .catch((err) =>
        logger.debug({ err, channelId, event: "session_info" }, "SSE write failed"),
      );
    logger.debug({ channelId }, "Docs QA client connected");
    return channelId;
  }

  /** Drop a client. Called by the SSE route's `onAbort`. */
  unregisterClient(channelId: string): void {
    const entry = this.clients.get(channelId);
    if (!entry) return;
    // Dispose any in-flight validator buffer so a flapping client
    // does not leak memory across reconnects.
    entry.validator = null;
    this.clients.delete(channelId);
    logger.debug({ channelId }, "Docs QA client disconnected");
  }

  /** True iff the channel has an open SSE writer. The route uses this
   *  to short-circuit POST `/docs/qa/messages` with `404
   *  channel_not_connected` rather than enqueuing into the void. */
  isConnected(channelId: string): boolean {
    const entry = this.clients.get(channelId);
    return entry !== undefined && !entry.client.closed;
  }

  /**
   * Translate an HTTP POST into a `MessageEvent` and feed it to the
   * dispatcher. Forces `intent: "docs_qa"`, `platform: "dashboard"`,
   * `isDm: true` regardless of the body — the route already guarded
   * the body shape; this is the second forced-fields layer per §3.3.
   */
  handleIncomingMessage(
    channelId: string,
    content: string,
    options: DocsQAScopeOptions,
  ): void {
    const event: Event = createEvent({
      type: "message.received",
      source: "dashboard",
      priority: EventPriority.HIGH,
    });

    const message: MessageEvent = Object.assign(event, {
      sender: "user",
      channel: channelId,
      content,
      platform: "dashboard",
      threadId: null,
      isDm: true,
      isMention: false,
      intent: "docs_qa" as const,
      ...(options.modelOverride
        ? {
            requestedBackendId: options.modelOverride.backendId,
            requestedModelId: options.modelOverride.modelId,
          }
        : {}),
    });

    // Stash scope + context hint on event.data so the docs-search skill
    // can read them. The scope discriminator narrows the corpus, and the
    // hint surfaces the slug / category the operator was looking at when
    // they opened the panel — the docs-qa task flow uses these to bias
    // the search query without forcing a route-side query rewrite.
    //
    // `currentDocSlug` is duplicated as a flat string (defaulting to
    // `"(none)"`) so `extractEventData` flattens it for the QA task
    // flow's `{event_data[currentDocSlug]}` placeholder — `resolveTemplate`
    // needs a primitive value, not the nested `docsContextHint` object.
    message.data = {
      ...message.data,
      docsScope: options.scope,
      currentDocSlug: options.contextHint?.currentSlug || "(none)",
      ...(options.contextHint ? { docsContextHint: options.contextHint } : {}),
    };

    this.onMessage(message);
  }

  // ── IDashboardStream — outbound (dispatcher → SSE wire) ──

  /**
   * Forward a streaming text delta through the per-channel citation
   * validator and emit the validated suffix. Unknown channelIds
   * silently no-op (matches `dashboard-adapter.ts:211-218`) so the
   * `CompositeDashboardStream` fan-out works without per-channel
   * ownership tracking — only the adapter that owns the id emits.
   */
  sendStreamChunk(channelId: string, chunk: string): void {
    const entry = this.clients.get(channelId);
    if (!entry || entry.client.closed) return;

    if (entry.validator === null) {
      entry.validator = createStreamingValidator(this.citationLookup);
    }
    const validated = entry.validator.feed(chunk);
    if (validated.length === 0) return;

    entry.client
      .writeSSE("chat_stream", JSON.stringify({ chunk: validated }))
      .catch((err) =>
        logger.debug({ err, channelId, event: "chat_stream" }, "SSE write failed"),
      );
  }

  /**
   * Flush the trailing buffer through the validator and emit the
   * final `stream_end` event. Disposes the per-channel validator so
   * the next turn on the same channel starts with a fresh buffer.
   */
  sendStreamEnd(channelId: string): void {
    const entry = this.clients.get(channelId);
    if (!entry) return;

    if (entry.validator !== null) {
      const tail = entry.validator.flush();
      entry.validator = null;
      if (tail.length > 0 && !entry.client.closed) {
        entry.client
          .writeSSE("chat_stream", JSON.stringify({ chunk: tail }))
          .catch((err) =>
            logger.debug({ err, channelId, event: "chat_stream" }, "SSE write failed"),
          );
      }
    }

    if (!entry.client.closed) {
      entry.client
        .writeSSE("stream_end", "")
        .catch((err) =>
          logger.debug({ err, channelId, event: "stream_end" }, "SSE write failed"),
        );
    }
  }

  sendMessageMeta(
    channelId: string,
    meta: { backend?: string; model?: string; durationMs?: number; costUsd?: number },
  ): void {
    const entry = this.clients.get(channelId);
    if (!entry || entry.client.closed) return;
    entry.client
      .writeSSE("chat_meta", JSON.stringify(meta))
      .catch((err) =>
        logger.debug({ err, channelId, event: "chat_meta" }, "SSE write failed"),
      );
  }

  sendSessionInfo(channelId: string, info: SessionInfoPayload): void {
    const entry = this.clients.get(channelId);
    if (!entry || entry.client.closed) return;
    entry.client
      .writeSSE("session_info", JSON.stringify(info))
      .catch((err) =>
        logger.debug({ err, channelId, event: "session_info" }, "SSE write failed"),
      );
  }

  sendError(channelId: string, message: string): void {
    const entry = this.clients.get(channelId);
    if (!entry || entry.client.closed) return;
    entry.client
      .writeSSE("chat_error", JSON.stringify({ message }))
      .catch((err) =>
        logger.debug({ err, channelId, event: "chat_error" }, "SSE write failed"),
      );
  }

  // ── MessageAdapter — outbound `sendMessage` is required by the
  //    interface but the QA path is streaming-only. Reject loudly to
  //    surface a misrouted dispatcher path during integration tests. ──

  async sendMessage(): Promise<void> {
    throw new Error(
      "DocsQAAdapter.sendMessage is not implemented — QA replies are streamed via sendStreamChunk/sendStreamEnd",
    );
  }

  /** Active channel ids — used by `/health` integration probes and
   *  test assertions; mirrors the chat adapter's helper. */
  getActiveChannels(): string[] {
    return [...this.clients.entries()]
      .filter(([, entry]) => !entry.client.closed)
      .map(([id]) => id);
  }
}
