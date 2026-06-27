import { describe, expect, it } from "vitest";

import {
  getAgentLessonsInjection,
  getInjectionPolicy,
  type AgentLessonsInjection,
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

  it("activity scan and today refresh drop both heavy blocks", () => {
    for (const key of ["routine.activity_scan", "routine.today_refresh"]) {
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
    const a = getInjectionPolicy("routine.activity_scan");
    const b = getInjectionPolicy("routine.today_refresh");
    // Both drop heavy blocks → same shared empty set instance.
    expect(a.alwaysBlocks).toBe(b.alwaysBlocks);
  });
});

describe("getAgentLessonsInjection — Stage-3 opt-in resolver (§5)", () => {
  const tuple = (i: AgentLessonsInjection) => [i.global, i.self, i.slim];

  it("DM / dashboard messages get global + self, no slim", () => {
    for (const key of [
      "message.received.dm",
      "message.dm",
      "message.received.dm_first",
      "message.mention",
    ]) {
      expect(tuple(getAgentLessonsInjection(key))).toEqual([true, true, false]);
    }
  });

  it("scheduled.dm gets global + self (conversational posture)", () => {
    expect(tuple(getAgentLessonsInjection("scheduled.dm"))).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("notify-deciding routines (morning Stage A + reviews) get global + self", () => {
    for (const key of [
      "routine.morning_routine_today",
      "routine.evening_review",
      "routine.weekly_review",
      "routine.monthly_review",
    ]) {
      expect(tuple(getAgentLessonsInjection(key))).toEqual([true, true, false]);
    }
  });

  it("activity_scan gets the slim variant: global + slim, no self", () => {
    expect(tuple(getAgentLessonsInjection("routine.activity_scan"))).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("the morning umbrella + Stage B journal author get nothing", () => {
    // The umbrella `routine.morning_routine` never reaches build(); Stage B
    // (`routine.morning_routine_journal`) decides no notifications. Keying
    // either would burn bytes against the §0 cost constraint.
    for (const key of [
      "routine.morning_routine",
      "routine.morning_routine_journal",
    ]) {
      expect(tuple(getAgentLessonsInjection(key))).toEqual([false, false, false]);
    }
  });

  it("the §5 'gets nothing' surfaces opt out entirely", () => {
    for (const key of [
      "scheduled.task",
      "routine.today_refresh",
      "routine.fetch_window",
      "routine.activity_scan.triage",
      "github.pull_request.opened",
      "git.new_commit",
      "schedule.approaching",
      "unknown.event",
    ]) {
      expect(tuple(getAgentLessonsInjection(key))).toEqual([false, false, false]);
    }
  });

  it("returns shared frozen instances for equality stability + immutability", () => {
    const a = getAgentLessonsInjection("message.dm");
    const b = getAgentLessonsInjection("routine.evening_review");
    expect(a).toBe(b); // same DM/review shape instance
    expect(Object.isFrozen(a)).toBe(true);
    expect(getAgentLessonsInjection("scheduled.task")).toBe(
      getAgentLessonsInjection("unknown.event"),
    );
  });

  it("slim always implies global (a slim-only surface would be incoherent)", () => {
    const hourly = getAgentLessonsInjection("routine.activity_scan");
    expect(hourly.slim && hourly.global).toBe(true);
  });

  it("agent-bound scheduled.task gets global + self (§5 Defined-agent execution)", () => {
    // A bare scheduled.task (no resolved Agent) opts out; one that resolves to
    // a user-defined Agent gets both blocks so feedback reaches that Agent.
    expect(tuple(getAgentLessonsInjection("scheduled.task"))).toEqual([
      false,
      false,
      false,
    ]);
    expect(
      tuple(getAgentLessonsInjection("scheduled.task", { agentBound: false })),
    ).toEqual([false, false, false]);
    expect(
      tuple(getAgentLessonsInjection("scheduled.task", { agentBound: true })),
    ).toEqual([true, true, false]);
  });

  it("agentBound never resurrects a §5 'gets nothing' non-task surface", () => {
    // The binding flag is scoped to scheduled.task; observers / fetch_window /
    // today_refresh stay NONE even if (hypothetically) bound to an Agent.
    for (const key of [
      "routine.today_refresh",
      "routine.fetch_window",
      "github.pull_request.opened",
      "unknown.event",
    ]) {
      expect(
        tuple(getAgentLessonsInjection(key, { agentBound: true })),
      ).toEqual([false, false, false]);
    }
  });

  it("agent-bound maintenance routines stay NONE (§5 / v1.6 §11.1 cost guarantee)", () => {
    // user_profile_sweep / skill_curation DO resolve to a built-in Agent, so
    // the builder supplies { agentBound: true } — unlike today_refresh /
    // observers above, which never resolve to an Agent. The guarantee is that
    // binding alone does NOT inject lessons: only `scheduled.task` is rescued.
    // These routines decide no notifications, so keying them would burn bytes
    // against the §0 cost constraint. This pins the exact "resolves to an Agent
    // but is not scheduled.task" path the binding-aware resolver must reject.
    for (const key of ["routine.user_profile_sweep", "routine.skill_curation"]) {
      expect(tuple(getAgentLessonsInjection(key))).toEqual([false, false, false]);
      expect(
        tuple(getAgentLessonsInjection(key, { agentBound: true })),
      ).toEqual([false, false, false]);
    }
  });

  it("agentBound does not change matched surfaces (hourly stays slim, no self)", () => {
    expect(
      tuple(getAgentLessonsInjection("routine.activity_scan", { agentBound: true })),
    ).toEqual([true, false, true]);
    expect(
      tuple(getAgentLessonsInjection("message.dm", { agentBound: true })),
    ).toEqual([true, true, false]);
  });
});

/**
 * V20 byte-identity regression guard.
 *
 * Plan §15 PR-2 checklist: "For every event type currently in
 * POLICY_KEY_GLOBAL_OPTOUT (Stage B journal author, activity_scan,
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
    const hourlyPaths = resolvePolicyRefs("routine.activity_scan").map(
      (r) => r.path,
    );
    expect(hourlyPaths).toEqual([
      "policies/redaction.md",
      "policies/mcp.md",
      "policies/routines/activity-scan.md",
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
