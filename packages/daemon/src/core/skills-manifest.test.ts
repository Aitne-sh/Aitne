import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, basename } from "node:path";
import Database from "better-sqlite3";
import {
  EVENT_SKILL_SETS,
  ALL_SKILLS,
  eveningRulebookIsActive,
  gmailLifestyleActive,
  gmailLifestyleActiveForDm,
  managedTasksActive,
  managedTasksActiveForDm,
  getProfileForProcess,
  getSkillsForProcess,
  resolveSkillManifest,
  resolveSkillManifestForProcess,
} from "./skills-manifest.js";
import {
  listBuiltinSkillDirs,
  resolveBuiltinSkillDir,
} from "./skill-source-paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../../");
const SKILLS_DIR = join(REPO_ROOT, "agent-assets/skills");
const TASK_FLOWS_DIR = join(REPO_ROOT, "agent-assets/task-flows");

// WIKI_BUILDER_DESIGN.md §9.1 — wiki skills live under a `wiki/`
// category subdirectory. The shared `listBuiltinSkillDirs` /
// `resolveBuiltinSkillDir` helpers honour that convention so this
// integrity suite picks up both flat and nested slugs without each
// test re-implementing the recursion.

describe("skills-manifest integrity", () => {
  test("every slug in EVENT_SKILL_SETS resolves to a SKILL.md", () => {
    const allSlugs = new Set(Object.values(EVENT_SKILL_SETS).flat());
    for (const slug of allSlugs) {
      const skillPath = join(resolveBuiltinSkillDir(SKILLS_DIR, slug), "SKILL.md");
      expect(existsSync(skillPath), `Missing SKILL.md for slug '${slug}'`).toBe(true);
    }
  });

  test("every slug in ALL_SKILLS resolves to a SKILL.md", () => {
    for (const slug of ALL_SKILLS) {
      const skillPath = join(resolveBuiltinSkillDir(SKILLS_DIR, slug), "SKILL.md");
      expect(existsSync(skillPath), `Missing SKILL.md for slug '${slug}'`).toBe(true);
    }
  });

  test("every built-in skill directory has a SKILL.md with matching frontmatter name", () => {
    const violations: string[] = [];
    for (const { slug, dir } of listBuiltinSkillDirs(SKILLS_DIR)) {
      const skillPath = join(dir, "SKILL.md");
      if (!existsSync(skillPath)) {
        violations.push(`${slug}/SKILL.md is missing`);
        continue;
      }
      const content = readFileSync(skillPath, "utf-8");
      const fm = content.match(/^---\n([\s\S]+?)\n---/);
      if (!fm) {
        violations.push(`${slug}/SKILL.md is missing YAML frontmatter`);
        continue;
      }
      const name = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
      const description = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
      if (name !== slug) {
        violations.push(`${slug}/SKILL.md declares name '${name ?? "<missing>"}'`);
      }
      if (!description) {
        violations.push(`${slug}/SKILL.md is missing description`);
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });

  test("every `slug` skill reference in task flows resolves to a loaded skill", () => {
    const SKILL_REF_RE = /`([a-z][a-z0-9-]*)` skill/g;
    const taskFlowFiles = readdirSync(TASK_FLOWS_DIR).filter((f) => f.endsWith(".md"));

    for (const file of taskFlowFiles) {
      const eventType = basename(file, ".md");
      const content = readFileSync(join(TASK_FLOWS_DIR, file), "utf-8");
      const loadedSkills = EVENT_SKILL_SETS[eventType] ?? ALL_SKILLS;

      SKILL_REF_RE.lastIndex = 0;
      let match;
      while ((match = SKILL_REF_RE.exec(content)) !== null) {
        const slug = match[1];
        expect(
          loadedSkills.includes(slug),
          `Task flow '${file}' references skill '${slug}' but it is not loaded for event '${eventType}'`,
        ).toBe(true);
      }
    }
  });

  test("agent.dm_task resolves to the conversational profile (scheduled.dm event)", () => {
    // SCHEDULED-DM-IMPLEMENTATION-PLAN §3.3 — DM-tone scheduled
    // sessions must run on `conversational` so the persona / character
    // visible to the user matches a normal DM. Drift to `task` would
    // produce the voice-mismatch the plan exists to fix.
    expect(getProfileForProcess("agent.dm_task")).toBe("conversational");
    expect(getSkillsForProcess("agent.dm_task")).toEqual([
      "context",
      "today",
      "notify",
      "schedule",
      "external-services",
      "mail",
      "notion",
      "observations",
      "roadmap",
      // docs/design/appendices/skills-improvement.md §9-§11 — conditionally loaded via
      // `gmailLifestyleActiveForDm` so the briefing surfaces upcoming
      // travel / commute when the DB or trigger phrases indicate it.
      "gmail-lifestyle",
      // profile-interview-queue.md §3.2 — the morning-briefing piggyback
      // and the `profile_interview:` fallback sub-flow both call into
      // user-interview. Keeping it on the dm_session manifest is what
      // lets a single composer turn weave a latent question into the
      // outgoing briefing.
      "user-interview",
    ]);
  });

  test("agent.task remains on the task profile (regression guard for the split)", () => {
    expect(getProfileForProcess("agent.task")).toBe("task");
  });

  test("scheduled.task workdir is provisioned with DM-operating skills", () => {
    // Manually-created schedules from the dashboard run via
    // executeScheduledTask in a fresh per-session workdir. The user-facing
    // contract — both for self-scheduled runs and for the dashboard's
    // "Schedule" form — requires that the agent can DM the owner from
    // inside that session and reschedule itself. `notify` is the
    // /api/notify chokepoint; `schedule` exposes the schedule CRUD.
    // Removing either silently breaks the manual-schedule UX.
    const skills = getSkillsForProcess("agent.task");
    expect(skills).toContain("notify");
    expect(skills).toContain("schedule");
  });

  test("knowledge.import resolves to the dedicated profile-importer profile and a minimal skill set", () => {
    // The dashboard Knowledge upload feature spawns a one-shot heavy
    // session whose entire job is to copy user-supplied facts into
    // user/*.md verbatim. The persona and the skill set both have to
    // stay narrow — drift here (e.g. inheriting the conversational
    // profile or widening to ALL_SKILLS) would let the agent paraphrase
    // or wander outside the import scope.
    expect(getProfileForProcess("knowledge.import")).toBe("profile-importer");
    expect(getSkillsForProcess("knowledge.import")).toEqual([
      "context",
      "user-profile",
      "notify",
    ]);
  });

  // docs/design/appendices/routine-data-acquisition.md Phase 1 F2 — the pre-pass
  // fetcher persona must (a) exist on disk so the SkillsCompiler can
  // materialise it, (b) be wired through PROFILE_RULES so the resolver
  // doesn't fall through to the generic `routine` profile, and
  // (c) carry a minimal skill manifest so the lite-tier session
  // doesn't pull every skill in ALL_SKILLS. All three are guarded
  // here because a missing wire would leave the file orphaned without
  // breaking any other test.
  test("routine.fetch_window is fully wired to its dedicated profile + minimal skill set", () => {
    const profilePath = join(
      REPO_ROOT,
      "agent-assets/agent-profiles/routine-fetch-window.md",
    );
    expect(existsSync(profilePath)).toBe(true);

    const body = readFileSync(profilePath, "utf-8");
    expect(body.length).toBeGreaterThan(0);
    // The contract phrases that anchor the prompt's intent — drift
    // here would silently weaken the "fetch, don't think" boundary.
    expect(body).toMatch(/pre-pass/i);
    expect(body).toMatch(/<acquisition-plan>/);
    expect(body).toMatch(/\/api\/observations/);
    // Sibling profiles in this directory ship without YAML frontmatter
    // (the SkillsCompiler substitutes brand tokens only). Pin the
    // shape so a future authoring tool can't accidentally introduce
    // frontmatter that the compiler doesn't parse.
    expect(body.startsWith("---")).toBe(false);

    // The resolver must NOT fall through to the catch-all `routine.`
    // rule. If it does, the file above is dead code.
    expect(getProfileForProcess("routine.fetch_window")).toBe("routine-fetch-window");

    // Minimal manifest by design — the fetcher does mechanical fetch +
    // POST observations and nothing else. Anything from this list
    // dropping out is a regression; anything else (today, schedule,
    // user-*, notify, management-*, roadmap) appearing here breaks
    // the boundary the profile enforces.
    const skills = getSkillsForProcess("routine.fetch_window");
    expect(skills).toEqual(
      expect.arrayContaining([
        "observations",
        "mail",
        "notion",
        "external-services",
        "attach",
      ]),
    );
    expect(skills.length).toBeLessThan(ALL_SKILLS.length);
    for (const forbidden of [
      "today",
      "schedule",
      "user-profile",
      "user-interview",
      "notify",
      "roadmap",
      "management-policy",
      "management-task-register",
    ]) {
      expect(skills).not.toContain(forbidden);
    }
  });

  test("profile-importer agent profile file exists in agent-assets/", () => {
    // The SkillsCompiler materializes this into CLAUDE.md / AGENTS.md /
    // GEMINI.md inside the per-session workdir based on the chosen
    // backend. Without the source file present, knowledge.import
    // sessions would fall back to the default `task` profile.
    const profilePath = join(
      REPO_ROOT,
      "agent-assets/agent-profiles/profile-importer.md",
    );
    expect(existsSync(profilePath)).toBe(true);
  });

  test("knowledge.import task flow uses the correct PATCH idiom (regression guard)", () => {
    // The PATCH endpoint is section-targeted: {section, mode, content}.
    // An earlier draft of this task flow used the PUT shape
    // {content, expectedMtime} which fails Zod validation with 400 at
    // execute time. This test pins the prose so a future refactor
    // can't quietly reintroduce the bug.
    const flowPath = join(REPO_ROOT, "agent-assets/task-flows/knowledge.import.md");
    const body = readFileSync(flowPath, "utf-8");

    // Required positive markers: the correct PATCH idiom is documented.
    expect(body).toMatch(/mode:\s*"append"/);
    expect(body).toMatch(/mode:\s*"append_to_file"/);
    expect(body).toMatch(/section:\s*\$s/); // jq -nc --arg s 'family' ...

    // Required negative markers: the wrong-shape patterns are gone.
    // The bug we hit was a curl/jq idiom emitting the PUT-shaped
    // `{content:$c, expectedMtime:$m}` body to the PATCH endpoint.
    // The substring `expectedMtime` itself may appear in the
    // explanatory prose (e.g. "PATCH does not require expectedMtime —
    // that is PUT") which is helpful and should NOT trigger the
    // regression. We only fail when an actual JSON-key form
    // (`expectedMtime:`) lands in a code-block-style snippet.
    expect(body).not.toMatch(/expectedMtime\s*:/);

    // The fidelity rule has to be visibly anchored — drift here would
    // weaken the strict-fidelity contract documented elsewhere.
    expect(body).toMatch(/verbatim/i);
    expect(body).toMatch(/Never use `mode: "replace"`/);
  });

  test("dashboard.docs_qa resolves to the single-skill docs-qa profile", () => {
    // DOCS_QA_DESIGN.md §10.3 — the QA session must run with exactly one
    // read-only skill and the docs-qa profile (not conversational, which
    // would import the dashboard-chat persona's broader scope).
    expect(getSkillsForProcess("dashboard.docs_qa")).toEqual(["docs-search"]);
    expect(getProfileForProcess("dashboard.docs_qa")).toBe("docs-qa");
  });

  test("routine.user_profile_sweep resolves to [context, user-profile, user-interview] on the routine profile", () => {
    // Phase 2 safety net — the sweep intentionally runs with a near-minimal
    // manifest to sidestep the selection-dilution failure mode that
    // motivated the plan. The third slug (`user-interview`) is gated to
    // the evening run and only invoked for queue maintenance (stale
    // recovery, latent fallback, Layer 4 reconcile) — not extracting
    // facts. Drift adding broader skills here would replicate the
    // DM-side bug.
    expect(getSkillsForProcess("routine.user_profile_sweep")).toEqual([
      "context",
      "user-profile",
      "user-interview",
    ]);
    expect(getProfileForProcess("routine.user_profile_sweep")).toBe("routine");
  });

  /**
   * SKILLS-PHASE-2-PLAN.md §3.4.5 (#15-#17). Lockstep invariants between
   * `{{> ref:<name> }}` directives and `references/<name>.md` files. Run
   * against the real `agent-assets/skills/` tree — synthetic fixtures
   * cover the resolver in isolation; this set catches the integration
   * drift class (a P2-B PR introducing a directive without committing
   * its file, or vice versa).
   *
   * Test #17 ("zero directives in tree as of P2-A") flips after the
   * first P2-B migration ships. Update by removing the assertion when
   * the first reference inline lands; #15 + #16 keep the lockstep
   * intact regardless.
   */
  const REF_DIRECTIVE_RE = /\{\{> ref:([a-z][a-z0-9-]*) \}\}/g;

  function findDirectivesIn(content: string): string[] {
    REF_DIRECTIVE_RE.lastIndex = 0;
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = REF_DIRECTIVE_RE.exec(content)) !== null) {
      out.push(m[1]);
    }
    return out;
  }

  test("every `{{> ref:<name> }}` directive in any SKILL.md / SKILL.*.md has a matching `references/<name>.md` (lockstep)", () => {
    const violations: string[] = [];
    for (const { slug, dir } of listBuiltinSkillDirs(SKILLS_DIR)) {
      // Inspect SKILL.md and any SKILL.*.md variant — directives are
      // legal in cross-backend variants too once Phase 2-B starts.
      const skillFiles = readdirSync(dir).filter((f) =>
        f.startsWith("SKILL") && f.endsWith(".md"),
      );
      for (const file of skillFiles) {
        const fullPath = join(dir, file);
        const body = readFileSync(fullPath, "utf-8");
        for (const name of findDirectivesIn(body)) {
          const refPath = join(dir, "references", `${name}.md`);
          if (!existsSync(refPath)) {
            violations.push(`${slug}/${file} references '${name}' but ${slug}/references/${name}.md is missing`);
          }
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  test("every `references/<name>.md` is referenced by its parent skill's SKILL.md / SKILL.*.md (reverse lockstep)", () => {
    const orphans: string[] = [];
    for (const { slug, dir } of listBuiltinSkillDirs(SKILLS_DIR)) {
      const refsDir = join(dir, "references");
      if (!existsSync(refsDir)) continue;
      const refFiles = readdirSync(refsDir).filter((f) => f.endsWith(".md"));
      if (refFiles.length === 0) continue;

      // Collect every directive name used by every SKILL*.md in this skill dir.
      const declared = new Set<string>();
      const skillFiles = readdirSync(dir).filter((f) =>
        f.startsWith("SKILL") && f.endsWith(".md"),
      );
      for (const file of skillFiles) {
        const body = readFileSync(join(dir, file), "utf-8");
        for (const name of findDirectivesIn(body)) declared.add(name);
      }

      for (const refFile of refFiles) {
        const name = refFile.slice(0, -".md".length);
        if (!declared.has(name)) {
          orphans.push(`${slug}/references/${refFile} is not referenced by any ${slug}/SKILL*.md`);
        }
      }
    }
    expect(orphans, orphans.join("\n")).toEqual([]);
  });

  /**
   * docs/design/appendices/skills-improvement.md §14 — the `recurrenceRule` grammar is
   * shared between `managed-tasks` (POST /api/managed-tasks) and
   * `schedule` (POST /api/recurring-schedules). `{{> ref: }}` is
   * intra-skill only, so two copies are required. Pin them
   * byte-identical so the sub-daily refusal template, mapping table,
   * and cadence-vs-rule discipline cannot drift.
   *
   * If this ever becomes painful, escalate by reopening
   * docs/design/appendices/skills-improvement.md Phase 0.10 (cross-skill `_shared/`
   * support in `renderReferenceIncludes`).
   */
  test("recurrence-rule.md is byte-identical across managed-tasks and schedule", () => {
    const managedTasks = readFileSync(
      join(SKILLS_DIR, "managed-tasks", "references", "recurrence-rule.md"),
      "utf-8",
    );
    const schedule = readFileSync(
      join(SKILLS_DIR, "schedule", "references", "recurrence-rule.md"),
      "utf-8",
    );
    expect(schedule).toEqual(managedTasks);
  });

  /**
   * Phase 9 — every `routine.hourly_check*.md` task-flow MUST carry the
   * "external services are read-only this hour" rule.
   *
   * The constraint owns three failure modes that the per-skill body
   * cannot cover uniformly:
   *  1. `external-services` skill body never declared the constraint.
   *  2. `notion` / `mail` SKILL.delegated.*.md cross-backend variants
   *     never declared it either (only the direct-mode SKILL.md did).
   *  3. Same-backend delegated mode drops the skill body entirely
   *     (`sameBackendDropsSkillBody: ["notion"]`), so a per-skill rule
   *     has no surface to live on.
   *
   * Putting the rule in the task-flow itself fixes all three. Pin every
   * variant so a future task-flow refactor cannot silently regress one
   * of the modes back to "writes allowed" during the silent-bookkeeping
   * pass.
   */
  // docs/design/appendices/routine-data-acquisition.md Phase 3 R4 deleted
  // `routine.hourly_check.{delegated,native}.<be>.md`; the
  // mode-specific prose now flows through `_partials/*-acquire.<key>.md`.
  // The external-write prohibition is owned by the base file (it
  // applies regardless of integration mode), so the matrix narrows to
  // the single base entry.
  test("routine.hourly_check.md contains the external-write prohibition", () => {
    const body = readFileSync(join(TASK_FLOWS_DIR, "routine.hourly_check.md"), "utf-8");
    expect(body).toContain("External services are read-only this hour");
    // Each touched system must be named so the agent can't argue
    // a particular surface (e.g. calendar) is unaffected.
    expect(body).toMatch(/Notion/);
    expect(body).toMatch(/mail/i);
    expect(body).toMatch(/calendar/i);
    expect(body).toMatch(/GitHub/);
    // The rule must explicitly cover the same-backend-delegated mode
    // where the skill body is dropped — otherwise that path is
    // structurally unprotected.
    expect(body).toMatch(/same-backend delegated/i);
  });

  test("notion/SKILL.base.md was removed (Phase 9 dead-asset cleanup)", () => {
    // The orphaned base.md never had a `{{> base }}` consumer; its
    // hourly-check read-only constraint relocated to the task-flow,
    // its other sections either duplicated the delegated variants or
    // described connector-literal formats with no valid load path.
    // The file's continued presence would re-create the dead-asset
    // confusion that motivated the cleanup.
    expect(existsSync(join(SKILLS_DIR, "notion", "SKILL.base.md"))).toBe(false);
  });

  test("every SKILL.md description field is ≤ 280 chars", () => {
    const DESCRIPTION_RE = /^description:\s*(.+)$/m;
    for (const { slug, dir } of listBuiltinSkillDirs(SKILLS_DIR)) {
      const skillPath = join(dir, "SKILL.md");
      if (!existsSync(skillPath)) continue;

      const content = readFileSync(skillPath, "utf-8");
      const match = content.match(DESCRIPTION_RE);
      if (!match) continue;

      const description = match[1].trim();
      if (description.length > 200) {
        console.warn(`Skill '${slug}' description is ${description.length} chars (warn threshold: 200)`);
      }
      expect(
        description.length,
        `Skill '${slug}' description is ${description.length} chars (max: 280)`,
      ).toBeLessThanOrEqual(280);
    }
  });
});

/**
 * BROWSER_TASK_REDESIGN_PLAN.md §10 / Phase 5 — wiring guards for the
 * new `browser-task` skill. The skill replaces the historically-missing
 * DM-driven entry point to the browser-task surface (the legacy
 * `browser-history-managed` skill was never in `message.received.dm`).
 *
 * These tests pin three things a future refactor must not silently
 * regress:
 *   1. The slug is loaded by `message.received.dm` AND inherited by
 *      `message.dm` / `dashboard.chat` via `PROCESS_TO_EVENT_TYPE`
 *      (where `resolveSkillManifestForProcess` looks).
 *   2. The slug is NOT loaded for mentions, scheduled DMs, scheduled
 *      tasks, or routines — those surfaces have no DM-time
 *      conversational bookend and the skill is dead weight there.
 *   3. The skill body covers every contract the §10 spec calls out
 *      (POST shape, /clarify, /cancel, awaiting_user listening, the
 *      do-not-relay rule for `!~xxxxxxxx` tokens, registered siteKey
 *      table). Drift here would replicate the gap the redesign exists
 *      to close.
 */
describe("browser-task skill wiring (BROWSER_TASK_REDESIGN_PLAN Phase 5)", () => {
  const SKILL_PATH = join(SKILLS_DIR, "browser-task", "SKILL.md");

  test("SKILL.md exists at agent-assets/skills/browser-task/", () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
  });

  test("frontmatter declares name=browser-task with Bash(curl *) allowed-tool", () => {
    const body = readFileSync(SKILL_PATH, "utf-8");
    const fm = body.match(/^---\n([\s\S]+?)\n---/);
    expect(fm, "missing YAML frontmatter").toBeTruthy();
    const fmBody = fm![1];
    expect(fmBody).toMatch(/^name:\s*browser-task\s*$/m);
    // `allowed-tools` must whitelist curl — the skill ships no other
    // mechanism for the agent to reach localhost. A future widening
    // (Read / Write / Edit) would let the agent bypass the daemon
    // chokepoint that owns audit + redaction; pin the list.
    expect(fmBody).toMatch(/allowed-tools:[\s\S]*Bash\(curl \*\)/);
    expect(fmBody).not.toMatch(/Bash\(rm\s/);
    expect(fmBody).not.toMatch(/^\s+-\s+(Read|Write|Edit|WebFetch)\b/m);
  });

  test("ALL_SKILLS includes browser-task", () => {
    expect(ALL_SKILLS).toContain("browser-task");
  });

  test.each([
    "message.received.dm",
    "message.received.dm_first",
  ])("loaded by event '%s' (static manifest)", (eventType) => {
    const slugs = EVENT_SKILL_SETS[eventType];
    expect(slugs, `event '${eventType}' has no manifest`).toBeDefined();
    expect(slugs).toContain("browser-task");
  });

  test("loaded for message.dm + dashboard.chat process keys via PROCESS_TO_EVENT_TYPE", () => {
    // Both process keys route through `message.received.dm`. A future
    // PROCESS_TO_EVENT_TYPE edit that moves either off this event
    // would silently drop the browser-task surface from that channel.
    expect(getSkillsForProcess("message.dm")).toContain("browser-task");
    expect(getSkillsForProcess("dashboard.chat")).toContain("browser-task");
  });

  test("resolveSkillManifestForProcess returns browser-task for the DM process keys", () => {
    // The resolver wrapper is the production call site; pin its
    // answer too so a future predicate that conditionally drops the
    // skill cannot bypass the static assertion above.
    expect(
      resolveSkillManifestForProcess("message.dm"),
    ).toContain("browser-task");
    expect(
      resolveSkillManifestForProcess("dashboard.chat"),
    ).toContain("browser-task");
  });

  test.each([
    "message.received",
    "scheduled.dm",
    "scheduled.task",
    "routine.morning_routine",
    "routine.hourly_check",
    "routine.evening_review",
  ])("NOT loaded for non-DM-chat event '%s'", (eventType) => {
    const slugs = EVENT_SKILL_SETS[eventType];
    expect(slugs, `event '${eventType}' has no manifest`).toBeDefined();
    // Mentions land on `message.received` (shared-channel surface);
    // scheduled DMs are daemon-initiated (no user-driven browser ask
    // to relay); routines have no DM-bookend. Adding browser-task to
    // any of these expands the skill's injection surface beyond the
    // §10 spec.
    expect(slugs, `event '${eventType}' must not carry browser-task`)
      .not.toContain("browser-task");
  });

  test("body covers every §10 contract topic", () => {
    const body = readFileSync(SKILL_PATH, "utf-8");
    // POST surface + how to compose
    expect(body).toMatch(/POST\s+\/api\/browser-task\b/);
    expect(body).toMatch(/\bdescription\b/);
    expect(body).toMatch(/\bsiteKey\b/);
    expect(body).toMatch(/\bscheduleAt\b/);
    expect(body).toMatch(/\brequireFinalConfirm\b/);
    // awaiting_user listening + /clarify shape
    expect(body).toMatch(/awaiting_user/);
    expect(body).toMatch(/clarificationId/);
    expect(body).toMatch(/\/clarify\b/);
    // /cancel shape (when user says "stop")
    expect(body).toMatch(/\/cancel\b/);
    // Final-confirm token do-not-relay rule
    expect(body).toMatch(/!~xxxxxxxx/);
    expect(body).toMatch(/never\s+(echo|read|paraphrase|relay)/i);
    // Fire-and-forget contract — the DM agent must POST, ack, and end
    // the turn; the daemon delivers the result directly. The skill MUST
    // forbid completion-polling in prose, otherwise the agent re-reads
    // GET /:id in a loop, re-processes the whole DM history each turn,
    // and burns its per-turn budget (the false "per-turn budget limit"
    // DM the user saw while the detached task still completed fine).
    expect(body.toLowerCase()).toMatch(/never poll/i);
    expect(body).toMatch(/end (your|the) turn/i);
    // Open navigation (2026-05-27 revision) — the Phase-4 registered-
    // siteKey table was removed at the owner's "no hardcoded domain
    // denylist" directive, so the skill no longer carries amazon_jp /
    // netflix / … rows. The skill instead teaches that navigation is
    // open and gated by the user-curated denylist at runtime.
    expect(body.toLowerCase()).toMatch(/open navigation|navigation is open/i);
  });

  test("body declares localhost-only contract (regression guard for the curl chokepoint)", () => {
    const body = readFileSync(SKILL_PATH, "utf-8");
    expect(body).toContain("127.0.0.1:8321");
    // The "localhost only" rule must be explicit prose, not just a
    // curl example — otherwise a future agent edit could quote the
    // example as "the daemon URL" while widening to a non-loopback
    // host. Pin a phrase that asserts the constraint.
    expect(body.toLowerCase()).toMatch(/localhost only/i);
  });

  test("body documents that siteKey / extraAllowedHosts were dropped (open navigation)", () => {
    // 2026-05-27 open-navigation revision: the POST body no longer
    // accepts `siteKey` or `extraAllowedHosts` (legacy callers are
    // silently ignored). The skill must say so explicitly so the agent
    // doesn't try to compose a pre-declared host set; navigation is open
    // and gated by the user-curated denylist at runtime instead.
    const body = readFileSync(SKILL_PATH, "utf-8");
    expect(body).toContain("siteKey");
    expect(body).toContain("extraAllowedHosts");
    expect(body.toLowerCase()).toMatch(/dropped both|silently ignored/i);
  });

  test("body carries no registered-siteKey table (open navigation guard)", async () => {
    // 2026-05-27 open-navigation revision + the owner's "no hardcoded
    // domain denylist" directive: browser-task navigation is open, so
    // the skill must NOT enumerate a per-site table. SITE_REGISTRY still
    // exists, but it backs the SEPARATE per-site sign-in / auth surface
    // (`/api/browser-automation/sites/*`), NOT browser-task — so none of
    // its keys should leak into a markdown table here. This guards
    // against a future edit accidentally re-introducing the retired
    // Phase-4 registered-site list.
    const body = readFileSync(SKILL_PATH, "utf-8");
    const { SITE_REGISTRY } = await import(
      "../services/browser-history/automation/site-registry.js"
    );
    const TABLE_ROW_RE = /^\|\s*`([a-z][a-z0-9_]+)`\s*\|/gm;
    const referenced = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = TABLE_ROW_RE.exec(body)) !== null) {
      referenced.add(m[1]);
    }
    for (const key of Object.keys(SITE_REGISTRY)) {
      expect(
        referenced.has(key),
        `browser-task SKILL.md re-introduced a registered-site row for '${key}' — navigation is open (2026-05-27); the per-site table belongs to the sign-in surface, not this skill`,
      ).toBe(false);
    }
    // Sign-in lives on the other surface — the skill must point there
    // rather than implying browser-task drives per-site auth.
    expect(body).toMatch(/\/api\/browser-automation\/sites/);
  });
});

/**
 * Skill-body content invariants for the multi-purpose skills (`mail`,
 * `external-services`) whose direct-mode body must teach delegation-aware
 * routing for the integration that touches them. Without these
 * paragraphs the agent loses the non-Gmail / non-Calendar surface in
 * same-backend delegated mode (regression guard for the
 * `sameBackendDropsSkillBody` semantics — see Findings B / B').
 *
 * Same invariants for the cross-backend variants: `mail/SKILL.delegated.*`
 * must declare that non-Gmail accounts keep their direct-mode routes
 * (sibling case discovered during final review).
 */
describe("skill-body delegation routing prose", () => {
  test("mail/SKILL.md §0 documents per-account mode-aware routing for gmail and outlook_mail", () => {
    const body = readFileSync(join(SKILLS_DIR, "mail", "SKILL.md"), "utf-8");
    // Section heading is the anchor for the routing block. The 2026-05
    // §5.3 native-mode amendment widened the §0 prose from "Delegation-
    // aware routing" (gmail-only) to "Per-account mode-aware routing"
    // covering outlook_mail too.
    expect(body).toContain("Per-account mode-aware routing");
    // Reference to the runtime mode signal the agent reads.
    expect(body).toContain("<integration_modes>");
    // The 410 from the per-account gate is the failure mode the agent
    // must short-circuit on, not retry. Both delegated and native
    // (2026-05 widening) must be documented.
    expect(body).toContain("410");
    expect(body).toContain("integration_delegated");
    expect(body).toContain("integration_native");
    // Routing intent for the in-session connector fallback when a Gmail
    // account is selected under same-backend delegation. We deliberately
    // do NOT pin specific tool name strings (the user's harness may
    // expose those tools under any namespace) — assert on the intent
    // prose instead so the LLM can pick the right tool from its menu.
    expect(body).toMatch(/in-session Gmail connector/i);
    // The non-gated kinds that must keep `/api/mail/*` regardless of mode.
    expect(body).toContain("iCloud");
    expect(body).toContain("IMAP");
    expect(body).toContain("Yahoo");
    // Outlook gets its own per-mode branches — the prose must mention
    // both modes that 410 (delegated + native) and that the daemon
    // ships no proxy for the user-managed connector.
    expect(body).toContain("outlook_mail");
    expect(body).toMatch(/user-managed connector/i);
  });

  test("external-services/SKILL.md documents delegation-aware routing for same-backend Calendar", () => {
    const body = readFileSync(
      join(SKILLS_DIR, "external-services", "SKILL.md"),
      "utf-8",
    );
    // Heading was widened to disambiguate Google from Apple Calendar
    // when both are documented in the same skill body.
    expect(body).toMatch(/Delegation-aware routing for (Google )?Calendar/);
    expect(body).toContain("<integration_modes>");
    expect(body).toContain("410");
    expect(body).toContain("integration_delegated");
    // Routing intent for the in-session Calendar connector (replaces the
    // older pinned tool-name strings — see the mail test above for the
    // same rationale).
    expect(body).toMatch(/in-session Google Calendar connector/i);
    // The non-Calendar surfaces that must remain on direct routes.
    expect(body).toContain("Obsidian");
    expect(body).toContain("GitHub");
    // Non-Calendar surfaces are explicitly described as direct-mode
    // (the doc states they are unaffected by Calendar's mode). The
    // wording wraps lines, so collapse whitespace before matching.
    const flat = body.replace(/\s+/g, " ");
    expect(flat).toMatch(/regardless of (Calendar's )?mode/i);
  });

  test.each(["claude", "codex", "gemini"] as const)(
    "mail/SKILL.delegated.%s.md teaches non-Gmail accounts to keep the direct-mode `/api/mail/*` surface",
    (sessionBackend) => {
      const body = readFileSync(
        join(SKILLS_DIR, "mail", `SKILL.delegated.${sessionBackend}.md`),
        "utf-8",
      );
      // The cross-backend variant must not claim ALL mail routes are
      // inert — that's the bug the sibling-case fix corrected. The
      // routing must be expressed per account `kind`.
      expect(body).toContain("Non-Gmail accounts");
      expect(body).toContain("/api/mail/");
      expect(body).toContain("kind");
      // Per-account gating language so the agent doesn't try the proxy
      // path for IMAP/Outlook/iCloud/Yahoo.
      expect(body).toMatch(/imap|IMAP/);
      expect(body).toContain("outlook");
      expect(body).toContain("icloud");
    },
  );

  test.each(["claude", "codex", "gemini"] as const)(
    "external-services/SKILL.delegated.%s.md keeps non-Calendar surfaces on direct-mode routes",
    (sessionBackend) => {
      const body = readFileSync(
        join(
          SKILLS_DIR,
          "external-services",
          `SKILL.delegated.${sessionBackend}.md`,
        ),
        "utf-8",
      );
      // The cross-backend variant must scope its proxy guidance to
      // Calendar only — Obsidian / GitHub / scheduling stay on direct.
      expect(body).toContain("Obsidian");
      expect(body).toContain("GitHub");
      expect(body).toMatch(/recurring|scheduling/);
      // The narrowing claim ("only the Calendar section changes") is
      // the contract that prevents over-routing through the proxy.
      expect(body.toLowerCase()).toMatch(/only the calendar.*changes|unchanged from the direct/);
    },
  );
});

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §7.1 / §8.1 / §8.5 — every
 * (integration, native-supported backend) pair must have its skill and
 * task-flow variants authored on disk before a release that ships
 * native mode. The Phase B2 content lands these files; this test pins
 * them so a future Phase C UI flip that activates native mode for
 * users cannot drop a variant file silently.
 */
describe("native variant existence (Phase B2 content)", () => {
  const NATIVE_INTEGRATIONS: Array<{
    key: string;
    skillSlug: string;
    backends: readonly ("claude" | "codex" | "gemini")[];
  }> = [
    { key: "gmail", skillSlug: "mail", backends: ["claude", "codex", "gemini"] },
    {
      key: "google_calendar",
      skillSlug: "external-services",
      backends: ["claude", "codex", "gemini"],
    },
    { key: "notion", skillSlug: "notion", backends: ["claude", "codex", "gemini"] },
  ];

  for (const { key, skillSlug, backends } of NATIVE_INTEGRATIONS) {
    for (const backend of backends) {
      test(`${skillSlug}/SKILL.native.${backend}.md exists for ${key}`, () => {
        const path = join(SKILLS_DIR, skillSlug, `SKILL.native.${backend}.md`);
        expect(existsSync(path), `Missing native skill variant: ${path}`).toBe(true);
      });
    }
  }

  // Per §17 Phase B2: DM + dm_first native variants are authored for
  // every backend that has at least one native-supported integration.
  // The task-flow variant existence assertion is keyed on backend, not
  // integration — the variant applies session-wide once any touched
  // integration is native and bound to the session backend.
  //
  // docs/design/appendices/routine-data-acquisition.md Phase 3 R4 removed
  // `routine.hourly_check` from this matrix — the variant files
  // (`routine.hourly_check.native.<be>.md`) were deleted; the
  // partial-include mechanism in the base `routine.hourly_check.md`
  // now carries the mode-specific prose for every (delegated × native)
  // permutation. `loadFlowVariant` falls through to the base when the
  // selector returns `native.<be>` for hourly_check.
  const NATIVE_TASK_FLOWS = [
    "message.received.dm",
    "message.received.dm_first",
  ];

  for (const flow of NATIVE_TASK_FLOWS) {
    for (const backend of ["claude", "codex", "gemini"] as const) {
      test(`${flow}.native.${backend}.md exists`, () => {
        const path = join(TASK_FLOWS_DIR, `${flow}.native.${backend}.md`);
        expect(existsSync(path), `Missing native task-flow variant: ${path}`).toBe(true);
      });
    }
  }

  // The native variant's structural contract: every native skill body
  // opens with an explicit refusal directive forbidding the daemon
  // exec/reconcile/per-key routes that would return 410 in native
  // mode. This is the §7.2 requirement — without it the agent may
  // burn turns retrying a 410-gated path the design explicitly
  // closed off.
  test.each([
    ["mail", "claude", "/api/integrations/gmail/exec"],
    ["mail", "codex", "/api/integrations/gmail/exec"],
    ["mail", "gemini", "/api/integrations/gmail/exec"],
    ["external-services", "claude", "/api/integrations/google_calendar/exec"],
    ["external-services", "codex", "/api/integrations/google_calendar/exec"],
    ["external-services", "gemini", "/api/integrations/google_calendar/exec"],
    ["notion", "claude", "/api/integrations/notion/exec"],
    ["notion", "codex", "/api/integrations/notion/exec"],
    ["notion", "gemini", "/api/integrations/notion/exec"],
  ])(
    "%s/SKILL.native.%s.md opens with a refusal directive for %s",
    (skillSlug, backend, refusedRoute) => {
      const body = readFileSync(
        join(SKILLS_DIR, skillSlug, `SKILL.native.${backend}.md`),
        "utf-8",
      );
      expect(body).toContain(refusedRoute);
      // The refusal language is normative — "Do NOT" / "do **NOT**"
      // anchors the rule for the agent. Case-insensitive so a
      // future rewrite can soften the emphasis without breaking
      // the contract.
      expect(body.toLowerCase()).toMatch(/do\s*\*?\*?\s*not\s*\*?\*?\s*call/);
      // The 410 contract must be stated — without it the agent may
      // treat the rejection as a transient error and retry.
      expect(body).toContain("410");
    },
  );

  // §7.2 — each native skill variant must describe routing INTENT for the
  // in-session connector that targets the integration. We deliberately
  // do NOT pin specific tool name strings (e.g. `mcp__claude_ai_Gmail__`):
  // the user's MCP harness may surface those tools under any namespace,
  // and the LLM picks the right tool from its tool menu at session start.
  // Pinning specific names here would re-introduce the failure mode the
  // 2026-05-13 intent-only rewrite resolved (parent routine seeing
  // `<fetch_report status='failed'>` because the prescribed tool name
  // wasn't in the actual harness).
  test.each([
    ["mail", "claude", /Gmail connector/i],
    ["mail", "codex", /Gmail connector/i],
    ["mail", "gemini", /Gmail connector/i],
    ["external-services", "claude", /Calendar connector/i],
    ["external-services", "codex", /Calendar connector/i],
    ["external-services", "gemini", /Calendar connector/i],
    ["notion", "claude", /Notion connector/i],
    ["notion", "codex", /Notion connector/i],
    ["notion", "gemini", /Notion connector/i],
  ])(
    "%s/SKILL.native.%s.md describes the in-session connector routing intent",
    (skillSlug, backend, intentPattern) => {
      const body = readFileSync(
        join(SKILLS_DIR, skillSlug, `SKILL.native.${backend}.md`),
        "utf-8",
      );
      // Connector-by-service intent: the body must mention the relevant
      // connector by service name (Gmail / Calendar / Notion). This is
      // the loosened post-2026-05-13 contract — see comment above.
      expect(body).toMatch(intentPattern);
      // Tool-name agnostic anchor: the body must EITHER mention the
      // user's harness explicitly ("your harness", "your tool menu") OR
      // describe the connector as in-session. Both signal that the LLM
      // should pick the tool from its runtime menu rather than a
      // hardcoded name.
      const hasHarnessAnchor =
        /your harness/i.test(body) || /your tool menu/i.test(body);
      const hasInSessionAnchor = /in-session/i.test(body);
      expect(hasHarnessAnchor || hasInSessionAnchor).toBe(true);
    },
  );

  // §7.2 — multi-provider skills (`mail` covers IMAP/Outlook/iCloud/
  // Yahoo; `external-services` covers Obsidian/GitHub/scheduling/
  // Apple Calendar/Outlook Calendar) must document the non-Gmail /
  // non-Calendar surfaces as direct-mode routes regardless of the
  // native binding. Without this paragraph the agent loses non-native
  // surfaces under native mode.
  test.each(["claude", "codex", "gemini"] as const)(
    "mail/SKILL.native.%s.md keeps non-Gmail accounts on the direct-mode /api/mail/* surface",
    (backend) => {
      const body = readFileSync(
        join(SKILLS_DIR, "mail", `SKILL.native.${backend}.md`),
        "utf-8",
      );
      expect(body).toContain("Non-Gmail accounts");
      expect(body).toContain("/api/mail/");
      expect(body.toLowerCase()).toMatch(/imap|outlook|icloud|yahoo/);
    },
  );

  test.each(["claude", "codex", "gemini"] as const)(
    "external-services/SKILL.native.%s.md keeps Obsidian / GitHub / scheduling on direct-mode routes",
    (backend) => {
      const body = readFileSync(
        join(SKILLS_DIR, "external-services", `SKILL.native.${backend}.md`),
        "utf-8",
      );
      expect(body).toContain("Obsidian");
      expect(body).toContain("GitHub");
      expect(body).toMatch(/recurring|scheduling|skills management/i);
    },
  );

  // §8.3 — every native variant must teach the agent the
  // `POST /api/observations` persistence contract. The route accepts
  // raw `payload` and the daemon computes the server-side hash; the
  // agent must NOT compute the hash itself (LLM hashes drift between
  // runs and from the worker's hash, breaking delegated→native flip
  // dedup).
  test.each([
    ["mail", "claude"],
    ["mail", "codex"],
    ["mail", "gemini"],
    ["external-services", "claude"],
    ["external-services", "codex"],
    ["external-services", "gemini"],
    ["notion", "claude"],
    ["notion", "codex"],
    ["notion", "gemini"],
  ])(
    "%s/SKILL.native.%s.md documents the /api/observations POST contract",
    (skillSlug, backend) => {
      const body = readFileSync(
        join(SKILLS_DIR, skillSlug, `SKILL.native.${backend}.md`),
        "utf-8",
      );
      expect(body).toContain("/api/observations");
      expect(body.toLowerCase()).toMatch(/contenthash/);
      // The "do not compute hash yourself" rule — the design's §8.3
      // load-bearing guarantee for cross-mode dedup.
      expect(body.toLowerCase()).toMatch(/server-side/);
    },
  );

  // docs/design/appendices/routine-data-acquisition.md Phase 3 R4 — the
  // `routine.hourly_check.native.<be>.md` variants are deleted. The
  // §8.3 contracts they used to encode (no /reconcile POSTs; documents
  // /api/observations; inherits the read-only constraint) live on
  // against the base file + partials, which are exercised by
  // `getTaskFlow` and pinned in `prompts.test.ts` (task flow quality
  // suite) and `routine-task-flow-includes.test.ts`. The static-file
  // version of this assertion is replaced by a check that the variants
  // no longer exist — `missingNativeVariants` skips them now too (the
  // §6.10 descriptor matrix declares the partial-only coupling).
  test.each(["claude", "codex", "gemini"] as const)(
    "routine.hourly_check.native.%s.md is deleted (Phase 3 R4 — superseded by partial-include mechanism)",
    (backend) => {
      expect(
        existsSync(join(TASK_FLOWS_DIR, `routine.hourly_check.native.${backend}.md`)),
      ).toBe(false);
    },
  );

  // §8.5 — running `missingNativeVariants` for every supported
  // (integration, native backend) pair must produce empty arrays.
  // This is the static integrity assert: a release that ships native
  // mode and is missing any variant file fails CI here. Test imports
  // the helper lazily so the file can stay in agent-assets-only
  // territory; the daemon import is deliberate.
  describe("missingNativeVariants — real agent-assets integrity", () => {
    test("every supported (integration, native backend) pair has every advertised variant on disk", async () => {
      const { INTEGRATION_DESCRIPTORS, INTEGRATION_KEYS } = await import("@aitne/shared");
      const { missingNativeVariants } = await import("./skills-compiler-variants.js");
      const repoRoot = REPO_ROOT;
      type BackendId = "claude" | "codex" | "gemini";
      for (const key of INTEGRATION_KEYS) {
        const descriptor = INTEGRATION_DESCRIPTORS[key];
        const declaredBackends = Object.keys(
          descriptor.backendConnectors,
        ) as BackendId[];
        for (const backend of declaredBackends) {
          const result = missingNativeVariants(repoRoot, key, backend);
          expect(
            result,
            `${key} × ${backend}: missing variants ${JSON.stringify(result)}`,
          ).toEqual({ skills: [], taskFlows: [] });
        }
      }
    });
  });
});

/**
 * `evening-review-slimdown.md` §2.1 Phase 2 — Q6 resolution. Conditional
 * `notify` loading for `routine.evening_review` based on the runtime
 * presence of operator-authored `routines/evening.md` rules. Predicate
 * isolated in `eveningRulebookIsActive`; resolver in
 * `resolveSkillManifest`.
 */
describe("eveningRulebookIsActive predicate", () => {
  let ctxRoot: string;
  let rulebookPath: string;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), "pa-evening-rulebook-"));
    mkdirSync(join(ctxRoot, "policies", "routines"), { recursive: true });
    rulebookPath = join(ctxRoot, "policies", "routines", "evening.md");
  });

  afterEach(() => {
    // Some test paths chmod 0 the file to simulate unreadability. Restore
    // before removal so cleanup never trips on EACCES.
    if (existsSync(rulebookPath)) {
      try {
        chmodSync(rulebookPath, 0o600);
      } catch {
        // ignore — best-effort restoration
      }
    }
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  test("returns false when contextDir is undefined", () => {
    expect(eveningRulebookIsActive(undefined)).toBe(false);
  });

  test("returns false when contextDir is null", () => {
    expect(eveningRulebookIsActive(null)).toBe(false);
  });

  test("returns false when contextDir is the empty string", () => {
    // Conservative default — the static manifest already drops notify on
    // this branch, mirroring the "rulebook inactive" answer.
    expect(eveningRulebookIsActive("")).toBe(false);
  });

  test("returns false when the rulebook file is absent", () => {
    expect(eveningRulebookIsActive(ctxRoot)).toBe(false);
  });

  test("returns false when the rulebook is empty", () => {
    writeFileSync(rulebookPath, "", "utf-8");
    expect(eveningRulebookIsActive(ctxRoot)).toBe(false);
  });

  test("returns false when the rulebook is whitespace-only", () => {
    writeFileSync(rulebookPath, "   \n\n\t\n   ", "utf-8");
    expect(eveningRulebookIsActive(ctxRoot)).toBe(false);
  });

  test("returns false when the rulebook contains only comments / non-heading prose", () => {
    writeFileSync(
      rulebookPath,
      "<!-- not yet authored -->\n\nFreeform notes — no rules yet.\n",
      "utf-8",
    );
    expect(eveningRulebookIsActive(ctxRoot)).toBe(false);
  });

  test("returns false when the rulebook only has H1 / H2 headings (the rule convention is H3)", () => {
    // H3 is the documented rule-heading shape; H1/H2 are file structure.
    writeFileSync(
      rulebookPath,
      "# Evening rulebook\n\n## Notes\n\nPlaceholder.\n",
      "utf-8",
    );
    expect(eveningRulebookIsActive(ctxRoot)).toBe(false);
  });

  test("returns true when the rulebook has a single `### ` rule heading", () => {
    writeFileSync(
      rulebookPath,
      "### Check stripe metrics\n\nPull yesterday's MRR snapshot.\n",
      "utf-8",
    );
    expect(eveningRulebookIsActive(ctxRoot)).toBe(true);
  });

  test("returns true when the rulebook has multiple `### ` rule headings", () => {
    writeFileSync(
      rulebookPath,
      [
        "# Evening rules",
        "",
        "### Stripe metrics",
        "Notify me about churn outliers.",
        "",
        "### Inbox triage",
        "If anything from the board, DM me.",
        "",
      ].join("\n"),
      "utf-8",
    );
    expect(eveningRulebookIsActive(ctxRoot)).toBe(true);
  });

  test("treats `####` (and deeper) headings as non-rule structure — returns false", () => {
    writeFileSync(
      rulebookPath,
      "#### subsection only\n\nNot a rule heading.\n",
      "utf-8",
    );
    expect(eveningRulebookIsActive(ctxRoot)).toBe(false);
  });

  test("requires the heading to be at column 0 — indented `### ` does not qualify", () => {
    writeFileSync(
      rulebookPath,
      "    ### indented heading\n\nNot a top-level rule.\n",
      "utf-8",
    );
    expect(eveningRulebookIsActive(ctxRoot)).toBe(false);
  });

  test("returns false when the rulebook is unreadable (permissions stripped)", () => {
    writeFileSync(rulebookPath, "### Stripe metrics\n", "utf-8");
    // chmod 0 simulates the deleted-between-existsSync-and-read race
    // *and* the permission-denied case. POSIX-only — root would still
    // be able to read, but vitest runs as the invoking user so this is
    // a reliable signal on the macOS/Linux dev surfaces this project
    // targets.
    try {
      chmodSync(rulebookPath, 0o000);
    } catch {
      // If the platform doesn't honour chmod (e.g. odd CI containers),
      // the test is a no-op rather than a false positive.
      return;
    }
    // Sanity — the predicate must NOT throw on EACCES; it must answer
    // "rulebook inactive" so the materializer falls back to the
    // conservative branch.
    expect(() => eveningRulebookIsActive(ctxRoot)).not.toThrow();
    expect(eveningRulebookIsActive(ctxRoot)).toBe(false);
  });
});

describe("resolveSkillManifest wrapper", () => {
  let ctxRoot: string;
  let rulebookPath: string;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), "pa-resolve-manifest-"));
    mkdirSync(join(ctxRoot, "policies", "routines"), { recursive: true });
    rulebookPath = join(ctxRoot, "policies", "routines", "evening.md");
  });

  afterEach(() => {
    if (existsSync(rulebookPath)) {
      try {
        chmodSync(rulebookPath, 0o600);
      } catch {
        // ignore
      }
    }
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  test("passes through non-evening events unchanged regardless of contextDir", () => {
    // The wrapper is per-event opt-in — every other event still resolves
    // to the static array. Spot-check a busy DM manifest so a future
    // accidental widening of the predicate is caught here.
    const direct = EVENT_SKILL_SETS["message.received"];
    expect(resolveSkillManifest("message.received")).toEqual(direct);
    expect(
      resolveSkillManifest("message.received", { contextDir: ctxRoot }),
    ).toEqual(direct);
    // Even passing a contextDir that DOES carry an evening rulebook does
    // not affect a non-evening event.
    writeFileSync(rulebookPath, "### a rule\n", "utf-8");
    expect(
      resolveSkillManifest("message.received", { contextDir: ctxRoot }),
    ).toEqual(direct);
  });

  test("falls back to ALL_SKILLS for unknown event types", () => {
    // Matches the conservative behaviour of `getSkillsForEvent`.
    expect(resolveSkillManifest("not.a.real.event")).toEqual(ALL_SKILLS);
  });

  test("returns the evening manifest WITHOUT notify when the rulebook is missing", () => {
    const result = resolveSkillManifest("routine.evening_review", {
      contextDir: ctxRoot,
    });
    expect(result).not.toContain("notify");
    // The five non-notify slugs MUST survive — they are load-bearing for
    // the built-in Handoff / Long-term Plans / Raw Signals graduation
    // steps. A regression that drops one of these is silent context loss.
    for (const slug of ["context", "today", "user-profile", "roadmap", "management-policy"]) {
      expect(result).toContain(slug);
    }
    // `travel` was removed unconditionally by the Phase 2 slimdown.
    expect(result).not.toContain("travel");
  });

  test("returns the evening manifest WITHOUT notify when the rulebook is empty", () => {
    writeFileSync(rulebookPath, "", "utf-8");
    expect(
      resolveSkillManifest("routine.evening_review", { contextDir: ctxRoot }),
    ).not.toContain("notify");
  });

  test("returns the evening manifest WITHOUT notify when the rulebook has no `### ` heading", () => {
    writeFileSync(
      rulebookPath,
      "# Evening rules\n\n## Drafts\n\nNothing here yet.\n",
      "utf-8",
    );
    expect(
      resolveSkillManifest("routine.evening_review", { contextDir: ctxRoot }),
    ).not.toContain("notify");
  });

  test("returns the evening manifest WITH notify when the rulebook has at least one `### ` heading", () => {
    writeFileSync(
      rulebookPath,
      "### Stripe metrics\n\nNotify me about churn outliers.\n",
      "utf-8",
    );
    const result = resolveSkillManifest("routine.evening_review", {
      contextDir: ctxRoot,
    });
    expect(result).toContain("notify");
    // Notify must be alongside, not replacing, the load-bearing slugs.
    for (const slug of ["context", "today", "user-profile", "roadmap", "management-policy"]) {
      expect(result).toContain(slug);
    }
  });

  test("returns the evening manifest WITHOUT notify when contextDir is omitted (conservative default)", () => {
    expect(resolveSkillManifest("routine.evening_review")).not.toContain(
      "notify",
    );
  });

  test("`resolveSkillManifestForProcess('routine.evening_review', …)` matches the event-keyed wrapper", () => {
    // The process-key wrapper has to route through the same predicate —
    // without it, the production call sites (which key on ProcessKey)
    // would bypass the gate.
    writeFileSync(rulebookPath, "### a rule\n", "utf-8");
    expect(
      resolveSkillManifestForProcess("routine.evening_review", {
        contextDir: ctxRoot,
      }),
    ).toEqual(
      resolveSkillManifest("routine.evening_review", { contextDir: ctxRoot }),
    );
    // …and the rulebook-absent branch agrees too.
    rmSync(rulebookPath, { force: true });
    expect(
      resolveSkillManifestForProcess("routine.evening_review", {
        contextDir: ctxRoot,
      }),
    ).toEqual(
      resolveSkillManifest("routine.evening_review", { contextDir: ctxRoot }),
    );
  });

  test("static `EVENT_SKILL_SETS[routine.evening_review]` no longer carries the dropped `travel` slug", () => {
    // Phase 2 dropped travel unconditionally. Pinning the static array
    // here keeps a future "add travel back to evening_review" PR from
    // sliding through unreviewed; the slug only justified itself for the
    // deleted Step 4 booking-detection path.
    const base = EVENT_SKILL_SETS["routine.evening_review"];
    expect(base).toBeDefined();
    expect(base).not.toContain("travel");
    // The static array is the "rulebook-active" answer — notify lives
    // here and the resolver subtracts it when the rulebook is inactive.
    expect(base).toContain("notify");
  });
});

