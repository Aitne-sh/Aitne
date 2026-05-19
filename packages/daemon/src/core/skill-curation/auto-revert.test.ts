import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../db/schema.js";
import {
  autoRevertSweep,
  freezeSection,
  readFrozenSet,
  tickFrozenCycles,
} from "./auto-revert.js";
import { recordSignal } from "./signals.js";
import { OverlayStore } from "./overlay-store.js";

let db: Database.Database;
let dataDir: string;
let skillsRoot: string;

beforeEach(() => {
  db = new Database(":memory:");
  applySchema(db);
  dataDir = mkdtempSync(join(tmpdir(), "auto-revert-"));
  skillsRoot = mkdtempSync(join(tmpdir(), "auto-revert-skills-"));
});
afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(skillsRoot, { recursive: true, force: true });
});

function insertProposal(args: {
  id: number;
  skill_slug: string;
  section_id: string;
  status: string;
  decided_at: number;
}): void {
  db.prepare(
    `INSERT INTO skill_curation_proposals
       (id, run_id, skill_slug, section_id, section_kind, schema_version,
        renderer_version_at_proposal, prev_payload_json, new_payload_json,
        rendered_md, diff_additions, diff_modifications, diff_removals,
        diff_kind, rationale, signals_json, status, proposed_at, decided_at)
     VALUES (?, 'r1', ?, ?, 'convention_notes', 1, 'cn-v1', '{}', '{}', '',
             0, 0, 0, 'additive_only', 'r', '[]', ?, ?, ?)`,
  ).run(args.id, args.skill_slug, args.section_id, args.status, args.decided_at, args.decided_at);
}

describe("freezeSection / readFrozenSet / tickFrozenCycles", () => {
  it("freezes a section and exposes it via readFrozenSet", () => {
    expect(readFrozenSet(db).size).toBe(0);
    freezeSection(db, "user-profile", "topic-files", "manual");
    const set = readFrozenSet(db);
    expect(set.has("user-profile:topic-files")).toBe(true);
  });

  it("tickFrozenCycles decrements counters and unfreezes at zero", () => {
    freezeSection(db, "today", "section-shape", "regression", { freezeCycles: 2 });
    let result = tickFrozenCycles(db);
    expect(result.unfrozen).toEqual([]);
    expect(readFrozenSet(db).has("today:section-shape")).toBe(true);
    result = tickFrozenCycles(db);
    expect(result.unfrozen).toEqual([{ slug: "today", section_id: "section-shape" }]);
    expect(readFrozenSet(db).size).toBe(0);
  });

  it("tickFrozenCycles is a no-op when no entries exist", () => {
    expect(tickFrozenCycles(db).unfrozen).toEqual([]);
  });

  it("freezeSection re-arms the counter when called twice", () => {
    freezeSection(db, "x", "y", "first", { freezeCycles: 2 });
    tickFrozenCycles(db); // counter -> 1
    freezeSection(db, "x", "y", "again", { freezeCycles: 2 });
    tickFrozenCycles(db);
    expect(readFrozenSet(db).has("x:y")).toBe(true);
  });
});

