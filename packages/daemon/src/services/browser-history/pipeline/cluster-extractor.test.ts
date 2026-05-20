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
