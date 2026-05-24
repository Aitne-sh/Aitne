import { describe, it, expect, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupStaleBrowserHistorySnapshots,
  createBrowserHistorySnapshot,
} from "./snapshot.js";

describe("createBrowserHistorySnapshot", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("copies the main SQLite file plus WAL and SHM siblings into a private cache dir", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "pa-browser-profile-"));
    const cacheRoot = mkdtempSync(join(tmpdir(), "pa-browser-cache-"));
    dirs.push(profileDir, cacheRoot);

    const historyPath = join(profileDir, "History");
    writeFileSync(historyPath, "main");
    writeFileSync(join(profileDir, "History-wal"), "wal");
    writeFileSync(join(profileDir, "History-shm"), "shm");

    const snapshot = await createBrowserHistorySnapshot(historyPath, cacheRoot);
    try {
      expect(snapshot.mainPath.startsWith(snapshot.dir)).toBe(true);
      expect(readFileSync(snapshot.mainPath, "utf8")).toBe("main");
      expect(readFileSync(join(snapshot.dir, "History-wal"), "utf8")).toBe("wal");
      expect(readFileSync(join(snapshot.dir, "History-shm"), "utf8")).toBe("shm");
      expect(snapshot.copiedWal).toBe(true);
      expect(snapshot.copiedShm).toBe(true);
    } finally {
      await snapshot.cleanup();
    }
    expect(existsSync(snapshot.dir)).toBe(false);
  });

  it("cleanupStaleBrowserHistorySnapshots removes only history-* subdirectories under the cache root", async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "pa-browser-cache-clean-"));
    dirs.push(cacheRoot);
    const staleDir = join(cacheRoot, "history-old-uuid");
    const keepDir = join(cacheRoot, "other-data");
    mkdirSync(staleDir, { recursive: true });
    mkdirSync(keepDir, { recursive: true });
    writeFileSync(join(staleDir, "History"), "leftover");
    writeFileSync(join(keepDir, "marker"), "preserve");

    const removed = await cleanupStaleBrowserHistorySnapshots(cacheRoot);
    expect(removed).toBe(1);
    expect(existsSync(staleDir)).toBe(false);
    expect(existsSync(keepDir)).toBe(true);
  });

  it("cleanupStaleBrowserHistorySnapshots is a no-op when the cache root does not exist", async () => {
    const removed = await cleanupStaleBrowserHistorySnapshots(
      join(tmpdir(), `pa-browser-cache-missing-${Date.now()}`),
    );
    expect(removed).toBe(0);
  });

  it("createBrowserHistorySnapshot omits WAL/SHM when absent and reports the flags", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "pa-browser-profile-bare-"));
    const cacheRoot = mkdtempSync(join(tmpdir(), "pa-browser-cache-bare-"));
    dirs.push(profileDir, cacheRoot);

    const historyPath = join(profileDir, "History");
    writeFileSync(historyPath, "main-only");

    const snapshot = await createBrowserHistorySnapshot(historyPath, cacheRoot);
    try {
      expect(readFileSync(snapshot.mainPath, "utf8")).toBe("main-only");
      expect(snapshot.copiedWal).toBe(false);
      expect(snapshot.copiedShm).toBe(false);
      expect(existsSync(join(snapshot.dir, "History-wal"))).toBe(false);
      expect(existsSync(join(snapshot.dir, "History-shm"))).toBe(false);
    } finally {
      await snapshot.cleanup();
    }
  });

  it("cleanupStaleBrowserHistorySnapshots swallows readdir failure when cache root is a file", async () => {
    const filePath = join(
      mkdtempSync(join(tmpdir(), "pa-browser-cache-file-")),
      "not-a-dir",
    );
    dirs.push(filePath);
    writeFileSync(filePath, "I am a file, not a directory");

    // `existsSync` returns true, but `readdir` throws ENOTDIR.
    // The outer catch should swallow it and return 0.
    const removed = await cleanupStaleBrowserHistorySnapshots(filePath);
    expect(removed).toBe(0);
  });

  it("cleanupStaleBrowserHistorySnapshots swallows per-entry rm failure", async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "pa-browser-cache-locked-"));
    dirs.push(cacheRoot);
    const staleDir = join(cacheRoot, "history-locked-uuid");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, "History"), "stuck");

    // Strip write permission from cacheRoot. readdir (r) still works,
    // but rm of the child cannot unlink because the parent denies write.
    // After the assertion we restore perms so the afterEach cleanup runs.
    chmodSync(cacheRoot, 0o555);
    try {
      const removed = await cleanupStaleBrowserHistorySnapshots(cacheRoot);
      // Per-entry catch swallows the EACCES; nothing was removed.
      expect(removed).toBe(0);
      expect(existsSync(staleDir)).toBe(true);
    } finally {
      chmodSync(cacheRoot, 0o755);
    }
  });
});
