import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { applySchema } from "../../db/schema.js";
import {
  approveDevSession,
  createDevSession,
  getDevSession,
  listDevRequirements,
  markDevAwaitingApproval,
  seedDevRequirements,
  updateDevSessionConfig,
} from "../../db/dev-sessions-store.js";
import {
  listDevTasks,
  getDevTaskByKey,
  insertDevTasks,
  markDevTaskState,
  setDevTaskPlanReview,
} from "../../db/dev-session-tasks-store.js";
import {
  DEV_DOCS,
  DEV_OWNER_PLAN_DECISION_FILE,
  DEV_TASK_ARCHIVE_DIR,
  ensureDevWorkdir,
  writeDevDoc,
  readDevDoc,
} from "./dev-loop-docs.js";
import { computeApprovalHash, normalizeDevLoopConfig } from "./dev-loop-config.js";
import type { DevLoopConfig } from "./types.js";
import type { DevLegResponse, DevLegRunner } from "./dev-loop-engine.js";
import type { DevFlowLegRunner } from "./dev-flow-legs.js";
import { createDevFleetOrchestrator } from "./dev-flow-orchestrator.js";

// ── git helpers ─────────────────────────────────────────────────────────

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}
function commit(repo: string, msg: string): void {
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", msg]);
}
function ok(text: string): DevLegResponse {
  return { text, sessionId: null, costUsd: 0.01, numTurns: 1, isError: false };
}

const CONTRACT = [
  "# Product Contract",
  "## Goal",
  "Build two things.",
  "### REQ-001: alpha",
  "The alpha behavior.",
  "### REQ-002: beta",
  "The beta behavior.",
].join("\n");

function ledgerFor(reqIds: readonly string[], status: string): string {
  return [
    "| REQ | Status | Evidence | Iter |",
    "|---|---|---|---|",
    ...reqIds.map((r) => `| ${r} | ${status} | ev | 1 |`),
  ].join("\n");
}

/** Which REQs a worktree owns — read from its seeded ledger. */
function ownedReqs(wt: string): string[] {
  const md = readDevDoc(wt, DEV_DOCS.ledger) ?? "";
  return [...md.matchAll(/\| (REQ-\d+) \|/g)].map((m) => m[1]!);
}

/**
 * A fake worker legRunner that side-effects the worktree like a real leg:
 * writes a task-named file (disjoint per task → no merge conflict), marks its
 * OWNED reqs met, declares READY_FOR_REVIEW, and APPROVEs its own gate.
 * Behaviors are overridable per task key.
 */
interface WorkerScript {
  /** Per-iteration behavior; return "escalate:<TOKEN>" to declare a stop, or
   *  "content:<text>" to just write file content. Default: succeed. */
  implement?: (wt: string, iteration: number) => "success" | { agentState: string; dr?: string } | { content: string };
  /** Override the number of the iteration on which implement is consulted. */
}

function fakeWorkerLegs(scripts: Record<string, WorkerScript> = {}): DevLegRunner {
  const iterCounts = new Map<string, number>();
  return {
    async plan(ctx) {
      writeDevDoc(ctx.repoPath, DEV_DOCS.plan, "## Milestones\n- [ ] do it");
      return ok("planned");
    },
    async implement(ctx) {
      const key = basename(ctx.repoPath);
      const n = (iterCounts.get(key) ?? 0) + 1;
      iterCounts.set(key, n);
      const script = scripts[key]?.implement?.(ctx.repoPath, n);
      const reqs = ownedReqs(ctx.repoPath);
      if (script && typeof script === "object" && "agentState" in script) {
        writeFileSync(join(ctx.repoPath, `${key}.ts`), `export const ${key.replace(/-/g, "_")} = ${n};\n`);
        if (script.dr) writeDevDoc(ctx.repoPath, DEV_DOCS.decisionRequests, script.dr);
        writeDevDoc(ctx.repoPath, DEV_DOCS.agentState, script.agentState);
        return ok("declared a stop");
      }
      if (script && typeof script === "object" && "content" in script) {
        writeFileSync(join(ctx.repoPath, `${key}.ts`), script.content);
        writeDevDoc(ctx.repoPath, DEV_DOCS.ledger, ledgerFor(reqs, "met"));
        writeDevDoc(ctx.repoPath, DEV_DOCS.agentState, "READY_FOR_REVIEW done");
        return ok("implemented (custom)");
      }
      writeFileSync(join(ctx.repoPath, `${key}.ts`), `export const ${key.replace(/-/g, "_")} = ${n};\n`);
      writeDevDoc(ctx.repoPath, DEV_DOCS.ledger, ledgerFor(reqs, "met"));
      writeDevDoc(ctx.repoPath, DEV_DOCS.agentState, "READY_FOR_REVIEW done");
      return ok("implemented");
    },
    async review(ctx) {
      const reqs = ctx.reqIds ?? ownedReqs(ctx.repoPath);
      const lines = reqs.map((r) => `${r}: MET ok`).join("\n");
      const text = `${lines}\nVERDICT: APPROVE ship it`;
      return {
        response: ok(text),
        review: {
          verdict: "APPROVE" as const,
          summary: "ship it",
          reqVerdicts: reqs.map((r) => ({ reqId: r, verdict: "MET" as const, evidence: "ok" })),
        },
      };
    },
    async stopEval() {
      return { response: ok("STOP-EVAL: MET"), verdict: "MET" as const };
    },
    async evidence(ctx) {
      writeDevDoc(ctx.repoPath, DEV_DOCS.evidence, "# Evidence\nall good");
      return ok("evidence");
    },
  };
}

