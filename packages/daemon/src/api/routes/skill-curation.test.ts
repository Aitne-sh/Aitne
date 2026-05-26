import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../../db/schema.js";
import type { ApiDependencies } from "../server.js";
import { createSkillCurationRoutes } from "./skill-curation.js";
import { recordSignal } from "../../core/skill-curation/signals.js";
import { DEFAULT_SKILL_CURATION_CONFIG } from "@aitne/shared";
import type { SecretStore } from "../../secrets/secret-store.js";

class FakeStore implements SecretStore {
  private store = new Map<string, string>();
  async has(name: string): Promise<boolean> { return this.store.has(name); }
  async get(name: string): Promise<string | null> { return this.store.get(name) ?? null; }
  async set(name: string, value: string): Promise<void> { this.store.set(name, value as string); }
  async delete(name: string): Promise<void> { this.store.delete(name); }
}

const fakeStore = new FakeStore();

let db: Database.Database;
let dataDir: string;
let workspaceDir: string;
let savedCwd: string;

function setEnabled(enabled: boolean): void {
  db.prepare(
    `INSERT OR REPLACE INTO runtime_state (key, value_json, updated_at)
     VALUES ('skill_curation.config', ?, CURRENT_TIMESTAMP)`,
  ).run(JSON.stringify({ ...DEFAULT_SKILL_CURATION_CONFIG, enabled }));
}

function makeApp() {
  const deps = makeDeps(db, dataDir);
  return createSkillCurationRoutes(deps);
}

function makeDeps(db: Database.Database, dataDir: string): ApiDependencies {
  return {
    db,
    config: {
      dataDir,
      workspaceDir,
      timezone: "UTC",
      dayBoundaryHour: 0,
      autonomousDailyCostCapUsd: null,
      autonomousMonthlyCostCapUsd: null,
      // The config object's broader shape is enforced by ApiDependencies
      // but `getContextDir` only needs `dataDir` (resolves to <dataDir>/context).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    secretBroker: fakeStore as never,
    services: {} as never,
    getHealthData: () => ({} as never),
    getIntegrationStatus: () => ({} as never),
  } as ApiDependencies;
}

beforeEach(() => {
  db = new Database(":memory:");
  applySchema(db);
  const root = mkdtempSync(join(tmpdir(), "sc-api-"));
  dataDir = join(root, "data");
  workspaceDir = join(root, "ws");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(workspaceDir, "agent-assets", "skills"), { recursive: true });
  // Set up a tiny test skill with curation declaration + seed.
  const slugDir = join(workspaceDir, "agent-assets", "skills", "user-profile");
  mkdirSync(join(slugDir, "seeds"), { recursive: true });
  writeFileSync(
    join(slugDir, "SKILL.md"),
    [
      "## Topic file layout",
      "",
      `<!-- CURATION:knowledge_layout id="topic-files" -->`,
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    join(slugDir, "curation.json"),
    JSON.stringify({
      version: 1,
      sections: [{
        id: "topic-files",
        kind: "knowledge_layout",
        anchor: `<!-- CURATION:knowledge_layout id="topic-files" -->`,
        human_label: "Topic file layout",
        description: "y",
        scope_paths: ["user/*.md"],
      }],
    }),
    "utf-8",
  );
  writeFileSync(
    join(slugDir, "seeds", "topic-files.seed.json"),
    JSON.stringify({
      kind: "knowledge_layout",
      files: [{ path: "user/profile.md", purpose: "identity facts", sections: [{ heading: "## Identity", contains: "name role tz" }] }],
    }),
    "utf-8",
  );

  // notes-skill: routing_table, search_recipes, convention_notes
  const notesDir = join(workspaceDir, "agent-assets", "skills", "notes-skill");
  mkdirSync(join(notesDir, "seeds"), { recursive: true });
  writeFileSync(join(notesDir, "SKILL.md"), `<!-- curation anchors -->`, "utf-8");
  writeFileSync(join(notesDir, "curation.json"), JSON.stringify({
    version: 1,
    sections: [
      { id: "routing", kind: "routing_table", anchor: `<!-- CURATION:routing_table id="routing" -->`, human_label: "Routing", description: "routing rules", scope_paths: ["work/*.md"] },
      { id: "recipes", kind: "search_recipes", anchor: `<!-- CURATION:search_recipes id="recipes" -->`, human_label: "Recipes", description: "search recipes", scope_paths: ["work/*.md"] },
      { id: "notes", kind: "convention_notes", anchor: `<!-- CURATION:convention_notes id="notes" -->`, human_label: "Notes", description: "convention notes", scope_paths: ["work/*.md"] },
    ],
  }), "utf-8");
  writeFileSync(join(notesDir, "seeds", "routing.seed.json"), JSON.stringify({ kind: "routing_table", rules: [{ trigger_pattern: "placeholder seed", destination_path: "_empty.md", destination_section: "## _", destination_mode: "append" }] }), "utf-8");
  writeFileSync(join(notesDir, "seeds", "recipes.seed.json"), JSON.stringify({ kind: "search_recipes", recipes: [{ question_shape: "placeholder seed", lookup_path: "_empty.md" }] }), "utf-8");
  writeFileSync(join(notesDir, "seeds", "notes.seed.json"), JSON.stringify({ kind: "convention_notes", notes: [{ topic: "placeholder", rule: "Placeholder seed value." }] }), "utf-8");

  // work-skill: frontmatter_schema, cross_references
  const workSkillDir = join(workspaceDir, "agent-assets", "skills", "work-skill");
  mkdirSync(join(workSkillDir, "seeds"), { recursive: true });
  writeFileSync(join(workSkillDir, "SKILL.md"), `<!-- curation anchors -->`, "utf-8");
  writeFileSync(join(workSkillDir, "curation.json"), JSON.stringify({
    version: 1,
    sections: [
      { id: "schema", kind: "frontmatter_schema", anchor: `<!-- CURATION:frontmatter_schema id="schema" -->`, human_label: "Schema", description: "frontmatter schema", scope_paths: ["work/*.md"] },
      { id: "xrefs", kind: "cross_references", anchor: `<!-- CURATION:cross_references id="xrefs" -->`, human_label: "Cross-refs", description: "cross references", scope_paths: ["work/*.md"] },
    ],
  }), "utf-8");
  writeFileSync(join(workSkillDir, "seeds", "schema.seed.json"), JSON.stringify({ kind: "frontmatter_schema", file_types: [{ glob: "_empty.md", required: [], conventional: [] }] }), "utf-8");
  writeFileSync(join(workSkillDir, "seeds", "xrefs.seed.json"), JSON.stringify({ kind: "cross_references", refs: [{ from_path: "_empty.md", to_path: "_empty.md", relation: "placeholder seed" }] }), "utf-8");

  // Set CWD so the route can resolve agent-assets/skills/.
  savedCwd = process.cwd();
  process.chdir(workspaceDir);
});
afterEach(() => {
  process.chdir(savedCwd);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("GET /skill-curation/skills", () => {
  it("lists skills with curation eligibility", async () => {
    const app = makeApp();
    const res = await app.request("/skill-curation/skills");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skills.find((s: any) => s.slug === "user-profile")).toBeDefined();
  });
});

describe("GET /skill-curation/skills/:slug", () => {
  it("returns 404 when skill has no curation.json", async () => {
    const app = makeApp();
    const res = await app.request("/skill-curation/skills/no-such-skill");
    expect(res.status).toBe(404);
  });

  it("returns sections + applied_overlay state", async () => {
    const app = makeApp();
    const res = await app.request("/skill-curation/skills/user-profile");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sections).toHaveLength(1);
    expect(body.sections[0].id).toBe("topic-files");
    expect(body.sections[0].applied_overlay).toBeNull();
  });
});

describe("GET /skill-curation/skills/:slug/sections/:section_id", () => {
  it("returns the seed payload as origin='seed'", async () => {
    const app = makeApp();
    const res = await app.request("/skill-curation/skills/user-profile/sections/topic-files");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("knowledge_layout");
    expect(body.payload.files[0].path).toBe("user/profile.md");
    expect(body.origin).toBe("seed");
  });
});

describe("GET /skill-curation/skills/:slug/sections/:section_id/history", () => {
  it("returns 404 for unknown skill", async () => {
    const app = makeApp();
    const res = await app.request("/skill-curation/skills/no-such-skill/sections/x/history");
    expect(res.status).toBe(404);
  });

  it("returns empty history for declared section with no proposals", async () => {
    const app = makeApp();
    const res = await app.request("/skill-curation/skills/user-profile/sections/topic-files/history");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.history).toEqual([]);
  });
});

