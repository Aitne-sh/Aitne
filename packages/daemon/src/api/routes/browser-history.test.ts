import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { applySchema } from "../../db/schema.js";
import {
  incrementReloadSignals,
  replaceShoppingSessions,
  writeBrowserHistoryCapabilities,
  writeBrowserLifecycleState,
  writeBrowserHistoryLastIngestAt,
} from "../../db/browser-history-store.js";
import { createBrowserHistoryRoutes } from "./browser-history.js";

function makeApp(db: Database.Database): Hono {
  const app = new Hono();
  app.route(
    "/api",
    createBrowserHistoryRoutes({
      db,
      config: {
        dataDir: "/tmp/pa-test",
        timezone: "UTC",
        dayBoundaryHour: 4,
      },
    } as never),
  );
  return app;
}

describe("browser history API routes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("GET /browser-history/status returns persisted capabilities and lifecycle state", async () => {
    writeBrowserHistoryCapabilities(db, {
      detectedAt: "2026-05-20T00:00:00.000Z",
      browsers: { chrome: "available" },
      ingestEnabled: ["chrome"],
      details: {
        chrome: {
          status: "available",
          profileCount: 1,
          readableProfiles: 1,
          signedInProfiles: 1,
          lastHistoryMtimeMs: 100,
          nonCanonicalLayout: false,
          message: null,
        },
      },
    });
    writeBrowserLifecycleState(db, {
      chrome: {
        state: "healthy",
        lastLaunchAt: 10,
        lastSuccessfulSyncAt: 20,
        lastCheckedAt: 30,
        consecutiveFailures: 0,
        pausedUntil: null,
        lastOutcome: "success",
      },
    });
    writeBrowserHistoryLastIngestAt(db, 123);

    const res = await makeApp(db).request("/api/browser-history/status");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      capabilities: { browsers: { chrome: string }; ingestEnabled: string[] };
      lifecycle: { chrome: { state: string } };
      lastIngestAt: number;
    };
    expect(body.capabilities.browsers.chrome).toBe("available");
    expect(body.capabilities.ingestEnabled).toEqual(["chrome"]);
    expect(body.lifecycle.chrome.state).toBe("healthy");
    expect(body.lastIngestAt).toBe(123);
  });

  it("P1 data endpoints return empty validated shapes until the poller is wired", async () => {
    const app = makeApp(db);
    const clusters = await app.request("/api/browser-history/research-clusters");
    expect(clusters.status).toBe(200);
    expect(await clusters.json()).toMatchObject({ clusters: [] });

    const summary = await app.request(
      "/api/browser-history/yesterday-summary?date=2026-05-19",
    );
    expect(summary.status).toBe(200);
    expect(await summary.json()).toEqual({
      date: "2026-05-19",
      sessions: [],
    });
  });

  it("GET /browser-history/shopping/:date returns matching sessions", async () => {
    replaceShoppingSessions(db, "2026-05-19", [
      {
        date: "2026-05-19",
        vendor: "amazon",
        asinSet: ["B01ABCDEFG", "B02ABCDEFG", "B03ABCDEFG"],
        comparisonMinutes: 14,
        locale: "co.jp",
      },
    ]);
    const res = await makeApp(db).request(
      "/api/browser-history/shopping/2026-05-19",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ asins: string[]; locale: string }> };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].asins).toEqual([
      "B01ABCDEFG",
      "B02ABCDEFG",
      "B03ABCDEFG",
    ]);
    expect(body.sessions[0].locale).toBe("co.jp");
  });

  it("GET /browser-history/shopping/:date rejects malformed dates", async () => {
    const res = await makeApp(db).request("/api/browser-history/shopping/notadate");
    expect(res.status).toBe(400);
  });

  it("GET /browser-history/reloads/today returns top patterns for the date", async () => {
    incrementReloadSignals(db, [
      { date: "2026-05-20", urlPattern: "claude.ai/usage", count: 7 },
      { date: "2026-05-20", urlPattern: "twitter.com/home", count: 12 },
    ]);
    const res = await makeApp(db).request(
      "/api/browser-history/reloads/today?date=2026-05-20",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      date: string;
      entries: Array<{ urlPattern: string; reloadCount: number }>;
    };
    expect(body.date).toBe("2026-05-20");
    expect(body.entries[0]).toEqual({
      urlPattern: "twitter.com/home",
      reloadCount: 12,
    });
  });

  it("GET /browser-history/reloads/weekly aggregates across the range", async () => {
    incrementReloadSignals(db, [
      { date: "2026-05-18", urlPattern: "claude.ai/usage", count: 3 },
      { date: "2026-05-19", urlPattern: "claude.ai/usage", count: 5 },
      { date: "2026-05-20", urlPattern: "claude.ai/usage", count: 2 },
    ]);
    const res = await makeApp(db).request(
      "/api/browser-history/reloads/weekly?start=2026-05-18&end=2026-05-20",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ urlPattern: string; reloadCount: number; days: number }>;
    };
    expect(body.entries[0]).toEqual({
      urlPattern: "claude.ai/usage",
      reloadCount: 10,
      days: 3,
    });
  });

  // BROWSER_HISTORY_INTEGRATION_PLAN §10.6 — agent write-back endpoint.
  // The accept paths deliberately leave `wikiSummaryWrittenAt` null so
  // the wiki task-flow's materiality check (step 3) does not skip the
  // very write the operator just asked for. Once the agent writes the
  // wiki note, it calls this endpoint to advance the column. Without
  // this stamp, the templated `wiki_summary_offer` would re-fire 14
  // days later despite a wiki already existing on disk.
  describe("POST /browser-history/research-clusters/:slug/wiki-written", () => {
    function seedCluster(db: Database.Database, slug: string): void {
      db.prepare(
        `INSERT INTO browser_research_clusters (
           slug, root_task_id, display_name, started_at, last_activity_at,
           visits_total, meaningful_visits_total, meaningful_foreground_sec_total,
           distinct_meaningful_domains, status
         ) VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 'active')`,
      ).run(slug, 1, "Quantum mechanics");
    }

    it("stamps wikiSummaryWrittenAt and returns the stamped timestamp", async () => {
      seedCluster(db, "quantum-mechanics");
      const app = makeApp(db);
      const res = await app.request(
        "/api/browser-history/research-clusters/quantum-mechanics/wiki-written",
        { method: "POST" },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        slug: string;
        wikiSummaryWrittenAt: number;
      };
      expect(body.slug).toBe("quantum-mechanics");
      expect(body.wikiSummaryWrittenAt).toBeGreaterThan(0);
      const row = db
        .prepare(
          `SELECT wiki_summary_written_at AS writtenAt
           FROM browser_research_clusters WHERE slug = ?`,
        )
        .get("quantum-mechanics") as { writtenAt: number | null };
      expect(row.writtenAt).toBe(body.wikiSummaryWrittenAt);
    });

    it("returns 404 for an unknown slug without mutating any row", async () => {
      const app = makeApp(db);
      const res = await app.request(
        "/api/browser-history/research-clusters/never-existed/wiki-written",
        { method: "POST" },
      );
      expect(res.status).toBe(404);
      const count = db
        .prepare(`SELECT COUNT(*) AS n FROM browser_research_clusters`)
        .get() as { n: number };
      expect(count.n).toBe(0);
    });

    it("rejects a malformed slug with 400", async () => {
      const app = makeApp(db);
      const res = await app.request(
        "/api/browser-history/research-clusters/UPPER-case-bad/wiki-written",
        { method: "POST" },
      );
      expect(res.status).toBe(400);
    });
  });

  // BROWSER_HISTORY_INTEGRATION_PLAN seventh-pass — the API accept
  // endpoint must clear ALL pending rows for the slug, including the
  // seventh-pass kind='offered' row. Deleting only the kind matching
  // the request body would orphan the 'offered' row and silence the
  // cluster for the 14-day TTL. This test fakes an EventBus so the
  // accept path's enqueue + post-enqueue cleanup actually runs.
  describe("POST /browser-history/offers/:slug/accept — pending cleanup", () => {
    function seedCluster(db: Database.Database, slug: string): void {
      db.prepare(
        `INSERT INTO browser_research_clusters (
           slug, root_task_id, display_name, started_at, last_activity_at,
           visits_total, meaningful_visits_total, meaningful_foreground_sec_total,
           distinct_meaningful_domains, status
         ) VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 'active')`,
      ).run(slug, 1, "Quantum mechanics");
    }

    function makeAppWithBus(db: Database.Database): Hono {
      const app = new Hono();
      app.route(
        "/api",
        createBrowserHistoryRoutes({
          db,
          config: {
            dataDir: "/tmp/pa-test",
            timezone: "UTC",
            dayBoundaryHour: 4,
          },
          eventBus: { put: async () => {} },
        } as never),
      );
      return app;
    }

    it("clears a kind='offered' pending row when accepting research_assist", async () => {
      seedCluster(db, "quantum-mechanics");
      db.prepare(
        `INSERT INTO browser_pending_offers (slug, kind, offered_at, expires_at)
         VALUES ('quantum-mechanics', 'offered', 0, 9999999999999)`,
      ).run();
      const app = makeAppWithBus(db);
      const res = await app.request(
        "/api/browser-history/offers/quantum-mechanics/accept",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "research_assist" }),
        },
      );
      expect(res.status).toBe(200);
      const count = db
        .prepare(`SELECT COUNT(*) AS n FROM browser_pending_offers`)
        .get() as { n: number };
      expect(count.n).toBe(0);
    });

    it("clears a kind='offered' pending row when accepting wiki_summary", async () => {
      seedCluster(db, "quantum-mechanics");
      db.prepare(
        `INSERT INTO browser_pending_offers (slug, kind, offered_at, expires_at)
         VALUES ('quantum-mechanics', 'offered', 0, 9999999999999)`,
      ).run();
      const app = makeAppWithBus(db);
      const res = await app.request(
        "/api/browser-history/offers/quantum-mechanics/accept",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "wiki_summary" }),
        },
      );
      expect(res.status).toBe(200);
      const count = db
        .prepare(`SELECT COUNT(*) AS n FROM browser_pending_offers`)
        .get() as { n: number };
      expect(count.n).toBe(0);
    });

    it("also clears legacy P3b-shape kind='research_assist' rows (no regression)", async () => {
      seedCluster(db, "quantum-mechanics");
      db.prepare(
        `INSERT INTO browser_pending_offers (slug, kind, offered_at, expires_at)
         VALUES ('quantum-mechanics', 'research_assist', 0, 9999999999999)`,
      ).run();
      const app = makeAppWithBus(db);
      const res = await app.request(
        "/api/browser-history/offers/quantum-mechanics/accept",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "research_assist" }),
        },
      );
      expect(res.status).toBe(200);
      const count = db
        .prepare(`SELECT COUNT(*) AS n FROM browser_pending_offers`)
        .get() as { n: number };
      expect(count.n).toBe(0);
    });
  });
});
