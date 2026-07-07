/**
 * Development-mode fleet orchestrator — the native port of loop-kit's
 * decompose flow + fleet orchestration (cmd_decompose_flow:4383,
 * run_fleet_orchestration:4707, tick:3047, bootstrap_worktree:1755,
 * reap/merge/supervise/plan-review, integration gate), re-expressed as an
 * event-driven dispatcher instead of a 2s poll:
 *
 *   - every RUNNING task is a promise driving one DevLoopEngine in its own
 *     git worktree (fresh Claude Code processes per leg — the phase boundary
 *     is a worktree boundary);
 *   - supervise / merge / plan-review run on a single CONTROL LANE (one
 *     mutation at a time — loop-kit's "at most one per tick" invariant);
 *   - WHAT to do next is the pure planFleetActions (dev-flow-schedule.ts);
 *     this file is the I/O shell that executes its actions.
 *
 * The session lifecycle (running / awaiting_user / terminal) stays the
 * runner's job: this module returns a DevFleetRunResult and creates task
 * escalation rows through the injected onTaskEscalation (immediate DM —
 * independent siblings keep running while the owner answers, D-G).
 *
 * I/O-bound (db/git/fs/model legs); excluded from the coverage gate. The
 * decision logic it executes lives in the covered peers (task-plan.ts,
 * dev-flow-schedule.ts, verdict-parse.ts, dev-loop-evaluate.ts).
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { BackendModelTier } from "@aitne/shared";
import {
  addDevSessionCost,
  bumpDevSessionFleetCounter,
  countDevRequirements,
  countDevRequirementsIn,
  getDevSession,
  listDevRequirements,
  recordDevIteration,
  updateDevRequirement,
  type DevSessionLoopState,
  type DevSessionRow,
} from "../../db/dev-sessions-store.js";
import {
  addDevTaskCost,
  bumpDevTaskSuperviseCount,
  claimDevTask,
  getDevTask,
  insertDevTasks,
  listDevTasks,
  markDevTaskState,
  resetDevTaskForRedo,
  rewireDevTaskDeps,
  setDevTaskPlanReview,
  setDevTaskSeedBranch,
  setDevTaskWorktree,
  writeDevTaskCheckpoint,
  type DevTaskRow,
  type DevTaskLoopState,
} from "../../db/dev-session-tasks-store.js";
import type { DevEscalationKind } from "../../db/dev-session-escalations-store.js";
import {
  DEV_DOCS,
  DEV_PHASE_CONTEXT_DIR,
  DEV_TASK_ARCHIVE_DIR,
  copyDevDoc,
  ensureDevWorkdir,
  gitDiffPaths,
  gitHead,
  isWholeRunDiffEmpty,
  parseLedgerMarkdown,
  readDevDoc,
  removeDevDoc,
  runVerifyCommand,
  writeDevDoc,
  writeLastVerifyLog,
} from "./dev-loop-docs.js";
import {
  gitBranchExists,
  gitMergeInProgress,
  gitMergeNoFF,
  gitRenameBranch,
  gitWorktreeAdd,
  gitWorktreeRemove,
  hasUncommittedTracked,
  runSetupCommand,
  seedMergeFromBranch,
  worktreeRootFor,
} from "./dev-flow-git.js";
import {
  classifyIdleFleet,
  planFleetActions,
  renderParallelContext,
  renderQueueSnapshot,
  type DevFleetTaskSnapshot,
  type DevQueueSnapshotTask,
} from "./dev-flow-schedule.js";
import {
  planParallelGroups,
  validateFixupTask,
  validatePlanRevision,
  validateReplanBlock,
  validateTaskPlan,
  type DevLiveTaskLike,
  type DevPlanTask,
} from "./task-plan.js";
import { evaluateIteration, EMPTY_BOOKKEEPING } from "./dev-loop-evaluate.js";
import { computeApprovalHash, normalizeDevLoopConfig } from "./dev-loop-config.js";
import { extractContractReqIds } from "./verdict-parse.js";
import {
  DevLoopEngine,
  type DevEnginePersistence,
  type DevLegResponse,
  type DevLegRunner,
} from "./dev-loop-engine.js";
import type { DevFlowLegRunner } from "./dev-flow-legs.js";
import type { DevLoopConfig } from "./types.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("dev-flow-orchestrator");

export type DevFleetRunResult =
  /** Decompose said n=1 — the caller runs the classic single loop. */
  | { kind: "single" }
  | { kind: "terminal"; loopState: DevSessionLoopState; reason: string }
  /** The session must park awaiting_user (escalation rows already exist). */
  | { kind: "parked"; reason: string };

export interface DevFleetOrchestratorDeps {
  db: Database.Database;
  /** The registered repo (the session branch is checked out here). */
  repoPath: string;
  session: DevSessionRow;
  config: DevLoopConfig;
  /** Worker legs (plan/implement/review/stop_eval/evidence). */
  legRunner: DevLegRunner;
  /** Fleet legs (decompose/review/supervise/plan-review). */
  flowLegs: DevFlowLegRunner;
  tier: BackendModelTier;
  now: () => number;
  uuid: () => string;
  /** The run-level abort (cancel / !exit) — forwarded to legs by the backend. */
  signal: AbortSignal;
  /** Create the escalation row + DM the owner immediately. taskId null =
   *  session-scoped (decompose failure / integration gate). */
  onTaskEscalation: (input: {
    taskId: string | null;
    kind: DevEscalationKind;
    question: string;
    contextSummary: string | null;
  }) => Promise<void>;
  /** Mid-run DM notes (flow summary, merges, replans). Best-effort. */
  onFleetNote?: (text: string) => Promise<void>;
  /** Merge-defer retry delay (tests shrink it). */
  mergeDeferMs?: number;
}

export interface DevFleetOrchestrator {
  run(): Promise<DevFleetRunResult>;
  /** Wake the dispatch loop after an external DB change (a task escalation
   *  answered mid-fleet). */
  notifyExternalChange(): void;
}

const MERGE_DEFER_LIMIT = 20;

