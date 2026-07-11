import { describe, it, expect, vi } from "vitest";
import {
  EMPTY_BOOKKEEPING,
  checkAcceptanceChecklist,
  detectOscillation,
  evaluateIteration,
  fingerprintFailure,
  globToRegExp,
  matchesAnyGlob,
  type DevEvaluateBookkeeping,
  type DevEvaluateDeps,
  type DevEvaluateInput,
} from "./dev-loop-evaluate.js";
import { normalizeDevLoopConfig } from "./dev-loop-config.js";
import type { DevChecklistRow } from "./dev-checklist.js";
import type { DevLoopConfig } from "./types.js";

const CONFIG: DevLoopConfig = normalizeDevLoopConfig({
  verifyCommands: ["npm test"],
});

function deps(opts: {
  changed?: string[];
  verifyExit?: number;
  verifyOutput?: string;
} = {}): DevEvaluateDeps & { diffPaths: ReturnType<typeof vi.fn>; runVerify: ReturnType<typeof vi.fn> } {
  const changed = opts.changed ?? ["src/a.ts"];
  return {
    diffPaths: vi.fn(() => changed),
    runVerify: vi.fn(() => ({
      exitCode: opts.verifyExit ?? 0,
      output: opts.verifyOutput ?? "ok",
    })),
  };
}

function input(overrides: Partial<DevEvaluateInput> = {}): DevEvaluateInput {
  return {
    config: CONFIG,
    preRef: "HEAD~1",
    approvedHash: "anchor",
    currentApprovedHash: "anchor",
    agentStateToken: null,
    allRequirementsMet: false,
    final: false,
    assumeReady: false,
    wholeRunDiffEmpty: false,
    fleetWorker: false,
    bookkeeping: EMPTY_BOOKKEEPING,
    ...overrides,
  };
}

describe("glob helpers", () => {
  it("globToRegExp: ** collapses to *, * crosses /", () => {
    expect(globToRegExp("secrets/**").test("secrets/a/b/c")).toBe(true);
    expect(globToRegExp(".env*").test(".env")).toBe(true);
    expect(globToRegExp(".env*").test(".env.local")).toBe(true);
    expect(globToRegExp(".env*").test("src/.env")).toBe(false);
  });
  it("matchesAnyGlob returns the matched glob or null", () => {
    expect(matchesAnyGlob(".env.local", [".env*"])).toBe(".env*");
    expect(matchesAnyGlob("src/a.ts", [".env*", "secrets/**"])).toBeNull();
  });
});

describe("fingerprintFailure", () => {
  it("normalizes VOLATILE numerics (hex, durations, clock, pid, port, long runs)", () => {
    // Same structural failure, differing only by volatile noise — must match.
    const fp1 = fingerprintFailure([
      { command: "npm test", exitCode: 1, passed: false, output: "boom (0xAB) in 2.3 s at 12:04:55 pid 483921 conn 10.0.0.1:8080 line src/a.ts:42" },
    ]);
    const fp2 = fingerprintFailure([
      { command: "npm test", exitCode: 1, passed: false, output: "boom (0xFF) in 4.1 s at 09:15:02 pid 512044 conn 10.0.0.1:9090 line src/a.ts:99" },
    ]);
    expect(fp1).toBe(fp2);
  });
  it("normalizes a long digit run glued to a unit suffix (no \\b gap)", () => {
    const fp1 = fingerprintFailure([{ command: "t", exitCode: 1, passed: false, output: "took 123456ms" }]);
    const fp2 = fingerprintFailure([{ command: "t", exitCode: 1, passed: false, output: "took 999999ms" }]);
    expect(fp1).toBe(fp2);
  });
  it("PRESERVES small counts so incremental test progress is NOT read as a repeat", () => {
    // "3 failed" → "2 failed" is real forward progress and must NOT collapse to
    // the same fingerprint (that would trip REPEAT_FAIL_N → premature BLOCKED).
    const fp1 = fingerprintFailure([
      { command: "npm test", exitCode: 1, passed: false, output: "Tests: 3 failed, 45 passed" },
    ]);
    const fp2 = fingerprintFailure([
      { command: "npm test", exitCode: 1, passed: false, output: "Tests: 2 failed, 46 passed" },
    ]);
    expect(fp1).not.toBe(fp2);
  });
  it("ignores passed commands", () => {
    expect(
      fingerprintFailure([{ command: "x", exitCode: 0, passed: true, output: "ok" }]),
    ).toBe("");
  });
});

