import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { createDevFlowLegRunner, type DevFlowLegContext } from "./dev-flow-legs.js";
import type { DevBackend, DevBackendRequest } from "./dev-loop-legs.js";
import type { DevLegResponse } from "./dev-loop-engine.js";
import { normalizeDevLoopConfig } from "./dev-loop-config.js";
import { ensureDevWorkdir, writeDevDoc, DEV_DOCS } from "./dev-loop-docs.js";
import type { DevSessionRow } from "../../db/dev-sessions-store.js";

const repoPath = mkdtempSync(join(tmpdir(), "dev-flow-legs-"));
ensureDevWorkdir(repoPath);
writeDevDoc(repoPath, DEV_DOCS.contract, "# Product Contract\n### REQ-001: thing");
writeDevDoc(repoPath, DEV_DOCS.loopConfig, '{"verifyCommands":["npm test"]}');
writeDevDoc(repoPath, DEV_DOCS.taskPlan, "plan body");

afterAll(() => rmSync(repoPath, { recursive: true, force: true }));

function response(text: string, isError = false): DevLegResponse {
  return { text, sessionId: "sdk-1", costUsd: 0.01, numTurns: 2, isError };
}

/** A backend that replies with the scripted texts in order. */
function fakeBackend(replies: readonly DevLegResponse[]): DevBackend & {
  calls: DevBackendRequest[];
} {
  const calls: DevBackendRequest[] = [];
  let i = 0;
  return {
    calls,
    runLeg: vi.fn(async (req: DevBackendRequest) => {
      calls.push(req);
      const r = replies[Math.min(i, replies.length - 1)]!;
      i++;
      return r;
    }),
  };
}

function ctx(): DevFlowLegContext {
  return {
    session: { slug: "my-repo", repositoryId: "r1" } as DevSessionRow,
    repoPath,
    config: normalizeDevLoopConfig({ verifyCommands: ["npm test"] }),
    tier: "high",
  };
}