describe("GET /skill-curation/signals", () => {
  it("returns unconsumed signals", async () => {
    recordSignal(db, { skill_slug: "user-profile", signal_type: "structure_diff", payload: { sub_kind: "heading_add" } });
    const app = makeApp();
    const res = await app.request("/skill-curation/signals?skill=user-profile");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.signals).toHaveLength(1);
    expect(body.signals[0].signal_type).toBe("structure_diff");
  });
});

describe("POST /skill-curation/runs (gating + token mint)", () => {
  it("403s when curation disabled", async () => {
    setEnabled(false);
    const app = makeApp();
    const res = await app.request("/skill-curation/runs", { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(403);
  });

  it("returns runId + runToken when enabled", async () => {
    setEnabled(true);
    const app = makeApp();
    const res = await app.request("/skill-curation/runs", { method: "POST", body: JSON.stringify({ target_skills: ["user-profile"] }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runId).toMatch(/^skcur-/);
    expect(typeof body.runToken).toBe("string");
    expect(body.runToken.split(".")).toHaveLength(3);
  });
});

describe("POST /skill-curation/proposals (chokepoint — atomic apply)", () => {
  it("403s without a valid run-token", async () => {
    setEnabled(true);
    const app = makeApp();
    const res = await app.request("/skill-curation/proposals", {
      method: "POST",
      body: JSON.stringify({
        runId: "fake",
        skill_slug: "user-profile",
        section_id: "topic-files",
        payload: { kind: "knowledge_layout", files: [{ path: "user/profile.md", purpose: "x x x x x", sections: [{ heading: "## H", contains: "yyyyy" }] }] },
        rationale: "test",
        signal_ids: [1],
      }),
      headers: { "x-optimizer-token": "garbage.x.x" },
    });
    expect(res.status).toBe(403);
  });

  it("422s with invalid body shape", async () => {
    setEnabled(true);
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();
    const res = await app.request("/skill-curation/proposals", {
      method: "POST",
      body: JSON.stringify({ runId, signal_ids: [] }),
      headers: { "x-optimizer-token": runToken },
    });
    expect(res.status).toBe(422);
  });

  it("end-to-end: enable → mint runToken → submit valid proposal → row lands as applied", async () => {
    setEnabled(true);
    const sig = recordSignal(db, { skill_slug: "user-profile", signal_type: "structure_diff", payload: { sub_kind: "heading_add" } });
    const app = makeApp();
    // Set up the context dir so paths_resolve passes
    mkdirSync(join(dataDir, "context", "user"), { recursive: true });
    writeFileSync(join(dataDir, "context", "user", "profile.md"), "## Identity\n## Work Pattern\n");
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();
    const res = await app.request("/skill-curation/proposals", {
      method: "POST",
      body: JSON.stringify({
        runId,
        skill_slug: "user-profile",
        section_id: "topic-files",
        payload: {
          kind: "knowledge_layout",
          files: [
            { path: "user/profile.md", purpose: "identity facts", sections: [{ heading: "## Identity", contains: "name role tz" }, { heading: "## Work Pattern", contains: "active hours" }] },
          ],
        },
        rationale: "added Work Pattern section observed in snapshot",
        signal_ids: [sig],
      }),
      headers: { "x-optimizer-token": runToken },
    });
    if (res.status !== 200) {
      const debug = await res.json();
      throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(debug)}`);
    }
    const body = await res.json();
    expect(body.proposalId).toBeGreaterThan(0);
    expect(body.status).toBe("applied");
    expect(body.overlayPath).toMatch(/topic-files\.json$/);
    expect(body.diff).toBeDefined();

    // Row landed directly as `applied` — no draft / awaiting_approval state.
    const row = db.prepare(`SELECT status FROM skill_curation_proposals WHERE id = ?`).get(body.proposalId) as any;
    expect(row.status).toBe("applied");

    // Signal got consumed only because the proposal applied.
    const sigRow = db.prepare(`SELECT consumed_at FROM skill_curation_signals WHERE id = ?`).get(sig) as any;
    expect(sigRow.consumed_at).not.toBeNull();
  });

  it("smoke-failed proposals persist with status='smoke_failed' and leave signals unconsumed", async () => {
    setEnabled(true);
    // Record a signal but DO NOT cite it — the smoke test's
    // `signal_citations_valid` check then fails because signal_ids is empty.
    // Actually: SubmitProposalRequest requires signal_ids.min(1), so we
    // cite a non-existent signal id which the smoke test will reject.
    const app = makeApp();
    mkdirSync(join(dataDir, "context", "user"), { recursive: true });
    writeFileSync(join(dataDir, "context", "user", "profile.md"), "## Identity\n");
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();
    const res = await app.request("/skill-curation/proposals", {
      method: "POST",
      body: JSON.stringify({
        runId,
        skill_slug: "user-profile",
        section_id: "topic-files",
        payload: {
          kind: "knowledge_layout",
          files: [
            { path: "user/profile.md", purpose: "identity facts", sections: [{ heading: "## Identity", contains: "name role tz" }] },
          ],
        },
        rationale: "x",
        signal_ids: [99999], // signal does not exist → smoke fails on signal_citations_valid
      }),
      headers: { "x-optimizer-token": runToken },
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("smoke_failed");

    // The failed proposal MUST be persisted for inspection.
    const rows = db.prepare(`SELECT status FROM skill_curation_proposals WHERE run_id = ?`).all(runId) as { status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("smoke_failed");
  });

  it("does not persist a proposal on dryrun even if smoke passes", async () => {
    setEnabled(true);
    const sig = recordSignal(db, { skill_slug: "user-profile", signal_type: "structure_diff", payload: { sub_kind: "heading_add" } });
    const app = makeApp();
    mkdirSync(join(dataDir, "context", "user"), { recursive: true });
    writeFileSync(join(dataDir, "context", "user", "profile.md"), "## Identity\n## Work Pattern\n");
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();
    const res = await app.request("/skill-curation/proposals/dryrun", {
      method: "POST",
      body: JSON.stringify({
        runId,
        skill_slug: "user-profile",
        section_id: "topic-files",
        payload: {
          kind: "knowledge_layout",
          files: [
            { path: "user/profile.md", purpose: "identity facts", sections: [{ heading: "## Identity", contains: "name role tz" }, { heading: "## Work Pattern", contains: "active hours" }] },
          ],
        },
        rationale: "dryrun preview",
        signal_ids: [sig],
      }),
      headers: { "x-optimizer-token": runToken },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dryRun).toBe(true);
    // No row, no signal consumption, no overlay write.
    const rows = db.prepare(`SELECT 1 FROM skill_curation_proposals WHERE run_id = ?`).all(runId);
    expect(rows).toHaveLength(0);
    const sigRow = db.prepare(`SELECT consumed_at FROM skill_curation_signals WHERE id = ?`).get(sig) as { consumed_at: number | null };
    expect(sigRow.consumed_at).toBeNull();
  });
});

describe("POST /skill-curation/runs/:id/finalize", () => {
  it("writes run summary with per-status counts", async () => {
    setEnabled(true);
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();
    // Pretend two proposals already landed (one applied, one smoke_failed).
    db.prepare(
      `INSERT INTO skill_curation_proposals
        (run_id, skill_slug, section_id, section_kind, schema_version,
         renderer_version_at_proposal, prev_payload_json, new_payload_json,
         rendered_md, diff_additions, diff_modifications, diff_removals,
         diff_kind, rationale, signals_json, status, proposed_at)
       VALUES (?, 'user-profile', 'topic-files', 'knowledge_layout', 1,
         'knowledge_layout/1', '{}', '{}', '', 0, 0, 0, 'additive_only', 'r', '[]',
         'applied', ?)`,
    ).run(runId, Date.now());
    db.prepare(
      `INSERT INTO skill_curation_proposals
        (run_id, skill_slug, section_id, section_kind, schema_version,
         renderer_version_at_proposal, prev_payload_json, new_payload_json,
         rendered_md, diff_additions, diff_modifications, diff_removals,
         diff_kind, rationale, signals_json, status, proposed_at)
       VALUES (?, 'user-profile', 'topic-files', 'knowledge_layout', 1,
         'knowledge_layout/1', '{}', '{}', '', 0, 0, 0, 'additive_only', 'r', '[]',
         'smoke_failed', ?)`,
    ).run(runId, Date.now());

    const res = await app.request(`/skill-curation/runs/${runId}/finalize`, {
      method: "POST",
      headers: { "x-optimizer-token": runToken },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.proposals_total).toBe(2);
    expect(body.counts).toEqual({ applied: 1, smoke_failed: 1 });

    const runRow = db.prepare(`SELECT status, proposal_count FROM skill_curation_runs WHERE id = ?`).get(runId) as { status: string; proposal_count: number };
    expect(runRow.status).toBe("finalized");
    expect(runRow.proposal_count).toBe(2);
  });
});

describe("approval endpoints removed", () => {
  it("returns 404 for /proposals/:id/approve (no longer registered)", async () => {
    setEnabled(true);
    const app = makeApp();
    const res = await app.request("/skill-curation/proposals/1/approve", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns 404 for /proposals/:id/reject", async () => {
    setEnabled(true);
    const app = makeApp();
    const res = await app.request("/skill-curation/proposals/1/reject", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns 404 for /proposals/:id/revert", async () => {
    setEnabled(true);
    const app = makeApp();
    const res = await app.request("/skill-curation/proposals/1/revert", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// ─── Additional coverage tests ───────────────────────────────────────────────

describe("GET /skill-curation/skills/:slug/sections/:section_id — section not found", () => {
  it("returns 404 section_not_declared for unknown section_id", async () => {
    const app = makeApp();
    const res = await app.request("/skill-curation/skills/user-profile/sections/nonexistent-section");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("section_not_declared");
  });
});

describe("GET /skill-curation/skills/:slug/sections/:section_id/history — section not found", () => {
  it("returns 404 section_not_declared when section does not exist", async () => {
    const app = makeApp();
    const res = await app.request("/skill-curation/skills/user-profile/sections/nonexistent-section/history");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("section_not_declared");
  });
});

describe("GET /skill-curation/signals — all signals + since filter", () => {
  it("returns all signals when no ?skill filter", async () => {
    recordSignal(db, { skill_slug: "user-profile", signal_type: "structure_diff", payload: { sub_kind: "heading_add" } });
    recordSignal(db, { skill_slug: "notes-skill", signal_type: "structure_diff", payload: { sub_kind: "heading_remove" } });
    const app = makeApp();
    const res = await app.request("/skill-curation/signals");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.signals.length).toBeGreaterThanOrEqual(2);
  });

  it("filters by ?since= ISO timestamp", async () => {
    const before = Date.now();
    recordSignal(db, { skill_slug: "user-profile", signal_type: "structure_diff", payload: { sub_kind: "heading_add" } });
    const after = Date.now();
    const app = makeApp();
    // Since = after all signals, expect zero results
    const futureIso = new Date(after + 60_000).toISOString();
    const res = await app.request(`/skill-curation/signals?since=${encodeURIComponent(futureIso)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.signals).toHaveLength(0);
    // Since = before signals, expect ≥1 result
    const pastIso = new Date(before - 1_000).toISOString();
    const res2 = await app.request(`/skill-curation/signals?since=${encodeURIComponent(pastIso)}`);
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.signals.length).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /skill-curation/knowledge-map", () => {
  it("returns 200 with files array when context dir is empty", async () => {
    const app = makeApp();
    const res = await app.request("/skill-curation/knowledge-map");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.files)).toBe(true);
  });

  it("filters by ?scope=user to return only user/* files", async () => {
    mkdirSync(join(dataDir, "context", "user"), { recursive: true });
    mkdirSync(join(dataDir, "context", "work"), { recursive: true });
    writeFileSync(join(dataDir, "context", "user", "profile.md"), "# Profile\n", "utf-8");
    writeFileSync(join(dataDir, "context", "work", "project.md"), "# Project\n", "utf-8");
    const app = makeApp();
    const res = await app.request("/skill-curation/knowledge-map?scope=user");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.files)).toBe(true);
    // All returned files should be under user/
    for (const f of body.files) {
      expect(f.path.startsWith("user/") || f.path === "user.md").toBe(true);
    }
  });
});

describe("GET /skill-curation/proposals/:id", () => {
  it("returns 400 bad_id for non-numeric id", async () => {
    const app = makeApp();
    const res = await app.request("/skill-curation/proposals/not-a-number");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("bad_id");
  });

  it("returns 404 not_found for numeric id that doesn't exist", async () => {
    const app = makeApp();
    const res = await app.request("/skill-curation/proposals/99999");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
  });

  it("returns 200 with proposal shape for existing proposal", async () => {
    setEnabled(true);
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();
    mkdirSync(join(dataDir, "context", "user"), { recursive: true });
    writeFileSync(join(dataDir, "context", "user", "profile.md"), "## Identity\n## Work Pattern\n");
    const sig = recordSignal(db, { skill_slug: "user-profile", signal_type: "structure_diff", payload: { sub_kind: "heading_add" } });
    const propRes = await app.request("/skill-curation/proposals", {
      method: "POST",
      body: JSON.stringify({
        runId,
        skill_slug: "user-profile",
        section_id: "topic-files",
        payload: {
          kind: "knowledge_layout",
          files: [
            { path: "user/profile.md", purpose: "identity facts", sections: [{ heading: "## Identity", contains: "name role tz" }, { heading: "## Work Pattern", contains: "active hours" }] },
          ],
        },
        rationale: "added section",
        signal_ids: [sig],
      }),
      headers: { "x-optimizer-token": runToken },
    });
    expect(propRes.status).toBe(200);
    const { proposalId } = await propRes.json();
    const res = await app.request(`/skill-curation/proposals/${proposalId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(proposalId);
    expect(body.skill_slug).toBe("user-profile");
    expect(body.section_id).toBe("topic-files");
    expect(body.status).toBe("applied");
    // The route returns individual diff fields (not a nested diff object)
    expect(body.diff_kind).toBeDefined();
    expect(typeof body.diff_additions).toBe("number");
    expect(body.payload).toBeDefined();
  });
});

describe("POST /skill-curation/runs/manual", () => {
  it("returns 403 curation_disabled when curation is not enabled", async () => {
    setEnabled(false);
    const app = makeApp();
    const res = await app.request("/skill-curation/runs/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("curation_disabled");
  });

  it("returns 503 event_bus_unavailable when eventBus is not set", async () => {
    setEnabled(true);
    const app = makeApp(); // makeDeps does NOT include eventBus
    const res = await app.request("/skill-curation/runs/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("event_bus_unavailable");
  });

  it("returns 409 run_in_flight when a run is already running", async () => {
    setEnabled(true);
    const fakeEvents: unknown[] = [];
    const appWithBus = createSkillCurationRoutes({
      ...makeDeps(db, dataDir),
      eventBus: { put: async (e: unknown) => { fakeEvents.push(e); } } as never,
    } as ApiDependencies);
    // Insert a running row
    db.prepare(
      `INSERT INTO skill_curation_runs (id, started_at, cadence, backend, model, target_skills_json, status, is_manual)
       VALUES (?, ?, 'weekly', 'claude', 'sonnet', '[]', 'running', 0)`,
    ).run("skcur-inflight-test", Date.now());
    const res = await appWithBus.request("/skill-curation/runs/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("run_in_flight");
    expect(body.runId).toBe("skcur-inflight-test");
  });

  it("returns 200 and emits event to eventBus when curation is enabled", async () => {
    setEnabled(true);
    const fakeEvents: unknown[] = [];
    const appWithBus = createSkillCurationRoutes({
      ...makeDeps(db, dataDir),
      eventBus: { put: async (e: unknown) => { fakeEvents.push(e); } } as never,
    } as ApiDependencies);
    const res = await appWithBus.request("/skill-curation/runs/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(fakeEvents.length).toBe(1);
    const evt = fakeEvents[0] as { type: string; routine: string };
    expect(evt.type).toBe("routine.skill_curation");
    expect(evt.routine).toBe("skill_curation");
  });
});

describe("POST /skill-curation/proposals — rate_limit_exceeded", () => {
  it("returns 429 when 20 proposals already exist for the run", async () => {
    setEnabled(true);
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();
    // Insert 20 proposals for this run
    for (let i = 0; i < 20; i++) {
      db.prepare(
        `INSERT INTO skill_curation_proposals
          (run_id, skill_slug, section_id, section_kind, schema_version,
           renderer_version_at_proposal, prev_payload_json, new_payload_json,
           rendered_md, diff_additions, diff_modifications, diff_removals,
           diff_kind, rationale, signals_json, status, proposed_at)
         VALUES (?, 'user-profile', 'topic-files', 'knowledge_layout', 1,
           'knowledge_layout/1', '{}', '{}', '', 1, 0, 0, 'additive_only', 'r', '[]',
           'applied', ?)`,
      ).run(runId, Date.now());
    }
    const res = await app.request("/skill-curation/proposals", {
      method: "POST",
      body: JSON.stringify({
        runId,
        skill_slug: "user-profile",
        section_id: "topic-files",
        payload: { kind: "knowledge_layout", files: [{ path: "user/profile.md", purpose: "identity facts", sections: [{ heading: "## H", contains: "some content here" }] }] },
        rationale: "over limit test",
        signal_ids: [1],
      }),
      headers: { "x-optimizer-token": runToken },
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("rate_limit_exceeded");
    expect(body.count).toBe(20);
    expect(body.cap).toBe(20);
  });
});

describe("POST /skill-curation/proposals — skill_has_no_curation", () => {
  it("returns 404 for unknown skill (proposals + dryrun)", async () => {
    setEnabled(true);
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();
    const reqBody = JSON.stringify({
      runId,
      skill_slug: "no-curation-skill",
      section_id: "some-section",
      payload: { kind: "knowledge_layout", files: [{ path: "user/profile.md", purpose: "identity facts", sections: [{ heading: "## H", contains: "some content here" }] }] },
      rationale: "test skill no curation",
      signal_ids: [1],
    });
    const res = await app.request("/skill-curation/proposals", {
      method: "POST",
      body: reqBody,
      headers: { "x-optimizer-token": runToken },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("skill_has_no_curation");

    // Also dryrun
    const runRes2 = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId: runId2, runToken: runToken2 } = await runRes2.json();
    const reqBody2 = JSON.stringify({
      runId: runId2,
      skill_slug: "no-curation-skill",
      section_id: "some-section",
      payload: { kind: "knowledge_layout", files: [{ path: "user/profile.md", purpose: "identity facts", sections: [{ heading: "## H", contains: "some content here" }] }] },
      rationale: "test skill no curation",
      signal_ids: [1],
    });
    const res2 = await app.request("/skill-curation/proposals/dryrun", {
      method: "POST",
      body: reqBody2,
      headers: { "x-optimizer-token": runToken2 },
    });
    expect(res2.status).toBe(404);
    expect((await res2.json()).error).toBe("skill_has_no_curation");
  });
});

describe("POST /skill-curation/proposals — section_not_declared", () => {
  it("returns 404 when section_id is not in curation.json", async () => {
    setEnabled(true);
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();
    const res = await app.request("/skill-curation/proposals", {
      method: "POST",
      body: JSON.stringify({
        runId,
        skill_slug: "user-profile",
        section_id: "nonexistent-section",
        payload: { kind: "knowledge_layout", files: [{ path: "user/profile.md", purpose: "identity facts", sections: [{ heading: "## H", contains: "some content here" }] }] },
        rationale: "test section not declared",
        signal_ids: [1],
      }),
      headers: { "x-optimizer-token": runToken },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("section_not_declared");
  });
});

describe("POST /skill-curation/proposals — kind_mismatch", () => {
  it("returns 422 when payload.kind doesn't match declared section kind", async () => {
    setEnabled(true);
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();
    // user-profile/topic-files is knowledge_layout; submit routing_table instead
    const res = await app.request("/skill-curation/proposals", {
      method: "POST",
      body: JSON.stringify({
        runId,
        skill_slug: "user-profile",
        section_id: "topic-files",
        payload: { kind: "routing_table", rules: [{ trigger_pattern: "foo trigger pattern", destination_path: "bar.md", destination_section: "## Bar", destination_mode: "append" }] },
        rationale: "wrong kind test case",
        signal_ids: [1],
      }),
      headers: { "x-optimizer-token": runToken },
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("kind_mismatch");
    expect(body.expected).toBe("knowledge_layout");
    expect(body.got).toBe("routing_table");
  });
});

describe("POST /skill-curation/proposals — diff_caps_exceeded (knowledge_layout)", () => {
  it("returns 422 diff_caps_exceeded when too many files added (>5 additions from prevSize=1)", async () => {
    setEnabled(true);
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();
    // prevPayload from emptyPayloadFor has 1 file (_empty.md); cap = max(5, ceil(1*0.5)) = 5
    // Submit 7 NEW files (different from _empty.md) to exceed additions cap
    const res = await app.request("/skill-curation/proposals", {
      method: "POST",
      body: JSON.stringify({
        runId,
        skill_slug: "user-profile",
        section_id: "topic-files",
        payload: {
          kind: "knowledge_layout",
          files: Array.from({ length: 7 }, (_, i) => ({
            path: `user/new-file-${i}.md`,
            purpose: `purpose ${i}`,
            sections: [{ heading: "## H", contains: "content" }],
          })),
        },
        rationale: "too many additions",
        signal_ids: [1],
      }),
      headers: { "x-optimizer-token": runToken },
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("diff_caps_exceeded");
  });
});

describe("POST /skill-curation/proposals — diff_caps_exceeded (routing_table)", () => {
  it("returns 422 diff_caps_exceeded when too many routing rules added", async () => {
    setEnabled(true);
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();
    // prevPayload seed has 1 rule (trigger_pattern="placeholder seed"); cap = 5 additions
    // Submit 7 rules with distinct trigger_patterns
    const res = await app.request("/skill-curation/proposals", {
      method: "POST",
      body: JSON.stringify({
        runId,
        skill_slug: "notes-skill",
        section_id: "routing",
        payload: {
          kind: "routing_table",
          rules: Array.from({ length: 7 }, (_, i) => ({
            trigger_pattern: `unique pattern ${i}`,
            destination_path: `dest-${i}.md`,
            destination_section: "## Section",
            destination_mode: "append",
          })),
        },
        rationale: "too many routing rules",
        signal_ids: [1],
      }),
      headers: { "x-optimizer-token": runToken },
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("diff_caps_exceeded");
  });
});

describe("POST /skill-curation/proposals — diff_caps_exceeded (search_recipes)", () => {
  it("returns 422 diff_caps_exceeded when too many search recipes added", async () => {
    setEnabled(true);
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();
    // prevPayload seed has 1 recipe (question_shape="placeholder seed"); cap = 5
    const res = await app.request("/skill-curation/proposals", {
      method: "POST",
      body: JSON.stringify({
        runId,
        skill_slug: "notes-skill",
        section_id: "recipes",
        payload: {
          kind: "search_recipes",
          recipes: Array.from({ length: 7 }, (_, i) => ({
            question_shape: `unique question shape ${i}`,
            lookup_path: `lookup-${i}.md`,
          })),
        },
        rationale: "too many recipes",
        signal_ids: [1],
      }),
      headers: { "x-optimizer-token": runToken },
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("diff_caps_exceeded");
  });
});

describe("POST /skill-curation/proposals — diff_caps_exceeded (convention_notes)", () => {
  it("returns 422 diff_caps_exceeded when too many convention notes added", async () => {
    setEnabled(true);
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();
    // prevPayload seed has 1 note (topic="placeholder"); cap = 5
    const res = await app.request("/skill-curation/proposals", {
      method: "POST",
      body: JSON.stringify({
        runId,
        skill_slug: "notes-skill",
        section_id: "notes",
        payload: {
          kind: "convention_notes",
          notes: Array.from({ length: 7 }, (_, i) => ({
            topic: `unique topic ${i}`,
            rule: `Rule for topic ${i}.`,
          })),
        },
        rationale: "too many notes",
        signal_ids: [1],
      }),
      headers: { "x-optimizer-token": runToken },
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("diff_caps_exceeded");
  });
});

describe("POST /skill-curation/proposals — diff_caps_exceeded (frontmatter_schema)", () => {
  it("returns 422 diff_caps_exceeded when too many file_types added", async () => {
    setEnabled(true);
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();
    // prevPayload seed has 1 file_type (glob="_empty.md"); cap = 5
    const res = await app.request("/skill-curation/proposals", {
      method: "POST",
      body: JSON.stringify({
        runId,
        skill_slug: "work-skill",
        section_id: "schema",
        payload: {
          kind: "frontmatter_schema",
          file_types: Array.from({ length: 7 }, (_, i) => ({
            glob: `unique-glob-${i}.md`,
            required: [],
            conventional: [],
          })),
        },
        rationale: "too many file types",
        signal_ids: [1],
      }),
      headers: { "x-optimizer-token": runToken },
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("diff_caps_exceeded");
  });
});

describe("POST /skill-curation/proposals — diff_caps_exceeded (cross_references)", () => {
  it("returns 422 diff_caps_exceeded when too many cross-refs added", async () => {
    setEnabled(true);
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();
    // prevPayload seed has 1 ref (from_path="_empty.md"); cap = 5
    const res = await app.request("/skill-curation/proposals", {
      method: "POST",
      body: JSON.stringify({
        runId,
        skill_slug: "work-skill",
        section_id: "xrefs",
        payload: {
          kind: "cross_references",
          refs: Array.from({ length: 7 }, (_, i) => ({
            from_path: `unique-from-${i}.md`,
            to_path: `dest-${i}.md`,
            relation: `relation ${i}`,
          })),
        },
        rationale: "too many refs",
        signal_ids: [1],
      }),
      headers: { "x-optimizer-token": runToken },
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("diff_caps_exceeded");
  });
});

describe("POST /skill-curation/proposals — render_budget_exceeded (convention_notes)", () => {
  it("returns 422 render_budget_exceeded when rendered convention_notes exceed 1.5KB budget", async () => {
    setEnabled(true);
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();
    // convention_notes budget = 1.5 × 1024 = 1536 bytes.
    // prevPayload from seed has 1 note (topic="placeholder"); cap = max(5, ceil(0.5)) = 5 additions.
    // Submit 4 new notes + keep "placeholder" = 4 additions, 0 removals (≤ cap=5 additions).
    // Each big note: "- **" + 80-char topic + ".**" + " " + 180-char rule + " Example: `" + 200-char example + "`."
    //   ≈ 4+80+4+180+11+200+2 = 481 bytes per note.
    // 4 big notes × 481 + 1 small note × 42 = 1966 bytes > 1536 → render_budget_exceeded fires.
    const bigTopic = "z".repeat(75) + "abcde"; // 80 chars
    const bigRule = "y".repeat(180);
    const bigExample = "e".repeat(200);
    const bigNotes = [
      // Keep the placeholder note so removals=0, additions=4
      { topic: "placeholder", rule: "Placeholder seed value." },
      ...Array.from({ length: 4 }, (_, i) => ({
        topic: `${bigTopic.slice(0, 75)}${i}abc`,  // 79 chars, unique
        rule: bigRule,
        example: bigExample,
      })),
    ];
    const res = await app.request("/skill-curation/proposals", {
      method: "POST",
      body: JSON.stringify({
        runId,
        skill_slug: "notes-skill",
        section_id: "notes",
        payload: { kind: "convention_notes", notes: bigNotes },
        rationale: "render budget test for convention notes",
        signal_ids: [1],
      }),
      headers: { "x-optimizer-token": runToken },
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("render_budget_exceeded");
    expect(typeof body.bytes).toBe("number");
    expect(body.bytes).toBeGreaterThan(1536);
  });
});

describe("GET /settings/skill-curation", () => {
  it("returns 200 with config, eligible_skills, recent_runs, orphan_overlays fields", async () => {
    const app = makeApp();
    const res = await app.request("/settings/skill-curation");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("config");
    expect(body).toHaveProperty("eligible_skills");
    expect(body).toHaveProperty("recent_runs");
    expect(body).toHaveProperty("orphan_overlays");
    expect(Array.isArray(body.eligible_skills)).toBe(true);
    expect(Array.isArray(body.recent_runs)).toBe(true);
    expect(Array.isArray(body.orphan_overlays)).toBe(true);
    // user-profile is eligible
    expect(body.eligible_skills).toContain("user-profile");
  });

  it("includes run stats after a real run and proposal", async () => {
    setEnabled(true);
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();
    mkdirSync(join(dataDir, "context", "user"), { recursive: true });
    writeFileSync(join(dataDir, "context", "user", "profile.md"), "## Identity\n## Work Pattern\n");
    const sig = recordSignal(db, { skill_slug: "user-profile", signal_type: "structure_diff", payload: { sub_kind: "heading_add" } });
    await app.request("/skill-curation/proposals", {
      method: "POST",
      body: JSON.stringify({
        runId,
        skill_slug: "user-profile",
        section_id: "topic-files",
        payload: {
          kind: "knowledge_layout",
          files: [
            { path: "user/profile.md", purpose: "identity facts", sections: [{ heading: "## Identity", contains: "name role tz" }, { heading: "## Work Pattern", contains: "active hours" }] },
          ],
        },
        rationale: "test",
        signal_ids: [sig],
      }),
      headers: { "x-optimizer-token": runToken },
    });
    const res = await app.request("/settings/skill-curation");
    expect(res.status).toBe(200);
    const body = await res.json();
    const run = body.recent_runs.find((r: { id: string }) => r.id === runId);
    expect(run).toBeDefined();
    expect(run.counts).toBeDefined();
  });
});

describe("PATCH /settings/skill-curation", () => {
  it("returns 200 with updated config for valid body", async () => {
    const app = makeApp();
    const res = await app.request("/settings/skill-curation", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.enabled).toBe(true);
  });

  it("returns 422 invalid_config for invalid body", async () => {
    const app = makeApp();
    const res = await app.request("/settings/skill-curation", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: "not-a-boolean" }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("invalid_config");
  });

  it("triggers onScheduleConfigChanged when cadence changes", async () => {
    let called = false;
    const appWithHook = createSkillCurationRoutes({
      ...makeDeps(db, dataDir),
      onScheduleConfigChanged: () => { called = true; },
    } as ApiDependencies);
    // First set a known cadence
    db.prepare(
      `INSERT OR REPLACE INTO runtime_state (key, value_json, updated_at)
       VALUES ('skill_curation.config', ?, CURRENT_TIMESTAMP)`,
    ).run(JSON.stringify({ ...DEFAULT_SKILL_CURATION_CONFIG, enabled: true, cadence: "weekly" }));
    // Change cadence → should trigger hook
    const res = await appWithHook.request("/settings/skill-curation", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cadence: "daily" }),
    });
    expect(res.status).toBe(200);
    expect(called).toBe(true);
  });

  it("does not trigger onScheduleConfigChanged when unrelated field changes", async () => {
    let called = false;
    const appWithHook = createSkillCurationRoutes({
      ...makeDeps(db, dataDir),
      onScheduleConfigChanged: () => { called = true; },
    } as ApiDependencies);
    db.prepare(
      `INSERT OR REPLACE INTO runtime_state (key, value_json, updated_at)
       VALUES ('skill_curation.config', ?, CURRENT_TIMESTAMP)`,
    ).run(JSON.stringify({ ...DEFAULT_SKILL_CURATION_CONFIG, enabled: true, cadence: "weekly" }));
    // Change max_proposals_per_run (not cadence or enabled)
    const res = await appWithHook.request("/settings/skill-curation", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ max_proposals_per_run: 15 }),
    });
    expect(res.status).toBe(200);
    expect(called).toBe(false);
  });
});

describe("GET /skill-curation/proposals — list", () => {
  it("returns 200 with proposals array (empty when no proposals)", async () => {
    const app = makeApp();
    const res = await app.request("/skill-curation/proposals");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.proposals)).toBe(true);
  });

  it("filters by ?status=applied", async () => {
    setEnabled(true);
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId } = await runRes.json();
    // Insert proposals with different statuses
    db.prepare(
      `INSERT INTO skill_curation_proposals
        (run_id, skill_slug, section_id, section_kind, schema_version,
         renderer_version_at_proposal, prev_payload_json, new_payload_json,
         rendered_md, diff_additions, diff_modifications, diff_removals,
         diff_kind, rationale, signals_json, status, proposed_at)
       VALUES (?, 'user-profile', 'topic-files', 'knowledge_layout', 1,
         'knowledge_layout/1', '{}', '{}', '', 1, 0, 0, 'additive_only', 'r', '[]',
         'applied', ?)`,
    ).run(runId, Date.now());
    db.prepare(
      `INSERT INTO skill_curation_proposals
        (run_id, skill_slug, section_id, section_kind, schema_version,
         renderer_version_at_proposal, prev_payload_json, new_payload_json,
         rendered_md, diff_additions, diff_modifications, diff_removals,
         diff_kind, rationale, signals_json, status, proposed_at)
       VALUES (?, 'user-profile', 'topic-files', 'knowledge_layout', 1,
         'knowledge_layout/1', '{}', '{}', '', 0, 0, 0, 'additive_only', 'r', '[]',
         'smoke_failed', ?)`,
    ).run(runId, Date.now());

    const res = await app.request("/skill-curation/proposals?status=applied");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.proposals.every((p: { status: string }) => p.status === "applied")).toBe(true);
  });
});

describe("GET /skill-curation/runs — list", () => {
  it("returns 200 with runs array (empty when no runs)", async () => {
    const app = makeApp();
    const res = await app.request("/skill-curation/runs");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.runs)).toBe(true);
  });

  it("includes runs after POST /skill-curation/runs", async () => {
    setEnabled(true);
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId } = await runRes.json();
    const res = await app.request("/skill-curation/runs");
    expect(res.status).toBe(200);
    const body = await res.json();
    const run = body.runs.find((r: { id: string }) => r.id === runId);
    expect(run).toBeDefined();
    expect(run.status).toBe("running");
    expect(typeof run.is_manual).toBe("boolean");
  });
});

describe("GET /skill-curation/orphans", () => {
  it("returns empty orphans when none exist", async () => {
    const app = makeApp();
    const res = await app.request("/skill-curation/orphans");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orphans).toHaveLength(0);
    expect(typeof body.scanned).toBe("number");
  });
});

describe("POST /skill-curation/orphans/discard", () => {
  it("returns 422 for invalid body (missing slug/section_id)", async () => {
    const app = makeApp();
    const res = await app.request("/skill-curation/orphans/discard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "only-slug-no-section" }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("invalid_body");
  });

  it("returns 409 discard_failed for non-existent orphan", async () => {
    const app = makeApp();
    const res = await app.request("/skill-curation/orphans/discard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "nonexistent-orphan", section_id: "nonexistent-section" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("discard_failed");
  });

  it("returns 200 success when discarding a real orphan overlay", async () => {
    // Create a real orphan: overlay for a skill that has no curation.json.
    // CONTEXT_VAULT_REDESIGN_PLAN.md V11 moved the overlay root from
    // `<dataDir>/skills/overlays/` to `<dataDir>/skill-curation-overlays/`
    // — `detectOrphanOverlays` reads from the new location, so the
    // fixture must seed there too.
    const orphanDir = join(dataDir, "skill-curation-overlays", "orphan-skill");
    mkdirSync(orphanDir, { recursive: true });
    // Write a valid OverlayEnvelope JSON
    const envelope = {
      schema_version: 1,
      skill_slug: "orphan-skill",
      section_id: "orphan-section",
      kind: "knowledge_layout",
      payload: { kind: "knowledge_layout", files: [] },
      applied_proposal_id: 1,
      applied_at: Date.now(),
    };
    writeFileSync(join(orphanDir, "orphan-section.json"), JSON.stringify(envelope), "utf-8");
    const app = makeApp();
    // Verify it's detected as an orphan first
    const orphansRes = await app.request("/skill-curation/orphans");
    expect(orphansRes.status).toBe(200);
    const orphansBody = await orphansRes.json();
    const orphan = orphansBody.orphans.find(
      (o: { slug: string; section_id: string }) => o.slug === "orphan-skill" && o.section_id === "orphan-section",
    );
    expect(orphan).toBeDefined();
    // Discard it
    const res = await app.request("/skill-curation/orphans/discard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "orphan-skill", section_id: "orphan-section" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.discarded).toMatch(/orphan-section\.json$/);
  });
});

describe("safeParse catch coverage — bad prev_payload_json in history", () => {
  it("returns null for prev_payload when prev_payload_json is not valid JSON", async () => {
    setEnabled(true);
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId } = await runRes.json();
    // Insert a row with invalid prev_payload_json
    db.prepare(
      `INSERT INTO skill_curation_proposals
        (run_id, skill_slug, section_id, section_kind, schema_version,
         renderer_version_at_proposal, prev_payload_json, new_payload_json,
         rendered_md, diff_additions, diff_modifications, diff_removals,
         diff_kind, rationale, signals_json, status, proposed_at)
       VALUES (?, 'user-profile', 'topic-files', 'knowledge_layout', 1,
         'knowledge_layout/1', 'not-json', '{}', '', 0, 0, 0, 'additive_only', 'r', '[]',
         'applied', ?)`,
    ).run(runId, Date.now());
    const res = await app.request("/skill-curation/skills/user-profile/sections/topic-files/history");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.history).toHaveLength(1);
    // safeParse returns null for invalid JSON
    expect(body.history[0].prev_payload).toBeNull();
  });
});

describe("isCurationEnabled exception path — bad config JSON in runtime_state", () => {
  it("returns 403 when skill_curation.config has invalid JSON (isCurationEnabled returns false)", async () => {
    // Insert malformed JSON — JSON.parse throws, catch returns false
    db.prepare(
      `INSERT OR REPLACE INTO runtime_state (key, value_json, updated_at)
       VALUES ('skill_curation.config', 'not-valid-json', CURRENT_TIMESTAMP)`,
    ).run();
    const app = makeApp();
    const res = await app.request("/skill-curation/runs/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("curation_disabled");
  });
});

describe("readCurationConfig exception path — bad config JSON returns default", () => {
  it("GET /settings/skill-curation returns 200 with default config when config JSON is corrupt", async () => {
    // Insert malformed JSON — readCurationConfig catches and returns DEFAULT_SKILL_CURATION_CONFIG
    db.prepare(
      `INSERT OR REPLACE INTO runtime_state (key, value_json, updated_at)
       VALUES ('skill_curation.config', 'not-valid-json', CURRENT_TIMESTAMP)`,
    ).run();
    const app = makeApp();
    const res = await app.request("/settings/skill-curation");
    expect(res.status).toBe(200);
    const body = await res.json();
    // Should get default config back
    expect(body.config.enabled).toBe(DEFAULT_SKILL_CURATION_CONFIG.enabled);
    expect(body.config.cadence).toBe(DEFAULT_SKILL_CURATION_CONFIG.cadence);
  });
});

// ── Coverage gap: !bodyResult.ok (readJsonBody parse failure) per endpoint ──
//
// Each POST/PATCH that uses readJsonBody has a `if (!bodyResult.ok) return`
// branch that fires when the request body is not valid JSON. Sending a raw
// non-JSON string with Content-Type: application/json triggers this path.

describe("readJsonBody parse-failure (400) — one hit per mutation endpoint", () => {
  it("POST /skill-curation/runs returns 400 for non-JSON body when curation enabled", async () => {
    setEnabled(true);
    const app = makeApp();
    const res = await app.request("/skill-curation/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-valid-json",
    });
    expect(res.status).toBe(400);
  });

  it("POST /skill-curation/runs/manual returns 400 for non-JSON body when curation enabled", async () => {
    setEnabled(true);
    const fakeEvents: unknown[] = [];
    const appWithBus = createSkillCurationRoutes({
      ...makeDeps(db, dataDir),
      eventBus: { put: async (e: unknown) => { fakeEvents.push(e); } } as never,
    } as ApiDependencies);
    const res = await appWithBus.request("/skill-curation/runs/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-valid-json",
    });
    expect(res.status).toBe(400);
    expect(fakeEvents).toHaveLength(0);
  });

  it("POST /skill-curation/runs/:id/finalize returns 400 for non-JSON body when curation enabled", async () => {
    setEnabled(true);
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();
    const res = await app.request(`/skill-curation/runs/${runId}/finalize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-optimizer-token": runToken,
      },
      body: "not-valid-json",
    });
    expect(res.status).toBe(400);
  });

  it("POST /skill-curation/proposals returns 400 for non-JSON body when curation enabled", async () => {
    setEnabled(true);
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();
    const res = await app.request("/skill-curation/proposals", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-optimizer-token": runToken,
      },
      body: "not-valid-json",
    });
    expect(res.status).toBe(400);
  });

  it("POST /skill-curation/proposals/dryrun returns 400 for non-JSON body when curation enabled", async () => {
    setEnabled(true);
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();
    const res = await app.request("/skill-curation/proposals/dryrun", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-optimizer-token": runToken,
      },
      body: "not-valid-json",
    });
    expect(res.status).toBe(400);
  });

  it("PATCH /settings/skill-curation returns 400 for non-JSON body", async () => {
    const app = makeApp();
    const res = await app.request("/settings/skill-curation", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "not-valid-json",
    });
    expect(res.status).toBe(400);
  });

  it("POST /skill-curation/orphans/discard returns 400 for non-JSON body", async () => {
    const app = makeApp();
    const res = await app.request("/skill-curation/orphans/discard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-valid-json",
    });
    expect(res.status).toBe(400);
  });
});