describe("evaluateIteration — decision order", () => {
  it("1. hash mismatch → NEEDS_SPEC_DECISION without touching git/verify", () => {
    const d = deps();
    const out = evaluateIteration(
      input({ currentApprovedHash: "changed" }),
      d,
    );
    expect(out.result.state).toBe("NEEDS_SPEC_DECISION");
    expect(d.diffPaths).not.toHaveBeenCalled();
    expect(out.bookkeeping).toBe(EMPTY_BOOKKEEPING);
  });

  it("2. denied path → RISK_REQUIRES_APPROVAL before verify", () => {
    const d = deps({ changed: [".env.local"] });
    const out = evaluateIteration(input(), d);
    expect(out.result.state).toBe("RISK_REQUIRES_APPROVAL");
    expect(out.result.reason).toMatch(/\.env\*/);
    expect(d.runVerify).not.toHaveBeenCalled();
  });

  it("3. escalate path → NEEDS_ARCHITECTURE_DECISION", () => {
    const cfg = normalizeDevLoopConfig({
      verifyCommands: ["npm test"],
      escalatePaths: ["package.json"],
    });
    const out = evaluateIteration(
      input({ config: cfg }),
      deps({ changed: ["package.json"] }),
    );
    expect(out.result.state).toBe("NEEDS_ARCHITECTURE_DECISION");
  });

  it("4. empty verifyCommands → NEEDS_SPEC_DECISION (fail-closed)", () => {
    const cfg = { ...CONFIG, verifyCommands: [] as string[] };
    const out = evaluateIteration(input({ config: cfg }), deps());
    expect(out.result.state).toBe("NEEDS_SPEC_DECISION");
    expect(out.result.reason).toMatch(/vacuous/);
  });

  it("5. agent-declared BLOCKED is honored (with verify attached)", () => {
    const out = evaluateIteration(
      input({ agentStateToken: "BLOCKED" }),
      deps(),
    );
    expect(out.result.state).toBe("BLOCKED");
    expect(out.result.verify).toHaveLength(1);
  });

  it("5. agent-declared NEEDS_ARCHITECTURE_DECISION is honored", () => {
    const out = evaluateIteration(
      input({ agentStateToken: "NEEDS_ARCHITECTURE_DECISION" }),
      deps(),
    );
    expect(out.result.state).toBe("NEEDS_ARCHITECTURE_DECISION");
  });

  it("6.5 verify-green + ready but unmet REQ → CONTINUE (refuse gate)", () => {
    const out = evaluateIteration(
      input({ agentStateToken: "READY_FOR_REVIEW", allRequirementsMet: false }),
      deps(),
    );
    expect(out.result.state).toBe("CONTINUE");
    expect(out.result.reason).toMatch(/requirements ledger/);
  });

  it("7. verify-green + ready + all met → SUCCESS_CANDIDATE (non-final)", () => {
    const out = evaluateIteration(
      input({ agentStateToken: "READY_FOR_REVIEW", allRequirementsMet: true }),
      deps(),
    );
    expect(out.result.state).toBe("SUCCESS_CANDIDATE");
  });

  it("7. forced gate: assumeReady without an agent-ready token → SUCCESS_CANDIDATE", () => {
    const out = evaluateIteration(input({ assumeReady: true }), deps());
    expect(out.result.state).toBe("SUCCESS_CANDIDATE");
  });

  it("7. final + ready + non-empty diff → SUCCESS", () => {
    const out = evaluateIteration(
      input({ agentStateToken: "READY_FOR_REVIEW", allRequirementsMet: true, final: true }),
      deps(),
    );
    expect(out.result.state).toBe("SUCCESS");
  });

  it("7. final + ready + empty whole-run diff → NO_OP", () => {
    const out = evaluateIteration(
      input({
        agentStateToken: "READY_FOR_REVIEW",
        allRequirementsMet: true,
        final: true,
        wholeRunDiffEmpty: true,
      }),
      deps(),
    );
    expect(out.result.state).toBe("NO_OP");
  });

  it("final + not-ready → BLOCKED (verify green)", () => {
    const out = evaluateIteration(input({ final: true }), deps());
    expect(out.result.state).toBe("BLOCKED");
    expect(out.result.reason).toMatch(/not ready/);
  });

  it("final + verify failing → BLOCKED (verify failing)", () => {
    const out = evaluateIteration(
      input({ final: true, assumeReady: true }),
      deps({ verifyExit: 1 }),
    );
    expect(out.result.state).toBe("BLOCKED");
    expect(out.result.reason).toMatch(/failing/);
  });

  it("8. no changes → stagnation increments, CONTINUE below threshold", () => {
    const out = evaluateIteration(
      input({ bookkeeping: { stagnationCount: 0, failFingerprints: [] } }),
      deps({ changed: [] }),
    );
    expect(out.result.state).toBe("CONTINUE");
    expect(out.bookkeeping.stagnationCount).toBe(1);
  });

  it("8. no changes reaching stagnationN → STALLED", () => {
    const out = evaluateIteration(
      input({ bookkeeping: { stagnationCount: 1, failFingerprints: [] } }),
      deps({ changed: [] }),
    );
    expect(out.result.state).toBe("STALLED");
    expect(out.bookkeeping.stagnationCount).toBe(2);
  });

  it("8. stagnationN=0 disables STALLED (still increments)", () => {
    const cfg = normalizeDevLoopConfig({ verifyCommands: ["npm test"], stagnationN: 0 });
    const out = evaluateIteration(
      input({ config: cfg, bookkeeping: { stagnationCount: 5, failFingerprints: [] } }),
      deps({ changed: [] }),
    );
    expect(out.result.state).toBe("CONTINUE");
    expect(out.bookkeeping.stagnationCount).toBe(6);
  });

  it("8. repeated identical failure reaching repeatFailN → BLOCKED", () => {
    const cfg = normalizeDevLoopConfig({ verifyCommands: ["npm test"], repeatFailN: 2 });
    const priorFp = fingerprintFailure([
      { command: "npm test", exitCode: 1, passed: false, output: "boom" },
    ]);
    const out = evaluateIteration(
      input({ config: cfg, bookkeeping: { stagnationCount: 0, failFingerprints: [priorFp] } }),
      deps({ changed: ["src/a.ts"], verifyExit: 1, verifyOutput: "boom" }),
    );
    expect(out.result.state).toBe("BLOCKED");
    expect(out.result.reason).toMatch(/recurred/);
  });

  it("8. a different failure does not trip repeat-fail (break branch)", () => {
    const cfg = normalizeDevLoopConfig({ verifyCommands: ["npm test"], repeatFailN: 2 });
    const out = evaluateIteration(
      input({ config: cfg, bookkeeping: { stagnationCount: 0, failFingerprints: ["other"] } }),
      deps({ changed: ["src/a.ts"], verifyExit: 1, verifyOutput: "boom" }),
    );
    expect(out.result.state).toBe("CONTINUE");
    expect(out.bookkeeping.failFingerprints).toHaveLength(2);
    expect(out.bookkeeping.stagnationCount).toBe(0);
  });

  it("8. repeatFailN=0 disables the repeat-fail block", () => {
    const cfg = normalizeDevLoopConfig({ verifyCommands: ["npm test"], repeatFailN: 0 });
    const fp = fingerprintFailure([
      { command: "npm test", exitCode: 1, passed: false, output: "boom" },
    ]);
    const out = evaluateIteration(
      input({ config: cfg, bookkeeping: { stagnationCount: 0, failFingerprints: [fp, fp, fp] } }),
      deps({ changed: ["src/a.ts"], verifyExit: 1, verifyOutput: "boom" }),
    );
    expect(out.result.state).toBe("CONTINUE");
  });

  it("8. a green verify with changes clears the failure streak", () => {
    const out = evaluateIteration(
      input({ bookkeeping: { stagnationCount: 2, failFingerprints: ["x", "y"] } }),
      deps({ changed: ["src/a.ts"], verifyExit: 0 }),
    );
    expect(out.result.state).toBe("CONTINUE");
    expect(out.bookkeeping.failFingerprints).toEqual([]);
    expect(out.bookkeeping.stagnationCount).toBe(0);
  });

  it("caps verify output length", () => {
    const out = evaluateIteration(
      input({ agentStateToken: "BLOCKED" }),
      deps({ verifyOutput: "x".repeat(5000) }),
    );
    expect(out.result.verify?.[0]?.output.length).toBe(4000);
  });
});

