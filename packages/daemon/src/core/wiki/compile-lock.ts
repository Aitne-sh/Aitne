/**
 * Workspace-scoped in-process lock for `wiki.compile` sessions.
 *
 * WIKI_BUILDER_DESIGN.md §3.5 / §14 Q4 — "Second `!compile` mid-`!compile`
 * → returns 409 `compile_in_progress` with the running session's id.
 * Compiles are not queued: a queued compile would land on a vault state
 * already reflecting the queued user's intent (because the in-progress
 * run picked up the same raw items), producing duplicate work."
 *
 * Design:
 *   - The bang handler calls `tryAcquireWikiCompileLock` at enqueue
 *     time. The lock is held until the dispatcher releases it via
 *     `releaseWikiCompileLock` in `executeDefault`'s `finally` block.
 *   - The lock is purely in-process; that matches the dispatcher's
 *     existing concurrency invariants (`hourlyCheckInProgress`,
 *     `morningRoutineActive` are also in-memory flags). A second
 *     daemon process would not see the lock — but the daemon is
 *     single-process by design.
 *   - TTL fallback: an unreleased lock older than 1h is treated as
 *     orphaned (daemon crashed before release, or a session legitimately
 *     ran longer than any wiki.compile budget envelope tolerates). The
 *     next acquire succeeds and overwrites the stale entry. Without
 *     this, a crash mid-compile would block all future `!compile` calls
 *     for that workspace until the next daemon restart.
 */

const LOCK_TTL_MS = 60 * 60 * 1000;

export interface WikiCompileLockHolder {
  workspace: string;
  startedAt: Date;
  correlationId?: string;
}

const inFlight = new Map<string, WikiCompileLockHolder>();

export type WikiCompileLockAcquireResult =
  | { ok: true }
  | { ok: false; holder: WikiCompileLockHolder };

export function tryAcquireWikiCompileLock(
  workspace: string,
  correlationId?: string,
  now: Date = new Date(),
): WikiCompileLockAcquireResult {
  const existing = inFlight.get(workspace);
  if (existing) {
    const age = now.getTime() - existing.startedAt.getTime();
    if (age < LOCK_TTL_MS) {
      return { ok: false, holder: existing };
    }
    // Stale — overwrite below.
  }
  const holder: WikiCompileLockHolder = {
    workspace,
    startedAt: now,
    ...(correlationId ? { correlationId } : {}),
  };
  inFlight.set(workspace, holder);
  return { ok: true };
}

export function releaseWikiCompileLock(workspace: string): void {
  inFlight.delete(workspace);
}

export function getWikiCompileLockHolder(
  workspace: string,
): WikiCompileLockHolder | null {
  return inFlight.get(workspace) ?? null;
}

/** Test helper — wipes the lock state. Never call outside test setup. */
export function __resetWikiCompileLockForTests(): void {
  inFlight.clear();
}
