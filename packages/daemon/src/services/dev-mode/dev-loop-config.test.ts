import { describe, it, expect } from "vitest";
import {
  DEV_FLOW_CONFIG_DEFAULTS,
  DEV_LOOP_CONFIG_DEFAULTS,
  canonicalize,
  computeApprovalHash,
  computeConfigHashSansBudget,
  normalizeDevFlowConfig,
  normalizeDevLoopConfig,
  validateDevLoopConfig,
} from "./dev-loop-config.js";
import type { DevLoopConfig } from "./types.js";

const CONTRACT_MD = [
  "# Product Contract",
  "## Goal",
  "ship it",
  "### REQ-001: auth",
].join("\n");

function cfg(partial: Partial<DevLoopConfig> = {}): DevLoopConfig {
  return normalizeDevLoopConfig({ verifyCommands: ["npm test"], ...partial });
}

describe("normalizeDevLoopConfig", () => {
  it("returns defaults for an empty partial", () => {
    const c = normalizeDevLoopConfig({});
    expect(c.deniedPaths).toEqual([".env*", "secrets/**", "credentials/**"]);
    expect(c.maxIterations).toBe(10);
    expect(c.reviewMode).toBe("always");
    expect(c.maxCostUsd).toBeNull();
    expect(c.stopEval).toBe(true);
  });

  it("handles null/undefined partial", () => {
    expect(normalizeDevLoopConfig(null).maxIterations).toBe(10);
    expect(normalizeDevLoopConfig(undefined).maxIterations).toBe(10);
  });

  it("merges + dedupes + trims string lists, dropping non-strings", () => {
    const c = normalizeDevLoopConfig({
      verifyCommands: [" npm test ", "npm test", "", 42 as unknown as string],
      deniedPaths: ["a/**"],
    });
    expect(c.verifyCommands).toEqual(["npm test"]);
    expect(c.deniedPaths).toEqual(["a/**"]);
  });

  it("falls back when a list field is not an array", () => {
    const c = normalizeDevLoopConfig({
      verifyCommands: "npm test" as unknown as string[],
    });
    expect(c.verifyCommands).toEqual([]);
  });

  it("coerces + clamps numeric fields", () => {
    const c = normalizeDevLoopConfig({
      maxIterations: 0, // clamped up to 1
      maxIterSeconds: -5, // clamped up to 1
      stagnationN: 2.9, // truncated to 2
      maxRevisions: 0, // clamped up to 1
      maxResumes: 0, // clamped up to 1
      metForceN: -3, // → default (nonNegInt fallback? -3 is finite → max(0,trunc)=0)
    });
    expect(c.maxIterations).toBe(1);
    expect(c.maxIterSeconds).toBe(1);
    expect(c.stagnationN).toBe(2);
    expect(c.maxRevisions).toBe(1);
    expect(c.maxResumes).toBe(1);
    expect(c.metForceN).toBe(0);
  });

  it("falls back on non-finite / non-number numerics", () => {
    const c = normalizeDevLoopConfig({
      stagnationN: NaN,
      repeatFailN: "x" as unknown as number,
      futileN: Infinity,
    });
    expect(c.stagnationN).toBe(2);
    expect(c.repeatFailN).toBe(3);
    expect(c.futileN).toBe(2);
  });

  it("treats explicit budget fields as positive-or-null; undefined keeps default", () => {
    expect(normalizeDevLoopConfig({ maxCostUsd: 5 }).maxCostUsd).toBe(5);
    expect(normalizeDevLoopConfig({ maxCostUsd: 0 }).maxCostUsd).toBeNull();
    expect(normalizeDevLoopConfig({ maxCostUsd: -1 }).maxCostUsd).toBeNull();
    expect(normalizeDevLoopConfig({ maxRunSeconds: 60 }).maxRunSeconds).toBe(60);
    expect(normalizeDevLoopConfig({ maxRunSeconds: 0 }).maxRunSeconds).toBeNull();
    // undefined → default (null)
    expect(normalizeDevLoopConfig({}).maxRunSeconds).toBeNull();
  });

  it("validates enum fields, falling back on unknown values", () => {
    expect(normalizeDevLoopConfig({ reviewMode: "candidate" }).reviewMode).toBe(
      "candidate",
    );
    expect(normalizeDevLoopConfig({ reviewMode: "off" }).reviewMode).toBe("off");
    expect(
      normalizeDevLoopConfig({ reviewMode: "bogus" as unknown as "always" })
        .reviewMode,
    ).toBe("always");
    expect(
      normalizeDevLoopConfig({ permissionMode: "bypassPermissions" }).permissionMode,
    ).toBe("bypassPermissions");
    expect(
      normalizeDevLoopConfig({ permissionMode: "auto" }).permissionMode,
    ).toBe("auto");
    expect(
      normalizeDevLoopConfig({ permissionMode: "x" as unknown as "auto" })
        .permissionMode,
    ).toBe("acceptEdits");
  });

  it("honors an explicit stopEval boolean and non-boolean fallback", () => {
    expect(normalizeDevLoopConfig({ stopEval: false }).stopEval).toBe(false);
    expect(
      normalizeDevLoopConfig({ stopEval: "yes" as unknown as boolean }).stopEval,
    ).toBe(true);
  });

  it("never mutates DEV_LOOP_CONFIG_DEFAULTS arrays", () => {
    const c = normalizeDevLoopConfig({});
    c.deniedPaths.push("x");
    expect(DEV_LOOP_CONFIG_DEFAULTS.deniedPaths).toEqual([
      ".env*",
      "secrets/**",
      "credentials/**",
    ]);
  });
});

