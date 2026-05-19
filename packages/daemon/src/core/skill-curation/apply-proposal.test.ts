import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../../db/schema.js";
import { OverlayStore, payloadHash } from "./overlay-store.js";
import {
  applyProposal,
  autoRevertProposal,
  recordFailedProposal,
} from "./apply-proposal.js";
import {
  SKILL_CURATION_SCHEMA_VERSION,
  type CurationPayloadValue,
} from "@aitne/shared";

let db: Database.Database;
let dataDir: string;
let skillsRoot: string;
let overlay: OverlayStore;

const seed: CurationPayloadValue = {
  kind: "convention_notes",
  notes: [{ topic: "Date prefix", rule: "Entries are written as [YYYY-MM-DD]." }],
};

const next: CurationPayloadValue = {
  kind: "convention_notes",
  notes: [{ topic: "Date prefix", rule: "Entries use [YYYY-MM-DD] prefix at the head." }],
};

const baseInput = (
  prev_payload: CurationPayloadValue,
  new_payload: CurationPayloadValue,
) => ({
  db,
  overlay,
  runId: "r1",
  skill_slug: "user-profile",
  section_id: "learned-context-format",
  section_kind: "convention_notes" as const,
  prev_payload,
  new_payload,
  rendered_md: "- ok",
  rendererVersion: "convention_notes/1",
  rationale: "restate convention",
  signal_ids: [1],
  diff: { additions: 0, modifications: 1, removals: 0, kind: "mixed" },
});

beforeEach(() => {
  db = new Database(":memory:");
  applySchema(db);
  const root = mkdtempSync(join(tmpdir(), "apply-"));
  dataDir = join(root, "d");
  skillsRoot = join(root, "s");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(skillsRoot, { recursive: true });
  overlay = new OverlayStore(dataDir, skillsRoot);
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(skillsRoot, { recursive: true, force: true });
});