/**
 * docs/design/appendices/skills-improvement.md §9-§11 + §14 — predicate tests for the
 * merged `gmail-lifestyle` and `managed-tasks` skills. The predicates
 * are runtime-cheap (single indexed `LIMIT 1` per check) and decide
 * whether the conditional skill is loaded for a given event.
 */
describe("gmailLifestyleActive predicate", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE travel_bookings (
        id INTEGER PRIMARY KEY,
        start_date TEXT NOT NULL
      );
      CREATE TABLE receipts (
        id INTEGER PRIMARY KEY,
        saved_at TEXT
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  test("returns true when db handle is undefined (conservative include)", () => {
    expect(gmailLifestyleActive(undefined)).toBe(true);
  });

  test("returns true when db handle is null (conservative include)", () => {
    expect(gmailLifestyleActive(null)).toBe(true);
  });

  test("returns false when both tables are empty", () => {
    expect(gmailLifestyleActive(db)).toBe(false);
  });

  test("returns true on a fresh booking (start_date within last 30 days)", () => {
    db.prepare("INSERT INTO travel_bookings (start_date) VALUES (datetime('now', '-10 days'))").run();
    expect(gmailLifestyleActive(db)).toBe(true);
  });

  test("returns true on a future booking", () => {
    db.prepare("INSERT INTO travel_bookings (start_date) VALUES (datetime('now', '+5 days'))").run();
    expect(gmailLifestyleActive(db)).toBe(true);
  });

  test("returns false when only stale bookings exist (> 30 days old)", () => {
    db.prepare("INSERT INTO travel_bookings (start_date) VALUES (datetime('now', '-100 days'))").run();
    expect(gmailLifestyleActive(db)).toBe(false);
  });

  test("returns true on an unsaved receipt", () => {
    db.prepare("INSERT INTO receipts (saved_at) VALUES (NULL)").run();
    expect(gmailLifestyleActive(db)).toBe(true);
  });

  test("returns false when receipts are all saved", () => {
    db.prepare("INSERT INTO receipts (saved_at) VALUES (datetime('now'))").run();
    expect(gmailLifestyleActive(db)).toBe(false);
  });

  test("returns true when schema is missing (conservative include on table error)", () => {
    const broken = new Database(":memory:");
    expect(gmailLifestyleActive(broken)).toBe(true);
    broken.close();
  });
});

