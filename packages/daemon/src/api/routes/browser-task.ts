/**
 * /api/browser-task/* — BROWSER_TASK_REDESIGN_PLAN.md §3.
 *
 * Phase 1 surface — the route handlers wire the slot manager + the
 * stub runner + the clarification store + the screenshot trace path.
 * The runner itself is a stub (`browser-task-runner.ts`) returning
 * `not_implemented` so callers can exercise the full state-machine
 * round-trip end-to-end without Playwright glue (Phase 2 lands the
 * real driver).
 *
 * Routes (per §3):
 *   POST   /api/browser-task                       Approve         create + dispatch
 *   GET    /api/browser-task                       ReadSensitive   list
 *   GET    /api/browser-task/:id                   ReadSensitive   detail (+ queueState)
 *   GET    /api/browser-task/:id/events            ReadSensitive   SSE (state transitions)
 *   GET    /api/browser-task/:id/screenshots/:idx  ReadSensitive   trace asset
 *   POST   /api/browser-task/:id/clarify           Autonomous      answer pending question
 *   POST   /api/browser-task/:id/cancel            Autonomous      abort in-flight task
 *
 * §14.8 originating-channel attestation: the `x-pa-channel-ref`
 * header is honoured only when the request bearer matches the daemon-
 * internal DM-agent token (Phase 2 wires the token check; Phase 1
 * accepts the header but logs the bearer status so a future tightening
 * is straightforward). Whether or not the header was honoured, the
 * value is intersected with `listPrimaryChannels()` at task creation;
 * an out-of-set value falls back to the primary set and records an
 * `agent_actions(action_type='browser_task_channel_override')` row.
 *
 * Excluded from the 100% coverage gate — route glue. The pure pieces
 * (allowlist composition, slot manager, deadline scanner, lite-final-
 * confirm classifier) are 100%-covered peers.
 */

import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { formatSqliteDatetime } from "@aitne/shared";

import {
  countBrowserTasks,
  createBrowserTask,
  getBrowserTask,
  listBrowserTasks,
  markTerminal,
  type BrowserTaskRow,
  type BrowserTaskState,
} from "../../db/browser-task-store.js";
import { listBrowserTaskActionLog } from "../../db/browser-task-action-log-store.js";
import {
  listClarificationsForTask,
  resolveClarification,
} from "../../db/browser-task-clarifications-store.js";
import { listPrimaryChannels, channelRef } from "../../db/browser-automation-purchase-primary-channels-store.js";
import { selectDefaultOwnerChannel } from "../../messaging/owner-channels.js";
import { composeAllowlistRegex } from "../../services/browser-task/browser-task-allowlist.js";
import {
  decideCancel,
  readQueueState,
  type SlotState,
} from "../../services/browser-task/browser-task-slots.js";

/** True when the slot manager's `active` map currently holds an entry
 *  for `taskId` (in any phase — running OR parked). Used by the cancel
 *  route to disambiguate "row is still `pending` in DB" from "runner
 *  already acquired the slot but has not flipped DB to running yet".
 *  Without this check, a cancel that lands in that window calls
 *  `decideCancel` on an active task, which throws + surfaces as a 500. */
function slotManagerHasActive(state: SlotState, taskId: string): boolean {
  for (const entry of state.active.values()) {
    if (entry.taskId === taskId) return true;
  }
  return false;
}
import { createBrowserTaskTransitionEmitter } from "../../services/browser-task/browser-task-transition-events.js";
import {
  resolveTraceFilePath,
} from "../../services/browser-history/automation/trace-store-paths.js";
import { createLogger } from "../../logging.js";
import { readJsonBody } from "../json-body.js";
import type { ApiDependencies } from "../server.js";

const logger = createLogger("browser-task-routes");