describe("applyProposal — atomic chokepoint", () => {
  it("inserts row with status='applied' and writes overlay", () => {
    let invalidated: { slug: string; sectionId: string } | null = null;
    const r = applyProposal({
      ...baseInput(seed, next),
      onApplied: (slug, sectionId) => {
        invalidated = { slug, sectionId };
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.status).toBe("applied");

    const env = overlay.read("user-profile", "learned-context-format", "convention_notes");
    expect(env?.payload).toEqual(next);
    expect(invalidated).toEqual({
      slug: "user-profile",
      sectionId: "learned-context-format",
    });

    const row = db
      .prepare(
        `SELECT status, applied_overlay_path, decided_by FROM skill_curation_proposals WHERE id = ?`,
      )
      .get(r.proposalId) as {
      status: string;
      applied_overlay_path: string;
      decided_by: string;
    };
    expect(row.status).toBe("applied");
    expect(row.decided_by).toBe("auto");
    expect(row.applied_overlay_path).toContain("learned-context-format.json");
  });

  it("emits an audit row tagged skill_curation_applied", () => {
    const r = applyProposal(baseInput(seed, next));
    expect(r.ok).toBe(true);
    const audits = db
      .prepare(`SELECT action_type FROM agent_actions ORDER BY id ASC`)
      .all() as { action_type: string }[];
    expect(audits.map((a) => a.action_type)).toContain("skill_curation_applied");
  });

  it("writes status='conflict' and skips overlay when current overlay differs", () => {
    const tampered: CurationPayloadValue = {
      kind: "convention_notes",
      notes: [{ topic: "Other", rule: "Different rule." }],
    };
    overlay.write(
      {
        schema_version: SKILL_CURATION_SCHEMA_VERSION,
        skill_slug: "user-profile",
        section_id: "learned-context-format",
        kind: "convention_notes",
        payload: tampered,
        applied_proposal_id: null,
        applied_at: null,
      },
      null,
    );
    const r = applyProposal(baseInput(seed, next));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected conflict");
    expect(r.status).toBe("conflict");

    // Overlay payload was NOT replaced by `next`.
    const env = overlay.read("user-profile", "learned-context-format", "convention_notes");
    expect(env?.payload).toEqual(tampered);

    const row = db
      .prepare(`SELECT status FROM skill_curation_proposals WHERE id = ?`)
      .get(r.proposalId) as { status: string };
    expect(row.status).toBe("conflict");
  });

  it("snapshots prior overlay to history before overwriting", () => {
    overlay.write(
      {
        schema_version: SKILL_CURATION_SCHEMA_VERSION,
        skill_slug: "user-profile",
        section_id: "learned-context-format",
        kind: "convention_notes",
        payload: seed,
        applied_proposal_id: null,
        applied_at: null,
      },
      null,
    );
    const r = applyProposal(baseInput(seed, next));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    const histPath = overlay.paths.historyPath("user-profile", r.proposalId);
    expect(existsSync(histPath)).toBe(true);
  });

  it("payloadHash is stable across calls and discriminates payloads", () => {
    expect(payloadHash(seed)).toBe(payloadHash(seed));
    expect(payloadHash(seed)).not.toBe(payloadHash(next));
  });
});

describe("recordFailedProposal", () => {
  it("persists smoke_failed row with failure detail in smoke_failures_json", () => {
    const id = recordFailedProposal({
      db,
      runId: "r1",
      skill_slug: "user-profile",
      section_id: "learned-context-format",
      section_kind: "convention_notes",
      prev_payload: seed,
      new_payload: next,
      rendered_md: "- ok",
      rendererVersion: "convention_notes/1",
      rationale: "x",
      signal_ids: [1],
      diff: { additions: 0, modifications: 1, removals: 0, kind: "mixed" },
      status: "smoke_failed",
      failure_detail: { failures: [{ check: "render_parses", reason: "bad" }] },
    });
    const row = db
      .prepare(
        `SELECT status, smoke_failures_json FROM skill_curation_proposals WHERE id = ?`,
      )
      .get(id) as { status: string; smoke_failures_json: string };
    expect(row.status).toBe("smoke_failed");
    expect(JSON.parse(row.smoke_failures_json)).toEqual({
      failures: [{ check: "render_parses", reason: "bad" }],
    });
  });

  it("supports diff_caps and render_budget statuses", () => {
    const id1 = recordFailedProposal({
      db,
      runId: "r1",
      skill_slug: "user-profile",
      section_id: "learned-context-format",
      section_kind: "convention_notes",
      prev_payload: seed,
      new_payload: next,
      rendered_md: "",
      rendererVersion: "convention_notes/1",
      rationale: "x",
      signal_ids: [1],
      diff: { additions: 0, modifications: 1, removals: 0, kind: "mixed" },
      status: "diff_caps",
      failure_detail: { reason: "removals_exceeded" },
    });
    const id2 = recordFailedProposal({
      db,
      runId: "r1",
      skill_slug: "user-profile",
      section_id: "learned-context-format",
      section_kind: "convention_notes",
      prev_payload: seed,
      new_payload: next,
      rendered_md: "",
      rendererVersion: "convention_notes/1",
      rationale: "x",
      signal_ids: [1],
      diff: { additions: 0, modifications: 1, removals: 0, kind: "mixed" },
      status: "render_budget",
      failure_detail: { bytes: 9999, budget: 1024 },
    });
    const rows = db
      .prepare(`SELECT id, status FROM skill_curation_proposals WHERE id IN (?, ?)`)
      .all(id1, id2) as { id: number; status: string }[];
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    expect(byId.get(id1)).toBe("diff_caps");
    expect(byId.get(id2)).toBe("render_budget");
  });
});

describe("autoRevertProposal — system-driven roll-back", () => {
  it("restores prior overlay from history snapshot and flips status", () => {
    overlay.write(
      {
        schema_version: SKILL_CURATION_SCHEMA_VERSION,
        skill_slug: "user-profile",
        section_id: "learned-context-format",
        kind: "convention_notes",
        payload: seed,
        applied_proposal_id: null,
        applied_at: null,
      },
      null,
    );
    const apply = applyProposal(baseInput(seed, next));
    expect(apply.ok).toBe(true);
    if (!apply.ok) throw new Error("apply failed");

    const r = autoRevertProposal({ db, overlay, proposalId: apply.proposalId });
    expect(r.ok).toBe(true);

    const env = overlay.read("user-profile", "learned-context-format", "convention_notes");
    expect(env?.payload).toEqual(seed);

    const row = db
      .prepare(
        `SELECT status, decided_by FROM skill_curation_proposals WHERE id = ?`,
      )
      .get(apply.proposalId) as { status: string; decided_by: string };
    expect(row.status).toBe("auto_reverted");
    expect(row.decided_by).toBe("system");

    const audits = db
      .prepare(`SELECT action_type FROM agent_actions ORDER BY id ASC`)
      .all() as { action_type: string }[];
    expect(audits.map((a) => a.action_type)).toContain("skill_curation_auto_reverted");
  });

  it("deletes overlay when reverting a first-ever proposal (no history)", () => {
    const apply = applyProposal(baseInput(seed, next));
    expect(apply.ok).toBe(true);
    if (!apply.ok) throw new Error("apply failed");
    expect(overlay.hasOverlay("user-profile", "learned-context-format")).toBe(true);

    const r = autoRevertProposal({ db, overlay, proposalId: apply.proposalId });
    expect(r.ok).toBe(true);
    expect(overlay.hasOverlay("user-profile", "learned-context-format")).toBe(false);
  });

  it("returns missing for unknown proposal id", () => {
    const r = autoRevertProposal({ db, overlay, proposalId: 99999 });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected missing");
    expect(r.status).toBe("missing");
  });

  it("invokes onApplied cache hook on successful revert", () => {
    // Covers line 252 — the `if (input.onApplied)` branch where the caller
    // passes a hook so SkillsCompiler can drop its cached render after revert.
    const apply = applyProposal(baseInput(seed, next));
    expect(apply.ok).toBe(true);
    if (!apply.ok) throw new Error("apply failed");
    let invalidated: { slug: string; sectionId: string } | null = null;
    const r = autoRevertProposal({
      db,
      overlay,
      proposalId: apply.proposalId,
      onApplied: (slug, sectionId) => {
        invalidated = { slug, sectionId };
      },
    });
    expect(r.ok).toBe(true);
    expect(invalidated).toEqual({
      slug: "user-profile",
      sectionId: "learned-context-format",
    });
  });

  it("refuses to revert a proposal that never landed an overlay", () => {
    const id = recordFailedProposal({
      db,
      runId: "r1",
      skill_slug: "user-profile",
      section_id: "learned-context-format",
      section_kind: "convention_notes",
      prev_payload: seed,
      new_payload: next,
      rendered_md: "",
      rendererVersion: "convention_notes/1",
      rationale: "x",
      signal_ids: [1],
      diff: { additions: 0, modifications: 1, removals: 0, kind: "mixed" },
      status: "smoke_failed",
      failure_detail: { failures: [] },
    });
    const r = autoRevertProposal({ db, overlay, proposalId: id });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected wrong_state");
    expect(r.status).toBe("wrong_state");
  });
});