export function createDevFleetOrchestrator(
  deps: DevFleetOrchestratorDeps,
): DevFleetOrchestrator {
  const { db, repoPath, config, legRunner, flowLegs, tier, now, uuid, signal } = deps;
  const sessionId = deps.session.id;
  const flow = config.flow;
  const mergeDeferMs = deps.mergeDeferMs ?? 3000;
  const wtRoot = worktreeRootFor(repoPath, sessionId);

  // ── dispatch state ──
  const running = new Map<string, Promise<void>>();
  let controlBusy = false;
  let fatal: DevFleetRunResult | null = null;
  let mergeDeferCount = 0;
  let mergeDeferredUntil = 0;
  let wakeResolve: (() => void) | null = null;

  const notify = (): void => {
    wakeResolve?.();
    wakeResolve = null;
  };
  const waitForWake = (): Promise<void> =>
    new Promise((resolve) => {
      wakeResolve = resolve;
    });

  // ── shared helpers ──

  const liveSession = (): DevSessionRow => getDevSession(db, sessionId) ?? deps.session;

  const spentUsd = (): number => liveSession().costUsd ?? 0;

  const overBudget = (): boolean => {
    const cap = deps.session.maxBudgetUsd;
    return cap !== null && spentUsd() >= cap;
  };

  const toSnapshot = (t: DevTaskRow): DevFleetTaskSnapshot => ({
    id: t.id,
    taskKey: t.taskKey,
    state: t.state,
    dependsOn: t.dependsOn,
    planReview: t.planReview,
    loopState: t.loopState,
  });

  const toLive = (t: DevTaskRow): DevLiveTaskLike => ({
    key: t.taskKey,
    state: t.state,
    dependsOn: t.dependsOn,
    reqs: t.reqs,
    seedBranch: t.seedBranch,
  });

  const toQueueTask = (t: DevTaskRow, withBody = false): DevQueueSnapshotTask => ({
    taskKey: t.taskKey,
    state: t.state,
    dependsOn: t.dependsOn,
    reqs: t.reqs,
    summary: t.summary,
    scope: t.scope,
    planReview: t.planReview,
    ...(withBody ? { body: t.body } : {}),
  });

  /** One journal row for a fleet-level or task-scoped flow leg. */
  const recordFlow = (
    phase: "decompose" | "decompose_review" | "supervise" | "plan_review" | "merge" | "gate" | "evidence" | "evaluate",
    input: {
      taskId?: string | null;
      verdict: string | null;
      reason?: string | null;
      responses?: readonly DevLegResponse[];
      commitSha?: string | null;
      iteration?: number;
    },
  ): void => {
    const responses = input.responses ?? [];
    const cost = responses.reduce((acc, r) => acc + (r.costUsd > 0 ? r.costUsd : 0), 0);
    recordDevIteration(db, {
      id: uuid(),
      sessionId,
      taskId: input.taskId ?? null,
      iteration: input.iteration ?? 0,
      phase,
      verdict: input.verdict,
      reason: input.reason ?? null,
      costUsd: cost > 0 ? cost : null,
      commitSha: input.commitSha ?? null,
      createdAt: now(),
    });
    if (cost > 0) addDevSessionCost(db, sessionId, cost);
  };

  const flowLegCtx = () => ({
    session: liveSession(),
    repoPath,
    config,
    tier,
  });

  const parkTaskForUser = async (
    task: DevTaskRow,
    fromStates: readonly DevTaskRow["state"][],
    kind: DevEscalationKind,
    question: string,
    contextSummary: string | null,
  ): Promise<void> => {
    markDevTaskState(db, {
      id: task.id,
      from: fromStates,
      to: "awaiting_user",
      at: now(),
    });
    await deps.onTaskEscalation({ taskId: task.id, kind, question, contextSummary });
  };

  const escalationKindFor = (loopState: DevTaskLoopState | null): DevEscalationKind => {
    switch (loopState) {
      case "NEEDS_ARCHITECTURE_DECISION":
        return "architecture_decision";
      case "RISK_REQUIRES_APPROVAL":
        return "risk_approval";
      default:
        return "spec_decision";
    }
  };

  /** Refresh parallel-context.md in every live worktree. */
  const refreshParallelContext = (): void => {
    const tasks = listDevTasks(db, sessionId);
    const queueTasks = tasks.map((t) => toQueueTask(t));
    for (const t of tasks) {
      if (!t.worktreePath || !existsSync(t.worktreePath)) continue;
      if (t.state === "merged" || t.state === "failed" || t.state === "superseded" || t.state === "dep_failed") continue;
      try {
        writeDevDoc(t.worktreePath, DEV_DOCS.parallelContext, renderParallelContext(t.taskKey, queueTasks));
      } catch (err) {
        logger.warn({ err, taskKey: t.taskKey }, "parallel-context refresh failed");
      }
    }
  };

  const decomposePlanHash = (contract: string, planMd: string): string =>
    createHash("sha256").update(`${contract}\n${planMd}`, "utf8").digest("hex");

  // ── Decompose flow (cmd_decompose_flow port) ──────────────────────────

  /** Returns null when fleet tasks are ready; otherwise the early result. */
  async function decomposeFlow(): Promise<DevFleetRunResult | null> {
    if (listDevTasks(db, sessionId).length > 0) return null; // resume
    const contract = readDevDoc(repoPath, DEV_DOCS.contract) ?? "";
    const masterReqIds = extractContractReqIds(contract);

    // Reuse marker — an approved plan whose contract+plan hash still matches
    // revalidates deterministically (no model call).
    const existingPlan = readDevDoc(repoPath, DEV_DOCS.taskPlan);
    const marker = readDevDoc(repoPath, DEV_DOCS.decomposeApproved)?.trim();
    let plan: { tasks: DevPlanTask[]; topo: string[] } | null = null;
    if (existingPlan && marker === decomposePlanHash(contract, existingPlan)) {
      const v = validateTaskPlan(existingPlan, {
        cap: flow.maxTasks,
        verdictN: null,
        masterReqIds,
      });
      if (v.ok) plan = { tasks: v.tasks, topo: v.topo };
    }

    if (!plan) {
      const generated = await generateAndReviewPlan(contract, masterReqIds);
      if ("early" in generated) return generated.early;
      plan = generated.plan;
      writeDevDoc(
        repoPath,
        DEV_DOCS.decomposeApproved,
        decomposePlanHash(contract, readDevDoc(repoPath, DEV_DOCS.taskPlan) ?? ""),
      );
      removeDevDoc(repoPath, DEV_DOCS.decomposeFeedback);
      removeDevDoc(repoPath, DEV_DOCS.decomposeReviewFeedback);
    }

    if (plan.tasks.length === 1) {
      logger.info({ sessionId }, "decompose chose n=1 — running the single loop");
      return { kind: "single" };
    }

    const byKey = new Map(plan.tasks.map((t) => [t.key, t]));
    insertDevTasks(
      db,
      sessionId,
      plan.topo.map((key) => {
        const t = byKey.get(key)!;
        return {
          id: uuid(),
          taskKey: t.key,
          summary: t.summary,
          dependsOn: t.dependsOn,
          scope: t.scope,
          reqs: t.reqs,
          body: t.body,
          origin: "plan" as const,
        };
      }),
      now(),
    );
    const groups = planParallelGroups(plan.tasks)
      .map((g, i) => `${i + 1}. ${g.join(" ∥ ")}`)
      .join("\n");
    await deps.onFleetNote?.(
      `Decomposed the contract into ${plan.tasks.length} tasks `
        + `(parallel groups, in order):\n${groups}`,
    );
    return null;
  }

  /** Generate → validate (retry once) → review (regenerate once). */
  async function generateAndReviewPlan(
    contract: string,
    masterReqIds: string[],
  ): Promise<{ plan: { tasks: DevPlanTask[]; topo: string[] } } | { early: DevFleetRunResult }> {
    const park = async (question: string): Promise<{ early: DevFleetRunResult }> => {
      await deps.onTaskEscalation({
        taskId: null,
        kind: "spec_decision",
        question,
        contextSummary: readDevDoc(repoPath, DEV_DOCS.decomposeFeedback),
      });
      return { early: { kind: "parked", reason: question } };
    };

    let reviewed = 0;
    for (;;) {
      // Generation (validator-retry once per review round).
      let valid: { tasks: DevPlanTask[]; topo: string[] } | null = null;
      let lastError = "the decomposer produced no parseable plan";
      for (let attempt = 1; attempt <= 2 && !valid; attempt++) {
        const preRef = gitHead(repoPath) ?? "HEAD";
        const dec = await flowLegs.decompose(flowLegCtx());
        recordFlow("decompose", {
          verdict: dec.n === null ? "unparseable" : `n=${dec.n}`,
          responses: dec.responses,
        });
        // Containment: the decomposer may write ONLY .aitne-dev (excluded
        // from the diff) — any project change fails closed to the owner.
        const stray = gitDiffPaths(repoPath, preRef);
        if (stray.length > 0) {
          await deps.onTaskEscalation({
            taskId: null,
            kind: "risk_approval",
            question:
              "The decompose step modified project files (it may only write "
              + `.aitne-dev/): ${stray.slice(0, 5).join(", ")} — inspect the repo before resuming.`,
            contextSummary: null,
          });
          return { early: { kind: "parked", reason: "decompose containment violation" } };
        }
        const planMd = readDevDoc(repoPath, DEV_DOCS.taskPlan);
        if (dec.n === null || !planMd) {
          lastError = dec.n === null
            ? "missing/malformed DECOMPOSE verdict line"
            : "no .aitne-dev/docs/task-plan.md was written";
          writeDevDoc(repoPath, DEV_DOCS.decomposeFeedback, lastError);
          continue;
        }
        const v = validateTaskPlan(planMd, {
          cap: flow.maxTasks,
          verdictN: dec.n,
          masterReqIds,
        });
        if (!v.ok) {
          lastError = v.error;
          writeDevDoc(repoPath, DEV_DOCS.decomposeFeedback, v.error);
          continue;
        }
        valid = { tasks: v.tasks, topo: v.topo };
      }
      if (!valid) {
        return park(`Decomposition failed twice — last error: ${lastError}`);
      }

      // Independent review.
      const review = await flowLegs.decomposeReview(flowLegCtx());
      recordFlow("decompose_review", {
        verdict: review.verdict ?? "unparseable",
        reason: review.detail || null,
        responses: review.responses,
      });
      if (review.verdict === "APPROVE") return { plan: valid };
      reviewed++;
      if (reviewed >= 2) {
        return park(
          "The decompose reviewer rejected the plan twice — "
            + `${review.detail || "no parseable review verdict"}`,
        );
      }
      writeDevDoc(
        repoPath,
        DEV_DOCS.decomposeReviewFeedback,
        review.detail || "REVISE (no detail — re-derive the plan from scratch)",
      );
      removeDevDoc(repoPath, DEV_DOCS.decomposeApproved);
    }
  }

  // ── Worker (runTask / reap port) ──────────────────────────────────────

  const taskPersistence = (task: DevTaskRow): DevEnginePersistence => {
    const owned = new Set(task.reqs);
    return {
      recordIteration(row) {
        recordDevIteration(db, { ...row, sessionId, taskId: task.id });
      },
      addCost(deltaUsd) {
        addDevTaskCost(db, task.id, deltaUsd, now());
        addDevSessionCost(db, sessionId, deltaUsd);
      },
      writeCheckpoint(counters, at) {
        writeDevTaskCheckpoint(db, { id: task.id, ...counters }, at);
      },
      syncLedgerRow(row) {
        if (!owned.has(row.reqId)) return; // a worker only owns its REQs
        updateDevRequirement(db, { sessionId, ...row });
      },
      requirementCounts() {
        return countDevRequirementsIn(db, sessionId, task.reqs);
      },
      unmetReqIds() {
        return listDevRequirements(db, sessionId)
          .filter((r) => owned.has(r.reqId) && r.status !== "met")
          .map((r) => r.reqId);
      },
    };
  };

  /** Seed the worker worktree's ledger with ONLY its owned REQs. */
  const seedWorktreeLedger = (wt: string, task: DevTaskRow): void => {
    const rows = listDevRequirements(db, sessionId).filter((r) =>
      task.reqs.includes(r.reqId),
    );
    const body = [
      "| REQ | Status | Evidence | Iter |",
      "|---|---|---|---|",
      ...rows.map((r) => `| ${r.reqId} | ${r.status.replace(/_/g, "-")} | ${r.evidence ?? ""} | ${r.iter ?? ""} |`),
    ].join("\n");
    writeDevDoc(wt, DEV_DOCS.ledger, `${body}\n`);
  };

  /** Copy every merged transitive dependency's archive into phase-context/. */
  const copyPhaseContext = (wt: string, task: DevTaskRow): void => {
    const all = listDevTasks(db, sessionId);
    const byKey = new Map(all.map((t) => [t.taskKey, t]));
    const closure = new Set<string>();
    let frontier = [...task.dependsOn];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const key of frontier) {
        if (closure.has(key)) continue;
        closure.add(key);
        for (const dep of byKey.get(key)?.dependsOn ?? []) next.push(dep);
      }
      frontier = next;
    }
    for (const depKey of closure) {
      for (const file of ["task-instruction.md", "evidence-report.md"]) {
        copyDevDoc(
          repoPath,
          `${DEV_TASK_ARCHIVE_DIR}/${depKey}/${file}`,
          wt,
          `${DEV_PHASE_CONTEXT_DIR}/${depKey}/${file}`,
        );
      }
    }
  };

  async function runWorker(taskId: string): Promise<void> {
    let task = getDevTask(db, taskId);
    if (!task || task.state !== "queued") return;
    const key = task.taskKey;
    const wt = join(wtRoot, key);
    const branch = task.branch ?? `aitne-dev/${sessionId}-${key}`;

    // ── bootstrap (skipped when the worktree survives an ANSWER relaunch
    //    or a daemon restart) ──
    if (!task.worktreePath || !existsSync(task.worktreePath)) {
      if (task.worktreePath && !existsSync(task.worktreePath)) {
        // The recorded worktree vanished (machine cleanup) — archive the old
        // branch and redo from the merged HEAD with zeroed counters.
        recordFlow("merge", {
          taskId: task.id,
          verdict: "STALE_BOOTSTRAP",
          reason: "worktree missing on relaunch — redoing from the merged HEAD",
        });
        if (task.branch && gitBranchExists(repoPath, task.branch)) {
          gitRenameBranch(repoPath, task.branch, `${task.branch}-stale-${task.resumes}`);
        }
        writeDevTaskCheckpoint(
          db,
          { id: task.id, iteration: 0, agentFailures: 0, gateReviseCount: 0, iterReviseCount: 0, resumes: task.resumes },
          now(),
        );
        task = getDevTask(db, taskId)!;
      }
      const baseRef = gitHead(repoPath);
      if (!baseRef) {
        markDevTaskState(db, { id: taskId, from: ["queued"], to: "failed", failReason: "BOOTSTRAP: parent repo has no commits", at: now() });
        return;
      }
      try {
        gitWorktreeAdd(repoPath, wt, branch, baseRef);
      } catch (err) {
        logger.error({ err, taskKey: key }, "worktree add failed");
        markDevTaskState(db, { id: taskId, from: ["queued"], to: "failed", failReason: `BOOTSTRAP: worktree add failed (${String(err)})`, at: now() });
        return;
      }
      // Carryover seed (NEEDS_DECOMPOSITION splits) — never fails bootstrap.
      if (task.seedBranch) {
        const seeded = seedMergeFromBranch(wt, task.seedBranch);
        recordFlow("merge", {
          taskId: task.id,
          verdict: seeded === "seeded" ? "SEEDED" : "CARRYOVER_SKIPPED",
          reason: seeded === "seeded"
            ? `carried committed work from ${task.seedBranch}`
            : `${seeded} — the carried work remains on ${task.seedBranch}`,
        });
      }
      ensureDevWorkdir(wt);
      copyDevDoc(repoPath, DEV_DOCS.contract, wt, DEV_DOCS.contract);
      copyDevDoc(repoPath, DEV_DOCS.loopConfig, wt, DEV_DOCS.loopConfig);
      writeDevDoc(wt, DEV_DOCS.taskInstruction, task.body);
      seedWorktreeLedger(wt, task);
      copyPhaseContext(wt, task);
      if (flow.worktreeSetupCommand) {
        const setup = runSetupCommand(wt, flow.worktreeSetupCommand, config.maxIterSeconds * 1000);
        if (setup.exitCode !== 0) {
          recordFlow("merge", {
            taskId: task.id,
            verdict: "BOOTSTRAP_FAILED",
            reason: `worktree setup command exited ${setup.exitCode}`,
          });
          markDevTaskState(db, { id: taskId, from: ["queued"], to: "failed", loopState: "BLOCKED", failReason: `BOOTSTRAP: setup command exited ${setup.exitCode}: ${setup.output.slice(0, 400)}`, at: now() });
          gitWorktreeRemove(repoPath, wt);
          return;
        }
      }
      const claimed = claimDevTask(db, { id: taskId, branch, worktreePath: wt, baseRef, at: now() });
      if (!claimed) return; // raced (cancel/supersede) — leave it be
      task = claimed;
    } else {
      const claimed = claimDevTask(db, {
        id: taskId,
        branch,
        worktreePath: task.worktreePath,
        baseRef: task.baseRef ?? gitHead(repoPath) ?? "HEAD",
        at: now(),
      });
      if (!claimed) return;
      task = claimed;
    }

    refreshParallelContext();

    // ── the worker loop (one DevLoopEngine in the worktree) ──
    const sessionRow = liveSession();
    const taskView: DevSessionRow = {
      ...sessionRow,
      branch: task.branch,
      baseRef: task.baseRef,
      iteration: task.iteration,
      agentFailures: task.agentFailures,
      gateReviseCount: task.gateReviseCount,
      iterReviseCount: task.iterReviseCount,
      resumes: task.resumes,
    };
    const engine = new DevLoopEngine(taskView, {
      db,
      repoPath: task.worktreePath!,
      legRunner,
      tier,
      now,
      uuid,
      persistence: taskPersistence(task),
      getSpentUsd: spentUsd,
      fleet: { taskReqIds: task.reqs },
    });

    try {
      await engine.ensurePlan();
      let iteration = task.iteration + 1;
      for (;;) {
        if (signal.aborted) {
          markDevTaskState(db, { id: taskId, from: ["running"], to: "queued", loopState: null, at: now() });
          return;
        }
        const outcome = await engine.runIteration(iteration);
        if (outcome.kind === "continue") {
          iteration++;
          continue;
        }
        if (outcome.kind === "escalate") {
          if (outcome.loopState === "RISK_REQUIRES_APPROVAL") {
            // Never supervised — straight to the owner (siblings keep going).
            const fresh = getDevTask(db, taskId)!;
            markDevTaskState(db, { id: taskId, from: ["running"], to: "awaiting_user", loopState: outcome.loopState, at: now() });
            await deps.onTaskEscalation({
              taskId,
              kind: "risk_approval",
              question: `[${key}] ${outcome.question}`,
              contextSummary: outcome.contextSummary,
            });
            void fresh;
          } else {
            // Supervisor-first: park for the control lane.
            markDevTaskState(db, { id: taskId, from: ["running"], to: "supervise_pending", loopState: outcome.loopState, at: now() });
          }
          return;
        }
        // terminal
        if (outcome.loopState === "SUCCESS") {
          markDevTaskState(db, { id: taskId, from: ["running"], to: "merge_pending", loopState: "SUCCESS", at: now() });
        } else if (outcome.loopState === "NO_OP") {
          // Nothing to merge — the task is complete as-is.
          markDevTaskState(db, { id: taskId, from: ["running"], to: "merged", loopState: "NO_OP", at: now() });
          recordFlow("merge", { taskId, verdict: "NO_OP", reason: outcome.reason });
        } else {
          markDevTaskState(db, { id: taskId, from: ["running"], to: "failed", loopState: outcome.loopState, failReason: outcome.reason, at: now() });
        }
        return;
      }
    } catch (err) {
      if (signal.aborted) {
        markDevTaskState(db, { id: taskId, from: ["running"], to: "queued", loopState: null, at: now() });
        return;
      }
      logger.error({ err, taskKey: key }, "dev fleet worker crashed");
      const fresh = getDevTask(db, taskId);
      if (fresh && fresh.resumes < 1) {
        writeDevTaskCheckpoint(
          db,
          { id: taskId, iteration: fresh.iteration, agentFailures: fresh.agentFailures, gateReviseCount: fresh.gateReviseCount, iterReviseCount: fresh.iterReviseCount, resumes: fresh.resumes + 1 },
          now(),
        );
        markDevTaskState(db, { id: taskId, from: ["running"], to: "queued", loopState: null, at: now() });
      } else {
        markDevTaskState(db, { id: taskId, from: ["running"], to: "failed", loopState: "BLOCKED", failReason: `CRASHED: ${String(err)}`, at: now() });
      }
    }
  }

  // ── Supervise (supervise_task port) ───────────────────────────────────

  async function superviseTask(taskId: string): Promise<void> {
    const task = getDevTask(db, taskId);
    if (!task || task.state !== "supervise_pending") return;
    const wt = task.worktreePath;

    if (task.superviseCount >= flow.superviseCap) {
      await parkTaskForUser(
        task,
        ["supervise_pending"],
        escalationKindFor(task.loopState),
        `[${task.taskKey}] supervisor cap reached (${task.superviseCount}/${flow.superviseCap}) — `
          + `the worker declared ${task.loopState ?? "an escalation"} and needs your decision.`,
        wt ? readDevDoc(wt, DEV_DOCS.decisionRequests) : null,
      );
      return;
    }

    const allTasks = listDevTasks(db, sessionId);
    const staged = {
      queueSnapshot: renderQueueSnapshot(allTasks.map((t) => toQueueTask(t))),
      taskPlan: readDevDoc(repoPath, DEV_DOCS.taskPlan),
      task: {
        taskKey: task.taskKey,
        loopState: task.loopState ?? "UNKNOWN",
        taskInstruction: wt ? readDevDoc(wt, DEV_DOCS.taskInstruction) : task.body,
        decisionRequests: wt ? readDevDoc(wt, DEV_DOCS.decisionRequests) : null,
        progress: wt ? readDevDoc(wt, DEV_DOCS.progress) : null,
        lastVerify: wt ? readDevDoc(wt, DEV_DOCS.lastVerify) : null,
        agentState: wt ? readDevDoc(wt, DEV_DOCS.agentState) : null,
        assumptions: wt ? readDevDoc(wt, DEV_DOCS.assumptions) : null,
      },
    };
    const decision = await flowLegs.supervise(flowLegCtx(), { mode: "task", staged });
    bumpDevTaskSuperviseCount(db, taskId, now());
    recordFlow("supervise", {
      taskId,
      verdict: decision.verdict ?? "unparseable",
      reason: decision.detail || null,
      responses: decision.responses,
    });

    if (decision.verdict === "ANSWER" && decision.guidance && wt) {
      writeDevDoc(wt, DEV_DOCS.supervisorGuidance, decision.guidance);
      markDevTaskState(db, { id: taskId, from: ["supervise_pending"], to: "queued", loopState: null, at: now() });
      await deps.onFleetNote?.(`supervisor answered ${task.taskKey}'s question — relaunching it`);
      return;
    }

    if (decision.verdict === "REPLAN" && decision.replanBlock) {
      const validated = validateReplanBlock(decision.replanBlock, {
        escalatedKey: task.taskKey,
        escalatedReqs: task.reqs,
        liveTasks: allTasks.map(toLive),
        replanBudgetUsed: liveSession().replanCount,
        replanCap: flow.replanCap,
        maxTasks: flow.maxTasks,
      });
      if (!validated.ok) {
        recordFlow("supervise", { taskId, verdict: "REPLAN_INVALID", reason: validated.error });
        await parkTaskForUser(
          task,
          ["supervise_pending"],
          escalationKindFor(task.loopState),
          `[${task.taskKey}] the supervisor proposed an invalid replan (${validated.error}) — your decision is needed.`,
          wt ? readDevDoc(wt, DEV_DOCS.decisionRequests) : null,
        );
        return;
      }
      const replacementIds = new Map(validated.topo.map((key) => [key, uuid()]));
      const byKey = new Map(validated.tasks.map((t) => [t.key, t]));
      const applyReplan = db.transaction(() => {
        const superseded = markDevTaskState(db, { id: taskId, from: ["supervise_pending"], to: "superseded", at: now() });
        if (!superseded) throw new Error("task state changed under the replan");
        insertDevTasks(
          db,
          sessionId,
          validated.topo.map((key) => {
            const t = byKey.get(key)!;
            return { id: replacementIds.get(key)!, taskKey: t.key, summary: t.summary, dependsOn: t.dependsOn, scope: t.scope, reqs: t.reqs, body: t.body, origin: "replan" as const };
          }),
          now(),
        );
        rewireDevTaskDeps(db, sessionId, task.taskKey, validated.sinkKeys, now());
        bumpDevSessionFleetCounter(db, sessionId, "replan_count", validated.tasks.length, now());
        // Carryover: a healthy split keeps the escalated task's committed work.
        if (task.loopState === "NEEDS_DECOMPOSITION" && flow.splitCarryover && task.branch) {
          if (validated.uniqueRootKey) {
            setDevTaskSeedBranch(db, replacementIds.get(validated.uniqueRootKey)!, task.branch, now());
          }
        }
      });
      try {
        applyReplan();
      } catch (err) {
        logger.error({ err, taskKey: task.taskKey }, "replan apply failed");
        return; // the task is still supervise_pending — retried next pass
      }
      if (task.loopState === "NEEDS_DECOMPOSITION" && flow.splitCarryover && task.branch) {
        recordFlow("supervise", {
          taskId,
          verdict: validated.uniqueRootKey ? "CARRYOVER_PLANNED" : "CARRYOVER_SKIPPED",
          reason: validated.uniqueRootKey
            ? `${validated.uniqueRootKey} will seed from ${task.branch}`
            : `replacement block has no unique root — the carried work remains on ${task.branch}`,
        });
      }
      if (wt) {
        gitWorktreeRemove(repoPath, wt);
        setDevTaskWorktree(db, taskId, null, now());
      }
      refreshParallelContext();
      await deps.onFleetNote?.(
        `supervisor replanned ${task.taskKey} into: ${validated.topo.join(" → ")}`,
      );
      return;
    }

    // ESCALATE (or unparseable / missing payload) — fail toward the owner.
    await parkTaskForUser(
      task,
      ["supervise_pending"],
      escalationKindFor(task.loopState),
      `[${task.taskKey}] ${decision.detail || `the worker declared ${task.loopState ?? "an escalation"} and the supervisor deferred to you.`}`,
      decision.responses.length > 0
        ? decision.responses[decision.responses.length - 1]!.text.slice(0, 4000)
        : null,
    );
  }

  // ── Merge (merge_task port) ───────────────────────────────────────────

  async function mergeTask(taskId: string): Promise<void> {
    const task = getDevTask(db, taskId);
    if (!task || task.state !== "merge_pending" || !task.branch) return;

    if (gitMergeInProgress(repoPath)) {
      fatal = {
        kind: "terminal",
        loopState: "BLOCKED",
        reason: "A merge is already in progress in the repository — resolve it manually.",
      };
      return;
    }
    if (hasUncommittedTracked(repoPath)) {
      mergeDeferCount++;
      if (mergeDeferCount > MERGE_DEFER_LIMIT) {
        await deps.onTaskEscalation({
          taskId: null,
          kind: "spec_decision",
          question:
            "The repository has uncommitted changes, so merged fleet work cannot land. "
            + "Commit or stash your local edits, then reply here to resume.",
          contextSummary: null,
        });
        fatal = { kind: "parked", reason: "parent repo dirty — merges blocked" };
        return;
      }
      mergeDeferredUntil = now() + mergeDeferMs;
      setTimeout(notify, mergeDeferMs);
      return;
    }
    mergeDeferCount = 0;

    // Pre-mark the plan review BEFORE the merge commit so a crash between
    // the two can never skip the review (dependents are held by deps_state).
    const hasQueuedDependents = listDevTasks(db, sessionId).some(
      (t) => t.state === "queued" && t.dependsOn.includes(task.taskKey),
    );
    if (flow.planReview && hasQueuedDependents) {
      setDevTaskPlanReview(db, taskId, "pending", now());
    }

    const merge = gitMergeNoFF(repoPath, task.branch, `dev: merge ${task.taskKey} — ${task.summary}`);
    if (!merge.ok) {
      if (merge.refused) {
        // A tracked change slipped in after the guard — defer and retry.
        setDevTaskPlanReview(db, taskId, null, now());
        mergeDeferredUntil = now() + mergeDeferMs;
        setTimeout(notify, mergeDeferMs);
        return;
      }
      if (task.mergeRetries === 0) {
        // One redo from the merged HEAD (loop-kit conflict-retry).
        gitRenameBranch(repoPath, task.branch, `${task.branch}-conflict-1`);
        if (task.worktreePath) gitWorktreeRemove(repoPath, task.worktreePath);
        resetDevTaskForRedo(db, { id: taskId, at: now() });
        recordFlow("merge", {
          taskId,
          verdict: "CONFLICT_REDO",
          reason: `merge conflict (${merge.conflicts.join(", ")}) — redoing from the merged HEAD`,
        });
        refreshParallelContext();
        return;
      }
      markDevTaskState(db, {
        id: taskId,
        from: ["merge_pending"],
        to: "failed",
        failReason: `MERGE_CONFLICT: ${merge.conflicts.join(", ")}`,
        at: now(),
      });
      recordFlow("merge", { taskId, verdict: "CONFLICT_FAILED", reason: merge.conflicts.join(", ") });
      if (task.worktreePath) gitWorktreeRemove(repoPath, task.worktreePath);
      return;
    }

    // Archive the task's docs (phase-context + publisher source), sync its
    // final ledger rows, then close it out.
    if (task.worktreePath) {
      for (const file of [DEV_DOCS.taskInstruction, DEV_DOCS.evidence, DEV_DOCS.ledger] as const) {
        const base = file.split("/").pop()!;
        copyDevDoc(task.worktreePath, file, repoPath, `${DEV_TASK_ARCHIVE_DIR}/${task.taskKey}/${base}`);
      }
      const owned = new Set(task.reqs);
      for (const row of parseLedgerMarkdown(readDevDoc(task.worktreePath, DEV_DOCS.ledger))) {
        if (!owned.has(row.reqId)) continue;
        updateDevRequirement(db, {
          sessionId,
          reqId: row.reqId,
          status: row.status,
          evidence: row.evidence || null,
          iter: row.iter,
          updatedAt: now(),
        });
      }
      gitWorktreeRemove(repoPath, task.worktreePath);
      setDevTaskWorktree(db, taskId, null, now());
    }
    markDevTaskState(db, { id: taskId, from: ["merge_pending"], to: "merged", at: now() });
    recordFlow("merge", {
      taskId,
      verdict: merge.noChanges ? "NO_CHANGES" : "MERGED",
      commitSha: merge.sha,
      reason: `merged ${task.taskKey}`,
    });
    refreshParallelContext();
    await deps.onFleetNote?.(
      `merged ${task.taskKey} (${task.iteration} iteration${task.iteration === 1 ? "" : "s"}`
        + `${task.costUsd ? `, $${task.costUsd.toFixed(2)}` : ""})`,
    );
  }

  // ── Plan review (plan_review_task port) ───────────────────────────────

  async function planReviewTask(taskId: string): Promise<void> {
    const task = getDevTask(db, taskId);
    if (!task || task.state !== "merged" || task.planReview !== "pending") return;

    if (liveSession().planReviewCount >= flow.planReviewCap) {
      setDevTaskPlanReview(db, taskId, "done", now());
      recordFlow("plan_review", { taskId, verdict: "CAPPED", reason: `plan-review cap ${flow.planReviewCap} reached — keeping the queued plan` });
      return;
    }

    const allTasks = listDevTasks(db, sessionId);
    const decision = await flowLegs.planReview(flowLegCtx(), {
      queueSnapshot: renderQueueSnapshot(
        allTasks.map((t) => toQueueTask(t, t.state === "queued")),
        { includeQueuedBodies: true },
      ),
      taskPlan: readDevDoc(repoPath, DEV_DOCS.taskPlan),
      mergedTaskKey: task.taskKey,
      mergedTaskInstruction: readDevDoc(repoPath, `${DEV_TASK_ARCHIVE_DIR}/${task.taskKey}/task-instruction.md`),
      mergedEvidence: readDevDoc(repoPath, `${DEV_TASK_ARCHIVE_DIR}/${task.taskKey}/evidence-report.md`),
    });
    recordFlow("plan_review", {
      taskId,
      verdict: decision.verdict ?? "unparseable",
      reason: decision.detail || null,
      responses: decision.responses,
    });

    if (decision.verdict === "ESCALATE") {
      setDevTaskPlanReview(db, taskId, "escalated", now());
      await deps.onTaskEscalation({
        taskId,
        kind: "review_escalation",
        question: `[${task.taskKey} merged] ${decision.detail || "the plan reviewer needs your decision on the remaining plan"}`,
        contextSummary: decision.responses.length > 0
          ? decision.responses[decision.responses.length - 1]!.text.slice(0, 4000)
          : null,
      });
      return;
    }

    if (decision.verdict === "REVISE" && decision.replanBlock) {
      const validated = validatePlanRevision(decision.replanBlock, {
        liveTasks: allTasks.map(toLive),
        maxReplanTasks: flow.replanCap,
        maxTasks: flow.maxTasks,
      });
      if (validated.ok) {
        const replacementIds = new Map(validated.topo.map((key) => [key, uuid()]));
        const byKey = new Map(validated.tasks.map((t) => [t.key, t]));
        const replacedIds = allTasks
          .filter((t) => validated.replacedKeys.includes(t.taskKey))
          .map((t) => t.id);
        const applyRevision = db.transaction(() => {
          for (const id of replacedIds) {
            const ok = markDevTaskState(db, { id, from: ["queued"], to: "superseded", at: now() });
            if (!ok) throw new Error("a replaced task left the queue during the revision");
          }
          insertDevTasks(
            db,
            sessionId,
            validated.topo.map((key) => {
              const t = byKey.get(key)!;
              return { id: replacementIds.get(key)!, taskKey: t.key, summary: t.summary, dependsOn: t.dependsOn, scope: t.scope, reqs: t.reqs, body: t.body, origin: "plan_review" as const };
            }),
            now(),
          );
          if (validated.seedBranch && validated.seedTargetKey) {
            setDevTaskSeedBranch(db, replacementIds.get(validated.seedTargetKey)!, validated.seedBranch, now());
          }
          bumpDevSessionFleetCounter(db, sessionId, "plan_review_count", 1, now());
          setDevTaskPlanReview(db, taskId, "done", now());
        });
        try {
          applyRevision();
          if (validated.seedBranch && !validated.seedTargetKey) {
            recordFlow("plan_review", {
              taskId,
              verdict: "CARRYOVER_SKIPPED",
              reason: `revision has no unique root — the carried work remains on ${validated.seedBranch}`,
            });
          }
          refreshParallelContext();
          await deps.onFleetNote?.(
            `plan review after ${task.taskKey}: replaced [${validated.replacedKeys.join(", ")}] with ${validated.topo.join(" → ")}`,
          );
          return;
        } catch (err) {
          logger.error({ err, taskKey: task.taskKey }, "plan revision apply failed");
          // fall through to KEEP
        }
      } else {
        recordFlow("plan_review", { taskId, verdict: "REVISE_INVALID", reason: validated.error });
      }
    }

    // KEEP (default, incl. degraded invalid REVISE / unparseable verdicts) —
    // a refused mutation must not stop the fleet.
    setDevTaskPlanReview(db, taskId, "done", now());
  }

  // ── Integration gate (orchestration-tail port) ────────────────────────

  async function integrationGate(): Promise<
    { kind: "result"; result: DevFleetRunResult } | { kind: "fixup" }
  > {
    const sessionRow = liveSession();
    const baseRef = sessionRow.baseRef ?? "HEAD";
    const contract = readDevDoc(repoPath, DEV_DOCS.contract) ?? "";
    const legCtx = {
      repoPath,
      session: sessionRow,
      config,
      iteration: 0,
      tier,
    };

    const { response: gateResp, review } = await legRunner.review({
      ...legCtx,
      mode: "gate",
      baseRef,
    });
    const verdict = review?.verdict ?? "REVISE";
    recordFlow("gate", { verdict, reason: review?.summary ?? null, responses: [gateResp] });
    if (gateResp.isError) {
      return { kind: "result", result: { kind: "terminal", loopState: "BLOCKED", reason: "The integration gate reviewer was unavailable." } };
    }

    if (verdict === "ESCALATE") {
      await deps.onTaskEscalation({
        taskId: null,
        kind: "review_escalation",
        question: `Integration gate: ${review?.summary ?? "the reviewer needs a decision on the merged result"}`,
        contextSummary: gateResp.text.slice(0, 4000),
      });
      return { kind: "result", result: { kind: "parked", reason: "integration gate escalated" } };
    }

    if (verdict === "REVISE") {
      const fixups = liveSession().fixupCount;
      if (fixups >= flow.integrationFixupCap) {
        return {
          kind: "result",
          result: {
            kind: "terminal",
            loopState: "BLOCKED",
            reason: `The integration review rejected the merged result after ${fixups} fix-up round(s).`,
          },
        };
      }
      writeDevDoc(repoPath, DEV_DOCS.reviewFeedback, gateResp.text);
      const allTasks = listDevTasks(db, sessionId);
      const fix = await flowLegs.supervise(flowLegCtx(), {
        mode: "integration",
        staged: {
          queueSnapshot: renderQueueSnapshot(allTasks.map((t) => toQueueTask(t))),
          taskPlan: readDevDoc(repoPath, DEV_DOCS.taskPlan),
          integration: {
            reviewFeedback: gateResp.text,
            changedFiles: gitDiffPaths(repoPath, baseRef).join("\n"),
          },
        },
      });
      recordFlow("supervise", {
        verdict: fix.verdict ? `integration:${fix.verdict}` : "unparseable",
        reason: fix.detail || null,
        responses: fix.responses,
      });
      if (fix.verdict === "REPLAN" && fix.replanBlock) {
        const validated = validateFixupTask(fix.replanBlock, { liveTasks: allTasks.map(toLive) });
        if (validated.ok) {
          bumpDevSessionFleetCounter(db, sessionId, "fixup_count", 1, now());
          const t = validated.task;
          insertDevTasks(
            db,
            sessionId,
            [{ id: uuid(), taskKey: t.key, summary: t.summary, dependsOn: t.dependsOn, scope: t.scope, reqs: t.reqs, body: t.body, origin: "fixup" }],
            now(),
          );
          await deps.onFleetNote?.(`integration gate requested a fix-up task: ${t.key}`);
          return { kind: "fixup" };
        }
        recordFlow("supervise", { verdict: "FIXUP_INVALID", reason: validated.error });
      }
      return {
        kind: "result",
        result: {
          kind: "terminal",
          loopState: "BLOCKED",
          reason: `The integration review rejected the merged result and no valid fix-up emerged (${fix.detail || "no verdict"}).`,
        },
      };
    }

    // APPROVE → evidence over the whole fleet result, then the final
    // deterministic re-check against the master contract.
    const reqVerdicts = review?.reqVerdicts ?? [];
    const evidence = await legRunner.evidence({ ...legCtx, gateReqVerdicts: reqVerdicts });
    recordFlow("evidence", { verdict: evidence.isError ? "error" : "ok", responses: [evidence] });
    if (evidence.isError) {
      return { kind: "result", result: { kind: "terminal", loopState: "BLOCKED", reason: "Evidence generation failed at the integration gate." } };
    }

    const { total, met } = countDevRequirements(db, sessionId);
    const finalOut = evaluateIteration(
      {
        config,
        preRef: baseRef,
        approvedHash: sessionRow.approvedHash ?? "",
        currentApprovedHash: computeApprovalHash(contract, config),
        agentStateToken: "READY_FOR_REVIEW",
        allRequirementsMet: total > 0 && met === total,
        final: true,
        assumeReady: true,
        wholeRunDiffEmpty: isWholeRunDiffEmpty(repoPath, baseRef),
        fleetWorker: false,
        bookkeeping: EMPTY_BOOKKEEPING,
      },
      {
        diffPaths: (ref) => gitDiffPaths(repoPath, ref),
        runVerify: (cmd) => runVerifyCommand(repoPath, cmd, config.maxIterSeconds * 1000),
      },
    );
    if (finalOut.result.verify) writeLastVerifyLog(repoPath, finalOut.result.verify);
    recordFlow("evaluate", { verdict: finalOut.result.state, reason: finalOut.result.reason });
    const fs = finalOut.result.state;
    if (fs === "SUCCESS" || fs === "NO_OP") {
      return { kind: "result", result: { kind: "terminal", loopState: fs, reason: finalOut.result.reason } };
    }
    return {
      kind: "result",
      result: { kind: "terminal", loopState: "BLOCKED", reason: `Final fleet re-check failed: ${finalOut.result.reason}` },
    };
  }

  // ── Dispatch loop (event-driven tick) ─────────────────────────────────

  async function dispatch(): Promise<{ kind: "gate" } | { kind: "result"; result: DevFleetRunResult }> {
    for (;;) {
      if (signal.aborted) {
        return { kind: "result", result: { kind: "parked", reason: "cancelled" } };
      }
      if (fatal) {
        const result = fatal;
        fatal = null;
        return { kind: "result", result };
      }
      const rows = listDevTasks(db, sessionId);
      const snapshots = rows.map(toSnapshot);
      let actions = planFleetActions(snapshots, flow.maxParallel, running.size, controlBusy);
      // A launched-but-not-yet-claimed task is still 'queued' in the DB.
      actions = actions.filter((a) => !(a.kind === "launch" && running.has(a.taskId)));
      if (overBudget()) {
        // No new spend; running workers stop at their own budget check.
        actions = actions.filter((a) => a.kind === "depFail");
      }
      if (now() < mergeDeferredUntil) {
        actions = actions.filter((a) => a.kind !== "merge");
      }

      if (actions.length === 0) {
        if (running.size === 0 && !controlBusy) {
          if (overBudget()) {
            return {
              kind: "result",
              result: { kind: "terminal", loopState: "BUDGET_EXCEEDED", reason: "The fleet hit the session cost ceiling." },
            };
          }
          const idle = classifyIdleFleet(snapshots);
          if (idle.kind === "clean") return { kind: "gate" };
          if (idle.kind === "needsHuman") {
            return { kind: "result", result: { kind: "parked", reason: "task decision(s) awaiting the owner" } };
          }
          return {
            kind: "result",
            result: { kind: "terminal", loopState: "BLOCKED", reason: idle.kind === "failed" ? idle.reason : idle.reason },
          };
        }
        await waitForWake();
        continue;
      }

      for (const action of actions) {
        if (action.kind === "launch") {
          const promise = runWorker(action.taskId)
            .catch((err) => logger.error({ err }, "dev fleet worker rejected"))
            .finally(() => {
              running.delete(action.taskId);
              notify();
            });
          running.set(action.taskId, promise);
        } else if (action.kind === "depFail") {
          const dep = action.failedDepKey;
          markDevTaskState(db, {
            id: action.taskId,
            from: ["queued"],
            to: "dep_failed",
            failReason: `DEP_FAILED: dependency '${dep}' can no longer merge`,
            at: now(),
          });
        } else {
          controlBusy = true;
          const controlWork =
            action.kind === "supervise"
              ? superviseTask(action.taskId)
              : action.kind === "merge"
                ? mergeTask(action.taskId)
                : planReviewTask(action.taskId);
          void controlWork
            .catch((err) => logger.error({ err, action: action.kind }, "dev fleet control action failed"))
            .finally(() => {
              controlBusy = false;
              notify();
            });
        }
      }
      // Re-plan immediately — planFleetActions accounts for running/controlBusy.
    }
  }

  // ── Entry ─────────────────────────────────────────────────────────────

  async function run(): Promise<DevFleetRunResult> {
    const early = await decomposeFlow();
    if (early) return early;
    for (;;) {
      const dispatched = await dispatch();
      if (dispatched.kind === "result") {
        if (dispatched.result.kind === "terminal") cleanupWorktrees();
        return dispatched.result;
      }
      const gate = await integrationGate();
      if (gate.kind === "fixup") continue;
      if (gate.result.kind === "terminal") cleanupWorktrees();
      return gate.result;
    }
  }

  /** Terminal cleanup: drop every remaining worktree (branches are kept). */
  function cleanupWorktrees(): void {
    for (const t of listDevTasks(db, sessionId)) {
      if (t.worktreePath) {
        gitWorktreeRemove(repoPath, t.worktreePath);
        setDevTaskWorktree(db, t.id, null, now());
      }
    }
  }

  return { run, notifyExternalChange: notify };
}
