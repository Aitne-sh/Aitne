import { Hono } from "hono";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatSqliteDatetime } from "@aitne/shared";

import type { ApiDependencies } from "../../server.js";
import { createLogger } from "../../../logging.js";
import { readJsonBody } from "../../json-body.js";
import {
  deleteAgent,
  getAgent,
  getOverrideSnapshot,
  getRuntimeWindow,
  listAgents,
  setEnabled,
  setOverrideSnapshot,
  setRuntimeWindow,
  type AgentListFilter,
} from "../../../db/agents-store.js";
import {
  byErrorKind,
  getExecution,
  listExecutions,
  metricsWindow,
  type AgentExecutionResult,
  type AgentMetricsWindow,
} from "../../../db/agent-executions-store.js";
import {
  deleteRecurringSchedule,
  getRecurringSchedule,
  updateRecurringSchedule,
} from "../../../db/recurring-schedules.js";
import { loadEffectiveDefinition } from "../../../core/agents/effective-definition.js";
import { loadAgents } from "../../../core/agents/loader.js";
import { buildAgentLoadOptions } from "../../../core/agents/loader-boot.js";
import {
  getBuiltinRegistryEntry,
  resolveRuntimeWindowCadence,
} from "../../../core/agents/builtin-registry.js";
import {
  mergeRuntimeWindow,
  resolveActivityScanCadence,
} from "../../../core/agents/activity-scan-cadence.js";
import {
  buildDetail,
  buildListItem,
  buildRow,
  planCreate,
  planPatch,
  planRunNow,
  serializeExecution,
} from "./views.js";

/**
 * `/api/agents/*` route surface (AGENT_DEFINITIONS_DESIGN.md §9). Thin Hono
 * glue over the `agents` / `agent_executions` stores + the pure view/plan
 * helpers in `views.ts` and the effective-definition composer. Auto-excluded
 * from the coverage gate as an `index.ts` barrel-style entry — the JSON shapes,
 * the run-now / patch planners, and the definition composition all live in the
 * peer-tested pure modules; this file is the I/O orchestration around them and
 * is pinned by the behavioural `agents.test.ts`.
 */

const logger = createLogger("agents-api");

/**
 * v0.1.10 → v0.1.11: the `hourly-check` built-in became `activity-scan`.
 * Old URLs (`/api/agents/hourly-check`, bookmarks, in-flight skills) keep
 * working for one deprecation window — same in-process normalization
 * pattern as `context-vault-aliases.ts` (never an HTTP redirect, so
 * `curl -X PATCH` without `-L` keeps working). Remove after a minor release.
 */
const LEGACY_AGENT_SLUG_ALIASES: Readonly<Record<string, string>> = {
  "hourly-check": "activity-scan",
};

function normalizeSlug(raw: string): string {
  return LEGACY_AGENT_SLUG_ALIASES[raw] ?? raw;
}

/** Per-Agent 7d-metrics cache (§9.1 — "cached in-memory for 60 seconds"). */
const METRICS_TTL_MS = 60_000;

const EXECUTION_RESULTS = new Set<AgentExecutionResult>([
  "success",
  "error",
  "skipped",
  "timeout",
]);

