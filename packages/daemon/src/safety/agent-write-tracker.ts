import { createHash } from "node:crypto";
import { createLogger } from "../logging.js";

const logger = createLogger("agent-write-tracker");

interface RecentWrite {
  expiresAt: number;
  /**
   * SHA-256 hash of the expected post-write content, or `null` if the caller
   * only knows which path will be touched but not the exact resulting bytes
   * (e.g. append operations against a file whose existing content isn't
   * loaded). `null` means `isMarked` does a path-only match instead of a
   * content-hash match.
   */
  contentHash: string | null;
}

interface RecentCommit {
  expiresAt: number;
}

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

/**
 * Commit-tracking TTL default. Outlives the 5-min `GitWatcher` poll
 * default at `git-watcher.ts` so a commit made just after a poll cycle
 * still wins attribution at the next cycle. Constructor lets tests
 * override.
 */
const DEFAULT_COMMIT_TTL_MS = 15 * 60_000;

/**
 * AgentWriteTracker — short-lived, in-memory record of paths the agent is
 * currently writing via the daemon API. Observers consult it to classify
 * file-change events as `actor='agent'` vs `actor='user'`, which gives the
 * activity-scan dispatcher a way to ignore its own writes.
 *
 * Two marking modes:
 *  1. **Content-hash mode** — caller passes the exact bytes they wrote.
 *     `isMarked` confirms both the path AND a hash match. Used by the
 *     context file API (PUT /api/context/today etc.) where we control the
 *     full content. Robust against false positives where the user edits
 *     the same path within the TTL window.
 *  2. **Path-only mode** — caller passes `undefined` for content. `isMarked`
 *     returns true for any observation on that path within the TTL. Used
 *     by append-style writes (Obsidian CLI `append`, `daily:append`) where
 *     the post-write file content depends on whatever was already on disk
 *     and the daemon can't deterministically compute the hash.
 *
 * In path-only mode there's a small false-positive risk: if the user edits
 * the same note within the TTL window, that user edit gets attributed to
 * the agent. Missing a user observation is cheaper than a loop where the
 * agent re-triggers itself.
 *
 * **Per-mark TTL override**: the default TTL is tuned for real-time file
 * system watchers that fire within milliseconds (chokidar/Obsidian). For
 * polled sources (Notion, Calendar) whose observation lag is measured in
 * minutes, the caller MUST pass `opts.ttlMs` large enough to outlive the
 * poll cadence — otherwise every agent write is seen as a fresh user
 * edit and the activity_scan can loop on its own output.
 */
export class AgentWriteTracker {
  private readonly recentWrites = new Map<string, RecentWrite>();
  /**
   * Parallel commit-tracking map keyed by `<repoPath>::<sha-lower>`. Used by
   * `GitWatcher` to flip observations of agent-originated commits from
   * `actor='user'` / `'unknown'` to `actor='agent'` so the activity_scan
   * pending-floor does not count the daemon's own commits as user
   * activity (C1).
   */
  private readonly recentCommits = new Map<string, RecentCommit>();
  private readonly commitTtlMs: number;

  constructor(
    private readonly ttlMs = 30_000,
    opts?: { commitTtlMs?: number },
  ) {
    this.commitTtlMs = opts?.commitTtlMs ?? DEFAULT_COMMIT_TTL_MS;
  }

  markWriting(
    absolutePath: string,
    content?: string | null,
    opts?: { ttlMs?: number },
  ): void {
    const mode = typeof content === "string" ? "content-hash" : "path-only";
    const ttlMs = opts?.ttlMs ?? this.ttlMs;
    this.recentWrites.set(absolutePath, {
      expiresAt: Date.now() + ttlMs,
      contentHash: typeof content === "string" ? this.hashContent(content) : null,
    });
    logger.debug({ path: absolutePath, mode, ttlMs }, "Write marked for agent attribution");
    this.cleanup();
  }

  /**
   * Remove a mark for `absolutePath`, regardless of mode (content-hash or
   * path-only). Used by writers that mark **before** the visible-write
   * boundary (C2 fix — `markWriting` must precede `writeFileAtomically` /
   * `writeFileSync` so FS-watch consumers see a populated tracker the
   * moment the rename/write completes). If the write throws, the caller
   * rolls the mark back via `unmark` so a stale mark cannot suppress a
   * later legitimate user edit. Idempotent — `Map.delete` on an unknown
   * key is a no-op, so callers can `unmark` unconditionally in a catch.
   */
  unmark(absolutePath: string): void {
    this.recentWrites.delete(absolutePath);
  }

  isMarked(absolutePath: string, content: string | null | undefined): boolean {
    const entry = this.recentWrites.get(absolutePath);
    if (!entry) {
      return false;
    }
    if (Date.now() > entry.expiresAt) {
      this.recentWrites.delete(absolutePath);
      return false;
    }
    // Path-only mark: no content comparison, any observation on this path
    // within the TTL window is considered agent-originated.
    if (entry.contentHash === null) {
      return true;
    }
    // Content-hash mark: require an exact byte match to tolerate rapid
    // user edits of the same path within the TTL.
    if (typeof content !== "string") {
      return false;
    }
    return entry.contentHash === this.hashContent(content);
  }

  cleanup(now = Date.now()): void {
    for (const [path, entry] of this.recentWrites.entries()) {
      if (entry.expiresAt <= now) {
        this.recentWrites.delete(path);
      }
    }
  }

  private hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  // ── Commit attribution (C1) ──────────────────────────────────────────

  /**
   * Register a git SHA the daemon just committed in `repoPath`. The next
   * `GitWatcher` observation of that SHA is flipped from `actor='user'` /
   * `'unknown'` to `actor='agent'` via `isAgentCommit`, which keeps the
   * activity_scan pending-floor from counting the daemon's own commits as
   * user activity (the loop bug described in C1).
   *
   * Production callers pass the full 40-char SHA from `git rev-parse HEAD`.
   * The minimum-length guard (≥7 hex chars) prevents accidental cross-repo
   * collisions when tests feed abbreviated hashes. Malformed input is a
   * silent no-op rather than an error — this is best-effort attribution,
   * never a correctness gate.
   */
  markAgentCommit(repoPath: string, sha: string, opts?: { ttlMs?: number }): void {
    if (!SHA_PATTERN.test(sha)) return;
    const ttlMs = opts?.ttlMs ?? this.commitTtlMs;
    this.recentCommits.set(this.commitKey(repoPath, sha), {
      expiresAt: Date.now() + ttlMs,
    });
    logger.debug(
      { repoPath, sha: sha.slice(0, 8), ttlMs },
      "Agent commit marked for attribution",
    );
    this.cleanupCommits();
  }

  isAgentCommit(repoPath: string, sha: string): boolean {
    if (!sha) return false;
    const key = this.commitKey(repoPath, sha);
    const entry = this.recentCommits.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.recentCommits.delete(key);
      return false;
    }
    return true;
  }

  private commitKey(repoPath: string, sha: string): string {
    // Normalise: trailing slash and case differences should hit the same
    // bucket. `realpathSync` (symlink resolution) is intentionally out of
    // scope — audit follow-up H12 covers it.
    return `${repoPath.replace(/\/+$/, "")}::${sha.toLowerCase()}`;
  }

  private cleanupCommits(now = Date.now()): void {
    for (const [key, entry] of this.recentCommits.entries()) {
      if (entry.expiresAt <= now) this.recentCommits.delete(key);
    }
  }
}
