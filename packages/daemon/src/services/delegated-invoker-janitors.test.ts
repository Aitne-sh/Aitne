/**
 * Peer tests for `./delegated-invoker-janitors.ts` — boot-time crash-safety
 * sweepers split out of `delegated-backend-invoker.ts` (file-split-plan §9
 * Tier 1).
 *
 * - {@link runDelegatedTaskOrphanJanitor} flips orphaned in-progress task
 *   rows to failed (subprocess_orphaned). We seed rows directly so the
 *   test doesn't depend on the rest of the invoker.
 * - {@link runProxyTempdirJanitor} sweeps stale `proxy-*` session dirs
 *   older than maxAgeMs. We build a fake `agent-sessions/` tree on a
 *   temp dir and check the right entries get removed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { applySchema } from "../db/schema.js";
import { DELEGATED_PROXY_DEFAULTS } from "./delegated-proxy-config.js";
import {
  runDelegatedTaskOrphanJanitor,
  runProxyTempdirJanitor,
} from "./delegated-invoker-janitors.js";

describe("runDelegatedTaskOrphanJanitor", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  it("flips orphaned in_progress rows to failed with subprocess_orphaned error", () => {
    db.prepare(
      `INSERT INTO agent_actions (action_type, result, started_at, backend, cost_source)
       VALUES ('delegated_task.exec', 'in_progress', datetime('now', '-1 hour'), 'claude', 'sdk')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_actions (action_type, result, started_at, backend, cost_source)
       VALUES ('delegated_task.run', 'in_progress', datetime('now', '-2 hour'), 'claude', 'sdk')`,
    ).run();

    const changed = runDelegatedTaskOrphanJanitor(db);
    expect(changed).toBe(2);

    const rows = db
      .prepare<[], { result: string; error: string }>(
        `SELECT result, error FROM agent_actions WHERE action_type LIKE 'delegated_task.%'`,
      )
      .all();
    for (const row of rows) {
      expect(row.result).toBe("failed");
      expect(row.error).toBe("subprocess_orphaned");
    }
  });

  it("does not touch in_progress rows newer than maxAgeMs", () => {
    db.prepare(
      `INSERT INTO agent_actions (action_type, result, started_at, backend, cost_source)
       VALUES ('delegated_task.exec', 'in_progress', datetime('now'), 'claude', 'sdk')`,
    ).run();

    const changed = runDelegatedTaskOrphanJanitor(db, { maxAgeMs: 10 * 60 * 1000 });
    expect(changed).toBe(0);
  });

  it("does not touch already-settled rows", () => {
    db.prepare(
      `INSERT INTO agent_actions (action_type, result, started_at, backend, cost_source)
       VALUES ('delegated_task.exec', 'success', datetime('now', '-1 hour'), 'claude', 'sdk')`,
    ).run();
    const changed = runDelegatedTaskOrphanJanitor(db);
    expect(changed).toBe(0);
  });

  it("returns 0 and logs warn on SQL failure", () => {
    db.close();
    const changed = runDelegatedTaskOrphanJanitor(db);
    expect(changed).toBe(0);
  });
});

describe("runProxyTempdirJanitor", () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "proxy-janitor-test-"));
    mkdirSync(join(scratch, "agent-sessions"));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("returns 0 when agent-sessions dir does not exist", () => {
    const missing = mkdtempSync(join(tmpdir(), "no-sessions-"));
    const result = runProxyTempdirJanitor(missing);
    expect(result).toBe(0);
    rmSync(missing, { recursive: true, force: true });
  });

  it("removes proxy-* dirs older than maxAgeMs and leaves recent ones", () => {
    const sessionsDir = join(scratch, "agent-sessions");
    const oldDir = join(sessionsDir, `${DELEGATED_PROXY_DEFAULTS.tempdirPrefix}aaa`);
    const freshDir = join(sessionsDir, `${DELEGATED_PROXY_DEFAULTS.tempdirPrefix}bbb`);
    mkdirSync(oldDir);
    mkdirSync(freshDir);
    writeFileSync(join(oldDir, "marker"), "x");
    writeFileSync(join(freshDir, "marker"), "y");

    // Age `oldDir` by setting its mtime to 2 hours ago.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(oldDir, twoHoursAgo, twoHoursAgo);

    const removed = runProxyTempdirJanitor(scratch, { maxAgeMs: 60 * 60 * 1000 });
    expect(removed).toBe(1);
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(freshDir)).toBe(true);
  });

  it("ignores non-proxy entries and non-directory entries", () => {
    const sessionsDir = join(scratch, "agent-sessions");
    mkdirSync(join(sessionsDir, "messages-session-1")); // wrong prefix
    writeFileSync(join(sessionsDir, "proxy-stray-file"), "x"); // file, not dir

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(join(sessionsDir, "messages-session-1"), twoHoursAgo, twoHoursAgo);
    utimesSync(join(sessionsDir, "proxy-stray-file"), twoHoursAgo, twoHoursAgo);

    const removed = runProxyTempdirJanitor(scratch, { maxAgeMs: 60 * 60 * 1000 });
    expect(removed).toBe(0);
    expect(existsSync(join(sessionsDir, "messages-session-1"))).toBe(true);
    expect(existsSync(join(sessionsDir, "proxy-stray-file"))).toBe(true);
  });
});
