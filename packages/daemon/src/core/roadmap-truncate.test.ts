import { describe, it, expect } from "vitest";
import { truncateRoadmap } from "./roadmap-truncate.js";

// Fixed clock: Monday 2026-04-20 12:00 UTC. Window defaults are lookback
// 7d + lookahead 30d = [2026-04-13, 2026-05-20] (inclusive on both ends
// under YMD-string lexicographic comparison). Tests below use system TZ
// when the timezone field is omitted; explicit tests exercise
// America/New_York boundary behaviour.
const NOW = new Date("2026-04-20T12:00:00.000Z");

function roadmap(agentActionPlan: string): string {
  return [
    "# Roadmap",
    "> Last synced: 2026-04-20",
    "",
    "## Annual Goals",
    "- Ship v1",
    "",
    "## Quarterly Focus",
    "- Q2 planning",
    "",
    "## Long-term Plans",
    "- [2026-Q4] Trip to Europe — Source: dm 2026-03-01",
    "",
    agentActionPlan,
    "## Recurring",
    "- Every Friday: weekly review",
    "",
  ].join("\n");
}

describe("truncateRoadmap", () => {
  it("returns content unchanged when there is no Agent Action Plan section", () => {
    const body = [
      "# Roadmap",
      "## Annual Goals",
      "- Ship v1",
      "",
      "## Long-term Plans",
      "- [2026] X",
      "",
    ].join("\n");
    expect(truncateRoadmap(body, { now: NOW })).toBe(body);
  });

  it("returns content unchanged when Agent Action Plan is empty", () => {
    const body = roadmap(["## Agent Action Plan", ""].join("\n"));
    expect(truncateRoadmap(body, { now: NOW })).toBe(body);
  });

  it("keeps event entries inside [today-7d, today+30d]", () => {
    const body = roadmap(
      [
        "## Agent Action Plan",
        "",
        "### 2026-04-18 ~ 04-18: In-window past",
        "Source: Google Calendar",
        "",
        "### 2026-05-15: In-window future",
        "Source: Google Calendar",
        "",
      ].join("\n"),
    );

    const result = truncateRoadmap(body, { now: NOW });
    expect(result).toContain("In-window past");
    expect(result).toContain("In-window future");
    expect(result).not.toContain("entries omitted");
  });

  it("drops event entries older than lookback window", () => {
    const body = roadmap(
      [
        "## Agent Action Plan",
        "",
        "### 2026-03-01 ~ 03-01: Old event",
        "Source: Google Calendar",
        "",
        "### 2026-04-20: Today event",
        "Source: Google Calendar",
        "",
      ].join("\n"),
    );

    const result = truncateRoadmap(body, { now: NOW });
    expect(result).not.toContain("Old event");
    expect(result).toContain("Today event");
    expect(result).toContain("1 older/farther entries omitted");
    expect(result).toContain("/api/context/roadmap");
  });

  it("drops event entries beyond lookahead window", () => {
    const body = roadmap(
      [
        "## Agent Action Plan",
        "",
        "### 2026-07-01: Far future event",
        "Source: Google Calendar",
        "",
        "### 2026-05-10: In-window",
        "Source: Google Calendar",
        "",
      ].join("\n"),
    );

    const result = truncateRoadmap(body, { now: NOW });
    expect(result).not.toContain("Far future event");
    expect(result).toContain("In-window");
    expect(result).toContain("1 older/farther entries omitted");
  });

  it("uses Source: wake-up date for Scheduled entries", () => {
    const body = roadmap(
      [
        "## Agent Action Plan",
        "",
        "### Scheduled: remind me about X  (task #12)",
        "Source: scheduled.task — wake-up 2026-05-01 09:00",
        "Status: ⏳ pending",
        "",
        "### Scheduled: old task  (task #3)",
        "Source: scheduled.task — wake-up 2026-02-10 09:00",
        "Status: ✓ completed",
        "",
      ].join("\n"),
    );

    const result = truncateRoadmap(body, { now: NOW });
    expect(result).toContain("remind me about X");
    expect(result).not.toContain("old task");
    expect(result).toContain("1 older/farther entries omitted");
  });

  it("keeps entries with unparseable header dates (conservative)", () => {
    const body = roadmap(
      [
        "## Agent Action Plan",
        "",
        "### Free-form heading with no date",
        "Source: custom",
        "",
        "### 2026-07-01: far future",
        "Source: Google Calendar",
        "",
      ].join("\n"),
    );

    const result = truncateRoadmap(body, { now: NOW });
    expect(result).toContain("Free-form heading with no date");
    expect(result).not.toContain("far future");
  });

  it("preserves non-Agent-Action-Plan sections verbatim", () => {
    const body = roadmap(
      [
        "## Agent Action Plan",
        "",
        "### 2026-01-01: Old",
        "",
      ].join("\n"),
    );

    const result = truncateRoadmap(body, { now: NOW });
    expect(result).toContain("## Annual Goals\n- Ship v1");
    expect(result).toContain("## Quarterly Focus\n- Q2 planning");
    expect(result).toContain(
      "## Long-term Plans\n- [2026-Q4] Trip to Europe — Source: dm 2026-03-01",
    );
    expect(result).toContain("## Recurring\n- Every Friday: weekly review");
  });

  it("respects the final section boundary (no next-heading)", () => {
    // Agent Action Plan is the LAST section — ensure the truncator handles
    // end-of-file correctly.
    const body = [
      "# Roadmap",
      "",
      "## Agent Action Plan",
      "",
      "### 2026-01-01: Old",
      "Source: Google Calendar",
      "",
      "### 2026-04-25: Kept",
      "Source: Google Calendar",
      "",
    ].join("\n");

    const result = truncateRoadmap(body, { now: NOW });
    expect(result).toContain("2026-04-25: Kept");
    expect(result).not.toContain("2026-01-01: Old");
  });

  it("respects custom lookback / lookahead options", () => {
    const body = roadmap(
      [
        "## Agent Action Plan",
        "",
        "### 2026-04-25: 5d ahead",
        "Source: Google Calendar",
        "",
        "### 2026-05-15: 25d ahead",
        "Source: Google Calendar",
        "",
      ].join("\n"),
    );

    // Tight 3d lookahead — only 5d-ahead entry is out of window.
    const result = truncateRoadmap(body, {
      now: NOW,
      lookaheadDays: 3,
    });
    expect(result).not.toContain("5d ahead");
    expect(result).not.toContain("25d ahead");
    expect(result).toContain("2 older/farther entries omitted");
  });

  it("counts multiple dropped entries in the omission marker", () => {
    const body = roadmap(
      [
        "## Agent Action Plan",
        "",
        "### 2026-01-01: Old 1",
        "Source: Google Calendar",
        "",
        "### 2026-02-01: Old 2",
        "Source: Google Calendar",
        "",
        "### 2026-09-01: Far 1",
        "Source: Google Calendar",
        "",
        "### 2026-04-20: Kept",
        "Source: Google Calendar",
        "",
      ].join("\n"),
    );

    const result = truncateRoadmap(body, { now: NOW });
    expect(result).toContain("3 older/farther entries omitted");
    expect(result).toContain("Kept");
  });

  it("preserves preamble text between the section heading and the first entry", () => {
    const body = roadmap(
      [
        "## Agent Action Plan",
        "",
        "Some preamble note from the agent.",
        "",
        "### 2026-04-25: Kept",
        "Source: Google Calendar",
        "",
      ].join("\n"),
    );

    const result = truncateRoadmap(body, { now: NOW });
    expect(result).toContain("Some preamble note from the agent.");
  });

  it("handles Agent Action Plan that starts directly with ### (no blank line)", () => {
    // Exercises the `sectionBody.startsWith("### ")` branch in splitEntries,
    // which only triggers when the section heading is followed by an
    // immediate entry with no blank line — unusual but legal markdown.
    const body = [
      "# Roadmap",
      "",
      "## Agent Action Plan",
      "### 2026-01-01: Old",
      "Source: Google Calendar",
      "",
      "### 2026-04-25: Kept",
      "Source: Google Calendar",
      "",
    ].join("\n");

    const result = truncateRoadmap(body, { now: NOW });
    expect(result).toContain("2026-04-25: Kept");
    expect(result).not.toContain("2026-01-01: Old");
  });

  it("drops Scheduled entries whose wake-up line is missing a date (conservative null)", () => {
    // A malformed Scheduled: entry without a parseable wake-up date must
    // be retained — we cannot classify it so we default to keeping it.
    const body = roadmap(
      [
        "## Agent Action Plan",
        "",
        "### Scheduled: malformed entry  (task #99)",
        "Source: scheduled.task — no date at all",
        "Status: ⏳ pending",
        "",
        "### 2026-07-01: far future",
        "Source: Google Calendar",
        "",
      ].join("\n"),
    );

    const result = truncateRoadmap(body, { now: NOW });
    expect(result).toContain("malformed entry");
    expect(result).not.toContain("far future");
  });

  it("handles file that starts with ## Agent Action Plan (no preceding sections)", () => {
    // Edge case: file begins directly with the Agent Action Plan header,
    // exercising the `content.startsWith(...)` branch of the bounds finder.
    const body = [
      "## Agent Action Plan",
      "",
      "### 2026-01-01: Old",
      "Source: Google Calendar",
      "",
      "### 2026-04-25: Kept",
      "Source: Google Calendar",
      "",
    ].join("\n");

    const result = truncateRoadmap(body, { now: NOW });
    expect(result).toContain("2026-04-25: Kept");
    expect(result).not.toContain("2026-01-01: Old");
  });

  // C2 regression: the UTC-day-floor variant disagreed with the user's
  // calendar around UTC-midnight rollover. For west-of-UTC timezones
  // (e.g. America/New_York), late local evening already advances the
  // UTC date — a UTC-floor would erroneously include entries past the
  // user's local +30d boundary. The local-YMD floor matches the user's
  // expectation in either direction.
  describe("timezone-aware day boundary", () => {
    // Evening review firing at 18:00 EDT (= 22:00 UTC) on 2026-04-20.
    // UTC date and local date both equal 2026-04-20, so the boundary
    // assertions below exercise the trivial path; the explicit
    // boundary-crossing case is verified in the next test.
    const NYC_EARLY_EVENING = new Date("2026-04-20T22:00:00.000Z");

    it("keeps the +30-day boundary entry when run at 18:00 America/New_York", () => {
      const body = roadmap(
        [
          "## Agent Action Plan",
          "",
          "### 2026-05-20: exactly at +30d boundary",
          "Source: Google Calendar",
          "",
          "### 2026-05-21: just past +30d boundary",
          "Source: Google Calendar",
          "",
        ].join("\n"),
      );

      const result = truncateRoadmap(body, {
        now: NYC_EARLY_EVENING,
        timezone: "America/New_York",
      });
      expect(result).toContain("exactly at +30d boundary");
      expect(result).not.toContain("just past +30d boundary");
    });

    it("resolves 'today' in the given timezone (boundary-hour sensitivity)", () => {
      // At 22:00 EDT on 2026-04-20 (= 2026-04-21 02:00 UTC), UTC-based
      // floor returns 2026-04-21 → windowEnd = 2026-05-21 under old
      // semantics, erroneously KEEPING the 2026-05-21 entry the user
      // still sees as past their local +30d boundary. The local-YMD
      // floor correctly excludes it while keeping 2026-05-20.
      const NYC_LATE_EVENING = new Date("2026-04-21T02:00:00.000Z"); // 22:00 EDT 2026-04-20
      const body = roadmap(
        [
          "## Agent Action Plan",
          "",
          "### 2026-05-20: +30d in user's local calendar",
          "Source: Google Calendar",
          "",
          "### 2026-05-21: past +30d in user's local calendar",
          "Source: Google Calendar",
          "",
        ].join("\n"),
      );

      const result = truncateRoadmap(body, {
        now: NYC_LATE_EVENING,
        timezone: "America/New_York",
      });
      expect(result).toContain("+30d in user's local calendar");
      expect(result).not.toContain("past +30d in user's local calendar");
    });
  });

  it("is idempotent when nothing falls outside the window", () => {
    const body = roadmap(
      [
        "## Agent Action Plan",
        "",
        "### 2026-04-21: Kept A",
        "Source: Google Calendar",
        "",
        "### 2026-04-25: Kept B",
        "Source: Google Calendar",
        "",
      ].join("\n"),
    );

    const once = truncateRoadmap(body, { now: NOW });
    const twice = truncateRoadmap(once, { now: NOW });
    expect(once).toBe(body);
    expect(twice).toBe(once);
  });
});
