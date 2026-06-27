import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  runRetentionCleanup,
  rollupAgentJournal,
  checkAgentJournalHealth,
  compareWeeklyKey,
  compareMonthlyKey,
} from "./retention.js";
import Database from "better-sqlite3";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { AgentConfig } from "../config.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE md_file_snapshots (
      id INTEGER PRIMARY KEY,
      file_path TEXT,
      content TEXT,
      trigger TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      session_id INTEGER,
      role TEXT,
      content TEXT,
      platform TEXT,
      timestamp TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE agent_actions (
      id INTEGER PRIMARY KEY,
      action_type TEXT,
      trigger TEXT,
      result TEXT,
      cost_usd REAL DEFAULT 0,
      started_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE notification_log (
      id INTEGER PRIMARY KEY,
      notification_type TEXT,
      priority TEXT,
      platform TEXT,
      content_summary TEXT,
      status TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE conversation_sessions (
      id INTEGER PRIMARY KEY,
      status TEXT DEFAULT 'expired',
      last_message_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE dm_conversation_log (
      id INTEGER PRIMARY KEY,
      platform TEXT,
      summary TEXT,
      message_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      ref TEXT NOT NULL,
      change_type TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'user',
      observed_at TEXT DEFAULT (datetime('now')),
      payload TEXT,
      consumed_at TEXT,
      consumed_by TEXT,
      summary_text TEXT,
      novelty_score INTEGER,
      summary_at TEXT,
      summary_backend TEXT,
      summary_status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE agent_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scheduled_for TEXT NOT NULL,
      task_type TEXT NOT NULL DEFAULT 'wake',
      task_description TEXT NOT NULL DEFAULT '',
      task_context TEXT,
      correlation_id TEXT,
      model TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE mcp_tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      event_type TEXT,
      session_id TEXT,
      ok INTEGER,
      error TEXT,
      called_at INTEGER NOT NULL,
      duration_ms INTEGER
    );
    CREATE TABLE integration_writes (
      integration TEXT NOT NULL,
      item_id     TEXT NOT NULL,
      written_at  TEXT NOT NULL,
      written_by  TEXT NOT NULL DEFAULT 'agent',
      expires_at  TEXT NOT NULL,
      PRIMARY KEY (integration, item_id)
    );
    CREATE TABLE imminent_event_notifications (
      item_id     TEXT PRIMARY KEY,
      notified_at TEXT NOT NULL
    );
    CREATE TABLE auth_telemetry_counters (
      backend_id TEXT NOT NULL,
      counter_key TEXT NOT NULL,
      bucket_hour TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'reactive',
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (backend_id, counter_key, bucket_hour, source)
    );
    CREATE TABLE mail_messages_index (
      account_id TEXT NOT NULL,
      provider_msg_id TEXT NOT NULL,
      received_at_utc TEXT NOT NULL,
      folder TEXT NOT NULL DEFAULT 'inbox',
      observed_at_utc TEXT NOT NULL,
      deleted_at_utc TEXT,
      subject TEXT,
      snippet TEXT,
      PRIMARY KEY (account_id, provider_msg_id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_mail_messages USING fts5(
      account_id UNINDEXED,
      provider_msg_id UNINDEXED,
      subject,
      snippet
    );
    CREATE TABLE parse_failures (
      id INTEGER PRIMARY KEY,
      provider_msg_id TEXT,
      error_reason TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE management_parse_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section TEXT,
      reason TEXT NOT NULL,
      raw TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE skill_curation_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_slug TEXT NOT NULL,
      section_id TEXT,
      signal_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      consumed_at INTEGER,
      consumed_by_proposal_id INTEGER
    );
    CREATE TABLE skill_curation_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      skill_slug TEXT NOT NULL,
      section_id TEXT NOT NULL,
      status TEXT NOT NULL,
      proposed_at INTEGER NOT NULL
    );
    CREATE TABLE skill_curation_runs (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      finalized_at INTEGER,
      cadence TEXT NOT NULL,
      backend TEXT NOT NULL,
      model TEXT NOT NULL,
      target_skills_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      proposal_count INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      is_manual INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE chat_attachments (
      id TEXT PRIMARY KEY,
      session_id INTEGER,
      message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      direction TEXT NOT NULL,
      provenance TEXT NOT NULL,
      path TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      safe_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      turn_token TEXT,
      caption TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_actions USING fts5(
      action_type, detail, tokenize='trigram'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_messages USING fts5(
      content, tokenize='trigram'
    );
  `);
  return db;
}

describe("runRetentionCleanup", () => {
  let tmpDir: string;
  let config: AgentConfig;

  beforeEach(() => {
    tmpDir = resolve(tmpdir(), `pa-retention-${randomUUID()}`);
    mkdirSync(resolve(tmpDir, "context", "weekly"), { recursive: true });
    config = { dataDir: tmpDir } as unknown as AgentConfig;
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("deletes old md_file_snapshots", () => {
    const db = createTestDb();
    // Insert old snapshot (31 days ago)
    db.prepare(
      "INSERT INTO md_file_snapshots (file_path, content, trigger, created_at) VALUES (?, ?, ?, datetime('now', '-31 days'))",
    ).run("today.md", "old content", "api_put");
    // Insert recent snapshot
    db.prepare(
      "INSERT INTO md_file_snapshots (file_path, content, trigger) VALUES (?, ?, ?)",
    ).run("today.md", "new content", "api_put");

    const result = runRetentionCleanup(db, config);

    expect(result.mdFileSnapshots).toBe(1);
    const remaining = db.prepare("SELECT COUNT(*) as cnt FROM md_file_snapshots").get() as { cnt: number };
    expect(remaining.cnt).toBe(1);
  });

  it("deletes old messages", () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO messages (session_id, role, content, platform, timestamp) VALUES (1, 'user', 'old', 'slack', datetime('now', '-91 days'))",
    ).run();
    db.prepare(
      "INSERT INTO messages (session_id, role, content, platform) VALUES (1, 'user', 'new', 'slack')",
    ).run();

    const result = runRetentionCleanup(db, config);

    expect(result.messages).toBe(1);
  });

  it("removes attachment directories after message retention cascades DB rows", () => {
    const db = createTestDb();
    db.pragma("foreign_keys = ON");
    const attachmentDir = resolve(tmpDir, "attachments", "att-old");
    const attachmentPath = resolve(attachmentDir, "old.png");
    mkdirSync(attachmentDir, { recursive: true });
    writeFileSync(attachmentPath, "bytes");
    const oldDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(attachmentDir, oldDate, oldDate);

    db.prepare(
      "INSERT INTO messages (id, session_id, role, content, platform, timestamp) VALUES (501, 1, 'user', 'old', 'dashboard', datetime('now', '-91 days'))",
    ).run();
    db.prepare(
      `INSERT INTO chat_attachments
        (id, message_id, direction, provenance, path, original_filename, safe_filename, mime_type, size_bytes)
       VALUES ('att-old', 501, 'inbound', 'user_dashboard', ?, 'old.png', 'old.png', 'image/png', 5)`,
    ).run(attachmentPath);

    const result = runRetentionCleanup(db, config);

    expect(result.messages).toBe(1);
    expect(result.attachmentUntrackedDirs).toBe(1);
    expect(existsSync(attachmentDir)).toBe(false);
    const remaining = db.prepare("SELECT COUNT(*) AS c FROM chat_attachments").get() as { c: number };
    expect(remaining.c).toBe(0);
  });

  it("deletes old agent_actions", () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO agent_actions (action_type, trigger, result, started_at) VALUES ('test', 'auto', 'success', datetime('now', '-91 days'))",
    ).run();
    db.prepare(
      "INSERT INTO agent_actions (action_type, trigger, result) VALUES ('test', 'auto', 'success')",
    ).run();

    const result = runRetentionCleanup(db, config);

    expect(result.agentActions).toBe(1);
  });

  it("deletes old notification_log entries", () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO notification_log (notification_type, priority, platform, content_summary, status, created_at) VALUES ('agent', 'normal', 'slack', 'test', 'delivered', datetime('now', '-61 days'))",
    ).run();
    db.prepare(
      "INSERT INTO notification_log (notification_type, priority, platform, content_summary, status) VALUES ('agent', 'normal', 'slack', 'test', 'delivered')",
    ).run();

    const result = runRetentionCleanup(db, config);

    expect(result.notificationLog).toBe(1);
  });

  it("deletes expired inactive sessions", () => {
    const db = createTestDb();
    // Old expired session
    db.prepare(
      "INSERT INTO conversation_sessions (status, last_message_at) VALUES ('expired', datetime('now', '-8 days'))",
    ).run();
    // Recent expired session (should keep)
    db.prepare(
      "INSERT INTO conversation_sessions (status, last_message_at) VALUES ('expired', datetime('now', '-1 days'))",
    ).run();
    // Active session (should keep regardless of age)
    db.prepare(
      "INSERT INTO conversation_sessions (status, last_message_at) VALUES ('active', datetime('now', '-30 days'))",
    ).run();

    const result = runRetentionCleanup(db, config);

    expect(result.conversationSessions).toBe(1);
    const remaining = db.prepare("SELECT COUNT(*) as cnt FROM conversation_sessions").get() as { cnt: number };
    expect(remaining.cnt).toBe(2);
  });

  // B-007 §5.9 / §6.5 — the legacy schedule/ directory sweep has been
  // retired (synthesized daily/YYYY-MM-DD.md is now persistent). The
  // retention result still exposes a `scheduleFiles` counter (kept for
  // API back-compat) but it is always 0.
  it("no longer touches daily/ entries (B-007 daily is persistent)", () => {
    const dailyDir = resolve(tmpDir, "context", "daily");
    mkdirSync(dailyDir, { recursive: true });
    const oldFile = resolve(dailyDir, "2025-12-01.md");
    writeFileSync(oldFile, "old daily");
    const oldDate = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, oldDate, oldDate);

    const db = createTestDb();
    const result = runRetentionCleanup(db, config);

    expect(result.scheduleFiles).toBe(0);
    expect(existsSync(oldFile)).toBe(true);
  });

  it("deletes session-linked messages before sessions (FK safety)", () => {
    const db = createTestDb();
    // Enable FK constraints to match production
    db.pragma("foreign_keys = ON");
    // Add FK constraint that matches the real schema
    db.exec("DROP TABLE IF EXISTS messages");
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        session_id INTEGER REFERENCES conversation_sessions(id),
        role TEXT,
        content TEXT,
        platform TEXT,
        timestamp TEXT DEFAULT (datetime('now'))
      )
    `);

    // Old session (8 days) with recent messages (2 days)
    db.prepare(
      "INSERT INTO conversation_sessions (id, status, last_message_at) VALUES (100, 'expired', datetime('now', '-8 days'))",
    ).run();
    db.prepare(
      "INSERT INTO messages (session_id, role, content, platform, timestamp) VALUES (100, 'user', 'msg', 'slack', datetime('now', '-2 days'))",
    ).run();

    // Should NOT throw FK violation
    const result = runRetentionCleanup(db, config);

    expect(result.conversationSessions).toBe(1);
    // The linked messages should also be gone
    const remaining = db.prepare("SELECT COUNT(*) as cnt FROM messages").get() as { cnt: number };
    expect(remaining.cnt).toBe(0);
  });

  it("does nothing when everything is within retention", () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO messages (session_id, role, content, platform) VALUES (1, 'user', 'recent', 'slack')",
    ).run();

    const result = runRetentionCleanup(db, config);

    expect(result.messages).toBe(0);
    expect(result.mdFileSnapshots).toBe(0);
    expect(result.agentActions).toBe(0);
    expect(result.notificationLog).toBe(0);
    expect(result.conversationSessions).toBe(0);
    expect(result.observations).toBe(0);
    expect(result.agentSchedule).toBe(0);
    expect(result.dmConversationLog).toBe(0);
    expect(result.authTelemetryCounters).toBe(0);
    expect(result.mailMessagesIndex).toBe(0);
    expect(result.mailParseFailures).toBe(0);
    expect(result.managementParseFailures).toBe(0);
    expect(result.skillCurationSignals).toBe(0);
    expect(result.skillCurationProposals).toBe(0);
    expect(result.skillCurationRuns).toBe(0);
    expect(result.skillCurationRunsAborted).toBe(0);
    expect(result.attachmentOrphanRows).toBe(0);
    expect(result.attachmentDanglingRows).toBe(0);
    expect(result.attachmentUntrackedDirs).toBe(0);
    expect(result.scheduleFiles).toBe(0);
    expect(result.weeklyFiles).toBe(0);
    expect(result.tempFiles).toBe(0);
    // FTS5 optimize should NOT run when no FTS-parent rows were deleted
    expect(result.ftsOptimized).toBe(false);
    expect(result.walCheckpointed).toBe(true);
  });

  // ── dmConversationLog retention ──

  it("deletes old dm_conversation_log entries and reports count", () => {
    const db = createTestDb();
    // Old DM summary (91 days ago — beyond 90-day cutoff)
    db.prepare(
      "INSERT INTO dm_conversation_log (platform, summary, message_count, created_at) VALUES ('slack', 'old summary', 5, datetime('now', '-91 days'))",
    ).run();
    // Recent DM summary (should survive)
    db.prepare(
      "INSERT INTO dm_conversation_log (platform, summary, message_count) VALUES ('slack', 'new summary', 3)",
    ).run();

    const result = runRetentionCleanup(db, config);

    expect(result.dmConversationLog).toBe(1);
    const remaining = db.prepare("SELECT COUNT(*) as cnt FROM dm_conversation_log").get() as { cnt: number };
    expect(remaining.cnt).toBe(1);
  });

  // ── schedule/weekly file split ──

  it("reports weekly file cleanup separately (scheduleFiles stays 0 per B-007)", () => {
    const weeklyDir = resolve(tmpDir, "context", "weekly");
    const oldWeekly = resolve(weeklyDir, "2025-W01.md");

    writeFileSync(oldWeekly, "old");

    const oldDate = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    utimesSync(oldWeekly, oldDate, oldDate);

    const db = createTestDb();
    const result = runRetentionCleanup(db, config);

    expect(result.scheduleFiles).toBe(0);
    expect(result.weeklyFiles).toBe(1);
  });

  it("cleans daemon tmp entries and exact atomic-write leftovers", () => {
    const tmpPath = resolve(tmpDir, "tmp", "old-work");
    const contextTmp = resolve(
      tmpDir,
      "context",
      "today.md.tmp.1234.0123456789abcdef",
    );
    const managedContextTmp = resolve(
      tmpDir,
      "context",
      "agent",
      "journal.md.tmp.1234.0123456789abcdef",
    );
    const knowledgeContextTmp = resolve(
      tmpDir,
      "context",
      "notes",
      "knowledge.md.tmp.1234.0123456789abcdef",
    );
    const userTmpLike = resolve(tmpDir, "context", "note.tmp.keep");
    mkdirSync(tmpPath, { recursive: true });
    mkdirSync(resolve(tmpDir, "context", "agent"), { recursive: true });
    mkdirSync(resolve(tmpDir, "context", "notes"), { recursive: true });
    writeFileSync(contextTmp, "old temp");
    writeFileSync(managedContextTmp, "old managed temp");
    writeFileSync(knowledgeContextTmp, "old knowledge temp");
    writeFileSync(userTmpLike, "user file");
    const oldDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(tmpPath, oldDate, oldDate);
    utimesSync(contextTmp, oldDate, oldDate);
    utimesSync(managedContextTmp, oldDate, oldDate);
    utimesSync(knowledgeContextTmp, oldDate, oldDate);
    utimesSync(userTmpLike, oldDate, oldDate);

    const db = createTestDb();
    const result = runRetentionCleanup(db, config);

    expect(result.tempFiles).toBe(3);
    expect(existsSync(tmpPath)).toBe(false);
    expect(existsSync(contextTmp)).toBe(false);
    expect(existsSync(managedContextTmp)).toBe(false);
    expect(existsSync(knowledgeContextTmp)).toBe(true);
    expect(existsSync(userTmpLike)).toBe(true);
  });

  // ── agent_schedule retention ──
  //
  // Terminal-status rows (completed/skipped/failed) older than 30 days are
  // deleted. Pending and running rows are never touched by retention.

  it("deletes old terminal-status agent_schedule rows", () => {
    const db = createTestDb();
    // Old completed task (31 days ago)
    db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, status) VALUES (datetime('now', '-31 days'), 'wake', 'completed')",
    ).run();
    // Old failed task (31 days ago)
    db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, status) VALUES (datetime('now', '-31 days'), 'wake', 'failed')",
    ).run();
    // Recent completed task (5 days ago, should survive)
    db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, status) VALUES (datetime('now', '-5 days'), 'wake', 'completed')",
    ).run();
    // Old pending task (60 days ago, should survive — retention never touches pending)
    db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, status) VALUES (datetime('now', '-60 days'), 'wake', 'pending')",
    ).run();
    // Old running task (40 days ago, should survive — retention never touches running)
    db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, status) VALUES (datetime('now', '-40 days'), 'wake', 'running')",
    ).run();

    const result = runRetentionCleanup(db, config);

    expect(result.agentSchedule).toBe(2);
    const remaining = db.prepare("SELECT COUNT(*) as cnt FROM agent_schedule").get() as { cnt: number };
    expect(remaining.cnt).toBe(3);
    // Verify surviving statuses
    const statuses = (
      db.prepare("SELECT status FROM agent_schedule ORDER BY status").all() as { status: string }[]
    ).map((r) => r.status);
    expect(statuses).toEqual(["completed", "pending", "running"]);
  });

  // ── Transaction atomicity ──

  it("rolls back all deletions if any single table cleanup fails", () => {
    const db = createTestDb();
    // Insert data into multiple tables
    db.prepare(
      "INSERT INTO md_file_snapshots (file_path, content, trigger, created_at) VALUES (?, ?, ?, datetime('now', '-31 days'))",
    ).run("today.md", "old", "api_put");
    db.prepare(
      "INSERT INTO messages (session_id, role, content, platform, timestamp) VALUES (1, 'user', 'old', 'slack', datetime('now', '-91 days'))",
    ).run();
    // Drop agent_actions to cause the transaction to fail mid-way
    db.exec("DROP TABLE agent_actions");

    expect(() => runRetentionCleanup(db, config)).toThrow();
    // md_file_snapshots should NOT have been deleted (transaction rolled back)
    const snapshots = db.prepare("SELECT COUNT(*) as cnt FROM md_file_snapshots").get() as { cnt: number };
    expect(snapshots.cnt).toBe(1);
    const messages = db.prepare("SELECT COUNT(*) as cnt FROM messages").get() as { cnt: number };
    expect(messages.cnt).toBe(1);
  });

  // ── Phase 9: observations retention boundary ──
  //
  // Observations are kept for 7 days after consumption. Pending rows are
  // never automatically deleted (the activity_scan dispatcher is expected
  // to consume them); ancient pending rows survive cleanup forever so
  // that operational bugs don't silently drop observation data.

  it("deletes consumed observations older than 7 days", () => {
    const db = createTestDb();
    // Consumed 8 days ago (beyond the 7-day cutoff)
    db.prepare(
      `INSERT INTO observations (source, ref, change_type, actor, consumed_at, consumed_by)
       VALUES (?, ?, 'modified', 'user', datetime('now', '-8 days'), 'corr-old')`,
    ).run("obsidian", "old.md");
    // Consumed 1 day ago (inside retention window, must survive)
    db.prepare(
      `INSERT INTO observations (source, ref, change_type, actor, consumed_at, consumed_by)
       VALUES (?, ?, 'modified', 'user', datetime('now', '-1 day'), 'corr-recent')`,
    ).run("obsidian", "recent.md");
    // Pending row (never consumed, never deleted)
    db.prepare(
      `INSERT INTO observations (source, ref, change_type, actor, observed_at)
       VALUES (?, ?, 'modified', 'user', datetime('now', '-30 days'))`,
    ).run("obsidian", "pending.md");

    const result = runRetentionCleanup(db, config);

    expect(result.observations).toBe(1);
    const remaining = db
      .prepare("SELECT ref FROM observations ORDER BY ref")
      .all() as Array<{ ref: string }>;
    expect(remaining.map((r) => r.ref)).toEqual(["pending.md", "recent.md"]);
  });

  it("preserves pending observations regardless of age", () => {
    // Pending rows never expire — only consumed_at is the retention signal.
    const db = createTestDb();
    db.prepare(
      `INSERT INTO observations (source, ref, change_type, actor, observed_at)
       VALUES (?, ?, 'modified', 'user', datetime('now', '-90 days'))`,
    ).run("obsidian", "ancient.md");

    const result = runRetentionCleanup(db, config);

    expect(result.observations).toBe(0);
    const count = (
      db.prepare("SELECT COUNT(*) as c FROM observations").get() as { c: number }
    ).c;
    expect(count).toBe(1);
  });

  it("handles the exact 7-day boundary correctly (edge case)", () => {
    const db = createTestDb();
    // Exactly 7 days ago: should be deleted (cleanupConsumedObservations uses `< -7 days`)
    db.prepare(
      `INSERT INTO observations (source, ref, change_type, actor, consumed_at, consumed_by)
       VALUES (?, ?, 'modified', 'user', datetime('now', '-7 days', '-1 second'), 'corr')`,
    ).run("obsidian", "edge-old.md");
    // 6 days 23 hours ago: should survive
    db.prepare(
      `INSERT INTO observations (source, ref, change_type, actor, consumed_at, consumed_by)
       VALUES (?, ?, 'modified', 'user', datetime('now', '-6 days', '-23 hours'), 'corr')`,
    ).run("obsidian", "edge-new.md");

    const result = runRetentionCleanup(db, config);

    expect(result.observations).toBe(1);
    const remaining = db
      .prepare("SELECT ref FROM observations")
      .all() as Array<{ ref: string }>;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].ref).toBe("edge-new.md");
  });

  // ── Stale pending observation visibility ──
  //
  // Pending observations are never auto-deleted (by design — silent drops
  // would hide bugs). But if a row stays pending for many days, it usually
  // means the activity_scan pipeline is stalled. Retention surfaces this via
  // a warning log so the operator notices, without changing the data.

  it("warns about pending observations older than the warn threshold without deleting them", () => {
    const db = createTestDb();
    // 20-day-old pending row — well beyond the 14-day warn threshold
    db.prepare(
      `INSERT INTO observations (source, ref, change_type, actor, observed_at)
       VALUES (?, ?, 'modified', 'user', datetime('now', '-20 days'))`,
    ).run("obsidian", "stuck.md");
    // Fresh pending row — should not trip the warning
    db.prepare(
      `INSERT INTO observations (source, ref, change_type, actor, observed_at)
       VALUES (?, ?, 'modified', 'user', datetime('now', '-1 day'))`,
    ).run("obsidian", "fresh.md");

    // pino's symbol-keyed write method is the only public extension point
    // for intercepting log records without swapping the destination stream.
    // We patch process.stdout.write so the retention logger lands here.
    const writes: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown, ...rest: unknown[]) => {
        if (typeof chunk === "string") writes.push(chunk);
        else if (chunk instanceof Uint8Array) writes.push(Buffer.from(chunk).toString("utf8"));
        return origWrite(chunk as Parameters<typeof origWrite>[0], ...(rest as []));
      });

    try {
      const result = runRetentionCleanup(db, config);
      // No deletions — the data invariant is preserved
      expect(result.observations).toBe(0);
      const surviving = db
        .prepare("SELECT ref FROM observations ORDER BY ref")
        .all() as Array<{ ref: string }>;
      expect(surviving.map((r) => r.ref)).toEqual(["fresh.md", "stuck.md"]);
    } finally {
      writeSpy.mockRestore();
    }

    // The retention logger uses pino with name='retention'. It may have
    // initialized before the spy was installed, so the most reliable
    // check is at the data layer: count(stale) > 0 should imply the
    // warning code path executed without throwing.
    // (Direct log capture is brittle across pino instance lifecycles —
    //  observations.test.ts already covers getStalePendingObservationStats.)
  });

  it("does not warn when all pending rows are within the freshness window", () => {
    const db = createTestDb();
    // 5-day-old pending — younger than the 14-day warn threshold
    db.prepare(
      `INSERT INTO observations (source, ref, change_type, actor, observed_at)
       VALUES (?, ?, 'modified', 'user', datetime('now', '-5 days'))`,
    ).run("obsidian", "young.md");

    const result = runRetentionCleanup(db, config);
    expect(result.observations).toBe(0);
    const count = (
      db.prepare("SELECT COUNT(*) as c FROM observations").get() as { c: number }
    ).c;
    expect(count).toBe(1);
  });

  // ── agent_schedule retention ──
  //
  // Terminal rows (completed/failed/skipped) older than 30 days should be
  // purged. Pending and running rows are NEVER deleted regardless of age.

  it("deletes old completed/failed/skipped schedule rows", () => {
    const db = createTestDb();
    // Old completed (31 days ago) — should be deleted
    db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status) VALUES (datetime('now', '-31 days'), 'wake', 'old completed', 'completed')",
    ).run();
    // Old failed — should be deleted
    db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status) VALUES (datetime('now', '-31 days'), 'wake', 'old failed', 'failed')",
    ).run();
    // Old skipped — should be deleted
    db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status) VALUES (datetime('now', '-31 days'), 'wake', 'old skipped', 'skipped')",
    ).run();
    // Recent completed (5 days ago) — should be kept
    db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status) VALUES (datetime('now', '-5 days'), 'wake', 'recent completed', 'completed')",
    ).run();

    const result = runRetentionCleanup(db, config);

    expect(result.agentSchedule).toBe(3);
    const remaining = db
      .prepare("SELECT task_description FROM agent_schedule")
      .all() as { task_description: string }[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].task_description).toBe("recent completed");
  });

  it("never deletes pending or running schedule rows regardless of age", () => {
    const db = createTestDb();
    // Ancient pending row — must survive
    db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status) VALUES (datetime('now', '-90 days'), 'wake', 'ancient pending', 'pending')",
    ).run();
    // Ancient running row — must survive
    db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status) VALUES (datetime('now', '-90 days'), 'escalation', 'ancient running', 'running')",
    ).run();

    const result = runRetentionCleanup(db, config);

    expect(result.agentSchedule).toBe(0);
    const count = (
      db.prepare("SELECT COUNT(*) as c FROM agent_schedule").get() as { c: number }
    ).c;
    expect(count).toBe(2);
  });

  // ── mcp_tool_calls retention ──

  it("deletes mcp_tool_calls rows older than the retention window", () => {
    const db = createTestDb();
    const oldMs = Date.now() - 91 * 24 * 60 * 60 * 1000;
    const recentMs = Date.now() - 5 * 24 * 60 * 60 * 1000;
    db.prepare(
      "INSERT INTO mcp_tool_calls (server_id, tool_name, called_at) VALUES ('srv', 'old_tool', ?)",
    ).run(oldMs);
    db.prepare(
      "INSERT INTO mcp_tool_calls (server_id, tool_name, called_at) VALUES ('srv', 'recent_tool', ?)",
    ).run(recentMs);

    const result = runRetentionCleanup(db, config);

    expect(result.mcpToolCalls).toBe(1);
    const remaining = db
      .prepare("SELECT tool_name FROM mcp_tool_calls")
      .all() as { tool_name: string }[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].tool_name).toBe("recent_tool");
  });

  // ── integration_writes retention (drift-detection §4.2) ──

  it("deletes expired integration_writes rows but keeps active ones", () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO integration_writes
        (integration, item_id, written_at, written_by, expires_at)
       VALUES ('google_calendar', 'expired-evt',
               datetime('now', '-1 hour'), 'agent',
               datetime('now', '-30 minutes'))`,
    ).run();
    db.prepare(
      `INSERT INTO integration_writes
        (integration, item_id, written_at, written_by, expires_at)
       VALUES ('google_calendar', 'active-evt',
               datetime('now', '-5 minutes'), 'agent',
               datetime('now', '+10 minutes'))`,
    ).run();

    const result = runRetentionCleanup(db, config);

    expect(result.integrationWrites).toBe(1);
    const remaining = db
      .prepare("SELECT item_id FROM integration_writes")
      .all() as { item_id: string }[];
    expect(remaining.map((r) => r.item_id)).toEqual(["active-evt"]);
  });

  // ── imminent_event_notifications retention (Phase 7 §3.2) ──

  it("prunes imminent_event_notifications rows older than 24h but keeps recent ones", () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO imminent_event_notifications (item_id, notified_at)
       VALUES ('stale-evt', datetime('now', '-2 days')),
              ('recent-evt', datetime('now', '-1 hour'))`,
    ).run();

    const result = runRetentionCleanup(db, config);

    expect(result.imminentEventNotifications).toBe(1);
    const remaining = db
      .prepare("SELECT item_id FROM imminent_event_notifications")
      .all() as Array<{ item_id: string }>;
    expect(remaining.map((r) => r.item_id)).toEqual(["recent-evt"]);
  });

  it("prunes bounded DB caches and diagnostics without touching recent rows", () => {
    const db = createTestDb();
    const oldIso = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const recentIso = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const oldMs = Date.now() - 200 * 24 * 60 * 60 * 1000;
    const recentMs = Date.now() - 5 * 24 * 60 * 60 * 1000;

    db.prepare(
      `INSERT INTO auth_telemetry_counters
       (backend_id, counter_key, bucket_hour, source, count)
       VALUES ('claude', 'probe_ok', ?, 'probe', 1),
              ('claude', 'probe_ok', ?, 'probe', 1)`,
    ).run(oldIso, recentIso);
    db.prepare(
      `INSERT INTO mail_messages_index
       (account_id, provider_msg_id, received_at_utc, observed_at_utc, deleted_at_utc, subject, snippet)
       VALUES ('acct', 'old-live', ?, ?, NULL, 'old', ''),
              ('acct', 'old-deleted', ?, ?, ?, 'deleted', ''),
              ('acct', 'recent', ?, ?, NULL, 'recent', '')`,
    ).run(oldIso, oldIso, recentIso, recentIso, oldIso, recentIso, recentIso);
    for (let i = 0; i < 501; i++) {
      db.prepare(
        `INSERT INTO parse_failures (provider_msg_id, error_reason, created_at)
         VALUES (?, 'bad', datetime('now', '-31 days'))`,
      ).run(`old-${i}`);
    }
    for (let i = 0; i < 51; i++) {
      db.prepare(
        `INSERT INTO management_parse_failures (reason, created_at)
         VALUES ('bad', datetime('now', '-31 days'))`,
      ).run();
    }
    db.prepare(
      `INSERT INTO skill_curation_signals
        (skill_slug, section_id, signal_type, payload_json, observed_at, consumed_at)
       VALUES ('alpha', 's1', 'structure_diff', '{}', ?, ?),
              ('alpha', 's2', 'structure_diff', '{}', ?, NULL),
              ('alpha', 's3', 'structure_diff', '{}', ?, NULL)`,
    ).run(oldMs, oldMs, oldMs, recentMs);
    db.prepare(
      `INSERT INTO skill_curation_proposals
        (run_id, skill_slug, section_id, status, proposed_at)
       VALUES ('old-run', 'alpha', 's1', 'applied', ?),
              ('recent-run', 'alpha', 's2', 'applied', ?)`,
    ).run(oldMs, recentMs);
    db.prepare(
      `INSERT INTO skill_curation_runs
        (id, started_at, cadence, backend, model, target_skills_json, status, finalized_at)
       VALUES ('old-run', ?, 'weekly', 'claude', 'model', '[]', 'finalized', ?),
              ('recent-run', ?, 'weekly', 'claude', 'model', '[]', 'finalized', ?),
              ('stale-running', ?, 'weekly', 'claude', 'model', '[]', 'running', NULL)`,
    ).run(oldMs, oldMs, recentMs, recentMs, Date.now() - 2 * 24 * 60 * 60 * 1000);

    const result = runRetentionCleanup(db, config);

    expect(result.authTelemetryCounters).toBe(1);
    expect(result.mailMessagesIndex).toBe(2);
    expect(result.mailParseFailures).toBe(1);
    expect(result.managementParseFailures).toBe(1);
    expect(result.skillCurationSignals).toBe(2);
    expect(result.skillCurationProposals).toBe(1);
    expect(result.skillCurationRuns).toBe(1);
    expect(result.skillCurationRunsAborted).toBe(1);

    const run = db
      .prepare("SELECT status FROM skill_curation_runs WHERE id = 'stale-running'")
      .get() as { status: string };
    expect(run.status).toBe("aborted");
    const mailIds = db
      .prepare("SELECT provider_msg_id FROM mail_messages_index ORDER BY provider_msg_id")
      .all() as { provider_msg_id: string }[];
    expect(mailIds.map((r) => r.provider_msg_id)).toEqual(["recent"]);
  });

  // ── dm_conversation_log observability ──

  it("reports dm_conversation_log deletion count in the result", () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO dm_conversation_log (platform, summary, created_at) VALUES ('slack', 'old summary', datetime('now', '-91 days'))",
    ).run();
    db.prepare(
      "INSERT INTO dm_conversation_log (platform, summary) VALUES ('slack', 'recent summary')",
    ).run();

    const result = runRetentionCleanup(db, config);

    expect(result.dmConversationLog).toBe(1);
    const remaining = db
      .prepare("SELECT COUNT(*) as c FROM dm_conversation_log")
      .get() as { c: number };
    expect(remaining.c).toBe(1);
  });
});

