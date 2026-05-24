import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { localDateStr } from "@aitne/shared";
import { applySchema } from "../db/schema.js";
import { writeIntegrations } from "../db/integrations-store.js";
import {
  createServiceRegistry,
  type ServiceRegistry,
} from "../services/service-registry.js";
import type {
  CalendarEvent,
  CalendarService,
} from "../services/calendar.js";
import type { AgentConfig } from "../config.js";
import { renderCalendarBlock } from "./context-builder-calendar.js";

/**
 * Per-sibling test peer for `context-builder-calendar.ts`. Mirrors the
 * test surface previously delivered through the class-level
 * `ContextBuilder.buildCalendarBlock()` indirection, but calls
 * `renderCalendarBlock` directly with the explicit `{ db, config, services }`
 * dependency object. The qualitative win of the split is precisely
 * that no `ContextBuilder` instantiation is needed here.
 *
 * Coverage pins:
 *   - every-provider-disabled fallback to the legacy
 *     `<calendar_status>not available>` sentinel
 *   - direct mode with `services.calendar` populated → inline events
 *   - direct mode for Outlook (no daemon service) → fallback hint
 *   - delegated mode with daemon proxy (Google) → cross-backend curl
 *   - delegated mode with user-managed connector (Outlook) → collapse
 *     to session MCP only
 *   - native mode → MCP directive with no daemon proxy
 *   - `prepassCovers=true` for delegated/native → observations hint
 *     instead of fetch-yourself directive (A8 / Finding 5 contract)
 *   - multi-provider wrap in `<calendar_events_*>` envelope
 */
