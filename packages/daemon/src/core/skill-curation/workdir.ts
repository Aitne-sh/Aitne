// P22 §3 — optimizer workdir provisioner.
//
// Creates an ephemeral, isolated workdir for the routine.skill_curation
// session under PA_DATA_DIR/optimizer-workdir/<run-id>/. The dir contains:
//
//   CLAUDE.md / AGENTS.md / GEMINI.md  — backend-specific preamble
//   .claude/skills/  (or .codex/, .gemini/)
//     skill-curation/SKILL.md
//     knowledge-map/SKILL.md
//     drift-analysis/SKILL.md
//   data/
//     knowledge-map.json
//     signals/<skill_slug>.json
//     current-payloads/<skill_slug>/<section_id>.json
//
// The agent has allowedTools = `Bash(curl http://localhost:8321/api/skill-curation/*)`
// + `Read`. Edit / Write / general Bash are absent.
//
// The optimizer-only skills live under `agent-assets/optimizer-skills/` —
// PHYSICALLY separate from `agent-assets/skills/` (defence-in-depth: a
// regular session cannot stumble into them via SkillsCompiler).

import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { buildKnowledgeMap } from "./knowledge-map.js";
import {
  loadAllCurationDeclarations,
  type LoadedCurationDeclaration,
} from "./declarations.js";
import { OverlayStore } from "./overlay-store.js";
import { selectSkillsForRun, unconsumedSignalsForSkill } from "./signals.js";
import { RunTokenManager } from "./run-token.js";
import { autoRevertSweep, tickFrozenCycles } from "./auto-revert.js";
import type { SecretStore } from "../../secrets/secret-store.js";
import { DEFAULT_SKILL_CURATION_CONFIG, SkillCurationConfig } from "@aitne/shared";
import { createLogger } from "../../logging.js";

const logger = createLogger("skill-curation-workdir");

export interface MaterializeOptimizerWorkdirParams {
  db: Database.Database;
  dataDir: string;
  /** Repo root (for agent-assets resolution). */
  workspaceDir: string;
  contextDir: string;
  secretStore: SecretStore;
  /** Cadence label persisted on the run row + inlined into the preamble. */
  cadence: "daily" | "weekly" | "monthly";
  /** Hard limit on inlined data size to keep the workdir bounded. */
  maxInlineBytes?: number;
  /**
   * P22 §6.4 — owner-clicked "Run optimization now" runs in manual mode.
   * In manual mode the run row is flagged `is_manual=1` (used by the
   * scheduler's cadence-interval gate to extend the next auto-fire), the
   * skill-selection threshold (`sum(weight) ≥ 3`) is bypassed so any skill
   * with at least one unconsumed signal becomes a target, and per-section
   * cooldowns (7 d post-apply, 14 d post-revert) are ignored — the owner
   * has explicitly asked the optimizer to look again.
   */
  manual?: boolean;
  /**
   * Optional owner-narrowed target list (manual run only). When set,
   * skill selection is restricted to this whitelist *intersected* with
   * skills that have unconsumed signals; excluded_skills still applies.
   */
  targetSkillsOverride?: string[];
}

export interface OptimizerWorkdir {
  runId: string;
  runToken: string;
  workdirPath: string;
  skillsRoot: string;
  targetSkills: string[];
}

const DEFAULT_INLINE_BUDGET = 256 * 1024; // 256 KB total inlined data — well below
                                          // the typical context-window for a single-turn
                                          // brief.