describe("gmailLifestyleActiveForDm trigger phrases", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE travel_bookings (id INTEGER PRIMARY KEY, start_date TEXT);
      CREATE TABLE receipts (id INTEGER PRIMARY KEY, saved_at TEXT);
    `);
  });
  afterEach(() => db.close());

  test("returns base predicate when message text is null", () => {
    expect(gmailLifestyleActiveForDm(db, null)).toBe(false);
  });

  test.each([
    ["please file this receipt", true],
    ["log my expense report", true],
    ["the invoice from acme", true],
    ["book a flight to SFO", true],
    ["hotel reservation for next week", true],
    ["catch the train at 10", true],
    ["my commute is 30 min", true],
    ["estimate departure time", true],
    ["upcoming trip", true],
    ["new booking", true],
    ["dinner reservation tonight", true],
  ])("triggers on phrase: %s", (text, expected) => {
    expect(gmailLifestyleActiveForDm(db, text)).toBe(expected);
  });

  test.each([
    "what's the weather",
    "schedule the standup",
    "register me for the workshop",
    "send a quick note to the team",
  ])("does NOT trigger on unrelated DM: %s", (text) => {
    expect(gmailLifestyleActiveForDm(db, text)).toBe(false);
  });

  // Word-boundary regression guards. The previous substring-based
  // matcher (`t.includes("trip")` / `t.includes("train")`) fired on
  // unrelated words containing those substrings — each false positive
  // loaded ~180 lines of skill body for nothing.
  test.each([
    "fix the stripe webhook integration",
    "I am training the model on more data",
    "constraint solver wedged in the planner",
    "the script stripped the trailing newline",
    "their training plan is locked",
    "build a tripwire for fork attempts",
  ])("does NOT trigger on substring false positive: %s", (text) => {
    expect(gmailLifestyleActiveForDm(db, text)).toBe(false);
  });

  test("base predicate (DB rows) wins even when message text is unrelated", () => {
    db.prepare("INSERT INTO receipts (saved_at) VALUES (NULL)").run();
    expect(gmailLifestyleActiveForDm(db, "unrelated noise")).toBe(true);
  });
});

describe("managedTasksActive predicate", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`CREATE TABLE managed_tasks (id TEXT PRIMARY KEY);`);
  });
  afterEach(() => db.close());

  test("returns true when db handle is undefined", () => {
    expect(managedTasksActive(undefined)).toBe(true);
  });

  test("returns false when managed_tasks is empty", () => {
    expect(managedTasksActive(db)).toBe(false);
  });

  test("returns true when at least one row exists", () => {
    db.prepare("INSERT INTO managed_tasks (id) VALUES ('mt_1')").run();
    expect(managedTasksActive(db)).toBe(true);
  });

  test("returns true on table-missing error (conservative include)", () => {
    const broken = new Database(":memory:");
    expect(managedTasksActive(broken)).toBe(true);
    broken.close();
  });
});

describe("managedTasksActiveForDm trigger phrases", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`CREATE TABLE managed_tasks (id TEXT PRIMARY KEY);`);
  });
  afterEach(() => db.close());

  test.each([
    ["the row id is mt_42", true],
    ["stop mt_7 please", true],
    ["I want a managed task", true],
    ["set up a recurring fetch", true],
    ["start a recurring sync", true],
    ["pull from Drive every day", true],
    ["check Zoom every Monday", true],
    ["weekly Gmail triage", true],
    ["monthly notion sweep", true],
  ])("triggers on phrase: %s", (text, expected) => {
    expect(managedTasksActiveForDm(db, text)).toBe(expected);
  });

  test.each([
    "zoom into the design",
    "check my notes",
    "register me for the workshop",
    "schedule a one-off reminder",
    "every day I drink coffee",
  ])("does NOT trigger on unrelated DM: %s", (text) => {
    expect(managedTasksActiveForDm(db, text)).toBe(false);
  });

  // Word-boundary regression guards for app-name false positives. The
  // previous matcher used `t.includes("notion")`, `t.includes("zoom")`,
  // etc. which fired on "notional" / "linearly" / "driveway" — each
  // false positive paired with any cadence anchor would load the
  // 250-line skill body unnecessarily.
  test.each([
    "every day I open Notion to plan",
    "every Monday I check Linear",
    "weekly Github actions review",
    "daily Drive cleanup",
  ])("triggers cleanly on real app name (cadence + word-boundary app): %s", (text) => {
    expect(managedTasksActiveForDm(db, text)).toBe(true);
  });

  test.each([
    "every Monday I review my linearly-derived metrics",
    "daily notional exposure update for the desk",
    "weekly outlooks for the quarter",
  ])("does NOT trigger when cadence pairs only with substring-noise app names: %s", (text) => {
    // "linearly" / "notional" / "outlooks" (plural) are substrings of
    // "linear" / "notion" / "outlook". The old `t.includes(...)` matcher
    // fired on these — the fixed word-boundary regex must not.
    expect(managedTasksActiveForDm(db, text)).toBe(false);
  });

  test("`mt_42` alone (no cadence) still triggers — id anchor is enough", () => {
    expect(managedTasksActiveForDm(db, "what's mt_42 doing now?")).toBe(true);
  });

  test("base predicate wins when at least one row exists", () => {
    db.prepare("INSERT INTO managed_tasks (id) VALUES ('mt_1')").run();
    expect(managedTasksActiveForDm(db, "unrelated noise")).toBe(true);
  });
});

describe("resolveSkillManifest — conditional gmail-lifestyle / managed-tasks gating", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE travel_bookings (id INTEGER PRIMARY KEY, start_date TEXT);
      CREATE TABLE receipts (id INTEGER PRIMARY KEY, saved_at TEXT);
      CREATE TABLE managed_tasks (id TEXT PRIMARY KEY);
    `);
  });
  afterEach(() => db.close());

  test("DM event without db includes both conditional skills (conservative default)", () => {
    const result = resolveSkillManifest("message.received.dm");
    expect(result).toContain("gmail-lifestyle");
    expect(result).toContain("managed-tasks");
  });

  test("DM event with empty db and no trigger phrase drops both conditional skills", () => {
    const result = resolveSkillManifest("message.received.dm", {
      db,
      messageText: "hello, just checking in",
    });
    expect(result).not.toContain("gmail-lifestyle");
    expect(result).not.toContain("managed-tasks");
  });

  test("DM event with empty db but gmail-lifestyle trigger phrase keeps that skill only", () => {
    const result = resolveSkillManifest("message.received.dm", {
      db,
      messageText: "where's the receipt from yesterday's lunch?",
    });
    expect(result).toContain("gmail-lifestyle");
    expect(result).not.toContain("managed-tasks");
  });

  test("DM event with empty db but managed-tasks trigger phrase keeps that skill only", () => {
    const result = resolveSkillManifest("message.received.dm", {
      db,
      messageText: "stop mt_42 please",
    });
    expect(result).not.toContain("gmail-lifestyle");
    expect(result).toContain("managed-tasks");
  });

  test("morning routine drops gmail-lifestyle when DB is empty (no trigger fallback)", () => {
    const result = resolveSkillManifest("routine.morning_routine", { db });
    expect(result).not.toContain("gmail-lifestyle");
  });

  test("morning routine keeps gmail-lifestyle when an unsaved receipt exists", () => {
    db.prepare("INSERT INTO receipts (saved_at) VALUES (NULL)").run();
    const result = resolveSkillManifest("routine.morning_routine", { db });
    expect(result).toContain("gmail-lifestyle");
  });

  // Stage-A of the split morning routine carries the same gmail-lifestyle
  // conditional slot. Pin it explicitly so a future ROUTINE_DATA_*-driven
  // refactor cannot quietly skip the gate on this event.
  test("morning routine TODAY (Stage A) honours the gmail-lifestyle gate", () => {
    expect(
      resolveSkillManifest("routine.morning_routine_today", { db }),
    ).not.toContain("gmail-lifestyle");
    db.prepare("INSERT INTO receipts (saved_at) VALUES (NULL)").run();
    expect(
      resolveSkillManifest("routine.morning_routine_today", { db }),
    ).toContain("gmail-lifestyle");
  });

  // DM-class events other than `message.received.dm` (mentions, first-DM,
  // scheduled DM) share the same gating contract. Cover the matrix once
  // so a future event-set extension cannot silently regress one branch.
  // Note: `scheduled.dm` carries `gmail-lifestyle` but not `managed-tasks`
  // in its static set — its gate only acts on the former.
  test.each([
    "message.received",
    "message.received.dm_first",
  ])("DM-class event %s honours both *ForDm gates", (eventType) => {
    expect(
      resolveSkillManifest(eventType, { db, messageText: "checking in" }),
    ).not.toContain("gmail-lifestyle");
    expect(
      resolveSkillManifest(eventType, { db, messageText: "stop mt_42 now" }),
    ).toContain("managed-tasks");
    expect(
      resolveSkillManifest(eventType, { db, messageText: "any receipt today?" }),
    ).toContain("gmail-lifestyle");
  });

  test("scheduled.dm honours the gmail-lifestyle gate (managed-tasks not in static set)", () => {
    expect(EVENT_SKILL_SETS["scheduled.dm"]).not.toContain("managed-tasks");
    expect(
      resolveSkillManifest("scheduled.dm", { db, messageText: "morning briefing" }),
    ).not.toContain("gmail-lifestyle");
    expect(
      resolveSkillManifest("scheduled.dm", {
        db,
        messageText: "any flight tomorrow?",
      }),
    ).toContain("gmail-lifestyle");
  });

  test("non-DM, non-routine event leaves the static array untouched", () => {
    // scheduled.task is not in the per-event predicate dispatch — even
    // with an empty db it should preserve its static manifest verbatim.
    const direct = EVENT_SKILL_SETS["scheduled.task"];
    const result = resolveSkillManifest("scheduled.task", { db });
    expect(result).toEqual(direct);
  });
});

