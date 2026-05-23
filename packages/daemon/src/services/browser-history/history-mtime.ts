import { stat } from "node:fs/promises";

// Chromium's `History` is a SQLite database. Both journaling modes route
// writes through sibling files, so the main `History` file's mtime can
// lag actual write activity by hours or days:
//
//   * WAL mode (Chromium's default on most platforms) — writes land in
//     `History-wal`; the main file's mtime advances only on checkpoint,
//     which under light activity may not happen for days.
//   * Rollback-journal mode (some Chromium forks and post-corruption
//     fallbacks) — a `History-journal` exists for the duration of each
//     transaction and is deleted on commit. Long-lived transactions
//     hold `History`'s mtime fixed at the last commit.
//
// Stat'ing only `History` therefore mis-flags an actively-used profile
// as stale. Callers that want a "is this DB being touched?" signal must
// consider the family. `-shm` is intentionally excluded — it moves on
// read-only opens, which would over-trigger "fresh" on a Chrome that
// opened the DB but isn't writing.
export const HISTORY_FAMILY_SUFFIXES = ["", "-wal", "-journal"] as const;

/**
 * Returns the newest mtime (in ms since epoch) across `historyPath`,
 * `<historyPath>-wal`, and `<historyPath>-journal`, or null if none of
 * them exist. Missing siblings are silently ignored — they're optional
 * by SQLite design.
 */
export async function freshestHistoryMtimeMs(historyPath: string): Promise<number | null> {
  const candidates = await Promise.all(
    HISTORY_FAMILY_SUFFIXES.map((suffix) =>
      stat(`${historyPath}${suffix}`)
        .then((s) => s.mtimeMs)
        .catch(() => null),
    ),
  );
  return candidates.reduce<number | null>(
    (acc, m) => (m === null ? acc : acc === null ? m : Math.max(acc, m)),
    null,
  );
}
