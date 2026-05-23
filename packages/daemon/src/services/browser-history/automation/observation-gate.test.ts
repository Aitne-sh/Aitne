import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { applySchema } from "../../../db/schema.js";
import { computeObservationGate } from "./observation-gate.js";

const SIX_WEEKS_MS = 42 * 24 * 60 * 60 * 1000;
const NOW_MS = 1_750_000_000_000;
const WINDOW_START = NOW_MS - SIX_WEEKS_MS;

function insertRun(
  db: Database.Database,
  i: number,
  outcome: string,
  blocked: string[],
  startedAt: number,
): void {
  db.prepare(
    `INSERT INTO browser_automation_workflows
       (workflow_id, workflow_name, params_hash, target_urls,
        blocked_requests, duration_ms, outcome,
        started_at, finished_at, screenshot_path, trace_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(
    `11111111-2222-3333-4444-${String(i).padStart(12, "0")}`,
    "extractNewsArticle",
    "abc",
    JSON.stringify(["https://example.com/"]),
    JSON.stringify(blocked),
    100,
    outcome,
    startedAt,
    startedAt + 100,
  );
}

describe("computeObservationGate", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });
  afterEach(() => db.close());

  it("renders the eight §10 criteria on an empty DB", () => {
    const r = computeObservationGate(db, NOW_MS);
    expect(r.criteria).toHaveLength(8);
    expect(r.criteria.map((c) => c.id).sort()).toEqual([
      "absolute_block_hits",
      "compromise_signals",
      "denylist_hits_per_workflow",
      "playwright_error_rate",
      "reauth_false_positives",
      "sandbox_refusals",
      "timeout_rate",
      "user_reported_high_severity",
    ]);
    expect(r.overall).toBe("green");
    expect(r.windowStartedAt).toBe(WINDOW_START);
    expect(r.windowEndedAt).toBe(NOW_MS);
  });

  it("flips overall to red when any zero-tolerance criterion has a hit", () => {
    db.prepare(
      `INSERT INTO agent_actions (action_type, trigger, result, detail, completed_at, source_kind)
       VALUES ('blocked_absolute', 'manual', 'failed',
               '{"matched_rule":"browser_profile"}',
               CURRENT_TIMESTAMP, 'cron')`,
    ).run();
    const r = computeObservationGate(db, NOW_MS);
    const blocked = r.criteria.find((c) => c.id === "absolute_block_hits");
    expect(blocked?.value).toBeGreaterThan(0);
    expect(blocked?.status).toBe("red");
    expect(r.overall).toBe("red");
  });

  it("computes playwright_error_rate as a percent", () => {
    // 1 / 5 → 20 %
    for (let i = 0; i < 4; i++) {
      insertRun(db, i, "success", [], NOW_MS - 1_000);
    }
    insertRun(db, 4, "playwright_error", [], NOW_MS - 1_000);
    const r = computeObservationGate(db, NOW_MS);
    const rate = r.criteria.find((c) => c.id === "playwright_error_rate");
    expect(rate?.value).toBe(20.0);
    expect(rate?.status).toBe("red"); // > 2 % threshold
  });

  it("computes timeout_rate as a percent", () => {
    for (let i = 0; i < 9; i++) {
      insertRun(db, i, "success", [], NOW_MS - 1_000);
    }
    insertRun(db, 9, "timeout", [], NOW_MS - 1_000);
    const r = computeObservationGate(db, NOW_MS);
    const rate = r.criteria.find((c) => c.id === "timeout_rate");
    expect(rate?.value).toBe(10.0);
    expect(rate?.status).toBe("red"); // > 1 %
  });

  it("ignores rows started before the 6-week window", () => {
    // Old row way before the window.
    insertRun(db, 0, "playwright_error", [], WINDOW_START - 1_000);
    // No in-window rows → rates report 0 with green status.
    const r = computeObservationGate(db, NOW_MS);
    const rate = r.criteria.find((c) => c.id === "playwright_error_rate");
    expect(rate?.value).toBe(0);
    expect(rate?.status).toBe("green");
  });

  it("aggregates blocked_requests array lengths per row", () => {
    insertRun(
      db,
      0,
      "success",
      ["https://a.com/", "https://b.com/"],
      NOW_MS - 1_000,
    );
    insertRun(db, 1, "success", ["https://c.com/"], NOW_MS - 1_000);
    const r = computeObservationGate(db, NOW_MS);
    const hits = r.criteria.find((c) => c.id === "denylist_hits_per_workflow");
    expect(hits?.value).toBe(3);
  });

  it("returns 0 sandbox refusals on a clean DB", () => {
    const r = computeObservationGate(db, NOW_MS);
    const sandbox = r.criteria.find((c) => c.id === "sandbox_refusals");
    expect(sandbox?.value).toBe(0);
    expect(sandbox?.status).toBe("green");
  });

  it("counts sandbox refusal agent_actions rows in the window", () => {
    db.prepare(
      `INSERT INTO agent_actions (action_type, trigger, result, detail, completed_at, source_kind)
       VALUES ('browser_lifecycle.chromium_sync.refused', 'manual', 'failed',
               '{}', CURRENT_TIMESTAMP, 'cron')`,
    ).run();
    const r = computeObservationGate(db, NOW_MS);
    const sandbox = r.criteria.find((c) => c.id === "sandbox_refusals");
    expect(sandbox?.value).toBeGreaterThan(0);
    expect(sandbox?.status).toBe("red");
  });

  it("counts compromise-signal agent_actions in the window", () => {
    db.prepare(
      `INSERT INTO agent_actions (action_type, trigger, result, detail, completed_at, source_kind)
       VALUES ('browser_automation.site_session_expired', 'manual', 'failed',
               '{}', CURRENT_TIMESTAMP, 'cron')`,
    ).run();
    const r = computeObservationGate(db, NOW_MS);
    const sig = r.criteria.find((c) => c.id === "compromise_signals");
    expect(sig?.value).toBeGreaterThan(0);
  });

  it("excludes compromise-signal rows outside the 6-week window (regression: SQL precedence)", () => {
    // The pre-fix WHERE was
    //   action_type LIKE 'a' OR action_type LIKE 'b' OR action_type = 'c'
    //     AND completed_at >= ?
    // which, under SQL's AND-tighter-than-OR precedence, only date-
    // filtered the third branch. A row matching the first or second
    // pattern but stamped 10 years ago slipped into the count.
    // Stamp a `compromise_xyz` row at a wall-clock the SQLite literal
    // resolves to 1970-01-01; the test window starts at NOW - 6 weeks,
    // so the row must be excluded.
    db.prepare(
      `INSERT INTO agent_actions (action_type, trigger, result, detail, completed_at, source_kind)
       VALUES ('browser_automation.compromise_xyz', 'manual', 'failed',
               '{}', '1970-01-01T00:00:00.000Z', 'cron')`,
    ).run();
    const r = computeObservationGate(db, NOW_MS);
    const sig = r.criteria.find((c) => c.id === "compromise_signals");
    expect(sig?.value).toBe(0);
  });

  it("flips overall to amber when a non-zero-tolerance criterion crosses 75% of threshold", () => {
    // 100 runs, 2 failures → 2 % failure rate.
    // bucketize: value(2) > threshold(2)? no. value(2) > 0.75*threshold(1.5)? yes → amber.
    for (let i = 0; i < 98; i++) {
      insertRun(db, i, "success", [], NOW_MS - 1_000);
    }
    insertRun(db, 98, "playwright_error", [], NOW_MS - 1_000);
    insertRun(db, 99, "playwright_error", [], NOW_MS - 1_000);
    const r = computeObservationGate(db, NOW_MS);
    const rate = r.criteria.find((c) => c.id === "playwright_error_rate");
    expect(rate?.status).toBe("amber");
    expect(r.overall).toBe("amber");
  });

  it("survives a missing browser_automation_workflows table (catch path)", () => {
    db.exec("DROP TABLE browser_automation_workflows;");
    const r = computeObservationGate(db, NOW_MS);
    expect(r.criteria).toHaveLength(8);
    const rate = r.criteria.find((c) => c.id === "playwright_error_rate");
    expect(rate?.value).toBe(0);
  });

  it("survives a missing agent_actions table (catch path)", () => {
    db.exec("DROP TABLE agent_actions;");
    const r = computeObservationGate(db, NOW_MS);
    expect(r.criteria).toHaveLength(8);
    const sandbox = r.criteria.find((c) => c.id === "sandbox_refusals");
    expect(sandbox?.value).toBe(0);
  });
});
