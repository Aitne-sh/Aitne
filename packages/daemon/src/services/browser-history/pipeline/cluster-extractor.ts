import type Database from "better-sqlite3";
import { getAgentDayDateStr } from "@aitne/shared";

export interface ClusterVisitRow {
  rootTaskId: number;
  ts: number;
  domain: string;
  category: string;
  meaningful: number;
  meaningfulForegroundSec: number | null;
  title: string | null;
  searchQuery: string | null;
}

export interface ClusterAggregate {
  rootTaskId: number;
  startedAt: number;
  lastActivityAt: number;
  visitsTotal: number;
  meaningfulVisitsTotal: number;
  meaningfulForegroundSecTotal: number;
  distinctMeaningfulDomains: number;
  distinctMeaningfulDays: number;
  topNonSearchDomain: string | null;
  topSearchTerm: string | null;
}

export interface AgentDayBoundary {
  timezone: string | undefined;
  dayBoundaryHour: number;
}

const DEFAULT_BOUNDARY: AgentDayBoundary = {
  timezone: undefined,
  dayBoundaryHour: 4,
};

function agentDayKey(tsMs: number, boundary: AgentDayBoundary): string {
  // Use the shared helper so the bucket respects the user's local
  // timezone. Reinventing this with `new Date(ms - 4h)` produces wrong
  // dates for any non-UTC user (CLAUDE.md: "do not reinvent date math").
  return getAgentDayDateStr(
    boundary.timezone,
    boundary.dayBoundaryHour,
    new Date(tsMs),
  );
}

export function aggregateCluster(
  rows: readonly ClusterVisitRow[],
  boundary: AgentDayBoundary = DEFAULT_BOUNDARY,
): ClusterAggregate | null {
  if (rows.length === 0) return null;
  const rootTaskId = rows[0].rootTaskId;
  const startedAt = Math.min(...rows.map((row) => row.ts));
  const lastActivityAt = Math.max(...rows.map((row) => row.ts));
  const meaningfulRows = rows.filter((row) => row.meaningful === 1);
  const meaningfulVisitsTotal = meaningfulRows.length;
  const meaningfulForegroundSecTotal = meaningfulRows.reduce(
    (acc, row) => acc + (row.meaningfulForegroundSec ?? 0),
    0,
  );
  const distinctDomains = new Set(meaningfulRows.map((row) => row.domain));
  const distinctDays = new Set(
    meaningfulRows.map((row) => agentDayKey(row.ts, boundary)),
  );

  const domainCounts = new Map<string, number>();
  for (const row of meaningfulRows) {
    domainCounts.set(row.domain, (domainCounts.get(row.domain) ?? 0) + 1);
  }
  const sortedDomains = [...domainCounts.entries()].sort((a, b) => b[1] - a[1]);
  const topNonSearchDomain =
    sortedDomains.find(([domain]) => !/(google|bing|duckduckgo|yahoo)\./.test(domain))?.[0]
    ?? sortedDomains[0]?.[0]
    ?? null;

  const termCounts = new Map<string, number>();
  for (const row of meaningfulRows) {
    if (!row.searchQuery) continue;
    const normalised = row.searchQuery.toLowerCase().trim();
    if (!normalised) continue;
    termCounts.set(normalised, (termCounts.get(normalised) ?? 0) + 1);
  }
  const sortedTerms = [...termCounts.entries()].sort((a, b) => b[1] - a[1]);
  const topSearchTerm = sortedTerms[0]?.[0] ?? null;

  return {
    rootTaskId,
    startedAt,
    lastActivityAt,
    visitsTotal: rows.length,
    meaningfulVisitsTotal,
    meaningfulForegroundSecTotal,
    distinctMeaningfulDomains: distinctDomains.size,
    distinctMeaningfulDays: distinctDays.size,
    topNonSearchDomain,
    topSearchTerm,
  };
}

export interface QualificationThresholds {
  minDays: number;
  minMeaningfulVisits: number;
  minMeaningfulForegroundSec: number;
  minDistinctDomains: number;
}

export const DEFAULT_QUALIFICATION_THRESHOLDS: QualificationThresholds = {
  minDays: 3,
  minMeaningfulVisits: 20,
  minMeaningfulForegroundSec: 3600,
  minDistinctDomains: 3,
};

