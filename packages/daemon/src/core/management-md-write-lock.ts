import { randomUUID } from "node:crypto";
import { createLogger } from "../logging.js";

const logger = createLogger("management-md-write-lock");

/**
 * `policies/management.md` write-lock manager — docs/design/21-management-
 * registry-and-entities.md §11.1.
 *
 * Mirrors the {@link InMemoryTodayWriteLockManager} pattern (see
 * `today-write-lock.ts`): a single in-process holder, an auto-release
 * timer, and a UUID lock-id that callers MUST present back to release.
 *
 * The registry's render+write path acquires the lock for the duration
 * of (render → atomic write → snapshot) so a competing API write or
 * boot reconciler cannot interleave between the steps. A single-vault,
 * single-daemon deployment makes an in-memory lock sufficient — the
 * file is not edited from a sibling process. If multi-daemon access is
 * ever introduced, swap the implementation for a `flock(2)`-backed one
 * matching `migration-lock` semantics.
 *
 * Default timeout: 5 s, matching the design's call-out and the existing
 * `pendingSelfWrites` window in `core/management-md.ts`. The render +
 * snapshot step is dominated by JSON serialization and a single small
 * write, so 5 s is generous; the auto-release exists only as a backstop
 * against a caller that crashes mid-critical-section without releasing.
 */
export const MANAGEMENT_MD_WRITE_LOCK_TIMEOUT_MS = 5_000;

export interface ManagementMdWriteLockManager {
  acquire(): { ok: true; lockId: string } | { ok: false; holder: string };
  release(lockId: string): boolean;
  isHeldBy(lockId?: string | null): boolean;
  getHolder(): string | null;
}

export class InMemoryManagementMdWriteLockManager
  implements ManagementMdWriteLockManager
{
  private holder: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly timeoutMs: number = MANAGEMENT_MD_WRITE_LOCK_TIMEOUT_MS) {}

  acquire(): { ok: true; lockId: string } | { ok: false; holder: string } {
    if (this.holder) {
      logger.debug(
        { existingHolder: this.holder },
        "management.md write lock acquire rejected — already held",
      );
      return { ok: false, holder: this.holder };
    }
    const lockId = randomUUID();
    this.holder = lockId;
    this.timer = setTimeout(() => {
      logger.warn(
        { lockId: this.holder, timeoutMs: this.timeoutMs },
        "management.md write lock expired by timeout — releasing",
      );
      this.holder = null;
      this.timer = null;
    }, this.timeoutMs);
    // The auto-release timer must not pin the event loop in tests or
    // when the daemon is otherwise quiescent.
    this.timer.unref?.();
    logger.debug({ lockId }, "management.md write lock acquired");
    return { ok: true, lockId };
  }

  release(lockId: string): boolean {
    if (!this.holder || this.holder !== lockId) return false;
    this.holder = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.debug({ lockId }, "management.md write lock released");
    return true;
  }

  isHeldBy(lockId?: string | null): boolean {
    if (!this.holder) return false;
    return this.holder === lockId;
  }

  getHolder(): string | null {
    return this.holder;
  }
}

/**
 * Run `fn` while holding the write lock. Releases on both success and
 * thrown exceptions so a partial render cannot strand the file.
 *
 * Returns `null` when the lock is currently held by another caller —
 * the registry boot path treats this as "another acquirer is mid-write,
 * skip the boot re-render and let theirs land". The watcher's hot path
 * uses the same shape to back off cleanly.
 */
export async function withManagementMdWriteLock<T>(
  manager: ManagementMdWriteLockManager,
  fn: () => Promise<T> | T,
): Promise<{ ok: true; value: T } | { ok: false; holder: string }> {
  const acquired = manager.acquire();
  if (!acquired.ok) return acquired;
  try {
    const value = await fn();
    return { ok: true, value };
  } finally {
    manager.release(acquired.lockId);
  }
}
