import type Database from "better-sqlite3";
import {
  browserHistoryCapabilitiesSchema,
  browserHistoryLifecycleStateSchema,
  browserHistoryResearchClustersResponseSchema,
  yesterdayResearchSummarySchema,
  type BrowserHistoryBrowserKey,
  type BrowserHistoryCapabilities,
  type BrowserHistoryLifecycleState,
  type BrowserHistoryResearchClustersResponse,
  type YesterdayResearchSummary,
} from "@aitne/shared";
import {
  readRuntimeState,
  writeRuntimeState,
} from "./runtime-state.js";
import type { SummarizedVisit } from "../services/browser-history/pipeline/summarizer.js";
import type { ExtractedCluster } from "../services/browser-history/pipeline/cluster-extractor.js";

export const BROWSER_HISTORY_CAPABILITIES_STATE_KEY =
  "browser_history_capabilities";
export const BROWSER_LIFECYCLE_STATE_KEY = "browser_lifecycle_state";
export const BROWSER_HISTORY_LAST_INGEST_AT_KEY =
  "browser_history_last_ingest_at";
export const BROWSER_HISTORY_INGEST_CURSORS_KEY =
  "browser_history_ingest_cursors";

export function readBrowserHistoryCapabilities(
  db: Database.Database,
): BrowserHistoryCapabilities | null {
  const value = readRuntimeState<unknown>(
    db,
    BROWSER_HISTORY_CAPABILITIES_STATE_KEY,
  );
  if (!value) return null;
  const parsed = browserHistoryCapabilitiesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function writeBrowserHistoryCapabilities(
  db: Database.Database,
  value: BrowserHistoryCapabilities,
): void {
  writeRuntimeState(db, BROWSER_HISTORY_CAPABILITIES_STATE_KEY, value);
}

export function readBrowserLifecycleState(
  db: Database.Database,
): BrowserHistoryLifecycleState {
  const value = readRuntimeState<unknown>(db, BROWSER_LIFECYCLE_STATE_KEY);
  if (!value) return {};
  const parsed = browserHistoryLifecycleStateSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

export function writeBrowserLifecycleState(
  db: Database.Database,
  value: BrowserHistoryLifecycleState,
): void {
  writeRuntimeState(db, BROWSER_LIFECYCLE_STATE_KEY, value);
}

export function readBrowserHistoryLastIngestAt(
  db: Database.Database,
): number | null {
  const value = readRuntimeState<unknown>(
    db,
    BROWSER_HISTORY_LAST_INGEST_AT_KEY,
  );
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function writeBrowserHistoryLastIngestAt(
  db: Database.Database,
  value: number,
): void {
  writeRuntimeState(db, BROWSER_HISTORY_LAST_INGEST_AT_KEY, value);
}

export function listBrowserResearchClusters(
  db: Database.Database,
): BrowserHistoryResearchClustersResponse {
  const rows = db
    .prepare(
      `SELECT
         slug,
         display_name AS displayName,
         started_at AS startedAt,
         last_activity_at AS lastActivityAt,
         visits_total AS visitsTotal,
         meaningful_visits_total AS meaningfulVisitsTotal,
         meaningful_foreground_sec_total AS meaningfulForegroundSecTotal,
         distinct_meaningful_domains AS distinctMeaningfulDomains,
         status,
         COALESCE(agent_summary_revision, 0) AS agentSummaryRevision
       FROM browser_research_clusters
       WHERE status IN ('active', 'dormant')
       ORDER BY last_activity_at DESC`,
    )
    .all();
  return browserHistoryResearchClustersResponseSchema.parse({
    clusters: rows,
    generatedAt: new Date().toISOString(),
  });
}

export function getYesterdayResearchSummary(
  date: string,
): YesterdayResearchSummary {
  return yesterdayResearchSummarySchema.parse({
    date,
    sessions: [],
  });
}

// ── Layer 1 ingestion (P2) — browser_visits + clusters + reloads + shopping ──

interface IngestCursorMap {
  [profileKey: string]: number;
}

export function browserHistoryProfileCursorKey(
  browser: BrowserHistoryBrowserKey,
  profile: string,
): string {
  return `${browser}::${profile}`;
}

export function readBrowserHistoryIngestCursors(
  db: Database.Database,
): IngestCursorMap {
  const value = readRuntimeState<unknown>(
    db,
    BROWSER_HISTORY_INGEST_CURSORS_KEY,
  );
  if (!value || typeof value !== "object") return {};
  const out: IngestCursorMap = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[key] = raw;
    }
  }
  return out;
}

export function readBrowserHistoryIngestCursor(
  db: Database.Database,
  browser: BrowserHistoryBrowserKey,
  profile: string,
): number {
  return (
    readBrowserHistoryIngestCursors(db)[
      browserHistoryProfileCursorKey(browser, profile)
    ] ?? 0
  );
}

export function writeBrowserHistoryIngestCursor(
  db: Database.Database,
  browser: BrowserHistoryBrowserKey,
  profile: string,
  cursorMs: number,
): void {
  const cursors = readBrowserHistoryIngestCursors(db);
  cursors[browserHistoryProfileCursorKey(browser, profile)] = cursorMs;
  writeRuntimeState(db, BROWSER_HISTORY_INGEST_CURSORS_KEY, cursors);
}

export interface InsertVisitsResult {
  inserted: number;
  duplicates: number;
}

const INSERT_VISIT_SQL = `
  INSERT OR IGNORE INTO browser_visits (
    ts, browser, profile, url_hash, domain, category, meaningful,
    dwell_sec, foreground_sec, transition, is_reload, root_task_id,
    http_status, title, search_query, amazon_asin, amazon_locale
  )
  VALUES (
    @ts, @browser, @profile, @urlHash, @domain, @category, @meaningful,
    @dwellSec, @foregroundSec, @transition, @isReload, @rootTaskId,
    @httpStatus, @title, @searchQuery, @amazonAsin, @amazonLocale
  )
`;

export function insertBrowserVisits(
  db: Database.Database,
  visits: readonly SummarizedVisit[],
): InsertVisitsResult {
  if (visits.length === 0) return { inserted: 0, duplicates: 0 };
  const stmt = db.prepare(INSERT_VISIT_SQL);
  let inserted = 0;
  let duplicates = 0;
  const tx = db.transaction((rows: readonly SummarizedVisit[]) => {
    for (const row of rows) {
      const info = stmt.run(row);
      if (info.changes > 0) {
        inserted += 1;
      } else {
        duplicates += 1;
      }
    }
  });
  tx(visits);
  return { inserted, duplicates };
}

const RELOAD_UPSERT_SQL = `
  INSERT INTO browser_reload_signals (date, url_pattern, reload_count)
  VALUES (?, ?, ?)
  ON CONFLICT (date, url_pattern) DO UPDATE SET
    reload_count = reload_count + excluded.reload_count
`;

export interface ReloadIncrement {
  date: string;
  urlPattern: string;
  count: number;
}

export function incrementReloadSignals(
  db: Database.Database,
  increments: readonly ReloadIncrement[],
): void {
  if (increments.length === 0) return;
  const stmt = db.prepare(RELOAD_UPSERT_SQL);
  const tx = db.transaction((rows: readonly ReloadIncrement[]) => {
    for (const row of rows) {
      stmt.run(row.date, row.urlPattern, row.count);
    }
  });
  tx(increments);
}

const CLUSTER_UPSERT_SQL = `
  INSERT INTO browser_research_clusters (
    slug, root_task_id, display_name, started_at, last_activity_at,
    visits_total, meaningful_visits_total, meaningful_foreground_sec_total,
    distinct_meaningful_domains, status, agent_summary_revision
  ) VALUES (
    @slug, @rootTaskId, @displayName, @startedAt, @lastActivityAt,
    @visitsTotal, @meaningfulVisitsTotal, @meaningfulForegroundSecTotal,
    @distinctMeaningfulDomains, @status, 0
  )
  ON CONFLICT (slug) DO UPDATE SET
    last_activity_at = excluded.last_activity_at,
    visits_total = excluded.visits_total,
    meaningful_visits_total = excluded.meaningful_visits_total,
    meaningful_foreground_sec_total = excluded.meaningful_foreground_sec_total,
    distinct_meaningful_domains = excluded.distinct_meaningful_domains,
    display_name = CASE
      WHEN browser_research_clusters.agent_summary_revision = 0
        THEN excluded.display_name
      ELSE browser_research_clusters.display_name
    END,
    status = CASE
      WHEN browser_research_clusters.status IN ('muted', 'concluded')
        THEN browser_research_clusters.status
      ELSE excluded.status
    END
`;

const DORMANT_AFTER_MS = 10 * 24 * 60 * 60 * 1000;

function chooseClusterStatus(
  lastActivityAt: number,
  qualifies: boolean,
  nowMs: number,
): "active" | "dormant" {
  if (!qualifies) return "dormant";
  return nowMs - lastActivityAt > DORMANT_AFTER_MS ? "dormant" : "active";
}

export function upsertResearchClusters(
  db: Database.Database,
  clusters: readonly ExtractedCluster[],
  nowMs: number = Date.now(),
): void {
  if (clusters.length === 0) return;
  const stmt = db.prepare(CLUSTER_UPSERT_SQL);
  const tx = db.transaction((rows: readonly ExtractedCluster[]) => {
    for (const cluster of rows) {
      stmt.run({
        slug: cluster.slug,
        rootTaskId: cluster.aggregate.rootTaskId,
        displayName: cluster.displayName,
        startedAt: cluster.aggregate.startedAt,
        lastActivityAt: cluster.aggregate.lastActivityAt,
        visitsTotal: cluster.aggregate.visitsTotal,
        meaningfulVisitsTotal: cluster.aggregate.meaningfulVisitsTotal,
        meaningfulForegroundSecTotal:
          cluster.aggregate.meaningfulForegroundSecTotal,
        distinctMeaningfulDomains: cluster.aggregate.distinctMeaningfulDomains,
        status: chooseClusterStatus(
          cluster.aggregate.lastActivityAt,
          cluster.qualifies,
          nowMs,
        ),
      });
    }
  });
  tx(clusters);
}

export interface ShoppingSessionInput {
  date: string;
  vendor: "amazon";
  asinSet: readonly string[];
  comparisonMinutes: number;
  locale: string | null;
}

export function replaceShoppingSessions(
  db: Database.Database,
  date: string,
  sessions: readonly ShoppingSessionInput[],
): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM browser_shopping_sessions WHERE date = ?").run(
      date,
    );
    if (sessions.length === 0) return;
    const stmt = db.prepare(
      `INSERT INTO browser_shopping_sessions
         (date, vendor, asin_set, comparison_minutes, locale)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const session of sessions) {
      stmt.run(
        session.date,
        session.vendor,
        JSON.stringify([...session.asinSet]),
        session.comparisonMinutes,
        session.locale,
      );
    }
  });
  tx();
}

export interface RetentionConfig {
  visitRetentionDays: number;
  searchQueryRetentionDays: number;
}

export interface ShoppingDateRow {
  date: string;
  vendor: "amazon";
  asins: string[];
  comparisonMinutes: number;
  locale: string | null;
}

export function listShoppingSessionsForDate(
  db: Database.Database,
  date: string,
): ShoppingDateRow[] {
  const rows = db
    .prepare(
      `SELECT date, vendor, asin_set, comparison_minutes, locale
       FROM browser_shopping_sessions
       WHERE date = ?
       ORDER BY id ASC`,
    )
    .all(date) as Array<{
      date: string;
      vendor: string;
      asin_set: string;
      comparison_minutes: number;
      locale: string | null;
    }>;
  return rows.map((row) => {
    let asins: string[] = [];
    try {
      const parsed = JSON.parse(row.asin_set) as unknown;
      if (Array.isArray(parsed)) {
        asins = parsed.filter((value): value is string => typeof value === "string");
      }
    } catch {
      // Corrupt JSON in the database — surface zero ASINs rather than
      // throw; the API endpoint Zod-validates and a 0-ASIN row will be
      // filtered out at the response boundary.
    }
    return {
      date: row.date,
      vendor: "amazon" as const,
      asins,
      comparisonMinutes: row.comparison_minutes,
      locale: row.locale,
    };
  });
}

export interface ReloadEntryRow {
  urlPattern: string;
  reloadCount: number;
}

export function listReloadsForDate(
  db: Database.Database,
  date: string,
  limit = 50,
): ReloadEntryRow[] {
  const rows = db
    .prepare(
      `SELECT url_pattern AS urlPattern, reload_count AS reloadCount
       FROM browser_reload_signals
       WHERE date = ?
       ORDER BY reload_count DESC, url_pattern ASC
       LIMIT ?`,
    )
    .all(date, limit) as ReloadEntryRow[];
  return rows;
}

export interface ReloadWeeklyEntryRow extends ReloadEntryRow {
  days: number;
}

export function listReloadsForRange(
  db: Database.Database,
  rangeStart: string,
  rangeEnd: string,
  limit = 50,
): ReloadWeeklyEntryRow[] {
  return db
    .prepare(
      `SELECT
         url_pattern AS urlPattern,
         SUM(reload_count) AS reloadCount,
         COUNT(DISTINCT date) AS days
       FROM browser_reload_signals
       WHERE date >= ? AND date <= ?
       GROUP BY url_pattern
       ORDER BY reloadCount DESC, url_pattern ASC
       LIMIT ?`,
    )
    .all(rangeStart, rangeEnd, limit) as ReloadWeeklyEntryRow[];
}

export function applyBrowserHistoryRetention(
  db: Database.Database,
  retention: RetentionConfig,
  nowMs: number = Date.now(),
): { visitsDeleted: number; searchQueriesCleared: number } {
  const visitCutoff = nowMs - retention.visitRetentionDays * 86_400_000;
  const queryCutoff = nowMs - retention.searchQueryRetentionDays * 86_400_000;
  const tx = db.transaction(() => {
    const cleared = db
      .prepare(
        "UPDATE browser_visits SET search_query = NULL WHERE search_query IS NOT NULL AND ts < ?",
      )
      .run(queryCutoff);
    const deleted = db
      .prepare("DELETE FROM browser_visits WHERE ts < ?")
      .run(visitCutoff);
    return {
      visitsDeleted: deleted.changes ?? 0,
      searchQueriesCleared: cleared.changes ?? 0,
    };
  });
  return tx();
}
