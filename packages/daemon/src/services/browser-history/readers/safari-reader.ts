import Database from "better-sqlite3";

export interface SafariHistorySummary {
  visitCount: number;
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(name);
  return !!row;
}

export function assertSafariHistorySchema(dbPath: string): SafariHistorySummary {
  const db = new Database(dbPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    if (!tableExists(db, "history_visits") || !tableExists(db, "history_items")) {
      throw new Error("missing required Safari history tables");
    }
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM history_visits")
      .get() as { count: number };
    return { visitCount: row.count };
  } finally {
    db.close();
  }
}
