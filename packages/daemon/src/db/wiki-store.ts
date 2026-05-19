import type Database from "better-sqlite3";

export function isWikiEnabled(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM wiki_workspaces WHERE active = 1`,
    )
    .get() as { count: number } | undefined;
  // SQLite's COUNT(*) always returns a non-null row, so the `??` fallback
  // is defensive — `row` is never undefined here in practice.
  /* c8 ignore next */
  return (row?.count ?? 0) > 0;
}

