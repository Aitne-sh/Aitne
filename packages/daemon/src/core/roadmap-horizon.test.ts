import { describe, expect, it } from "vitest";
import {
  addDaysYmd,
  bumpReviewCycle,
  deriveReviewDate,
  isValidYmd,
  normalizeLongTermPlanLine,
  resolveHorizonAnchor,
  todayYmd,
  type LongTermPlanSource,
} from "./roadmap-horizon.js";

describe("roadmap horizon helpers", () => {
  it("validates real YYYY-MM-DD calendar dates", () => {
    expect(isValidYmd("2026-04-21")).toBe(true);
    expect(isValidYmd("2026-4-21")).toBe(false);
    expect(isValidYmd("2026-02-31")).toBe(false);
  });

  it("adds days across month boundaries and rejects malformed dates", () => {
    expect(addDaysYmd("2026-01-31", 1)).toBe("2026-02-01");
    expect(() => addDaysYmd("2026-02-31", 1)).toThrow("Invalid YYYY-MM-DD date");
  });

  it("derives today's date from an explicit clock and timezone", () => {
    // 2026-04-21T01:30Z is 21:30 the previous day in EDT (UTC-4 in spring),
    // so the local date should be 2026-04-20.
    expect(todayYmd({
      now: new Date("2026-04-21T01:30:00.000Z"),
      timezone: "America/New_York",
    })).toBe("2026-04-20");
  });

  it("resolves horizon anchors with the documented lead times", () => {
    expect(resolveHorizonAnchor("2026-05")).toEqual({
      tag: "2026-05",
      anchorDate: "2026-05-01",
      leadDays: 28,
    });
    expect(resolveHorizonAnchor("2026-Q3")).toEqual({
      tag: "2026-Q3",
      anchorDate: "2026-07-01",
      leadDays: 45,
    });
    expect(resolveHorizonAnchor("2026 summer")).toEqual({
      tag: "2026 summer",
      anchorDate: "2026-06-01",
      leadDays: 60,
    });
    expect(resolveHorizonAnchor("undated")).toEqual({
      tag: "undated",
      anchorDate: null,
      leadDays: null,
    });
    expect(resolveHorizonAnchor("2026-Q5")).toBeNull();
  });

  it("derives review dates from anchors and clamps past dates to Source + 1 day", () => {
    expect(
      deriveReviewDate("2026-Q3", {
        sourceDate: "2026-04-19",
        today: "2026-04-20",
      }),
    ).toBe("2026-05-17");

    expect(
      deriveReviewDate("2026-05", {
        sourceDate: "2026-04-19",
        today: "2026-04-20",
      }),
    ).toBe("2026-04-20");
  });

  it("uses Source + 90 days for undated review dates", () => {
    expect(
      deriveReviewDate("undated", {
        sourceDate: "2026-04-19",
        today: "2026-04-20",
      }),
    ).toBe("2026-07-18");
  });

  it("rejects invalid review derivation inputs", () => {
    expect(() =>
      deriveReviewDate("2026-Q3", {
        sourceDate: "2026-02-31",
        today: "2026-04-20",
      }),
    ).toThrow("Invalid Source date");

    expect(() =>
      deriveReviewDate("soon", {
        sourceDate: "2026-04-19",
        today: "2026-04-20",
      }),
    ).toThrow("Invalid horizon tag");
  });

  it("bumps review cycles and caps undated entries at noreview after three reviews", () => {
    expect(
      bumpReviewCycle({
        horizonTag: "2026-Q3",
        review: "2026-05-17",
        reviewCount: 0,
      }),
    ).toEqual({ review: "2026-06-16", reviewCount: 1 });

    expect(
      bumpReviewCycle({
        horizonTag: "undated",
        review: "2026-07-18",
        reviewCount: 2,
      }),
    ).toEqual({ review: "[noreview]", reviewCount: 3 });

    expect(
      bumpReviewCycle({
        horizonTag: "undated",
        review: "[noreview]",
        reviewCount: 9,
      }),
    ).toEqual({ review: "[noreview]", reviewCount: 3 });

    expect(
      bumpReviewCycle({
        horizonTag: "2026-Q3",
        review: "2026-05-17",
        reviewCount: 3,
      }),
    ).toEqual({ review: "2026-06-16", reviewCount: 3 });

    expect(
      bumpReviewCycle({
        horizonTag: "undated",
        review: "2026-07-18",
        reviewCount: 0,
      }),
    ).toEqual({ review: "2026-10-16", reviewCount: 1 });
  });

  it("rejects invalid review cycle inputs", () => {
    expect(() =>
      bumpReviewCycle({
        horizonTag: "2026-Q3",
        review: "2026-02-31",
        reviewCount: 0,
      }),
    ).toThrow("Invalid Review date");

    expect(() =>
      bumpReviewCycle({
        horizonTag: "2026-Q3",
        review: "2026-05-17",
        reviewCount: 4,
      }),
    ).toThrow("Invalid ReviewCount");
  });

  it("normalizes missing Long-term Plans fields with dashboard source and derived review", () => {
    const result = normalizeLongTermPlanLine("- [2026-05] LA trip candidate", {
      today: "2026-04-19",
    });
    expect(result).toEqual({
      ok: true,
      line: "- [2026-05] LA trip candidate — Source: dashboard 2026-04-19 — Review: 2026-04-20 — ReviewCount: 0",
      changed: true,
      warning: "Long-term Plans entry normalized with missing schema fields",
    });
  });

  it("preserves Long-term Plans id comments while normalizing missing fields", () => {
    const result = normalizeLongTermPlanLine(
      "- [2026-05] LA trip candidate  <!-- id: rm-20260419-a3f1c2 -->",
      { today: "2026-04-19" },
    );
    expect(result).toEqual({
      ok: true,
      line: "- [2026-05] LA trip candidate — Source: dashboard 2026-04-19 — Review: 2026-04-20 — ReviewCount: 0  <!-- id: rm-20260419-a3f1c2 -->",
      changed: true,
      warning: "Long-term Plans entry normalized with missing schema fields",
    });
  });

  it("preserves canonical Long-term Plans lines unchanged", () => {
    const line = "- [2026-Q3] US study prep — Source: dm 2026-04-19 — Review: 2026-05-17 — ReviewCount: 0";
    expect(normalizeLongTermPlanLine(line)).toEqual({
      ok: true,
      line,
      changed: false,
    });
  });

  it("normalizes partially specified fields and preserves trailing markers", () => {
    const result = normalizeLongTermPlanLine(
      "- [undated] Wait for passport response — Source: mail 2026-04-19 — Review: [noreview] [awaiting-reply 2026-04-22]",
      { today: "2026-04-20" },
    );
    expect(result).toEqual({
      ok: true,
      line: "- [undated] Wait for passport response — Source: mail 2026-04-19 — Review: [noreview] — ReviewCount: 0 [awaiting-reply 2026-04-22]",
      changed: true,
      warning: "Long-term Plans entry normalized with missing schema fields",
    });
  });

  it("preserves an explicit ReviewCount while normalizing missing fields", () => {
    const result = normalizeLongTermPlanLine(
      "- [2026-Q3] US study prep — Source: observation 2026-04-19 — ReviewCount: 2",
      { today: "2026-04-20" },
    );
    expect(result).toEqual({
      ok: true,
      line: "- [2026-Q3] US study prep — Source: observation 2026-04-19 — Review: 2026-05-17 — ReviewCount: 2",
      changed: true,
      warning: "Long-term Plans entry normalized with missing schema fields",
    });
  });

  it("uses a supplied default source for new Long-term Plans entries", () => {
    const result = normalizeLongTermPlanLine("- [2026-Q4] Renew passport", {
      today: "2026-04-19",
      defaultSource: "manual",
    });
    expect(result).toMatchObject({
      ok: true,
      line: "- [2026-Q4] Renew passport — Source: manual 2026-04-19 — Review: 2026-08-17 — ReviewCount: 0",
    });
  });

  it("accepts blank lines without normalizing them", () => {
    expect(normalizeLongTermPlanLine("  ")).toEqual({
      ok: true,
      line: "  ",
      changed: false,
    });
  });

  it("rejects malformed Long-term Plans line shapes", () => {
    expect(normalizeLongTermPlanLine("not a bullet")).toEqual({
      ok: false,
      message: "Long-term Plans entries must be bullet lines beginning with `- [<horizon>]`",
    });
    expect(normalizeLongTermPlanLine("- [soon] Renew passport")).toEqual({
      ok: false,
      message: "Invalid horizon tag: soon",
    });
    expect(normalizeLongTermPlanLine("- [2026-05] \u00a0")).toEqual({
      ok: false,
      message: "Long-term Plans entry intent is empty",
    });
  });

  it("rejects malformed Long-term Plans schema fields individually", () => {
    expect(normalizeLongTermPlanLine(
      "- [2026-05] Renew passport — Source: unknown 2026-04-19",
    )).toEqual({
      ok: false,
      message: "Malformed Long-term Plans Source field",
    });
    expect(normalizeLongTermPlanLine(
      "- [2026-05] Renew passport — Review: tomorrow",
    )).toEqual({
      ok: false,
      message: "Malformed Long-term Plans Review field",
    });
    expect(normalizeLongTermPlanLine(
      "- [2026-05] Renew passport — ReviewCount: 4",
    )).toEqual({
      ok: false,
      message: "Malformed Long-term Plans ReviewCount field",
    });
  });

  it("rejects invalid dates in canonical and partially specified fields", () => {
    expect(normalizeLongTermPlanLine(
      "- [2026-Q3] US study prep — Source: dm 2026-02-31 — Review: 2026-05-17 — ReviewCount: 0",
    )).toEqual({
      ok: false,
      message: "Invalid Source date: 2026-02-31",
    });
    expect(normalizeLongTermPlanLine(
      "- [2026-Q3] US study prep — Source: dm 2026-04-19 — Review: 2026-02-31 — ReviewCount: 0",
    )).toEqual({
      ok: false,
      message: "Invalid Review date: 2026-02-31",
    });
    expect(normalizeLongTermPlanLine(
      "- [2026-05] Renew passport — Source: mail 2026-02-31",
    )).toEqual({
      ok: false,
      message: "Invalid Source date: 2026-02-31",
    });
    expect(normalizeLongTermPlanLine(
      "- [2026-05] Renew passport — Review: 2026-02-31",
      { today: "2026-04-19" },
    )).toEqual({
      ok: false,
      message: "Invalid Review date: 2026-02-31",
    });
  });

  it("rejects an invalid runtime default source defensively", () => {
    const result = normalizeLongTermPlanLine("- [2026-05] Renew passport", {
      today: "2026-04-19",
      defaultSource: "bogus" as LongTermPlanSource,
    });
    expect(result).toEqual({
      ok: false,
      message: "Invalid Long-term Plans Source: bogus",
    });
  });

  it("rejects parseable bullets with malformed trailing fields instead of dropping text", () => {
    const result = normalizeLongTermPlanLine(
      "- [2026-Q3] US study prep — Source: dm 2026-04-19 extra",
      { today: "2026-04-20" },
    );
    expect(result).toEqual({
      ok: false,
      message: "Malformed Long-term Plans schema fields",
    });
  });
});
