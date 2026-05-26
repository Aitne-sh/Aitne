import { Hono } from "hono";
import type Database from "better-sqlite3";
import {
  ACTIVITY_VIEW_WINDOW_DAYS,
  windowCutoffDate,
} from "../../core/context/activity-view-reconciler.js";
import { enumerateActivitySources } from "../../core/context/activity-sources.js";

/**
 * `GET /api/activity-sources` — the source-list the dashboard's
 * Memory → Activity tab consumes (followups doc Issue 3).
 *
 * The runner's `enumerateActivitySources` is the canonical source of
 * truth; this route is the dashboard's read-mirror. The response
 * includes `status` so the UI can flag a recently-stopped task whose
 * `state/activity/<source>.md` is still on disk for the 90-day window.
 *
 * Settings → Management still uses `GET /managed-tasks` (active only)
 * because that page edits live rows; the activity tab is read-only and
 * benefits from the wider window.
 */

export interface ActivitySourcesRoutesDeps {
  db: Database.Database;
}

export function createActivitySourcesRoutes(
  deps: ActivitySourcesRoutesDeps,
): Hono {
  const app = new Hono();
  const { db } = deps;

  app.get("/activity-sources", (c) => {
    const cutoff = windowCutoffDate(new Date(), ACTIVITY_VIEW_WINDOW_DAYS);
    const items = enumerateActivitySources(db, cutoff);
    return c.json({
      items,
      windowDays: ACTIVITY_VIEW_WINDOW_DAYS,
      cutoffDate: cutoff,
    });
  });

  return app;
}