// ── Coverage gap: onScheduleConfigChanged throwing ──────────────────────────

describe("PATCH /settings/skill-curation — onScheduleConfigChanged throws (warn-and-continue)", () => {
  it("returns 200 even when the schedule-change hook throws", async () => {
    // The PATCH handler wraps deps.onScheduleConfigChanged() in a try/catch
    // (lines 481-487 in skill-curation.ts). If the hook throws, the warning
    // is logged and the updated config is returned normally.
    const throwingHook = createSkillCurationRoutes({
      ...makeDeps(db, dataDir),
      onScheduleConfigChanged: () => {
        throw new Error("hook failure simulation");
      },
    } as ApiDependencies);
    // Seed a config so cadence/enabled change triggers the hook.
    db.prepare(
      `INSERT OR REPLACE INTO runtime_state (key, value_json, updated_at)
       VALUES ('skill_curation.config', ?, CURRENT_TIMESTAMP)`,
    ).run(JSON.stringify({ ...DEFAULT_SKILL_CURATION_CONFIG, enabled: true, cadence: "weekly" }));
    const res = await throwingHook.request("/settings/skill-curation", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cadence: "daily" }), // cadence change triggers hook
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.cadence).toBe("daily");
  });
});

// ── Coverage gap: emptyPayloadFor (all 6 kinds) ──────────────────────────────
//
// emptyPayloadFor is called from processProposalSubmission when
// overlay.readPayload returns null (no overlay AND no seed). Each test
// deletes the target section's seed file, submitting a proposal with
// enough additions to exceed diff_caps. This makes emptyPayloadFor the
// source of prevPayload and covers its switch case without needing smoke.

