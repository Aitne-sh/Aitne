import type Database from "better-sqlite3";
import {
  getAgentDayBoundsUtc,
  getAgentDayDateStr,
  parseSqliteUtcMs,
} from "@aitne/shared";
import { matchClustersToProject } from "./project-matcher.js";

/**
 * WEEKLY_INTERESTS_REFLECTION_PLAN.md §10.1 — deterministic Layer-1
 * builder for the weekly interest reflection.
 *
 * Pure aggregation over `browser_research_clusters` joined with
 * `browser_visits` for the 7-day window ending at the weekly_review
 * trigger time, agent-day-aligned (default 04:00 boundary). No LLM, no
 * network, no filesystem; SQLite is the only I/O.
 *
 * Two responsibilities split deliberately:
 *
 * 1. `buildWeeklyInterestsSummary` — the production entry. Reads the
 *    cluster rows + per-visit history, ranks the active set by
 *    meaningful foreground seconds in the window, and diffs against the
 *    prior 7-day window to surface "dormant since last week" entries.
 *    Optionally accepts `projectKeywords` (from `project-matcher.ts`)
 *    so the caller doesn't need a second pass.
 *
 * 2. The exported pure helpers `pickTopClusters`, `weekWindowMs`, and
 *    `weekStartFromDate` exist so the same date math and ranking are
 *    available to tests and to the `GET /api/browser-history/
 *    weekly-interests-summary` route without rebuilding them.
 *
 * Invariants the caller can rely on:
 *   - `clusters` is sorted by `meaningfulForegroundSec` desc, ties
 *     broken by `distinctMeaningfulDomains` desc, then by `slug`. Capped
 *     at `options.maxClusters` (default 20).
 *   - Every cluster in `clusters` has at least one meaningful visit
 *     inside `[weekStartMs, weekEndMs)` AND status='active'.
 *   - `dormantSinceLastWeek` contains rows that had meaningful visits
 *     in the prior 7-day window but NONE in the current window. Sorted
 *     by `lastActivity` desc.
 *   - `projectMatches` is computed only when `options.projectKeywords`
 *     is supplied; matchers operate on `clusters` (the post-cap set).
 */

export type ClusterStatusChange =
  | "new"
  | "active_continued"
  | "newly_dormant"
  | "muted_this_week";

export interface ClusterSnapshot {
  slug: string;
  displayName: string;
  /** Distinct agent-day buckets the cluster had meaningful visits in. */
  daysActive: number;
  /** Meaningful visit count inside the 7-day window. */
  meaningfulVisits: number;
  /** Meaningful foreground seconds inside the 7-day window. */
  meaningfulForegroundSec: number;
  /** Distinct meaningful domains inside the 7-day window. */
  distinctMeaningfulDomains: number;
  /** Top-5 meaningful domains inside the window, ranked by foreground sec. */
  topDomains: string[];
  /** Cluster row `status` at read time. */
  status: "active" | "dormant" | "concluded" | "muted";
  /**
   * Change since last week. `"new"` = no meaningful visits in the prior
   * window but ≥1 in the current; `"active_continued"` = present in
   * both windows.
   *
   * Clusters that became dormant this week never appear in the active
   * `clusters` set — they surface in `dormantSinceLastWeek` instead, so
   * `"newly_dormant"` and `"muted_this_week"` are reserved for the
   * dormant-list use case and are present here only for shape parity
   * with `WeeklyInterestsSummary`.
   */
  statusChange: ClusterStatusChange;
  /** Path under `contextDir` to the cluster journal (no leading slash). */
  clusterJournalPath: string;
  hasOpenOffer: boolean;
  hasAcceptedResearch: boolean;
  hasWikiSummary: boolean;
  /** Agent-day date string of `lastActivityAt`, for downstream display. */
  lastActivityDate: string;
  /** Raw ms timestamp of the cluster's last meaningful activity. */
  lastActivityMs: number;
}

export interface DormantClusterEntry {
  slug: string;
  displayName: string;
  /** Agent-day date string of the most recent activity (now outside window). */
  lastActivity: string;
  lastActivityMs: number;
}

export interface ProjectMatch {
  projectSlug: string;
  projectPath: string;
  clusters: { slug: string; reason: "filename_match" | "jaccard" }[];
}

export interface ProjectKeywords {
  projectSlug: string;
  projectPath: string;
  keywords: Set<string>;
  source: "explicit" | "frontmatter" | "filename";
}

