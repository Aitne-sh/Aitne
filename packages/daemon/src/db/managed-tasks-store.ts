import type Database from "better-sqlite3";
import {
  formatManagedTaskId,
  isValidManagedTaskId,
  managedTaskSchema,
  normalizeAppLabel,
  type ManagedTask,
} from "@aitne/shared";

/**
 * Managed-tasks DB access (docs/design/21-management-registry-and-entities.md
 * §9.2). Pure data layer: each function is one prepared statement plus
 * row→DTO mapping; the API layer at `api/routes/managed-tasks.ts`
 * composes these into the §10.1/10.2/10.3 transactions and owns the
 * file-render + agent_actions emission.
 *
 * No file IO, no chokidar, no logging. Each helper is one prepared
 * statement so the registry's render+lock+snapshot path stays
 * comfortably under NFR-2's 200 ms boot budget.
 */

interface ManagedTaskRow {
  id: string;
  intent: string;
  app: string;
  app_normalized: string;
  cadence: string;
  output_path: string | null;
  schedule_id: number;
  last_run_at: string | null;
  last_result: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
}

function rowToManagedTask(row: ManagedTaskRow): ManagedTask {
  // Re-validate on read so a manually-poked row cannot smuggle an
  // invalid `output_path` (or any other field) into the renderer. The
  // CHECK constraint already enforces the trailing-slash rule (§9.2);
  // the Zod refinement covers the §9.1 enum invariants the SQL CHECK
  // intentionally does not encode.
  return managedTaskSchema.parse({
    id: row.id,
    intent: row.intent,
    app: row.app,
    app_normalized: row.app_normalized,
    cadence: row.cadence,
    output_path: row.output_path,
    schedule_id: row.schedule_id,
    last_run_at: row.last_run_at,
    last_result: row.last_result,
    consecutive_failures: row.consecutive_failures,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

/**
 * List all active managed tasks ordered by numeric id ascending so the
 * rendered table is deterministic across calls (NFR-2 idempotency: same
 * DB → byte-identical render).
 *
 * Sorting on `CAST(SUBSTR(id, 4) AS INTEGER)` avoids string-compare
 * surprises when the seq crosses 10/100/1000 boundaries (`mt_10` would
 * sort before `mt_2` lexically).
 */
export function listManagedTasks(db: Database.Database): ManagedTask[] {
  const rows = db
    .prepare(
      `SELECT id, intent, app, app_normalized, cadence, output_path,
              schedule_id, last_run_at, last_result, consecutive_failures,
              created_at, updated_at
         FROM managed_tasks
         ORDER BY CAST(SUBSTR(id, 4) AS INTEGER) ASC`,
    )
    .all() as ManagedTaskRow[];
  return rows.map(rowToManagedTask);
}

/**
 * Read one managed task by id. Returns `null` when the id does not
 * match `/^mt_[1-9]\d*$/` or when no row is present, so callers can
 * cleanly distinguish "bad input" from "deleted".
 */
export function getManagedTask(
  db: Database.Database,
  id: string,
): ManagedTask | null {
  if (!isValidManagedTaskId(id)) return null;
  const row = db
    .prepare(
      `SELECT id, intent, app, app_normalized, cadence, output_path,
              schedule_id, last_run_at, last_result, consecutive_failures,
              created_at, updated_at
         FROM managed_tasks WHERE id = ?`,
    )
    .get(id) as ManagedTaskRow | undefined;
  if (!row) return null;
  return rowToManagedTask(row);
}

/**
 * Total active managed-task count — surfaced by the §14.3
 * `aitne_managed_tasks_active` gauge and the §13.2 cap check (returning
 * 409 once the configured `managementMaxActiveTasks` is hit).
 */
export function countManagedTasks(db: Database.Database): number {
  // `COUNT(*)` always returns one row in SQLite, so the result is
  // non-undefined by SQL semantics — no defensive `?? 0` needed.
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM managed_tasks")
    .get() as { n: number };
  return row.n;
}

export interface AllocateNextIdOptions {
  /**
   * On boot, the §12 "managed_tasks.id collision after restore from
   * backup" recovery path passes `bootstrap=true` so the seq is
   * guaranteed to advance past every existing id (a backup-restored
   * database can outpace its seq counter).
   */
  bootstrap?: boolean;
}

/**
 * Allocate the next `mt_<n>` id atomically. Increments
 * `managed_task_seq.next_id` and returns the formatted id. The caller
 * MUST run this inside a transaction that also INSERTs the matching
 * `managed_tasks` row, otherwise a crash between allocation and insert
 * burns the id (which is fine — IDs are never reused) but a duplicate
 * caller could race to allocate the same value if the UPDATE+SELECT
 * are not in one statement. SQLite's `RETURNING` on UPDATE is exactly
 * that single statement.
 *
 * The boot-side reconciler invokes `bootstrapNextManagedTaskId` instead
 * to pre-seed the counter from the max existing id — restoring from a
 * backup whose `data.db` carries higher mt_ids than the seed value
 * would otherwise collide on the next allocate. A simple call (without
 * `bootstrap=true`) does not consult `MAX(...)` because the per-call
 * cost is unnecessary at steady state.
 */
export function allocateNextManagedTaskId(db: Database.Database): string {
  const row = db
    .prepare(
      `UPDATE managed_task_seq
          SET next_id = next_id + 1
        WHERE singleton = 1
        RETURNING next_id`,
    )
    .get() as { next_id: number } | undefined;
  if (!row) {
    // The schema seeds `(singleton=1, next_id=1)` and the row is
    // protected by the `CHECK (singleton = 1)` PK; a missing row means
    // someone has manually wiped it. Re-seed so the daemon recovers,
    // then retry once.
    db.prepare(
      "INSERT OR IGNORE INTO managed_task_seq (singleton, next_id) VALUES (1, 1)",
    ).run();
    const retry = db
      .prepare(
        `UPDATE managed_task_seq
            SET next_id = next_id + 1
          WHERE singleton = 1
          RETURNING next_id`,
      )
      .get() as { next_id: number };
    return formatManagedTaskId(retry.next_id - 1);
  }
  // RETURNING surfaces the new value (post-increment); the caller's id
  // is the *previous* counter, i.e. `next_id - 1`. This keeps the seed
  // semantics — first allocation returns `mt_1`.
  return formatManagedTaskId(row.next_id - 1);
}

/**
 * §12 recovery path: ensure `managed_task_seq.next_id` is greater than
 * the maximum existing `managed_tasks.id` numeric component. Idempotent
 * — call from boot once, after the schema is applied. Safe to call
 * even on an empty table (no-op when MAX returns NULL).
 */
export function bootstrapManagedTaskSeq(db: Database.Database): void {
  const row = db
    .prepare(
      `SELECT MAX(CAST(SUBSTR(id, 4) AS INTEGER)) AS max_id FROM managed_tasks`,
    )
    .get() as { max_id: number | null } | undefined;
  const maxId = row?.max_id ?? 0;
  if (maxId <= 0) return;
  db.prepare(
    `UPDATE managed_task_seq SET next_id = ? WHERE singleton = 1 AND next_id <= ?`,
  ).run(maxId + 1, maxId);
}

// ── Mutations (§9.2 / §10.1-10.4) ──────────────────────────────────────────
//
// Each mutator is a single prepared statement (or a small group) and
// is *not* wrapped in `db.transaction(...)` itself — the API route
// composes the registration / patch / delete transactions across this
// module + `db/recurring-schedules.ts` + the `agent_actions` insert.

/**
 * Insert a managed-task row. Returns the freshly-rehydrated DTO so
 * the caller doesn't need a follow-up SELECT. The `id` MUST already
 * have been allocated via {@link allocateNextManagedTaskId} inside the
 * same transaction so the seq counter and the inserted row stay
 * consistent on rollback.
 *
 * The `(app_normalized, cadence)` UNIQUE constraint is the dedup floor
 * (§NFR-3 / §12); a SqliteError with code `SQLITE_CONSTRAINT_UNIQUE`
 * surfaces from this function on collision, and the route layer maps
 * it to a 409 with the existing mt_id (§17.2 integration test bullet).
 */
export interface InsertManagedTaskInput {
  id: string;
  intent: string;
  app: string;
  cadence: string;
  outputPath: string | null;
  scheduleId: number;
}

export function insertManagedTask(
  db: Database.Database,
  input: InsertManagedTaskInput,
): ManagedTask {
  if (!isValidManagedTaskId(input.id)) {
    throw new Error(`insertManagedTask: invalid id ${input.id}`);
  }
  db.prepare(
    `INSERT INTO managed_tasks
        (id, intent, app, app_normalized, cadence, output_path, schedule_id,
         consecutive_failures, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))`,
  ).run(
    input.id,
    input.intent,
    input.app,
    normalizeAppLabel(input.app),
    input.cadence,
    input.outputPath,
    input.scheduleId,
  );
  const dto = getManagedTask(db, input.id);
  // INSERT just succeeded, the row is guaranteed to exist; the branch
  // is defensive against a post-insert deletion racing in another
  // connection (no such caller exists today).
  /* c8 ignore start */
  if (!dto) {
    throw new Error(`insertManagedTask: row vanished after insert (${input.id})`);
  }
  /* c8 ignore stop */
  return dto;
}

/**
 * Apply a partial update. Only the columns the API layer is permitted
 * to mutate are accepted (§9.2 ManagedTaskPatchSchema). Returns the
 * post-update DTO, or `null` when no row matches.
 *
 * `app` (and `app_normalized`) are intentionally NOT mutable through
 * this surface — see the `rename-app` flow (§12) for the atomic path
 * that updates entity-file `frontmatter.sources.<key>` references.
 */
export interface UpdateManagedTaskInput {
  intent?: string;
  cadence?: string;
  outputPath?: string | null;
}

export function updateManagedTask(
  db: Database.Database,
  id: string,
  input: UpdateManagedTaskInput,
): ManagedTask | null {
  if (!isValidManagedTaskId(id)) return null;
  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.intent !== undefined) {
    sets.push("intent = ?");
    values.push(input.intent);
  }
  if (input.cadence !== undefined) {
    sets.push("cadence = ?");
    values.push(input.cadence);
  }
  if (input.outputPath !== undefined) {
    sets.push("output_path = ?");
    values.push(input.outputPath);
  }
  if (sets.length === 0) return getManagedTask(db, id);
  sets.push("updated_at = datetime('now')");
  values.push(id);
  const result = db
    .prepare(`UPDATE managed_tasks SET ${sets.join(", ")} WHERE id = ?`)
    .run(...values);
  if (result.changes === 0) return null;
  return getManagedTask(db, id);
}

/**
 * Internal-only — applied by the scheduled-managed-task skill via
 * `PATCH /api/managed-tasks/:id/run-result` (§10.4 step 5). Replace-
 * semantics on every column so the skill is responsible for the
 * three-strikes counter (§10.4 step 6 is the route layer's notify
 * path).
 */
export function updateManagedTaskRunResult(
  db: Database.Database,
  id: string,
  input: {
    lastRunAt: string;
    lastResult: string;
    consecutiveFailures: number;
  },
): ManagedTask | null {
  if (!isValidManagedTaskId(id)) return null;
  const result = db
    .prepare(
      `UPDATE managed_tasks
          SET last_run_at = ?, last_result = ?, consecutive_failures = ?,
              updated_at = datetime('now')
        WHERE id = ?`,
    )
    .run(input.lastRunAt, input.lastResult, input.consecutiveFailures, id);
  if (result.changes === 0) return null;
  return getManagedTask(db, id);
}

/**
 * Hard-delete a managed task (§10.3). Returns `true` when a row was
 * removed, `false` when the id did not exist. The caller is expected
 * to also delete the matching `recurring_schedules.id` row in the
 * same transaction; the FK's `ON DELETE CASCADE` handles the reverse
 * direction when the schedule is deleted first, but the §10.3 flow
 * deletes managed_tasks first (so a partial failure leaves the
 * schedule orphaned for the boot reconciler to clean up rather than
 * silently dropping the user's commitment).
 */
export function deleteManagedTask(
  db: Database.Database,
  id: string,
): boolean {
  if (!isValidManagedTaskId(id)) return false;
  const result = db
    .prepare("DELETE FROM managed_tasks WHERE id = ?")
    .run(id);
  return result.changes > 0;
}

/**
 * §10.1 step 2 — DB-side dedup probe. Used by the route layer when an
 * Idempotency-Key collision (§11.4) misses but the (app_normalized,
 * cadence) pair already exists. Returns the existing row so a 409
 * response can carry the mt_id back to the agent's DM.
 *
 * Returns `null` when no row matches. The match is exact on the
 * normalized app label and on the verbatim cadence string —
 * semantic-cadence matching is left to the LLM-judged dedup at
 * registration time (§10.1 step 2).
 */
export function findManagedTaskByAppCadence(
  db: Database.Database,
  app: string,
  cadence: string,
): ManagedTask | null {
  const row = db
    .prepare(
      `SELECT id, intent, app, app_normalized, cadence, output_path,
              schedule_id, last_run_at, last_result, consecutive_failures,
              created_at, updated_at
         FROM managed_tasks
        WHERE app_normalized = ? AND cadence = ?
        LIMIT 1`,
    )
    .get(normalizeAppLabel(app), cadence) as ManagedTaskRow | undefined;
  return row ? rowToManagedTask(row) : null;
}
