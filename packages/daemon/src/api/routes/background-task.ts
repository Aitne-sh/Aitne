/**
 * /api/background-task/* — BACKGROUND_TASK_RUNNER_DESIGN.md §7.
 *
 * The generic detached-task surface. The DM agent POSTs a self-contained
 * brief, acks, and ends its turn; the runner runs the worker detached and
 * writes an artifact; the delivery boundary surfaces it. GET /:id returns
 * the artifact (the DM agent's "read the result" affordance for precise
 * follow-ups). /clarify relays the owner's answer; /cancel aborts.
 *
 * Routes (§7):
 *   POST   /api/background-task            spawn (or schedule via scheduleAt)
 *   GET    /api/background-task            list
 *   GET    /api/background-task/:id        the artifact (full detail)
 *   POST   /api/background-task/:id/clarify  answer a pending clarification
 *   POST   /api/background-task/:id/cancel   abort in-flight task
 *
 * Excluded from the 100% coverage gate — route glue. The pure pieces
 * (budget envelope, slot manager) are 100%-covered peers.
 */

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { formatSqliteDatetime } from "@aitne/shared";

import {
  countBackgroundTasks,
  createBackgroundTask,
  findRecentDuplicateBackgroundTask,
  getBackgroundTask,
  listBackgroundTasks,
  markTerminal,
  type BackgroundTaskRow,
  type BackgroundTaskState,
} from "../../db/background-task-store.js";
import {
  getOpenClarificationForTask,
  listClarificationsForTask,
  resolveClarification,
} from "../../db/background-task-clarifications-store.js";
import {
  listPrimaryChannels,
  channelRef,
} from "../../db/browser-automation-purchase-primary-channels-store.js";
import { selectDefaultOwnerChannel } from "../../messaging/owner-channels.js";
import { createBackgroundTaskTransitionEmitter } from "../../services/background-task/background-task-transition-events.js";
import { createLogger } from "../../logging.js";
import { readJsonBody } from "../json-body.js";
import type { ApiDependencies } from "../server.js";

const logger = createLogger("background-task-routes");

const postBodySchema = z.object({
  brief: z.string().min(1).max(16_384),
  title: z.string().min(1).max(200).optional(),
  notificationPolicy: z
    .enum(["always", "if_significant", "silent"])
    .optional()
    .default("always"),
  // Phase 4 if_significant criteria DSL (§4.3) — optional structured
  // conditions the worker checks one-by-one. Each is a concrete, atomic
  // condition ("any repo's main build is red"); the worker sets
  // notify=true iff ANY is met. Up to 12, each ≤500 chars.
  significanceCriteria: z
    .array(z.string().min(1).max(500))
    .max(12)
    .optional(),
  tier: z.enum(["lite", "medium", "high"]).optional(),
  maxBudgetUsd: z.number().positive().max(15).optional(),
  originatingChannel: z.string().optional(),
  correlationId: z.string().optional(),
  scheduleAt: z.string().datetime({ offset: true }).optional(),
});

const clarifyBodySchema = z.object({
  clarificationId: z.string().uuid().optional(),
  answer: z.string().min(1).max(8192),
});

const cancelBodySchema = z
  .object({ reason: z.string().max(256).optional() })
  .optional();

function toWire(row: BackgroundTaskRow): Record<string, unknown> {
  return {
    id: row.id,
    brief: row.brief,
    title: row.title,
    state: row.state,
    notificationPolicy: row.notificationPolicy,
    significanceCriteria: row.significanceCriteria,
    report: row.report,
    draft: row.draft,
    notify: row.notify,
    significance: row.significance,
    artifactPath: row.artifactPath,
    outcomeDetail: row.outcomeDetail,
    originatingChannel: row.originatingChannel,
    correlationId: row.correlationId,
    scheduleRowId: row.scheduleRowId,
    tier: row.tier,
    maxBudgetUsd: row.maxBudgetUsd,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    deliveredAt: row.deliveredAt,
  };
}

/** Resolve the originating channel: header / body preferred, intersected
 *  with the primary set ∪ the owner's most-recent DM channel. A null
 *  result files the artifact but cannot DM it. */
function resolveOriginatingChannel(
  deps: ApiDependencies,
  headerChannel: string | undefined,
  bodyChannel: string | undefined,
): string | null {
  const requested = headerChannel ?? bodyChannel ?? null;
  const primary = listPrimaryChannels(deps.db).map((row) =>
    channelRef(row.platform, row.channelId),
  );
  const ownerDefault = selectDefaultOwnerChannel(deps.db);
  const ownerDefaultRef = ownerDefault
    ? channelRef(ownerDefault.platform, ownerDefault.channelId)
    : null;
  if (requested) {
    if (primary.includes(requested)) return requested;
    return primary[0] ?? ownerDefaultRef;
  }
  return primary[0] ?? ownerDefaultRef;
}

