/**
 * Development-mode loop engine — a native port of loop-kit's run_iteration_loop
 * + run_success_gate. It owns the LOOP LOGIC (implement -> evaluate -> review ->
 * stop-eval -> gate -> evidence), the requirements-ledger sync, and the
 * run-checkpoint bookkeeping. It does NOT own the outer session lifecycle
 * (running / awaiting_user / terminal state transitions, escalation rows,
 * timeout, delivery) — that is the runner's job (dev-mode-runner.ts), which
 * interprets the DevIterationOutcome this engine returns.
 *
 * The model calls are injected as a `DevLegRunner`, so the engine is
 * integration-testable with a fake runner over a real temp git repo + an
 * in-memory db, with no backend/router. I/O-bound (git/fs/db); excluded from
 * the coverage gate — the deterministic decision core it delegates to
 * (dev-loop-evaluate.ts) is separately covered 100%.
 */

import type Database from "better-sqlite3";
import type { BackendModelTier } from "@aitne/shared";
import {
  addDevSessionCost,
  listDevRequirements,
  recordDevIteration,
  updateDevRequirement,
  writeDevCheckpoint,
  countDevRequirements,
  type DevIterationPhase,
  type DevRequirementStatus,
  type DevSessionRow,
  type DevSessionLoopState,
} from "../../db/dev-sessions-store.js";
import type { DevTaskLoopState } from "../../db/dev-session-tasks-store.js";
import type { DevEscalationKind } from "../../db/dev-session-escalations-store.js";
import {
  DEV_DOCS,
  clearAgentState,
  gitCommitAll,
  gitDiffPaths,
  gitHead,
  isWholeRunDiffEmpty,
  parseLedgerMarkdown,
  readAgentStateFirstLine,
  readDevDoc,
  removeDevDoc,
  runVerifyCommand,
  writeDevDoc,
  writeLastVerifyLog,
} from "./dev-loop-docs.js";
import {
  EMPTY_BOOKKEEPING,
  evaluateIteration,
  type DevEvaluateBookkeeping,
} from "./dev-loop-evaluate.js";
import { computeApprovalHash, normalizeDevLoopConfig } from "./dev-loop-config.js";
import { computeSplitNudge } from "./dev-flow-schedule.js";
import { parseAgentStateToken } from "./verdict-parse.js";
import type {
  DevLoopConfig,
  DevReqVerdictLine,
  DevReviewResult,
  DevStopEval,
} from "./types.js";

// ── The injected leg contract (implemented by dev-loop-legs.ts) ─────────

export interface DevLegResponse {
  text: string;
  sessionId: string | null;
  costUsd: number;
  numTurns: number;
  isError: boolean;
}

export interface DevLegContext {
  repoPath: string;
  session: DevSessionRow;
  config: DevLoopConfig;
  iteration: number;
  tier: BackendModelTier;
  /** Live session-wide spend (USD) for the per-call budget clamp — a FLEET
   *  worker must clamp against the shared process total, not its own stale
   *  in-memory mirror. Defaults (undefined) to `session.costUsd`. */
  spentUsd?: number;
}

export interface DevReviewLegContext extends DevLegContext {
  mode: "interim" | "gate";
  /** Whole-run base for a gate/holistic review; the iteration pre-ref for a
   *  scoped interim review. */
  baseRef: string;
  /** The REQ ids the gate downgrade judges. A fleet worker passes only the
   *  task's OWNED reqs (its worktree holds the full master contract for the
   *  hash anchor, but the task must reach SUCCESS on its slice); undefined =
   *  all contract reqs (the single loop + the integration gate). */
  reqIds?: readonly string[];
}

export interface DevReviewLegResult {
  response: DevLegResponse;
  review: DevReviewResult | null;
}

export interface DevLegRunner {
  plan(ctx: DevLegContext): Promise<DevLegResponse>;
  implement(ctx: DevLegContext): Promise<DevLegResponse>;
  review(ctx: DevReviewLegContext): Promise<DevReviewLegResult>;
  stopEval(ctx: DevLegContext): Promise<{ response: DevLegResponse; verdict: DevStopEval | null }>;
  evidence(
    ctx: DevLegContext & { gateReqVerdicts: DevReqVerdictLine[] },
  ): Promise<DevLegResponse>;
}