export async function materializeOptimizerWorkdir(
  params: MaterializeOptimizerWorkdirParams,
): Promise<OptimizerWorkdir> {
  const runId = `skcur-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const workdirPath = join(params.dataDir, "optimizer-workdir", runId);
  const optimizerSkillsRoot = join(params.workspaceDir, "agent-assets", "optimizer-skills");
  const skillsRoot = join(params.workspaceDir, "agent-assets", "skills");
  const dataPath = join(workdirPath, "data");

  mkdirSync(dataPath, { recursive: true });
  mkdirSync(join(workdirPath, ".claude", "skills"), { recursive: true });

  // Mint a run-token, persist the run row.
  const tokenManager = new RunTokenManager(params.secretStore);
  const token = await tokenManager.mint(runId);

  // §5.3 — auto-revert + 2-cycle freeze. Decrement existing freeze
  // counters first (a section frozen 2 cycles ago becomes eligible again
  // on the third), then sweep recently-applied proposals for regression
  // and revert + freeze any that accumulated more drift signals after
  // apply than the threshold tolerates. Both calls are idempotent and
  // bounded; failures are logged but do not block the run.
  const overlayForRevert = new OverlayStore(params.dataDir, skillsRoot);
  try {
    const ticked = tickFrozenCycles(params.db);
    if (ticked.unfrozen.length > 0) {
      logger.info({ unfrozen: ticked.unfrozen }, "Frozen sections aged out");
    }
    const swept = autoRevertSweep(params.db, overlayForRevert);
    if (swept.reverted > 0) {
      logger.info(
        { reverted: swept.reverted, newly_frozen: swept.newly_frozen },
        "Auto-revert sweep completed",
      );
    }
  } catch (err) {
    logger.warn({ err }, "Auto-revert sweep failed; continuing run");
  }

  const decls = loadAllCurationDeclarations(skillsRoot).filter((d) => d.declaration !== null);
  // Honour the operator's per-skill exclusions from /settings/self-learning.
  // Cooldown filter follows: it's a transient state (post-apply 7d / post-revert
  // 14d) while exclusion is the long-term opt-out.
  const excluded = readExcludedSkills(params.db);
  const manual = params.manual === true;
  const selections = selectSkillsForRun(params.db, {
    excludedSlugs: excluded,
    // P22 §6.4 — manual runs bypass the weight threshold AND the per-section
    // cooldown. The owner asked explicitly; respect it.
    ...(manual ? { minWeight: 0, ignoreCooldowns: true } : {}),
  });
  let targetSkillsAll = manual
    ? selections.map((s) => s.skill_slug)
    : selections.filter((s) => !s.cooldown_blocked).map((s) => s.skill_slug);
  if (manual && params.targetSkillsOverride && params.targetSkillsOverride.length > 0) {
    const allow = new Set(params.targetSkillsOverride);
    targetSkillsAll = targetSkillsAll.filter((slug) => allow.has(slug));
  }
  const targetSkills = targetSkillsAll.length > 0
    ? targetSkillsAll
    : decls.map((d) => d.slug); // fall back to all declared so the agent has something to read

  params.db
    .prepare(
      `INSERT INTO skill_curation_runs (id, started_at, cadence, backend, model, target_skills_json, status, is_manual)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
    )
    .run(runId, Date.now(), params.cadence, "claude", "claude-sonnet-5", JSON.stringify(targetSkills), manual ? 1 : 0);

  // Knowledge-map snapshot.
  const snapshot = buildKnowledgeMap(params.contextDir);
  writeFileSync(join(dataPath, "knowledge-map.json"), JSON.stringify(snapshot, null, 2), "utf-8");

  // Per-skill signals + current payloads.
  mkdirSync(join(dataPath, "signals"), { recursive: true });
  mkdirSync(join(dataPath, "current-payloads"), { recursive: true });
  const overlay = new OverlayStore(params.dataDir, skillsRoot);
  let inlinedBytes = 0;
  const budget = params.maxInlineBytes ?? DEFAULT_INLINE_BUDGET;
  for (const slug of targetSkills) {
    const decl = decls.find((d) => d.slug === slug);
    if (!decl?.declaration) continue;
    const sigs = unconsumedSignalsForSkill(params.db, slug);
    const sigJson = JSON.stringify(sigs.map((s) => ({
      id: s.id,
      section_id: s.section_id,
      signal_type: s.signal_type,
      observed_at: s.observed_at,
      payload: tryParse(s.payload_json),
    })), null, 2);
    inlinedBytes += Buffer.byteLength(sigJson, "utf-8");
    if (inlinedBytes > budget) break;
    writeFileSync(join(dataPath, "signals", `${slug}.json`), sigJson, "utf-8");

    mkdirSync(join(dataPath, "current-payloads", slug), { recursive: true });
    for (const section of decl.declaration.sections) {
      const payload = overlay.readPayload(slug, section.id, section.kind);
      const text = JSON.stringify({
        skill_slug: slug,
        section_id: section.id,
        kind: section.kind,
        payload,
      }, null, 2);
      inlinedBytes += Buffer.byteLength(text, "utf-8");
      if (inlinedBytes > budget) break;
      writeFileSync(join(dataPath, "current-payloads", slug, `${section.id}.json`), text, "utf-8");
    }
  }

  // Inline the 3 optimizer-only skills under .claude/skills/<slug>/SKILL.md.
  for (const slug of ["skill-curation", "knowledge-map", "drift-analysis"]) {
    const src = join(optimizerSkillsRoot, slug);
    const dest = join(workdirPath, ".claude", "skills", slug);
    cpSync(src, dest, { recursive: true });
  }

  // Write the preamble. Backend-specific filename (CLAUDE.md). For codex /
  // gemini sessions the daemon dispatcher would write AGENTS.md / GEMINI.md
  // instead — same body. We default to CLAUDE.md here since the design
  // §6 setting picks Claude as the curation default.
  const preamble = renderPreamble({
    runId,
    runToken: token.raw,
    cadence: params.cadence,
    targetSkills,
    workdirSummary: summarizeWorkdir(targetSkills, decls, snapshot.files.length),
  });
  writeFileSync(join(workdirPath, "CLAUDE.md"), preamble, "utf-8");

  return { runId, runToken: token.raw, workdirPath, skillsRoot, targetSkills };
}

