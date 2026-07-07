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
  | "evidence";

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

/** GET /dev-sessions/:id — the full projection. `session` carries every
 *  DevSessionSummary field plus the daemon's extra columns (approvedHash etc.),
 *  which the page does not need, so it is typed as the summary + a passthrough. */
export interface DevSessionDetailResponse {
  session: DevSessionSummary & Record<string, unknown>;
  iterations: DevIterationDTO[];
  requirements: DevRequirementDTO[];
  escalations: DevEscalationDTO[];
}
