import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../../db/schema.js";
import {
  markSignalsConsumed,
  recordSignal,
  selectSkillsForRun,
  unconsumedSignalsAll,
  unconsumedSignalsForSkill,
  weightFor,
} from "./signals.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  applySchema(db);
});
afterEach(() => {
  db.close();
});

describe("recordSignal / unconsumedSignalsForSkill", () => {
  it("inserts and recalls an unconsumed signal", () => {
    const id = recordSignal(db, {
      skill_slug: "user-profile",
      section_id: "topic-files",
      signal_type: "structure_diff",
      payload: { sub_kind: "heading_add", heading: "## Health" },
    });
    expect(id).toBeGreaterThan(0);
    const rows = unconsumedSignalsForSkill(db, "user-profile");
    expect(rows).toHaveLength(1);
    expect(rows[0].signal_type).toBe("structure_diff");
  });

  it("excludes consumed signals", () => {
    const id = recordSignal(db, {
      skill_slug: "x",
      signal_type: "structure_diff",
      payload: {},
    });
    markSignalsConsumed(db, [id], 42);
    expect(unconsumedSignalsForSkill(db, "x")).toHaveLength(0);
  });
});

describe("weightFor", () => {
  it("respects min-age gate for low-weight signals", () => {
    const id = recordSignal(db, {
      skill_slug: "x",
      signal_type: "structure_diff",
      payload: { sub_kind: "heading_add" },
      observed_at: 1000,
    });
    const sig = unconsumedSignalsForSkill(db, "x").find((s) => s.id === id)!;
    expect(weightFor(sig, 1000)).toBe(0);
    expect(weightFor(sig, 1000 + 25 * 60 * 60 * 1000)).toBe(1);
  });

  it("scores file_add signals higher", () => {
    const id = recordSignal(db, {
      skill_slug: "x",
      signal_type: "structure_diff",
      payload: { sub_kind: "file_add" },
      observed_at: 1000,
    });
    const sig = unconsumedSignalsForSkill(db, "x").find((s) => s.id === id)!;
    expect(weightFor(sig, 1000 + 25 * 60 * 60 * 1000)).toBe(2);
  });

  it("file_remove also scores 2", () => {
    const id = recordSignal(db, {
      skill_slug: "x",
      signal_type: "structure_diff",
      payload: { sub_kind: "file_remove" },
      observed_at: 1000,
    });
    const sig = unconsumedSignalsForSkill(db, "x").find((s) => s.id === id)!;
    expect(weightFor(sig, 1000 + 25 * 60 * 60 * 1000)).toBe(2);
  });
});

