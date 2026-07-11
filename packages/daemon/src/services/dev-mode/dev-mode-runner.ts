/**
 * Development-mode runner — the detached lifecycle manager that owns a dev
 * session from `!approve` to a terminal state. It is the I/O twin of the pure
 * `DevLoopEngine`: the engine decides the LOOP (implement → evaluate → review →
 * gate → evidence) and returns a `DevIterationOutcome`; this runner interprets
 * that outcome into the OUTER lifecycle (running / awaiting_user / terminal
 * transitions, escalation rows, the 30-min inactivity timeout, and delivery).
 *
 * Modeled on `background-task-runner.ts` (factory + fire-and-forget `void
 * run().catch()` + a per-run `AbortController` that a cancel/timeout aborts),
 * but simpler: dev mode is a global singleton (D5), so there is no slot manager
 * — at most one loop runs at a time and one controller is held per session id.
 *
 * The model-calling backend is injected (`makeBackend`) so the runner is
 * testable with a fake `DevBackend` over a real temp git repo, exactly like the
 * engine test. I/O-shaped; excluded from the coverage gate (the deterministic
 * decision core it drives is separately covered 100%).
 */

import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import type { BackendModelTier } from "@aitne/shared";
import { formatSqliteDatetime } from "@aitne/shared";

import { createLogger } from "../../logging.js";
import {
  approveDevSession,
  bumpDevSessionRunResumes,
  getDevSession,
  markDevAwaitingApproval,
  markDevRunningFromTerminal,
  markDevTerminal,
  markDevAwaitingUser,
  markDevRunningFromParked,
  rebindDevSessionApproval,
  recordDevIteration,
  resetDevSessionStopHeuristics,
  seedDevRequirements,
  setDevSessionBaselineDone,
  setDevTimeoutScheduleId,
  updateDevSessionBaseRef,
  updateDevSessionConfig,
  writeDevCheckpoint,
  countDevRequirements,
  type DevSessionRow,
} from "../../db/dev-sessions-store.js";
import {
  createDevEscalation,
  getOpenDevEscalationForSession,
  resolveDevEscalation,
  type DevEscalationKind,
} from "../../db/dev-session-escalations-store.js";
import {
  getDevTask,
  listDevTasks,
  markDevTaskState,
  requeueDevTaskForResume,
  setDevTaskPlanReview,
  setDevTaskSeedBranch,
} from "../../db/dev-session-tasks-store.js";
import {
  DEV_DOCS,
  DEV_OWNER_PLAN_DECISION_FILE,
  DEV_TASK_ARCHIVE_DIR,
  DevRepoGuardError,
  appendDevDoc,
  checkRepoGuards,
  ensureDevWorkdir,
  gitCommitAll,
  gitCreateBranch,
  gitCurrentBranch,
  gitDiffPaths,
  gitHead,
  gitMergeInProgress,
  gitStatusDirty,
  markChecklistRows,
  readAgentStateFirstLine,
  readArchivedLessons,
  readDevDoc,
  removeDevDoc,
  runVerifyCommand,
  validateBaseRef,
  writeBaselineVerifyLog,
  writeDevDoc,
} from "./dev-loop-docs.js";
import { gitBranchExists, gitRenameBranch, gitWorktreeRemove } from "./dev-flow-git.js";
import {
  computeApprovalHash,
  computeConfigHashSansBudget,
  normalizeDevLoopConfig,
  validateDevLoopConfig,
} from "./dev-loop-config.js";
import {
  extractContractReqIds,
  extractContractRequirements,
  parseAgentStateToken,
  parseContractReviewVerdict,
  type DevContractReviewVerdict,
} from "./verdict-parse.js";
import {
  lintContractChecklist,
  parseChecklistMarkdown,
  parseHumanVerifyReply,
} from "./dev-checklist.js";
import { upsertDevChecklistRow } from "../../db/dev-session-checklist-store.js";
import type { DevLoopConfig } from "./types.js";
import { DevLoopEngine, type DevIterationOutcome, type DevLegResponse } from "./dev-loop-engine.js";
import { createDevLegRunner, type DevBackend } from "./dev-loop-legs.js";
import { createDevFlowLegRunner } from "./dev-flow-legs.js";
import {
  createDevFleetOrchestrator,
  type DevFleetOrchestrator,
  type DevFleetRunResult,
} from "./dev-flow-orchestrator.js";
import type { DevModePublisher } from "./dev-mode-publisher.js";

const logger = createLogger("dev-mode-runner");

/** Default inactivity window before an idle interview/approval session is
 *  auto-exited to free the singleton (loop-kit has no analog; this is the
 *  singleton-hygiene guard). */
const DEFAULT_TIMEOUT_MINUTES = 30;

/**
 * Decoupled delivery — the runner hands a digest/escalation to this so a
 * `task.delivery` event lands on the bus, keeping the runner free of any
 * core/messaging import (mirrors `BackgroundTaskDeliveryEnqueuer`). Optional:
 * when absent (tests) the DB transitions still happen; only the push is
 * skipped.
 */
export interface DevModeDeliveryEnqueuer {
  enqueueDigest(input: {
    sessionId: string;
    originatingChannel: string | null;
    title: string;
    draft: string;
    report: string;
    evidencePath?: string | null;
  }): Promise<void>;
  enqueueEscalation(input: {
    sessionId: string;
    escalationId: string;
    originatingChannel: string | null;
    title: string;
    question: string;
    contextSummary: string | null;
  }): Promise<void>;
}

export interface DevModeRunnerDeps {
  db: Database.Database;
  /** Construct the leg backend bound to this run's AbortController (so a
   *  cancel/timeout unwinds an in-flight leg). */
  makeBackend: (abortController: AbortController) => DevBackend;
  /** Task-flow body loader (core `getTaskFlow`). */
  loadTaskFlow: (key: string) => string;
  /** Resolve a repository's local worktree path (`getRepository(...).localPath`). */
  resolveRepoPath: (repositoryId: string) => string | null;
  /** Fired when a session reaches a terminal state so the dispatcher can drop
   *  its in-memory dev-mode latch + the runtime_state pointer in ONE place. */
  onSessionEnded?: (sessionId: string) => void;
  deliveryEnqueuer?: DevModeDeliveryEnqueuer;
  /** Publishes a terminal session's artifacts to the knowledge vault. */
  publisher?: DevModePublisher;
  /** Model tier for the loop's legs. Default "high". */
  tier?: BackendModelTier;
  /** Inactivity timeout window (minutes). Default 30. */
  timeoutMinutes?: number;
  now?: () => number;
  uuid?: () => string;
}

export interface DevApproveResult {
  ok: boolean;
  reason?: string;
  branch?: string;
  baseRef?: string;
  reqCount?: number;
}

export interface DevResumeResult {
  ok: boolean;
  reason?: string;
}

export interface DevModeRunner {
  /** Explicit `!resume` of a terminal (failed/exited/done-with-adds) session —
   *  loop-kit decide_run_mode semantics: fresh stop-heuristic windows for
   *  BLOCKED/STALLED, a budget rebind for BUDGET_EXCEEDED raises, a
   *  run_resumes backstop, and the Phase-A git recovery (base-ref validation
   *  + recovered-work commit) on relaunch. */
  resumeSession(input: {
    sessionId: string;
    budgetUsd?: number;
    iters?: number;
    note?: string;
  }): Promise<DevResumeResult>;
  /** Run one contract-interview turn: a read/write dev leg (cwd = repo) that
   *  surveys the repo, folds in the owner's message, updates the contract
   *  draft, and either asks a follow-up or declares CONTRACT_READY (the runner
   *  then validates + moves to awaiting_approval). Returns the user-facing
   *  reply (a question, or the loop summary). */
  runInterviewTurn(input: { sessionId: string; userMessage: string }): Promise<string>;
  /** Approve the awaiting_approval session (hash + branch + seed reqs +
   *  baseline snapshot) and kick the detached loop. Synchronous CAS + result;
   *  the loop runs fire-and-forget. */
  startFromApproval(sessionId: string): DevApproveResult;
  cancel(sessionId: string, reason: string): Promise<boolean>;
  /** Returns what happened so the caller replies correctly: `resumed` (loop is
   *  running again), `blocked` (hit the resume budget → terminal, a digest was
   *  sent), or `failed` (couldn't resume — session unchanged/parked). */
  resumeAfterEscalation(input: {
    sessionId: string;
    escalationId: string;
    answer: string;
  }): Promise<"resumed" | "blocked" | "failed">;
  /** Boot recovery for a non-terminal session: restart a `running` loop from
   *  its checkpoint; re-arm the inactivity timer for a human-wait state. */
  resumeFromBoot(sessionId: string): Promise<void>;
  /** The inactivity timer fired — exit an idle interview/approval session. */
  expireForTimeout(sessionId: string): Promise<void>;
  armTimeout(sessionId: string): void;
  cancelTimeout(sessionId: string): void;
  retimeTimeout(sessionId: string): void;
  isRunning(sessionId: string): boolean;
  /** A live FLEET orchestrator holds this session (vs a single loop). */
  hasLiveOrchestrator(sessionId: string): boolean;
  /** Wake a live fleet's dispatch loop after an `!add` enqueue. */
  notifyTaskQueued(sessionId: string): void;
}