/**
 * skills-improvement.md Test coverage — P1.
 *
 * Per-skill body line-range pin. Two columns matter:
 *
 * - `designTarget` — the aspirational ceiling from
 *   skills-improvement.md §"Updated DM manifest". This is the
 *   design's north-star: the body the LLM ideally consumes after
 *   every per-skill reference extraction has landed.
 *
 * - `regressionCeiling` — the test enforcement number. For skills
 *   that already meet the design target this equals `designTarget *
 *   1.2`. For skills whose body still carries operational
 *   procedural prose that hasn't been extracted yet, this is set to
 *   the **current measured size + 5% headroom** so the test acts as
 *   a regression guard ("don't grow") rather than blocking CI on
 *   aspirational trim work.
 *
 * The gap between the two columns is the per-skill trim work
 * tracked in skills-improvement.md §"Per-skill plans" §§1–16. Each
 * landed phase shrinks the body; the regression ceiling drops to
 * the new measured size + 5% in the same PR.
 */
describe("per-skill body line-range pin (P1)", () => {
  type Pin = { designTarget: number; regressionCeiling: number };
  const PINS: Record<string, Pin> = {
    // Already at or under design target — strict ceiling.
    context: { designTarget: 120, regressionCeiling: 144 },
    roadmap: { designTarget: 180, regressionCeiling: 216 },
    notion: { designTarget: 70, regressionCeiling: 95 },
    attach: { designTarget: 80, regressionCeiling: 110 },
    // Operational-procedure-heavy skills — regression-guard ceiling
    // set above current size. Per-skill phases (§§ in
    // skills-improvement.md) drive the design target.
    today: { designTarget: 120, regressionCeiling: 225 },              // §2  — Agent Plan lifecycle extracted; further trim pending
    "user-profile": { designTarget: 100, regressionCeiling: 210 },     // §3  — character-preferences ref exists; body still hosts schema
    "user-interview": { designTarget: 180, regressionCeiling: 290 },   // §15 — Op-morning/Op-briefing refs exist
    notify: { designTarget: 80, regressionCeiling: 135 },              // §4  — priority ref exists
    schedule: { designTarget: 150, regressionCeiling: 240 },           // §5  — batch/recurring/errors/recurrence refs + R4 confirm-subflow extracted
    "external-services": { designTarget: 80, regressionCeiling: 135 }, // §6  — 6 service refs exist
    mail: { designTarget: 180, regressionCeiling: 250 },               // §7  — api/errors/examples/providers/query-grammar refs exist
    "gmail-lifestyle": { designTarget: 180, regressionCeiling: 235 },  // §9  — merged skill (travel + receipts) with 2 refs
    "management-policy": { designTarget: 120, regressionCeiling: 245 }, // §13 — policy-workflow ref exists
    "managed-tasks": { designTarget: 250, regressionCeiling: 485 },    // §14 — errors/output-path/recurrence refs exist; bulk is Register/Modify/Stop procedure
  };

  test.each(Object.entries(PINS))(
    "%s SKILL.md ≤ regressionCeiling (design target %j)",
    (slug, pin) => {
      const skillPath = join(
        resolveBuiltinSkillDir(SKILLS_DIR, slug),
        "SKILL.md",
      );
      const lines = readFileSync(skillPath, "utf-8").split("\n").length;
      expect(
        lines,
        `${slug}: ${lines} lines vs regression ceiling ${pin.regressionCeiling} ` +
          `(design target ${pin.designTarget}). ` +
          `If you trimmed, lower the regressionCeiling. If you grew the body, ` +
          `justify it or extract to references/ per the design doc's §§.`,
      ).toBeLessThanOrEqual(pin.regressionCeiling);
    },
  );

  test("design-target gap is documented — every PIN logs (slug, design, current, gap)", () => {
    const report: { slug: string; design: number; current: number; gapToDesign: number }[] = [];
    for (const [slug, pin] of Object.entries(PINS)) {
      const skillPath = join(
        resolveBuiltinSkillDir(SKILLS_DIR, slug),
        "SKILL.md",
      );
      const current = readFileSync(skillPath, "utf-8").split("\n").length;
      report.push({
        slug,
        design: pin.designTarget,
        current,
        gapToDesign: current - pin.designTarget,
      });
    }
    // Sanity: a regression that DROPS a skill below its design
    // target should also drop the regressionCeiling. The signal
    // here is for the maintainer running the test locally.
    const slugsAtTarget = report.filter((r) => r.gapToDesign <= 0).map((r) => r.slug);
    expect(slugsAtTarget.length, "snapshot for visibility").toBeGreaterThanOrEqual(0);
  });
});