describe("autoRevertSweep", () => {
  it("reverts a proposal whose section accumulates new signals after apply", () => {
    // decided_at must fall inside the 21-day regression window relative
    // to `now`, AND the signals must be older than their per-type min-age
    // gate. We pick now = 25h after the signal so heading_add (24h gate)
    // is cleared and contributes its weight.
    insertProposal({
      id: 10,
      skill_slug: "user-profile",
      section_id: "topic-files",
      status: "applied",
      decided_at: 1_000,
    });
    recordSignal(db, {
      skill_slug: "user-profile",
      section_id: "topic-files",
      signal_type: "structure_diff",
      payload: { sub_kind: "heading_add" },
      observed_at: 2_000,
    });
    recordSignal(db, {
      skill_slug: "user-profile",
      section_id: "topic-files",
      signal_type: "structure_diff",
      payload: { sub_kind: "file_add" },
      observed_at: 2_000,
    });

    const overlay = new OverlayStore(dataDir, skillsRoot);
    const fakeRevert = vi.fn().mockReturnValue({ ok: true, proposalId: 10 });
    // now = 25h after the signal observed_at. heading_add weight=1,
    // file_add weight=2 → total 3, hitting threshold. decided_at (1000)
    // is well within the 21-day regression window.
    const out = autoRevertSweep(db, overlay, {
      now: 2_000 + 25 * 60 * 60 * 1000,
      revertProposalImpl: fakeRevert,
    });

    expect(out.reverted).toBe(1);
    expect(out.newly_frozen).toEqual([{ slug: "user-profile", section_id: "topic-files" }]);
    expect(fakeRevert).toHaveBeenCalledTimes(1);
    expect(readFrozenSet(db).has("user-profile:topic-files")).toBe(true);
  });

  it("skips proposals whose post-apply signal weight is below the threshold", () => {
    insertProposal({
      id: 11,
      skill_slug: "today",
      section_id: "section-shape",
      status: "applied",
      decided_at: 2_000,
    });
    recordSignal(db, {
      skill_slug: "today",
      section_id: "section-shape",
      signal_type: "structure_diff",
      payload: { sub_kind: "heading_add" },
      observed_at: 3_000,
    });

    const overlay = new OverlayStore(dataDir, skillsRoot);
    const fakeRevert = vi.fn();
    // 25h past observed_at — heading_add gate (24h) cleared; weight=1 < 3.
    const out = autoRevertSweep(db, overlay, {
      now: 3_000 + 25 * 60 * 60 * 1000,
      revertProposalImpl: fakeRevert,
    });
    expect(out.reverted).toBe(0);
    expect(fakeRevert).not.toHaveBeenCalled();
  });

  it("skips proposals outside the regression window", () => {
    insertProposal({
      id: 12,
      skill_slug: "x",
      section_id: "y",
      status: "applied",
      decided_at: 1_000,
    });
    recordSignal(db, {
      skill_slug: "x",
      section_id: "y",
      signal_type: "structure_diff",
      payload: { sub_kind: "file_add" },
      observed_at: 2_000,
    });
    recordSignal(db, {
      skill_slug: "x",
      section_id: "y",
      signal_type: "structure_diff",
      payload: { sub_kind: "file_add" },
      observed_at: 2_000,
    });
    const overlay = new OverlayStore(dataDir, skillsRoot);
    const fakeRevert = vi.fn();
    // Window default is 21 days; pick `now` so the proposal's decided_at is well outside.
    const out = autoRevertSweep(db, overlay, {
      now: 1_000 + 100 * 24 * 60 * 60 * 1000,
      revertProposalImpl: fakeRevert,
    });
    expect(out.proposals_inspected).toBe(0);
    expect(fakeRevert).not.toHaveBeenCalled();
  });

  it("logs and continues when revertProposal fails", () => {
    insertProposal({
      id: 13,
      skill_slug: "x",
      section_id: "y",
      status: "applied",
      decided_at: 1_000,
    });
    // Two file_add signals → weight 4 ≥ 3 threshold (24h age gate cleared by `now` below).
    recordSignal(db, {
      skill_slug: "x",
      section_id: "y",
      signal_type: "structure_diff",
      payload: { sub_kind: "file_add" },
      observed_at: 2_000,
    });
    recordSignal(db, {
      skill_slug: "x",
      section_id: "y",
      signal_type: "structure_diff",
      payload: { sub_kind: "file_add" },
      observed_at: 2_000,
    });
    const overlay = new OverlayStore(dataDir, skillsRoot);
    const fakeRevert = vi
      .fn()
      .mockReturnValue({ ok: false, status: "wrong_state", message: "no" });
    // Push past the 24h age gate so the file_add signals contribute weight.
    const out = autoRevertSweep(db, overlay, {
      now: 2_000 + 25 * 60 * 60 * 1000,
      revertProposalImpl: fakeRevert,
    });
    expect(out.proposals_inspected).toBe(1);
    expect(fakeRevert).toHaveBeenCalledTimes(1);
    expect(out.reverted).toBe(0);
    expect(readFrozenSet(db).size).toBe(0);
  });
});

