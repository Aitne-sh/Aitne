import { describe, it, expect, vi } from "vitest";
import {
  EMPTY_BOOKKEEPING,
  evaluateIteration,
  fingerprintFailure,
  globToRegExp,
  matchesAnyGlob,
  type DevEvaluateBookkeeping,
  type DevEvaluateDeps,
  type DevEvaluateInput,
} from "./dev-loop-evaluate.js";
import { normalizeDevLoopConfig } from "./dev-loop-config.js";
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
  it("normalizes numbers and hex so identical failures match", () => {
    const fp1 = fingerprintFailure([
      { command: "npm test", exitCode: 1, passed: false, output: "fail at line 42 (0xAB)" },
    ]);
    const fp2 = fingerprintFailure([
      { command: "npm test", exitCode: 1, passed: false, output: "fail at line 99 (0xFF)" },
    ]);
    expect(fp1).toBe(fp2);
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
