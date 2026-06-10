/**
 * Outbound-notification gate — QUIET_HOURS_HARDENING_PLAN.md Phase 1.
 *
 * Single decision function for the API-deps `sendNotification` chokepoint
 * (`bootstrap/api.ts`), closing finding F1: `POST /api/notify` used to
 * bypass quiet hours AND rate limits without the explicit-user-intent
 * justification the other delivery paths encode. The intent rule —
 * "explicit user-chosen time → deliver regardless of quiet hours; ambient
 * autonomous output → suppress/defer" — now holds here too:
 *
 *   1. safety / critical → send immediately (mirrors NotificationManager);
 *   2. inside quiet hours → defer to a `task_type='dm'` agent_schedule row
 *      at the quiet-hours edge (durable, coalesced per origin — see
 *      `db/deferred-dm.ts`), never silently dropped;
 *   3. outside quiet hours → enforce the same hourly/daily rate limits the
 *      proactive path enforces; the live session gets a `rate_limit`
 *      verdict it can adapt to (write to today.md instead) rather than a
 *      silent queue.
 *
 * Pure composition over covered helpers — keep glue out of bootstrap.
 */
import type Database from "better-sqlite3";
import { deferDmToQuietHoursEnd } from "../db/deferred-dm.js";
import {
  evaluateNotificationRateLimit,
} from "./notification-rate-limit.js";

/** Safety categories bypass quiet hours and user preferences. Owned here
 *  so the NotificationManager and this gate share one list. */
export const SAFETY_CATEGORIES = [
  "security",
  "deadline",
  "error",
  "critical",
] as const;

export interface OutboundGateConfig {
  quietHoursStart: string;
  quietHoursEnd: string;
  /** IANA tz; empty string falls back to system timezone. */
  timezone: string;
  maxNotificationsPerHour: number;
  maxNotificationsPerDay: number;
  dayBoundaryHour: number;
}

export interface OutboundGateParams {
  message: string;
  platforms?: string[] | undefined;
  priority?: string | undefined;
  notificationType?: string | undefined;
  originSessionId?: number | undefined;
  agentId?: string | null | undefined;
  /** Origin marker stamped into the deferred row, e.g. `"api.notify"`. */
  deferredFrom: string;
}

export type OutboundGateResult =
  | { action: "send" }
  | {
      action: "defer";
      scheduleId: string;
      /** SQLite-format UTC datetime the deferred DM fires at. */
      deliverAfter: string;
      coalesced: boolean;
    }
  | { action: "rate_limit"; retryAfter: string | null };

/**
 * Critical priority and safety-tagged notification types deliver
 * immediately — same bypass set as `NotificationManager.isSafetyCategory`
 * ("urgent" accepted defensively; the notify schema only emits
 * critical/high/normal/low).
 */
export function bypassesOutboundGate(
  priority: string | undefined,
  notificationType: string | undefined,
): boolean {
  if (priority === "critical" || priority === "urgent") return true;
  return (
    notificationType !== undefined &&
    (SAFETY_CATEGORIES as readonly string[]).includes(notificationType)
  );
}

export function gateOutboundNotification(
  db: Database.Database,
  config: OutboundGateConfig,
  params: OutboundGateParams,
  now: Date = new Date(),
): OutboundGateResult {
  if (bypassesOutboundGate(params.priority, params.notificationType)) {
    return { action: "send" };
  }

  const deferred = deferDmToQuietHoursEnd(
    db,
    {
      start: config.quietHoursStart,
      end: config.quietHoursEnd,
      timezone: config.timezone || undefined,
    },
    {
      message: params.message,
      platforms: params.platforms,
      deferredFrom: params.deferredFrom,
      originSessionId: params.originSessionId,
      agentId: params.agentId,
    },
    now,
  );
  if (deferred !== null) {
    return { action: "defer", ...deferred };
  }

  const rateLimit = evaluateNotificationRateLimit(
    db,
    {
      maxNotificationsPerHour: config.maxNotificationsPerHour,
      maxNotificationsPerDay: config.maxNotificationsPerDay,
      timezone: config.timezone,
      dayBoundaryHour: config.dayBoundaryHour,
    },
    now,
  );
  if (rateLimit.limited) {
    return { action: "rate_limit", retryAfter: rateLimit.retryAfter };
  }

  return { action: "send" };
}