export interface WeeklyInterestsSummary {
  /** Agent-day YYYY-MM-DD start (inclusive). */
  weekStart: string;
  /** Agent-day YYYY-MM-DD end (inclusive — the last day in the window). */
  weekEnd: string;
  /** ISO timestamp of when this summary was built. */
  generatedAt: string;
  clusters: ClusterSnapshot[];
  dormantSinceLastWeek: DormantClusterEntry[];
  projectMatches: ProjectMatch[];
}

export interface AgentDayBoundary {
  readonly timezone: string | undefined;
  readonly dayBoundaryHour: number;
}

const DEFAULT_BOUNDARY: AgentDayBoundary = {
  timezone: undefined,
  dayBoundaryHour: 4,
};

export interface BuildSummaryOptions {
  readonly maxClusters?: number;
  readonly maxProjectClusters?: number;
  readonly boundary?: AgentDayBoundary;
  readonly projectKeywords?: readonly ProjectKeywords[];
  /** Override for deterministic tests; defaults to `Date.now()`. */
  readonly nowMs?: number;
}

const DEFAULT_MAX_CLUSTERS = 20;
const DEFAULT_MAX_PROJECT_CLUSTERS = 5;
const WINDOW_DAYS = 7;
const WEEK_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;
const TOP_DOMAINS_CAP = 5;

/**
 * Anchor a YYYY-MM-DD agent-day-aligned `weekStart` to the UTC ms range
 * the SQL filter consumes. Exported so the API route can validate that
 * the caller's `weekStart` is genuinely a Monday before recomputing.
 */
export function weekWindowMs(
  weekStart: string,
  boundary: AgentDayBoundary,
): { startMs: number; endMs: number } {
  // Anchor at noon UTC on the requested date so DST transitions don't
  // shift us into the previous agent-day. `getAgentDayBoundsUtc`
  // resolves the local-time 04:00 boundary anchored on the noon-UTC
  // input.
  const anchor = new Date(`${weekStart}T12:00:00Z`);
  const bounds = getAgentDayBoundsUtc(
    boundary.timezone,
    boundary.dayBoundaryHour,
    anchor,
  );
  const startMs = parseSqliteUtcMs(bounds.start);
  return { startMs, endMs: startMs + WEEK_MS };
}

/**
 * Return the agent-day date string for `nowMs`. Useful for the
 * scheduler / dashboard helpers that need "today's agent-day" without
 * importing the shared helper directly.
 */
export function weekStartFromDate(
  nowMs: number,
  boundary: AgentDayBoundary = DEFAULT_BOUNDARY,
): string {
  return getAgentDayDateStr(
    boundary.timezone,
    boundary.dayBoundaryHour,
    new Date(nowMs),
  );
}

interface ClusterRow {
  slug: string;
  rootTaskId: number;
  displayName: string;
  status: "active" | "dormant" | "concluded" | "muted";
  startedAt: number;
  lastActivityAt: number;
  meaningfulVisitsTotal: number;
  meaningfulForegroundSecTotal: number;
  distinctMeaningfulDomains: number;
  researchOfferAcceptedAt: number | null;
  wikiSummaryWrittenAt: number | null;
}

interface VisitWindowRow {
  rootTaskId: number;
  ts: number;
  domain: string;
  foregroundSec: number | null;
}

const ACTIVE_CLUSTERS_QUERY = `
  SELECT
    slug,
    root_task_id AS rootTaskId,
    display_name AS displayName,
    status,
    started_at AS startedAt,
    last_activity_at AS lastActivityAt,
    meaningful_visits_total AS meaningfulVisitsTotal,
    meaningful_foreground_sec_total AS meaningfulForegroundSecTotal,
    distinct_meaningful_domains AS distinctMeaningfulDomains,
    research_offer_accepted_at AS researchOfferAcceptedAt,
    wiki_summary_written_at AS wikiSummaryWrittenAt
  FROM browser_research_clusters
  WHERE status = 'active'
`;

const ALL_CLUSTERS_QUERY = `
  SELECT
    slug,
    root_task_id AS rootTaskId,
    display_name AS displayName,
    status,
    last_activity_at AS lastActivityAt
  FROM browser_research_clusters
`;

const VISITS_FOR_ROOT_QUERY = `
  SELECT
    root_task_id AS rootTaskId,
    ts,
    domain,
    foreground_sec AS foregroundSec
  FROM browser_visits
  WHERE root_task_id = ? AND meaningful = 1 AND ts >= ? AND ts < ?
`;