/**
 * POST body schema. As of the 2026-05-27 open-navigation revision the
 * caller no longer pre-declares a `siteKey` or `extraAllowedHosts` —
 * the task description may not contain a known URL upfront and the
 * sub-agent decides where to navigate as it runs. Domain-level deny
 * comes from the user-curated `runtime-settings.browserTaskHostnameDenylist`
 * (Dashboard `/settings/browser`); the network-level (IP CIDR) +
 * payment-path URL gates remain hardcoded.
 *
 * Unknown fields are silently ignored (zod default) so legacy callers
 * that still pass the deprecated fields don't 400 — but the values are
 * discarded.
 */
const postBodySchema = z.object({
  description: z.string().min(1).max(4096),
  originatingChannel: z.string().optional(),
  scheduleAt: z
    .string()
    .datetime({ offset: true })
    .optional(),
  requireFinalConfirm: z.boolean().optional(),
});

/** Clarify body — answer to a pending ask_user round-trip. */
const clarifyBodySchema = z.object({
  clarificationId: z.string().uuid(),
  answer: z.string().min(1).max(8192),
});

/** Cancel body — optional reason string. */
const cancelBodySchema = z
  .object({ reason: z.string().max(256).optional() })
  .optional();

function toWire(row: BrowserTaskRow): {
  id: string;
  description: string;
  siteKey: string | null;
  extraAllowedHosts: readonly string[];
  originatingChannel: string | null;
  scheduleRowId: number | null;
  requireFinalConfirm: boolean;
  state: BrowserTaskState;
  outcomeDetail: string | null;
  report: string | null;
  effectiveAllowlistRegex: string | null;
  blockedRequestsCount: number;
  extractCharsTotal: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
} {
  return {
    id: row.id,
    description: row.description,
    siteKey: row.siteKey,
    extraAllowedHosts: row.extraAllowedHosts,
    originatingChannel: row.originatingChannel,
    scheduleRowId: row.scheduleRowId,
    requireFinalConfirm: row.requireFinalConfirm,
    state: row.state,
    outcomeDetail: row.outcomeDetail,
    report: row.report,
    effectiveAllowlistRegex: row.effectiveAllowlistRegex,
    blockedRequestsCount: row.blockedRequestsCount,
    extractCharsTotal: row.extractCharsTotal,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

export function createBrowserTaskRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  const paDataDir = deps.config.dataDir;
  // BROWSER_TASK_REDESIGN_PLAN.md §9a.5 Shape B — emit `browser_task`
  // SSE events from the route layer too, so the dashboard sees the
  // initial `pending` insert plus the route-owned cancel + runner-
  // unavailable fallback transitions. The runner / driver / tool layer
  // emit their own transitions; this route layer covers the surface
  // those layers don't see.
  const transitionEmitter = createBrowserTaskTransitionEmitter(
    deps.eventBroadcaster ?? null,
  );

  // ── POST /api/browser-task ────────────────────────────────────────────
  app.post("/browser-task", async (c) => {
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
    // 2026-05-27 open-navigation revision — siteKey/extraAllowedHosts
    // are no longer required (or accepted) on the request body. The
    // task runs with no positive allowlist; domain-level gating comes
    // from the user-curated `browserTaskHostnameDenylist` runtime
    // setting, and the network IP CIDR layer + payment-path URL
    // blocker remain hardcoded inside the CDP route handler.
    const allowlist = composeAllowlistRegex({ siteKey: null });
    // The siteKey=null path always returns ok (`composedSource: null`).
    // The else branch is structurally unreachable; the assertion makes
    // the type checker discriminate the union without an `as` cast.
    /* c8 ignore start -- unreachable: siteKey=null path is total */
    if (!allowlist.ok) {
      return c.json({ error: allowlist.reason }, 500);
    }
    /* c8 ignore stop */

    // §14.8 originating-channel attestation. Header preferred over
    // body field. Phase 1 honours the header unconditionally because
    // the route is Approve-tier (bearer-only) — the dashboard is the
    // only legitimate caller. Phase 2 tightens this to the DM-agent
    // token check. A request whose channel is outside `listPrimaryChannels()`
    // is silently downgraded to the primary default AND an
    // `agent_actions(action_type='browser_task_channel_override')` row
    // is emitted per §14.8 step 2 so the override is auditable.
    //
    // §14.8 step 2 also envisions a `listPrimaryChannels() ∪ { DM-
    // agent's recorded session channel }` union so a legitimate DM-
    // agent forward whose session channel is not (yet) primary still
    // passes attestation. Threading the session channel through
    // requires plumbing the DM-agent session id from the request
    // context (header convention TBD in Phase 2 alongside the DM-agent
    // token check). Phase 1 uses the strictly-narrower
    // `listPrimaryChannels()`-only set; the rejection branch logs the
    // requested channel + writes the audit row so a Phase 2 reader
    // can grep `browser_task_channel_override` to see if the strict
    // posture caused real downgrades in production. The downgrade is
    // safe because the route is bearer-gated — the worst case is a
    // legitimate DM lands on a different primary channel, not a
    // hostile retargeting.
    const headerChannel = c.req.header("x-pa-channel-ref");
    const requestedChannel = headerChannel ?? input.originatingChannel ?? null;
    const primary = listPrimaryChannels(deps.db).map((row) =>
      channelRef(row.platform, row.channelId),
    );
    // Fallback when no B-4 primary channel is registered (the common case —
    // B-4 is opt-in / default-off, so `listPrimaryChannels()` is usually
    // empty): the owner's most-recently-active DM channel from
    // `owner_channels`. This is the practical form of the §14.8 "primary set
    // ∪ DM-agent session channel" union the comment above envisions — a
    // verified owner channel (paired via magic-phrase), never a hostile
    // target. Without it a DM-triggered task resolves to null and the
    // sub-agent's `ask_user` / `finish` DMs (including the screenshot) are
    // silently skipped, leaving the user with no result.
    const ownerDefault = selectDefaultOwnerChannel(deps.db);
    const ownerDefaultRef = ownerDefault
      ? channelRef(ownerDefault.platform, ownerDefault.channelId)
      : null;
    let resolvedChannel: string | null = null;
    if (requestedChannel) {
      if (primary.includes(requestedChannel)) {
        resolvedChannel = requestedChannel;
      } else {
        resolvedChannel = primary[0] ?? ownerDefaultRef;
        logger.warn(
          { requestedChannel, primaryCount: primary.length },
          "browser-task: requested originating channel not in primary set — falling back to primary default / owner DM channel",
        );
        try {
          deps.db
            .prepare(
              `INSERT INTO agent_actions
                 (action_type, detail, result, started_at, completed_at)
               VALUES (?, ?, 'success', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            )
            .run(
              "browser_task_channel_override",
              JSON.stringify({
                requestedChannel,
                resolvedChannel,
                source: headerChannel ? "header" : "body",
                reason: "outside_primary_set",
              }),
            );
        } catch (err) {
          /* c8 ignore start -- defensive against schema partials */
          logger.warn({ err }, "failed to record browser_task_channel_override audit row");
          /* c8 ignore stop */
        }
      }
    } else {
      resolvedChannel = primary[0] ?? ownerDefaultRef;
    }
    if (resolvedChannel === null) {
      logger.warn(
        { primaryCount: primary.length },
        "browser-task: no originating channel resolvable (no primary channel and no paired owner DM channel) — ask_user / finish DMs will be skipped",
      );
    }

    const id = randomUUID();

    // ── Scheduled path (BROWSER_TASK_REDESIGN_PLAN.md §6.2 / §7) ─────
    // Insert an `agent_schedule` row carrying the validated POST body
    // in `task_context`. The `browser_task` row is created at fire time
    // by the dispatcher's `scheduled.browser_task` handler so the
    // browser-task state machine doesn't accumulate stale `pending`
    // rows over a multi-day scheduling horizon. The taskId returned
    // here is pre-generated so the dashboard can poll
    // `GET /api/browser-task/<id>` and see a 404 until fire time,
    // then transition to the real row without a re-query.
    if (input.scheduleAt !== undefined) {
      const scheduledAtMs = Date.parse(input.scheduleAt);
      if (!Number.isFinite(scheduledAtMs)) {
        return c.json(
          { error: "invalid_schedule_at", detail: "scheduleAt must parse as ISO 8601." },
          400,
        );
      }
      // Reject schedules more than 1 minute in the past — symmetric
      // with the recurring-schedule reconciler's grace window. A
      // strictly-equal-to-now schedule fires on the next ScheduleWatcher
      // tick; a far-past schedule indicates a client clock error.
      const nowMs = Date.now();
      if (scheduledAtMs < nowMs - 60_000) {
        return c.json(
          {
            error: "schedule_at_in_past",
            detail: `scheduleAt resolves to a wall-clock time more than 60s in the past (delta=${nowMs - scheduledAtMs}ms).`,
          },
          400,
        );
      }
      const scheduleContext = {
        preGeneratedTaskId: id,
        description: input.description,
        siteKey: null,
        extraAllowedHosts: [] as string[],
        originatingChannel: resolvedChannel,
        requireFinalConfirm: input.requireFinalConfirm ?? true,
      };
      const correlationId = randomUUID();
      const browserDirective = input.description.slice(0, 200);
      const insertResult = deps.db
        .prepare(
          `INSERT INTO agent_schedule
             (scheduled_for, task_type, task_description, task_prompt, task_context, correlation_id, model, status)
           VALUES (?, 'browser_task', ?, ?, ?, ?, NULL, 'pending')`,
        )
        .run(
          formatSqliteDatetime(new Date(scheduledAtMs)),
          // The user's directive is both the list label and the agent body.
          browserDirective,
          browserDirective,
          JSON.stringify(scheduleContext),
          correlationId,
        );
      const scheduleRowId = Number(insertResult.lastInsertRowid);
      logger.info(
        { taskId: id, scheduleRowId, scheduledAt: input.scheduleAt },
        "browser-task scheduled — fire-time row creation deferred to dispatcher",
      );
      return c.json(
        {
          taskId: id,
          status: "scheduled" as const,
          scheduledFor: scheduledAtMs,
          scheduleRowId,
        },
        202,
      );
    }

    const createdAt = Date.now();
    const row = createBrowserTask(deps.db, {
      id,
      description: input.description,
      siteKey: null,
      extraAllowedHosts: [],
      originatingChannel: resolvedChannel,
      scheduleRowId: null,
      requireFinalConfirm: input.requireFinalConfirm ?? true,
      effectiveAllowlistRegex: allowlist.composedSource,
      createdAt,
    });
    // Shape B initial insert — emit so the dashboard list invalidates
    // before the runner promotes / fails. The runner emits subsequent
    // transitions of its own.
    transitionEmitter.emitFromRow(row, createdAt);

    // Fire-and-forget the runner. Phase 1 stub returns
    // `not_implemented` immediately; Phase 2 lands the real
    // Playwright + SDK loop. The await on the runner is deliberately
    // omitted so the route returns 202 + the task id without blocking
    // the HTTP response.
    if (deps.browserTaskRunner) {
      void deps.browserTaskRunner.runFromPost(id).catch((err) => {
        logger.error(
          { err, taskId: id },
          "browser-task runner threw on dispatch — task left in pending state",
        );
      });
    } else {
      // No runner wired (test harness OR an `index.ts` bootstrap that
      // has not yet wired the runner) — write a synthetic terminal
      // transition so the row doesn't hang in pending forever.
      const finishedAt = Date.now();
      const terminal = markTerminal(deps.db, {
        id,
        state: "failed",
        outcomeDetail: "runner_unavailable",
        report: null,
        finishedAt,
      });
      transitionEmitter.emitFromRow(terminal, finishedAt);
    }

    const queueState = deps.browserTaskSlotStateRef
      ? readQueueState(deps.browserTaskSlotStateRef.state, id)
      : null;

    // Re-read the row so the response reflects the post-dispatch state.
    // Without this, callers whose request landed when the runner was
    // not wired would see `status: "running"` even though the row was
    // already flipped to `failed (runner_unavailable)` in the fallback
    // branch above. The status mirrors the row's state directly so a
    // future state addition does not silently lie to the client.
    const postDispatchRow = getBrowserTask(deps.db, id) ?? row;

    return c.json(
      {
        taskId: id,
        status: postDispatchRow.state,
        sseUrl: `/api/browser-task/${id}/events`,
        queueState,
        row: toWire(postDispatchRow),
      },
      202,
    );
  });

  // ── GET /api/browser-task ─────────────────────────────────────────────
  app.get("/browser-task", (c) => {
    const stateQuery = c.req.query("state");
    const states = stateQuery
      ? (stateQuery.split(",").filter((s) => s.length > 0) as BrowserTaskState[])
      : undefined;
    const siteKey = c.req.query("siteKey");
    const limit = Math.min(
      200,
      Math.max(0, Number(c.req.query("limit")) || 50),
    );
    const offset = Math.max(0, Number(c.req.query("offset")) || 0);
    const rows = listBrowserTasks(deps.db, {
      states,
      siteKey: siteKey === undefined ? undefined : siteKey,
      limit,
      offset,
    });
    const total = countBrowserTasks(deps.db, {
      states,
      siteKey: siteKey === undefined ? undefined : siteKey,
    });
    const wire = rows.map((r) => ({
      ...toWire(r),
      queueState: deps.browserTaskSlotStateRef
        ? readQueueState(deps.browserTaskSlotStateRef.state, r.id)
        : null,
    }));
    return c.json({ tasks: wire, total, limit, offset });
  });

  // ── GET /api/browser-task/:id ─────────────────────────────────────────
  app.get("/browser-task/:id", (c) => {
    const id = c.req.param("id");
    const row = getBrowserTask(deps.db, id);
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json({
      ...toWire(row),
      queueState: deps.browserTaskSlotStateRef
        ? readQueueState(deps.browserTaskSlotStateRef.state, id)
        : null,
      actionLog: listBrowserTaskActionLog(deps.db, id),
      clarifications: listClarificationsForTask(deps.db, id),
    });
  });

  // ── GET /api/browser-task/:id/events (SSE) ────────────────────────────
  app.get("/browser-task/:id/events", (c) => {
    const id = c.req.param("id");
    const initial = getBrowserTask(deps.db, id);
    if (!initial) return c.json({ error: "not_found" }, 404);
    return streamSSE(c, async (stream) => {
      // Initial snapshot.
      await stream.writeSSE({
        event: "snapshot",
        data: JSON.stringify(toWire(initial)),
      });
      let lastState: BrowserTaskState = initial.state;
      // Phase 1 cheap-poll loop. Phase 7a wires the global SSE
      // adapter to emit `browser_task` named events on every state
      // transition (§9a.5 Shape B); the per-task stream stays
      // available as a fallback for CLI / future tooling.
      while (!stream.closed && !stream.aborted) {
        await stream.sleep(2000);
        const row = getBrowserTask(deps.db, id);
        if (!row) {
          await stream.writeSSE({
            event: "deleted",
            data: JSON.stringify({ id }),
          });
          return;
        }
        if (row.state !== lastState) {
          lastState = row.state;
          await stream.writeSSE({
            event: "transition",
            data: JSON.stringify(toWire(row)),
          });
        }
        if (
          row.state === "completed" ||
          row.state === "failed" ||
          row.state === "timeout" ||
          row.state === "cancelled" ||
          row.state === "abandoned"
        ) {
          // Terminal — flush a final marker and stop polling.
          await stream.writeSSE({
            event: "done",
            data: JSON.stringify(toWire(row)),
          });
          return;
        }
      }
    });
  });

  // ── GET /api/browser-task/:id/screenshots/:file ───────────────────────
  // The route shape mirrors §3 (`/screenshots/:idx`) but the file index
  // is the trace-store filename, not a numeric step index — the runner
  // emits per-step files via `trace-store-paths.makeScreenshotFileName`
  // and the action log records `screenshot_key` as the relative
  // filename. We accept the parameter as `:file` so the
  // existing `resolveTraceFilePath` validator (path-traversal safe)
  // applies unchanged.
  app.get("/browser-task/:id/screenshots/:file", async (c) => {
    const id = c.req.param("id");
    const fileName = c.req.param("file");
    const resolved = resolveTraceFilePath(paDataDir, id, fileName);
    if (!resolved) {
      return c.json({ error: "invalid_screenshot_path" }, 400);
    }
    let buf: Buffer;
    try {
      buf = await readFile(resolved);
    } catch (err) {
      logger.warn(
        { err, taskId: id, fileName },
        "browser-task screenshot read failed",
      );
      return c.json({ error: "screenshot_not_found" }, 404);
    }
    const ext = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
    const contentType =
      ext === "png"
        ? "image/png"
        : ext === "jpg" || ext === "jpeg"
          ? "image/jpeg"
          : ext === "webp"
            ? "image/webp"
            : "application/octet-stream";
    return new Response(buf, {
      status: 200,
      headers: {
        "content-type": contentType,
        "cache-control": "private, max-age=60",
      },
    });
  });

  // ── POST /api/browser-task/:id/clarify ────────────────────────────────
  app.post("/browser-task/:id/clarify", async (c) => {
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
    const row = getBrowserTask(deps.db, id);
    if (!row) return c.json({ error: "not_found" }, 404);
    if (row.state !== "awaiting_user") {
      return c.json(
        { error: "not_awaiting_user", currentState: row.state },
        409,
      );
    }
    const resolved = resolveClarification(deps.db, {
      id: parsed.data.clarificationId,
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
      return c.json(
        { error: resolved.reason ?? "clarify_failed" },
        status,
      );
    }
    // Phase 2 — invoke the runner's resume path. The runner re-enters
    // the SDK with the user's answer threaded as a fresh user message
    // and flips state accordingly when the next turn lands a terminal
    // / yield outcome. Fire-and-forget so the HTTP call returns
    // immediately; the SSE / list endpoints surface the outcome to the
    // dashboard.
    if (deps.browserTaskRunner) {
      void deps.browserTaskRunner
        .resumeAfterClarification({
          taskId: id,
          clarificationId: parsed.data.clarificationId,
          answer: parsed.data.answer,
        })
        .catch((err) => {
          logger.error(
            { err, taskId: id, clarificationId: parsed.data.clarificationId },
            "browser-task resumeAfterClarification threw — task left parked",
          );
        });
    } else {
      logger.warn(
        { taskId: id, clarificationId: parsed.data.clarificationId },
        "browser-task clarify recorded but no runner wired — task cannot resume.",
      );
    }
    return c.json({ ok: true, clarification: resolved.row });
  });

  // ── POST /api/browser-task/:id/cancel ─────────────────────────────────
  app.post("/browser-task/:id/cancel", async (c) => {
    const id = c.req.param("id");
    // Optional-body route: a bare cancel (no body / empty body) must
    // succeed with the default reason, not 400. `readJsonBody` never
    // rejects — for an empty body it resolves `{ ok: false, ... }`
    // (JSON.parse("") throws and is caught internally) — so we do NOT
    // bail on `!body.ok`; we treat an unreadable/empty body as "no
    // body" and let cancelBodySchema's `.optional()` default the reason.
    // Mirrors the managed-tasks.ts cancel precedent.
    const body = await readJsonBody(c);
    const rawBody = body.ok ? body.body : undefined;
    const parsed = cancelBodySchema.safeParse(rawBody);
    const reason = parsed.success ? parsed.data?.reason ?? "user_cancel" : "user_cancel";
    const row = getBrowserTask(deps.db, id);
    if (!row) return c.json({ error: "not_found" }, 404);
    if (
      row.state === "completed" ||
      row.state === "failed" ||
      row.state === "timeout" ||
      row.state === "cancelled" ||
      row.state === "abandoned"
    ) {
      return c.json(
        { error: "already_terminal", currentState: row.state },
        409,
      );
    }

    // Cancel-while-pending uses the queue-cancel path (decideCancel),
    // which throws when the slot manager already tracks the task as
    // active. The runner's `tryAcquire` flips the slot to active BEFORE
    // `markRunning` writes `state='running'` to DB, so there is a
    // narrow window where the DB row still reads `pending` but the
    // slot manager already promoted the task. A cancel landing in that
    // window must go through `runner.cancel` (which understands active
    // tasks via its in-memory handle map), NOT `decideCancel` (which
    // would throw and surface as a 500 to the caller).
    const slotActive = deps.browserTaskSlotStateRef
      ? slotManagerHasActive(deps.browserTaskSlotStateRef.state, id)
      : false;
    const isPending = row.state === "pending" && !slotActive;
    if (isPending) {
      // Cancel-while-pending — remove from BOTH FIFOs, no release
      // cascade fires (no slot was acquired).
      if (deps.browserTaskSlotStateRef) {
        const result = decideCancel(deps.browserTaskSlotStateRef.state, id);
        deps.browserTaskSlotStateRef.state = result.state;
      }
      const finishedAt = Date.now();
      const updated = markTerminal(deps.db, {
        id,
        state: "cancelled",
        outcomeDetail: `cancelled_in_queue:${reason}`,
        report: null,
        finishedAt,
      });
      transitionEmitter.emitFromRow(updated, finishedAt);
      return c.json({ ok: true, row: updated ? toWire(updated) : null });
    }

    // Cancel during running / awaiting_user / final_confirm.
    // Phase 2: hand the cancel to the runner and let it own the
    // terminal write + slot release once the SDK loop unwinds:
    //   - For a `running` task the runner only flips abortController;
    //     the SDK iterates one more `result` message then `runDriver`
    //     returns `outcome=cancelled` and `reconcileDriverOutcome`
    //     writes the terminal + releases the slot + releases the
    //     Playwright handle.
    //   - For a parked task (`awaiting_user` / `final_confirm`) the
    //     runner walks the parked-handle path itself — markTerminal +
    //     releaseDriverHandle + releaseAndPromote — synchronously.
    //
    // Critically we do NOT call `decideRelease` or `markTerminal` here
    // for the running case. Doing so frees the siteKey slot before the
    // BrowserContext is gone, which lets a queued same-siteKey task
    // promote into a Chromium `SingletonLock` clash on the shared
    // `--user-data-dir` (Plan A §5.1's load-bearing invariant).
    if (deps.browserTaskRunner) {
      await deps.browserTaskRunner.cancel(id, reason);
    } else {
      // No runner wired — fall back to the synthetic transition so the
      // row doesn't hang. The slot manager is also unreachable in this
      // path so we skip the release leg cleanly.
      const finishedAt = Date.now();
      const updated = markTerminal(deps.db, {
        id,
        state: "cancelled",
        outcomeDetail: reason,
        report: null,
        finishedAt,
      });
      transitionEmitter.emitFromRow(updated, finishedAt);
      return c.json({ ok: true, row: updated ? toWire(updated) : null });
    }

    // Re-read after the cancel — for parked tasks the runner already
    // wrote the terminal transition synchronously; for live tasks the
    // row may still be in non-terminal state until the SDK loop exits.
    const after = getBrowserTask(deps.db, id);
    return c.json({ ok: true, row: after ? toWire(after) : null });
  });

  return app;
}
