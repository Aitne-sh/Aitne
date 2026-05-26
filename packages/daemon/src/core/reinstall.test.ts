import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  planReinstall,
  executeReinstall,
  enumerateContextFiles,
  countSnapshotRows,
  defaultBackupDir,
  defaultAncillaryDirs,
  backupTargetPath,
} from "./reinstall.js";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE md_file_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      content TEXT NOT NULL,
      trigger TEXT NOT NULL,
      session_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

describe("reinstall", () => {
  let tmp: string;
  let contextDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reinstall-test-"));
    contextDir = join(tmp, "context");
  });

  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  describe("enumerateContextFiles", () => {
    it("returns empty for missing dir", () => {
      const result = enumerateContextFiles(contextDir);
      expect(result).toEqual({ filesToDelete: [], totalBytes: 0 });
    });

    it("enumerates files recursively with byte totals", () => {
      mkdirSync(join(contextDir, "identity"), { recursive: true }); mkdirSync(join(contextDir, "state"), { recursive: true });
      writeFileSync(join(contextDir, "state", "today.md"), "hello");
      writeFileSync(join(contextDir, "identity", "profile.md"), "profile!");
      const result = enumerateContextFiles(contextDir);
      expect(result.filesToDelete).toHaveLength(2);
      expect(result.totalBytes).toBe(5 + 8);
    });

    it("handles empty directories gracefully", () => {
      mkdirSync(join(contextDir, "empty"), { recursive: true });
      const result = enumerateContextFiles(contextDir);
      expect(result.filesToDelete).toEqual([]);
      expect(result.totalBytes).toBe(0);
    });

    it("ignores symlinks (dirent.isFile() returns false)", () => {
      mkdirSync(contextDir, { recursive: true });
      writeFileSync(join(contextDir, "real.md"), "real");
      symlinkSync(
        join(contextDir, "missing-target"),
        join(contextDir, "broken.md"),
      );
      const result = enumerateContextFiles(contextDir);
      expect(result.filesToDelete).toEqual([join(contextDir, "real.md")]);
      expect(result.totalBytes).toBe(4);
    });
  });

  describe("countSnapshotRows", () => {
    it("returns 0 when table absent", () => {
      const db = new Database(":memory:");
      expect(countSnapshotRows(db)).toBe(0);
      db.close();
    });

    it("returns current row count", () => {
      const db = createDb();
      db.prepare(
        "INSERT INTO md_file_snapshots (file_path, content, trigger) VALUES (?, ?, ?)",
      ).run("today", "foo", "test");
      db.prepare(
        "INSERT INTO md_file_snapshots (file_path, content, trigger) VALUES (?, ?, ?)",
      ).run("user", "bar", "test");
      expect(countSnapshotRows(db)).toBe(2);
      db.close();
    });
  });

  describe("defaultBackupDir / backupTargetPath", () => {
    it("puts backup as a sibling of context/", () => {
      expect(defaultBackupDir("/home/u/.pa/context")).toBe(
        "/home/u/.pa/backup",
      );
    });

    it("formats backup filename with ISO timestamp", () => {
      const now = new Date("2026-04-17T14:30:15Z");
      const target = backupTargetPath("/tmp/bak", now);
      expect(target).toMatch(
        /^\/tmp\/bak\/context-pre-reinstall-2026-04-17T14-30-15-000Z\.tar\.gz$/,
      );
    });
  });

  describe("defaultAncillaryDirs", () => {
    it("returns prompts/ and agent-sessions/ as siblings of context/", () => {
      expect(defaultAncillaryDirs("/home/u/.pa/context")).toEqual([
        "/home/u/.pa/prompts",
        "/home/u/.pa/agent-sessions",
      ]);
    });
  });

  describe("planReinstall", () => {
    it("produces a plan even when context is missing", () => {
      const db = createDb();
      const plan = planReinstall({ contextDir, db });
      expect(plan.contextDir).toBe(contextDir);
      expect(plan.filesToDelete).toEqual([]);
      expect(plan.totalBytes).toBe(0);
      expect(plan.snapshotRowCount).toBe(0);
      expect(plan.backupPath).toContain("context-pre-reinstall-");
      // ancillary list defaults to siblings even when context is missing.
      expect(plan.ancillaryDirs.some((p) => p.endsWith("/prompts"))).toBe(true);
      expect(plan.ancillaryDirs.some((p) => p.endsWith("/agent-sessions"))).toBe(
        true,
      );
      db.close();
    });

    it("reports files and snapshot rows accurately", () => {
      mkdirSync(join(contextDir, "plans", "projects"), { recursive: true });
      mkdirSync(join(contextDir, "state"), { recursive: true });
      writeFileSync(join(contextDir, "state", "today.md"), "x");
      writeFileSync(join(contextDir, "plans", "projects", "p.md"), "yy");
      const db = createDb();
      db.prepare(
        "INSERT INTO md_file_snapshots (file_path, content, trigger) VALUES (?, ?, ?)",
      ).run("today", "x", "rot");
      const plan = planReinstall({
        contextDir,
        db,
        now: () => new Date("2026-04-17T12:00:00Z"),
      });
      expect(plan.filesToDelete).toHaveLength(2);
      expect(plan.totalBytes).toBe(3);
      expect(plan.snapshotRowCount).toBe(1);
      db.close();
    });

    it("respects custom backup dir", () => {
      const db = createDb();
      const plan = planReinstall({
        contextDir,
        db,
        backupDir: "/tmp/custom-backup",
        now: () => new Date("2026-04-17T12:00:00Z"),
      });
      expect(plan.backupPath.startsWith("/tmp/custom-backup/")).toBe(true);
      db.close();
    });
  });

  describe("executeReinstall", () => {
    it("wipes context/ and deletes snapshot rows, writes a backup", async () => {
      mkdirSync(join(contextDir, "identity"), { recursive: true }); mkdirSync(join(contextDir, "state"), { recursive: true });
      writeFileSync(join(contextDir, "state", "today.md"), "t");
      writeFileSync(join(contextDir, "identity", "profile.md"), "p");
      const db = createDb();
      db.prepare(
        "INSERT INTO md_file_snapshots (file_path, content, trigger) VALUES (?, ?, ?)",
      ).run("today", "t", "pre");

      const backupDir = join(tmp, "bak");
      const spawnCalls: Array<{ source: string; target: string }> = [];

      const result = await executeReinstall({
        contextDir,
        db,
        backupDir,
        now: () => new Date("2026-04-17T00:00:00Z"),
        spawnTar: ({ source, target }) => {
          spawnCalls.push({ source, target });
          writeFileSync(target, "fake-tar-content");
          return { status: 0 };
        },
      });

      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0].source).toBe(contextDir);
      expect(result.backupPath).not.toBeNull();
      expect(existsSync(result.backupPath!)).toBe(true);
      expect(result.filesDeleted).toBe(2);
      expect(result.bytesDeleted).toBe(2);
      expect(result.snapshotRowsDeleted).toBe(1);
      expect(result.ancillaryDirsRemoved).toEqual([]);
      expect(existsSync(contextDir)).toBe(false);
      expect(countSnapshotRows(db)).toBe(0);
      db.close();
    });

    it("wipes prompts/ and agent-sessions/ alongside context/ (spec §7.1)", async () => {
      mkdirSync(join(contextDir, "identity"), { recursive: true }); mkdirSync(join(contextDir, "state"), { recursive: true });
      writeFileSync(join(contextDir, "state", "today.md"), "t");
      const promptsDir = join(tmp, "prompts");
      const sessionsDir = join(tmp, "agent-sessions");
      mkdirSync(promptsDir, { recursive: true });
      writeFileSync(join(promptsDir, "rendered.md"), "cached");
      mkdirSync(join(sessionsDir, "session-1"), { recursive: true });
      writeFileSync(join(sessionsDir, "session-1", "CLAUDE.md"), "old");

      const db = createDb();
      const result = await executeReinstall({
        contextDir,
        db,
        backupDir: join(tmp, "bak"),
        now: () => new Date("2026-04-17T00:00:00Z"),
        spawnTar: ({ target }) => {
          writeFileSync(target, "fake-tar-content");
          return { status: 0 };
        },
      });

      expect(result.ancillaryDirsRemoved).toEqual(
        expect.arrayContaining([promptsDir, sessionsDir]),
      );
      expect(existsSync(promptsDir)).toBe(false);
      expect(existsSync(sessionsDir)).toBe(false);
      db.close();
    });

    it("honours custom ancillaryDirs + skips those that do not exist", async () => {
      mkdirSync(contextDir, { recursive: true });
      mkdirSync(join(contextDir, "state"), { recursive: true });
      writeFileSync(join(contextDir, "state", "today.md"), "t");
      const present = join(tmp, "scratch-cache");
      const absent = join(tmp, "never-existed");
      mkdirSync(present, { recursive: true });
      writeFileSync(join(present, "x"), "x");

      const db = createDb();
      const result = await executeReinstall({
        contextDir,
        db,
        backupDir: join(tmp, "bak"),
        ancillaryDirs: [present, absent],
        now: () => new Date("2026-04-17T00:00:00Z"),
        spawnTar: ({ target }) => {
          writeFileSync(target, "fake-tar-content");
          return { status: 0 };
        },
      });

      expect(result.ancillaryDirsRemoved).toEqual([present]);
      expect(existsSync(present)).toBe(false);
      db.close();
    });

    it("skips backup when context/ does not exist", async () => {
      const db = createDb();
      const result = await executeReinstall({
        contextDir,
        db,
        backupDir: join(tmp, "bak"),
        now: () => new Date("2026-04-17T00:00:00Z"),
        spawnTar: () => {
          throw new Error("spawnTar should not have been called");
        },
      });
      expect(result.backupPath).toBeNull();
      expect(result.filesDeleted).toBe(0);
      expect(result.bytesDeleted).toBe(0);
      expect(result.snapshotRowsDeleted).toBe(0);
      expect(result.ancillaryDirsRemoved).toEqual([]);
      db.close();
    });

    it("skips backup when context/ is empty", async () => {
      mkdirSync(contextDir, { recursive: true });
      const db = createDb();
      const result = await executeReinstall({
        contextDir,
        db,
        backupDir: join(tmp, "bak"),
        now: () => new Date("2026-04-17T00:00:00Z"),
        spawnTar: () => {
          throw new Error("spawnTar should not have been called");
        },
      });
      expect(result.backupPath).toBeNull();
      expect(existsSync(contextDir)).toBe(false);
      db.close();
    });

    it("uses the real tar binary when no override is supplied", async () => {
      mkdirSync(contextDir, { recursive: true });
      mkdirSync(join(contextDir, "state"), { recursive: true });
      writeFileSync(join(contextDir, "state", "today.md"), "real");
      const db = createDb();
      const backupDir = join(tmp, "bak");
      const result = await executeReinstall({
        contextDir,
        db,
        backupDir,
        now: () => new Date("2026-04-17T00:00:00Z"),
      });
      expect(result.backupPath).not.toBeNull();
      expect(existsSync(result.backupPath!)).toBe(true);
      expect(statSync(result.backupPath!).size).toBeGreaterThan(0);
      expect(result.filesDeleted).toBe(1);
      expect(existsSync(contextDir)).toBe(false);
      db.close();
    });

    it("throws when the tar process exits non-zero", async () => {
      mkdirSync(contextDir, { recursive: true });
      mkdirSync(join(contextDir, "state"), { recursive: true });
      writeFileSync(join(contextDir, "state", "today.md"), "t");
      const db = createDb();
      await expect(
        executeReinstall({
          contextDir,
          db,
          backupDir: join(tmp, "bak"),
          now: () => new Date("2026-04-17T00:00:00Z"),
          spawnTar: () => ({ status: 1 }),
        }),
      ).rejects.toThrow(/tar exited with status 1/);
      expect(existsSync(contextDir)).toBe(true);
      db.close();
    });

    it("propagates backup failures and preserves context", async () => {
      mkdirSync(contextDir, { recursive: true });
      mkdirSync(join(contextDir, "state"), { recursive: true });
      writeFileSync(join(contextDir, "state", "today.md"), "t");
      const db = createDb();
      await expect(
        executeReinstall({
          contextDir,
          db,
          backupDir: join(tmp, "bak"),
          now: () => new Date("2026-04-17T00:00:00Z"),
          spawnTar: () => {
            throw new Error("tar crashed");
          },
        }),
      ).rejects.toThrow("tar crashed");
      // Context dir must still exist when backup fails
      expect(existsSync(contextDir)).toBe(true);
      db.close();
    });
  });
});
