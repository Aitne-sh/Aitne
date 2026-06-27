import type Database from "better-sqlite3";
import {
  getAgentDayBoundsUtc,
  getIntegrationDescriptor,
  localDateStr,
  nowInTimezone,
  parseSqliteUtcMs,
} from "@aitne/shared";
import type { AgentConfig } from "../config.js";
import type { ServiceRegistry } from "../services/service-registry.js";
import type { CalendarEvent } from "../services/calendar.js";
import { readIntegrations } from "../db/integrations-store.js";
import { createLogger } from "../logging.js";
import { sanitizeUntrustedTemplateValue } from "./backends/prompt-utils.js";

const logger = createLogger("context-builder-calendar");

interface CalendarDeps {
  db: Database.Database;
  config: AgentConfig;
  services: ServiceRegistry;
}

/**
 * Build a `<calendar_events_*>` context block honouring every active
 * provider's mode.
 *
 * docs/design/appendices/routine-data-acquisition.md §6.6 — the block wraps one
 * `<provider key="…" mode="…">…</provider>` sub-block per active
 * provider so the parent routine sees a uniform shape regardless of
 * which provider(s) the operator has configured.
 *
 * `prepassCovers` — A8 / Finding 5. When `true`, the caller's
 * `ROUTINE_WINDOWS` entry includes a calendar row, so the
 * `routine.fetch_window` pre-pass has already POSTed events to
 * `/api/observations` for every non-direct provider. Non-direct
 * provider sub-blocks then emit a "read observations" hint instead
 * of the legacy "fetch yourself" directive. Direct providers are
 * unchanged — ContextBuilder still pre-fetches inline events via
 * `services.calendar` (Google) and emits the fallback hint for
 * Outlook (no daemon-side service yet). The flag has no effect on
 * direct-mode sub-blocks. Default `false` for callers that don't
 * have pre-pass coverage (today_refresh, weekly/monthly_review,
 * roadmap_refresh).
 */
export async function renderCalendarBlock(
  deps: CalendarDeps,
  args: { days: number; blockName: string; prepassCovers?: boolean },
): Promise<string> {
  const { db } = deps;
  const { days, blockName, prepassCovers = false } = args;
  const integrations = readIntegrations(db);
  const { timeMin, timeMax } = computeCalendarWindow(deps, days);

  const subblocks: string[] = [];
  const googleSub = await renderCalendarProviderBlock(
    deps,
    "google_calendar",
    "Google Calendar",
    integrations.google_calendar?.mode ?? "disabled",
    days,
    timeMin,
    timeMax,
    prepassCovers,
  );
  if (googleSub) subblocks.push(googleSub);
  const outlookSub = await renderCalendarProviderBlock(
    deps,
    "outlook_calendar",
    "Outlook Calendar",
    integrations.outlook_calendar?.mode ?? "disabled",
    days,
    timeMin,
    timeMax,
    prepassCovers,
  );
  if (outlookSub) subblocks.push(outlookSub);

  if (subblocks.length === 0) {
    // Match the legacy single-line shape so existing prose that greps
    // for `<calendar_status>not available` keeps matching.
    return `<calendar_status>Calendar service not available. No calendar provider is configured for this window.</calendar_status>`;
  }
  return [
    `<${blockName} days="${days}" timeMin="${timeMin}" timeMax="${timeMax}">`,
    ...subblocks,
    `</${blockName}>`,
  ].join("\n");
}

/**
 * Compute the calendar lookahead window anchored at the user-timezone
 * midnight boundary. Shared by direct-mode fetches and the delegated-mode
 * MCP-fetch directive so both paths describe exactly the same range.
 */
function computeCalendarWindow(
  deps: CalendarDeps,
  days: number,
): { timeMin: string; timeMax: string } {
  const tz = deps.config.timezone || undefined;
  const dayBounds = getAgentDayBoundsUtc(tz, 0);
  const startMs = parseSqliteUtcMs(dayBounds.start);
  return {
    timeMin: new Date(startMs).toISOString(),
    timeMax: new Date(startMs + days * 24 * 60 * 60 * 1000).toISOString(),
  };
}

/**
 * Emit one provider sub-block for `renderCalendarBlock`. Returns null
 * when the provider is disabled (or, for native mode, the binding
 * does not apply to a meaningful path — the agent reads
 * `<integration_modes>` to decide whether its session backend is the
 * native one).
 */
