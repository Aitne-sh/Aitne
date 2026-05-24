/**
 * MANAGEMENT-POLICY-CAPTURE-PLAN §P3 — skill prompt tests.
 *
 * The `management-policy` skill is the LLM-facing contract for the
 * policy-capture flow. These tests assert that the SKILL.md ships the
 * structural pieces the plan §4.4 / §4.5 / §4.6 require: trigger-shape
 * description, "When NOT to use" routing, similarity heuristics,
 * mandatory pre-write listing, the strict create-order with rollback,
 * and pause/resume/remove. If a future edit drops one of these the
 * agent's behavior degrades silently — these tests catch that.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { EVENT_SKILL_SETS, ALL_SKILLS } from "./core/skills-manifest.js";
import { renderReferenceIncludes } from "./core/skills-compiler-skill-index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../");
const SKILL_DIR = resolve(REPO_ROOT, "agent-assets/skills/management-policy");
const SKILL_PATH = resolve(SKILL_DIR, "SKILL.md");

function readSkill(): string {
  // docs/design/appendices/skills-improvement.md §13 — Step 5 fan-out moved into
  // `references/policy-workflow.md`. Inline `{{> ref:* }}` directives
  // so structural assertions see the post-materialisation body.
  return renderReferenceIncludes(readFileSync(SKILL_PATH, "utf-8"), SKILL_DIR);
}

function frontmatter(skill: string): Record<string, string> {
  const match = skill.match(/^---\n([\s\S]+?)\n---/);
  if (!match) throw new Error("SKILL.md is missing YAML frontmatter");
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^([a-zA-Z_-]+):\s*(.+)$/);
    if (m) result[m[1]] = m[2].trim();
  }
  return result;
}

function body(skill: string): string {
  return skill.replace(/^---\n[\s\S]+?\n---\n/, "");
}

describe("management-policy SKILL.md — frontmatter & description shape", () => {
  it("declares name `management-policy`", () => {
    expect(frontmatter(readSkill()).name).toBe("management-policy");
  });

  it("description contains durable-rule trigger phrases", () => {
    // Plan §4.4 trigger-shape — the description has to surface "every
    // morning"-class signals so the model selects this over `schedule`
    // for ongoing-rule shapes.
    const desc = frontmatter(readSkill()).description.toLowerCase();
    expect(desc).toContain("durable");
    expect(desc).toMatch(/every morning|from now on/);
  });

  it("description + when_to_use contain explicit SKIP rules pointing at sibling skills", () => {
    // Plan §4.4 — without an explicit SKIP routing the model overlaps
    // with `schedule`, `user-profile`, `character`. The trio must be
    // named so the description-match heuristic at the SDK layer can
    // disambiguate. SKILLS-PHASE-2-PLAN.md §5 moved the SKIP clause out
    // of `description:` and into `when_to_use:` — both are read by the
    // SDK at activation time, so the combined trigger surface is what
    // the agent sees. Assert against the joined value.
    const fm = frontmatter(readSkill());
    const trigger = `${fm.description ?? ""} ${fm.when_to_use ?? ""}`.toLowerCase();
    expect(trigger).toContain("skip");
    expect(trigger).toContain("schedule");
    expect(trigger).toContain("user-profile");
  });

  it("description fits the SDK's 280-char trigger-shape budget", () => {
    // Mirrors the assertion in skills-manifest.test.ts — drift here would
    // cause the SDK to truncate the trigger guidance silently.
    expect(frontmatter(readSkill()).description.length).toBeLessThanOrEqual(
      280,
    );
  });
});

describe("management-policy SKILL.md — workflow structure (plan §4.4.1)", () => {
  it("documents Steps 1 through 7 in order", () => {
    const text = body(readSkill());
    const steps = [
      "Step 1 — List existing policies",
      "Step 2 — Detect similarity",
      "Step 3 — Echo interpretation",
      "Step 4 — Build the policy file",
      "Step 5 — Wire the dependencies",
      "Step 6 — Confirm to the user",
      "Step 7 — Audit",
    ];
    let cursor = 0;
    for (const step of steps) {
      const idx = text.indexOf(step, cursor);
      expect(idx, `Missing or out-of-order: ${step}`).toBeGreaterThan(-1);
      cursor = idx + step.length;
    }
  });

  it("Step 5 enumerates the exact create order: dossier → routine → policy, with 5.4 delegated to the reconciler", () => {
    // Plan §4.4.1 step 5 is load-bearing for the rollback contract:
    // failure at step N must roll back N-1…1. P4 (plan §9 row P4)
    // moved the previously-manual `_index.md` PATCH at step 5.4 onto
    // the daemon's policy-index reconciler — the skill must now state
    // 5.4 as a no-op for the agent so it doesn't race the reconciler.
    const text = body(readSkill());
    const dossierIdx = text.indexOf("5.1 Create the dossier");
    const routineIdx = text.indexOf("5.2 Create the custom routine");
    const policyIdx = text.indexOf("5.3 Create the policy file");
    const noopIdx = text.indexOf("5.4 _(no manual step required)_");
    expect(dossierIdx).toBeGreaterThan(-1);
    expect(routineIdx).toBeGreaterThan(dossierIdx);
    expect(policyIdx).toBeGreaterThan(routineIdx);
    expect(noopIdx).toBeGreaterThan(policyIdx);
    // Step 5.4's body must point at the reconciler so the next reader
    // doesn't reinstate a manual PATCH.
    const fromNoop = text.slice(noopIdx);
    expect(fromNoop).toMatch(/auto-maintained|policy-index reconciler/i);
  });

  it("warns about reverse-order rollback on failure", () => {
    const text = body(readSkill());
    expect(text.toLowerCase()).toMatch(/roll back/);
    expect(text).toMatch(/in reverse|reverse order|N-1/);
  });

  it("forbids editing rules/management.md body sections (plan §4.7)", () => {
    const text = body(readSkill());
    expect(text).toMatch(/does NOT touch.*rules\/management\.md|wizard-only/i);
  });
});

describe("management-policy SKILL.md — similarity detection (plan §4.5)", () => {
  it("Step 1 reads BOTH the directory and the _index", () => {
    // Plan §4.4.1 step 1 + §4.5 — directory listing is source of truth,
    // _index is convenience. The skill must read both so the agent
    // catches drift instead of acting on a stale index.
    const text = body(readSkill());
    const step1 = text.split("Step 2")[0];
    expect(step1).toMatch(/_index/);
    expect(step1).toMatch(/list|directory/i);
  });

  it("names all three similarity heuristics from plan §4.5", () => {
    const text = body(readSkill());
    // (a) same dossier, (b) same cron, (c) slug stem match
    expect(text.toLowerCase()).toContain("dossier");
    expect(text.toLowerCase()).toMatch(/cron expression|cadence/);
    expect(text.toLowerCase()).toMatch(/slug.*stem|stem.*slug|primary noun/);
  });

  it("requires asking the user — no silent create-anyway path", () => {
    const text = body(readSkill());
    // Decision §1.1.3 — duplicate suspicion must STOP and ask. Silent
    // creation accumulates duplicates the user can't see.
    expect(text.toLowerCase()).toMatch(/stop until|wait.*explicit|do not create.*silent/);
  });
});

describe("management-policy SKILL.md — pause / resume / remove (plan §4.6)", () => {
  it("documents pause, resume, and remove flows", () => {
    const text = body(readSkill());
    expect(text).toMatch(/^### Pause/m);
    expect(text).toMatch(/^### Resume/m);
    expect(text).toMatch(/^### Remove/m);
  });

  it("pause flow flips both policy.status AND linked routine.enabled", () => {
    // Decision §1.1.4 — pause = pause linked things. A pause that only
    // touches the policy file leaves the cron job firing.
    const text = body(readSkill());
    const pauseSection = text.split(/^### Pause/m)[1].split(/^### Resume/m)[0];
    expect(pauseSection).toMatch(/status:\s*paused/);
    expect(pauseSection).toMatch(/enabled:\s*false/);
    expect(pauseSection).toMatch(/_index/);
  });

  it("remove flow uses status:removed (not file delete) for the policy file", () => {
    // Plan §4.6 + §5.1 — DELETE is intentionally not whitelisted on
    // rules/*. The policy file is kept for history with status:removed.
    const text = body(readSkill());
    const removeSection = text.split(/^### Remove/m)[1] ?? "";
    expect(removeSection).toMatch(/status:\s*removed/);
    // The routine file IS deleted (DELETE is whitelisted on routines/custom/*).
    expect(removeSection).toMatch(/DELETE\s+\/api\/context\/routines\/custom/);
  });

  it("documents best-effort fan-out semantics, not transactional", () => {
    // Plan §4.6 revised honest framing — atomicity caveat must be
    // visible so the agent surfaces partial-state failures to the user.
    const text = body(readSkill());
    expect(text.toLowerCase()).toMatch(/best-effort|partial state|attempt to roll back/);
  });
});

describe("management-policy SKILL.md — API surface (plan §11)", () => {
  it("references the actually-existing context API endpoints", () => {
    // Defensive: if the skill drifts to a non-existent endpoint, every
    // policy capture silently 404s. The HTTP integration test covers
    // live calls; this assertion catches obvious typos at static-analysis
    // time.
    const text = body(readSkill());
    expect(text).toMatch(/\/api\/context\/rules\/policies\//);
    expect(text).toMatch(/\/api\/context\/routines\/custom\//);
    expect(text).toMatch(/\/api\/context\/dossiers\//);
    expect(text).toMatch(/\/api\/context\/rules\/policies\/_index/);
  });

  it("uses the single-segment list endpoint, NOT the broken multi-segment form", () => {
    // The list route is `/context/list/:dir` — single-segment param. An
    // earlier draft of this skill called `/api/context/list/rules/policies`,
    // which falls through to `/context/*` (single-file fetch) and returns
    // 404 for every invocation. The integration test pins the working URL
    // against the real router; this static assertion catches a drift at
    // edit time.
    const text = body(readSkill());
    expect(
      text,
      "skill must NOT call the broken multi-segment list URL",
    ).not.toMatch(/\/api\/context\/list\/rules\/policies/);
    expect(
      text,
      "skill MUST call /api/context/list/rules and filter for policies/ entries",
    ).toMatch(/\/api\/context\/list\/rules(?!\/)/);
  });

  it("forbids direct insertion into agent_actions and describes the real audit substrate", () => {
    // Plan §4.4.1 step 7 — the audit row is NOT an agent_actions insert.
    // The legacy Notify-tier middleware (removed in DELEGATED-MODE-V2 §4.5)
    // only emitted a pino log line, never an agent_actions row; the
    // durable rollback trail is `md_file_snapshots` (audit test verifies
    // this). The skill must not claim agent_actions and must not call any
    // audit endpoint itself.
    const text = body(readSkill());
    expect(text).toMatch(/Do\s+\*?\*?not\*?\*?\s+call\s+any\s+extra\s+audit/i);
    expect(
      text,
      "skill must reference md_file_snapshots, the real audit substrate",
    ).toMatch(/md_file_snapshots/);
    expect(
      text,
      "skill must not falsely claim Notify-tier writes produce an agent_actions row",
    ).not.toMatch(/produces\s+an\s+`?agent_actions`?\s+row/i);
  });
});

describe("management-policy skill — manifest registration (plan §6.2)", () => {
  it("is registered for every conversational entry point", () => {
    // Plan §6.2 — without this registration the skill is invisible to
    // SkillsCompiler.materializeSessionBundle and the agent can never
    // invoke it from a DM. Audit-C in §0 was specifically about this gap.
    for (const eventType of [
      "message.received",
      "message.received.dm",
      "message.received.dm_first",
      "routine.evening_review",
    ]) {
      const skills = EVENT_SKILL_SETS[eventType];
      expect(
        skills,
        `EVENT_SKILL_SETS missing for event ${eventType}`,
      ).toBeDefined();
      expect(
        skills?.includes("management-policy"),
        `${eventType} must include management-policy`,
      ).toBe(true);
    }
  });

  it("is in ALL_SKILLS so the fallback path picks it up", () => {
    expect(ALL_SKILLS).toContain("management-policy");
  });

  it("is NOT registered in routine.user_profile_sweep (curated minimal manifest)", () => {
    // Plan §6.2 explicit DO-NOT-bloat list. The 2-skill sweep manifest
    // is load-bearing for selection accuracy on user-profile detection;
    // see USER-PROFILE-CAPTURE-PLAN §Phase 2.
    expect(EVENT_SKILL_SETS["routine.user_profile_sweep"]).not.toContain(
      "management-policy",
    );
  });
});
