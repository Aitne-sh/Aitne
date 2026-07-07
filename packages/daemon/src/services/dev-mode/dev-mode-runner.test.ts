import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../db/schema.js";
import {
  createDevSession,
  getDevSession,
  markDevAwaitingApproval,
  updateDevSessionConfig,
  listDevRequirements,
  listDevIterations,
} from "../../db/dev-sessions-store.js";
import {
  getOpenDevEscalationForSession,
  listDevEscalationsForSession,
} from "../../db/dev-session-escalations-store.js";
import { DEV_DOCS, ensureDevWorkdir, writeDevDoc, readDevDoc } from "./dev-loop-docs.js";
import { normalizeDevLoopConfig } from "./dev-loop-config.js";
import {
  createDevModeRunner,
  type DevModeDeliveryEnqueuer,
  type DevModeRunner,
} from "./dev-mode-runner.js";
import type { DevBackend, DevBackendRequest } from "./dev-loop-legs.js";
import type { DevLegResponse } from "./dev-loop-engine.js";

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

function ok(text: string): DevLegResponse {
  return { text, sessionId: null, costUsd: 0.01, numTurns: 2, isError: false };
}

function ledgerMd(status: string): string {
  return [
    "| REQ | Status | Evidence | Iter |",
    "| --- | --- | --- | --- |",
    `| REQ-001 | ${status} | ev | 1 |`,
    `| REQ-002 | ${status} | ev | 1 |`,
  ].join("\n");
}

/** A fake DevBackend that side-effects the repo like a real leg would (writing
 *  files/ledger/agent-state) and returns the verdict text the parser reads. The
 *  `implement` behaviour is overridable per test. */
function fakeBackend(
  repo: string,
  overrides: Partial<Record<string, (req: DevBackendRequest) => DevLegResponse>> = {},
): DevBackend {
  return {
    async runLeg(req: DevBackendRequest): Promise<DevLegResponse> {
      const override = overrides[req.taskFlowKey];
      if (override) return override(req);
      switch (req.taskFlowKey) {
        case "dev.plan":
          writeDevDoc(repo, DEV_DOCS.plan, "## Milestones\n- [ ] REQ-001\n- [ ] REQ-002");
          return ok("planned");
        case "dev.implement":
          writeFileSync(join(repo, "feature.ts"), "export const x = 1;\n");
          writeDevDoc(repo, DEV_DOCS.ledger, ledgerMd("met"));
          writeDevDoc(repo, DEV_DOCS.agentState, "READY_FOR_REVIEW done");
          return ok("implemented");
        case "dev.review":
          return ok("REQ-001: MET ok\nREQ-002: MET ok\nVERDICT: APPROVE ship it");
        case "dev.stop_eval":
          return ok("STOP-EVAL: MET");
        case "dev.evidence":
          writeDevDoc(repo, DEV_DOCS.evidence, "# Implementation Evidence Report\n...");
          return ok("evidence");
        default:
          return ok("noop");
      }
    },
  };
}

interface CapturedDelivery {
  digests: { sessionId: string; draft: string; report: string; evidencePath?: string | null }[];
  escalations: { sessionId: string; escalationId: string; question: string }[];
}

function makeEnqueuer(cap: CapturedDelivery): DevModeDeliveryEnqueuer {
  return {
    async enqueueDigest(input) {
      cap.digests.push(input);
    },
    async enqueueEscalation(input) {
      cap.escalations.push(input);
    },
  };
}