async function renderCalendarProviderBlock(
  deps: CalendarDeps,
  key: "google_calendar" | "outlook_calendar",
  displayName: string,
  mode: "direct" | "delegated" | "native" | "disabled",
  days: number,
  timeMin: string,
  timeMax: string,
  prepassCovers: boolean,
): Promise<string | null> {
  if (mode === "disabled") return null;

  const open = `  <provider key="${key}" mode="${mode}">`;
  const close = "  </provider>";

  // A8 / Finding 5 — when the parent routine's pre-pass owns the
  // calendar window AND this provider is non-direct, the pre-pass
  // has already POSTed events to /api/observations. Replace the
  // legacy "fetch yourself" directive with a hint pointing at
  // observations so the main routine session never re-drives the
  // MCP fan-out (the cost regression that motivated this flag).
  if (prepassCovers && (mode === "delegated" || mode === "native")) {
    return [
      open,
      `${displayName} ${mode} mode — the routine.fetch_window pre-pass`,
      `posted events for [${timeMin}, ${timeMax}) to /api/observations`,
      `under source_prefix \`${key}:\`. Read them via:`,
      `  GET http://localhost:8321/api/observations?pending=true&source_prefix=${key}:&limit=200`,
      `Consult \`<fetch_report>\` injected above for pre-pass status; on`,
      `status="failed" or "skipped" treat this provider as unavailable for`,
      `the window and log a one-line skip to \`## Agent Log\` instead of`,
      `re-driving the connector yourself. Do NOT call /api/calendar/* or`,
      `/api/integrations/*/exec — those return 410 in this mode.`,
      close,
    ].join("\n");
  }

  if (mode === "direct") {
    // Today only `services.calendar` (Google) is wired. Outlook direct
    // mode reaches `GET /api/calendar/outlook` from the task flow; the
    // context block surfaces a service-status hint until a daemon-side
    // CalendarService for Outlook lands. Either way the agent can fall
    // back to its own direct REST call from the task flow.
    if (key === "google_calendar" && deps.services.calendar) {
      const inline = await fetchCalendarEvents(deps, days);
      if (inline !== null) {
        return [open, inline, close].join("\n");
      }
    }
    return [
      open,
      `${displayName}: direct mode, daemon service not initialized for this window.`,
      `Fetch yourself via the task flow's direct-mode endpoint (Google: /api/calendar/events; Outlook: /api/calendar/outlook).`,
      close,
    ].join("\n");
  }

  if (mode === "delegated") {
    // CLAUDE.md: "Never hardcode an integration reference outside the
    // registry." `userManagedConnector` is the registry's source of
    // truth for whether the daemon ships a `/api/integrations/<key>/
    // exec` proxy. Reading it from the descriptor means a future
    // user-managed integration (Proton, custom MCP, etc.) inherits
    // the right branch without touching this method.
    const isUserManaged =
      getIntegrationDescriptor(key).userManagedConnector === true;
    const lines: string[] = [
      open,
      `${displayName} is delegated — see \`<integration_modes>\`. Fetch the window`,
      `(timeMin=${timeMin}, timeMax=${timeMax}) and treat the returned events as`,
      `the contents of this provider block for the rest of the task flow.`,
      "",
      "  Same-backend (delegated_to == your session backend) — use your",
      `  session's ${displayName} MCP tool (whichever your skills document).`,
    ];
    if (!isUserManaged) {
      lines.push(
        "",
        "  Cross-backend (delegated_to != your session backend) — call",
        "  the daemon's task-mode endpoint so the configured account is used:",
        `    POST http://localhost:8321/api/integrations/${key}/exec`,
        `      task: List every event between ${timeMin} and ${timeMax}.`,
        `      outputSchema: { events: [ { id, title, start, end } ] }`,
        `    Do NOT call /api/calendar/* (returns 410 in delegated mode).`,
      );
    } else {
      lines.push(
        "",
        "  Cross-backend: not available for Outlook (user-managed connector,",
        "  no daemon proxy). Fall through to the session's MCP regardless.",
      );
    }
    lines.push(
      "",
      "If the call errors out, log one line to `## Agent Log` and proceed",
      "as if the window were empty.",
      close,
    );
    return lines.join("\n");
  }

  // mode === "native"
  return [
    open,
    `${displayName} is in native mode — see \`<integration_modes>.${key}_native_to\`.`,
    `Fetch this window (timeMin=${timeMin}, timeMax=${timeMax}) yourself via your`,
    `session backend's ${displayName} MCP surface. Do NOT call /api/calendar/*`,
    `or /api/integrations/*/exec — native mode has no daemon proxy.`,
    "",
    `If the native binding does not match your session backend (check`,
    `\`${key}_native_to\`), treat this provider as unavailable for this turn`,
    `and log one line to \`## Agent Log\`.`,
    close,
  ].join("\n");
}

