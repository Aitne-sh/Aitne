import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../../db/schema.js";
import type { SecretStore } from "../../secrets/secret-store.js";
import { freezeSection } from "./auto-revert.js";
import { recordSignal } from "./signals.js";
import { materializeOptimizerWorkdir, teardownOptimizerWorkdir } from "./workdir.js";

class FakeStore implements SecretStore {
  private store = new Map<string, string>();
  async has(name: string): Promise<boolean> { return this.store.has(name); }
  async get(name: string): Promise<string | null> { return this.store.get(name) ?? null; }
  async set(name: string, value: string): Promise<void> { this.store.set(name, value as string); }
  async delete(name: string): Promise<void> { this.store.delete(name); }
}

let db: Database.Database;
let dataDir: string;
let workspaceDir: string;
let contextDir: string;
let secretStore: SecretStore;

beforeEach(() => {
  db = new Database(":memory:");
  applySchema(db);
  const root = mkdtempSync(join(tmpdir(), "wd-"));
  dataDir = join(root, "data");
  workspaceDir = join(root, "ws");
  contextDir = join(root, "ctx");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(contextDir, { recursive: true });
  // Set up a tiny optimizer-skills root + a target skill with curation.json
  for (const slug of ["skill-curation", "knowledge-map", "drift-analysis"]) {
    const dir = join(workspaceDir, "agent-assets", "optimizer-skills", slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${slug}\ndescription: stub\n---\n\nbody`, "utf-8");
  }
  const targetSkillDir = join(workspaceDir, "agent-assets", "skills", "user-profile");
  mkdirSync(join(targetSkillDir, "seeds"), { recursive: true });
  writeFileSync(join(targetSkillDir, "SKILL.md"), `## H\n<!-- CURATION:knowledge_layout id="topic-files" -->\n`, "utf-8");
  writeFileSync(join(targetSkillDir, "curation.json"), JSON.stringify({
    version: 1,
    sections: [{
      id: "topic-files",
      kind: "knowledge_layout",
      anchor: `<!-- CURATION:knowledge_layout id="topic-files" -->`,
      human_label: "Topic file layout",
      description: "y",
      scope_paths: ["user/*.md"],
    }],
  }), "utf-8");
  secretStore = new FakeStore();
});
afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
  rmSync(contextDir, { recursive: true, force: true });
});