// ── Outcomes the runner acts on ─────────────────────────────────────────

export type DevIterationOutcome =
  | { kind: "continue" }
  | {
      kind: "escalate";
      escalationKind: DevEscalationKind;
      /** NEEDS_DECOMPOSITION only ever appears for fleet workers — the
       *  orchestrator routes it to the supervisor, never the session row. */
      loopState: DevTaskLoopState;
      question: string;
      contextSummary: string | null;
    }
  | { kind: "terminal"; loopState: DevSessionLoopState; reason: string };

const LOOP_STATE_TO_ESCALATION: Record<string, DevEscalationKind> = {
  NEEDS_SPEC_DECISION: "spec_decision",
  NEEDS_ARCHITECTURE_DECISION: "architecture_decision",
  // A cap-parked split request surfaces to the user as a spec decision.
  NEEDS_DECOMPOSITION: "spec_decision",
  RISK_REQUIRES_APPROVAL: "risk_approval",
};

// ── Persistence seam (session-scoped by default; task-scoped in a fleet) ─

/**
 * Where the engine's durable side effects land. The default routes to the
 * session row + session-level journal (v1 behavior); the fleet orchestrator
 * injects a task-scoped sink that stamps task_id on journal rows, checkpoints
 * the dev_session_tasks row, rolls cost up to BOTH the task and the session,
 * and scopes the ledger/REQ reads to the task's owned REQs.
 */
export interface DevEnginePersistence {
  recordIteration(row: {
    id: string;
    iteration: number;
    phase: DevIterationPhase;
    verdict: string | null;
    reason: string | null;
    costUsd: number | null;
    commitSha: string | null;
    createdAt: number;
  }): void;
  addCost(deltaUsd: number): void;
  writeCheckpoint(
    counters: {
      iteration: number;
      agentFailures: number;
      gateReviseCount: number;
      iterReviseCount: number;
      resumes: number;
    },
    at: number,
  ): void;
  syncLedgerRow(row: {
    reqId: string;
    status: DevRequirementStatus;
    evidence: string | null;
    iter: number | null;
    updatedAt: number;
  }): void;
  requirementCounts(): { total: number; met: number };
  /** REQ ids not yet 'met' — the split-nudge input. */
  unmetReqIds(): string[];
}

/** The v1 session-scoped persistence (journal rows carry task_id NULL). */
export function createSessionEnginePersistence(
  db: Database.Database,
  sessionId: string,
): DevEnginePersistence {
  return {
    recordIteration(row) {
      recordDevIteration(db, { ...row, sessionId });
    },
    addCost(deltaUsd) {
      addDevSessionCost(db, sessionId, deltaUsd);
    },
    writeCheckpoint(counters, at) {
      writeDevCheckpoint(db, { id: sessionId, ...counters }, at);
    },
    syncLedgerRow(row) {
      updateDevRequirement(db, { sessionId, ...row });
    },
    requirementCounts() {
      return countDevRequirements(db, sessionId);
    },
    unmetReqIds() {
      return listDevRequirements(db, sessionId)
        .filter((r) => r.status !== "met")
        .map((r) => r.reqId);
    },
  };
}

export interface DevLoopEngineDeps {
  db: Database.Database;
  repoPath: string;
  legRunner: DevLegRunner;
  tier: BackendModelTier;
  /** Injected clock/id for deterministic tests (no Date.now/randomUUID). */
  now: () => number;
  uuid: () => string;
  /** Defaults to the session-scoped sink; the fleet injects a task sink. */
  persistence?: DevEnginePersistence;
  /** Session-wide spent-USD reader — parallel workers share ONE budget
   *  ceiling. Defaults to the engine's own running cost mirror. */
  getSpentUsd?: () => number;
  /** Present for fleet workers: enables the NEEDS_DECOMPOSITION token and
   *  the deterministic split nudge. */
  fleet?: { taskReqIds: readonly string[] };
  /** Absolute wall-clock deadline (ms, in the injected clock's frame) shared by
   *  a fleet's workers so they all self-terminate at the SAME instant regardless
   *  of when each engine was (re)constructed. Undefined → the single-loop uses
   *  its own construction-time window against config.maxRunSeconds. */
  runDeadlineMs?: number;
}

