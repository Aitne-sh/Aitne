/**
 * Dev-session row store — the development-mode plan §1.
 *
 * I/O-bound CRUD over `dev_sessions` (+ the child `dev_session_iterations`
 * and `dev_session_requirements`). The outer lifecycle state machine is
 * enforced here via the CHECK constraint on the `state` column (closed set)
 * plus the per-transition CAS helpers — `markDevAwaitingApproval`,
 * `approveDevSession`, `markDevAwaitingUser`, `markDevRunningFromParked`,
 * `markDevTerminal` — each one's WHERE clause refuses an out-of-order write
 * so a race between two writers (e.g. the loop engine and a `!exit`) cannot
 * flip a row backwards.
 *
 * `dev_sessions` is the durable state authority: the loop-kit run-checkpoint
 * fields (`iteration`, counters, `cost_usd`) are persisted at the top of
 * every iteration so a daemon restart resumes rather than restarts. The
 * per-repo `.aitne-dev/` working dir is the model-and-evaluator shared
 * memory; this table is the boot-resume + dashboard + singleton-guard surface.
 *
 * SQL wrapper only — excluded from the coverage gate, same posture as
 * `background-task-store.ts`. The escalation store is a sibling module
 * (`dev-session-escalations-store.ts`), cloned from the clarifications store.
 */

import type Database from "better-sqlite3";

export type DevSessionState =
  | "interview"
  | "awaiting_approval"
  | "running"
  | "awaiting_user"
  | "done"
  | "exited"
  | "failed";

/** loop-kit's named inner stop states (the loop verdict). */
export type DevSessionLoopState =
  | "SUCCESS"
  | "NO_OP"
  | "NEEDS_SPEC_DECISION"
  | "NEEDS_ARCHITECTURE_DECISION"
  | "RISK_REQUIRES_APPROVAL"
  | "BLOCKED"
  | "STALLED"
  | "BUDGET_EXCEEDED";

export type DevSessionTerminalState = "done" | "exited" | "failed";

export const DEV_SESSION_NON_TERMINAL_STATES: ReadonlySet<DevSessionState> =
  new Set(["interview", "awaiting_approval", "running", "awaiting_user"]);

/** REQ-ledger status tokens (mirror requirements-ledger.md). */
export type DevRequirementStatus =
  | "unstarted"
  | "in_progress"
  | "met"
  | "at_risk"
  | "regressed";

/** One loop leg (native journal.jsonl). decompose…merge are dev-flow fleet
 *  phases; baseline/rollback/contract_review/resume/contract_gen are the
 *  DEV_MODE_GIT_HARDENING additions (baseline-verify snapshot, !rollback
 *  audit rows, the independent contract-review leg, !resume / RUN_ABEND
 *  journal rows, and a manual task's sub-contract generation). */
export type DevIterationPhase =
  | "plan"
  | "implement"
  | "evaluate"
  | "review"
  | "stop_eval"
  | "gate"
  | "evidence"
  | "decompose"
  | "decompose_review"
  | "supervise"
  | "plan_review"
  | "merge"
  | "baseline"
  | "rollback"
  | "contract_review"
  | "resume"
  | "contract_gen";

export interface DevSessionRow {
  id: string;
  repositoryId: string;
  slug: string | null;
  branch: string | null;
  baseRef: string | null;
  /** Branch the owner's checkout was on BEFORE `checkout -B` at !approve;
   *  null = detached HEAD at approve (or a pre-0029 session). */
  originalBranch: string | null;
  /** HEAD sha before the branch switch — the whole-session rollback target. */
  originalHead: string | null;
  /** Sha of the pre-loop baseline snapshot commit IFF it swept in dirty owner
   *  WIP (!rollback re-applies it); null = the tree was clean at approve. */
  wipSnapshotRef: string | null;
  state: DevSessionState;
  loopState: DevSessionLoopState | null;
  approvedHash: string | null;
  approvedAt: number | null;
  /** Epoch-ms when the baseline-verify pass completed; null = fresh run
   *  pending (the fresh-vs-resume discriminator). */
  baselineVerifiedAt: number | null;
  iteration: number;
  agentFailures: number;
  gateReviseCount: number;
  iterReviseCount: number;
  resumes: number;
  /** Crash/terminal-resume counter (loop-kit RESUME_COUNT); reset to 0 after
   *  any evaluated iteration. Separate from `resumes` (escalation answers). */
  runResumes: number;
  /** Cumulative fleet-mutation counters — replan / plan-review /
   *  integration-fixup budgets are enforced against these. */
  replanCount: number;
  planReviewCount: number;
  fixupCount: number;
  maxIterations: number | null;
  /** Approved stop conditions (verifyCommands, deniedPaths, …). */
  config: Record<string, unknown> | null;
  /** Per-role model routing; null falls back to dev.session defaults. */
  models: Record<string, unknown> | null;
  costUsd: number | null;
  maxBudgetUsd: number | null;
  timeoutScheduleId: number | null;
  originatingPlatform: string | null;
  originatingChannel: string | null;
  /** Epoch-ms of a whole-session !rollback; non-null rows drop out of the
   *  rollback/resume target lookups. */
  rolledBackAt: number | null;
  createdAt: number;
  enteredAt: number;
  updatedAt: number;
  exitedAt: number | null;
}