describe("validateDevLoopConfig", () => {
  it("rejects an empty verifyCommands (fail-closed)", () => {
    const v = validateDevLoopConfig(cfg({ verifyCommands: [] }));
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toMatch(/verifyCommands is empty/);
  });

  it("passes when verifyCommands is set", () => {
    expect(validateDevLoopConfig(cfg()).ok).toBe(true);
  });

  it("reports maxIterations < 1 (constructed to bypass the clamp)", () => {
    const bad = { ...cfg(), maxIterations: 0 };
    const v = validateDevLoopConfig(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /maxIterations/.test(e))).toBe(true);
  });
});

describe("approval-hash serialization", () => {
  it("canonicalize sorts object keys deeply and preserves arrays/primitives", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
    expect(canonicalize([3, { y: 1, x: 2 }])).toBe('[3,{"x":2,"y":1}]');
    expect(canonicalize("s")).toBe('"s"');
    expect(canonicalize(null)).toBe("null");
  });

  it("computeApprovalHash is deterministic and order-independent for config keys", () => {
    const c1 = cfg();
    const h1 = computeApprovalHash(CONTRACT_MD, c1);
    const h2 = computeApprovalHash(CONTRACT_MD, cfg());
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the contract or config changes", () => {
    const base = computeApprovalHash(CONTRACT_MD, cfg());
    const c2 = computeApprovalHash(`${CONTRACT_MD}\nedited`, cfg());
    const c3 = computeApprovalHash(CONTRACT_MD, cfg({ maxIterations: 5 }));
    expect(c2).not.toBe(base);
    expect(c3).not.toBe(base);
  });

  it("config-sans-budget hash ignores budget keys but not others", () => {
    const base = computeConfigHashSansBudget(cfg());
    const budgetOnly = computeConfigHashSansBudget(
      cfg({ maxIterations: 99, maxCostUsd: 50, maxRunSeconds: 3600 }),
    );
    const nonBudget = computeConfigHashSansBudget(cfg({ stagnationN: 9 }));
    expect(budgetOnly).toBe(base);
    expect(nonBudget).not.toBe(base);
  });
});

describe("normalizeDevFlowConfig", () => {
  it("returns the fleet defaults for empty/absent partials", () => {
    expect(normalizeDevFlowConfig(undefined)).toEqual(DEV_FLOW_CONFIG_DEFAULTS);
    expect(normalizeDevFlowConfig(null)).toEqual(DEV_FLOW_CONFIG_DEFAULTS);
    expect(normalizeDevFlowConfig({})).toEqual(DEV_FLOW_CONFIG_DEFAULTS);
    expect(DEV_FLOW_CONFIG_DEFAULTS.maxParallel).toBe(3);
    expect(DEV_FLOW_CONFIG_DEFAULTS.decompose).toBe(true);
  });
  it("coerces every field defensively", () => {
    const c = normalizeDevFlowConfig({
      decompose: false,
      maxParallel: 0,
      maxTasks: -5,
      superviseCap: 4.9,
      replanCap: Number.NaN,
      planReview: false,
      planReviewCap: 2,
      integrationFixupCap: 3,
      splitNudgeAt: 250,
      splitCarryover: false,
      worktreeSetupCommand: "  pnpm install  ",
    });
    expect(c.decompose).toBe(false);
    expect(c.maxParallel).toBe(1); // floor of 1
    expect(c.maxTasks).toBe(1); // floor of 1 after non-neg clamp
    expect(c.superviseCap).toBe(4);
    expect(c.replanCap).toBe(DEV_FLOW_CONFIG_DEFAULTS.replanCap);
    expect(c.planReview).toBe(false);
    expect(c.splitNudgeAt).toBe(100); // percentage clamp
    expect(c.splitCarryover).toBe(false);
    expect(c.worktreeSetupCommand).toBe("pnpm install");
  });
  it("normalizes a blank setup command to null", () => {
    expect(normalizeDevFlowConfig({ worktreeSetupCommand: "   " }).worktreeSetupCommand).toBeNull();
    expect(
      normalizeDevFlowConfig({ worktreeSetupCommand: 42 as unknown as string }).worktreeSetupCommand,
    ).toBeNull();
  });
  it("lands in the loop config and the approval hash", () => {
    const base = computeApprovalHash(CONTRACT_MD, cfg());
    const flowChanged = computeApprovalHash(
      CONTRACT_MD,
      cfg({ flow: { ...DEV_FLOW_CONFIG_DEFAULTS, maxParallel: 1 } }),
    );
    expect(cfg().flow).toEqual(DEV_FLOW_CONFIG_DEFAULTS);
    expect(flowChanged).not.toBe(base);
    // flow is NOT a budget key — sans-budget hash still changes.
    expect(
      computeConfigHashSansBudget(cfg({ flow: { ...DEV_FLOW_CONFIG_DEFAULTS, maxParallel: 1 } })),
    ).not.toBe(computeConfigHashSansBudget(cfg()));
  });
});
