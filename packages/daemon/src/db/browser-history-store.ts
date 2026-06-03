import type Database from "better-sqlite3";
import {
  browserHistoryCapabilitiesSchema,
  browserHistoryLifecycleStateSchema,
  browserHistoryResearchClustersResponseSchema,
  getAgentDayDateStr,
  yesterdayResearchSummarySchema,
  type BrowserHistoryBrowserKey,
  type BrowserHistoryCapabilities,
  type BrowserHistoryClusterDetail,
  type BrowserHistoryLifecycleState,
  type BrowserHistoryOfferKind,
  type BrowserHistoryPendingOffer,
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

const CLUSTER_INSERT_SQL = `
  INSERT INTO browser_research_clusters (
    slug, root_task_id, display_name, started_at, last_activity_at,
    visits_total, meaningful_visits_total, meaningful_foreground_sec_total,
    distinct_meaningful_domains, status, agent_summary_revision
  ) VALUES (
    @slug, @rootTaskId, @displayName, @startedAt, @lastActivityAt,
    @visitsTotal, @meaningfulVisitsTotal, @meaningfulForegroundSecTotal,
    @distinctMeaningfulDomains, @status, 0
  )
`;

// The cluster's stable identity is `root_task_id`, not `slug`. The slug is a
// label composed from the cluster's currently-dominant domain + search term
// (deriveClusterSlug), so as more visits accumulate for the same root task the
// dominant term can shift and the next ingest tick derives a *different* slug.
// The old `ON CONFLICT (slug)` upsert then missed the conflict and the INSERT
// collided with the row's existing `root_task_id` UNIQUE constraint, throwing
// SqliteError and aborting the whole ingest transaction (no clusters written
// that tick). We update by root_task_id and leave the persisted slug untouched
// so browser_pending_offers rows — which reference clusters by slug — stay
// joined.
const CLUSTER_UPDATE_BY_ROOT_SQL = `
  UPDATE browser_research_clusters SET
    last_activity_at = @lastActivityAt,
    visits_total = @visitsTotal,
    meaningful_visits_total = @meaningfulVisitsTotal,
    meaningful_foreground_sec_total = @meaningfulForegroundSecTotal,
    distinct_meaningful_domains = @distinctMeaningfulDomains,
    display_name = CASE
      WHEN agent_summary_revision = 0 THEN @displayName
      ELSE display_name
    END,
    status = CASE
      WHEN status IN ('muted', 'concluded') THEN status
      ELSE @status
    END
  WHERE root_task_id = @rootTaskId
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
  const insertStmt = db.prepare(CLUSTER_INSERT_SQL);
  const updateStmt = db.prepare(CLUSTER_UPDATE_BY_ROOT_SQL);
  const existingForRoot = db.prepare(
    "SELECT slug FROM browser_research_clusters WHERE root_task_id = ?",
  );
  const slugHeldByOtherRoot = db.prepare(
    "SELECT 1 FROM browser_research_clusters WHERE slug = ? AND root_task_id <> ?",
  );
  const tx = db.transaction((rows: readonly ExtractedCluster[]) => {
    for (const cluster of rows) {
      const rootTaskId = cluster.aggregate.rootTaskId;
      // Fields shared by both paths. `started_at` and `slug` are INSERT-only
      // (started_at is set once and preserved across ticks; slug is keyed on
      // separately below), so they are excluded here and added to the INSERT
      // params — keeping each statement's bound object to exactly its `@`
      // placeholders.
      const shared = {
        rootTaskId,
        displayName: cluster.displayName,
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
      };
      if (existingForRoot.get(rootTaskId)) {
        updateStmt.run(shared);
        continue;
      }
      // New root task. Guard the slug PRIMARY KEY against a value already held
      // by a different root_task_id: two roots can derive the same base slug in
      // separate ingest ticks, where the in-run usedSlugs disambiguator
      // (cluster-extractor) cannot see previously-persisted rows.
      let slug = cluster.slug;
      if (slugHeldByOtherRoot.get(slug, rootTaskId)) {
        slug = `${slug}-${rootTaskId}`;
      }
      insertStmt.run({
        ...shared,
        startedAt: cluster.aggregate.startedAt,
        slug,
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

// ── P3 — cluster engagement (DM budget, offers, delta) ──

const CLUSTER_DETAIL_QUERY = `
  SELECT
    slug,
    root_task_id AS rootTaskId,
    display_name AS displayName,
    started_at AS startedAt,
    last_activity_at AS lastActivityAt,
    visits_total AS visitsTotal,
    meaningful_visits_total AS meaningfulVisitsTotal,
    meaningful_foreground_sec_total AS meaningfulForegroundSecTotal,
    distinct_meaningful_domains AS distinctMeaningfulDomains,
    status,
    COALESCE(agent_summary_revision, 0) AS agentSummaryRevision,
    last_dm_at AS lastDmAt,
    last_research_offer_at AS lastResearchOfferAt,
    last_wiki_offer_at AS lastWikiOfferAt,
    research_offer_accepted_at AS researchOfferAcceptedAt,
    wiki_summary_written_at AS wikiSummaryWrittenAt
  FROM browser_research_clusters
  WHERE slug = ?
`;

interface ClusterDetailRow {
  slug: string;
  rootTaskId: number;
  displayName: string;
  startedAt: number;
  lastActivityAt: number;
  visitsTotal: number;
  meaningfulVisitsTotal: number;
  meaningfulForegroundSecTotal: number;
  distinctMeaningfulDomains: number;
  status: BrowserHistoryClusterDetail["status"];
  agentSummaryRevision: number;
  lastDmAt: number | null;
  lastResearchOfferAt: number | null;
  lastWikiOfferAt: number | null;
  researchOfferAcceptedAt: number | null;
  wikiSummaryWrittenAt: number | null;
}

/**
 * Read a cluster row with the full P3 engagement field set. Returns null
 * when the slug does not exist. The result is the *raw* DB shape; the
 * route layer assembles `topDomains` via a separate query and Zod-parses
 * the union before returning to the agent / dashboard.
 */
export function getResearchClusterDetail(
  db: Database.Database,
  slug: string,
): ClusterDetailRow | null {
  const row = db.prepare(CLUSTER_DETAIL_QUERY).get(slug) as
    | ClusterDetailRow
    | undefined;
  return row ?? null;
}

/**
 * Top eTLD+1 labels (regex-constrained domain shape) observed inside the
 * cluster, ordered by visit count. Capped at `limit` so the cluster
 * detail payload stays bounded. The label is never a raw URL — visits
 * already store `domain` as the eTLD+1, written by `redactor.ts`.
 */
export function listTopDomainsForCluster(
  db: Database.Database,
  rootTaskId: number,
  limit = 10,
): string[] {
  const rows = db
    .prepare(
      `SELECT domain, COUNT(*) AS visits
       FROM browser_visits
       WHERE root_task_id = ? AND meaningful = 1
       GROUP BY domain
       ORDER BY visits DESC, domain ASC
       LIMIT ?`,
    )
    .all(rootTaskId, limit) as Array<{ domain: string; visits: number }>;
  return rows.map((row) => row.domain);
}

export interface ClusterDailyDeltaRow {
  date: string;
  meaningfulVisits: number;
  meaningfulForegroundSec: number;
  newDomains: string[];
}

/**
 * Per-day delta over the cluster's meaningful visits, bucketed by the
 * agent-day calendar (so a visit at 03:30 lands in the prior day's
 * bucket when `dayBoundaryHour=4`). `newDomains` is the set of eTLD+1
 * labels that appear in this day's bucket but did not appear in any
 * earlier bucket of the same cluster — the "what changed yesterday"
 * surface the F2 digest pulls into the morning journal.
 *
 * Pure aggregation over `browser_visits`. Bounded at the API layer by
 * `dayLimit` (default 31 days back from today) to keep payloads small.
 */
export function listClusterDailyDeltas(
  db: Database.Database,
  rootTaskId: number,
  boundary: { timezone: string | undefined; dayBoundaryHour: number },
  options: { sinceMs?: number; dayLimit?: number } = {},
): ClusterDailyDeltaRow[] {
  const rows = db
    .prepare(
      `SELECT ts, domain, foreground_sec AS foregroundSec
       FROM browser_visits
       WHERE root_task_id = ? AND meaningful = 1
         AND (? IS NULL OR ts >= ?)
       ORDER BY ts ASC`,
    )
    .all(
      rootTaskId,
      options.sinceMs ?? null,
      options.sinceMs ?? null,
    ) as Array<{ ts: number; domain: string; foregroundSec: number | null }>;

  const buckets = new Map<
    string,
    { visits: number; foregroundSec: number; domains: Set<string> }
  >();
  const seenDomains = new Set<string>();
  const orderedDays: string[] = [];

  for (const row of rows) {
    const day = getAgentDayDateStr(
      boundary.timezone,
      boundary.dayBoundaryHour,
      new Date(row.ts),
    );
    let bucket = buckets.get(day);
    if (!bucket) {
      bucket = { visits: 0, foregroundSec: 0, domains: new Set() };
      buckets.set(day, bucket);
      orderedDays.push(day);
    }
    bucket.visits += 1;
    bucket.foregroundSec += row.foregroundSec ?? 0;
    bucket.domains.add(row.domain);
  }

  const out: ClusterDailyDeltaRow[] = [];
  for (const day of orderedDays) {
    // `orderedDays` is only appended to when a fresh bucket is inserted
    // above, so the lookup here is guaranteed to hit.
    const bucket = buckets.get(day)!;
    const newDomains: string[] = [];
    for (const domain of bucket.domains) {
      if (!seenDomains.has(domain)) {
        newDomains.push(domain);
      }
    }
    for (const domain of bucket.domains) seenDomains.add(domain);
    out.push({
      date: day,
      meaningfulVisits: bucket.visits,
      meaningfulForegroundSec: bucket.foregroundSec,
      newDomains: newDomains.sort(),
    });
  }

  if (options.dayLimit && out.length > options.dayLimit) {
    return out.slice(out.length - options.dayLimit);
  }
  return out;
}

/**
 * Stamp the DM dispatch wall-clock + offer-tracking columns after a
 * templated DM has been queued through the notification path. All
 * three columns are optional — pass null to leave a column untouched.
 *
 * Idempotent under concurrent writers: every column either retains
 * its prior value or moves forward (UPDATE … SET col = COALESCE(?, col))
 * so a double-fire from a poller race cannot regress an earlier
 * stamp.
 */
export function stampClusterDmFields(
  db: Database.Database,
  slug: string,
  fields: {
    lastDmAt?: number | null;
    lastResearchOfferAt?: number | null;
    lastWikiOfferAt?: number | null;
    researchOfferAcceptedAt?: number | null;
    wikiSummaryWrittenAt?: number | null;
    statusOverride?: BrowserHistoryClusterDetail["status"];
  },
): void {
  const stmt = db.prepare(
    `UPDATE browser_research_clusters
     SET
       last_dm_at = COALESCE(?, last_dm_at),
       last_research_offer_at = COALESCE(?, last_research_offer_at),
       last_wiki_offer_at = COALESCE(?, last_wiki_offer_at),
       research_offer_accepted_at = COALESCE(?, research_offer_accepted_at),
       wiki_summary_written_at = COALESCE(?, wiki_summary_written_at),
       status = COALESCE(?, status)
     WHERE slug = ?`,
  );
  stmt.run(
    fields.lastDmAt ?? null,
    fields.lastResearchOfferAt ?? null,
    fields.lastWikiOfferAt ?? null,
    fields.researchOfferAcceptedAt ?? null,
    fields.wikiSummaryWrittenAt ?? null,
    fields.statusOverride ?? null,
    slug,
  );
}

/**
 * Explicitly NULL out one or more `last_*_offer_at` stamps. Sibling of
 * `stampClusterDmFields` for the wiki-summary acceptance path: that
 * path needs to break the rate-limit gate's `decline_backoff` condition
 * (which trips when `lastWikiOfferAt !== null AND
 * wikiSummaryWrittenAt === null`), and the gate's bookkeeping has no
 * separate "user accepted wiki" stamp. `stampClusterDmFields` uses
 * `COALESCE(?, col)` so passing `null` there is a no-op — it preserves
 * the prior value to keep concurrent writers idempotent. This function
 * is the explicit-clear branch.
 *
 * Pass `true` for the column(s) to clear. Calling with no flags is a
 * no-op (skips the UPDATE) so the function is safe to invoke
 * unconditionally from a switch branch.
 */
export function clearClusterOfferStamps(
  db: Database.Database,
  slug: string,
  fields: {
    lastResearchOfferAt?: boolean;
    lastWikiOfferAt?: boolean;
  },
): void {
  const sets: string[] = [];
  if (fields.lastResearchOfferAt) sets.push("last_research_offer_at = NULL");
  if (fields.lastWikiOfferAt) sets.push("last_wiki_offer_at = NULL");
  if (sets.length === 0) return;
  db.prepare(
    `UPDATE browser_research_clusters SET ${sets.join(", ")} WHERE slug = ?`,
  ).run(slug);
}

/**
 * Set the cluster's status with a hard override (rename / conclude /
 * mute / unmute paths). Differs from `stampClusterDmFields` in that
 * it always writes — never COALESCE — and from the poller's upsert in
 * that the upsert preserves `muted` / `concluded` against newly
 * arriving visits, while this path is the source of truth for the
 * user / bang-command-driven transition.
 */
export function setResearchClusterStatus(
  db: Database.Database,
  slug: string,
  status: BrowserHistoryClusterDetail["status"],
): boolean {
  const info = db
    .prepare(`UPDATE browser_research_clusters SET status = ? WHERE slug = ?`)
    .run(status, slug);
  return info.changes > 0;
}

/**
 * Rename a cluster — only the operator-facing `display_name` changes.
 * The slug is the PK and is held stable (the user types `!research <slug>`
 * after rename, but the URL-friendly slug remains the same — a new
 * slug would orphan the existing context/research/<slug>.md note and
 * any in-flight DM offer references). `agent_summary_revision` is
 * bumped so the next cluster_update sees a non-zero revision and
 * stops re-deriving the display name from top domain + top search
 * term (preserving the operator's pick).
 */
export function renameResearchCluster(
  db: Database.Database,
  slug: string,
  displayName: string,
): boolean {
  const info = db
    .prepare(
      `UPDATE browser_research_clusters
       SET display_name = ?,
           agent_summary_revision = MAX(agent_summary_revision, 1)
       WHERE slug = ?`,
    )
    .run(displayName, slug);
  return info.changes > 0;
}

/**
 * Bump `agent_summary_revision` after a `routine.research_cluster_update`
 * session writes the day entry to `context/research/<slug>.md`. The
 * poller-side upsert reads this column to decide whether the operator
 * has invested in a custom display name yet; the cluster_update
 * routine reads it to decide whether to skip a no-op run.
 */
export function bumpClusterAgentSummaryRevision(
  db: Database.Database,
  slug: string,
): number {
  const info = db
    .prepare(
      `UPDATE browser_research_clusters
       SET agent_summary_revision = agent_summary_revision + 1
       WHERE slug = ?`,
    )
    .run(slug);
  if (info.changes === 0) return 0;
  // The UPDATE just succeeded on this slug, so the SELECT below is
  // guaranteed to find it (single-writer SQLite, same db handle).
  const row = db
    .prepare(
      `SELECT agent_summary_revision AS rev FROM browser_research_clusters WHERE slug = ?`,
    )
    .get(slug) as { rev: number };
  return row.rev;
}

/**
 * Clusters whose `last_activity_at` is newer than the row's most recent
 * cluster_update session — i.e. the agent has new visits to journal.
 * Surfaces only `active` rows: muted / concluded / dormant clusters do
 * not get nightly journal appends. Capped by `limit` so a backlog never
 * floods the schedule fan-out.
 */
export function listClustersNeedingUpdate(
  db: Database.Database,
  lookbackMs: number,
  nowMs: number = Date.now(),
  limit = 25,
): Array<{ slug: string; displayName: string }> {
  const since = nowMs - lookbackMs;
  return db
    .prepare(
      `SELECT slug, display_name AS displayName
       FROM browser_research_clusters
       WHERE status = 'active'
         AND last_activity_at >= ?
       ORDER BY last_activity_at DESC
       LIMIT ?`,
    )
    .all(since, limit) as Array<{ slug: string; displayName: string }>;
}

// ── browser_pending_offers — materialised view of open offer state ──

export const OFFER_DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface PendingOfferInput {
  slug: string;
  kind: BrowserHistoryOfferKind;
  offeredAt: number;
  expiresAt: number;
}

/**
 * INSERT-OR-REPLACE the open-offer row for (slug, kind). REPLACE keeps the
 * row idempotent under a poller re-emit: a cluster that re-qualifies after
 * an expired offer cleanup gets its `expires_at` extended without first
 * deleting; a cluster that already has an open row keeps its offered_at /
 * expires_at as-is (the poller's `shouldEmitOffer` check filters before
 * this path is called).
 */
export function upsertPendingOffer(
  db: Database.Database,
  input: PendingOfferInput,
): void {
  db.prepare(
    `INSERT INTO browser_pending_offers (slug, kind, offered_at, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (slug, kind) DO UPDATE SET
       offered_at = excluded.offered_at,
       expires_at = excluded.expires_at`,
  ).run(input.slug, input.kind, input.offeredAt, input.expiresAt);
}

export function deletePendingOffer(
  db: Database.Database,
  slug: string,
  kind: BrowserHistoryOfferKind,
): boolean {
  const info = db
    .prepare(`DELETE FROM browser_pending_offers WHERE slug = ? AND kind = ?`)
    .run(slug, kind);
  return info.changes > 0;
}

export function deletePendingOffersForCluster(
  db: Database.Database,
  slug: string,
): number {
  const info = db
    .prepare(`DELETE FROM browser_pending_offers WHERE slug = ?`)
    .run(slug);
  return info.changes;
}

/**
 * List open offers joined to their cluster display name. The route layer
 * returns this verbatim (after Zod parse) for `/api/browser-history/offers/pending`
 * and the pre-morning digest surfaces it in `pending-offers.md`.
 *
 * Expired offers (now > expires_at) are filtered out and lazily purged
 * — purge runs inline so the next `!research` list does not show a
 * dangling row. Lazy purge avoids a dedicated cron entry; the table is
 * small (≤1 row per cluster per kind, capped by the 14-day TTL).
 */
export function listPendingOffersWithDisplay(
  db: Database.Database,
  nowMs: number = Date.now(),
): BrowserHistoryPendingOffer[] {
  db.prepare(`DELETE FROM browser_pending_offers WHERE expires_at < ?`).run(
    nowMs,
  );
  return db
    .prepare(
      `SELECT
         po.slug,
         c.display_name AS displayName,
         po.kind,
         po.offered_at AS offeredAt,
         po.expires_at AS expiresAt
       FROM browser_pending_offers po
       JOIN browser_research_clusters c ON c.slug = po.slug
       ORDER BY po.offered_at DESC`,
    )
    .all() as BrowserHistoryPendingOffer[];
}

export function listPendingOffersForCluster(
  db: Database.Database,
  slug: string,
  nowMs: number = Date.now(),
): BrowserHistoryPendingOffer[] {
  return db
    .prepare(
      `SELECT
         po.slug,
         c.display_name AS displayName,
         po.kind,
         po.offered_at AS offeredAt,
         po.expires_at AS expiresAt
       FROM browser_pending_offers po
       JOIN browser_research_clusters c ON c.slug = po.slug
       WHERE po.slug = ? AND po.expires_at >= ?
       ORDER BY po.offered_at DESC`,
    )
    .all(slug, nowMs) as BrowserHistoryPendingOffer[];
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
      visitsDeleted: deleted.changes,
      searchQueriesCleared: cleared.changes,
    };
  });
  return tx();
}
