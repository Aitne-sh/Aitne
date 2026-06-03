import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import {
  applyBrowserHistoryRetention,
  browserHistoryProfileCursorKey,
  bumpClusterAgentSummaryRevision,
  clearClusterOfferStamps,
  deletePendingOffer,
  deletePendingOffersForCluster,
  getResearchClusterDetail,
  incrementReloadSignals,
  insertBrowserVisits,
  listClusterDailyDeltas,
  listClustersNeedingUpdate,
  listPendingOffersForCluster,
  listPendingOffersWithDisplay,
  listShoppingSessionsForDate,
  listTopDomainsForCluster,
  readBrowserHistoryCapabilities,
  readBrowserHistoryIngestCursor,
  readBrowserHistoryIngestCursors,
  readBrowserHistoryLastIngestAt,
  readBrowserLifecycleState,
  renameResearchCluster,
  replaceShoppingSessions,
  setResearchClusterStatus,
  stampClusterDmFields,
  upsertPendingOffer,
  upsertResearchClusters,
  writeBrowserHistoryCapabilities,
  writeBrowserHistoryIngestCursor,
  writeBrowserHistoryLastIngestAt,
  writeBrowserLifecycleState,
  OFFER_DEFAULT_TTL_MS,
} from "./browser-history-store.js";
import { writeRuntimeState } from "./runtime-state.js";
import type { SummarizedVisit } from "../services/browser-history/pipeline/summarizer.js";
import type { ExtractedCluster } from "../services/browser-history/pipeline/cluster-extractor.js";

function visit(overrides: Partial<SummarizedVisit> = {}): SummarizedVisit {
  return {
    ts: 1_700_000_000_000,
    browser: "chrome",
    profile: "Default",
    urlHash: "hash-1",
    domain: "arxiv.org",
    category: "research",
    meaningful: 1,
    dwellSec: null,
    foregroundSec: 120,
    transition: 0,
    isReload: 0,
    rootTaskId: 1,
    httpStatus: 200,
    title: "Quantum",
    searchQuery: null,
    amazonAsin: null,
    amazonLocale: null,
    ...overrides,
  };
}