interface DevSessionDbRow {
  id: string;
  repository_id: string;
  slug: string | null;
  branch: string | null;
  base_ref: string | null;
  original_branch: string | null;
  original_head: string | null;
  wip_snapshot_ref: string | null;
  state: DevSessionState;
  loop_state: DevSessionLoopState | null;
  approved_hash: string | null;
  approved_at: number | null;
  baseline_verified_at: number | null;
  iteration: number;
  agent_failures: number;
  gate_revise_count: number;
  iter_revise_count: number;
  resumes: number;
  run_resumes: number;
  replan_count: number;
  plan_review_count: number;
  fixup_count: number;
  max_iterations: number | null;
  config_json: string | null;
  models_json: string | null;
  cost_usd: number | null;
  max_budget_usd: number | null;
  timeout_schedule_id: number | null;
  originating_platform: string | null;
  originating_channel: string | null;
  rolled_back_at: number | null;
  created_at: number;
  entered_at: number;
  updated_at: number;
  exited_at: number | null;
}

const SELECT_COLUMNS = `
  id, repository_id, slug, branch, base_ref, original_branch, original_head,
  wip_snapshot_ref, state, loop_state,
  approved_hash, approved_at, baseline_verified_at, iteration, agent_failures,
  gate_revise_count, iter_revise_count, resumes, run_resumes,
  replan_count, plan_review_count, fixup_count,
  max_iterations, config_json, models_json,
  cost_usd, max_budget_usd, timeout_schedule_id, originating_platform,
  originating_channel, rolled_back_at, created_at, entered_at, updated_at,
  exited_at
`;

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function fromDbRow(row: DevSessionDbRow): DevSessionRow {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    slug: row.slug,
    branch: row.branch,
    baseRef: row.base_ref,
    originalBranch: row.original_branch,
    originalHead: row.original_head,
    wipSnapshotRef: row.wip_snapshot_ref,
    state: row.state,
    loopState: row.loop_state,
    approvedHash: row.approved_hash,
    approvedAt: row.approved_at,
    baselineVerifiedAt: row.baseline_verified_at,
    iteration: row.iteration,
    agentFailures: row.agent_failures,
    gateReviseCount: row.gate_revise_count,
    iterReviseCount: row.iter_revise_count,
    resumes: row.resumes,
    runResumes: row.run_resumes,
    replanCount: row.replan_count,
    planReviewCount: row.plan_review_count,
    fixupCount: row.fixup_count,
    maxIterations: row.max_iterations,
    config: parseJsonObject(row.config_json),
    models: parseJsonObject(row.models_json),
    costUsd: row.cost_usd,
    maxBudgetUsd: row.max_budget_usd,
    timeoutScheduleId: row.timeout_schedule_id,
    originatingPlatform: row.originating_platform,
    originatingChannel: row.originating_channel,
    rolledBackAt: row.rolled_back_at,
    createdAt: row.created_at,
    enteredAt: row.entered_at,
    updatedAt: row.updated_at,
    exitedAt: row.exited_at,
  };
}

// ── Session CRUD ────────────────────────────────────────────────────────

export interface CreateDevSessionInput {
  id: string;
  repositoryId: string;
  slug: string | null;
  originatingPlatform: string | null;
  originatingChannel: string | null;
  /** epoch-ms; also seeds entered_at + updated_at. */
  createdAt: number;
}

