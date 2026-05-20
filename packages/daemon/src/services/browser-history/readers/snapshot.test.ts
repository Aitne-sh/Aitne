import { describe, it, expect, afterEach } from "vitest";
import {
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
});
