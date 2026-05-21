import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../../db/schema.js";
import { insertBrowserVisits } from "../../../db/browser-history-store.js";
import type { SummarizedVisit } from "./summarizer.js";
import {
  aggregateCluster,
  deriveClusterDisplayName,
  deriveClusterSlug,
  extractClustersFromDb,
  qualifiesAsActiveResearch,
  type ClusterVisitRow,
} from "./cluster-extractor.js";

function dayMs(offsetDays: number): number {
  return new Date("2026-05-10T12:00:00Z").getTime() + offsetDays * 86_400_000;
}

function row(overrides: Partial<ClusterVisitRow> = {}): ClusterVisitRow {
  return {
    rootTaskId: 42,
    ts: dayMs(0),
    domain: "arxiv.org",
    category: "research",
    meaningful: 1,
    meaningfulForegroundSec: 600,
    title: null,
    searchQuery: null,
    ...overrides,
  };
}

describe("aggregateCluster", () => {
  it("buckets days by the configured timezone (Asia/Tokyo, 04:00 boundary)", () => {
    // 2026-05-21T00:00 JST = 2026-05-20T15:00 UTC → agent-day "2026-05-20"
    //   (before 04:00 JST cutoff for May 21).
    // 2026-05-21T05:00 JST = 2026-05-20T20:00 UTC → agent-day "2026-05-21".
    const visits: ClusterVisitRow[] = [
      row({ ts: Date.UTC(2026, 4, 20, 15, 0, 0), domain: "arxiv.org" }),
      row({ ts: Date.UTC(2026, 4, 20, 20, 0, 0), domain: "arxiv.org" }),
    ];
    const result = aggregateCluster(visits, {
      timezone: "Asia/Tokyo",
      dayBoundaryHour: 4,
    });
    expect(result?.distinctMeaningfulDays).toBe(2);
  });

  it("returns null for empty input", () => {
    expect(aggregateCluster([])).toBeNull();
  });

  it("counts only meaningful visits toward distinct-domain count", () => {
    const result = aggregateCluster([
      row({ domain: "arxiv.org", meaningful: 1 }),
      row({ domain: "wikipedia.org", meaningful: 1 }),
      row({ domain: "noise.com", meaningful: 0 }),
    ]);
    expect(result?.meaningfulVisitsTotal).toBe(2);
    expect(result?.distinctMeaningfulDomains).toBe(2);
    expect(result?.visitsTotal).toBe(3);
  });

  it("counts distinct days across visits", () => {
    const result = aggregateCluster([
      row({ ts: dayMs(0), domain: "arxiv.org" }),
      row({ ts: dayMs(1), domain: "wikipedia.org" }),
      row({ ts: dayMs(2), domain: "anthropic.com" }),
    ]);
    expect(result?.distinctMeaningfulDays).toBe(3);
  });

  it("sums foreground seconds across meaningful visits only", () => {
    const result = aggregateCluster([
      row({ meaningful: 1, meaningfulForegroundSec: 600 }),
      row({ meaningful: 1, meaningfulForegroundSec: 1200 }),
      row({ meaningful: 0, meaningfulForegroundSec: 100_000 }),
    ]);
    expect(result?.meaningfulForegroundSecTotal).toBe(1800);
  });
});

  it("treats null meaningfulForegroundSec as 0 in the aggregate sum (?? branch)", () => {
    const result = aggregateCluster([
      row({ meaningful: 1, meaningfulForegroundSec: null }),
      row({ meaningful: 1, meaningfulForegroundSec: 300 }),
    ]);
    expect(result?.meaningfulForegroundSecTotal).toBe(300);
  });

  it("falls back to a search-engine domain when no non-search domain exists (?? sortedDomains[0])", () => {
    const result = aggregateCluster([
      row({ domain: "google.com", meaningful: 1 }),
      row({ domain: "google.com", meaningful: 1 }),
    ]);
    // No non-search domain → topNonSearchDomain falls through to sortedDomains[0][0].
    expect(result?.topNonSearchDomain).toBe("google.com");
  });

  it("sets topNonSearchDomain to null when there are no meaningful rows (?? null)", () => {
    const result = aggregateCluster([
      row({ meaningful: 0, domain: "noise.com", searchQuery: null }),
    ]);
    expect(result?.topNonSearchDomain).toBeNull();
  });

  it("skips whitespace-only searchQuery in the term aggregator (!normalised branch)", () => {
    const result = aggregateCluster([
      row({ searchQuery: "   ", meaningful: 1 }),
      row({ searchQuery: "real query", meaningful: 1 }),
    ]);
    expect(result?.topSearchTerm).toBe("real query");
  });