/** A scriptable flow-leg runner. Each method pops from its queue. */
class FakeFlowLegs implements DevFlowLegRunner {
  decomposeQueue: { plan: string; n: number }[] = [];
  reviewQueue: ("APPROVE" | "REVISE")[] = [];
  superviseQueue: {
    verdict: "ANSWER" | "REPLAN" | "ESCALATE";
    guidance?: string;
    replan?: string;
    detail?: string;
  }[] = [];
  planReviewQueue: {
    verdict: "KEEP" | "REVISE" | "ESCALATE";
    replan?: string;
    detail?: string;
  }[] = [];
  gateReviewQueue: ("APPROVE" | "REVISE" | "ESCALATE")[] = [];
  repoPath = "";

  async decompose() {
    const next = this.decomposeQueue.shift();
    if (!next) return { responses: [ok("no plan")], n: null };
    writeDevDoc(this.repoPath, DEV_DOCS.taskPlan, next.plan);
    return { responses: [ok(`DECOMPOSE: TASKS n=${next.n}`)], n: next.n };
  }
  async decomposeReview() {
    const v = this.reviewQueue.shift() ?? "APPROVE";
    return { responses: [ok(`DECOMPOSE-REVIEW: ${v} x`)], verdict: v, detail: "" };
  }
  async supervise(
    _ctx: unknown,
    input: { mode: "task" | "integration" },
  ) {
    const next = this.superviseQueue.shift() ?? { verdict: "ESCALATE" as const };
    void input;
    return {
      responses: [ok(`SUPERVISE: ${next.verdict}`)],
      verdict: next.verdict,
      detail: next.detail ?? "",
      guidance: next.guidance ?? null,
      replanBlock: next.replan ?? null,
    };
  }
  async planReview() {
    const next = this.planReviewQueue.shift() ?? { verdict: "KEEP" as const };
    return {
      responses: [ok(`PLAN-REVIEW: ${next.verdict}`)],
      verdict: next.verdict,
      detail: next.detail ?? "",
      replanBlock: next.replan ?? null,
    };
  }
}

// The orchestrator's integration gate calls legRunner.review (worker legs) at
// the session level. We give the worker legs a switchable gate outcome.
function fakeWorkerLegsWithGate(
  scripts: Record<string, WorkerScript>,
  flowLegs: FakeFlowLegs,
): DevLegRunner {
  const base = fakeWorkerLegs(scripts);
  return {
    ...base,
    async review(ctx) {
      // Session-level gate (no reqIds passed by the orchestrator, repoPath is
      // the parent) uses the scripted gate outcome; worker gates use base.
      const isIntegration = ctx.reqIds === undefined && flowLegs.gateReviewQueue.length > 0
        && basename(ctx.repoPath) !== undefined
        && ctx.repoPath === flowLegs.repoPath;
      if (isIntegration) {
        const v = flowLegs.gateReviewQueue.shift()!;
        const reqs = ["REQ-001", "REQ-002"];
        const lines = reqs.map((r) => `${r}: ${v === "APPROVE" ? "MET" : "PARTIAL"} x`).join("\n");
        return {
          response: ok(`${lines}\nVERDICT: ${v} integration`),
          review: {
            verdict: v,
            summary: "integration",
            reqVerdicts: reqs.map((r) => ({ reqId: r, verdict: (v === "APPROVE" ? "MET" : "PARTIAL") as const, evidence: "x" })),
          },
        };
      }
      return base.review(ctx);
    },
  };
}

// ── plan-doc builders ───────────────────────────────────────────────────

function taskBlock(key: string, reqs: string, depends = "-"): string {
  return [
    `TASK: ${key}`,
    `SUMMARY: build ${key}`,
    `DEPENDS: ${depends}`,
    `SCOPE: ${key}.ts only`,
    `REQS: ${reqs}`,
    "BODY-BEGIN",
    `Implement ${key}. Owns ${reqs}.`,
    "BODY-END",
    "TASK-END",
  ].join("\n");
}
function planDoc(...blocks: string[]): string {
  return ["rationale", "<!-- TASK-PLAN-BEGIN v1 -->", ...blocks, "<!-- TASK-PLAN-END -->"].join("\n");
}