describe("selectSkillsForRun", () => {
  const oldNow = 1;
  const fileAddPayload = { sub_kind: "file_add" };
  const headingAddPayload = { sub_kind: "heading_add" };

  it("skips skills below min weight", () => {
    recordSignal(db, { skill_slug: "x", signal_type: "structure_diff", payload: headingAddPayload, observed_at: 1 });
    const sels = selectSkillsForRun(db, { now: 1 + 25 * 60 * 60 * 1000 });
    expect(sels).toHaveLength(0); // weight 1 < 3
  });

  it("admits skills with weight ≥ 3 and orders by weight", () => {
    // Skill `a`: one structure_diff/heading_add (weight 1) — below threshold.
    // Skill `b`: two file_add (weight 2 each = 4) + one heading_add (1) = 5.
    // After threshold filter only `b` remains (weight 5).
    // Add a third for `c`: two file_add (4) — also passes; expect order [b, c].
    recordSignal(db, { skill_slug: "a", signal_type: "structure_diff", payload: headingAddPayload, observed_at: oldNow });
    recordSignal(db, { skill_slug: "b", signal_type: "structure_diff", payload: fileAddPayload, observed_at: oldNow });
    recordSignal(db, { skill_slug: "b", signal_type: "structure_diff", payload: fileAddPayload, observed_at: oldNow });
    recordSignal(db, { skill_slug: "b", signal_type: "structure_diff", payload: headingAddPayload, observed_at: oldNow });
    recordSignal(db, { skill_slug: "c", signal_type: "structure_diff", payload: fileAddPayload, observed_at: oldNow });
    recordSignal(db, { skill_slug: "c", signal_type: "structure_diff", payload: fileAddPayload, observed_at: oldNow });
    const future = oldNow + 25 * 60 * 60 * 1000;
    const sels = selectSkillsForRun(db, { now: future });
    expect(sels.map((s) => s.skill_slug)).toEqual(["b", "c"]);
  });

  it("excludes skills via excludedSlugs", () => {
    recordSignal(db, { skill_slug: "a", signal_type: "structure_diff", payload: fileAddPayload, observed_at: oldNow });
    recordSignal(db, { skill_slug: "a", signal_type: "structure_diff", payload: fileAddPayload, observed_at: oldNow });
    const future = oldNow + 25 * 60 * 60 * 1000;
    const sels = selectSkillsForRun(db, { excludedSlugs: new Set(["a"]), now: future });
    expect(sels).toHaveLength(0);
  });

  it("flags cooldown-blocked when an applied proposal is recent", () => {
    // Two file_add signals → weight 4 ≥ 3 threshold.
    recordSignal(db, { skill_slug: "x", signal_type: "structure_diff", payload: fileAddPayload, observed_at: 1 });
    recordSignal(db, { skill_slug: "x", signal_type: "structure_diff", payload: fileAddPayload, observed_at: 1 });
    db.prepare(
      `INSERT INTO skill_curation_proposals (run_id, skill_slug, section_id, section_kind,
        schema_version, renderer_version_at_proposal, prev_payload_json, new_payload_json,
        rendered_md, diff_additions, diff_modifications, diff_removals, diff_kind, rationale,
        signals_json, status, proposed_at)
       VALUES ('r', 'x', 's', 'convention_notes', 1, 'v', '{}', '{}', '', 0, 0, 0, 'additive_only',
         'r', '[]', 'applied', ?)`,
    ).run(Date.now() - 60_000);
    const sels = selectSkillsForRun(db);
    const x = sels.find((s) => s.skill_slug === "x");
    expect(x?.cooldown_blocked).toBe(true);
  });

  it("manual run (ignoreCooldowns) bypasses cooldown flag", () => {
    recordSignal(db, { skill_slug: "x", signal_type: "structure_diff", payload: fileAddPayload, observed_at: 1 });
    recordSignal(db, { skill_slug: "x", signal_type: "structure_diff", payload: fileAddPayload, observed_at: 1 });
    db.prepare(
      `INSERT INTO skill_curation_proposals (run_id, skill_slug, section_id, section_kind,
        schema_version, renderer_version_at_proposal, prev_payload_json, new_payload_json,
        rendered_md, diff_additions, diff_modifications, diff_removals, diff_kind, rationale,
        signals_json, status, proposed_at)
       VALUES ('r', 'x', 's', 'convention_notes', 1, 'v', '{}', '{}', '', 0, 0, 0, 'additive_only',
         'r', '[]', 'applied', ?)`,
    ).run(Date.now() - 60_000);
    const sels = selectSkillsForRun(db, { ignoreCooldowns: true });
    const x = sels.find((s) => s.skill_slug === "x");
    expect(x?.cooldown_blocked).toBe(false);
  });

  it("manual run (minWeight 0) admits skills with a single low-weight signal", () => {
    recordSignal(db, { skill_slug: "x", signal_type: "structure_diff", payload: headingAddPayload, observed_at: 1 });
    const future = 1 + 25 * 60 * 60 * 1000;
    const sels = selectSkillsForRun(db, { minWeight: 0, now: future });
    expect(sels.map((s) => s.skill_slug)).toEqual(["x"]);
  });
});

describe("unconsumedSignalsAll", () => {
  it("returns signals from all skills", () => {
    recordSignal(db, { skill_slug: "a", signal_type: "structure_diff", payload: { sub_kind: "file_add" } });
    recordSignal(db, { skill_slug: "b", signal_type: "structure_diff", payload: { sub_kind: "file_add" } });
    expect(unconsumedSignalsAll(db)).toHaveLength(2);
  });
});

describe("markSignalsConsumed edge cases", () => {
  it("returns early without preparing a SQL statement when ids is empty", () => {
    // Pre-condition: no rows touched. We assert by recording one row, calling
    // markSignalsConsumed([], ...), and confirming the row is still unconsumed.
    const id = recordSignal(db, {
      skill_slug: "x",
      signal_type: "structure_diff",
      payload: { sub_kind: "file_add" },
    });
    markSignalsConsumed(db, [], 999);
    const rows = unconsumedSignalsForSkill(db, "x");
    expect(rows.map((r) => r.id)).toEqual([id]);
  });

  it("supports a single-element ids array", () => {
    const id = recordSignal(db, {
      skill_slug: "x",
      signal_type: "structure_diff",
      payload: { sub_kind: "file_add" },
    });
    markSignalsConsumed(db, [id], 7);
    expect(unconsumedSignalsForSkill(db, "x")).toHaveLength(0);
  });
});

