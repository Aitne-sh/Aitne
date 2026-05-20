import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import {
  applyBrowserHistoryRetention,
  browserHistoryProfileCursorKey,
  incrementReloadSignals,
  insertBrowserVisits,
  readBrowserHistoryIngestCursor,
  readBrowserHistoryIngestCursors,
  replaceShoppingSessions,
  upsertResearchClusters,
  writeBrowserHistoryIngestCursor,
} from "./browser-history-store.js";
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
});
