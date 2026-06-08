import { describe, expect, it } from "vitest";

import {
  DEFAULT_EVICTION_WEIGHTS,
  enforceCaps,
  kindImportance,
  omittedMarker,
  recencyDecay,
  scoreLesson,
} from "./eviction-scorer.js";
import type { Lesson } from "./lesson-format.js";

const NOW = "2026-06-07T00:00:00Z";

function lesson(overrides: Partial<Lesson>): Lesson {
  return {
    date: "2026-06-01",
    text: "A lesson.",
    ev: 1,
    kind: "preference",
    src: "behavioral",
    conf: "low",
    last: "2026-06-01",
    provisional: false,
    ...overrides,
  };
}

describe("eviction-scorer", () => {
  describe("kindImportance", () => {
    it("ranks constraint > correction > do-more/do-less > preference", () => {
      expect(kindImportance("constraint")).toBe(4);
      expect(kindImportance("correction")).toBe(3);
      expect(kindImportance("do-more")).toBe(2);
      expect(kindImportance("do-less")).toBe(2);
      expect(kindImportance("preference")).toBe(1);
    });
  });

  describe("recencyDecay", () => {
    it("is 1 for a lesson reinforced today (age <= 0)", () => {
      expect(recencyDecay("2026-06-07", NOW)).toBe(1);
    });
    it("is 0.5 at one half-life", () => {
      // 2026-04-23 → 2026-06-07 is exactly 45 days.
      expect(recencyDecay("2026-04-23", NOW, 45)).toBeCloseTo(0.5, 6);
    });
    it("clamps a future last date to 1", () => {
      expect(recencyDecay("2026-07-01", NOW)).toBe(1);
    });
    it("returns 1 for an unparseable last or now (never penalise a quirk)", () => {
      expect(recencyDecay("garbage", NOW)).toBe(1);
      expect(recencyDecay("2026-06-07", "not-a-date")).toBe(1);
    });
    it("uses the default half-life when omitted", () => {
      expect(recencyDecay("2026-06-06", NOW)).toBeGreaterThan(0.9);
    });
  });

  describe("scoreLesson", () => {
    it("subtracts exactly the provisional penalty for a provisional lesson", () => {
      const active = lesson({ provisional: false });
      const prov = lesson({ provisional: true });
      expect(scoreLesson(active, NOW) - scoreLesson(prov, NOW)).toBeCloseTo(
        DEFAULT_EVICTION_WEIGHTS.provisionalPenalty,
        6,
      );
    });
    it("scores higher evidence + stronger kind above a weak lesson", () => {
      const strong = lesson({ ev: 10, kind: "constraint", last: "2026-06-07" });
      const weak = lesson({ ev: 1, kind: "preference", last: "2026-01-01" });
      expect(scoreLesson(strong, NOW)).toBeGreaterThan(scoreLesson(weak, NOW));
    });
  });

  it("omittedMarker renders the count", () => {
    expect(omittedMarker(3)).toBe(
      "- [...3 lower-signal lessons omitted — full history in feedback_signals]",
    );
  });

  describe("enforceCaps", () => {
    const opts = { scopeLabel: "agent" };

    it("keeps everything under both caps, sorted highest-score first", () => {
      const high = lesson({ text: "high", ev: 10, kind: "constraint" });
      const low = lesson({ text: "low", ev: 1, kind: "preference", last: "2026-01-01" });
      const plan = enforceCaps(
        [low, high],
        { maxBytes: 100_000, maxEntries: 40 },
        NOW,
        opts,
      );
      expect(plan.evicted).toEqual([]);
      expect(plan.omittedMarker).toBeNull();
      expect(plan.keep.map((l) => l.text)).toEqual(["high", "low"]);
      expect(plan.bytes).toBeGreaterThan(0);
    });

    it("enforces the entry cap, evicting the lowest-scored", () => {
      const a = lesson({ text: "a", ev: 10, kind: "constraint" });
      const b = lesson({ text: "b", ev: 3, kind: "do-more" });
      const c = lesson({ text: "c", ev: 1, kind: "preference", last: "2026-01-01" });
      const plan = enforceCaps(
        [a, b, c],
        { maxBytes: 100_000, maxEntries: 1 },
        NOW,
        opts,
      );
      expect(plan.keep.map((l) => l.text)).toEqual(["a"]);
      expect(plan.evicted.map((l) => l.text).sort()).toEqual(["b", "c"]);
      expect(plan.omittedMarker).toBe(omittedMarker(2));
    });

    it("enforces the byte cap, dropping lowest-scored until it fits", () => {
      const lessons = [
        lesson({ text: "aaaaaaaaaaaaaaaaaaaaaaaa", ev: 10, kind: "constraint" }),
        lesson({ text: "bbbbbbbbbbbbbbbbbbbbbbbb", ev: 3, kind: "do-more" }),
        lesson({
          text: "cccccccccccccccccccccccc",
          ev: 1,
          kind: "preference",
          last: "2026-01-01",
        }),
      ];
      const cap = { maxBytes: 200, maxEntries: 40 };
      const plan = enforceCaps(lessons, cap, NOW, opts);
      // Invariants: fits the cap, something was evicted, kept set is the
      // top-of-score prefix, and the marker reflects the evicted count.
      expect(plan.bytes).toBeLessThanOrEqual(cap.maxBytes);
      expect(plan.evicted.length).toBeGreaterThan(0);
      expect(plan.keep.length + plan.evicted.length).toBe(3);
      const byScoreDesc = [...lessons].sort(
        (x, y) => scoreLesson(y, NOW) - scoreLesson(x, NOW),
      );
      expect(plan.keep).toEqual(byScoreDesc.slice(0, plan.keep.length));
      expect(plan.omittedMarker).toBe(omittedMarker(plan.evicted.length));
    });

    it("evicts even a single lesson larger than the byte cap (loop terminates)", () => {
      const huge = lesson({ text: "x".repeat(500) });
      const plan = enforceCaps(
        [huge],
        { maxBytes: 1, maxEntries: 40 },
        NOW,
        opts,
      );
      expect(plan.keep).toEqual([]);
      expect(plan.evicted).toHaveLength(1);
      expect(plan.omittedMarker).toBe(omittedMarker(1));
    });

    it("dedupes near-duplicates (summing ev) before considering eviction", () => {
      const plan = enforceCaps(
        [
          lesson({ text: "Shorten the report", ev: 2 }),
          lesson({ text: "shorten the report!", ev: 3 }),
        ],
        { maxBytes: 100_000, maxEntries: 40 },
        NOW,
        opts,
      );
      expect(plan.keep).toHaveLength(1);
      expect(plan.keep[0].ev).toBe(5);
      expect(plan.evicted).toEqual([]);
    });
  });
});
