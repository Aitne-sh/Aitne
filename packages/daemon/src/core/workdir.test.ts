import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { BackendId, ProcessKey } from "@aitne/shared";
import {
  createSessionWorkdir,
  ensureSessionWorkdir,
  ensureBackendMaterialized,
  getSessionWorkdirPath,
  cleanupSessionWorkdir,
  cleanupStaleWorkdirs,
  getSkillsForEvent,
  getProfileForEvent,
  syncUserSkills,
  syncAllUserSkills,
  refreshDmSessionWorkdirs,
} from "./workdir.js";
import { OWNER_DM_SCOPE } from "../messaging/constants.js";

/** Raw profile content (without safety preamble). */
const PROFILE_CONTENTS: Record<string, string> = {
  routine: "# Routine Agent\nAutonomous scheduled routines.",
  conversational: "# Conversational Agent\nUser-facing dialogue.",
  observer: "# Observer Agent\nEvent classification.",
  task: "# Task Agent\nScheduled task execution.",
};

const SAFETY_PREAMBLE = "## Safety Invariants\n- Do not execute destructive operations.\n";

describe("getProfileForEvent", () => {
  it("returns routine for morning routine", () => {
    expect(getProfileForEvent("routine.morning_routine")).toBe("routine");
    // `routine.morning_routine_initial` retired by Phase 7 (2026-05-16);
    // any stray caller still passing the retired key is caught by the
    // `routine.*` prefix fallback in `getProfileForEvent`, which we
    // pin here as a defense-in-depth guard.
    expect(getProfileForEvent("routine.morning_routine_initial")).toBe("routine");
  });

  it("returns routine for evening review", () => {
    expect(getProfileForEvent("routine.evening_review")).toBe("routine");
  });

  it("returns routine for roadmap refresh", () => {
    expect(getProfileForEvent("routine.roadmap_refresh")).toBe("routine");
  });

  it("returns conversational for user messages", () => {
    expect(getProfileForEvent("message.received")).toBe("conversational");
    expect(getProfileForEvent("message.received.dm_first")).toBe("conversational");
    expect(getProfileForEvent("message.received.dm")).toBe("conversational");
  });

  it("returns conversational for setup events", () => {
    expect(getProfileForEvent("setup.initial")).toBe("conversational");
    expect(getProfileForEvent("setup.update")).toBe("conversational");
  });

  it("returns routine for hourly observation checks", () => {
    expect(getProfileForEvent("routine.activity_scan")).toBe("routine");
  });

  it("returns observer for approaching events and task for scheduled tasks", () => {
    expect(getProfileForEvent("schedule.approaching")).toBe("observer");
    expect(getProfileForEvent("scheduled.task")).toBe("task");
  });

  it("returns task (default) for unknown event types", () => {
    expect(getProfileForEvent("unknown.type")).toBe("task");
  });

  it("returns routine for custom routines (unified with named routines)", () => {
    expect(getProfileForEvent("routine.custom.read-health")).toBe("routine");
    expect(getProfileForEvent("routine.custom.any-slug")).toBe("routine");
  });
});

describe("getSkillsForEvent", () => {
  it("returns specific skills for morning routine", () => {
    const skills = getSkillsForEvent("routine.morning_routine");
    expect(skills).toContain("context");
    expect(skills).toContain("today");
    expect(skills).toContain("observations");
    expect(skills).toContain("schedule");
    expect(skills).toContain("mail");
    expect(skills).toContain("roadmap");
    expect(skills).not.toContain("user-profile");
    // Trimmed for cost — these skills inline endpoint reference for surfaces
    // the morning routine's task-flow does not call. Notion drain goes
    // through `/api/observations` (taught by `observations`), not
    // `/api/notion/*`. Travel/external-services would only matter if the
    // routine called those endpoint families directly.
    expect(skills).not.toContain("external-services");
    expect(skills).not.toContain("notion");
    expect(skills).not.toContain("travel");
  });

  it("returns specific skills for message.received", () => {
    const skills = getSkillsForEvent("message.received");
    expect(skills).toContain("user-profile");
    expect(skills).toContain("external-services");
    expect(skills).toContain("notify");
    expect(skills).toContain("today");
    expect(skills).toContain("context");
    expect(skills).toContain("schedule");
  });

  it("loads context, today, user-profile for DM prompts", () => {
    const firstDmSkills = getSkillsForEvent("message.received.dm_first");
    const dmSkills = getSkillsForEvent("message.received.dm");
    for (const skills of [firstDmSkills, dmSkills]) {
      expect(skills).toContain("context");
      expect(skills).toContain("today");
      expect(skills).toContain("user-profile");
      expect(skills).toContain("external-services");
    }
  });

  it("uses a minimal skill set for setup.initial (user-profile only)", () => {
    // SETUP-FLOW-REDESIGN-PLAN §5.8 removed the legacy "tool selections"
    // form. setup.initial now derives Source-of-Truth from the
    // `<integration_modes>` context tag and writes only to
    // /api/context/user/*. external-services (calendar / obsidian /
    // github / skills) is dead weight here and was pruned so Codex
    // sessions don't pay for ~1k+ lines of irrelevant API reference.
    const skills = getSkillsForEvent("setup.initial");
    expect(skills).toContain("user-profile");
    expect(skills).not.toContain("external-services");
    expect(skills).toHaveLength(1);
  });

  it("includes user-profile in setup.update for communication-style edits", () => {
    const skills = getSkillsForEvent("setup.update");
    expect(skills).toContain("user-profile");
    expect(skills).toHaveLength(1);
  });

  it("returns specific skills for evening review", () => {
    const skills = getSkillsForEvent("routine.evening_review");
    expect(skills).toContain("context");
    expect(skills).toContain("today");
    expect(skills).toContain("user-profile");
    expect(skills).toContain("notify");
  });

  it("returns specific skills for roadmap refresh", () => {
    const skills = getSkillsForEvent("routine.roadmap_refresh");
    expect(skills).toContain("context");
    expect(skills).toContain("external-services");
    expect(skills).toContain("notion");
    expect(skills).toContain("roadmap");
    expect(skills).toHaveLength(4);
  });

  it("returns specific skills for routine.activity_scan", () => {
    const skills = getSkillsForEvent("routine.activity_scan");
    expect(skills).toContain("context");
    expect(skills).toContain("today");
    expect(skills).toContain("observations");
    expect(skills).toContain("notify");
    expect(skills).toContain("schedule");
    expect(skills).toContain("external-services");
    expect(skills).not.toContain("user-profile");
  });

  it("includes context, today, and notify for schedule.approaching", () => {
    const skills = getSkillsForEvent("schedule.approaching");
    expect(skills).toContain("context");
    expect(skills).toContain("today");
    expect(skills).toContain("notify");
    expect(skills).toHaveLength(3);
  });

  it("includes context and external-services for scheduled.task", () => {
    const skills = getSkillsForEvent("scheduled.task");
    expect(skills).toContain("context");
    expect(skills).toContain("today");
    expect(skills).toContain("notify");
    expect(skills).toContain("schedule");
    expect(skills).toContain("external-services");
  });

  it("loads only context + project-doc for git.project.retemplate (no ALL_SKILLS fallback)", () => {
    // The dashboard "Apply current template" action enqueues a
    // git.project.retemplate scheduled task. Without an explicit manifest
    // entry the resolver falls back to ALL_SKILLS (18 skills), bloating
    // a quality-sensitive one-shot template re-conform with mail / notion
    // / today / observations / etc. that the task-flow never references.
    // Pin the tailored set so a future EVENT_SKILL_SETS edit cannot
    // silently regress it. See agent-assets/task-flows/git.project.retemplate.md.
    const skills = getSkillsForEvent("git.project.retemplate");
    expect(skills).toEqual(["context", "project-doc"]);
  });

  it("returns all skills for unknown event type", () => {
    const skills = getSkillsForEvent("unknown.type");
    // docs/design/appendices/skills-improvement.md §9-§11 merged travel +
    // receipts → gmail-lifestyle; §14 merged
    // management-task-{register,modify,stop} → managed-tasks. Net
    // skill count drops from 26 to 21 (base) + 4 = 25 total. P3
    // adds `browser-history` (BROWSER_HISTORY_INTEGRATION_PLAN) → 26.
    // P3c (seventh-pass) adds `browser-history-respond` (narrow accept
    // surface loaded only for message.received.dm) → 27.
    // BROWSER_TASK_REDESIGN_PLAN.md §10 / Phase 5 adds `browser-task`
    // (DM-driven entry to the open-ended browser sub-agent) → 28.
    // Scheduling split adds `agent-create` (author a recurring Agent when the
    // user asks for an ongoing cadence; `/schedule` is one-shot only) → 29.
    // BACKGROUND_TASK_RUNNER_DESIGN.md §5 / Phase 3 adds `background-task`
    // (spawn) + `background-task-reply` (clarify relay) → 31.
    // unified-task-board.md L0/L1 adds `board` (read inventory + blast-radius)
    // + `task` (unified write facade) → 33.
    // NOTE: operating playbooks are NOT a skill (AGENT_PROMPT_QUALITY_DESIGN.md
    // §4 — injection is the single delivery), so they add nothing to this count.
    expect(skills).toHaveLength(34);
    expect(skills).toContain("background-task");
    expect(skills).toContain("background-task-reply");
    expect(skills).toContain("agent-create");
    expect(skills).toContain("context");
    expect(skills).toContain("today");
    expect(skills).toContain("user-profile");
    expect(skills).toContain("user-interview");
    expect(skills).toContain("notify");
    expect(skills).toContain("schedule");
    expect(skills).toContain("observations");
    expect(skills).toContain("attach");
    expect(skills).toContain("external-services");
    expect(skills).toContain("mail");
    expect(skills).toContain("notion");
    expect(skills).toContain("gmail-lifestyle");
    expect(skills).toContain("roadmap");
    expect(skills).toContain("management-policy");
    expect(skills).toContain("managed-tasks");
    expect(skills).toContain("scheduled-managed-task");
    expect(skills).toContain("project-doc");
    expect(skills).toContain("wiki-vault-rules");
    expect(skills).toContain("wiki-ingest");
    expect(skills).toContain("wiki-compile");
    expect(skills).toContain("wiki-ask");
    expect(skills).toContain("wiki-lint");
    expect(skills).toContain("wiki-trace");
    expect(skills).toContain("wiki-connect");
    expect(skills).toContain("wiki-graduate");
    expect(skills).toContain("browser-history");
    // Legacy slugs the merge replaced — fail loud if a regression
    // ever reintroduces them as separate entries.
    expect(skills).not.toContain("travel");
    expect(skills).not.toContain("travel-time");
    expect(skills).not.toContain("receipts");
    expect(skills).not.toContain("management-task-register");
    expect(skills).not.toContain("management-task-modify");
    expect(skills).not.toContain("management-task-stop");
  });

  // ── Coverage invariant ──
  // Every skill in ALL_SKILLS must appear in at least one EVENT_SKILL_SETS
  // entry. A skill that exists but is never assigned is dead weight and
  // suggests a manifest gap.
  it("assigns every skill in ALL_SKILLS to at least one event type", () => {
    const allSkills = getSkillsForEvent("unknown.type"); // fallback = ALL_SKILLS
    const assignedSkills = new Set<string>();
    for (const eventType of [
      // morning_routine_initial retired by Phase 7 (2026-05-16); the
      // first-run branch routes through morning_routine_today (Stage A)
      // which exercises every skill the legacy initial bundle did.
      "routine.morning_routine", "routine.morning_routine_today", "routine.morning_routine_journal",
      "routine.evening_review", "routine.weekly_review", "routine.monthly_review",
      "routine.activity_scan", "routine.roadmap_refresh",
      "message.received", "message.received.dm_first", "message.received.dm",
      "schedule.approaching", "scheduled.task",
      "setup.initial", "setup.update",
      // project-doc lives here — without these the coverage invariant
      // flags it as dead weight (see git project lifecycle phase 3).
      "git.project.init", "git.project.update", "git.lifecycle.poll",
      // Wiki Phase 1 + Phase 3 — every wiki-* skill is loaded only by
      // its companion wiki.* event. Without these the coverage invariant
      // flags wiki-vault-rules / wiki-ingest / wiki-compile / wiki-ask /
      // wiki-graduate / wiki-lint / wiki-trace / wiki-connect as dead
      // weight even though each is wired through EVENT_SKILL_SETS.
      "wiki.ingest_url", "wiki.compile", "wiki.ask",
      "wiki.lint", "wiki.trace", "wiki.connect",
      // BROWSER_HISTORY_INTEGRATION_PLAN P3 — the three research process
      // keys each load the `browser-history` skill. Without these
      // entries the coverage invariant flags it as dead weight.
      "routine.research_cluster_update",
      "routine.research_dispatch",
      "routine.research_wiki_summary",
    ]) {
      for (const skill of getSkillsForEvent(eventType)) {
        assignedSkills.add(skill);
      }
    }
    for (const skill of allSkills) {
      expect(assignedSkills, `skill "${skill}" is in ALL_SKILLS but not assigned to any event`).toContain(skill);
    }
  });
});

