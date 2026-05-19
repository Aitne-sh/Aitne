import { describe, it, expect } from "vitest";
import {
  deriveDefaultScheduleLabel,
  extractDefaultSchedulesSection,
  renderDefaultSchedulesSection,
  upsertManagementRulesDefaultSchedules,
  type DefaultScheduleSnapshotEntry,
} from "./default-schedules-reconciler.js";

const briefing: DefaultScheduleSnapshotEntry = {
  id: 1,
  label: "Morning briefing",
  recurrenceRule: { frequency: "daily", time: "08:00", timezone: "America/New_York" },
  enabled: true,
  pinnedToQuietHours: true,
  subFlow: "morning_briefing",
};

const evening: DefaultScheduleSnapshotEntry = {
  id: 2,
  label: "Evening summary",
  recurrenceRule: { frequency: "daily", time: "21:00", timezone: "America/New_York" },
  enabled: false,
  pinnedToQuietHours: false,
  subFlow: "evening_summary",
};

describe("renderDefaultSchedulesSection", () => {
  it("renders the empty-state placeholder when no entries are present", () => {
    const out = renderDefaultSchedulesSection([]);
    expect(out.startsWith("## Default Schedules\n")).toBe(true);
    expect(out).toContain("_No default schedules._");
    // Section MUST NOT end with a trailing newline — upsert appends it.
    expect(out.endsWith("\n")).toBe(false);
  });

  it("renders one row per entry, id-sorted", () => {
    const out = renderDefaultSchedulesSection([evening, briefing]);
    expect(out).toContain("| Schedule | Time | Status | Notes |");
    const briefingIdx = out.indexOf("Morning briefing");
    const eveningIdx = out.indexOf("Evening summary");
    expect(briefingIdx).toBeGreaterThan(0);
    expect(eveningIdx).toBeGreaterThan(briefingIdx);
  });

  it("renders enabled / disabled status from the row's enabled flag", () => {
    const out = renderDefaultSchedulesSection([briefing, evening]);
    expect(out).toMatch(/Morning briefing[^|]*\|[^|]*\|\s*enabled\s*\|/);
    expect(out).toMatch(/Evening summary[^|]*\|[^|]*\|\s*disabled\s*\|/);
  });

  it("renders the pinned-to-quiet-hours notes column", () => {
    const out = renderDefaultSchedulesSection([briefing, evening]);
    expect(out).toContain("pinned to quiet_hours_end");
    expect(out).toContain("user-pinned time");
  });

  it("escapes pipe characters in user-supplied cells", () => {
    const tricky: DefaultScheduleSnapshotEntry = {
      ...briefing,
      label: "Morning | brief",
    };
    const out = renderDefaultSchedulesSection([tricky]);
    expect(out).toContain("Morning \\| brief");
  });

  it("renders daily schedules via formatRecurrenceLabel (preserves cadence wording)", () => {
    const out = renderDefaultSchedulesSection([briefing]);
    expect(out).toContain("Daily at 08:00 (America/New_York)");
  });

  it("renders weekly schedules with the day list — no information loss", () => {
    const weekly: DefaultScheduleSnapshotEntry = {
      id: 3,
      label: "Weekly check-in",
      recurrenceRule: {
        frequency: "weekly",
        time: "09:00",
        timezone: "America/New_York",
        daysOfWeek: [1, 3, 5],
      },
      enabled: true,
      pinnedToQuietHours: false,
      subFlow: "weekly_checkin",
    };
    const out = renderDefaultSchedulesSection([weekly]);
    expect(out).toContain("Weekly on Mon, Wed, Fri at 09:00 (America/New_York)");
  });

  it("renders monthly schedules with the day-of-month list", () => {
    const monthly: DefaultScheduleSnapshotEntry = {
      id: 4,
      label: "Monthly review",
      recurrenceRule: {
        frequency: "monthly",
        time: "10:00",
        daysOfMonth: [1, 15],
      },
      enabled: true,
      pinnedToQuietHours: false,
      subFlow: "monthly_review",
    };
    const out = renderDefaultSchedulesSection([monthly]);
    expect(out).toContain("Monthly on day 1, 15 at 10:00");
    // No timezone parens when timezone is absent from the rule.
    expect(out).not.toContain("Monthly on day 1, 15 at 10:00 (");
  });
});

describe("upsertManagementRulesDefaultSchedules", () => {
  const SECTION =
    "## Default Schedules\n\n_No default schedules._";
  const NEW_SECTION =
    "## Default Schedules\n\n| Schedule | Time |\n|---|---|\n| a | x |";

  it("returns the section alone when content is empty", () => {
    expect(upsertManagementRulesDefaultSchedules("", SECTION)).toBe(
      `${SECTION}\n`,
    );
  });

  it("appends at the end when no Default Schedules section exists", () => {
    const out = upsertManagementRulesDefaultSchedules(
      "# Management rules\n\n## Active Policies\n\nx\n",
      SECTION,
    );
    expect(out).toContain("## Active Policies");
    expect(out).toContain("## Default Schedules");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("replaces an existing Default Schedules section in place", () => {
    const before =
      "# Management rules\n\n## Default Schedules\n\nold body\n\n## Notes\n\nx\n";
    const out = upsertManagementRulesDefaultSchedules(before, NEW_SECTION);
    expect(out).not.toContain("old body");
    expect(out).toContain("| a | x |");
    expect(out).toContain("## Notes");
  });
});

describe("extractDefaultSchedulesSection", () => {
  it("returns null when no section is present", () => {
    expect(
      extractDefaultSchedulesSection("# Management rules\n\n## Notes\n\nz\n"),
    ).toBe(null);
  });

  it("returns the section text when present", () => {
    const content =
      "# Management rules\n\n## Default Schedules\n\n| a |\n|---|\n| b |\n\n## Notes\n\nz\n";
    const extracted = extractDefaultSchedulesSection(content);
    expect(extracted).not.toBe(null);
    expect(extracted).toContain("## Default Schedules");
    expect(extracted).toContain("| a |");
  });
});

describe("deriveDefaultScheduleLabel", () => {
  it("title-cases an underscore slug", () => {
    expect(deriveDefaultScheduleLabel("morning_briefing", "x")).toBe(
      "Morning briefing",
    );
  });

  it("falls back to the description when sub_flow is null", () => {
    expect(deriveDefaultScheduleLabel(null, "morning briefing — daily")).toBe(
      "morning briefing — daily",
    );
  });

  it("falls back to em-dash when both inputs are empty", () => {
    expect(deriveDefaultScheduleLabel(null, "")).toBe("—");
  });
});