export function teardownOptimizerWorkdir(workdirPath: string): void {
  rmSync(workdirPath, { recursive: true, force: true });
}

function tryParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

function readExcludedSkills(db: Database.Database): Set<string> {
  try {
    const row = db
      .prepare(`SELECT value_json FROM runtime_state WHERE key = 'skill_curation.config'`)
      .get() as { value_json: string } | undefined;
    if (!row) return new Set(DEFAULT_SKILL_CURATION_CONFIG.excluded_skills);
    return new Set(SkillCurationConfig.parse(JSON.parse(row.value_json)).excluded_skills);
  } catch {
    return new Set();
  }
}

function renderPreamble(p: {
  runId: string;
  runToken: string;
  cadence: string;
  targetSkills: string[];
  workdirSummary: string;
}): string {
  return [
    "# Aitne — Skill Curation Optimizer Run",
    "",
    "You are running inside an isolated optimizer workdir. The ONLY mutation",
    "surface available to you is the curation API at",
    "`http://localhost:8321/api/skill-curation/*`. Edit, Write, MultiEdit,",
    "and general Bash are not in your allowed-tools list.",
    "",
    "## Run context",
    "",
    "- **runId**: `" + p.runId + "`",
    "- **runToken** (use as `X-Optimizer-Token` header on every API call):",
    "  ```",
    "  " + p.runToken,
    "  ```",
    "- **cadence**: " + p.cadence,
    "- **target skills** (selected by signal weight, cooldown-aware):",
    p.targetSkills.length > 0 ? p.targetSkills.map((s) => "  - `" + s + "`").join("\n") : "  - (none — finalize with notes)",
    "",
    "## Workdir layout",
    "",
    p.workdirSummary,
    "",
    "## What to do",
    "",
    "1. Read `data/knowledge-map.json` to understand the live knowledge tree.",
    "2. For each target skill, read `data/signals/<slug>.json` and",
    "   `data/current-payloads/<slug>/<section_id>.json`.",
    "3. Decide whether a curation proposal is warranted using the",
    "   `drift-analysis` skill's corroboration rules.",
    "4. For each section worth changing, dry-run a proposal first via",
    "   `POST /api/skill-curation/proposals/dryrun`, then submit the real",
    "   proposal via `POST /api/skill-curation/proposals` once it passes.",
    "5. Finalize the run via",
    "   `POST /api/skill-curation/runs/" + p.runId + "/finalize` with",
    "   any notes on what you skipped and why.",
    "",
    "## Safety reminders",
    "",
    "- **Zero proposals is a valid run.** When in doubt, skip.",
    "- Cite at least one `signal_id` per proposal (a proposal with empty",
    "  `signal_ids[]` is auto-rejected).",
    "- Free-text fields describe conventions; they do not prescribe actions",
    "  (no \"when X then Y\", no \"must\"/\"always\"/\"never\").",
    "- Per-run rate limit: max 20 proposals.",
    "",
    "See `.claude/skills/skill-curation/SKILL.md`,",
    "`.claude/skills/knowledge-map/SKILL.md`, and",
    "`.claude/skills/drift-analysis/SKILL.md` for the API contract,",
    "snapshot semantics, and triage rules.",
    "",
  ].join("\n");
}

function summarizeWorkdir(targetSkills: string[], decls: LoadedCurationDeclaration[], fileCount: number): string {
  const sectionTotal = decls
    .filter((d) => targetSkills.includes(d.slug))
    .reduce((acc, d) => acc + d.declaration!.sections.length, 0);
  return [
    "- `data/knowledge-map.json` — " + fileCount + " files in the knowledge tree at run start",
    "- `data/signals/` — unconsumed drift signals per skill",
    "- `data/current-payloads/` — current overlay/seed JSON per section (" + sectionTotal + " sections across " + targetSkills.length + " skills)",
    "- `.claude/skills/` — your three working skills (read-only references)",
  ].join("\n");
}
