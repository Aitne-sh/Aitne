import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applySchema } from "../../db/schema.js";
import {
  incrementReloadSignals,
  replaceShoppingSessions,
  writeBrowserHistoryCapabilities,
  writeBrowserLifecycleState,
  writeBrowserHistoryLastIngestAt,
} from "../../db/browser-history-store.js";
import { createBrowserHistoryRoutes } from "./browser-history.js";

function makeApp(
  db: Database.Database,
  options?: { dataDir?: string },
): Hono {
  const app = new Hono();
  app.route(
    "/api",
    createBrowserHistoryRoutes({
      db,
      config: {
        dataDir: options?.dataDir ?? "/tmp/pa-test",
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

    // Decline-backoff invariant: accepting wiki via the two-option offer
    // must NOT leave `last_wiki_offer_at` set, or the rate-limit gate's
    // 30-day decline backoff would falsely silence the cluster if the
    // wiki write fails before stamping `wiki_summary_written_at` via
    // /wiki-written. See `clearClusterOfferStamps` JSDoc.
    it("clears last_wiki_offer_at when accepting wiki_summary so decline_backoff cannot trip", async () => {
      seedCluster(db, "quantum-mechanics");
      // Simulate the two-option offer fire: both lastResearchOfferAt
      // and lastWikiOfferAt are stamped by the poller (offer-trigger
      // stamp); pending offer row is the 'offered' two-option kind.
      const offeredAt = 1_700_000_000_000;
      db.prepare(
        `UPDATE browser_research_clusters
           SET last_research_offer_at = ?, last_wiki_offer_at = ?, last_dm_at = ?
         WHERE slug = ?`,
      ).run(offeredAt, offeredAt, offeredAt, "quantum-mechanics");
      db.prepare(
        `INSERT INTO browser_pending_offers (slug, kind, offered_at, expires_at)
         VALUES ('quantum-mechanics', 'offered', ?, ?)`,
      ).run(offeredAt, offeredAt + 14 * 24 * 60 * 60 * 1000);
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
      const row = db
        .prepare(
          `SELECT last_research_offer_at AS r, last_wiki_offer_at AS w
             FROM browser_research_clusters WHERE slug = ?`,
        )
        .get("quantum-mechanics") as {
        r: number | null;
        w: number | null;
      };
      expect(row.w).toBeNull();
      // The research-side stamp is preserved — only the accepted side's
      // pending-decline signal is cleared.
      expect(row.r).toBe(offeredAt);
    });

    // Mirror invariant: accepting research_assist stamps
    // `researchOfferAcceptedAt` (which already closes the gate's
    // research-side decline check) and does NOT clear lastWikiOfferAt.
    // The wiki side keeps its 14-day re-fire window so a fresh wiki
    // offer is suppressed until the window elapses.
    it("preserves last_wiki_offer_at when accepting research_assist", async () => {
      seedCluster(db, "quantum-mechanics");
      const offeredAt = 1_700_000_000_000;
      db.prepare(
        `UPDATE browser_research_clusters
           SET last_research_offer_at = ?, last_wiki_offer_at = ?, last_dm_at = ?
         WHERE slug = ?`,
      ).run(offeredAt, offeredAt, offeredAt, "quantum-mechanics");
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
      const row = db
        .prepare(
          `SELECT last_wiki_offer_at AS w, research_offer_accepted_at AS a
             FROM browser_research_clusters WHERE slug = ?`,
        )
        .get("quantum-mechanics") as {
        w: number | null;
        a: number | null;
      };
      expect(row.w).toBe(offeredAt);
      expect(row.a).not.toBeNull();
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

  // BROWSER_HISTORY_INTEGRATION_PLAN §5.F2 P4a — pre-morning digest JSON
  // endpoint. Two paths: the sidecar (written by the cron at
  // `dayBoundaryHour − 1`) and the live-rebuild fallback.
  describe("GET /browser-history/pre-morning-digest/:date", () => {
    it("rejects malformed dates with 400", async () => {
      const app = makeApp(db);
      const res = await app.request(
        "/api/browser-history/pre-morning-digest/notadate",
      );
      expect(res.status).toBe(400);
    });

    it("rebuilds fresh when no sidecar exists and returns the typed shape", async () => {
      // No sidecar on disk under `/tmp/pa-test/context` (not pre-created).
      // The endpoint should fall through to the live build and return
      // an empty-but-valid digest.
      const app = makeApp(db);
      const res = await app.request(
        "/api/browser-history/pre-morning-digest/2026-05-19",
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        date: string;
        source: string;
        clusters: unknown[];
        shopping: unknown[];
        reloads: unknown[];
        pendingOffers: unknown[];
        newThresholdsCount: number;
      };
      expect(body.date).toBe("2026-05-19");
      expect(body.source).toBe("deterministic");
      expect(body.clusters).toEqual([]);
      expect(body.shopping).toEqual([]);
      expect(body.reloads).toEqual([]);
      expect(body.pendingOffers).toEqual([]);
      expect(body.newThresholdsCount).toBe(0);
    });

    it("serves the JSON sidecar verbatim when present (no DB rebuild)", async () => {
      // Use a fresh tmpdir-style dataDir so the test's sidecar cannot
      // collide with other tests' /tmp/pa-test artefacts and the
      // rebuild path's empty-disk assumption stays intact.
      const dataDir = `/tmp/pa-test-sidecar-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const browserDir = join(dataDir, "context", "browser");
      mkdirSync(browserDir, { recursive: true });
      // Hand-crafted payload distinguishable from a DB rebuild (which on
      // an empty DB would produce zero clusters and source=deterministic
      // with `newThresholdsCount=0`). If the route ever silently bypasses
      // the sidecar and rebuilds, this assertion catches it.
      const sidecar = {
        date: "2026-05-19",
        generatedAt: "2026-05-20T03:00:00.000Z",
        source: "deterministic",
        clusters: [
          {
            slug: "sidecar-marker",
            displayName: "sidecar-marker",
            status: "active",
            daysActive: 3,
            meaningfulVisitsInWindow: 7,
            meaningfulForegroundSecInWindow: 1800,
            newDomainsInWindow: [],
            topDomains: ["arxiv.org"],
            qualifiedOvernight: false,
          },
        ],
        shopping: [],
        reloads: [],
        pendingOffers: [],
        newThresholdsCount: 0,
      };
      writeFileSync(
        join(browserDir, "yesterday-2026-05-19.json"),
        JSON.stringify(sidecar),
        "utf-8",
      );
      const res = await makeApp(db, { dataDir }).request(
        "/api/browser-history/pre-morning-digest/2026-05-19",
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as typeof sidecar;
      expect(body.clusters).toHaveLength(1);
      expect(body.clusters[0].slug).toBe("sidecar-marker");
      expect(body.generatedAt).toBe("2026-05-20T03:00:00.000Z");
    });

    it("falls through to live rebuild when the sidecar's date does not match the requested date", async () => {
      // Stale sidecar (yesterday's file under today's URL) — the route
      // must NOT return it, otherwise an operator who manually fetched
      // `/pre-morning-digest/2026-05-20` after a 03:00 cron miss would
      // be handed `2026-05-19`'s data with no signal of the drift.
      const dataDir = `/tmp/pa-test-sidecar-stale-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const browserDir = join(dataDir, "context", "browser");
      mkdirSync(browserDir, { recursive: true });
      const sidecar = {
        date: "2026-05-18", // wrong date on purpose
        generatedAt: "2026-05-19T03:00:00.000Z",
        source: "deterministic",
        clusters: [],
        shopping: [],
        reloads: [],
        pendingOffers: [],
        newThresholdsCount: 0,
      };
      writeFileSync(
        join(browserDir, "yesterday-2026-05-19.json"),
        JSON.stringify(sidecar),
        "utf-8",
      );
      const res = await makeApp(db, { dataDir }).request(
        "/api/browser-history/pre-morning-digest/2026-05-19",
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { date: string };
      // The rebuild path wins → date matches the URL.
      expect(body.date).toBe("2026-05-19");
    });

    it("never leaks raw URLs / titles when visits carry them", async () => {
      // Seed a cluster + a visit whose title + search_query look like
      // attacker-influenceable prose. The digest builder is Layer 1 —
      // it must not surface either field in the JSON response.
      db.prepare(
        `INSERT INTO browser_research_clusters (
           slug, root_task_id, display_name, started_at, last_activity_at,
           visits_total, meaningful_visits_total, meaningful_foreground_sec_total,
           distinct_meaningful_domains, status
         ) VALUES ('redaction-check', 99, 'redaction-check',
                   0, 0, 1, 1, 600, 1, 'active')`,
      ).run();
      // Place the visit inside the agent-day window for 2026-05-19 UTC.
      db.prepare(
        `INSERT INTO browser_visits
           (ts, browser, profile, url_hash, domain, category, meaningful,
            foreground_sec, transition, is_reload, root_task_id,
            title, search_query)
         VALUES (?, 'chrome', 'Default', 'h-leak', 'arxiv.org', 'research',
                 1, 600, 0, 0, 99,
                 'Sensitive paper title 2402.06196',
                 'super secret query string')`,
      ).run(Date.UTC(2026, 4, 19, 6, 0, 0));

      const res = await makeApp(db).request(
        "/api/browser-history/pre-morning-digest/2026-05-19",
      );
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain("Sensitive paper title");
      expect(text).not.toContain("super secret query");
      expect(text).not.toContain("2402.06196");
      // Cluster is present and uses the sanitised display name.
      const body = JSON.parse(text) as { clusters: Array<{ slug: string }> };
      expect(body.clusters[0]?.slug).toBe("redaction-check");
    });
  });
});
