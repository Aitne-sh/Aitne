import Database from "better-sqlite3";

export interface ChromiumHistorySummary {
  visitCount: number;
  latestVisitTime: number | null;
  hasContextAnnotations: boolean;
}

export interface ChromiumVisitRow {
  visitId: number;
  url: string;
  title: string | null;
  visitTimeMs: number;
  transition: number;
  rootTaskId: number | null;
  foregroundSec: number | null;
  durationSinceLastVisitSec: number | null;
  httpStatus: number | null;
  searchTerm: string | null;
}

/**
 * Chromium stores timestamps as microseconds since 1601-01-01 UTC.
 * Convert to standard UNIX epoch milliseconds. Chromium-epoch zero is
 * `11644473600000` ms before the UNIX epoch.
 */
const CHROMIUM_EPOCH_MS_OFFSET = 11_644_473_600_000;

function chromiumTimeToMs(value: number | bigint | null): number {
  if (value === null || value === undefined) return 0;
  const numeric = typeof value === "bigint" ? Number(value) : value;
  return Math.floor(numeric / 1000) - CHROMIUM_EPOCH_MS_OFFSET;
}

function msToChromiumTime(ms: number): number {
  return (ms + CHROMIUM_EPOCH_MS_OFFSET) * 1000;
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(name);
  return !!row;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

export function assertChromiumHistorySchema(dbPath: string): ChromiumHistorySummary {
  const db = new Database(dbPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    if (!tableExists(db, "urls") || !tableExists(db, "visits")) {
      throw new Error("missing required urls/visits tables");
    }
    for (const [table, column] of [
      ["urls", "id"],
      ["urls", "url"],
      ["urls", "title"],
      ["visits", "id"],
      ["visits", "url"],
      ["visits", "visit_time"],
      ["visits", "transition"],
    ] as const) {
      if (!hasColumn(db, table, column)) {
        throw new Error(`missing required column ${table}.${column}`);
      }
    }
    const visitCountRow = db
      .prepare("SELECT COUNT(*) AS count, MAX(visit_time) AS latest FROM visits")
      .get() as { count: number; latest: number | null };
    const hasContextAnnotations =
      tableExists(db, "context_annotations")
      && hasColumn(db, "context_annotations", "visit_id");
    return {
      visitCount: visitCountRow.count,
      latestVisitTime: visitCountRow.latest,
      hasContextAnnotations,
    };
  } finally {
    db.close();
  }
}

export interface ReadChromiumVisitsOptions {
  sinceMs: number;
  limit: number;
}

interface RawChromiumVisitRow {
  visit_id: number;
  url: string;
  title: string | null;
  visit_time: number | bigint;
  transition: number;
  root_task_id: number | null;
  total_foreground_duration: number | bigint | null;
  duration_since_last_visit: number | bigint | null;
  response_code: number | null;
  search_term: string | null;
}

/**
 * Read Chromium visits newer than `sinceMs` from a previously snapshotted
 * History database. Joins `urls`, `visits`, `context_annotations`, and
 * `keyword_search_terms` so the caller receives a single denormalized row
 * per visit. The reader gracefully degrades when `context_annotations`
 * is absent (older Chromium builds and some forks).
 */
export function readChromiumVisits(
  dbPath: string,
  options: ReadChromiumVisitsOptions,
): ChromiumVisitRow[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const sinceChromiumTime = msToChromiumTime(Math.max(0, options.sinceMs));
    const hasContextAnnotations =
      tableExists(db, "context_annotations")
      && hasColumn(db, "context_annotations", "visit_id");
    const hasKeywordSearch = tableExists(db, "keyword_search_terms");

    const select = hasContextAnnotations
      ? `
          SELECT
            v.id AS visit_id,
            u.url AS url,
            u.title AS title,
            v.visit_time AS visit_time,
            v.transition AS transition,
            ca.root_task_id AS root_task_id,
            ca.total_foreground_duration AS total_foreground_duration,
            ca.duration_since_last_visit AS duration_since_last_visit,
            ca.response_code AS response_code,
            ${hasKeywordSearch ? "kst.term" : "NULL"} AS search_term
          FROM visits v
          INNER JOIN urls u ON u.id = v.url
          LEFT JOIN context_annotations ca ON ca.visit_id = v.id
          ${hasKeywordSearch ? "LEFT JOIN keyword_search_terms kst ON kst.url_id = u.id" : ""}
          WHERE v.visit_time > ?
          ORDER BY v.visit_time ASC
          LIMIT ?
        `
      : `
          SELECT
            v.id AS visit_id,
            u.url AS url,
            u.title AS title,
            v.visit_time AS visit_time,
            v.transition AS transition,
            NULL AS root_task_id,
            NULL AS total_foreground_duration,
            NULL AS duration_since_last_visit,
            NULL AS response_code,
            ${hasKeywordSearch ? "kst.term" : "NULL"} AS search_term
          FROM visits v
          INNER JOIN urls u ON u.id = v.url
          ${hasKeywordSearch ? "LEFT JOIN keyword_search_terms kst ON kst.url_id = u.id" : ""}
          WHERE v.visit_time > ?
          ORDER BY v.visit_time ASC
          LIMIT ?
        `;

    const rows = db.prepare(select).all(sinceChromiumTime, options.limit) as RawChromiumVisitRow[];
    return rows.map((row) => ({
      visitId: row.visit_id,
      url: row.url,
      title: row.title,
      visitTimeMs: chromiumTimeToMs(row.visit_time),
      transition: row.transition,
      rootTaskId: row.root_task_id ?? null,
      foregroundSec:
        row.total_foreground_duration === null || row.total_foreground_duration === undefined
          ? null
          : Math.max(
              0,
              Math.floor(
                Number(row.total_foreground_duration) / 1_000_000,
              ),
            ),
      durationSinceLastVisitSec:
        row.duration_since_last_visit === null || row.duration_since_last_visit === undefined
          ? null
          : Math.max(
              0,
              Math.floor(
                Number(row.duration_since_last_visit) / 1_000_000,
              ),
            ),
      httpStatus: row.response_code ?? null,
      searchTerm: row.search_term ?? null,
    }));
  } finally {
    db.close();
  }
}
