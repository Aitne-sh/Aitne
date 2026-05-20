import { Hono } from "hono";
import {
  browserHistoryStatusResponseSchema,
  browserHistoryResearchClustersResponseSchema,
  browserReloadsTodayResponseSchema,
  browserReloadsWeeklyResponseSchema,
  browserShoppingDateResponseSchema,
  getAgentDayDateStr,
  yesterdayResearchSummarySchema,
} from "@aitne/shared";
import type { ApiDependencies } from "../server.js";
import {
  getYesterdayResearchSummary,
  listBrowserResearchClusters,
  listReloadsForDate,
  listReloadsForRange,
  listShoppingSessionsForDate,
  readBrowserHistoryCapabilities,
  readBrowserHistoryLastIngestAt,
  readBrowserLifecycleState,
  writeBrowserHistoryCapabilities,
} from "../../db/browser-history-store.js";
import { createHostProfile } from "../../services/browser-history/lifecycle/platform.js";
import { detectBrowserHistoryCapabilities } from "../../services/browser-history/detectors/registry.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function agentDayBoundary(deps: ApiDependencies) {
  return {
    timezone: deps.config.timezone || undefined,
    dayBoundaryHour: deps.config.dayBoundaryHour ?? 4,
  };
}

function todayKey(deps: ApiDependencies): string {
  const b = agentDayBoundary(deps);
  return getAgentDayDateStr(b.timezone, b.dayBoundaryHour, new Date());
}

function yesterdayKey(deps: ApiDependencies): string {
  const b = agentDayBoundary(deps);
  return getAgentDayDateStr(
    b.timezone,
    b.dayBoundaryHour,
    new Date(Date.now() - 24 * 60 * 60 * 1000),
  );
}

function parseDateParam(
  value: string | undefined,
  fallback: () => string,
): string {
  if (value && DATE_PATTERN.test(value)) return value;
  return fallback();
}

function addDays(dateStr: string, deltaDays: number): string {
  const ms = Date.parse(`${dateStr}T00:00:00Z`);
  return new Date(ms + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

export function createBrowserHistoryRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();

  app.get("/browser-history/status", (c) => {
    const payload = browserHistoryStatusResponseSchema.parse({
      capabilities: readBrowserHistoryCapabilities(deps.db),
      lifecycle: readBrowserLifecycleState(deps.db),
      lastIngestAt: readBrowserHistoryLastIngestAt(deps.db),
    });
    return c.json(payload);
  });

  app.get("/browser-history/research-clusters", (c) => {
    return c.json(
      browserHistoryResearchClustersResponseSchema.parse(
        listBrowserResearchClusters(deps.db),
      ),
    );
  });

  app.get("/browser-history/yesterday-summary", (c) => {
    const date = parseDateParam(c.req.query("date"), () => yesterdayKey(deps));
    return c.json(
      yesterdayResearchSummarySchema.parse(
        getYesterdayResearchSummary(date),
      ),
    );
  });

  app.get("/browser-history/shopping/:date", (c) => {
    const requested = c.req.param("date");
    if (!DATE_PATTERN.test(requested)) {
      return c.json({ error: "invalid_date" }, 400);
    }
    const rows = listShoppingSessionsForDate(deps.db, requested);
    const sessions = rows
      .filter((row) => row.asins.length > 0)
      .map((row) => ({
        date: row.date,
        vendor: row.vendor,
        asins: row.asins,
        comparisonMinutes: row.comparisonMinutes,
        locale: row.locale,
      }));
    return c.json(
      browserShoppingDateResponseSchema.parse({
        date: requested,
        sessions,
      }),
    );
  });

  app.get("/browser-history/reloads/today", (c) => {
    const date = parseDateParam(c.req.query("date"), () => todayKey(deps));
    const entries = listReloadsForDate(deps.db, date);
    return c.json(
      browserReloadsTodayResponseSchema.parse({ date, entries }),
    );
  });

  app.get("/browser-history/reloads/weekly", (c) => {
    const rangeEnd = parseDateParam(c.req.query("end"), () => todayKey(deps));
    const rangeStart = parseDateParam(c.req.query("start"), () =>
      addDays(rangeEnd, -6),
    );
    const entries = listReloadsForRange(deps.db, rangeStart, rangeEnd);
    return c.json(
      browserReloadsWeeklyResponseSchema.parse({
        rangeStart,
        rangeEnd,
        entries,
      }),
    );
  });

  app.post("/setup/redetect-browsers", async (c) => {
    const { capabilities } = await detectBrowserHistoryCapabilities({
      db: deps.db,
      config: deps.config,
      host: createHostProfile(),
    });
    writeBrowserHistoryCapabilities(deps.db, capabilities);
    return c.json({ capabilities });
  });

  return app;
}