describe("createDevFlowLegRunner", () => {
  it("decompose: parses n, scopes writes to .aitne-dev, injects the contract", async () => {
    const backend = fakeBackend([response("rationale…\nDECOMPOSE: TASKS n=3")]);
    const runner = createDevFlowLegRunner({ backend, loadTaskFlow: (k) => `PROMPT:${k}` });
    const out = await runner.decompose(ctx());
    expect(out.n).toBe(3);
    expect(out.responses).toHaveLength(1);
    const req = backend.calls[0]!;
    expect(req.taskFlowKey).toBe("dev.decompose");
    expect(req.allowedTools).toContain("Write(.aitne-dev/**)");
    expect(req.allowedTools).not.toContain("Write");
    expect(req.readOnly).toBe(false);
    expect(req.context).toContain("Product contract");
    expect(req.context).toContain("REQ-001");
    expect(req.sessionDir).toBe(repoPath);
  });

  it("decompose: retries ONCE with a format reminder, then gives up (n null)", async () => {
    const backend = fakeBackend([response("no verdict"), response("still none")]);
    const runner = createDevFlowLegRunner({ backend, loadTaskFlow: () => "P" });
    const out = await runner.decompose(ctx());
    expect(out.n).toBeNull();
    expect(out.responses).toHaveLength(2);
    expect(backend.calls[1]!.context).toContain("FORMAT REMINDER");
    // An isError first attempt also triggers the retry.
    const backend2 = fakeBackend([
      response("irrelevant", true),
      response("DECOMPOSE: TASKS n=1"),
    ]);
    const runner2 = createDevFlowLegRunner({ backend: backend2, loadTaskFlow: () => "P" });
    const out2 = await runner2.decompose(ctx());
    expect(out2.n).toBe(1);
    expect(out2.responses).toHaveLength(2);
  });

  it("decomposeReview: read-only leg with the plan injected, verdict parsed", async () => {
    const backend = fakeBackend([response("looks good\nDECOMPOSE-REVIEW: APPROVE tight scopes")]);
    const runner = createDevFlowLegRunner({ backend, loadTaskFlow: () => "P" });
    const out = await runner.decomposeReview(ctx());
    expect(out.verdict).toBe("APPROVE");
    expect(out.detail).toBe("tight scopes");
    const req = backend.calls[0]!;
    expect(req.taskFlowKey).toBe("dev.decompose_review");
    expect(req.readOnly).toBe(true);
    expect(req.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect(req.context).toContain("plan body");
  });

  it("supervise task mode: stages worker files, extracts guidance/replan blocks", async () => {
    const reply = [
      "analysis",
      "GUIDANCE-BEGIN",
      "use the helper",
      "GUIDANCE-END",
      "SUPERVISE: ANSWER use the helper",
    ].join("\n");
    const backend = fakeBackend([response(reply)]);
    const runner = createDevFlowLegRunner({ backend, loadTaskFlow: () => "P" });
    const out = await runner.supervise(ctx(), {
      mode: "task",
      staged: {
        queueSnapshot: "| a | queued |",
        taskPlan: "original plan",
        task: {
          taskKey: "big-task",
          loopState: "NEEDS_SPEC_DECISION",
          taskInstruction: "do the thing",
          decisionRequests: "DR-1: which helper?",
          progress: "iter 1 done",
          lastVerify: "[PASS]",
          agentState: "NEEDS_SPEC_DECISION which helper",
          assumptions: null,
        },
      },
    });
    expect(out.verdict).toBe("ANSWER");
    expect(out.guidance).toBe("use the helper");
    expect(out.replanBlock).toBeNull();
    const req = backend.calls[0]!;
    expect(req.taskFlowKey).toBe("dev.supervise");
    expect(req.readOnly).toBe(true);
    expect(req.context).toContain("## Decision mode\ntask");
    expect(req.context).toContain("big-task — declared NEEDS_SPEC_DECISION");
    expect(req.context).toContain("DR-1: which helper?");
    expect(req.context).toContain("| a | queued |");
  });

  it("supervise: unparseable twice → null verdict (caller fails closed)", async () => {
    const backend = fakeBackend([response("shrug"), response("still shrug")]);
    const runner = createDevFlowLegRunner({ backend, loadTaskFlow: () => "P" });
    const out = await runner.supervise(ctx(), {
      mode: "integration",
      staged: {
        queueSnapshot: "(empty)",
        taskPlan: null,
        integration: { reviewFeedback: "1. fix X", changedFiles: "src/a.ts" },
      },
    });
    expect(out.verdict).toBeNull();
    expect(backend.calls[1]!.context).toContain("FORMAT REMINDER");
    expect(backend.calls[0]!.context).toContain("1. fix X");
    expect(backend.calls[0]!.context).toContain("src/a.ts");
  });

  it("planReview: reuses the supervise flow with plan-review staging", async () => {
    const reply = [
      "REPLAN-BEGIN",
      "TASK: n1",
      "REPLAN-END",
      "PLAN-REVIEW: REVISE swap phase 2",
    ].join("\n");
    const backend = fakeBackend([response(reply)]);
    const runner = createDevFlowLegRunner({ backend, loadTaskFlow: () => "P" });
    const out = await runner.planReview(ctx(), {
      queueSnapshot: "| p2 | queued |",
      taskPlan: "original plan",
      mergedTaskKey: "p1",
      mergedTaskInstruction: "phase 1 body",
      mergedEvidence: "evidence md",
    });
    expect(out.verdict).toBe("REVISE");
    expect(out.detail).toBe("swap phase 2");
    expect(out.replanBlock).toContain("TASK: n1");
    const req = backend.calls[0]!;
    expect(req.taskFlowKey).toBe("dev.supervise");
    expect(req.context).toContain("## Decision mode\nplan-review");
    expect(req.context).toContain("## Merged phase\np1");
    expect(req.context).toContain("evidence md");
  });
});
