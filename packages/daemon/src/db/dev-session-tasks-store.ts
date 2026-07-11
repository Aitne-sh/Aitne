/**
 * Dev-session task store — the dev-flow plan (task-DAG fleet).
 *
 * I/O-bound CRUD over `dev_session_tasks`: one row per task-DAG node. The
 * plan phase decomposes the approved contract into small dependent tasks;
 * each task runs its own inner loop inside an isolated git worktree, then
 * flows through supervise → merge back onto the session branch. The task
 * lifecycle is enforced here via the CHECK constraint on `state` (closed
 * set) plus CAS transitions — `claimDevTask` (queued→running),
 * `markDevTaskState` (generic from-set→to), `resetDevTaskForRedo`
 * (merge_pending→queued) — each one's WHERE clause refuses an out-of-order
 * write so a race between two writers cannot flip a row backwards.
 *
 * `depends_on` / `reqs` are JSON string arrays round-tripped through
 * `parseJsonStringArray` (defensive fallback to [] on malformed JSON, the
 * same posture as `parseJsonObject` in dev-sessions-store). The per-task
 * loop-checkpoint counters mirror the session-level ones so a daemon
 * restart resumes each task rather than restarting it.
 *
 * SQL wrapper only — excluded from the coverage gate, same posture as
 * `dev-sessions-store.ts` (its peer test still exercises every branch).
 */

import type Database from "better-sqlite3";
import type { DevSessionLoopState } from "./dev-sessions-store.js";

export type DevTaskState =
  | "queued"
  | "running"
  | "supervise_pending"
  | "merge_pending"
  | "awaiting_user"
  | "merged"
  | "failed"
  | "superseded"
  | "dep_failed";

/** The session-level loop verdicts plus the task-only "split me" state. */
export type DevTaskLoopState = DevSessionLoopState | "NEEDS_DECOMPOSITION";

/** Which fleet mutation created the task row. 'manual' = an owner `!add` —
 *  it runs OUTSIDE the master contract with its own generated sub-contract. */
export type DevTaskOrigin = "plan" | "replan" | "plan_review" | "fixup" | "manual";

export type DevTaskPlanReview = "pending" | "done" | "escalated";

/** Non-terminal task states — the fleet scheduler's live set. */
export const DEV_TASK_LIVE_STATES: ReadonlySet<DevTaskState> = new Set([
  "queued",
  "running",
  "supervise_pending",
  "merge_pending",
  "awaiting_user",
]);

const DEV_TASK_TERMINAL_STATES: ReadonlySet<DevTaskState> = new Set([
  "merged",
  "failed",
  "superseded",
  "dep_failed",
]);

export interface DevTaskRow {
  id: string;
  sessionId: string;
  taskKey: string;
  summary: string;
  /** task_keys this task waits on (JSON array column). [] = a root. */
  dependsOn: string[];
  scope: string;
  /** REQ- ids this task claims to advance (JSON array column). */
  reqs: string[];
  body: string;
  origin: DevTaskOrigin;
  /** A MANUAL task's own sub-contract anchor (computeApprovalHash over its
   *  worktree contract + config); null = runs under the session's hash. */
  approvedHash: string | null;
  state: DevTaskState;
  loopState: DevTaskLoopState | null;
  branch: string | null;
  worktreePath: string | null;
  baseRef: string | null;
  seedBranch: string | null;
  iteration: number;
  agentFailures: number;
  gateReviseCount: number;
  iterReviseCount: number;
  resumes: number;
  mergeRetries: number;
  superviseCount: number;
  planReview: DevTaskPlanReview | null;
  costUsd: number | null;
  failReason: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  mergedAt: number | null;
  updatedAt: number;
}

interface DevTaskDbRow {
  id: string;
  session_id: string;
  task_key: string;
  summary: string;
  depends_on: string;
  scope: string;
  reqs: string;
  body: string;
  origin: DevTaskOrigin;
  approved_hash: string | null;
  state: DevTaskState;
  loop_state: DevTaskLoopState | null;
  branch: string | null;
  worktree_path: string | null;
  base_ref: string | null;
  seed_branch: string | null;
  iteration: number;
  agent_failures: number;
  gate_revise_count: number;
  iter_revise_count: number;
  resumes: number;
  merge_retries: number;
  supervise_count: number;
  plan_review: DevTaskPlanReview | null;
  cost_usd: number | null;
  fail_reason: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  merged_at: number | null;
  updated_at: number;
}

const SELECT_COLUMNS = `
  id, session_id, task_key, summary, depends_on, scope, reqs, body, origin,
  approved_hash, state, loop_state, branch, worktree_path, base_ref,
  seed_branch, iteration,
  agent_failures, gate_revise_count, iter_revise_count, resumes,
  merge_retries, supervise_count, plan_review, cost_usd, fail_reason,
  created_at, started_at, ended_at, merged_at, updated_at
`;