export function createDevModeRunner(deps: DevModeRunnerDeps): DevModeRunner {
  const now = deps.now ?? (() => Date.now());
  const uuid = deps.uuid ?? (() => randomUUID());
  const tier: BackendModelTier = deps.tier ?? "high";
  const timeoutMs = (deps.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * 60_000;

  /** The in-flight loop's controller, keyed by session id. Singleton in
   *  practice (D5) but keyed for clarity + defensive multi-session safety.
   *  Also holds the interview-turn controller so a !exit/timeout aborts a
   *  mid-interview leg (WP3 P1-15). */
  const active = new Map<string, AbortController>();

  /** The LIVE fleet orchestrator for a running session, so a mid-fleet
   *  escalation answer can wake its dispatch loop in place instead of
   *  restarting the whole loop (WP3 P0-4). Present only while a fleet
   *  `orchestrator.run()` is executing; deleted in runLoop's finally. */
  const orchestrators = new Map<string, DevFleetOrchestrator>();

  // ── inactivity timeout (schedule-backed; no dedicated store) ──────────

  function cancelTimeout(sessionId: string): void {
    const session = getDevSession(deps.db, sessionId);
    const scheduleId = session?.timeoutScheduleId ?? null;
    if (scheduleId !== null) {
      // Skip (house style — invisible to the watcher poll) rather than delete.
      deps.db
        .prepare(`UPDATE agent_schedule SET status = 'skipped' WHERE id = ? AND status = 'pending'`)
        .run(scheduleId);
    }
    setDevTimeoutScheduleId(deps.db, sessionId, null);
  }

  function armTimeout(sessionId: string): void {
    cancelTimeout(sessionId);
    const scheduledFor = formatSqliteDatetime(new Date(now() + timeoutMs));
    const res = deps.db
      .prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, model, status)
         VALUES (?, 'dev_session_timeout', ?, ?, NULL, 'pending')`,
      )
      .run(
        scheduledFor,
        `dev session inactivity timeout (${sessionId})`,
        JSON.stringify({ sessionId, importance: "low" }),
      );
    setDevTimeoutScheduleId(deps.db, sessionId, Number(res.lastInsertRowid));
  }

  /** Slide the window forward on activity (an inbound interview message). */
  function retimeTimeout(sessionId: string): void {
    const session = getDevSession(deps.db, sessionId);
    const scheduleId = session?.timeoutScheduleId ?? null;
    if (scheduleId === null) {
      armTimeout(sessionId);
      return;
    }
    const scheduledFor = formatSqliteDatetime(new Date(now() + timeoutMs));
    const res = deps.db
      .prepare(
        `UPDATE agent_schedule SET scheduled_for = ? WHERE id = ? AND status = 'pending'`,
      )
      .run(scheduledFor, scheduleId);
    // The row was already claimed/fired (race) — arm a fresh one.
    if (res.changes === 0) armTimeout(sessionId);
  }

  // ── delivery (best-effort; recovery sweep retries) ────────────────────

  async function enqueueEscalationDelivery(
    session: DevSessionRow,
    escalationId: string,
    escalation: { question: string; contextSummary: string | null },
  ): Promise<void> {
    if (!deps.deliveryEnqueuer) return;
    try {
      await deps.deliveryEnqueuer.enqueueEscalation({
        sessionId: session.id,
        escalationId,
        originatingChannel: session.originatingChannel,
        title: session.slug ?? session.repositoryId,
        question: escalation.question,
        contextSummary: escalation.contextSummary,
      });
    } catch (err) {
      logger.warn({ err, sessionId: session.id }, "dev escalation delivery enqueue failed (recovery sweep will retry)");
    }
  }

  /** Create an escalation row + deliver it, WITHOUT parking the session — the
   *  fleet's task escalations keep independent siblings running (D-G). The
   *  session parks only when the orchestrator returns "parked". */
  async function createAndDeliverEscalation(input: {
    sessionId: string;
    taskId: string | null;
    kind: DevEscalationKind;
    question: string;
    contextSummary: string | null;
  }): Promise<void> {
    const escalationId = uuid();
    const row = createDevEscalation(deps.db, {
      id: escalationId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      kind: input.kind,
      question: input.question,
      contextSummary: input.contextSummary,
      askedAt: now(),
    });
    // Serialization (WP3 P0-5): deliver only if this is the ACTIVE escalation.
    // A concurrent fleet task escalation is created queued and stays silent
    // until the active one resolves + promotes it (resolveDevEscalation), at
    // which point the runner delivers the promoted row.
    const session = getDevSession(deps.db, input.sessionId);
    if (session && !row.queued) {
      await enqueueEscalationDelivery(session, escalationId, {
        question: input.question,
        contextSummary: input.contextSummary,
      });
    }
    logger.info(
      { sessionId: input.sessionId, taskId: input.taskId, kind: input.kind, queued: row.queued },
      "dev task escalation raised",
    );
  }

  async function enqueueDigestDelivery(
    session: DevSessionRow,
    draft: string,
    report: string,
  ): Promise<void> {
    if (!deps.deliveryEnqueuer) return;
    const repoPath = deps.resolveRepoPath(session.repositoryId);
    const evidencePath =
      repoPath && readDevDoc(repoPath, DEV_DOCS.evidence) !== null
        ? `${repoPath}/.aitne-dev/${DEV_DOCS.evidence}`
        : null;
    try {
      await deps.deliveryEnqueuer.enqueueDigest({
        sessionId: session.id,
        originatingChannel: session.originatingChannel,
        title: session.slug ?? session.repositoryId,
        draft,
        report,
        evidencePath,
      });
    } catch (err) {
      logger.warn({ err, sessionId: session.id }, "dev digest delivery enqueue failed (recovery sweep will retry)");
    }
  }

  // ── outcome handlers ──────────────────────────────────────────────────

  async function handleEscalate(
    sessionId: string,
    outcome: Extract<DevIterationOutcome, { kind: "escalate" }>,
  ): Promise<void> {
    const escalationId = uuid();
    const row = createDevEscalation(deps.db, {
      id: escalationId,
      sessionId,
      // Single-loop escalations map the (task-widened) loop state back to a
      // session escalation kind; NEEDS_DECOMPOSITION never reaches here.
      kind: outcome.escalationKind,
      question: outcome.question,
      contextSummary: outcome.contextSummary,
      askedAt: now(),
    });
    markDevAwaitingUser(deps.db, sessionId, now());
    // Escalations never auto-expire — cancel the inactivity timer while parked.
    cancelTimeout(sessionId);
    // A single loop parks with exactly one open escalation, so `row.queued` is
    // always false here; the guard keeps the "deliver only the active one"
    // invariant explicit (WP3 P0-5).
    const session = getDevSession(deps.db, sessionId);
    if (session && !row.queued) await enqueueEscalationDelivery(session, escalationId, outcome);
    logger.info({ sessionId, kind: outcome.escalationKind }, "dev session parked on escalation");
  }

  function digestFor(session: DevSessionRow, outcome: Extract<DevIterationOutcome, { kind: "terminal" }>): {
    draft: string;
    report: string;
    terminalState: "done" | "failed";
  } {
    const { total, met } = countDevRequirements(deps.db, session.id);
    const cost = session.costUsd ?? 0;
    const success = outcome.loopState === "SUCCESS" || outcome.loopState === "NO_OP";
    const label = session.slug ?? session.repositoryId;
    const head = success
      ? `Dev session for ${label} finished: ${outcome.loopState}.`
      : `Dev session for ${label} stopped: ${outcome.loopState}.`;
    const body = [
      head,
      `Requirements met: ${met}/${total}.`,
      `Iterations: ${session.iteration}.  Cost: $${cost.toFixed(2)}.`,
      `Branch: ${session.branch ?? "(none)"}.`,
      outcome.reason ? `Reason: ${outcome.reason}` : "",
    ]
      .filter((l) => l.length > 0)
      .join("\n");
    return { draft: body, report: body, terminalState: success ? "done" : "failed" };
  }

  async function handleTerminal(
    sessionId: string,
    outcome: Extract<DevIterationOutcome, { kind: "terminal" }>,
  ): Promise<void> {
    const session = getDevSession(deps.db, sessionId);
    if (!session) return;
    const { draft, report, terminalState } = digestFor(session, outcome);
    const terminal = markDevTerminal(deps.db, {
      id: sessionId,
      state: terminalState,
      loopState: outcome.loopState,
      exitedAt: now(),
    });
    cancelTimeout(sessionId);
    deps.onSessionEnded?.(sessionId);
    // Publish the session's artifacts to the knowledge vault before the digest,
    // so the evidence report is browsable the moment the owner is pinged.
    const repoPath = deps.resolveRepoPath(session.repositoryId);
    if (repoPath) {
      try {
        deps.publisher?.publishSession({
          sessionId,
          slug: session.slug ?? session.repositoryId,
          repoPath,
        });
      } catch (err) {
        logger.warn({ err, sessionId }, "dev publish threw (continuing)");
      }
    }
    // Re-read for the final rollup (cost/iteration persisted by the engine).
    const finalRow = terminal ?? getDevSession(deps.db, sessionId) ?? session;
    await enqueueDigestDelivery(finalRow, draft, report);
    logger.info({ sessionId, loopState: outcome.loopState, terminalState }, "dev session terminal");
  }

  /** Best-effort removal of every fleet worktree for a session (branches are
   *  kept for autopsy). Shared by cancel(), failLoud(), and the resume-budget
   *  block so no terminal path leaks a worktree (WP3 P1-16). Safe to call when
   *  no worktrees exist (single-loop / pre-fleet). */
  function cleanupFleetWorktrees(sessionId: string): void {
    const session = getDevSession(deps.db, sessionId);
    const repoPath = session ? deps.resolveRepoPath(session.repositoryId) : null;
    if (!repoPath) return;
    for (const task of listDevTasks(deps.db, sessionId)) {
      if (task.worktreePath) {
        try {
          gitWorktreeRemove(repoPath, task.worktreePath);
        } catch (err) {
          logger.warn({ err, sessionId, taskKey: task.taskKey }, "dev worktree cleanup failed");
        }
      }
    }
  }

  async function failLoud(sessionId: string, err: unknown): Promise<void> {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error({ err, sessionId }, "dev loop threw — marking failed");
    const session = getDevSession(deps.db, sessionId);
    markDevTerminal(deps.db, { id: sessionId, state: "failed", loopState: null, exitedAt: now() });
    cancelTimeout(sessionId);
    // A throw escapes the orchestrator's terminal-cleanup path, so reap the
    // fleet worktrees here — failLoud is terminal + non-resumable (WP3 P1-16).
    cleanupFleetWorktrees(sessionId);
    deps.onSessionEnded?.(sessionId);
    if (session) {
      await enqueueDigestDelivery(
        session,
        `Dev session for ${session.slug ?? session.repositoryId} failed: ${detail}.`,
        `The development loop hit an unrecoverable error: ${detail}.`,
      );
    }
  }

  // ── the loop driver (detached) ────────────────────────────────────────

  async function runLoop(sessionId: string): Promise<void> {
    const controller = new AbortController();
    active.set(sessionId, controller);
    try {
      const session = getDevSession(deps.db, sessionId);
      if (!session || session.state !== "running") {
        logger.warn({ sessionId, state: session?.state }, "dev runLoop: session not running — skipping");
        return;
      }
      const repoPath = deps.resolveRepoPath(session.repositoryId);
      if (!repoPath) {
        await failLoud(sessionId, new Error("repository local path unresolved"));
        return;
      }
      let config = normalizeDevLoopConfig(session.config);

      // ── Phase A repo guards + baseline/resume git prep ──────────────────
      // The daemon shares the owner's checkout: refuse to run over a moved
      // branch or a half-resolved merge — park on a chat question instead.
      if (session.branch) {
        const guard = checkRepoGuards(repoPath, session.branch);
        if (!guard.ok) {
          await handleEscalate(sessionId, {
            kind: "escalate",
            escalationKind: "spec_decision",
            loopState: "NEEDS_SPEC_DECISION",
            question: guard.question,
            contextSummary: null,
          });
          return;
        }
      }
      let session2 = session;
      // Fresh run = never baselined AND still at iteration 0. The iteration
      // guard matters for a session upgraded mid-flight: migration 0029
      // back-fills baseline_verified_at=NULL on pre-existing rows, so without
      // it a resumed pre-upgrade session (iteration>0) would wrongly re-run
      // baseline verify, add a snapshot commit, and reset base_ref to a
      // mid-run HEAD (losing the whole-run diff base).
      if (session.baselineVerifiedAt === null && session.iteration === 0) {
        // Fresh run — baseline-verify snapshot (loop.sh:7033 port): run the
        // gate once so tool side-effects (lockfiles/caches) land in BASELINE
        // (never the agent's diff), record the per-command red→green
        // baseline, and advance base_ref past the snapshot commit. Fleet
        // worktrees are cut AFTER this, so workers inherit the clean base.
        const results = config.verifyCommands.map((command) => {
          const r = runVerifyCommand(repoPath, command, config.maxIterSeconds * 1000);
          return { command, exitCode: r.exitCode, passed: r.exitCode === 0, output: r.output };
        });
        writeBaselineVerifyLog(repoPath, results);
        // Re-check the branch identity: the verify run above can take minutes,
        // during which the owner could `git checkout` off the session branch —
        // committing the snapshot then would land it on the WRONG branch. Park
        // instead (the fresh path re-runs the whole baseline on resume).
        if (session.branch) {
          const postVerifyGuard = checkRepoGuards(repoPath, session.branch);
          if (!postVerifyGuard.ok) {
            await handleEscalate(sessionId, {
              kind: "escalate",
              escalationKind: "spec_decision",
              loopState: "NEEDS_SPEC_DECISION",
              question: postVerifyGuard.question,
              contextSummary: null,
            });
            return;
          }
        }
        gitCommitAll(repoPath, "dev: baseline verify snapshot");
        const newBase = gitHead(repoPath);
        if (newBase) {
          setDevSessionBaselineDone(deps.db, { id: sessionId, baseRef: newBase, verifiedAt: now() });
        }
        const red = results.filter((r) => !r.passed).length;
        recordDevIteration(deps.db, {
          id: uuid(),
          sessionId,
          iteration: 0,
          phase: "baseline",
          verdict: `red=${red} green=${results.length - red}`,
          commitSha: newBase,
          createdAt: now(),
        });
        session2 = getDevSession(deps.db, sessionId) ?? session;
      } else {
        // Resume — re-validate the recorded base against real history
        // (degrade to HEAD on a rewrite) and sweep the interrupted
        // iteration's uncommitted work into a commit the reviewer can see.
        const check = validateBaseRef(repoPath, session.baseRef);
        if (check.degraded) {
          updateDevSessionBaseRef(deps.db, sessionId, check.ref, now());
          appendDevDoc(
            repoPath,
            DEV_DOCS.progress,
            `\nresume: recorded base ${session.baseRef ?? "(none)"} is not an `
              + `ancestor of HEAD — using ${check.ref} as the review base.\n`,
          );
          logger.warn({ sessionId, recorded: session.baseRef, degraded: check.ref }, "dev resume: base ref degraded");
          session2 = getDevSession(deps.db, sessionId) ?? session;
        }
        if (session.branch && gitStatusDirty(repoPath)) {
          gitCommitAll(repoPath, `dev: iter ${session.iteration} — recovered uncommitted work on resume`);
          logger.info({ sessionId }, "dev resume: committed recovered uncommitted work");
        }
      }
      if (controller.signal.aborted) return;
      const session3 = session2;
      config = normalizeDevLoopConfig(session3.config);

      const backend = deps.makeBackend(controller);
      const legRunner = createDevLegRunner({ backend, loadTaskFlow: deps.loadTaskFlow });

      // Fleet path: decompose the contract into a task DAG, then run the
      // orchestrator. A resume (tasks already exist) re-enters mid-fleet. When
      // decompose returns "single" (n=1), fall through to the classic loop.
      // Queued task rows force the orchestrator even when decompose is off —
      // otherwise a `!add` on a done single-loop session (decompose:false)
      // would enqueue a manual task the single-loop path never dispatches
      // (the decomposeFlow guard then runs it as a mini-fleet, skipping
      // decompose for a pure-manual queue).
      const hasQueuedTasks = listDevTasks(deps.db, sessionId).length > 0;
      if (config.flow.decompose || hasQueuedTasks) {
        const flowLegs = createDevFlowLegRunner({ backend, loadTaskFlow: deps.loadTaskFlow });
        const orchestrator = createDevFleetOrchestrator({
          db: deps.db,
          repoPath,
          session: session3,
          config,
          legRunner,
          flowLegs,
          tier,
          now,
          uuid,
          signal: controller.signal,
          onTaskEscalation: (e) =>
            createAndDeliverEscalation({
              sessionId,
              taskId: e.taskId,
              kind: e.kind,
              question: e.question,
              contextSummary: e.contextSummary,
            }),
          onFleetNote: async (text) => {
            const s = getDevSession(deps.db, sessionId);
            if (s) await enqueueFleetNote(s, text);
          },
        });
        // Hold the live handle so a mid-fleet escalation answer can wake the
        // dispatch loop in place (WP3 P0-4). Cleared in the finally below.
        orchestrators.set(sessionId, orchestrator);
        const result = await orchestrator.run();
        if (controller.signal.aborted) return;
        if (result.kind !== "single") {
          await handleFleetResult(sessionId, result);
          return;
        }
        // n=1 collapse → run the classic single loop. The orchestrator has
        // returned and is no longer live, so drop the handle NOW (not only in
        // the finally): otherwise hasLiveOrchestrator stays true for the whole
        // single-loop run and `!add` misreports "the fleet is still planning"
        // instead of the honest single-loop refusal.
        orchestrators.delete(sessionId);
        logger.info({ sessionId }, "dev fleet: n=1 — running the single loop");
      }

      // Single-loop path (decompose disabled or n=1).
      const engine = new DevLoopEngine(session3, {
        db: deps.db,
        repoPath,
        legRunner,
        tier,
        now,
        uuid,
      });

      await engine.ensurePlan();
      if (controller.signal.aborted) return;

      let n = Math.max(1, session3.iteration);
      // Hard backstop above the engine's own maxIterations guard.
      for (;;) {
        if (controller.signal.aborted) return;
        const outcome = await engine.runIteration(n);
        if (controller.signal.aborted) return;
        if (outcome.kind === "continue") {
          n += 1;
          continue;
        }
        if (outcome.kind === "escalate") {
          // A single loop can only raise session-scoped escalation states
          // (never NEEDS_DECOMPOSITION — the evaluator gates that on fleet).
          await handleEscalate(sessionId, outcome as Extract<DevIterationOutcome, { kind: "escalate" }>);
          return;
        }
        await handleTerminal(sessionId, outcome);
        return;
      }
    } catch (err) {
      // A repo-guard trip (merge backstop / plan-leg branch check) is the
      // owner's to fix — park on the question instead of failing the session.
      if (err instanceof DevRepoGuardError) {
        await handleEscalate(sessionId, {
          kind: "escalate",
          escalationKind: "spec_decision",
          loopState: "NEEDS_SPEC_DECISION",
          question: err.guard.question,
          contextSummary: null,
        });
        return;
      }
      await failLoud(sessionId, err);
    } finally {
      active.delete(sessionId);
      orchestrators.delete(sessionId);
    }
  }

  /** A mid-fleet progress note → a low-key digest DM (best-effort). */
  async function enqueueFleetNote(session: DevSessionRow, text: string): Promise<void> {
    if (!deps.deliveryEnqueuer) return;
    try {
      await deps.deliveryEnqueuer.enqueueDigest({
        sessionId: session.id,
        originatingChannel: session.originatingChannel,
        title: session.slug ?? session.repositoryId,
        draft: text,
        report: text,
        evidencePath: null,
      });
    } catch (err) {
      logger.warn({ err, sessionId: session.id }, "dev fleet note enqueue failed");
    }
  }

  /** Map an orchestrator result onto the outer session lifecycle. */
  async function handleFleetResult(
    sessionId: string,
    result: Exclude<DevFleetRunResult, { kind: "single" }>,
  ): Promise<void> {
    if (result.kind === "terminal") {
      await handleTerminal(sessionId, {
        kind: "terminal",
        loopState: result.loopState,
        reason: result.reason,
      });
      return;
    }
    // parked: the orchestrator already created + delivered the task escalation
    // rows (or the fleet cancelled). Cancel maps through the runner's cancel().
    if (result.reason === "cancelled") return;
    markDevAwaitingUser(deps.db, sessionId, now());
    cancelTimeout(sessionId);
    logger.info({ sessionId, reason: result.reason }, "dev fleet parked awaiting the owner");
  }

  // ── interview (pre-approval contract authoring) ───────────────────────

  /** Pull the `## Goal` paragraph out of the contract markdown for the loop
   *  summary (best-effort; the heading is optional). */
  function extractGoal(contractMd: string): string | null {
    const lines = contractMd.split(/\r?\n/);
    const start = lines.findIndex((l) => /^#{1,6}\s+goal\b/i.test(l.trim()));
    if (start < 0) return null;
    const body: string[] = [];
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^#{1,6}\s+/.test(lines[i]!.trim())) break;
      if (lines[i]!.trim().length > 0) body.push(lines[i]!.trim());
    }
    const joined = body.join(" ").trim();
    return joined.length > 0 ? joined : null;
  }

  function renderLoopSummary(
    session: DevSessionRow,
    contractMd: string,
    config: DevLoopConfig,
    reviewLine: string | null,
  ): string {
    const reqs = extractContractRequirements(contractMd);
    const goal = extractGoal(contractMd);
    const repoPath = deps.resolveRepoPath(session.repositoryId);
    const acRows = repoPath
      ? parseChecklistMarkdown(readDevDoc(repoPath, DEV_DOCS.checklist)) ?? []
      : [];
    const acCount = (m: string): number => acRows.filter((r) => r.method === m).length;
    const lines = [
      `Contract ready for ${session.slug ?? session.repositoryId}.`,
      goal ? `\nGoal: ${goal}` : "",
      `\nRequirements (${reqs.length}):`,
      ...reqs.map((r) => `  • ${r.id}: ${r.title}`),
      acRows.length > 0
        ? `\nAcceptance checklist: ${acRows.length} expectations `
          + `(${acCount("cmd")} cmd · ${acCount("run")} run · ${acCount("human")} human`
          + `${acCount("human") > 0 ? " — human rows come back to you for sign-off" : ""})`
        : "",
      reviewLine ? `\n${reviewLine}` : "",
      `\nVerify (all must pass): ${config.verifyCommands.join(", ")}`,
      // Surface the setup command too — it runs unsandboxed in each worktree, so
      // the owner should see (and consent to) it at approval.
      config.flow.worktreeSetupCommand
        ? `Worktree setup (runs per worktree): ${config.flow.worktreeSetupCommand}`
        : "",
      config.deniedPaths.length > 0 ? `Denied paths: ${config.deniedPaths.join(", ")}` : "",
      // Three-tier cost model: ① loop count, ② per Claude Code session (leg),
      // ③ per process (toggle).
      `\nCost — max loops: ${config.maxIterations}  ·  per session (per call): $${config.maxCostPerSessionUsd}`,
      config.maxCostUsd !== null
        ? `Process cap: $${config.maxCostUsd} (hard total)`
        : config.flow.decompose
          ? `Process cap: off — no hard total (a parallel fleet can spend well above loops × per-session). Ask me to set one to bound total spend.`
          : `Process cap: off — no hard total (bounded only by loops × per-session). Ask me to set one for a hard limit.`,
      `\nReply !approve to start the loop, or keep chatting to refine.`,
    ];
    return lines.filter((l) => l.length > 0).join("\n");
  }

  /** Deterministic definition checks at CONTRACT_READY: contract shape,
   *  config validity, the unknowns record, the checklist lint, and the
   *  runner-side verify PROBE (the interview leg has no shell — the daemon
   *  runs each command once and refuses finalization when one cannot run). */
  function validateDefinition(
    repoPath: string,
  ):
    | { kind: "question"; question: string }
    | { kind: "ok"; contractMd: string; config: DevLoopConfig } {
    const contractMd = readDevDoc(repoPath, DEV_DOCS.contract);
    if (!contractMd || contractMd.trim().length === 0) {
      return { kind: "question", question: "I couldn't find the drafted contract yet — what's the goal you want me to build toward?" };
    }
    const reqs = extractContractRequirements(contractMd);
    if (reqs.length === 0) {
      return {
        kind: "question",
        question: "The contract still needs at least one numbered requirement (a `### REQ-001: …` heading). What's the first concrete, verifiable requirement?",
      };
    }
    let parsed: Partial<DevLoopConfig> = {};
    const raw = readDevDoc(repoPath, DEV_DOCS.loopConfig);
    if (raw) {
      try {
        parsed = JSON.parse(raw) as Partial<DevLoopConfig>;
      } catch {
        // fall through — validation will flag the missing verify commands
      }
    }
    const config = normalizeDevLoopConfig(parsed);
    const validation = validateDevLoopConfig(config);
    if (!validation.ok) {
      return {
        kind: "question",
        question: `Almost there — ${validation.errors.join(" ")} What command(s) should verify success (e.g. \`npm test\` or \`pytest\`)?`,
      };
    }
    // The structured unknowns record is mandatory (blindspot survey output).
    const unknowns = readDevDoc(repoPath, DEV_DOCS.unknowns);
    if (!unknowns || unknowns.trim().length === 0) {
      return {
        kind: "question",
        question:
          "Before I can finalize: the unknowns record (.aitne-dev/docs/unknowns.md) "
          + "is missing — I need one more pass over the repo to fill it. What area "
          + "should I prioritize surveying?",
      };
    }
    // Checklist definition lint (anchors ↔ rows ↔ REQs).
    const lintErrors = lintContractChecklist(
      contractMd,
      readDevDoc(repoPath, DEV_DOCS.checklist),
      extractContractReqIds(contractMd),
    );
    if (lintErrors.length > 0) {
      return {
        kind: "question",
        question: `The acceptance checklist needs fixes before approval: ${lintErrors.slice(0, 3).join("; ")}.`,
      };
    }
    // Verify probe — each command must at least be RUNNABLE here (loop-kit
    // runs them in-session; the read-only interview leg cannot, so the daemon
    // does it deterministically). Results feed the contract review + summary.
    const probeLines: string[] = ["| Command | Exit | Baseline |", "|---|---|---|"];
    for (const command of config.verifyCommands) {
      const run = runVerifyCommand(repoPath, command, config.maxIterSeconds * 1000);
      const classification = run.exitCode === 0 ? "stays-green" : "red at baseline (red→green candidate)";
      probeLines.push(`| ${command.replace(/\|/g, "/")} | ${run.exitCode} | ${classification} |`);
      if (run.exitCode === 127 || run.exitCode === 126) {
        writeDevDoc(repoPath, DEV_DOCS.verifyProbe, `${probeLines.join("\n")}\n`);
        return {
          kind: "question",
          question:
            `The verify command \`${command}\` isn't runnable in this repo `
            + `(exit ${run.exitCode}) — the gate would never pass. What should it run instead?`,
        };
      }
    }
    writeDevDoc(repoPath, DEV_DOCS.verifyProbe, `${probeLines.join("\n")}\n`);
    return { kind: "ok", contractMd, config };
  }

  /** Independent read-only judge of the interview's definition (loop-kit
   *  loop-contract-review — dev-mode runs it ALWAYS, not just headless).
   *  One format-reminder retry; null = no parseable verdict (fail TOWARD the
   *  human: present the summary with a caveat, never silently approve). */
  async function runContractReview(
    session: DevSessionRow,
    repoPath: string,
    backend: DevBackend,
    config: DevLoopConfig,
  ): Promise<DevContractReviewVerdict | null> {
    const staged = [
      "<dev_contract_review_context>",
      `Repo: ${session.slug ?? session.repositoryId}`,
      "",
      "## Product contract (the definition under review)",
      readDevDoc(repoPath, DEV_DOCS.contract) ?? "(missing)",
      "",
      "## Loop config (stop conditions)",
      readDevDoc(repoPath, DEV_DOCS.loopConfig) ?? "(missing)",
      "",
      "## Unknowns record",
      readDevDoc(repoPath, DEV_DOCS.unknowns) ?? "(missing)",
      "",
      "## Acceptance checklist",
      readDevDoc(repoPath, DEV_DOCS.checklist) ?? "(none)",
      "",
      "## Verify probe (deterministic daemon run — exit codes are ground truth)",
      readDevDoc(repoPath, DEV_DOCS.verifyProbe) ?? "(none)",
      "</dev_contract_review_context>",
    ].join("\n");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const resp = await backend.runLeg({
        taskFlowKey: "dev.contract_review",
        prompt: deps.loadTaskFlow("dev.contract_review"),
        context:
          attempt === 0
            ? staged
            : `${staged}\n\nREMINDER: end with exactly one line \`CONTRACT-REVIEW: APPROVE|REVISE|ESCALATE <detail>\`.`,
        sessionDir: repoPath,
        allowedTools: ["Read", "Glob", "Grep"],
        readOnly: true,
        tier,
        maxTurns: 25,
        maxBudgetUsd: config.maxCostPerSessionUsd,
        maxSeconds: 600,
      });
      recordDevIteration(deps.db, {
        id: uuid(),
        sessionId: session.id,
        iteration: 0,
        phase: "contract_review",
        verdict: resp.isError ? "error" : parseContractReviewVerdict(resp.text)?.verdict ?? "unparseable",
        reason: parseContractReviewVerdict(resp.text)?.detail ?? null,
        costUsd: resp.costUsd > 0 ? resp.costUsd : null,
        createdAt: now(),
      });
      if (resp.isError) continue;
      const verdict = parseContractReviewVerdict(resp.text);
      if (verdict) return verdict;
    }
    return null;
  }

  /** CONTRACT_READY path — deterministic checks, the independent contract
   *  review (bounded auto-revision), then awaiting_approval + the summary. */
  async function finalizeWithReview(
    session: DevSessionRow,
    repoPath: string,
    backend: DevBackend,
  ): Promise<string> {
    for (let round = 0; ; round += 1) {
      const checked = validateDefinition(repoPath);
      if (checked.kind === "question") return checked.question;
      const { contractMd, config } = checked;

      let reviewLine: string | null = null;
      if (config.contractReview) {
        const review = await runContractReview(session, repoPath, backend, config);
        if (review === null) {
          reviewLine = "⚠️ Independent contract review could not render a verdict — read the summary extra carefully.";
        } else if (review.verdict === "ESCALATE") {
          return `The contract reviewer needs your call before this can run: ${review.detail}`;
        } else if (review.verdict === "REVISE") {
          writeDevDoc(repoPath, DEV_DOCS.contractReviewFeedback, review.detail);
          if (round === 0) {
            // One bounded auto-revision: re-run the interview leg with the
            // reviewer's must-fix items injected, then re-validate.
            const resp = await runInterviewLeg(
              session,
              repoPath,
              backend,
              "(automated) Address the contract reviewer's must-fix items injected above, then re-declare CONTRACT_READY.",
            );
            if (!resp.isError) {
              const token = parseAgentStateToken(readAgentStateFirstLine(repoPath));
              if (token === "CONTRACT_READY") continue; // re-validate + re-review
              return resp.text.trim().length > 0
                ? resp.text.trim()
                : "The reviewer raised concerns I couldn't resolve automatically — tell me how to proceed.";
            }
            reviewLine = `⚠️ Reviewer concerns (auto-revision failed): ${review.detail}`;
          } else {
            // Still REVISE after the revision — the human gate decides.
            reviewLine = `⚠️ Reviewer concerns outstanding: ${review.detail}`;
          }
        } else {
          removeDevDoc(repoPath, DEV_DOCS.contractReviewFeedback);
          reviewLine = `Independently reviewed: APPROVE${review.detail ? ` — ${review.detail}` : ""}`;
        }
      }

      updateDevSessionConfig(
        deps.db,
        session.id,
        { config: config as unknown as Record<string, unknown> },
        now(),
      );
      const advanced = markDevAwaitingApproval(deps.db, session.id, now());
      // Cancel the inactivity timer? No — awaiting_approval still waits on the
      // human, so keep it armed (retimed on each message).
      const finalRow = advanced ?? session;
      logger.info(
        { sessionId: session.id, review: reviewLine },
        "dev contract finalized — awaiting approval",
      );
      return renderLoopSummary(finalRow, contractMd, config, reviewLine);
    }
  }

  /** One contract-interview leg (also the contract-review auto-revision
   *  vehicle). Injects every definition draft so a fresh-context turn sees
   *  the full state, plus any contract-review feedback to address. */
  async function runInterviewLeg(
    session: DevSessionRow,
    repoPath: string,
    backend: DevBackend,
    ownerMessage: string,
  ): Promise<DevLegResponse> {
    const draftSection = (title: string, rel: string): string => {
      const body = readDevDoc(repoPath, rel);
      return body && body.trim().length > 0 ? `\n## ${title}\n${body.trim()}\n` : "";
    };
    const draft = readDevDoc(repoPath, DEV_DOCS.contract);
    const context = [
      "<dev_interview_context>",
      `Repo: ${session.slug ?? session.repositoryId}  ·  Local path: ${repoPath}`,
      `Session id: ${session.id}`,
      "",
      "## Current contract draft (.aitne-dev/docs/product-contract.md)",
      draft && draft.trim().length > 0 ? draft : "(none yet — this is the first turn)",
      draftSection("Current loop config draft", DEV_DOCS.loopConfig),
      draftSection("Current unknowns record", DEV_DOCS.unknowns),
      draftSection("Current acceptance checklist", DEV_DOCS.checklist),
      draftSection(
        "Contract-review feedback (address EVERY must-fix item before re-declaring CONTRACT_READY)",
        DEV_DOCS.contractReviewFeedback,
      ),
      (() => {
        const lessons = readArchivedLessons(repoPath);
        return lessons
          ? `\n## Lessons from previous runs in this repo (intake — read first)\n${lessons}\n`
          : "";
      })(),
      "",
      "## Owner's latest message",
      ownerMessage,
      "</dev_interview_context>",
    ].join("\n");
    return backend.runLeg({
      taskFlowKey: "dev.contract_interview",
      prompt: deps.loadTaskFlow("dev.contract_interview"),
      context,
      sessionDir: repoPath,
      // Read the repo, but SCOPE writes to the .aitne-dev working dir — the
      // interview runs pre-approval on the owner's live branch with no branch
      // isolation, so an over-reaching / prompt-injected turn must not be able
      // to mutate repo source or out-of-repo files (~/.zshrc etc.). Path-scoped
      // Write/Edit (cwd-relative glob) is the enforced boundary; the task-flow
      // prose is only advisory on top.
      allowedTools: ["Read", "Glob", "Grep", "Write(.aitne-dev/**)", "Edit(.aitne-dev/**)"],
      readOnly: false,
      tier,
      maxTurns: 40,
      // The interview is one Claude Code session — cap it at the per-session
      // budget (the draft config's, or the default before any is written).
      maxBudgetUsd: normalizeDevLoopConfig(session.config).maxCostPerSessionUsd,
      maxSeconds: 600,
    });
  }

  async function runInterviewTurn(input: {
    sessionId: string;
    userMessage: string;
  }): Promise<string> {
    const session = getDevSession(deps.db, input.sessionId);
    if (!session) return "That dev session no longer exists. Start again with !repo <name>.";
    if (session.state !== "interview" && session.state !== "awaiting_approval") {
      return "This dev session isn't in the interview phase anymore.";
    }
    const repoPath = deps.resolveRepoPath(session.repositoryId);
    if (!repoPath) return "I can't find the local path for that repository.";
    ensureDevWorkdir(repoPath);

    // Interview turns are not part of the loop, but they must be abortable —
    // register the controller in `active` so a !exit / inactivity timeout
    // unwinds a mid-interview leg instead of waiting out maxSeconds (WP3
    // P1-15). Interview and loop states are mutually exclusive, so this never
    // collides with a runLoop controller; the finally only clears our own.
    const controller = new AbortController();
    active.set(input.sessionId, controller);
    try {
      const backend = deps.makeBackend(controller);
      const resp = await runInterviewLeg(session, repoPath, backend, input.userMessage);
      if (resp.isError) {
        return "Something went wrong while drafting the contract. Try rephrasing, or reply !exit to stop.";
      }

      const stateToken = parseAgentStateToken(readAgentStateFirstLine(repoPath));
      if (stateToken === "CONTRACT_READY") {
        return await finalizeWithReview(session, repoPath, backend);
      }
      return resp.text.trim().length > 0
        ? resp.text.trim()
        : "Tell me more about what you'd like me to build.";
    } finally {
      // Clear only our own controller — a later runLoop may have set a fresh
      // one (interview/loop states are exclusive, but stay defensive).
      if (active.get(input.sessionId) === controller) active.delete(input.sessionId);
    }
  }

  // ── public surface ────────────────────────────────────────────────────

  function startFromApproval(sessionId: string): DevApproveResult {
    const session = getDevSession(deps.db, sessionId);
    if (!session) return { ok: false, reason: "session_not_found" };
    if (session.state !== "awaiting_approval") {
      return { ok: false, reason: `not_awaiting_approval (state=${session.state})` };
    }
    const repoPath = deps.resolveRepoPath(session.repositoryId);
    if (!repoPath) return { ok: false, reason: "repository_path_unresolved" };

    const config = normalizeDevLoopConfig(session.config);
    const validation = validateDevLoopConfig(config);
    if (!validation.ok) return { ok: false, reason: validation.errors.join("; ") };

    // Never `checkout -B` + `add -A` over a half-resolved merge — the
    // snapshot would stage the conflict markers as resolved (loop.sh:3775).
    if (gitMergeInProgress(repoPath)) {
      return {
        ok: false,
        reason:
          "a git merge is in progress in the repository — resolve it (or run "
          + "`git merge --abort`), then !approve again",
      };
    }

    ensureDevWorkdir(repoPath);
    const contractMd = readDevDoc(repoPath, DEV_DOCS.contract);
    if (!contractMd || contractMd.trim().length === 0) {
      return { ok: false, reason: "product-contract.md missing — run the interview first" };
    }
    const reqs = extractContractRequirements(contractMd);
    if (reqs.length === 0) {
      return { ok: false, reason: "contract has no REQ-### requirements" };
    }
    // Belt-and-braces checklist lint (the interview already gates on it, but
    // the file could have been hand-edited between summary and !approve).
    const lintErrors = lintContractChecklist(
      contractMd,
      readDevDoc(repoPath, DEV_DOCS.checklist),
      reqs.map((r) => r.id),
    );
    if (lintErrors.length > 0) {
      return { ok: false, reason: `acceptance checklist: ${lintErrors[0]!}` };
    }

    // Move onto the dev branch (dirty worktree carries over), snapshot the
    // pre-loop baseline there so per-iteration diffs are clean, and anchor the
    // run baseline. Never touches the owner's original branch (D6). The
    // pre-switch checkout (branch + HEAD) is recorded FIRST so `!rollback`
    // can restore it, and the snapshot sha is kept iff it actually swept in
    // dirty owner WIP (the rollback re-applies exactly that commit).
    const branch = `aitne-dev/${sessionId}`;
    const originalBranch = gitCurrentBranch(repoPath);
    const originalHead = gitHead(repoPath);
    let wipSnapshotRef: string | null = null;
    try {
      gitCreateBranch(repoPath, branch);
      gitCommitAll(repoPath, "dev: baseline snapshot (pre-loop)");
      const postSnapshotHead = gitHead(repoPath);
      // Record the snapshot as restorable WIP only when it swept in genuine
      // OWNER files — not merely ensureDevWorkdir's `.gitignore` edit (which
      // is bundled into the commit on a repo that didn't yet ignore
      // `.aitne-dev/`). gitDiffPaths already excludes `.aitne-dev/`; filtering
      // `.gitignore` leaves the owner's uncommitted work. An empty result on a
      // clean tree keeps wip_snapshot_ref null so `!rollback` doesn't
      // mislabel "restored your changes".
      if (postSnapshotHead !== null && originalHead !== null && postSnapshotHead !== originalHead) {
        const swept = gitDiffPaths(repoPath, originalHead).filter((p) => p !== ".gitignore");
        wipSnapshotRef = swept.length > 0 ? postSnapshotHead : null;
      }
    } catch (err) {
      return { ok: false, reason: `git branch/baseline failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const baseRef = gitHead(repoPath);
    if (!baseRef) return { ok: false, reason: "could not resolve base ref after snapshot" };

    const approvedHash = computeApprovalHash(contractMd, config);
    seedDevRequirements(
      deps.db,
      sessionId,
      reqs.map((r) => ({ id: uuid(), reqId: r.id, title: r.title })),
      now(),
    );
    // Seed the checklist DB mirror (the §6.6 monotonicity baseline starts at
    // the approved definition; lint-time defects were refused above).
    for (const row of parseChecklistMarkdown(readDevDoc(repoPath, DEV_DOCS.checklist)) ?? []) {
      if (row.method === null || row.status === "unknown") continue;
      upsertDevChecklistRow(deps.db, {
        id: uuid(),
        sessionId,
        taskId: null,
        acId: row.acId,
        reqId: row.reqId || null,
        expectation: row.expectation || null,
        method: row.method,
        status: row.status,
        evidence: row.evidence || null,
        iter: 0,
        updatedAt: now(),
      });
    }
    const approved = approveDevSession(deps.db, {
      id: sessionId,
      approvedHash,
      branch,
      baseRef,
      originalBranch,
      originalHead,
      wipSnapshotRef,
      maxIterations: config.maxIterations,
      // Per-process total cap (③). null = off (COALESCE keeps the NULL) → the
      // engine's session-wide BUDGET_EXCEEDED guard stays dormant and the
      // effective ceiling is maxIterations × legs × maxCostPerSessionUsd.
      maxBudgetUsd: config.maxCostUsd,
      approvedAt: now(),
    });
    if (!approved) return { ok: false, reason: "approval CAS missed (already approved?)" };

    // The loop is active work — no inactivity timeout while running.
    cancelTimeout(sessionId);
    void runLoop(sessionId).catch((err) => {
      logger.error({ err, sessionId }, "dev runLoop rejected (should be caught internally)");
    });
    return { ok: true, branch, baseRef, reqCount: reqs.length };
  }

  async function cancel(sessionId: string, reason: string): Promise<boolean> {
    const session = getDevSession(deps.db, sessionId);
    if (!session) return false;
    const controller = active.get(sessionId);
    if (controller) {
      try {
        controller.abort(new Error(reason || "cancel"));
      } catch (err) {
        logger.warn({ err, sessionId }, "dev cancel: abort failed");
      }
    }
    cancelTimeout(sessionId);
    markDevTerminal(deps.db, {
      id: sessionId,
      state: "exited",
      loopState: session.loopState,
      exitedAt: now(),
    });
    // Best-effort fleet worktree cleanup (branches are kept for autopsy).
    cleanupFleetWorktrees(sessionId);
    deps.onSessionEnded?.(sessionId);
    logger.info({ sessionId, reason, wasRunning: !!controller }, "dev session cancelled");
    return true;
  }

  async function resumeAfterEscalation(input: {
    sessionId: string;
    escalationId: string;
    answer: string;
  }): Promise<"resumed" | "blocked" | "failed"> {
    const session = getDevSession(deps.db, input.sessionId);
    if (!session) return "failed";
    // Accept an answer when the session is parked (awaiting_user — a single
    // loop, or a fully-blocked fleet) OR still running with a LIVE fleet
    // orchestrator: a task escalated while its siblings keep working, so the
    // session never parked (F6 / WP3 P0-4). Any other state has no answerable
    // question on file.
    const orchestrator = orchestrators.get(input.sessionId) ?? null;
    const midFleet = session.state === "running" && orchestrator !== null;
    if (session.state !== "awaiting_user" && !midFleet) return "failed";

    const resolved = resolveDevEscalation(deps.db, {
      id: input.escalationId,
      answer: input.answer,
      answeredAt: now(),
    });
    if (!resolved.ok) {
      logger.warn({ ...input, reason: resolved.reason }, "dev resume: escalation resolve failed");
      // If it was already resolved, still try to resume (idempotent forwarding).
      if (resolved.reason !== "already_resolved") return "failed";
    }

    const repoPath = deps.resolveRepoPath(session.repositoryId);
    const taskId = resolved.row?.taskId ?? null;
    const ownerDecision = `\n## Owner decision (resolved ${new Date(now()).toISOString()})\n${input.answer}\n`;

    if (taskId && repoPath) {
      // ── task-scoped escalation ──
      const task = getDevTask(deps.db, taskId);
      if (task && task.state === "awaiting_user" && task.worktreePath) {
        // A worker (RISK / supervise-ESCALATE / cap) is parked — write the
        // owner's call as authoritative guidance and re-queue it. The
        // orchestrator (live, or relaunched below) resumes it from its
        // checkpoint.
        if (resolved.row?.kind === "human_verify") {
          // Close the worktree's pending human rows from the owner's reply
          // BEFORE the requeue, or the worker would just re-escalate.
          const verdict = parseHumanVerifyReply(input.answer);
          const rows = parseChecklistMarkdown(readDevDoc(task.worktreePath, DEV_DOCS.checklist)) ?? [];
          const ids = rows
            .filter((r) => r.method === "human" && r.status !== "verified")
            .map((r) => r.acId);
          markChecklistRows(
            task.worktreePath,
            ids,
            verdict === "verified" ? "verified" : "failed",
            `owner ${verdict === "verified" ? "sign-off" : "rejection"} via escalation: `
              + input.answer.replace(/\|/g, "/").slice(0, 160),
          );
        }
        writeDevDoc(task.worktreePath, DEV_DOCS.supervisorGuidance, `${input.answer}\n`);
        appendDevDoc(task.worktreePath, DEV_DOCS.decisionRequests, ownerDecision);
        markDevTaskState(deps.db, { id: taskId, from: ["awaiting_user"], to: "queued", loopState: null, at: now() });
      } else if (task && task.planReview === "escalated") {
        // A phase-boundary plan review escalated (WP3 P1-14). Persist the
        // owner's keep/drop/revise call where planReviewTask re-reads it, then
        // RE-TRIGGER the review (escalated -> pending) so the re-run folds the
        // decision into a validated KEEP/REVISE — instead of rubber-stamping
        // the un-revised plan and releasing the held dependents blind.
        appendDevDoc(
          repoPath,
          `${DEV_TASK_ARCHIVE_DIR}/${task.taskKey}/decision-requests.md`,
          ownerDecision,
        );
        writeDevDoc(
          repoPath,
          `${DEV_TASK_ARCHIVE_DIR}/${task.taskKey}/${DEV_OWNER_PLAN_DECISION_FILE}`,
          `${input.answer}\n`,
        );
        setDevTaskPlanReview(deps.db, taskId, "pending", now());
      } else {
        // The task moved on (superseded/merged) — the answer is advisory only.
        appendDevDoc(repoPath, DEV_DOCS.decisionRequests, ownerDecision);
      }
    } else if (repoPath) {
      // Session-scoped (single loop, integration gate, or decompose failure).
      if (resolved.row?.kind === "human_verify") {
        // §6.6 human-method closure: the owner's reply closes the pending
        // human rows. The RUNNER is the only non-model writer of checklist
        // rows (loop-kit: "the human may edit rows; the loop may not"); the
        // engine re-syncs the DB mirror on the next iteration.
        const verdict = parseHumanVerifyReply(input.answer);
        const rows = parseChecklistMarkdown(readDevDoc(repoPath, DEV_DOCS.checklist)) ?? [];
        const ids = rows
          .filter((r) => r.method === "human" && r.status !== "verified")
          .map((r) => r.acId);
        markChecklistRows(
          repoPath,
          ids,
          verdict === "verified" ? "verified" : "failed",
          `owner ${verdict === "verified" ? "sign-off" : "rejection"} via escalation: `
            + input.answer.replace(/\|/g, "/").slice(0, 160),
        );
        logger.info({ sessionId: session.id, ids, verdict }, "dev human-verify rows closed");
      }
      appendDevDoc(repoPath, DEV_DOCS.decisionRequests, ownerDecision);
    }

    // Resume budget (WP3 P1-17) — a TOTAL escalation-resume cap, SCALED by the
    // task count for fleets so a legitimately human-heavy fleet (one decision
    // per task) is not blocked at the single-loop cap. The denominator is the
    // SESSION's fleet size (a single loop has zero task rows → cap = maxResumes;
    // a fleet has N rows → maxResumes × N), NOT the current escalation's scope —
    // so a late SESSION-scoped escalation (integration gate / dirty-repo /
    // refused-merge) is judged against the SAME scaled cap as the task ones,
    // instead of collapsing to the single-loop cap and killing a merged fleet at
    // its final gate. Per-streak semantics would need a mid-iteration reset, but
    // the engine re-persists its checkpoint every iteration and would clobber
    // it, so this stays a (scaled) lifetime floor. Re-read the session so a
    // concurrent fleet tick's counter writes are not clobbered by the checkpoint.
    const fresh = getDevSession(deps.db, session.id) ?? session;
    const config = normalizeDevLoopConfig(session.config);
    const taskCount = Math.max(1, listDevTasks(deps.db, session.id).length);
    const effectiveCap = config.maxResumes * taskCount;
    const resumes = fresh.resumes + 1;
    if (resumes > effectiveCap) {
      // Give up. For a mid-fleet block, abort the live run so no detached
      // worker keeps going, then reap the (now non-resumable) worktrees. NOTE:
      // a just-promoted sibling escalation is NOT delivered on this path (the
      // delivery is below, after the budget gate) so a blocked session never
      // asks the owner a fresh question it can no longer resume.
      if (midFleet) active.get(input.sessionId)?.abort(new Error("resume_budget_exceeded"));
      markDevTerminal(deps.db, { id: session.id, state: "failed", loopState: "BLOCKED", exitedAt: now() });
      cancelTimeout(session.id);
      cleanupFleetWorktrees(session.id);
      deps.onSessionEnded?.(session.id);
      await enqueueDigestDelivery(
        session,
        `Dev session for ${session.slug ?? session.repositoryId} blocked: hit the resume budget (${effectiveCap} decisions).`,
        `The loop needed more than ${effectiveCap} human decisions. Restart with a sharper contract if you want to continue.`,
      );
      return "blocked";
    }
    writeDevCheckpoint(
      deps.db,
      {
        id: session.id,
        iteration: fresh.iteration,
        agentFailures: fresh.agentFailures,
        gateReviseCount: fresh.gateReviseCount,
        iterReviseCount: fresh.iterReviseCount,
        resumes,
      },
      now(),
    );

    // Kick the loop forward SYNCHRONOUSLY (no await before the wake) so the
    // resume decision cannot race the live orchestrator tearing down, and so the
    // block path above has already returned before any owner-facing side effect.
    if (midFleet) {
      // The orchestrator is already running — wake its dispatch loop so it picks
      // up the re-queued task / re-triggered plan review. Do NOT relaunch the
      // loop or touch the session state (WP3 P0-4).
      orchestrator!.notifyExternalChange();
      logger.info(
        { sessionId: input.sessionId, escalationId: input.escalationId },
        "dev fleet resumed in place after escalation",
      );
    } else {
      // Parked: flip the session back to running and relaunch the loop; the
      // engine / a fresh orchestrator resume from the checkpoint.
      const running = markDevRunningFromParked(deps.db, input.sessionId, now());
      if (!running) return "failed";
      void runLoop(input.sessionId).catch((err) => {
        logger.error({ err, sessionId: input.sessionId }, "dev resume runLoop rejected");
      });
      logger.info({ sessionId: input.sessionId, escalationId: input.escalationId }, "dev session resumed after escalation");
    }

    // Serialization (WP3 P0-5): now that the resume is COMMITTED (past the budget
    // gate) and the loop is awake/relaunched, deliver the sibling escalation the
    // resolve promoted to active — so the owner is asked exactly one question at
    // a time. Delivering before the budget gate could ask a fresh question on a
    // session about to be terminated (dead-end + a contradictory "blocked" DM).
    if (resolved.promoted) {
      const s = getDevSession(deps.db, input.sessionId);
      if (s) {
        await enqueueEscalationDelivery(s, resolved.promoted.id, {
          question: resolved.promoted.question,
          contextSummary: resolved.promoted.contextSummary,
        });
      }
    }
    return "resumed";
  }

  /** Rename a failed task's surviving branch to a probed-unique seed and
   *  requeue it with fresh per-task heuristics — the honest v1 of loop-kit's
   *  resume_class relaunch/requeue (the committed work folds back into the
   *  fresh worktree via seedMergeFromBranch at bootstrap). */
  function prepareTasksForResume(sessionId: string, repoPath: string): number {
    let requeued = 0;
    for (const task of listDevTasks(deps.db, sessionId)) {
      if (task.state !== "failed" && task.state !== "dep_failed") continue;
      if (task.branch && gitBranchExists(repoPath, task.branch)) {
        let renamed = `${task.branch}-resume-1`;
        for (let n = 2; gitBranchExists(repoPath, renamed); n += 1) {
          renamed = `${task.branch}-resume-${n}`;
        }
        try {
          gitRenameBranch(repoPath, task.branch, renamed);
          // Always seed from the NEWEST renamed branch: each rename captures
          // the cumulative work (the prior attempt was itself seeded from its
          // predecessor), so the latest branch is a strict superset. Keeping a
          // stale seed would orphan the most recent attempt's commits.
          setDevTaskSeedBranch(deps.db, task.id, renamed, now());
        } catch (err) {
          logger.warn({ err, taskKey: task.taskKey }, "dev resume: branch rename failed (redo from merged HEAD)");
        }
      }
      if (task.worktreePath) gitWorktreeRemove(repoPath, task.worktreePath);
      if (requeueDevTaskForResume(deps.db, { id: task.id, at: now() })) requeued += 1;
    }
    return requeued;
  }

  async function resumeSession(input: {
    sessionId: string;
    budgetUsd?: number;
    iters?: number;
    note?: string;
  }): Promise<DevResumeResult> {
    const session = getDevSession(deps.db, input.sessionId);
    if (!session) return { ok: false, reason: "that dev session no longer exists" };
    if (session.rolledBackAt !== null) {
      return { ok: false, reason: "that session was rolled back — start fresh with !repo" };
    }
    if (session.state === "running") {
      return { ok: false, reason: "the loop is already running" };
    }
    if (session.state === "interview" || session.state === "awaiting_approval") {
      return {
        ok: false,
        reason: "nothing to resume — finish the interview (or reply !approve)",
      };
    }
    const repoPath = deps.resolveRepoPath(session.repositoryId);
    if (!repoPath) return { ok: false, reason: "the repository's local path is unresolved" };

    if (session.state === "awaiting_user") {
      const open = getOpenDevEscalationForSession(deps.db, session.id);
      if (open) {
        return {
          ok: false,
          reason: `there's an open question — answer it instead: ${open.question.slice(0, 140)}`,
        };
      }
      // Defensive: parked with no answerable row on file (historical dead
      // end) — flip back to running and relaunch from the checkpoint.
      if (!markDevRunningFromParked(deps.db, session.id, now())) {
        return { ok: false, reason: "could not un-park the session (state moved)" };
      }
      void runLoop(session.id).catch((err) => logger.error({ err }, "dev resume runLoop rejected"));
      return { ok: true };
    }

    // Terminal states from here.
    const config = normalizeDevLoopConfig(session.config);
    if (session.state === "exited" && session.branch === null) {
      return { ok: false, reason: "the session never started its loop — begin again with !repo" };
    }
    if (session.state === "done") {
      const queuedManual = listDevTasks(deps.db, session.id).some(
        (t) => t.state === "queued" && t.origin === "manual",
      );
      if (!queuedManual) {
        return { ok: false, reason: "nothing to resume — the run finished; use !add for follow-up work" };
      }
    }

    // The crash/terminal-resume backstop (loop-kit MAX_RESUMES; resets to 0
    // on any evaluated iteration).
    if (session.runResumes + 1 > config.maxResumes) {
      return {
        ok: false,
        reason: `resumed ${session.runResumes} times without an evaluated iteration — start fresh with !repo`,
      };
    }

    // BUDGET_EXCEEDED: resume only with headroom, or with an explicit raise
    // (the loop-kit budget-only re-approval — the sans-budget hash proves
    // nothing else changed, so the anchor may be rebound without a fresh
    // human approval round).
    if (session.loopState === "BUDGET_EXCEEDED") {
      const raise = input.budgetUsd !== undefined || input.iters !== undefined;
      if (raise) {
        const contractMd = readDevDoc(repoPath, DEV_DOCS.contract) ?? "";
        if (computeApprovalHash(contractMd, config) !== session.approvedHash) {
          return { ok: false, reason: "the contract or config changed since approval — start a new session" };
        }
        if (input.iters !== undefined && input.iters <= session.iteration) {
          return { ok: false, reason: `iters must exceed the current iteration (${session.iteration})` };
        }
        if (input.budgetUsd !== undefined && input.budgetUsd <= (session.costUsd ?? 0)) {
          return { ok: false, reason: `budget must exceed the current spend ($${(session.costUsd ?? 0).toFixed(2)})` };
        }
        const newConfig = normalizeDevLoopConfig({
          ...(session.config ?? {}),
          maxCostUsd: input.budgetUsd ?? config.maxCostUsd,
          maxIterations: input.iters ?? config.maxIterations,
        } as Partial<DevLoopConfig>);
        const validation = validateDevLoopConfig(newConfig);
        if (!validation.ok) return { ok: false, reason: validation.errors[0]! };
        if (computeConfigHashSansBudget(newConfig) !== computeConfigHashSansBudget(config)) {
          return { ok: false, reason: "only the budget keys may change on a resume" };
        }
        updateDevSessionConfig(
          deps.db,
          session.id,
          { config: newConfig as unknown as Record<string, unknown> },
          now(),
        );
        rebindDevSessionApproval(deps.db, {
          id: session.id,
          approvedHash: computeApprovalHash(contractMd, newConfig),
          maxIterations: newConfig.maxIterations,
          maxBudgetUsd: newConfig.maxCostUsd,
          at: now(),
        });
      } else {
        const iterationHeadroom = session.iteration < (session.maxIterations ?? config.maxIterations);
        const costHeadroom =
          session.maxBudgetUsd === null || (session.costUsd ?? 0) < session.maxBudgetUsd;
        if (!iterationHeadroom || !costHeadroom) {
          return {
            ok: false,
            reason:
              `budget exhausted (iteration ${session.iteration}/${session.maxIterations ?? config.maxIterations}, `
              + `$${(session.costUsd ?? 0).toFixed(2)}${session.maxBudgetUsd !== null ? `/$${session.maxBudgetUsd}` : ""}) — `
              + "raise it: !resume budget=<usd> and/or iters=<n>",
          };
        }
      }
    }

    // Fresh stop-heuristic windows for an EXPLICIT resume of a stopped run
    // (loop-kit 6996-7003): the persisted revise/failure counters reset;
    // stagnation/futile/fingerprints are engine-memory and reset by
    // construction. iteration / cost / base_ref persist.
    resetDevSessionStopHeuristics(deps.db, session.id, now());
    prepareTasksForResume(session.id, repoPath);
    if (!markDevRunningFromTerminal(deps.db, { id: session.id, at: now() })) {
      return { ok: false, reason: "could not resume (the session state moved)" };
    }
    const resumes = bumpDevSessionRunResumes(deps.db, session.id, now());
    recordDevIteration(deps.db, {
      id: uuid(),
      sessionId: session.id,
      iteration: session.iteration,
      phase: "resume",
      verdict: "RUN_RESUME",
      reason:
        `resume #${resumes}; previous: ${session.state}/${session.loopState ?? "-"}`
        + "; stop-heuristic windows reset"
        + (input.budgetUsd !== undefined || input.iters !== undefined ? "; budget rebound" : ""),
      createdAt: now(),
    });
    if (input.note && input.note.trim().length > 0) {
      // The steer note is THE owner decision for the next iteration.
      writeDevDoc(repoPath, DEV_DOCS.supervisorGuidance, `${input.note.trim()}\n`);
      appendDevDoc(
        repoPath,
        DEV_DOCS.decisionRequests,
        `\n## Owner decision (resume ${new Date(now()).toISOString()})\n${input.note.trim()}\n`,
      );
    }
    cancelTimeout(session.id);
    void runLoop(session.id).catch((err) => {
      logger.error({ err, sessionId: session.id }, "dev resume runLoop rejected");
    });
    logger.info({ sessionId: session.id, resumes }, "dev session resumed from terminal");
    return { ok: true };
  }

  async function resumeFromBoot(sessionId: string): Promise<void> {
    const session = getDevSession(deps.db, sessionId);
    if (!session) return;
    if (session.state === "running") {
      // RUN_ABEND: the daemon died while the loop was RUNNING (no interrupt
      // trap fired). Journal it and advance the resume backstop BEFORE any
      // recovery side effect — a crash loop must not relaunch forever.
      const config = normalizeDevLoopConfig(session.config);
      const resumes = bumpDevSessionRunResumes(deps.db, sessionId, now());
      recordDevIteration(deps.db, {
        id: uuid(),
        sessionId,
        iteration: session.iteration,
        phase: "resume",
        verdict: "RUN_ABEND",
        reason: `the daemon died while the loop was running; boot resume #${resumes}`,
        createdAt: now(),
      });
      if (resumes > config.maxResumes) {
        logger.error({ sessionId, resumes }, "dev boot: resume backstop hit — failing the session");
        markDevTerminal(deps.db, { id: sessionId, state: "failed", loopState: "BLOCKED", exitedAt: now() });
        cleanupFleetWorktrees(sessionId);
        deps.onSessionEnded?.(sessionId);
        const fresh = getDevSession(deps.db, sessionId);
        if (fresh) {
          await enqueueDigestDelivery(
            fresh,
            `Dev session for ${fresh.slug ?? fresh.repositoryId} blocked: crashed/resumed ${resumes} times without progress.`,
            "The daemon kept dying mid-loop. Inspect the logs, then start fresh with !repo (or !rollback to restore your branch).",
          );
        }
        return;
      }
      logger.info({ sessionId, resumes }, "dev boot: resuming running loop from checkpoint");
      void runLoop(sessionId).catch((err) => {
        logger.error({ err, sessionId }, "dev boot runLoop rejected");
      });
      return;
    }
    if (session.state === "interview" || session.state === "awaiting_approval") {
      // Still waiting on the human — re-arm the inactivity timer.
      armTimeout(sessionId);
      return;
    }
    // awaiting_user: leave parked; the escalation-delivery recovery sweep +
    // a DM answer resumes it. No timer (escalations never expire).
  }

  async function expireForTimeout(sessionId: string): Promise<void> {
    const session = getDevSession(deps.db, sessionId);
    if (!session) return;
    // Only the human-wait states auto-expire. A running loop bounds itself via
    // iteration/budget caps; an open escalation must never be killed.
    if (session.state !== "interview" && session.state !== "awaiting_approval") {
      setDevTimeoutScheduleId(deps.db, sessionId, null);
      return;
    }
    markDevTerminal(deps.db, { id: sessionId, state: "exited", loopState: null, exitedAt: now() });
    setDevTimeoutScheduleId(deps.db, sessionId, null);
    deps.onSessionEnded?.(sessionId);
    await enqueueDigestDelivery(
      session,
      `Dev session for ${session.slug ?? session.repositoryId} expired after inactivity.`,
      "No activity for the timeout window — the session was closed to free dev mode. Start again with !repo.",
    );
    logger.info({ sessionId }, "dev session expired for inactivity");
  }

  function isRunning(sessionId: string): boolean {
    return active.has(sessionId);
  }

  function hasLiveOrchestrator(sessionId: string): boolean {
    return orchestrators.has(sessionId);
  }

  function notifyTaskQueued(sessionId: string): void {
    orchestrators.get(sessionId)?.notifyExternalChange();
  }

  return {
    runInterviewTurn,
    startFromApproval,
    cancel,
    resumeSession,
    resumeAfterEscalation,
    resumeFromBoot,
    expireForTimeout,
    armTimeout,
    cancelTimeout,
    retimeTimeout,
    isRunning,
    hasLiveOrchestrator,
    notifyTaskQueued,
  };
}
