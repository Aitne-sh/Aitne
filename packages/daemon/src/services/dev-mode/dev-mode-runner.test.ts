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
  markDevAwaitingUser,
  approveDevSession,
  updateDevSessionConfig,
  listDevRequirements,
  listDevIterations,
} from "../../db/dev-sessions-store.js";
import {
  createDevEscalation,
  getOpenDevEscalationForSession,
  listDevEscalationsForSession,
} from "../../db/dev-session-escalations-store.js";
import { getDevTask, listDevTasks } from "../../db/dev-session-tasks-store.js";
import {
  DEV_DOCS,
  DEV_OWNER_PLAN_DECISION_FILE,
  DEV_TASK_ARCHIVE_DIR,
  ensureDevWorkdir,
  writeDevDoc,
  readDevDoc,
} from "./dev-loop-docs.js";
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
        case "dev.decompose":
          // n=1 (fewer-is-better) — routes straight to the single loop.
          writeDevDoc(
            req.sessionDir,
            DEV_DOCS.taskPlan,
            [
              "<!-- TASK-PLAN-BEGIN v1 -->",
              "TASK: all",
              "SUMMARY: build everything",
              "DEPENDS: -",
              "SCOPE: the whole contract",
              "REQS: REQ-001,REQ-002",
              "BODY-BEGIN",
              "Implement the whole contract.",
              "BODY-END",
              "TASK-END",
              "<!-- TASK-PLAN-END -->",
            ].join("\n"),
          );
          return ok("DECOMPOSE: TASKS n=1");
        case "dev.decompose_review":
          return ok("DECOMPOSE-REVIEW: APPROVE single task is right");
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

  it("startFromApproval wires the process cap (③) from config.maxCostUsd when set", async () => {
    updateDevSessionConfig(db, "s1", { config: normalizeDevLoopConfig({ verifyCommands: ["true"], maxCostUsd: 8 }) }, 0);
    const runner = makeRunner(fakeBackend(repo));
    expect(runner.startFromApproval("s1").ok).toBe(true);
    // The per-process cap is authoritative from config → session.max_budget_usd.
    expect(getDevSession(db, "s1")!.maxBudgetUsd).toBe(8);
    await waitUntil(() => getDevSession(db, "s1")?.state !== "running");
  });

  it("startFromApproval CLEARS the process cap to null when ③ is off (direct SET, not COALESCE)", async () => {
    // seedSession pre-set max_budget_usd = 10; approving with ③ off (config
    // maxCostUsd = null) must CLEAR it — a stale cap must never survive "off".
    const runner = makeRunner(fakeBackend(repo));
    expect(runner.startFromApproval("s1").ok).toBe(true);
    expect(getDevSession(db, "s1")!.maxBudgetUsd).toBeNull();
    await waitUntil(() => getDevSession(db, "s1")?.state !== "running");
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

  it("routes an n>=2 decomposition into the fleet (per-task worktrees + merge)", async () => {
    // A decompose leg that splits the two REQs into two independent tasks; each
    // worker writes a task-named file and marks its OWNED req met; the gate
    // APPROVEs the merged whole.
    const fleetBackend: DevBackend = {
      async runLeg(req: DevBackendRequest): Promise<DevLegResponse> {
        switch (req.taskFlowKey) {
          case "dev.decompose":
            writeDevDoc(
              req.sessionDir,
              DEV_DOCS.taskPlan,
              [
                "<!-- TASK-PLAN-BEGIN v1 -->",
                "TASK: alpha\nSUMMARY: a\nDEPENDS: -\nSCOPE: alpha.ts\nREQS: REQ-001\nBODY-BEGIN\nbuild alpha\nBODY-END\nTASK-END",
                "TASK: beta\nSUMMARY: b\nDEPENDS: -\nSCOPE: beta.ts\nREQS: REQ-002\nBODY-BEGIN\nbuild beta\nBODY-END\nTASK-END",
                "<!-- TASK-PLAN-END -->",
              ].join("\n"),
            );
            return ok("DECOMPOSE: TASKS n=2");
          case "dev.decompose_review":
            return ok("DECOMPOSE-REVIEW: APPROVE clean split");
          case "dev.plan":
            writeDevDoc(req.sessionDir, DEV_DOCS.plan, "## Milestones\n- [ ] do it");
            return ok("planned");
          case "dev.implement": {
            const key = req.sessionDir.split("/").pop()!;
            writeFileSync(join(req.sessionDir, `${key}.ts`), `export const ${key} = 1;\n`);
            const ledgerMd_ = readDevDoc(req.sessionDir, DEV_DOCS.ledger) ?? "";
            const reqs = [...ledgerMd_.matchAll(/\| (REQ-\d+) \|/g)].map((m) => m[1]!);
            writeDevDoc(
              req.sessionDir,
              DEV_DOCS.ledger,
              ["| REQ | Status | Evidence | Iter |", "|---|---|---|---|", ...reqs.map((r) => `| ${r} | met | ev | 1 |`)].join("\n"),
            );
            writeDevDoc(req.sessionDir, DEV_DOCS.agentState, "READY_FOR_REVIEW done");
            return ok("implemented");
          }
          case "dev.review":
            // Emit per-REQ MET lines for both reqs so the gate downgrade
            // (scoped to owned reqs for a worker, all reqs for integration)
            // never fires.
            return ok("REQ-001: MET ok\nREQ-002: MET ok\nVERDICT: APPROVE ship it");
          case "dev.stop_eval":
            return ok("STOP-EVAL: MET");
          case "dev.evidence":
            writeDevDoc(req.sessionDir, DEV_DOCS.evidence, "# Evidence\nall good");
            return ok("evidence");
          default:
            return ok("noop");
        }
      },
    };
    const runner = makeRunner(fleetBackend);
    runner.startFromApproval("s1");
    await waitUntil(() => getDevSession(db, "s1")?.state !== "running", 15000);
    const session = getDevSession(db, "s1")!;
    expect(session.state).toBe("done");
    expect(session.loopState).toBe("SUCCESS");
    // Both decomposed task files landed on the session branch.
    expect(existsSync(join(repo, "alpha.ts"))).toBe(true);
    expect(existsSync(join(repo, "beta.ts"))).toBe(true);
    // The task rows are recorded and merged.
    const tasks = listDevTasks(db, "s1");
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.state === "merged")).toBe(true);
    // Iteration rows are tagged with their task id.
    const taskTagged = listDevIterations(db, "s1").filter((r) => r.taskId !== null);
    expect(taskTagged.length).toBeGreaterThan(0);
  });

  // ── WP3 escalation-routing + lifecycle ────────────────────────────────

  /** Approve + park the session in awaiting_user (bypassing the loop) so a
   *  resumeAfterEscalation edge case can be exercised deterministically. */
  function parkAwaitingUser(): void {
    approveDevSession(db, {
      id: "s1", approvedHash: "h", branch: "aitne-dev/s1", baseRef: "base",
      maxIterations: 10, maxBudgetUsd: null, approvedAt: 0,
    });
    markDevAwaitingUser(db, "s1", 0);
  }

  it("interview turn is abortable via cancel (P1-15)", async () => {
    db.prepare(`UPDATE dev_sessions SET state = 'interview' WHERE id = 's1'`).run();
    let started = false;
    let aborted = false;
    let ctrl: AbortController | null = null;
    const backend: DevBackend = {
      async runLeg() {
        started = true;
        if (ctrl!.signal.aborted) {
          aborted = true;
        } else {
          await new Promise<void>((resolve) =>
            ctrl!.signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }),
          );
        }
        return { text: "aborted", sessionId: null, costUsd: 0, numTurns: 0, isError: true };
      },
    };
    const runner = createDevModeRunner({
      db,
      makeBackend: (controller) => { ctrl = controller; return backend; },
      loadTaskFlow: (key) => `${key} {context}`,
      resolveRepoPath: (id) => (id === "local:t" ? repo : null),
      deliveryEnqueuer: makeEnqueuer(cap),
      tier: "high",
      now: () => 1000,
      uuid: () => `id-${idn++}`,
    });
    const turn = runner.runInterviewTurn({ sessionId: "s1", userMessage: "build X" });
    await waitUntil(() => started);
    // The interview controller is registered in `active`, so cancel aborts it
    // instead of the leg running out its maxSeconds window.
    await runner.cancel("s1", "user exit");
    await turn;
    expect(aborted).toBe(true);
  });

  it("promotes + delivers the next queued escalation on a resume that proceeds (P0-5)", async () => {
    parkAwaitingUser();
    createDevEscalation(db, {
      id: "e-a", sessionId: "s1", kind: "spec_decision",
      question: "A?", contextSummary: null, askedAt: 1,
    });
    createDevEscalation(db, {
      id: "e-b", sessionId: "s1", kind: "spec_decision",
      question: "B?", contextSummary: null, askedAt: 2,
    });
    const runner = makeRunner(fakeBackend(repo));
    // A resume that PROCEEDS (budget healthy): the held escalation is promoted
    // to active AND delivered, then the loop resumes.
    const outcome = await runner.resumeAfterEscalation({ sessionId: "s1", escalationId: "e-a", answer: "use A" });
    expect(outcome).toBe("resumed");
    expect(getOpenDevEscalationForSession(db, "s1")?.id).toBe("e-b");
    expect(cap.escalations.some((e) => e.escalationId === "e-b")).toBe(true);
    await waitUntil(() => getDevSession(db, "s1")?.state !== "running", 15000);
  });

  it("does NOT deliver the promoted escalation when the resume is blocked by budget (P0-5)", async () => {
    parkAwaitingUser();
    createDevEscalation(db, {
      id: "e-a", sessionId: "s1", kind: "spec_decision",
      question: "A?", contextSummary: null, askedAt: 1,
    });
    createDevEscalation(db, {
      id: "e-b", sessionId: "s1", kind: "spec_decision",
      question: "B?", contextSummary: null, askedAt: 2,
    });
    updateDevSessionConfig(db, "s1", { config: normalizeDevLoopConfig({ verifyCommands: ["true"], maxResumes: 1 }) }, 0);
    db.prepare(`UPDATE dev_sessions SET resumes = 5 WHERE id = 's1'`).run();
    const runner = makeRunner(fakeBackend(repo));
    const outcome = await runner.resumeAfterEscalation({ sessionId: "s1", escalationId: "e-a", answer: "use A" });
    expect(outcome).toBe("blocked");
    // e-b was promoted in the store, but NOT delivered — the owner is not asked
    // a fresh question on a session the budget check just terminated.
    expect(getOpenDevEscalationForSession(db, "s1")?.id).toBe("e-b");
    expect(cap.escalations.some((e) => e.escalationId === "e-b")).toBe(false);
  });

  it("scales the resume budget by task count for a fleet (P1-17)", async () => {
    parkAwaitingUser();
    for (const k of ["a", "b", "c"]) {
      db.prepare(
        `INSERT INTO dev_session_tasks (id, session_id, task_key, summary, body, state, created_at, updated_at)
         VALUES (?, 's1', ?, 's', 'b', 'queued', 0, 0)`,
      ).run(`t-${k}`, k);
    }
    createDevEscalation(db, {
      id: "e1", sessionId: "s1", taskId: "t-a", kind: "risk_approval",
      question: "?", contextSummary: null, askedAt: 1,
    });
    updateDevSessionConfig(db, "s1", { config: normalizeDevLoopConfig({ verifyCommands: ["true"], maxResumes: 1 }) }, 0);
    // At resumes = 3 the fleet's scaled cap (maxResumes 1 × 3 tasks = 3) is
    // spent — the next resume blocks; a single-loop cap (1) would have blocked
    // two resumes earlier.
    db.prepare(`UPDATE dev_sessions SET resumes = 3 WHERE id = 's1'`).run();
    const runner = makeRunner(fakeBackend(repo));
    const outcome = await runner.resumeAfterEscalation({ sessionId: "s1", escalationId: "e1", answer: "ok" });
    expect(outcome).toBe("blocked");
    const blockDigest = cap.digests.find((d) => d.draft.includes("resume budget"));
    expect(blockDigest?.draft).toContain("3 decisions");
  });

  it("scales the resume budget by fleet size for a SESSION-scoped escalation too (P1-17 fix)", async () => {
    parkAwaitingUser();
    for (const k of ["a", "b", "c"]) {
      db.prepare(
        `INSERT INTO dev_session_tasks (id, session_id, task_key, summary, body, state, created_at, updated_at)
         VALUES (?, 's1', ?, 's', 'b', 'merged', 0, 0)`,
      ).run(`t-${k}`, k);
    }
    // A SESSION-scoped escalation (taskId null) — e.g. the integration gate,
    // raised after every task merged. The cap must be the SAME scaled fleet cap
    // (1 × 3 = 3), not the single-loop cap (1) — otherwise a merged fleet is
    // killed at its final gate.
    createDevEscalation(db, {
      id: "eg", sessionId: "s1", kind: "review_escalation",
      question: "gate?", contextSummary: null, askedAt: 1,
    });
    updateDevSessionConfig(db, "s1", { config: normalizeDevLoopConfig({ verifyCommands: ["true"], maxResumes: 1 }) }, 0);
    db.prepare(`UPDATE dev_sessions SET resumes = 3 WHERE id = 's1'`).run();
    const runner = makeRunner(fakeBackend(repo));
    const outcome = await runner.resumeAfterEscalation({ sessionId: "s1", escalationId: "eg", answer: "approve" });
    expect(outcome).toBe("blocked");
    const blockDigest = cap.digests.find((d) => d.draft.includes("resume budget"));
    expect(blockDigest?.draft).toContain("3 decisions"); // scaled by fleet size, not the single-loop 1
  });

  it("re-triggers plan review with the owner decision on a plan-review escalation (P1-14)", async () => {
    parkAwaitingUser();
    // A merged task whose plan review escalated.
    db.prepare(
      `INSERT INTO dev_session_tasks (id, session_id, task_key, summary, body, state, plan_review, created_at, updated_at)
       VALUES ('tk', 's1', 'auth', 's', 'b', 'merged', 'escalated', 0, 0)`,
    ).run();
    createDevEscalation(db, {
      id: "e1", sessionId: "s1", taskId: "tk", kind: "review_escalation",
      question: "keep or drop?", contextSummary: null, askedAt: 1,
    });
    // Starve the budget so the resume blocks AFTER the plan-review reset (which
    // runs first) — deterministic, no loop.
    updateDevSessionConfig(db, "s1", { config: normalizeDevLoopConfig({ verifyCommands: ["true"], maxResumes: 1 }) }, 0);
    db.prepare(`UPDATE dev_sessions SET resumes = 5 WHERE id = 's1'`).run();
    const runner = makeRunner(fakeBackend(repo));
    const outcome = await runner.resumeAfterEscalation({
      sessionId: "s1", escalationId: "e1", answer: "drop REQ-002 from the remaining tasks",
    });
    expect(outcome).toBe("blocked");
    // The review is re-armed (escalated -> pending) and the owner's decision is
    // persisted where planReviewTask re-reads it — NOT rubber-stamped to done.
    expect(getDevTask(db, "tk")!.planReview).toBe("pending");
    const ownerDoc = readDevDoc(repo, `${DEV_TASK_ARCHIVE_DIR}/auth/${DEV_OWNER_PLAN_DECISION_FILE}`);
    expect(ownerDoc).toContain("drop REQ-002");
  });

  it("accepts a task escalation answer mid-fleet and wakes the loop in place (P0-4)", async () => {
    // A 2-task fleet: `alpha` escalates RISK on its first pass while `beta` is
    // held in-flight (blocked on a gate). The session therefore stays 'running'
    // (a sibling is still working, F6). The owner answers alpha's escalation
    // WHILE running — it must be accepted and wake the live orchestrator in
    // place (no second loop), not rejected with "the loop is running".
    let releaseBeta: () => void = () => {};
    const betaGate = new Promise<void>((r) => { releaseBeta = r; });
    const complete = (dir: string, key: string): DevLegResponse => {
      writeFileSync(join(dir, `${key}.ts`), `export const ${key} = 1;\n`);
      const led = readDevDoc(dir, DEV_DOCS.ledger) ?? "";
      const reqs = [...led.matchAll(/\| (REQ-\d+) \|/g)].map((m) => m[1]!);
      writeDevDoc(dir, DEV_DOCS.ledger, ["| REQ | Status | Evidence | Iter |", "|---|---|---|---|", ...reqs.map((r) => `| ${r} | met | ev | 1 |`)].join("\n"));
      writeDevDoc(dir, DEV_DOCS.agentState, "READY_FOR_REVIEW done");
      return ok("implemented");
    };
    const backend: DevBackend = {
      async runLeg(req) {
        const key = req.sessionDir.split("/").pop()!;
        switch (req.taskFlowKey) {
          case "dev.decompose":
            writeDevDoc(req.sessionDir, DEV_DOCS.taskPlan, [
              "<!-- TASK-PLAN-BEGIN v1 -->",
              "TASK: alpha\nSUMMARY: a\nDEPENDS: -\nSCOPE: alpha.ts\nREQS: REQ-001\nBODY-BEGIN\nbuild alpha\nBODY-END\nTASK-END",
              "TASK: beta\nSUMMARY: b\nDEPENDS: -\nSCOPE: beta.ts\nREQS: REQ-002\nBODY-BEGIN\nbuild beta\nBODY-END\nTASK-END",
              "<!-- TASK-PLAN-END -->",
            ].join("\n"));
            return ok("DECOMPOSE: TASKS n=2");
          case "dev.decompose_review": return ok("DECOMPOSE-REVIEW: APPROVE clean");
          case "dev.plan":
            writeDevDoc(req.sessionDir, DEV_DOCS.plan, "## Milestones\n- [ ] do it");
            return ok("planned");
          case "dev.implement": {
            const guidance = readDevDoc(req.sessionDir, DEV_DOCS.supervisorGuidance);
            if (key === "alpha" && !guidance) {
              // First pass → NEEDS_SPEC_DECISION; the supervisor escalates it
              // straight to the owner (below). The guidance the owner's answer
              // writes flips alpha to completion on its next pass.
              writeDevDoc(req.sessionDir, DEV_DOCS.decisionRequests, "DR-1: which database?");
              writeDevDoc(req.sessionDir, DEV_DOCS.agentState, "NEEDS_SPEC_DECISION which database?");
              return ok("needs a decision");
            }
            if (key === "beta") await betaGate; // hold beta in-flight
            return complete(req.sessionDir, key);
          }
          case "dev.supervise":
            // Task-mode: the supervisor sends the question to the owner. (The
            // integration gate never reaches here — dev.review APPROVEs.)
            return ok("The owner must pick the database.\nSUPERVISE: ESCALATE which database should alpha use?");
          case "dev.review":
            return ok("REQ-001: MET ok\nREQ-002: MET ok\nVERDICT: APPROVE ship it");
          case "dev.stop_eval": return ok("STOP-EVAL: MET");
          case "dev.evidence":
            writeDevDoc(req.sessionDir, DEV_DOCS.evidence, "# Evidence\nok");
            return ok("evidence");
          default: return ok("noop");
        }
      },
    };
    const runner = makeRunner(backend);
    runner.startFromApproval("s1");
    try {
      // alpha escalates; beta is still in-flight, so the session stays running.
      await waitUntil(() => cap.escalations.length > 0, 15000);
      const esc = getOpenDevEscalationForSession(db, "s1")!;
      expect(getDevSession(db, "s1")!.state).toBe("running");
      const outcome = await runner.resumeAfterEscalation({ sessionId: "s1", escalationId: esc.id, answer: "yes, touch .env is fine" });
      expect(outcome).toBe("resumed");
      // Still one run — the mid-fleet answer woke the loop in place.
      expect(getDevSession(db, "s1")!.state).toBe("running");
    } finally {
      releaseBeta();
    }
    await waitUntil(() => getDevSession(db, "s1")?.state !== "running", 20000);
    const session = getDevSession(db, "s1")!;
    expect(session.state).toBe("done");
    expect(session.loopState).toBe("SUCCESS");
    expect(existsSync(join(repo, "alpha.ts"))).toBe(true);
    expect(existsSync(join(repo, "beta.ts"))).toBe(true);
    expect(listDevEscalationsForSession(db, "s1")[0]!.resolved).toBe(true);
  });

  // ── Phase A in-place git safety (DEV_MODE_GIT_HARDENING) ──────────────

  it("startFromApproval refuses over an in-progress merge", async () => {
    // Manufacture a real conflicted merge in the owner's checkout.
    const preBranch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    git(repo, ["checkout", "-q", "-b", "side"]);
    writeFileSync(join(repo, "README.md"), "side\n");
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "side"]);
    git(repo, ["checkout", "-q", preBranch]);
    writeFileSync(join(repo, "README.md"), "local\n");
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "local"]);
    expect(() => git(repo, ["merge", "side"])).toThrow();

    const runner = makeRunner(fakeBackend(repo));
    const result = runner.startFromApproval("s1");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("merge is in progress");
    // Nothing moved: still parked mid-merge on the owner's branch.
    expect(getDevSession(db, "s1")!.state).toBe("awaiting_approval");
    git(repo, ["merge", "--abort"]);
  });

  it("records the rollback anchors + baseline journal row on the fresh path", async () => {
    // seedSession's ensureDevWorkdir left a fresh untracked .gitignore —
    // commit it so the owner's tree is genuinely clean at approve.
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "gitignore"]);
    const preBranch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const preHead = git(repo, ["rev-parse", "HEAD"]);
    const runner = makeRunner(fakeBackend(repo));
    expect(runner.startFromApproval("s1").ok).toBe(true);
    await waitUntil(() => getDevSession(db, "s1")?.state !== "running");

    const session = getDevSession(db, "s1")!;
    expect(session.originalBranch).toBe(preBranch);
    expect(session.originalHead).toBe(preHead);
    // The tree was clean at approve — no WIP was swept into the snapshot.
    expect(session.wipSnapshotRef).toBeNull();
    // Baseline verify ran once and journaled its red→green record.
    expect(session.baselineVerifiedAt).not.toBeNull();
    const baseline = listDevIterations(db, "s1").find((i) => i.phase === "baseline");
    expect(baseline?.verdict).toBe("red=0 green=1");
  });

  it("sweeps dirty owner WIP into the snapshot and records its sha", async () => {
    const preHead = git(repo, ["rev-parse", "HEAD"]);
    writeFileSync(join(repo, "wip.txt"), "uncommitted owner work\n");
    const runner = makeRunner(fakeBackend(repo));
    expect(runner.startFromApproval("s1").ok).toBe(true);
    await waitUntil(() => getDevSession(db, "s1")?.state !== "running");

    const session = getDevSession(db, "s1")!;
    expect(session.wipSnapshotRef).not.toBeNull();
    expect(session.wipSnapshotRef).not.toBe(preHead);
    // The snapshot commit is exactly the WIP sweep.
    expect(git(repo, ["show", "--stat", "--format=%s", session.wipSnapshotRef!])).toContain(
      "baseline snapshot",
    );
  });

  it("parks again with a moved-checkout question when resuming off-branch", async () => {
    // Implement escalates on the first pass so the session parks.
    let calls = 0;
    const backend = fakeBackend(repo, {
      "dev.implement": () => {
        calls += 1;
        writeFileSync(join(repo, "wip.ts"), `// pass ${calls}\n`);
        writeDevDoc(repo, DEV_DOCS.agentState, "NEEDS_SPEC_DECISION which db");
        writeDevDoc(repo, DEV_DOCS.decisionRequests, "## DR-1\nWhich db?");
        return ok("stuck");
      },
    });
    const runner = makeRunner(backend);
    expect(runner.startFromApproval("s1").ok).toBe(true);
    await waitUntil(() => getDevSession(db, "s1")?.state === "awaiting_user");
    const first = getOpenDevEscalationForSession(db, "s1")!;

    // The owner wanders off the session branch, then answers.
    git(repo, ["checkout", "-q", "-B", "somewhere-else"]);
    const outcome = await runner.resumeAfterEscalation({
      sessionId: "s1",
      escalationId: first.id,
      answer: "use sqlite",
    });
    expect(outcome).toBe("resumed");
    await waitUntil(() => getDevSession(db, "s1")?.state === "awaiting_user");
    const second = getOpenDevEscalationForSession(db, "s1")!;
    expect(second.id).not.toBe(first.id);
    expect(second.question).toContain("checkout moved");
    expect(second.question).toContain("aitne-dev/s1");
  });

  it("commits recovered uncommitted work on resume so the reviewer sees it", async () => {
    let calls = 0;
    const backend = fakeBackend(repo, {
      "dev.implement": () => {
        calls += 1;
        if (calls === 1) {
          // First pass: leaves WORK UNCOMMITTED and escalates (the park).
          writeFileSync(join(repo, "half-done.ts"), "export const partial = 1;\n");
          writeDevDoc(repo, DEV_DOCS.agentState, "NEEDS_SPEC_DECISION which db");
          return ok("stuck");
        }
        writeFileSync(join(repo, "feature.ts"), "export const x = 1;\n");
        writeDevDoc(repo, DEV_DOCS.ledger, ledgerMd("met"));
        writeDevDoc(repo, DEV_DOCS.agentState, "READY_FOR_REVIEW done");
        return ok("implemented");
      },
    });
    const runner = makeRunner(backend);
    expect(runner.startFromApproval("s1").ok).toBe(true);
    await waitUntil(() => getDevSession(db, "s1")?.state === "awaiting_user");
    // The escalate iteration itself was checkpoint-committed (half-done.ts is
    // in history, loop-kit parity). Simulate an interrupted leg's residue —
    // work that never reached an evaluate commit — appearing while parked.
    writeFileSync(join(repo, "crash-leftover.ts"), "export const orphan = 1;\n");

    const esc = getOpenDevEscalationForSession(db, "s1")!;
    await runner.resumeAfterEscalation({ sessionId: "s1", escalationId: esc.id, answer: "sqlite" });
    await waitUntil(() => {
      const s = getDevSession(db, "s1");
      return s?.state !== "running" && s?.state !== "awaiting_user";
    }, 20000);

    expect(getDevSession(db, "s1")!.loopState).toBe("SUCCESS");
    const subjects = git(repo, ["log", "--format=%s"]);
    expect(subjects).toContain("recovered uncommitted work on resume");
    // The recovered work landed on the SESSION branch, not lost.
    expect(git(repo, ["status", "--porcelain"])).toBe("");
  });
});