export function createAgentDefinitionRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  const { db, config } = deps;
  const dayBoundaryHour = config.dayBoundaryHour;

  // Live interval cadence for a runtime-window built-in (activity-scan), or null
  // for every other Agent. The agent row's `runtime_window` overrides win;
  // the legacy `activityScan*` config keys are the per-field fallback
  // (AGENTS_HUB_REDESIGN_PLAN §2). Read at call time so a PATCH is reflected
  // immediately.
  const cadenceFor = (slug: string) => {
    const resolved = resolveActivityScanCadence(getRuntimeWindow(db, "activity-scan"), config);
    return resolveRuntimeWindowCadence(slug, {
      activityScanIntervalMinutes: resolved.intervalMinutes,
      activityScanActiveStartHour: resolved.activeStartHour,
      activityScanActiveEndHour: resolved.activeEndHour,
    });
  };

  // Runtime-window block for the detail envelope — only for the
  // runtime-window built-in (registry cron resolver === null).
  const scheduleWindowFor = (slug: string) => {
    const entry = getBuiltinRegistryEntry(slug);
    if (!entry || entry.cronExpression !== null) return null;
    const overrides = getRuntimeWindow(db, slug);
    const resolved = resolveActivityScanCadence(overrides, config);
    return {
      overrides: overrides as Record<string, number>,
      resolved: {
        interval_minutes: resolved.intervalMinutes,
        active_start_hour: resolved.activeStartHour,
        active_end_hour: resolved.activeEndHour,
        min_observations: resolved.minObservations,
      },
    };
  };

  const readDefinitionFile = (path: string): string | null => {
    try {
      return existsSync(path) ? readFileSync(path, "utf-8") : null;
    } catch (err) {
      logger.warn({ err, path }, "Failed to read agent definition file");
      return null;
    }
  };

  const metricsCache = new Map<string, { at: number; value: AgentMetricsWindow }>();
  const metrics7dCached = (slug: string): AgentMetricsWindow => {
    const now = Date.now();
    const hit = metricsCache.get(slug);
    if (hit && now - hit.at < METRICS_TTL_MS) return hit.value;
    const value = metricsWindow(db, slug, 7);
    metricsCache.set(slug, { at: now, value });
    return value;
  };

  const emit = (kind: string, payload: Record<string, unknown>): void => {
    deps.eventBroadcaster?.broadcastEvent({ kind, ...payload });
  };

  const recordAudit = (
    actionType: string,
    slug: string,
    detail: Record<string, unknown>,
  ): void => {
    try {
      db.prepare(
        `INSERT INTO agent_actions (action_type, trigger, result, detail, agent_id, started_at, completed_at)
         VALUES (?, 'api', 'success', json(?), ?, datetime('now'), datetime('now'))`,
      ).run(actionType, JSON.stringify({ slug, ...detail }), slug);
    } catch (err) {
      logger.warn({ err, slug, actionType }, "Failed to record agent config-change audit row");
    }
  };

  // ── GET /agents (§9.1) ──────────────────────────────────────────────────
  app.get("/agents", (c) => {
    const filter: AgentListFilter = { includeInvalid: false };
    const source = c.req.query("source");
    if (source === "builtin" || source === "user") filter.source = source;
    const enabled = c.req.query("enabled");
    if (enabled === "true") filter.enabled = true;
    else if (enabled === "false") filter.enabled = false;
    if (c.req.query("include_invalid") === "true") filter.includeInvalid = true;

    const agents = listAgents(db, filter).map((dto) => {
      const lastExecution =
        dto.lastExecutionId !== null ? getExecution(db, dto.lastExecutionId) : null;
      return buildListItem(dto, {
        metrics7d: metrics7dCached(dto.slug),
        lastExecution,
        intervalCadence: cadenceFor(dto.slug),
      });
    });
    return c.json({ agents });
  });

  // ── POST /agents — create a recurring user Agent ────────────────────────
  // The programmatic counterpart to the dashboard's "+ New Agent" form. The
  // pure `planCreate` assembles + validates the agent.md (recurring-only — a
  // one_shot schedule is rejected with a pointer to POST /api/schedule); the
  // route writes the file to the user agents root then synchronously reloads so
  // the row + paired recurring_schedules row exist before the 201 (the file
  // watcher also fires later, an idempotent no-op).
  app.post("/agents", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    if (
      typeof parsedBody.body !== "object" ||
      parsedBody.body === null ||
      Array.isArray(parsedBody.body)
    ) {
      return c.json({ error: "invalid_body", message: "body must be a JSON object" }, 400);
    }
    const body = parsedBody.body as Record<string, unknown>;

    const existingSlugs = new Set(
      listAgents(db, { includeInvalid: true }).map((a) => a.slug),
    );
    const plan = planCreate(body, existingSlugs);
    if (!plan.ok) {
      if (plan.status === 409) {
        return c.json({ error: plan.error, slug: plan.slug }, 409);
      }
      return c.json(
        {
          error: plan.error,
          ...(plan.hint ? { hint: plan.hint } : {}),
          ...(plan.field ? { field: plan.field } : {}),
          ...(plan.issues ? { issues: plan.issues } : {}),
        },
        400,
      );
    }

    const opts = buildAgentLoadOptions({
      db,
      config,
      ...(deps.eventBroadcaster ? { eventBroadcaster: deps.eventBroadcaster } : {}),
    });
    const dir = join(opts.userDir, plan.slug);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "agent.md"), plan.markdown, "utf-8");
    } catch (err) {
      logger.error({ err, slug: plan.slug, dir }, "Failed to write agent.md");
      return c.json({ error: "agent_write_failed", slug: plan.slug }, 500);
    }

    // Synchronous load pairs the recurring row + upserts the agents row. The
    // loader runs the FULL cross-check (e.g. tools.allowed vs the absolute-block
    // layer) the schema can't express; if it flags the fresh file invalid, undo
    // the write so a bad create leaves no junk.
    loadAgents(db, opts);
    const dto = getAgent(db, plan.slug);
    if (!dto || dto.invalid) {
      const detail = dto?.metadata.last_error ?? null;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        logger.warn({ err, slug: plan.slug, dir }, "Failed to clean up invalid agent dir");
      }
      if (dto) deleteAgent(db, plan.slug);
      deps.agentEnabledCache?.invalidate();
      return c.json({ error: "invalid_definition", slug: plan.slug, detail }, 400);
    }

    deps.agentEnabledCache?.invalidate();
    emit("agent.updated", { slug: plan.slug, source: "user" });
    recordAudit("agent.created", plan.slug, { source: "user" });
    logger.info(
      { slug: plan.slug, warnings: plan.warnings.length },
      "Agent created via POST /api/agents",
    );
    // AGENT_PROMPT_QUALITY_DESIGN.md §3.5 — surface the deterministic lint's
    // non-blocking authoring warnings so the DM agent can fix them or ask the
    // user. Omitted when clean so the common response shape is unchanged.
    return c.json(
      {
        status: "created",
        slug: plan.slug,
        ...(plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
      },
      201,
    );
  });

  // ── GET /agents/:slug (§9.2) ────────────────────────────────────────────
  app.get("/agents/:slug", (c) => {
    const slug = normalizeSlug(c.req.param("slug"));
    const dto = getAgent(db, slug);
    if (!dto) return c.json({ error: "agent_not_found", slug }, 404);

    const effective = loadEffectiveDefinition(dto, {
      readFile: readDefinitionFile,
      dayBoundaryHour,
    });
    const detail = buildDetail({
      dto,
      definition: effective.definition,
      definitionYaml: effective.yaml,
      recentExecutions: listExecutions(db, slug, { limit: 25 }),
      metrics7d: metricsWindow(db, slug, 7),
      metrics30d: metricsWindow(db, slug, 30),
      byErrorKind7d: byErrorKind(db, slug, 7),
      intervalCadence: cadenceFor(slug),
      scheduleWindow: scheduleWindowFor(slug),
    });
    return c.json(detail);
  });

  // ── GET /agents/:slug/executions (§9.3) ─────────────────────────────────
  app.get("/agents/:slug/executions", (c) => {
    const slug = normalizeSlug(c.req.param("slug"));
    if (!getAgent(db, slug)) return c.json({ error: "agent_not_found", slug }, 404);

    const limitRaw = Number.parseInt(c.req.query("limit") ?? "25", 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 25;
    const opts: Parameters<typeof listExecutions>[2] = { limit };
    const beforeRaw = c.req.query("before");
    if (beforeRaw !== undefined) {
      const before = Number.parseInt(beforeRaw, 10);
      if (Number.isFinite(before) && before > 0) opts.before = before;
    }
    const result = c.req.query("result");
    if (result !== undefined && EXECUTION_RESULTS.has(result as AgentExecutionResult)) {
      opts.result = result as AgentExecutionResult;
    }
    const executions = listExecutions(db, slug, opts).map(serializeExecution);
    return c.json({ slug, limit, executions });
  });

  // ── POST /agents/:slug/run-now (§9.4) ───────────────────────────────────
  app.post("/agents/:slug/run-now", async (c) => {
    const slug = normalizeSlug(c.req.param("slug"));
    const dto = getAgent(db, slug);
    if (!dto) return c.json({ error: "agent_not_found", slug }, 404);

    // User Agents carry their recurring row's prompt AND routing pins
    // (backend_id / model / tier_override) so the manual run does the real task
    // on the same backend a cron fire would use — `generateNextScheduleRow`
    // copies the identical fields off this row. Built-ins drive the prompt from
    // the routine / process key and resolve their backend there, so these stay
    // null.
    let taskPrompt: string | null = null;
    let pinnedBackendId: string | null = null;
    let pinnedModel: string | null = null;
    let pinnedTier: string | null = null;
    if (dto.source === "user" && dto.recurringScheduleId !== null) {
      const recurring = getRecurringSchedule(db, dto.recurringScheduleId);
      taskPrompt = recurring?.prompt ?? null;
      pinnedBackendId = recurring?.backendId ?? null;
      pinnedModel = recurring?.model ?? null;
      pinnedTier = recurring?.tier ?? null;
    }

    // §9.4 optional `trigger_note`. Tolerant of an empty/absent/malformed body
    // (the dashboard posts no body) — a missing note never 400s, it just stays
    // undefined; only a string value is honoured.
    const parsedBody = await readJsonBody(c);
    const note =
      parsedBody.ok
      && typeof parsedBody.body === "object"
      && parsedBody.body !== null
      && !Array.isArray(parsedBody.body)
      && typeof (parsedBody.body as Record<string, unknown>).trigger_note === "string"
        ? ((parsedBody.body as Record<string, unknown>).trigger_note as string)
        : undefined;

    const plan = planRunNow(dto, {
      taskPrompt,
      ...(note !== undefined ? { triggerNote: note } : {}),
      backendId: pinnedBackendId,
      model: pinnedModel,
      tier: pinnedTier,
    });
    if (!plan.ok) {
      return c.json({ error: plan.error, hint: plan.hint }, plan.status);
    }

    // System Agents: DM the owner before enqueueing (§9.4 Notify convention).
    if (plan.emitDm && deps.sendNotification) {
      try {
        await deps.sendNotification({
          message: `Manually triggered ${slug} at ${new Date().toISOString()}`,
          priority: "normal",
          notificationType: "agent",
        });
      } catch (err) {
        logger.warn({ err, slug }, "run-now owner DM failed (continuing to enqueue)");
      }
    }

    const insert = db
      .prepare(
        `INSERT INTO agent_schedule
           (scheduled_for, task_type, task_description, task_prompt, task_context, model, tier_override, backend_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(
        formatSqliteDatetime(new Date()),
        plan.taskType,
        plan.taskDescription,
        // System agents drive their body from the routine/process key and
        // leave taskPrompt null; the dispatcher reads task_prompt directly
        // (no task_description fallback), so coalesce to the description body.
        plan.taskPrompt ?? plan.taskDescription,
        JSON.stringify(plan.taskContext),
        plan.model,
        plan.tier,
        plan.backendId,
      );
    const scheduleRowId = Number(insert.lastInsertRowid);
    recordAudit("agent.run_now", slug, {
      scheduleRowId,
      source: dto.source,
      ...(note !== undefined ? { trigger_note: note } : {}),
    });
    logger.info({ slug, scheduleRowId, source: dto.source }, "Agent run-now enqueued");

    // The `agent_executions` row is opened by the dispatcher when it fires the
    // queued schedule row (§8.1), so no execution id exists yet at enqueue time.
    return c.json({ status: "queued", schedule_row_id: scheduleRowId, execution_id: null }, 202);
  });

  // ── PATCH /agents/:slug (§9.5) ──────────────────────────────────────────
  app.patch("/agents/:slug", async (c) => {
    const slug = normalizeSlug(c.req.param("slug"));
    const dto = getAgent(db, slug);
    if (!dto) return c.json({ error: "agent_not_found", slug }, 404);

    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    if (typeof parsedBody.body !== "object" || parsedBody.body === null || Array.isArray(parsedBody.body)) {
      return c.json({ error: "invalid_body", message: "body must be a JSON object" }, 400);
    }
    const body = parsedBody.body as Record<string, unknown>;

    const plan = planPatch(dto, body);
    if (!plan.ok) {
      if (plan.status === 409) {
        return c.json({ error: plan.error, warning: plan.warning }, 409);
      }
      return c.json(
        { error: plan.error, ...(plan.hint ? { hint: plan.hint } : {}), ...(plan.field ? { field: plan.field } : {}) },
        400,
      );
    }

    const now = Date.now();
    // Validate the schedule_window merge BEFORE applying anything so a bad
    // window can't leave a half-applied PATCH (enabled flipped, window 400d).
    let mergedWindow: ReturnType<typeof mergeRuntimeWindow> | undefined;
    if (plan.scheduleWindow !== undefined) {
      mergedWindow = mergeRuntimeWindow(getRuntimeWindow(db, slug), plan.scheduleWindow, config);
      if (!mergedWindow.ok) {
        return c.json({ error: mergedWindow.error, field: mergedWindow.field }, 400);
      }
    }
    if (plan.setEnabled !== undefined) {
      setEnabled(db, slug, plan.setEnabled, now, now);
      deps.agentEnabledCache?.invalidate();
      emit("agent.enabled_changed", { slug, enabled: plan.setEnabled });
      // Persist the stop-warning consent (§12.3): a built-in stop is gated on an
      // explicit `ack_warning`, so record that ack in the audit detail — the
      // audit trail should show the operator consented, not just that the flag
      // flipped. (Reaching here for a built-in disable means the ack passed.)
      recordAudit("agent.enabled_changed", slug, {
        enabled: plan.setEnabled,
        ...(plan.setEnabled === false && dto.source === "builtin"
          ? { ack_warning: body.ack_warning === true }
          : {}),
      });
    }
    if (plan.mirrorRecurringEnabled !== undefined && dto.recurringScheduleId !== null) {
      updateRecurringSchedule(db, dto.recurringScheduleId, { enabled: plan.mirrorRecurringEnabled });
    }
    if (Object.keys(plan.overrideSet).length > 0 || plan.overrideReset.length > 0) {
      const snapshot = getOverrideSnapshot(db, slug);
      for (const [path, value] of Object.entries(plan.overrideSet)) snapshot[path] = value;
      for (const path of plan.overrideReset) delete snapshot[path];
      setOverrideSnapshot(db, slug, snapshot, now);
      recordAudit("agent.override_changed", slug, {
        set: Object.keys(plan.overrideSet),
        reset: plan.overrideReset,
      });
    }
    if (mergedWindow?.ok) {
      setRuntimeWindow(db, slug, mergedWindow.value, now);
      recordAudit("agent.schedule_window_changed", slug, {
        window: mergedWindow.value,
        cadence_changed: mergedWindow.cadenceChanged,
      });
      // Interval / active-hours edits change the registered cron expression;
      // rebuild live (same mechanism the dashboard config PATCH used for the
      // legacy keys). min_observations is fire-time-only — no rebuild.
      if (mergedWindow.cadenceChanged) {
        deps.onScheduleConfigChanged?.();
      }
    }
    if (plan.stripped.length > 0) {
      logger.info({ slug, stripped: plan.stripped }, "PATCH /agents stripped read-only fields");
    }
    emit("agent.updated", { slug, source: dto.source });

    const updated = getAgent(db, slug)!;
    return c.json({ status: "updated", row: buildRow(updated, cadenceFor(slug)), stripped: plan.stripped });
  });

  // ── DELETE /agents/:slug (§9.6) ─────────────────────────────────────────
  app.delete("/agents/:slug", async (c) => {
    const slug = normalizeSlug(c.req.param("slug"));
    const dto = getAgent(db, slug);
    if (!dto) return c.json({ error: "agent_not_found", slug }, 404);

    if (dto.source === "builtin") {
      return c.json(
        {
          error: "system_agent_undeletable",
          warning: dto.stopWarning,
          hint: "system Agents can be stopped but not deleted",
        },
        409,
      );
    }

    const rawBody = await c.req.json().catch(() => ({}));
    const keepHistory = (rawBody as { keep_history?: unknown }).keep_history !== false;
    const now = Date.now();

    if (keepHistory) {
      // Disable (retain) the paired recurring row so the schedule stops firing
      // but its definition + the Agent's execution history survive.
      if (dto.recurringScheduleId !== null) {
        updateRecurringSchedule(db, dto.recurringScheduleId, { enabled: false });
      }
      setEnabled(db, slug, false, now, now);
      deps.agentEnabledCache?.invalidate();
      emit("agent.enabled_changed", { slug, enabled: false });
      recordAudit("agent.disabled", slug, { keepHistory: true });
      return c.json({ status: "disabled", slug });
    }

    // Hard delete — remove the paired recurring row ENTIRELY (cancels its
    // pending agent_schedule rows + clears the FK), not just disable it.
    // Disabling alone leaves a row that no Agent references once we drop the
    // `agents` row below, and the loader's first-boot auto-import (§6.5) re-
    // creates that orphan as `imported-<id>/agent.md` on the next boot —
    // resurrecting the Agent the operator just hard-deleted. Deleting the
    // recurring row removes the orphan so the deletion is permanent.
    if (dto.recurringScheduleId !== null) {
      deleteRecurringSchedule(db, dto.recurringScheduleId);
    }

    // Snapshot the file, remove it, then drop the row (cascades executions).
    // Best-effort fs ops never block the DB delete.
    try {
      if (existsSync(dto.definitionPath)) {
        const content = readFileSync(dto.definitionPath, "utf-8");
        db.prepare(
          "INSERT INTO md_file_snapshots (file_path, content, trigger, session_id) VALUES (?, ?, 'agent_delete', NULL)",
        ).run(dto.definitionPath, content);
        rmSync(dirname(dto.definitionPath), { recursive: true, force: true });
      }
    } catch (err) {
      logger.warn({ err, slug, path: dto.definitionPath }, "Failed to remove agent definition file");
    }
    deleteAgent(db, slug);
    deps.agentEnabledCache?.invalidate();
    emit("agent.updated", { slug, source: "user" });
    recordAudit("agent.deleted", slug, { keepHistory: false });
    return c.json({ status: "deleted", slug });
  });

  return app;
}
