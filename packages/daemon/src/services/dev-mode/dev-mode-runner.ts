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
  getDevSession,
  markDevAwaitingApproval,
  markDevTerminal,
  markDevAwaitingUser,
  markDevRunningFromParked,
  seedDevRequirements,
  setDevTimeoutScheduleId,
  updateDevSessionConfig,
  writeDevCheckpoint,
  countDevRequirements,
  type DevSessionRow,
} from "../../db/dev-sessions-store.js";
import {
  createDevEscalation,
  resolveDevEscalation,
  type DevEscalationKind,
} from "../../db/dev-session-escalations-store.js";
import {
  getDevTask,
  listDevTasks,
  markDevTaskState,
  setDevTaskPlanReview,
} from "../../db/dev-session-tasks-store.js";
import {
  DEV_DOCS,
  DEV_OWNER_PLAN_DECISION_FILE,
  DEV_TASK_ARCHIVE_DIR,
  appendDevDoc,
  ensureDevWorkdir,
  gitCommitAll,
  gitCreateBranch,
  gitHead,
  readAgentStateFirstLine,
  readDevDoc,
  writeDevDoc,
} from "./dev-loop-docs.js";
import { gitWorktreeRemove } from "./dev-flow-git.js";
import {
  computeApprovalHash,
  normalizeDevLoopConfig,
  validateDevLoopConfig,
} from "./dev-loop-config.js";
import { extractContractRequirements, parseAgentStateToken } from "./verdict-parse.js";
import type { DevLoopConfig } from "./types.js";
import { DevLoopEngine, type DevIterationOutcome } from "./dev-loop-engine.js";
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

export interface DevModeRunner {
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
      const config = normalizeDevLoopConfig(session.config);
      const backend = deps.makeBackend(controller);
      const legRunner = createDevLegRunner({ backend, loadTaskFlow: deps.loadTaskFlow });

      // Fleet path: decompose the contract into a task DAG, then run the
      // orchestrator. A resume (tasks already exist) re-enters mid-fleet. When
      // decompose returns "single" (n=1), fall through to the classic loop.
      if (config.flow.decompose) {
        const flowLegs = createDevFlowLegRunner({ backend, loadTaskFlow: deps.loadTaskFlow });
        const orchestrator = createDevFleetOrchestrator({
          db: deps.db,
          repoPath,
          session,
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
        logger.info({ sessionId }, "dev fleet: n=1 — running the single loop");
      }

      // Single-loop path (decompose disabled or n=1).
      const engine = new DevLoopEngine(session, {
        db: deps.db,
        repoPath,
        legRunner,
        tier,
        now,
        uuid,
      });

      await engine.ensurePlan();
      if (controller.signal.aborted) return;

      let n = Math.max(1, session.iteration);
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
  ): string {
    const reqs = extractContractRequirements(contractMd);
    const goal = extractGoal(contractMd);
    const lines = [
      `Contract ready for ${session.slug ?? session.repositoryId}.`,
      goal ? `\nGoal: ${goal}` : "",
      `\nRequirements (${reqs.length}):`,
      ...reqs.map((r) => `  • ${r.id}: ${r.title}`),
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

  /** CONTRACT_READY path — validate the drafted contract + config and move the
   *  session to awaiting_approval, returning the loop summary. On any gap,
   *  return a follow-up question and stay in interview. */
  function finalizeContract(session: DevSessionRow, repoPath: string): string {
    const contractMd = readDevDoc(repoPath, DEV_DOCS.contract);
    if (!contractMd || contractMd.trim().length === 0) {
      return "I couldn't find the drafted contract yet — what's the goal you want me to build toward?";
    }
    const reqs = extractContractRequirements(contractMd);
    if (reqs.length === 0) {
      return "The contract still needs at least one numbered requirement (a `### REQ-001: …` heading). What's the first concrete, verifiable requirement?";
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
      return `Almost there — ${validation.errors.join(" ")} What command(s) should verify success (e.g. \`npm test\` or \`pytest\`)?`;
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
    logger.info({ sessionId: session.id, reqCount: reqs.length }, "dev contract finalized — awaiting approval");
    return renderLoopSummary(finalRow, contractMd, config);
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

    const draft = readDevDoc(repoPath, DEV_DOCS.contract);
    const context = [
      "<dev_interview_context>",
      `Repo: ${session.slug ?? session.repositoryId}  ·  Local path: ${repoPath}`,
      `Session id: ${session.id}`,
      "",
      "## Current contract draft (.aitne-dev/docs/product-contract.md)",
      draft && draft.trim().length > 0 ? draft : "(none yet — this is the first turn)",
      "",
      "## Owner's latest message",
      input.userMessage,
      "</dev_interview_context>",
    ].join("\n");

    // Interview turns are not part of the loop, but they must be abortable —
    // register the controller in `active` so a !exit / inactivity timeout
    // unwinds a mid-interview leg instead of waiting out maxSeconds (WP3
    // P1-15). Interview and loop states are mutually exclusive, so this never
    // collides with a runLoop controller; the finally only clears our own.
    const controller = new AbortController();
    active.set(input.sessionId, controller);
    try {
      const backend = deps.makeBackend(controller);
      const resp = await backend.runLeg({
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
      if (resp.isError) {
        return "Something went wrong while drafting the contract. Try rephrasing, or reply !exit to stop.";
      }

      const stateToken = parseAgentStateToken(readAgentStateFirstLine(repoPath));
      if (stateToken === "CONTRACT_READY") {
        return finalizeContract(session, repoPath);
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

    ensureDevWorkdir(repoPath);
    const contractMd = readDevDoc(repoPath, DEV_DOCS.contract);
    if (!contractMd || contractMd.trim().length === 0) {
      return { ok: false, reason: "product-contract.md missing — run the interview first" };
    }
    const reqs = extractContractRequirements(contractMd);
    if (reqs.length === 0) {
      return { ok: false, reason: "contract has no REQ-### requirements" };
    }

    // Move onto the dev branch (dirty worktree carries over), snapshot the
    // pre-loop baseline there so per-iteration diffs are clean, and anchor the
    // run baseline. Never touches the owner's original branch (D6).
    const branch = `aitne-dev/${sessionId}`;
    try {
      gitCreateBranch(repoPath, branch);
      gitCommitAll(repoPath, "dev: baseline snapshot (pre-loop)");
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
    const approved = approveDevSession(deps.db, {
      id: sessionId,
      approvedHash,
      branch,
      baseRef,
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

  async function resumeFromBoot(sessionId: string): Promise<void> {
    const session = getDevSession(deps.db, sessionId);
    if (!session) return;
    if (session.state === "running") {
      logger.info({ sessionId }, "dev boot: resuming running loop from checkpoint");
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

  return {
    runInterviewTurn,
    startFromApproval,
    cancel,
    resumeAfterEscalation,
    resumeFromBoot,
    expireForTimeout,
    armTimeout,
    cancelTimeout,
    retimeTimeout,
    isRunning,
  };
}
