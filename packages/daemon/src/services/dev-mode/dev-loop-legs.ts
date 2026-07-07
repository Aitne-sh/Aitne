/**
 * Development-mode legs — the model-calling layer. Implements the engine's
 * injected `DevLegRunner` by (1) loading the `dev.*.md` task-flow, (2)
 * assembling the injected `<dev_loop_context>` block from the .aitne-dev/
 * working dir + the git diff, (3) calling a `DevBackend` with the right tool
 * envelope + tier, and (4) parsing the reply with the covered verdict parser.
 *
 * `DevBackend` is injected (implemented by the runner over `IAgentRouter`), so
 * this module is unit-testable with a fake backend. I/O-bound (reads
 * .aitne-dev/ + git); excluded from the coverage gate.
 */

import type { BackendModelTier } from "@aitne/shared";
import {
  DEV_DOCS,
  gitDiffText,
  readDevDoc,
  readPhaseContext,
} from "./dev-loop-docs.js";
import {
  parseReviewResult,
  applyGateReqDowngrade,
  parseStopEval,
  extractContractReqIds,
} from "./verdict-parse.js";
import type {
  DevLegContext,
  DevLegResponse,
  DevLegRunner,
  DevReviewLegContext,
  DevReviewLegResult,
} from "./dev-loop-engine.js";
import type { DevStopEval } from "./types.js";

/** One backend invocation for a leg (the runner turns this into an
 *  IAgentRouter.execute call). */
export interface DevBackendRequest {
  /** Task-flow filename stem, e.g. "dev.implement" → dev.implement.md. */
  taskFlowKey: string;
  /** The rendered task-flow body (the role/steps/output-grammar). */
  prompt: string;
  /** The injected <dev_loop_context> block. */
  context: string;
  /** cwd for the backend — the registered repo path. */
  sessionDir: string;
  /** Tool allowlist (REPLACES the default). Read-only legs get Read/Glob/Grep. */
  allowedTools: readonly string[];
  /** Whether this leg may only read (no code writes) — a belt-and-braces hint
   *  the runner can use to pick a stricter permission posture. */
  readOnly: boolean;
  tier: BackendModelTier;
  maxTurns: number;
  maxBudgetUsd: number;
  /** Per-leg wall-clock watchdog (seconds) — loop-kit maxIterSeconds. The
   *  backend aborts a hung leg after this. */
  maxSeconds: number;
}

export interface DevBackend {
  runLeg(req: DevBackendRequest): Promise<DevLegResponse>;
}

export interface DevLegRunnerDeps {
  backend: DevBackend;
  /** Loads a task-flow body by key (default: core prompts getTaskFlow). */
  loadTaskFlow: (key: string) => string;
}

const READONLY_TOOLS: readonly string[] = ["Read", "Glob", "Grep"];
const WRITE_TOOLS: readonly string[] = ["Read", "Glob", "Grep", "Write", "Edit"];

/** Per-leg execution envelope (turns/budget). The session-level cost cap
 *  (BUDGET_EXCEEDED) bounds the total across legs. */
const LEG_ENVELOPE = {
  plan: { maxTurns: 20, maxBudgetUsd: 0.4, tier: "high" as BackendModelTier },
  implement: { maxTurns: 60, maxBudgetUsd: 1.0, tier: "high" as BackendModelTier },
  review: { maxTurns: 25, maxBudgetUsd: 0.5, tier: "high" as BackendModelTier },
  stop_eval: { maxTurns: 5, maxBudgetUsd: 0.1, tier: "lite" as BackendModelTier },
  evidence: { maxTurns: 20, maxBudgetUsd: 0.4, tier: "medium" as BackendModelTier },
} as const;

