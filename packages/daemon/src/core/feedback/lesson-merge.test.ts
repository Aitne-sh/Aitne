import { describe, expect, it } from "vitest";

import { dedupeLessons, groupSignalsBySummary, normalizeSummary } from "./lesson-merge.js";
import type { Lesson } from "./lesson-format.js";

function lesson(overrides: Partial<Lesson>): Lesson {
  return {
    date: "2026-06-01",
    text: "Lead with blockers.",
    ev: 1,
    kind: "preference",
    src: "behavioral",
    conf: "low",
    cf: null,
    last: "2026-06-01",
    provisional: false,
    ...overrides,
  };
}

describe("lesson-merge", () => {
  describe("normalizeSummary", () => {
    it("lowercases, strips punctuation, and collapses whitespace", () => {
      expect(normalizeSummary("Keep the  Budget-Section!!!")).toBe(
        "keep the budget section",
      );
      expect(normalizeSummary("  Padded  ")).toBe("padded");
    });
    it("preserves unicode letters and digits", () => {
      expect(normalizeSummary("Café 24/7")).toBe("café 24 7");
    });
  });

  describe("groupSignalsBySummary", () => {
    it("groups by normalized summary, preserving first-seen order", () => {
      const groups = groupSignalsBySummary([
        { id: 1, summary: "Shorten the report" },
        { id: 2, summary: "Other thing" },
        { id: 3, summary: "shorten   the report!" },
      ]);
      expect(groups).toHaveLength(2);
      expect(groups[0].summary).toBe("Shorten the report");
      expect(groups[0].members.map((m) => m.id)).toEqual([1, 3]);
      expect(groups[1].members.map((m) => m.id)).toEqual([2]);
    });

    it("keeps empty-summary signals under a stable key (no id lost)", () => {
      const groups = groupSignalsBySummary([
        { id: 1, summary: "" },
        { id: 2, summary: "   " },
      ]);
      expect(groups).toHaveLength(1);
      expect(groups[0].key).toBe("");
      expect(groups[0].members.map((m) => m.id)).toEqual([1, 2]);
    });
  });

  describe("dedupeLessons", () => {
    it("leaves distinct lessons untouched", () => {
      const input = [lesson({ text: "A" }), lesson({ text: "B" })];
      expect(dedupeLessons(input)).toEqual(input);
    });

    it("merges duplicates: sums ev, keeps earliest date / latest last / max conf / constraint / active", () => {
      const merged = dedupeLessons([
        lesson({
          text: "Shorten the report",
          date: "2026-06-05",
          last: "2026-06-05",
          conf: "low",
          kind: "preference",
          ev: 1,
          provisional: true,
        }),
        lesson({
          text: "shorten the report!",
          date: "2026-06-01", // earlier → wins
          last: "2026-06-10", // later → wins
          conf: "high", // higher rank → wins
          kind: "constraint", // constraint → wins
          ev: 2,
          provisional: false, // active → result active
        }),
      ]);
      expect(merged).toHaveLength(1);
      expect(merged[0]).toMatchObject({
        date: "2026-06-01",
        last: "2026-06-10",
        conf: "high",
        kind: "constraint",
        ev: 3,
        provisional: false,
      });
    });

    it("does not regress fields when the duplicate is weaker (covers else branches)", () => {
      const merged = dedupeLessons([
        lesson({
          text: "Shorten the report",
          date: "2026-06-01",
          last: "2026-06-10",
          conf: "high",
          kind: "constraint",
          ev: 2,
          provisional: false,
        }),
        lesson({
          text: "Shorten the report",
          date: "2026-06-05", // later → no change
          last: "2026-06-02", // earlier → no change
          conf: "low", // lower → no change
          kind: "do-more", // non-constraint → constraint stays
          ev: 1,
          provisional: true,
        }),
      ]);
      expect(merged[0]).toMatchObject({
        date: "2026-06-01",
        last: "2026-06-10",
        conf: "high",
        kind: "constraint",
        ev: 3,
        provisional: false, // false && true = false
      });
    });

    it("keeps provisional only when every duplicate is provisional", () => {
      const merged = dedupeLessons([
        lesson({ text: "Maybe", provisional: true }),
        lesson({ text: "maybe", provisional: true }),
      ]);
      expect(merged[0].provisional).toBe(true);
    });

    it("merges cf as the max of persisted values; null never wins", () => {
      expect(
        dedupeLessons([
          lesson({ text: "Same", cf: 0.4 }),
          lesson({ text: "same", cf: 0.7 }),
        ])[0].cf,
      ).toBe(0.7);
      expect(
        dedupeLessons([
          lesson({ text: "Same", cf: 0.7 }),
          lesson({ text: "same", cf: 0.4 }),
        ])[0].cf,
      ).toBe(0.7);
      expect(
        dedupeLessons([
          lesson({ text: "Same", cf: null }),
          lesson({ text: "same", cf: 0.4 }),
        ])[0].cf,
      ).toBe(0.4);
      expect(
        dedupeLessons([
          lesson({ text: "Same", cf: 0.4 }),
          lesson({ text: "same", cf: null }),
        ])[0].cf,
      ).toBe(0.4);
    });
  });
});
