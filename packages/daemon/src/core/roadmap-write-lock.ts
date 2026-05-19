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
      logger.warn({ lockId: this.holder }, "Roadmap write lock expired by timeout");
      this.holder = null;
      this.timer = null;
    }, this.timeoutMs);

    logger.debug({ lockId }, "Roadmap write lock acquired");
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
    logger.debug({ lockId }, "Roadmap write lock released");
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
