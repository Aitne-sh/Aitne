import { randomUUID } from "node:crypto";
import { createLogger } from "../logging.js";

const logger = createLogger("today-write-lock");

export interface TodayWriteLockManager {
  acquire(): { ok: true; lockId: string } | { ok: false; holder: string };
  release(lockId: string): boolean;
  isHeldBy(lockId?: string | null): boolean;
  getHolder(): string | null;
}

export class InMemoryTodayWriteLockManager implements TodayWriteLockManager {
  private holder: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly timeoutMs: number) {}

  acquire(): { ok: true; lockId: string } | { ok: false; holder: string } {
    if (this.holder) {
      logger.debug({ existingHolder: this.holder }, "Lock acquire rejected — already held");
      return { ok: false, holder: this.holder };
    }

    const lockId = randomUUID();
    this.holder = lockId;
    this.timer = setTimeout(() => {
      logger.warn({ lockId: this.holder }, "Today write lock expired by timeout");
      this.holder = null;
      this.timer = null;
    }, this.timeoutMs);

    logger.debug({ lockId }, "Today write lock acquired");
    return { ok: true, lockId };
  }

  release(lockId: string): boolean {
    if (!this.holder || this.holder !== lockId) {
      return false;
    }

    this.holder = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.debug({ lockId }, "Today write lock released");
    return true;
  }

  isHeldBy(lockId?: string | null): boolean {
    if (!this.holder) {
      return false;
    }
    return this.holder === lockId;
  }

  getHolder(): string | null {
    return this.holder;
  }
}

export function getTodayWriteLockTimeoutMs(executeTimeoutMinutes: number): number {
  const normalizedMinutes =
    Number.isFinite(executeTimeoutMinutes) && executeTimeoutMinutes >= 0
      ? executeTimeoutMinutes
      : 60;
  return (normalizedMinutes * 2 + 10) * 60 * 1000;
}

/**
 * Exclusive cross-request lock — the migration endpoint holds this for the
 * duration of a `/api/setup/migrate-context` run so a second concurrent
 * migration returns 409 immediately instead of interleaving with the
 * first. Same acquire/release/holder shape as `TodayWriteLockManager` but
 * uses a long default timeout because migrations may legitimately take
 * minutes on large cross-fs copies.
 */
export class MigrationLock {
  private holder: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly timeoutMs: number) {}

  acquire(): { ok: true; lockId: string } | { ok: false; holder: string } {
    if (this.holder) {
      logger.debug({ existingHolder: this.holder }, "Migration lock rejected — already held");
      return { ok: false, holder: this.holder };
    }
    const lockId = randomUUID();
    this.holder = lockId;
    this.timer = setTimeout(() => {
      logger.warn({ lockId: this.holder }, "Migration lock expired by timeout");
      this.holder = null;
      this.timer = null;
    }, this.timeoutMs);
    logger.debug({ lockId }, "Migration lock acquired");
    return { ok: true, lockId };
  }

  release(lockId: string): boolean {
    if (!this.holder || this.holder !== lockId) {
      return false;
    }
    this.holder = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.debug({ lockId }, "Migration lock released");
    return true;
  }

  isHeld(): boolean {
    return this.holder !== null;
  }

  getHolder(): string | null {
    return this.holder;
  }
}

/**
 * Global context-write gate — engaged by the migration endpoint while the
 * primary store is mid-move so every `/api/context/*` write handler (plus
 * internal writers that opt into the check) refuses with 503. Unlike
 * `TodayWriteLockManager` / `MigrationLock`, there is no caller identity:
 * this is a pure on/off flag. In-memory is sufficient because a daemon
 * restart itself clears the gate, and the migration endpoint guarantees
 * it disengages the gate in its resume/rollback paths.
 *
 * The 503 surface matches degraded mode's `primary_vault_unreachable`
 * shape so clients can reuse the same retry logic, but the `reason`
 * differentiates the two ("migration_in_progress" vs
 * "primary_vault_unreachable").
 *
 * Plan §6.2 step 4 cron-tick suppressor integration point — any cron
 * handler that performs direct filesystem I/O against the primary
 * context dir without going through ObserverManager (stopped via
 * pauseAll) or EventBus (paused via pauseDispatch) SHOULD read
 * `isEngaged()` at fire time and yield when true. Today all known
 * handlers go through one of the two pause layers, so the flag is
 * reserved for future handlers that don't.
 */
export class ContextWriteGate {
  private engaged = false;
  private reason: string | null = null;
  private since: string | null = null;

  engage(reason: string): void {
    if (this.engaged) {
      logger.warn({ existingReason: this.reason, newReason: reason }, "Context write gate already engaged");
      return;
    }
    this.engaged = true;
    this.reason = reason;
    this.since = new Date().toISOString();
    logger.info({ reason }, "Context write gate engaged");
  }

  disengage(): void {
    if (!this.engaged) return;
    logger.info({ previousReason: this.reason }, "Context write gate disengaged");
    this.engaged = false;
    this.reason = null;
    this.since = null;
  }

  isEngaged(): boolean {
    return this.engaged;
  }

  getState(): { engaged: boolean; reason: string | null; since: string | null } {
    return { engaged: this.engaged, reason: this.reason, since: this.since };
  }
}
