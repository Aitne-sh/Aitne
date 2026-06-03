/**
 * docs/design/21-management-registry-and-entities.md §18 P4 — skill prompt tests.
 *
 * docs/design/appendices/skills-improvement.md §14 merged the three sibling
 * management-task-{register,modify,stop} skills into a single
 * `managed-tasks` skill (Register / Modify / Stop / Run-once sections).
 * `scheduled-managed-task` remains a separate skill keyed on
 * `scheduled.task` firings where `task_context.mt_id` matches.
 *
 * Tests below pin structural invariants from §10.1-§10.4, the
 * entity-lookup contract from §7.6, the validation rules from §13, and
 * the manifest registration required for SkillsCompiler.materializeSessionBundle
 * to surface the skill bodies into a DM session. Drift on any of these
 * silently breaks the registration / scheduled-run loops.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ALL_SKILLS, EVENT_SKILL_SETS } from "./core/skills-manifest.js";
import { renderReferenceIncludes } from "./core/skills-compiler-skill-index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../");

const SKILLS = {
  managed: "managed-tasks",
  scheduled: "scheduled-managed-task",
} as const;

function skillPath(slug: string): string {
  return resolve(REPO_ROOT, "agent-assets/skills", slug, "SKILL.md");
}

function readSkill(slug: string): string {
  return readFileSync(skillPath(slug), "utf-8");
}

function frontmatter(skill: string): Record<string, string> {
  const match = skill.match(/^---\n([\s\S]+?)\n---/);
  if (!match) throw new Error("SKILL.md missing YAML frontmatter");
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

describe("managed-tasks skill — frontmatter shape", () => {
  it("declares matching name", () => {
    expect(frontmatter(readSkill(SKILLS.managed)).name).toBe(SKILLS.managed);
  });

  it("description fits the SDK trigger budget (≤ 280 chars)", () => {
    const desc = frontmatter(readSkill(SKILLS.managed)).description;
    expect(desc.length).toBeLessThanOrEqual(280);
  });

  it("description carries the mt_<n> anchor", () => {
    // §14 description draft anchored on `mt_<n>` as the high-precision
    // trigger token. Without it the merged description over-triggers on
    // generic "register" / "modify" / "stop" phrasings.
    const desc = frontmatter(readSkill(SKILLS.managed)).description;
    expect(desc).toContain("mt_<n>");
  });

  it("description carries all four verbs (register / modify / stop / run-now)", () => {
    // The merged skill replaces three sibling skills — its trigger
    // surface must name every verb the SDK should match on. Run-now is
    // the §10.4 off-schedule fire (`POST /api/managed-tasks/:id/run-now`).
    const desc = frontmatter(readSkill(SKILLS.managed)).description.toLowerCase();
    expect(desc).toContain("register");
    expect(desc).toContain("modify");
    expect(desc).toContain("stop");
    expect(desc).toMatch(/run.now/);
  });

  it("description carries explicit SKIP routing to sibling skills", () => {
    // Without explicit SKIP clauses the merged description over-triggers
    // on neighbouring intents (one-off reminders → schedule; durable
    // no-app rules → management-policy; DM-only cadences →
    // recurring-schedules). The SKIP routing tells the SDK to defer.
    const desc = frontmatter(readSkill(SKILLS.managed)).description.toLowerCase();
    expect(desc).toContain("skip");
    expect(desc).toContain("schedule");
    expect(desc).toContain("management-policy");
    expect(desc).toContain("recurring-schedules");
  });

  it("register / modify trigger examples do not advertise unsupported sub-daily cadence", () => {
    const skill = readSkill(SKILLS.managed);
    const fm = frontmatter(skill);
    const triggerSurface = [
      fm.description ?? "",
      body(skill).split("## When NOT to use this skill")[0],
    ].join("\n");
    expect(
      triggerSurface,
      "managed-tasks trigger examples must not present hourly cadence as supported",
    ).not.toMatch(/\bhourly\b|every hour|every 5 minutes/i);
  });

  it("scheduled-managed-task declares matching name and ≤ 280 char description", () => {
    const fm = frontmatter(readSkill(SKILLS.scheduled));
    expect(fm.name).toBe(SKILLS.scheduled);
    expect(fm.description.length).toBeLessThanOrEqual(280);
  });

  it("scheduled-managed-task trigger fields use task_context.mt_id, not correlation_id", () => {
    const fm = frontmatter(readSkill(SKILLS.scheduled));
    const trigger = `${fm.description ?? ""} ${fm.when_to_use ?? ""}`;
    expect(trigger).toContain("task_context.mt_id");
    expect(trigger).toContain("task_context.adhoc");
    expect(trigger).not.toContain("task_context.correlation_id");
    expect(trigger).not.toContain("mt_<n>.adhoc");
  });
});

describe("managed-tasks — Register section (design §10.1)", () => {
  const text = body(readSkill(SKILLS.managed));

  it("documents Steps 1 through 7 in order", () => {
    const steps = [
      "Step 1 — Read current state",
      "Step 2 — Semantic dedup",
      "Step 3 — Tool selection",
      "Step 4 — Read-only probe",
      "Step 4a — Decide `output_path`",
      "Step 5 — Resolve the cadence",
      "Step 6 — POST /api/managed-tasks",
      "Step 7 — Confirm to user",
    ];
    let cursor = text.indexOf("## Register");
    expect(cursor, "Register section header missing").toBeGreaterThan(-1);
    for (const step of steps) {
      const idx = text.indexOf(step, cursor);
      expect(idx, `Missing or out-of-order: ${step}`).toBeGreaterThan(-1);
      cursor = idx + step.length;
    }
  });

  it("Step 4a names the entity-mirror bias path and the (domain, type) prior", () => {
    expect(text).toMatch(/\/api\/entities\?source=/);
    expect(text).toMatch(/\bbias\b/i);
    expect(text).toMatch(/work\/meetings|finance\/receipts/);
  });

  it("Step 4 surfaces the verbatim probe error to the user", () => {
    expect(text).toMatch(/verbatim/i);
  });

  it("forbids hardcoded tool-name pattern matching (FR-4 / ADR §8.4)", () => {
    expect(text).toMatch(/NEVER hardcode|do(es)? NOT hardcode/i);
  });

  it("forbids direct PUT to rules/management.md (FR-12)", () => {
    expect(text).toMatch(/does NOT PUT.*rules\/management\.md|daemon owns the[\s\S]+?file/i);
  });

  it("documents Idempotency-Key for retry safety", () => {
    expect(text).toMatch(/Idempotency-Key/i);
  });

  it("references the path validation invariants from §9.3 / §13.3", () => {
    // The output-path grammar lives in `references/output-path.md` and is
    // inlined via `{{> ref:output-path }}`. Resolve the include so this
    // assertion sees the post-materialisation body (2026-06 audit moved
    // the grammar table out of the SKILL.md body into the reference).
    const resolved = renderReferenceIncludes(
      readSkill(SKILLS.managed),
      resolve(REPO_ROOT, "agent-assets/skills", SKILLS.managed),
    );
    expect(resolved).toMatch(/<domain>\/<type-plural>\//);
    expect(resolved).toMatch(/output-path/);
  });

  it("documents the recurrence-engine floor (daily/weekly/monthly only)", () => {
    // The recurrence-rule grammar lives in `references/recurrence-rule.md`
    // and is inlined via `{{> ref:recurrence-rule }}`. After resolution
    // the SKILL.md body carries the sub-daily refusal contract.
    expect(text).toMatch(/recurrence-rule/);
  });

  it("uses recurrenceRule (not raw cron) in the POST body example", () => {
    expect(text).toMatch(/"recurrenceRule"\s*:/);
    expect(text).toMatch(/"frequency"\s*:\s*"(daily|weekly|monthly)"/);
    expect(text).not.toMatch(/"cron"\s*:\s*"/);
  });
});

describe("managed-tasks — Modify section (design §10.2)", () => {
  const text = body(readSkill(SKILLS.managed));

  it("documents Steps 1 through 5 in order under ## Modify", () => {
    const steps = [
      "Step 1 — Locate the row",
      "Step 2 — Diff the requested change",
      "Step 3 — Confirm before mutating",
      "Step 4 — PATCH /api/managed-tasks/:id",
      "Step 5 — Confirm to user",
    ];
    let cursor = text.indexOf("## Modify");
    expect(cursor, "Modify section header missing").toBeGreaterThan(-1);
    for (const step of steps) {
      const idx = text.indexOf(step, cursor);
      expect(idx, `Missing or out-of-order: ${step}`).toBeGreaterThan(-1);
      cursor = idx + step.length;
    }
  });

  it("requires a Notify-tier user confirmation before PATCH (§13.1)", () => {
    expect(text).toMatch(/Notify[- ]tier/i);
    expect(text).toMatch(/wait for an explicit yes|user confirms?|explicit user-facing confirmation/i);
  });

  it("preserves mt_id across modification (§10.2)", () => {
    expect(text).toMatch(/mt_id.*preserved|preserved across|history is continuous/i);
  });

  it("rejects app changes — routes to stop + re-register", () => {
    expect(text).toMatch(/stop\s+\+\s+re-register|stop and re-register|different commitment/i);
  });

  it("requires sending cadence + recurrenceRule together on a cadence change", () => {
    expect(text).toMatch(/cadence.*recurrenceRule|recurrenceRule.*cadence/);
    expect(text).toMatch(/send (both|all|the two) together|together so the rendered/i);
  });

  it("notes that output_path relocation does NOT move existing entity files", () => {
    expect(text).toMatch(/does NOT move existing entity files|past entities stay/i);
  });
});

describe("managed-tasks — Stop section (design §10.3)", () => {
  const text = body(readSkill(SKILLS.managed));

  it("documents Steps 1 through 4 in order under ## Stop", () => {
    const steps = [
      "Step 1 — Locate the row",
      "Step 2 — Confirm",
      "Step 3 — DELETE /api/managed-tasks/:id",
      "Step 4 — Confirm to user",
    ];
    let cursor = text.indexOf("## Stop");
    expect(cursor, "Stop section header missing").toBeGreaterThan(-1);
    for (const step of steps) {
      const idx = text.indexOf(step, cursor);
      expect(idx, `Missing or out-of-order: ${step}`).toBeGreaterThan(-1);
      cursor = idx + step.length;
    }
  });

  it("requires a destructive-ops confirmation per CLAUDE.md safety invariants", () => {
    expect(text).toMatch(/destructive/i);
    expect(text).toMatch(/Notify[- ]tier/i);
    expect(text).toMatch(/Never auto-stop|never silently/i);
  });

  it("explains the hard-delete model (no soft-pause)", () => {
    expect(text).toMatch(/hard.delete|hard-deletes/i);
    expect(text).toMatch(/no soft.pause|won't auto.resume/i);
  });

  it("does NOT delete entity files produced by past runs", () => {
    expect(text).toMatch(/does NOT delete entity files|those stay/i);
  });

  it("does NOT bulk-stop without per-row confirmation", () => {
    expect(text).toMatch(/Never stop more than one|bulk[- ]stop/i);
  });
});

describe("managed-tasks — Run-once (§10.4 + §10.5)", () => {
  const text = body(readSkill(SKILLS.managed));

  it("documents the run-now endpoint", () => {
    expect(text).toMatch(/POST\s+http:\/\/[^\s]+\/api\/managed-tasks\/mt_\d+\/run-now/);
  });

  it("documents the 202 queued response (no in-flight guard — the route has no 409 already_running)", () => {
    // 2026-06 skills audit: the route (managed-tasks.ts:875-968) has NO
    // concurrency guard — it unconditionally enqueues and returns
    // `202 {status:"queued", ...}`. The prior pinned `already_running`
    // string asserted a 409 that the implementation never emits.
    expect(text).toMatch(/202/);
    expect(text).toMatch(/queued/);
    expect(text).not.toMatch(/already_running/);
  });
});

describe("scheduled-managed-task — workflow (design §10.4 + §7.6)", () => {
  const text = body(readSkill(SKILLS.scheduled));

  it("documents Steps 0 through 7 in order", () => {
    const steps = [
      "Step 0 — Identify the row",
      "Step 1 — Read the row",
      "Step 2 — Select tool",
      "Step 3 — Invoke with `since",
      "Step 4 — Resolve each new datum",
      "Step 5a — Merge into the entity file",
      "Step 5b — Update the row",
      "Step 6 — Three-strikes notify",
      "Step 7 — End the session",
    ];
    let cursor = 0;
    for (const step of steps) {
      const idx = text.indexOf(step, cursor);
      expect(idx, `Missing or out-of-order: ${step}`).toBeGreaterThan(-1);
      cursor = idx + step.length;
    }
  });

  it("entity lookup follows the §7.6 precedence: external_id → date+title → new", () => {
    const lookup41 = text.indexOf("4.1 Exact `(source_key, external_id)` match");
    const lookup42 = text.indexOf("4.2 Fallback");
    const lookup43 = text.indexOf("4.3 Otherwise");
    expect(lookup41).toBeGreaterThan(-1);
    expect(lookup42).toBeGreaterThan(lookup41);
    expect(lookup43).toBeGreaterThan(lookup42);
    expect(text).toMatch(/\/api\/entities\?source=.*&external_id=/);
    expect(text).toMatch(/\/api\/entities\?domain=.*&type=.*&date=/);
  });

  it("biases toward managed_tasks.output_path when allocating new entities", () => {
    expect(text).toMatch(/bias toward.*output_path|output_path[\s\S]+?encodes the user's intent/i);
  });

  it("does NOT call /api/notify for routine successes (silent by design)", () => {
    expect(text).toMatch(/silent by design|Does NOT post.*notify.*routine|empty final text/i);
  });

  it("documents the 3-strikes notify contract (daemon-owned by design, agent-owned today)", () => {
    expect(text).toMatch(/three.strikes|3.strikes|3 consecutive|threshold crossing/i);
    expect(text).toMatch(
      /daemon owns the (3.strikes |three.strikes )?notify|API owns the notify|skill is the safety net|crossing[- ]edge/i,
    );
  });

  it("uses /run-result for last_run_at writes, not the user-facing PATCH", () => {
    expect(text).toMatch(/PATCH\s+http:\/\/[^\s]+\/api\/managed-tasks\/mt_\d+\/run-result/);
    expect(text).not.toMatch(/"consecutiveFailuresIncrement"/);
  });

  it("identifies managed-task fires via task_context.mt_id (not correlation_id)", () => {
    expect(text).toMatch(/task_context\.mt_id/);
    expect(text).toMatch(/task_context\.adhoc|adhoc\s*===?\s*true/);
  });

  it("does NOT auto-stop the schedule (ADR-flavored §10.4 note)", () => {
    expect(text).toMatch(/never auto[- ]stopped|never auto.stop/i);
  });

  it("explains adhoc detection (task_context.adhoc) for run-now firings (§10.5)", () => {
    expect(text).toMatch(/adhoc/i);
    expect(text).toMatch(/run-now|run_now|on-demand/i);
  });

  it("forbids hardcoded tool names (FR-4 / ADR §8.4)", () => {
    expect(text).toMatch(/NEVER hardcode|do(es)? NOT hardcode/i);
  });

  it("explains idempotency for crash-resume (entity-mirror dedup)", () => {
    expect(text).toMatch(/^## Idempotency$/m);
    expect(text).toMatch(/merge,?\s+not\s+a\s+duplicate|crash[\s\S]+?merge/i);
  });
});

describe("managed-tasks — manifest registration", () => {
  it("DM event manifests include managed-tasks", () => {
    // Without registration the merged skill is invisible to
    // SkillsCompiler.materializeSessionBundle and the user can never
    // invoke register / modify / stop from a DM.
    for (const eventType of [
      "message.received",
      "message.received.dm",
      "message.received.dm_first",
    ]) {
      const skills = EVENT_SKILL_SETS[eventType];
      expect(skills, `EVENT_SKILL_SETS missing for ${eventType}`).toBeDefined();
      expect(
        skills?.includes(SKILLS.managed),
        `${eventType} must include ${SKILLS.managed}`,
      ).toBe(true);
    }
  });

  it("DM event manifests no longer carry the legacy three-skill split", () => {
    // The three sibling slugs (management-task-{register,modify,stop})
    // were merged into managed-tasks. Any DM event still listing them
    // would dual-load redundant skill bodies.
    for (const eventType of [
      "message.received",
      "message.received.dm",
      "message.received.dm_first",
    ]) {
      const skills = EVENT_SKILL_SETS[eventType] ?? [];
      expect(skills).not.toContain("management-task-register");
      expect(skills).not.toContain("management-task-modify");
      expect(skills).not.toContain("management-task-stop");
    }
  });

  it("scheduled.task manifest includes scheduled-managed-task", () => {
    const skills = EVENT_SKILL_SETS["scheduled.task"];
    expect(skills).toBeDefined();
    expect(skills?.includes(SKILLS.scheduled)).toBe(true);
  });

  it("DM event manifests do NOT include scheduled-managed-task", () => {
    for (const eventType of [
      "message.received",
      "message.received.dm",
      "message.received.dm_first",
    ]) {
      expect(EVENT_SKILL_SETS[eventType]).not.toContain(SKILLS.scheduled);
    }
  });

  it("scheduled.task manifest does NOT include managed-tasks", () => {
    // The DM-side CRUD skill is user-confirmation gated (§13.1 Notify
    // tier). A scheduled.task session has no DM channel to confirm
    // against — exposing the merged CRUD skill there is a footgun.
    const skills = EVENT_SKILL_SETS["scheduled.task"];
    expect(skills).not.toContain(SKILLS.managed);
  });

  it("both surviving skills are in ALL_SKILLS (fallback path)", () => {
    for (const slug of Object.values(SKILLS)) {
      expect(ALL_SKILLS, `ALL_SKILLS must contain ${slug}`).toContain(slug);
    }
  });

  it("does NOT bloat curated minimal manifests (user_profile_sweep, docs_qa)", () => {
    for (const eventType of ["routine.user_profile_sweep", "dashboard.docs_qa"]) {
      const skills = EVENT_SKILL_SETS[eventType];
      for (const slug of Object.values(SKILLS)) {
        expect(skills, `${eventType} should not include ${slug}`).not.toContain(
          slug,
        );
      }
    }
  });
});

describe("managed-tasks — API contract surface", () => {
  it("Register section references the actual managed-tasks endpoint", () => {
    const text = body(readSkill(SKILLS.managed));
    expect(text).toMatch(/POST\s+http:\/\/[^\s]+\/api\/managed-tasks\b/);
  });

  it("Modify uses PATCH on /api/managed-tasks/:id", () => {
    const text = body(readSkill(SKILLS.managed));
    expect(text).toMatch(/PATCH\s+http:\/\/[^\s]+\/api\/managed-tasks\/mt_/);
  });

  it("Stop uses DELETE on /api/managed-tasks/:id", () => {
    const text = body(readSkill(SKILLS.managed));
    expect(text).toMatch(/DELETE\s+http:\/\/[^\s]+\/api\/managed-tasks\/mt_/);
  });

  it("scheduled writes via /api/context/<domain>/<type-plural>/<slug>", () => {
    const text = body(readSkill(SKILLS.scheduled));
    expect(text).toMatch(/PATCH\s+\/api\/context\/<domain>\/<type-plural>\/<slug>|PATCH\s+"http:\/\/[^"]+\/api\/context\//);
  });

  it("scheduled hits /api/entities for the §7.6 lookup contract", () => {
    const text = body(readSkill(SKILLS.scheduled));
    expect(text).toMatch(/\/api\/entities\?source=/);
    expect(text).toMatch(/\/api\/entities\?domain=/);
  });

  it("neither surviving skill claims writes produce a separate agent_actions row", () => {
    // The daemon writes one agent_actions row per state-changing call
    // (§NFR-7). A skill that re-asserts "agent_actions row produced"
    // misleads future readers into double-writing.
    for (const slug of Object.values(SKILLS)) {
      const text = body(readSkill(slug));
      expect(
        text,
        `${slug}: must not claim it inserts agent_actions itself`,
      ).not.toMatch(/I (will )?(INSERT|insert) (an? )?`?agent_actions`?/i);
    }
  });
});
