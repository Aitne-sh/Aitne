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
});
