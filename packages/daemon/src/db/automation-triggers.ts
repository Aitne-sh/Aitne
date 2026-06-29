import type Database from "better-sqlite3";
import type { RecurrenceRule } from "@aitne/shared";
import {
  createRecurringSchedule,
  updateRecurringSchedule,
  deleteRecurringSchedule,
  getRecurringSchedule,
} from "./recurring-schedules.js";

/**
 * Cron-driven automation triggers (the legacy "domain triggers" in
 * `docs/design/19-dashboard-ia-and-triggers.md`). One row per
 * (domain, event_type, recurring_schedule) and the dispatcher fires
 * the configured prompt on schedule.
 *
 * Not to be confused with `repository_triggers` in
 * `db/repositories-store.ts` — that table is per-repository,
 * **event-driven** (`git.push.detected`, `github.workflow_run.failed`,
 * etc.) and dispatches `(backend, model, workdirMode)` as configured
 * by the user in `my life > git`. The two trigger families coexist:
 *
 *   - automation_triggers   — cron-fired,  domain-keyed,  shared prompt
 *   - repository_triggers   — event-fired, repo-keyed,    per-repo action
 *
 * See `docs/design/appendices/unified-repositories.md` §4.4 for the
 * repository_triggers contract.
 */

// ── Types ────────────────────────────────────────────────────────────

export type TriggerDomain = "git";
export type TriggerEventType = "cron.daily" | "cron.weekly";

