import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../db/schema.js";
import {
  createDevSession,
  getDevSession,
  markDevAwaitingApproval,
  approveDevSession,
  seedDevRequirements,
  updateDevSessionConfig,
  type DevSessionRow,
} from "../../db/dev-sessions-store.js";
import {
  DevLoopEngine,
  type DevIterationOutcome,
  type DevLegContext,
  type DevLegResponse,
  type DevLegRunner,
  type DevReviewLegContext,
  type DevReviewLegResult,
} from "./dev-loop-engine.js";
import {
  DEV_DOCS,
  ensureDevWorkdir,
  writeDevDoc,
} from "./dev-loop-docs.js";
import { computeApprovalHash, normalizeDevLoopConfig } from "./dev-loop-config.js";

const CONTRACT_MD = [
  "# Product Contract",
  "## Goal",
  "Build the thing.",
  "### REQ-001: first",
  "### REQ-002: second",
].join("\n");

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function okLeg(text: string): DevLegResponse {
  return { text, sessionId: "sdk-1", costUsd: 0.01, numTurns: 3, isError: false };
}

function ledgerMd(status: string): string {
  return [
    "| REQ | Status | Evidence | Iter |",
    "| --- | --- | --- | --- |",
    `| REQ-001 | ${status} | ev | 1 |`,
    `| REQ-002 | ${status} | ev | 1 |`,
  ].join("\n");
}

