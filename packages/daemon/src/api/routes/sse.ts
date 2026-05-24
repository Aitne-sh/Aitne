import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { BackendId } from "@aitne/shared";
import { isBackendId } from "@aitne/shared";
import { createLogger } from "../../logging.js";
import { getLogBuffer } from "../../log-buffer.js";
import type { DashboardAdapter } from "../../adapters/dashboard-adapter.js";
import type { AttachmentStore } from "../../services/attachments/store.js";
import { ATTACHMENT_LIMITS } from "./attachments.js";
import type { SessionInfoPayload } from "../chat-binding-query.js";
import { resolveDashboardResumeSession } from "../chat-session-resume.js";
import { readJsonBody } from "../json-body.js";

const logger = createLogger("sse");

/**
 * Broadcaster for real-time event streaming via SSE.
 * Replaces the WebSocket-based event broadcast.
 */
export class EventBroadcaster {
  private readonly clients = new Set<SSEWriter>();

  /**
   * Broadcast a persisted `agent_actions` row to dashboard subscribers.
   *
   * The dashboard merges these rows with `/api/events` pagination, so the
   * payload must stay aligned with that REST shape rather than raw EventBus data.
   */
  broadcastEvent(data: unknown): void {
    void this.broadcastNamedEvent("event", data);
  }

  /**
   * Broadcast a named SSE event to dashboard subscribers.
   *
   * Used by Management Mode to stream migration progress separately from
   * the persisted `agent_actions` event feed.
   */
  async broadcastNamedEvent(event: string, data: unknown): Promise<void> {
    const json = JSON.stringify(data);
    await Promise.all(
      [...this.clients].map(async (client) => {
        try {
          await client.write(event, json);
        } catch {
          this.clients.delete(client);
        }
      }),
    );
  }

  register(client: SSEWriter): void {
    this.clients.add(client);
    logger.info({ total: this.clients.size }, "Event SSE client connected");
  }

  unregister(client: SSEWriter): void {
    this.clients.delete(client);
    logger.info({ total: this.clients.size }, "Event SSE client disconnected");
  }

  get clientCount(): number {
    return this.clients.size;
  }
}

interface SSEWriter {
  write(event: string, data: string): Promise<void>;
}

/**
 * Create SSE routes for real-time communication.
 *
 * Endpoints:
 * - GET  /chat/stream    — SSE: server→client push for chat responses
 * - POST /chat/messages   — HTTP: client→server chat message
 * - GET  /events/stream   — SSE: server→client event broadcast
 * - GET  /logs/stream     — SSE: server→client real-time application logs
 * - GET  /logs            — REST: recent buffered application logs
 */
