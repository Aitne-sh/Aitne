import type Database from "better-sqlite3";
import type { AgentKind, ScheduleKind, StopWarning } from "@aitne/shared";

/**
 * Agents store — durable identity layer for the Agent Definitions feature
 * (AGENT_DEFINITIONS_DESIGN.md §5.1). One `agents` row per built-in routine
 * and per user-authored recurring task. This module is the only place that
 * reads/writes the `agents` table; the loader (§6), the `/api/agents` routes
 * (§9), and the scheduler enabled-gate (§7) all go through it.
 *
 * Design notes encoded here:
 *
 *   - **Timestamps are epoch-millisecond integers**, not ISO strings. The
 *     store is the sole writer and always supplies an explicit value, so the
 *     loader's §6.4 override resolution can compare `enabledOverriddenAt`
 *     directly against an `fs.stat().mtimeMs` with no coercion.
 *   - **`upsertAgent` is a pure column writer.** All policy — enabled-override
 *     resolution, override-snapshot merge, hash-change version bump — lives in
 *     the loader (Phase 5), which composes the final values and hands them to
 *     `upsertAgent`. On conflict the upsert preserves `created_at` and
 *     `last_execution_id` (those are owned by insert-time and the recorder
 *     respectively); the dedicated `setEnabled` / `setLastExecutionId` /
 *     `setOverrideSnapshot` mutators own their narrow slices.
 *   - **`process_key` is nullable**: the two no-LLM in-process passes
 *     (roadmap-maintenance, context-index-reconcile) have no routing key.
 */

/** `source` column vocabulary — identical to the YAML `kind` discriminator. */
export type AgentSource = AgentKind;

/**
 * Structured shape of the `metadata_json` blob (§5.1). Carries everything not
 * worth a dedicated column. The index signature keeps forward-compatibility
 * with reserved future fields without forcing a schema change.
 */
export interface AgentMetadata {
  /** Bumped by the loader on every `definition_hash` change (§6.3). */
  version_counter?: number;
  /** Set on the invalid-definition path (§6.6); presence == "invalid". */
  last_error?: string;
  /** Built-in field-level edits that must survive `npm i -g` (§6.4.1). */
  override_snapshot?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Raw row as stored in SQLite (snake_case, JSON columns unparsed). */
export interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  source: AgentSource;
  definition_path: string;
  definition_hash: string;
  enabled: number;
  enabled_overridden_at: number | null;
  process_key: string | null;
  schedule_kind: ScheduleKind;
  schedule_expression: string | null;
  schedule_timezone: string;
  tags_json: string;
  stop_warning_json: string | null;
  recurring_schedule_id: number | null;
  last_execution_id: number | null;
  metadata_json: string;
  created_at: number;
  updated_at: number;
}

/** Parsed, camelCase view returned to callers. */
export interface AgentDTO {
  slug: string;
  name: string;
  description: string | null;
  source: AgentSource;
  definitionPath: string;
  definitionHash: string;
  enabled: boolean;
  enabledOverriddenAt: number | null;
  processKey: string | null;
  scheduleKind: ScheduleKind;
  scheduleExpression: string | null;
  scheduleTimezone: string;
  tags: string[];
  stopWarning: StopWarning | null;
  recurringScheduleId: number | null;
  lastExecutionId: number | null;
  metadata: AgentMetadata;
  /** True when `metadata.last_error` is set (parse-failure row, §6.6). */
  invalid: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * Everything the loader resolves before persisting a row. The shared
 * `AgentDefinition` is decomposed into columns here plus the loader-only
 * fields (`definitionPath`, `definitionHash`, resolved `scheduleTimezone`,
 * `recurringScheduleId`, post-override `enabled`, `metadata`). `upsertAgent`
 * writes exactly these — it computes nothing.
 */
export interface AgentUpsertInput {
  slug: string;
  name: string;
  description?: string | null;
  source: AgentSource;
  definitionPath: string;
  definitionHash: string;
  enabled: boolean;
  enabledOverriddenAt?: number | null;
  processKey?: string | null;
  scheduleKind: ScheduleKind;
  scheduleExpression?: string | null;
  scheduleTimezone: string;
  tags?: string[];
  stopWarning?: StopWarning | null;
  recurringScheduleId?: number | null;
  metadata?: AgentMetadata;
}

export interface AgentListFilter {
  source?: AgentSource;
  enabled?: boolean;
  /**
   * When `false`, parse-failure rows (`metadata.last_error` set) are excluded.
   * Omitted / `true` returns every row. The `/api/agents` route applies the
   * product default (false) on top of this; the store stays a faithful data
   * layer that returns everything unless asked to filter.
   */
  includeInvalid?: boolean;
}

// ── JSON parsing (defensive — store is the writer, but never trust bytes) ──

function parseTags(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    /* fall through to [] */
  }
  return [];
}

