import type { Hono } from "hono";
import {
  scheduleRequestSchema,
  scheduleUpdateRequestSchema,
  scheduleDmRequestSchema,
  scheduleBatchRequestSchema,
  formatSqliteDatetime,
  isProcessTier,
  type ScheduleBatchRow,
} from "@aitne/shared";
import { createLogger } from "../../logging.js";
import type { ApiDependencies } from "../server.js";
import { readJsonBody } from "../json-body.js";
import { maybeTriggerRoadmapRefresh } from "../../core/schedule-insert-helper.js";
import {
  composeIssue,
  respondWithAgentError,
  translateZodError,
  type AgentErrorIssue,
} from "../helpers/agent-errors.js";
import { enrichAgentPlanTaskContext } from "./agent-schedule-plan-match.js";
import {
  resolveModelToken,
  resolveModelTokenForPatch,
} from "./schedule-model-resolver.js";
import { snapshotModelRegistry } from "./schedule-validation.js";

const logger = createLogger("agent-schedule-api");

/**
 * Promote a JSON-encoded `taskContext.tier_override` slot to the
 * dedicated `agent_schedule.tier_override` column. The slot pre-dates
 * the column (declared on `scheduleBatchTaskContextSchema` since the
 * batch endpoint's first cut and documented in
 * `agent-assets/skills/schedule/references/batch.md`) but was never
 * read at dispatch time — the column is the runtime contract. Lifting
 * here keeps callers that follow `references/batch.md` working
 * without introducing a second precedence path at dispatch.
 *
 * Returns `null` when the slot is absent or carries an unrecognised
 * value (CHECK constraint would reject the latter anyway; refusing
 * here lets the row land with `tier_override = NULL` instead of an
 * INSERT-time SqliteError).
 */
function liftTierFromTaskContext(
  ctx: Record<string, unknown> | undefined,
): "lite" | "medium" | "high" | null {
  if (!ctx) return null;
  const value = (ctx as { tier_override?: unknown }).tier_override;
  return isProcessTier(value) ? value : null;
}

function parseTaskContextJson(raw: string | null): Record<string, unknown> {
  // The agent_schedule.task_context column has DEFAULT '{}', so `raw` is never
  // null from a properly-seeded row. This guard handles the edge case of a row
  // inserted directly without the column value (test or legacy data).
  /* c8 ignore next */
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (err) {
    logger.warn({ err }, "Invalid task_context JSON in agent_schedule row");
  }
  return {};
}

