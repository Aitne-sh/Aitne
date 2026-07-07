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
} from "../../db/dev-session-escalations-store.js";
import {
  DEV_DOCS,
  appendDevDoc,
  ensureDevWorkdir,
  gitCommitAll,
  gitCreateBranch,
  gitHead,
  readAgentStateFirstLine,
  readDevDoc,
} from "./dev-loop-docs.js";
import {
  computeApprovalHash,
  normalizeDevLoopConfig,
  validateDevLoopConfig,
} from "./dev-loop-config.js";
import { extractContractRequirements, parseAgentStateToken } from "./verdict-parse.js";
import type { DevLoopConfig } from "./types.js";
import { DevLoopEngine, type DevIterationOutcome } from "./dev-loop-engine.js";
import { createDevLegRunner, type DevBackend } from "./dev-loop-legs.js";
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
   *  practice (D5) but keyed for clarity + defensive multi-session safety. */
  const active = new Map<string, AbortController>();

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
    outcome: Extract<DevIterationOutcome, { kind: "escalate" }>,
  ): Promise<void> {
    if (!deps.deliveryEnqueuer) return;
    try {
      await deps.deliveryEnqueuer.enqueueEscalation({
        sessionId: session.id,
        escalationId,
        originatingChannel: session.originatingChannel,
        title: session.slug ?? session.repositoryId,
        question: outcome.question,
        contextSummary: outcome.contextSummary,
      });
    } catch (err) {
      logger.warn({ err, sessionId: session.id }, "dev escalation delivery enqueue failed (recovery sweep will retry)");
    }
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
    createDevEscalation(deps.db, {
      id: escalationId,
      sessionId,
      kind: outcome.escalationKind,
      question: outcome.question,
      contextSummary: outcome.contextSummary,
      askedAt: now(),
    });
    markDevAwaitingUser(deps.db, sessionId, now());
    // Escalations never auto-expire — cancel the inactivity timer while parked.
    cancelTimeout(sessionId);
    const session = getDevSession(deps.db, sessionId);
    if (session) await enqueueEscalationDelivery(session, escalationId, outcome);
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

  async function failLoud(sessionId: string, err: unknown): Promise<void> {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error({ err, sessionId }, "dev loop threw — marking failed");
    const session = getDevSession(deps.db, sessionId);
    markDevTerminal(deps.db, { id: sessionId, state: "failed", loopState: null, exitedAt: now() });
    cancelTimeout(sessionId);
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
      const backend = deps.makeBackend(controller);
      const legRunner = createDevLegRunner({ backend, loadTaskFlow: deps.loadTaskFlow });
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
          await handleEscalate(sessionId, outcome);
          return;
        }
        await handleTerminal(sessionId, outcome);
        return;
      }
    } catch (err) {
      await failLoud(sessionId, err);
    } finally {
      active.delete(sessionId);
    }
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
      config.deniedPaths.length > 0 ? `Denied paths: ${config.deniedPaths.join(", ")}` : "",
      `Max iterations: ${config.maxIterations}`
        + (session.maxBudgetUsd ? `  ·  Budget: $${session.maxBudgetUsd}` : ""),
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

    // Interview turns are not part of the loop; give them their own controller.
    const controller = new AbortController();
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
      maxBudgetUsd: 0.6,
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
      maxBudgetUsd: session.maxBudgetUsd,
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
    if (!session || session.state !== "awaiting_user") return "failed";

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

    // Fold the owner's decision into decision-requests.md so the next implement
    // leg (fresh context) sees the resolution.
    const repoPath = deps.resolveRepoPath(session.repositoryId);
    if (repoPath) {
      appendDevDoc(
        repoPath,
        DEV_DOCS.decisionRequests,
        `\n## Owner decision (resolved ${new Date(now()).toISOString()})\n${input.answer}\n`,
      );
    }

    // Resume budget — a TOTAL escalation-resume cap for the session (not
    // loop-kit's per-streak "consecutive resumes that never complete an
    // iteration"). The per-streak semantics would need a reset when an
    // iteration completes, but the engine re-persists its construction-time
    // checkpoint on every iteration and would clobber a mid-loop reset the
    // runner wrote — so this is a lifetime cap instead. It is a reasonable
    // safety floor: a bounded dev session needing more than `maxResumes`
    // human decisions signals a contract too ambiguous to finish, and should
    // be restarted with a sharper contract rather than looped indefinitely.
    const config = normalizeDevLoopConfig(session.config);
    const resumes = session.resumes + 1;
    if (resumes > config.maxResumes) {
      markDevTerminal(deps.db, { id: session.id, state: "failed", loopState: "BLOCKED", exitedAt: now() });
      cancelTimeout(session.id);
      deps.onSessionEnded?.(session.id);
      await enqueueDigestDelivery(
        session,
        `Dev session for ${session.slug ?? session.repositoryId} blocked: hit the resume budget (${config.maxResumes} decisions).`,
        `The loop needed more than ${config.maxResumes} human decisions. Restart with a sharper contract if you want to continue.`,
      );
      return "blocked";
    }
    writeDevCheckpoint(
      deps.db,
      {
        id: session.id,
        iteration: session.iteration,
        agentFailures: session.agentFailures,
        gateReviseCount: session.gateReviseCount,
        iterReviseCount: session.iterReviseCount,
        resumes,
      },
      now(),
    );

    const running = markDevRunningFromParked(deps.db, input.sessionId, now());
    if (!running) return "failed";
    void runLoop(input.sessionId).catch((err) => {
      logger.error({ err, sessionId: input.sessionId }, "dev resume runLoop rejected");
    });
    logger.info({ sessionId: input.sessionId, escalationId: input.escalationId }, "dev session resumed after escalation");
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