describe("createSessionWorkdir", () => {
  let fakeProjectRoot: string;
  let createdDirs: string[];

  beforeEach(() => {
    fakeProjectRoot = join(tmpdir(), `pa-test-root-${Date.now()}`);
    createdDirs = [];

    // Create fake skills. docs/design/appendices/skills-unification.md Phase 1 — every
    // SKILL.md ships frontmatter (name + description) so the per-backend
    // dir copy lands in the rendered `<skill-index>` block.
    const skillsDir = join(fakeProjectRoot, "agent-assets", "skills");
    for (const name of ["context", "today", "user-profile", "notify", "schedule", "observations", "external-services"]) {
      const dir = join(skillsDir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: synthetic ${name} skill for workdir tests.\n---\n\n# ${name} skill content\n`,
      );
    }

    // Create agent profiles
    const profilesDir = join(fakeProjectRoot, "agent-assets", "agent-profiles");
    mkdirSync(profilesDir, { recursive: true });
    for (const [name, content] of Object.entries(PROFILE_CONTENTS)) {
      writeFileSync(join(profilesDir, `${name}.md`), content);
    }
    writeFileSync(join(profilesDir, "_safety.md"), SAFETY_PREAMBLE);
  });

  afterEach(() => {
    for (const dir of createdDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    rmSync(fakeProjectRoot, { recursive: true, force: true });
  });

  it("creates a temp directory with selected skills", () => {
    const sessionDir = createSessionWorkdir(fakeProjectRoot, "message.received");
    createdDirs.push(sessionDir);

    expect(existsSync(join(sessionDir, ".claude", "skills", "user-profile", "SKILL.md"))).toBe(true);
    expect(existsSync(join(sessionDir, ".claude", "skills", "notify", "SKILL.md"))).toBe(true);
    expect(existsSync(join(sessionDir, ".claude", "skills", "external-services", "SKILL.md"))).toBe(true);

    // message.received includes both context and schedule (§3.3)
    expect(existsSync(join(sessionDir, ".claude", "skills", "context", "SKILL.md"))).toBe(true);
    expect(existsSync(join(sessionDir, ".claude", "skills", "schedule", "SKILL.md"))).toBe(true);
  });

  it("includes context in DM workdirs", () => {
    const sessionDir = createSessionWorkdir(fakeProjectRoot, "message.received.dm_first");
    createdDirs.push(sessionDir);

    expect(existsSync(join(sessionDir, ".claude", "skills", "context", "SKILL.md"))).toBe(true);
    expect(existsSync(join(sessionDir, ".claude", "skills", "user-profile", "SKILL.md"))).toBe(true);
  });

  it("copies conversational profile with safety preamble for message.received", () => {
    const sessionDir = createSessionWorkdir(fakeProjectRoot, "message.received");
    createdDirs.push(sessionDir);

    const content = readFileSync(join(sessionDir, "CLAUDE.md"), "utf-8");
    expect(content).toContain("# Conversational Agent");
    expect(content).toContain("Safety Invariants");
  });

  it("copies routine profile with safety preamble for morning routine", () => {
    const sessionDir = createSessionWorkdir(fakeProjectRoot, "routine.morning_routine");
    createdDirs.push(sessionDir);

    const content = readFileSync(join(sessionDir, "CLAUDE.md"), "utf-8");
    expect(content).toContain("# Routine Agent");
    expect(content).toContain("Safety Invariants");
  });

  it("copies routine profile for routine.activity_scan", () => {
    const sessionDir = createSessionWorkdir(fakeProjectRoot, "routine.activity_scan");
    createdDirs.push(sessionDir);

    const content = readFileSync(join(sessionDir, "CLAUDE.md"), "utf-8");
    expect(content).toContain("# Routine Agent");
    expect(content).toContain("Safety Invariants");
  });

  it("copies task profile for scheduled.task", () => {
    const sessionDir = createSessionWorkdir(fakeProjectRoot, "scheduled.task");
    createdDirs.push(sessionDir);

    const content = readFileSync(join(sessionDir, "CLAUDE.md"), "utf-8");
    expect(content).toContain("# Task Agent");
    expect(content).toContain("Safety Invariants");
  });

  it("copies conversational profile for setup.initial", () => {
    const sessionDir = createSessionWorkdir(fakeProjectRoot, "setup.initial");
    createdDirs.push(sessionDir);

    const content = readFileSync(join(sessionDir, "CLAUDE.md"), "utf-8");
    expect(content).toContain("# Conversational Agent");
    expect(content).toContain("Safety Invariants");
  });

  it("copies task profile (default) for unknown event types", () => {
    const sessionDir = createSessionWorkdir(fakeProjectRoot, "unknown.event");
    createdDirs.push(sessionDir);

    const content = readFileSync(join(sessionDir, "CLAUDE.md"), "utf-8");
    expect(content).toContain("# Task Agent");
    expect(content).toContain("Safety Invariants");
  });

  // ── CLI backend instruction file tests (AGENTS.md / GEMINI.md) ──

  it("generates AGENTS.md for Codex backend with safety, behavioral rules, and inlined skills", () => {
    const sessionDir = createSessionWorkdir(fakeProjectRoot, "scheduled.task", undefined, {
      backendId: "codex",
      processKey: "agent.task",
    });
    createdDirs.push(sessionDir);

    const content = readFileSync(join(sessionDir, "AGENTS.md"), "utf-8");
    // Safety preamble at top level
    expect(content).toContain("Safety Invariants");
    // Behavioral rules section with WhatsApp prefix
    expect(content).toContain("## Behavioral rules");
    expect(content).toContain("WhatsApp outbound messages are prefixed by the daemon");
    // Profile content inlined
    expect(content).toContain("# Task Agent");
    expect(content).toContain("## Daemon API Usage");
    expect(content).toContain("Use plain `curl` for daemon API calls.");
    // Codex-specific read-sensitive warning, hoisted ABOVE the skills so
    // the agent sees the constraint before the first inlined skill body.
    expect(content).toContain("Read-sensitive endpoints are UNAVAILABLE");
    expect(content).toContain("Codex sessions do not receive the read-sensitive daemon token");
    expect(content.indexOf("## Daemon API Usage")).toBeGreaterThan(0);
    expect(content.indexOf("## Daemon API Usage"))
      .toBeLessThan(content.indexOf("## Skills"));
    // docs/design/appendices/skills-unification.md Phase 1 — bodies live in `.codex/skills/`
    // and are read on demand; instruction file carries the preamble +
    // `<skill-index>` block only.
    expect(content).toContain("## Skills");
    expect(content).toContain("<skill-index>");
    expect(content).toContain("- name: context");
    // No CLAUDE.md should be created for Codex
    expect(existsSync(join(sessionDir, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(sessionDir, ".pa", "bin", "pa-api"))).toBe(true);
    expect(existsSync(join(sessionDir, ".pa", "bin", "curl"))).toBe(true);
    // Skills copied to .codex/skills/ for native CLI skill discovery
    expect(existsSync(join(sessionDir, ".codex", "skills", "context", "SKILL.md"))).toBe(true);
    expect(existsSync(join(sessionDir, ".codex", "skills", "schedule", "SKILL.md"))).toBe(true);
    // No Claude-specific skill dirs
    expect(existsSync(join(sessionDir, ".claude", "skills", "context", "SKILL.md"))).toBe(false);
  });

  it("generates GEMINI.md for Gemini backend", () => {
    const sessionDir = createSessionWorkdir(fakeProjectRoot, "routine.activity_scan", undefined, {
      backendId: "gemini",
      processKey: "routine.activity_scan",
    });
    createdDirs.push(sessionDir);

    const content = readFileSync(join(sessionDir, "GEMINI.md"), "utf-8");
    expect(content).toContain("Safety Invariants");
    expect(content).toContain("## Behavioral rules");
    expect(content).toContain("# Routine Agent");
    expect(content).toContain("## Daemon API Usage");
    expect(content).toContain("auto-attaches session auth for read-sensitive endpoints");
    // Daemon-API note hoisted above the skills section for both CLI
    // backends so the rendered file shape is uniform.
    expect(content.indexOf("## Daemon API Usage"))
      .toBeLessThan(content.indexOf("## Skills"));
    // Gemini does NOT carry the Codex-only "UNAVAILABLE" warning — its
    // session does receive the read-sensitive token.
    expect(content).not.toContain("Read-sensitive endpoints are UNAVAILABLE");
    // docs/design/appendices/skills-unification.md Phase 1 — skill listing moved from
    // `### <slug>` inline-body sections into the `<skill-index>` block.
    expect(content).toContain("<skill-index>");
    expect(content).toContain("- name: observations");
    expect(content).toContain("- name: external-services");
    expect(existsSync(join(sessionDir, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(sessionDir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(sessionDir, ".pa", "bin", "pa-api"))).toBe(true);
    expect(existsSync(join(sessionDir, ".pa", "bin", "curl"))).toBe(true);
    // Skills copied to .gemini/skills/ for native CLI skill discovery
    expect(existsSync(join(sessionDir, ".gemini", "skills", "observations", "SKILL.md"))).toBe(true);
    expect(existsSync(join(sessionDir, ".gemini", "skills", "external-services", "SKILL.md"))).toBe(true);
  });

  it("does not inline skill bodies into the CLI instruction file (docs/design/appendices/skills-unification.md Phase 1)", () => {
    const skillPath = join(fakeProjectRoot, "agent-assets", "skills", "context", "SKILL.md");
    writeFileSync(
      skillPath,
      "---\nname: context\ndescription: Context file API reference.\nallowed-tools:\n  - Bash(curl *)\n---\n\n# Context skill body",
    );

    const sessionDir = createSessionWorkdir(fakeProjectRoot, "routine.morning_routine", undefined, {
      backendId: "codex",
      processKey: "routine.morning_routine",
    });
    createdDirs.push(sessionDir);

    const content = readFileSync(join(sessionDir, "AGENTS.md"), "utf-8");
    // Skill body is NOT inlined — it lives in `.codex/skills/context/SKILL.md`
    // and is read on demand. The `<skill-index>` lists name + description.
    expect(content).not.toContain("# Context skill body");
    expect(content).toContain("<skill-index>");
    expect(content).toContain("- name: context");
    expect(content).toContain("description: Context file API reference.");
  });

  it("keeps source SKILL.md frontmatter byte-identical in the CLI skill dir (R6 — adaptSkillForCli deleted)", () => {
    const skillPath = join(fakeProjectRoot, "agent-assets", "skills", "context", "SKILL.md");
    writeFileSync(
      skillPath,
      "---\nname: context\ndescription: Context file API reference.\nallowed-tools:\n  - Bash(curl *)\n  - Read\n---\n\n# Context skill body",
    );

    const sessionDir = createSessionWorkdir(fakeProjectRoot, "routine.morning_routine", undefined, {
      backendId: "codex",
      processKey: "routine.morning_routine",
    });
    createdDirs.push(sessionDir);

    const adapted = readFileSync(join(sessionDir, ".codex", "skills", "context", "SKILL.md"), "utf-8");
    // docs/design/appendices/skills-unification.md Phase 1 §R6 — `adaptSkillForCli` is gone.
    // The source frontmatter is byte-identical across all backends; Codex
    // tolerates the `allowed-tools` block as unknown YAML.
    expect(adapted).toContain("name: context");
    expect(adapted).toContain("description: Context file API reference.");
    expect(adapted).toContain("allowed-tools");
    expect(adapted).toContain("Bash(curl *)");
    // Body preserved.
    expect(adapted).toContain("# Context skill body");
  });

  it("copies skill supporting files to CLI skill directories", () => {
    const contextDir = join(fakeProjectRoot, "agent-assets", "skills", "context");
    mkdirSync(join(contextDir, "scripts"), { recursive: true });
    writeFileSync(join(contextDir, "scripts", "helper.sh"), "#!/bin/sh\necho helper");

    const sessionDir = createSessionWorkdir(fakeProjectRoot, "routine.morning_routine", undefined, {
      backendId: "gemini",
      processKey: "routine.morning_routine",
    });
    createdDirs.push(sessionDir);

    // Supporting files are also copied to .gemini/skills/
    expect(existsSync(join(sessionDir, ".gemini", "skills", "context", "scripts", "helper.sh"))).toBe(true);
    expect(readFileSync(join(sessionDir, ".gemini", "skills", "context", "scripts", "helper.sh"), "utf-8")).toBe(
      "#!/bin/sh\necho helper",
    );
  });

  it("copies skill content correctly", () => {
    const sessionDir = createSessionWorkdir(fakeProjectRoot, "routine.morning_routine");
    createdDirs.push(sessionDir);

    const content = readFileSync(
      join(sessionDir, ".claude", "skills", "context", "SKILL.md"),
      "utf-8",
    );
    // docs/design/appendices/skills-unification.md Phase 1 — frontmatter flows through
    // byte-identically; body is preserved verbatim under it.
    expect(content).toContain("name: context");
    expect(content).toContain("# context skill content");
  });

  it("includes all skills for unknown event types", () => {
    const sessionDir = createSessionWorkdir(fakeProjectRoot, "unknown.event");
    createdDirs.push(sessionDir);

    expect(existsSync(join(sessionDir, ".claude", "skills", "context", "SKILL.md"))).toBe(true);
    expect(existsSync(join(sessionDir, ".claude", "skills", "user-profile", "SKILL.md"))).toBe(true);
    expect(existsSync(join(sessionDir, ".claude", "skills", "external-services", "SKILL.md"))).toBe(true);
  });

  it("skips missing skills gracefully", () => {
    rmSync(join(fakeProjectRoot, "agent-assets", "skills", "notify"), { recursive: true });

    const sessionDir = createSessionWorkdir(fakeProjectRoot, "routine.evening_review");
    createdDirs.push(sessionDir);

    expect(existsSync(join(sessionDir, ".claude", "skills", "notify"))).toBe(false);
    expect(existsSync(join(sessionDir, ".claude", "skills", "context", "SKILL.md"))).toBe(true);
  });

  it("copies skill supporting files (scripts/) recursively", () => {
    // Skills may bundle scripts or other supporting files alongside SKILL.md.
    // The workdir loader must copy them so the agent can read them on demand.
    const contextDir = join(fakeProjectRoot, "agent-assets", "skills", "context");
    mkdirSync(join(contextDir, "scripts"), { recursive: true });
    writeFileSync(join(contextDir, "scripts", "helper.sh"), "#!/bin/sh\necho helper");
    writeFileSync(join(contextDir, "scripts", "validate.sh"), "#!/bin/sh\necho validate");

    const sessionDir = createSessionWorkdir(fakeProjectRoot, "routine.morning_routine");
    createdDirs.push(sessionDir);

    const destContext = join(sessionDir, ".claude", "skills", "context");
    expect(existsSync(join(destContext, "SKILL.md"))).toBe(true);
    expect(existsSync(join(destContext, "scripts", "helper.sh"))).toBe(true);
    expect(existsSync(join(destContext, "scripts", "validate.sh"))).toBe(true);
    expect(readFileSync(join(destContext, "scripts", "helper.sh"), "utf-8")).toBe(
      "#!/bin/sh\necho helper",
    );
  });

  it("handles missing profile gracefully (no CLAUDE.md created)", () => {
    rmSync(join(fakeProjectRoot, "agent-assets", "agent-profiles", "routine.md"));

    const sessionDir = createSessionWorkdir(fakeProjectRoot, "routine.activity_scan");
    createdDirs.push(sessionDir);

    expect(existsSync(join(sessionDir, "CLAUDE.md"))).toBe(false);
    // Session dir itself should still exist
    expect(existsSync(sessionDir)).toBe(true);
  });

  it("copies user-authored skills when userSkillsDir is provided", () => {
    // Plant a user skill outside the project tree
    const userSkillsDir = join(tmpdir(), `pa-user-skills-${Date.now()}`);
    const userSkillDir = join(userSkillsDir, "my-digest");
    mkdirSync(userSkillDir, { recursive: true });
    writeFileSync(
      join(userSkillDir, "SKILL.md"),
      `---\nname: my-digest\ndescription: "User digest"\n---\n\n# Body\n`,
    );

    try {
      const sessionDir = createSessionWorkdir(
        fakeProjectRoot,
        "message.received",
        userSkillsDir,
      );
      createdDirs.push(sessionDir);

      // Built-in still copied
      expect(existsSync(join(sessionDir, ".claude", "skills", "user-profile", "SKILL.md"))).toBe(true);
      // User skill also copied
      expect(existsSync(join(sessionDir, ".claude", "skills", "my-digest", "SKILL.md"))).toBe(true);
      const copied = readFileSync(join(sessionDir, ".claude", "skills", "my-digest", "SKILL.md"), "utf-8");
      expect(copied).toContain("name: my-digest");
    } finally {
      rmSync(userSkillsDir, { recursive: true, force: true });
    }
  });

  it("silently ignores missing userSkillsDir", () => {
    const sessionDir = createSessionWorkdir(
      fakeProjectRoot,
      "message.received",
      join(tmpdir(), `pa-nonexistent-${Date.now()}`),
    );
    createdDirs.push(sessionDir);
    expect(existsSync(join(sessionDir, ".claude", "skills", "user-profile", "SKILL.md"))).toBe(true);
  });

  it("does NOT provision user skills into narrow-persona sessions (wiki / research)", () => {
    // Plant a user skill, then materialise a wiki.compile and a
    // routine.research_dispatch session. Both run dedicated personas with
    // tight built-in manifests; the owner's general skill library must not
    // land there (neither the `.claude/skills/` tree nor the `skills/` docs
    // layer). See `eventTypeAcceptsUserSkills`.
    const userSkillsDir = join(tmpdir(), `pa-user-skills-narrow-${Date.now()}`);
    const userSkillDir = join(userSkillsDir, "my-digest");
    mkdirSync(userSkillDir, { recursive: true });
    writeFileSync(
      join(userSkillDir, "SKILL.md"),
      `---\nname: my-digest\ndescription: "User digest"\n---\n\n# Body\n`,
    );

    try {
      for (const key of ["wiki.compile", "routine.research_dispatch"] as const) {
        const sessionDir = createSessionWorkdir(
          fakeProjectRoot,
          key,
          userSkillsDir,
          { processKey: key },
        );
        createdDirs.push(sessionDir);

        expect(
          existsSync(join(sessionDir, ".claude", "skills", "my-digest", "SKILL.md")),
        ).toBe(false);
        expect(
          existsSync(join(sessionDir, "skills", "my-digest", "SKILL.md")),
        ).toBe(false);
      }

      // Control: a conversational session with the SAME library DOES get it,
      // proving the absence above is the gate, not a planting mistake.
      const dmDir = createSessionWorkdir(
        fakeProjectRoot,
        "message.received",
        userSkillsDir,
      );
      createdDirs.push(dmDir);
      expect(
        existsSync(join(dmDir, ".claude", "skills", "my-digest", "SKILL.md")),
      ).toBe(true);
    } finally {
      rmSync(userSkillsDir, { recursive: true, force: true });
    }
  });

  it("does not let user skills clobber built-ins on name collision", () => {
    // A well-behaved API rejects collisions, but defense in depth —
    // if a user skill ever ended up with a built-in's name, the built-in wins.
    const userSkillsDir = join(tmpdir(), `pa-collision-${Date.now()}`);
    const collidingDir = join(userSkillsDir, "context");
    mkdirSync(collidingDir, { recursive: true });
    writeFileSync(
      join(collidingDir, "SKILL.md"),
      `---\nname: context\ndescription: "hijacked"\n---\n\n# HIJACKED\n`,
    );

    try {
      const sessionDir = createSessionWorkdir(
        fakeProjectRoot,
        "routine.morning_routine",
        userSkillsDir,
      );
      createdDirs.push(sessionDir);

      const content = readFileSync(
        join(sessionDir, ".claude", "skills", "context", "SKILL.md"),
        "utf-8",
      );
      // Built-in survives — body unchanged, HIJACKED never lands. The
      // frontmatter prefix is the Phase 1 schema (name + description).
      expect(content).toContain("# context skill content");
      expect(content).not.toContain("HIJACKED");
    } finally {
      rmSync(userSkillsDir, { recursive: true, force: true });
    }
  });
});

describe("ensureSessionWorkdir", () => {
  let fakeProjectRoot: string;
  let fakeDataDir: string;

  beforeEach(() => {
    fakeProjectRoot = join(tmpdir(), `pa-test-resume-root-${Date.now()}`);
    fakeDataDir = join(tmpdir(), `pa-test-data-${Date.now()}`);
    mkdirSync(fakeDataDir, { recursive: true });

    // Create skills
    const skillsDir = join(fakeProjectRoot, "agent-assets", "skills");
    for (const name of ["context", "today", "user-profile", "external-services"]) {
      const dir = join(skillsDir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `# ${name} skill content`);
    }

    // Create agent profiles
    const profilesDir = join(fakeProjectRoot, "agent-assets", "agent-profiles");
    mkdirSync(profilesDir, { recursive: true });
    writeFileSync(join(profilesDir, "conversational.md"), PROFILE_CONTENTS.conversational);
    writeFileSync(join(profilesDir, "_safety.md"), SAFETY_PREAMBLE);
  });

  afterEach(() => {
    rmSync(fakeProjectRoot, { recursive: true, force: true });
    rmSync(fakeDataDir, { recursive: true, force: true });
  });

  it("creates a deterministic path based on session ID", () => {
    const dir = ensureSessionWorkdir(fakeProjectRoot, fakeDataDir, 42, "setup.initial");
    expect(dir).toBe(join(fakeDataDir, "agent-sessions", "42"));
    expect(existsSync(dir)).toBe(true);
  });

  it("copies skills and CLAUDE.md on first call", () => {
    const dir = ensureSessionWorkdir(fakeProjectRoot, fakeDataDir, 1, "setup.initial");

    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
    const content = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
    expect(content).toContain("# Conversational Agent");
    expect(content).toContain("Safety Invariants");
    expect(existsSync(join(dir, ".claude", "skills", "user-profile", "SKILL.md"))).toBe(true);
    // setup.initial's skill manifest is intentionally minimal —
    // external-services is NOT materialised for this event because the
    // task-flow never touches /api/calendar, /api/obsidian, /api/github,
    // or /api/skills. Pin the negative assertion so a future broaden
    // doesn't silently re-introduce a ~1k-line skill body for Codex.
    expect(existsSync(join(dir, ".claude", "skills", "external-services", "SKILL.md"))).toBe(false);
  });

  it("copies user-profile for setup.update sessions", () => {
    const dir = ensureSessionWorkdir(fakeProjectRoot, fakeDataDir, 3, "setup.update");
    expect(existsSync(join(dir, ".claude", "skills", "user-profile", "SKILL.md"))).toBe(true);
  });

  it("copies context for persistent DM workdirs", () => {
    const dir = ensureSessionWorkdir(fakeProjectRoot, fakeDataDir, 4, "message.received.dm");
    expect(existsSync(join(dir, ".claude", "skills", "context", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, ".claude", "skills", "user-profile", "SKILL.md"))).toBe(true);
  });

  it("recursively copies supporting files for persistent workdir", () => {
    // Use `user-profile` as the recursive-copy fixture — it is in
    // setup.initial's skill manifest, so the skill directory is
    // guaranteed to be materialised. (Pre-trim this test used
    // `external-services`, which is no longer in the setup.initial
    // manifest.)
    const upDir = join(fakeProjectRoot, "agent-assets", "skills", "user-profile");
    mkdirSync(join(upDir, "scripts"), { recursive: true });
    writeFileSync(join(upDir, "scripts", "setup.sh"), "#!/bin/sh\necho setup");

    const dir = ensureSessionWorkdir(fakeProjectRoot, fakeDataDir, 99, "setup.initial");

    expect(existsSync(join(dir, ".claude", "skills", "user-profile", "scripts", "setup.sh"))).toBe(true);
    expect(readFileSync(join(dir, ".claude", "skills", "user-profile", "scripts", "setup.sh"), "utf-8")).toBe(
      "#!/bin/sh\necho setup",
    );
  });

  it("is a no-op on second call (resume)", () => {
    const dir1 = ensureSessionWorkdir(fakeProjectRoot, fakeDataDir, 7, "setup.initial");
    const dir2 = ensureSessionWorkdir(fakeProjectRoot, fakeDataDir, 7, "setup.initial");
    expect(dir1).toBe(dir2);
  });

  it("repairs helper binaries when reusing an existing session workdir", () => {
    const dir = ensureSessionWorkdir(fakeProjectRoot, fakeDataDir, 8, "message.received.dm");
    rmSync(join(dir, ".pa"), { recursive: true, force: true });

    ensureSessionWorkdir(fakeProjectRoot, fakeDataDir, 8, "message.received.dm");

    expect(existsSync(join(dir, ".pa", "bin", "pa-api"))).toBe(true);
    expect(existsSync(join(dir, ".pa", "bin", "curl"))).toBe(true);
  });

  it("different session IDs get different directories", () => {
    const dir1 = ensureSessionWorkdir(fakeProjectRoot, fakeDataDir, 1, "message.received");
    const dir2 = ensureSessionWorkdir(fakeProjectRoot, fakeDataDir, 2, "message.received");
    expect(dir1).not.toBe(dir2);
  });

  it("copies user-authored skills from <contextDir>/policies/skills/", () => {
    // CONTEXT_VAULT_REDESIGN_PLAN.md v4 V11 — user skills root is now
    // `<contextDir>/policies/skills`. The workdir fallback (when
    // `options.contextDir` is omitted) derives from `<dataDir>/context`
    // — the default plain-mode vault location.
    const userSkillDir = join(
      fakeDataDir,
      "context",
      "policies",
      "skills",
      "my-digest",
    );
    mkdirSync(userSkillDir, { recursive: true });
    writeFileSync(
      join(userSkillDir, "SKILL.md"),
      `---\nname: my-digest\ndescription: "User digest"\n---\n\n# Body\n`,
    );

    const dir = ensureSessionWorkdir(fakeProjectRoot, fakeDataDir, 100, "message.received");

    // User skill landed in the persistent workdir's .claude/skills tree
    expect(existsSync(join(dir, ".claude", "skills", "my-digest", "SKILL.md"))).toBe(true);
    // Built-ins still present
    expect(existsSync(join(dir, ".claude", "skills", "user-profile", "SKILL.md"))).toBe(true);
  });

  it("is resilient when <contextDir>/policies/skills/ doesn't exist", () => {
    // No user skills dir at all — should not throw
    const dir = ensureSessionWorkdir(fakeProjectRoot, fakeDataDir, 101, "message.received");
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, ".claude", "skills", "user-profile", "SKILL.md"))).toBe(true);
  });

  it("does NOT copy user skills into a narrow-persona persistent workdir (wiki / research)", () => {
    // Same library, same dataDir as the DM test above — but a wiki.compile
    // session (and a research_dispatch session) must skip it. See
    // `eventTypeAcceptsUserSkills`.
    const userSkillDir = join(
      fakeDataDir,
      "context",
      "policies",
      "skills",
      "my-digest",
    );
    mkdirSync(userSkillDir, { recursive: true });
    writeFileSync(
      join(userSkillDir, "SKILL.md"),
      `---\nname: my-digest\ndescription: "User digest"\n---\n\n# Body\n`,
    );

    const wikiDir = ensureSessionWorkdir(
      fakeProjectRoot,
      fakeDataDir,
      110,
      "wiki.compile",
      { processKey: "wiki.compile" },
    );
    expect(
      existsSync(join(wikiDir, ".claude", "skills", "my-digest", "SKILL.md")),
    ).toBe(false);

    const researchDir = ensureSessionWorkdir(
      fakeProjectRoot,
      fakeDataDir,
      111,
      "routine.research_dispatch",
      { processKey: "routine.research_dispatch" },
    );
    expect(
      existsSync(join(researchDir, ".claude", "skills", "my-digest", "SKILL.md")),
    ).toBe(false);
  });

  it("fallback simulation: ensureBackendMaterialized + syncAllUserSkills populates user skills in fallback dir", () => {
    // Simulate the full fallback lifecycle:
    // 1. Session created for Claude (main)
    // 2. User skills synced (dispatcher does this BEFORE router.execute)
    // 3. Main fails → ensureBackendMaterialized for Codex (creates .codex/skills/)
    // 4. syncAllUserSkills again (the fix: re-sync picks up newly created .codex/skills/)

    // Plant a user skill at the canonical CONTEXT_VAULT_REDESIGN location.
    const userSkillsRoot = join(fakeDataDir, "context", "policies", "skills");
    const userSkillDir = join(userSkillsRoot, "my-digest");
    mkdirSync(userSkillDir, { recursive: true });
    writeFileSync(
      join(userSkillDir, "SKILL.md"),
      `---\nname: my-digest\ndescription: "User digest"\n---\n\n# Body\n`,
    );

    // Step 1: Create session for Claude (main backend)
    const dir = ensureSessionWorkdir(fakeProjectRoot, fakeDataDir, 200, "message.received.dm");
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(dir, ".claude", "skills", "my-digest", "SKILL.md"))).toBe(true);
    // Codex dirs don't exist yet
    expect(existsSync(join(dir, ".codex", "skills"))).toBe(false);

    // Step 2: syncAllUserSkills (dispatcher calls this before router.execute)
    syncAllUserSkills(dir, userSkillsRoot);
    // .codex/skills/ still doesn't exist, so user skills not synced there
    expect(existsSync(join(dir, ".codex", "skills"))).toBe(false);

    // Step 3: Main fails → ensureBackendMaterialized creates Codex dirs
    ensureBackendMaterialized(fakeProjectRoot, dir, "codex", "message.received.dm", "message.dm");
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(dir, ".codex", "skills"))).toBe(true);
    // Built-in skills are in .codex/skills/
    expect(existsSync(join(dir, ".codex", "skills", "context", "SKILL.md"))).toBe(true);
    // But user skill is NOT yet in .codex/skills/ — only built-ins from materialization
    expect(existsSync(join(dir, ".codex", "skills", "my-digest", "SKILL.md"))).toBe(false);

    // Step 4: syncAllUserSkills again (the fix in index.ts callback)
    syncAllUserSkills(dir, userSkillsRoot);
    // Now user skills should be in .codex/skills/ too
    expect(existsSync(join(dir, ".codex", "skills", "my-digest", "SKILL.md"))).toBe(true);
    const content = readFileSync(join(dir, ".codex", "skills", "my-digest", "SKILL.md"), "utf-8");
    expect(content).toContain("name: my-digest");
  });

  /**
   * docs/design/appendices/skills-unification.md Phase 1 §R4 — `syncAllUserSkills` must
   * refresh the `<skill-index>` block in the CLI instruction file so a
   * freshly synced user-authored skill is discoverable on the next turn.
   *
   * Pre-fix the dispatcher's per-turn `syncAllUserSkills` call (resume
   * + fresh-execute branches in `dispatcher-message-handler.ts`) copied
   * the SKILL.md into `.codex/skills/<slug>/` but left the AGENTS.md
   * `<skill-index>` listing stale, so a user who PUT a new skill mid-
   * session would not see Codex/Gemini load it until the workdir was
   * re-materialised.
   *
   * Regression pin: this test simulates the "user adds a skill between
   * turns" flow against a Codex session and asserts both the on-disk
   * tree AND the in-instruction-file index land in one syncAllUserSkills
   * call. Mirrored for Gemini below.
   */
  it("syncAllUserSkills refreshes `<skill-index>` on Codex so mid-session user skills are agent-discoverable", () => {
    // Materialise a Codex session against the synthetic project tree.
    // beforeEach has already planted built-ins (context, today, etc.)
    // and the `conversational` profile.
    const dir = ensureSessionWorkdir(
      fakeProjectRoot,
      fakeDataDir,
      500,
      "message.received.dm",
      { backendId: "codex", processKey: "message.dm" },
    );
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
    const before = readFileSync(join(dir, "AGENTS.md"), "utf-8");
    expect(before).toContain("<skill-index>");
    expect(before).not.toContain("- name: mid-session-skill");

    // User PUTs a new skill mid-session — lands in `{dataDir}/skills/`.
    const newSkillDir = join(fakeDataDir, "skills", "mid-session-skill");
    mkdirSync(newSkillDir, { recursive: true });
    writeFileSync(
      join(newSkillDir, "SKILL.md"),
      "---\nname: mid-session-skill\ndescription: Freshly added by the user mid-session.\n---\n\nBody.\n",
      "utf-8",
    );

    // Dispatcher's per-turn sync. After my fix, this also refreshes the
    // `<skill-index>` block so the new skill is listed.
    syncAllUserSkills(dir, join(fakeDataDir, "skills"));

    expect(
      existsSync(join(dir, ".codex", "skills", "mid-session-skill", "SKILL.md")),
    ).toBe(true);
    const after = readFileSync(join(dir, "AGENTS.md"), "utf-8");
    expect(after).toContain("- name: mid-session-skill");
    expect(after).toContain("description: Freshly added by the user mid-session.");
  });

  it("syncAllUserSkills refreshes `<skill-index>` on Gemini so mid-session user skills are agent-discoverable", () => {
    const dir = ensureSessionWorkdir(
      fakeProjectRoot,
      fakeDataDir,
      501,
      "message.received.dm",
      { backendId: "gemini", processKey: "message.dm" },
    );
    expect(existsSync(join(dir, "GEMINI.md"))).toBe(true);
    const before = readFileSync(join(dir, "GEMINI.md"), "utf-8");
    expect(before).toContain("<skill-index>");

    const newSkillDir = join(fakeDataDir, "skills", "gemini-mid-session-skill");
    mkdirSync(newSkillDir, { recursive: true });
    writeFileSync(
      join(newSkillDir, "SKILL.md"),
      "---\nname: gemini-mid-session-skill\ndescription: Gemini-side mid-session skill.\n---\n\nBody.\n",
      "utf-8",
    );

    syncAllUserSkills(dir, join(fakeDataDir, "skills"));

    expect(
      existsSync(join(dir, ".gemini", "skills", "gemini-mid-session-skill", "SKILL.md")),
    ).toBe(true);
    const after = readFileSync(join(dir, "GEMINI.md"), "utf-8");
    expect(after).toContain("- name: gemini-mid-session-skill");
  });

  /**
   * `evening-review-slimdown.md` §3.5 — fallback re-materialize for
   * `routine.evening_review` MUST honour the same conditional-notify
   * predicate the main backend honoured. Without threading `contextDir`
   * through `ensureBackendMaterialized` → `materializeSessionBundle`,
   * `eveningRulebookIsActive(undefined)` evaluates to `false` and the
   * fallback session drops `notify` from the manifest even when the
   * operator's `routines/evening.md` rulebook has authored rules that
   * call `POST /api/notify` — silently breaking rulebook execution on
   * every fallback path.
   *
   * Pin both branches: with contextDir + active rulebook → notify is
   * materialized; without contextDir → notify is dropped (the conservative
   * default — also the historical bug shape, kept as a documentation
   * anchor so a future "always pass the gate" widening doesn't quietly
   * regress the conservative branch tests rely on).
   */
  it("ensureBackendMaterialized threads contextDir so the fallback path honours the evening rulebook gate (notify present)", () => {
    // Plant the assets the slim evening_review manifest needs that the
    // surrounding describe's beforeEach doesn't seed (it only plants
    // conversational + context/today/user-profile/external-services).
    const notifyDir = join(fakeProjectRoot, "agent-assets", "skills", "notify");
    mkdirSync(notifyDir, { recursive: true });
    writeFileSync(
      join(notifyDir, "SKILL.md"),
      "---\nname: notify\ndescription: synthetic notify skill for fallback test.\n---\n\n# notify skill content\n",
    );
    writeFileSync(
      join(fakeProjectRoot, "agent-assets", "agent-profiles", "routine.md"),
      PROFILE_CONTENTS.routine,
    );

    const dir = ensureSessionWorkdir(
      fakeProjectRoot,
      fakeDataDir,
      300,
      "routine.evening_review",
      { processKey: "routine.evening_review" },
    );
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);

    // Operator has authored a `### `-headed rule — rulebook ACTIVE.
    const contextDir = join(fakeDataDir, "context");
    mkdirSync(join(contextDir, "policies", "routines"), { recursive: true });
    writeFileSync(
      join(contextDir, "policies", "routines", "evening.md"),
      "### Stripe metrics\n\nDM me about churn outliers.\n",
      "utf-8",
    );

    // Fallback to Codex. With contextDir threaded, the gate evaluates
    // to active → notify is materialized into the fallback backend's dir.
    ensureBackendMaterialized(
      fakeProjectRoot,
      dir,
      "codex",
      "routine.evening_review",
      "routine.evening_review",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      contextDir,
    );
    expect(existsSync(join(dir, ".codex", "skills", "notify", "SKILL.md"))).toBe(true);
    // docs/design/appendices/skills-unification.md Phase 1 — `<skill-index>` lists notify;
    // the body is in `.codex/skills/notify/SKILL.md`, no longer inlined.
    const agentsMd = readFileSync(join(dir, "AGENTS.md"), "utf-8");
    expect(agentsMd).toMatch(/^- name: notify$/m);
  });

  it("ensureBackendMaterialized without contextDir falls back to the conservative 'rulebook inactive' branch (notify dropped)", () => {
    const notifyDir = join(fakeProjectRoot, "agent-assets", "skills", "notify");
    mkdirSync(notifyDir, { recursive: true });
    writeFileSync(
      join(notifyDir, "SKILL.md"),
      "---\nname: notify\ndescription: synthetic notify skill for fallback test.\n---\n\n# notify skill content\n",
    );
    writeFileSync(
      join(fakeProjectRoot, "agent-assets", "agent-profiles", "routine.md"),
      PROFILE_CONTENTS.routine,
    );

    const dir = ensureSessionWorkdir(
      fakeProjectRoot,
      fakeDataDir,
      301,
      "routine.evening_review",
      { processKey: "routine.evening_review" },
    );

    // Even if a rulebook exists on disk, omitting contextDir means the
    // predicate can't see it — the conservative default wins. This is
    // the documented `eveningRulebookIsActive(undefined) === false` rule.
    const contextDir = join(fakeDataDir, "context");
    mkdirSync(join(contextDir, "policies", "routines"), { recursive: true });
    writeFileSync(
      join(contextDir, "policies", "routines", "evening.md"),
      "### Stripe metrics\n\nDM me about churn outliers.\n",
      "utf-8",
    );

    ensureBackendMaterialized(
      fakeProjectRoot,
      dir,
      "codex",
      "routine.evening_review",
      "routine.evening_review",
    );
    expect(existsSync(join(dir, ".codex", "skills", "notify"))).toBe(false);
    const agentsMd = readFileSync(join(dir, "AGENTS.md"), "utf-8");
    expect(agentsMd).not.toMatch(/^###\s+notify\s*$/m);
  });

  /**
   * Per-turn override path used by custom messaging bang commands. The
   * override forces a re-materialize even when the workdir already
   * exists, and writes a stamp file so the FOLLOWING regular DM turn
   * resets the workdir back to manifest defaults — preventing a
   * `!cmd` configuration from leaking into a natural DM that follows.
   */
  describe("override path (custom bang commands)", () => {
    const STAMP = ".aitne-bang-active";

    it("force-rematerializes when override is set, ignoring the fast-path skip", () => {
      // First call: warm the workdir with manifest defaults (no override).
      ensureSessionWorkdir(fakeProjectRoot, fakeDataDir, 100, "message.received.dm");
      const dir = join(fakeDataDir, "agent-sessions", "100");
      expect(existsSync(join(dir, ".claude", "skills", "context", "SKILL.md"))).toBe(true);

      // Second call with override narrowing skills to a single slug. The
      // pre-existing `context` dir must be pruned.
      ensureSessionWorkdir(fakeProjectRoot, fakeDataDir, 100, "message.received.dm", {
        override: { skillSlugs: ["user-profile"], profileBody: null },
      });
      expect(existsSync(join(dir, ".claude", "skills", "user-profile", "SKILL.md"))).toBe(true);
      expect(existsSync(join(dir, ".claude", "skills", "context"))).toBe(false);
    });

    it("writes the bang stamp file after a successful override turn", () => {
      ensureSessionWorkdir(fakeProjectRoot, fakeDataDir, 101, "message.received.dm", {
        override: { skillSlugs: ["user-profile"], profileBody: null },
      });
      const stamp = join(fakeDataDir, "agent-sessions", "101", STAMP);
      expect(existsSync(stamp)).toBe(true);
    });

    it("the next regular DM turn resets the workdir to manifest defaults and removes the stamp", () => {
      const dir = join(fakeDataDir, "agent-sessions", "102");
      // Bang turn: narrow override.
      ensureSessionWorkdir(fakeProjectRoot, fakeDataDir, 102, "message.received.dm", {
        override: { skillSlugs: ["user-profile"], profileBody: null },
      });
      expect(existsSync(join(dir, ".claude", "skills", "user-profile", "SKILL.md"))).toBe(true);
      expect(existsSync(join(dir, ".claude", "skills", "context"))).toBe(false);
      expect(existsSync(join(dir, STAMP))).toBe(true);

      // Regular DM turn (no override) — must restore the manifest default
      // skill set and clear the stamp.
      ensureSessionWorkdir(fakeProjectRoot, fakeDataDir, 102, "message.received.dm");
      expect(existsSync(join(dir, ".claude", "skills", "context", "SKILL.md"))).toBe(true);
      expect(existsSync(join(dir, STAMP))).toBe(false);
    });

    it("a third regular DM turn after reset stays on the fast path (no rebuild work)", () => {
      const dir = join(fakeDataDir, "agent-sessions", "103");
      // Bang → reset cycle.
      ensureSessionWorkdir(fakeProjectRoot, fakeDataDir, 103, "message.received.dm", {
        override: { skillSlugs: ["user-profile"], profileBody: null },
      });
      ensureSessionWorkdir(fakeProjectRoot, fakeDataDir, 103, "message.received.dm");
      // Capture mtime, then call again — fast-path expectation: CLAUDE.md
      // mtime should be unchanged because the function no-ops on existing
      // workdirs without the stamp.
      const before = statSync(join(dir, "CLAUDE.md")).mtimeMs;
      ensureSessionWorkdir(fakeProjectRoot, fakeDataDir, 103, "message.received.dm");
      const after = statSync(join(dir, "CLAUDE.md")).mtimeMs;
      expect(after).toBe(before);
    });

    it("the override profile body lands verbatim in CLAUDE.md", () => {
      const body = "Reply with a single bullet then stop.";
      ensureSessionWorkdir(fakeProjectRoot, fakeDataDir, 104, "message.received.dm", {
        override: { skillSlugs: ["user-profile"], profileBody: body },
      });
      const claudeMd = readFileSync(
        join(fakeDataDir, "agent-sessions", "104", "CLAUDE.md"),
        "utf-8",
      );
      expect(claudeMd).toContain(body);
    });
  });

  /**
   * docs/design/appendices/skills-unification.md Phase 1 item 14 — manifest-snapshot drift
   * guard. The instruction-asset fingerprint catches *source* edits but
   * not *resolver* drift (e.g. evening rulebook activates between turns,
   * so the manifest now resolves to a different slug set even though
   * agent-assets/ is byte-identical). The per-session stamp records the
   * `(processKey, skillSlugs)` snapshot the workdir was last materialised
   * against; a delta forces re-materialisation so the per-backend dir
   * and `<skill-index>` block stay in sync with the live manifest.
   *
   * The function under test (`resolveManifestDriftAgainstStamp`) is
   * private; we drive it end-to-end via `ensureSessionWorkdir` and
   * verify side-effects via the stamp JSON file the workdir writes.
   */
  describe("manifest-drift re-materialisation (Phase 1 item 14)", () => {
    function stampPath(sessionId: number): string {
      return join(
        fakeDataDir,
        "agent-sessions",
        String(sessionId),
        ".aitne-instruction-assets.json",
      );
    }
    function readStamp(sessionId: number): {
      manifest?: { processKey: string; skillSlugs: string[] };
    } {
      return JSON.parse(readFileSync(stampPath(sessionId), "utf-8")) as {
        manifest?: { processKey: string; skillSlugs: string[] };
      };
    }

    it("records the (processKey, skillSlugs) snapshot on first materialisation", () => {
      const dir = ensureSessionWorkdir(
        fakeProjectRoot,
        fakeDataDir,
        500,
        "message.received.dm",
        { processKey: "message.dm" },
      );
      expect(existsSync(dir)).toBe(true);
      const stamp = readStamp(500);
      expect(stamp.manifest).toBeDefined();
      expect(stamp.manifest!.processKey).toBe("message.dm");
      expect(Array.isArray(stamp.manifest!.skillSlugs)).toBe(true);
      // Slugs are recorded sorted (release-assets.ts writes them
      // pre-sorted so the drift comparison can be a plain ordered scan).
      const sorted = [...stamp.manifest!.skillSlugs].sort();
      expect(stamp.manifest!.skillSlugs).toEqual(sorted);
    });

    it("forces re-materialisation when the recorded slug set diverges from the live manifest", () => {
      ensureSessionWorkdir(
        fakeProjectRoot,
        fakeDataDir,
        501,
        "message.received.dm",
        { processKey: "message.dm" },
      );
      const originalSlugs = readStamp(501).manifest!.skillSlugs;
      expect(originalSlugs.length).toBeGreaterThan(0);

      // Tamper: replace the recorded slugs with a bogus single-entry set
      // so the next call's "live vs recorded" comparison detects drift.
      const parsed = readStamp(501);
      parsed.manifest!.skillSlugs = ["definitely-not-a-real-slug"];
      writeFileSync(stampPath(501), JSON.stringify(parsed), "utf-8");

      // Second call: drift → re-materialise → stamp restored.
      ensureSessionWorkdir(
        fakeProjectRoot,
        fakeDataDir,
        501,
        "message.received.dm",
        { processKey: "message.dm" },
      );
      const restored = readStamp(501).manifest!;
      expect(restored.skillSlugs).not.toContain("definitely-not-a-real-slug");
      expect([...restored.skillSlugs].sort()).toEqual([...originalSlugs].sort());
      expect(restored.processKey).toBe("message.dm");
    });

    it("forces re-materialisation when the recorded processKey diverges from the call", () => {
      ensureSessionWorkdir(
        fakeProjectRoot,
        fakeDataDir,
        502,
        "message.received.dm",
        { processKey: "message.dm" },
      );
      expect(readStamp(502).manifest!.processKey).toBe("message.dm");

      // Tamper: claim the stamp was for a different processKey so the
      // next call's comparison detects drift even though the slugs match.
      const parsed = readStamp(502);
      parsed.manifest!.processKey = "some.other.processkey";
      writeFileSync(stampPath(502), JSON.stringify(parsed), "utf-8");

      ensureSessionWorkdir(
        fakeProjectRoot,
        fakeDataDir,
        502,
        "message.received.dm",
        { processKey: "message.dm" },
      );
      expect(readStamp(502).manifest!.processKey).toBe("message.dm");
    });

    it("upgrades a pre-Phase-1 stamp (no manifest field) by forcing re-materialisation", () => {
      ensureSessionWorkdir(
        fakeProjectRoot,
        fakeDataDir,
        503,
        "message.received.dm",
        { processKey: "message.dm" },
      );

      // Tamper: strip the manifest field entirely, simulating a stamp
      // written by a pre-Phase-1 daemon binary. The drift guard treats
      // missing-manifest as "force re-materialise" so the stamp shape
      // upgrades on next dispatch.
      const parsed = readStamp(503);
      delete parsed.manifest;
      writeFileSync(stampPath(503), JSON.stringify(parsed), "utf-8");

      ensureSessionWorkdir(
        fakeProjectRoot,
        fakeDataDir,
        503,
        "message.received.dm",
        { processKey: "message.dm" },
      );
      const upgraded = readStamp(503);
      expect(upgraded.manifest).toBeDefined();
      expect(upgraded.manifest!.processKey).toBe("message.dm");
      expect(upgraded.manifest!.skillSlugs.length).toBeGreaterThan(0);
    });
  });
});

