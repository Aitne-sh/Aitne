/**
 * Development-mode loop engine — domain types.
 *
 * A native TypeScript port of the loop-kit harness (/Users/shuto/Projects/loop):
 * CONTRACT -> APPROVE -> LOOP{plan -> implement -> evaluate -> review ->
 * stop_eval -> commit} -> EVIDENCE. These types describe the loop CONTRACT
 * (the approved goalposts), the machine-checkable STOP CONDITIONS, and the
 * verdict grammar of each leg. They are deliberately backend-neutral and hold
 * no daemon wiring — the engine/legs/runner modules consume them.
 *
 * Terminology mirrors loop-kit: an "iteration" is one implement->evaluate
 * cycle; a "leg" is one model or evaluator call; the deterministic evaluator
 * never trusts a model's self-report.
 */

import type { DevSessionLoopState } from "../../db/dev-sessions-store.js";

// ── The product contract (loop-kit product-contract.md, §4) ─────────────

/** One numbered requirement — the unit of the REQ ledger + gate verdicts. */
export interface DevContractRequirement {
  /** "REQ-001" — heading-derived, sorted-unique, never from prose. */
  id: string;
  /** One-line observable/verifiable behavior. */
  title: string;
  /** Optional fuller body (acceptance detail). */
  body?: string;
}

/**
 * The approved goalposts. Hashed together with the stop conditions at
 * !approve to form the immutability anchor (`dev_sessions.approved_hash`).
 */
export interface DevContract {
  /** One outcome-focused paragraph. */
  goal: string;
  /** Numbered REQ-### requirements (the parallel/verification unit). */
  requirements: DevContractRequirement[];
  /** Explicit exclusions (scope-creep guard). */
  nonGoals: string[];
  /** Invariants the reviewer enforces (never file-scope — that is deniedPaths). */
  constraints: string[];
  /** Checkable statements the evidence report must demonstrate. */
  acceptanceCriteria: string[];
  /** Human-readable mirror of the machine verifyCommands. */
  validationCommands: string[];
  /** The mid-run escalation bar — conditions that STOP for the human. */
  humanApprovalIf: string[];
  /** Auto/interview assumptions recorded during CONTRACT. */
  assumptions?: string[];
}

// ── Stop conditions (loop-kit loop.config.sh, §3) ───────────────────────

export type DevReviewMode = "always" | "candidate" | "off";
export type DevPermissionMode = "acceptEdits" | "auto" | "bypassPermissions";

/**
 * The machine-checkable stop conditions. Every field mirrors a loop.config.sh
 * variable; the defaults mirror loop-kit's `load_config`. `verifyCommands` is
 * the ONLY path to SUCCESS and has no default — an approved config with an
 * empty list is refused (fail-closed, never a vacuous pass).
 */
export interface DevLoopConfig {
  /** Deterministic success gate — ALL must exit 0 (run as a subprocess). */
  verifyCommands: string[];
  /** Globs; a touch → RISK_REQUIRES_APPROVAL. */
  deniedPaths: string[];
  /** Globs (deps/schema/infra); a touch → NEEDS_ARCHITECTURE_DECISION. */
  escalatePaths: string[];
  /** Hard cap on loop iterations. */
  maxIterations: number;
  /** Per-agent-call wall-clock watchdog (seconds). */
  maxIterSeconds: number;
  /** Total per-run wall-clock cap (seconds); 0/undefined = no cap. */
  maxRunSeconds: number | null;
  /** Total USD cap; null = fall back to the process envelope ceiling. */
  maxCostUsd: number | null;
  /** Consecutive no-project-diff iterations → STALLED. */
  stagnationN: number;
  /** Identical verify-failure fingerprint N times → BLOCKED. */
  repeatFailN: number;
  /** Consecutive FUTILE stop-eval verdicts → STALLED. */
  futileN: number;
  /** Consecutive MET stop-evals + verify green → force the gate (0 = never). */
  metForceN: number;
  /** Consecutive reviewer rejections (per counter) → BLOCKED. */
  maxRevisions: number;
  /** always | candidate | off (fleet integration ignores off; N/A in v1). */
  reviewMode: DevReviewMode;
  /** Every Nth interim review widens to the whole-run diff (0 = off). */
  holisticEveryN: number;
  /** Iteration diffs ≥ N changed lines also widen the review (0 = off). */
  holisticTriggerLines: number;
  /** Enable the advisory stop evaluator each iteration. */
  stopEval: boolean;
  /** Passed to the backend for write legs. */
  permissionMode: DevPermissionMode;
  /** Max consecutive resumes that never complete an iteration → BLOCKED. */
  maxResumes: number;
  /** Fleet/flow settings (decompose + parallel worktree execution). */
  flow: DevFlowConfig;
}

/**
 * Fleet/flow stop conditions — the loop-kit fleet.config.sh port. Approved as
 * part of `config_json`, so the whole object lands in the approval hash via
 * `canonicalize` (a flow change after approval is a goalpost move).
 */
