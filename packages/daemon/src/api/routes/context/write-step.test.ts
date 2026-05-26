/**
 * Unit tests for `write-step.ts:performContextFileWrite`. The helper is
 * exercised end-to-end by the composer + the HTTP route, but a small
 * suite here pins the branches that aren't natural at the higher
 * call-sites:
 *   - `missing_for_append` (append_block against a non-existent file).
 *   - writeFileAtomically failure → writeTracker.unmark rollback.
 *   - daily-skeleton drift returns structured error rather than throwing.
 *
 * Each test uses a tmp dir + an in-memory snapshot recorder.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { performContextFileWrite } from "./write-step.js";

describe("performContextFileWrite", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "context-write-step-"));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup. A test that chmod'd a tmp dir read-only may
      // refuse rmSync — that's harmless for $TMPDIR.
    }
  });

  it("put mode against a fresh file — writes content and skips pre-state snapshot", () => {
    const path = join(tmpDir, "today.md");
    const snapshots: Array<{ key: string; trigger: string }> = [];
    const result = performContextFileWrite(
      {
        saveSnapshot: (key, _content, trigger) => {
          snapshots.push({ key, trigger });
          return 99;
        },
      },
      {
        absolutePath: path,
        relativePath: "today.md",
        snapshotKey: "today",
        mode: "put",
        content: "# today\n",
        trigger: "test",
      },
    );

    expect(result).toMatchObject({ ok: true, bytesWritten: "# today\n".length });
    expect(readFileSync(path, "utf-8")).toBe("# today\n");
    expect(snapshots).toEqual([]); // no pre-state to snapshot
  });

  it("put mode against an existing file — snapshots pre-state then overwrites", () => {
    const path = join(tmpDir, "today.md");
    writeFileSync(path, "old content\n", "utf-8");
    const snapshots: Array<{ key: string; trigger: string; content: string }> = [];
    const result = performContextFileWrite(
      {
        saveSnapshot: (key, content, trigger) => {
          snapshots.push({ key, trigger, content });
          return 7;
        },
      },
      {
        absolutePath: path,
        relativePath: "today.md",
        snapshotKey: "today",
        mode: "put",
        content: "new content\n",
        trigger: "test",
      },
    );

    expect(result).toMatchObject({ ok: true, snapshotId: 7 });
    expect(readFileSync(path, "utf-8")).toBe("new content\n");
    expect(snapshots).toEqual([
      { key: "today", trigger: "test", content: "old content\n" },
    ]);
  });

  it("append_block on a missing file — returns missing_for_append", () => {
    const path = join(tmpDir, "absent.md");
    const result = performContextFileWrite(
      { saveSnapshot: () => 0 },
      {
        absolutePath: path,
        relativePath: "absent.md",
        snapshotKey: "absent",
        mode: "append_block",
        content: "block",
        trigger: "test",
      },
    );

    expect(result).toEqual({ ok: false, reason: "missing_for_append" });
    expect(existsSync(path)).toBe(false);
  });

  it("append_block against existing file — pure append with newline separator", () => {
    const path = join(tmpDir, "agent-journal.md");
    writeFileSync(path, "# Agent journal\n\n## 2026-05-22 morning routine\n- existing\n", "utf-8");
    const result = performContextFileWrite(
      { saveSnapshot: () => 0 },
      {
        absolutePath: path,
        relativePath: "journal/agent.md",
        snapshotKey: "journal/agent",
        mode: "append_block",
        content: "## 2026-05-23 morning routine\n- new",
        trigger: "test",
      },
    );

    expect(result.ok).toBe(true);
    const updated = readFileSync(path, "utf-8");
    expect(updated).toContain("- existing");
    expect(updated).toContain("- new");
    // The original block is preserved (no LAST-wins H2 replacement).
    expect(updated.indexOf("- existing")).toBeLessThan(updated.indexOf("- new"));
  });

  it("daily-skeleton drift — returns structured error, no file written", () => {
    const path = join(tmpDir, "daily", "2026-05-22.md");
    const result = performContextFileWrite(
      { saveSnapshot: () => 0 },
      {
        absolutePath: path,
        relativePath: "journal/daily/2026-05-22.md",
        snapshotKey: "journal/daily/2026-05-22",
        mode: "put",
        content: "---\n---\n# wrong\n",
        trigger: "test",
        validateDailySkeleton: true,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "daily_skeleton_drift") {
      expect(result.driftErrors.length).toBeGreaterThan(0);
    } else {
      throw new Error("expected daily_skeleton_drift");
    }
    expect(existsSync(path)).toBe(false);
  });

  it("writeFileAtomically throw — writeTracker.unmark called as rollback", () => {
    // Point the destination at a path whose parent is a regular file,
    // not a directory. `writeFileAtomically` calls
    // `mkdirSync(parent, { recursive: true })` early on; recursive
    // mkdir through a regular file throws ENOTDIR. The throw happens
    // AFTER `markWriting` (per the helper's mark-then-write ordering),
    // so the catch fires `unmark` — exactly the C2 rollback invariant
    // we want to pin.
    const blockingFile = join(tmpDir, "blocker");
    writeFileSync(blockingFile, "x");
    const absolutePath = join(blockingFile, "sub", "file.md");

    const events: string[] = [];
    expect(() =>
      performContextFileWrite(
        {
          saveSnapshot: () => 0,
          writeTracker: {
            markWriting: () => events.push("mark"),
            unmark: () => events.push("unmark"),
          },
        },
        {
          absolutePath,
          relativePath: "today.md",
          snapshotKey: "today",
          mode: "put",
          content: "content",
          trigger: "test",
        },
      ),
    ).toThrow();

    // mark must precede unmark so the FS-watch attribution invariant
    // (C2) holds even when the write fails.
    expect(events).toEqual(["mark", "unmark"]);
  });

  it("writeTracker is optional", () => {
    const path = join(tmpDir, "today.md");
    expect(() =>
      performContextFileWrite(
        { saveSnapshot: () => 0 },
        {
          absolutePath: path,
          relativePath: "today.md",
          snapshotKey: "today",
          mode: "put",
          content: "x",
          trigger: "test",
        },
      ),
    ).not.toThrow();
    expect(readFileSync(path, "utf-8")).toBe("x");
  });

  it("onIndexableContextChange fires with relativePath", () => {
    const path = join(tmpDir, "today.md");
    const events: string[] = [];
    performContextFileWrite(
      {
        saveSnapshot: () => 0,
        onIndexableContextChange: (rel) => events.push(rel),
      },
      {
        absolutePath: path,
        relativePath: "today.md",
        snapshotKey: "today",
        mode: "put",
        content: "x",
        trigger: "test",
      },
    );
    expect(events).toEqual(["today.md"]);
  });

  // Silence lint for "chmodSync unused" — kept imported in case future
  // tests need to exercise the permission-denied write branch.
  void chmodSync;
});