describe("syncUserSkills", () => {
  let sessionDir: string;
  let userSkillsDir: string;

  beforeEach(() => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionDir = join(tmpdir(), `pa-sync-session-${stamp}`);
    userSkillsDir = join(tmpdir(), `pa-sync-user-${stamp}`);
    mkdirSync(join(sessionDir, ".claude", "skills"), { recursive: true });
    mkdirSync(userSkillsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
    rmSync(userSkillsDir, { recursive: true, force: true });
  });

  function plantUserSkill(slug: string, body: string) {
    const dir = join(userSkillsDir, slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), body);
  }

  it("adds new user skills mid-session (the critical 'create → use' flow)", () => {
    // Simulate: session workdir exists, then user creates a skill via API,
    // then the next message calls syncUserSkills.
    plantUserSkill("todo-digest", `---\nname: todo-digest\ndescription: "x"\n---\n\n# Body\n`);

    const result = syncUserSkills(sessionDir, userSkillsDir);

    expect(result.added).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.removed).toBe(0);
    expect(existsSync(join(sessionDir, ".claude", "skills", "todo-digest", "SKILL.md"))).toBe(true);
  });

  it("propagates updates to existing user skills on subsequent sync", () => {
    plantUserSkill("todo-digest", `---\nname: todo-digest\ndescription: "v1"\n---\n\n# v1 body\n`);
    syncUserSkills(sessionDir, userSkillsDir);

    // User updates the skill via PUT
    plantUserSkill("todo-digest", `---\nname: todo-digest\ndescription: "v2"\n---\n\n# v2 body\n`);

    const result = syncUserSkills(sessionDir, userSkillsDir);

    expect(result.updated).toBe(1);
    expect(result.added).toBe(0);
    const content = readFileSync(
      join(sessionDir, ".claude", "skills", "todo-digest", "SKILL.md"),
      "utf-8",
    );
    expect(content).toContain("# v2 body");
    expect(content).not.toContain("# v1 body");
  });

  it("removes user skills that were deleted via API", () => {
    plantUserSkill("todo-digest", `---\nname: todo-digest\ndescription: "x"\n---\n\n# Body\n`);
    syncUserSkills(sessionDir, userSkillsDir);
    expect(existsSync(join(sessionDir, ".claude", "skills", "todo-digest"))).toBe(true);

    // User deletes the skill via DELETE /api/skills/todo-digest
    rmSync(join(userSkillsDir, "todo-digest"), { recursive: true });

    const result = syncUserSkills(sessionDir, userSkillsDir);

    expect(result.removed).toBe(1);
    expect(existsSync(join(sessionDir, ".claude", "skills", "todo-digest"))).toBe(false);
  });

  it("never clobbers built-in skills that happen to share a name", () => {
    // Plant a "built-in" already in the session workdir (simulating what
    // ensureSessionWorkdir did earlier)
    const builtinInSession = join(sessionDir, ".claude", "skills", "context");
    mkdirSync(builtinInSession, { recursive: true });
    writeFileSync(join(builtinInSession, "SKILL.md"), "# built-in content");

    // A colliding user skill somehow ended up in the user dir (the API
    // wouldn't allow this, but defense in depth)
    plantUserSkill("context", `---\nname: context\ndescription: "evil"\n---\n\n# EVIL\n`);

    syncUserSkills(sessionDir, userSkillsDir);

    const content = readFileSync(join(builtinInSession, "SKILL.md"), "utf-8");
    expect(content).toBe("# built-in content");
    expect(content).not.toContain("EVIL");
  });

  it("writes a hidden manifest file that Claude Code skill discovery ignores", () => {
    plantUserSkill("one", `---\nname: one\ndescription: "x"\n---\n\nbody`);
    syncUserSkills(sessionDir, userSkillsDir);

    const manifest = join(sessionDir, ".claude", "skills", ".user-skills.json");
    expect(existsSync(manifest)).toBe(true);
    // Dot-prefixed so SDK's skill scanner doesn't treat it as a skill dir
    expect(JSON.parse(readFileSync(manifest, "utf-8"))).toEqual(["one"]);
  });

  it("is resilient when user skills dir doesn't exist yet", () => {
    const missing = join(tmpdir(), `pa-missing-${Date.now()}`);
    expect(() => syncUserSkills(sessionDir, missing)).not.toThrow();
    // And the manifest should exist as an empty list
    const manifest = join(sessionDir, ".claude", "skills", ".user-skills.json");
    expect(JSON.parse(readFileSync(manifest, "utf-8"))).toEqual([]);
  });

  it("recovers from a corrupt manifest by treating it as empty", () => {
    const manifest = join(sessionDir, ".claude", "skills", ".user-skills.json");
    writeFileSync(manifest, "not valid json {{{");
    plantUserSkill("foo", `---\nname: foo\ndescription: "x"\n---\n\nbody`);

    const result = syncUserSkills(sessionDir, userSkillsDir);

    expect(result.added).toBe(1);
    expect(JSON.parse(readFileSync(manifest, "utf-8"))).toEqual(["foo"]);
  });

  it("handles a full add → update → delete lifecycle across three sync calls", () => {
    // Call 1: add
    plantUserSkill("foo", `---\nname: foo\ndescription: "v1"\n---\n\n# v1`);
    let r = syncUserSkills(sessionDir, userSkillsDir);
    expect(r).toEqual({ added: 1, updated: 0, removed: 0 });

    // Call 2: update
    plantUserSkill("foo", `---\nname: foo\ndescription: "v2"\n---\n\n# v2`);
    r = syncUserSkills(sessionDir, userSkillsDir);
    expect(r).toEqual({ added: 0, updated: 1, removed: 0 });

    // Call 3: delete
    rmSync(join(userSkillsDir, "foo"), { recursive: true });
    r = syncUserSkills(sessionDir, userSkillsDir);
    expect(r).toEqual({ added: 0, updated: 0, removed: 1 });
    expect(existsSync(join(sessionDir, ".claude", "skills", "foo"))).toBe(false);
  });

  it("is idempotent on repeat calls with no changes", () => {
    plantUserSkill("foo", `---\nname: foo\ndescription: "x"\n---\n\nbody`);
    syncUserSkills(sessionDir, userSkillsDir);

    const r2 = syncUserSkills(sessionDir, userSkillsDir);
    // Second call updates (re-copies) existing slugs, doesn't add or remove
    expect(r2.added).toBe(0);
    expect(r2.removed).toBe(0);
  });
});