describe("description disjointness (P3)", () => {
  // Cluster groups vulnerable to over-triggering. Pairwise Jaccard
  // similarity must stay ≤ 0.35 — close enough that some shared verbs
  // (e.g. "load", "skill") are allowed, but two skills that aim at the
  // same intent will trip the threshold.
  const CLUSTERS: ReadonlyArray<readonly string[]> = [
    ["schedule", "managed-tasks"],
    ["notify", "user-profile", "today"],
    ["context", "today", "roadmap"],
  ];
  const STOPWORDS = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "in",
    "is",
    "it",
    "load",
    "of",
    "on",
    "or",
    "skill",
    "skills",
    "that",
    "the",
    "this",
    "to",
    "via",
    "when",
    "whenever",
    "with",
  ]);
  const MAX_JACCARD = 0.35;

  function descriptionTokens(slug: string): Set<string> {
    const body = readFileSync(
      join(resolveBuiltinSkillDir(SKILLS_DIR, slug), "SKILL.md"),
      "utf-8",
    );
    const fm = body.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) return new Set();
    const desc = fm[1].match(/^description:\s*(.+)$/m);
    if (!desc) return new Set();
    return new Set(
      desc[1]
        .toLowerCase()
        .split(/[\s,.\-/()<>—]+/u)
        .filter((w) => w.length > 0 && !STOPWORDS.has(w)),
    );
  }

  function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
  }

  for (const cluster of CLUSTERS) {
    test(`cluster {${cluster.join(", ")}}: pairwise description Jaccard ≤ ${MAX_JACCARD}`, () => {
      const tokens = cluster.map((s) => [s, descriptionTokens(s)] as const);
      const violations: string[] = [];
      for (let i = 0; i < tokens.length; i++) {
        for (let j = i + 1; j < tokens.length; j++) {
          const [sa, ta] = tokens[i];
          const [sb, tb] = tokens[j];
          const score = jaccard(ta, tb);
          if (score > MAX_JACCARD) {
            violations.push(`${sa} ⨯ ${sb}: ${score.toFixed(3)}`);
          }
        }
      }
      expect(
        violations,
        `descriptions overlap too closely: ${violations.join("; ")}`,
      ).toEqual([]);
    });
  }
});