/**
 * One engine instance per active session run. `session` is the live row; the
 * engine mutates its in-memory checkpoint fields as it goes and persists them
 * via writeDevCheckpoint before each iteration.
 */
export class DevLoopEngine {
  private readonly repoPath: string;
  private readonly legRunner: DevLegRunner;
  private readonly tier: BackendModelTier;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly config: DevLoopConfig;
  private readonly persistence: DevEnginePersistence;
  private readonly getSpentUsd: (() => number) | null;
  private readonly fleet: { taskReqIds: readonly string[] } | null;
  private readonly runDeadlineMs: number | null;

  private session: DevSessionRow;
  /** Wall-clock start of THIS run (loop-kit MAX_RUN_SECONDS; a resume that
   *  constructs a fresh engine gets a fresh window, matching loop-kit). */
  private readonly runStartMs: number;
  private bookkeeping: DevEvaluateBookkeeping = EMPTY_BOOKKEEPING;
  /** Consecutive MET / FUTILE stop-eval verdicts (loop-kit met-count /
   *  futile-count) — drive the forced gate + STALLED. */
  private metStreak = 0;
  private futileStreak = 0;

  constructor(session: DevSessionRow, deps: DevLoopEngineDeps) {
    this.session = session;
    this.repoPath = deps.repoPath;
    this.legRunner = deps.legRunner;
    this.tier = deps.tier;
    this.now = deps.now;
    this.uuid = deps.uuid;
    this.config = normalizeDevLoopConfig(session.config);
    this.persistence =
      deps.persistence ?? createSessionEnginePersistence(deps.db, session.id);
    this.getSpentUsd = deps.getSpentUsd ?? null;
    this.fleet = deps.fleet ?? null;
    this.runStartMs = deps.now();
    this.runDeadlineMs = deps.runDeadlineMs ?? null;
  }

  /** The mutable checkpoint counters (the runner reads these to persist). */
  get iteration(): number {
    return this.session.iteration;
  }

  private legCtx(): DevLegContext {
    return {
      repoPath: this.repoPath,
      session: this.session,
      config: this.config,
      iteration: this.session.iteration,
      tier: this.tier,
      // Fleet workers share one process budget: clamp per-call spend against the
      // LIVE session-wide total (getSpentUsd), not this worker's in-memory
      // mirror which misses concurrent siblings. Single loop → own cost.
      spentUsd: this.getSpentUsd ? this.getSpentUsd() : this.session.costUsd ?? 0,
    };
  }

  private record(
    phase: DevIterationPhase,
    verdict: string | null,
    reason: string | null,
    leg?: DevLegResponse,
    commitSha?: string | null,
  ): void {
    this.persistence.recordIteration({
      id: this.uuid(),
      iteration: this.session.iteration,
      phase,
      verdict,
      reason,
      costUsd: leg?.costUsd ?? null,
      commitSha: commitSha ?? null,
      createdAt: this.now(),
    });
    if (leg && leg.costUsd > 0) {
      this.persistence.addCost(leg.costUsd);
      this.session = { ...this.session, costUsd: (this.session.costUsd ?? 0) + leg.costUsd };
    }
  }

  private persistCheckpoint(): void {
    this.persistence.writeCheckpoint(
      {
        iteration: this.session.iteration,
        agentFailures: this.session.agentFailures,
        gateReviseCount: this.session.gateReviseCount,
        iterReviseCount: this.session.iterReviseCount,
        resumes: this.session.resumes,
      },
      this.now(),
    );
  }

  /** Recompute the immutability anchor from the on-disk contract + config. */
  private currentApprovedHash(): string {
    const contract = readDevDoc(this.repoPath, DEV_DOCS.contract) ?? "";
    return computeApprovalHash(contract, this.config);
  }

  /** Sync the .aitne-dev ledger Markdown into the DB (the evaluator + UI read
   *  the DB; the agent writes the Markdown). */
  private syncLedger(): void {
    const md = readDevDoc(this.repoPath, DEV_DOCS.ledger);
    for (const row of parseLedgerMarkdown(md)) {
      this.persistence.syncLedgerRow({
        reqId: row.reqId,
        status: row.status,
        evidence: row.evidence || null,
        iter: row.iter,
        updatedAt: this.now(),
      });
    }
  }

