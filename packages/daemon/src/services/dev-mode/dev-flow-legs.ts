/**
 * Development-mode flow legs — the model-calling layer of the fleet:
 * decompose / decompose-review / supervise (task + integration) / plan-review.
 * Same posture as dev-loop-legs.ts: load the dev.*.md task-flow, assemble the
 * injected <dev_flow_context> block, call the injected `DevBackend` with the
 * right tool envelope, parse the reply with the covered verdict parsers.
 *
 * Every leg retries ONCE with a format reminder when the verdict line is
 * unparseable (loop-kit's two-attempt pattern); a still-unparseable reply
 * returns a null verdict and the caller fails toward the safe side (user for
 * decompose/supervise, KEEP for plan-review). The supervisor is READ-ONLY —
 * the orchestrator performs every write its decisions imply.
 *
 * I/O-bound (reads .aitne-dev/); excluded from the coverage gate. The parsing
 * it leans on lives in the covered verdict-parse.ts / task-plan.ts.
 */

import type { BackendModelTier } from "@aitne/shared";
import type { DevSessionRow } from "../../db/dev-sessions-store.js";
import { DEV_DOCS, readDevDoc } from "./dev-loop-docs.js";
import { perCallBudgetUsd } from "./dev-loop-config.js";
import type { DevBackend } from "./dev-loop-legs.js";
import type { DevLegResponse } from "./dev-loop-engine.js";
import type { DevLoopConfig } from "./types.js";
import {
  extractBetween,
  parseDecomposeReviewVerdict,
  parseDecomposeVerdict,
  parsePlanReviewVerdict,
  parseSuperviseVerdict,
} from "./verdict-parse.js";

const READONLY_TOOLS: readonly string[] = ["Read", "Glob", "Grep"];
/** The decomposer explores the repo but may only WRITE the task plan (the
 *  orchestrator additionally diff-checks containment after the leg). */
const DECOMPOSE_TOOLS: readonly string[] = [
  "Read",
  "Glob",
  "Grep",
  "Write(.aitne-dev/**)",
  "Edit(.aitne-dev/**)",
];

// maxTurns shape only — the USD ceiling is the per-session cap (clamped to the
// remaining per-process budget), applied uniformly in `runLeg` via
// perCallBudgetUsd, so the cost knob is the user config, not a constant here.
const FLOW_LEG_ENVELOPE = {
  decompose: { maxTurns: 40 },
  decompose_review: { maxTurns: 25 },
  supervise: { maxTurns: 30 },
  plan_review: { maxTurns: 25 },
} as const;

export interface DevFlowLegContext {
  session: DevSessionRow;
  /** The PARENT repo — flow legs never run inside a task worktree. */
  repoPath: string;
  config: DevLoopConfig;
  tier: BackendModelTier;
}

/** Staged inputs for a task/integration supervise decision. All strings are
 *  pre-read by the orchestrator (worktree files + a DB-rendered queue
 *  snapshot) so the read-only leg needs no filesystem reach into worktrees. */
export interface DevSuperviseStagedContext {
  /** The LIVE queue rendered from the DB — the only source of task ids. */
  queueSnapshot: string;
  /** The original (never-rewritten) task plan, for rationale/scopes. */
  taskPlan: string | null;
  /** Task mode: the escalated worker's state. */
  task?: {
    taskKey: string;
    loopState: string;
    taskInstruction: string | null;
    decisionRequests: string | null;
    progress: string | null;
    lastVerify: string | null;
    agentState: string | null;
    assumptions: string | null;
  };
  /** Integration mode: the failed gate's evidence. */
  integration?: {
    reviewFeedback: string | null;
    changedFiles: string;
  };
}

export interface DevPlanReviewStagedContext {
  queueSnapshot: string;
  taskPlan: string | null;
  mergedTaskKey: string;
  mergedTaskInstruction: string | null;
  mergedEvidence: string | null;
}

export interface DevFlowLegRunner {
  decompose(
    ctx: DevFlowLegContext,
  ): Promise<{ responses: DevLegResponse[]; n: number | null }>;
  decomposeReview(
    ctx: DevFlowLegContext,
  ): Promise<{
    responses: DevLegResponse[];
    verdict: "APPROVE" | "REVISE" | null;
    detail: string;
  }>;
  supervise(
    ctx: DevFlowLegContext,
    input: { mode: "task" | "integration"; staged: DevSuperviseStagedContext },
  ): Promise<{
    responses: DevLegResponse[];
    verdict: "ANSWER" | "REPLAN" | "ESCALATE" | null;
    detail: string;
    guidance: string | null;
    replanBlock: string | null;
  }>;
  planReview(
    ctx: DevFlowLegContext,
    staged: DevPlanReviewStagedContext,
  ): Promise<{
    responses: DevLegResponse[];
    verdict: "KEEP" | "REVISE" | "ESCALATE" | null;
    detail: string;
    replanBlock: string | null;
  }>;
}

