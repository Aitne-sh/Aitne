import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import { getLogBuffer, pushToLogBuffer, resetLogBuffer } from "../log-buffer.js";
import { getSessionWorkdirPath } from "./workdir.js";
import {
  DASHBOARD_CHAT_SCOPE,
  DASHBOARD_SCOPE_KEY,
} from "../messaging/constants.js";
import {
  appendResetAuditLine,
  clearAllSecrets,
  dropFactoryResetUserTables,
  findNonEmptyFactoryResetTables,
  factoryReset,
  getFactoryResetSearchIndexes,
  getFactoryResetUserTables,
  purgeHistory,
  resetRuntimeConfig,
  wipeContextFiles,
  wipeEncryptedBlobs,
  wipeFactoryResetAncillaryData,
  wipeStaleDataDirArtifacts,
} from "./system-reset.js";
import type { SecretBroker } from "../secrets/secret-broker.js";
import { SECRET_NAMES } from "../secrets/secret-names.js";

describe("system-reset", () => {
  let dataDir: string;
  let db: Database.Database;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-system-reset-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    resetLogBuffer();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function seedFullHistory() {
    // Active dashboard chat (id=1) must survive everything except factory reset.
    // Closed sessions (ids 2, 3) get wiped by purgeHistory.
    db.prepare(
      `INSERT INTO conversation_sessions
         (id, platform, channel_id, scope, scope_key, status, is_dm)
       VALUES
         (1, 'dashboard', 'dashboard-ch', ?, ?, 'active',  1),
         (2, 'dashboard', 'dashboard-ch', ?, ?, 'closed',  1),
         (3, 'telegram',  'tg',           'owner_dm', '', 'closed',  1)`,
    ).run(
      DASHBOARD_CHAT_SCOPE, DASHBOARD_SCOPE_KEY,
      DASHBOARD_CHAT_SCOPE, DASHBOARD_SCOPE_KEY,
    );
    db.prepare(
      `INSERT INTO messages (session_id, role, content, platform)
       VALUES
         (1, 'user', 'live', 'dashboard'),
         (2, 'user', 'past', 'dashboard'),
         (3, 'user', 'past-tg', 'telegram')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_actions (action_type, result) VALUES ('test', 'success'), ('test2', 'failed')`,
    ).run();
    db.prepare(
      `INSERT INTO observations (source, ref, change_type) VALUES ('git', 'a', 'modified')`,
    ).run();
    db.prepare(
      `INSERT INTO notification_log (dispatch_id, priority, platform) VALUES ('d1', 'normal', 'slack')`,
    ).run();
    db.prepare(
      `INSERT INTO md_file_snapshots (file_path, content, trigger) VALUES ('today', 'x', 't')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_schedule (scheduled_for, task_type, status) VALUES ('2030-01-01 00:00', 't', 'pending')`,
    ).run();
    db.prepare(
      `INSERT INTO dm_conversation_log (platform, scope, scope_key, summary) VALUES ('slack', 'platform_dm', '', 's')`,
    ).run();
    for (const id of [1, 2, 3]) {
      mkdirSync(getSessionWorkdirPath(dataDir, id), { recursive: true });
    }
  }

  describe("purgeHistory", () => {
    it("removes closed sessions, messages, and all audit tables but preserves active", () => {
      seedFullHistory();

      const result = purgeHistory({ db, dataDir });

      expect(result.deletedSessions).toBe(2);
      expect(result.deletedActions).toBe(2);
      expect(result.deletedObservations).toBe(1);
      expect(result.deletedNotifications).toBe(1);
      expect(result.deletedSnapshots).toBe(1);
      expect(result.deletedSchedule).toBe(1);
      expect(result.deletedDmLog).toBe(1);

      const sessions = db
        .prepare("SELECT id FROM conversation_sessions")
        .all() as Array<{ id: number }>;
      expect(sessions).toEqual([{ id: 1 }]);

      const messages = db
        .prepare("SELECT session_id FROM messages")
        .all() as Array<{ session_id: number }>;
      expect(messages).toEqual([{ session_id: 1 }]);

      // Workdir for active session preserved, closed ones cleaned up.
      expect(existsSync(getSessionWorkdirPath(dataDir, 1))).toBe(true);
      expect(existsSync(getSessionWorkdirPath(dataDir, 2))).toBe(false);
      expect(existsSync(getSessionWorkdirPath(dataDir, 3))).toBe(false);
    });

    it("is a no-op on a clean database", () => {
      const result = purgeHistory({ db, dataDir });
      expect(result).toEqual({
        deletedSessions: 0,
        deletedMessages: 0,
        deletedActions: 0,
        deletedObservations: 0,
        deletedNotifications: 0,
        deletedSnapshots: 0,
        deletedSchedule: 0,
        deletedDmLog: 0,
      });
    });

    it("keeps running schedule rows (dispatcher mid-flight)", () => {
      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, status)
           VALUES ('2030-01-01 00:00', 't', 'running'),
                  ('2030-01-01 00:00', 't', 'pending')`,
      ).run();

      const result = purgeHistory({ db, dataDir });

      expect(result.deletedSchedule).toBe(1);
      const remaining = db
        .prepare("SELECT status FROM agent_schedule")
        .all() as Array<{ status: string }>;
      expect(remaining).toEqual([{ status: "running" }]);
    });

    it("clears recurring schedule links before deleting non-running schedule rows", () => {
      const recurring = db.prepare(
        `INSERT INTO recurring_schedules
           (task_type, task_description, task_context, model, recurrence_rule, enabled, next_run_at)
         VALUES ('scheduled.task', 'daily', '{}', 'sonnet', '{"frequency":"daily"}', 1, '2030-01-01 00:00')`,
      ).run();
      const scheduled = db.prepare(
        `INSERT INTO agent_schedule
           (scheduled_for, task_type, task_description, task_context, status, recurring_schedule_id)
         VALUES ('2030-01-01 00:00', 'scheduled.task', 'pending', '{}', 'pending', ?)`,
      ).run(recurring.lastInsertRowid);
      db.prepare(
        `UPDATE recurring_schedules SET last_scheduled_id = ? WHERE id = ?`,
      ).run(scheduled.lastInsertRowid, recurring.lastInsertRowid);

      const result = purgeHistory({ db, dataDir });

      expect(result.deletedSchedule).toBe(1);
      const scheduleCount = db
        .prepare("SELECT COUNT(*) as n FROM agent_schedule")
        .get() as { n: number };
      expect(scheduleCount.n).toBe(0);
      const recurringRow = db
        .prepare("SELECT last_scheduled_id FROM recurring_schedules WHERE id = ?")
        .get(recurring.lastInsertRowid) as { last_scheduled_id: number | null };
      expect(recurringRow.last_scheduled_id).toBeNull();
    });

    it("includeActive=true wipes everything, including active sessions", () => {
      seedFullHistory();

      const result = purgeHistory({ db, dataDir, includeActive: true });

      expect(result.deletedSessions).toBe(3);
      const remaining = db
        .prepare("SELECT COUNT(*) as n FROM conversation_sessions")
        .get() as { n: number };
      expect(remaining.n).toBe(0);
      for (const id of [1, 2, 3]) {
        expect(existsSync(getSessionWorkdirPath(dataDir, id))).toBe(false);
      }
    });
  });

  describe("resetRuntimeConfig", () => {
    it("clears the settings table and invokes the defaults callback", () => {
      // applySchema seeds baseline rows (e.g. the `integrations` row).
      // Wipe before the test so the row count reflects only what the test
      // inserts.
      db.prepare("DELETE FROM settings").run();
      db.prepare(
        `INSERT INTO settings (key, value_json) VALUES ('timezone', '"UTC"'), ('dayBoundaryHour', '5')`,
      ).run();

      const applyDefaults = vi.fn();
      const result = resetRuntimeConfig({ db, applyDefaults });

      expect(result.cleared).toBe(2);
      expect(applyDefaults).toHaveBeenCalledOnce();
      const rows = db.prepare("SELECT * FROM settings").all();
      expect(rows).toEqual([]);
    });
  });

  describe("wipeContextFiles", () => {
    it("removes every entry in the context dir but keeps the dir itself", () => {
      const contextDir = join(dataDir, "context");
      mkdirSync(join(contextDir, "user"), { recursive: true });
      mkdirSync(join(contextDir, "rules"), { recursive: true });
      mkdirSync(join(contextDir, "projects"), { recursive: true });
      writeFileSync(join(contextDir, "today.md"), "today");
      writeFileSync(join(contextDir, "rules", "management.md"), "rules");
      writeFileSync(join(contextDir, "user", "work.md"), "work");

      const result = wipeContextFiles({ dataDir });

      expect(result.removed).toBeGreaterThanOrEqual(3);
      expect(existsSync(contextDir)).toBe(true);
      expect(existsSync(join(contextDir, "today.md"))).toBe(false);
      expect(existsSync(join(contextDir, "rules", "management.md"))).toBe(false);
      expect(existsSync(join(contextDir, "user"))).toBe(false);
    });

    it("is a no-op when the context dir does not exist", () => {
      const result = wipeContextFiles({ dataDir });
      expect(result.removed).toBe(0);
      expect(result.errors).toEqual([]);
    });

    it("removes every provided context dir so Obsidian primary vaults are cleaned too", () => {
      const fallbackContextDir = join(dataDir, "context");
      const primaryContextDir = join(dataDir, "primary-vault");
      mkdirSync(join(fallbackContextDir, "rules"), { recursive: true });
      mkdirSync(join(primaryContextDir, "rules"), { recursive: true });
      writeFileSync(join(fallbackContextDir, "rules", "management.md"), "fallback");
      writeFileSync(join(primaryContextDir, "rules", "management.md"), "primary");

      const result = wipeContextFiles({
        dataDir,
        contextDirs: [primaryContextDir, fallbackContextDir, primaryContextDir],
      });

      expect(result.removed).toBe(2);
      expect(result.path).toBe(primaryContextDir);
      expect(result.paths).toEqual([
        { path: primaryContextDir, removed: 1 },
        { path: fallbackContextDir, removed: 1 },
      ]);
      expect(existsSync(join(primaryContextDir, "rules", "management.md"))).toBe(false);
      expect(existsSync(join(fallbackContextDir, "rules", "management.md"))).toBe(false);
    });

    it("records path errors and still wipes other provided context dirs", () => {
      const badContextPath = join(dataDir, "not-a-dir");
      const fallbackContextDir = join(dataDir, "context");
      writeFileSync(badContextPath, "not a directory");
      mkdirSync(join(fallbackContextDir, "rules"), { recursive: true });
      writeFileSync(join(fallbackContextDir, "rules", "management.md"), "fallback");

      const result = wipeContextFiles({
        dataDir,
        contextDirs: [badContextPath, fallbackContextDir],
      });

      expect(result.removed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.path).toBe(badContextPath);
      expect(result.paths[0]).toMatchObject({ path: badContextPath, removed: 0 });
      expect(result.paths[0]?.error).toBeTruthy();
      expect(result.paths[1]).toEqual({ path: fallbackContextDir, removed: 1 });
      expect(existsSync(join(fallbackContextDir, "rules", "management.md"))).toBe(false);
    });

    it("rejects unsafe context dirs before deleting anything", () => {
      const fallbackContextDir = join(dataDir, "context");
      mkdirSync(fallbackContextDir, { recursive: true });
      writeFileSync(join(fallbackContextDir, "today.md"), "today");

      expect(() => wipeContextFiles({
        dataDir,
        contextDirs: [dataDir, fallbackContextDir],
      })).toThrow(/unsafe context path/);
      expect(existsSync(join(fallbackContextDir, "today.md"))).toBe(true);
    });

    it("rejects unsafe context dirs reached through symlinks", () => {
      const fallbackContextDir = join(dataDir, "context");
      const symlinkContextDir = join(dataDir, "context-link");
      mkdirSync(fallbackContextDir, { recursive: true });
      writeFileSync(join(fallbackContextDir, "today.md"), "today");
      symlinkSync(dataDir, symlinkContextDir);

      expect(() => wipeContextFiles({
        dataDir,
        contextDirs: [symlinkContextDir],
      })).toThrow(/unsafe context path/);
      expect(existsSync(join(fallbackContextDir, "today.md"))).toBe(true);
    });
  });

  describe("wipeEncryptedBlobs", () => {
    it("removes every file under secrets/blobs", () => {
      const blobDir = join(dataDir, "secrets", "blobs");
      mkdirSync(blobDir, { recursive: true });
      writeFileSync(join(blobDir, "outlook.blob"), "x");
      writeFileSync(join(blobDir, "other.blob"), "y");

      const result = wipeEncryptedBlobs({ dataDir });

      expect(result.removed).toBe(2);
      expect(existsSync(blobDir)).toBe(true);
      expect(existsSync(join(blobDir, "outlook.blob"))).toBe(false);
    });

    it("is a no-op when blob dir does not exist", () => {
      expect(wipeEncryptedBlobs({ dataDir })).toEqual({ removed: 0 });
    });
  });

  describe("clearAllSecrets", () => {
    it("calls broker.delete for every user-facing secret name", async () => {
      const deleted: string[] = [];
      const broker = {
        delete: vi.fn(async (name: string) => {
          deleted.push(name);
        }),
      } as unknown as SecretBroker;

      const result = await clearAllSecrets({ secretBroker: broker });

      expect(result.deleted.length).toBe(SECRET_NAMES.length);
      expect(result.failed).toEqual([]);
      expect(new Set(deleted)).toEqual(new Set(SECRET_NAMES));
    });

    it("continues through errors and returns only the successful deletes", async () => {
      const broker = {
        delete: vi.fn(async (name: string) => {
          if (name === "slackBotToken") throw new Error("boom");
        }),
      } as unknown as SecretBroker;

      const result = await clearAllSecrets({ secretBroker: broker });

      expect(result.deleted).not.toContain("slackBotToken");
      expect(result.deleted.length).toBe(SECRET_NAMES.length - 1);
      expect(result.failed).toEqual([
        { name: "slackBotToken", message: "boom" },
      ]);
    });
  });

  describe("factoryReset", () => {
    it("wipes everything and closes active sessions first", async () => {
      seedFullHistory();
      // Same baseline-wipe rationale as resetRuntimeConfig: drop the rows
      // applySchema seeded so `settingsCleared` reflects test-inserted
      // rows only.
      db.prepare("DELETE FROM settings").run();
      db.prepare(`INSERT INTO settings (key, value_json) VALUES ('timezone', '"UTC"')`).run();
      db.prepare(
        `INSERT INTO owner_channels (platform, channel_id) VALUES ('slack', 'C1')`,
      ).run();
      const contextDir = join(dataDir, "context");
      mkdirSync(contextDir, { recursive: true });
      writeFileSync(join(contextDir, "today.md"), "t");
      const blobDir = join(dataDir, "secrets", "blobs");
      mkdirSync(blobDir, { recursive: true });
      writeFileSync(join(blobDir, "a.blob"), "x");
      for (const dir of [
        "attachments/a1",
        "agent-sessions/orphan",
        "optimizer-workdir/run-42",
        "migration-backups/b1",
        "backup",
        "backups/templates/2026-04-22T01-00-00-000Z",
        "backups/release-assets",
        "cache",
        "tmp",
        "mcp/server/probe-sandbox/p1",
        "whatsapp/auth",
        "skills/custom",
        "prompts",
        "templates",
        "task-flows",
        "runtime",
        "codex-home",
        "models/whisper",
        "logs",
        "logs-old-20260418",
      ]) {
        mkdirSync(join(dataDir, dir), { recursive: true });
        writeFileSync(join(dataDir, dir, "marker.txt"), "x");
      }
      writeFileSync(join(dataDir, "integrations.md"), "old integrations");
      writeFileSync(join(dataDir, "management.md"), "legacy integrations");
      writeFileSync(join(dataDir, "system-reset.log"), "old reset audit");
      writeFileSync(join(dataDir, "data.db"), "legacy root db");
      mkdirSync(join(dataDir, "data"), { recursive: true });
      writeFileSync(join(dataDir, "data", "agent.db"), "legacy agent db");
      writeFileSync(join(dataDir, "data", "personal-agent.db"), "legacy dash db");
      // Stale rebrand artifact and a DB backup snapshot — both contain (or
      // would contain on a real install) prior user state that must not
      // survive factory reset.
      writeFileSync(join(dataDir, "data", "aitne.db"), "legacy rebrand db");
      writeFileSync(
        join(dataDir, "data", "personal_agent.db.bak.20260426-234042"),
        "legacy backup snapshot",
      );

      const broker = {
        delete: vi.fn(async () => {}),
      } as unknown as SecretBroker;
      const applyDefaults = vi.fn();

      const result = await factoryReset({
        db,
        dataDir,
        secretBroker: broker,
        applyDefaults,
      });

      expect(result.purged.deletedSessions).toBe(3);
      expect(result.settingsCleared).toBe(1);
      expect(result.context.removed).toBeGreaterThanOrEqual(1);
      expect(result.blobsRemoved).toBe(1);
      expect(result.ancillary.removed).toBeGreaterThanOrEqual(10);
      expect(result.sequencesReset.reset).toBe(true);
      expect(result.databaseCompacted.vacuumed).toBe(true);
      expect(result.secretsDeleted.length).toBe(SECRET_NAMES.length);
      expect(result.tablesCleared).toContain("owner_channels");
      expect(result.searchIndexesCleared.map((entry) => entry.table)).toEqual(
        expect.arrayContaining(["fts_actions", "fts_messages", "fts_mail_messages"]),
      );
      expect(result.errors).toEqual([]);

      expect(applyDefaults).toHaveBeenCalledOnce();

      const remaining = db
        .prepare("SELECT COUNT(*) as n FROM conversation_sessions")
        .get() as { n: number };
      expect(remaining.n).toBe(0);

      const owners = db
        .prepare("SELECT COUNT(*) as n FROM owner_channels")
        .get() as { n: number };
      expect(owners.n).toBe(0);

      expect(existsSync(contextDir)).toBe(true);
      expect(existsSync(join(contextDir, "today.md"))).toBe(false);
      for (const dir of [
        "attachments",
        "agent-sessions",
        "optimizer-workdir",
        "migration-backups",
        "backup",
        "backups",
        "cache",
        "mcp",
        "whatsapp",
        "skills",
        "prompts",
        "templates",
        "task-flows",
        "runtime",
        "codex-home",
        "models",
        "logs",
        "logs-old-20260418",
      ]) {
        expect(existsSync(join(dataDir, dir))).toBe(false);
      }
      expect(existsSync(join(dataDir, "tmp"))).toBe(true);
      expect(existsSync(join(dataDir, "tmp", "marker.txt"))).toBe(false);
      expect(existsSync(join(dataDir, "integrations.md"))).toBe(false);
      expect(existsSync(join(dataDir, "management.md"))).toBe(false);
      expect(existsSync(join(dataDir, "system-reset.log"))).toBe(false);
      expect(existsSync(join(dataDir, "data.db"))).toBe(false);
      expect(existsSync(join(dataDir, "data", "agent.db"))).toBe(false);
      expect(existsSync(join(dataDir, "data", "personal-agent.db"))).toBe(false);
      expect(existsSync(join(dataDir, "data", "aitne.db"))).toBe(false);
      expect(
        existsSync(join(dataDir, "data", "personal_agent.db.bak.20260426-234042")),
      ).toBe(false);
      expect(result.staleDataArtifactsRemoved.length).toBeGreaterThanOrEqual(2);
    });

    it("resets AUTOINCREMENT sequences so IDs start fresh after reset", async () => {
      const before = db.prepare(
        `INSERT INTO conversation_sessions
           (platform, channel_id, scope, scope_key, status, is_dm)
         VALUES ('dashboard', 'before', ?, ?, 'closed', 1)`,
      ).run(DASHBOARD_CHAT_SCOPE, DASHBOARD_SCOPE_KEY);
      expect(Number(before.lastInsertRowid)).toBe(1);

      const result = await factoryReset({
        db,
        dataDir,
        secretBroker: { delete: vi.fn(async () => {}) } as unknown as SecretBroker,
        applyDefaults: vi.fn(),
      });

      const after = db.prepare(
        `INSERT INTO conversation_sessions
           (platform, channel_id, scope, scope_key, status, is_dm)
         VALUES ('dashboard', 'after', ?, ?, 'closed', 1)`,
      ).run(DASHBOARD_CHAT_SCOPE, DASHBOARD_SCOPE_KEY);
      expect(result.sequencesReset.reset).toBe(true);
      expect(Number(after.lastInsertRowid)).toBe(1);
    });

    it("wipes captured context dirs even after settings reset mutates runtime config", async () => {
      const fallbackContextDir = join(dataDir, "context");
      const primaryContextDir = join(dataDir, "primary-vault");
      mkdirSync(join(fallbackContextDir, "rules"), { recursive: true });
      mkdirSync(join(primaryContextDir, "rules"), { recursive: true });
      writeFileSync(join(fallbackContextDir, "rules", "management.md"), "fallback");
      writeFileSync(join(primaryContextDir, "rules", "management.md"), "primary");

      const broker = { delete: vi.fn(async () => {}) } as unknown as SecretBroker;
      const applyDefaults = vi.fn();

      const result = await factoryReset({
        db,
        dataDir,
        contextDirs: [primaryContextDir, fallbackContextDir],
        secretBroker: broker,
        applyDefaults,
      });

      expect(result.context.removed).toBe(2);
      expect(result.context.paths).toEqual([
        { path: primaryContextDir, removed: 1 },
        { path: fallbackContextDir, removed: 1 },
      ]);
      expect(applyDefaults).toHaveBeenCalledOnce();
      expect(existsSync(join(primaryContextDir, "rules", "management.md"))).toBe(false);
      expect(existsSync(join(fallbackContextDir, "rules", "management.md"))).toBe(false);
    });

    it("survives when an optional extra table does not exist", async () => {
      // Drop an extra table to simulate an install where the table was
      // never created — factoryReset discovers existing tables dynamically
      // and should still complete the rest of the work.
      db.exec(`DROP TABLE IF EXISTS mail_accounts`);
      db.exec(`DROP TABLE IF EXISTS mail_messages_index`);

      const broker = { delete: vi.fn(async () => {}) } as unknown as SecretBroker;
      const applyDefaults = vi.fn();

      const result = await factoryReset({
        db,
        dataDir,
        secretBroker: broker,
        applyDefaults,
      });

      expect(result.purged).toBeDefined();
      expect(result.errors).toEqual([]);
      // The remaining tables are still cleared.
      expect(result.tablesCleared).toContain("owner_channels");
    });

    it("deletes running schedule rows and recurring schedule FK cycles", async () => {
      const recurring = db.prepare(
        `INSERT INTO recurring_schedules
           (task_type, task_description, task_context, model, recurrence_rule, enabled, next_run_at)
         VALUES ('scheduled.task', 'daily', '{}', 'sonnet', '{"frequency":"daily"}', 1, '2030-01-01 00:00')`,
      ).run();
      const scheduled = db.prepare(
        `INSERT INTO agent_schedule
           (scheduled_for, task_type, task_description, task_context, model, status, recurring_schedule_id)
         VALUES ('2030-01-01 00:00', 'scheduled.task', 'running row', '{}', 'sonnet', 'running', ?)`,
      ).run(recurring.lastInsertRowid);
      db.prepare(
        `UPDATE recurring_schedules SET last_scheduled_id = ? WHERE id = ?`,
      ).run(scheduled.lastInsertRowid, recurring.lastInsertRowid);

      const result = await factoryReset({
        db,
        dataDir,
        secretBroker: { delete: vi.fn(async () => {}) } as unknown as SecretBroker,
        applyDefaults: vi.fn(),
      });

      expect(result.errors).toEqual([]);
      expect(result.purged.deletedSchedule).toBe(1);
      expect(result.remainingTables).toEqual([]);
      for (const table of ["agent_schedule", "recurring_schedules"]) {
        const row = db.prepare(`SELECT COUNT(*) as n FROM "${table}"`).get() as { n: number };
        expect(row.n, `${table} should be empty`).toBe(0);
      }
    });

    it("clears FTS search indexes, including orphaned external-content entries", async () => {
      const marker = "resetmarkeralpha";
      db.prepare(
        `INSERT INTO fts_messages(rowid, content) VALUES (9001, ?)`,
      ).run(marker);
      db.prepare(
        `INSERT INTO fts_actions(rowid, action_type, detail) VALUES (9002, 'test', ?)`,
      ).run(marker);
      db.prepare(
        `INSERT INTO fts_mail_messages(account_id, provider_msg_id, subject, snippet)
         VALUES ('mail', 'm1', ?, ?)`,
      ).run(marker, marker);

      for (const table of ["fts_messages", "fts_actions", "fts_mail_messages"]) {
        const row = db
          .prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${table}" MATCH ?`)
          .get(marker) as { n: number };
        expect(row.n, `${table} should have a searchable marker before reset`).toBeGreaterThan(0);
      }

      const result = await factoryReset({
        db,
        dataDir,
        secretBroker: { delete: vi.fn(async () => {}) } as unknown as SecretBroker,
        applyDefaults: vi.fn(),
      });

      expect(result.errors).toEqual([]);
      expect(result.searchIndexesCleared.map((entry) => entry.table)).toEqual(
        expect.arrayContaining(["fts_actions", "fts_messages", "fts_mail_messages"]),
      );
      expect(result.remainingSearchIndexes).toEqual([]);
      for (const table of ["fts_messages", "fts_actions", "fts_mail_messages"]) {
        const row = db
          .prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${table}" MATCH ?`)
          .get(marker) as { n: number };
        expect(row.n, `${table} should not retain searchable data after reset`).toBe(0);
      }
    });

    it("recovers from a missing/corrupt FTS5 index by rebuilding before purge", async () => {
      // Regression: a corrupt fts_messages index made the AFTER DELETE
      // trigger on `messages` raise "database disk image is malformed", which
      // aborted purge_history and clear_database_tables and left up to ~18
      // user tables populated. Simulate the broken state by dropping the FTS
      // table entirely — the trigger will then raise "no such table" instead
      // of "malformed", but it exercises the same recovery code path: drop
      // any remaining FTS infrastructure and the triggers that target the
      // missing tables, then run the wipes with no FTS writes happening.
      seedFullHistory();
      db.exec("DROP TABLE fts_messages");
      db.exec("DROP TABLE fts_actions");

      const result = await factoryReset({
        db,
        dataDir,
        secretBroker: { delete: vi.fn(async () => {}) } as unknown as SecretBroker,
        applyDefaults: vi.fn(),
      });

      expect(result.errors).toEqual([]);
      expect(result.purged.deletedSessions).toBe(3);
      expect(result.remainingTables).toEqual([]);

      const messages = db.prepare("SELECT COUNT(*) as n FROM messages").get() as { n: number };
      expect(messages.n).toBe(0);
      const actions = db.prepare("SELECT COUNT(*) as n FROM agent_actions").get() as { n: number };
      expect(actions.n).toBe(0);

      // FTS tables exist again (recreated by applySchema in the restore step)
      // and the AFTER DELETE triggers are wired against the new tables, so
      // subsequent inserts/deletes on the source tables won't trip.
      const ftsExists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fts_%'`)
        .all() as Array<{ name: string }>;
      const ftsNames = ftsExists.map((row) => row.name);
      expect(ftsNames).toEqual(
        expect.arrayContaining(["fts_actions", "fts_messages", "fts_mail_messages"]),
      );

      db.prepare(
        `INSERT INTO conversation_sessions
           (platform, channel_id, scope, scope_key, status, is_dm)
         VALUES ('dashboard', 'post-reset', ?, ?, 'active', 1)`,
      ).run(DASHBOARD_CHAT_SCOPE, DASHBOARD_SCOPE_KEY);
      const newSessionId = db
        .prepare("SELECT id FROM conversation_sessions WHERE channel_id = 'post-reset'")
        .get() as { id: number };
      expect(() =>
        db.prepare(
          `INSERT INTO messages (session_id, role, content, platform)
           VALUES (?, 'user', 'after reset', 'dashboard')`,
        ).run(newSessionId.id),
      ).not.toThrow();
    });

    it("clears the in-memory log buffer", async () => {
      pushToLogBuffer(30, "test", ["pre reset marker"]);
      expect(getLogBuffer().getRecent().some((entry) => entry.message === "pre reset marker")).toBe(
        true,
      );

      const result = await factoryReset({
        db,
        dataDir,
        secretBroker: { delete: vi.fn(async () => {}) } as unknown as SecretBroker,
        applyDefaults: vi.fn(),
      });

      expect(result.errors).toEqual([]);
      expect(getLogBuffer().getRecent()).toEqual([]);
    });
  });

  describe("wipeFactoryResetAncillaryData", () => {
    it("rejects paths outside dataDir", () => {
      expect(() =>
        wipeFactoryResetAncillaryData({
          dataDir,
          dirs: [join(dataDir, "..", "outside")],
        })
      ).toThrow(/outside dataDir/);
    });
  });

  describe("wipeStaleDataDirArtifacts", () => {
    it("removes legacy DB files and backup snapshots, keeps the active DB triple", () => {
      const dataSubdir = join(dataDir, "data");
      mkdirSync(dataSubdir, { recursive: true });
      // Active DB triple — must be preserved.
      writeFileSync(join(dataSubdir, "personal_agent.db"), "active");
      writeFileSync(join(dataSubdir, "personal_agent.db-shm"), "shm");
      writeFileSync(join(dataSubdir, "personal_agent.db-wal"), "wal");
      // Legacy/stale artifacts — must be removed.
      writeFileSync(join(dataSubdir, "aitne.db"), "rebrand legacy");
      writeFileSync(join(dataSubdir, "data.db"), "old layout");
      writeFileSync(join(dataSubdir, "agent.db"), "older layout");
      writeFileSync(join(dataSubdir, "personal-agent.db"), "another older layout");
      writeFileSync(
        join(dataSubdir, "personal_agent.db.bak.20260426-234042"),
        "DB backup snapshot containing prior user state",
      );
      writeFileSync(join(dataSubdir, "stray-note.txt"), "anything else");

      const result = wipeStaleDataDirArtifacts({ dataDir });

      expect(result.removed.length).toBe(6);
      expect(existsSync(join(dataSubdir, "personal_agent.db"))).toBe(true);
      expect(existsSync(join(dataSubdir, "personal_agent.db-shm"))).toBe(true);
      expect(existsSync(join(dataSubdir, "personal_agent.db-wal"))).toBe(true);
      expect(existsSync(join(dataSubdir, "aitne.db"))).toBe(false);
      expect(existsSync(join(dataSubdir, "data.db"))).toBe(false);
      expect(existsSync(join(dataSubdir, "agent.db"))).toBe(false);
      expect(existsSync(join(dataSubdir, "personal-agent.db"))).toBe(false);
      expect(
        existsSync(join(dataSubdir, "personal_agent.db.bak.20260426-234042")),
      ).toBe(false);
      expect(existsSync(join(dataSubdir, "stray-note.txt"))).toBe(false);
    });

    it("is a no-op when the data subdir does not exist", () => {
      const result = wipeStaleDataDirArtifacts({ dataDir });
      expect(result.removed).toEqual([]);
    });
  });

  it("factoryReset compacts deleted content out of an on-disk database", async () => {
    db.close();
    const dbPath = join(dataDir, "data", "personal_agent.db");
    mkdirSync(join(dataDir, "data"), { recursive: true });
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    applySchema(db);
    const marker = "SUPER_SECRET_FACTORY_RESET_MARKER_20260422";
    const ftsMarker = "FTS_FACTORY_RESET_MARKER_20260422";
    db.prepare(
      `INSERT INTO conversation_sessions
         (id, platform, channel_id, scope, scope_key, status, is_dm)
       VALUES (1, 'dashboard', 'dashboard', ?, ?, 'closed', 1)`,
    ).run(DASHBOARD_CHAT_SCOPE, DASHBOARD_SCOPE_KEY);
    db.prepare(
      `INSERT INTO messages (session_id, role, content, platform)
       VALUES (1, 'user', ?, 'dashboard')`,
    ).run(marker);
    db.prepare(
      `INSERT INTO fts_mail_messages(account_id, provider_msg_id, subject, snippet)
       VALUES ('mail', 'm1', ?, ?)`,
    ).run(ftsMarker, ftsMarker);
    expect(readFileSync(dbPath).includes(Buffer.from(marker))).toBe(true);
    expect(readFileSync(dbPath).includes(Buffer.from(ftsMarker))).toBe(true);

    await factoryReset({
      db,
      dataDir,
      secretBroker: { delete: vi.fn(async () => {}) } as unknown as SecretBroker,
      applyDefaults: vi.fn(),
    });
    db.close();
    db = new Database(":memory:");
    applySchema(db);

    expect(readFileSync(dbPath).includes(Buffer.from(marker))).toBe(false);
    expect(readFileSync(dbPath).includes(Buffer.from(ftsMarker))).toBe(false);
  });

  it("integration — after purgeHistory all audit tables are empty (messages for active session preserved)", () => {
    seedFullHistory();
    purgeHistory({ db, dataDir });

    // Audit tables are truncated unconditionally — no active-session carve-out.
    for (const table of [
      "agent_actions",
      "observations",
      "notification_log",
      "md_file_snapshots",
      "dm_conversation_log",
    ]) {
      const row = db.prepare(`SELECT COUNT(*) as n FROM "${table}"`).get() as { n: number };
      expect(row.n, `${table} should be empty`).toBe(0);
    }
    // Messages for the active session (id=1) are preserved.
    const messages = db
      .prepare("SELECT session_id FROM messages")
      .all() as Array<{ session_id: number }>;
    expect(messages).toEqual([{ session_id: 1 }]);
  });

  describe("appendResetAuditLine", () => {
    it("creates system-reset.log under dataDir and writes one JSON line per call", () => {
      appendResetAuditLine({
        dataDir,
        event: "test_event",
        payload: { a: 1 },
      });
      appendResetAuditLine({
        dataDir,
        event: "another",
        payload: { b: "x" },
      });

      const logPath = join(dataDir, "system-reset.log");
      expect(existsSync(logPath)).toBe(true);
      const lines = readFileSync(logPath, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0]);
      expect(first.event).toBe("test_event");
      expect(first.a).toBe(1);
      expect(typeof first.timestamp).toBe("string");
      const second = JSON.parse(lines[1]);
      expect(second.event).toBe("another");
      expect(second.b).toBe("x");
    });

    it("factoryReset removes the reset audit log instead of preserving it", async () => {
      const contextDir = join(dataDir, "context");
      mkdirSync(contextDir, { recursive: true });
      writeFileSync(join(contextDir, "today.md"), "t");
      appendResetAuditLine({
        dataDir,
        event: "before_factory_reset",
        payload: { marker: "must disappear" },
      });

      const broker = { delete: vi.fn(async () => {}) } as unknown as SecretBroker;
      await factoryReset({
        db,
        dataDir,
        secretBroker: broker,
        applyDefaults: vi.fn(),
      });

      const logPath = join(dataDir, "system-reset.log");
      expect(existsSync(logPath)).toBe(false);
    });
  });

  describe("factoryReset with FK-related seed", () => {
    it("clears backends + backend_global_defaults + process_backend_config despite FKs", async () => {
      // Seed a realistic FK graph: backends → backend_global_defaults + process_backend_config.
      // Without `defer_foreign_keys` the DELETE FROM backends would fail
      // because child rows still reference it. applySchema already seeds
      // default rows so we only need to verify the state before factoryReset.
      // Reset to a known seed shape first.
      db.prepare(`DELETE FROM process_backend_config`).run();
      db.prepare(`DELETE FROM backend_global_defaults`).run();
      db.prepare(`DELETE FROM backends`).run();

      db.prepare(
        `INSERT INTO backends (id, enabled) VALUES ('claude', 1)`,
      ).run();
      db.prepare(
        `INSERT INTO backend_global_defaults
           (singleton, default_backend, default_lite_model, default_medium_model, default_high_model)
         VALUES (1, 'claude', 'haiku', 'sonnet', 'opus')`,
      ).run();
      db.prepare(
        `INSERT INTO process_backend_config
           (process_key, main_backend, main_model, fallback_backend, fallback_model)
         VALUES ('message.dm', 'claude', 'opus', 'claude', 'sonnet')`,
      ).run();

      const broker = { delete: vi.fn(async () => {}) } as unknown as SecretBroker;
      const result = await factoryReset({
        db,
        dataDir,
        secretBroker: broker,
        applyDefaults: vi.fn(),
      });

      expect(result.errors).toEqual([]);
      expect(result.tablesCleared).toContain("backends");
      expect(result.tablesCleared).toContain("backend_global_defaults");
      expect(result.tablesCleared).toContain("process_backend_config");

      for (const table of ["backends", "backend_global_defaults", "process_backend_config"]) {
        const row = db.prepare(`SELECT COUNT(*) as n FROM "${table}"`).get() as { n: number };
        expect(row.n, `${table} should be empty`).toBe(0);
      }
    });

    it("collects per-step errors without aborting the whole reset", async () => {
      const broker = {
        delete: vi.fn(async () => {
          throw new Error("keychain offline");
        }),
      } as unknown as SecretBroker;
      const store = {
        delete: vi.fn(async () => {
          throw new Error("keychain offline");
        }),
        has: vi.fn(async () => false),
        get: vi.fn(async () => null),
        set: vi.fn(async () => {}),
      };

      const result = await factoryReset({
        db,
        dataDir,
        secretBroker: broker,
        secretStore: store,
        applyDefaults: vi.fn(),
      });

      // Keychain errors are best-effort, but must still be surfaced so a
      // factory reset cannot be mistaken for fully clean when credentials
      // remain in the platform store.
      expect(result.secretsDeleted).toEqual([]);
      expect(result.secretDeleteFailures.length).toBeGreaterThan(0);
      expect(result.errors.map((e) => e.step)).toContain("clear_secrets");
      // But DB/context work must still have happened.
      expect(Array.isArray(result.tablesCleared)).toBe(true);
    });
  });

  it("guard — every user-data table is empty after factoryReset", async () => {
    // If a new user-data table is added, the dynamic sweeper must include it
    // or this test will catch silent retention after factory reset.
    const tablesBefore = getFactoryResetUserTables(db);
    const searchIndexesBefore = getFactoryResetSearchIndexes(db).map((index) => index.name);

    const broker = { delete: vi.fn(async () => {}) } as unknown as SecretBroker;
    const result = await factoryReset({
      db,
      dataDir,
      secretBroker: broker,
      applyDefaults: vi.fn(),
    });

    expect(result.errors).toEqual([]);
    expect(result.tablesCleared).toEqual(expect.arrayContaining(tablesBefore));
    expect(result.searchIndexesCleared.map((entry) => entry.table)).toEqual(
      expect.arrayContaining(searchIndexesBefore),
    );
    expect(findNonEmptyFactoryResetTables(db)).toEqual([]);
  });

  describe("factoryReset schema-drift recovery", () => {
    it("recreates user tables so columns added to schema.ts after the original boot reappear", async () => {
      // Simulate a DB that was first booted before `write_strategy` /
      // `bridge_measurement_only` / etc. were added to wiki_workspaces.
      // CREATE TABLE IF NOT EXISTS in applySchema cannot heal this drift on
      // its own — the table already exists, so the new columns never appear.
      // Factory reset must DROP + recreate to clear the drift.
      db.exec("DROP TABLE IF EXISTS wiki_workspaces");
      db.exec(`
        CREATE TABLE wiki_workspaces (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL DEFAULT 'internal',
          root_path TEXT NOT NULL,
          language TEXT NOT NULL DEFAULT 'en',
          dispatch_mode TEXT NOT NULL DEFAULT 'parallel',
          concurrency_cap INTEGER NOT NULL DEFAULT 3,
          dm_agent_write_enabled INTEGER NOT NULL DEFAULT 0,
          bridge_enabled INTEGER NOT NULL DEFAULT 0,
          full_compile_approval_threshold_usd REAL NOT NULL DEFAULT 2.00,
          schema_version INTEGER NOT NULL DEFAULT 1,
          active INTEGER NOT NULL DEFAULT 1,
          last_ingest_at TEXT,
          last_compile_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);

      const columnsBefore = (
        db.pragma("table_info(wiki_workspaces)") as Array<{ name: string }>
      ).map((row) => row.name);
      expect(columnsBefore).not.toContain("write_strategy");
      expect(columnsBefore).not.toContain("bridge_measurement_only");
      expect(columnsBefore).not.toContain("git_pre_compile_enabled");

      const broker = { delete: vi.fn(async () => {}) } as unknown as SecretBroker;
      const result = await factoryReset({
        db,
        dataDir,
        secretBroker: broker,
        applyDefaults: vi.fn(),
      });

      expect(result.errors).toEqual([]);
      expect(result.userTablesDropped).toContain("wiki_workspaces");

      const columnsAfter = (
        db.pragma("table_info(wiki_workspaces)") as Array<{ name: string }>
      ).map((row) => row.name);
      expect(columnsAfter).toContain("write_strategy");
      expect(columnsAfter).toContain("bridge_measurement_only");
      expect(columnsAfter).toContain("bridge_min_confidence");
      expect(columnsAfter).toContain("git_pre_compile_enabled");

      // INSERT referencing the recovered column must now succeed — this is
      // the exact path that 500s in production when the drift persists.
      db.prepare(
        `INSERT INTO wiki_workspaces (
           name, kind, root_path, language, write_strategy
         ) VALUES ('default', 'external', '/tmp/v', 'en', 'auto')`,
      ).run();
    });

    it("dropFactoryResetUserTables clears every non-FTS user table", () => {
      const before = getFactoryResetUserTables(db);
      expect(before.length).toBeGreaterThan(0);

      const dropped = dropFactoryResetUserTables(db);
      expect(dropped).toEqual(expect.arrayContaining(before));

      const after = getFactoryResetUserTables(db);
      expect(after).toEqual([]);
    });

    it("dropFactoryResetUserTables is safe with an empty allowlist", () => {
      expect(dropFactoryResetUserTables(db, [])).toEqual([]);
      // The schema is still intact afterwards.
      expect(getFactoryResetUserTables(db).length).toBeGreaterThan(0);
    });
  });

  it("audit log survives wipeContextFiles (lives outside context dir)", () => {
    appendResetAuditLine({ dataDir, event: "before", payload: {} });
    const contextDir = join(dataDir, "context");
    mkdirSync(contextDir, { recursive: true });
    writeFileSync(join(contextDir, "x.md"), "x");

    wipeContextFiles({ dataDir });

    // dataDir itself should still contain the log file.
    const present = readdirSync(dataDir);
    expect(present).toContain("system-reset.log");
    expect(readFileSync(join(dataDir, "system-reset.log"), "utf8")).toContain("before");
  });

  it("smoke — readFileSync roundtrip works after wipeContextFiles recreates a file", () => {
    const contextDir = join(dataDir, "context");
    mkdirSync(contextDir, { recursive: true });
    writeFileSync(join(contextDir, "old.md"), "old");
    wipeContextFiles({ dataDir });
    writeFileSync(join(contextDir, "new.md"), "new");
    expect(readFileSync(join(contextDir, "new.md"), "utf8")).toBe("new");
  });
});
