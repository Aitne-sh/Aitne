import type { Hono } from "hono";
import type { ApiDependencies } from "../../server.js";
import { computeDmFreshnessAggregate } from "../../../core/dm-freshness-metrics.js";

function getLocalHourMinute(date: Date, timeZone?: string): { hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  });
  const parts = formatter.formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return { hour, minute };
}

function isHourlyCheckSlot(date: Date, config: ApiDependencies["config"]): boolean {
  if (!config.hourlyCheckEnabled) return false;
  const { hour, minute } = getLocalHourMinute(date, config.timezone || undefined);
  if (hour === config.dayBoundaryHour) return false;
  if (hour < config.hourlyCheckActiveStartHour || hour >= config.hourlyCheckActiveEndHour) {
    return false;
  }
  return minute % config.hourlyCheckIntervalMinutes === 0;
}

function getNextHourlyCheck(config: ApiDependencies["config"]): { active: boolean; nextRunAt: string | null } {
  if (!config.hourlyCheckEnabled) {
    return { active: false, nextRunAt: null };
  }

  const now = new Date();
  const active = isHourlyCheckSlot(now, config);
  const start = new Date(now.getTime() + 60_000);
  start.setSeconds(0, 0);

  for (let offset = 0; offset < 48 * 60; offset++) {
    const candidate = new Date(start.getTime() + offset * 60_000);
    if (isHourlyCheckSlot(candidate, config)) {
      return { active, nextRunAt: candidate.toISOString() };
    }
  }

  return { active, nextRunAt: null };
}

export function registerNotificationsRoutes(app: Hono, deps: ApiDependencies): void {
  const { db, config } = deps;

  app.get("/dashboard/next-check", (c) => {
    return c.json(getNextHourlyCheck(config));
  });

  // STAGE-C-DM-FRESHNESS-PLAN §Task 4 — DM freshness aggregate. Powered
  // by `agent_actions.detail.dm_freshness.*` rows the DM dispatch path
  // writes via AuditLogger.logAction. Window defaults to 7 days; query
  // param `days` overrides for ad-hoc inspection (clamped to 1..90).
  app.get("/dashboard/dm-freshness", (c) => {
    const daysParam = c.req.query("days");
    let windowDays = 7;
    if (daysParam !== undefined) {
      const parsed = Number(daysParam);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 90) {
        return c.json(
          {
            error: "invalid_window",
            message: "days must be a number between 1 and 90",
          },
          400,
        );
      }
      windowDays = Math.round(parsed);
    }
    const aggregate = computeDmFreshnessAggregate(deps.db, windowDays);
    return c.json(aggregate);
  });

  // ── Notifications API ──

  /** GET /notifications — notification history (paginated) */
  app.get("/notifications", (c) => {
    const page = Math.max(1, Number(c.req.query("page") ?? "1"));
    const limit = Math.min(Number(c.req.query("limit") ?? "50"), 100);
    const status = c.req.query("status");
    const priority = c.req.query("priority");
    const offset = (page - 1) * limit;

    let where = "1=1";
    const params: unknown[] = [];
    if (status) { where += " AND status = ?"; params.push(status); }
    if (priority) { where += " AND priority = ?"; params.push(priority); }

    const total = (db
      .prepare(`SELECT COUNT(*) as count FROM notification_log WHERE ${where}`)
      .get(...params) as { count: number }).count;

    params.push(limit, offset);
    const notifications = db
      .prepare(
        `SELECT
           id,
           dispatch_id,
           content_summary AS message,
           platform,
           delivery_channel,
           priority,
           status,
           user_reaction,
           reacted_at,
           created_at
         FROM notification_log WHERE ${where}
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params);

    return c.json({
      notifications,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  });
}