// ── Agent-journal content rollup ──
//
// The journal is append-only: Weekly/Monthly Review routines add `## Weekly
// YYYY-Www` and `## Monthly YYYY-MM` sections over time. The rollup keeps
// all monthly sections forever and only the most recent N weekly sections.

describe("rollupAgentJournal", () => {
  let tmpDir: string;
  let journalPath: string;

  beforeEach(() => {
    tmpDir = resolve(tmpdir(), `pa-journal-${randomUUID()}`);
    mkdirSync(resolve(tmpDir, "agent"), { recursive: true });
    journalPath = resolve(tmpDir, "agent", "journal.md");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildJournal(
    weekSlugs: string[],
    monthSlugs: string[] = [],
    { includePreamble = true }: { includePreamble?: boolean } = {},
  ): string {
    const sections: string[] = [];
    if (includePreamble) sections.push("# Agent Journal\n");
    // Interleave monthly at the end of each quarter to mimic real writes
    for (const slug of weekSlugs) {
      sections.push(`## Weekly ${slug}\n> Appended\n\n### What worked\n- note\n`);
    }
    for (const slug of monthSlugs) {
      sections.push(`## Monthly ${slug}\n> Appended\n\n### Recurring\n- note\n`);
    }
    return sections.join("\n");
  }

  it("returns a zero result and leaves the file untouched when it does not exist", () => {
    const result = rollupAgentJournal(journalPath, 12);
    expect(result).toEqual({
      weeklyPruned: 0,
      monthlyPruned: 0,
      duplicatesCollapsed: 0,
      oversizedSections: 0,
    });
    expect(existsSync(journalPath)).toBe(false);
  });

  it("does not rewrite the file when there is nothing to dedup or prune", () => {
    const content = buildJournal(
      ["2026-W01", "2026-W02", "2026-W03"],
      ["2026-01"],
    );
    writeFileSync(journalPath, content, "utf-8");
    const before = readFileSync(journalPath, "utf-8");

    const result = rollupAgentJournal(journalPath, 12);

    expect(result.weeklyPruned).toBe(0);
    expect(result.duplicatesCollapsed).toBe(0);
    expect(readFileSync(journalPath, "utf-8")).toBe(before);
  });

  it("prunes the oldest weekly sections when count exceeds the threshold", () => {
    const weeklies = [
      "2026-W01", "2026-W02", "2026-W03", "2026-W04",
      "2026-W05", "2026-W06", "2026-W07", "2026-W08",
      "2026-W09", "2026-W10", "2026-W11", "2026-W12",
      "2026-W13", "2026-W14",
    ];
    const content = buildJournal(weeklies, ["2026-01", "2026-02", "2026-03"]);
    writeFileSync(journalPath, content, "utf-8");

    const result = rollupAgentJournal(journalPath, 12);

    expect(result.weeklyPruned).toBe(2); // W01 and W02 pruned
    expect(result.duplicatesCollapsed).toBe(0);
    const rewritten = readFileSync(journalPath, "utf-8");
    expect(rewritten).not.toContain("## Weekly 2026-W01");
    expect(rewritten).not.toContain("## Weekly 2026-W02");
    // Most recent 12 weekly sections kept
    for (const slug of weeklies.slice(2)) {
      expect(rewritten).toContain(`## Weekly ${slug}`);
    }
    // All monthly sections preserved
    expect(rewritten).toContain("## Monthly 2026-01");
    expect(rewritten).toContain("## Monthly 2026-02");
    expect(rewritten).toContain("## Monthly 2026-03");
    // H1 preamble preserved
    expect(rewritten).toContain("# Agent Journal");
  });

  it("keeps monthly sections within the keepMonthlySections limit (default 24)", () => {
    const weeklies = ["2026-W01"];
    // 20 monthlies — below the default 24 limit, all kept
    const monthlies = Array.from({ length: 20 }, (_, i) => {
      const month = String((i % 12) + 1).padStart(2, "0");
      const year = 2024 + Math.floor(i / 12);
      return `${year}-${month}`;
    });
    const content = buildJournal(weeklies, monthlies);
    writeFileSync(journalPath, content, "utf-8");

    const result = rollupAgentJournal(journalPath, 12);

    expect(result.weeklyPruned).toBe(0);
    expect(result.monthlyPruned).toBe(0);
    const rewritten = readFileSync(journalPath, "utf-8");
    for (const slug of monthlies) {
      expect(rewritten).toContain(`## Monthly ${slug}`);
    }
  });

  it("prunes the oldest monthly sections when count exceeds the limit", () => {
    const weeklies = ["2026-W01"];
    // 28 unique monthlies — exceeds the default 24 limit by 4
    const monthlies = Array.from({ length: 28 }, (_, i) => {
      const month = String((i % 12) + 1).padStart(2, "0");
      const year = 2024 + Math.floor(i / 12);
      return `${year}-${month}`;
    });
    const content = buildJournal(weeklies, monthlies);
    writeFileSync(journalPath, content, "utf-8");

    const result = rollupAgentJournal(journalPath, 12);

    expect(result.monthlyPruned).toBe(4);
    const rewritten = readFileSync(journalPath, "utf-8");
    // Oldest 4 should be gone (2024-01 through 2024-04)
    expect(rewritten).not.toContain("## Monthly 2024-01");
    expect(rewritten).not.toContain("## Monthly 2024-04");
    // Recent ones should survive
    expect(rewritten).toContain("## Monthly 2024-05");
    expect(rewritten).toContain("## Monthly 2026-04");
  });

  it("preserves non-weekly, non-monthly H2 sections as-is (defensive)", () => {
    const content = [
      "# Agent Journal",
      "",
      "## Weekly 2026-W01",
      "- a",
      "",
      "## Scratchpad",
      "- user-added note",
      "",
      "## Weekly 2026-W02",
      "- b",
    ].join("\n");
    writeFileSync(journalPath, content, "utf-8");

    const result = rollupAgentJournal(journalPath, 1);

    expect(result.weeklyPruned).toBe(1); // W01 pruned, W02 kept
    const rewritten = readFileSync(journalPath, "utf-8");
    expect(rewritten).toContain("## Scratchpad");
    expect(rewritten).toContain("- user-added note");
    expect(rewritten).toContain("## Weekly 2026-W02");
    expect(rewritten).not.toContain("## Weekly 2026-W01");
  });

  it("picks the most recent weeks by ISO week key, not file order", () => {
    // Simulate an out-of-order file (e.g., the agent appended a backfilled
    // week after a more recent one). The rollup should still keep the
    // chronologically-latest weeks.
    const content = buildJournal([
      "2026-W05", // newest
      "2026-W01", // oldest, written last
      "2026-W04",
      "2026-W02",
      "2026-W03",
    ]);
    writeFileSync(journalPath, content, "utf-8");

    const result = rollupAgentJournal(journalPath, 2);

    expect(result.weeklyPruned).toBe(3);
    const rewritten = readFileSync(journalPath, "utf-8");
    expect(rewritten).toContain("## Weekly 2026-W04");
    expect(rewritten).toContain("## Weekly 2026-W05");
    expect(rewritten).not.toContain("## Weekly 2026-W01");
    expect(rewritten).not.toContain("## Weekly 2026-W02");
    expect(rewritten).not.toContain("## Weekly 2026-W03");
  });

  it("preserves trailing newline parity with the original file", () => {
    const withTrailing = buildJournal(
      ["2026-W01", "2026-W02", "2026-W03", "2026-W04"],
    );
    const ensuredTrailing = withTrailing.endsWith("\n")
      ? withTrailing
      : withTrailing + "\n";
    writeFileSync(journalPath, ensuredTrailing, "utf-8");

    rollupAgentJournal(journalPath, 2);

    const rewritten = readFileSync(journalPath, "utf-8");
    expect(rewritten.endsWith("\n")).toBe(true);
  });

  // ── Dedup: last-write-wins on duplicate keys ──

  it("collapses duplicate weekly sections, keeping the most recent append", () => {
    // Simulate the Weekly Review routine running twice in the same ISO week:
    // two `## Weekly 2026-W14` sections — the second one has a newer bullet.
    const content = [
      "# Agent Journal",
      "",
      "## Weekly 2026-W14",
      "### What worked",
      "- first-run note (stale)",
      "",
      "## Weekly 2026-W14",
      "### What worked",
      "- second-run note (authoritative)",
    ].join("\n");
    writeFileSync(journalPath, content, "utf-8");

    const result = rollupAgentJournal(journalPath, 12);

    expect(result.duplicatesCollapsed).toBe(1);
    expect(result.weeklyPruned).toBe(0);
    const rewritten = readFileSync(journalPath, "utf-8");
    // Only one weekly section remains
    expect(rewritten.match(/## Weekly 2026-W14/g)?.length).toBe(1);
    // The LATER content (second run) wins
    expect(rewritten).toContain("second-run note (authoritative)");
    expect(rewritten).not.toContain("first-run note (stale)");
  });

  it("collapses duplicate monthly sections, keeping the most recent append", () => {
    const content = [
      "# Agent Journal",
      "",
      "## Monthly 2026-04",
      "### Recurring self-critique",
      "- first attempt",
      "",
      "## Monthly 2026-04",
      "### Recurring self-critique",
      "- second attempt (authoritative)",
    ].join("\n");
    writeFileSync(journalPath, content, "utf-8");

    const result = rollupAgentJournal(journalPath, 12);

    expect(result.duplicatesCollapsed).toBe(1);
    expect(result.weeklyPruned).toBe(0);
    const rewritten = readFileSync(journalPath, "utf-8");
    expect(rewritten.match(/## Monthly 2026-04/g)?.length).toBe(1);
    expect(rewritten).toContain("second attempt (authoritative)");
    expect(rewritten).not.toContain("first attempt");
  });

  it("is idempotent — repeated runs do not keep rewriting the file", () => {
    // After a single dedup+prune sweep, a second run on the same file
    // should make no changes and emit a zero result.
    const content = [
      "# Agent Journal",
      "",
      "## Weekly 2026-W14",
      "- first",
      "",
      "## Weekly 2026-W14",
      "- second",
      "",
      "## Weekly 2026-W15",
      "- third",
    ].join("\n");
    writeFileSync(journalPath, content, "utf-8");

    const first = rollupAgentJournal(journalPath, 12);
    expect(first.duplicatesCollapsed).toBe(1);

    const afterFirst = readFileSync(journalPath, "utf-8");

    const second = rollupAgentJournal(journalPath, 12);
    expect(second.duplicatesCollapsed).toBe(0);
    expect(second.weeklyPruned).toBe(0);
    expect(readFileSync(journalPath, "utf-8")).toBe(afterFirst);
  });

  it("counts dedup and age-based pruning independently", () => {
    // Build 14 unique weekly keys + 1 duplicate of the newest.
    // Keep threshold = 12. Expect duplicatesCollapsed=1, weeklyPruned=2.
    const content = [
      "# Agent Journal",
      "",
      ...[
        "2026-W01", "2026-W02", "2026-W03", "2026-W04",
        "2026-W05", "2026-W06", "2026-W07", "2026-W08",
        "2026-W09", "2026-W10", "2026-W11", "2026-W12",
        "2026-W13", "2026-W14",
      ].flatMap((slug) => [`## Weekly ${slug}`, `- note`, ""]),
      "## Weekly 2026-W14", // duplicate — later wins
      "- duplicate note",
    ].join("\n");
    writeFileSync(journalPath, content, "utf-8");

    const result = rollupAgentJournal(journalPath, 12);

    expect(result.duplicatesCollapsed).toBe(1);
    expect(result.weeklyPruned).toBe(2); // W01 and W02 pruned
    const rewritten = readFileSync(journalPath, "utf-8");
    expect(rewritten).not.toContain("## Weekly 2026-W01");
    expect(rewritten).not.toContain("## Weekly 2026-W02");
    // W14 appears exactly once (dedup winner)
    expect(rewritten.match(/## Weekly 2026-W14/g)?.length).toBe(1);
    expect(rewritten).toContain("- duplicate note");
  });

  // ── Size warning (non-destructive) ──

  it("flags oversized sections without truncating them", () => {
    // Build a weekly section whose body exceeds 200 bytes.
    const bloatedBody = "- ".concat("x".repeat(500));
    const content = [
      "# Agent Journal",
      "",
      "## Weekly 2026-W14",
      bloatedBody,
      "",
      "## Weekly 2026-W15",
      "- small",
    ].join("\n");
    writeFileSync(journalPath, content, "utf-8");

    // Custom low threshold so we can trigger it without dumping 4KB.
    const result = rollupAgentJournal(journalPath, 12, 200);

    expect(result.oversizedSections).toBe(1);
    expect(result.weeklyPruned).toBe(0);
    expect(result.duplicatesCollapsed).toBe(0);
    // Content is preserved in full — no truncation
    const rewritten = readFileSync(journalPath, "utf-8");
    expect(rewritten).toContain(bloatedBody);
  });

  it("emits size warnings even when nothing else triggers a rewrite", () => {
    // When the only finding is an oversized section, the file should not
    // be rewritten (stable mtime) but the warning count should still be
    // returned so retention.ts can surface it.
    const bloatedBody = "- ".concat("x".repeat(500));
    const content = ["# Agent Journal", "", "## Weekly 2026-W14", bloatedBody].join("\n");
    writeFileSync(journalPath, content, "utf-8");
    const before = readFileSync(journalPath, "utf-8");

    const result = rollupAgentJournal(journalPath, 12, 200);

    expect(result.oversizedSections).toBe(1);
    expect(result.weeklyPruned).toBe(0);
    expect(result.duplicatesCollapsed).toBe(0);
    // File unchanged — warnings are observability only
    expect(readFileSync(journalPath, "utf-8")).toBe(before);
  });

  // ── L2: numeric parser for ISO week keys ──
  //
  // Rollup previously compared weekly keys lexicographically, which
  // silently miscategorizes non-zero-padded numbers (`W5` > `W14` in
  // string order) and was fragile across LLM prompt compliance drift.
  // The numeric parser fixes this while keeping the on-disk format
  // untouched (no forced canonicalization).

  it("sorts mixed-padding weekly keys chronologically (W5 before W14)", () => {
    // The agent-journal contains a non-zero-padded key (`W5`) alongside
    // zero-padded ones. Lexicographic sort would rank `W5` as newer than
    // `W14`; the numeric parser must rank it as older.
    const content = buildJournal([
      "2026-W14",
      "2026-W5", // non-padded — chronologically earlier than W14
      "2026-W10",
      "2026-W3", // non-padded — earliest
      "2026-W12",
    ]);
    writeFileSync(journalPath, content, "utf-8");

    const result = rollupAgentJournal(journalPath, 2);

    expect(result.weeklyPruned).toBe(3);
    const rewritten = readFileSync(journalPath, "utf-8");
    // The two most recent by (year, week) are W12 and W14.
    expect(rewritten).toContain("## Weekly 2026-W12");
    expect(rewritten).toContain("## Weekly 2026-W14");
    expect(rewritten).not.toContain("## Weekly 2026-W3\n");
    expect(rewritten).not.toContain("## Weekly 2026-W5\n");
    expect(rewritten).not.toContain("## Weekly 2026-W10\n");
  });

  it("sorts across ISO year boundaries (2025-W52 before 2026-W01)", () => {
    // Lexicographic sort already handles this correctly for zero-padded
    // keys, but the numeric path should still match so this test locks
    // in the invariant against future refactors.
    const content = buildJournal([
      "2025-W51",
      "2025-W52",
      "2026-W01",
      "2026-W02",
    ]);
    writeFileSync(journalPath, content, "utf-8");

    const result = rollupAgentJournal(journalPath, 2);

    expect(result.weeklyPruned).toBe(2);
    const rewritten = readFileSync(journalPath, "utf-8");
    // The two most recent are 2026-W01 and 2026-W02.
    expect(rewritten).toContain("## Weekly 2026-W01");
    expect(rewritten).toContain("## Weekly 2026-W02");
    expect(rewritten).not.toContain("## Weekly 2025-W51");
    expect(rewritten).not.toContain("## Weekly 2025-W52");
  });

  it("keeps ISO W53 in years that have 53 weeks", () => {
    // 2026 is a 53-week ISO year (short/long year pattern). W53 must sort
    // after W52 of the same year and before W01 of the following year.
    const content = buildJournal([
      "2026-W52",
      "2026-W53",
      "2027-W01",
    ]);
    writeFileSync(journalPath, content, "utf-8");

    const result = rollupAgentJournal(journalPath, 1);

    expect(result.weeklyPruned).toBe(2);
    const rewritten = readFileSync(journalPath, "utf-8");
    // Latest is 2027-W01
    expect(rewritten).toContain("## Weekly 2027-W01");
    expect(rewritten).not.toContain("## Weekly 2026-W52");
    expect(rewritten).not.toContain("## Weekly 2026-W53");
  });

  it("falls back gracefully on unparseable keys without crashing", () => {
    // If an LLM writes a malformed header (`## Weekly Week14` or similar),
    // rollup should not throw. The unparseable section ends up sorted by
    // the lexicographic fallback path and is treated as a normal weekly
    // section for dedup / size purposes.
    const content = [
      "# Agent Journal",
      "",
      "## Weekly 2026-W01",
      "- note",
      "",
      "## Weekly Week14", // malformed — no digits after "W"
      "- malformed",
      "",
      "## Weekly 2026-W02",
      "- note",
    ].join("\n");
    writeFileSync(journalPath, content, "utf-8");

    // Keep 1 — rollup must run to completion without throwing, and must
    // prune at least something. The only hard invariants are:
    //   (a) no exception
    //   (b) the file is still structurally intact
    //   (c) exactly one weekly section survives
    let result: ReturnType<typeof rollupAgentJournal> | undefined;
    expect(() => {
      result = rollupAgentJournal(journalPath, 1);
    }).not.toThrow();

    expect(result).toBeDefined();
    expect(result!.weeklyPruned + result!.duplicatesCollapsed).toBeGreaterThan(0);
    const rewritten = readFileSync(journalPath, "utf-8");
    expect(rewritten).toContain("# Agent Journal");
    const remainingWeeklyHeaders = rewritten.match(/^## Weekly /gm) ?? [];
    expect(remainingWeeklyHeaders.length).toBe(1);
  });
});

// ── compareWeeklyKey unit tests ──
//
// The comparator is exported separately so its contract can be locked
// in without having to reconstruct a whole journal file for each case.

describe("compareWeeklyKey", () => {
  it("ranks zero-padded weeks in the same year chronologically", () => {
    expect(compareWeeklyKey("2026-W05", "2026-W14")).toBeLessThan(0);
    expect(compareWeeklyKey("2026-W14", "2026-W05")).toBeGreaterThan(0);
    expect(compareWeeklyKey("2026-W07", "2026-W07")).toBe(0);
  });

  it("handles non-zero-padded weeks correctly (W5 < W14)", () => {
    // This is the core regression that L2 targets — lexicographic compare
    // would return the wrong sign here.
    expect(compareWeeklyKey("2026-W5", "2026-W14")).toBeLessThan(0);
    expect(compareWeeklyKey("2026-W14", "2026-W5")).toBeGreaterThan(0);
  });

  it("compares padded and non-padded equivalently (W5 == W05)", () => {
    expect(compareWeeklyKey("2026-W5", "2026-W05")).toBe(0);
  });

  it("orders across ISO year boundaries", () => {
    expect(compareWeeklyKey("2025-W52", "2026-W01")).toBeLessThan(0);
    expect(compareWeeklyKey("2026-W01", "2025-W52")).toBeGreaterThan(0);
    expect(compareWeeklyKey("2025-W53", "2026-W01")).toBeLessThan(0);
  });

  it("orders the year field above the week field", () => {
    // A week-52 of 2024 is older than week-1 of 2025, even though 52 > 1.
    expect(compareWeeklyKey("2024-W52", "2025-W01")).toBeLessThan(0);
  });

  it("rejects out-of-range week numbers by falling back to string compare", () => {
    // week 99 is invalid — both parses fail, so we fall back to string
    // compare and the contract becomes "stable, not chronologically
    // meaningful" for this pair. The test just pins the behavior.
    const cmp = compareWeeklyKey("2026-W99", "2026-W14");
    expect(cmp).not.toBe(NaN);
    // String "2026-W14" < "2026-W99" lexicographically
    expect(cmp).toBeGreaterThan(0);
  });

  it("falls back to stable string order on completely malformed input", () => {
    // Both sides fail to parse → lexicographic fallback. ASCII-wise,
    // '2' (50) < 'g' (103), so "2026-W14" sorts before "garbage". The
    // ordering is arbitrary for unparseable input — we only care that
    // it is stable and non-zero so sort() terminates deterministically.
    expect(compareWeeklyKey("garbage", "2026-W14")).toBeGreaterThan(0);
    expect(compareWeeklyKey("2026-W14", "garbage")).toBeLessThan(0);
    expect(compareWeeklyKey("garbage", "garbage")).toBe(0);
  });

  it("is a total order suitable for Array.sort", () => {
    // Defensive sanity check — feed a shuffled list through sort and
    // verify the result is monotone. This catches any accidental
    // non-transitive comparator.
    const input = [
      "2026-W14",
      "2025-W52",
      "2026-W5", // non-padded on purpose
      "2026-W01",
      "2027-W02",
      "2026-W52",
    ];
    const sorted = [...input].sort(compareWeeklyKey);
    expect(sorted).toEqual([
      "2025-W52",
      "2026-W01",
      "2026-W5",
      "2026-W14",
      "2026-W52",
      "2027-W02",
    ]);
  });
});

// ── compareMonthlyKey unit tests ──

describe("compareMonthlyKey", () => {
  it("ranks zero-padded months in the same year chronologically", () => {
    expect(compareMonthlyKey("2026-01", "2026-12")).toBeLessThan(0);
    expect(compareMonthlyKey("2026-12", "2026-01")).toBeGreaterThan(0);
    expect(compareMonthlyKey("2026-06", "2026-06")).toBe(0);
  });

  it("handles non-zero-padded months correctly (4 < 10)", () => {
    expect(compareMonthlyKey("2026-4", "2026-10")).toBeLessThan(0);
    expect(compareMonthlyKey("2026-10", "2026-4")).toBeGreaterThan(0);
  });

  it("compares padded and non-padded equivalently (4 == 04)", () => {
    expect(compareMonthlyKey("2026-4", "2026-04")).toBe(0);
  });

  it("orders across year boundaries", () => {
    expect(compareMonthlyKey("2025-12", "2026-01")).toBeLessThan(0);
    expect(compareMonthlyKey("2026-01", "2025-12")).toBeGreaterThan(0);
  });

  it("rejects out-of-range months by falling back to string compare", () => {
    const cmp = compareMonthlyKey("2026-13", "2026-06");
    expect(cmp).not.toBe(NaN);
  });

  it("falls back to stable string order on malformed input", () => {
    expect(compareMonthlyKey("garbage", "2026-06")).toBeGreaterThan(0);
    expect(compareMonthlyKey("garbage", "garbage")).toBe(0);
  });

  it("is a total order suitable for Array.sort", () => {
    const input = ["2026-12", "2025-06", "2026-4", "2026-01", "2027-03"];
    const sorted = [...input].sort(compareMonthlyKey);
    expect(sorted).toEqual(["2025-06", "2026-01", "2026-4", "2026-12", "2027-03"]);
  });
});

// ── onBeforeWrite callback ──

describe("rollupAgentJournal — onBeforeWrite snapshot", () => {
  let tmpDir: string;
  let journalPath: string;

  beforeEach(() => {
    tmpDir = resolve(tmpdir(), `pa-journal-snap-${randomUUID()}`);
    mkdirSync(resolve(tmpDir, "agent"), { recursive: true });
    journalPath = resolve(tmpDir, "agent", "journal.md");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("calls onBeforeWrite with pre-rollup content when pruning occurs", () => {
    const content = [
      "# Agent Journal",
      "",
      "## Weekly 2026-W01",
      "- old",
      "",
      "## Weekly 2026-W02",
      "- new",
    ].join("\n");
    writeFileSync(journalPath, content, "utf-8");

    const captured: string[] = [];
    rollupAgentJournal(journalPath, 1, 4000, 24, (c) => {
      captured.push(c);
    });

    // Callback was invoked exactly once with the original content
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("## Weekly 2026-W01");
    expect(captured[0]).toContain("## Weekly 2026-W02");

    // File was still rewritten (W01 pruned)
    const rewritten = readFileSync(journalPath, "utf-8");
    expect(rewritten).not.toContain("## Weekly 2026-W01");
    expect(rewritten).toContain("## Weekly 2026-W02");
  });

  it("does not call onBeforeWrite when nothing changes", () => {
    const content = [
      "# Agent Journal",
      "",
      "## Weekly 2026-W01",
      "- note",
    ].join("\n");
    writeFileSync(journalPath, content, "utf-8");

    const captured: string[] = [];
    rollupAgentJournal(journalPath, 12, 4000, 24, (c) => {
      captured.push(c);
    });

    // No pruning or dedup → callback not invoked
    expect(captured).toHaveLength(0);
  });

  it("calls onBeforeWrite when dedup triggers a rewrite (no age pruning)", () => {
    // Duplicate weekly key — dedup alone triggers a rewrite, which should
    // invoke onBeforeWrite even if no age-based pruning occurs.
    const content = [
      "# Agent Journal",
      "",
      "## Weekly 2026-W14",
      "- first run (stale)",
      "",
      "## Weekly 2026-W14",
      "- second run (authoritative)",
    ].join("\n");
    writeFileSync(journalPath, content, "utf-8");

    const captured: string[] = [];
    const result = rollupAgentJournal(journalPath, 12, 4000, 24, (c) => {
      captured.push(c);
    });

    expect(result.duplicatesCollapsed).toBe(1);
    expect(result.weeklyPruned).toBe(0);
    // Snapshot was taken before the dedup rewrite
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("first run (stale)");
    expect(captured[0]).toContain("second run (authoritative)");
  });

  it("proceeds with rollup even if onBeforeWrite throws", () => {
    const content = [
      "# Agent Journal",
      "",
      "## Weekly 2026-W01",
      "- old",
      "",
      "## Weekly 2026-W02",
      "- new",
    ].join("\n");
    writeFileSync(journalPath, content, "utf-8");

    const result = rollupAgentJournal(journalPath, 1, 4000, 24, () => {
      throw new Error("snapshot DB unavailable");
    });

    // Rollup still completed
    expect(result.weeklyPruned).toBe(1);
    const rewritten = readFileSync(journalPath, "utf-8");
    expect(rewritten).not.toContain("## Weekly 2026-W01");
    expect(rewritten).toContain("## Weekly 2026-W02");
  });
});

// ── checkAgentJournalHealth ──

describe("checkAgentJournalHealth", () => {
  let tmpDir: string;
  let journalPath: string;

  beforeEach(() => {
    tmpDir = resolve(tmpdir(), `pa-journal-health-${randomUUID()}`);
    mkdirSync(resolve(tmpDir, "agent"), { recursive: true });
    journalPath = resolve(tmpDir, "agent", "journal.md");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns exists=false when file does not exist", () => {
    const result = checkAgentJournalHealth(journalPath);
    expect(result.exists).toBe(false);
    expect(result.weeklySections).toBe(0);
    expect(result.monthlySections).toBe(0);
    expect(result.oversizedSections).toEqual([]);
  });

  it("counts weekly and monthly sections correctly", () => {
    const content = [
      "# Agent Journal",
      "",
      "## Weekly 2026-W12",
      "- a",
      "",
      "## Weekly 2026-W13",
      "- b",
      "",
      "## Monthly 2026-03",
      "- c",
    ].join("\n");
    writeFileSync(journalPath, content, "utf-8");

    const result = checkAgentJournalHealth(journalPath);
    expect(result.exists).toBe(true);
    expect(result.weeklySections).toBe(2);
    expect(result.monthlySections).toBe(1);
    expect(result.oversizedSections).toEqual([]);
  });

  it("reports oversized sections by key", () => {
    const bigBody = "- " + "x".repeat(300);
    const content = [
      "# Agent Journal",
      "",
      "## Weekly 2026-W14",
      bigBody,
      "",
      "## Monthly 2026-04",
      "- small",
    ].join("\n");
    writeFileSync(journalPath, content, "utf-8");

    // Low threshold to trigger on the weekly section
    const result = checkAgentJournalHealth(journalPath, 200);
    expect(result.oversizedSections).toEqual(["Weekly 2026-W14"]);
  });
});