export interface AutomationTriggerRow {
  id: number;
  domain: string;
  event_type: string;
  prompt: string;
  recurring_schedule_id: number | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface AutomationTriggerDTO {
  id: number;
  domain: TriggerDomain;
  eventType: TriggerEventType;
  prompt: string;
  enabled: boolean;
  recurringScheduleId: number | null;
  /** Recurrence detail (frequency/time/days) when this is a cron trigger. */
  recurrence: RecurrenceRule | null;
  /** Next scheduled fire time (UTC ISO from agent_schedule), if any. */
  nextRunAt: string | null;
  /** Most-recent agent_actions row id for this trigger, if any. */
  lastRunActionId: number | null;
  lastRunStartedAt: string | null;
  lastRunResult: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

function rowToDTO(
  db: Database.Database,
  row: AutomationTriggerRow,
): AutomationTriggerDTO {
  let recurrence: RecurrenceRule | null = null;
  let nextRunAt: string | null = null;
  if (row.recurring_schedule_id !== null) {
    const sched = getRecurringSchedule(db, row.recurring_schedule_id);
    if (sched) {
      recurrence = sched.recurrenceRule;
      nextRunAt = sched.nextRunAt;
    }
  }

  // Look up the most recent action this trigger drove. The dispatcher
  // populates source_kind='trigger', source_ref=trigger.id once the
  // wiring lands; until then this gracefully returns null.
  const lastAction = db
    .prepare<[string], { id: number; started_at: string; result: string | null }>(
      `SELECT id, started_at, result
         FROM agent_actions
        WHERE source_kind = 'trigger' AND source_ref = ?
        ORDER BY started_at DESC
        LIMIT 1`,
    )
    .get(String(row.id));

  return {
    id: row.id,
    domain: row.domain as TriggerDomain,
    eventType: row.event_type as TriggerEventType,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    recurringScheduleId: row.recurring_schedule_id,
    recurrence,
    nextRunAt,
    lastRunActionId: lastAction?.id ?? null,
    lastRunStartedAt: lastAction?.started_at ?? null,
    lastRunResult: lastAction?.result ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildRecurrenceFromEvent(
  eventType: TriggerEventType,
  time: string,
  daysOfWeek: number[] | undefined,
  configTimezone: string,
): RecurrenceRule {
  if (eventType === "cron.daily") {
    return { frequency: "daily", time, timezone: configTimezone };
  }
  // cron.weekly — daysOfWeek is required. The Zod boundary already enforces
  // non-empty arrays on create; on update the caller must explicitly carry
  // the existing value forward when only `time` changes (otherwise we'd
  // silently collapse to a single day). Treat a missing value as a bug.
  if (daysOfWeek === undefined || daysOfWeek.length === 0) {
    throw new Error(
      "buildRecurrenceFromEvent: daysOfWeek is required for cron.weekly",
    );
  }
  return {
    frequency: "weekly",
    time,
    timezone: configTimezone,
    daysOfWeek,
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────

export interface CreateTriggerParams {
  domain: TriggerDomain;
  eventType: TriggerEventType;
  prompt: string;
  /** HH:MM (local). Required for cron.* events. */
  time: string;
  /** 0=Sun..6=Sat. Required for cron.weekly. */
  daysOfWeek?: number[];
  configTimezone: string;
}

export function createTrigger(
  db: Database.Database,
  params: CreateTriggerParams,
): AutomationTriggerDTO {
  const recurrence = buildRecurrenceFromEvent(
    params.eventType,
    params.time,
    params.daysOfWeek,
    params.configTimezone,
  );

  // Order matters: we insert the automation_triggers row first so the
  // triggerId is known before createRecurringSchedule materializes the
  // first agent_schedule row. Otherwise the first firing of every new
  // trigger would carry a task_context without triggerId, and the
  // dispatcher (Phase 2.5) would write source_ref=NULL on the
  // resulting agent_actions row.
  const txn = db.transaction((): number => {
    const insert = db
      .prepare(
        `INSERT INTO automation_triggers
           (domain, event_type, prompt, recurring_schedule_id, enabled)
         VALUES (?, ?, ?, NULL, 1)`,
      )
      .run(params.domain, params.eventType, params.prompt);
    const triggerId = Number(insert.lastInsertRowid);

    const sched = createRecurringSchedule(db, {
      taskType: "agent.task",
      description: params.prompt,
      recurrenceRule: recurrence,
      taskContext: {
        triggerSource: "automation_trigger",
        triggerDomain: params.domain,
        triggerEventType: params.eventType,
        triggerId,
      },
    });

    db.prepare(
      "UPDATE automation_triggers SET recurring_schedule_id = ? WHERE id = ?",
    ).run(sched.id, triggerId);

    return triggerId;
  });
  const triggerId = txn();

  const row = db
    .prepare("SELECT * FROM automation_triggers WHERE id = ?")
    .get(triggerId) as AutomationTriggerRow;
  return rowToDTO(db, row);
}

export function listTriggers(
  db: Database.Database,
  options?: { domain?: TriggerDomain },
): AutomationTriggerDTO[] {
  const rows = options?.domain
    ? (db
        .prepare(
          "SELECT * FROM automation_triggers WHERE domain = ? ORDER BY created_at ASC",
        )
        .all(options.domain) as AutomationTriggerRow[])
    : (db
        .prepare("SELECT * FROM automation_triggers ORDER BY created_at ASC")
        .all() as AutomationTriggerRow[]);
  return rows.map((row) => rowToDTO(db, row));
}

export function getTrigger(
  db: Database.Database,
  id: number,
): AutomationTriggerDTO | null {
  const row = db
    .prepare("SELECT * FROM automation_triggers WHERE id = ?")
    .get(id) as AutomationTriggerRow | undefined;
  if (!row) return null;
  return rowToDTO(db, row);
}

export interface UpdateTriggerParams {
  prompt?: string;
  enabled?: boolean;
  /** Only meaningful for cron triggers; ignored otherwise. */
  time?: string;
  daysOfWeek?: number[];
  configTimezone: string;
}

export function updateTrigger(
  db: Database.Database,
  id: number,
  params: UpdateTriggerParams,
): AutomationTriggerDTO | null {
  const existing = db
    .prepare("SELECT * FROM automation_triggers WHERE id = ?")
    .get(id) as AutomationTriggerRow | undefined;
  if (!existing) return null;

  const setClauses: string[] = [];
  const args: unknown[] = [];
  if (params.prompt !== undefined) {
    setClauses.push("prompt = ?");
    args.push(params.prompt);
  }
  if (params.enabled !== undefined) {
    setClauses.push("enabled = ?");
    args.push(params.enabled ? 1 : 0);
  }
  if (setClauses.length > 0) {
    setClauses.push("updated_at = CURRENT_TIMESTAMP");
    args.push(id);
    db.prepare(
      `UPDATE automation_triggers SET ${setClauses.join(", ")} WHERE id = ?`,
    ).run(...args);
  }

  // Sync the paired recurring_schedule for cron triggers when prompt,
  // schedule shape, or enabled flag changes. The schedule's description
  // is the LLM prompt at firing time, so prompt edits must propagate.
  if (existing.recurring_schedule_id !== null) {
    const existingSched = getRecurringSchedule(db, existing.recurring_schedule_id);

    const recurrenceUpdate =
      params.time !== undefined || params.daysOfWeek !== undefined
        ? buildRecurrenceFromEvent(
            existing.event_type as TriggerEventType,
            params.time ?? existingSched?.recurrenceRule.time ?? "09:00",
            // Preserve the existing daysOfWeek on time-only edits.
            // Without this, a weekly trigger silently collapses to a
            // single Monday on PATCH {time} — the wizard always sends
            // both fields today, but direct API/CLI callers won't.
            params.daysOfWeek ??
              (existing.event_type === "cron.weekly"
                ? existingSched?.recurrenceRule.daysOfWeek
                : undefined),
            params.configTimezone,
          )
        : undefined;

    const update: Parameters<typeof updateRecurringSchedule>[2] = {};
    if (params.prompt !== undefined) update.description = params.prompt;
    if (params.enabled !== undefined) update.enabled = params.enabled;
    if (recurrenceUpdate !== undefined) update.recurrenceRule = recurrenceUpdate;
    if (Object.keys(update).length > 0) {
      updateRecurringSchedule(db, existing.recurring_schedule_id, update);
    }

    // updateRecurringSchedule re-materializes the pending agent_schedule
    // row only when recurrenceRule or enabled changes. A prompt-only edit
    // would therefore leave the next firing using the stale prompt
    // (next-after-that picks up the new one). Patch the pending row
    // directly so the very next firing reflects the user's edit.
    if (params.prompt !== undefined && recurrenceUpdate === undefined) {
      db.prepare(
        `UPDATE agent_schedule
            SET task_description = ?
          WHERE recurring_schedule_id = ? AND status = 'pending'`,
      ).run(params.prompt, existing.recurring_schedule_id);
    }
  }

  const fresh = db
    .prepare("SELECT * FROM automation_triggers WHERE id = ?")
    .get(id) as AutomationTriggerRow;
  return rowToDTO(db, fresh);
}

export function deleteTrigger(db: Database.Database, id: number): boolean {
  const row = db
    .prepare("SELECT recurring_schedule_id FROM automation_triggers WHERE id = ?")
    .get(id) as { recurring_schedule_id: number | null } | undefined;
  if (!row) return false;

  if (row.recurring_schedule_id !== null) {
    deleteRecurringSchedule(db, row.recurring_schedule_id);
  }
  const result = db
    .prepare("DELETE FROM automation_triggers WHERE id = ?")
    .run(id);
  return result.changes > 0;
}

// ── Catalog ──────────────────────────────────────────────────────────

export interface CatalogEvent {
  type: TriggerEventType;
  label: string;
  /** Whether this event needs a HH:MM time slot. */
  needsTime: boolean;
  /** Whether this event needs day-of-week selection. */
  needsDayOfWeek: boolean;
}

export function getCatalog(domain: TriggerDomain): { domain: TriggerDomain; events: CatalogEvent[] } {
  if (domain === "git") {
    return {
      domain,
      events: [
        { type: "cron.daily", label: "Every day at…", needsTime: true, needsDayOfWeek: false },
        { type: "cron.weekly", label: "Every week on…", needsTime: true, needsDayOfWeek: true },
      ],
    };
  }
  return { domain, events: [] };
}