/** JSON string-array round-trip with a defensive [] fallback (the array
 *  sibling of dev-sessions-store's parseJsonObject). Non-string members
 *  are dropped rather than surfaced. */
function parseJsonStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function fromDbRow(row: DevTaskDbRow): DevTaskRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskKey: row.task_key,
    summary: row.summary,
    dependsOn: parseJsonStringArray(row.depends_on),
    scope: row.scope,
    reqs: parseJsonStringArray(row.reqs),
    body: row.body,
    origin: row.origin,
    approvedHash: row.approved_hash,
    state: row.state,
    loopState: row.loop_state,
    branch: row.branch,
    worktreePath: row.worktree_path,
    baseRef: row.base_ref,
    seedBranch: row.seed_branch,
    iteration: row.iteration,
    agentFailures: row.agent_failures,
    gateReviseCount: row.gate_revise_count,
    iterReviseCount: row.iter_revise_count,
    resumes: row.resumes,
    mergeRetries: row.merge_retries,
    superviseCount: row.supervise_count,
    planReview: row.plan_review,
    costUsd: row.cost_usd,
    failReason: row.fail_reason,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    mergedAt: row.merged_at,
    updatedAt: row.updated_at,
  };
}

// ── Insert / read ───────────────────────────────────────────────────────

export interface NewDevTaskInput {
  id: string;
  taskKey: string;
  summary: string;
  dependsOn: string[];
  scope: string;
  reqs: string[];
  body: string;
  origin: DevTaskOrigin;
}

/** Insert a batch of fresh 'queued' tasks in ONE transaction — a plan /
 *  replan / fixup lands atomically or not at all (the unique
 *  (session_id, task_key) index rolls the whole batch back on a dup). */
