import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  // ── WEEKLY_INTERESTS_REFLECTION_PLAN.md §10.2 / §10.3 / §10.3.1 ──
  // Three thin HTTP wrappers over the daemon-internal helpers. The
  // helpers themselves are exhaustively covered by
  // `services/browser-history/{refresh,cleanup}-interests-reflection.test.ts`
  // and `pipeline/weekly-interests-summary.test.ts`; this block asserts
  // only the route surface — Zod parse, validation, body forwarding,
  // and the contextDir resolution path.
  describe("WEEKLY_INTERESTS_REFLECTION routes", () => {
    let tmpRoot: string;

    function makeAppInTmp(db: Database.Database): Hono {
      return makeApp(db, { dataDir: tmpRoot });
    }

    function seedClusterRow(
      db: Database.Database,
      args: {
        slug: string;
        rootTaskId: number;
        displayName: string;
        lastActivityAt: number;
      },
    ): void {
      db.prepare(
        `INSERT INTO browser_research_clusters (
           slug, root_task_id, display_name, started_at, last_activity_at,
           visits_total, meaningful_visits_total, meaningful_foreground_sec_total,
           distinct_meaningful_domains, status, agent_summary_revision
         ) VALUES (?, ?, ?, ?, ?, 30, 22, 5400, 4, 'active', 0)`,
      ).run(
        args.slug,
        args.rootTaskId,
        args.displayName,
        args.lastActivityAt - 86_400_000,
        args.lastActivityAt,
      );
    }

    let visitCounter = 0;
    function seedVisitRow(
      db: Database.Database,
      args: {
        rootTaskId: number;
        ts: number;
        domain: string;
        foregroundSec?: number;
      },
    ): void {
      visitCounter += 1;
      db.prepare(
        `INSERT INTO browser_visits (
           ts, browser, profile, url_hash, domain, category, meaningful,
           foreground_sec, transition, is_reload, root_task_id
         ) VALUES (?, 'chrome', 'Default', ?, ?, 'research', 1, ?, 0, 0, ?)`,
      ).run(
        args.ts,
        `route-test-hash-${visitCounter}`,
        args.domain,
        args.foregroundSec ?? 1200,
        args.rootTaskId,
      );
    }

    /**
     * Seed three active clusters with meaningful visits inside the
     * Monday-aligned 7-day window the test's `weekStart` describes.
     * Three is the `MIN_PROFILE_MD_THEMES` floor — anything less and
     * the refresh helper returns `skipped='fewer_than_min_themes'`.
     */
    function seedThreeQualifyingClusters(
      db: Database.Database,
      weekStartMs: number,
    ): void {
      const slugs = [
        ["prompt-injection-defenses", "Prompt-injection defenses", 101],
        ["quantum-mechanics-intro", "Quantum mechanics intro", 102],
        ["rust-borrow-checker", "Rust borrow checker", 103],
      ] as const;
      for (const [slug, displayName, rootTaskId] of slugs) {
        const lastActivity = weekStartMs + 3 * 86_400_000;
        seedClusterRow(db, {
          slug,
          rootTaskId,
          displayName,
          lastActivityAt: lastActivity,
        });
        // Two visits per cluster, two distinct domains, comfortably
        // inside the window so `weekly-interests-summary` qualifies
        // them.
        seedVisitRow(db, {
          rootTaskId,
          ts: weekStartMs + 1 * 86_400_000,
          domain: `${slug}.example`,
          foregroundSec: 1800,
        });
        seedVisitRow(db, {
          rootTaskId,
          ts: weekStartMs + 2 * 86_400_000,
          domain: `notes.${slug}.example`,
          foregroundSec: 900,
        });
      }
    }

    beforeEach(() => {
      tmpRoot = mkdtempSync(join(tmpdir(), "pa-interests-routes-"));
      // Seed the user/ tree so the refresh helper has its Mode A
      // targets to write into. `_index.md` is intentionally created so
      // the test exercises the index-entry block path; tests that want
      // `_index_missing` semantics omit it.
      mkdirSync(join(tmpRoot, "context", "user"), { recursive: true });
      writeFileSync(
        join(tmpRoot, "context", "user", "profile.md"),
        "# Profile\n\n## Identity\n- placeholder\n",
      );
      writeFileSync(
        join(tmpRoot, "context", "user", "_index.md"),
        "# User topics\n\n- `profile.md`\n",
      );
      visitCounter = 0;
    });

    afterEach(() => {
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    describe("GET /browser-history/weekly-interests-summary", () => {
      it("rejects a missing weekStart with 400", async () => {
        const res = await makeAppInTmp(db).request(
          "/api/browser-history/weekly-interests-summary",
        );
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "invalid_weekStart" });
      });

      it("rejects a malformed weekStart with 400", async () => {
        const res = await makeAppInTmp(db).request(
          "/api/browser-history/weekly-interests-summary?weekStart=notadate",
        );
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "invalid_weekStart" });
      });

      it("rejects a non-Monday weekStart with 400 (Tuesday)", async () => {
        // 2026-05-19 is Tuesday → reject. The helper itself accepts any
        // YYYY-MM-DD, but the HTTP route layer enforces the ISO-Monday
        // contract called out in §10.2.
        const res = await makeAppInTmp(db).request(
          "/api/browser-history/weekly-interests-summary?weekStart=2026-05-19",
        );
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: "weekStart_must_be_monday",
        });
      });

      it("accepts a Monday weekStart and returns the validated summary shape", async () => {
        const res = await makeAppInTmp(db).request(
          "/api/browser-history/weekly-interests-summary?weekStart=2026-05-18",
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          weekStart: string;
          weekEnd: string;
          generatedAt: string;
          clusters: unknown[];
          dormantSinceLastWeek: unknown[];
          projectMatches: unknown[];
        };
        expect(body.weekStart).toBe("2026-05-18");
        expect(Array.isArray(body.clusters)).toBe(true);
        expect(Array.isArray(body.dormantSinceLastWeek)).toBe(true);
        expect(Array.isArray(body.projectMatches)).toBe(true);
        expect(typeof body.generatedAt).toBe("string");
      });

      it("surfaces seeded active clusters inside the window", async () => {
        // 2026-05-18 00:00 UTC anchors a Monday-aligned window; place
        // a meaningful visit at +1 day so it lands cleanly inside.
        const weekStartMs = Date.UTC(2026, 4, 18, 0, 0, 0);
        seedClusterRow(db, {
          slug: "rust-borrow-checker",
          rootTaskId: 1,
          displayName: "Rust borrow checker",
          lastActivityAt: weekStartMs + 2 * 86_400_000,
        });
        seedVisitRow(db, {
          rootTaskId: 1,
          ts: weekStartMs + 1 * 86_400_000,
          domain: "doc.rust-lang.org",
        });
        const res = await makeAppInTmp(db).request(
          "/api/browser-history/weekly-interests-summary?weekStart=2026-05-18",
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          clusters: Array<{ slug: string; meaningfulVisits: number }>;
        };
        expect(body.clusters).toHaveLength(1);
        expect(body.clusters[0]).toMatchObject({
          slug: "rust-borrow-checker",
          meaningfulVisits: 1,
        });
      });

      it("populates projectMatches with relative paths when a project file matches", async () => {
        // Regression guard for the §10.1 spec drift the route used to
        // exhibit: builder was called without `projectKeywords`, so
        // every response carried an empty projectMatches array. The
        // route now loads keywords from `<contextDir>/projects/*.md`
        // and projects the absolute path to the documented
        // `projects/<slug>.md` form.
        const weekStartMs = Date.UTC(2026, 4, 18, 0, 0, 0);
        seedClusterRow(db, {
          slug: "rust-borrow-checker",
          rootTaskId: 1,
          displayName: "Rust borrow checker",
          lastActivityAt: weekStartMs + 2 * 86_400_000,
        });
        seedVisitRow(db, {
          rootTaskId: 1,
          ts: weekStartMs + 1 * 86_400_000,
          domain: "doc.rust-lang.org",
        });
        mkdirSync(join(tmpRoot, "context", "projects"), { recursive: true });
        writeFileSync(
          join(tmpRoot, "context", "projects", "rust-borrow-checker.md"),
          [
            "---",
            "type: project",
            "owner: user",
            "aitne_project_keywords: [rust, borrow, checker]",
            "---",
            "# Rust borrow checker project",
          ].join("\n"),
        );
        const res = await makeAppInTmp(db).request(
          "/api/browser-history/weekly-interests-summary?weekStart=2026-05-18",
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          projectMatches: Array<{
            projectSlug: string;
            projectPath: string;
            clusters: { slug: string; reason: string }[];
          }>;
        };
        expect(body.projectMatches).toHaveLength(1);
        expect(body.projectMatches[0]).toMatchObject({
          projectSlug: "rust-borrow-checker",
          projectPath: "projects/rust-borrow-checker.md",
        });
        // No absolute path / data-dir layout leaks into the response.
        expect(body.projectMatches[0]!.projectPath.startsWith("/")).toBe(false);
        expect(body.projectMatches[0]!.projectPath).not.toContain(tmpRoot);
      });
    });

    describe("POST /browser-history/refresh-interests-reflection", () => {
      it("returns skipped=fewer_than_min_themes on an empty DB", async () => {
        const res = await makeAppInTmp(db).request(
          "/api/browser-history/refresh-interests-reflection",
          { method: "POST" },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          targetsWritten: string[];
          themesSelected: string[];
          skipped?: { reason: string };
        };
        expect(body.skipped).toEqual({ reason: "fewer_than_min_themes" });
        expect(body.targetsWritten).toEqual([]);
        expect(body.themesSelected).toEqual([]);
      });

      it("writes the four targets when three or more clusters qualify", async () => {
        // Pin the wall-clock so the helper's `mostRecentMondayFromDate`
        // resolves deterministically. 2026-05-20T12:00Z is Wednesday;
        // the most recent ISO Monday (UTC boundary 04:00) is
        // 2026-05-18, and the 7-day window is [2026-05-18, 2026-05-25).
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-05-20T12:00:00Z"));
        try {
          const weekStartMs = Date.UTC(2026, 4, 18, 4, 0, 0); // 04:00 UTC = boundary
          seedThreeQualifyingClusters(db, weekStartMs);

          const res = await makeAppInTmp(db).request(
            "/api/browser-history/refresh-interests-reflection",
            { method: "POST" },
          );
          expect(res.status).toBe(200);
          const body = (await res.json()) as {
            weekStart: string;
            targetsWritten: string[];
            themesSelected: string[];
            skipped?: { reason: string };
          };
          expect(body.weekStart).toBe("2026-05-18");
          expect(body.skipped).toBeUndefined();
          expect(body.themesSelected.length).toBeGreaterThanOrEqual(3);
          // profile.md, research-themes.md, _index.md are all expected
          // to be written; project files are absent so no project block.
          expect(body.targetsWritten).toEqual(
            expect.arrayContaining([
              "user/profile.md",
              "user/research-themes.md",
              "user/_index.md",
            ]),
          );
          // The wholly-daemon-owned snapshot file landed on disk.
          const themesPath = join(
            tmpRoot,
            "context",
            "user",
            "research-themes.md",
          );
          expect(existsSync(themesPath)).toBe(true);
          const profileBody = readFileSync(
            join(tmpRoot, "context", "user", "profile.md"),
            "utf-8",
          );
          expect(profileBody).toContain(
            "<!-- BEGIN aitne:browser-interests v1",
          );
          expect(profileBody).toContain(
            "<!-- END aitne:browser-interests v1",
          );
        } finally {
          vi.useRealTimers();
        }
      });

      it("records a 'dashboard' trigger on the audit row even when skipped", async () => {
        // No clusters seeded → helper returns skipped, but still emits
        // an audit row. The route surface contract is "trigger always
        // recorded as dashboard" — the skipped path is the cheap way
        // to assert it without needing fake timers.
        await makeAppInTmp(db).request(
          "/api/browser-history/refresh-interests-reflection",
          { method: "POST" },
        );
        const row = db
          .prepare(
            `SELECT trigger, result FROM agent_actions
             WHERE action_type = 'browser_interests_reflection_applied'
             ORDER BY id DESC LIMIT 1`,
          )
          .get() as { trigger: string; result: string } | undefined;
        expect(row?.trigger).toBe("weekly_interests_reflection:dashboard");
        expect(row?.result).toBe("skipped");
      });
    });

    describe("POST /browser-history/cleanup-interests-reflection", () => {
      function seedThemesFileAndAutoBlock(): void {
        writeFileSync(
          join(tmpRoot, "context", "user", "research-themes.md"),
          "---\ntype: user\nowner: aitne-browser-history\n---\n# stub\n",
        );
        writeFileSync(
          join(tmpRoot, "context", "user", "profile.md"),
          [
            "# Profile",
            "",
            "## Identity",
            "- placeholder",
            "",
            "<!-- BEGIN aitne:browser-interests v1 weekStart=2026-05-18 -->",
            "## Current research themes (auto)",
            "- **Rust** — 1 day",
            "<!-- END aitne:browser-interests v1 -->",
            "",
          ].join("\n"),
        );
      }

      it("accepts a missing body and uses the default (delete themes file)", async () => {
        seedThemesFileAndAutoBlock();
        const res = await makeAppInTmp(db).request(
          "/api/browser-history/cleanup-interests-reflection",
          { method: "POST" },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          blocksRemoved: number;
          filesAffected: string[];
          researchThemesDeleted: boolean;
        };
        expect(body.blocksRemoved).toBe(1);
        expect(body.researchThemesDeleted).toBe(true);
        expect(
          existsSync(
            join(tmpRoot, "context", "user", "research-themes.md"),
          ),
        ).toBe(false);
        const profileBody = readFileSync(
          join(tmpRoot, "context", "user", "profile.md"),
          "utf-8",
        );
        expect(profileBody).not.toContain("aitne:browser-interests");
        // The pre-existing user-authored ## Identity section survives.
        expect(profileBody).toContain("## Identity");
      });

      it("respects alsoDeleteResearchThemesFile=false", async () => {
        seedThemesFileAndAutoBlock();
        const res = await makeAppInTmp(db).request(
          "/api/browser-history/cleanup-interests-reflection",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ alsoDeleteResearchThemesFile: false }),
          },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          researchThemesDeleted: boolean;
        };
        expect(body.researchThemesDeleted).toBe(false);
        expect(
          existsSync(
            join(tmpRoot, "context", "user", "research-themes.md"),
          ),
        ).toBe(true);
      });

      it("rejects an unknown field in the body with 400 (strict schema)", async () => {
        const res = await makeAppInTmp(db).request(
          "/api/browser-history/cleanup-interests-reflection",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ destroyEverything: true }),
          },
        );
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "invalid_body" });
      });

      it("is idempotent — a second invocation reports zero blocks removed", async () => {
        seedThemesFileAndAutoBlock();
        const app = makeAppInTmp(db);
        await app.request(
          "/api/browser-history/cleanup-interests-reflection",
          { method: "POST" },
        );
        const second = await app.request(
          "/api/browser-history/cleanup-interests-reflection",
          { method: "POST" },
        );
        expect(second.status).toBe(200);
        const body = (await second.json()) as {
          blocksRemoved: number;
          researchThemesDeleted: boolean;
        };
        expect(body.blocksRemoved).toBe(0);
        // Already gone on the second run, so `researchThemesDeleted`
        // is false — the existsSync gate inside the helper short-
        // circuits before unlinkSync runs.
        expect(body.researchThemesDeleted).toBe(false);
      });
    });
  });
});