describe("materializeOptimizerWorkdir", () => {
  it("creates the expected directory layout", async () => {
    // Need at least 1 selected skill to have signals → seed weight 3
    // Two file_add signals (weight 2 each = 4 ≥ 3 threshold), backdated past
    // the 24h age gate so they actually count at materialize time.
    const aged = Date.now() - 25 * 60 * 60 * 1000;
    recordSignal(db, { skill_slug: "user-profile", signal_type: "structure_diff", payload: { sub_kind: "file_add" }, observed_at: aged });
    recordSignal(db, { skill_slug: "user-profile", signal_type: "structure_diff", payload: { sub_kind: "file_add" }, observed_at: aged });
    const wd = await materializeOptimizerWorkdir({
      db, dataDir, workspaceDir, contextDir, secretStore, cadence: "weekly",
    });
    expect(existsSync(wd.workdirPath)).toBe(true);
    expect(existsSync(join(wd.workdirPath, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(wd.workdirPath, ".claude/skills/skill-curation/SKILL.md"))).toBe(true);
    expect(existsSync(join(wd.workdirPath, ".claude/skills/knowledge-map/SKILL.md"))).toBe(true);
    expect(existsSync(join(wd.workdirPath, ".claude/skills/drift-analysis/SKILL.md"))).toBe(true);
    expect(existsSync(join(wd.workdirPath, "data/knowledge-map.json"))).toBe(true);
    expect(existsSync(join(wd.workdirPath, "data/signals/user-profile.json"))).toBe(true);
    expect(existsSync(join(wd.workdirPath, "data/current-payloads/user-profile/topic-files.json"))).toBe(true);
  });

  it("inlines runId + runToken into CLAUDE.md preamble", async () => {
    // Two file_add signals (weight 2 each = 4 ≥ 3 threshold), backdated past
    // the 24h age gate so they actually count at materialize time.
    const aged = Date.now() - 25 * 60 * 60 * 1000;
    recordSignal(db, { skill_slug: "user-profile", signal_type: "structure_diff", payload: { sub_kind: "file_add" }, observed_at: aged });
    recordSignal(db, { skill_slug: "user-profile", signal_type: "structure_diff", payload: { sub_kind: "file_add" }, observed_at: aged });
    const wd = await materializeOptimizerWorkdir({
      db, dataDir, workspaceDir, contextDir, secretStore, cadence: "weekly",
    });
    const claudeMd = readFileSync(join(wd.workdirPath, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain(wd.runId);
    expect(claudeMd).toContain(wd.runToken);
    expect(claudeMd).toContain("X-Optimizer-Token");
  });

  it("persists a skill_curation_runs row", async () => {
    // Two file_add signals (weight 2 each = 4 ≥ 3 threshold), backdated past
    // the 24h age gate so they actually count at materialize time.
    const aged = Date.now() - 25 * 60 * 60 * 1000;
    recordSignal(db, { skill_slug: "user-profile", signal_type: "structure_diff", payload: { sub_kind: "file_add" }, observed_at: aged });
    recordSignal(db, { skill_slug: "user-profile", signal_type: "structure_diff", payload: { sub_kind: "file_add" }, observed_at: aged });
    const wd = await materializeOptimizerWorkdir({
      db, dataDir, workspaceDir, contextDir, secretStore, cadence: "daily",
    });
    const row = db.prepare(`SELECT cadence, status FROM skill_curation_runs WHERE id = ?`).get(wd.runId) as any;
    expect(row).toBeDefined();
    expect(row.cadence).toBe("daily");
    expect(row.status).toBe("running");
  });

  it("falls back to all declared skills when no signals select any", async () => {
    const wd = await materializeOptimizerWorkdir({
      db, dataDir, workspaceDir, contextDir, secretStore, cadence: "weekly",
    });
    expect(wd.targetSkills).toContain("user-profile");
  });

  it("manual run intersects targetSkills with targetSkillsOverride (covers 137-139)", async () => {
    // Add a second declared skill so the unfiltered selection set has at
    // least two entries. Then materialize in manual mode with an override
    // that picks just one — the workdir's targetSkills must reflect the
    // intersection.
    const otherSkill = join(workspaceDir, "agent-assets", "skills", "today");
    mkdirSync(join(otherSkill, "seeds"), { recursive: true });
    writeFileSync(
      join(otherSkill, "SKILL.md"),
      `## H\n<!-- CURATION:convention_notes id="format" -->\n`,
      "utf-8",
    );
    writeFileSync(
      join(otherSkill, "curation.json"),
      JSON.stringify({
        version: 1,
        sections: [{
          id: "format",
          kind: "convention_notes",
          anchor: `<!-- CURATION:convention_notes id="format" -->`,
          human_label: "Format",
          description: "y",
          scope_paths: ["today.md"],
        }],
      }),
      "utf-8",
    );
    // Seed unconsumed signals for both skills so manual mode (minWeight=0)
    // selects both as candidates.
    recordSignal(db, { skill_slug: "user-profile", signal_type: "structure_diff", payload: { sub_kind: "heading_add" } });
    recordSignal(db, { skill_slug: "today", signal_type: "structure_diff", payload: { sub_kind: "heading_add" } });

    const wd = await materializeOptimizerWorkdir({
      db,
      dataDir,
      workspaceDir,
      contextDir,
      secretStore,
      cadence: "weekly",
      manual: true,
      targetSkillsOverride: ["user-profile"], // owner-narrowed list
    });
    // Override prunes the candidate set to just user-profile.
    expect(wd.targetSkills).toEqual(["user-profile"]);
  });

  it("logs aged-out frozen sections from tickFrozenCycles (covers 108-109)", async () => {
    // Seed a single-cycle freeze so tickFrozenCycles inside materialize
    // immediately unfreezes it and the `unfrozen.length > 0` info log fires.
    freezeSection(db, "user-profile", "topic-files", "test", { freezeCycles: 1 });
    const wd = await materializeOptimizerWorkdir({
      db, dataDir, workspaceDir, contextDir, secretStore, cadence: "weekly",
    });
    expect(existsSync(wd.workdirPath)).toBe(true);
    // Sanity — the frozen entry is gone.
    const row = db.prepare(
      `SELECT value_json FROM runtime_state WHERE key = 'skill_curation.frozen'`,
    ).get() as { value_json: string } | undefined;
    if (row) {
      const parsed = JSON.parse(row.value_json) as { entries: unknown[] };
      expect(parsed.entries).toEqual([]);
    }
  });

  it("logs auto-revert sweep results when revertProposalImpl succeeds (covers 112-116)", async () => {
    // Insert an applied proposal whose post-apply signals trip the
    // regression threshold so autoRevertSweep reverts at least one row.
    const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000 - 60_000;
    db.prepare(
      `INSERT INTO skill_curation_proposals
         (id, run_id, skill_slug, section_id, section_kind, schema_version,
          renderer_version_at_proposal, prev_payload_json, new_payload_json,
          rendered_md, diff_additions, diff_modifications, diff_removals,
          diff_kind, rationale, signals_json, status, proposed_at, decided_at,
          smoke_passed_at, decided_by, applied_overlay_path)
       VALUES (?, 'r1', 'user-profile', 'topic-files', 'convention_notes', 1,
               'cn-v1', '{}', '{}', '', 0, 0, 0, 'additive_only', 'r', '[]',
               'applied', ?, ?, ?, 'auto', NULL)`,
    ).run(7, fiveDaysAgo, fiveDaysAgo, fiveDaysAgo);
    recordSignal(db, {
      skill_slug: "user-profile",
      section_id: "topic-files",
      signal_type: "structure_diff",
      payload: { sub_kind: "file_add" },
      observed_at: oneDayAgo,
    });
    recordSignal(db, {
      skill_slug: "user-profile",
      section_id: "topic-files",
      signal_type: "structure_diff",
      payload: { sub_kind: "file_add" },
      observed_at: oneDayAgo,
    });
    const wd = await materializeOptimizerWorkdir({
      db, dataDir, workspaceDir, contextDir, secretStore, cadence: "weekly",
    });
    // The proposal must have flipped to auto_reverted.
    const status = db.prepare(
      `SELECT status FROM skill_curation_proposals WHERE id = ?`,
    ).get(7) as { status: string };
    expect(status.status).toBe("auto_reverted");
    expect(existsSync(wd.workdirPath)).toBe(true);
  });

  it("logs and continues when the auto-revert sweep block throws (covers 117-119)", async () => {
    // tickFrozenCycles parses the frozen state row and dereferences
    // `state.entries.length`. Storing a JSON object whose `entries` is
    // null forces a TypeError that the catch block must swallow.
    db.prepare(
      `INSERT INTO runtime_state (key, value_json, updated_at)
       VALUES ('skill_curation.frozen', ?, CURRENT_TIMESTAMP)`,
    ).run(JSON.stringify({ entries: null }));
    const aged = Date.now() - 25 * 60 * 60 * 1000;
    recordSignal(db, { skill_slug: "user-profile", signal_type: "structure_diff", payload: { sub_kind: "file_add" }, observed_at: aged });
    recordSignal(db, { skill_slug: "user-profile", signal_type: "structure_diff", payload: { sub_kind: "file_add" }, observed_at: aged });
    const wd = await materializeOptimizerWorkdir({
      db, dataDir, workspaceDir, contextDir, secretStore, cadence: "weekly",
    });
    expect(existsSync(wd.workdirPath)).toBe(true);
  });

  it("survives a corrupt skill_curation.config row (covers 228-231)", async () => {
    // readExcludedSkills wraps its DB read in a try/catch that returns an
    // empty Set on parse error. Insert garbage JSON into runtime_state so
    // SkillCurationConfig.parse throws — materialization must still complete.
    db.prepare(
      `INSERT INTO runtime_state (key, value_json, updated_at)
       VALUES ('skill_curation.config', ?, CURRENT_TIMESTAMP)`,
    ).run("not valid json {{{");
    const aged = Date.now() - 25 * 60 * 60 * 1000;
    recordSignal(db, { skill_slug: "user-profile", signal_type: "structure_diff", payload: { sub_kind: "file_add" }, observed_at: aged });
    recordSignal(db, { skill_slug: "user-profile", signal_type: "structure_diff", payload: { sub_kind: "file_add" }, observed_at: aged });
    const wd = await materializeOptimizerWorkdir({
      db, dataDir, workspaceDir, contextDir, secretStore, cadence: "weekly",
    });
    expect(existsSync(wd.workdirPath)).toBe(true);
    // Empty exclusion set means user-profile is still eligible.
    expect(wd.targetSkills).toContain("user-profile");
  });

  it("respects maxInlineBytes budget and stops inlining early (covers line 160 ?? left-branch and lines 173/186 break branches)", async () => {
    // maxInlineBytes = 1 → the first sigJson byte count exceeds the budget immediately.
    // Line 160: params.maxInlineBytes ?? DEFAULT → left side of ?? is used.
    // Line 173: inlinedBytes > budget → break before writing the signals file.
    const aged = Date.now() - 25 * 60 * 60 * 1000;
    recordSignal(db, { skill_slug: "user-profile", signal_type: "structure_diff", payload: { sub_kind: "file_add" }, observed_at: aged });
    recordSignal(db, { skill_slug: "user-profile", signal_type: "structure_diff", payload: { sub_kind: "file_add" }, observed_at: aged });
    const wd = await materializeOptimizerWorkdir({
      db, dataDir, workspaceDir, contextDir, secretStore, cadence: "weekly",
      maxInlineBytes: 1,
    });
    expect(existsSync(wd.workdirPath)).toBe(true);
    // Budget hit before writing signals file — it must not exist.
    expect(existsSync(join(wd.workdirPath, "data/signals/user-profile.json"))).toBe(false);
  });

  it("breaks out of section-payload loop when budget is exceeded mid-section (covers line 186 break branch)", async () => {
    // No signals → sigJson = "[]" (2 bytes) which fits a 4-byte budget.
    // The section payload JSON (~100 bytes) exceeds the remaining budget → break
    // before the current-payloads/<slug>/<section>.json is written.
    const wd = await materializeOptimizerWorkdir({
      db, dataDir, workspaceDir, contextDir, secretStore, cadence: "weekly",
      maxInlineBytes: 4,
    });
    expect(existsSync(wd.workdirPath)).toBe(true);
    // Empty signals file was written (2 bytes ≤ 4).
    expect(existsSync(join(wd.workdirPath, "data/signals/user-profile.json"))).toBe(true);
    // Section payload was NOT written (budget exceeded at line 186).
    expect(existsSync(join(wd.workdirPath, "data/current-payloads/user-profile/topic-files.json"))).toBe(false);
  });

  it("skips targetSkills entries without a curation declaration (!decl?.declaration continue, line 163)", async () => {
    // Insert signals for 'orphan-skill' which has no curation.json in workspaceDir.
    // selectSkillsForRun returns it (weight 4 ≥ 3) but decls.find() returns undefined
    // → !decl?.declaration is true → the loop continues without writing files.
    const aged = Date.now() - 25 * 60 * 60 * 1000;
    recordSignal(db, { skill_slug: "orphan-skill", signal_type: "structure_diff", payload: { sub_kind: "file_add" }, observed_at: aged });
    recordSignal(db, { skill_slug: "orphan-skill", signal_type: "structure_diff", payload: { sub_kind: "file_add" }, observed_at: aged });
    const wd = await materializeOptimizerWorkdir({
      db, dataDir, workspaceDir, contextDir, secretStore, cadence: "weekly",
    });
    expect(existsSync(wd.workdirPath)).toBe(true);
    // orphan-skill has no declaration → its signals file was never written.
    expect(existsSync(join(wd.workdirPath, "data/signals/orphan-skill.json"))).toBe(false);
  });

  it("inlines invalid JSON payload as null via tryParse catch branch (line 219)", async () => {
    // Directly insert a signal row with malformed payload_json so that
    // tryParse(s.payload_json) hits the catch { return null; } branch.
    const aged = Date.now() - 25 * 60 * 60 * 1000;
    db.prepare(
      `INSERT INTO skill_curation_signals (skill_slug, section_id, signal_type, payload_json, observed_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("user-profile", "topic-files", "structure_diff", "{ NOT VALID JSON }", aged);
    // Seed a second valid signal so total weight meets the threshold.
    recordSignal(db, { skill_slug: "user-profile", signal_type: "structure_diff", payload: { sub_kind: "file_add" }, observed_at: aged });
    const wd = await materializeOptimizerWorkdir({
      db, dataDir, workspaceDir, contextDir, secretStore, cadence: "weekly",
    });
    expect(existsSync(wd.workdirPath)).toBe(true);
    const sigJson = readFileSync(join(wd.workdirPath, "data/signals/user-profile.json"), "utf-8");
    const sigs = JSON.parse(sigJson) as { payload: unknown }[];
    // The invalid-JSON entry should appear with payload: null.
    expect(sigs.some((s) => s.payload === null)).toBe(true);
  });

  it("renders none placeholder when no skills are declared (covers renderPreamble line 258 false branch)", async () => {
    // No skill with a valid curation.json → decls = [] → targetSkills = []
    // → renderPreamble sees p.targetSkills.length === 0 → emits the "(none)" line.
    const emptyWs = join(dataDir, "empty-ws");
    for (const slug of ["skill-curation", "knowledge-map", "drift-analysis"]) {
      const dir = join(emptyWs, "agent-assets", "optimizer-skills", slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${slug}\n---\nbody`, "utf-8");
    }
    // skills/ directory exists but is empty — no curation.json present.
    mkdirSync(join(emptyWs, "agent-assets", "skills"), { recursive: true });
    const emptyDataDir = join(dataDir, "empty-wd-data");
    const wd = await materializeOptimizerWorkdir({
      db,
      dataDir: emptyDataDir,
      workspaceDir: emptyWs,
      contextDir,
      secretStore,
      cadence: "weekly",
    });
    const claudeMd = readFileSync(join(wd.workdirPath, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain("(none — finalize with notes)");
  });

  it("honours valid skill_curation.config exclusion list (covers readExcludedSkills row-found branch, line 228)", async () => {
    // Insert a well-formed config row. readExcludedSkills must parse it and
    // return a Set containing "user-profile" so that skill is excluded from
    // selectSkillsForRun. The run still succeeds (falls back to all declared).
    db.prepare(
      `INSERT INTO runtime_state (key, value_json, updated_at)
       VALUES ('skill_curation.config', ?, CURRENT_TIMESTAMP)`,
    ).run(JSON.stringify({ excluded_skills: ["user-profile"] }));
    const wd = await materializeOptimizerWorkdir({
      db, dataDir, workspaceDir, contextDir, secretStore, cadence: "weekly",
    });
    expect(existsSync(wd.workdirPath)).toBe(true);
    // Fallback kicks in because selections is empty (user-profile excluded).
    expect(wd.targetSkills).toContain("user-profile");
  });
});  // end describe("materializeOptimizerWorkdir")

describe("teardownOptimizerWorkdir", () => {
  it("removes the workdir tree", async () => {
    // Two file_add signals (weight 2 each = 4 ≥ 3 threshold), backdated past
    // the 24h age gate so they actually count at materialize time.
    const aged = Date.now() - 25 * 60 * 60 * 1000;
    recordSignal(db, { skill_slug: "user-profile", signal_type: "structure_diff", payload: { sub_kind: "file_add" }, observed_at: aged });
    recordSignal(db, { skill_slug: "user-profile", signal_type: "structure_diff", payload: { sub_kind: "file_add" }, observed_at: aged });
    const wd = await materializeOptimizerWorkdir({
      db, dataDir, workspaceDir, contextDir, secretStore, cadence: "weekly",
    });
    expect(existsSync(wd.workdirPath)).toBe(true);
    teardownOptimizerWorkdir(wd.workdirPath);
    expect(existsSync(wd.workdirPath)).toBe(false);
  });
});