export function createBackgroundTaskRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  const transitionEmitter = createBackgroundTaskTransitionEmitter(
    deps.eventBroadcaster ?? null,
  );

  // ── POST /api/background-task ─────────────────────────────────────────
  app.post("/background-task", async (c) => {
    const body = await readJsonBody(c);
    if (!body.ok) return body.response;
    const parsed = postBodySchema.safeParse(body.body);
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }
    const input = parsed.data;
    const resolvedChannel = resolveOriginatingChannel(
      deps,
      c.req.header("x-pa-channel-ref"),
      input.originatingChannel,
    );
    if (resolvedChannel === null) {
      logger.warn(
        {},
        "background-task: no originating channel resolvable — the result will be filed but cannot be DMed",
      );
    }
    const id = randomUUID();
    const title = input.title ?? null;

    // ── Scheduled path ──────────────────────────────────────────────
    if (input.scheduleAt !== undefined) {
      const scheduledAtMs = Date.parse(input.scheduleAt);
      if (!Number.isFinite(scheduledAtMs)) {
        return c.json(
          { error: "invalid_schedule_at", detail: "scheduleAt must parse as ISO 8601." },
          400,
        );
      }
      const nowMs = Date.now();
      if (scheduledAtMs < nowMs - 60_000) {
        return c.json(
          {
            error: "schedule_at_in_past",
            detail: `scheduleAt resolves to more than 60s in the past (delta=${nowMs - scheduledAtMs}ms).`,
          },
          400,
        );
      }
      const scheduleContext = {
        preGeneratedTaskId: id,
        brief: input.brief,
        title,
        notificationPolicy: input.notificationPolicy,
        significanceCriteria: input.significanceCriteria ?? null,
        tier: input.tier ?? null,
        maxBudgetUsd: input.maxBudgetUsd ?? null,
        originatingChannel: resolvedChannel,
      };
      const correlationId = input.correlationId ?? randomUUID();
      const label = title ?? input.brief.slice(0, 200);
      const insertResult = deps.db
        .prepare(
          `INSERT INTO agent_schedule
             (scheduled_for, task_type, task_description, task_prompt, task_context, correlation_id, model, status)
           VALUES (?, 'background_task', ?, ?, ?, ?, NULL, 'pending')`,
        )
        .run(
          formatSqliteDatetime(new Date(scheduledAtMs)),
          label,
          input.brief,
          JSON.stringify(scheduleContext),
          correlationId,
        );
      const scheduleRowId = Number(insertResult.lastInsertRowid);
      logger.info(
        { taskId: id, scheduleRowId, scheduledAt: input.scheduleAt },
        "background-task scheduled — fire-time row creation deferred to dispatcher",
      );
      return c.json(
        { taskId: id, status: "scheduled" as const, scheduledFor: scheduledAtMs, scheduleRowId },
        202,
      );
    }

    // ── Brief-dedup (§10.3 / Phase 4) ───────────────────────────────
    // A replayed trigger (the RESEARCH_CLUSTER_COST_FIX_PLAN runaway
    // class) or an over-eager agent POSTing the same brief repeatedly
    // within minutes would otherwise spawn N detached workers. Collapse
    // onto the first still-relevant identical task. `0` disables.
    const dedupWindowMinutes =
      deps.config?.backgroundTaskDedupWindowMinutes ?? 0;
    if (dedupWindowMinutes > 0) {
      const existing = findRecentDuplicateBackgroundTask(deps.db, {
        brief: input.brief,
        tier: input.tier ?? null,
        sinceMs: Date.now() - dedupWindowMinutes * 60_000,
      });
      if (existing) {
        logger.info(
          {
            taskId: existing.id,
            state: existing.state,
            windowMinutes: dedupWindowMinutes,
          },
          "background-task dedup — identical brief within window; returning existing task instead of spawning a duplicate",
        );
        return c.json(
          {
            taskId: existing.id,
            status: existing.state,
            deduplicated: true as const,
            row: toWire(existing),
          },
          202,
        );
      }
    }

    const createdAt = Date.now();
    const row = createBackgroundTask(deps.db, {
      id,
      brief: input.brief,
      title,
      notificationPolicy: input.notificationPolicy,
      significanceCriteria: input.significanceCriteria ?? null,
      originatingChannel: resolvedChannel,
      correlationId: input.correlationId ?? null,
      scheduleRowId: null,
      tier: input.tier ?? null,
      maxBudgetUsd: input.maxBudgetUsd ?? null,
      createdAt,
    });
    transitionEmitter.emitFromRow(row, createdAt);

    if (deps.backgroundTaskRunner) {
      void deps.backgroundTaskRunner.runFromPost(id).catch((err) => {
        logger.error(
          { err, taskId: id },
          "background-task runner threw on dispatch — task left in pending state",
        );
      });
    } else {
      // No runner wired (tests / lite installs) — synthetic terminal so
      // the row doesn't hang in pending.
      const finishedAt = Date.now();
      const terminal = markTerminal(deps.db, {
        id,
        state: "failed",
        outcomeDetail: "runner_unavailable",
        finishedAt,
      });
      transitionEmitter.emitFromRow(terminal, finishedAt);
    }

    const postDispatchRow = getBackgroundTask(deps.db, id) ?? row;
    return c.json(
      { taskId: id, status: postDispatchRow.state, row: toWire(postDispatchRow) },
      202,
    );
  });

  // ── GET /api/background-task ──────────────────────────────────────────
  app.get("/background-task", (c) => {
    const stateQuery = c.req.query("state");
    const states = stateQuery
      ? (stateQuery.split(",").filter((s) => s.length > 0) as BackgroundTaskState[])
      : undefined;
    // §10.5 — the filed-results digest / "did that monitor run?" pull:
    // `notify=false` + `sinceHours=N` narrows to recently-filed results.
    const notifyQuery = c.req.query("notify");
    const notify =
      notifyQuery === "true" || notifyQuery === "1"
        ? true
        : notifyQuery === "false" || notifyQuery === "0"
          ? false
          : undefined;
    const sinceHours = Number(c.req.query("sinceHours"));
    const finishedSinceMs =
      Number.isFinite(sinceHours) && sinceHours > 0
        ? Date.now() - sinceHours * 3_600_000
        : undefined;
    const limit = Math.min(200, Math.max(0, Number(c.req.query("limit")) || 50));
    const offset = Math.max(0, Number(c.req.query("offset")) || 0);
    const filter = { states, notify, finishedSinceMs };
    const rows = listBackgroundTasks(deps.db, { ...filter, limit, offset });
    const total = countBackgroundTasks(deps.db, filter);
    return c.json({ tasks: rows.map(toWire), total, limit, offset });
  });

  // ── GET /api/background-task/:id (the artifact) ───────────────────────
  app.get("/background-task/:id", (c) => {
    const id = c.req.param("id");
    const row = getBackgroundTask(deps.db, id);
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json({
      ...toWire(row),
      clarifications: listClarificationsForTask(deps.db, id),
    });
  });

  // ── POST /api/background-task/:id/clarify ─────────────────────────────
  app.post("/background-task/:id/clarify", async (c) => {
    const id = c.req.param("id");
    const body = await readJsonBody(c);
    if (!body.ok) return body.response;
    const parsed = clarifyBodySchema.safeParse(body.body);
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }
    const row = getBackgroundTask(deps.db, id);
    if (!row) return c.json({ error: "not_found" }, 404);
    if (row.state !== "awaiting_user") {
      return c.json({ error: "not_awaiting_user", currentState: row.state }, 409);
    }
    // Resolve the explicit clarificationId, or the single open one.
    const clarificationId =
      parsed.data.clarificationId
      ?? getOpenClarificationForTask(deps.db, id)?.id
      ?? null;
    if (!clarificationId) {
      return c.json({ error: "no_open_clarification" }, 409);
    }
    const resolved = resolveClarification(deps.db, {
      id: clarificationId,
      answer: parsed.data.answer,
      answeredAt: Date.now(),
    });
    if (!resolved.ok) {
      const status =
        resolved.reason === "not_found"
          ? 404
          : resolved.reason === "expired"
            ? 410
            : 409;
      return c.json({ error: resolved.reason ?? "clarify_failed" }, status);
    }
    if (deps.backgroundTaskRunner) {
      void deps.backgroundTaskRunner
        .resumeAfterClarification({
          taskId: id,
          clarificationId,
          answer: parsed.data.answer,
        })
        .catch((err) => {
          logger.error(
            { err, taskId: id, clarificationId },
            "background-task resumeAfterClarification threw — task left parked",
          );
        });
    } else {
      logger.warn(
        { taskId: id, clarificationId },
        "background-task clarify recorded but no runner wired — task cannot resume.",
      );
    }
    return c.json({ ok: true, clarification: resolved.row });
  });

  // ── POST /api/background-task/:id/cancel ──────────────────────────────
  app.post("/background-task/:id/cancel", async (c) => {
    const id = c.req.param("id");
    const body = await readJsonBody(c);
    const rawBody = body.ok ? body.body : undefined;
    const parsed = cancelBodySchema.safeParse(rawBody);
    const reason = parsed.success ? parsed.data?.reason ?? "user_cancel" : "user_cancel";
    const row = getBackgroundTask(deps.db, id);
    if (!row) return c.json({ error: "not_found" }, 404);
    if (
      row.state === "completed"
      || row.state === "failed"
      || row.state === "timeout"
      || row.state === "cancelled"
    ) {
      return c.json({ error: "already_terminal", currentState: row.state }, 409);
    }
    if (deps.backgroundTaskRunner) {
      await deps.backgroundTaskRunner.cancel(id, reason);
    } else {
      const finishedAt = Date.now();
      const updated = markTerminal(deps.db, {
        id,
        state: "cancelled",
        outcomeDetail: reason,
        finishedAt,
      });
      transitionEmitter.emitFromRow(updated, finishedAt);
      return c.json({ ok: true, row: updated ? toWire(updated) : null });
    }
    const after = getBackgroundTask(deps.db, id);
    return c.json({ ok: true, row: after ? toWire(after) : null });
  });

  return app;
}