  private allRequirementsMet(): boolean {
    const { total, met } = this.persistence.requirementCounts();
    return total > 0 && met === total;
  }

  /** Iteration 0 — produce a plan if none exists yet (loop-kit /loop-plan). */
  async ensurePlan(): Promise<void> {
    const plan = readDevDoc(this.repoPath, DEV_DOCS.plan);
    if (plan && plan.trim().length > 0) return;
    const leg = await this.legRunner.plan(this.legCtx());
    const sha = gitCommitAll(this.repoPath, "dev: iteration 0 — plan");
    this.record("plan", leg.isError ? "error" : "ok", null, leg, sha);
  }

  /**
   * Run one full iteration: implement -> deterministic evaluate -> branch to a
   * success gate, or interim review + stop-eval + forced-gate check. Returns
   * the outcome the runner acts on.
   */
  async runIteration(iterationNo: number): Promise<DevIterationOutcome> {
    this.session = { ...this.session, iteration: iterationNo };

    // Budget / iteration-cap guards (loop-kit budget_exceeded). Fleet workers
    // read the SESSION-WIDE rollup so parallel loops share one ceiling.
    if (iterationNo > this.config.maxIterations) {
      return { kind: "terminal", loopState: "BUDGET_EXCEEDED", reason: "Hit the max-iteration cap." };
    }
    const spentUsd = this.getSpentUsd ? this.getSpentUsd() : this.session.costUsd ?? 0;
    if (this.session.maxBudgetUsd !== null && spentUsd >= this.session.maxBudgetUsd) {
      return { kind: "terminal", loopState: "BUDGET_EXCEEDED", reason: "Hit the cost ceiling." };
    }
    // Wall-clock cap. A fleet worker uses the shared absolute deadline (all
    // workers stop together); the single loop uses its own construction-time
    // window against maxRunSeconds.
    const wallClockHit =
      this.runDeadlineMs !== null
        ? this.now() >= this.runDeadlineMs
        : this.config.maxRunSeconds !== null
          && (this.now() - this.runStartMs) / 1000 >= this.config.maxRunSeconds;
    if (wallClockHit) {
      return { kind: "terminal", loopState: "BUDGET_EXCEEDED", reason: "Hit the wall-clock cap for this run." };
    }

    this.persistCheckpoint();
    clearAgentState(this.repoPath);
    // Deterministic budget signal for fleet workers (write_split_nudge port).
    if (this.fleet && this.config.flow.splitNudgeAt > 0) {
      const nudge = computeSplitNudge({
        iteration: iterationNo,
        maxIterations: this.config.maxIterations,
        splitNudgeAt: this.config.flow.splitNudgeAt,
        unmetReqIds: this.persistence.unmetReqIds(),
        stopNudgeActive: false,
      });
      if (nudge) writeDevDoc(this.repoPath, DEV_DOCS.splitNudge, nudge);
      else removeDevDoc(this.repoPath, DEV_DOCS.splitNudge);
    }
    const preRef = gitHead(this.repoPath) ?? "HEAD";

    // ── IMPLEMENT ──
    const impl = await this.legRunner.implement(this.legCtx());
    this.record("implement", impl.isError ? "error" : "ok", null, impl);
    if (impl.isError) {
      const agentFailures = this.session.agentFailures + 1;
      this.session = { ...this.session, agentFailures };
      if (agentFailures >= 2) {
        return { kind: "terminal", loopState: "BLOCKED", reason: "The implementer failed twice in a row." };
      }
      return { kind: "continue" };
    }
    this.session = { ...this.session, agentFailures: 0 };
    this.syncLedger();

    // ── EVALUATE (deterministic) ──
    const agentStateToken = parseAgentStateToken(readAgentStateFirstLine(this.repoPath));
    const evalOut = evaluateIteration(
      {
        config: this.config,
        preRef,
        approvedHash: this.session.approvedHash ?? "",
        currentApprovedHash: this.currentApprovedHash(),
        agentStateToken,
        allRequirementsMet: this.allRequirementsMet(),
        final: false,
        assumeReady: false,
        wholeRunDiffEmpty: false,
        fleetWorker: this.fleet !== null,
        bookkeeping: this.bookkeeping,
      },
      {
        diffPaths: (ref) => gitDiffPaths(this.repoPath, ref),
        runVerify: (cmd) => runVerifyCommand(this.repoPath, cmd, this.config.maxIterSeconds * 1000),
      },
    );
    this.bookkeeping = evalOut.bookkeeping;
    if (evalOut.result.verify) {
      writeLastVerifyLog(this.repoPath, evalOut.result.verify);
    }
    const sha = gitCommitAll(this.repoPath, `dev: iter ${iterationNo} — ${evalOut.result.state}`);
    this.record("evaluate", evalOut.result.state, evalOut.result.reason, undefined, sha);

    const state = evalOut.result.state;

    if (state === "SUCCESS_CANDIDATE") {
      return this.runSuccessGate(false, preRef);
    }
    if (
      state === "NEEDS_SPEC_DECISION"
      || state === "NEEDS_ARCHITECTURE_DECISION"
      || state === "NEEDS_DECOMPOSITION"
      || state === "RISK_REQUIRES_APPROVAL"
    ) {
      return this.escalate(state, evalOut.result.reason);
    }
    if (state === "BLOCKED" || state === "STALLED") {
      return { kind: "terminal", loopState: state, reason: evalOut.result.reason };
    }

    // state === "CONTINUE" → interim review + stop-eval + forced-gate check.
    if (this.config.reviewMode === "always") {
      const reviewOutcome = await this.runInterimReview(preRef);
      if (reviewOutcome) return reviewOutcome;
    }
    if (this.config.stopEval) {
      const stopOutcome = await this.runStopEval();
      if (stopOutcome) return stopOutcome;
    }
    // Forced gate — MET streak + verify green.
    if (this.shouldForceGate()) {
      return this.runSuccessGate(true, preRef);
    }
    return { kind: "continue" };
  }

