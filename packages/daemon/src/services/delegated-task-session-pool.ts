import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BackendId, IntegrationKey } from "@aitne/shared";
import { createLogger } from "../logging.js";

const logger = createLogger("delegated-task-session-pool");

/**
 * DELEGATED-TASK-MODE-DESIGN.md §13 Phase 3.2 — session-dir warm cache.
 *
 * Why this is a "session-dir pool" and NOT a "subprocess pool":
 *   - Claude Agent SDK 0.2.98's V2 `SDKSession` (warm-resume API) is alpha.
 *   - §15-5 requires "clear conversation between tasks" anyway — keeping a
 *     live session would force per-task conversation reset, which collapses
 *     the value of warm-reuse on Claude.
 *   - Gemini CLI 0.40.0's `--prompt` mode is one-shot; there is no live
 *     stdin protocol that lets us slip a second task into the same process.
 *
 * What we CAN safely reuse: the materialized session **directory**. The
 * proxy profile (`CLAUDE.md` / `GEMINI.md`) and the chmod 0700 dir cost
 * tens of milliseconds per call to materialize. Reusing the dir saves
 * that cost for rapid sequential tasks (e.g. an agent running three
 * Gmail searches in a row).
 *
 * Per-task allowedTools / admin-policy TOML are still rewritten per call
 * (Claude passes them through SDK args; Gemini overwrites the TOML in
 * `runDelegatedTask`), so write-class state never leaks between tasks.
 *
 * Entries are keyed by `(backendId, integrationKey | "run", modelId)`.
 * `allowDestructive` is intentionally NOT in the key — it changes
 * allowedTools but those are wired per-call, not per-dir, so two calls
 * with different `allowDestructive` can share a dir safely.
 */

export interface SessionPoolKey {
  backendId: BackendId;
  /** `null` for `/api/delegated/run` calls (no integration). */
  integrationKey: IntegrationKey | null;
  modelId: string;
}

export interface SessionPoolOptions {
  /** Idle TTL — entry is evictable after this many ms past `releasedAt`. */
  ttlMs: number;
  /**
   * Hard cap on idle entries. Defaults to `delegatedProxyMaxConcurrent` so
   * the pool can never strand more dirs than the concurrency surface.
   */
  maxIdle: number;
  /**
   * Filesystem materialiser. The invoker passes its `materializeProxySession`
   * as a callback so the pool stays decoupled from the agent-profile path
   * resolution + fallback profile body.
   */
  materializer: (sessionDir: string, backendId: BackendId) => void;
  /** Tempdir basename prefix — distinct from the proxy- prefix so the boot
   *  janitor can target pool-orphans separately. */
  tempdirPrefix: string;
  /**
   * Sessions root (e.g. `<dataDir>/agent-sessions`). The pool creates dirs
   * directly under this. Cleanup uses `rmSync(recursive, force)`.
   */
  sessionsRoot: string;
  /** Now-source for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

interface PooledEntry {
  hashKey: string;
  backendId: BackendId;
  integrationKey: IntegrationKey | null;
  modelId: string;
  sessionDir: string;
  /** Wall-clock ms when the dir became idle (release time). */
  releasedAt: number;
  /** True while a task is using this entry — cannot be evicted. */
  inUse: boolean;
}

/**
 * Acquire-release lifecycle:
 *
 *   const lease = pool.acquire(key);  // creates + materializes if no idle entry
 *   try {
 *     await runDelegatedTask({ sessionDir: lease.sessionDir, ... });
 *   } finally {
 *     pool.release(lease);              // returns to idle pool with TTL
 *     // OR
 *     pool.discard(lease);              // dir is already gone (e.g. SIGKILL)
 *   }
 *
 * The pool is opt-in via `delegatedTaskSubprocessPoolEnabled`. When the
 * invoker is configured without the pool, every call goes through the
 * pre-Phase-3 path: makeTempdir → materialize → cleanup.
 */
export class DelegatedTaskSessionPool {
  private readonly entries: PooledEntry[] = [];
  private readonly opts: SessionPoolOptions;
  private readonly now: () => number;