describe("DevLoopEngine (integration over a real git repo)", () => {
  let repo: string;
  let db: Database.Database;
  let session: DevSessionRow;
  let idn = 0;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "dev-engine-"));
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@t"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "README.md"), "seed\n");
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed"]);
    const baseRef = git(repo, ["rev-parse", "HEAD"]);
    ensureDevWorkdir(repo);
    writeDevDoc(repo, DEV_DOCS.contract, CONTRACT_MD);

    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
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
    const config = normalizeDevLoopConfig({ verifyCommands: ["true"], deniedPaths: [".env*"] });
    updateDevSessionConfig(db, "s1", { config }, 0);
    seedDevRequirements(
      db,
      "s1",
      [
        { id: "r1", reqId: "REQ-001", title: "first" },
        { id: "r2", reqId: "REQ-002", title: "second" },
      ],
      0,
    );
    markDevAwaitingApproval(db, "s1", 0);
    approveDevSession(db, {
      id: "s1",
      approvedHash: computeApprovalHash(CONTRACT_MD, config),
      branch: "aitne-dev/s1",
      baseRef,
      maxIterations: 10,
      maxBudgetUsd: 10,
      approvedAt: 0,
    });
    session = getDevSession(db, "s1")!;
  });

  afterEach(() => {
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  function engine(legRunner: DevLegRunner): DevLoopEngine {
    idn = 0;
    return new DevLoopEngine(session, {
      db,
      repoPath: repo,
      legRunner,
      tier: "high",
      now: () => 1000,
      uuid: () => `id-${idn++}`,
    });
  }

  it("happy path: implement→evaluate→gate APPROVE→evidence→final SUCCESS", async () => {
    const legRunner: DevLegRunner = {
      async plan() {
        writeDevDoc(repo, DEV_DOCS.plan, "## Milestones\n- [ ] REQ-001\n- [ ] REQ-002");
        return okLeg("planned");
      },
      async implement(ctx: DevLegContext) {
        writeFileSync(join(repo, "feature.ts"), `export const x = ${ctx.iteration};\n`);
        writeDevDoc(repo, DEV_DOCS.ledger, ledgerMd("met"));
        writeDevDoc(repo, DEV_DOCS.agentState, "READY_FOR_REVIEW all done");
        return okLeg("implemented");
      },
      async review(ctx: DevReviewLegContext): Promise<DevReviewLegResult> {
        const text =
          ctx.mode === "gate"
            ? "REQ-001: MET ok\nREQ-002: MET ok\nVERDICT: APPROVE ship it"
            : "VERDICT: APPROVE looks fine";
        return { response: okLeg(text), review: parseFor(ctx, text) };
      },
      async stopEval() {
        return { response: okLeg("STOP-EVAL: MET"), verdict: "MET" };
      },
      async evidence() {
        writeDevDoc(repo, DEV_DOCS.evidence, "# Implementation Evidence Report\n...");
        return okLeg("evidence");
      },
    };
    const e = engine(legRunner);
    await e.ensurePlan();
    const outcome = await e.runIteration(1);
    expect(outcome).toEqual<DevIterationOutcome>({
      kind: "terminal",
      loopState: "SUCCESS",
      reason: expect.stringMatching(/green/),
    });
  });

  it("escalation: agent declares NEEDS_SPEC_DECISION → escalate outcome", async () => {
    const legRunner = baseRunner();
    legRunner.implement = async () => {
      writeFileSync(join(repo, "wip.ts"), "// partial\n");
      writeDevDoc(repo, DEV_DOCS.decisionRequests, "## DR-1\nWhich database?");
      writeDevDoc(repo, DEV_DOCS.agentState, "NEEDS_SPEC_DECISION which db");
      return okLeg("stuck");
    };
    const outcome = await engine(legRunner).runIteration(1);
    expect(outcome.kind).toBe("escalate");
    if (outcome.kind === "escalate") {
      expect(outcome.escalationKind).toBe("spec_decision");
      expect(outcome.loopState).toBe("NEEDS_SPEC_DECISION");
      expect(outcome.contextSummary).toMatch(/Which database/);
    }
  });

  it("denied path touched → RISK_REQUIRES_APPROVAL escalate", async () => {
    const legRunner = baseRunner();
    legRunner.implement = async () => {
      writeFileSync(join(repo, ".env.local"), "SECRET=1\n");
      writeDevDoc(repo, DEV_DOCS.agentState, "IN_PROGRESS wrote env");
      return okLeg("touched env");
    };
    const outcome = await engine(legRunner).runIteration(1);
    expect(outcome.kind).toBe("escalate");
    if (outcome.kind === "escalate") expect(outcome.escalationKind).toBe("risk_approval");
  });

  it("not-ready iteration with interim APPROVE + stop-eval CONTINUE → continue", async () => {
    const legRunner = baseRunner();
    legRunner.implement = async () => {
      writeFileSync(join(repo, "feature.ts"), "export const x = 1;\n");
      writeDevDoc(repo, DEV_DOCS.ledger, ledgerMd("in-progress"));
      writeDevDoc(repo, DEV_DOCS.agentState, "IN_PROGRESS still going");
      return okLeg("progress");
    };
    const outcome = await engine(legRunner).runIteration(1);
    expect(outcome).toEqual({ kind: "continue" });
  });

  it("hits the iteration cap → BUDGET_EXCEEDED", async () => {
    const outcome = await engine(baseRunner()).runIteration(11);
    expect(outcome).toEqual({ kind: "terminal", loopState: "BUDGET_EXCEEDED", reason: expect.any(String) });
  });

  // ── helpers ──
  function parseFor(ctx: DevReviewLegContext, text: string): DevReviewLegResult["review"] {
    // Minimal inline parse mirroring the leg runner's use of verdict-parse.
    const verdict = /VERDICT:\s*APPROVE/.test(text) ? "APPROVE" : "REVISE";
    return { verdict, summary: "", reqVerdicts: ctx.mode === "gate" ? [] : undefined };
  }
  function baseRunner(): DevLegRunner {
    return {
      async plan() {
        writeDevDoc(repo, DEV_DOCS.plan, "## Milestones\n- [ ] REQ-001");
        return okLeg("planned");
      },
      async implement() {
        return okLeg("noop");
      },
      async review(ctx) {
        const text = "VERDICT: APPROVE fine";
        return { response: okLeg(text), review: parseFor(ctx, text) };
      },
      async stopEval() {
        return { response: okLeg("STOP-EVAL: CONTINUE"), verdict: "CONTINUE" };
      },
      async evidence() {
        return okLeg("evidence");
      },
    };
  }

  it("terminates BUDGET_EXCEEDED when the per-run wall-clock cap is exceeded", async () => {
    const cfg = normalizeDevLoopConfig({ verifyCommands: ["true"], maxRunSeconds: 5 });
    updateDevSessionConfig(db, "s1", { config: cfg }, 0);
    const s = getDevSession(db, "s1")!;
    let clock = 1000; // runStartMs is captured here at construction
    const e = new DevLoopEngine(s, {
      db, repoPath: repo, legRunner: baseRunner(), tier: "high",
      now: () => clock, uuid: () => `id-${idn++}`,
    });
    clock = 1000 + 6000; // 6s elapsed > 5s cap
    const outcome = await e.runIteration(1);
    expect(outcome).toEqual<DevIterationOutcome>({
      kind: "terminal", loopState: "BUDGET_EXCEEDED", reason: expect.stringMatching(/wall-clock/),
    });
  });

  it("honors a shared absolute runDeadlineMs (fleet worker) over its own window", async () => {
    let clock = 1000;
    const e = new DevLoopEngine(session, {
      db, repoPath: repo, legRunner: baseRunner(), tier: "high",
      now: () => clock, uuid: () => `id-${idn++}`,
      runDeadlineMs: 2000, // absolute deadline, independent of construction time
    });
    clock = 2001; // past the shared deadline
    const outcome = await e.runIteration(1);
    expect(outcome).toEqual<DevIterationOutcome>({
      kind: "terminal", loopState: "BUDGET_EXCEEDED", reason: expect.stringMatching(/wall-clock/),
    });
  });
});
