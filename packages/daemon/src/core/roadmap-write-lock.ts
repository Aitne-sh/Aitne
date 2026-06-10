import { randomUUID } from "node:crypto";
import { createLogger } from "../logging.js";

const logger = createLogger("roadmap-write-lock");

/**
 * Cross-request exclusive lock for `roadmap.md` writes.
 *
 * Mirrors `today-write-lock.ts` (see ROADMAP-REDESIGN.md §3.6). The
 * dispatcher acquires it at the start of a `routine.roadmap_refresh`
 * run and injects the resulting lockId into the session context as
 * `<roadmap_write_lock_id>`. Any other flow attempting a write to
 * `/api/context/roadmap` while the lock is held without passing the
 * matching `X-Lock-Id` header receives a 409 so it can retry, rather
 * than silently interleaving with a mid-session refresh.
 *
 * Scope: serializes PUT/PATCH/snapshot-restore on the `roadmap`
 * context path across concurrent *sessions* (e.g. hourly-triggered
 * refresh vs. DM handler PATCH). The in-route async mutex in
 * `context.ts` already serializes individual HTTP requests within a
 * single daemon process; the cross-request lock adds the stronger
 * "one session at a time" guarantee.
 */
export interface RoadmapWriteLockManager {
  acquire(): { ok: true; lockId: string } | { ok: false; holder: string };
  release(lockId: string): boolean;
  isHeldBy(lockId?: string | null): boolean;
  getHolder(): string | null;
}

export class InMemoryRoadmapWriteLockManager implements RoadmapWriteLockManager {
  private holder: string | null = null;
  private expiresAtMs = 0;

  constructor(private readonly timeoutMs: number) {}

  // Wall-clock lazy expiry — mirrors today-write-lock.ts. A setTimeout
  // here would freeze across machine sleep (monotonic clock) and hold
  // the lock long past its TTL after wake.
  private expireIfStale(): void {
    if (this.holder && Date.now() >= this.expiresAtMs) {
      logger.warn({ lockId: this.holder }, "Roadmap write lock expired by timeout");
      this.holder = null;
    }
  }

  acquire(): { ok: true; lockId: string } | { ok: false; holder: string } {
    this.expireIfStale();
    if (this.holder) {
      logger.debug({ existingHolder: this.holder }, "Lock acquire rejected — already held");
      return { ok: false, holder: this.holder };
    }

    const lockId = randomUUID();
    this.holder = lockId;
    this.expiresAtMs = Date.now() + this.timeoutMs;

    logger.debug({ lockId }, "Roadmap write lock acquired");
    return { ok: true, lockId };
  }

  release(lockId: string): boolean {
    this.expireIfStale();
    if (!this.holder || this.holder !== lockId) {
      return false;
    }

    this.holder = null;
    logger.debug({ lockId }, "Roadmap write lock released");
    return true;
  }

  isHeldBy(lockId?: string | null): boolean {
    this.expireIfStale();
    if (!this.holder) {
      return false;
    }
    return this.holder === lockId;
  }

  getHolder(): string | null {
    this.expireIfStale();
    return this.holder;
  }
}

/**
 * Timeout derivation — matches `getTodayWriteLockTimeoutMs` semantics
 * (2× the per-execute wall-clock plus a 10-minute safety margin) so a
 * single long refresh session can never outlive its own lock.
 */
export function getRoadmapWriteLockTimeoutMs(executeTimeoutMinutes: number): number {
  const normalizedMinutes =
    Number.isFinite(executeTimeoutMinutes) && executeTimeoutMinutes >= 0
      ? executeTimeoutMinutes
      : 60;
  return (normalizedMinutes * 2 + 10) * 60 * 1000;
}
