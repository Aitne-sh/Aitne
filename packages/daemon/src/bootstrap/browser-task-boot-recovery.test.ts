/**
 * Boot-recovery sweep (§6.5) peer test.
 *
 * Targets the §13 row for "Boot-time recovery sweep (§6.5)". Covers:
 *   - empty DB → no-op + 0 affected count
 *   - DB with non-terminal rows → all flipped to failed(daemon_restarted)
 *   - per-row `agent_actions(action_type='browser_task.boot_recovery')`
 *     row emitted
 *   - re-run (idempotency) → 0 affected
 *   - terminal rows are NOT touched
 */

import { describe, expect, it } from "vitest";

import Database from "better-sqlite3";

import { applySchema } from "../db/schema.js";
import {
  createBrowserTask,
  getBrowserTask,
  markRunning,
  markTerminal,
} from "../db/browser-task-store.js";
import { surfaceBrowserTaskBootRecovery } from "./db.js";

function newDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  // backends row required for the FK on process_backend_config seed; the
  // seed itself doesn't apply because we're running applySchema only.
  return db;
}

describe("surfaceBrowserTaskBootRecovery", () => {
  it("no-op on empty DB", () => {
    const db = newDb();
    expect(surfaceBrowserTaskBootRecovery(db)).toBe(0);
    const auditCount = (
      db
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM agent_actions WHERE action_type = ?`,
        )
        .get("browser_task.boot_recovery") as { c: number } | undefined
    )?.c;
    expect(auditCount ?? 0).toBe(0);
  });

  it("flips every non-terminal row to failed(daemon_restarted)", () => {
    const db = newDb();
    // Two non-terminal rows + one already-terminal row.
    createBrowserTask(db, {
      id: "11111111-1111-4111-8111-111111111111",
      description: "task A",
      siteKey: "amazon_jp",
      extraAllowedHosts: [],
      originatingChannel: "slack:owner",
      scheduleRowId: null,
      requireFinalConfirm: true,
      effectiveAllowlistRegex: "^https?://amazon\\.co\\.jp/",
      createdAt: 1000,
    });
    markRunning(db, "11111111-1111-4111-8111-111111111111", 1100);
    createBrowserTask(db, {
      id: "22222222-2222-4222-8222-222222222222",
      description: "task B",
      siteKey: "x_com",
      extraAllowedHosts: [],
      originatingChannel: null,
      scheduleRowId: null,
      requireFinalConfirm: false,
      effectiveAllowlistRegex: null,
      createdAt: 2000,
    });
    createBrowserTask(db, {
      id: "33333333-3333-4333-8333-333333333333",
      description: "task C",
      siteKey: "amazon_com",
      extraAllowedHosts: [],
      originatingChannel: null,
      scheduleRowId: null,
      requireFinalConfirm: false,
      effectiveAllowlistRegex: null,
      createdAt: 3000,
    });
    markTerminal(db, {
      id: "33333333-3333-4333-8333-333333333333",
      state: "completed",
      outcomeDetail: "ok",
      report: "done",
      finishedAt: 3500,
    });

    const affected = surfaceBrowserTaskBootRecovery(db);
    expect(affected).toBe(2);

    const a = getBrowserTask(db, "11111111-1111-4111-8111-111111111111");
    expect(a?.state).toBe("failed");
    expect(a?.outcomeDetail).toBe("daemon_restarted");

    const b = getBrowserTask(db, "22222222-2222-4222-8222-222222222222");
    expect(b?.state).toBe("failed");
    expect(b?.outcomeDetail).toBe("daemon_restarted");

    const c = getBrowserTask(db, "33333333-3333-4333-8333-333333333333");
    expect(c?.state).toBe("completed");
    expect(c?.outcomeDetail).toBe("ok");

    const auditRows = db
      .prepare<[string], { detail: string }>(
        `SELECT detail FROM agent_actions WHERE action_type = ?`,
      )
      .all("browser_task.boot_recovery");
    expect(auditRows).toHaveLength(2);
    const detailParsed = auditRows.map((r) => JSON.parse(r.detail) as {
      taskId: string;
      originatingChannel: string | null;
    });
    expect(detailParsed.find((d) => d.taskId.startsWith("11111111"))?.originatingChannel).toBe(
      "slack:owner",
    );
    expect(detailParsed.find((d) => d.taskId.startsWith("22222222"))?.originatingChannel).toBeNull();
  });

  it("re-run after sweep is a no-op (idempotent)", () => {
    const db = newDb();
    createBrowserTask(db, {
      id: "11111111-1111-4111-8111-111111111111",
      description: "task A",
      siteKey: "amazon_jp",
      extraAllowedHosts: [],
      originatingChannel: null,
      scheduleRowId: null,
      requireFinalConfirm: true,
      effectiveAllowlistRegex: null,
      createdAt: 1000,
    });
    expect(surfaceBrowserTaskBootRecovery(db)).toBe(1);
    expect(surfaceBrowserTaskBootRecovery(db)).toBe(0);
  });

  it("includes every non-terminal state in the sweep", () => {
    const db = newDb();
    const ids = ["pending-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "running-bbbb-bbbb-bbbb-bbbbbbbbbbbb"];
    for (const id of ids) {
      createBrowserTask(db, {
        id,
        description: "x",
        siteKey: "amazon_jp",
        extraAllowedHosts: [],
        originatingChannel: null,
        scheduleRowId: null,
        requireFinalConfirm: false,
        effectiveAllowlistRegex: null,
        createdAt: 1000,
      });
    }
    markRunning(db, ids[1], 1100);
    // Park one as awaiting_user via raw SQL (skips the markAwaitingUser CAS shape).
    db.prepare(`UPDATE browser_task SET state = 'awaiting_user' WHERE id = ?`).run(ids[1]);

    expect(surfaceBrowserTaskBootRecovery(db)).toBe(2);
    expect(getBrowserTask(db, ids[0])?.state).toBe("failed");
    expect(getBrowserTask(db, ids[1])?.state).toBe("failed");
  });
});
