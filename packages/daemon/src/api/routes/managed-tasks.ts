import { Hono } from "hono";
import type Database from "better-sqlite3";
import {
  managedTaskCreateSchema,
  managedTaskPatchSchema,
  managedTaskRunResultSchema,
  isValidManagedTaskId,
  normalizeAppLabel,
  validateAppLabel,
  type ManagedTask,
  type RecurrenceRule,
} from "@aitne/shared";
import {
  allocateNextManagedTaskId,
  countManagedTasks,
  deleteManagedTask,
  findManagedTaskByAppCadence,
  getManagedTask,
  insertManagedTask,
  listManagedTasks,
  updateManagedTask,
  updateManagedTaskRunResult,
} from "../../db/managed-tasks-store.js";
import {
  createRecurringSchedule,
  deleteRecurringSchedule,
  getRecurringSchedule,
  updateRecurringSchedule,
} from "../../db/recurring-schedules.js";
import { readJsonBody } from "../json-body.js";
import { getContextDir } from "../../config.js";
import { createLogger } from "../../logging.js";
import { composeIssue, respondWithAgentError } from "../helpers/agent-errors.js";
import {
  bootstrapManagementRegistry,
  readAndParseManagementMd,
  renderAndWriteManagementMd,
  type RenderOptions,
} from "../../core/management-registry.js";
import {
  InMemoryManagementMdWriteLockManager,
  withManagementMdWriteLock,
  type ManagementMdWriteLockManager,
} from "../../core/management-md-write-lock.js";
import { rewriteEntityFilesForSourceRename } from "../../core/context/entity-source-rename.js";
import type { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import { readSotBindings } from "../../db/sot-bindings-store.js";
import {
  readRuntimeState,
  writeRuntimeState,
} from "../../db/runtime-state.js";
import type { ApiDependencies } from "../server.js";

const logger = createLogger("managed-tasks-api");

const TASK_TYPE = "scheduled.task";
const RUN_NOW_TASK_TYPE = "scheduled.task";
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** Hard upper bound on active managed-task rows (§NFR-8). Surfaced as 409
 *  when registration would push the count past this value. */
const DEFAULT_MAX_ACTIVE_TASKS = 100;

interface IdempotencyRecord {
  /** mt_id allocated for the original successful POST. */
  mtId: string;
  /** Epoch-ms expiry. Past this point the row is treated as absent. */
  expiresAt: number;
}

function idempotencyKeyToRuntimeKey(key: string): string {
  return `idem:managed-tasks:${key}`;
}

function configuredMaxActiveTasks(config: ApiDependencies["config"]): number {
  const value = (config as Record<string, unknown>).managementMaxActiveTasks;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_MAX_ACTIVE_TASKS;
}

function recordAuditAction(
  db: Database.Database,
  actionType: string,
  detail: Record<string, unknown>,
  result: "success" | "failed" = "success",
): void {
  try {
    db.prepare(
      `INSERT INTO agent_actions
         (event_id, action_type, trigger, result, detail, started_at, completed_at)
       VALUES (?, ?, 'reactive', ?, ?, datetime('now'), datetime('now'))`,
    ).run(
      `${actionType}:${Date.now()}`,
      actionType,
      result,
      JSON.stringify(detail),
    );
  } catch (err) {
    // Audit failure is non-fatal — the row in the user-facing tables
    // already committed. Log loudly so observability picks up DB pressure.
    logger.warn(
      { err, actionType, detail },
      "managed-task audit insert failed",
    );
  }
}

/**
 * Recover preserved §C and free-prose blocks from the on-disk file so
 * an API-driven re-render does not silently destroy user-authored
 * content. Returns empty options when the file does not exist or fails
 * to parse — matching the `bootstrapManagementRegistry` behavior of
 * falling back to the default stub + Notes block.
 *
 * MUST be called inside the management-md write lock so a watcher /
 * concurrent API call cannot stomp the file between the parse and the
 * subsequent render.
 */
async function loadPreservedRenderOptions(
  contextDir: string,
): Promise<RenderOptions> {
  try {
    const parsed = await readAndParseManagementMd(contextDir);
    if (!parsed) return {};
    const opts: RenderOptions = {};
    if (parsed.preservedSectionC !== null) {
      opts.preservedSectionC = parsed.preservedSectionC;
    }
    if (parsed.preservedFreeProse.size > 0) {
      opts.preservedFreeProse = parsed.preservedFreeProse;
    }
    return opts;
  /* c8 ignore start — fires only when the management.md file is unreadable/corrupted;
   * the render falls back to defaults harmlessly. Not reachable in unit tests. */
  } catch (err) {
    logger.warn(
      { err },
      "management.md preserved-section read failed — re-render will fall back to defaults",
    );
    return {};
  }
  /* c8 ignore stop */
}

/**
 * Re-render `policies/management.md` from the current DB state, holding
 * the management-md write lock for the render → atomic write →
 * snapshot trio (§11.1, §11.3). Returns:
 *   - `{ ok: true }` on success
 *   - `{ ok: false, holder }` when the lock was contended; the DB is
 *     authoritative so the response is non-fatal — the boot reconciler
 *     converges on next start.
 *
 * The function imports the render input fresh on every call so a
 * concurrent in-tx mutation (registration + first scheduled run) sees
 * the latest row state instead of stale closure data.
 *
 * Preserved §C and free-prose blocks are recovered from the on-disk
 * file inside the lock so user-authored content survives the re-render
 * (parity with `bootstrapManagementRegistry` and the watcher).
 */
async function renderManagementMdFromDb(
  contextDir: string,
  db: Database.Database,
  lockManager: ManagementMdWriteLockManager,
  trigger: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await withManagementMdWriteLock(lockManager, async () => {
    const lockId = lockManager.getHolder();
    /* c8 ignore next 3 — held lock guarantees a holder; defensive only. */
    if (!lockId) {
      throw new Error("renderManagementMdFromDb: lock holder lost");
    }
    const render = await loadPreservedRenderOptions(contextDir);
    await renderAndWriteManagementMd(
      contextDir,
      db,
      {
        sotBindings: readSotBindings(db),
        managedTasks: listManagedTasks(db),
      },
      { lockManager, lockId, trigger, render },
    );
  });
  /* c8 ignore start — fires only when a concurrent write holds the lock;
   * not reproducible in single-threaded unit tests. */
  if (!result.ok) {
    logger.warn(
      { holder: result.holder, trigger },
      "management.md re-render skipped — lock contended (DB remains authoritative)",
    );
    return { ok: false, reason: `lock_contended:${result.holder}` };
  }
  /* c8 ignore stop */
  return { ok: true };
}

export interface ManagedTasksRoutesDeps {
  db: Database.Database;
  config: ApiDependencies["config"];
  /**
   * Shared management-md write lock manager. The single in-process
   * holder is required by §11.1 — a per-call manager would let
   * back-to-back POSTs stomp each other's render. The `apiServer`
   * wires a singleton; tests inject their own.
   */
  lockManager: ManagementMdWriteLockManager;
  /**
   * Forwarded from the agent's `/run-now` plumbing. The route's
   * per-mt-id `run-now` enqueues an `agent_schedule` row pointing at
   * the recurring schedule; that row is what the dispatcher already
   * picks up — no separate event-bus push is required. Provided
   * optionally for parity with `recurring-schedules.ts`'s mirror
   * refresh hook.
   */
  triggerRoadmapRefresh?: (source: string) => void;
  /**
   * Shared with the entity-mirror watcher so the rename-app entity-
   * file rewrites are not classified as user-originated edits (which
   * would emit duplicate `observation` rows). Optional in tests; the
   * production wiring threads `deps.writeTracker` from the API server.
   */
  writeTracker?: AgentWriteTracker;
}

export function createManagedTasksRoutes(deps: ManagedTasksRoutesDeps): Hono {
  const app = new Hono();
  const { db, config, lockManager, writeTracker } = deps;

  // ── List / read ─────────────────────────────────────────────────────────

  // GET /managed-tasks — list active rows
  app.get("/managed-tasks", (c) => {
    const items = listManagedTasks(db);
    return c.json({ items, count: items.length });
  });

  // GET /managed-tasks/:id — single row + structured recurrenceRule
  //
  // The structured rule is embedded so the modify sheet can populate
  // its cadence editor in one round-trip (per followups #1: cadence
  // schedule edit). The DB is the FK target — a managed_tasks row
  // without its recurring_schedules sibling is an integrity violation,
  // so a missing rule here means "row is mid-rebuild" and we surface
  // it via `recurrenceRule: null` rather than 5xx-ing the read.
  app.get("/managed-tasks/:id", (c) => {
    const id = c.req.param("id");
    if (!isValidManagedTaskId(id)) {
      return respondWithAgentError(c, 400, [
        composeIssue("managed_tasks.invalid_id", { field: "id", received: id }),
      ]);
    }
    const item = getManagedTask(db, id);
    if (!item) {
      return respondWithAgentError(c, 404, [
        composeIssue("managed_tasks.not_found", { field: "id", received: id }),
      ]);
    }
    const schedule = getRecurringSchedule(db, item.schedule_id);
    return c.json({
      item,
      /* c8 ignore next 1 — FK ON DELETE CASCADE guarantees schedule exists when managed_task does */
      recurrenceRule: schedule?.recurrenceRule ?? null,
    });
  });

  // GET /managed-tasks/:id/runs — agent_actions history (§14.2)
  app.get("/managed-tasks/:id/runs", (c) => {
    const id = c.req.param("id");
    if (!isValidManagedTaskId(id)) {
      return respondWithAgentError(c, 400, [
        composeIssue("managed_tasks.invalid_id", { field: "id", received: id }),
      ]);
    }
    const item = getManagedTask(db, id);
    if (!item) {
      return respondWithAgentError(c, 404, [
        composeIssue("managed_tasks.not_found", { field: "id", received: id }),
      ]);
    }
    const limit = clampQueryLimit(c.req.query("limit"), 50, 200);
    if (limit === null) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("managed_tasks.invalid_limit", { field: "limit", received: c.req.query("limit") ?? "<missing>" })],
        { legacyFields: { message: "limit must be a positive integer ≤ 200" } },
      );
    }
    const rows = db
      .prepare(
        `SELECT id, action_type, result, detail, started_at, completed_at
           FROM agent_actions
          WHERE action_type LIKE 'management_task.%'
            AND json_extract(detail, '$.mt_id') = ?
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(id, limit) as Array<{
        id: number;
        action_type: string;
        result: string | null;
        detail: string | null;
        started_at: string | null;
        completed_at: string | null;
      }>;
    return c.json({
      runs: rows.map((row) => ({
        id: row.id,
        kind: row.action_type,
        result: row.result,
        /* c8 ignore next 1 — json_extract WHERE clause guarantees detail is non-null here */
        detail: row.detail ? safeParseJson(row.detail) : null,
        startedAt: row.started_at,
        completedAt: row.completed_at,
      })),
    });
  });

  // GET /management-history — recent management_task.% + sot_binding.%
  // events for the dashboard's Settings → Management → History tab
  // (§14.1). Aggregate view: the per-mt /runs endpoint is keyed by id;
  // this one shows everything that touched A or B sections recently.
  //
  // Cursor pagination: pass `before_id=<id>` to fetch rows older than the
  // given id. The response's `nextCursor` is the smallest id in the
  // RETURNED page when more rows may exist past it; `null` at the tail.
  // We probe by querying `LIMIT (limit + 1)` and slicing the extra row
  // off — that lets us know "more exists" without a trailing empty
  // page on the boundary case (exactly `limit` rows match). The cursor
  // walks `id DESC` so a fresh insert during pagination cannot push
  // older rows past the cursor (monotonic AUTOINCREMENT ids).
  app.get("/management-history", (c) => {
    const limit = clampQueryLimit(c.req.query("limit"), 50, 200);
    if (limit === null) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("managed_tasks.invalid_limit", { field: "limit", received: c.req.query("limit") ?? "<missing>" })],
        { legacyFields: { message: "limit must be a positive integer ≤ 200" } },
      );
    }
    const cursor = parseBeforeIdCursor(c.req.query("before_id"));
    if (cursor === "invalid") {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("managed_tasks.invalid_cursor", { field: "before_id", received: c.req.query("before_id") ?? "<missing>" })],
        { legacyFields: { message: "before_id must be a positive integer" } },
      );
    }
    const probeLimit = limit + 1;
    const probed = (cursor === null
      ? db
          .prepare(
            `SELECT id, action_type, result, detail, started_at, completed_at
               FROM agent_actions
              WHERE action_type LIKE 'management_task.%'
                 OR action_type LIKE 'sot_binding.%'
              ORDER BY id DESC
              LIMIT ?`,
          )
          .all(probeLimit)
      : db
          .prepare(
            `SELECT id, action_type, result, detail, started_at, completed_at
               FROM agent_actions
              WHERE (action_type LIKE 'management_task.%'
                     OR action_type LIKE 'sot_binding.%')
                AND id < ?
              ORDER BY id DESC
              LIMIT ?`,
          )
          .all(cursor, probeLimit)) as Array<{
        id: number;
        action_type: string;
        result: string | null;
        detail: string | null;
        started_at: string | null;
        completed_at: string | null;
      }>;
    const hasMore = probed.length > limit;
    const rows = hasMore ? probed.slice(0, limit) : probed;
    const nextCursor = hasMore ? Number(rows[rows.length - 1].id) : null;
    return c.json({
      events: rows.map((row) => ({
        id: row.id,
        kind: row.action_type,
        result: row.result,
        detail: row.detail ? safeParseJson(row.detail) : null,
        startedAt: row.started_at,
        completedAt: row.completed_at,
      })),
      nextCursor,
    });
  });

  // ── Create (§10.1) ──────────────────────────────────────────────────────

  app.post("/managed-tasks", async (c) => {
    const parsedBody = await readJsonBody(c, { maxBytes: 32 * 1024 });
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = managedTaskCreateSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("managed_tasks.validation_error", { field: "body", received: parsedBody.body })],
        { legacyFields: { details: parsed.error } },
      );
    }
    const idempotencyKey = c.req.header("idempotency-key");

    // §11.4 idempotency: an unexpired record short-circuits to the
    // original mt_id without inserting again. The expiry is checked at
    // read-time (lazy GC); a stale record falls through and is
    // overwritten on success.
    if (idempotencyKey) {
      const existing = readRuntimeState<IdempotencyRecord>(
        db,
        idempotencyKeyToRuntimeKey(idempotencyKey),
      );
      if (existing && existing.expiresAt > Date.now()) {
        const item = getManagedTask(db, existing.mtId);
        if (item) {
          return c.json({ status: "idempotent_replay", item }, 200);
        }
        // The mt_id was deleted (manual stop, etc.) but the idempotency
        // record outlived it. Drop the stale record so the retry can
        // legitimately re-register.
        writeRuntimeState(db, idempotencyKeyToRuntimeKey(idempotencyKey), {
          mtId: "",
          expiresAt: 0,
        });
      }
    }

    // Cap check (§NFR-8). Done outside the tx so the response is fast
    // and the count race is acceptable: a competing POST that lands at
    // exactly `cap` will fail on the UNIQUE / cap recheck inside the tx.
    if (countManagedTasks(db) >= configuredMaxActiveTasks(config)) {
      return respondWithAgentError(
        c,
        409,
        [
          composeIssue("managed_tasks.cap_reached", {
            field: "count",
            received: countManagedTasks(db),
          }),
        ],
        {
          legacyFields: {
            message: `Active managed-tasks cap (${configuredMaxActiveTasks(config)}) reached. Stop one before registering another.`,
          },
        },
      );
    }

    const { intent, app: appLabel, cadence, recurrenceRule, output_path } =
      parsed.data;

    // §10.1 step 5b duplicate check — the (app_normalized, cadence)
    // UNIQUE constraint is the floor, but explicitly checking here lets
    // us return a 409 with the existing mt_id for the agent's DM
    // ("Already managed as mt_xx") instead of relying on the DB error.
    const dup = findManagedTaskByAppCadence(db, appLabel, cadence);
    if (dup) {
      return respondWithAgentError(
        c,
        409,
        [
          composeIssue("managed_tasks.duplicate", {
            field: "(app, cadence)",
            received: { app: dup.app, cadence: dup.cadence },
          }),
        ],
        {
          legacyFields: {
            message: `A managed task already covers (${dup.app}, ${dup.cadence})`,
            item: dup,
          },
        },
      );
    }

    // Resolve timezone from daemon config when omitted, mirroring
    // recurring-schedules.ts's resolveTimezone.
    const resolvedRule: RecurrenceRule = {
      ...recurrenceRule,
      timezone:
        recurrenceRule.timezone ?? config.timezone ?? "UTC",
    };

    let inserted: ManagedTask;
    let scheduleId: number;
    try {
      // §11.3 — DB transaction. File IO is post-transaction.
      const txResult = db.transaction(() => {
        const mtId = allocateNextManagedTaskId(db);
        // task_description is the rendered cadence label so a stale
        // ScheduleWatcher fire still has enough context for the agent
        // to act on, even before the per-row managed-task lookup.
        const description = `[${mtId}] ${intent} — ${cadence}`;
        const scheduleDto = createRecurringSchedule(db, {
          taskType: TASK_TYPE,
          description,
          recurrenceRule: resolvedRule,
          taskContext: {
            mt_id: mtId,
            app: appLabel,
            cadence,
            // Importance="low" so the agent_schedule materializer
            // doesn't surface every recurring fire on the roadmap.
            importance: "low",
          },
        });
        const row = insertManagedTask(db, {
          id: mtId,
          intent,
          app: appLabel,
          cadence,
          outputPath: output_path ?? null,
          scheduleId: scheduleDto.id,
        });
        return { row, scheduleId: scheduleDto.id };
      })();
      inserted = txResult.row;
      scheduleId = txResult.scheduleId;
    } catch (err) {
      /* c8 ignore next 1 — err is always a SqliteError; String(err) fallback unreachable */
      const message = err instanceof Error ? err.message : String(err);
      /* c8 ignore start — UNIQUE constraint race: only when two POST requests
       * interleave between the pre-check SELECT and the INSERT; not testable
       * single-threaded. Both the condition and its body must be ignored to
       * suppress branch coverage misses on the || operands and the if itself. */
      if (
        message.includes("UNIQUE constraint failed: managed_tasks") ||
        message.includes("SQLITE_CONSTRAINT_UNIQUE")
      ) {
        const existing = findManagedTaskByAppCadence(db, appLabel, cadence);
        if (existing) {
          return respondWithAgentError(
            c,
            409,
            [
              composeIssue("managed_tasks.duplicate", {
                field: "(app, cadence)",
                received: { app: existing.app, cadence: existing.cadence },
              }),
            ],
            {
              legacyFields: {
                message: "concurrent registration: row already exists",
                item: existing,
              },
            },
          );
        }
      }
      /* c8 ignore stop */
      logger.error({ err, app: appLabel }, "managed-task POST tx failed");
      return respondWithAgentError(c, 500, [
        composeIssue("managed_tasks.internal_error", {
          field: "tx",
          received: err instanceof Error ? err.message : String(err),
        }),
      ]);
    }

    recordAuditAction(db, "management_task.created", {
      mt_id: inserted.id,
      app: inserted.app,
      app_normalized: normalizeAppLabel(inserted.app),
      cadence: inserted.cadence,
      output_path: inserted.output_path,
      schedule_id: scheduleId,
    });

    if (idempotencyKey) {
      writeRuntimeState(db, idempotencyKeyToRuntimeKey(idempotencyKey), {
        mtId: inserted.id,
        expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
      } satisfies IdempotencyRecord);
    }

    let contextDir: string;
    try {
      contextDir = getContextDir(config, db);
    } catch (err) {
      logger.warn(
        { err, mtId: inserted.id },
        "management.md re-render skipped — getContextDir failed (DB still authoritative)",
      );
      return c.json({ status: "created", item: inserted }, 201);
    }

    const renderResult = await renderManagementMdFromDb(
      contextDir,
      db,
      lockManager,
      "managed-tasks.api.create",
    );

    // §10.1 step 6 — the route returns the full row so the agent's DM
    // text can include `mt_<n>` and the (possibly auto-resolved)
    // output_path. The `render_status` flag is a hint for the test
    // suite + dashboard banner; non-`ok` values do NOT roll back the
    // create.
    /* c8 ignore next 1 — false branch requires concurrent lock contention */
    const renderStatus1 = renderResult.ok ? "ok" : renderResult.reason;
    return c.json(
      {
        status: "created",
        item: inserted,
        render_status: renderStatus1,
      },
      201,
    );
  });

  // ── Modify (§10.2) ──────────────────────────────────────────────────────

  app.patch("/managed-tasks/:id", async (c) => {
    const id = c.req.param("id");
    if (!isValidManagedTaskId(id)) {
      return respondWithAgentError(c, 400, [
        composeIssue("managed_tasks.invalid_id", { field: "id", received: id }),
      ]);
    }
    const parsedBody = await readJsonBody(c, { maxBytes: 32 * 1024 });
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = managedTaskPatchSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("managed_tasks.validation_error", { field: "body", received: parsedBody.body })],
        { legacyFields: { details: parsed.error } },
      );
    }
    const existing = getManagedTask(db, id);
    if (!existing) {
      return respondWithAgentError(c, 404, [
        composeIssue("managed_tasks.not_found", { field: "id", received: id }),
      ]);
    }

    const data = parsed.data;
    let updated: ManagedTask | null = null;
    try {
      updated = db.transaction(() => {
        if (data.recurrenceRule !== undefined) {
          const resolved: RecurrenceRule = {
            ...data.recurrenceRule,
            timezone:
              data.recurrenceRule.timezone ?? config.timezone ?? "UTC",
          };
          updateRecurringSchedule(db, existing.schedule_id, {
            recurrenceRule: resolved,
          });
        }
        return updateManagedTask(db, id, {
          intent: data.intent,
          cadence: data.cadence,
          outputPath:
            data.output_path === undefined ? undefined : data.output_path,
        });
      })();
    } catch (err) {
      logger.error({ err, id }, "managed-task PATCH tx failed");
      return respondWithAgentError(c, 500, [
        composeIssue("managed_tasks.internal_error", {
          field: "tx",
          received: err instanceof Error ? err.message : String(err),
        }),
      ]);
    }

    /* c8 ignore next 1 — updateManagedTask is non-null when the row existed above */
    if (!updated) {
      return respondWithAgentError(c, 404, [
        composeIssue("managed_tasks.not_found", { field: "id", received: id }),
      ]);
    }

    recordAuditAction(db, "management_task.modified", {
      mt_id: id,
      // Top-level `app` / `app_normalized` are required by the activity-
      // view runner — `enumerateActiveSources` filters on
      // `$.app_normalized`, and `buildActivitySnapshot`'s "Recently
      // changed" query selects per-source via the same path. Without
      // them every lifecycle event but `created` is silently dropped
      // from `state/activity/<source>.md`.
      app: existing.app,
      app_normalized: normalizeAppLabel(existing.app),
      changed: Object.keys(data),
      from: {
        intent: existing.intent,
        cadence: existing.cadence,
        output_path: existing.output_path,
      },
      to: {
        intent: updated.intent,
        cadence: updated.cadence,
        output_path: updated.output_path,
      },
    });

    let contextDir: string;
    try {
      contextDir = getContextDir(config, db);
    } catch (err) {
      logger.warn({ err, id }, "management.md re-render skipped (PATCH)");
      return c.json({ status: "updated", item: updated });
    }
    const renderResult = await renderManagementMdFromDb(
      contextDir,
      db,
      lockManager,
      "managed-tasks.api.modify",
    );
    /* c8 ignore next 1 — false branch requires concurrent lock contention */
    const renderStatus2 = renderResult.ok ? "ok" : renderResult.reason;
    return c.json({
      status: "updated",
      item: updated,
      render_status: renderStatus2,
    });
  });

  // ── Internal — run-result mutator (§10.4 step 5) ────────────────────────
  //
  // Separate path from the user-facing PATCH because the schema and
  // risk-tier intent differ: this is the scheduled-managed-task skill
  // posting back the outcome of a fire, not a user editing their
  // commitment.

  app.patch("/managed-tasks/:id/run-result", async (c) => {
    const id = c.req.param("id");
    if (!isValidManagedTaskId(id)) {
      return respondWithAgentError(c, 400, [
        composeIssue("managed_tasks.invalid_id", { field: "id", received: id }),
      ]);
    }
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = managedTaskRunResultSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("managed_tasks.validation_error", { field: "body", received: parsedBody.body })],
        { legacyFields: { details: parsed.error } },
      );
    }
    const updated = updateManagedTaskRunResult(db, id, {
      lastRunAt: parsed.data.last_run_at,
      lastResult: parsed.data.last_result,
      consecutiveFailures: parsed.data.consecutive_failures,
    });
    if (!updated) {
      return respondWithAgentError(c, 404, [
        composeIssue("managed_tasks.not_found", { field: "id", received: id }),
      ]);
    }

    recordAuditAction(db, "management_task.run_recorded", {
      mt_id: id,
      // Top-level `app` / `app_normalized` for the activity-view runner
      // (see comment on `management_task.modified`).
      app: updated.app,
      app_normalized: normalizeAppLabel(updated.app),
      last_run_at: parsed.data.last_run_at,
      last_result: parsed.data.last_result,
      consecutive_failures: parsed.data.consecutive_failures,
    });

    // Re-render so the rendered Last run / Last result columns stay in
    // lock-step with the row. The renderer reads from DB so the agent's
    // very next prompt-injection sees the new state.
    let contextDir: string;
    try {
      contextDir = getContextDir(config, db);
    } catch (err) {
      logger.warn({ err, id }, "management.md re-render skipped (run-result)");
      return c.json({ status: "updated", item: updated });
    }
    const renderResult = await renderManagementMdFromDb(
      contextDir,
      db,
      lockManager,
      "managed-tasks.api.run-result",
    );
    /* c8 ignore next 1 — false branch requires concurrent lock contention */
    const renderStatus3 = renderResult.ok ? "ok" : renderResult.reason;
    return c.json({
      status: "updated",
      item: updated,
      render_status: renderStatus3,
    });
  });

  // ── Stop (§10.3) ────────────────────────────────────────────────────────

  app.delete("/managed-tasks/:id", async (c) => {
    const id = c.req.param("id");
    if (!isValidManagedTaskId(id)) {
      return respondWithAgentError(c, 400, [
        composeIssue("managed_tasks.invalid_id", { field: "id", received: id }),
      ]);
    }
    const existing = getManagedTask(db, id);
    if (!existing) {
      return respondWithAgentError(c, 404, [
        composeIssue("managed_tasks.not_found", { field: "id", received: id }),
      ]);
    }

    try {
      db.transaction(() => {
        // §10.3 step 3a — snapshot the row into the audit detail BEFORE
        // delete so the activity-view reconciler can render a "Recently
        // changed" entry from agent_actions alone. Top-level `app` /
        // `app_normalized` are duplicated out of `original_row` so the
        // activity-view runner's `$.app_normalized` filter (which does
        // not descend into `original_row`) still enumerates the stopped
        // source for the 90-day post-stop window.
        recordAuditAction(db, "management_task.deleted", {
          mt_id: id,
          app: existing.app,
          app_normalized: normalizeAppLabel(existing.app),
          original_row: existing,
          deleted_at: new Date().toISOString(),
        });
        deleteManagedTask(db, id);
        // The FK is `ON DELETE CASCADE` from `recurring_schedules` to
        // `managed_tasks`, but we DELETE managed_tasks first (§10.3),
        // so we explicitly clean up the matching schedule afterwards.
        deleteRecurringSchedule(db, existing.schedule_id);
      })();
    } catch (err) {
      logger.error({ err, id }, "managed-task DELETE tx failed");
      return respondWithAgentError(c, 500, [
        composeIssue("managed_tasks.internal_error", {
          field: "tx",
          received: err instanceof Error ? err.message : String(err),
        }),
      ]);
    }

    let contextDir: string;
    try {
      contextDir = getContextDir(config, db);
    } catch (err) {
      logger.warn({ err, id }, "management.md re-render skipped (DELETE)");
      return c.json({ status: "deleted", id });
    }
    const renderResult = await renderManagementMdFromDb(
      contextDir,
      db,
      lockManager,
      "managed-tasks.api.delete",
    );
    /* c8 ignore next 1 — false branch requires concurrent lock contention */
    const renderStatus4 = renderResult.ok ? "ok" : renderResult.reason;
    return c.json({
      status: "deleted",
      id,
      render_status: renderStatus4,
    });
  });

  // ── On-demand fire (§10.5) ──────────────────────────────────────────────

  app.post("/managed-tasks/:id/run-now", async (c) => {
    const id = c.req.param("id");
    if (!isValidManagedTaskId(id)) {
      return respondWithAgentError(c, 400, [
        composeIssue("managed_tasks.invalid_id", { field: "id", received: id }),
      ]);
    }
    const existing = getManagedTask(db, id);
    if (!existing) {
      return respondWithAgentError(c, 404, [
        composeIssue("managed_tasks.not_found", { field: "id", received: id }),
      ]);
    }

    /* c8 ignore start — readJsonBody always resolves; the .catch() fallback is unreachable */
    const parsedBody = await readJsonBody(c).catch(() => ({
      ok: true as const,
      body: {},
    }));
    /* c8 ignore stop */
    const reason = (() => {
      if (!parsedBody.ok) return "api";
      const body = parsedBody.body;
      if (
        body !== null &&
        typeof body === "object" &&
        typeof (body as Record<string, unknown>).reason === "string"
      ) {
        return ((body as Record<string, unknown>).reason as string).trim() ||
          "api";
      }
      return "api";
    })();

    // Defer execution to the existing scheduler: enqueue an
    // `agent_schedule` row with `scheduled_for=now` and the same
    // task_type/correlation as the recurring-schedules-driven fires.
    // This reuses the dispatcher → scheduled.task path verbatim.
    let scheduledRowId: number;
    try {
      const result = db.transaction(() => {
        const adhocLabel = `[${id}] ad-hoc — ${existing.intent}`;
        const insert = db
          .prepare(
            `INSERT INTO agent_schedule
                (scheduled_for, task_type, task_description, task_prompt, task_context,
                 status, recurring_schedule_id, correlation_id)
              VALUES (datetime('now'), ?, ?, ?, ?, 'pending', ?, ?)`,
          )
          .run(
            RUN_NOW_TASK_TYPE,
            // task_description (label) === task_prompt (agent body); the real
            // task is resolved from task_context.mt_id at fire time.
            adhocLabel,
            adhocLabel,
            JSON.stringify({
              mt_id: id,
              app: existing.app,
              cadence: existing.cadence,
              adhoc: true,
              reason,
              importance: "transient",
            }),
            existing.schedule_id,
            id,
          );
        return Number(insert.lastInsertRowid);
      })();
      scheduledRowId = result;
    } catch (err) {
      logger.error({ err, id }, "managed-task run-now enqueue failed");
      return respondWithAgentError(c, 500, [
        composeIssue("managed_tasks.internal_error", {
          field: "tx",
          received: err instanceof Error ? err.message : String(err),
        }),
      ]);
    }

    recordAuditAction(db, "management_task.run_now", {
      mt_id: id,
      // Top-level `app` / `app_normalized` for the activity-view runner.
      app: existing.app,
      app_normalized: normalizeAppLabel(existing.app),
      scheduled_row_id: scheduledRowId,
      reason,
    });

    return c.json({
      status: "queued",
      mt_id: id,
      scheduled_row_id: scheduledRowId,
    }, 202);
  });

  // ── Rename app (§12 failure modes) ──────────────────────────────────────
  //
  // The plain PATCH does NOT mutate `app` because doing so would
  // silently orphan all entity-file `frontmatter.sources.<key>`
  // references. This dedicated endpoint is the atomic path: it moves
  // the column, emits a `management_task.app_renamed` audit row, then
  // walks every entity file referencing the old key (via the
  // `entity_source_keys` mirror) and rewrites its frontmatter
  // `sources.<oldKey>` to `sources.<newKey>`. Per-file failures are
  // isolated and surfaced in the response so the dashboard can flag
  // them.

  app.post("/managed-tasks/:id/rename-app", async (c) => {
    const id = c.req.param("id");
    if (!isValidManagedTaskId(id)) {
      return respondWithAgentError(c, 400, [
        composeIssue("managed_tasks.invalid_id", { field: "id", received: id }),
      ]);
    }
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body;
    if (
      body === null ||
      typeof body !== "object" ||
      typeof (body as Record<string, unknown>).newApp !== "string"
    ) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("managed_tasks.validation_error", { field: "newApp", received: body })],
        { legacyFields: { message: "body must include `newApp` string" } },
      );
    }
    const newAppRaw = validateAppLabel(
      (body as Record<string, unknown>).newApp as string,
    );
    if (newAppRaw === null) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("managed_tasks.validation_error", { field: "newApp", received: (body as Record<string, unknown>).newApp })],
        { legacyFields: { message: "invalid newApp" } },
      );
    }
    const existing = getManagedTask(db, id);
    if (!existing) {
      return respondWithAgentError(c, 404, [
        composeIssue("managed_tasks.not_found", { field: "id", received: id }),
      ]);
    }
    const oldApp = existing.app;
    const oldNormalized = normalizeAppLabel(oldApp);
    const newNormalized = normalizeAppLabel(newAppRaw);

    if (oldNormalized === newNormalized) {
      return c.json({ status: "noop", item: existing });
    }

    try {
      db.transaction(() => {
        db.prepare(
          `UPDATE managed_tasks
              SET app = ?, app_normalized = ?, updated_at = datetime('now')
            WHERE id = ?`,
        ).run(newAppRaw, newNormalized, id);
      })();
    } catch (err) {
      /* c8 ignore next 1 — err is always a SqliteError; String(err) fallback unreachable */
      const message = err instanceof Error ? err.message : String(err);
      /* c8 ignore start — UNIQUE constraint race: rename collision only when a
       * concurrent request creates the same (app_normalized, cadence) row;
       * not testable single-threaded. */
      if (
        message.includes("UNIQUE constraint failed: managed_tasks") ||
        message.includes("SQLITE_CONSTRAINT_UNIQUE")
      ) {
        return respondWithAgentError(
          c,
          409,
          [
            composeIssue("managed_tasks.duplicate", {
              field: "(app_normalized, cadence)",
              received: { newApp: newAppRaw, cadence: existing.cadence },
            }),
          ],
          {
            legacyFields: {
              message:
                "renaming would collide with an existing (app_normalized, cadence) row",
            },
          },
        );
      }
      /* c8 ignore stop */
      logger.error({ err, id }, "managed-task rename-app tx failed");
      return respondWithAgentError(c, 500, [
        composeIssue("managed_tasks.internal_error", {
          field: "tx",
          received: err instanceof Error ? err.message : String(err),
        }),
      ]);
    }

    recordAuditAction(db, "management_task.app_renamed", {
      mt_id: id,
      // `from`/`to` are the canonical user-facing labels (existing
      // contract — preserved for the dashboard's history card and the
      // managed-tasks integration tests).
      from: oldApp,
      to: newAppRaw,
      // `app` / `app_normalized` follow the post-rename label so the
      // NEW `state/activity/<new>.md` enumerates this event (parity with the
      // other `management_task.*` rows). `old_app` / `old_app_normalized`
      // let the OLD `state/activity/<old>.md` keep showing the rename for
      // its 90-day retention window — the activity-view runner reads
      // both via the SQL OR clause in `enumerateActiveSources` /
      // `buildActivitySnapshot`.
      app: newAppRaw,
      app_normalized: newNormalized,
      old_app: oldApp,
      old_app_normalized: oldNormalized,
      schedule_id: existing.schedule_id,
    });

    let contextDir: string | null = null;
    try {
      contextDir = getContextDir(config, db);
    } catch (err) {
      logger.warn(
        { err, id },
        "rename-app: getContextDir failed — skipping entity rewrite + management.md re-render",
      );
    }

    // §12 entity-file rewrite. Best-effort, post-DB-commit: a failure
    // here does NOT roll back the rename — the DB is already canonical
    // and the old key may live on in entity files until the next pass.
    // The follow-up audit row makes this visible to the dashboard.
    let rewrite: Awaited<ReturnType<typeof rewriteEntityFilesForSourceRename>> = {
      rewrote: [],
      skippedNewKeyExists: [],
      skippedMultipleVariants: [],
      skippedOldKeyMissing: [],
      errors: [],
    };
    if (contextDir) {
      try {
        rewrite = await rewriteEntityFilesForSourceRename({
          db,
          contextDir,
          oldKey: oldApp,
          newKey: newAppRaw,
          writeTracker,
        });
      } catch (err) {
        logger.warn(
          { err, id, oldApp, newAppRaw },
          "rename-app: entity-file rewrite failed",
        );
      }
      if (
        rewrite.rewrote.length > 0 ||
        rewrite.skippedNewKeyExists.length > 0 ||
        rewrite.skippedMultipleVariants.length > 0 ||
        rewrite.errors.length > 0
      ) {
        recordAuditAction(
          db,
          "management_task.app_renamed.entity_rewrite",
          {
            mt_id: id,
            app: newAppRaw,
            app_normalized: newNormalized,
            old_app: oldApp,
            old_app_normalized: oldNormalized,
            rewrote: rewrite.rewrote,
            skipped_new_key_exists: rewrite.skippedNewKeyExists,
            skipped_multiple_variants: rewrite.skippedMultipleVariants,
            skipped_old_key_missing: rewrite.skippedOldKeyMissing,
            errors: rewrite.errors,
          },
          rewrite.errors.length > 0 ? "failed" : "success",
        );
      }
    }

    if (!contextDir) {
      const updated = getManagedTask(db, id);
      return c.json({ status: "renamed", item: updated, rewrite });
    }
    const renderResult = await renderManagementMdFromDb(
      contextDir,
      db,
      lockManager,
      "managed-tasks.api.rename-app",
    );
    const updated = getManagedTask(db, id);
    /* c8 ignore next 1 — false branch requires concurrent write-lock contention */
    const renderStatus = renderResult.ok ? "ok" : renderResult.reason;
    return c.json({
      status: "renamed",
      item: updated,
      rewrite,
      render_status: renderStatus,
    });
  });

  return app;
}

/**
 * Build a {@link ManagedTasksRoutesDeps} from `ApiDependencies`. Used
 * by the server wiring; lazily creates the lock manager when one was
 * not threaded in (test-only path — production wires the singleton at
 * startup so concurrent routes share state).
 */
export function buildManagedTasksRoutesDepsFromApi(
  deps: ApiDependencies,
  fallbackLockManager?: ManagementMdWriteLockManager,
): ManagedTasksRoutesDeps {
  return {
    db: deps.db,
    config: deps.config,
    lockManager:
      deps.managementMdWriteLockManager ??
      fallbackLockManager ??
      new InMemoryManagementMdWriteLockManager(),
    writeTracker: deps.writeTracker,
  };
}

/**
 * Re-export for the server wiring. The boot path (index.ts) calls
 * {@link bootstrapManagementRegistry} after this module's routes are
 * mounted, so the file converges to the fresh DB state on first run.
 */
export { bootstrapManagementRegistry };

function clampQueryLimit(
  raw: string | undefined,
  defaultValue: number,
  max: number,
): number | null {
  if (raw === undefined) return defaultValue;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, max);
}

/**
 * Parse the `before_id` cursor query param. `undefined` returns `null`
 * (no cursor); a malformed value returns `"invalid"` so the route can
 * surface a 400 instead of silently treating garbage as "no cursor".
 */
function parseBeforeIdCursor(
  raw: string | undefined,
): number | null | "invalid" {
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return "invalid";
  return n;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