describe("NEEDS_DECOMPOSITION (fleet-only token)", () => {
  it("is honored for fleet workers", () => {
    const out = evaluateIteration(
      input({ agentStateToken: "NEEDS_DECOMPOSITION", fleetWorker: true }),
      deps(),
    );
    expect(out.result.state).toBe("NEEDS_DECOMPOSITION");
    expect(out.result.reason).toMatch(/declared NEEDS_DECOMPOSITION/);
  });

  it("is ignored in the single loop (falls through to bookkeeping)", () => {
    const out = evaluateIteration(
      input({ agentStateToken: "NEEDS_DECOMPOSITION", fleetWorker: false }),
      deps(),
    );
    expect(out.result.state).toBe("CONTINUE");
  });

  it("does not weaken the other fleet-worker escalation tokens", () => {
    const out = evaluateIteration(
      input({ agentStateToken: "BLOCKED", fleetWorker: true }),
      deps(),
    );
    expect(out.result.state).toBe("BLOCKED");
  });
});

// ── §6.6 acceptance checklist (DEV_MODE_GIT_HARDENING Phase B) ───────────

function acRow(
  acId: string,
  overrides: Partial<DevChecklistRow> = {},
): DevChecklistRow {
  return {
    acId,
    reqId: "REQ-001",
    expectation: "it observably works",
    method: "cmd",
    status: "verified",
    evidence: "npm test",
    ...overrides,
  };
}