describe("getSessionWorkdirPath", () => {
  it("returns deterministic path", () => {
    expect(getSessionWorkdirPath("/data", 42)).toBe("/data/agent-sessions/42");
  });
});

describe("cleanupStaleWorkdirs", () => {
  let fakeDataDir: string;

  beforeEach(() => {
    fakeDataDir = join(tmpdir(), `pa-stale-test-${Date.now()}`);
    const sessionsDir = join(fakeDataDir, "agent-sessions");
    // Create fake session dirs
    for (const id of ["1", "2", "3"]) {
      mkdirSync(join(sessionsDir, id), { recursive: true });
    }
  });

  afterEach(() => {
    rmSync(fakeDataDir, { recursive: true, force: true });
  });

  it("removes dirs for sessions not in active set", () => {
    const cleaned = cleanupStaleWorkdirs(fakeDataDir, new Set([1]));
    expect(cleaned).toBe(2);
    expect(existsSync(join(fakeDataDir, "agent-sessions", "1"))).toBe(true);
    expect(existsSync(join(fakeDataDir, "agent-sessions", "2"))).toBe(false);
    expect(existsSync(join(fakeDataDir, "agent-sessions", "3"))).toBe(false);
  });

  it("returns 0 when all sessions are active", () => {
    const cleaned = cleanupStaleWorkdirs(fakeDataDir, new Set([1, 2, 3]));
    expect(cleaned).toBe(0);
  });
});

