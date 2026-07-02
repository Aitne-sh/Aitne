import type Database from "better-sqlite3";
import { formatSqliteDatetime } from "@aitne/shared";
import type { RecurrenceRule } from "@aitne/shared";
import { computeNextOccurrence, formatRecurrenceLabel } from "../core/recurrence.js";

// ── Row types ────────────────────────────────────────────────────────

export interface RecurringScheduleRow {
  id: number;
  task_type: string;
  task_description: string | null;
  /** Optional override for the agent task body. NULL = use task_description. */
  task_prompt: string | null;
  task_context: string;
  /** NULL when the operator has not pinned a model; a concrete
   *  'sonnet' / 'opus' is the explicit escape hatch (PATCH `model`).
   *  See schema.ts comment on `recurring_schedules.model`. */
  model: string | null;
  /** NULL when the operator has not pinned a tier; concrete
   *  'lite' / 'medium' / 'high' overrides the dispatcher's process-key
   *  default at execution time. Propagated through to every generated
   *  agent_schedule row by `generateNextScheduleRow`. */
  tier_override: string | null;
  /** SCHEDULE_API_REDESIGN_PLAN §4.3a — snapshot of the operator's
   *  backend pin at write time. Companions `model` so a registered
   *  full model id resolves to a (backend, model) tuple at dispatch.
   *  NULL when no model pin (alias rows, pure-tier rows, legacy rows). */
  backend_id: string | null;
  recurrence_rule: string;
  enabled: number;
  last_scheduled_id: number | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecurringScheduleDTO {
  id: number;
  taskType: string;
  description: string;
  /** null = no prompt override; description doubles as the agent body. */
  prompt: string | null;
  recurrenceRule: RecurrenceRule;
  /** Mirrors `RecurringScheduleRow.model` — null when no override. */
  model: string | null;
  /** Mirrors `RecurringScheduleRow.tier_override` — null when no override. */
  tier: string | null;
  /** Mirrors `RecurringScheduleRow.backend_id` — null when no model pin. */
  backendId: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  recurrenceLabel: string;
  taskContext: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

function rowToDTO(row: RecurringScheduleRow): RecurringScheduleDTO {
  const rule = JSON.parse(row.recurrence_rule) as RecurrenceRule;
  return {
    id: row.id,
    taskType: row.task_type,
    description: row.task_description ?? "",
    prompt: row.task_prompt,
    recurrenceRule: rule,
    model: row.model,
    tier: row.tier_override,
    backendId: row.backend_id,
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    recurrenceLabel: formatRecurrenceLabel(rule),
    taskContext: JSON.parse(row.task_context || "{}"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────

/**
 * Task types that MUST NOT become recurring rows.
 * `reconcileRecurringSchedules` copies the parent row's `task_context`
 * verbatim into every generated `agent_schedule` occurrence, so a recurring
 * `browser_task` reuses a single fixed `preGeneratedTaskId` on each fire —
 * the dispatcher's `getBrowserTask` dedup then hits `row_already_exists` and
 * silently no-ops every occurrence after the first, so the recurring browser
 * task only ever runs once. Recurring browser tasks are explicitly out of
 * scope per BROWSER_TASK_REDESIGN_PLAN.md (one-shot scheduleAt path only);
 * close the hole here rather than enable an undesigned feature.
 *
 * Note: `dm` / `dm_session` are intentionally NOT listed — the scheduler
 * dispatches them per-occurrence with no preGeneratedTaskId dedup
 * (`handleDirectDm` / a fresh `scheduled.dm` event), so recurring DMs /
 * briefings are a supported, designed feature.
 */
const NON_RECURRING_ELIGIBLE_TASK_TYPES = new Set([
  "browser_task",
]);

export function createRecurringSchedule(
  db: Database.Database,
  params: {
    taskType: string;
    description: string;
    /** Optional override for the agent task body. */
    prompt?: string;
    recurrenceRule: RecurrenceRule;
    model?: string;
    /** Abstract tier override — 'lite' | 'medium' | 'high'. Schema CHECK
     *  enforces the enum at write time. */
    tier?: string;
    /** SCHEDULE_API_REDESIGN_PLAN §4.3a — captured backend pin that
     *  companions `model`. The route's `validateModelToken` resolves a
     *  registered model id to (backendId, modelId) and passes both in.
     *  Schema CHECK enforces the BackendId enum at write time. */
    backendId?: string;
    taskContext?: Record<string, unknown>;
    /** Initial enabled state. Defaults to `true` (existing callers' behaviour).
     *  The Agent loader passes the §6.4-resolved value so a disabled Agent's
     *  recurring row is created disabled (and fires nothing). */
    enabled?: boolean;
  },
): RecurringScheduleDTO {
  // Reject task types that can't safely recur (browser_task) as recurring
  // task types. See NON_RECURRING_ELIGIBLE_TASK_TYPES — copying such a row's
  // task_context into every occurrence reuses a single fixed
  // preGeneratedTaskId, so only the first fire ever runs.
  if (NON_RECURRING_ELIGIBLE_TASK_TYPES.has(params.taskType)) {
    throw new Error(
      `task_type '${params.taskType}' is not supported for recurring schedules`,
    );
  }

  const rule = params.recurrenceRule;
  const nextOccurrence = computeNextOccurrence(rule, new Date());
  const nextRunAt = nextOccurrence ? formatSqliteDatetime(nextOccurrence) : null;

  // No `?? "sonnet"` fallback. An omitted `model` MUST persist as NULL so
  // the scheduler doesn't synthesise a `requestedModel` that would later
  // override `process_backend_config` for the resolved ProcessKey
  // (`agent.task`, `agent.dm_task`, etc.). A concrete value is reserved
  // for explicit operator pins via the API.
  const persistedModel = params.model ?? null;
  const persistedTier = params.tier ?? null;
  const persistedBackendId = params.backendId ?? null;
  const persistedPrompt = params.prompt ?? null;
  // Default to enabled so every existing caller (the /api/recurring-schedules
  // route, scheduled-DM, repository runs) is unchanged; the Agent loader passes
  // an explicit §6.4-resolved value so a disabled Agent's row is created off.
  const persistedEnabled = params.enabled ?? true;

  const result = db.prepare(`
    INSERT INTO recurring_schedules
      (task_type, task_description, task_prompt, task_context, model, tier_override, backend_id, recurrence_rule, enabled, next_run_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.taskType,
    params.description,
    persistedPrompt,
    JSON.stringify(params.taskContext ?? {}),
    persistedModel,
    persistedTier,
    persistedBackendId,
    JSON.stringify(rule),
    persistedEnabled ? 1 : 0,
    nextRunAt,
  );

  const row = db.prepare(
    "SELECT * FROM recurring_schedules WHERE id = ?",
  ).get(result.lastInsertRowid) as RecurringScheduleRow;

  // Generate the first agent_schedule row. Skip when the row is created
  // disabled — the reconciler gates materialisation on `enabled = 1`, so a
  // disabled row must not eagerly fire once before its first reconcile pass.
  if (nextOccurrence && persistedEnabled) {
    generateNextScheduleRow(
      db,
      row.id,
      params.taskType,
      rule,
      params.description,
      persistedPrompt,
      params.taskContext ?? {},
      persistedModel,
      persistedTier,
      persistedBackendId,
      nextOccurrence,
    );
  }

  // Re-read to get updated last_scheduled_id
  const updated = db.prepare(
    "SELECT * FROM recurring_schedules WHERE id = ?",
  ).get(row.id) as RecurringScheduleRow;

  return rowToDTO(updated);
}

export function listRecurringSchedules(
  db: Database.Database,
  options?: { enabledOnly?: boolean },
): RecurringScheduleDTO[] {
  const enabledOnly = options?.enabledOnly ?? false;
  const query = enabledOnly
    ? "SELECT * FROM recurring_schedules WHERE enabled = 1 ORDER BY created_at ASC"
    : "SELECT * FROM recurring_schedules ORDER BY created_at ASC";

  const rows = db.prepare(query).all() as RecurringScheduleRow[];
  return rows.map(rowToDTO);
}

export function getRecurringSchedule(
  db: Database.Database,
  id: number,
): RecurringScheduleDTO | null {
  const row = db.prepare(
    "SELECT * FROM recurring_schedules WHERE id = ?",
  ).get(id) as RecurringScheduleRow | undefined;

  return row ? rowToDTO(row) : null;
}

export function updateRecurringSchedule(
  db: Database.Database,
  id: number,
  params: {
    description?: string;
    /** `string` sets an override; `null` clears it; `undefined` = no change. */
    prompt?: string | null;
    recurrenceRule?: RecurrenceRule;
    /** `string` sets the model token; `null` clears it; `undefined` = no
     *  change. Pair with `backendId` when setting a registered model id;
     *  legacy aliases ('sonnet' / 'opus') should rewrite to `tier`
     *  upstream and pass `model: null, backendId: null` here. */
    model?: string | null;
    /** `string` sets the backend pin; `null` clears it; `undefined` = no
     *  change. See `model` — these two fields move together. */
    backendId?: string | null;
    /** `string` sets an override; `null` clears it; `undefined` = no change. */
    tier?: string | null;
    taskContext?: Record<string, unknown>;
    enabled?: boolean;
  },
  /**
   * AGENT_DEFINITIONS_DESIGN.md §11.3.2 — when an Agent-owned rule edit
   * supersedes a pending materialisation, the loader's recurring-schedule
   * adapter passes `"agent_definition_changed"` so the cancelled row records
   * `task_context.skipReason`. Dashboard / API edits omit it (no tag).
   */
  cancelReason?: string,
): RecurringScheduleDTO | null {
  const existing = db.prepare(
    "SELECT * FROM recurring_schedules WHERE id = ?",
  ).get(id) as RecurringScheduleRow | undefined;

  if (!existing) return null;

  const updates: string[] = [];
  const values: unknown[] = [];

  if (params.description !== undefined) {
    updates.push("task_description = ?");
    values.push(params.description);
  }

  if (params.prompt !== undefined) {
    updates.push("task_prompt = ?");
    values.push(params.prompt);
  }

  if (params.recurrenceRule !== undefined) {
    updates.push("recurrence_rule = ?");
    values.push(JSON.stringify(params.recurrenceRule));
  }

  if (params.model !== undefined) {
    updates.push("model = ?");
    values.push(params.model);
  }

  // SCHEDULE_API_REDESIGN_PLAN §4.3a — `backendId: null` is the explicit
  // clear; `backendId: <BackendId>` sets the pin; `undefined` leaves the
  // column untouched. The route's validator pairs this with `model`
  // every time a registered model id resolves; pure-tier and alias
  // paths leave both NULL.
  if (params.backendId !== undefined) {
    updates.push("backend_id = ?");
    values.push(params.backendId);
  }

  // `tier: null` is the explicit clear; `tier: <enum>` sets the
  // override; `undefined` leaves the column untouched.
  if (params.tier !== undefined) {
    updates.push("tier_override = ?");
    values.push(params.tier);
  }

  if (params.taskContext !== undefined) {
    updates.push("task_context = ?");
    values.push(JSON.stringify(params.taskContext));
  }

  if (params.enabled !== undefined) {
    updates.push("enabled = ?");
    values.push(params.enabled ? 1 : 0);
  }

  if (updates.length === 0) return rowToDTO(existing);

  updates.push("updated_at = CURRENT_TIMESTAMP");
  values.push(id);

  db.prepare(
    `UPDATE recurring_schedules SET ${updates.join(", ")} WHERE id = ?`,
  ).run(...values);

  // A prompt/description edit must also reach any already-materialised
  // pending agent_schedule row — the dispatcher reads the row's task_prompt
  // directly, so without this the next fire runs the OLD text even though the
  // recurring rule was updated. Unlike recurrence/enabled (below) the edit
  // does NOT cancel + re-materialise (that recomputes next_run_at
  // strictly-after-now and can drop an imminent fire); the text is patched in
  // place instead: same scheduled_for, same claim window, fresh task text.
  // Mirrors the generateNextScheduleRow contract (task_prompt falls back to
  // the description). `running` rows keep the text they launched with.
  if (
    (params.prompt !== undefined || params.description !== undefined)
    && params.recurrenceRule === undefined
    && params.enabled === undefined
  ) {
    const row = db.prepare(
      "SELECT task_description, task_prompt FROM recurring_schedules WHERE id = ?",
    ).get(id) as { task_description: string | null; task_prompt: string | null };
    db.prepare(
      `UPDATE agent_schedule
          SET task_description = ?, task_prompt = ?
        WHERE recurring_schedule_id = ? AND status = 'pending'`,
    ).run(
      row.task_description ?? "",
      row.task_prompt ?? row.task_description ?? "",
      id,
    );
  }

  // If recurrence rule changed or re-enabled, recompute next_run_at
  // and cancel the old pending agent_schedule row. AGENT_DEFINITIONS_DESIGN.md
  // §11.3.2: a pending materialisation derived from the *old* rule is
  // superseded; cancelling it (status='skipped') + recomputing next_run_at is
  // the re-materialisation. `running` rows are deliberately left alone (the
  // WHERE clause filters to `pending` only). `cancelReason`, when supplied by
  // an Agent-driven edit, tags the skipped row's `task_context.skipReason` so
  // the cause is attributable.
  if (params.recurrenceRule !== undefined || params.enabled !== undefined) {
    const row = db.prepare(
      "SELECT * FROM recurring_schedules WHERE id = ?",
    ).get(id) as RecurringScheduleRow;

    if (row.enabled) {
      cancelPendingScheduleRows(db, id, cancelReason);

      const rule = JSON.parse(row.recurrence_rule) as RecurrenceRule;
      const nextOccurrence = computeNextOccurrence(rule, new Date());
      const nextRunAt = nextOccurrence ? formatSqliteDatetime(nextOccurrence) : null;

      db.prepare(
        "UPDATE recurring_schedules SET next_run_at = ? WHERE id = ?",
      ).run(nextRunAt, id);

      if (nextOccurrence) {
        generateNextScheduleRow(
          db,
          id,
          row.task_type,
          rule,
          row.task_description ?? "",
          row.task_prompt,
          JSON.parse(row.task_context || "{}"),
          row.model,
          row.tier_override,
          row.backend_id,
          nextOccurrence,
        );
      }
    } else {
      // Disabled — cancel pending rows and clear next_run_at
      cancelPendingScheduleRows(db, id, cancelReason);
      db.prepare(
        "UPDATE recurring_schedules SET next_run_at = NULL WHERE id = ?",
      ).run(id);
    }
  }

  const updated = db.prepare(
    "SELECT * FROM recurring_schedules WHERE id = ?",
  ).get(id) as RecurringScheduleRow;

  return rowToDTO(updated);
}

export function deleteRecurringSchedule(
  db: Database.Database,
  id: number,
): boolean {
  const existing = db.prepare(
    "SELECT id FROM recurring_schedules WHERE id = ?",
  ).get(id) as { id: number } | undefined;

  if (!existing) return false;

  // Cancel any pending agent_schedule rows
  db.prepare(
    "UPDATE agent_schedule SET status = 'skipped' WHERE recurring_schedule_id = ? AND status = 'pending'",
  ).run(id);

  // Clear the FK on agent_schedule rows so the parent can be deleted
  db.prepare(
    "UPDATE agent_schedule SET recurring_schedule_id = NULL WHERE recurring_schedule_id = ?",
  ).run(id);

  db.prepare("DELETE FROM recurring_schedules WHERE id = ?").run(id);
  return true;
}

// ── Reconciliation ───────────────────────────────────────────────────

/**
 * Cancel every still-`pending` agent_schedule row backing a recurring
 * schedule (status → `skipped`). When `reason` is supplied it is recorded on
 * each cancelled row's `task_context.skipReason` (AGENT_DEFINITIONS_DESIGN.md
 * §11.3.2 — attributes an Agent-definition-driven re-materialisation).
 * `running` rows are never touched (the WHERE filters to `pending`).
 */
function cancelPendingScheduleRows(
  db: Database.Database,
  recurringId: number,
  reason?: string,
): void {
  if (reason) {
    db.prepare(
      `UPDATE agent_schedule
          SET status = 'skipped',
              task_context = json_set(COALESCE(task_context, '{}'), '$.skipReason', ?)
        WHERE recurring_schedule_id = ? AND status = 'pending'`,
    ).run(reason, recurringId);
    return;
  }
  db.prepare(
    "UPDATE agent_schedule SET status = 'skipped' WHERE recurring_schedule_id = ? AND status = 'pending'",
  ).run(recurringId);
}

/**
 * Generate a single agent_schedule row for a recurring schedule.
 */
function generateNextScheduleRow(
  db: Database.Database,
  recurringId: number,
  taskType: string,
  rule: RecurrenceRule,
  description: string,
  prompt: string | null,
  taskContext: Record<string, unknown>,
  model: string | null,
  tier: string | null,
  backendId: string | null,
  nextOccurrence: Date,
): void {
  const scheduledFor = formatSqliteDatetime(nextOccurrence);

  // AGENT_DEFINITIONS_DESIGN.md §7.2 — stamp the owning Agent's slug into the
  // materialised row's `task_context` so the dispatcher's agent_id resolution
  // (§8.1 step 1) attributes the execution without a join. Built-in routines
  // own no recurring row, so this is the user-Agent path only; a recurring row
  // with no paired Agent (a raw `/api/recurring-schedules` row) leaves the key
  // unset. The `agents` table is always present (created by `applySchema`).
  const owner = db
    .prepare<[number], { id: string }>(
      "SELECT id FROM agents WHERE recurring_schedule_id = ? LIMIT 1",
    )
    .get(recurringId);

  // Recurring materialization is an internal tick — the parent
  // `recurring_schedules` row already represents the user-facing
  // commitment, so mark each generated agent_schedule as `low` to keep
  // it out of roadmap's `Scheduled:` entries (the recurring cadence
  // itself is visible via `routine.roadmap_refresh` reading recurring
  // schedules separately, not via this mechanical materialization).
  const context: Record<string, unknown> = {
    ...taskContext,
    recurringScheduleId: recurringId,
    importance: "low",
  };
  if (owner) context.agent_id = owner.id;

  const result = db.prepare(`
    INSERT INTO agent_schedule
      (scheduled_for, task_type, task_description, task_prompt, task_context, model, tier_override, backend_id, status, recurring_schedule_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    scheduledFor,
    taskType,
    description,
    // The dispatcher reads task_prompt directly (no description fallback), so
    // materialized rows must always carry it: use the rule's prompt override
    // when set, else fall back to its description body.
    prompt ?? description,
    JSON.stringify(context),
    model,
    tier,
    backendId,
    recurringId,
  );

  db.prepare(
    "UPDATE recurring_schedules SET last_scheduled_id = ? WHERE id = ?",
  ).run(result.lastInsertRowid, recurringId);
}

/**
 * Reconciliation: for each enabled recurring schedule with no pending/running
 * agent_schedule row, compute the next future occurrence and insert a new row.
 *
 * Called at the top of each ScheduleWatcher poll loop. Self-healing: covers
 * normal completion, failed tasks, stale-discarded rows, and daemon downtime.
 *
 * @returns Number of new agent_schedule rows generated.
 */
export function reconcileRecurringSchedules(
  db: Database.Database,
): number {
  // Guard: table may not exist when a test hand-crafts a partial schema
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='recurring_schedules'",
  ).get();
  if (!tableExists) return 0;

  // Find enabled recurring schedules with no active (pending/running) agent_schedule row
  const orphaned = db.prepare(`
    SELECT rs.*
    FROM recurring_schedules rs
    WHERE rs.enabled = 1
      AND NOT EXISTS (
        SELECT 1 FROM agent_schedule a
        WHERE a.recurring_schedule_id = rs.id
          AND a.status IN ('pending', 'running')
      )
  `).all() as RecurringScheduleRow[];

  let generated = 0;

  for (const row of orphaned) {
    // Per-row try/catch: a single malformed `recurrence_rule` or
    // `task_context` JSON otherwise aborts the whole reconcile tick and
    // every subsequent tick repeats the crash, blocking all healthy
    // recurring schedules behind one bad row.
    try {
      const rule = JSON.parse(row.recurrence_rule) as RecurrenceRule;
      // Always use now as reference: computeNextOccurrence returns the next
      // occurrence strictly after the reference, so missed runs are skipped
      // and we always schedule a future time.
      const nextOccurrence = computeNextOccurrence(rule, new Date());
      if (!nextOccurrence) continue;

      const nextRunAt = formatSqliteDatetime(nextOccurrence);
      db.prepare(
        "UPDATE recurring_schedules SET next_run_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      ).run(nextRunAt, row.id);

      generateNextScheduleRow(
        db,
        row.id,
        row.task_type,
        rule,
        row.task_description ?? "",
        row.task_prompt,
        JSON.parse(row.task_context || "{}"),
        row.model,
        row.tier_override,
        row.backend_id,
        nextOccurrence,
      );

      generated++;
    } catch (rowErr) {
      // Disable the offending row so the watcher stops re-attempting it
      // on every poll, but keep going so the remaining orphans reconcile.
      try {
        db.prepare(
          "UPDATE recurring_schedules SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        ).run(row.id);
      } catch {
        // Ignore secondary failure — primary already logged below.
      }
      // Surface via console.error since this module has no shared logger.
      // Caller (scheduler.ts) wraps the whole reconcile in its own
      // try/catch, but we still want the offending row id surfaced.
      console.error(
        "[recurring-schedules] reconcile row failed; row disabled:",
        { id: row.id, err: rowErr instanceof Error ? rowErr.message : String(rowErr) },
      );
    }
  }

  return generated;
}
