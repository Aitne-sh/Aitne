/**
 * Tests for the Phase 2 filesystem primitives. Pure tmpdir-based checks,
 * no DB or HTTP setup.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AGENT_FILE_TOP_LEVEL,
  createBackup,
  finalizeBackup,
  inspectDir,
  inspectTarget,
  listTopLevel,
  moveTree,
  onSameFilesystem,
  resolveConflictPolicy,
  restoreFromBackup,
} from "./migration-backup.js";
import { CONTEXT_DIR_NAMES } from "./context-paths.js";

function makeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = resolve(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }
}

describe("inspectDir", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pa-inspect-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("walks recursively and records sizes", () => {
    makeTree(tmp, {
      "today.md": "abc",
      "projects/foo.md": "hello world",
      "projects/bar.md": "",
    });
    const m = inspectDir(tmp);
    const files = m.files.map((f) => f.rel).sort();
    expect(files).toEqual(["projects", "projects/bar.md", "projects/foo.md", "today.md"]);
    expect(m.totalBytes).toBe(3 + 11 + 0);
  });

  it("records symlinks without dereferencing", () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "target.md"), "data");
    symlinkSync("target.md", join(tmp, "alias.md"));
    const m = inspectDir(tmp);
    const alias = m.files.find((f) => f.rel === "alias.md");
    expect(alias?.kind).toBe("symlink");
  });

  it("returns an empty manifest for a missing dir", () => {
    const missing = join(tmp, "does-not-exist");
    const m = inspectDir(missing);
    expect(m.files).toEqual([]);
    expect(m.totalBytes).toBe(0);
  });
});

describe("listTopLevel", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pa-toplevel-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("filters benign entries and returns names only", () => {
    writeFileSync(join(tmp, "today.md"), "");
    mkdirSync(join(tmp, "projects"));
    mkdirSync(join(tmp, ".obsidian"));
    writeFileSync(join(tmp, ".DS_Store"), "");
    const names = listTopLevel(tmp);
    expect(names.has("today.md")).toBe(true);
    expect(names.has("projects")).toBe(true);
    expect(names.has(".obsidian")).toBe(false);
    expect(names.has(".DS_Store")).toBe(false);
  });
});

describe("inspectTarget + resolveConflictPolicy", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pa-target-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("treats a missing target as OK for all policies", () => {
    const report = inspectTarget(join(tmp, "no-such-dir"), new Set(["today.md"]));
    expect(report.targetExists).toBe(false);
    expect(resolveConflictPolicy(report, "abort").ok).toBe(true);
  });

  it("treats a target with only benign entries as empty", () => {
    const target = join(tmp, "t");
    mkdirSync(join(target, ".obsidian"), { recursive: true });
    writeFileSync(join(target, ".DS_Store"), "");
    const report = inspectTarget(target, new Set(["today.md"]));
    expect(report.targetIsEmpty).toBe(true);
    expect(resolveConflictPolicy(report, "abort").ok).toBe(true);
  });

  it("rejects foreign files under 'abort'", () => {
    const target = join(tmp, "t");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "foreign.md"), "hi");
    const report = inspectTarget(target, new Set(["today.md"]));
    const res = resolveConflictPolicy(report, "abort");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("target_has_unrelated_files");
      expect(res.entries).toContain("foreign.md");
    }
  });

  it("rejects agent-file conflicts under 'merge'", () => {
    const target = join(tmp, "t");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "today.md"), "existing");
    const report = inspectTarget(target, new Set(["today.md"]));
    const res = resolveConflictPolicy(report, "merge");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("target_has_agent_file_conflicts");
  });

  it("permits agent-file conflicts under 'overwrite_agent_files'", () => {
    const target = join(tmp, "t");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "today.md"), "existing");
    const report = inspectTarget(target, new Set(["today.md"]));
    expect(resolveConflictPolicy(report, "overwrite_agent_files").ok).toBe(true);
  });

  it("treats stale skeleton residue (empty subtrees) as benign", () => {
    // Reproduces the obsidian → plain rollback case where the daemon's
    // own ensureSkeletonFiles() left empty top-level dirs (including
    // nested empty dirs like agent/scratch and routines/custom) at
    // ~/.personal-agent/context after a prior plain → obsidian migration.
    // Under policy="abort" this used to fail with target_has_unrelated_files.
    const target = join(tmp, "t");
    mkdirSync(join(target, "agent", "scratch"), { recursive: true });
    mkdirSync(join(target, "routines", "custom"), { recursive: true });
    mkdirSync(join(target, "git-repos"), { recursive: true });
    mkdirSync(join(target, "weekly"), { recursive: true });
    const report = inspectTarget(target, new Set());
    expect(report.targetIsEmpty).toBe(true);
    expect(resolveConflictPolicy(report, "abort").ok).toBe(true);
  });

  it("flags a top-level dir that contains any file (even nested) as a real entry", () => {
    // Defense-in-depth: only TRULY empty subtrees get pruned. A user
    // who has actual content under projects/ must still hit the
    // conflict path, not be silently ignored.
    const target = join(tmp, "t");
    mkdirSync(join(target, "projects", "deep"), { recursive: true });
    writeFileSync(join(target, "projects", "deep", "user-note.md"), "mine");
    const report = inspectTarget(target, new Set());
    expect(report.targetIsEmpty).toBe(false);
    // Not in source → foreign (and would block under abort).
    expect(report.foreignEntries).toContain("projects");
  });
});

describe("createBackup + restoreFromBackup", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pa-backup-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("creates a faithful snapshot and restores it identically", () => {
    const source = join(tmp, "src");
    makeTree(source, {
      "today.md": "T",
      "projects/a.md": "A content",
      "rules/management.md": "R",
    });
    const backup = createBackup(source, join(tmp, "bk"));
    expect(backup.manifest.files.length).toBeGreaterThan(0);
    expect(existsSync(join(backup.backupDir, "today.md"))).toBe(true);

    // Wipe source and restore.
    rmSync(source, { recursive: true, force: true });
    restoreFromBackup(backup, source);
    expect(readFileSync(join(source, "today.md"), "utf-8")).toBe("T");
    expect(readFileSync(join(source, "projects/a.md"), "utf-8")).toBe("A content");
  });

  it("rejects an existing backup directory", () => {
    const source = join(tmp, "src");
    makeTree(source, { "a.md": "x" });
    const bk = join(tmp, "bk");
    mkdirSync(bk, { recursive: true });
    expect(() => createBackup(source, bk)).toThrow();
  });

  it("cleans up a partially-created backup directory when backup creation fails", async () => {
    const source = join(tmp, "src");
    makeTree(source, {
      "a.md": "x",
      "nested/b.md": "y",
    });
    const backupDir = join(tmp, "bk");
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      const shouldFail = (dst: string) => dst.endsWith("nested/b.md");
      return {
        ...actual,
        linkSync: (...args: Parameters<typeof actual.linkSync>) => {
          if (shouldFail(String(args[1]))) {
            throw new Error("simulated backup failure");
          }
          return actual.linkSync(...args);
        },
        copyFileSync: (...args: Parameters<typeof actual.copyFileSync>) => {
          if (shouldFail(String(args[1]))) {
            throw new Error("simulated backup failure");
          }
          return actual.copyFileSync(...args);
        },
      };
    });

    try {
      const mod = await import("./migration-backup.js");
      expect(() => mod.createBackup(source, backupDir)).toThrow(/simulated backup failure/);
      expect(existsSync(backupDir)).toBe(false);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});

describe("finalizeBackup", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pa-finalize-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("breaks hardlink aliases so source writes don't mutate the backup", () => {
    const source = join(tmp, "src");
    makeTree(source, { "today.md": "original" });
    const backup = createBackup(source, join(tmp, "bk"));
    // Only relevant when same-fs (hardlinked). If the tmpdir is cross-fs from
    // itself (shouldn't be), the assertion about inode separation would be
    // meaningless, so branch.
    if (backup.hardlinked) {
      const beforeIno = statSync(join(source, "today.md")).ino;
      const beforeBkIno = statSync(join(backup.backupDir, "today.md")).ino;
      expect(beforeIno).toBe(beforeBkIno);
      finalizeBackup(backup);
      const afterIno = statSync(join(source, "today.md")).ino;
      const afterBkIno = statSync(join(backup.backupDir, "today.md")).ino;
      expect(afterBkIno).not.toBe(afterIno);
    } else {
      // Cross-fs case: finalize is a no-op and both inodes were always distinct.
      finalizeBackup(backup);
      expect(existsSync(join(backup.backupDir, "today.md"))).toBe(true);
    }
  });
});

describe("moveTree (same-fs)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pa-move-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("rename-moves when target does not exist", () => {
    const source = join(tmp, "src");
    const target = join(tmp, "dst");
    makeTree(source, { "today.md": "T", "projects/a.md": "A" });
    moveTree(source, target);
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(join(target, "today.md"), "utf-8")).toBe("T");
    expect(readFileSync(join(target, "projects/a.md"), "utf-8")).toBe("A");
  });

  it("merges into a benign-only target (preserves .obsidian)", () => {
    const source = join(tmp, "src");
    const target = join(tmp, "dst");
    makeTree(source, { "today.md": "T" });
    mkdirSync(join(target, ".obsidian"), { recursive: true });
    writeFileSync(join(target, ".obsidian", "workspace"), "{}");
    moveTree(source, target);
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(join(target, "today.md"), "utf-8")).toBe("T");
    expect(readFileSync(join(target, ".obsidian", "workspace"), "utf-8")).toBe("{}");
  });
});

describe("onSameFilesystem", () => {
  it("returns true for two paths inside /tmp", () => {
    const a = mkdtempSync(join(tmpdir(), "pa-fs-a-"));
    const b = mkdtempSync(join(tmpdir(), "pa-fs-b-"));
    expect(onSameFilesystem(a, b)).toBe(true);
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  });
});

describe("AGENT_FILE_TOP_LEVEL", () => {
  it("covers all canonical top-level names used by setup", () => {
    // Spot-check a few critical entries; the full set is documented in
    // migration-backup.ts. If the list drifts, Phase 2 silently degrades
    // conflict detection on new files — this test is the tripwire.
    expect(AGENT_FILE_TOP_LEVEL.has("today.md")).toBe(true);
    expect(AGENT_FILE_TOP_LEVEL.has("rules")).toBe(true);
    expect(AGENT_FILE_TOP_LEVEL.has("projects")).toBe(true);
    expect(AGENT_FILE_TOP_LEVEL.has("agent")).toBe(true);
  });

  it("includes every top-level directory the skeleton seeder creates", () => {
    // skeleton.ts:ensureSkeletonFiles materializes every CONTEXT_DIR_NAMES
    // entry on each daemon boot, so any of those names landing at a
    // migration target are agent-owned and must NOT be flagged as foreign.
    // Missing one (e.g. "git-repos") makes obsidian → plain rollback fail
    // with target_has_unrelated_files.
    const skeletonTopLevels = new Set(
      CONTEXT_DIR_NAMES.map((name) => name.split("/")[0]),
    );
    const missing = [...skeletonTopLevels].filter(
      (name) => !AGENT_FILE_TOP_LEVEL.has(name),
    );
    expect(missing).toEqual([]);
  });
});