/**
 * Derive a Bash allowlist from the verify commands plus read-only git. Each
 * verify command is granted as its FULL prefix (`Bash(<command>:*)`), never as
 * a bare root (`Bash(<root>:*)`): a bare root would let the leg run ANY
 * subcommand of that tool — e.g. `Bash(git:*)` permits `git push`, `Bash(npm:*)`
 * permits `npm run <push-script>`, `Bash(bash:*)` permits `bash -c 'git push'`
 * — all D6 escapes (never push). Full-prefix grants let the leg re-run exactly
 * the approved checks (with args) and nothing else. The deterministic path
 * policy is the harder guard on top.
 */
export function deriveBashAllowlist(verifyCommands: readonly string[]): string[] {
  const tools = new Set<string>();
  for (const cmd of verifyCommands) {
    const trimmed = cmd.trim();
    if (trimmed.length > 0) tools.add(`Bash(${trimmed}:*)`);
  }
  return [
    ...tools,
    "Bash(git status:*)",
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(ls:*)",
    "Bash(cat:*)",
  ];
}

function section(title: string, body: string | null): string {
  if (!body || body.trim().length === 0) return "";
  return `\n## ${title}\n${body.trim()}\n`;
}

function baseContext(ctx: DevLegContext): string {
  return [
    `Repo: ${ctx.session.slug ?? ctx.session.repositoryId}  ·  Iteration: ${ctx.iteration}`,
    section("Product contract (immutable — do not edit)", readDevDoc(ctx.repoPath, DEV_DOCS.contract)),
    section("Requirements ledger", readDevDoc(ctx.repoPath, DEV_DOCS.ledger)),
  ].join("");
}

/** Fleet-worker sections — empty strings in a single (non-fleet) run where
 *  none of these files exist. Order mirrors the load order dev.implement.md
 *  prescribes. */
function fleetContext(ctx: DevLegContext): string {
  return (
    section(
      "Task instruction (this worktree's job — implement ONLY this)",
      readDevDoc(ctx.repoPath, DEV_DOCS.taskInstruction),
    )
    + section(
      "Supervisor guidance (treat as the owner's decision)",
      readDevDoc(ctx.repoPath, DEV_DOCS.supervisorGuidance),
    )
    + section(
      "Parallel loops in this project (never touch a sibling's scope)",
      readDevDoc(ctx.repoPath, DEV_DOCS.parallelContext),
    )
    + section("Budget signal", readDevDoc(ctx.repoPath, DEV_DOCS.splitNudge))
    + section(
      "Phase context from merged dependencies (advisory — the WHY behind code already in your tree)",
      readPhaseContext(ctx.repoPath),
    )
  );
}