const PENDING_OFFERS_QUERY = `
  SELECT slug FROM browser_pending_offers WHERE expires_at > ?
`;

interface ClusterWindowAggregate {
  visits: number;
  foregroundSec: number;
  distinctDomains: Set<string>;
  domainForeground: Map<string, number>;
  daySet: Set<string>;
  lastTsInWindow: number;
}

function emptyAggregate(): ClusterWindowAggregate {
  return {
    visits: 0,
    foregroundSec: 0,
    distinctDomains: new Set<string>(),
    domainForeground: new Map<string, number>(),
    daySet: new Set<string>(),
    lastTsInWindow: 0,
  };
}

/**
 * Sort the `clusters` array deterministically. Exported so the renderer
 * tests can reuse the same ordering rule.
 */
export function pickTopClusters(
  clusters: readonly ClusterSnapshot[],
  maxClusters: number,
): ClusterSnapshot[] {
  // `sort` mutates, so copy first; production callers also pass the
  // same array around between routes and tests.
  const copy = [...clusters];
  copy.sort((a, b) => {
    if (b.meaningfulForegroundSec !== a.meaningfulForegroundSec) {
      return b.meaningfulForegroundSec - a.meaningfulForegroundSec;
    }
    if (b.distinctMeaningfulDomains !== a.distinctMeaningfulDomains) {
      return b.distinctMeaningfulDomains - a.distinctMeaningfulDomains;
    }
    return a.slug.localeCompare(b.slug);
  });
  return copy.slice(0, Math.max(0, maxClusters));
}

function aggregateClusterWindow(
  db: Database.Database,
  rootTaskId: number,
  startMs: number,
  endMs: number,
  boundary: AgentDayBoundary,
): ClusterWindowAggregate {
  const rows = db
    .prepare(VISITS_FOR_ROOT_QUERY)
    .all(rootTaskId, startMs, endMs) as VisitWindowRow[];
  const agg = emptyAggregate();
  for (const row of rows) {
    agg.visits += 1;
    const fg = row.foregroundSec ?? 0;
    agg.foregroundSec += fg;
    agg.distinctDomains.add(row.domain);
    agg.domainForeground.set(
      row.domain,
      (agg.domainForeground.get(row.domain) ?? 0) + fg,
    );
    agg.daySet.add(
      getAgentDayDateStr(
        boundary.timezone,
        boundary.dayBoundaryHour,
        new Date(row.ts),
      ),
    );
    if (row.ts > agg.lastTsInWindow) {
      agg.lastTsInWindow = row.ts;
    }
  }
  return agg;
}

function topDomainsFromAggregate(agg: ClusterWindowAggregate): string[] {
  return [...agg.domainForeground.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_DOMAINS_CAP)
    .map(([domain]) => domain);
}