describe("qualifiesAsActiveResearch", () => {
  it("rejects clusters with too few distinct days", () => {
    const aggregate = aggregateCluster(
      Array.from({ length: 25 }, () =>
        row({ ts: dayMs(0), domain: "arxiv.org", meaningfulForegroundSec: 300 }),
      ),
    );
    expect(aggregate).toBeTruthy();
    expect(qualifiesAsActiveResearch(aggregate!)).toBe(false);
  });

  it("rejects clusters with too few meaningful visits", () => {
    const aggregate = aggregateCluster([
      row({ ts: dayMs(0), domain: "arxiv.org" }),
      row({ ts: dayMs(1), domain: "wikipedia.org" }),
      row({ ts: dayMs(2), domain: "anthropic.com" }),
    ]);
    expect(qualifiesAsActiveResearch(aggregate!)).toBe(false);
  });

  it("accepts a 3-day, 20-visit, 3-domain, 60-minute cluster", () => {
    const visits: ClusterVisitRow[] = [];
    for (let i = 0; i < 21; i += 1) {
      visits.push(
        row({
          ts: dayMs(i % 3),
          domain: ["arxiv.org", "wikipedia.org", "anthropic.com"][i % 3],
          meaningfulForegroundSec: 200,
        }),
      );
    }
    const aggregate = aggregateCluster(visits);
    expect(aggregate).toBeTruthy();
    expect(qualifiesAsActiveResearch(aggregate!)).toBe(true);
  });
});

describe("deriveClusterSlug", () => {
  it("composes slug from top domain + top search term", () => {
    const aggregate = aggregateCluster([
      row({ domain: "arxiv.org", searchQuery: "quantum mechanics" }),
      row({ domain: "arxiv.org", searchQuery: "quantum mechanics" }),
      row({ domain: "wikipedia.org" }),
    ]);
    const slug = deriveClusterSlug(aggregate!);
    expect(slug).toContain("arxiv");
    expect(slug).toContain("quantum");
  });

  it("falls back to cluster-<id> when no signals", () => {
    const aggregate = aggregateCluster([
      row({ domain: "", meaningful: 0, searchQuery: null }),
    ]);
    expect(deriveClusterSlug(aggregate!)).toMatch(/^cluster-42$/);
  });

  it("falls back to cluster-<id> when the derived slug is shorter than 2 chars (length<2 branch)", () => {
    // Top domain "a" produces a 1-char slug → triggers the length<2 fallback.
    const aggregate = aggregateCluster([
      row({ domain: "a", meaningful: 1, searchQuery: null }),
    ]);
    expect(deriveClusterSlug(aggregate!)).toMatch(/^cluster-42$/);
  });
});

describe("deriveClusterDisplayName", () => {
  it("title-cases the top search term", () => {
    const aggregate = aggregateCluster([
      row({ searchQuery: "prompt injection defenses" }),
      row({ searchQuery: "prompt injection defenses" }),
    ]);
    expect(deriveClusterDisplayName(aggregate!)).toBe(
      "Prompt Injection Defenses",
    );
  });

  it("falls back to top domain when no search term", () => {
    const aggregate = aggregateCluster([
      row({ domain: "arxiv.org", searchQuery: null }),
    ]);
    expect(deriveClusterDisplayName(aggregate!)).toBe("arxiv.org");
  });

  it("falls back to 'research' when topNonSearchDomain is null (?? branch)", () => {
    const aggregate = aggregateCluster([
      row({ meaningful: 0, domain: "x", searchQuery: null }),
    ]);
    // No meaningful rows → topNonSearchDomain is null + no term → falls back.
    expect(deriveClusterDisplayName(aggregate!)).toBe("research");
  });

  it("falls back to domain when titleCased becomes empty (whitespace-only term)", () => {
    // search term is purely whitespace → after split+filter, titleCased=""
    // → returns domain. Need a meaningful row to make topNonSearchDomain non-null
    // AND a stored search term that survives the aggregator's `if (!normalised)`
    // filter (so it must trim to non-empty), yet break apart to empty parts after
    // /\s+/ split. Use a single non-space character: "x" — title-cases to "X".
    // To actually reach the empty-titleCased branch we need an aggregator-accepted
    // term whose split-on-/\s+/-and-filter yields no parts. The aggregator's
    // `if (!normalised)` rejects whitespace-only, so the only way is to invoke
    // deriveClusterDisplayName directly with a constructed aggregate.
    const synthetic = {
      rootTaskId: 1,
      startedAt: 0,
      lastActivityAt: 1,
      visitsTotal: 1,
      meaningfulVisitsTotal: 1,
      meaningfulForegroundSecTotal: 60,
      distinctMeaningfulDomains: 1,
      distinctMeaningfulDays: 1,
      topNonSearchDomain: "arxiv.org",
      topSearchTerm: "   ", // bypass the aggregator's filter — direct call
    };
    expect(deriveClusterDisplayName(synthetic)).toBe("arxiv.org");
  });
});

