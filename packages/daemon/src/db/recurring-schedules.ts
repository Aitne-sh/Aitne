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
  },
): RecurringScheduleDTO {
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

  const result = db.prepare(`
    INSERT INTO recurring_schedules
      (task_type, task_description, task_prompt, task_context, model, tier_override, backend_id, recurrence_rule, enabled, next_run_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    params.taskType,
    params.description,
    persistedPrompt,
    JSON.stringify(params.taskContext ?? {}),
    persistedModel,
    persistedTier,
    persistedBackendId,
    JSON.stringify(rule),
    nextRunAt,
  );

  const row = db.prepare(
    "SELECT * FROM recurring_schedules WHERE id = ?",
  ).get(result.lastInsertRowid) as RecurringScheduleRow;

  // Generate the first agent_schedule row
  if (nextOccurrence) {
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

  // If recurrence rule changed or re-enabled, recompute next_run_at
  // and cancel the old pending agent_schedule row
  if (params.recurrenceRule !== undefined || params.enabled !== undefined) {
    const row = db.prepare(
      "SELECT * FROM recurring_schedules WHERE id = ?",
    ).get(id) as RecurringScheduleRow;

    if (row.enabled) {
      // Cancel any existing pending row for this recurring schedule
      db.prepare(
        "UPDATE agent_schedule SET status = 'skipped' WHERE recurring_schedule_id = ? AND status = 'pending'",
      ).run(id);

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
      db.prepare(
        "UPDATE agent_schedule SET status = 'skipped' WHERE recurring_schedule_id = ? AND status = 'pending'",
      ).run(id);
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

  // Recurring materialization is an internal tick — the parent
  // `recurring_schedules` row already represents the user-facing
  // commitment, so mark each generated agent_schedule as `low` to keep
  // it out of roadmap's `Scheduled:` entries (the recurring cadence
  // itself is visible via `routine.roadmap_refresh` reading recurring
  // schedules separately, not via this mechanical materialization).
  const result = db.prepare(`
    INSERT INTO agent_schedule
      (scheduled_for, task_type, task_description, task_prompt, task_context, model, tier_override, backend_id, status, recurring_schedule_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    scheduledFor,
    taskType,
    description,
    prompt,
    JSON.stringify({
      ...taskContext,
      recurringScheduleId: recurringId,
      importance: "low",
    }),
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