describe("emptyPayloadFor — knowledge_layout case (user-profile, no seed)", () => {
  it("returns 422 diff_caps_exceeded using emptyPayloadFor('knowledge_layout')", async () => {
    rmSync(join(workspaceDir, "agent-assets", "skills", "user-profile", "seeds", "topic-files.seed.json"));
    setEnabled(true);
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();
    const res = await app.request("/skill-curation/proposals", {
      method: "POST",
      body: JSON.stringify({
        runId, skill_slug: "user-profile", section_id: "topic-files",
        payload: { kind: "knowledge_layout", files: Array.from({ length: 7 }, (_, i) => ({
          path: `user/file-${i}.md`, purpose: `purpose ${i}`,
          sections: [{ heading: "## H", contains: "content" }],
        })) },
        rationale: "test emptyPayloadFor knowledge_layout", signal_ids: [1],
      }),
      headers: { "x-optimizer-token": runToken },
    });
    expect(res.status).toBe(422);
    expect((await res.json() as { error: string }).error).toBe("diff_caps_exceeded");
  });
});

describe("emptyPayloadFor — search_recipes case (notes-skill/recipes, no seed)", () => {
  it("returns 422 diff_caps_exceeded using emptyPayloadFor('search_recipes')", async () => {
    rmSync(join(workspaceDir, "agent-assets", "skills", "notes-skill", "seeds", "recipes.seed.json"));
    setEnabled(true);
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();
    const res = await app.request("/skill-curation/proposals", {
      method: "POST",
      body: JSON.stringify({
        runId, skill_slug: "notes-skill", section_id: "recipes",
        payload: { kind: "search_recipes", recipes: Array.from({ length: 7 }, (_, i) => ({
          question_shape: `question ${i}`, lookup_path: `lookup-${i}.md`,
        })) },
        rationale: "test emptyPayloadFor search_recipes", signal_ids: [1],
      }),
      headers: { "x-optimizer-token": runToken },
    });
    expect(res.status).toBe(422);
    expect((await res.json() as { error: string }).error).toBe("diff_caps_exceeded");
  });
});