describe("extractClustersFromDb (edge cases)", () => {
  it("returns [] for an empty database (rows.length===0 branch)", () => {
    const db = new Database(":memory:");
    applySchema(db);
    expect(extractClustersFromDb(db)).toEqual([]);
    db.close();
  });
});

describe("extractClustersFromDb", () => {
  function visit(overrides: Partial<SummarizedVisit> = {}): SummarizedVisit {
    return {
      ts: dayMs(0),
      browser: "chrome",
      profile: "Default",
      urlHash: `hash-${Math.random()}`,
      domain: "arxiv.org",
      category: "research",
      meaningful: 1,
      dwellSec: null,
      foregroundSec: 300,
      transition: 0,
      isReload: 0,
      rootTaskId: 1,
      httpStatus: 200,
      title: "Quantum",
      searchQuery: "quantum mechanics",
      amazonAsin: null,
      amazonLocale: null,
      ...overrides,
    };
  }

  it("disambiguates two clusters that derive the same slug", () => {
    const db = new Database(":memory:");
    applySchema(db);
    // Two distinct root_task_ids whose top-domain (arxiv.org) and
    // top-search-term ("quantum mechanics") match. Without the
    // disambiguation fix, deriveClusterSlug returns the same string for
    // both, and the slug-keyed upsert would silently merge them under
    // the first inserted root_task_id.
    insertBrowserVisits(db, [
      visit({ rootTaskId: 11, urlHash: "h1" }),
      visit({ rootTaskId: 11, ts: dayMs(0) + 1, urlHash: "h1b" }),
      visit({ rootTaskId: 22, urlHash: "h2" }),
      visit({ rootTaskId: 22, ts: dayMs(0) + 1, urlHash: "h2b" }),
    ]);
    const clusters = extractClustersFromDb(db);
    db.close();
    expect(clusters).toHaveLength(2);
    const slugs = new Set(clusters.map((c) => c.slug));
    expect(slugs.size).toBe(2);
    expect(clusters.find((c) => c.aggregate.rootTaskId === 22)?.slug).toMatch(
      /-22$/,
    );
  });
});

