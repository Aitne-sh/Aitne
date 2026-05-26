import { describe, expect, it } from "vitest";

import {
  getInjectionPolicy,
  type AlwaysBlockKey,
  type InjectionPolicy,
} from "./injection-policy.js";
import { resolvePolicyRefs } from "./policy-files.js";

describe("getInjectionPolicy — §8 declarative table", () => {
  it("default (unknown key) injects both blocks and merges *", () => {
    const policy = getInjectionPolicy("unknown.event");
    expect(setEqual(policy.alwaysBlocks, ["user", "management_rules"])).toBe(
      true,
    );
    expect(policy.policyFileGlobalMerge).toBe(true);
  });

  it("DM and message events are on the wide path", () => {
    for (const key of ["message.received.dm", "message.dm", "dashboard.message"]) {
      const policy = getInjectionPolicy(key);
      expect(setEqual(policy.alwaysBlocks, ["user", "management_rules"])).toBe(
        true,
      );
      expect(policy.policyFileGlobalMerge).toBe(true);
    }
  });

  it("Stage B opts out of <management_rules> AND of the * policy merge", () => {
    const policy = getInjectionPolicy("routine.morning_routine_journal");
    // <user> kept (for people roster + redaction-aware wikilinks);
    // <management_rules> dropped.
    expect(setEqual(policy.alwaysBlocks, ["user"])).toBe(true);
    // v4.2 V20 — this is the only key today with policyFileGlobalMerge=false.
    expect(policy.policyFileGlobalMerge).toBe(false);
  });

  it("hourly check and today refresh drop both heavy blocks", () => {
    for (const key of ["routine.hourly_check", "routine.today_refresh"]) {
      const policy = getInjectionPolicy(key);
      expect(policy.alwaysBlocks.size).toBe(0);
      // Redaction is non-negotiable for any vault-write surface — `*`
      // merge stays on for narrow routines too.
      expect(policy.policyFileGlobalMerge).toBe(true);
    }
  });

  it("github.* and git.* observer events drop both heavy blocks", () => {
    for (const key of [
      "github.pull_request.opened",
      "github.issue.commented",
      "git.new_commit",
      "git.project.update",
    ]) {
      const policy = getInjectionPolicy(key);
      expect(policy.alwaysBlocks.size).toBe(0);
      expect(policy.policyFileGlobalMerge).toBe(true);
    }
  });

  it("schedule.approaching drops both heavy blocks", () => {
    const policy = getInjectionPolicy("schedule.approaching");
    expect(policy.alwaysBlocks.size).toBe(0);
    expect(policy.policyFileGlobalMerge).toBe(true);
  });

  it("scheduled.task drops both heavy blocks", () => {
    const policy = getInjectionPolicy("scheduled.task");
    expect(policy.alwaysBlocks.size).toBe(0);
    expect(policy.policyFileGlobalMerge).toBe(true);
  });

  it("scheduled.dm stays on the wide path (morning_briefing reads <user>)", () => {
    const policy = getInjectionPolicy("scheduled.dm");
    expect(setEqual(policy.alwaysBlocks, ["user", "management_rules"])).toBe(
      true,
    );
    expect(policy.policyFileGlobalMerge).toBe(true);
  });

  it("returns shared, frozen Set instances for equality stability", () => {
    const a = getInjectionPolicy("routine.hourly_check");
    const b = getInjectionPolicy("routine.today_refresh");
    // Both drop heavy blocks → same shared empty set instance.
    expect(a.alwaysBlocks).toBe(b.alwaysBlocks);
  });
});

/**
 * V20 byte-identity regression guard.
 *
 * Plan §15 PR-2 checklist: "For every event type currently in
 * POLICY_KEY_GLOBAL_OPTOUT (Stage B journal author, hourly_check,
 * today_refresh, observer events, scheduled.task), snapshot the rendered
 * policy-files output before the consolidation, run the consolidation,
 * snapshot again. The two snapshots must be byte-identical."
 *
 * The pre-consolidation value of POLICY_KEY_GLOBAL_OPTOUT was a single
 * entry: `routine.morning_routine_journal`. The plan's "every event type
 * currently in POLICY_KEY_GLOBAL_OPTOUT" therefore means that one key —
 * the other narrow routines were opted out of <user>/<management_rules>
 * injection but NOT out of the policy-file `*` merge.
 *
 * Hard-coded expected paths below are byte-identical to what the
 * pre-consolidation code produced (`POLICY_FILE_REGISTRY["*"]` minus the
 * mcp.md flag-gated entry that ContextBuilder activates separately, plus
 * the Stage B specific row).
 */
describe("V20 byte-identity guard — resolvePolicyRefs survives consolidation", () => {
  // Note: the byte-identity contract is "behavior preserved across the
  // V20 consolidation"; the paths themselves rebase onto the new vault
  // layout (policies/ instead of rules/) as part of the same
  // CONTEXT_VAULT_REDESIGN release.
  it("Stage B output is exactly the pre-consolidation byte stream", () => {
    const refs = resolvePolicyRefs("routine.morning_routine_journal");
    const paths = refs.map((r) => r.path);
    expect(paths).toEqual([
      // Specific to Stage B (POLICY_FILE_REGISTRY["routine.morning_routine_journal"])
      "policies/redaction.md",
      "policies/journal-format.md",
      "policies/journal-export.md",
    ]);
    // `*` merge MUST be suppressed → no second copy of redaction.md, no
    // mcp.md, even though both live under `*`.
    expect(paths.filter((p) => p === "policies/redaction.md")).toHaveLength(1);
    expect(paths).not.toContain("policies/mcp.md");
  });

  it("Stage A is unchanged (still gets `*` merge)", () => {
    const refs = resolvePolicyRefs("routine.morning_routine_today");
    const paths = refs.map((r) => r.path);
    expect(paths).toEqual([
      // `*` defaults first (order preserved):
      "policies/redaction.md",
      "policies/mcp.md",
      // Specific:
      "policies/routines/morning.md",
    ]);
  });

  it("narrow routines that opt out of heavy blocks still get the * merge", () => {
    // These were never in POLICY_KEY_GLOBAL_OPTOUT — their resolvePolicyRefs
    // output must match the pre-consolidation behavior.
    const hourlyPaths = resolvePolicyRefs("routine.hourly_check").map(
      (r) => r.path,
    );
    expect(hourlyPaths).toEqual([
      "policies/redaction.md",
      "policies/mcp.md",
      "policies/routines/hourly.md",
    ]);
  });

  it("custom routines preserve the * merge plus the slug file", () => {
    const refs = resolvePolicyRefs("routine.custom.tuesday-notion");
    const paths = refs.map((r) => r.path);
    expect(paths).toEqual([
      "policies/redaction.md",
      "policies/mcp.md",
      "policies/routines/custom/tuesday-notion.md",
    ]);
  });
});

function setEqual(
  set: ReadonlySet<AlwaysBlockKey>,
  expected: readonly AlwaysBlockKey[],
): boolean {
  if (set.size !== expected.length) return false;
  for (const item of expected) {
    if (!set.has(item)) return false;
  }
  return true;
}

// Type-only sanity check — surfaces a missing field at compile time.
const _typeCheck: InjectionPolicy = {
  alwaysBlocks: new Set<AlwaysBlockKey>(["user"]),
  policyFileGlobalMerge: true,
};
void _typeCheck;