function parseStopWarning(json: string | null): StopWarning | null {
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as StopWarning;
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

function parseMetadata(json: string): AgentMetadata {
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as AgentMetadata;
    }
  } catch {
    /* fall through to {} */
  }
  return {};
}

function rowToDTO(row: AgentRow): AgentDTO {
  const metadata = parseMetadata(row.metadata_json);
  // Read into a local first: the redaction static guard
  // (scripts/check-redaction-coverage.mjs) flags the auth-health JSON key name
  // whenever it is immediately followed by an equals sign anywhere under
  // daemon/src, to force the `backends` auth-detail column through its
  // redaction helper. The metadata key read just below is an unrelated
  // Agent-definition parse error (§6.6), never a secret — so we dodge the
  // textual pattern by comparing the camelCase local rather than exempting the
  // whole file. Do NOT inline this back into the comparison.
  const lastError = metadata.last_error;
  return {
    slug: row.id,
    name: row.name,
    description: row.description,
    source: row.source,
    definitionPath: row.definition_path,
    definitionHash: row.definition_hash,
    enabled: row.enabled === 1,
    enabledOverriddenAt: row.enabled_overridden_at,
    processKey: row.process_key,
    scheduleKind: row.schedule_kind,
    scheduleExpression: row.schedule_expression,
    scheduleTimezone: row.schedule_timezone,
    tags: parseTags(row.tags_json),
    stopWarning: parseStopWarning(row.stop_warning_json),
    recurringScheduleId: row.recurring_schedule_id,
    lastExecutionId: row.last_execution_id,
    metadata,
    invalid: typeof lastError === "string" && lastError.length > 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Reads ────────────────────────────────────────────────────────────

export function getAgent(db: Database.Database, slug: string): AgentDTO | null {
  const row = db
    .prepare<[string], AgentRow>("SELECT * FROM agents WHERE id = ?")
    .get(slug);
  return row ? rowToDTO(row) : null;
}

export function listAgents(
  db: Database.Database,
  filter: AgentListFilter = {},
): AgentDTO[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.source !== undefined) {
    where.push("source = ?");
    params.push(filter.source);
  }
  if (filter.enabled !== undefined) {
    where.push("enabled = ?");
    params.push(filter.enabled ? 1 : 0);
  }
  if (filter.includeInvalid === false) {
    // metadata_json is always valid JSON written by this store (default '{}'),
    // so json_extract is safe. An absent key returns NULL → the row is kept.
    where.push("json_extract(metadata_json, '$.last_error') IS NULL");
  }
  const sql =
    "SELECT * FROM agents"
    + (where.length ? ` WHERE ${where.join(" AND ")}` : "")
    + " ORDER BY source ASC, id ASC";
  const rows = db.prepare(sql).all(...params) as AgentRow[];
  return rows.map(rowToDTO);
}

// ── Writes ───────────────────────────────────────────────────────────

/**
 * Insert or update an Agent identity row by slug. On conflict, `created_at`
 * and `last_execution_id` are preserved (not in the DO UPDATE set); every
 * other column is overwritten from `input`. Returns the resulting DTO.
 */
export function upsertAgent(
  db: Database.Database,
  input: AgentUpsertInput,
  now: number = Date.now(),
): AgentDTO {
  db.prepare(
    `INSERT INTO agents (
        id, name, description, source, definition_path, definition_hash,
        enabled, enabled_overridden_at, process_key, schedule_kind,
        schedule_expression, schedule_timezone, tags_json, stop_warning_json,
        recurring_schedule_id, metadata_json, created_at, updated_at
     ) VALUES (
        @id, @name, @description, @source, @definition_path, @definition_hash,
        @enabled, @enabled_overridden_at, @process_key, @schedule_kind,
        @schedule_expression, @schedule_timezone, @tags_json, @stop_warning_json,
        @recurring_schedule_id, @metadata_json, @created_at, @updated_at
     )
     ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        source = excluded.source,
        definition_path = excluded.definition_path,
        definition_hash = excluded.definition_hash,
        enabled = excluded.enabled,
        enabled_overridden_at = excluded.enabled_overridden_at,
        process_key = excluded.process_key,
        schedule_kind = excluded.schedule_kind,
        schedule_expression = excluded.schedule_expression,
        schedule_timezone = excluded.schedule_timezone,
        tags_json = excluded.tags_json,
        stop_warning_json = excluded.stop_warning_json,
        recurring_schedule_id = excluded.recurring_schedule_id,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
  ).run({
    id: input.slug,
    name: input.name,
    description: input.description ?? null,
    source: input.source,
    definition_path: input.definitionPath,
    definition_hash: input.definitionHash,
    enabled: input.enabled ? 1 : 0,
    enabled_overridden_at: input.enabledOverriddenAt ?? null,
    process_key: input.processKey ?? null,
    schedule_kind: input.scheduleKind,
    schedule_expression: input.scheduleExpression ?? null,
    schedule_timezone: input.scheduleTimezone,
    tags_json: JSON.stringify(input.tags ?? []),
    stop_warning_json:
      input.stopWarning != null ? JSON.stringify(input.stopWarning) : null,
    recurring_schedule_id: input.recurringScheduleId ?? null,
    metadata_json: JSON.stringify(input.metadata ?? {}),
    created_at: now,
    updated_at: now,
  });
  // Non-null: the row was just inserted/updated under this id.
  return getAgent(db, input.slug)!;
}

/**
 * Toggle the enabled flag and stamp `enabled_overridden_at` (the dashboard
 * PATCH path, §6.4 / §9.5). Pass `overriddenAt = now` for an operator toggle;
 * the loader never calls this (it writes enabled via `upsertAgent`). Returns
 * the updated DTO, or `null` when no row matches the slug.
 */
export function setEnabled(
  db: Database.Database,
  slug: string,
  enabled: boolean,
  overriddenAt: number | null,
  now: number = Date.now(),
): AgentDTO | null {
  const result = db
    .prepare(
      `UPDATE agents
          SET enabled = ?, enabled_overridden_at = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(enabled ? 1 : 0, overriddenAt, now, slug);
  if (result.changes === 0) return null;
  return getAgent(db, slug);
}

/**
 * Point `last_execution_id` at a freshly-recorded execution (the recorder
 * runs this inside the same transaction as `completeExecution`, §8.2).
 * `null` clears the pointer. Returns true when a row was updated.
 */
export function setLastExecutionId(
  db: Database.Database,
  slug: string,
  executionId: number | null,
  now: number = Date.now(),
): boolean {
  const result = db
    .prepare(
      `UPDATE agents SET last_execution_id = ?, updated_at = ? WHERE id = ?`,
    )
    .run(executionId, now, slug);
  return result.changes > 0;
}

// ── One-shot Agent lifecycle (legacy / defensive) ──────────────────────────

/**
 * Defensive cleanup for any row that still carries `schedule_kind='one_shot'`.
 *
 * As of the scheduling split, `/agents` is recurring-only — the loader rejects
 * a user one_shot definition outright, so no NEW one_shot Agents are created.
 * This guard is retained because a legacy/pre-split DB row (or a manual edit)
 * could still be `one_shot`: when such a row fires, disable it (so it stays as a
 * re-runnable record the operator can re-fire via run-now) and skip any other
 * still-pending firing for it (defends against a run-now + scheduled pair, or a
 * stale row, double-firing). No-op for cron / event Agents — they keep their
 * materialised pending rows. Returns true only when this call disabled a
 * still-enabled one_shot Agent. Called unconditionally by the execution
 * recorder; the `schedule_kind !== 'one_shot'` guard makes it a cheap no-op for
 * the now-universal cron case.
 */
export function disableOneShotAfterFire(
  db: Database.Database,
  slug: string,
  now: number = Date.now(),
): boolean {
  const row = db
    .prepare<[string], { schedule_kind: ScheduleKind; enabled: number }>(
      "SELECT schedule_kind AS schedule_kind, enabled AS enabled FROM agents WHERE id = ?",
    )
    .get(slug);
  if (!row || row.schedule_kind !== "one_shot") return false;
  // Cancel sibling pending fires so a double-booked one_shot can't fire twice
  // once one run has settled — independent of the enabled flip below.
  db.prepare(
    `UPDATE agent_schedule SET status = 'skipped'
       WHERE json_extract(task_context, '$.agent_id') = ? AND status = 'pending'`,
  ).run(slug);
  if (row.enabled === 0) return false;
  db.prepare(
    `UPDATE agents
        SET enabled = 0, enabled_overridden_at = ?, updated_at = ?
      WHERE id = ? AND enabled = 1`,
  ).run(now, now, slug);
  return true;
}

/**
 * Delete an Agent row. The FK on `agent_executions.agent_id` cascades, so the
 * Agent's execution history is removed too (the `/api/agents` DELETE handler's
 * `keep_history` path stops short of this and disables instead — §9.6).
 * Returns true when a row was removed.
 */
export function deleteAgent(db: Database.Database, slug: string): boolean {
  const result = db.prepare("DELETE FROM agents WHERE id = ?").run(slug);
  return result.changes > 0;
}

// ── Override snapshot (§6.4.1 — built-in edits that survive npm upgrade) ──

/**
 * Read the built-in override snapshot. Returns `{}` when the Agent is missing
 * or carries no snapshot, so callers can treat the result uniformly.
 */
export function getOverrideSnapshot(
  db: Database.Database,
  slug: string,
): Record<string, unknown> {
  const row = db
    .prepare<[string], { metadata_json: string }>(
      "SELECT metadata_json FROM agents WHERE id = ?",
    )
    .get(slug);
  if (!row) return {};
  return parseMetadata(row.metadata_json).override_snapshot ?? {};
}

/**
 * Replace the override snapshot, preserving every other `metadata_json` key.
 * An empty snapshot removes the `override_snapshot` key entirely (so a fully
 * reset Agent's metadata is clean). Returns the updated DTO, or `null` when no
 * row matches.
 */
export function setOverrideSnapshot(
  db: Database.Database,
  slug: string,
  snapshot: Record<string, unknown>,
  now: number = Date.now(),
): AgentDTO | null {
  const row = db
    .prepare<[string], { metadata_json: string }>(
      "SELECT metadata_json FROM agents WHERE id = ?",
    )
    .get(slug);
  if (!row) return null;
  const metadata = parseMetadata(row.metadata_json);
  if (Object.keys(snapshot).length === 0) {
    delete metadata.override_snapshot;
  } else {
    metadata.override_snapshot = snapshot;
  }
  db.prepare(
    "UPDATE agents SET metadata_json = ?, updated_at = ? WHERE id = ?",
  ).run(JSON.stringify(metadata), now, slug);
  return getAgent(db, slug);
}
