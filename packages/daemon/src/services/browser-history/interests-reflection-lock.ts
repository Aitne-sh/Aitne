import { createLogger } from "../../logging.js";

/**
 * WEEKLY_INTERESTS_REFLECTION_PLAN.md §10.3 — courtesy mutex serialising
 * `refreshInterestsReflection` against `cleanupInterestsReflection`.
 *
 * Both helpers are synchronous in this codebase, and the Node event
 * loop is single-threaded, so two same-tick invocations cannot
 * physically interleave. The lock exists for three forward-looking
 * reasons:
 *
 *   1. The design specifies a per-feature write lock that serialises a
 *      same-minute re-run (e.g. scheduler tick overlapping a dashboard
 *      "Refresh now" click). The implementation must honour the
 *      contract even if Node single-thread makes the lock effectively a
 *      no-op today — otherwise a later async rewrite of the helpers
 *      would silently lose the serialisation guarantee.
 *   2. The lock makes contention an explicit, observable error
 *      (`InterestsReflectionLockBusyError`) rather than a silent
 *      "lost update" if the implementation ever moves to async FS.
 *   3. The retry shape (§20 testing strategy — "retry once after 250ms")
 *      lives here so callers don't reinvent it.
 *
 * The lock holder is identified by a free-form `holder` string
 * (`"refresh:scheduler"` / `"refresh:dashboard"` / `"cleanup:dashboard"`
 * / `"refresh:test"` / …) so a contention error tells the operator who
 * was already running. Identity is for diagnostics only — the lock has
 * no caller-token semantics.
 */

const logger = createLogger("interests-reflection-lock");

export class InterestsReflectionLockBusyError extends Error {
  constructor(
    public readonly attemptedBy: string,
    public readonly heldBy: string,
  ) {
    super(
      `Interests reflection lock busy: '${attemptedBy}' attempted while '${heldBy}' was running`,
    );
    this.name = "InterestsReflectionLockBusyError";
  }
}

let currentHolder: string | null = null;

/**
 * Synchronously acquire the lock. Returns a release callback the caller
 * MUST invoke in a `finally` block — without it the lock leaks and
 * every subsequent reflection attempt throws
 * `InterestsReflectionLockBusyError`.
 *
 * The retry contract is one-shot: this function does NOT internally
 * sleep — sync callers cannot block the event loop responsibly. The
 * dashboard route wraps the call in a 250ms async retry; the scheduler
 * pre-hook treats contention as a journal-line and moves on (the same
 * data will refresh on the next cron tick).
 */
export function acquireInterestsReflectionLock(holder: string): () => void {
  if (currentHolder !== null) {
    logger.debug(
      { attemptedBy: holder, heldBy: currentHolder },
      "Interests reflection lock contention",
    );
    throw new InterestsReflectionLockBusyError(holder, currentHolder);
  }
  currentHolder = holder;
  let released = false;
  return function release(): void {
    if (released) return;
    released = true;
    if (currentHolder !== holder) {
      // Defensive: a stale release call after the lock was force-cleared
      // or re-acquired must not nuke an unrelated holder.
      logger.warn(
        { holder, currentHolder },
        "Interests reflection lock release ignored — holder mismatch",
      );
      return;
    }
    currentHolder = null;
  };
}

/**
 * Test-only escape hatch: reset the lock state regardless of holder.
 * Production code must not use this — the proper teardown is the
 * `release` callback returned by `acquireInterestsReflectionLock`.
 */
export function _resetInterestsReflectionLockForTests(): void {
  currentHolder = null;
}

/** Current holder string, or `null` when the lock is free. */
export function peekInterestsReflectionLockHolder(): string | null {
  return currentHolder;
}
