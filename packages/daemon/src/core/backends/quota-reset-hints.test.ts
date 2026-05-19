import { describe, expect, it } from "vitest";
import {
  buildAgentDayBoundaryHint,
  extractGenericQuotaResetHint,
} from "./quota-reset-hints.js";

describe("extractGenericQuotaResetHint", () => {
  // Frozen "now" so the relative-offset assertions are deterministic.
  // 2026-05-14T10:00:00Z — the test reads UTC fields off the result, so
  // any wall-clock that resolves cleanly works.
  const now = (): Date => new Date("2026-05-14T10:00:00Z");

  describe("relative offsets (OpenAI / 429 retry-after)", () => {
    it("parses 'try again in Xh Ym Zs'", () => {
      const hint = extractGenericQuotaResetHint(
        "Rate limit reached. Please try again in 1h 5m 30s. Visit https://...",
        now,
      );
      expect(hint).toEqual({
        hour: 11,
        minute: 5,
        timeZone: "UTC",
        rawLabel: expect.stringContaining("try again in 1h 5m 30s"),
      });
    });

    it("parses 'try again in Xm' alone", () => {
      const hint = extractGenericQuotaResetHint(
        "rate_limited: please try again in 26m",
        now,
      );
      expect(hint).toMatchObject({ hour: 10, minute: 26, timeZone: "UTC" });
    });

    it("parses 'retry-after: Ns' header form", () => {
      const hint = extractGenericQuotaResetHint(
        "HTTP 429 — retry-after: 90s",
        now,
      );
      expect(hint).toMatchObject({ hour: 10, minute: 1, timeZone: "UTC" });
    });

    it("returns null when relative offset matches but is zero", () => {
      // The helper only emits a hint when the parsed offset is positive;
      // a zero-second retry-after is ambiguous and falls through to the
      // other patterns (which don't match here).
      const hint = extractGenericQuotaResetHint("retry-after: 0s", now);
      expect(hint).toBeNull();
    });
  });

  describe("ISO timestamp", () => {
    it("parses 'try again at YYYY-MM-DDTHH:MM:SSZ'", () => {
      const hint = extractGenericQuotaResetHint(
        "quota exceeded. try again at 2026-05-15T03:45:00Z",
        now,
      );
      expect(hint).toMatchObject({ hour: 3, minute: 45, timeZone: "UTC" });
    });

    it("parses 'reset time YYYY-MM-DD HH:MM:SS' (space separator)", () => {
      const hint = extractGenericQuotaResetHint(
        "RESOURCE_EXHAUSTED — reset time 2026-05-15 12:30:00Z",
        now,
      );
      expect(hint).toMatchObject({ hour: 12, minute: 30, timeZone: "UTC" });
    });
  });

  describe("absolute clock time", () => {
    it("parses 'try again at HH:MM (TZ)'", () => {
      const hint = extractGenericQuotaResetHint(
        "Rate limit. try again at 17:30 UTC",
        now,
      );
      expect(hint).toMatchObject({ hour: 17, minute: 30, timeZone: "UTC" });
    });

    it("parses 'resets at Xpm (TZ)' Anthropic-style", () => {
      const hint = extractGenericQuotaResetHint(
        "Your messages limit will reset at 5pm (PST)",
        now,
      );
      expect(hint).toMatchObject({ hour: 17, minute: 0, timeZone: "PST" });
    });

    it("parses 'resets 11am' without TZ", () => {
      const hint = extractGenericQuotaResetHint("limit resets 11am", now);
      expect(hint).toMatchObject({ hour: 11, minute: 0 });
      expect(hint?.timeZone).toBeUndefined();
    });
  });

  describe("buildAgentDayBoundaryHint", () => {
    it("emits the boundary hour with the configured timezone", () => {
      expect(buildAgentDayBoundaryHint(4, "Asia/Tokyo")).toEqual({
        hour: 4,
        minute: 0,
        timeZone: "Asia/Tokyo",
        rawLabel: "next agent-day boundary (04:00 Asia/Tokyo)",
      });
    });

    it("omits timeZone when the config value is empty/whitespace", () => {
      // AgentConfig.timezone defaults to "" — the dashboard would render
      // "resets at 04:00 ()" if we passed the empty string through.
      const hint = buildAgentDayBoundaryHint(4, "");
      expect(hint).toEqual({
        hour: 4,
        minute: 0,
        rawLabel: "next agent-day boundary (04:00)",
      });
      expect(hint.timeZone).toBeUndefined();
    });

    it("omits timeZone when undefined", () => {
      const hint = buildAgentDayBoundaryHint(4, undefined);
      expect(hint.timeZone).toBeUndefined();
    });

    it("clamps hour to [0, 23] and truncates fractions", () => {
      // Defensive: the schema doesn't bound dayBoundaryHour, so a misconfig
      // (e.g. 24 or 4.5) shouldn't produce a row that violates the
      // BackendQuotaResetHint contract (hour ∈ [0, 23]).
      expect(buildAgentDayBoundaryHint(25, "UTC").hour).toBe(23);
      expect(buildAgentDayBoundaryHint(-3, "UTC").hour).toBe(0);
      expect(buildAgentDayBoundaryHint(4.7, "UTC").hour).toBe(4);
    });

    it("pads single-digit hour in rawLabel", () => {
      expect(buildAgentDayBoundaryHint(7, "UTC").rawLabel).toContain("07:00");
    });
  });

  describe("no match", () => {
    it("returns null on empty string", () => {
      expect(extractGenericQuotaResetHint("", now)).toBeNull();
    });

    it("returns null when no reset-time language present", () => {
      expect(
        extractGenericQuotaResetHint("Internal server error", now),
      ).toBeNull();
    });

    it("does not false-positive on a bare '5pm' in unrelated prose", () => {
      // The absolute-time regex is anchored on "try again at" / "resets",
      // so a stray time mention should NOT trigger the parser.
      expect(
        extractGenericQuotaResetHint(
          "Your meeting is at 5pm tomorrow",
          now,
        ),
      ).toBeNull();
    });
  });
});
