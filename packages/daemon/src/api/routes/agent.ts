import { Hono } from "hono";
import {
  notifyRequestSchema,
  redactSensitiveString,
  actionLogRequestSchema,
  createEvent,
  EventPriority,
  type RoutineEvent,
} from "@aitne/shared";
import { randomUUID } from "node:crypto";
import { createLogger } from "../../logging.js";
import type { ApiDependencies } from "../server.js";
import { loadAuditEventRow } from "../../safety/audit.js";
import {
  assertOutboundAllowedForAgent,
  OutboundPurchaseTemplateError,
} from "../../safety/outbound-purchase-guard.js";
import { readJsonBody } from "../json-body.js";
import {
  composeIssue,
  respondWithAgentError,
  type AgentErrorIssue,
} from "../helpers/agent-errors.js";
import { registerAgentScheduleRoutes } from "./agent-schedule.js";

const logger = createLogger("agent-api");

export function createAgentRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  const { db, sendNotification, eventBroadcaster } = deps;

  app.post("/agent/run-now", async (c) => {
    if (deps.isStartupComplete && !deps.isStartupComplete()) {
      return respondWithAgentError(
        c,
        503,
        [
          composeIssue("agent.daemon_starting", {
            field: "daemon",
            received: "<starting>",
          }),
        ],
        {
          legacyFields: {
            message: "Daemon startup is still in progress. Try again in a moment.",
          },
        },
      );
    }

    if (!deps.triggerHourlyCheck) {
      return respondWithAgentError(c, 503, [
        composeIssue("agent.hourly_check_unavailable", {
          field: "triggerHourlyCheck",
          received: "<unavailable>",
        }),
      ]);
    }

    const body = await c.req.json().catch(() => ({})) as {
      reason?: unknown;
      force?: unknown;
      requestedModel?: unknown;
    };
    const reason = typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim()
      : "api";
    // Default to `force: true` for manual runs — the user explicitly asked
    // us to check now, so bypass the `hourlyCheckMinObservations` threshold.
    // Callers may pass `{ force: false }` to respect the threshold (e.g.,
    // for a gentle cron-style "check if anything is pending" ping).
    const force = body.force === undefined ? true : body.force === true;

    // requestedModel lets the caller force an Opus run (e.g. manual weekly
    // review). Must be "sonnet" or "opus"; anything else is rejected.
    let requestedModel: "sonnet" | "opus" | undefined;
    if (body.requestedModel !== undefined) {
      if (body.requestedModel === "sonnet" || body.requestedModel === "opus") {
        requestedModel = body.requestedModel;
      } else {
        return respondWithAgentError(
          c,
          400,
          [
            composeIssue("agent.invalid_requested_model", {
              field: "requestedModel",
              received: body.requestedModel,
            }),
          ],
          {
            legacyFields: {
              message: "requestedModel must be 'sonnet' or 'opus'",
            },
          },
        );
      }
    }

    const result = await deps.triggerHourlyCheck(`manual:${reason}`, {
      force,
      ...(requestedModel ? { requestedModel } : {}),
    });
    return c.json(result);
  });

  // POST /agent/run-now/roadmap-maintenance — Manual fire of the daily
  // mechanical roadmap.md maintenance pass (evening-review slimdown
  // §2.2). Same code path as the 17:45 cron callback. Used by
  // `aitne run-now roadmap_maintenance` for operator debugging and
  // the parallel-verification rollout phase. Synchronous: blocks
  // until the pass completes (or is skipped) and returns the
  // structured result so the CLI can surface counts.
  app.post("/agent/run-now/roadmap-maintenance", async (c) => {
    if (deps.isStartupComplete && !deps.isStartupComplete()) {
      return respondWithAgentError(
        c,
        503,
        [
          composeIssue("agent.daemon_starting", {
            field: "daemon",
            received: "<starting>",
          }),
        ],
        {
          legacyFields: {
            message: "Daemon startup is still in progress. Try again in a moment.",
          },
        },
      );
    }
    if (!deps.triggerRoadmapMaintenance) {
      return respondWithAgentError(c, 503, [
        composeIssue("agent.roadmap_maintenance_unavailable", {
          field: "triggerRoadmapMaintenance",
          received: "<unavailable>",
        }),
      ]);
    }
    try {
      const result = await deps.triggerRoadmapMaintenance();
      return c.json({ ok: true, result });
    } catch (err) {
      logger.error({ err }, "Manual roadmap maintenance fire threw");
      const message = err instanceof Error ? err.message : String(err);
      return respondWithAgentError(
        c,
        500,
        [
          composeIssue("agent.roadmap_maintenance_failed", {
            field: "maintenance",
            received: message,
          }),
        ],
        { legacyFields: { message } },
      );
    }
  });

  // POST /escalate — Removed in plan-aware-model-defaults. Automatic
  // Sonnet→Opus handoff was replaced by the opt-in advisor tool + explicit
  // manual Opus runs (dashboard chat model picker, agent_schedule.model,
  // run-now requestedModel). Returns 410 Gone for any stale clients.
  app.post("/escalate", (c) => {
    return c.json(
      {
        error: "gone",
        message:
          "The /api/escalate endpoint has been removed. Use the advisor tool for second-opinion reviews, or trigger Opus explicitly via /api/agent/run-now {requestedModel:'opus'}, dashboard chat model picker, or agent_schedule.model='opus'.",
      },
      410,
    );
  });

  // GET /agent/actions — DELEGATED-MODE-V2-DESIGN.md §6.1, §4.5.2 #3.
  // Agent-callable retrospective. Replaces the rejected push-digest pattern:
  // when the user asks "what did you do today / about Gmail / etc.", the
  // agent calls this endpoint, summarises, and answers in the conversation.
  //
  // Risk tier: Autonomous — the agent reads only its own audit trail. Field
  // values pass through `redactSensitiveString` before serialization so a
  // tool's emitted secret can't leak through the read path even if it
  // landed in `agent_actions.detail` upstream.
  //
  // Query params:
  //   - since:  ISO-8601 timestamp lower bound (inclusive on `started_at`).
  //             When omitted, defaults to 24h before now (the design's
  //             "what did you do today" target).
  //   - kind:   Optional `action_type` filter, exact match. Common values:
  //             `delegated_proxy.invoke`, `integration.mode_change`,
  //             `integration.policy_change`. Repeat for multiple values
  //             via `?kind=a&kind=b`.
  //   - limit:  Default 50, max 200. Mirrors `/integrations/:key/recent-proxy-calls`.
  app.get("/agent/actions", (c) => {
    const since = c.req.query("since");
    let sinceIso: string;
    if (since !== undefined) {
      const parsed = new Date(since);
      if (Number.isNaN(parsed.getTime())) {
        return c.json(
          {
            error: "invalid_since",
            message: "`since` must be an ISO-8601 timestamp parseable by Date()",
          },
          400,
        );
      }
      sinceIso = parsed.toISOString();
    } else {
      sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    }

    const kindParams = c.req.queries("kind") ?? [];
    const kinds = kindParams.filter((k): k is string => typeof k === "string" && k.length > 0);

    const rawLimit = c.req.query("limit");
    let limit = 50;
    if (rawLimit !== undefined) {
      const parsed = Number.parseInt(rawLimit, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return c.json(
          {
            error: "invalid_limit",
            message: "limit must be a positive integer (default 50, max 200)",
          },
          400,
        );
      }
      limit = Math.min(parsed, 200);
    }

    const whereClauses: string[] = ["started_at >= ?"];
    const params: (string | number)[] = [sinceIso];
    if (kinds.length > 0) {
      const placeholders = kinds.map(() => "?").join(", ");
      whereClauses.push(`action_type IN (${placeholders})`);
      params.push(...kinds);
    }
    params.push(limit);

    const rows = db
      .prepare(
        `SELECT id, event_id, action_type, trigger, model_used, backend,
                cost_usd, tokens_input, tokens_output, duration_ms,
                num_turns, result, error, detail, started_at, completed_at
           FROM agent_actions
          WHERE ${whereClauses.join(" AND ")}
          ORDER BY started_at DESC, id DESC
          LIMIT ?`,
      )
      .all(...params) as Array<{
        id: number;
        event_id: string | null;
        action_type: string;
        trigger: string | null;
        model_used: string | null;
        backend: string | null;
        cost_usd: number | null;
        tokens_input: number | null;
        tokens_output: number | null;
        duration_ms: number | null;
        num_turns: number | null;
        result: string | null;
        error: string | null;
        detail: string | null;
        started_at: string | null;
        completed_at: string | null;
      }>;

    const actions = rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      kind: row.action_type,
      trigger: row.trigger,
      modelId: row.model_used,
      backend: row.backend,
      costUsd: row.cost_usd,
      tokensInput: row.tokens_input,
      tokensOutput: row.tokens_output,
      durationMs: row.duration_ms,
      numTurns: row.num_turns,
      result: row.result,
      // Redact known secret patterns from free-text fields. The detail
      // payload is also passed through so embedded auth strings (which
      // shouldn't be there but might leak in tool outputs) cannot escape
      // to the agent's prose.
      error: row.error ? redactSensitiveString(row.error) : null,
      detail: row.detail ? redactSensitiveString(row.detail) : null,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    }));

    return c.json({
      since: sinceIso,
      kinds: kinds.length > 0 ? kinds : null,
      limit,
      actions,
    });
  });

  // POST /notify — Send notification to user
  app.post("/notify", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = notifyRequestSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("agent.notify_validation_error", { field: "body", received: parsedBody.body })],
        { legacyFields: { details: parsed.error } },
      );
    }

    const {
      message,
      platform,
      platforms,
      priority,
    } = parsed.data as {
      message: string;
      platform?: string;
      platforms?: string[];
      priority?: "critical" | "high" | "normal" | "low";
    };
    // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.7 structural-anti-
    // spoofing layer — refuse outbound messages that carry one of the
    // reserved purchase-confirmation markers ("🔐 Aitne purchase
    // confirmation", "[purchase-verify:", "Approved on …"). These are
    // emitted exclusively by `purchase-system-message-sender` via the
    // unforgeable module capability; an agent-originated /notify call
    // claiming to be a purchase confirmation is by definition a spoof
    // attempt. The classifier audits the refusal so the dashboard's
    // recent-activity surface flags the agent path that tried.
    try {
      assertOutboundAllowedForAgent(message, "api.notify", db);
    } catch (err) {
      if (err instanceof OutboundPurchaseTemplateError) {
        return respondWithAgentError(
          c,
          400,
          [
            composeIssue("agent.outbound_purchase_template_refused", {
              field: "message",
              received: { marker: err.match.marker },
            }),
          ],
        );
      }
      throw err;
    }
    const normalizedPlatforms = platforms ?? (platform ? [platform] : undefined);
    const messageSummary = message.slice(0, 200);
    const originSessionId = parsePositiveIntegerHeader(c.req.header("x-pa-session-id"));

    let dispatchId: string = randomUUID();
    let notificationId: string | number = dispatchId;

    if (sendNotification) {
      const result = await sendNotification({
        message,
        platforms: normalizedPlatforms,
        priority: priority ?? "normal",
        notificationType: "agent",
        ...(originSessionId !== null ? { originSessionId } : {}),
      });
      dispatchId = result.dispatchId;
      notificationId = dispatchId;
    } else {
      logger.warn("sendNotification unavailable — recording notification directly to DB");
      const result = db
        .prepare(
          `INSERT INTO notification_log (
             dispatch_id,
             notification_type,
             priority,
             platform,
             content_summary,
             status,
             delivered_at
           )
           VALUES (?, 'agent', ?, ?, ?, 'delivered', CURRENT_TIMESTAMP)`,
        )
        .run(
          dispatchId,
          priority ?? "normal",
          normalizedPlatforms?.[0] ?? "slack",
          messageSummary,
        );
      notificationId = String(result.lastInsertRowid);
    }

    // Notify-dedup — when the agent's shim auto-attached the correlation
    // header, mark the event so the dispatcher skips the implicit
    // final-text DM forward in processResult. We only mark on the
    // success branch (sendNotification path); the warn-fallback branch
    // is daemon-misconfiguration, not user-visible delivery.
    if (sendNotification && deps.markEventNotified) {
      const correlationId = c.req.header("x-pa-event-correlation-id");
      if (correlationId) {
        deps.markEventNotified(correlationId);
      }
    }

    return c.json({
      status: "sent",
      notificationId: String(notificationId),
      dispatchId,
    });
  });

  // PATCH /agent-actions/self — Agent-self-reported structured metadata.
  //
  // docs/design/appendices/morning-routine-optimization.md §"PATCH
  // /api/agent-actions/self". Lets the currently-running agent session
  // write structured metadata into its own `agent_actions` row, so the
  // daemon's ⑥ AgentJournalAppender (and other post-hoc consumers)
  // read structured data rather than parsing LLM final-text prose.
  //
  // Auth: the session's per-run identity comes from
  // `x-pa-event-correlation-id` (matches `agent_actions.event_id`) and
  // `x-process-key` (matches `agent_actions.action_type`), both auto-
  // injected by pa-api from dispatcher-set env vars. Aitne's threat
  // model is single-owner local-only (127.0.0.1 daemon, sole LLM
  // caller, UUID correlation IDs); the morning-routine-optimization
  // rev4 banner records why per-run token binding / cross-row 403 was
  // withdrawn rather than shipped. Lookup miss → 404
  // `agent_actions.session_row_not_found`.
  //
  // Merge: the body's `metadata` slot is shallow-merged into the row's
  // existing `metadata` JSON column. Repeated PATCHes during the same
  // session accumulate (later keys win).
  app.patch("/agent-actions/self", async (c) => {
    const correlationId = c.req.header("x-pa-event-correlation-id");
    const processKey = c.req.header("x-process-key");

    const headerIssues: AgentErrorIssue[] = [];
    if (!correlationId || correlationId.trim().length === 0) {
      headerIssues.push(
        composeIssue("agent_actions.session_identity_missing", {
          field: "headers.x-pa-event-correlation-id",
          received: correlationId ?? "<missing>",
        }),
      );
    }
    if (!processKey || processKey.trim().length === 0) {
      headerIssues.push(
        composeIssue("agent_actions.session_identity_missing", {
          field: "headers.x-process-key",
          received: processKey ?? "<missing>",
        }),
      );
    }
    if (headerIssues.length > 0) {
      return respondWithAgentError(c, 400, headerIssues);
    }

    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    if (
      !parsedBody.body
      || typeof parsedBody.body !== "object"
      || Array.isArray(parsedBody.body)
    ) {
      return respondWithAgentError(c, 400, [
        composeIssue("agent_actions.body_not_object", {
          field: "$",
          received: parsedBody.body,
        }),
      ]);
    }

    const body = parsedBody.body as { metadata?: unknown };
    if (
      !body.metadata
      || typeof body.metadata !== "object"
      || Array.isArray(body.metadata)
    ) {
      return respondWithAgentError(c, 400, [
        composeIssue("agent_actions.metadata_field_invalid", {
          field: "metadata",
          received: body.metadata,
        }),
      ]);
    }

    // body.metadata has already round-tripped through readJsonBody's
    // JSON.parse, so its shape is guaranteed plain JSON (no Functions,
    // Symbols, BigInts, or cyclic refs). The cast is sound.
    const metadataPatch = body.metadata as Record<string, unknown>;

    // Find the most recent in-flight row matching the session's identity.
    // The dispatcher's standard pattern is to INSERT after a session
    // completes, so this lookup only succeeds when an upstream caller
    // (Phase 5/6 orchestrator) has pre-inserted an in_progress row.
    // Until then this endpoint returns 404 — a documented expected state
    // for Phase 1 callers who provide the in_progress row in tests.
    //
    // `result = 'in_progress'` is part of the filter so retry chains (a
    // failed older row + an in_progress newer row sharing identity) can't
    // accidentally resolve to a terminal row, and so a delayed shim call
    // arriving after the session has already settled to success/failed
    // does not overwrite the final metadata. The SKILL.md documents this
    // explicitly: "or it has already settled to a terminal result."
    const row = db
      .prepare(
        `SELECT id, metadata
         FROM agent_actions
         WHERE event_id = ? AND action_type = ?
           AND result = 'in_progress'
         ORDER BY started_at DESC, id DESC
         LIMIT 1`,
      )
      .get(correlationId, processKey) as
        | { id: number; metadata: string | null }
        | undefined;

    if (!row) {
      return respondWithAgentError(c, 404, [
        composeIssue("agent_actions.session_row_not_found", {
          field: "headers.x-process-key",
          received: { correlationId, processKey },
        }),
      ]);
    }

    // Shallow-merge with the existing metadata JSON. The column has
    // DEFAULT '{}' so the parse is safe; a corrupted JSON (manual DB
    // edit, e.g.) falls back to an empty object so the PATCH still
    // succeeds — better than 500ing and losing the agent's write.
    let existing: Record<string, unknown> = {};
    if (row.metadata) {
      try {
        const parsedJson = JSON.parse(row.metadata) as unknown;
        if (parsedJson && typeof parsedJson === "object" && !Array.isArray(parsedJson)) {
          existing = parsedJson as Record<string, unknown>;
        }
      } catch (err) {
        logger.warn(
          { err, rowId: row.id },
          "agent_actions.metadata is not valid JSON — overwriting with PATCH body",
        );
      }
    }

    const merged: Record<string, unknown> = { ...existing, ...metadataPatch };

    db.prepare(`UPDATE agent_actions SET metadata = ? WHERE id = ?`).run(
      JSON.stringify(merged),
      row.id,
    );

    logger.info(
      {
        rowId: row.id,
        keysPatched: Object.keys(metadataPatch),
      },
      "Agent self-reported structured metadata patched",
    );

    return c.json({
      ok: true,
      id: row.id,
      metadata: merged,
    });
  });

  // POST /agent/regenerate — Trigger context file regeneration
  app.post("/agent/regenerate", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const target = (parsedBody.body as { target?: string }).target;
    if (!target || !["today", "roadmap"].includes(target)) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("agent.invalid_target", { field: "target", received: target ?? "<missing>" })],
        { legacyErrorCode: "Invalid target. Must be one of: today, roadmap" },
      );
    }

    if (target === "roadmap") {
      // Emit the real `routine.roadmap_refresh` event (bypassing the
      // 5-minute internal dedup — the user explicitly clicked Regenerate).
      // The refresh task flow owns the full Phase 1/2/3 pipeline; we
      // no longer ship an ad-hoc prompt that short-circuits to a single
      // section write.
      if (!deps.triggerRoadmapRefresh) {
        return respondWithAgentError(
          c,
          503,
          [
            composeIssue("agent.roadmap_refresh_unavailable", {
              field: "triggerRoadmapRefresh",
              received: "<unavailable>",
            }),
          ],
          { legacyErrorCode: "Roadmap refresh trigger not available" },
        );
      }
      deps.triggerRoadmapRefresh("dashboard_regenerate", { bypassDedup: true });
      logger.info({ target }, "Regeneration triggered");
      return c.json({ status: "triggered", target });
    }

    // target === "today" — dispatch routine.today_refresh. The task flow
    // fetches calendar state itself (direct /api/calendar/events or the
    // delegated MCP tool, depending on integration mode) so this handler
    // does not need a local CalendarService.
    if (!deps.eventBus) {
      return respondWithAgentError(
        c,
        500,
        [
          composeIssue("agent.event_bus_unavailable", {
            field: "eventBus",
            received: "<unavailable>",
          }),
        ],
        { legacyErrorCode: "Event bus not available" },
      );
    }

    const event: RoutineEvent = {
      ...createEvent({
        type: "routine.today_refresh",
        source: "dashboard_regenerate",
        priority: EventPriority.HIGH,
      }),
      routine: "today_refresh",
    };

    await deps.eventBus.put(event);
    logger.info({ target }, "Regeneration triggered");
    return c.json({ status: "triggered", target });
  });

  // POST /action/log — Record action log
  app.post("/action/log", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = actionLogRequestSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("agent.action_log_validation_error", { field: "body", received: parsedBody.body })],
        { legacyFields: { details: parsed.error } },
      );
    }

    const { actionType, detail, result: actionResult } = parsed.data;

    const insertResult = db.prepare(
      `INSERT INTO agent_actions (action_type, trigger, result, detail, started_at)
       VALUES (?, 'api', ?, ?, datetime('now'))`,
    ).run(actionType, actionResult, JSON.stringify({ detail }));

    const row = loadAuditEventRow(db, Number(insertResult.lastInsertRowid));
    if (row) {
      eventBroadcaster?.broadcastEvent(row);
    }

    return c.json({ status: "logged" });
  });

  // Schedule cluster (POST/GET/PATCH/DELETE /schedule, /schedule/batch,
  // /schedule/dm, /schedule/:id) is registered from agent-schedule.ts.
  // Per docs/design/appendices/api-route-decomposition.md §5.5 the split
  // is partial — only the schedule routes were extracted, and the public
  // `createAgentRoutes` factory remains the single Hono entry registered
  // in server.ts.
  registerAgentScheduleRoutes(app, deps);

  return app;
}

function parsePositiveIntegerHeader(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}