describe("emptyPayloadFor — convention_notes case (notes-skill/notes, no seed)", () => {
  it("returns 422 diff_caps_exceeded using emptyPayloadFor('convention_notes')", async () => {
    rmSync(join(workspaceDir, "agent-assets", "skills", "notes-skill", "seeds", "notes.seed.json"));
    setEnabled(true);
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();
    const res = await app.request("/skill-curation/proposals", {
      method: "POST",
      body: JSON.stringify({
        runId, skill_slug: "notes-skill", section_id: "notes",
        payload: { kind: "convention_notes", notes: Array.from({ length: 7 }, (_, i) => ({
          topic: `topic-${i}`, rule: `Rule for topic ${i}.`,
        })) },
        rationale: "test emptyPayloadFor convention_notes", signal_ids: [1],
      }),
      headers: { "x-optimizer-token": runToken },
    });
    expect(res.status).toBe(422);
    expect((await res.json() as { error: string }).error).toBe("diff_caps_exceeded");
  });
});

describe("emptyPayloadFor — frontmatter_schema case (work-skill/schema, no seed)", () => {
  it("returns 422 diff_caps_exceeded using emptyPayloadFor('frontmatter_schema')", async () => {
    rmSync(join(workspaceDir, "agent-assets", "skills", "work-skill", "seeds", "schema.seed.json"));
    setEnabled(true);
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();
    const res = await app.request("/skill-curation/proposals", {
      method: "POST",
      body: JSON.stringify({
        runId, skill_slug: "work-skill", section_id: "schema",
        payload: { kind: "frontmatter_schema", file_types: Array.from({ length: 7 }, (_, i) => ({
          glob: `glob-${i}.md`, required: [], conventional: [],
        })) },
        rationale: "test emptyPayloadFor frontmatter_schema", signal_ids: [1],
      }),
      headers: { "x-optimizer-token": runToken },
    });
    expect(res.status).toBe(422);
    expect((await res.json() as { error: string }).error).toBe("diff_caps_exceeded");
  });
});

