import { describe, it, expect } from "vitest";
import type { AgentConfig } from "../../config.js";
import { createScheduleOptionsRoutes } from "./schedule-options.js";

/**
 * `GET /api/schedule/options` — SCHEDULE_API_REDESIGN_PLAN.md §4.4.
 *
 * Pure read endpoint. The payload mirrors what the agent's error
 * envelopes cite via `docsUrl`, so test pins the shape contract:
 * tiers / aliases / per-backend models / frequencies / daysOfWeek /
 * time format / timezone default.
 */

function fakeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { timezone: "Asia/Tokyo", ...overrides } as unknown as AgentConfig;
}

describe("GET /api/schedule/options", () => {
  it("returns the canonical option payload shape", async () => {
    const app = createScheduleOptionsRoutes({ config: fakeConfig() });
    const res = await app.request("/schedule/options");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tiers: string[];
      modelAliases: Record<string, string>;
      models: Record<string, Array<{ id: string; tier: string; deprecated: boolean }>>;
      frequencies: string[];
      daysOfWeek: Record<string, string>;
      recurrence: {
        intervalHours: { min: number; max: number };
        minuteOfHour: { min: number; max: number };
        daysOfMonth: { min: number; max: number };
        onMissingDay: { values: string[]; default: string };
      };
      timeFormat: string;
      timezoneExample: string;
      defaults: { timezone: string };
    };

    expect(body.tiers).toEqual(["lite", "medium", "high"]);
    expect(body.modelAliases).toEqual({ sonnet: "medium", opus: "high" });
    expect(body.frequencies).toEqual(["hourly", "daily", "weekly", "monthly"]);
    expect(body.daysOfWeek).toEqual({
      "0": "Sun",
      "1": "Mon",
      "2": "Tue",
      "3": "Wed",
      "4": "Thu",
      "5": "Fri",
      "6": "Sat",
    });
    expect(body.timeFormat).toBe("HH:MM (24h)");
    expect(body.timezoneExample).toBe("Asia/Tokyo");
    expect(body.defaults.timezone).toBe("Asia/Tokyo");
  });

  it("exposes the recurrence-rule composition bounds the LLM needs upfront", async () => {
    // Without these surfaces /options would advertise "hourly" / "monthly"
    // as frequencies but force the LLM to probe Phase D's error envelope
    // to discover intervalHours caps at 23 and onMissingDay is the
    // non-obvious "skip" | "lastDayOfMonth" enum. Keeping the bounds
    // here so the recurring-schedule skill can fetch /options once per
    // session and compose a valid rule on the first try.
    const app = createScheduleOptionsRoutes({ config: fakeConfig() });
    const res = await app.request("/schedule/options");
    const body = (await res.json()) as {
      recurrence: {
        intervalHours: { min: number; max: number };
        minuteOfHour: { min: number; max: number };
        daysOfMonth: { min: number; max: number };
        onMissingDay: { values: string[]; default: string };
      };
    };

    expect(body.recurrence.intervalHours).toEqual({ min: 1, max: 23 });
    expect(body.recurrence.minuteOfHour).toEqual({ min: 0, max: 59 });
    expect(body.recurrence.daysOfMonth).toEqual({ min: 1, max: 31 });
    expect(body.recurrence.onMissingDay.values).toEqual(["skip", "lastDayOfMonth"]);
    expect(body.recurrence.onMissingDay.default).toBe("lastDayOfMonth");
  });

  it("lists each registered backend with at least one model row", async () => {
    const app = createScheduleOptionsRoutes({ config: fakeConfig() });
    const res = await app.request("/schedule/options");
    const body = (await res.json()) as {
      models: Record<string, Array<{ id: string; tier: string; deprecated: boolean }>>;
    };

    expect(Object.keys(body.models).sort()).toEqual(
      ["claude", "codex", "gemini", "opencode"].sort(),
    );
    expect(body.models.claude.length).toBeGreaterThan(0);
    expect(body.models.codex.length).toBeGreaterThan(0);
    expect(body.models.gemini.length).toBeGreaterThan(0);
    expect(body.models.opencode.length).toBeGreaterThan(0);
  });

  it("includes deprecated entries in the model listing (dashboards surface them)", async () => {
    const app = createScheduleOptionsRoutes({ config: fakeConfig() });
    const res = await app.request("/schedule/options");
    const body = (await res.json()) as {
      models: Record<string, Array<{ id: string; tier: string; deprecated: boolean }>>;
    };
    const opus46 = body.models.claude.find(
      (m: { id: string; deprecated: boolean }) => m.id === "claude-opus-4-6",
    );
    expect(opus46).toBeDefined();
    expect(opus46?.deprecated).toBe(true);
  });

  it("falls back to the system-resolved timezone when config.timezone is empty", async () => {
    const app = createScheduleOptionsRoutes({
      config: fakeConfig({ timezone: "" }),
    });
    const res = await app.request("/schedule/options");
    const body = (await res.json()) as { defaults: { timezone: string } };
    // `Intl.DateTimeFormat().resolvedOptions().timeZone` always returns a
    // non-empty IANA zone identifier on every supported platform.
    expect(body.defaults.timezone.length).toBeGreaterThan(0);
    expect(body.defaults.timezone).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  });

  it("honors the operator-configured timezone when set", async () => {
    const app = createScheduleOptionsRoutes({
      config: fakeConfig({ timezone: "America/New_York" }),
    });
    const res = await app.request("/schedule/options");
    const body = (await res.json()) as { defaults: { timezone: string } };
    expect(body.defaults.timezone).toBe("America/New_York");
  });
});