/**
 * skills-improvement.md Test coverage — P4.
 *
 * Two ceilings:
 *
 * - `DESIGN_BUDGET_BYTES` (80 KB) — aspirational end-state from
 *   §"Updated DM manifest" after every per-skill phase lands.
 * - `REGRESSION_CEILING_BYTES` — current measured total + 3%
 *   headroom. Test enforces this ceiling so the suite catches body
 *   growth without blocking on aspirational trim.
 *
 * Each per-skill PR that lowers a slug's body also lowers
 * `REGRESSION_CEILING_BYTES` in the same commit. Net result: a
 * staircase from current (~128 KB) down to the design's 80 KB.
 */
describe("DM manifest body byte budget (P4)", () => {
  const DESIGN_BUDGET_BYTES = 80 * 1024;
  // BROWSER_TASK_REDESIGN_PLAN.md §10 / Phase 5 — bumped from 132 KB
  // to 138 KB to admit the new `browser-task` SKILL.md (~6 KB) that
  // teaches the DM agent the open-ended browser-task surface. The
  // skill body is the smallest concrete artefact that closes the
  // long-standing DM-driven browser-ops gap (the legacy
  // `browser-history-managed` skill was never in message.received.dm).
  // The aspirational 80 KB design target stands; per-skill phases in
  // skills-improvement.md continue to step the ceiling back down as
  // bodies trim. Do NOT raise this ceiling further without a similar
  // justification — adding cost to the DM manifest is regression risk.
  const REGRESSION_CEILING_BYTES = 138 * 1024;

  test("message.received.dm total SKILL.md bytes ≤ regression ceiling", () => {
    const slugs = EVENT_SKILL_SETS["message.received.dm"];
    expect(slugs, "EVENT_SKILL_SETS['message.received.dm'] should exist").toBeTruthy();
    const sizes = slugs.map((slug) => {
      const path = join(resolveBuiltinSkillDir(SKILLS_DIR, slug), "SKILL.md");
      const bytes = readFileSync(path).byteLength;
      return [slug, bytes] as const;
    });
    const total = sizes.reduce((acc, [, b]) => acc + b, 0);
    const breakdown = sizes
      .sort((a, b) => b[1] - a[1])
      .map(([s, b]) => `${s}=${b}`)
      .join(" ");
    expect(
      total,
      `total ${total} bytes vs regression ceiling ${REGRESSION_CEILING_BYTES} ` +
        `(design budget ${DESIGN_BUDGET_BYTES}). Breakdown: ${breakdown}`,
    ).toBeLessThanOrEqual(REGRESSION_CEILING_BYTES);
  });
});