export function qualifiesAsActiveResearch(
  aggregate: ClusterAggregate,
  thresholds: QualificationThresholds = DEFAULT_QUALIFICATION_THRESHOLDS,
): boolean {
  return (
    aggregate.distinctMeaningfulDays >= thresholds.minDays
    && aggregate.meaningfulVisitsTotal >= thresholds.minMeaningfulVisits
    && aggregate.meaningfulForegroundSecTotal >= thresholds.minMeaningfulForegroundSec
    && aggregate.distinctMeaningfulDomains >= thresholds.minDistinctDomains
  );
}

const SLUG_MAX_LENGTH = 60;

function slugifyToken(value: string | null): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH);
}

function trimSlug(slug: string): string {
  return slug.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

export function deriveClusterSlug(aggregate: ClusterAggregate): string {
  const domainPart = slugifyToken(aggregate.topNonSearchDomain?.replace(/^www\./, "")
    .split(".")[0] ?? null);
  const termPart = slugifyToken(aggregate.topSearchTerm);
  const composed = [domainPart, termPart].filter((part) => part.length > 0).join("-");
  const fallback = `cluster-${aggregate.rootTaskId}`;
  const slug = trimSlug(composed) || fallback;
  return slug.length >= 2 ? slug.slice(0, SLUG_MAX_LENGTH * 2) : fallback;
}

export function deriveClusterDisplayName(aggregate: ClusterAggregate): string {
  const domain = aggregate.topNonSearchDomain ?? "research";
  const term = aggregate.topSearchTerm;
  if (term) {
    const titleCased = term
      .split(/\s+/)
      .filter((part) => part.length > 0)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
    return titleCased.length > 0 ? titleCased : domain;
  }
  return domain;
}

export interface ExtractedCluster {
  slug: string;
  displayName: string;
  aggregate: ClusterAggregate;
  qualifies: boolean;
}

const CLUSTER_QUERY = `
  SELECT
    root_task_id AS rootTaskId,
    ts,
    domain,
    category,
    meaningful,
    foreground_sec AS meaningfulForegroundSec,
    title,
    search_query AS searchQuery
  FROM browser_visits
  WHERE root_task_id IS NOT NULL
  ORDER BY root_task_id ASC, ts ASC
`;

function disambiguateSlug(
  base: string,
  rootTaskId: number,
  used: Set<string>,
): string {
  if (!used.has(base)) return base;
  // Two clusters that would derive the same slug (same top-domain + top
  // search term) collide on the `slug` PK in browser_research_clusters
  // and silently merge under the first-inserted root_task_id. Append a
  // stable suffix so each root_task_id keeps its own row.
  const suffix = `-${rootTaskId}`;
  const truncated = base.slice(0, Math.max(2, SLUG_MAX_LENGTH * 2 - suffix.length));
  const candidate = `${truncated}${suffix}`;
  return used.has(candidate) ? `cluster-${rootTaskId}` : candidate;
}

export function extractClustersFromDb(
  db: Database.Database,
  boundary: AgentDayBoundary = DEFAULT_BOUNDARY,
): ExtractedCluster[] {
  const rows = db.prepare(CLUSTER_QUERY).all() as ClusterVisitRow[];
  if (rows.length === 0) return [];
  const byRoot = new Map<number, ClusterVisitRow[]>();
  for (const row of rows) {
    const list = byRoot.get(row.rootTaskId) ?? [];
    list.push(row);
    byRoot.set(row.rootTaskId, list);
  }
  const out: ExtractedCluster[] = [];
  const usedSlugs = new Set<string>();
  for (const [, group] of byRoot) {
    const aggregate = aggregateCluster(group, boundary);
    if (!aggregate) continue;
    const baseSlug = deriveClusterSlug(aggregate);
    const slug = disambiguateSlug(baseSlug, aggregate.rootTaskId, usedSlugs);
    usedSlugs.add(slug);
    out.push({
      slug,
      displayName: deriveClusterDisplayName(aggregate),
      aggregate,
      qualifies: qualifiesAsActiveResearch(aggregate),
    });
  }
  return out;
}