describe("weightFor payload parsing branches", () => {
  it("falls back to default weight when payload_json is invalid JSON", () => {
    // Insert a row directly so payload_json is a literal that JSON.parse rejects.
    // safeParse must catch and treat it as an empty payload (no sub_kind),
    // which means default weight = 1 once min-age has elapsed.
    db.prepare(
      `INSERT INTO skill_curation_signals
         (skill_slug, section_id, signal_type, payload_json, observed_at)
       VALUES ('x', NULL, 'structure_diff', '{not-valid-json', 1000)`,
    ).run();
    const sig = unconsumedSignalsForSkill(db, "x")[0]!;
    expect(weightFor(sig, 1000 + 25 * 60 * 60 * 1000)).toBe(1);
  });

  it("falls back to default weight when payload is JSON but not an object with sub_kind", () => {
    // Payload parses to a primitive — exercises the `(payload && ...) ?? ""`
    // null-coalescing branch where payload is truthy but lacks sub_kind.
    db.prepare(
      `INSERT INTO skill_curation_signals
         (skill_slug, section_id, signal_type, payload_json, observed_at)
       VALUES ('x', NULL, 'structure_diff', '"plain-string"', 2000)`,
    ).run();
    const sig = unconsumedSignalsForSkill(db, "x")[0]!;
    expect(weightFor(sig, 2000 + 25 * 60 * 60 * 1000)).toBe(1);
  });

  it("falls back to default weight when payload is JSON null", () => {
    db.prepare(
      `INSERT INTO skill_curation_signals
         (skill_slug, section_id, signal_type, payload_json, observed_at)
       VALUES ('x', NULL, 'structure_diff', 'null', 3000)`,
    ).run();
    const sig = unconsumedSignalsForSkill(db, "x")[0]!;
    expect(weightFor(sig, 3000 + 25 * 60 * 60 * 1000)).toBe(1);
  });
});

describe("selectSkillsForRun cooldown — reverted/conflict branch", () => {
  // Targets isOnCooldown's revertedRow check: applied check passes (no row),
  // then the function inspects the auto_reverted/conflict cooldown.
  const fileAddPayload = { sub_kind: "file_add" };

  function insertProposal(status: string, decidedAt: number) {
    db.prepare(
      `INSERT INTO skill_curation_proposals (run_id, skill_slug, section_id, section_kind,
        schema_version, renderer_version_at_proposal, prev_payload_json, new_payload_json,
        rendered_md, diff_additions, diff_modifications, diff_removals, diff_kind, rationale,
        signals_json, status, proposed_at, decided_at)
       VALUES ('r', 'x', 's', 'convention_notes', 1, 'v', '{}', '{}', '', 0, 0, 0, 'additive_only',
         'r', '[]', ?, ?, ?)`,
    ).run(status, decidedAt - 1000, decidedAt);
  }

  it("flags cooldown when an auto_reverted proposal is recent", () => {
    recordSignal(db, { skill_slug: "x", signal_type: "structure_diff", payload: fileAddPayload, observed_at: 1 });
    recordSignal(db, { skill_slug: "x", signal_type: "structure_diff", payload: fileAddPayload, observed_at: 1 });
    const now = Date.now();
    insertProposal("auto_reverted", now - 60_000);
    const sels = selectSkillsForRun(db, { now });
    expect(sels.find((s) => s.skill_slug === "x")?.cooldown_blocked).toBe(true);
  });

  it("flags cooldown when a conflict proposal is within the reverted window", () => {
    recordSignal(db, { skill_slug: "x", signal_type: "structure_diff", payload: fileAddPayload, observed_at: 1 });
    recordSignal(db, { skill_slug: "x", signal_type: "structure_diff", payload: fileAddPayload, observed_at: 1 });
    const now = Date.now();
    insertProposal("conflict", now - 60_000);
    const sels = selectSkillsForRun(db, { now });
    expect(sels.find((s) => s.skill_slug === "x")?.cooldown_blocked).toBe(true);
  });

  it("clears cooldown once the reverted window has elapsed", () => {
    recordSignal(db, { skill_slug: "x", signal_type: "structure_diff", payload: fileAddPayload, observed_at: 1 });
    recordSignal(db, { skill_slug: "x", signal_type: "structure_diff", payload: fileAddPayload, observed_at: 1 });
    const now = Date.now();
    // 15 days ago — past the 14d reverted cooldown default.
    insertProposal("auto_reverted", now - 15 * 24 * 60 * 60 * 1000);
    const sels = selectSkillsForRun(db, { now });
    expect(sels.find((s) => s.skill_slug === "x")?.cooldown_blocked).toBe(false);
  });
});