export interface DevFlowConfig {
  /** Run the decompose step after approval; false = always the single loop. */
  decompose: boolean;
  /** Concurrent worker slots (FLEET_MAX_PARALLEL). */
  maxParallel: number;
  /** Hard cap on tasks in flight (FLEET_MAX_TASKS). */
  maxTasks: number;
  /** Supervisor decisions per task before parking for the user
   *  (FLEET_MAX_SUPERVISE_PER_TASK). */
  superviseCap: number;
  /** Cumulative replacement-task budget across REPLANs
   *  (FLEET_MAX_REPLAN_TASKS). */
  replanCap: number;
  /** Run the phase-boundary plan review when a merged task has queued
   *  dependents (FLEET_PLAN_REVIEW). */
  planReview: boolean;
  /** Cumulative plan-review REVISE budget (FLEET_MAX_PLAN_REVISIONS). */
  planReviewCap: number;
  /** Integration-gate fix-up rounds before BLOCKED
   *  (FLEET_MAX_INTEGRATION_FIXUPS). */
  integrationFixupCap: number;
  /** Percent of maxIterations after which a fleet worker with unmet REQs gets
   *  the split nudge (SPLIT_NUDGE_AT; 0 = off). */
  splitNudgeAt: number;
  /** Seed a NEEDS_DECOMPOSITION replacement block's unique root with the
   *  escalated task's committed branch (FLEET_SPLIT_CARRYOVER). */
  splitCarryover: boolean;
  /** Command run in a fresh worktree before its loop starts (e.g. installing
   *  gitignored deps so verifyCommands can pass); null = none
   *  (WORKTREE_SETUP_CMD). */
  worktreeSetupCommand: string | null;
}

/** The budget-only keys a resume tolerates without re-approval (loop-kit
 *  config_hash_sans_budget). */
export const DEV_BUDGET_CONFIG_KEYS = [
  "maxIterations",
  "maxCostUsd",
  "maxRunSeconds",
] as const satisfies readonly (keyof DevLoopConfig)[];

// ── Deterministic evaluate verdicts (loop-kit evaluate.sh, §7) ──────────

/**
 * The one-line verdict the deterministic evaluator returns. Highest-trust
 * decision order lives in dev-loop-evaluate.ts. `SUCCESS`/`NO_OP` are only
 * emitted on the FINAL re-check; interim promotion emits `SUCCESS_CANDIDATE`.
 */
export type DevEvaluateState =
  | "SUCCESS_CANDIDATE"
  | "CONTINUE"
  | "SUCCESS"
  | "NO_OP"
  | "NEEDS_SPEC_DECISION"
  | "NEEDS_ARCHITECTURE_DECISION"
  | "NEEDS_DECOMPOSITION"
  | "RISK_REQUIRES_APPROVAL"
  | "BLOCKED"
  | "STALLED";

export interface DevEvaluateResult {
  state: DevEvaluateState;
  reason: string;
  /** Per-VERIFY_COMMANDS pass/fail, for the evidence table + last-verify.log. */
  verify?: DevVerifyResult[];
}

export interface DevVerifyResult {
  command: string;
  exitCode: number;
  passed: boolean;
  /** Truncated combined stdout+stderr for the log/evidence. */
  output: string;
}

// ── Review + stop-eval verdicts (loop-kit §6) ───────────────────────────

export type DevReviewVerdict = "APPROVE" | "REVISE" | "ESCALATE";
export type DevReqVerdict = "MET" | "PARTIAL" | "UNMET" | "REGRESSED" | "MISSING";
export type DevStopEval = "CONTINUE" | "MET" | "FUTILE";

/** One parsed per-REQ gate line: `REQ-NNN: MET|PARTIAL|UNMET|REGRESSED — …`. */
export interface DevReqVerdictLine {
  reqId: string;
  verdict: DevReqVerdict;
  evidence: string;
}

export interface DevReviewResult {
  verdict: DevReviewVerdict;
  /** Free-text summary/question trailing the verdict token. */
  summary: string;
  /** Gate mode only — one line per contract REQ. */
  reqVerdicts?: DevReqVerdictLine[];
}

// ── Escalation mapping (loop-kit stop states → escalation kinds) ────────

/** The subset of loop states that PARK the run for a human answer. */
export type DevEscalationState =
  | "NEEDS_SPEC_DECISION"
  | "NEEDS_ARCHITECTURE_DECISION"
  | "RISK_REQUIRES_APPROVAL";

/** The subset that TERMINATE the run (surfaced, not parked). */
export type DevLoopTerminalState = Extract<
  DevSessionLoopState,
  "SUCCESS" | "NO_OP" | "BLOCKED" | "STALLED" | "BUDGET_EXCEEDED"
>;

export const DEV_ESCALATION_STATES: ReadonlySet<string> = new Set([
  "NEEDS_SPEC_DECISION",
  "NEEDS_ARCHITECTURE_DECISION",
  "RISK_REQUIRES_APPROVAL",
]);