describe("buildEngagementSnapshot (P3)", () => {
  function v(overrides: Partial<SummarizedVisit> = {}): SummarizedVisit {
    return {
      ts: dayMs(0),
      browser: "chrome",
      profile: "Default",
      urlHash: `hash-${Math.random()}`,
      domain: "arxiv.org",
      category: "research",
      meaningful: 1,
      dwellSec: null,
      foregroundSec: 300,
      transition: 0,
      isReload: 0,
      rootTaskId: 100,
      httpStatus: 200,
      title: "Quantum",
      searchQuery: "quantum mechanics",
      amazonAsin: null,
      amazonLocale: null,
      ...overrides,
    };
  }

  function clusterRow(): import("./cluster-extractor.js").ClusterRowForEngagement {
    return {
      slug: "quantum-mechanics",
      displayName: "Quantum Mechanics",
      rootTaskId: 100,
      status: "active",
      startedAt: dayMs(0),
      lastActivityAt: dayMs(0),
      meaningfulVisitsTotal: 0,
      meaningfulForegroundSecTotal: 0,
      distinctMeaningfulDomains: 0,
      lastDmAt: null,
      lastResearchOfferAt: null,
      lastWikiOfferAt: null,
      researchOfferAcceptedAt: null,
      wikiSummaryWrittenAt: null,
    };
  }

  it("treats a null foregroundSec on a meaningful visit as 0 (?? branch)", async () => {
    const db = new Database(":memory:");
    applySchema(db);
    const now = Date.parse("2026-05-20T10:00:00Z");
    insertBrowserVisits(db, [
      v({
        rootTaskId: 100,
        ts: now - 1 * 86_400_000,
        domain: "arxiv.org",
        foregroundSec: null,
        urlHash: "fg-null",
      }),
    ]);
    const { buildEngagementSnapshot } = await import("./cluster-extractor.js");
    const snap = buildEngagementSnapshot(
      db,
      clusterRow(),
      { timezone: undefined, dayBoundaryHour: 4 },
      now,
    );
    // Null foreground → recentForegroundSec stays 0.
    expect(snap?.recentForegroundSec).toBe(0);
    db.close();
  });

  it("returns null when the cluster has no meaningful rows", async () => {
    const db = new Database(":memory:");
    applySchema(db);
    const { buildEngagementSnapshot } = await import("./cluster-extractor.js");
    expect(buildEngagementSnapshot(db, clusterRow(), {
      timezone: undefined,
      dayBoundaryHour: 4,
    }, Date.now())).toBeNull();
    db.close();
  });

  it("aggregates long-read visits, recent/prior domain windows, and day buckets", async () => {
    const db = new Database(":memory:");
    applySchema(db);
    const now = Date.parse("2026-05-20T10:00:00Z");
    insertBrowserVisits(db, [
      // Long-read (≥120s) in the recent window.
      v({
        rootTaskId: 100,
        ts: now - 1 * 86_400_000,
        domain: "arxiv.org",
        foregroundSec: 300,
        urlHash: "r-1",
      }),
      // Long-read on a separate day so longReadDays = 2.
      v({
        rootTaskId: 100,
        ts: now - 2 * 86_400_000,
        domain: "wikipedia.org",
        foregroundSec: 150,
        urlHash: "r-2",
      }),
      // Short visit — not a long-read, but counts toward dayCount + recentForeground.
      v({
        rootTaskId: 100,
        ts: now - 1 * 86_400_000,
        domain: "arxiv.org",
        foregroundSec: 30,
        urlHash: "r-3",
      }),
      // Prior-window visit (8-day old) — its domain lands in priorDomains.
      v({
        rootTaskId: 100,
        ts: now - 8 * 86_400_000,
        domain: "anthropic.com",
        foregroundSec: 200,
        urlHash: "r-4",
      }),
    ]);
    const { buildEngagementSnapshot } = await import("./cluster-extractor.js");
    const snap = buildEngagementSnapshot(
      db,
      clusterRow(),
      { timezone: undefined, dayBoundaryHour: 4 },
      now,
    );
    // longReadVisits counts every meaningful visit with foreground ≥120s
    // across the entire cluster (recent + prior windows + outside both).
    // Three visits in the fixture qualify: r-1 (300s), r-2 (150s), r-4 (200s).
    expect(snap?.longReadVisits).toBe(3);
    // longReadDays — distinct agent-day buckets containing ≥1 long-read.
    expect(snap?.longReadDays).toBe(3);
    expect(snap?.recentDomains).toEqual(
      new Set(["arxiv.org", "wikipedia.org"]),
    );
    expect(snap?.priorDomains).toEqual(new Set(["anthropic.com"]));
    expect(snap?.distinctMeaningfulDays).toBe(3);
    db.close();
  });
});

describe("listActiveClustersForEngagement (P3)", () => {
  it("returns only active rows with the full engagement field set", async () => {
    const db = new Database(":memory:");
    applySchema(db);
    db.prepare(
      `INSERT INTO browser_research_clusters
         (slug, root_task_id, display_name, started_at, last_activity_at,
          visits_total, meaningful_visits_total, meaningful_foreground_sec_total,
          distinct_meaningful_domains, status)
       VALUES
         ('a', 1, 'A', 1, 2, 0, 0, 0, 0, 'active'),
         ('b', 2, 'B', 1, 2, 0, 0, 0, 0, 'muted'),
         ('c', 3, 'C', 1, 2, 0, 0, 0, 0, 'concluded')`,
    ).run();
    const { listActiveClustersForEngagement } = await import("./cluster-extractor.js");
    const rows = listActiveClustersForEngagement(db);
    expect(rows.map((r) => r.slug)).toEqual(["a"]);
    db.close();
  });
});
