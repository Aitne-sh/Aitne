/**
 * `serializeContextFileWrite` — daemon-wide per-absolute-path promise-chain
 * mutex. The single source of truth for "this read-modify-write block on
 * `<abs>` does not interleave with any other writer to the same path",
 * across BOTH the HTTP context routes and the in-process daemon-direct
 * writers (today-direct-writer, agent-journal-appender, roadmap-maintenance,
 * dispatcher-scheduled-tasks' weekly-interests journal appender).
 *
 * Why this exists
 * ---------------
 * Before this module landed, the HTTP route's in-router `withWriteLock`
 * serialized only HTTP-vs-HTTP writes within a single router instance.
 * Daemon-direct writers (which fire from cron ticks and scheduled-task
 * pre-hooks) ran their own `readFileSync` → mutate → `writeFileAtomically`
 * sequence with no shared coordination, so a concurrent HTTP `PATCH` and
 * a activity_scan `appendAgentLogLine` could both read the same pre-state,
 * each compute their own "next", and the second `rename` would silently
 * drop the first writer's bullet.
 *
 * The named cross-session locks (`morningRoutineLock`, `roadmapWriteLock`)
 * are NOT a substitute: they're a fast-fail X-Lock-Id gate for cross-session
 * coordination (HTTP returns 409 when held by another session), not an
 * await-the-current-writer mutex. Direct writers gracefully `acquire() →
 * skip` when the lock is held; that is acceptable for "best-effort log
 * line" callers but loses morning-routine journal entries and roadmap
 * maintenance traces when it fires.
 *
 * Contract
 * --------
 * - `fn` is invoked at most once per call, after every previously-enqueued
 *   `fn` for the same absolute path has settled.
 * - Errors thrown by `fn` propagate to the caller AND release the queue —
 *   a poisoning `fn` does not block successors.
 * - The map entry is dropped when this call is the tail of the chain, so
 *   the map's footprint tracks "paths with currently-pending writers"
 *   rather than the unbounded history.
 *
 * Multi-path acquisitions
 * -----------------------
 * Callers that need to atomically read one path and write another (e.g.
 * `POST /api/context/archive-today` rotating today.md → yesterday.md)
 * must acquire BOTH serializers, nested with a deterministic order.
 * Convention: acquire in **alphabetical order by absolute path**. The
 * fixed order prevents AB/BA deadlock against any other multi-path
 * caller that follows the same rule. Pattern:
 *
 *   return serializeContextFileWrite(pathA, () =>
 *     serializeContextFileWrite(pathB, () => { ... }));
 *
 * where `pathA < pathB` lexicographically.
 *
 * Convention for new writers
 * --------------------------
 * **Every new writer that targets a context file must go through this
 * helper.** "Context file" = any `.md` file under the configured
 * `contextDir` (see `core/context-paths.ts`). The bug class this fence
 * prevents (HTTP PATCH and a daemon-direct writer reading the same
 * pre-state and clobbering each other) re-emerges silently the moment
 * a new writer skips it. There is no compile-time enforcement — the
 * grep for `writeFileAtomically` followed by a `contextDir`-anchored
 * path is the audit signal. When adding a writer, wrap the entire
 * read-modify-write block (not just the write) so the read sees the
 * post-state of any previously-enqueued writer.
 *
 * Out of scope
 * ------------
 * - Cross-process coordination (multiple daemon processes touching the
 *   same context dir). The daemon is single-process by design; running
 *   two on one DATA_DIR is unsupported elsewhere too.
 * - Read serialization. Reads are not gated. A reader can observe an
 *   intermediate post-rename state, which is the same guarantee
 *   `writeFileAtomically` already gives.
 *
 * Resetting state in tests
 * ------------------------
 * `_resetContextFileSerializerForTesting()` clears the in-flight map so
 * a test that exercises the queue can start from a known state in the
 * next test. Production code MUST NOT call it.
 */

const pendingWrites = new Map<string, Promise<unknown>>();

export async function serializeContextFileWrite<T>(
  absolutePath: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const previous = pendingWrites.get(absolutePath) ?? Promise.resolve();

  // The chain pattern: each caller awaits its predecessor (swallowing
  // the predecessor's error so a poisoning fn does not block successors)
  // and then runs its own `fn`. The map stores the "outer" Promise that
  // resolves only after this call's `fn` settles, so the next caller
  // chains onto it.
  let resolveSelf!: () => void;
  const self = new Promise<void>((resolve) => {
    resolveSelf = resolve;
  });
  pendingWrites.set(absolutePath, self);

  try {
    await previous.catch(() => {
      // Predecessor errors are surfaced to the predecessor's caller —
      // we deliberately do not propagate them here, so a single
      // poisoning fn does not cascade through the queue.
    });
    return await fn();
  } finally {
    resolveSelf();
    // Drop the map entry when we're the tail. If a later caller has
    // already chained on, `pendingWrites.get(absolutePath)` !== `self`
    // and we leave the map alone.
    if (pendingWrites.get(absolutePath) === self) {
      pendingWrites.delete(absolutePath);
    }
  }
}

/**
 * Test-only reset. Production callers MUST NOT invoke this — clearing
 * the map mid-flight would let two writers run concurrently against the
 * same path, which is the exact bug this module exists to prevent.
 */
export function _resetContextFileSerializerForTesting(): void {
  pendingWrites.clear();
}

/**
 * Test-only inspector. Returns the number of paths with at least one
 * pending writer. Exposed so tests can assert the map shrinks back to
 * zero after the chain drains, catching map-leak regressions.
 */
export function _pendingPathCountForTesting(): number {
  return pendingWrites.size;
}