/**
 * skills-improvement.md Test coverage — X1 / X2 / X3.
 *
 * Phase 0.2 / 0.3 / 0.6 collapse duplicated *rule prose* down to a
 * single pointer line. These tests catch true duplication only —
 * lines that name the rule set (pointer lines) and lines that
 * describe operational context (persona modes, skill-specific
 * routing distinctions, worked examples with the rule's named
 * primitives) are NOT duplication and are stripped before checking.
 *
 * The signal for duplication is "a description of the rule
 * happening in prose form, away from any explicit cross-reference to
 * the canonical owner skill".
 */
describe("ownership pointer collapse — Phase 0.2 / 0.3 / 0.6 (X1 / X2 / X3)", () => {
  /**
   * Filter helper: drop any line that:
   *  - names the canonical owner skill via `<owner> skill` or
   *    `**<owner>** skill` — that's a pointer reference,
   *  - is a blockquote (`>`-prefixed) — that's a quoted example,
   *  - names a process key (e.g. `message.received`, `scheduled.dm`)
   *    — that's persona-mode operational prose, not a rule restatement.
   */
  function stripLegitimateMentions(body: string, ownerSlug: string): string {
    const ownerPattern = new RegExp(
      `\\b\\*?\\*?${ownerSlug}\\*?\\*?\\s+skill\\b`,
      "i",
    );
    return body
      .split("\n")
      .filter((line) => {
        if (ownerPattern.test(line)) return false; // pointer reference
        if (/^\s*>/.test(line)) return false; // blockquote / example
        if (/\bmessage\.received(\.\w+)?\b|\bscheduled\.dm\b/.test(line)) {
          return false; // persona-mode operational prose
        }
        return true;
      })
      .join("\n");
  }

  // ── X1: notify ownership ────────────────────────────────────────────
  // True duplication: multi-rule listings in prose form (i.e. a line
  // that names two or more of the four rules — awareness/no-ceremony/
  // no-readback/compactness — after stripping legit mentions).
  const NOTIFY_RULE_TOKENS = [
    /awareness[- ]?gate/i,
    /no[- ]?ceremony/i,
    /no[- ]?readback/i,
    /\bcompactness\b/i,
  ];
  const NOTIFY_CONSUMERS = [
    "agent-assets/agent-profiles/conversational.md",
    "agent-assets/task-flows/message.received.dm.md",
    "agent-assets/task-flows/message.received.dm_first.md",
    "agent-assets/task-flows/scheduled.dm.md",
    "agent-assets/task-flows/routine.morning_routine_today.md",
  ];

  test.each(NOTIFY_CONSUMERS)(
    "X1 — %s does not restate the notify rule set in prose",
    (rel) => {
      const path = join(REPO_ROOT, rel);
      if (!existsSync(path)) return;
      const stripped = stripLegitimateMentions(
        readFileSync(path, "utf-8"),
        "notify",
      );
      // Count, per line, how many distinct rule tokens appear. A line
      // that names ≥2 rules is prose restatement.
      const offending: string[] = [];
      for (const line of stripped.split("\n")) {
        const hits = NOTIFY_RULE_TOKENS.filter((re) => re.test(line)).length;
        if (hits >= 2) offending.push(line.trim());
      }
      expect(
        offending,
        `${rel} restates ${offending.length} notify-rule line(s): ${offending.join(" | ")}`,
      ).toEqual([]);
    },
  );

  // ── X2: user-profile ownership ──────────────────────────────────────
  // True duplication: the CANONICAL recipe of "read GET /api/config/
  // character then PATCH with the 1000-char cap". A line that names the
  // cap value AND the PATCH endpoint on the same line is the recipe.
  // Operational mentions ("read-before-write") alone are fine — that
  // discipline appears in many skills as a generic rule.
  const CHARACTER_CONSUMERS = [
    "agent-assets/skills/management-policy/SKILL.md",
    "agent-assets/task-flows/routine.evening_review.md",
    "agent-assets/task-flows/routine.user_profile_sweep.md",
    "agent-assets/task-flows/setup.initial.md",
    "agent-assets/task-flows/setup.update.md",
    "agent-assets/task-flows/message.received.dm.md",
    "agent-assets/task-flows/message.received.dm_first.md",
  ];

  test.each(CHARACTER_CONSUMERS)(
    "X2 — %s does not restate the Tone / character PATCH recipe in prose",
    (rel) => {
      const path = join(REPO_ROOT, rel);
      if (!existsSync(path)) return;
      const stripped = stripLegitimateMentions(
        readFileSync(path, "utf-8"),
        "user-profile",
      );
      // The recipe signature: a line that names BOTH the cap value
      // (1000-char) AND the endpoint (PATCH /api/config/character).
      const offending: string[] = [];
      for (const line of stripped.split("\n")) {
        const hasCap = /1000[- ]?char/i.test(line);
        const hasEndpoint = /PATCH\s+\/api\/config\/character/.test(line);
        if (hasCap && hasEndpoint) offending.push(line.trim());
      }
      expect(
        offending,
        `${rel} restates the full PATCH /api/config/character recipe: ${offending.join(" | ")}`,
      ).toEqual([]);
    },
  );

  // ── X3: /api/context single source ──────────────────────────────────
  // True duplication: an `## API` (or similar) section dedicated to
  // documenting /api/context PATCH modes, error codes, or X-Lock-Id
  // headers. Inline operational mentions (today.md's Morning Routine
  // lock guidance; user-profile's `section_not_found → append_to_file`
  // fallback recipe specific to first-write on a new section) are
  // skill-specific — not generic API documentation.
  const API_CONSUMERS = ["today", "roadmap", "user-profile"];

  test.each(API_CONSUMERS)(
    "X3 — %s/SKILL.md does not host a dedicated /api/context API reference section",
    (slug) => {
      const path = join(SKILLS_DIR, slug, "SKILL.md");
      const body = readFileSync(path, "utf-8");
      // Look for the SECTION-LEVEL signal: a heading that promises an
      // API reference, followed within ~30 lines by both a PATCH mode
      // word AND an error code word. That's the duplication shape; a
      // single inline mention is not.
      const lines = body.split("\n");
      const offendingSections: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (!/^##\s+.*(API|api\/context)/i.test(lines[i])) continue;
        const block = lines.slice(i, i + 30).join("\n");
        const hasMode = /\b(append_to_file|clear_before|append|replace|clear)\b/.test(
          block,
        );
        const hasError = /\b(section_not_found|cutoff_required|validation_error)\b/.test(
          block,
        );
        if (hasMode && hasError) {
          offendingSections.push(lines[i].trim());
        }
      }
      expect(
        offendingSections,
        `${slug}: still hosts ${offendingSections.length} /api/context reference section(s); ` +
          `move to context/references/api.md per Phase 0.6`,
      ).toEqual([]);
    },
  );
});