describe("emptyPayloadFor — cross_references case (work-skill/xrefs, no seed)", () => {
  it("returns 422 diff_caps_exceeded using emptyPayloadFor('cross_references')", async () => {
    rmSync(join(workspaceDir, "agent-assets", "skills", "work-skill", "seeds", "xrefs.seed.json"));
    setEnabled(true);
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();
    const res = await app.request("/skill-curation/proposals", {
      method: "POST",
      body: JSON.stringify({
        runId, skill_slug: "work-skill", section_id: "xrefs",
        payload: { kind: "cross_references", refs: Array.from({ length: 7 }, (_, i) => ({
          from_path: `from-${i}.md`, to_path: `to-${i}.md`, relation: `relation-${i}`,
        })) },
        rationale: "test emptyPayloadFor cross_references", signal_ids: [1],
      }),
      headers: { "x-optimizer-token": runToken },
    });
    expect(res.status).toBe(422);
    expect((await res.json() as { error: string }).error).toBe("diff_caps_exceeded");
  });
});

// ── Coverage gap: collectSiblingPayloads lines 745-746 ───────────────────────
//
// collectSiblingPayloads is called from runSmokeTest (step 10) when all
// earlier gates pass. We use notes-skill with:
//   - routing seed deleted (emptyPayloadFor called for prev_payload)
//   - notes seed also deleted (sibling readPayload returns null → if(p) FALSE)
//   - recipes seed kept (sibling readPayload returns seed payload → if(p) TRUE)
// This covers both branches of `if (p) out[s.id] = p` at line 746.
// The small proposal (1 additional rule) passes diff_caps, render, and
// byte_budget, reaching runSmokeTest which invokes collectSiblingPayloads.
// Smoke fails on paths_resolve (expected) → 422 smoke_failed.