describe("context-builder-calendar", () => {
  let db: Database.Database;
  let services: ServiceRegistry;
  let config: AgentConfig;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    services = createServiceRegistry();
    config = {
      dataDir: "/tmp/pa-calendar-test",
      externalObsidianVaultPath: null,
      timezone: "UTC",
    } as unknown as AgentConfig;
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  function deps(): { db: Database.Database; config: AgentConfig; services: ServiceRegistry } {
    return { db, config, services };
  }

  function mockCalendar(events: CalendarEvent[]): CalendarService {
    return {
      available: true,
      init: vi.fn(),
      listEvents: vi.fn().mockResolvedValue(events),
      createEvent: vi.fn(),
    } as unknown as CalendarService;
  }

  function rejectingCalendar(error: Error): CalendarService {
    return {
      available: true,
      init: vi.fn(),
      listEvents: vi.fn().mockRejectedValue(error),
      createEvent: vi.fn(),
    } as unknown as CalendarService;
  }

  it("falls back to <calendar_status>not available> when every provider is disabled", async () => {
    // defaultIntegrationsMap returns mode='disabled' for every key when
    // the settings row is absent. The block must NOT emit an envelope
    // wrapper in this case — task-flow prose greps for the exact
    // `<calendar_status>not available` string to decide "skip calendar
    // steps", and an empty `<calendar_events_*>` envelope would defeat
    // that signal.
    const out = await renderCalendarBlock(deps(), {
      days: 3,
      blockName: "calendar_events_3d",
    });

    expect(out).toContain("<calendar_status>");
    expect(out).toContain("Calendar service not available");
    expect(out).not.toContain("<calendar_events_");
    expect(out).not.toContain("<provider");
  });

  it("renders direct-mode Google Calendar events inline when services.calendar is wired", async () => {
    writeIntegrations(db, {
      google_calendar: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00.000Z",
      },
    });
    const todayStr = localDateStr(new Date(), "UTC");
    services.calendar = mockCalendar([
      {
        id: "ev-1",
        summary: "Standup",
        start: `${todayStr}T09:00:00Z`,
        end: `${todayStr}T09:30:00Z`,
        description: null,
        location: null,
        allDay: false,
      },
    ]);

    const out = await renderCalendarBlock(deps(), {
      days: 1,
      blockName: "calendar_today",
    });

    expect(out).toContain('<calendar_today days="1"');
    expect(out).toContain('<provider key="google_calendar" mode="direct">');
    expect(out).toContain("Standup");
    expect(out).toContain("</calendar_today>");
  });

  it("emits the 'no events' direct-mode sentinel when the calendar service returns an empty list", async () => {
    writeIntegrations(db, {
      google_calendar: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00.000Z",
      },
    });
    services.calendar = mockCalendar([]);

    const out = await renderCalendarBlock(deps(), {
      days: 7,
      blockName: "calendar_events_7d",
    });

    expect(out).toContain('<provider key="google_calendar" mode="direct">');
    expect(out).toContain("No events found in the next 7 days");
  });

  it("falls through to the direct-mode hint when CalendarService throws", async () => {
    // Hard service errors (auth expired, transient network) must not
    // blow up the whole context build — the provider sub-block should
    // fall back to the "fetch yourself" hint so the task-flow can pick
    // up the REST endpoint instead of bricking the routine.
    writeIntegrations(db, {
      google_calendar: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00.000Z",
      },
    });
    services.calendar = rejectingCalendar(new Error("Auth expired"));

    const out = await renderCalendarBlock(deps(), {
      days: 1,
      blockName: "calendar_today",
    });

    expect(out).toContain('<provider key="google_calendar" mode="direct">');
    expect(out).toContain("daemon service not initialized");
    expect(out).toContain("/api/calendar/events");
  });

  it("emits the direct-mode fallback hint for Outlook (no daemon service yet)", async () => {
    // The daemon does not ship an Outlook CalendarService; direct mode
    // surfaces a fallback hint that points at the REST endpoint so the
    // task-flow can still acquire the window. Pin the absence of any
    // Google-only language to guard against accidental cross-pollination.
    writeIntegrations(db, {
      outlook_calendar: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00.000Z",
      },
    });

    const out = await renderCalendarBlock(deps(), {
      days: 1,
      blockName: "calendar_today",
    });

    expect(out).toContain('<provider key="outlook_calendar" mode="direct">');
    expect(out).toContain("/api/calendar/outlook");
    expect(out).not.toContain("Google Calendar:");
  });

  it("delegated mode for Google emits both same-backend and cross-backend branches", async () => {
    writeIntegrations(db, {
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00.000Z",
      },
    });

    const out = await renderCalendarBlock(deps(), {
      days: 7,
      blockName: "calendar_events_7d",
    });

    expect(out).toContain('<provider key="google_calendar" mode="delegated">');
    expect(out).toContain("Same-backend");
    expect(out).toContain("Cross-backend");
    expect(out).toContain("/api/integrations/google_calendar/exec");
    // P7 — daemon does not name MCP tools; the directive routes through
    // <integration_modes> and the session-bound MCP surface.
    expect(out).not.toContain("mcp__claude_ai_Google_Calendar__");
  });

  it("delegated mode for user-managed Outlook collapses the cross-backend branch", async () => {
    // The Outlook descriptor sets `userManagedConnector: true` so the
    // daemon ships no `/api/integrations/outlook_calendar/exec` proxy.
    // The block must surface that explicitly rather than dangling a
    // cross-backend curl that would 404.
    writeIntegrations(db, {
      outlook_calendar: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00.000Z",
      },
    });

    const out = await renderCalendarBlock(deps(), {
      days: 3,
      blockName: "calendar_events_3d",
    });

    expect(out).toContain(
      '<provider key="outlook_calendar" mode="delegated">',
    );
    expect(out).toContain("user-managed connector");
    expect(out).not.toContain("/api/integrations/outlook_calendar/exec");
  });

  it("native mode emits a session-MCP directive with no daemon proxy", async () => {
    writeIntegrations(db, {
      google_calendar: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00.000Z",
      },
    });

    const out = await renderCalendarBlock(deps(), {
      days: 3,
      blockName: "calendar_events_3d",
    });

    expect(out).toContain('<provider key="google_calendar" mode="native">');
    expect(out).toContain("google_calendar_native_to");
    // Native mode has no daemon proxy — the directive prohibits both
    // proxy paths explicitly. The string "/api/calendar/" appears only
    // inside the "Do NOT call /api/calendar/*" prohibition, so the
    // assertion is "no proxy fallback wired" (e.g. no curl POST line)
    // rather than absence of the path token.
    expect(out).toContain("Do NOT call /api/calendar/*");
    expect(out).toContain("native mode has no daemon proxy");
    expect(out).not.toContain("/api/integrations/google_calendar/exec");
  });

  it("prepassCovers=true makes non-direct providers emit the observations hint, not a fetch-yourself directive", async () => {
    // A8 / Finding 5 — when the parent routine's `routine.fetch_window`
    // pre-pass has already POSTed events to `/api/observations`, the
    // provider sub-block must point the main session at that table
    // instead of restating the MCP fan-out directive (the cost
    // regression that motivated the flag).
    writeIntegrations(db, {
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00.000Z",
      },
    });

    const out = await renderCalendarBlock(deps(), {
      days: 7,
      blockName: "calendar_events_7d",
      prepassCovers: true,
    });

    expect(out).toContain('<provider key="google_calendar" mode="delegated">');
    expect(out).toContain("/api/observations");
    expect(out).toContain("source_prefix=google_calendar:");
    // Legacy directive language must NOT leak through when the pre-pass
    // owns the window.
    expect(out).not.toContain("/api/integrations/google_calendar/exec");
    expect(out).not.toContain("Cross-backend");
    expect(out).not.toContain("Fetch this window");
  });

  it("prepassCovers=true is a no-op on direct-mode sub-blocks (pre-pass only fires for non-direct)", async () => {
    // The flag's documented behaviour is "non-direct providers re-route
    // to observations." Direct sub-blocks remain unchanged — the
    // daemon's CalendarService is still the source of truth.
    writeIntegrations(db, {
      google_calendar: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00.000Z",
      },
    });
    services.calendar = mockCalendar([]);

    const out = await renderCalendarBlock(deps(), {
      days: 7,
      blockName: "calendar_events_7d",
      prepassCovers: true,
    });

    expect(out).toContain('<provider key="google_calendar" mode="direct">');
    expect(out).not.toContain("/api/observations");
    expect(out).toContain("No events found in the next 7 days");
  });

  it("wraps multiple provider sub-blocks in a single <calendar_events_*> envelope with window attributes", async () => {
    writeIntegrations(db, {
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "codex",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00.000Z",
      },
      outlook_calendar: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00.000Z",
      },
    });

    const out = await renderCalendarBlock(deps(), {
      days: 3,
      blockName: "calendar_events_3d",
    });

    expect(out).toMatch(
      /<calendar_events_3d days="3" timeMin="[^"]+" timeMax="[^"]+">/,
    );
    expect(out).toContain('<provider key="google_calendar" mode="delegated">');
    expect(out).toContain('<provider key="outlook_calendar" mode="native">');
    expect(out).toContain("</calendar_events_3d>");
  });

  it("omits provider sub-blocks for any provider in disabled mode", async () => {
    // Mixed-mode deployments: direct google + disabled outlook should
    // produce one google sub-block and nothing for outlook. The wrapper
    // envelope is still emitted because google is non-disabled.
    writeIntegrations(db, {
      google_calendar: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00.000Z",
      },
      outlook_calendar: {
        mode: "disabled",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00.000Z",
      },
    });
    services.calendar = mockCalendar([]);

    const out = await renderCalendarBlock(deps(), {
      days: 3,
      blockName: "calendar_events_3d",
    });

    expect(out).toContain('<calendar_events_3d days="3"');
    expect(out).toContain('<provider key="google_calendar" mode="direct">');
    expect(out).not.toContain('key="outlook_calendar"');
  });

  it("computes the timeMin/timeMax window from the operator's timezone day boundary, not the server's local clock", async () => {
    // Pin the timezone behaviour: with timezone=Asia/Tokyo (UTC+9), the
    // 1-day window starts at the previous local midnight (Tokyo), which
    // is 15:00 UTC the previous calendar day. This guarantees that a
    // user in Tokyo running the morning routine never sees an empty
    // window because the daemon's process clock happens to be in UTC.
    config = {
      ...config,
      timezone: "Asia/Tokyo",
    } as AgentConfig;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T03:00:00.000Z"));
    writeIntegrations(db, {
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00.000Z",
      },
    });

    const out = await renderCalendarBlock(deps(), {
      days: 1,
      blockName: "calendar_today",
    });

    // 2026-04-20 03:00 UTC = 2026-04-20 12:00 Tokyo. Day boundary is
    // 00:00 local on 2026-04-20, which is 2026-04-19 15:00 UTC.
    expect(out).toContain('timeMin="2026-04-19T15:00:00.000Z"');
    expect(out).toContain('timeMax="2026-04-20T15:00:00.000Z"');
  });
});