describe("browser-history-store P2 helpers", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("ingest cursor", () => {
    it("returns 0 when no cursor stored", () => {
      expect(
        readBrowserHistoryIngestCursor(db, "chrome", "Default"),
      ).toBe(0);
    });

    it("round-trips per-profile cursor values", () => {
      writeBrowserHistoryIngestCursor(db, "chrome", "Default", 12345);
      writeBrowserHistoryIngestCursor(db, "chrome", "Profile 1", 67890);
      expect(readBrowserHistoryIngestCursor(db, "chrome", "Default")).toBe(
        12345,
      );
      expect(
        readBrowserHistoryIngestCursor(db, "chrome", "Profile 1"),
      ).toBe(67890);
    });

    it("groups all cursors under one runtime_state row", () => {
      writeBrowserHistoryIngestCursor(db, "chrome", "Default", 12345);
      writeBrowserHistoryIngestCursor(db, "brave", "Default", 67890);
      const cursors = readBrowserHistoryIngestCursors(db);
      expect(cursors[browserHistoryProfileCursorKey("chrome", "Default")]).toBe(
        12345,
      );
      expect(cursors[browserHistoryProfileCursorKey("brave", "Default")]).toBe(
        67890,
      );
    });
  });

  describe("insertBrowserVisits", () => {
    it("inserts new rows", () => {
      const result = insertBrowserVisits(db, [
        visit({ urlHash: "hash-a" }),
        visit({ urlHash: "hash-b" }),
      ]);
      expect(result.inserted).toBe(2);
      expect(result.duplicates).toBe(0);
    });

    it("deduplicates on (browser, profile, ts, url_hash)", () => {
      insertBrowserVisits(db, [visit({ urlHash: "hash-a" })]);
      const result = insertBrowserVisits(db, [visit({ urlHash: "hash-a" })]);
      expect(result.inserted).toBe(0);
      expect(result.duplicates).toBe(1);
    });

    it("returns {0,0} for empty input", () => {
      expect(insertBrowserVisits(db, [])).toEqual({ inserted: 0, duplicates: 0 });
    });
  });

  describe("incrementReloadSignals", () => {
    it("upserts and accumulates counts per (date, pattern)", () => {
      incrementReloadSignals(db, [
        { date: "2026-05-19", urlPattern: "claude.ai/usage", count: 2 },
      ]);
      incrementReloadSignals(db, [
        { date: "2026-05-19", urlPattern: "claude.ai/usage", count: 3 },
      ]);
      const row = db
        .prepare(
          "SELECT reload_count FROM browser_reload_signals WHERE date = ? AND url_pattern = ?",
        )
        .get("2026-05-19", "claude.ai/usage") as { reload_count: number };
      expect(row.reload_count).toBe(5);
    });
  });

  describe("upsertResearchClusters", () => {
    const nowMs = 1_725_000_000_000;
    function cluster(
      overrides: Partial<ExtractedCluster["aggregate"]> = {},
      qualifies = true,
    ): ExtractedCluster {
      return {
        slug: "quantum-mechanics",
        displayName: "Quantum Mechanics",
        aggregate: {
          rootTaskId: 11,
          startedAt: nowMs - 3 * 86_400_000,
          lastActivityAt: nowMs,
          visitsTotal: 30,
          meaningfulVisitsTotal: 25,
          meaningfulForegroundSecTotal: 4000,
          distinctMeaningfulDomains: 4,
          distinctMeaningfulDays: 3,
          topNonSearchDomain: "arxiv.org",
          topSearchTerm: "quantum mechanics",
          ...overrides,
        },
        qualifies,
      };
    }

    it("inserts then updates the cluster row", () => {
      upsertResearchClusters(db, [cluster()], nowMs);
      upsertResearchClusters(
        db,
        [cluster({ meaningfulVisitsTotal: 40 })],
        nowMs,
      );
      const row = db
        .prepare(
          "SELECT meaningful_visits_total AS n, status FROM browser_research_clusters WHERE slug = ?",
        )
        .get("quantum-mechanics") as { n: number; status: string };
      expect(row.n).toBe(40);
      expect(row.status).toBe("active");
    });

    it("respects muted status across upserts", () => {
      upsertResearchClusters(db, [cluster()], nowMs);
      db.prepare("UPDATE browser_research_clusters SET status = 'muted'").run();
      upsertResearchClusters(db, [cluster()], nowMs);
      const row = db
        .prepare(
          "SELECT status FROM browser_research_clusters WHERE slug = ?",
        )
        .get("quantum-mechanics") as { status: string };
      expect(row.status).toBe("muted");
    });

    it("sets dormant status when below qualification threshold", () => {
      upsertResearchClusters(db, [cluster({}, false)], nowMs);
      const row = db
        .prepare(
          "SELECT status FROM browser_research_clusters WHERE slug = ?",
        )
        .get("quantum-mechanics") as { status: string };
      expect(row.status).toBe("dormant");
    });

    it("transitions stale clusters to dormant after 10 days of inactivity", () => {
      const olderActivity = nowMs - 11 * 86_400_000;
      upsertResearchClusters(
        db,
        [cluster({ lastActivityAt: olderActivity })],
        nowMs,
      );
      const row = db
        .prepare(
          "SELECT status FROM browser_research_clusters WHERE slug = ?",
        )
        .get("quantum-mechanics") as { status: string };
      expect(row.status).toBe("dormant");
    });

    it("updates by root_task_id when the derived slug drifts (no UNIQUE crash)", () => {
      // First tick: dominant term yields slug "quantum-mechanics".
      upsertResearchClusters(db, [cluster()], nowMs);
      // Next tick for the SAME root task: the dominant domain/term shifted, so
      // the extractor derives a different slug. The stable identity is
      // root_task_id — this must update in place, not throw on the root_task_id
      // UNIQUE constraint.
      expect(() =>
        upsertResearchClusters(
          db,
          [
            {
              ...cluster({ meaningfulVisitsTotal: 99 }),
              slug: "stack-overflow-rust",
              displayName: "Stack Overflow Rust",
            },
          ],
          nowMs,
        ),
      ).not.toThrow();
      const rows = db
        .prepare(
          "SELECT slug, meaningful_visits_total AS n FROM browser_research_clusters WHERE root_task_id = ?",
        )
        .all(11) as { slug: string; n: number }[];
      // Exactly one row, the persisted slug preserved (so pending offers keyed
      // on the old slug stay joined), counters updated.
      expect(rows).toHaveLength(1);
      expect(rows[0].slug).toBe("quantum-mechanics");
      expect(rows[0].n).toBe(99);
    });

    it("disambiguates the slug PK when two roots derive the same slug across ticks", () => {
      upsertResearchClusters(db, [cluster({ rootTaskId: 11 })], nowMs);
      // A different root task derives the same base slug in a later tick — the
      // in-run usedSlugs set can't see the persisted row, so the store must
      // disambiguate to avoid the slug PRIMARY KEY collision.
      expect(() =>
        upsertResearchClusters(db, [cluster({ rootTaskId: 22 })], nowMs),
      ).not.toThrow();
      const slugs = db
        .prepare(
          "SELECT slug FROM browser_research_clusters ORDER BY root_task_id",
        )
        .all() as { slug: string }[];
      expect(slugs.map((r) => r.slug)).toEqual([
        "quantum-mechanics",
        "quantum-mechanics-22",
      ]);
    });
  });

  describe("replaceShoppingSessions", () => {
    it("replaces all rows for a date", () => {
      replaceShoppingSessions(db, "2026-05-19", [
        {
          date: "2026-05-19",
          vendor: "amazon",
          asinSet: ["B01", "B02", "B03"],
          comparisonMinutes: 12,
          locale: "co.jp",
        },
      ]);
      replaceShoppingSessions(db, "2026-05-19", [
        {
          date: "2026-05-19",
          vendor: "amazon",
          asinSet: ["B04", "B05", "B06"],
          comparisonMinutes: 10,
          locale: "com",
        },
      ]);
      const rows = db
        .prepare(
          "SELECT vendor, asin_set, comparison_minutes, locale FROM browser_shopping_sessions WHERE date = ?",
        )
        .all("2026-05-19");
      expect(rows).toHaveLength(1);
    });
  });

  describe("applyBrowserHistoryRetention", () => {
    it("deletes visits older than the retention cutoff", () => {
      const now = Date.now();
      insertBrowserVisits(db, [
        visit({ ts: now - 60 * 86_400_000, urlHash: "old" }),
        visit({ ts: now, urlHash: "fresh" }),
      ]);
      const result = applyBrowserHistoryRetention(
        db,
        { visitRetentionDays: 30, searchQueryRetentionDays: 7 },
        now,
      );
      expect(result.visitsDeleted).toBe(1);
      const remaining = db
        .prepare("SELECT COUNT(*) AS n FROM browser_visits")
        .get() as { n: number };
      expect(remaining.n).toBe(1);
    });

    it("clears search queries older than the search-query cutoff", () => {
      const now = Date.now();
      insertBrowserVisits(db, [
        visit({
          ts: now - 10 * 86_400_000,
          urlHash: "old-search",
          searchQuery: "secret query",
        }),
      ]);
      applyBrowserHistoryRetention(
        db,
        { visitRetentionDays: 30, searchQueryRetentionDays: 7 },
        now,
      );
      const row = db
        .prepare("SELECT search_query FROM browser_visits")
        .get() as { search_query: string | null };
      expect(row.search_query).toBeNull();
    });
  });

  // ── P3 engagement helpers ──

  function seedCluster(rootTaskId: number, slug: string): void {
    const cluster: ExtractedCluster = {
      slug,
      displayName: "Quantum Mechanics",
      aggregate: {
        rootTaskId,
        startedAt: 1_700_000_000_000,
        lastActivityAt: 1_700_000_000_000,
        visitsTotal: 1,
        meaningfulVisitsTotal: 1,
        meaningfulForegroundSecTotal: 120,
        distinctMeaningfulDomains: 1,
        distinctMeaningfulDays: 1,
        topNonSearchDomain: "arxiv.org",
        topSearchTerm: null,
      },
      qualifies: true,
    };
    upsertResearchClusters(db, [cluster]);
  }

  describe("getResearchClusterDetail", () => {
    it("returns null when slug not found", () => {
      expect(getResearchClusterDetail(db, "missing")).toBeNull();
    });

    it("returns the full row when the cluster exists", () => {
      seedCluster(42, "quantum-mechanics");
      const detail = getResearchClusterDetail(db, "quantum-mechanics");
      expect(detail?.slug).toBe("quantum-mechanics");
      expect(detail?.rootTaskId).toBe(42);
      expect(detail?.lastDmAt).toBeNull();
    });
  });

  describe("listTopDomainsForCluster", () => {
    it("orders distinct meaningful domains by descending visit count", () => {
      seedCluster(7, "topic");
      insertBrowserVisits(db, [
        visit({ rootTaskId: 7, urlHash: "h-1", domain: "arxiv.org", meaningful: 1 }),
        visit({ rootTaskId: 7, urlHash: "h-2", domain: "arxiv.org", meaningful: 1 }),
        visit({
          rootTaskId: 7,
          urlHash: "h-3",
          domain: "wikipedia.org",
          meaningful: 1,
        }),
        visit({
          rootTaskId: 7,
          urlHash: "h-4",
          domain: "noise.example.com",
          meaningful: 0,
        }),
      ]);
      const domains = listTopDomainsForCluster(db, 7);
      expect(domains[0]).toBe("arxiv.org");
      expect(domains).toContain("wikipedia.org");
      expect(domains).not.toContain("noise.example.com");
    });
  });

  describe("listClusterDailyDeltas", () => {
    it("buckets meaningful visits by agent-day and reports new domains", () => {
      const day1 = Date.parse("2026-05-15T10:00:00Z");
      const day2 = Date.parse("2026-05-16T10:00:00Z");
      seedCluster(9, "x");
      insertBrowserVisits(db, [
        visit({
          ts: day1,
          rootTaskId: 9,
          urlHash: "d1-a",
          domain: "arxiv.org",
          foregroundSec: 300,
        }),
        visit({
          ts: day2,
          rootTaskId: 9,
          urlHash: "d2-a",
          domain: "arxiv.org",
          foregroundSec: 200,
        }),
        visit({
          ts: day2,
          rootTaskId: 9,
          urlHash: "d2-b",
          domain: "wikipedia.org",
          foregroundSec: 400,
        }),
      ]);
      const days = listClusterDailyDeltas(db, 9, {
        timezone: undefined,
        dayBoundaryHour: 4,
      });
      expect(days.length).toBe(2);
      expect(days[0].newDomains).toEqual(["arxiv.org"]);
      expect(days[1].newDomains).toEqual(["wikipedia.org"]);
    });

    it("returns empty when the cluster has no meaningful rows", () => {
      seedCluster(11, "empty");
      expect(
        listClusterDailyDeltas(db, 11, {
          timezone: undefined,
          dayBoundaryHour: 4,
        }),
      ).toEqual([]);
    });

    it("honours dayLimit and sinceMs", () => {
      seedCluster(13, "limited");
      const base = Date.parse("2026-05-20T10:00:00Z");
      // Three days of visits.
      insertBrowserVisits(db, [
        visit({
          ts: base,
          rootTaskId: 13,
          urlHash: "a",
          domain: "arxiv.org",
          foregroundSec: 200,
        }),
        visit({
          ts: base + 86_400_000,
          rootTaskId: 13,
          urlHash: "b",
          domain: "wikipedia.org",
          foregroundSec: 200,
        }),
        visit({
          ts: base + 2 * 86_400_000,
          rootTaskId: 13,
          urlHash: "c",
          domain: "anthropic.com",
          foregroundSec: 200,
        }),
      ]);
      const days = listClusterDailyDeltas(
        db,
        13,
        { timezone: undefined, dayBoundaryHour: 4 },
        { dayLimit: 2 },
      );
      expect(days.length).toBe(2);
      const sinceDays = listClusterDailyDeltas(
        db,
        13,
        { timezone: undefined, dayBoundaryHour: 4 },
        { sinceMs: base + 86_400_000 },
      );
      expect(sinceDays.length).toBe(2);
    });
  });

  describe("stampClusterDmFields / setResearchClusterStatus / renameResearchCluster", () => {
    it("stamps lastDmAt + offer columns, coalescing nulls", () => {
      seedCluster(15, "stamp");
      stampClusterDmFields(db, "stamp", { lastDmAt: 1_700_000_000_000 });
      stampClusterDmFields(db, "stamp", {
        lastResearchOfferAt: 1_700_000_001_000,
      });
      const detail = getResearchClusterDetail(db, "stamp");
      expect(detail?.lastDmAt).toBe(1_700_000_000_000);
      expect(detail?.lastResearchOfferAt).toBe(1_700_000_001_000);
    });

    it("setResearchClusterStatus returns false on missing slug", () => {
      expect(setResearchClusterStatus(db, "missing", "muted")).toBe(false);
    });

    it("setResearchClusterStatus flips status when found", () => {
      seedCluster(17, "alive");
      expect(setResearchClusterStatus(db, "alive", "muted")).toBe(true);
      expect(getResearchClusterDetail(db, "alive")?.status).toBe("muted");
    });

    it("renameResearchCluster updates display_name and bumps revision", () => {
      seedCluster(19, "named");
      expect(renameResearchCluster(db, "named", "Custom Name")).toBe(true);
      const detail = getResearchClusterDetail(db, "named");
      expect(detail?.displayName).toBe("Custom Name");
      expect(detail?.agentSummaryRevision).toBe(1);
    });

    it("renameResearchCluster returns false on missing slug", () => {
      expect(renameResearchCluster(db, "missing", "x")).toBe(false);
    });

    it("bumpClusterAgentSummaryRevision increments and returns the new value", () => {
      seedCluster(21, "rev");
      expect(bumpClusterAgentSummaryRevision(db, "rev")).toBe(1);
      expect(bumpClusterAgentSummaryRevision(db, "rev")).toBe(2);
      expect(bumpClusterAgentSummaryRevision(db, "missing")).toBe(0);
    });

    it("clearClusterOfferStamps nulls the requested last_*_offer_at columns", () => {
      seedCluster(23, "clear-wiki");
      stampClusterDmFields(db, "clear-wiki", {
        lastDmAt: 1_700_000_000_000,
        lastResearchOfferAt: 1_700_000_000_000,
        lastWikiOfferAt: 1_700_000_000_000,
      });
      clearClusterOfferStamps(db, "clear-wiki", { lastWikiOfferAt: true });
      const detail = getResearchClusterDetail(db, "clear-wiki");
      expect(detail?.lastWikiOfferAt).toBeNull();
      // Adjacent stamps untouched — the call is column-scoped.
      expect(detail?.lastResearchOfferAt).toBe(1_700_000_000_000);
      expect(detail?.lastDmAt).toBe(1_700_000_000_000);
    });

    it("clearClusterOfferStamps clears both columns when both flags are set", () => {
      seedCluster(25, "clear-both");
      stampClusterDmFields(db, "clear-both", {
        lastResearchOfferAt: 1_700_000_000_000,
        lastWikiOfferAt: 1_700_000_000_000,
      });
      clearClusterOfferStamps(db, "clear-both", {
        lastResearchOfferAt: true,
        lastWikiOfferAt: true,
      });
      const detail = getResearchClusterDetail(db, "clear-both");
      expect(detail?.lastResearchOfferAt).toBeNull();
      expect(detail?.lastWikiOfferAt).toBeNull();
    });

    it("clearClusterOfferStamps is a no-op when no flags are set", () => {
      seedCluster(27, "clear-none");
      stampClusterDmFields(db, "clear-none", {
        lastWikiOfferAt: 1_700_000_000_000,
      });
      clearClusterOfferStamps(db, "clear-none", {});
      const detail = getResearchClusterDetail(db, "clear-none");
      expect(detail?.lastWikiOfferAt).toBe(1_700_000_000_000);
    });
  });

  describe("pending offers", () => {
    it("upserts, lists, and deletes single offer rows", () => {
      seedCluster(23, "offer");
      const now = 1_700_000_000_000;
      upsertPendingOffer(db, {
        slug: "offer",
        kind: "research_assist",
        offeredAt: now,
        expiresAt: now + OFFER_DEFAULT_TTL_MS,
      });
      const list = listPendingOffersWithDisplay(db, now + 1);
      expect(list.length).toBe(1);
      expect(list[0].slug).toBe("offer");
      expect(list[0].displayName).toBe("Quantum Mechanics");
      // Re-upsert refreshes expiresAt.
      upsertPendingOffer(db, {
        slug: "offer",
        kind: "research_assist",
        offeredAt: now + 1000,
        expiresAt: now + 2000,
      });
      expect(deletePendingOffer(db, "offer", "research_assist")).toBe(true);
      expect(deletePendingOffer(db, "offer", "research_assist")).toBe(false);
    });

    it("lazily purges expired offer rows from listPendingOffersWithDisplay", () => {
      seedCluster(25, "expired");
      const now = 1_700_000_000_000;
      upsertPendingOffer(db, {
        slug: "expired",
        kind: "wiki_summary",
        offeredAt: now - 30 * 86_400_000,
        expiresAt: now - 16 * 86_400_000,
      });
      const list = listPendingOffersWithDisplay(db, now);
      expect(list).toEqual([]);
    });

    it("scopes listPendingOffersForCluster to its slug + non-expired filter", () => {
      seedCluster(27, "scope-a");
      seedCluster(29, "scope-b");
      const now = 1_700_000_000_000;
      upsertPendingOffer(db, {
        slug: "scope-a",
        kind: "research_assist",
        offeredAt: now,
        expiresAt: now + 10_000,
      });
      upsertPendingOffer(db, {
        slug: "scope-b",
        kind: "wiki_summary",
        offeredAt: now,
        expiresAt: now + 10_000,
      });
      expect(listPendingOffersForCluster(db, "scope-a", now)).toHaveLength(1);
      expect(listPendingOffersForCluster(db, "scope-b", now)).toHaveLength(1);
      // Expired row is filtered out by the WHERE clause.
      upsertPendingOffer(db, {
        slug: "scope-a",
        kind: "wiki_summary",
        offeredAt: now - 10_000,
        expiresAt: now - 1,
      });
      expect(
        listPendingOffersForCluster(db, "scope-a", now).map((r) => r.kind),
      ).toEqual(["research_assist"]);
    });

    it("deletes all pending offers for a slug", () => {
      seedCluster(31, "bulk");
      const now = 1_700_000_000_000;
      upsertPendingOffer(db, {
        slug: "bulk",
        kind: "research_assist",
        offeredAt: now,
        expiresAt: now + 10_000,
      });
      upsertPendingOffer(db, {
        slug: "bulk",
        kind: "wiki_summary",
        offeredAt: now,
        expiresAt: now + 10_000,
      });
      expect(deletePendingOffersForCluster(db, "bulk")).toBe(2);
      expect(deletePendingOffersForCluster(db, "bulk")).toBe(0);
    });
  });

  describe("listClustersNeedingUpdate", () => {
    function rawSeed(
      slug: string,
      rootTaskId: number,
      status: "active" | "dormant" | "muted" | "concluded",
      lastActivityAt: number,
    ): void {
      db.prepare(
        `INSERT INTO browser_research_clusters
           (slug, root_task_id, display_name, started_at, last_activity_at,
            visits_total, meaningful_visits_total, meaningful_foreground_sec_total,
            distinct_meaningful_domains, status)
         VALUES (?, ?, ?, ?, ?, 1, 1, 120, 1, ?)`,
      ).run(slug, rootTaskId, slug, lastActivityAt, lastActivityAt, status);
    }

    it("returns only active clusters with recent activity, capped at limit", () => {
      const now = Date.now();
      rawSeed("fresh", 33, "active", now - 10_000);
      rawSeed("stale", 35, "active", now - 10 * 86_400_000);
      rawSeed("muted", 37, "muted", now - 10_000);
      const out = listClustersNeedingUpdate(db, 24 * 60 * 60 * 1000, now, 25);
      expect(out.map((r) => r.slug)).toEqual(["fresh"]);
    });

    it("respects the limit argument", () => {
      const now = Date.now();
      for (let i = 0; i < 5; i += 1) {
        rawSeed(`row-${i}`, 100 + i, "active", now - (i + 1) * 1000);
      }
      const out = listClustersNeedingUpdate(db, 24 * 60 * 60 * 1000, now, 2);
      expect(out).toHaveLength(2);
    });
  });

  describe("runtime-state helpers (capabilities / lifecycle / lastIngest)", () => {
    const CAPS_KEY = "browser_history_capabilities";
    const LIFECYCLE_KEY = "browser_lifecycle_state";
    const LAST_INGEST_KEY = "browser_history_last_ingest_at";

    it("readBrowserHistoryCapabilities returns null when key is absent", () => {
      expect(readBrowserHistoryCapabilities(db)).toBeNull();
    });

    it("readBrowserHistoryCapabilities returns null when stored value fails schema parse", () => {
      writeRuntimeState(db, CAPS_KEY, { not: "a capabilities shape" });
      expect(readBrowserHistoryCapabilities(db)).toBeNull();
    });

    it("readBrowserHistoryCapabilities round-trips a valid value", () => {
      const value = {
        detectedAt: "2026-05-20T10:00:00.000Z",
        browsers: { chrome: "available" as const },
        ingestEnabled: ["chrome" as const],
        details: {},
      };
      writeBrowserHistoryCapabilities(db, value);
      expect(readBrowserHistoryCapabilities(db)).toMatchObject({
        browsers: { chrome: "available" },
      });
    });

    it("readBrowserLifecycleState returns {} when absent", () => {
      expect(readBrowserLifecycleState(db)).toEqual({});
    });

    it("readBrowserLifecycleState returns {} when stored value fails schema parse", () => {
      writeRuntimeState(db, LIFECYCLE_KEY, "not an object");
      expect(readBrowserLifecycleState(db)).toEqual({});
    });

    it("writeBrowserLifecycleState round-trips through readBrowserLifecycleState", () => {
      writeBrowserLifecycleState(db, {
        chrome: {
          state: "healthy",
          lastLaunchAt: 1,
          lastSuccessfulSyncAt: 2,
          lastCheckedAt: 3,
          consecutiveFailures: 0,
          pausedUntil: null,
          lastOutcome: "success",
        },
      });
      const read = readBrowserLifecycleState(db);
      expect(read.chrome?.state).toBe("healthy");
    });

    it("readBrowserHistoryLastIngestAt returns null when absent", () => {
      expect(readBrowserHistoryLastIngestAt(db)).toBeNull();
    });

    it("readBrowserHistoryLastIngestAt returns null when stored value is not a number", () => {
      writeRuntimeState(db, LAST_INGEST_KEY, "not-a-number");
      expect(readBrowserHistoryLastIngestAt(db)).toBeNull();
    });

    it("readBrowserHistoryLastIngestAt returns null when stored value is NaN", () => {
      writeRuntimeState(db, LAST_INGEST_KEY, Number.NaN);
      expect(readBrowserHistoryLastIngestAt(db)).toBeNull();
    });

    it("writeBrowserHistoryLastIngestAt persists and reads back", () => {
      writeBrowserHistoryLastIngestAt(db, 123_456_789);
      expect(readBrowserHistoryLastIngestAt(db)).toBe(123_456_789);
    });
  });

  describe("empty-input early returns", () => {
    it("incrementReloadSignals returns without prepare when increments is empty", () => {
      expect(() => incrementReloadSignals(db, [])).not.toThrow();
    });

    it("upsertResearchClusters returns without prepare when clusters is empty", () => {
      expect(() => upsertResearchClusters(db, [])).not.toThrow();
    });

    it("replaceShoppingSessions only deletes when sessions is empty", () => {
      replaceShoppingSessions(db, "2026-05-20", [
        {
          date: "2026-05-20",
          vendor: "amazon",
          asinSet: ["B08XYZ1234"],
          comparisonMinutes: 30,
          locale: "com",
        },
      ]);
      expect(listShoppingSessionsForDate(db, "2026-05-20")).toHaveLength(1);
      // Empty replacement → row should be wiped.
      replaceShoppingSessions(db, "2026-05-20", []);
      expect(listShoppingSessionsForDate(db, "2026-05-20")).toHaveLength(0);
    });
  });

  describe("shopping session corruption guard", () => {
    it("returns empty asins array when stored asin_set is not valid JSON", () => {
      db.prepare(
        `INSERT INTO browser_shopping_sessions
           (date, vendor, asin_set, comparison_minutes, locale)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("2026-05-20", "amazon", "{ not valid json", 5, "com");
      const sessions = listShoppingSessionsForDate(db, "2026-05-20");
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.asins).toEqual([]);
    });

    it("returns empty asins array when stored asin_set parses to a non-array", () => {
      db.prepare(
        `INSERT INTO browser_shopping_sessions
           (date, vendor, asin_set, comparison_minutes, locale)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("2026-05-20", "amazon", '{"oops": "object"}', 5, "com");
      const sessions = listShoppingSessionsForDate(db, "2026-05-20");
      expect(sessions[0]?.asins).toEqual([]);
    });
  });

  describe("listClusterDailyDeltas — null foregroundSec handling", () => {
    it("treats null foreground_sec as 0 in the bucket sum (?? branch)", () => {
      // Seed cluster with one visit whose foreground_sec is NULL.
      db.prepare(
        `INSERT INTO browser_research_clusters
           (slug, root_task_id, display_name, started_at, last_activity_at,
            visits_total, meaningful_visits_total, meaningful_foreground_sec_total,
            distinct_meaningful_domains, status)
         VALUES (?, ?, ?, ?, ?, 1, 1, 0, 1, 'active')`,
      ).run("null-fg", 999, "null-fg", 1, 1);
      insertBrowserVisits(db, [
        visit({
          rootTaskId: 999,
          ts: Date.parse("2026-05-20T10:00:00Z"),
          foregroundSec: null,
          urlHash: "v-null-fg",
        }),
      ]);
      const deltas = listClusterDailyDeltas(db, 999, {
        timezone: "UTC",
        dayBoundaryHour: 0,
      });
      expect(deltas[0]?.meaningfulForegroundSec).toBe(0);
    });
  });
});