describe("checkAcceptanceChecklist (§6.6)", () => {
  it("passes when not in use, or when every row is verified", () => {
    expect(
      checkAcceptanceChecklist({ rows: null, contractAnchors: [], seenAcIds: [] }),
    ).toBeNull();
    expect(
      checkAcceptanceChecklist({
        rows: [acRow("AC-001"), acRow("AC-002", { method: "run" })],
        contractAnchors: [
          { acId: "AC-001", method: "cmd" },
          // A method-less anchor (older contract) imposes no method constraint.
          { acId: "AC-002", method: null },
        ],
        seenAcIds: ["AC-001", "AC-002"],
      }),
    ).toBeNull();
    // An empty rows array (file exists, no rows yet) imposes nothing.
    expect(
      checkAcceptanceChecklist({ rows: [], contractAnchors: [], seenAcIds: [] }),
    ).toBeNull();
  });

  it("(a) refuses on any unverified non-human row", () => {
    const out = checkAcceptanceChecklist({
      rows: [acRow("AC-001", { status: "pending" }), acRow("AC-002", { status: "unknown" })],
      contractAnchors: [],
      seenAcIds: [],
    });
    expect(out).toMatchObject({ kind: "refuse" });
    if (out?.kind === "refuse") {
      expect(out.reason).toContain("AC-001(pending)");
      expect(out.reason).toContain("AC-002(unknown)");
    }
  });

  it("(a) human-only unverified rows become the human_verify signal", () => {
    const out = checkAcceptanceChecklist({
      rows: [acRow("AC-001"), acRow("AC-002", { method: "human", status: "pending" })],
      contractAnchors: [{ acId: "AC-002", method: "human" }],
      seenAcIds: ["AC-001", "AC-002"],
    });
    expect(out).toEqual({
      kind: "human_verify",
      acIds: ["AC-002"],
      reason: expect.stringContaining("AC-002"),
    });
  });

  it("(b) contract anchors need a row — even when the file is absent", () => {
    const noFile = checkAcceptanceChecklist({
      rows: null,
      contractAnchors: [{ acId: "AC-001", method: null }],
      seenAcIds: [],
    });
    expect(noFile).toMatchObject({ kind: "refuse", reason: expect.stringContaining("AC-001") });
    const missingRow = checkAcceptanceChecklist({
      rows: [acRow("AC-001")],
      contractAnchors: [{ acId: "AC-001", method: null }, { acId: "AC-002", method: null }],
      seenAcIds: ["AC-001"],
    });
    expect(missingRow).toMatchObject({ kind: "refuse", reason: expect.stringContaining("AC-002") });
  });

  it("(c) vanished previously-seen ids refuse (monotonicity)", () => {
    const out = checkAcceptanceChecklist({
      rows: [acRow("AC-001")],
      contractAnchors: [],
      seenAcIds: ["AC-001", "AC-002"],
    });
    expect(out).toMatchObject({ kind: "refuse", reason: expect.stringContaining("AC-002") });
    // A deleted FILE with history is the same defect.
    const gone = checkAcceptanceChecklist({
      rows: null,
      contractAnchors: [],
      seenAcIds: ["AC-001"],
    });
    expect(gone).toMatchObject({ kind: "refuse", reason: expect.stringContaining("disappeared") });
  });

  it("(d) a contract (run) anchor cannot be closed by a cmd row", () => {
    const out = checkAcceptanceChecklist({
      rows: [acRow("AC-001", { method: "cmd" })],
      contractAnchors: [{ acId: "AC-001", method: "run" }],
      seenAcIds: ["AC-001"],
    });
    expect(out).toMatchObject({
      kind: "refuse",
      reason: expect.stringContaining("AC-001(contract:run)"),
    });
  });
});