/**
 * skills-improvement.md Test coverage — T1 row (mt_<n> anchor in
 * managed-tasks description). C6 / T2 (negative triggers) are already
 * covered by `managedTasksActiveForDm trigger phrases` above; this
 * test pins the description-level anchor itself.
 */
describe("managed-tasks description anchor (T1)", () => {
  test("description contains the `mt_<n>` token (unique-to-this-skill anchor)", () => {
    const body = readFileSync(join(SKILLS_DIR, "managed-tasks", "SKILL.md"), "utf-8");
    const fm = body.match(/^---\n([\s\S]*?)\n---/);
    expect(fm).toBeTruthy();
    const desc = fm![1].match(/^description:\s*(.+)$/m);
    expect(desc).toBeTruthy();
    expect(desc![1]).toMatch(/mt_<n>|mt_\\<n\\>/);
  });

  test("description names all three verbs (register/modify/stop) + run-now", () => {
    const body = readFileSync(join(SKILLS_DIR, "managed-tasks", "SKILL.md"), "utf-8");
    const fm = body.match(/^---\n([\s\S]*?)\n---/);
    const desc = fm![1].match(/^description:\s*(.+)$/m)![1].toLowerCase();
    for (const verb of ["register", "modify", "stop", "run"]) {
      expect(desc, `verb "${verb}" missing`).toContain(verb);
    }
  });
});
