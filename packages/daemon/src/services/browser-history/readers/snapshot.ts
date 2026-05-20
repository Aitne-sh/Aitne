import { mkdir, readdir, rm, stat, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface BrowserHistorySnapshot {
  dir: string;
  mainPath: string;
  copiedWal: boolean;
  copiedShm: boolean;
  cleanup(): Promise<void>;
}

async function copyIfExists(source: string, target: string): Promise<boolean> {
  if (!existsSync(source)) return false;
  await copyFile(source, target);
  return true;
}

export async function createBrowserHistorySnapshot(
  historyPath: string,
  cacheRoot: string,
): Promise<BrowserHistorySnapshot> {
  await stat(historyPath);
  const dir = join(cacheRoot, `history-${Date.now()}-${randomUUID()}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const base = basename(historyPath);
  const sourceDir = dirname(historyPath);
  const mainPath = join(dir, base);
  await copyFile(historyPath, mainPath);
  const copiedWal = await copyIfExists(
    join(sourceDir, `${base}-wal`),
    join(dir, `${base}-wal`),
  );
  const copiedShm = await copyIfExists(
    join(sourceDir, `${base}-shm`),
    join(dir, `${base}-shm`),
  );

  return {
    dir,
    mainPath,
    copiedWal,
    copiedShm,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Best-effort boot-time cleanup of stale `history-*` snapshot directories
 * left over from a previous daemon process that crashed before `cleanup()`
 * could run. The directories are owner-only and contain only copies of
 * browser SQLite files (themselves regenerated from the live profile on
 * the next snapshot), so deleting them is safe.
 *
 * Returns the number of directories removed. Silently swallows fs errors
 * — a write-failure here should never block daemon startup.
 */
export async function cleanupStaleBrowserHistorySnapshots(
  cacheRoot: string,
): Promise<number> {
  if (!existsSync(cacheRoot)) return 0;
  let removed = 0;
  try {
    const entries = await readdir(cacheRoot, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory() || !entry.name.startsWith("history-")) {
          return;
        }
        try {
          await rm(join(cacheRoot, entry.name), {
            recursive: true,
            force: true,
          });
          removed += 1;
        } catch {
          // ignore per-entry failures; partial cleanup is fine
        }
      }),
    );
  } catch {
    // Best-effort — cache root unreadable.
  }
  return removed;
}