export function createDevLegRunner(deps: DevLegRunnerDeps): DevLegRunner {
  const { backend, loadTaskFlow } = deps;

  return {
    async plan(ctx: DevLegContext): Promise<DevLegResponse> {
      const context = `<dev_loop_context>${baseContext(ctx)}${fleetContext(ctx)}${section(
        "Existing plan (if any)",
        readDevDoc(ctx.repoPath, DEV_DOCS.plan),
      )}</dev_loop_context>`;
      return backend.runLeg({
        taskFlowKey: "dev.plan",
        prompt: loadTaskFlow("dev.plan"),
        context,
        sessionDir: ctx.repoPath,
        maxSeconds: ctx.config.maxIterSeconds,
        allowedTools: WRITE_TOOLS,
        readOnly: false,
        ...LEG_ENVELOPE.plan,
      });
    },

    async implement(ctx: DevLegContext): Promise<DevLegResponse> {
      const context =
        `<dev_loop_context>${baseContext(ctx)}${fleetContext(ctx)}`
        + section("Implementation plan", readDevDoc(ctx.repoPath, DEV_DOCS.plan))
        + section("Recent progress", readDevDoc(ctx.repoPath, DEV_DOCS.progress))
        + section("Reviewer must-fix (address FIRST if present)", readDevDoc(ctx.repoPath, DEV_DOCS.reviewFeedback))
        + section("Open decision requests", readDevDoc(ctx.repoPath, DEV_DOCS.decisionRequests))
        + `</dev_loop_context>`;
      return backend.runLeg({
        taskFlowKey: "dev.implement",
        prompt: loadTaskFlow("dev.implement"),
        context,
        sessionDir: ctx.repoPath,
        maxSeconds: ctx.config.maxIterSeconds,
        allowedTools: [...WRITE_TOOLS, ...deriveBashAllowlist(ctx.config.verifyCommands)],
        readOnly: false,
        maxTurns: LEG_ENVELOPE.implement.maxTurns,
        maxBudgetUsd: ctx.session.maxBudgetUsd ?? LEG_ENVELOPE.implement.maxBudgetUsd,
        tier: ctx.tier,
      });
    },

    async review(ctx: DevReviewLegContext): Promise<DevReviewLegResult> {
      const contractMd = readDevDoc(ctx.repoPath, DEV_DOCS.contract) ?? "";
      const context =
        `<dev_loop_context>\nReview mode: ${ctx.mode}`
        + baseContext(ctx)
        + section("Diff under review", gitDiffText(ctx.repoPath, ctx.baseRef))
        + `</dev_loop_context>`;
      const response = await backend.runLeg({
        taskFlowKey: "dev.review",
        prompt: loadTaskFlow("dev.review"),
        context,
        sessionDir: ctx.repoPath,
        maxSeconds: ctx.config.maxIterSeconds,
        allowedTools: READONLY_TOOLS,
        readOnly: true,
        maxTurns: LEG_ENVELOPE.review.maxTurns,
        maxBudgetUsd: LEG_ENVELOPE.review.maxBudgetUsd,
        tier: ctx.tier,
      });
      let review = parseReviewResult(response.text, ctx.mode);
      if (ctx.mode === "gate" && review) {
        // A fleet worker judges only its owned reqs; the single loop + the
        // integration gate judge every contract req.
        const reqIds = ctx.reqIds ?? extractContractReqIds(contractMd);
        review = applyGateReqDowngrade(review, reqIds, response.text);
      }
      return { response, review };
    },

    async stopEval(ctx: DevLegContext): Promise<{ response: DevLegResponse; verdict: DevStopEval | null }> {
      const context =
        `<dev_loop_context>${baseContext(ctx)}`
        + section("Recent progress", readDevDoc(ctx.repoPath, DEV_DOCS.progress))
        + section("Last verify log", readDevDoc(ctx.repoPath, DEV_DOCS.lastVerify))
        + `</dev_loop_context>`;
      const response = await backend.runLeg({
        taskFlowKey: "dev.stop_eval",
        prompt: loadTaskFlow("dev.stop_eval"),
        context,
        sessionDir: ctx.repoPath,
        maxSeconds: ctx.config.maxIterSeconds,
        allowedTools: READONLY_TOOLS,
        readOnly: true,
        ...LEG_ENVELOPE.stop_eval,
      });
      return { response, verdict: parseStopEval(response.text) };
    },

    async evidence(
      ctx: DevLegContext & { gateReqVerdicts: { reqId: string; verdict: string; evidence: string }[] },
    ): Promise<DevLegResponse> {
      const verdictLines = ctx.gateReqVerdicts
        .map((v) => `${v.reqId}: ${v.verdict} — ${v.evidence}`)
        .join("\n");
      const context =
        `<dev_loop_context>${baseContext(ctx)}`
        + section("Gate reviewer per-REQ verdicts", verdictLines)
        + section("Verify log", readDevDoc(ctx.repoPath, DEV_DOCS.lastVerify))
        + section("Assumptions", readDevDoc(ctx.repoPath, DEV_DOCS.assumptions))
        + section("Whole-run diff", gitDiffText(ctx.repoPath, ctx.session.baseRef ?? "HEAD"))
        + `</dev_loop_context>`;
      return backend.runLeg({
        taskFlowKey: "dev.evidence",
        prompt: loadTaskFlow("dev.evidence"),
        context,
        sessionDir: ctx.repoPath,
        maxSeconds: ctx.config.maxIterSeconds,
        allowedTools: WRITE_TOOLS,
        readOnly: false,
        ...LEG_ENVELOPE.evidence,
      });
    },
  };
}