  constructor(options: SessionPoolOptions) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error(
        `DelegatedTaskSessionPool: ttlMs must be > 0 (got ${options.ttlMs})`,
      );
    }
    if (!Number.isFinite(options.maxIdle) || options.maxIdle <= 0) {
      throw new Error(
        `DelegatedTaskSessionPool: maxIdle must be > 0 (got ${options.maxIdle})`,
      );
    }
    this.opts = options;
    this.now = options.now ?? Date.now;
  }

  /**
   * Hash the pool key into a comparable string. Exposed for tests +
   * eviction matching.
   */
  static hashKey(key: SessionPoolKey): string {
    return [
      key.backendId,
      key.integrationKey ?? "run",
      key.modelId,
    ].join("|");
  }

  /**
   * Acquire a session dir. Reuses an idle entry when possible; otherwise
   * creates a fresh tempdir and materializes the proxy profile. Either
   * path returns a lease the caller MUST release or discard.
   *
   * Pruning happens lazily on every acquire — cheap because the entries
   * array is bounded at `maxIdle` (default 4).
   */
  acquire(key: SessionPoolKey): SessionPoolLease {
    this.pruneExpired();
    const hash = DelegatedTaskSessionPool.hashKey(key);
    for (const entry of this.entries) {
      if (entry.inUse) continue;
      if (entry.hashKey !== hash) continue;
      if (!existsSync(entry.sessionDir)) {
        // Lost the directory between release and re-acquire (e.g. external
        // janitor swept it). Drop the entry and fall through to a fresh
        // materialize. This is a defensive path; production should never
        // hit it because the pool's own janitor is the only thing
        // expected to remove dirs in this prefix.
        const idx = this.entries.indexOf(entry);
        if (idx >= 0) this.entries.splice(idx, 1);
        break;
      }
      entry.inUse = true;
      return new SessionPoolLease(this, entry, /* fromPool */ true);
    }
    // No reusable entry — materialize fresh.
    const sessionDir = join(
      this.opts.sessionsRoot,
      `${this.opts.tempdirPrefix}${randomUUID()}`,
    );
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    try {
      this.opts.materializer(sessionDir, key.backendId);
    } catch (err) {
      // Materialisation failed — clean up and rethrow so the caller falls
      // back to its own non-pool path. Don't add a half-materialized entry
      // to the pool.
      try {
        rmSync(sessionDir, { recursive: true, force: true });
      } catch {
        /* ignore double-cleanup */
      }
      throw err;
    }
    const entry: PooledEntry = {
      hashKey: hash,
      backendId: key.backendId,
      integrationKey: key.integrationKey,
      modelId: key.modelId,
      sessionDir,
      releasedAt: this.now(),
      inUse: true,
    };
    this.entries.push(entry);
    return new SessionPoolLease(this, entry, /* fromPool */ false);
  }

  /**
   * Mark `entry` as idle and stamp `releasedAt` so its TTL starts now.
   * If we're over `maxIdle`, evict the LRU entry to free a slot. Called
   * by `SessionPoolLease.release()`.
   */
  releaseEntry(entry: PooledEntry): void {
    entry.inUse = false;
    entry.releasedAt = this.now();
    // Evict to maxIdle. Walk in releasedAt order to drop the LRU; we
    // never evict the entry just released (it's the freshest).
    const idle = this.entries.filter((e) => !e.inUse);
    if (idle.length <= this.opts.maxIdle) return;
    idle.sort((a, b) => a.releasedAt - b.releasedAt);
    const overflow = idle.length - this.opts.maxIdle;
    for (let i = 0; i < overflow; i++) {
      this.removeEntry(idle[i]);
    }
  }

  /**
   * Caller knows the dir is gone (e.g. subprocess crashed mid-task and
   * left it in an indeterminate state). Drop without TTL semantics so
   * the next acquire materializes fresh.
   */
  discardEntry(entry: PooledEntry): void {
    this.removeEntry(entry);
  }

  /**
   * Sweep expired idle entries. Called eagerly on every acquire and by
   * the periodic janitor. Returns number of dirs removed.
   */
  pruneExpired(): number {
    const cutoff = this.now() - this.opts.ttlMs;
    let removed = 0;
    for (const entry of [...this.entries]) {
      if (entry.inUse) continue;
      if (entry.releasedAt > cutoff) continue;
      this.removeEntry(entry);
      removed += 1;
    }
    return removed;
  }

  /**
   * Drop every idle entry. Used when `delegatedTaskSubprocessPoolEnabled`
   * flips false mid-window OR when the daemon is shutting down. In-use
   * entries are left alone — they'll be removed by their lease's
   * release/discard.
   */
  evictAll(): number {
    let removed = 0;
    for (const entry of [...this.entries]) {
      if (entry.inUse) continue;
      this.removeEntry(entry);
      removed += 1;
    }
    return removed;
  }

  /** Visibility for /health.metrics. */
  stats(): { idle: number; inUse: number; total: number; maxIdle: number; ttlMs: number } {
    let inUse = 0;
    let idle = 0;
    for (const e of this.entries) {
      if (e.inUse) inUse += 1;
      else idle += 1;
    }
    return {
      idle,
      inUse,
      total: this.entries.length,
      maxIdle: this.opts.maxIdle,
      ttlMs: this.opts.ttlMs,
    };
  }

  private removeEntry(entry: PooledEntry): void {
    const idx = this.entries.indexOf(entry);
    if (idx >= 0) this.entries.splice(idx, 1);
    try {
      rmSync(entry.sessionDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        { err, sessionDir: entry.sessionDir },
        "session pool: failed to rm idle dir",
      );
    }
  }
}