export function insertDevTasks(
  db: Database.Database,
  sessionId: string,
  tasks: readonly NewDevTaskInput[],
  now: number,
): void {
  const insert = db.prepare(
    `INSERT INTO dev_session_tasks
       (id, session_id, task_key, summary, depends_on, scope, reqs, body,
        origin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const txn = db.transaction(() => {
    for (const task of tasks) {
      insert.run(
        task.id,
        sessionId,
        task.taskKey,
        task.summary,
        JSON.stringify(task.dependsOn),
        task.scope,
        JSON.stringify(task.reqs),
        task.body,
        task.origin,
        now,
        now,
      );
    }
  });
  txn();
}

export function getDevTask(
  db: Database.Database,
  id: string,
): DevTaskRow | null {
  const row = db
    .prepare<[string], DevTaskDbRow>(
      `SELECT ${SELECT_COLUMNS} FROM dev_session_tasks WHERE id = ?`,
    )
    .get(id);
  return row ? fromDbRow(row) : null;
}

export function getDevTaskByKey(
  db: Database.Database,
  sessionId: string,
  taskKey: string,
): DevTaskRow | null {
  const row = db
    .prepare<[string, string], DevTaskDbRow>(
      `SELECT ${SELECT_COLUMNS} FROM dev_session_tasks
        WHERE session_id = ? AND task_key = ?`,
    )
    .get(sessionId, taskKey);
  return row ? fromDbRow(row) : null;
}

/** All tasks for a session — stable creation order (batch peers tie-break
 *  on task_key so listings are deterministic). */
export function listDevTasks(
  db: Database.Database,
  sessionId: string,
): DevTaskRow[] {
  const rows = db
    .prepare<[string], DevTaskDbRow>(
      `SELECT ${SELECT_COLUMNS} FROM dev_session_tasks
        WHERE session_id = ?
        ORDER BY created_at ASC, task_key ASC`,
    )
    .all(sessionId);
  return rows.map(fromDbRow);
}

// ── CAS transitions ─────────────────────────────────────────────────────

/**
 * CAS queued → running, stamping the worker's branch / worktree / merge
 * baseline. started_at is set only if still NULL — a merge-redo keeps the
 * first claim time. Returns null on a CAS miss (already claimed / not
 * queued), so two workers cannot both win the same task.
 */
export function claimDevTask(
  db: Database.Database,
  input: {
    id: string;
    branch: string;
    worktreePath: string;
    baseRef: string;
    at: number;
  },
): DevTaskRow | null {
  const result = db
    .prepare(
      `UPDATE dev_session_tasks
          SET state = 'running',
              branch = ?,
              worktree_path = ?,
              base_ref = ?,
              started_at = COALESCE(started_at, ?),
              updated_at = ?
        WHERE id = ? AND state = 'queued'`,
    )
    .run(
      input.branch,
      input.worktreePath,
      input.baseRef,
      input.at,
      input.at,
      input.id,
    );
  return result.changes > 0 ? getDevTask(db, input.id) : null;
}

/**
 * Generic CAS transition: `from` (a closed set) → `to`. Stamps ended_at
 * when `to` is terminal (merged/failed/superseded/dep_failed) and merged_at
 * when `to` is 'merged'. loopState semantics: undefined = leave as-is,
 * null = clear, value = set. Same for failReason. Returns null on a CAS
 * miss so callers can distinguish a lost race from a write.
 */
export function markDevTaskState(
  db: Database.Database,
  input: {
    id: string;
    from: readonly DevTaskState[];
    to: DevTaskState;
    loopState?: DevTaskLoopState | null;
    failReason?: string | null;
    at: number;
  },
): DevTaskRow | null {
  if (input.from.length === 0) return null;
  const sets = [`state = ?`, `updated_at = ?`];
  const params: (string | number | null)[] = [input.to, input.at];
  if (input.loopState !== undefined) {
    sets.push(`loop_state = ?`);
    params.push(input.loopState);
  }
  if (input.failReason !== undefined) {
    sets.push(`fail_reason = ?`);
    params.push(input.failReason);
  }
  if (DEV_TASK_TERMINAL_STATES.has(input.to)) {
    sets.push(`ended_at = ?`);
    params.push(input.at);
  }
  if (input.to === "merged") {
    sets.push(`merged_at = ?`);
    params.push(input.at);
  }
  const result = db
    .prepare(
      `UPDATE dev_session_tasks
          SET ${sets.join(", ")}
        WHERE id = ?
          AND state IN (${input.from.map(() => "?").join(", ")})`,
    )
    .run(...params, input.id, ...input.from);
  return result.changes > 0 ? getDevTask(db, input.id) : null;
}

/**
 * CAS merge_pending → queued for a merge redo: bump merge_retries, zero
 * the per-task loop checkpoint, clear the worker anchors (branch /
 * worktree_path / base_ref) and loop_state. Keeps started_at (first claim
 * time), cost_usd (spend is cumulative), seed_branch and plan_review.
 */
export function resetDevTaskForRedo(
  db: Database.Database,
  input: { id: string; at: number },
): DevTaskRow | null {
  const result = db
    .prepare(
      `UPDATE dev_session_tasks
          SET state = 'queued',
              merge_retries = merge_retries + 1,
              iteration = 0,
              agent_failures = 0,
              gate_revise_count = 0,
              iter_revise_count = 0,
              resumes = 0,
              branch = NULL,
              worktree_path = NULL,
              base_ref = NULL,
              loop_state = NULL,
              updated_at = ?
        WHERE id = ? AND state = 'merge_pending'`,
    )
    .run(input.at, input.id);
  return result.changes > 0 ? getDevTask(db, input.id) : null;
}

// ── Run-checkpoint + telemetry ──────────────────────────────────────────

/** Persist the per-task loop-kit run-checkpoint counters. State untouched. */
export function writeDevTaskCheckpoint(
  db: Database.Database,
  input: {
    id: string;
    iteration: number;
    agentFailures: number;
    gateReviseCount: number;
    iterReviseCount: number;
    resumes: number;
  },
  now: number,
): void {
  db.prepare(
    `UPDATE dev_session_tasks
        SET iteration = ?,
            agent_failures = ?,
            gate_revise_count = ?,
            iter_revise_count = ?,
            resumes = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(
    input.iteration,
    input.agentFailures,
    input.gateReviseCount,
    input.iterReviseCount,
    input.resumes,
    now,
    input.id,
  );
}

/** Accumulate one leg's USD onto the task rollup. No-op for a zero /
 *  negative / non-finite delta (mirror of addDevSessionCost) so a costless
 *  bail never fabricates a 0 rollup. */
export function addDevTaskCost(
  db: Database.Database,
  id: string,
  deltaUsd: number,
  now: number,
): void {
  if (!Number.isFinite(deltaUsd) || deltaUsd <= 0) return;
  db.prepare(
    `UPDATE dev_session_tasks
        SET cost_usd = COALESCE(cost_usd, 0) + ?, updated_at = ?
      WHERE id = ?`,
  ).run(deltaUsd, now, id);
}

/** +1 supervise_count; returns the new value (0 for a missing row). */
export function bumpDevTaskSuperviseCount(
  db: Database.Database,
  id: string,
  now: number,
): number {
  db.prepare(
    `UPDATE dev_session_tasks
        SET supervise_count = supervise_count + 1, updated_at = ?
      WHERE id = ?`,
  ).run(now, id);
  const row = db
    .prepare<[string], { n: number }>(
      `SELECT supervise_count AS n FROM dev_session_tasks WHERE id = ?`,
    )
    .get(id);
  return row?.n ?? 0;
}

/** +1 merge_retries; returns the new value (0 for a missing row). */
export function bumpDevTaskMergeRetries(
  db: Database.Database,
  id: string,
  now: number,
): number {
  db.prepare(
    `UPDATE dev_session_tasks
        SET merge_retries = merge_retries + 1, updated_at = ?
      WHERE id = ?`,
  ).run(now, id);
  const row = db
    .prepare<[string], { n: number }>(
      `SELECT merge_retries AS n FROM dev_session_tasks WHERE id = ?`,
    )
    .get(id);
  return row?.n ?? 0;
}

// ── Field setters ───────────────────────────────────────────────────────

export function setDevTaskPlanReview(
  db: Database.Database,
  id: string,
  value: DevTaskPlanReview | null,
  now: number,
): void {
  db.prepare(
    `UPDATE dev_session_tasks SET plan_review = ?, updated_at = ? WHERE id = ?`,
  ).run(value, now, id);
}

export function setDevTaskSeedBranch(
  db: Database.Database,
  id: string,
  seedBranch: string | null,
  now: number,
): void {
  db.prepare(
    `UPDATE dev_session_tasks SET seed_branch = ?, updated_at = ? WHERE id = ?`,
  ).run(seedBranch, now, id);
}

export function setDevTaskWorktree(
  db: Database.Database,
  id: string,
  worktreePath: string | null,
  now: number,
): void {
  db.prepare(
    `UPDATE dev_session_tasks SET worktree_path = ?, updated_at = ? WHERE id = ?`,
  ).run(worktreePath, now, id);
}

/** Stamp a MANUAL task's own sub-contract anchor (set once at claim, after
 *  its contract-gen + contract-review legs). */
export function setDevTaskApprovedHash(
  db: Database.Database,
  id: string,
  approvedHash: string | null,
  now: number,
): void {
  db.prepare(
    `UPDATE dev_session_tasks SET approved_hash = ?, updated_at = ? WHERE id = ?`,
  ).run(approvedHash, now, id);
}

/**
 * CAS failed/dep_failed → queued for `!resume`: zero the per-task loop
 * checkpoint (fresh stop-heuristic window), bump the task resume counter,
 * clear the worker anchors (branch / worktree_path / base_ref — the runner
 * renames a surviving branch to a seed first) and loop_state / fail_reason.
 * Keeps started_at (first claim time), cost_usd (spend is cumulative),
 * merge_retries, seed_branch and plan_review — mirror of resetDevTaskForRedo
 * with a resume posture. Returns null on a CAS miss.
 */
export function requeueDevTaskForResume(
  db: Database.Database,
  input: { id: string; at: number },
): DevTaskRow | null {
  const result = db
    .prepare(
      `UPDATE dev_session_tasks
          SET state = 'queued',
              resumes = resumes + 1,
              iteration = 0,
              agent_failures = 0,
              gate_revise_count = 0,
              iter_revise_count = 0,
              branch = NULL,
              worktree_path = NULL,
              base_ref = NULL,
              loop_state = NULL,
              fail_reason = NULL,
              updated_at = ?
        WHERE id = ? AND state IN ('failed', 'dep_failed')`,
    )
    .run(input.at, input.id);
  return result.changes > 0 ? getDevTask(db, input.id) : null;
}

// ── DAG surgery ─────────────────────────────────────────────────────────

/**
 * After a decompose replaces task `oldKey` with sink tasks, rewire every
 * QUEUED task whose depends_on contains `oldKey`: drop `oldKey`, keep the
 * remaining deps in order (deduped), then append `sinkKeys` in the given
 * order (skipping keys already present). Only queued rows are touched —
 * anything already running captured its dep set at claim time. One
 * transaction; returns the number of rows rewired.
 */
export function rewireDevTaskDeps(
  db: Database.Database,
  sessionId: string,
  oldKey: string,
  sinkKeys: readonly string[],
  now: number,
): number {
  let rewired = 0;
  const txn = db.transaction(() => {
    const rows = db
      .prepare<[string], { id: string; depends_on: string }>(
        `SELECT id, depends_on FROM dev_session_tasks
          WHERE session_id = ? AND state = 'queued'`,
      )
      .all(sessionId);
    const update = db.prepare(
      `UPDATE dev_session_tasks SET depends_on = ?, updated_at = ? WHERE id = ?`,
    );
    for (const row of rows) {
      const deps = parseJsonStringArray(row.depends_on);
      if (!deps.includes(oldKey)) continue;
      const next: string[] = [];
      for (const dep of deps) {
        if (dep === oldKey) continue;
        if (!next.includes(dep)) next.push(dep);
      }
      for (const sink of sinkKeys) {
        if (!next.includes(sink)) next.push(sink);
      }
      update.run(JSON.stringify(next), now, row.id);
      rewired += 1;
    }
  });
  txn();
  return rewired;
}