// ── harness ─────────────────────────────────────────────────────────────

describe("createDevFleetOrchestrator", () => {
  let repo: string;
  let db: Database.Database;
  let idn = 0;
  let escalations: { taskId: string | null; kind: string; question: string }[];
  let notes: string[];

  function seed(configOverride: Partial<DevLoopConfig> = {}): DevLoopConfig {
    db.prepare(
      `INSERT INTO repositories (id, local_path, local_only, created_at, updated_at) VALUES ('local:t', ?, 1, 0, 0)`,
    ).run(repo);
    createDevSession(db, {
      id: "s1",
      repositoryId: "local:t",
      slug: "t",
      originatingPlatform: "telegram",
      originatingChannel: "telegram:1",
      createdAt: 0,
    });
    const config = normalizeDevLoopConfig({
      verifyCommands: ["true"],
      maxIterations: 5,
      ...configOverride,
    });
    updateDevSessionConfig(db, "s1", { config, maxBudgetUsd: 100 }, 0);
    ensureDevWorkdir(repo);
    writeDevDoc(repo, DEV_DOCS.contract, CONTRACT);
    commit(repo, "seed .gitignore");
    markDevAwaitingApproval(db, "s1", 0);
    const baseRef = git(repo, ["rev-parse", "HEAD"]);
    seedDevRequirements(
      db,
      "s1",
      [
        { id: "r1", reqId: "REQ-001", title: "alpha" },
        { id: "r2", reqId: "REQ-002", title: "beta" },
      ],
      0,
    );
    approveDevSession(db, {
      id: "s1",
      approvedHash: computeApprovalHash(CONTRACT, config),
      branch: "aitne-dev/s1",
      baseRef,
      maxIterations: config.maxIterations,
      maxBudgetUsd: 100,
      approvedAt: 0,
    });
    git(repo, ["checkout", "-q", "-B", "aitne-dev/s1"]);
    return config;
  }

  function makeOrch(
    config: DevLoopConfig,
    legRunner: DevLegRunner,
    flowLegs: DevFlowLegRunner,
    signal: AbortSignal,
  ) {
    (flowLegs as FakeFlowLegs).repoPath = repo;
    return createDevFleetOrchestrator({
      db,
      repoPath: repo,
      session: getDevSession(db, "s1")!,
      config,
      legRunner,
      flowLegs,
      tier: "high",
      now: () => 1000 + idn,
      uuid: () => `u-${idn++}`,
      signal,
      onTaskEscalation: async (e) => {
        escalations.push({ taskId: e.taskId, kind: e.kind, question: e.question });
      },
      onFleetNote: async (t) => {
        notes.push(t);
      },
      mergeDeferMs: 20,
    });
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "dev-fleet-"));
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@t"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "README.md"), "seed\n");
    commit(repo, "root");
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    idn = 0;
    escalations = [];
    notes = [];
  });

  afterEach(() => {
    db.close();
    rmSync(repo, { recursive: true, force: true });
    const wtRoot = join(repo, "..", `${basename(repo)}-aitne-worktrees`);
    rmSync(wtRoot, { recursive: true, force: true });
  });

  it("runs two independent tasks in parallel, merges serially, and passes the gate", async () => {
    const config = seed();
    const flow = new FakeFlowLegs();
    flow.decomposeQueue.push({
      plan: planDoc(taskBlock("alpha", "REQ-001"), taskBlock("beta", "REQ-002")),
      n: 2,
    });
    flow.gateReviewQueue.push("APPROVE");
    const legs = fakeWorkerLegsWithGate({}, flow);
    const result = await makeOrch(config, legs, flow, new AbortController().signal).run();

    expect(result).toEqual({ kind: "terminal", loopState: "SUCCESS", reason: expect.any(String) });
    const tasks = listDevTasks(db, "s1");
    expect(tasks.every((t) => t.state === "merged")).toBe(true);
    // Both task files landed on the session branch.
    expect(existsSync(join(repo, "alpha.ts"))).toBe(true);
    expect(existsSync(join(repo, "beta.ts"))).toBe(true);
    // Worktrees cleaned up.
    expect(tasks.every((t) => t.worktreePath === null)).toBe(true);
    expect(notes.some((n) => n.includes("Decomposed"))).toBe(true);
  });

  it("runs an owner-added MANUAL task via its own sub-contract, outside the master ledger", async () => {
    const config = seed();
    const flow = new FakeFlowLegs();
    flow.decomposeQueue.push({
      plan: planDoc(taskBlock("alpha", "REQ-001"), taskBlock("beta", "REQ-002")),
      n: 2,
    });
    flow.gateReviewQueue.push("APPROVE");
    // The owner queued a follow-up BEFORE the run started — the decompose
    // guard must still decompose the master (parked manual queue ≠ resume)
    // and dispatch the add alongside the plan.
    insertDevTasks(db, "s1", [{
      id: "m1", taskKey: "manual-1", summary: "also add a README note",
      dependsOn: [], scope: "", reqs: [], body: "Add a note to the README.", origin: "manual",
    }], 0);
    const legs = fakeWorkerLegsWithGate({}, flow);
    const result = await makeOrch(config, legs, flow, new AbortController().signal).run();

    expect(result).toEqual({ kind: "terminal", loopState: "SUCCESS", reason: expect.any(String) });
    const tasks = listDevTasks(db, "s1");
    expect(tasks).toHaveLength(3);
    expect(tasks.every((t) => t.state === "merged")).toBe(true);
    // The manual task carries its OWN sub-contract anchor.
    const manual = tasks.find((t) => t.taskKey === "manual-1")!;
    expect(manual.approvedHash).not.toBeNull();
    expect(manual.approvedHash).not.toBe(getDevSession(db, "s1")!.approvedHash);
    // Its work landed on the session branch.
    expect(existsSync(join(repo, "manual-1.ts"))).toBe(true);
    // The session REQ ledger stayed master-only (no manual REQ-001 pollution:
    // both master REQs were owned + met by the planned workers).
    const reqs = listDevRequirements(db, "s1");
    expect(reqs.map((r) => r.reqId).sort()).toEqual(["REQ-001", "REQ-002"]);
    expect(reqs.every((r) => r.status === "met")).toBe(true);
  });

  it("returns single when decompose says n=1", async () => {
    const config = seed();
    const flow = new FakeFlowLegs();
    flow.decomposeQueue.push({ plan: planDoc(taskBlock("solo", "REQ-001,REQ-002")), n: 1 });
    const result = await makeOrch(config, fakeWorkerLegs(), flow, new AbortController().signal).run();
    expect(result).toEqual({ kind: "single" });
    expect(listDevTasks(db, "s1")).toHaveLength(0);
  });

  it("a done session with only manual adds SKIPS decompose and runs them as a mini-fleet", async () => {
    const config = seed();
    const flow = new FakeFlowLegs();
    flow.gateReviewQueue.push("APPROVE");
    // A completed run (loop_state SUCCESS) with an owner `!add` queued — the
    // decomposeFlow guard must skip decompose (an empty decomposeQueue would
    // THROW if it ran) and dispatch the manual task straight to the gate.
    db.prepare(`UPDATE dev_sessions SET loop_state = 'SUCCESS' WHERE id = 's1'`).run();
    insertDevTasks(db, "s1", [{
      id: "m1", taskKey: "manual-1", summary: "add a changelog entry",
      dependsOn: [], scope: "", reqs: [], body: "Add a CHANGELOG entry.", origin: "manual",
    }], 0);
    const result = await makeOrch(config, fakeWorkerLegsWithGate({}, flow), flow, new AbortController().signal).run();

    expect(result).toEqual({ kind: "terminal", loopState: "SUCCESS", reason: expect.any(String) });
    const manual = getDevTaskByKey(db, "s1", "manual-1")!;
    expect(manual.state).toBe("merged");
    expect(manual.approvedHash).not.toBeNull(); // ran under its own sub-contract
    expect(existsSync(join(repo, "manual-1.ts"))).toBe(true);
    // decompose was never invoked (its queue was left untouched).
    expect(flow.decomposeQueue).toHaveLength(0);
  });

  it("runs a dependency chain and injects phase-context into the dependent worktree", async () => {
    const config = seed();
    const flow = new FakeFlowLegs();
    flow.decomposeQueue.push({
      plan: planDoc(taskBlock("first", "REQ-001"), taskBlock("second", "REQ-002", "first")),
      n: 2,
    });
    flow.gateReviewQueue.push("APPROVE");
    let secondSawPhaseContext = false;
    const scripts: Record<string, WorkerScript> = {
      second: {
        implement: (wt) => {
          secondSawPhaseContext = existsSync(join(wt, ".aitne-dev", "phase-context", "first", "evidence-report.md"));
          return "success";
        },
      },
    };
    const result = await makeOrch(config, fakeWorkerLegsWithGate(scripts, flow), flow, new AbortController().signal).run();
    expect(result.kind).toBe("terminal");
    expect((result as { loopState: string }).loopState).toBe("SUCCESS");
    expect(secondSawPhaseContext).toBe(true);
    // first must have merged before second started (dependent waits for merge).
    const first = getDevTaskByKey(db, "s1", "first")!;
    const second = getDevTaskByKey(db, "s1", "second")!;
    expect(first.mergedAt).not.toBeNull();
    expect(second.startedAt! >= first.mergedAt!).toBe(true);
  });

  it("recovers from a merge conflict by redoing from the merged HEAD", async () => {
    const config = seed();
    const flow = new FakeFlowLegs();
    // Both tasks write the SAME file → the second merge conflicts.
    flow.decomposeQueue.push({
      plan: planDoc(taskBlock("one", "REQ-001"), taskBlock("two", "REQ-002")),
      n: 2,
    });
    flow.gateReviewQueue.push("APPROVE");
    let twoAttempts = 0;
    const scripts: Record<string, WorkerScript> = {
      one: { implement: () => ({ content: "export const shared = 1;\n" }) },
      two: {
        implement: () => {
          twoAttempts++;
          // First attempt conflicts on shared.ts; the redo appends non-conflicting.
          return { content: twoAttempts === 1 ? "export const shared = 2;\n" : "export const two_only = 2;\n" };
        },
      },
    };
    // Make both write shared.ts by overriding the filename indirectly:
    // simplest — both use `content` writing to <key>.ts, so no conflict. To
    // force a conflict, have `two` also write one.ts on its first attempt.
    const conflictScripts: Record<string, WorkerScript> = {
      one: { implement: () => ({ content: "export const v = 1;\n" }) },
      two: {
        implement: () => {
          twoAttempts++;
          return { content: twoAttempts === 1 ? "CONFLICT" : "export const two = 2;\n" };
        },
      },
    };
    void scripts;
    // Write both to the same path `shared.ts` via a custom leg.
    const legs = fakeWorkerLegsWithGate(conflictScripts, flow);
    const customLegs: DevLegRunner = {
      ...legs,
      async implement(ctx) {
        const key = basename(ctx.repoPath);
        const reqs = ownedReqs(ctx.repoPath);
        if (key === "one") {
          writeFileSync(join(ctx.repoPath, "shared.ts"), "export const v = 1;\n");
        } else {
          twoAttempts++;
          writeFileSync(
            join(ctx.repoPath, "shared.ts"),
            twoAttempts === 1 ? "export const v = 999;\n" : "export const two = 2;\n",
          );
        }
        writeDevDoc(ctx.repoPath, DEV_DOCS.ledger, ledgerFor(reqs, "met"));
        writeDevDoc(ctx.repoPath, DEV_DOCS.agentState, "READY_FOR_REVIEW done");
        return ok("implemented shared");
      },
    };
    const result = await makeOrch(config, customLegs, flow, new AbortController().signal).run();
    expect(result.kind).toBe("terminal");
    expect((result as { loopState: string }).loopState).toBe("SUCCESS");
    // two was redone from the merged HEAD (>=2 attempts) and eventually merged.
    expect(twoAttempts).toBeGreaterThanOrEqual(2);
    expect(getDevTaskByKey(db, "s1", "two")!.state).toBe("merged");
    expect(getDevTaskByKey(db, "s1", "two")!.mergeRetries).toBe(1);
  });

  it("routes a worker escalation to the supervisor; ANSWER relaunches it", async () => {
    const config = seed();
    const flow = new FakeFlowLegs();
    flow.decomposeQueue.push({ plan: planDoc(taskBlock("alpha", "REQ-001"), taskBlock("beta", "REQ-002")), n: 2 });
    flow.gateReviewQueue.push("APPROVE");
    flow.superviseQueue.push({ verdict: "ANSWER", guidance: "use the config value" });
    let alphaCalls = 0;
    const scripts: Record<string, WorkerScript> = {
      alpha: {
        implement: (_wt, n) => {
          alphaCalls = n;
          // First pass: escalate. After the supervisor answers, succeed.
          if (n === 1) return { agentState: "NEEDS_SPEC_DECISION which value?", dr: "DR-1: which value?" };
          return "success";
        },
      },
    };
    const result = await makeOrch(config, fakeWorkerLegsWithGate(scripts, flow), flow, new AbortController().signal).run();
    expect(result.kind).toBe("terminal");
    expect((result as { loopState: string }).loopState).toBe("SUCCESS");
    expect(alphaCalls).toBeGreaterThanOrEqual(2);
    // No user escalation — the supervisor handled it.
    expect(escalations).toHaveLength(0);
    // Guidance file was written into the worktree during the relaunch.
    expect(notes.some((n) => n.includes("supervisor answered"))).toBe(true);
  });

  it("sends RISK_REQUIRES_APPROVAL straight to the owner, never the supervisor", async () => {
    const config = seed({ deniedPaths: ["forbidden/**"] });
    const flow = new FakeFlowLegs();
    flow.decomposeQueue.push({ plan: planDoc(taskBlock("alpha", "REQ-001"), taskBlock("beta", "REQ-002")), n: 2 });
    const scripts: Record<string, WorkerScript> = {
      alpha: {
        implement: (wt) => {
          // Touch a denied path → the evaluator raises RISK_REQUIRES_APPROVAL.
          const dir = join(wt, "forbidden");
          execFileSync("mkdir", ["-p", dir]);
          writeFileSync(join(dir, "secret.ts"), "x");
          return { agentState: "IN_PROGRESS working" };
        },
      },
    };
    // beta completes; alpha parks awaiting_user → the fleet parks.
    const result = await makeOrch(config, fakeWorkerLegsWithGate(scripts, flow), flow, new AbortController().signal).run();
    expect(result.kind).toBe("parked");
    expect(escalations.some((e) => e.kind === "risk_approval")).toBe(true);
    // The supervisor was never consulted for a RISK escalation.
    expect(flow.superviseQueue.length).toBe(0); // nothing was pushed, nothing consumed
    expect(getDevTaskByKey(db, "s1", "alpha")!.state).toBe("awaiting_user");
  });

  it("parks the session and DMs the owner when the supervisor cap is hit", async () => {
    const config = seed({ deniedPaths: [] });
    const flow = new FakeFlowLegs();
    flow.decomposeQueue.push({ plan: planDoc(taskBlock("alpha", "REQ-001"), taskBlock("beta", "REQ-002")), n: 2 });
    flow.gateReviewQueue.push("APPROVE");
    // superviseCap defaults to 2 → two ESCALATE-less REPLAN failures, then cap.
    // Simpler: worker keeps escalating; supervisor keeps ANSWERing without a
    // guidance block → each ANSWER-without-guidance falls to a user escalation
    // only after the cap. Use ESCALATE to go straight to the owner.
    flow.superviseQueue.push({ verdict: "ESCALATE", detail: "need a human" });
    const scripts: Record<string, WorkerScript> = {
      alpha: {
        implement: () => ({ agentState: "NEEDS_ARCHITECTURE_DECISION which db?", dr: "DR-1: which db?" }),
      },
    };
    const result = await makeOrch(config, fakeWorkerLegsWithGate(scripts, flow), flow, new AbortController().signal).run();
    expect(result.kind).toBe("parked");
    const esc = escalations.find((e) => e.taskId !== null);
    expect(esc).toBeTruthy();
    expect(esc!.kind).toBe("architecture_decision");
    expect(getDevTaskByKey(db, "s1", "alpha")!.state).toBe("awaiting_user");
  });

  it("stops the fleet with BUDGET_EXCEEDED when the session ceiling is reached", async () => {
    const config = seed();
    // Force the ceiling low: patch the session budget to a tiny value.
    db.prepare("UPDATE dev_sessions SET max_budget_usd = 0.005 WHERE id = 's1'").run();
    const freshConfig = { ...config };
    const flow = new FakeFlowLegs();
    flow.decomposeQueue.push({ plan: planDoc(taskBlock("alpha", "REQ-001"), taskBlock("beta", "REQ-002")), n: 2 });
    // A single leg costs 0.01 > 0.005, so the first iteration trips the budget.
    const result = await makeOrch(freshConfig, fakeWorkerLegs(), flow, new AbortController().signal).run();
    expect(result.kind).toBe("terminal");
    expect((result as { loopState: string }).loopState).toBe("BUDGET_EXCEEDED");
  });

  it("splits an oversized task via REPLAN and seeds the carryover branch", async () => {
    const config = seed({ splitNudgeAt: 1 });
    const flow = new FakeFlowLegs();
    flow.decomposeQueue.push({ plan: planDoc(taskBlock("big", "REQ-001"), taskBlock("beta", "REQ-002")), n: 2 });
    flow.gateReviewQueue.push("APPROVE");
    // The supervisor splits `big` into a phased chain p1 → p2 (both own REQ-001).
    flow.superviseQueue.push({
      verdict: "REPLAN",
      replan: [taskBlock("p1", "REQ-001"), taskBlock("p2", "REQ-001", "p1")].join("\n"),
    });
    let p1SawSeed = false;
    const scripts: Record<string, WorkerScript> = {
      big: {
        implement: () => ({ agentState: "NEEDS_DECOMPOSITION too big", dr: "DR-1: DONE x / REMAINS p1,p2" }),
      },
      p1: {
        implement: (wt) => {
          // The carried commit from `big` (big.ts) is seeded into p1's tree.
          p1SawSeed = existsSync(join(wt, "big.ts"));
          return "success";
        },
      },
    };
    const result = await makeOrch(config, fakeWorkerLegsWithGate(scripts, flow), flow, new AbortController().signal).run();
    expect(result.kind).toBe("terminal");
    expect((result as { loopState: string }).loopState).toBe("SUCCESS");
    // big was superseded; p1/p2 were created by the replan and merged.
    expect(getDevTaskByKey(db, "s1", "big")!.state).toBe("superseded");
    const p1 = getDevTaskByKey(db, "s1", "p1")!;
    expect(p1.origin).toBe("replan");
    expect(p1.seedBranch).toBe("aitne-dev/s1-big");
    expect(p1SawSeed).toBe(true);
    expect(getDevTaskByKey(db, "s1", "p2")!.state).toBe("merged");
  });

  it("revises the queued plan at a phase boundary (plan-review REVISE)", async () => {
    const config = seed();
    const flow = new FakeFlowLegs();
    // first (REQ-001) → second (REQ-002) chained; after `first` merges the
    // plan review replaces the queued `second` with `second2`.
    flow.decomposeQueue.push({
      plan: planDoc(taskBlock("first", "REQ-001"), taskBlock("second", "REQ-002", "first")),
      n: 2,
    });
    flow.gateReviewQueue.push("APPROVE");
    flow.planReviewQueue.push({
      verdict: "REVISE",
      replan: taskBlock("second2", "REQ-002", "first"),
    });
    const result = await makeOrch(config, fakeWorkerLegsWithGate({}, flow), flow, new AbortController().signal).run();
    expect(result.kind).toBe("terminal");
    expect((result as { loopState: string }).loopState).toBe("SUCCESS");
    expect(getDevTaskByKey(db, "s1", "second")!.state).toBe("superseded");
    const second2 = getDevTaskByKey(db, "s1", "second2")!;
    expect(second2.origin).toBe("plan_review");
    expect(second2.state).toBe("merged");
  });

  it("re-escalates a plan-review owner decision that can't be applied, instead of silently keeping (P1-14)", async () => {
    const config = seed();
    const flow = new FakeFlowLegs();
    flow.decomposeQueue.push({
      plan: planDoc(taskBlock("first", "REQ-001"), taskBlock("second", "REQ-002", "first")),
      n: 2,
    });
    // After `first` merges, its plan review escalates to the owner.
    flow.planReviewQueue.push({ verdict: "ESCALATE", detail: "should the remaining plan change?" });
    const run1 = await makeOrch(config, fakeWorkerLegsWithGate({}, flow), flow, new AbortController().signal).run();
    expect(run1.kind).toBe("parked");
    expect(getDevTaskByKey(db, "s1", "first")!.planReview).toBe("escalated");
    expect(escalations.filter((e) => e.kind === "review_escalation").length).toBe(1);

    // Simulate the owner's answer (what resumeAfterEscalation does on resume):
    // persist the decision + re-arm the review.
    writeDevDoc(repo, `${DEV_TASK_ARCHIVE_DIR}/first/${DEV_OWNER_PLAN_DECISION_FILE}`, "drop REQ-002 from the plan");
    setDevTaskPlanReview(db, getDevTaskByKey(db, "s1", "first")!.id, "pending", 999);

    // The re-run's decision cannot be applied (a REVISE with no valid block).
    // It must RE-ESCALATE, not silently KEEP the un-revised plan + release the
    // held dependent.
    const flow2 = new FakeFlowLegs();
    flow2.planReviewQueue.push({ verdict: "REVISE" }); // no replan block → unusable
    const run2 = await makeOrch(config, fakeWorkerLegsWithGate({}, flow2), flow2, new AbortController().signal).run();
    expect(run2.kind).toBe("parked");
    expect(getDevTaskByKey(db, "s1", "first")!.planReview).toBe("escalated"); // re-escalated, NOT done
    const reviewEscalations = escalations.filter((e) => e.kind === "review_escalation");
    expect(reviewEscalations.length).toBe(2);
    expect(reviewEscalations[1]!.question).toContain("couldn't apply your decision");
    // The held dependent was NOT released blind.
    expect(getDevTaskByKey(db, "s1", "second")!.state).toBe("queued");
  });

  it("runs an integration fix-up when the gate rejects the merged whole", async () => {
    const config = seed();
    const flow = new FakeFlowLegs();
    flow.decomposeQueue.push({ plan: planDoc(taskBlock("alpha", "REQ-001"), taskBlock("beta", "REQ-002")), n: 2 });
    // First gate REVISE → one fix-up task → re-gate APPROVE.
    flow.gateReviewQueue.push("REVISE", "APPROVE");
    flow.superviseQueue.push({
      verdict: "REPLAN",
      replan: taskBlock("fixit", "REQ-001"),
    });
    const result = await makeOrch(config, fakeWorkerLegsWithGate({}, flow), flow, new AbortController().signal).run();
    expect(result.kind).toBe("terminal");
    expect((result as { loopState: string }).loopState).toBe("SUCCESS");
    const fixit = getDevTaskByKey(db, "s1", "fixit")!;
    expect(fixit.origin).toBe("fixup");
    expect(fixit.state).toBe("merged");
    expect(getDevSession(db, "s1")!.fixupCount).toBe(1);
  });

  it("resumes an existing fleet (no re-decompose) after a restart", async () => {
    const config = seed();
    const flow = new FakeFlowLegs();
    flow.decomposeQueue.push({ plan: planDoc(taskBlock("alpha", "REQ-001"), taskBlock("beta", "REQ-002")), n: 2 });
    flow.gateReviewQueue.push("APPROVE");
    // First run to completion.
    await makeOrch(config, fakeWorkerLegsWithGate({}, flow), flow, new AbortController().signal).run();
    expect(listDevTasks(db, "s1").every((t) => t.state === "merged")).toBe(true);
    // A second orchestrator over the SAME db finds tasks already merged → the
    // dispatch loop settles straight to the gate; decompose is never called.
    const flow2 = new FakeFlowLegs();
    flow2.gateReviewQueue.push("APPROVE");
    const result = await makeOrch(config, fakeWorkerLegsWithGate({}, flow2), flow2, new AbortController().signal).run();
    expect(result.kind).toBe("terminal");
    expect((result as { loopState: string }).loopState).toBe("SUCCESS");
    // decomposeQueue on flow2 was never touched.
    expect(flow2.decomposeQueue).toHaveLength(0);
  });

  it("reclaims an orphaned `running` task on resume instead of stalling BLOCKED", async () => {
    const config = seed();
    // Simulate a crash mid-fleet: the tasks exist and one is stuck `running`
    // in the DB with NO in-memory worker promise (the daemon restarted).
    insertDevTasks(
      db,
      "s1",
      [
        { id: "t-alpha", taskKey: "alpha", summary: "a", dependsOn: [], scope: "alpha.ts", reqs: ["REQ-001"], body: "impl alpha", origin: "plan" },
        { id: "t-beta", taskKey: "beta", summary: "b", dependsOn: [], scope: "beta.ts", reqs: ["REQ-002"], body: "impl beta", origin: "plan" },
      ],
      0,
    );
    markDevTaskState(db, { id: "t-alpha", from: ["queued"], to: "running", at: 0 });

    const flow = new FakeFlowLegs();
    flow.gateReviewQueue.push("APPROVE");
    // A fresh orchestrator (post-restart) must re-queue the orphaned task and
    // drive the fleet to SUCCESS — NOT read `running` as an unsettled stall and
    // terminate BLOCKED. decompose is never called (tasks already exist).
    const result = await makeOrch(config, fakeWorkerLegsWithGate({}, flow), flow, new AbortController().signal).run();

    expect(result.kind).toBe("terminal");
    expect((result as { loopState: string }).loopState).toBe("SUCCESS");
    expect(listDevTasks(db, "s1").every((t) => t.state === "merged")).toBe(true);
    expect(flow.decomposeQueue).toHaveLength(0);
  });

  // Spawn-heavy (2 full workers + 21 merge-defer rounds, each round several
  // git subprocesses) — on a machine with slow process spawn (~200ms/exec)
  // this brushes the global 45s testTimeout, so it gets its own ceiling.
  it("defers (not BLOCKED) when the parent repo is dirty at merge, then parks the owner", { timeout: 120_000 }, async () => {
    const config = seed();
    const flow = new FakeFlowLegs();
    flow.decomposeQueue.push({
      plan: planDoc(taskBlock("alpha", "REQ-001"), taskBlock("beta", "REQ-002")),
      n: 2,
    });
    // Simulate the human editing a tracked file DURING the run (after decompose,
    // which has its own containment guard): the alpha worker dirties the PARENT
    // repo. Every merge must then DEFER (never land over the human's edit), and
    // when nothing else can progress the fleet must PARK the owner — NOT mis-read
    // merge_pending as an idle stall and die BLOCKED (P0-3).
    const legs = fakeWorkerLegsWithGate(
      {
        alpha: {
          implement: (): "success" => {
            writeFileSync(join(repo, "README.md"), "seed\nlocal uncommitted edit\n");
            return "success";
          },
        },
      },
      flow,
    );
    const result = await makeOrch(config, legs, flow, new AbortController().signal).run();

    expect(result.kind).toBe("parked");
    expect(escalations.some((e) => /uncommitted/i.test(e.question))).toBe(true);
    // The human's tracked edit was never merged over.
    expect(readFileSync(join(repo, "README.md"), "utf8")).toContain("local uncommitted edit");
    // No task landed (all held at merge_pending), and nothing failed BLOCKED.
    expect(listDevTasks(db, "s1").every((t) => t.state !== "merged" && t.state !== "failed")).toBe(true);
  });
});
