/**
 * Dashboard-side DTO mirror of the daemon's `GET /api/dev-sessions` response.
 * Kept in sync with `packages/daemon/src/db/dev-sessions-store.ts` +
 * `packages/daemon/src/api/routes/dev-sessions.ts`. Timestamps are epoch-ms
 * numbers (not ISO strings).
 */

export type DevSessionState =
  | "interview"
  | "awaiting_approval"
  | "running"
  | "awaiting_user"
  | "done"
  | "exited"
  | "failed";

export type DevSessionLoopState =
  | "SUCCESS"
  | "NO_OP"
  | "NEEDS_SPEC_DECISION"
  | "NEEDS_ARCHITECTURE_DECISION"
  | "RISK_REQUIRES_APPROVAL"
  | "BLOCKED"
  | "STALLED"
  | "BUDGET_EXCEEDED";

export type DevRequirementStatus =
  | "unstarted"
  | "in_progress"
  | "met"
  | "at_risk"
  | "regressed";

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

export type DevTaskLoopState = DevSessionLoopState | "NEEDS_DECOMPOSITION";
export type DevTaskOrigin = "plan" | "replan" | "plan_review" | "fixup" | "manual";

/** One DAG node in a fleet run (GET /dev-sessions/:id → tasks[]). */
export interface DevTaskDTO {
  id: string;
  taskKey: string;
  summary: string;
  dependsOn: string[];
  reqs: string[];
  origin: DevTaskOrigin;
  state: DevTaskState;
  loopState: DevTaskLoopState | null;
  branch: string | null;
  iteration: number;
  costUsd: number | null;
  failReason: string | null;
  /** Topological layer index (tasks in one layer may run in parallel). */
  group: number;
  createdAt: number;
  mergedAt: number | null;
}

/** One row in the sessions list (GET /dev-sessions). */
export interface DevSessionSummary {
  id: string;
  repositoryId: string;
  slug: string | null;
  state: DevSessionState;
  loopState: DevSessionLoopState | null;
  branch: string | null;
  iteration: number;
  requirementsMet: number;
  requirementsTotal: number;
  /** Fleet progress; 0 total = a single-loop or not-yet-decomposed run. */
  tasksTotal: number;
  tasksMerged: number;
  costUsd: number | null;
  maxBudgetUsd: number | null;
  createdAt: number;
  updatedAt: number;
  exitedAt: number | null;
}

export interface DevSessionsResponse {
  sessions: DevSessionSummary[];
}

export interface DevIterationDTO {
  id: string;
  sessionId: string;
  taskId: string | null;
  /** The owning task's key, resolved server-side (null for session-level legs). */
  taskKey: string | null;
  iteration: number;
  phase: DevIterationPhase;
  verdict: string | null;
  reason: string | null;
  costUsd: number | null;
  commitSha: string | null;
  createdAt: number;
}

export interface DevRequirementDTO {
  id: string;
  sessionId: string;
  reqId: string;
  title: string | null;
  status: DevRequirementStatus;
  evidence: string | null;
  iter: number | null;
  updatedAt: number;
}

export interface DevEscalationDTO {
  id: string;
  sessionId: string;
  kind: string;
  question: string;
  contextSummary: string | null;
  askedAt: number;
  answer: string | null;
  answeredAt: number | null;
  resolved: boolean;
}

export type DevAcMethod = "cmd" | "run" | "human";
export type DevAcRowStatus = "pending" | "verified" | "failed";

/** One acceptance-checklist row (GET /dev-sessions/:id → checklist[]). */
export interface DevChecklistDTO {
  id: string;
  sessionId: string;
  taskId: string | null;
  /** The owning task's key (null = session-level / master checklist). */
  taskKey: string | null;
  acId: string;
  reqId: string | null;
  expectation: string | null;
  method: DevAcMethod;
  status: DevAcRowStatus;
  evidence: string | null;
  updatedAt: number;
}

/** GET /dev-sessions/:id — the full projection. `session` carries every
 *  DevSessionSummary field plus the daemon's extra columns (approvedHash etc.),
 *  which the page does not need, so it is typed as the summary + a passthrough. */
export interface DevSessionDetailResponse {
  session: DevSessionSummary & Record<string, unknown>;
  tasks: DevTaskDTO[];
  iterations: DevIterationDTO[];
  requirements: DevRequirementDTO[];
  /** Absent on daemons that predate the checklist layer. */
  checklist?: DevChecklistDTO[];
  escalations: DevEscalationDTO[];
}