/**
 * Fetch calendar events for the next N days and format as markdown.
 * Groups events by date with day-of-week and Today/Tomorrow labels.
 * Returns null if CalendarService is not available.
 */
async function fetchCalendarEvents(
  deps: CalendarDeps,
  days: number,
): Promise<string | null> {
  const calendar = deps.services.calendar;
  if (!calendar) return null;

  try {
    const { timeMin, timeMax } = computeCalendarWindow(deps, days);

    const events = await calendar.listEvents(timeMin, timeMax);

    if (events.length === 0) {
      return `Calendar connected (Google Calendar). No events found in the next ${days} days.`;
    }

    return formatCalendarEvents(deps, events, days);
  } catch (err) {
    logger.warn(
      { err },
      "Failed to fetch calendar events for context",
    );
    return null;
  }
}

/** Format calendar events grouped by date */
function formatCalendarEvents(
  deps: CalendarDeps,
  events: CalendarEvent[],
  days: number,
): string {
  const now = new Date();
  const tz = deps.config.timezone || undefined;
  const todayStr = localDateStr(now, tz);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = localDateStr(tomorrow, tz);

  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // Group events by local date in the configured timezone.
  const byDate = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    if (!event.start) continue;
    const dateStr =
      event.start.length === 10
        ? event.start
        : localDateStr(new Date(event.start), tz);
    const group = byDate.get(dateStr) ?? [];
    group.push(event);
    byDate.set(dateStr, group);
  }

  const lines: string[] = [];

  // Generate all dates in range
  for (let i = 0; i < days; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() + i);
    const dateStr = localDateStr(date, tz);
    const localInfo = nowInTimezone(tz, date);
    const dayName = dayNames[localInfo.dayOfWeek];

    let label = "";
    if (dateStr === todayStr) label = " — Today";
    else if (dateStr === tomorrowStr) label = " — Tomorrow";

    lines.push(`## ${dateStr} (${dayName})${label}`);

    const dayEvents = byDate.get(dateStr);
    if (!dayEvents || dayEvents.length === 0) {
      lines.push("- (no events)");
    } else {
      for (const event of dayEvents) {
        const timeRange = formatTimeRange(deps, event);
        // Calendar titles/locations are fully attacker-controlled — anyone
        // who can send the user an invite controls them. They land inside
        // the daemon-rendered `context` (which `resolveTemplate` does NOT
        // sanitise), so escape `<`/`>` here so a crafted title cannot close
        // the `<calendar_events_*>` fence and inject a forged directive.
        const summary = sanitizeUntrustedTemplateValue(event.summary ?? "Untitled");
        const locationPart = event.location
          ? ` @ ${sanitizeUntrustedTemplateValue(event.location)}`
          : "";
        lines.push(`- ${timeRange} ${summary}${locationPart}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/** Format event time range as "HH:MM–HH:MM" or "All day" */
function formatTimeRange(deps: CalendarDeps, event: CalendarEvent): string {
  if (!event.start || !event.end) return "All day";
  // All-day events have date format (YYYY-MM-DD) without time component
  if (event.start.length === 10) return "All day";

  const startDate = new Date(event.start);
  const endDate = new Date(event.end);
  const startTime = formatLocalTime(deps, startDate);
  const endTime = formatLocalTime(deps, endDate);
  return `${startTime}–${endTime}`;
}

function formatLocalTime(deps: CalendarDeps, date: Date): string {
  const local = nowInTimezone(deps.config.timezone || undefined, date);
  return `${String(local.hours).padStart(2, "0")}:${String(local.minutes).padStart(2, "0")}`;
}