export function createSSERoutes(deps: {
  dashboardAdapter: DashboardAdapter | null;
  eventBroadcaster: EventBroadcaster;
  /** Optional callback to resolve the current chat binding at SSE connect time */
  getChatBinding?: () => SessionInfoPayload | null;
  /** Check whether a session row exists and is active (SELECT-only). */
  isSessionActive?: (sessionId: number) => boolean;
  /**
   * Fallback lookup when the client did NOT pass a stored sessionId (e.g.
   * the browser navigated away before the dispatcher's first session_info
   * push could save to localStorage). Returns the currently-active
   * dashboard_chat session id, or null. Lets the new tab rebind to an
   * in-flight session instead of starting fresh.
   */
  findActiveDashboardSessionId?: () => number | null;
  /** Update the session's channel_id in the DB after registration. */
  rebindSessionChannel?: (sessionId: number, newChannelId: string) => void;
  /** Explicitly close the current dashboard chat session. */
  endSession?: (channelId: string) => Promise<{ id: number } | null> | { id: number } | null;
  /** Continue a resumable browser-only dashboard session from history. */
  continueSession?: (sessionId: number) => Promise<
    | { ok: true; sessionId: number }
    | { ok: false; status: 403 | 404 | 409 | 503; message: string }
  >;
  /** Validate a client-supplied (backendId, modelId) override pair against
   *  the DB (backend enabled + model in registry for that backend). Returns
   *  true when the pair is safe to forward to the dashboard adapter. */
  validateChatModelOverride?: (backendId: BackendId, modelId: string) => boolean;
  /** Shared AttachmentStore — used by POST /chat/messages to validate
   *  attachmentIds before they are handed to the dispatcher. The store
   *  binds rows to (session_id, message_id) once the dispatcher records
   *  the user message. */
  attachmentStore?: AttachmentStore;
}): Hono {
  const app = new Hono();
  const { dashboardAdapter, eventBroadcaster } = deps;

  // ── Chat SSE stream ──
  app.get("/chat/stream", (c) => {
    if (!dashboardAdapter) {
      return c.json({ error: "dashboard adapter not available" }, 503);
    }
    const adapter = dashboardAdapter;

    // Read optional sessionId from query — the frontend sends this when
    // restoring a session after page reload or SSE reconnect.
    const rawSessionId = c.req.query("sessionId");
    const resumeSessionId = rawSessionId ? Number(rawSessionId) : undefined;
    const validResumeId =
      resumeSessionId && Number.isFinite(resumeSessionId) && resumeSessionId > 0
        ? resumeSessionId
        : undefined;

    return streamSSE(c, async (stream) => {
      const client = {
        async writeSSE(event: string, data: string): Promise<void> {
          await stream.writeSSE({ event, data });
        },
        get closed() {
          return stream.closed || stream.aborted;
        },
      };
      // Resolve current binding so the first session_info event includes model info
      const initialInfo = deps.getChatBinding?.() ?? undefined;

      // Check session validity BEFORE registration so the initial session_info
      // event carries the correct flag (sessionId present → valid, absent → stale).
      const requestedSessionIsActive =
        validResumeId && deps.isSessionActive
          ? deps.isSessionActive(validResumeId)
          : undefined;
      if (validResumeId && requestedSessionIsActive === false) {
        logger.debug({ sessionId: validResumeId }, "Session resume skipped — not found or inactive");
      }

      const discoveredActiveSessionId = deps.findActiveDashboardSessionId?.() ?? null;
      const resolvedResume = resolveDashboardResumeSession({
        requestedSessionId: validResumeId,
        requestedSessionIsActive,
        activeDashboardSessionId: discoveredActiveSessionId,
      });

      if (resolvedResume.source === "active" && discoveredActiveSessionId) {
        logger.debug(
          { sessionId: discoveredActiveSessionId },
          validResumeId
            ? "Auto-adopted active dashboard session after stale resume id"
            : "Auto-adopted active dashboard session on fresh SSE connect",
        );
      }

      const channelId = adapter.registerClient(client, {
        initialInfo,
        resumeSessionId: resolvedResume.sessionId,
        resumeSessionValid: resolvedResume.valid,
      });

      // Rebind the session's channel_id AFTER registration so the UUID is final.
      if (resolvedResume.sessionId && resolvedResume.valid && deps.rebindSessionChannel) {
        deps.rebindSessionChannel(resolvedResume.sessionId, channelId);
      }

      // Pass `client` so the adapter removes only THIS tab's SSE entry.
      // Today each tab gets a unique channelId so it's equivalent to a
      // full delete; this guards a future change that lets multiple
      // tabs share a channelId (e.g. session-shared fan-out) from
      // accidentally reaping every tab when one disconnects.
      stream.onAbort(() => {
        adapter.unregisterClient(channelId, client);
      });

      // Keep alive with periodic pings until client disconnects
      while (!stream.aborted) {
        await stream.sleep(30_000);
        if (!stream.aborted) {
          await stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
        }
      }
    });
  });

  // ── Chat message POST ──
  app.post("/chat/end-session", async (c) => {
    if (!dashboardAdapter) {
      return c.json({ error: "dashboard adapter not available" }, 503);
    }

    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body as { channelId?: string };
    if (!body.channelId || typeof body.channelId !== "string") {
      return c.json({ error: "channelId is required" }, 400);
    }

    const closed = await deps.endSession?.(body.channelId) ?? null;
    return c.json({
      status: "ended",
      closedSessionId: closed?.id ?? null,
    });
  });

  app.post("/chat/continue-session", async (c) => {
    if (!dashboardAdapter) {
      return c.json({ error: "dashboard adapter not available" }, 503);
    }

    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body as { sessionId?: number };
    if (typeof body.sessionId !== "number" || !Number.isFinite(body.sessionId) || body.sessionId <= 0) {
      return c.json({ error: "sessionId is required" }, 400);
    }

    const result = await deps.continueSession?.(body.sessionId) ?? {
      ok: false as const,
      status: 503,
      message: "continue unavailable",
    };
    if (!result.ok) {
      return c.json({ error: "continue_failed", message: result.message }, result.status);
    }

    return c.json({
      status: "continued",
      sessionId: result.sessionId,
    });
  });

  // ── Chat message POST ──
  app.post("/chat/messages", async (c) => {
    if (!dashboardAdapter) {
      return c.json({ error: "dashboard adapter not available" }, 503);
    }

    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body as {
      channelId?: string;
      content?: string;
      requestedModel?: unknown;
      requestedBackendId?: unknown;
      requestedModelId?: unknown;
      attachmentIds?: unknown;
    };
    if (!body.channelId || typeof body.content !== "string") {
      return c.json({ error: "channelId and content are required" }, 400);
    }
    if (body.content.length > 100_000) {
      return c.json({ error: "invalid content" }, 400);
    }

    // ── Validate optional attachmentIds ──
    let attachmentIds: string[] = [];
    if (body.attachmentIds !== undefined) {
      if (!Array.isArray(body.attachmentIds) || body.attachmentIds.some((v) => typeof v !== "string")) {
        return c.json({ error: "invalid_attachmentIds", message: "attachmentIds must be string[]" }, 400);
      }
      attachmentIds = (body.attachmentIds as string[]).slice(0, 50);
      if (!deps.attachmentStore) {
        return c.json({ error: "attachments_disabled" }, 503);
      }
      // Verify every id resolves to an unbound inbound row and the
      // total size for this turn is under the per-turn cap.
      let totalBytes = 0;
      for (const id of attachmentIds) {
        const row = deps.attachmentStore.get(id);
        if (!row || row.direction !== "inbound" || row.messageId !== null) {
          return c.json(
            { error: "invalid_attachment", message: `Unknown or already-bound attachment ${id}` },
            400,
          );
        }
        totalBytes += row.sizeBytes;
      }
      if (totalBytes > ATTACHMENT_LIMITS.PER_TURN_MAX_BYTES) {
        return c.json(
          {
            error: "per_turn_cap",
            message: `Total attachment size ${totalBytes} exceeds ${ATTACHMENT_LIMITS.PER_TURN_MAX_BYTES} bytes per turn`,
          },
          400,
        );
      }
    }
    if (!body.content && attachmentIds.length === 0) {
      return c.json({ error: "empty_turn", message: "Must provide content or attachmentIds" }, 400);
    }

    // Narrowly accept requestedModel from the client. Unlike free-form
    // metadata (still rejected on this path to prevent prompt injection
    // via adapter → dispatcher → prompt context), requestedModel is a
    // bounded enum that only affects BackendRouter tier selection and
    // never reaches prompt content. It is the legacy Claude-only form of
    // the dashboard chat model override — the newer
    // (requestedBackendId, requestedModelId) pair is its cross-backend
    // superset. Callers MUST NOT send both; the client would then be
    // asking "please route to Opus OR to gemini-2.5-pro" with no defined
    // precedence. We reject the ambiguous case rather than silently
    // preferring one.
    const hasRequestedModel = body.requestedModel !== undefined;
    const hasRequestedPair =
      body.requestedBackendId !== undefined || body.requestedModelId !== undefined;
    if (hasRequestedModel && hasRequestedPair) {
      return c.json(
        {
          error: "conflicting_model_override",
          message:
            "requestedModel and (requestedBackendId, requestedModelId) are mutually exclusive",
        },
        400,
      );
    }

    let requestedModel: "sonnet" | "opus" | undefined;
    if (hasRequestedModel) {
      if (body.requestedModel === "sonnet" || body.requestedModel === "opus") {
        requestedModel = body.requestedModel;
      } else {
        return c.json(
          {
            error: "invalid_requestedModel",
            message: "requestedModel must be 'sonnet' or 'opus'",
          },
          400,
        );
      }
    }

    // Accept an explicit (backendId, modelId) pair from the dashboard chat
    // model picker — the superset of requestedModel that lets the user
    // target any registered model on any enabled backend, not just Claude
    // sonnet/opus. Validation rules (all must hold):
    //   1. Both fields present and strings (partial pair is rejected).
    //   2. backendId is a known BackendId enum value.
    //   3. (backend, model) passes the deps.validateChatModelOverride
    //      check — i.e. the backend row has enabled=1 and the model is in
    //      the registry for that backend. We do NOT trust the client here;
    //      without DB-side validation, a crafted request could route to a
    //      disabled backend.
    let requestedBackendId: BackendId | undefined;
    let requestedModelId: string | undefined;
    const hasBackend = body.requestedBackendId !== undefined;
    const hasModel = body.requestedModelId !== undefined;
    if (hasBackend || hasModel) {
      if (!hasBackend || !hasModel) {
        return c.json(
          {
            error: "invalid_requestedBackendModel",
            message:
              "requestedBackendId and requestedModelId must be provided together",
          },
          400,
        );
      }
      if (
        typeof body.requestedBackendId !== "string" ||
        typeof body.requestedModelId !== "string" ||
        !isBackendId(body.requestedBackendId)
      ) {
        return c.json(
          {
            error: "invalid_requestedBackendModel",
            message:
              "requestedBackendId must be a valid BackendId and requestedModelId a string",
          },
          400,
        );
      }
      const backend = body.requestedBackendId;
      const model = body.requestedModelId;
      if (
        !deps.validateChatModelOverride ||
        !deps.validateChatModelOverride(backend, model)
      ) {
        return c.json(
          {
            error: "invalid_requestedBackendModel",
            message: `Backend "${backend}" is not enabled or model "${model}" is not registered for it`,
          },
          400,
        );
      }
      requestedBackendId = backend;
      requestedModelId = model;
    }

    if (!dashboardAdapter.isConnected(body.channelId)) {
      logger.warn({ channelId: body.channelId, activeChannels: dashboardAdapter.getActiveChannels().length }, "Chat message rejected — channel not connected");
      return c.json({ error: "channel not connected" }, 404);
    }

    dashboardAdapter.handleIncomingMessage(body.channelId, body.content, {
      ...(requestedModel ? { requestedModel } : {}),
      ...(requestedBackendId && requestedModelId
        ? { requestedBackendId, requestedModelId }
        : {}),
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    });
    return c.json({ status: "accepted" });
  });

  // ── Events SSE stream ──
  app.get("/events/stream", (c) => {
    return streamSSE(c, async (stream) => {
      const client: SSEWriter = {
        async write(event: string, data: string): Promise<void> {
          await stream.writeSSE({ event, data });
        },
      };
      eventBroadcaster.register(client);

      stream.onAbort(() => {
        eventBroadcaster.unregister(client);
      });

      // Emit an immediate frame so proxies flush the stream promptly.
      await stream.writeSSE({ event: "ping", data: "" }).catch(() => {});

      // Keep alive
      while (!stream.aborted) {
        await stream.sleep(30_000);
        if (!stream.aborted) {
          await stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
        }
      }
    });
  });

  // ── System Logs SSE stream ──
  app.get("/logs/stream", (c) => {
    const logBuffer = getLogBuffer();

    return streamSSE(c, async (stream) => {
      let consecutiveErrors = 0;
      const unsubscribe = logBuffer.subscribe((entry) => {
        stream
          .writeSSE({ event: "log", data: JSON.stringify(entry) })
          .then(() => {
            consecutiveErrors = 0;
          })
          .catch(() => {
            consecutiveErrors++;
            // Unsubscribe after repeated failures — stream is likely dead
            if (consecutiveErrors >= 3) {
              unsubscribe();
            }
          });
      });

      stream.onAbort(() => {
        unsubscribe();
      });

      // Emit an immediate frame so proxies flush the stream promptly.
      await stream.writeSSE({ event: "ping", data: "" }).catch(() => {});

      // Keep alive
      while (!stream.aborted) {
        await stream.sleep(30_000);
        if (!stream.aborted) {
          await stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
        }
      }
    });
  });

  // ── System Logs REST ──
  app.get("/logs", (c) => {
    const logBuffer = getLogBuffer();
    const limit = Math.min(
      Math.max(parseInt(c.req.query("limit") ?? "200", 10) || 200, 1),
      500,
    );
    const afterIdRaw = c.req.query("afterId");
    const afterId = afterIdRaw ? Number(afterIdRaw) : undefined;
    const level = c.req.query("level") || undefined;
    const loggerName = c.req.query("logger") || undefined;

    const logs = logBuffer.getRecent(limit, {
      level,
      logger: loggerName,
      afterId: afterId && Number.isFinite(afterId) && afterId > 0 ? afterId : undefined,
    });
    const loggers = logBuffer.getLoggerNames();
    return c.json({ logs, loggers });
  });

  return app;
}
