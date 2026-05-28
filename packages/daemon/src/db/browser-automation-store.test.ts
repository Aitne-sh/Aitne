import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { deleteWorkflowRunsOlderThan } from "./browser-automation-store.js";
import { applySchema } from "./schema.js";

/**
 * BROWSER_TASK_REDESIGN_PLAN.md §9 Phase 6 + Phase 6.5 dead-code rip-out:
 * `insertWorkflowRun`, `listRecentWorkflowRuns`, `getWorkflowRunById`, and
 * the four `*AllowlistEntry*` / `isDomainAllowed` helpers were removed
 * along with their routes. Only `deleteWorkflowRunsOlderThan` remains as
 * the retention-sweep entry point for the still-retained
 * `browser_automation_workflows` audit table. The test below is the
 * narrow surface that survives.
 */
describe("browser-automation-store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });
  afterEach(() => db.close());

  describe("deleteWorkflowRunsOlderThan", () => {
    it("prunes only rows with started_at < cutoff and reports the deleted count", () => {
      // Insert two legacy rows directly via SQL — the row-writer helper
      // (`insertWorkflowRun`) was deleted in Phase 6.5, so this test
      // simulates the pre-Phase-6 audit-table shape the daemon now only
      // reads-and-prunes from.
      db.prepare(
        `INSERT INTO browser_automation_workflows
           (workflow_id, workflow_name, params_hash, target_urls,
            blocked_requests, duration_ms, outcome,
            started_at, finished_at, screenshot_path, trace_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "11111111-1111-1111-1111-111111111111",
        "screenshotPage",
        "h1",
        "[]",
        "[]",
        100,
        "success",
        100,
        200,
        null,
        null,
      );
      db.prepare(
        `INSERT INTO browser_automation_workflows
           (workflow_id, workflow_name, params_hash, target_urls,
            blocked_requests, duration_ms, outcome,
            started_at, finished_at, screenshot_path, trace_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "22222222-2222-2222-2222-222222222222",
        "screenshotPage",
        "h2",
        "[]",
        "[]",
        100,
        "success",
        5000,
        5100,
        null,
        null,
      );

      const deleted = deleteWorkflowRunsOlderThan(db, 1000);
      expect(deleted).toBe(1);

      const remaining = db
        .prepare<[], { workflow_id: string }>(
          "SELECT workflow_id FROM browser_automation_workflows",
        )
        .all();
      expect(remaining).toEqual([
        { workflow_id: "22222222-2222-2222-2222-222222222222" },
      ]);
    });

    it("returns 0 when no rows are old enough", () => {
      expect(deleteWorkflowRunsOlderThan(db, 0)).toBe(0);
    });
  });
});
