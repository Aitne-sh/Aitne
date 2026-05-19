/**
 * Per-path async mutex serializing read-modify-write operations on a
 * repository overview.md.
 *
 * Two writers race on the file:
 *
 *   - `appendOverviewDailyLog` (called by `runRepositoryManagementScan`)
 *     reads overview.md, removes the same-day daily-log line, prepends a
 *     fresh summary, refreshes the `updated:` field, and atomically
 *     replaces the file.
 *   - `runRepositoryArchitectureSectionReplace` (called by the agent's
 *     `PUT /api/repositories/:id/architecture-section` chokepoint) reads
 *     overview.md, replaces the marker-bracketed `## Architecture`
 *     block, refreshes frontmatter, and atomically replaces the file.
 *
 * Each individual `writeFileAtomically` is symlink-safe and the rename
 * boundary is atomic, but the surrounding read → modify → write
 * sequence is not. With two interleaved sequences a second write can
 * clobber the first:
 *
 *   T1 scan:                read v0 → modify (add daily log) → write v1
 *   T2 arch-replace:                          read v0 → modify (replace arch) → write v2
 *
 * v2 was computed against v0 and overwrites v1 — the daily log update
 * vanishes. The mirrored ordering loses the architecture section
 * instead. Today both functions are entirely synchronous, so Node's
 * single-threaded execution prevents interleaving by accident; this
 * lock is defense in depth so any future change that introduces an
 * `await` between read and write cannot silently re-open the race.
 *
 * The lock is per-`absolutePath` so concurrent updates to two different
 * repositories' overview files don't serialize on each other. The map
 * size is bounded by the number of managed repositories — small and
 * stable — so we don't bother evicting tail entries.
 */

const tails = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after every previously queued operation on `path` has
 * settled. The previous chain's rejection does not skip our turn — we
 * pass `fn` to both `then` slots so the queue keeps draining even if
 * an earlier critical section threw. Our own rejection is silenced on
 * the stored tail (via `.catch`) so it doesn't poison later callers,
 * but is still propagated to *our* caller through the returned
 * promise.
 */
export async function withOverviewWriteLock<T>(
  path: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const previous = tails.get(path) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  tails.set(path, next.catch(() => undefined));
  return next;
}

/** Test-only: drop all queued work. Never call from production code. */
export function _resetOverviewWriteLocksForTests(): void {
  tails.clear();
}