export function buildWeeklyInterestsSummary(
  db: Database.Database,
  weekStart: string,
  options: BuildSummaryOptions = {},
): WeeklyInterestsSummary {
  const boundary = options.boundary ?? DEFAULT_BOUNDARY;
  const maxClusters = options.maxClusters ?? DEFAULT_MAX_CLUSTERS;
  const maxProjectClusters =
    options.maxProjectClusters ?? DEFAULT_MAX_PROJECT_CLUSTERS;
  const nowMs = options.nowMs ?? Date.now();

  const { startMs: weekStartMs, endMs: weekEndMs } = weekWindowMs(
    weekStart,
    boundary,
  );
  const priorStartMs = weekStartMs - WEEK_MS;
  const priorEndMs = weekStartMs;

  const activeRows = db.prepare(ACTIVE_CLUSTERS_QUERY).all() as ClusterRow[];
  const openOfferSlugs = new Set(
    (db.prepare(PENDING_OFFERS_QUERY).all(nowMs) as Array<{ slug: string }>)
      .map((r) => r.slug),
  );

  const builtClusters: ClusterSnapshot[] = [];
  for (const row of activeRows) {
    const windowAgg = aggregateClusterWindow(
      db,
      row.rootTaskId,
      weekStartMs,
      weekEndMs,
      boundary,
    );
    if (windowAgg.visits === 0) continue;
    const priorAgg = aggregateClusterWindow(
      db,
      row.rootTaskId,
      priorStartMs,
      priorEndMs,
      boundary,
    );
    const statusChange: ClusterStatusChange =
      priorAgg.visits === 0 ? "new" : "active_continued";
    builtClusters.push({
      slug: row.slug,
      displayName: row.displayName,
      daysActive: windowAgg.daySet.size,
      meaningfulVisits: windowAgg.visits,
      meaningfulForegroundSec: windowAgg.foregroundSec,
      distinctMeaningfulDomains: windowAgg.distinctDomains.size,
      topDomains: topDomainsFromAggregate(windowAgg),
      status: row.status,
      statusChange,
      clusterJournalPath: `research/${row.slug}.md`,
      hasOpenOffer: openOfferSlugs.has(row.slug),
      hasAcceptedResearch: row.researchOfferAcceptedAt !== null,
      hasWikiSummary: row.wikiSummaryWrittenAt !== null,
      lastActivityDate: getAgentDayDateStr(
        boundary.timezone,
        boundary.dayBoundaryHour,
        new Date(windowAgg.lastTsInWindow),
      ),
      lastActivityMs: windowAgg.lastTsInWindow,
    });
  }

  const clusters = pickTopClusters(builtClusters, maxClusters);
  const currentSlugSet = new Set(clusters.map((c) => c.slug));

  const dormantSinceLastWeek: DormantClusterEntry[] = [];
  const allRows = db.prepare(ALL_CLUSTERS_QUERY).all() as Array<{
    slug: string;
    rootTaskId: number;
    displayName: string;
    status: "active" | "dormant" | "concluded" | "muted";
    lastActivityAt: number;
  }>;
  for (const row of allRows) {
    if (currentSlugSet.has(row.slug)) continue;
    // Dormant means: had meaningful visits in [-2 wk, -1 wk) but none
    // in the current window. Read the prior aggregate first as the
    // cheaper gate, then short-circuit.
    const priorAgg = aggregateClusterWindow(
      db,
      row.rootTaskId,
      priorStartMs,
      priorEndMs,
      boundary,
    );
    if (priorAgg.visits === 0) continue;
    // Defensive — the active path above already excluded clusters with
    // window visits, but a non-active status (concluded, muted) could
    // still have window visits while being absent from `currentSlugSet`
    // (the active query filtered them out). Suppress those: a muted
    // cluster shouldn't surface as "dormant" — it was deliberately
    // silenced, not abandoned.
    if (row.status !== "active" && row.status !== "dormant") continue;
    // Final check: zero visits in the CURRENT window. For a status
    // that's still 'active' this is the dormancy definition; for a row
    // already flipped to 'dormant' the prior-week presence is enough
    // to surface it once.
    const currentAgg = aggregateClusterWindow(
      db,
      row.rootTaskId,
      weekStartMs,
      weekEndMs,
      boundary,
    );
    if (currentAgg.visits > 0) continue;
    dormantSinceLastWeek.push({
      slug: row.slug,
      displayName: row.displayName,
      // Use the agent-day label (boundary-aware) — `localDateStr` alone
      // would mis-label a visit at 02:00 local as "today" when the
      // 04:00 boundary places it in the previous agent-day.
      lastActivity: getAgentDayDateStr(
        boundary.timezone,
        boundary.dayBoundaryHour,
        new Date(row.lastActivityAt),
      ),
      lastActivityMs: row.lastActivityAt,
    });
  }
  dormantSinceLastWeek.sort((a, b) => b.lastActivityMs - a.lastActivityMs);

  const projectMatches: ProjectMatch[] = [];
  if (options.projectKeywords) {
    for (const project of options.projectKeywords) {
      const matched = matchClustersToProject(
        project,
        clusters,
        maxProjectClusters,
      );
      if (matched.length === 0) continue;
      projectMatches.push({
        projectSlug: project.projectSlug,
        projectPath: project.projectPath,
        clusters: matched,
      });
    }
    projectMatches.sort((a, b) => a.projectSlug.localeCompare(b.projectSlug));
  }

  // `weekEnd` is the agent-day label of the last day in the window.
  // The window is half-open `[weekStartMs, weekEndMs)`; subtract a
  // single minute (well inside the day) and round to the agent-day so
  // the label is the same on both DST and non-DST zones.
  const weekEnd = getAgentDayDateStr(
    boundary.timezone,
    boundary.dayBoundaryHour,
    new Date(weekEndMs - 60_000),
  );

  return {
    weekStart,
    weekEnd,
    generatedAt: new Date(nowMs).toISOString(),
    clusters,
    dormantSinceLastWeek,
    projectMatches,
  };
}