describe("collectSiblingPayloads lines 745-746 — multi-section skill with mixed sibling states", () => {
  it("covers both branches of if(p): TRUE (seed exists) and FALSE (no seed/overlay)", async () => {
    // Delete routing seed (target → emptyPayloadFor used) and notes seed (→ null sibling)
    rmSync(join(workspaceDir, "agent-assets", "skills", "notes-skill", "seeds", "routing.seed.json"));
    rmSync(join(workspaceDir, "agent-assets", "skills", "notes-skill", "seeds", "notes.seed.json"));
    // recipes seed remains → sibling readPayload returns non-null seed

    setEnabled(true);
    const sig = recordSignal(db, {
      skill_slug: "notes-skill",
      signal_type: "structure_diff",
      payload: { sub_kind: "heading_add" },
    });
    const app = makeApp();
    const runRes = await app.request("/skill-curation/runs", { method: "POST", body: "{}" });
    const { runId, runToken } = await runRes.json();

    // 1 additional rule from emptyPayloadFor("routing_table")'s 1-rule placeholder.
    // additions=1 ≤ cap=5 → passes diff_caps.
    // Siblings: recipes (seed non-null → TRUE branch) + notes (no seed → FALSE branch).
    const res = await app.request("/skill-curation/proposals", {
      method: "POST",
      body: JSON.stringify({
        runId, skill_slug: "notes-skill", section_id: "routing",
        payload: { kind: "routing_table", rules: [
          { trigger_pattern: "placeholder seed", destination_path: "_empty.md", destination_section: "## _", destination_mode: "append" },
          { trigger_pattern: "new-trigger-abc", destination_path: "work/tasks.md", destination_section: "## Tasks", destination_mode: "append" },
        ] },
        rationale: "collectSiblingPayloads coverage test",
        signal_ids: [sig],
      }),
      headers: { "x-optimizer-token": runToken },
    });
    // Smoke fails (work/tasks.md not in context) → 422 smoke_failed.
    // collectSiblingPayloads was called and both branches of if(p) were exercised.
    expect(res.status).toBe(422);
  });
});