  private async runInterimReview(preRef: string): Promise<DevIterationOutcome | null> {
    const holistic =
      (this.config.holisticEveryN > 0 && this.session.iteration % this.config.holisticEveryN === 0)
      || false;
    const { response, review } = await this.legRunner.review({
      ...this.legCtx(),
      mode: "interim",
      baseRef: holistic ? this.session.baseRef ?? preRef : preRef,
    });
    const verdict = review?.verdict ?? "REVISE"; // unparseable fails closed
    this.record("review", verdict, review?.summary ?? null, response);
    if (response.isError) {
      return { kind: "terminal", loopState: "BLOCKED", reason: "The reviewer was unavailable." };
    }
    if (verdict === "REVISE") {
      // Review is read-only; the engine persists the must-fix feedback so the
      // next implement leg addresses it first.
      writeDevDoc(this.repoPath, DEV_DOCS.reviewFeedback, response.text);
      const iterReviseCount = this.session.iterReviseCount + 1;
      this.session = { ...this.session, iterReviseCount };
      if (iterReviseCount >= this.config.maxRevisions) {
        return { kind: "terminal", loopState: "BLOCKED", reason: "Interim review churn (max revisions)." };
      }
    } else {
      removeDevDoc(this.repoPath, DEV_DOCS.reviewFeedback);
      this.session = { ...this.session, iterReviseCount: 0 };
    }
    return null;
  }

  private async runStopEval(): Promise<DevIterationOutcome | null> {
    const { response, verdict } = await this.legRunner.stopEval(this.legCtx());
    this.record("stop_eval", verdict, null, response);
    if (verdict === "FUTILE") {
      this.futileStreak += 1;
      this.metStreak = 0;
      if (this.config.futileN > 0 && this.futileStreak >= this.config.futileN) {
        return { kind: "terminal", loopState: "STALLED", reason: "Consecutive futile stop-eval verdicts." };
      }
    } else if (verdict === "MET") {
      this.metStreak += 1;
      this.futileStreak = 0;
    } else {
      this.futileStreak = 0;
      this.metStreak = 0;
    }
    return null;
  }