describe("detectOscillation", () => {
  it("fires on ≤2 distinct fingerprints over a full 2×N window", () => {
    expect(detectOscillation(["a", "b", "a", "b", "a", "b"], 3)).toEqual({ distinct: 2, window: 6 });
    // Uniform failures also qualify structurally (repeat-fail usually wins first).
    expect(detectOscillation(["a", "a", "a", "a"], 2)).toEqual({ distinct: 1, window: 4 });
  });
  it("never fires below the window, at N<2, or with ≥3 distinct states", () => {
    expect(detectOscillation(["a", "b"], 3)).toBeNull();
    expect(detectOscillation(["a", "b", "a", "b"], 1)).toBeNull();
    expect(detectOscillation(["a", "b", "c", "a", "b", "c"], 3)).toBeNull();
  });
});

describe("evaluateIteration — checklist / oscillation / flake wiring", () => {
  const READY = {
    agentStateToken: "READY_FOR_REVIEW",
    allRequirementsMet: true,
  };

  it("6.6 refusal demotes a ready candidate to CONTINUE", () => {
    const out = evaluateIteration(
      input({
        ...READY,
        checklist: {
          rows: [acRow("AC-001", { status: "pending" })],
          contractAnchors: [],
          seenAcIds: [],
        },
      }),
      deps(),
    );
    expect(out.result.state).toBe("CONTINUE");
    expect(out.result.reason).toContain("unverified rows");
  });

  it("6.6 human-only pending rows surface NEEDS_HUMAN_VERIFY", () => {
    const out = evaluateIteration(
      input({
        ...READY,
        checklist: {
          rows: [acRow("AC-001", { method: "human", status: "pending" })],
          contractAnchors: [],
          seenAcIds: [],
        },
      }),
      deps(),
    );
    expect(out.result.state).toBe("NEEDS_HUMAN_VERIFY");
  });

  it("6.6 passes through to the candidate when the checklist is satisfied — and is skipped on forced gates", () => {
    const checklist = {
      rows: [acRow("AC-001")],
      contractAnchors: [{ acId: "AC-001", method: "cmd" as const }],
      seenAcIds: ["AC-001"],
    };
    expect(
      evaluateIteration(input({ ...READY, checklist }), deps()).result.state,
    ).toBe("SUCCESS_CANDIDATE");
    // Forced gate (assumeReady): the checklist never blocks it (loop-kit
    // candidate-promotion-only trust model).
    const forced = evaluateIteration(
      input({
        agentStateToken: null,
        allRequirementsMet: true,
        assumeReady: true,
        checklist: {
          rows: [acRow("AC-001", { status: "pending" })],
          contractAnchors: [],
          seenAcIds: [],
        },
      }),
      deps(),
    );
    expect(forced.result.state).toBe("SUCCESS_CANDIDATE");
  });

  it("oscillation: an A→B→A→B ping-pong BLOCKS where identical-repeat cannot", () => {
    const config = normalizeDevLoopConfig({ verifyCommands: ["npm test"], repeatFailN: 2 });
    let call = 0;
    const d: DevEvaluateDeps = {
      diffPaths: () => ["src/a.ts"],
      // Alternate two failure shapes: A, B, A, B — never 2 identical in a row.
      runVerify: () => ({ exitCode: 1, output: `failure shape ${call++ % 2 === 0 ? "alpha" : "beta"}` }),
    };
    let bookkeeping: DevEvaluateBookkeeping = EMPTY_BOOKKEEPING;
    let state = "";
    for (let i = 0; i < 4; i += 1) {
      const out = evaluateIteration(input({ config, bookkeeping }), d);
      bookkeeping = out.bookkeeping;
      state = out.result.state;
    }
    expect(state).toBe("BLOCKED");
    expect(bookkeeping.failFingerprints.length).toBe(4); // window respected (2×N)
  });

  it("flake absorption: red-then-green counts as green and keeps the failing pass", () => {
    const config = normalizeDevLoopConfig({ verifyCommands: ["npm test"], verifyRetries: 1 });
    let call = 0;
    const d: DevEvaluateDeps = {
      diffPaths: () => ["src/a.ts"],
      runVerify: () => (call++ === 0
        ? { exitCode: 1, output: "socket hiccup" }
        : { exitCode: 0, output: "ok" }),
    };
    const out = evaluateIteration(input({ ...READY, config }), d);
    expect(out.result.state).toBe("SUCCESS_CANDIDATE");
    expect(out.result.flake).toMatchObject({ attempt: 1 });
    expect(out.result.flake!.failedVerify[0]!.output).toContain("socket hiccup");
    expect(call).toBe(2);
  });

  it("flake absorption: a rerun that stays red fingerprints the FINAL pass", () => {
    const config = normalizeDevLoopConfig({ verifyCommands: ["npm test"], verifyRetries: 2, repeatFailN: 0 });
    let call = 0;
    const d: DevEvaluateDeps = {
      diffPaths: () => ["src/a.ts"],
      runVerify: () => ({ exitCode: 1, output: `attempt ${call++} boom` }),
    };
    const out = evaluateIteration(input({ config }), d);
    expect(out.result.state).toBe("CONTINUE");
    expect(out.result.flake).toBeUndefined();
    expect(call).toBe(3); // first pass + 2 reruns
    // The bookkeeping fingerprint came from the LAST rerun's output.
    expect(out.result.verify![0]!.output).toContain("attempt 2");
  });

  it("verifyRetries=0 trusts the first red pass", () => {
    const d = deps({ verifyExit: 1, verifyOutput: "red" });
    const out = evaluateIteration(input({}), d);
    expect(out.result.state).toBe("CONTINUE");
    expect(d.runVerify).toHaveBeenCalledTimes(1);
  });
});