export interface DevFlowLegRunnerDeps {
  backend: DevBackend;
  loadTaskFlow: (key: string) => string;
}

function section(title: string, body: string | null): string {
  if (!body || body.trim().length === 0) return "";
  return `\n## ${title}\n${body.trim()}\n`;
}

/** Run a leg, retrying ONCE with a format reminder when `parse` yields null. */
async function runWithFormatRetry<T>(
  run: (extraContext: string) => Promise<DevLegResponse>,
  parse: (text: string) => T | null,
  reminder: string,
): Promise<{ responses: DevLegResponse[]; parsed: T | null }> {
  const first = await run("");
  const parsedFirst = first.isError ? null : parse(first.text);
  if (parsedFirst !== null) return { responses: [first], parsed: parsedFirst };
  const second = await run(
    `\n## FORMAT REMINDER\n${reminder}\n`,
  );
  const parsedSecond = second.isError ? null : parse(second.text);
  return { responses: [first, second], parsed: parsedSecond };
}

export function createDevFlowLegRunner(deps: DevFlowLegRunnerDeps): DevFlowLegRunner {
  const { backend, loadTaskFlow } = deps;

  const runLeg = (
    ctx: DevFlowLegContext,
    input: {
      taskFlowKey: string;
      context: string;
      allowedTools: readonly string[];
      readOnly: boolean;
      envelope: { maxTurns: number };
    },
  ): Promise<DevLegResponse> =>
    backend.runLeg({
      taskFlowKey: input.taskFlowKey,
      prompt: loadTaskFlow(input.taskFlowKey),
      context: input.context,
      sessionDir: ctx.repoPath,
      maxSeconds: ctx.config.maxIterSeconds,
      allowedTools: input.allowedTools,
      readOnly: input.readOnly,
      maxTurns: input.envelope.maxTurns,
      // Per-session cap (clamped to remaining per-process budget); the flow
      // leg's own budget is a shape hint, superseded by the user's cost knob.
      maxBudgetUsd: perCallBudgetUsd(ctx.config, ctx.session.costUsd ?? 0),
      tier: ctx.tier,
    });

  const flowHeader = (ctx: DevFlowLegContext): string =>
    `Repo: ${ctx.session.slug ?? ctx.session.repositoryId}`
    + section(
      "Product contract (immutable — do not edit)",
      readDevDoc(ctx.repoPath, DEV_DOCS.contract),
    );

  return {
    async decompose(ctx) {
      const context =
        `<dev_flow_context>${flowHeader(ctx)}`
        + section("Loop config (JSON)", readDevDoc(ctx.repoPath, DEV_DOCS.loopConfig))
        + section(
          "Validator feedback on your PREVIOUS plan (fix every item)",
          readDevDoc(ctx.repoPath, DEV_DOCS.decomposeFeedback),
        )
        + section(
          "Reviewer feedback on your PREVIOUS plan (address every must-fix)",
          readDevDoc(ctx.repoPath, DEV_DOCS.decomposeReviewFeedback),
        );
      const { responses, parsed } = await runWithFormatRetry(
        (extra) =>
          runLeg(ctx, {
            taskFlowKey: "dev.decompose",
            context: `${context}${extra}</dev_flow_context>`,
            allowedTools: DECOMPOSE_TOOLS,
            readOnly: false,
            envelope: FLOW_LEG_ENVELOPE.decompose,
          }),
        parseDecomposeVerdict,
        "After writing .aitne-dev/docs/task-plan.md, the LAST line of your "
          + "reply must be exactly: DECOMPOSE: TASKS n=<N> (plain text, no "
          + "code fence), where <N> is the number of TASK blocks.",
      );
      return { responses, n: parsed };
    },

    async decomposeReview(ctx) {
      const context =
        `<dev_flow_context>${flowHeader(ctx)}`
        + section("Task plan under review", readDevDoc(ctx.repoPath, DEV_DOCS.taskPlan))
        + section("Loop config (JSON)", readDevDoc(ctx.repoPath, DEV_DOCS.loopConfig));
      const { responses, parsed } = await runWithFormatRetry(
        (extra) =>
          runLeg(ctx, {
            taskFlowKey: "dev.decompose_review",
            context: `${context}${extra}</dev_flow_context>`,
            allowedTools: READONLY_TOOLS,
            readOnly: true,
            envelope: FLOW_LEG_ENVELOPE.decompose_review,
          }),
        parseDecomposeReviewVerdict,
        "The LAST line of your reply must be exactly one of: "
          + "DECOMPOSE-REVIEW: APPROVE <why> / DECOMPOSE-REVIEW: REVISE "
          + "<numbered must-fix items>. Plain text, no code fence.",
      );
      return {
        responses,
        verdict: parsed?.verdict ?? null,
        detail: parsed?.detail ?? "",
      };
    },

    async supervise(ctx, { mode, staged }) {
      const modeSection = `\n## Decision mode\n${mode}\n`;
      let stagedSections = section("Live queue snapshot (the ONLY source of task ids)", staged.queueSnapshot)
        + section("Original task plan (rationale/scopes — may be stale)", staged.taskPlan);
      if (staged.task) {
        stagedSections +=
          `\n## Escalated task\n${staged.task.taskKey} — declared ${staged.task.loopState}\n`
          + section("Task instruction", staged.task.taskInstruction)
          + section("Decision requests (what the worker asks)", staged.task.decisionRequests)
          + section("Worker progress", staged.task.progress)
          + section("Last verify log", staged.task.lastVerify)
          + section("Worker agent-state", staged.task.agentState)
          + section("Worker assumptions (do not contradict without saying why)", staged.task.assumptions);
      }
      if (staged.integration) {
        stagedSections +=
          section("Gate reviewer must-fix items", staged.integration.reviewFeedback)
          + section("Merged diff — changed files", staged.integration.changedFiles);
      }
      const context = `<dev_flow_context>${flowHeader(ctx)}${modeSection}${stagedSections}`;
      const { responses, parsed } = await runWithFormatRetry(
        (extra) =>
          runLeg(ctx, {
            taskFlowKey: "dev.supervise",
            context: `${context}${extra}</dev_flow_context>`,
            allowedTools: READONLY_TOOLS,
            readOnly: true,
            envelope: FLOW_LEG_ENVELOPE.supervise,
          }),
        parseSuperviseVerdict,
        mode === "integration"
          ? "Reply with exactly ONE fix-up task in a REPLAN-BEGIN/REPLAN-END "
            + "block and the last line 'SUPERVISE: REPLAN <summary>', or "
            + "'SUPERVISE: ESCALATE <question>'."
          : "The LAST line of your reply must be exactly one of: "
            + "SUPERVISE: ANSWER <summary> (with a GUIDANCE-BEGIN/GUIDANCE-END "
            + "block) / SUPERVISE: REPLAN <summary> (with a "
            + "REPLAN-BEGIN/REPLAN-END block) / SUPERVISE: ESCALATE <question>.",
      );
      const text = responses[responses.length - 1]!.text;
      return {
        responses,
        verdict: parsed?.verdict ?? null,
        detail: parsed?.detail ?? "",
        guidance: extractBetween(text, "GUIDANCE-BEGIN", "GUIDANCE-END"),
        replanBlock: extractBetween(text, "REPLAN-BEGIN", "REPLAN-END"),
      };
    },

    async planReview(ctx, staged) {
      const context =
        `<dev_flow_context>${flowHeader(ctx)}`
        + `\n## Decision mode\nplan-review\n`
        + `\n## Merged phase\n${staged.mergedTaskKey}\n`
        + section("Merged phase task instruction", staged.mergedTaskInstruction)
        + section("Merged phase evidence report", staged.mergedEvidence)
        + section("Live queue snapshot (the ONLY source of task ids)", staged.queueSnapshot)
        + section("Original task plan (rationale/scopes — may be stale)", staged.taskPlan);
      const { responses, parsed } = await runWithFormatRetry(
        (extra) =>
          runLeg(ctx, {
            taskFlowKey: "dev.supervise",
            context: `${context}${extra}</dev_flow_context>`,
            allowedTools: READONLY_TOOLS,
            readOnly: true,
            envelope: FLOW_LEG_ENVELOPE.plan_review,
          }),
        parsePlanReviewVerdict,
        "The LAST line of your reply must be exactly one of: "
          + "PLAN-REVIEW: KEEP <why> / PLAN-REVIEW: REVISE <what/why> (with a "
          + "REPLAN-BEGIN/REPLAN-END block) / PLAN-REVIEW: ESCALATE <question>.",
      );
      const text = responses[responses.length - 1]!.text;
      return {
        responses,
        verdict: parsed?.verdict ?? null,
        detail: parsed?.detail ?? "",
        replanBlock: extractBetween(text, "REPLAN-BEGIN", "REPLAN-END"),
      };
    },
  };
}