describe("autoRevertSweep — default option fallbacks", () => {
  it("uses defaults for now / window / threshold / freezeCycles when omitted", () => {
    // Covers lines 151-155 — all `??` fallbacks for AutoRevertSweepOptions.
    // The proposal must be applied BEFORE the signals were observed, since
    // computeWeightSince() looks for `observed_at > appliedAt`. We backdate
    // both: apply 5 days ago, signals at 1 day ago (well past the 24h age
    // gate that file_add requires).
    const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000 - 60_000;
    // Need an INSERT INTO that lets us also seed the proposal as having
    // a real first-overlay write so autoRevert finds something to delete.
    // (The default revertProposalImpl still succeeds even with no overlay
    // present — it falls through to OverlayStore.delete which is a no-op.)
    insertProposal({
      id: 50,
      skill_slug: "user-profile",
      section_id: "topic-files",
      status: "applied",
      decided_at: fiveDaysAgo,
    });
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
    const overlay = new OverlayStore(dataDir, skillsRoot);
    // Call WITHOUT options so every `??` fallback executes.
    const out = autoRevertSweep(db, overlay);
    expect(out.proposals_inspected).toBe(1);
    expect(out.reverted).toBe(1);
    expect(out.newly_frozen).toEqual([{ slug: "user-profile", section_id: "topic-files" }]);
  });

  it("falls back to proposed_at when decided_at is null", () => {
    // Covers line 172 — `appliedAt = c.decided_at ?? c.proposed_at`. Insert
    // an applied proposal with NULL decided_at and verify the sweep still
    // computes a weight window from proposed_at.
    db.prepare(
      `INSERT INTO skill_curation_proposals
         (id, run_id, skill_slug, section_id, section_kind, schema_version,
          renderer_version_at_proposal, prev_payload_json, new_payload_json,
          rendered_md, diff_additions, diff_modifications, diff_removals,
          diff_kind, rationale, signals_json, status, proposed_at, decided_at)
       VALUES (?, 'r1', ?, ?, 'convention_notes', 1, 'cn-v1', '{}', '{}', '',
               0, 0, 0, 'additive_only', 'r', '[]', 'applied', ?, NULL)`,
    ).run(99, "x", "y", 1_000);
    recordSignal(db, {
      skill_slug: "x",
      section_id: "y",
      signal_type: "structure_diff",
      payload: { sub_kind: "file_add" },
      observed_at: 2_000,
    });
    recordSignal(db, {
      skill_slug: "x",
      section_id: "y",
      signal_type: "structure_diff",
      payload: { sub_kind: "file_add" },
      observed_at: 2_000,
    });
    const overlay = new OverlayStore(dataDir, skillsRoot);
    const fakeRevert = vi.fn().mockReturnValue({ ok: true, proposalId: 99 });
    const out = autoRevertSweep(db, overlay, {
      now: 2_000 + 25 * 60 * 60 * 1000,
      revertProposalImpl: fakeRevert,
    });
    // The signals were observed at 2000 > proposed_at (1000), so the
    // weight is computed correctly via the proposed_at fallback.
    expect(out.reverted).toBe(1);
    expect(fakeRevert).toHaveBeenCalledTimes(1);
  });
});

describe("readFrozenSet edge cases", () => {
  it("returns empty when runtime_state row is missing", () => {
    expect(readFrozenSet(db).size).toBe(0);
  });

  it("survives skillsRoot/dataDir interplay (smoke)", () => {
    mkdirSync(skillsRoot, { recursive: true });
    writeFileSync(join(skillsRoot, ".keep"), "", "utf-8");
    expect(readFrozenSet(db).size).toBe(0);
  });
});