/** Insert a fresh session in the 'interview' state. */
export function createDevSession(
  db: Database.Database,
  input: CreateDevSessionInput,
): DevSessionRow {
  db.prepare(
    `INSERT INTO dev_sessions
       (id, repository_id, slug, state, originating_platform,
        originating_channel, created_at, entered_at, updated_at)
     VALUES (?, ?, ?, 'interview', ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.repositoryId,
    input.slug,
    input.originatingPlatform,
    input.originatingChannel,
    input.createdAt,
    input.createdAt,
    input.createdAt,
  );
  const row = getDevSession(db, input.id);
  if (!row) {
    throw new Error(`createDevSession: post-insert row for ${input.id} missing`);
  }
  return row;
}

export function getDevSession(
  db: Database.Database,
  id: string,
): DevSessionRow | null {
  const row = db
    .prepare<[string], DevSessionDbRow>(
      `SELECT ${SELECT_COLUMNS} FROM dev_sessions WHERE id = ?`,
    )
    .get(id);
  return row ? fromDbRow(row) : null;
}

/**
 * The single active session, if any (singleton invariant — at most one
 * non-terminal row). Newest-first so a boot after a crash picks the most
 * recent. The D5 singleton is enforced by `!repo`'s synchronous
 * check-then-insert (this read guards that insert): getActiveDevSession +
 * createDevSession run with no `await` between them, so on Node's single
 * thread a second concurrent `!repo` observes the first row and refuses. Note
 * the `runtime_state` latch (`current_dev_mode`) is a single overwriting
 * pointer, NOT the guard — this read is. `ORDER BY created_at DESC LIMIT 1`
 * is defensive against a transient >1 non-terminal row (e.g. a prior crash).
 */
export function getActiveDevSession(db: Database.Database): DevSessionRow | null {
  const row = db
    .prepare<[], DevSessionDbRow>(
      `SELECT ${SELECT_COLUMNS} FROM dev_sessions
        WHERE state IN ('interview', 'awaiting_approval', 'running', 'awaiting_user')
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get();
  return row ? fromDbRow(row) : null;
}

/** All non-terminal sessions — the boot re-dispatch sweep. */
export function listNonTerminalDevSessions(
  db: Database.Database,
): readonly DevSessionRow[] {
  const rows = db
    .prepare<[], DevSessionDbRow>(
      `SELECT ${SELECT_COLUMNS} FROM dev_sessions
        WHERE state IN ('interview', 'awaiting_approval', 'running', 'awaiting_user')
        ORDER BY created_at DESC`,
    )
    .all();
  return rows.map(fromDbRow);
}

export interface ListDevSessionsOptions {
  repositoryId?: string;
  states?: readonly DevSessionState[];
  limit?: number;
  offset?: number;
}

export function listDevSessions(
  db: Database.Database,
  options: ListDevSessionsOptions = {},
): readonly DevSessionRow[] {
  const { repositoryId, states, limit = 50, offset = 0 } = options;
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (repositoryId) {
    where.push(`repository_id = ?`);
    params.push(repositoryId);
  }
  if (states && states.length > 0) {
    where.push(`state IN (${states.map(() => "?").join(", ")})`);
    params.push(...states);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare<unknown[], DevSessionDbRow>(
      `SELECT ${SELECT_COLUMNS} FROM dev_sessions
       ${clause}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
  return rows.map(fromDbRow);
}

// ── Interview → contract authoring ──────────────────────────────────────

export interface DevConfigUpdate {
  slug?: string | null;
  config?: Record<string, unknown> | null;
  models?: Record<string, unknown> | null;
  maxBudgetUsd?: number | null;
}

/**
 * Persist the interview's product-contract config (stop conditions, model
 * routing) onto the row. Kept separate from the state transition so the DM
 * agent can iterate on the contract before the loop summary is sent.
 */
export function updateDevSessionConfig(
  db: Database.Database,
  id: string,
  update: DevConfigUpdate,
  updatedAt: number,
): DevSessionRow | null {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (update.slug !== undefined) {
    sets.push(`slug = ?`);
    params.push(update.slug);
  }
  if (update.config !== undefined) {
    sets.push(`config_json = ?`);
    params.push(update.config ? JSON.stringify(update.config) : null);
  }
  if (update.models !== undefined) {
    sets.push(`models_json = ?`);
    params.push(update.models ? JSON.stringify(update.models) : null);
  }
  if (update.maxBudgetUsd !== undefined) {
    sets.push(`max_budget_usd = ?`);
    params.push(update.maxBudgetUsd);
  }
  if (sets.length === 0) return getDevSession(db, id);
  sets.push(`updated_at = ?`);
  params.push(updatedAt);
  const result = db
    .prepare(`UPDATE dev_sessions SET ${sets.join(", ")} WHERE id = ?`)
    .run(...params, id);
  return result.changes > 0 ? getDevSession(db, id) : null;
}

// ── State-machine CAS transitions ───────────────────────────────────────

/** interview → awaiting_approval (loop summary sent). */
export function markDevAwaitingApproval(
  db: Database.Database,
  id: string,
  updatedAt: number,
): DevSessionRow | null {
  const result = db
    .prepare(
      `UPDATE dev_sessions
          SET state = 'awaiting_approval', updated_at = ?
        WHERE id = ? AND state = 'interview'`,
    )
    .run(updatedAt, id);
  return result.changes > 0 ? getDevSession(db, id) : null;
}

export interface ApproveDevSessionInput {
  id: string;
  approvedHash: string;
  branch: string;
  baseRef: string;
  /** The owner's checkout BEFORE `checkout -B` (rollback anchors); null/
   *  omitted = detached HEAD / zero-commit repo (rollback then refuses). */
  originalBranch?: string | null;
  originalHead?: string | null;
  /** The pre-loop snapshot commit IFF it swept in dirty owner WIP. */
  wipSnapshotRef?: string | null;
  maxIterations: number;
  maxBudgetUsd: number | null;
  approvedAt: number;
}

/**
 * awaiting_approval → running, stamping the immutability anchor + the run
 * baseline in one CAS transition (the loop-kit APPROVE gate). Idempotent —
 * a second !approve CAS-misses and returns null.
 */
export function approveDevSession(
  db: Database.Database,
  input: ApproveDevSessionInput,
): DevSessionRow | null {
  const result = db
    .prepare(
      `UPDATE dev_sessions
          SET state = 'running',
              approved_hash = ?,
              branch = ?,
              base_ref = ?,
              original_branch = ?,
              original_head = ?,
              wip_snapshot_ref = ?,
              max_iterations = ?,
              -- Authoritative from config.maxCostUsd (③ per-process cap):
              -- NULL means "off", which must be writable, so a direct SET (not
              -- COALESCE, which could preserve a stale prior cap).
              max_budget_usd = ?,
              approved_at = ?,
              updated_at = ?
        WHERE id = ? AND state = 'awaiting_approval'`,
    )
    .run(
      input.approvedHash,
      input.branch,
      input.baseRef,
      input.originalBranch ?? null,
      input.originalHead ?? null,
      input.wipSnapshotRef ?? null,
      input.maxIterations,
      input.maxBudgetUsd,
      input.approvedAt,
      input.approvedAt,
      input.id,
    );
  return result.changes > 0 ? getDevSession(db, input.id) : null;
}

/** running → awaiting_user (the loop parked on a critical question). */
export function markDevAwaitingUser(
  db: Database.Database,
  id: string,
  updatedAt: number,
): DevSessionRow | null {
  const result = db
    .prepare(
      `UPDATE dev_sessions
          SET state = 'awaiting_user', updated_at = ?
        WHERE id = ? AND state = 'running'`,
    )
    .run(updatedAt, id);
  return result.changes > 0 ? getDevSession(db, id) : null;
}

/** awaiting_user → running (the owner answered; resume from checkpoint). */
export function markDevRunningFromParked(
  db: Database.Database,
  id: string,
  updatedAt: number,
): DevSessionRow | null {
  const result = db
    .prepare(
      `UPDATE dev_sessions
          SET state = 'running', updated_at = ?
        WHERE id = ? AND state = 'awaiting_user'`,
    )
    .run(updatedAt, id);
  return result.changes > 0 ? getDevSession(db, id) : null;
}

export interface DevTerminalInput {
  id: string;
  state: DevSessionTerminalState;
  /** The inner loop verdict, when the loop reached one. */
  loopState?: DevSessionLoopState | null;
  exitedAt: number;
}

/**
 * Any non-terminal state → terminal (done/exited/failed), recording the
 * loop verdict atomically. Idempotent — re-running on a terminal row
 * CAS-misses and returns null.
 */
export function markDevTerminal(
  db: Database.Database,
  input: DevTerminalInput,
): DevSessionRow | null {
  const result = db
    .prepare(
      `UPDATE dev_sessions
          SET state = ?,
              loop_state = COALESCE(?, loop_state),
              exited_at = ?,
              updated_at = ?
        WHERE id = ?
          AND state IN ('interview', 'awaiting_approval', 'running', 'awaiting_user')`,
    )
    .run(
      input.state,
      input.loopState ?? null,
      input.exitedAt,
      input.exitedAt,
      input.id,
    );
  return result.changes > 0 ? getDevSession(db, input.id) : null;
}

// ── Run-checkpoint + telemetry (persisted at the top of every iteration) ─

export interface DevCheckpointInput {
  id: string;
  iteration: number;
  agentFailures: number;
  gateReviseCount: number;
  iterReviseCount: number;
  resumes: number;
}

/** Persist the loop-kit run-checkpoint counters. State is untouched. */
export function writeDevCheckpoint(
  db: Database.Database,
  input: DevCheckpointInput,
  updatedAt: number,
): void {
  db.prepare(
    `UPDATE dev_sessions
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
    updatedAt,
    input.id,
  );
}

/** Accumulate one leg's USD onto the session rollup. No-op for a
 *  zero/negative delta so a costless bail never fabricates a 0 rollup. */
export function addDevSessionCost(
  db: Database.Database,
  id: string,
  deltaUsd: number,
): void {
  if (!(deltaUsd > 0)) return;
  db.prepare(
    `UPDATE dev_sessions
        SET cost_usd = COALESCE(cost_usd, 0) + ?
      WHERE id = ?`,
  ).run(deltaUsd, id);
}

/** Column allowlist for bumpDevSessionFleetCounter — the counter name is
 *  interpolated into SQL, so it MUST be validated against this literal set
 *  first (never trust the compile-time type alone across a JS boundary). */
const DEV_FLEET_COUNTERS: ReadonlySet<string> = new Set([
  "replan_count",
  "plan_review_count",
  "fixup_count",
]);

/**
 * Bump one cumulative fleet-mutation counter (replan / plan-review /
 * integration-fixup) by `delta` and return the new value. The counters
 * only ever go up — budget checks compare them against the contract caps.
 */
export function bumpDevSessionFleetCounter(
  db: Database.Database,
  id: string,
  counter: "replan_count" | "plan_review_count" | "fixup_count",
  delta: number,
  now: number,
): number {
  if (!DEV_FLEET_COUNTERS.has(counter)) {
    throw new Error(
      `bumpDevSessionFleetCounter: unknown counter ${JSON.stringify(counter)}`,
    );
  }
  db.prepare(
    `UPDATE dev_sessions
        SET ${counter} = ${counter} + ?, updated_at = ?
      WHERE id = ?`,
  ).run(delta, now, id);
  const row = db
    .prepare<[string], { n: number }>(
      `SELECT ${counter} AS n FROM dev_sessions WHERE id = ?`,
    )
    .get(id);
  return row?.n ?? 0;
}

/** Arm/clear the FK to the 30-min inactivity-timeout schedule row. */
export function setDevTimeoutScheduleId(
  db: Database.Database,
  id: string,
  scheduleId: number | null,
): void {
  db.prepare(
    `UPDATE dev_sessions SET timeout_schedule_id = ? WHERE id = ?`,
  ).run(scheduleId, id);
}

// ── Iterations (native journal.jsonl) ───────────────────────────────────

export interface DevIterationRow {
  id: string;
  sessionId: string;
  /** The task-DAG node this leg ran under; null = session-level leg. */
  taskId: string | null;
  iteration: number;
  phase: DevIterationPhase;
  verdict: string | null;
  reason: string | null;
  costUsd: number | null;
  commitSha: string | null;
  /** True once a later `!rollback <n>` superseded this row (audit trail;
   *  excluded from checkpoint/commit lookups). Inserted rows are always 0. */
  superseded: boolean;
  createdAt: number;
}

interface DevIterationDbRow {
  id: string;
  session_id: string;
  task_id: string | null;
  iteration: number;
  phase: DevIterationPhase;
  verdict: string | null;
  reason: string | null;
  cost_usd: number | null;
  commit_sha: string | null;
  superseded: number;
  created_at: number;
}

export interface RecordDevIterationInput {
  id: string;
  sessionId: string;
  /** Omitted/null = session-level leg (plan / plan_review / evidence …). */
  taskId?: string | null;
  iteration: number;
  phase: DevIterationPhase;
  verdict?: string | null;
  reason?: string | null;
  costUsd?: number | null;
  commitSha?: string | null;
  createdAt: number;
}

export function recordDevIteration(
  db: Database.Database,
  input: RecordDevIterationInput,
): void {
  db.prepare(
    `INSERT INTO dev_session_iterations
       (id, session_id, task_id, iteration, phase, verdict, reason, cost_usd,
        commit_sha, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.sessionId,
    input.taskId ?? null,
    input.iteration,
    input.phase,
    input.verdict ?? null,
    input.reason ?? null,
    input.costUsd ?? null,
    input.commitSha ?? null,
    input.createdAt,
  );
}

export function listDevIterations(
  db: Database.Database,
  sessionId: string,
): readonly DevIterationRow[] {
  const rows = db
    .prepare<[string], DevIterationDbRow>(
      `SELECT id, session_id, task_id, iteration, phase, verdict, reason,
              cost_usd, commit_sha, superseded, created_at
         FROM dev_session_iterations
        WHERE session_id = ?
        ORDER BY created_at ASC`,
    )
    .all(sessionId);
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    iteration: row.iteration,
    phase: row.phase,
    verdict: row.verdict,
    reason: row.reason,
    costUsd: row.cost_usd,
    commitSha: row.commit_sha,
    superseded: row.superseded === 1,
    createdAt: row.created_at,
  }));
}

// ── Rollback / resume support (DEV_MODE_GIT_HARDENING) ──────────────────

/** Stamp the baseline-verify completion: advance base_ref past the baseline
 *  snapshot commit and set the fresh-vs-resume discriminator. */
export function setDevSessionBaselineDone(
  db: Database.Database,
  input: { id: string; baseRef: string; verifiedAt: number },
): void {
  db.prepare(
    `UPDATE dev_sessions
        SET base_ref = ?, baseline_verified_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(input.baseRef, input.verifiedAt, input.verifiedAt, input.id);
}

/** Ancestry-degradation path: the recorded base is no longer an ancestor of
 *  HEAD (history rewrite), so the review base falls back to HEAD. */
export function updateDevSessionBaseRef(
  db: Database.Database,
  id: string,
  baseRef: string,
  updatedAt: number,
): void {
  db.prepare(
    `UPDATE dev_sessions SET base_ref = ?, updated_at = ? WHERE id = ?`,
  ).run(baseRef, updatedAt, id);
}

/** Mark a whole-session rollback — the session drops out of the rollback /
 *  resume target lookups. */
export function markDevSessionRolledBack(
  db: Database.Database,
  input: { id: string; at: number },
): void {
  db.prepare(
    `UPDATE dev_sessions SET rolled_back_at = ?, updated_at = ? WHERE id = ?`,
  ).run(input.at, input.at, input.id);
}

/** The newest session whose branch exists and that has not already been
 *  rolled back — the `!rollback` target when no session is active. */
export function getLatestRollbackableDevSession(
  db: Database.Database,
): DevSessionRow | null {
  const row = db
    .prepare<[], DevSessionDbRow>(
      `SELECT ${SELECT_COLUMNS} FROM dev_sessions
        WHERE branch IS NOT NULL AND rolled_back_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get();
  return row ? fromDbRow(row) : null;
}

/** The newest session bound to a chat channel ("<platform>:<channel>") — the
 *  `!resume` / `!status` / `!add` target resolution when none is active. */
export function getLatestDevSessionForChannel(
  db: Database.Database,
  channel: string,
): DevSessionRow | null {
  const row = db
    .prepare<[string], DevSessionDbRow>(
      `SELECT ${SELECT_COLUMNS} FROM dev_sessions
        WHERE originating_channel = ?
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(channel);
  return row ? fromDbRow(row) : null;
}

/** The post-iteration commit for `!rollback <n>`: the newest non-superseded
 *  session-level evaluate row at iteration n that carries a commit sha. */
export function latestEvaluateCommitFor(
  db: Database.Database,
  sessionId: string,
  iteration: number,
): string | null {
  const row = db
    .prepare<[string, number], { commit_sha: string }>(
      `SELECT commit_sha FROM dev_session_iterations
        WHERE session_id = ? AND iteration = ? AND task_id IS NULL
          AND phase = 'evaluate' AND superseded = 0 AND commit_sha IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(sessionId, iteration);
  return row?.commit_sha ?? null;
}

/** Flag every session-level journal row past iteration n as superseded by a
 *  rollback (kept — never deleted). Returns the number of rows flagged. */
export function supersedeDevIterationsAfter(
  db: Database.Database,
  sessionId: string,
  iteration: number,
): number {
  return db
    .prepare(
      `UPDATE dev_session_iterations
          SET superseded = 1
        WHERE session_id = ? AND task_id IS NULL AND iteration > ?
          AND superseded = 0`,
    )
    .run(sessionId, iteration).changes;
}

/** Pre-ledger-resync wipe for `!rollback <n>`: every REQ row back to
 *  'unstarted' (the restored ledger markdown is then re-synced over this). */
export function resetDevRequirementStatuses(
  db: Database.Database,
  sessionId: string,
  updatedAt: number,
): void {
  db.prepare(
    `UPDATE dev_session_requirements
        SET status = 'unstarted', evidence = NULL, iter = NULL, updated_at = ?
      WHERE session_id = ?`,
  ).run(updatedAt, sessionId);
}

/** CAS terminal (done/exited/failed) → running for `!resume`. Clears the
 *  terminal bookkeeping; the caller owns counter resets + relaunch. */
export function markDevRunningFromTerminal(
  db: Database.Database,
  input: { id: string; at: number },
): DevSessionRow | null {
  const result = db
    .prepare(
      `UPDATE dev_sessions
          SET state = 'running', exited_at = NULL, updated_at = ?
        WHERE id = ? AND state IN ('done', 'exited', 'failed')`,
    )
    .run(input.at, input.id);
  return result.changes > 0 ? getDevSession(db, input.id) : null;
}

/** Fresh stop-heuristic windows for an explicit resume of a BLOCKED/STALLED
 *  run (loop-kit resets stagnation/futile/fingerprints + BOTH revise counters
 *  + the agent-failure streak; the first three are engine-memory here, so
 *  only the persisted counters need zeroing). iteration / cost / base_ref /
 *  resume counters persist. */
export function resetDevSessionStopHeuristics(
  db: Database.Database,
  id: string,
  at: number,
): void {
  db.prepare(
    `UPDATE dev_sessions
        SET agent_failures = 0,
            gate_revise_count = 0,
            iter_revise_count = 0,
            updated_at = ?
      WHERE id = ?`,
  ).run(at, id);
}

/** +1 run_resumes (crash/terminal resume); returns the new value. Persisted
 *  before any recovery side effect so a crash inside the recovery window
 *  still advances the backstop (loop-kit 6967). */
export function bumpDevSessionRunResumes(
  db: Database.Database,
  id: string,
  at: number,
): number {
  db.prepare(
    `UPDATE dev_sessions
        SET run_resumes = run_resumes + 1, updated_at = ?
      WHERE id = ?`,
  ).run(at, id);
  const row = db
    .prepare<[string], { n: number }>(
      `SELECT run_resumes AS n FROM dev_sessions WHERE id = ?`,
    )
    .get(id);
  return row?.n ?? 0;
}

/** Reset run_resumes after any evaluated iteration — benign interrupts during
 *  long legs must not accumulate toward the cap (loop-kit 7181). */
export function clearDevSessionRunResumes(
  db: Database.Database,
  id: string,
  at: number,
): void {
  db.prepare(
    `UPDATE dev_sessions
        SET run_resumes = 0, updated_at = ?
      WHERE id = ? AND run_resumes <> 0`,
  ).run(at, id);
}

/** Budget-only re-approval (loop-kit ckpt_rebind): a raised iteration/cost
 *  cap re-anchors the immutability hash WITHOUT a fresh human approval. The
 *  caller MUST have verified (1) the on-disk contract still matches the OLD
 *  hash and (2) computeConfigHashSansBudget is unchanged. */
export function rebindDevSessionApproval(
  db: Database.Database,
  input: {
    id: string;
    approvedHash: string;
    maxIterations: number;
    maxBudgetUsd: number | null;
    at: number;
  },
): void {
  db.prepare(
    `UPDATE dev_sessions
        SET approved_hash = ?,
            max_iterations = ?,
            max_budget_usd = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(
    input.approvedHash,
    input.maxIterations,
    input.maxBudgetUsd,
    input.at,
    input.id,
  );
}

// ── Requirements ledger ─────────────────────────────────────────────────

export interface DevRequirementRow {
  id: string;
  sessionId: string;
  reqId: string;
  title: string | null;
  status: DevRequirementStatus;
  evidence: string | null;
  iter: number | null;
  updatedAt: number;
}

interface DevRequirementDbRow {
  id: string;
  session_id: string;
  req_id: string;
  title: string | null;
  status: DevRequirementStatus;
  evidence: string | null;
  iter: number | null;
  updated_at: number;
}

export interface SeedDevRequirementInput {
  id: string;
  reqId: string;
  title: string | null;
}

/**
 * Seed the REQ ledger from the approved contract's REQ- headings (loop-kit
 * bootstrap_requirements_ledger). Idempotent per (session, req_id) via the
 * unique index — a re-seed leaves existing rows (and their progress) intact.
 */
export function seedDevRequirements(
  db: Database.Database,
  sessionId: string,
  requirements: readonly SeedDevRequirementInput[],
  now: number,
): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO dev_session_requirements
       (id, session_id, req_id, title, status, updated_at)
     VALUES (?, ?, ?, ?, 'unstarted', ?)`,
  );
  const txn = db.transaction(() => {
    for (const req of requirements) {
      insert.run(req.id, sessionId, req.reqId, req.title, now);
    }
  });
  txn();
}

export function listDevRequirements(
  db: Database.Database,
  sessionId: string,
): readonly DevRequirementRow[] {
  const rows = db
    .prepare<[string], DevRequirementDbRow>(
      `SELECT id, session_id, req_id, title, status, evidence, iter, updated_at
         FROM dev_session_requirements
        WHERE session_id = ?
        ORDER BY req_id ASC`,
    )
    .all(sessionId);
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    reqId: row.req_id,
    title: row.title,
    status: row.status,
    evidence: row.evidence,
    iter: row.iter,
    updatedAt: row.updated_at,
  }));
}

export interface UpdateDevRequirementInput {
  sessionId: string;
  reqId: string;
  status: DevRequirementStatus;
  evidence?: string | null;
  iter?: number | null;
  updatedAt: number;
}

/** Update one REQ row's status/evidence (the implement/review legs report
 *  progress through this). Returns false if the (session, req_id) is absent. */
export function updateDevRequirement(
  db: Database.Database,
  input: UpdateDevRequirementInput,
): boolean {
  const result = db
    .prepare(
      `UPDATE dev_session_requirements
          SET status = ?,
              evidence = COALESCE(?, evidence),
              iter = COALESCE(?, iter),
              updated_at = ?
        WHERE session_id = ? AND req_id = ?`,
    )
    .run(
      input.status,
      input.evidence ?? null,
      input.iter ?? null,
      input.updatedAt,
      input.sessionId,
      input.reqId,
    );
  return result.changes > 0;
}

export interface DevRequirementCounts {
  total: number;
  met: number;
}

/** "4/5 REQ met" — the chat digest + gate summary. */
export function countDevRequirements(
  db: Database.Database,
  sessionId: string,
): DevRequirementCounts {
  const row = db
    .prepare<[string], { total: number; met: number }>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN status = 'met' THEN 1 ELSE 0 END), 0) AS met
         FROM dev_session_requirements
        WHERE session_id = ?`,
    )
    .get(sessionId);
  return { total: row?.total ?? 0, met: row?.met ?? 0 };
}

/** countDevRequirements scoped to a task's claimed REQ ids (dev-flow: the
 *  per-task gate only reasons over the reqs the task owns). Unseeded ids
 *  simply don't count toward total. Empty list → {0, 0}. */
export function countDevRequirementsIn(
  db: Database.Database,
  sessionId: string,
  reqIds: readonly string[],
): DevRequirementCounts {
  if (reqIds.length === 0) return { total: 0, met: 0 };
  const placeholders = reqIds.map(() => "?").join(", ");
  const row = db
    .prepare<(string | number)[], { total: number; met: number }>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN status = 'met' THEN 1 ELSE 0 END), 0) AS met
         FROM dev_session_requirements
        WHERE session_id = ? AND req_id IN (${placeholders})`,
    )
    .get(sessionId, ...reqIds);
  return { total: row?.total ?? 0, met: row?.met ?? 0 };
}