  private shouldForceGate(): boolean {
    return this.config.metForceN > 0 && this.metStreak >= this.config.metForceN;
  }

  /**
   * The success gate (loop-kit run_success_gate): gate review of the whole-run
   * diff -> evidence report -> final deterministic re-check. `forced` skips the
   * per-REQ downgrade and treats any non-escalation state as ready.
   */
  private async runSuccessGate(forced: boolean, preRef: string): Promise<DevIterationOutcome> {
    const baseRef = this.session.baseRef ?? preRef;
    const { response: reviewResp, review } = await this.legRunner.review({
      ...this.legCtx(),
      mode: "gate",
      baseRef,
      reqIds: this.fleet?.taskReqIds,
    });
    if (reviewResp.isError) {
      this.record("gate", "error", "reviewer unavailable", reviewResp);
      return { kind: "terminal", loopState: "BLOCKED", reason: "The gate reviewer was unavailable." };
    }
    const verdict = review?.verdict ?? "REVISE";
    const reqVerdicts = review?.reqVerdicts ?? [];
    this.record("gate", verdict, review?.summary ?? null, reviewResp);

    if (verdict === "ESCALATE") {
      return this.escalate("NEEDS_SPEC_DECISION", review?.summary ?? "The gate reviewer requested a decision.");
    }
    if (verdict === "REVISE") {
      writeDevDoc(this.repoPath, DEV_DOCS.reviewFeedback, reviewResp.text);
      if (forced) return { kind: "continue" }; // forced rejection does not count toward maxRevisions
      const gateReviseCount = this.session.gateReviseCount + 1;
      this.session = { ...this.session, gateReviseCount };
      if (gateReviseCount >= this.config.maxRevisions) {
        return { kind: "terminal", loopState: "BLOCKED", reason: "Gate review churn (max revisions)." };
      }
      return { kind: "continue" };
    }
    // APPROVE → evidence.
    removeDevDoc(this.repoPath, DEV_DOCS.reviewFeedback);
    this.session = { ...this.session, gateReviseCount: 0 };
    const evidence = await this.legRunner.evidence({ ...this.legCtx(), gateReqVerdicts: reqVerdicts });
    const sha = gitCommitAll(this.repoPath, `dev: iter ${this.session.iteration} — evidence`);
    this.record("evidence", evidence.isError ? "error" : "ok", null, evidence, sha);
    if (evidence.isError) {
      return { kind: "terminal", loopState: "BLOCKED", reason: "Evidence generation failed." };
    }

    // Final deterministic re-check.
    const finalOut = evaluateIteration(
      {
        config: this.config,
        preRef,
        approvedHash: this.session.approvedHash ?? "",
        currentApprovedHash: this.currentApprovedHash(),
        agentStateToken: "READY_FOR_REVIEW",
        allRequirementsMet: this.allRequirementsMet(),
        final: true,
        assumeReady: forced,
        wholeRunDiffEmpty: isWholeRunDiffEmpty(this.repoPath, baseRef),
        fleetWorker: this.fleet !== null,
        bookkeeping: this.bookkeeping,
      },
      {
        diffPaths: (ref) => gitDiffPaths(this.repoPath, ref),
        runVerify: (cmd) => runVerifyCommand(this.repoPath, cmd, this.config.maxIterSeconds * 1000),
      },
    );
    if (finalOut.result.verify) writeLastVerifyLog(this.repoPath, finalOut.result.verify);
    const fs = finalOut.result.state;
    if (fs === "SUCCESS" || fs === "NO_OP") {
      return { kind: "terminal", loopState: fs, reason: finalOut.result.reason };
    }
    return { kind: "terminal", loopState: "BLOCKED", reason: `Post-evidence re-check failed: ${finalOut.result.reason}` };
  }

  private escalate(loopState: DevTaskLoopState, reason: string): DevIterationOutcome {
    const kind = LOOP_STATE_TO_ESCALATION[loopState] ?? "spec_decision";
    const decisionRequests = readDevDoc(this.repoPath, DEV_DOCS.decisionRequests);
    return {
      kind: "escalate",
      escalationKind: kind,
      loopState,
      question: reason,
      contextSummary: decisionRequests,
    };
  }
}
