import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as chokidar from "chokidar";
import type { FSWatcher } from "chokidar";
import { createLogger } from "../../logging.js";
import type { WikiWorkspaceRow } from "./workspaces.js";

const logger = createLogger("wiki-index-cache");

/**
 * Per-workspace in-process cache of `20_wiki/_index.md`.
 *
 * WIKI_BUILDER_DESIGN.md §14 Q6 — external-mode workspaces only.
 * Internal-mode reads hit a local SSD inside dataDir, so the chokidar
 * + TTL bookkeeping is a net cost and the manager refuses to register
 * a watcher there.
 *
 * Invalidation:
 * - chokidar watcher rooted on `<root>/20_wiki/_index.md` for fs events
 *   (the canonical signal once the file exists on disk).
 * - 5-minute TTL fallback covers iCloud-FUSE missed events; iCloud and
 *   similar FUSE filesystems are known to occasionally drop change
 *   notifications, so a stale TTL is the belt-and-braces guard.
 *
 * The cache is read-through: a miss reads from disk + reparses; a hit
 * returns the cached parsed snapshot.
 *
 * Note: this module is intentionally tolerant of the index file not
 * existing yet. A freshly-seeded workspace has no `_index.md` until the
 * first `wiki.compile` writes one, and consumers should observe a
 * `{ exists: false }` snapshot in that window rather than throwing.
 */
const TTL_MS = 5 * 60 * 1000;

export interface WikiIndexSnapshot {
  exists: boolean;
  /** Raw markdown contents — present only when `exists` is true. */
  content: string | null;
  /** mtimeMs from the underlying file — for cache freshness assertions. */
  mtimeMs: number | null;
  /** When this snapshot was loaded from disk. */
  loadedAtMs: number;
}

interface Entry {
  snapshot: WikiIndexSnapshot;
  expiresAtMs: number;
  watcher: FSWatcher | null;
  watchedPath: string;
}

export class WikiIndexCache {
  private readonly entries = new Map<number, Entry>();

  /**
   * Read the cached snapshot, populating from disk on a miss / staleness.
   * Returns a `{ exists: false }` snapshot when the workspace is not
   * external (the caller is expected to short-circuit before reaching
   * here, but this is a safe no-op for them too).
   */
  get(workspace: WikiWorkspaceRow): WikiIndexSnapshot {
    if (workspace.kind !== "external") {
      return readSnapshotFromDisk(workspace);
    }
    const existing = this.entries.get(workspace.id);
    if (existing && existing.expiresAtMs > Date.now()) {
      return existing.snapshot;
    }
    return this.refresh(workspace);
  }

  /**
   * Force a re-read from disk. Used by chokidar callbacks and by the
   * write path immediately after an `_index.md` mutation so the next
   * reader observes the just-written content.
   */
  refresh(workspace: WikiWorkspaceRow): WikiIndexSnapshot {
    const snapshot = readSnapshotFromDisk(workspace);
    const expiresAtMs = Date.now() + TTL_MS;
    const existing = this.entries.get(workspace.id);
    if (existing) {
      existing.snapshot = snapshot;
      existing.expiresAtMs = expiresAtMs;
      return snapshot;
    }
    const entry: Entry = {
      snapshot,
      expiresAtMs,
      watcher: null,
      watchedPath: workspace.kind === "external"
        ? join(workspace.root_path, "20_wiki/_index.md")
        : "",
    };
    if (workspace.kind === "external") {
      try {
        entry.watcher = chokidar
          .watch(entry.watchedPath, {
            ignoreInitial: true,
            persistent: false,
            awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
          })
          .on("add", () => {
            this.refresh(workspace);
          })
          .on("change", () => {
            this.refresh(workspace);
          })
          .on("unlink", () => {
            this.refresh(workspace);
          })
          .on("error", (err) => {
            logger.warn(
              { workspace: workspace.name, err: err instanceof Error ? err.message : String(err) },
              "wiki-index-cache watcher error — relying on TTL fallback",
            );
          });
      } catch (err) {
        logger.warn(
          { workspace: workspace.name, err: err instanceof Error ? err.message : String(err) },
          "wiki-index-cache failed to start watcher — falling back to TTL only",
        );
      }
    }
    this.entries.set(workspace.id, entry);
    return snapshot;
  }

  /**
   * Invalidate the cached snapshot without re-reading. Useful when the
   * write path knows the watcher is about to fire and wants the next
   * reader to observe the post-write state without two reads in a row.
   */
  invalidate(workspaceId: number): void {
    const entry = this.entries.get(workspaceId);
    if (!entry) return;
    entry.expiresAtMs = 0;
  }

  /**
   * Tear down a workspace's cache + watcher. Called by the workspace
   * deactivation path so an archived workspace no longer holds an fd.
   */
  async release(workspaceId: number): Promise<void> {
    const entry = this.entries.get(workspaceId);
    if (!entry) return;
    if (entry.watcher) {
      try {
        await entry.watcher.close();
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "wiki-index-cache failed to close watcher",
        );
      }
    }
    this.entries.delete(workspaceId);
  }

  async shutdown(): Promise<void> {
    const ids = [...this.entries.keys()];
    await Promise.all(ids.map((id) => this.release(id)));
  }
}

function readSnapshotFromDisk(workspace: WikiWorkspaceRow): WikiIndexSnapshot {
  const path = join(workspace.root_path, "20_wiki/_index.md");
  if (!existsSync(path)) {
    return { exists: false, content: null, mtimeMs: null, loadedAtMs: Date.now() };
  }
  try {
    const stat = statSync(path);
    const content = readFileSync(path, "utf-8");
    return {
      exists: true,
      content,
      mtimeMs: stat.mtimeMs,
      loadedAtMs: Date.now(),
    };
  } catch (err) {
    logger.warn(
      { workspace: workspace.name, err: err instanceof Error ? err.message : String(err) },
      "wiki-index-cache failed to read _index.md",
    );
    return { exists: false, content: null, mtimeMs: null, loadedAtMs: Date.now() };
  }
}