/**
 * RAII-style lease the invoker holds for the duration of a task. The
 * lease object is intentionally tiny — only the sessionDir is exposed
 * to the rest of the invoker.
 */
export class SessionPoolLease {
  /** True iff this lease was satisfied by an existing pool entry. */
  readonly fromPool: boolean;
  readonly sessionDir: string;
  private released = false;

  constructor(
    private readonly pool: DelegatedTaskSessionPool,
    private readonly entry: PooledEntry,
    fromPool: boolean,
  ) {
    this.fromPool = fromPool;
    this.sessionDir = entry.sessionDir;
  }

  /**
   * Return the dir to the idle pool. Idempotent so a `finally { lease.release(); }`
   * is safe even when the caller manually called `release()` already.
   */
  release(): void {
    if (this.released) return;
    this.released = true;
    this.pool.releaseEntry(this.entry);
  }

  /**
   * Drop the entry permanently — used when the dir is in an unknown
   * state (e.g. a subprocess crash). The next acquire materializes fresh.
   * Idempotent.
   */
  discard(): void {
    if (this.released) return;
    this.released = true;
    this.pool.discardEntry(this.entry);
  }
}

/**
 * Tempdir prefix the pool uses. Distinct from the `proxy-` prefix so
 * `runProxyTempdirJanitor` doesn't sweep live pool dirs at boot. The
 * pool has its own janitor for orphans (`runDelegatedTaskSessionPoolJanitor`
 * lives in delegated-backend-invoker.ts).
 */
export const SESSION_POOL_TEMPDIR_PREFIX = "task-pool-";

/**
 * Boot-time janitor — scans `sessionsRoot` for `task-pool-*` dirs older
 * than `maxAgeMs` and removes them. Runs once at startup before any pool
 * is constructed, mirroring `runProxyTempdirJanitor` so a daemon crash
 * cannot leave orphan dirs across restarts. Returns count removed.
 */
export function runSessionPoolTempdirJanitor(
  sessionsRoot: string,
  options: { now?: () => number; maxAgeMs?: number } = {},
): number {
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? 5 * 60 * 1000;
  if (!existsSync(sessionsRoot)) return 0;
  let entries: string[];
  try {
    entries = readdirSync(sessionsRoot);
  } catch (err) {
    logger.warn({ err, sessionsRoot }, "session pool janitor: readdir failed");
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.startsWith(SESSION_POOL_TEMPDIR_PREFIX)) continue;
    const path = join(sessionsRoot, entry);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (now() - stat.mtimeMs < maxAgeMs) continue;
    try {
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch (err) {
      logger.warn({ err, path }, "session pool janitor: rm failed");
    }
  }
  if (removed > 0) {
    logger.info({ removed }, "session pool janitor: removed orphan dirs");
  }
  return removed;
}