export function registerAgentScheduleRoutes(
  app: Hono,
  deps: ApiDependencies,
): void {
  const { db } = deps;

  // POST /schedule — Register dynamic schedule
  app.post("/schedule", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = scheduleRequestSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      // Per docs/design/appendices/morning-routine-optimization.md
      // Phase 1, the existing single-row endpoint adopts the agent-
      // consumable error envelope so agent callers self-correct in
      // the same turn instead of looping on opaque "validation_error"
      // strings. Field-keyed code overrides cover the schema's
      // string-min and enum constraints; anything else falls through
      // to the namespace-level placeholder hint so a missing
      // registry entry surfaces in tests.
      // Schema-level fields (`time`, `taskType`) are typed as bare
      // `z.string()` here so the body-level Zod failure has no
      // registry-mapped semantics on its own. Field-keyed overrides
      // promote each to the nearest registry code so an LLM caller
      // gets a useful hint instead of a `<ns>.<field>_missing`
      // placeholder. The post-Zod handler below still re-checks
      // `time` for ISO8601 parseability and future-bound — the
      // override here only covers the "field absent / wrong type"
      // path Zod produces.
      const issues = translateZodError(parsed.error, {
        namespace: "schedule",
        fieldCodeMap: {
          time: "schedule.scheduled_for_invalid",
          taskType: "schedule.task_type_unknown",
          description: "schedule.description_too_short",
          prompt: "schedule.prompt_too_short",
          model: "schedule.model_unknown",
          tier: "schedule.tier_unknown",
        },
      });
      return respondWithAgentError(c, 400, issues);
    }

    const { time, taskType, description, prompt, model, tier, taskContext } = parsed.data;

    // Phase D — resolve the `(model, tier)` pair against the live
    // model registry BEFORE we do any other work so the alias-rewrite
    // and ambiguous/unknown branches reject the row at the same
    // boundary as the schema parse. The resolver also enforces §4.3's
    // tier/model mutual exclusion and emits the deprecated-warning
    // bookkeeping. Single snapshot per request so the conflict /
    // unknown / deprecated payloads stay consistent within the call.
    const registrySnapshot = snapshotModelRegistry();
    const resolved = resolveModelToken({
      model,
      tier,
      fieldBase: "model",
      tierField: "tier",
      rowIndex: null,
      snapshot: registrySnapshot,
    });
    if (!resolved.ok) {
      return respondWithAgentError(c, 400, resolved.errors);
    }

    // Normalize ISO8601 (possibly with timezone offset) to UTC SQLite format.
    // Without this, "2026-04-05T07:00:00+09:00" would be stored as-is and
    // ScheduleWatcher's lexicographic comparison (YYYY-MM-DD HH:MM:SS) would
    // fail due to the 'T' separator being > ' ' in ASCII.
    const parsedDate = new Date(time);
    if (isNaN(parsedDate.getTime())) {
      return respondWithAgentError(c, 400, [
        composeIssue("schedule.scheduled_for_invalid", {
          field: "time",
          received: time,
        }),
      ]);
    }
    // Reject times more than 1 minute in the past. This mirrors
    // /schedule/dm and prevents accidental immediate catch-up tasks when a
    // model resolves a relative time incorrectly.
    if (parsedDate.getTime() < Date.now() - 60_000) {
      return respondWithAgentError(c, 400, [
        composeIssue("schedule.scheduled_for_in_past", {
          field: "time",
          received: time,
        }),
      ]);
    }
    const scheduledForUtc = formatSqliteDatetime(parsedDate);
    const enrichedTaskContext = enrichAgentPlanTaskContext(
      taskContext,
      parsedDate,
      description,
      deps,
    );

    // Tier precedence: resolved `(model, tier_override, backend_id)`
    // from §4.3 wins over the legacy `taskContext.tier_override` slot.
    // The slot pre-dates the column and the resolver above already
    // rejected `{tier, model}` conflicts — so the lift here only
    // fires when the resolver returned all-NULL (no top-level pin)
    // AND the legacy JSON slot carries a tier the dispatcher should
    // honour. Lift the slot into `tier_override` for backward compat
    // with skills that follow the old `references/batch.md` shape.
    const liftedTier = liftTierFromTaskContext(enrichedTaskContext);
    const effectiveTier =
      resolved.model !== null || resolved.tierOverride !== null
        ? resolved.tierOverride
        : liftedTier;

    const result = db
      .prepare(
        `INSERT INTO agent_schedule (
           scheduled_for, task_type, task_description, task_prompt,
           task_context, model, tier_override, backend_id, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(
        scheduledForUtc,
        taskType,
        description,
        prompt ?? null,
        JSON.stringify(enrichedTaskContext),
        // §4.3 persistence rule: at most one of (model, tier_override)
        // is non-NULL at rest. The resolver normalizes alias rows to
        // `tier_override` and clears `model` + `backend_id` so the
        // dispatcher's override block reads a self-consistent row.
        resolved.model,
        effectiveTier,
        // §4.3a — snapshot the backend pin at write time. NULL for
        // alias rows, pure-tier rows, and the no-override path so
        // the scheduler falls through to the process-key defaults.
        resolved.backendId,
      );

    logger.info({ scheduleId: result.lastInsertRowid, taskType, scheduledFor: scheduledForUtc }, "Task scheduled");
    // Surface long-horizon user-facing schedules in roadmap.md as
    // `Scheduled:` entries. Internal/short-lived callers opt out via
    // `taskContext.importance = "low"` or `"transient"`; strategic rows
    // opt in regardless of horizon.
    maybeTriggerRoadmapRefresh(
      { scheduledFor: scheduledForUtc, taskContext: enrichedTaskContext },
      deps.triggerRoadmapRefresh,
      "scheduled_task_created",
    );
    // 2026-05 skill/API consistency: `/schedule/dm` returns
    // `scheduledFor` so the caller can confirm the normalized UTC
    // timestamp without a round-trip GET. The wake-task variant did
    // not, forcing callers that wanted to log the scheduled time to
    // either re-parse the input `time` themselves or query the table.
    // Returning it here is additive and matches the DM variant.
    //
    // Phase D — `warnings` carries the §5.0.5 advisory channel. The
    // most common entry is `schedule.model_deprecated` for a
    // registered-but-deprecated pin. Surface ALWAYS (even as empty
    // array) so the agent's parser doesn't have to handle two
    // response shapes.
    return c.json({
      status: "scheduled",
      scheduleId: String(result.lastInsertRowid),
      scheduledFor: scheduledForUtc,
      warnings: resolved.warnings,
    });
  });

  // POST /schedule/batch — Bulk schedule registration with rich taskContext.
  //
  // docs/design/appendices/morning-routine-optimization.md §"POST
  // /api/schedule/batch". Atomic by default — either every row commits or
  // none. The agent (Stage A in the morning-routine pipeline) is the only
  // actor with fresh access to mail / calendar / projects / roadmap so it
  // is the only actor that can compose a per-row `taskContext` carrying
  // background / expected_output / references / tone. A future
  // `scheduled.task` session firing hours later inherits that context
  // verbatim — its output quality is bounded by what the agent wrote at
  // scheduling time.
  //
  // Errors emit the uniform agent-consumable envelope so the LLM can
  // self-correct in the same turn rather than guessing. Per-row issues
  // carry rowIndex; cross-row issues carry rowIndex=null.
  app.post("/schedule/batch", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    if (
      !parsedBody.body
      || typeof parsedBody.body !== "object"
      || Array.isArray(parsedBody.body)
    ) {
      return respondWithAgentError(c, 400, [
        composeIssue("schedule.body_not_object", {
          field: "$",
          received: parsedBody.body,
        }),
      ]);
    }

    const parsed = scheduleBatchRequestSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      // Let the Zod translator emit "<ns>.<fieldTail>_<reason>" codes;
      // remap to registry codes per field. This keeps the missing vs
      // too-short distinction intact for taskContext required slots
      // (a field-code map would collapse both Zod reasons onto one
      // override and lose the "populate the field" vs "expand the
      // string" remediation hint).
      const rawIssues = translateZodError(parsed.error, {
        namespace: "schedule",
      });

      const remapped = rawIssues.map((issue) => {
        const f = issue.field;
        const reason = issue.code.replace(/^schedule\./, "");

        // taskContext slots — required vs optional are distinguished by
        // which keys the schema marks required (background, expected_output).
        // For those two we surface missing vs too-short separately so the
        // hint pushes the agent to populate the required slot. For any
        // other taskContext sub-field (references / tone / tier_override /
        // sub_flow / catch-all extras) the only failure shape Zod produces
        // is wrong-type — we collapse those to a single wrong_type code
        // so the response carries a useful hint instead of leaking the
        // unregistered <namespace>.<fieldTail>_invalid placeholder.
        if (f.includes(".taskContext.")) {
          const isRequiredSlot =
            f.endsWith(".taskContext.background")
            || f.endsWith(".taskContext.expected_output");
          if (isRequiredSlot && reason.endsWith("_missing")) {
            return composeIssue("schedule.task_context_field_missing", {
              field: f,
              received: issue.received,
              rowIndex: issue.rowIndex,
            });
          }
          if (isRequiredSlot && reason.endsWith("_too_short")) {
            return composeIssue("schedule.task_context_field_too_short", {
              field: f,
              received: issue.received,
              rowIndex: issue.rowIndex,
            });
          }
          return composeIssue("schedule.task_context_field_wrong_type", {
            field: f,
            received: issue.received,
            rowIndex: issue.rowIndex,
          });
        }

        // rows[] cardinality — too_big maps onto rows_too_many; missing /
        // wrong-type onto rows_field_missing.
        if (f === "rows") {
          if (reason.endsWith("_too_long") || reason.endsWith("_too_big")) {
            return composeIssue("schedule.rows_too_many", {
              field: f,
              received: issue.received,
              rowIndex: null,
            });
          }
          return composeIssue("schedule.rows_field_missing", {
            field: f,
            received: issue.received,
            rowIndex: null,
          });
        }

        // Row-content slots.
        if (f.endsWith(".taskDescription") && reason.endsWith("_too_short")) {
          return composeIssue("schedule.description_too_short", {
            field: f,
            received: issue.received,
            rowIndex: issue.rowIndex,
          });
        }
        if (f.endsWith(".taskPrompt") && reason.endsWith("_too_short")) {
          return composeIssue("schedule.prompt_too_short", {
            field: f,
            received: issue.received,
            rowIndex: issue.rowIndex,
          });
        }
        if (f.endsWith(".taskType")) {
          return composeIssue("schedule.task_type_unknown", {
            field: f,
            received: issue.received,
            rowIndex: issue.rowIndex,
          });
        }
        if (f.endsWith(".model")) {
          return composeIssue("schedule.model_unknown", {
            field: f,
            received: issue.received,
            rowIndex: issue.rowIndex,
          });
        }
        if (f.endsWith(".tier")) {
          return composeIssue("schedule.tier_unknown", {
            field: f,
            received: issue.received,
            rowIndex: issue.rowIndex,
          });
        }
        if (f === "atomic") {
          return composeIssue("schedule.batch_atomic_invalid", {
            field: f,
            received: issue.received,
            rowIndex: null,
          });
        }

        return issue;
      });

      return respondWithAgentError(c, 422, remapped, {
        rowsAttempted: Array.isArray(
          (parsedBody.body as { rows?: unknown }).rows,
        )
          ? ((parsedBody.body as { rows: unknown[] }).rows.length)
          : 0,
        rowsCommitted: 0,
        retryHint:
          "Fix the listed rows and POST the same body again. atomic=true (the default) means no rows were committed.",
      });
    }

    const { rows, atomic = true } = parsed.data;
    if (rows.length === 0) {
      // Documented no-op — keeps Stage A's "register everything I wrote"
      // step idempotent on days where it produced no schedules.
      return c.json({
        ok: true,
        rowsAttempted: 0,
        rowsCommitted: 0,
        ids: [] as number[],
      });
    }

    // Per-row business validation (Date-parse + future-bound + Phase D
    // model resolution). Zod can't express "Date(time) >= now" without
    // a refine that loses the row index in the path, and the model
    // resolver needs a live registry snapshot it doesn't currently
    // hold, so both checks happen in one pass here.
    const nowMs = Date.now();
    const registrySnapshot = snapshotModelRegistry();
    const businessIssues: AgentErrorIssue[] = [];
    const warnings: AgentErrorIssue[] = [];
    const normalized: Array<{
      row: ScheduleBatchRow;
      scheduledForUtc: string;
      scheduledForDate: Date;
      /** Resolved (model, tier_override, backend_id) per §4.3. */
      resolvedModel: string | null;
      resolvedTier: "lite" | "medium" | "high" | null;
      resolvedBackendId: string | null;
    }> = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const date = new Date(row.scheduledFor);
      if (Number.isNaN(date.getTime())) {
        businessIssues.push(
          composeIssue("schedule.scheduled_for_invalid", {
            field: `rows[${i}].scheduledFor`,
            received: row.scheduledFor,
            rowIndex: i,
          }),
        );
        continue;
      }
      if (date.getTime() < nowMs - 60_000) {
        businessIssues.push(
          composeIssue("schedule.scheduled_for_in_past", {
            field: `rows[${i}].scheduledFor`,
            received: row.scheduledFor,
            rowIndex: i,
          }),
        );
        continue;
      }
      // Phase D — per-row registry resolution. Nullable schema fields
      // come through as `null`; the resolver only acts on defined
      // values, so coerce null → undefined to reach the "no pin"
      // branch instead of misreading it as an explicit clear (which
      // is a PATCH-only concept on batch inserts).
      const resolved = resolveModelToken({
        model: row.model ?? undefined,
        tier: row.tier ?? undefined,
        fieldBase: `rows[${i}].model`,
        tierField: `rows[${i}].tier`,
        rowIndex: i,
        snapshot: registrySnapshot,
      });
      if (!resolved.ok) {
        for (const issue of resolved.errors) businessIssues.push(issue);
        continue;
      }
      for (const w of resolved.warnings) warnings.push(w);
      normalized.push({
        row,
        scheduledForUtc: formatSqliteDatetime(date),
        scheduledForDate: date,
        resolvedModel: resolved.model,
        resolvedTier: resolved.tierOverride,
        resolvedBackendId: resolved.backendId,
      });
    }

    if (businessIssues.length > 0) {
      return respondWithAgentError(c, 422, businessIssues, {
        rowsAttempted: rows.length,
        rowsCommitted: 0,
        retryHint:
          "Fix the listed rows and POST the same body again. atomic=true (the default) means no rows were committed.",
      });
    }

    // Insert phase. With `atomic:true` we wrap the loop in a single
    // better-sqlite3 transaction so an unforeseen DB-side rejection
    // (e.g. CHECK constraint) rolls back every row. The validated
    // path above already covers the per-row failure shape, so the
    // transaction is a defense-in-depth rather than the primary
    // error channel.
    const insert = db.prepare(
      `INSERT INTO agent_schedule (
         scheduled_for, task_type, task_description, task_prompt,
         task_context, correlation_id, model, tier_override, backend_id, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    );

    const ids: number[] = [];

    const writeOne = (entry: typeof normalized[number]): number => {
      const enriched = enrichAgentPlanTaskContext(
        entry.row.taskContext as Record<string, unknown>,
        entry.scheduledForDate,
        entry.row.taskDescription,
        deps,
      );
      // Tier precedence per single-row endpoint: the resolved pin
      // from §4.3 wins. Fall through to the legacy
      // `taskContext.tier_override` slot only when the resolver
      // returned no pin (no top-level `model` and no top-level
      // `tier` on the row).
      const liftedTier = liftTierFromTaskContext(enriched);
      const effectiveTier =
        entry.resolvedModel !== null || entry.resolvedTier !== null
          ? entry.resolvedTier
          : liftedTier;
      const result = insert.run(
        entry.scheduledForUtc,
        entry.row.taskType,
        entry.row.taskDescription,
        entry.row.taskPrompt ?? null,
        JSON.stringify(enriched),
        entry.row.correlationId ?? null,
        // §4.3 — at most one of (model, tier_override) is non-NULL.
        entry.resolvedModel,
        effectiveTier,
        // §4.3a — backend pin paired with the model column.
        entry.resolvedBackendId,
      );
      return Number(result.lastInsertRowid);
    };

    if (atomic) {
      const tx = db.transaction((entries: typeof normalized) => {
        for (const entry of entries) {
          ids.push(writeOne(entry));
        }
      });
      tx(normalized);
    } else {
      for (const entry of normalized) {
        ids.push(writeOne(entry));
      }
    }

    logger.info(
      {
        rowsCommitted: ids.length,
        atomic,
      },
      "Schedule batch registered",
    );

    // Roadmap refresh: trigger once per batch if any row qualifies.
    // Matches the single-row /schedule path's semantics — strategic +
    // long-horizon normal rows surface as roadmap `Scheduled:` entries.
    for (const entry of normalized) {
      maybeTriggerRoadmapRefresh(
        {
          scheduledFor: entry.scheduledForUtc,
          taskContext: entry.row.taskContext as Record<string, unknown>,
        },
        deps.triggerRoadmapRefresh,
        "scheduled_task_created",
      );
    }

    return c.json(
      {
        ok: true,
        rowsAttempted: rows.length,
        rowsCommitted: ids.length,
        ids,
        // §5.0.5 advisory channel. Always present (even as []) so
        // the LLM's batch parser doesn't have to handle two shapes.
        warnings,
      },
      201,
    );
  });

  // POST /schedule/dm — Schedule a direct DM (no agent needed)
  app.post("/schedule/dm", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = scheduleDmRequestSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("agent.schedule_dm_validation_error", { field: "body", received: parsedBody.body })],
        { legacyFields: { details: parsed.error } },
      );
    }

    const { time, message, platform, platforms, importance } = parsed.data as {
      time: string;
      message: string;
      platform?: string;
      platforms?: string[];
      importance?: "transient" | "normal" | "strategic";
    };

    const parsedDate = new Date(time);
    if (isNaN(parsedDate.getTime())) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("agent.invalid_time", { field: "time", received: time })],
        { legacyFields: { details: "Cannot parse time as a valid date" } },
      );
    }

    // Reject times more than 1 minute in the past
    if (parsedDate.getTime() < Date.now() - 60_000) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("agent.invalid_time", { field: "time", received: time })],
        { legacyFields: { details: "Scheduled time is in the past" } },
      );
    }

    const scheduledForUtc = formatSqliteDatetime(parsedDate);

    const dmTaskContext: Record<string, unknown> = {
      platforms: platforms ?? (platform ? [platform] : null),
      importance: importance ?? "transient",
    };

    const result = db
      .prepare(
        // task_type='dm' is consumed directly by `handleDirectDm` —
        // the LLM never runs, so `model` is meaningless. Persist NULL
        // so a reader can't mistake the row for a model-pinned task.
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, model, status)
         VALUES (?, 'dm', ?, ?, NULL, 'pending')`,
      )
      .run(
        scheduledForUtc,
        message,
        JSON.stringify(dmTaskContext),
      );

    // DM-scheduled reminders are transient by default so short pings do
    // not pollute roadmap.md. Callers can opt in with `importance`.
    maybeTriggerRoadmapRefresh(
      { scheduledFor: scheduledForUtc, taskContext: dmTaskContext },
      deps.triggerRoadmapRefresh,
      "scheduled_task_created",
    );

    return c.json({
      status: "scheduled",
      scheduleId: String(result.lastInsertRowid),
      scheduledFor: scheduledForUtc,
    });
  });

  // GET /schedule — List scheduled items
  app.get("/schedule", (c) => {
    const statusParam = c.req.query("status") ?? "pending,running";
    const roadmapEligible =
      c.req.query("roadmapEligible") === "true" ||
      c.req.query("roadmapEligible") === "1";
    const statuses = statusParam.split(",").map((s) => s.trim()).filter(Boolean);
    const allowed = new Set(["pending", "running", "completed", "failed", "skipped"]);
    for (const s of statuses) {
      if (!allowed.has(s)) {
        return respondWithAgentError(
          c,
          400,
          [composeIssue("agent.invalid_status", { field: "status", received: s })],
          { legacyFields: { details: `Unknown status: ${s}` } },
        );
      }
    }

    const placeholders = statuses.map(() => "?").join(",");
    const where = [`status IN (${placeholders})`];
    const queryParams: unknown[] = [...statuses];
    if (roadmapEligible) {
      const normalHorizonCutoff = formatSqliteDatetime(
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      );
      where.push(
        `(
          json_extract(task_context, '$.importance') = 'strategic'
          OR (
            (
              json_extract(task_context, '$.importance') IS NULL
              OR json_extract(task_context, '$.importance') NOT IN ('transient', 'low', 'strategic')
            )
            AND scheduled_for > ?
          )
        )`,
      );
      queryParams.push(normalHorizonCutoff);
    }

    const rows = db
      .prepare(
        `SELECT id, scheduled_for, task_type, task_description, task_prompt, task_context, model, tier_override, backend_id, status, created_at
         FROM agent_schedule
         WHERE ${where.join(" AND ")}
         ORDER BY scheduled_for ASC
         LIMIT 50`,
      )
      .all(...queryParams) as {
        id: number;
        scheduled_for: string;
        task_type: string;
        task_description: string;
        task_prompt: string | null;
        task_context: string | null;
        model: string | null;
        tier_override: string | null;
        backend_id: string | null;
        status: string;
        created_at: string;
      }[];

    const items = rows.map((r) => ({
      id: r.id,
      scheduledFor: r.scheduled_for,
      taskType: r.task_type,
      description: r.task_description,
      prompt: r.task_prompt,
      status: r.status,
      model: r.model,
      tier: r.tier_override,
      // Phase D §4.3a — surface the backend pin so callers
      // inspecting a row see the full (model, backend_id) tuple.
      backendId: r.backend_id,
      taskContext: parseTaskContextJson(r.task_context),
      createdAt: r.created_at,
    }));

    return c.json({ items });
  });

  // PATCH /schedule/:id — Edit a pending scheduled item
  app.patch("/schedule/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return respondWithAgentError(c, 400, [
        composeIssue("agent.invalid_id", { field: "id", received: c.req.param("id") }),
      ]);
    }

    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = scheduleUpdateRequestSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      // SCHEDULE_API_REDESIGN_PLAN §11 — PATCH parity with POST /schedule.
      // The legacy `agent.schedule_dm_validation_error` collapse erased
      // the offending field; the field-keyed map below preserves it so
      // the LLM caller self-corrects in one turn. `message` is omitted —
      // no `schedule.message_*` registry code exists and the post-Zod
      // block at ~785-807 handles the field/task_type mismatch path.
      // The three root-path refines (empty body, description+message,
      // prompt+message) all surface at field="" with Zod code "custom"
      // (mapped to `<ns>._invalid` by the generic translator). Remap to
      // `agent.no_changes`, which is registered and carries a coherent
      // hint for the dominant empty-body case; the other two refines
      // are accepted as conflated per §11 (the agent's retry path
      // naturally converges on a single-field body).
      const issues = translateZodError(parsed.error, {
        namespace: "schedule",
        fieldCodeMap: {
          time: "schedule.scheduled_for_invalid",
          description: "schedule.description_too_short",
          prompt: "schedule.prompt_too_short",
          model: "schedule.model_unknown",
          tier: "schedule.tier_unknown",
        },
      }).map((issue) => {
        if (issue.field === "" && issue.code.endsWith("_invalid")) {
          return composeIssue("agent.no_changes", {
            field: "body",
            received: parsedBody.body,
            rowIndex: null,
          });
        }
        return issue;
      });
      return respondWithAgentError(c, 400, issues);
    }

    const row = db
      .prepare("SELECT id, status, task_type FROM agent_schedule WHERE id = ?")
      .get(id) as { id: number; status: string; task_type: string } | undefined;

    if (!row) {
      return respondWithAgentError(c, 404, [
        composeIssue("agent.not_found", { field: "id", received: id }),
      ]);
    }

    if (row.status !== "pending") {
      return respondWithAgentError(
        c,
        409,
        [composeIssue("agent.schedule_conflict", { field: "status", received: row.status })],
        { legacyFields: { details: `Cannot edit item with status '${row.status}'. Only 'pending' items can be edited.` } },
      );
    }

    // Type-field validation: description ↔ wake/escalation, message ↔ dm,
    // prompt forbidden on dm (direct DMs do not run an agent so the prompt
    // override has nothing to override).
    if (parsed.data.description !== undefined && row.task_type === "dm") {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("agent.invalid_field", { field: "description", received: parsed.data.description })],
        { legacyFields: { details: "'description' cannot be set on dm-type schedules. Use 'message' instead." } },
      );
    }
    if (parsed.data.message !== undefined && row.task_type !== "dm") {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("agent.invalid_field", { field: "message", received: parsed.data.message })],
        { legacyFields: { details: "'message' can only be set on dm-type schedules. Use 'description' instead." } },
      );
    }
    if (parsed.data.prompt !== undefined && row.task_type === "dm") {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("agent.invalid_field", { field: "prompt", received: parsed.data.prompt })],
        { legacyFields: { details: "'prompt' cannot be set on dm-type schedules — direct DMs do not run an agent." } },
      );
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (parsed.data.time !== undefined) {
      const parsedDate = new Date(parsed.data.time);
      if (isNaN(parsedDate.getTime())) {
        return respondWithAgentError(
          c,
          400,
          [composeIssue("agent.invalid_time", { field: "time", received: parsed.data.time })],
          { legacyFields: { details: "Cannot parse time as a valid date" } },
        );
      }
      // Reject past times for dm type (consistent with POST /schedule/dm)
      if (row.task_type === "dm" && parsedDate.getTime() < Date.now() - 60_000) {
        return respondWithAgentError(
          c,
          400,
          [composeIssue("agent.invalid_time", { field: "time", received: parsed.data.time })],
          { legacyFields: { details: "Scheduled time is in the past" } },
        );
      }
      updates.push("scheduled_for = ?");
      values.push(formatSqliteDatetime(parsedDate));
    }

    if (parsed.data.description !== undefined) {
      updates.push("task_description = ?");
      values.push(parsed.data.description);
    }

    if (parsed.data.message !== undefined) {
      updates.push("task_description = ?");
      values.push(parsed.data.message);
    }

    // `prompt: null` is the explicit clear (revert to using task_description
    // as the agent body). `prompt: <string>` sets an override. `undefined` =
    // no change. The dm-type rejection is handled in the type-field block above.
    if (parsed.data.prompt !== undefined) {
      updates.push("task_prompt = ?");
      values.push(parsed.data.prompt);
    }

    // Phase D — resolve `(model, tier)` against the live registry
    // BEFORE assembling the UPDATE so the alias-rewrite, conflict,
    // and ambiguous/unknown paths reject at the same boundary as the
    // schema parse. PATCH-only semantics: `null` is the explicit
    // clear sentinel (separate from `undefined` = no change).
    const patchResolved = resolveModelTokenForPatch({
      model: parsed.data.model,
      tier: parsed.data.tier,
      fieldBase: "model",
      tierField: "tier",
      rowIndex: null,
    });
    if (!patchResolved.ok) {
      return respondWithAgentError(c, 400, patchResolved.errors);
    }

    if (patchResolved.model.present) {
      updates.push("model = ?");
      values.push(patchResolved.model.value);
    }

    // `tier: null` is the explicit clear; `tier: <enum>` sets the
    // override; `undefined` leaves the column untouched. The
    // PATCH resolver above coordinates with the model branch — an
    // alias rewrite or a registered-model set ALSO writes
    // `tier_override` (clears or sets) to keep the row consistent
    // with §4.3's "at most one pin non-NULL" invariant.
    if (patchResolved.tierOverride.present) {
      updates.push("tier_override = ?");
      values.push(patchResolved.tierOverride.value);
    }

    // §4.3a — `backend_id` always moves with `model`. The resolver
    // sets `present:true` on both for every model-write so the
    // dispatcher's override block (which guards on both columns
    // together) never reads a half-applied row.
    if (patchResolved.backendId.present) {
      updates.push("backend_id = ?");
      values.push(patchResolved.backendId.value);
    }

    if (parsed.data.taskContext !== undefined) {
      updates.push("task_context = ?");
      values.push(JSON.stringify(parsed.data.taskContext));
    }

    // This branch is unreachable: the zod refine above requires at least one
    // field to be defined — so updates can only be empty if all field-update
    // blocks above are individually skipped, which contradicts the refine.
    /* c8 ignore start */
    if (updates.length === 0) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("agent.no_changes", { field: "body", received: parsed.data })],
        { legacyFields: { details: "No valid fields to update" } },
      );
    }
    /* c8 ignore stop */

    // Optimistic lock: only update if still pending
    values.push(id);
    const result = db.prepare(
      `UPDATE agent_schedule SET ${updates.join(", ")} WHERE id = ? AND status = 'pending'`,
    ).run(...values);

    // Unreachable in unit tests: requires a concurrent scheduler tick to
    // change status from 'pending' to 'running' between the SELECT and this
    // UPDATE. The prior status !== 'pending' check (line ~660) catches the
    // row-not-found case; this fires only on a true time-of-check/time-of-use
    // race that cannot be reproduced without process-level suspension.
    /* c8 ignore start */
    if (result.changes === 0) {
      return respondWithAgentError(
        c,
        409,
        [composeIssue("agent.schedule_conflict", { field: "status", received: "running" })],
        { legacyFields: { details: "Item is no longer pending (may have been picked up by scheduler)" } },
      );
    }
    /* c8 ignore stop */

    return c.json({ status: "updated", id, warnings: patchResolved.warnings });
  });

  // DELETE /schedule/:id — Cancel a pending scheduled item
  app.delete("/schedule/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return respondWithAgentError(c, 400, [
        composeIssue("agent.invalid_id", { field: "id", received: c.req.param("id") }),
      ]);
    }

    const row = db
      .prepare("SELECT id, status FROM agent_schedule WHERE id = ?")
      .get(id) as { id: number; status: string } | undefined;

    if (!row) {
      return respondWithAgentError(c, 404, [
        composeIssue("agent.not_found", { field: "id", received: id }),
      ]);
    }

    if (row.status !== "pending") {
      return respondWithAgentError(
        c,
        409,
        [composeIssue("agent.schedule_conflict", { field: "status", received: row.status })],
        { legacyFields: { details: `Cannot cancel item with status '${row.status}'. Only 'pending' items can be cancelled.` } },
      );
    }

    db.prepare("UPDATE agent_schedule SET status = 'skipped' WHERE id = ?").run(id);

    return c.json({ status: "cancelled", id });
  });
}