describe("cleanupSessionWorkdir", () => {
  it("removes the directory", () => {
    const dir = join(tmpdir(), `pa-cleanup-test-${Date.now()}`);
    mkdirSync(join(dir, ".claude", "skills", "test"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", "test", "SKILL.md"), "test");

    cleanupSessionWorkdir(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("does not throw for non-existent directory", () => {
    expect(() => cleanupSessionWorkdir("/tmp/nonexistent-pa-dir")).not.toThrow();
  });
});

// DELEGATED-PROXY-API-DESIGN.md Phase F (§4.8) and DELEGATED-MODE-V2-DESIGN.md
// §4.1 — re-bake on-disk skill body using the *new* integration state when an
// active DM session is refreshed.
//
// Pre-fix (Phase F), the helper hardcoded `integrations: undefined` so
// `selectSkillVariantFile` saw an empty map and always resolved to `SKILL.md`
// — a delegated → direct → delegated flip wrote direct-mode content into the
// DM workdir while the integration was actually delegated.
//
// Post-V2, `selectSkillVariantFile` returns:
//   - `"SKILL.md"`                    on direct/disabled
//   - `"SKILL.delegated.<bk>.md"`     on cross-backend delegated
//   - `null`                          on same-backend delegated (no skill;
//                                     the connector's native MCP carries
//                                     the tool descriptions)
// Notion is the only non-proxy integration with skillsTouched populated, so
// it's the right test subject for variant resolution.
describe("refreshDmSessionWorkdirs variant resolution", () => {
  let projectRoot: string;
  let dataDir: string;

  const NOTION_DIRECT_MARKER = "NOTION-VARIANT-MARKER:DIRECT";
  const NOTION_DELEGATED_CODEX_MARKER = "NOTION-VARIANT-MARKER:DELEGATED-CODEX";

  beforeEach(() => {
    projectRoot = join(tmpdir(), `pa-test-rematerialize-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    dataDir = join(tmpdir(), `pa-test-rematerialize-data-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dataDir, { recursive: true });

    // Minimal notion fixture — only the variants we care about. Other skills
    // referenced by `message.received.dm` are silently skipped because their
    // source SKILL.md is missing (see `materializeClaudeSession` line ~331).
    //
    // V2 — exercise the cross-backend variant (notion delegated to codex,
    // session on claude → SKILL.delegated.claude.md). Same-backend delegated
    // (e.g. notion delegated to claude with claude session) returns null and
    // the test asserting the absence of a materialized skill body lives below.
    const notionDir = join(projectRoot, "agent-assets", "skills", "notion");
    mkdirSync(notionDir, { recursive: true });
    writeFileSync(join(notionDir, "SKILL.md"), `# notion\n${NOTION_DIRECT_MARKER}\n`);
    writeFileSync(
      join(notionDir, "SKILL.delegated.claude.md"),
      `# notion (delegated, claude session × codex backend)\n${NOTION_DELEGATED_CODEX_MARKER}\n`,
    );
    writeFileSync(join(notionDir, "SKILL.base.md"), "");

    const profilesDir = join(projectRoot, "agent-assets", "agent-profiles");
    mkdirSync(profilesDir, { recursive: true });
    writeFileSync(join(profilesDir, "conversational.md"), PROFILE_CONTENTS.conversational);
    writeFileSync(join(profilesDir, "_safety.md"), SAFETY_PREAMBLE);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("re-bakes the cross-backend variant when notion flips direct → delegated to a different backend", () => {
    // Pre-materialize the DM workdir with notion in direct mode.
    const sessionDir = ensureSessionWorkdir(projectRoot, dataDir, 1, "message.received.dm", {
      backendId: "claude",
      processKey: "message.dm",
      integrations: {
        notion: { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-25T10:00:00Z" },
      },
    });
    const skillPath = join(sessionDir, ".claude", "skills", "notion", "SKILL.md");
    expect(readFileSync(skillPath, "utf-8")).toContain(NOTION_DIRECT_MARKER);

    // Phase F refresh — caller passes the post-flip integration state.
    // Cross-backend: notion delegated to CODEX with a Claude DM session.
    // The resolver returns "SKILL.delegated.claude.md".
    const result = refreshDmSessionWorkdirs({
      projectRoot,
      dataDir,
      sessions: [{ id: 1, backend: "claude", scope: OWNER_DM_SCOPE }],
      configuredServices: new Set(),
      mailAccounts: [],
      integrations: {
        notion: {
          mode: "delegated",
          delegatedBackend: "codex",
          deniedTools: [],
          lastChangedAt: "2026-04-25T11:00:00Z",
        },
      },
      character: "",
    });

    expect(result.refreshed).toBe(1);
    const after = readFileSync(skillPath, "utf-8");
    expect(after).toContain(NOTION_DELEGATED_CODEX_MARKER);
    expect(after).not.toContain(NOTION_DIRECT_MARKER);
  });

  it("re-bakes the direct body when notion flips delegated → direct", () => {
    // Start in cross-backend delegated (notion on codex, claude session).
    const sessionDir = ensureSessionWorkdir(projectRoot, dataDir, 2, "message.received.dm", {
      backendId: "claude",
      processKey: "message.dm",
      integrations: {
        notion: {
          mode: "delegated",
          delegatedBackend: "codex",
          deniedTools: [],
          lastChangedAt: "2026-04-25T10:00:00Z",
        },
      },
    });
    const skillPath = join(sessionDir, ".claude", "skills", "notion", "SKILL.md");
    expect(readFileSync(skillPath, "utf-8")).toContain(NOTION_DELEGATED_CODEX_MARKER);

    refreshDmSessionWorkdirs({
      projectRoot,
      dataDir,
      sessions: [{ id: 2, backend: "claude", scope: OWNER_DM_SCOPE }],
      configuredServices: new Set(),
      mailAccounts: [],
      integrations: {
        notion: { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-25T11:00:00Z" },
      },
      character: "",
    });

    const after = readFileSync(skillPath, "utf-8");
    expect(after).toContain(NOTION_DIRECT_MARKER);
    expect(after).not.toContain(NOTION_DELEGATED_CODEX_MARKER);
  });

  it("removes the materialized skill dir on a flip into same-backend delegated (V2 §4.1.2)", () => {
    // Direct mode → SKILL.md materialized.
    const sessionDir = ensureSessionWorkdir(projectRoot, dataDir, 3, "message.received.dm", {
      backendId: "claude",
      processKey: "message.dm",
      integrations: {
        notion: { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-25T10:00:00Z" },
      },
    });
    const skillDir = join(sessionDir, ".claude", "skills", "notion");
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);

    // Flip to same-backend delegated: notion on claude, claude session →
    // resolver returns null → skill dir removed.
    refreshDmSessionWorkdirs({
      projectRoot,
      dataDir,
      sessions: [{ id: 3, backend: "claude", scope: OWNER_DM_SCOPE }],
      configuredServices: new Set(),
      mailAccounts: [],
      integrations: {
        notion: {
          mode: "delegated",
          delegatedBackend: "claude",
          deniedTools: [],
          lastChangedAt: "2026-04-25T11:00:00Z",
        },
      },
      character: "",
    });

    expect(existsSync(skillDir)).toBe(false);
  });

  it("retains the mail skill body when gmail flips into same-backend delegated (multi-provider skill survives)", () => {
    // Multi-purpose skill regression: gmail's `sameBackendDropsSkillBody`
    // is empty so the resolver returns "SKILL.md" rather than null. The
    // direct body covers IMAP/Outlook/iCloud accounts, which still need
    // `/api/mail/*` regardless of how Gmail accounts are routed.
    const mailDir = join(projectRoot, "agent-assets", "skills", "mail");
    mkdirSync(mailDir, { recursive: true });
    const mailMarker = "MAIL-SKILL-MARKER:DIRECT-BODY";
    writeFileSync(join(mailDir, "SKILL.md"), `# mail\n${mailMarker}\n`);

    // Pre-materialize in direct mode so the skill dir exists.
    const sessionDir = ensureSessionWorkdir(projectRoot, dataDir, 7, "message.received.dm", {
      backendId: "claude",
      processKey: "message.dm",
      integrations: {
        gmail: { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-25T10:00:00Z" },
      },
    });
    const mailSkillPath = join(sessionDir, ".claude", "skills", "mail", "SKILL.md");
    expect(readFileSync(mailSkillPath, "utf-8")).toContain(mailMarker);

    // Flip gmail → same-backend delegated. The pre-fix bug would drop
    // the skill dir; post-fix it stays in place with SKILL.md body intact.
    refreshDmSessionWorkdirs({
      projectRoot,
      dataDir,
      sessions: [{ id: 7, backend: "claude", scope: OWNER_DM_SCOPE }],
      configuredServices: new Set(),
      mailAccounts: [],
      integrations: {
        gmail: {
          mode: "delegated",
          delegatedBackend: "claude",
          deniedTools: [],
          lastChangedAt: "2026-04-25T11:00:00Z",
        },
      },
      character: "",
    });

    expect(existsSync(mailSkillPath)).toBe(true);
    expect(readFileSync(mailSkillPath, "utf-8")).toContain(mailMarker);
  });

  it("skipsMissing when the session workdir has not been materialized", () => {
    const result = refreshDmSessionWorkdirs({
      projectRoot,
      dataDir,
      sessions: [{ id: 999, backend: "claude", scope: OWNER_DM_SCOPE }],
      configuredServices: new Set(),
      mailAccounts: [],
      integrations: {},
      character: "",
    });
    expect(result.skippedMissing).toBe(1);
    expect(result.refreshed).toBe(0);
  });
});

/**
 * docs/design/appendices/skills-unification.md Phase 4 — end-to-end gating tests. The
 * resolver-level tests in `skills-manifest.test.ts` cover the predicate
 * logic in isolation; these tests pin the contract at the actual
 * materialisation boundary: that the `db` / `messageText` / `contextDir`
 * options threaded through `createSessionWorkdir` and `ensureSessionWorkdir`
 * REALLY cause `gmail-lifestyle/SKILL.md` and `managed-tasks/SKILL.md` to
 * appear (or not appear) under `.claude/skills/<slug>/`.
 *
 * Without these tests, a future refactor that drops the option-forwarding
 * in any backend's `createSessionWorkdir` callsite — or in the dispatcher's
 * `ensureSessionWorkdir` callsites — would silently regress to the
 * conservative-include branch and the per-slot byte savings the plan exists
 * to deliver would evaporate.
 */
describe("conditional manifest materialisation (Phase 4)", () => {
  let fakeProjectRoot: string;
  let fakeDataDir: string;
  let db: Database.Database;
  let createdDirs: string[];

  beforeEach(() => {
    fakeProjectRoot = join(tmpdir(), `pa-test-phase4-root-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fakeDataDir = join(tmpdir(), `pa-test-phase4-data-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(fakeDataDir, { recursive: true });
    createdDirs = [];

    // Every slug `message.received.dm` declares plus the two conditional
    // ones we're gating on. The compiler skips any slug whose source
    // SKILL.md is missing, so we materialise every entry from the manifest
    // to keep the assertions speaking to the gating logic — not to a
    // happens-to-be-absent file.
    const SLUGS = [
      "context",
      "today",
      "user-profile",
      "user-interview",
      "notify",
      "attach",
      "schedule",
      "external-services",
      "mail",
      "notion",
      "gmail-lifestyle",
      "roadmap",
      "management-policy",
      "managed-tasks",
      "observations",
    ];
    const skillsDir = join(fakeProjectRoot, "agent-assets", "skills");
    for (const name of SLUGS) {
      const dir = join(skillsDir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: synthetic ${name} skill for phase 4 tests.\n---\n\n# ${name} skill content\n`,
      );
    }

    const profilesDir = join(fakeProjectRoot, "agent-assets", "agent-profiles");
    mkdirSync(profilesDir, { recursive: true });
    for (const [name, content] of Object.entries(PROFILE_CONTENTS)) {
      writeFileSync(join(profilesDir, `${name}.md`), content);
    }
    writeFileSync(join(profilesDir, "_safety.md"), SAFETY_PREAMBLE);

    db = new Database(":memory:");
    // Minimal schema matching the queries inside `gmailLifestyleActive` /
    // `managedTasksActive`. The predicates are defensive on schema gaps
    // (conservative include), so we only need the columns they touch.
    db.exec(`
      CREATE TABLE travel_bookings (
        id INTEGER PRIMARY KEY,
        start_date TEXT NOT NULL
      );
      CREATE TABLE receipts (
        id INTEGER PRIMARY KEY,
        saved_at TEXT
      );
      CREATE TABLE managed_tasks (
        id TEXT PRIMARY KEY
      );
    `);
  });

  afterEach(() => {
    db.close();
    for (const dir of createdDirs) {
      cleanupSessionWorkdir(dir);
    }
    rmSync(fakeProjectRoot, { recursive: true, force: true });
    rmSync(fakeDataDir, { recursive: true, force: true });
  });

  const skillExists = (sessionDir: string, slug: string) =>
    existsSync(join(sessionDir, ".claude", "skills", slug, "SKILL.md"));

  it("drops gmail-lifestyle AND managed-tasks for a DM when db is empty and the message text is neutral", () => {
    const sessionDir = createSessionWorkdir(
      fakeProjectRoot,
      "message.received.dm",
      undefined,
      {
        backendId: "claude",
        processKey: "message.dm",
        db,
        messageText: "hello, just checking in",
      },
    );
    createdDirs.push(sessionDir);

    // Conditional slugs dropped.
    expect(skillExists(sessionDir, "gmail-lifestyle")).toBe(false);
    expect(skillExists(sessionDir, "managed-tasks")).toBe(false);
    // Unconditional slugs survive — guard against accidental over-pruning.
    expect(skillExists(sessionDir, "context")).toBe(true);
    expect(skillExists(sessionDir, "today")).toBe(true);
    expect(skillExists(sessionDir, "user-profile")).toBe(true);
  });

  it("keeps gmail-lifestyle when an unsaved receipt exists in the db", () => {
    db.prepare("INSERT INTO receipts (saved_at) VALUES (NULL)").run();

    const sessionDir = createSessionWorkdir(
      fakeProjectRoot,
      "message.received.dm",
      undefined,
      {
        backendId: "claude",
        processKey: "message.dm",
        db,
        messageText: "totally unrelated topic",
      },
    );
    createdDirs.push(sessionDir);

    expect(skillExists(sessionDir, "gmail-lifestyle")).toBe(true);
    // managed-tasks DB is still empty + message text is unrelated → dropped.
    expect(skillExists(sessionDir, "managed-tasks")).toBe(false);
  });

  it("keeps managed-tasks when the DM text mentions an `mt_<n>` anchor even with an empty db", () => {
    const sessionDir = createSessionWorkdir(
      fakeProjectRoot,
      "message.received.dm",
      undefined,
      {
        backendId: "claude",
        processKey: "message.dm",
        db,
        messageText: "stop mt_42 please",
      },
    );
    createdDirs.push(sessionDir);

    expect(skillExists(sessionDir, "managed-tasks")).toBe(true);
    expect(skillExists(sessionDir, "gmail-lifestyle")).toBe(false);
  });

  it("keeps gmail-lifestyle for the morning routine when an unsaved receipt exists (no trigger-phrase fallback for routines)", () => {
    db.prepare("INSERT INTO receipts (saved_at) VALUES (NULL)").run();

    const sessionDir = createSessionWorkdir(
      fakeProjectRoot,
      "routine.morning_routine",
      undefined,
      {
        backendId: "claude",
        processKey: "routine.morning_routine",
        db,
        // messageText is intentionally omitted — routines don't carry one.
      },
    );
    createdDirs.push(sessionDir);

    expect(skillExists(sessionDir, "gmail-lifestyle")).toBe(true);
  });

  it("drops gmail-lifestyle for the morning routine when the db is empty (no trigger phrase to fall back on)", () => {
    const sessionDir = createSessionWorkdir(
      fakeProjectRoot,
      "routine.morning_routine",
      undefined,
      {
        backendId: "claude",
        processKey: "routine.morning_routine",
        db,
      },
    );
    createdDirs.push(sessionDir);

    expect(skillExists(sessionDir, "gmail-lifestyle")).toBe(false);
  });

  it("conservative-include fires when neither db nor messageText is threaded (legacy / tooling fallback)", () => {
    // Pre-Phase-4 callsites passed neither argument. The resolver returns
    // the static manifest verbatim in that case — both conditional slugs
    // stay included. This test pins the safety net: a code path that
    // forgets to forward the new options must NOT accidentally drop
    // skills.
    const sessionDir = createSessionWorkdir(
      fakeProjectRoot,
      "message.received.dm",
      undefined,
      {
        backendId: "claude",
        processKey: "message.dm",
      },
    );
    createdDirs.push(sessionDir);

    expect(skillExists(sessionDir, "gmail-lifestyle")).toBe(true);
    expect(skillExists(sessionDir, "managed-tasks")).toBe(true);
  });

  it("ensureSessionWorkdir re-renders the manifest when a predicate flips between turns", () => {
    // Turn 1 — db empty, neutral DM. Both conditional slugs drop.
    const sessionDir = ensureSessionWorkdir(
      fakeProjectRoot,
      fakeDataDir,
      777,
      "message.received.dm",
      {
        backendId: "claude",
        processKey: "message.dm",
        db,
        messageText: "tell me about today",
      },
    );
    createdDirs.push(sessionDir);
    expect(skillExists(sessionDir, "gmail-lifestyle")).toBe(false);
    expect(skillExists(sessionDir, "managed-tasks")).toBe(false);

    // Turn 2 — db gets a receipt mid-session. The drift detector in
    // `resolveManifestDriftAgainstStamp` must notice and re-materialise
    // the workdir so `gmail-lifestyle/SKILL.md` lands on disk; without
    // that, the per-turn `<skill-index>` block (Codex / Gemini) or the
    // SDK skill discovery (Claude) would be stale.
    db.prepare("INSERT INTO receipts (saved_at) VALUES (NULL)").run();
    const sessionDir2 = ensureSessionWorkdir(
      fakeProjectRoot,
      fakeDataDir,
      777,
      "message.received.dm",
      {
        backendId: "claude",
        processKey: "message.dm",
        db,
        messageText: "tell me about today",
      },
    );
    expect(sessionDir2).toBe(sessionDir); // same persistent dir
    expect(skillExists(sessionDir2, "gmail-lifestyle")).toBe(true);
  });

  it("ensureSessionWorkdir re-renders when only the messageText flips a trigger phrase", () => {
    // Turn 1: neutral DM, both conditionals drop.
    const sessionDir = ensureSessionWorkdir(
      fakeProjectRoot,
      fakeDataDir,
      888,
      "message.received.dm",
      {
        backendId: "claude",
        processKey: "message.dm",
        db,
        messageText: "no triggers here",
      },
    );
    createdDirs.push(sessionDir);
    expect(skillExists(sessionDir, "managed-tasks")).toBe(false);

    // Turn 2: same db, but the inbound message now mentions an mt_<n>
    // anchor — managed-tasks must reappear on disk before the dispatcher
    // hands the workdir to the backend.
    ensureSessionWorkdir(
      fakeProjectRoot,
      fakeDataDir,
      888,
      "message.received.dm",
      {
        backendId: "claude",
        processKey: "message.dm",
        db,
        messageText: "actually, stop mt_3 for me",
      },
    );
    expect(skillExists(sessionDir, "managed-tasks")).toBe(true);
  });
});

/**
 * Per-process workdir materialization matrix.
 *
 * For every dispatch ProcessKey × backend pair this suite pins:
 *   (1) the exact skill set materialized under `.<backend>/skills/` — no
 *       missing slug, no extras leaked in
 *   (2) the correct instruction file is rendered
 *       (CLAUDE.md / AGENTS.md / GEMINI.md)
 *   (3) sibling-backend instruction files and skill dirs do NOT leak in
 *   (4) the right agent profile heading lands in the instruction file
 *
 * Coverage rationale: process keys with dedicated suites are NOT
 * duplicated here.
 *   - `routine.fetch_window` → "materializeSessionBundle —
 *     routine.fetch_window CLI slim path" (skills-compiler.test.ts)
 *   - `routine.evening_review` rulebook-active branch →
 *     "routine.evening_review session materialization (Phase 2 slimdown)"
 *     (skills-compiler.test.ts). The rulebook-INACTIVE branch (no
 *     contextDir → `notify` dropped) is exercised here so all four
 *     backends are covered identically.
 *   - DM-class events' conditional gmail-lifestyle / managed-tasks
 *     gating → "conditional manifest materialisation (Phase 4)" suite
 *     above. This matrix runs DM events in their conservative-include
 *     shape (no db / messageText) so the static manifest branch is
 *     pinned.
 *
 * The matrix runs against the REAL agent-assets tree (not a synthetic
 * fixture) so a slug deletion in `agent-assets/skills/` or a manifest
 * widening edit cannot pass silently.
 */
const MATRIX_REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

interface MatrixCase {
  readonly processKey: ProcessKey;
  readonly eventType: string;
  readonly expectedSkills: readonly string[];
  readonly expectedProfileHeading: string;
}

const MATRIX_CASES: ReadonlyArray<MatrixCase> = [
  // ── Routines ──
  {
    processKey: "routine.morning_routine",
    eventType: "routine.morning_routine",
    // 8 slugs. user-profile is intentionally absent (the morning routine
    // does not own profile writes); external-services / notion / travel
    // were trimmed by morning-routine-optimization.md to keep the
    // medium-tier cold-start budget in line.
    expectedSkills: [
      "context",
      "today",
      "observations",
      "schedule",
      "mail",
      "roadmap",
      "gmail-lifestyle",
      "user-interview",
    ],
    expectedProfileHeading: "# Routine Agent",
  },
  {
    // Stage A — adds `agent-actions` for the Step 9 self-report PATCH.
    processKey: "routine.morning_routine_today",
    eventType: "routine.morning_routine_today",
    expectedSkills: [
      "context",
      "today",
      "observations",
      "schedule",
      "mail",
      "roadmap",
      "gmail-lifestyle",
      "user-interview",
      "agent-actions",
    ],
    expectedProfileHeading: "# Routine Agent",
  },
  {
    // daily-journal-daemon-write.md §4.10 — Stage B has zero tool
    // requirement. The daemon-side composer writes daily/<date>.md from
    // the LLM's tagged final-text output; the manifest is empty so
    // no `Bash`/`Read`/`Write`/`Edit` are even registered.
    processKey: "routine.morning_routine_journal",
    eventType: "routine.morning_routine_journal",
    expectedSkills: [],
    expectedProfileHeading: "# Routine Agent",
  },
  {
    // Rulebook-INACTIVE branch only (no contextDir threaded). The
    // rulebook-active branch lives in skills-compiler.test.ts's
    // dedicated suite. Without a `### `-headed `routines/evening.md`,
    // `notify` is dropped → 5 slugs.
    processKey: "routine.evening_review",
    eventType: "routine.evening_review",
    expectedSkills: [
      "context",
      "today",
      "user-profile",
      "roadmap",
      "management-policy",
    ],
    expectedProfileHeading: "# Routine Agent",
  },
  {
    processKey: "routine.activity_scan",
    eventType: "routine.activity_scan",
    expectedSkills: [
      "context",
      "today",
      "observations",
      "notify",
      "schedule",
      "external-services",
      "mail",
      "notion",
    ],
    expectedProfileHeading: "# Routine Agent",
  },
  {
    processKey: "routine.weekly_review",
    eventType: "routine.weekly_review",
    expectedSkills: ["context", "today", "notify", "schedule", "reading"],
    expectedProfileHeading: "# Routine Agent",
  },
  {
    processKey: "routine.monthly_review",
    eventType: "routine.monthly_review",
    expectedSkills: ["context", "today", "notify", "schedule", "reading"],
    expectedProfileHeading: "# Routine Agent",
  },
  {
    processKey: "routine.today_refresh",
    eventType: "routine.today_refresh",
    expectedSkills: ["context", "today", "external-services"],
    expectedProfileHeading: "# Routine Agent",
  },
  {
    processKey: "routine.roadmap_refresh",
    eventType: "routine.roadmap_refresh",
    expectedSkills: ["context", "external-services", "notion", "roadmap"],
    expectedProfileHeading: "# Routine Agent",
  },
  {
    processKey: "routine.user_profile_sweep",
    eventType: "routine.user_profile_sweep",
    expectedSkills: ["context", "user-profile", "user-interview"],
    expectedProfileHeading: "# Routine Agent",
  },
  // ── DM-class events (conservative-include shape) ──
  {
    // No db / messageText is threaded → resolver returns the static
    // manifest verbatim (conservative include). 15 slugs including
    // both `gmail-lifestyle` and `managed-tasks`. The Phase 4 suite
    // covers the runtime-gated branches.
    processKey: "message.dm",
    eventType: "message.received.dm",
    expectedSkills: [
      "context",
      "today",
      "user-profile",
      "notify",
      "attach",
      // SOURCE_LIBRARY_DESIGN.md — filing surface for auto-captured
      // document attachments; unconditional on `message.received.dm`.
      "sources",
      "schedule",
      "external-services",
      "mail",
      "notion",
      "gmail-lifestyle",
      "roadmap",
      "management-policy",
      "managed-tasks",
      "user-interview",
      // BROWSER_HISTORY_INTEGRATION_PLAN §10.1 (seventh-pass) — narrow
      // accept-surface for the natural-language reply path.
      "browser-history-respond",
      // BROWSER_TASK_REDESIGN_PLAN.md §10 / Phase 5 — DM-driven entry
      // point to the open-ended browser-task surface.
      "browser-task",
      // BACKGROUND_TASK_RUNNER_DESIGN.md §5 / Phase 3 — generic detached
      // long-task spawn + the clarify-relay. Both are unconditional on
      // `message.received.dm`, so the conservative-include matrix carries
      // them like browser-task.
      "background-task",
      "background-task-reply",
      // unified-task-board.md L0/L1 — the read board + unified write facade.
      // Unconditional on `message.received.dm` (like browser-task /
      // background-task), so the conservative-include matrix carries them.
      "board",
      "task",
      // NB: `agent-create` is conditionally loaded (recurring-work cadence +
      // verb in the message) — the matrix passes no message text, so it is
      // correctly dropped here. Its conditional gate is tested in
      // skills-manifest.test.ts.
    ],
    expectedProfileHeading: "# Conversational Agent",
  },
  {
    // Scheduled DM (`agent.dm_task` → `scheduled.dm`). 11 slugs;
    // `managed-tasks` is NOT in the static set by design. Runs on the
    // conversational profile per SCHEDULED-DM-IMPLEMENTATION-PLAN §3.3.
    processKey: "agent.dm_task",
    eventType: "scheduled.dm",
    expectedSkills: [
      "context",
      "today",
      "notify",
      "schedule",
      "external-services",
      "mail",
      "notion",
      "observations",
      "roadmap",
      "gmail-lifestyle",
      "user-interview",
    ],
    expectedProfileHeading: "# Conversational Agent",
  },
  {
    // `agent.task` → `scheduled.task`. 9 slugs; runs on the task profile.
    // (Operating playbooks are injection-only, NOT a skill, so they add no slug.)
    processKey: "agent.task",
    eventType: "scheduled.task",
    expectedSkills: [
      "context",
      "today",
      "notify",
      "schedule",
      "external-services",
      "mail",
      "notion",
      "roadmap",
      "scheduled-managed-task",
      // NOTE: operating playbooks are NOT a skill (injection-only) — see
      // AGENT_PROMPT_QUALITY_DESIGN.md §4; they are not materialized here.
    ],
    expectedProfileHeading: "# Task Agent",
  },
];

interface BackendLayout {
  readonly backendId: BackendId;
  readonly instructionFile: "CLAUDE.md" | "AGENTS.md" | "GEMINI.md";
  readonly skillsRel: string;
}

const BACKEND_LAYOUTS: ReadonlyArray<BackendLayout> = [
  { backendId: "claude",   instructionFile: "CLAUDE.md", skillsRel: join(".claude",   "skills") },
  { backendId: "codex",    instructionFile: "AGENTS.md", skillsRel: join(".codex",    "skills") },
  { backendId: "gemini",   instructionFile: "GEMINI.md", skillsRel: join(".gemini",   "skills") },
  { backendId: "opencode", instructionFile: "AGENTS.md", skillsRel: join(".opencode", "skills") },
];

const ALL_INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md"] as const;
const ALL_SKILL_DIRS = [
  join(".claude",   "skills"),
  join(".codex",    "skills"),
  join(".gemini",   "skills"),
  join(".opencode", "skills"),
] as const;

describe("per-process workdir materialization matrix", () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    while (createdDirs.length > 0) {
      const d = createdDirs.pop();
      if (d) cleanupSessionWorkdir(d);
    }
  });

  for (const c of MATRIX_CASES) {
    for (const b of BACKEND_LAYOUTS) {
      const label = `${c.processKey} × ${b.backendId}`;
      it(`${label} renders only the manifest skills and the right instruction file`, () => {
        const sessionDir = createSessionWorkdir(
          MATRIX_REPO_ROOT,
          c.eventType,
          undefined,
          {
            backendId: b.backendId,
            processKey: c.processKey,
          },
        );
        createdDirs.push(sessionDir);

        // (1) The chosen backend's instruction file is rendered.
        const instructionPath = join(sessionDir, b.instructionFile);
        expect(
          existsSync(instructionPath),
          `${label}: missing ${b.instructionFile}`,
        ).toBe(true);

        // (2) Profile heading is present inside the instruction file.
        const content = readFileSync(instructionPath, "utf-8");
        expect(
          content.includes(c.expectedProfileHeading),
          `${label}: ${b.instructionFile} missing "${c.expectedProfileHeading}"`,
        ).toBe(true);

        // (3) Sibling-backend instruction files MUST NOT leak. AGENTS.md
        // is shared by codex + opencode by design, so for those two we
        // only assert CLAUDE.md / GEMINI.md absence; for claude / gemini
        // we additionally assert AGENTS.md absence.
        for (const f of ALL_INSTRUCTION_FILES) {
          if (f === b.instructionFile) continue;
          expect(
            existsSync(join(sessionDir, f)),
            `${label}: sibling instruction file ${f} leaked`,
          ).toBe(false);
        }

        // (4) Each expected skill has SKILL.md under the chosen backend's
        // skill dir.
        for (const slug of c.expectedSkills) {
          const skillPath = join(sessionDir, b.skillsRel, slug, "SKILL.md");
          expect(
            existsSync(skillPath),
            `${label}: missing ${slug}/SKILL.md`,
          ).toBe(true);
        }

        // (5) The materialized skill set equals the manifest exactly — no
        // extras leaked in (a future EVENT_SKILL_SETS edit that widens
        // scope surfaces here, not at agent runtime).
        const skillsRoot = join(sessionDir, b.skillsRel);
        expect(
          existsSync(skillsRoot),
          `${label}: expected skill root ${b.skillsRel} missing`,
        ).toBe(true);
        const actualSlugs = readdirSync(skillsRoot, { withFileTypes: true })
          .filter(
            (e) =>
              e.isDirectory() &&
              existsSync(join(skillsRoot, e.name, "SKILL.md")),
          )
          .map((e) => e.name)
          .sort();
        expect(
          actualSlugs,
          `${label}: materialized skill set diverged from manifest`,
        ).toEqual([...c.expectedSkills].sort());

        // (6) Sibling-backend skill dirs MUST NOT exist. Opencode also
        // writes `.opencode/agent/<slug>.md` files; those live next to
        // — not inside — `.opencode/skills/`, so checking the skill-dir
        // path here is the right scope for "no cross-backend leak".
        for (const d of ALL_SKILL_DIRS) {
          if (d === b.skillsRel) continue;
          expect(
            existsSync(join(sessionDir, d)),
            `${label}: sibling skill dir ${d} leaked`,
          ).toBe(false);
        }
      });
    }
  }
});