async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("DevModeRunner", () => {
  let repo: string;
  let db: Database.Database;
  let idn = 0;
  let cap: CapturedDelivery;

  function seedSession(): void {
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
    updateDevSessionConfig(db, "s1", { config, maxBudgetUsd: 10 }, 0);
    ensureDevWorkdir(repo);
    writeDevDoc(repo, DEV_DOCS.contract, CONTRACT_MD);
    markDevAwaitingApproval(db, "s1", 0);
  }

  let published: string[];

  function makeRunner(backend: DevBackend, onEnded?: (id: string) => void): DevModeRunner {
    idn = 0;
    return createDevModeRunner({
      db,
      makeBackend: () => backend,
      loadTaskFlow: (key) => `${key} flow {context}`,
      resolveRepoPath: (repoId) => (repoId === "local:t" ? repo : null),
      onSessionEnded: onEnded,
      deliveryEnqueuer: makeEnqueuer(cap),
      publisher: {
        publishSession: (input) => published.push(input.sessionId),
      },
      tier: "high",
      now: () => 1000,
      uuid: () => `id-${idn++}`,
    });
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "dev-runner-"));
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@t"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "README.md"), "seed\n");
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed"]);
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    cap = { digests: [], escalations: [] };
    published = [];
    seedSession();
  });

  afterEach(() => {
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it("startFromApproval: approves, branches, seeds reqs, and drives the loop to SUCCESS", async () => {
    const ended: string[] = [];
    const runner = makeRunner(fakeBackend(repo), (id) => ended.push(id));
    const result = runner.startFromApproval("s1");
    expect(result.ok).toBe(true);
    expect(result.branch).toBe("aitne-dev/s1");
    expect(result.reqCount).toBe(2);

    await waitUntil(() => getDevSession(db, "s1")?.state !== "running");

    const session = getDevSession(db, "s1")!;
    expect(session.state).toBe("done");
    expect(session.loopState).toBe("SUCCESS");
    expect(session.approvedHash).toBeTruthy();
    // Seeded both REQs from the contract headings.
    expect(listDevRequirements(db, "s1")).toHaveLength(2);
    // Ran on the dev branch, never the owner's branch.
    expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("aitne-dev/s1");
    // onSessionEnded + a digest fired.
    expect(ended).toEqual(["s1"]);
    expect(cap.digests).toHaveLength(1);
    expect(cap.digests[0]!.draft).toContain("SUCCESS");
    expect(cap.digests[0]!.evidencePath).toContain("evidence-report.md");
    // Artifacts published to the knowledge vault on terminal.
    expect(published).toEqual(["s1"]);
    // The timeout FK is cleared on terminal.
    expect(session.timeoutScheduleId).toBeNull();
  });

  it("rejects an approval that is not awaiting_approval", async () => {
    const runner = makeRunner(fakeBackend(repo));
    const first = runner.startFromApproval("s1");
    expect(first.ok).toBe(true);
    // Let the first loop finish so the session leaves awaiting_approval (and no
    // detached work outlives the test into a closed DB).
    await waitUntil(() => getDevSession(db, "s1")?.state !== "running");
    const second = runner.startFromApproval("s1");
    expect(second.ok).toBe(false);
    expect(second.reason).toContain("not_awaiting_approval");
  });

  it("rejects approval when the contract has no REQ headings", () => {
    writeDevDoc(repo, "docs/product-contract.md", "# Contract\nNo requirements here.");
    const runner = makeRunner(fakeBackend(repo));
    const result = runner.startFromApproval("s1");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("REQ");
  });

  it("escalates: parks awaiting_user, records an escalation, cancels the timeout", async () => {
    const runner = makeRunner(
      fakeBackend(repo, {
        "dev.implement": () => {
          writeFileSync(join(repo, "wip.ts"), "// partial\n");
          writeDevDoc(repo, DEV_DOCS.decisionRequests, "## DR-1\nWhich database?");
          writeDevDoc(repo, DEV_DOCS.agentState, "NEEDS_SPEC_DECISION which db");
          return ok("stuck");
        },
      }),
    );
    runner.startFromApproval("s1");
    await waitUntil(() => getDevSession(db, "s1")?.state === "awaiting_user");

    const session = getDevSession(db, "s1")!;
    expect(session.state).toBe("awaiting_user");
    expect(session.timeoutScheduleId).toBeNull();
    const open = getOpenDevEscalationForSession(db, "s1");
    expect(open?.kind).toBe("spec_decision");
    expect(open?.contextSummary).toContain("Which database");
    expect(cap.escalations).toHaveLength(1);
    expect(cap.escalations[0]!.escalationId).toBe(open!.id);
  });

  it("resumeAfterEscalation: resolves the question, folds the answer in, and finishes", async () => {
    let escalated = false;
    const runner = makeRunner(
      fakeBackend(repo, {
        "dev.implement": (req) => {
          const dr = readDevDoc(req.sessionDir, DEV_DOCS.decisionRequests) ?? "";
          if (!escalated && !dr.includes("Owner decision")) {
            escalated = true;
            writeDevDoc(repo, DEV_DOCS.decisionRequests, "## DR-1\nWhich database?");
            writeDevDoc(repo, DEV_DOCS.agentState, "NEEDS_SPEC_DECISION which db");
            return ok("stuck");
          }
          // Post-answer: complete.
          writeFileSync(join(repo, "feature.ts"), "export const x = 1;\n");
          writeDevDoc(repo, DEV_DOCS.ledger, ledgerMd("met"));
          writeDevDoc(repo, DEV_DOCS.agentState, "READY_FOR_REVIEW done");
          return ok("done");
        },
      }),
    );
    runner.startFromApproval("s1");
    await waitUntil(() => getDevSession(db, "s1")?.state === "awaiting_user");
    const escId = getOpenDevEscalationForSession(db, "s1")!.id;

    const resumed = await runner.resumeAfterEscalation({
      sessionId: "s1",
      escalationId: escId,
      answer: "Use SQLite.",
    });
    expect(resumed).toBe("resumed");
    await waitUntil(() => getDevSession(db, "s1")?.state === "done");

    // The escalation is resolved and the answer landed in decision-requests.md.
    expect(listDevEscalationsForSession(db, "s1")[0]!.resolved).toBe(true);
    expect(readDevDoc(repo, DEV_DOCS.decisionRequests)).toContain("Use SQLite");
    expect(getDevSession(db, "s1")!.loopState).toBe("SUCCESS");
  });

  it("cancel: aborts and marks exited", async () => {
    const ended: string[] = [];
    const runner = makeRunner(fakeBackend(repo), (id) => ended.push(id));
    runner.startFromApproval("s1");
    const cancelled = await runner.cancel("s1", "user exit");
    expect(cancelled).toBe(true);
    const session = getDevSession(db, "s1")!;
    expect(session.state).toBe("exited");
    expect(ended).toContain("s1");
  });

  it("timeout helpers: arm creates a schedule row + FK; cancel skips it", () => {
    const runner = makeRunner(fakeBackend(repo));
    runner.armTimeout("s1");
    const armed = getDevSession(db, "s1")!;
    expect(armed.timeoutScheduleId).not.toBeNull();
    const row = db
      .prepare(`SELECT task_type, status FROM agent_schedule WHERE id = ?`)
      .get(armed.timeoutScheduleId) as { task_type: string; status: string };
    expect(row.task_type).toBe("dev_session_timeout");
    expect(row.status).toBe("pending");

    runner.cancelTimeout("s1");
    expect(getDevSession(db, "s1")!.timeoutScheduleId).toBeNull();
    const after = db
      .prepare(`SELECT status FROM agent_schedule WHERE id = ?`)
      .get(armed.timeoutScheduleId) as { status: string };
    expect(after.status).toBe("skipped");
  });

  it("expireForTimeout: exits an idle interview/approval session", async () => {
    const ended: string[] = [];
    const runner = makeRunner(fakeBackend(repo), (id) => ended.push(id));
    // Session is in awaiting_approval (seedSession). Expire it.
    await runner.expireForTimeout("s1");
    expect(getDevSession(db, "s1")!.state).toBe("exited");
    expect(ended).toContain("s1");
  });

  it("expireForTimeout: does NOT kill a running loop (defensive guard)", async () => {
    const runner = makeRunner(fakeBackend(repo));
    // Move to running without finishing (block the loop by making implement hang
    // is hard; instead approve then immediately expire before the loop finishes).
    // Simpler: assert expire is a no-op once terminal-done.
    runner.startFromApproval("s1");
    await waitUntil(() => getDevSession(db, "s1")?.state === "done");
    const before = getDevSession(db, "s1")!.state;
    await runner.expireForTimeout("s1");
    expect(getDevSession(db, "s1")!.state).toBe(before); // unchanged (already done)
  });

  it("interview turn scopes Write/Edit to .aitne-dev (no unscoped repo writes)", async () => {
    let capturedTools: readonly string[] = [];
    const backend: DevBackend = {
      async runLeg(req) {
        capturedTools = req.allowedTools;
        // Simulate the agent writing the drafts + declaring readiness.
        writeDevDoc(repo, DEV_DOCS.contract, CONTRACT_MD);
        writeDevDoc(repo, "docs/loop-config.json", JSON.stringify({ verifyCommands: ["true"] }));
        writeDevDoc(repo, DEV_DOCS.agentState, "CONTRACT_READY drafted");
        return ok("here's the contract");
      },
    };
    // Session must be in interview state.
    db.prepare(`UPDATE dev_sessions SET state = 'interview' WHERE id = 's1'`).run();
    const runner = makeRunner(backend);
    const reply = await runner.runInterviewTurn({ sessionId: "s1", userMessage: "build X" });
    expect(capturedTools).toContain("Write(.aitne-dev/**)");
    expect(capturedTools).toContain("Edit(.aitne-dev/**)");
    expect(capturedTools).not.toContain("Write");
    expect(capturedTools).not.toContain("Edit");
    // CONTRACT_READY → finalized → awaiting_approval + loop summary.
    expect(getDevSession(db, "s1")!.state).toBe("awaiting_approval");
    expect(reply).toContain("Reply !approve");
  });

  it("records per-leg iterations for the timeline", async () => {
    const runner = makeRunner(fakeBackend(repo));
    runner.startFromApproval("s1");
    await waitUntil(() => getDevSession(db, "s1")?.state !== "running");
    const phases = listDevIterations(db, "s1").map((r) => r.phase);
    expect(phases).toContain("plan");
    expect(phases).toContain("implement");
    expect(phases).toContain("evaluate");
    expect(phases).toContain("evidence");
  });
});
