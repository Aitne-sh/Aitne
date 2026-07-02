import { describe, expect, it } from "vitest";

import {
  buildRepromoteGuard,
  findContradictionSuspects,
  MAX_SUSPECTS,
  significantTokens,
} from "./lesson-contradiction.js";
import type { Lesson } from "./lesson-format.js";

function lesson(overrides: Partial<Lesson>): Lesson {
  return {
    date: "2026-06-01",
    text: "Include the budget section in the weekly report",
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

describe("significantTokens", () => {
  it("normalizes, drops short tokens and stopwords", () => {
    const tokens = significantTokens(
      "Always include the Budget-Section in your weekly report, because it matters!",
    );
    expect(tokens.has("budget")).toBe(true);
    expect(tokens.has("section")).toBe(true);
    expect(tokens.has("weekly")).toBe(true);
    expect(tokens.has("report")).toBe(true);
    // short tokens + stopwords out
    expect(tokens.has("the")).toBe(false);
    expect(tokens.has("in")).toBe(false);
    expect(tokens.has("always")).toBe(false);
    expect(tokens.has("because")).toBe(false);
    expect(tokens.has("your")).toBe(false);
  });
});

describe("findContradictionSuspects", () => {
  it("flags opposing do-more/do-less kinds on an overlapping topic (both directions)", () => {
    const suspects = findContradictionSuspects(
      { text: "Reduce budget section detail", kind: "do-less" },
      [lesson({ text: "Expand the budget section detail", kind: "do-more" })],
    );
    expect(suspects).toHaveLength(1);
    expect(suspects[0].index).toBe(0);
    expect(suspects[0].reason).toMatch(/^opposing-kind overlap=/);

    const reversed = findContradictionSuspects(
      { text: "Expand budget section detail", kind: "do-more" },
      [lesson({ text: "Reduce the budget section detail", kind: "do-less" })],
    );
    expect(reversed).toHaveLength(1);
    expect(reversed[0].reason).toMatch(/^opposing-kind overlap=/);

    // Same kinds (or a non-opposing pair) never fire the kind cue.
    const sameKind = findContradictionSuspects(
      { text: "Expand budget graphs", kind: "do-more" },
      [lesson({ text: "Expand budget tables", kind: "do-more" })],
    );
    expect(sameKind.every((s) => !s.reason.startsWith("opposing-kind"))).toBe(
      true,
    );
  });

  it("honours minOverlapTokens / maxSuspects overrides and index tie-breaks equal overlap", () => {
    const existing = [
      lesson({ text: "budget report cadence" }),
      lesson({ text: "budget report formatting" }),
    ];
    // Both overlap on exactly {budget, report} = 2 tokens; the default bar
    // (3) skips them, an override of 2 keeps both, and equal overlap
    // tie-breaks by ascending index.
    const suspects = findContradictionSuspects(
      { text: "budget report length" },
      existing,
      { minOverlapTokens: 2, maxSuspects: 1 },
    );
    expect(suspects).toHaveLength(1);
    expect(suspects[0].index).toBe(0);

    const both = findContradictionSuspects(
      { text: "budget report length" },
      existing,
      { minOverlapTokens: 2 },
    );
    expect(both.map((s) => s.index)).toEqual([0, 1]);
  });

  it("flags a negating candidate against an affirmative lesson", () => {
    const suspects = findContradictionSuspects(
      { text: "Stop including the budget section in reports", kind: "correction" },
      [lesson({ text: "Include the budget section in every report" })],
    );
    expect(suspects).toHaveLength(1);
    expect(suspects[0].reason).toMatch(/^negation overlap=/);
  });

  it("does not fire negation against another negated lesson", () => {
    const suspects = findContradictionSuspects(
      { text: "Never send the budget section attachment" },
      [lesson({ text: "Don't attach the budget section attachment" })],
    );
    // Both negate — not a contradiction cue; falls through to plain overlap.
    expect(suspects.every((s) => !s.reason.startsWith("negation"))).toBe(true);
  });

  it("flags plain token overlap at the >= 3 bar and not below", () => {
    const hit = findContradictionSuspects(
      { text: "Weekly budget report section formatting" },
      [lesson({ text: "Format the weekly budget report section tightly" })],
    );
    expect(hit).toHaveLength(1);
    expect(hit[0].reason).toMatch(/^token-overlap=/);

    const miss = findContradictionSuspects(
      { text: "Weekly standup cadence" },
      [lesson({ text: "Weekly budget report" })],
    );
    expect(miss).toHaveLength(0);
  });

  it("skips provisional lessons and returns [] for empty candidates", () => {
    expect(
      findContradictionSuspects(
        { text: "Stop including the budget section" },
        [
          lesson({
            text: "Include the budget section in reports",
            provisional: true,
          }),
        ],
      ),
    ).toHaveLength(0);
    expect(
      findContradictionSuspects({ text: "!!!" }, [lesson({})]),
    ).toHaveLength(0);
  });

  it("ignores lessons with zero overlap", () => {
    expect(
      findContradictionSuspects(
        { text: "Stop sending calendar conflict alerts" },
        [lesson({ text: "Prefer terse standup summaries" })],
      ),
    ).toHaveLength(0);
  });

  it("caps suspects at MAX_SUSPECTS ranked by overlap", () => {
    const existing = [
      lesson({ text: "budget report section weekly" }),
      lesson({ text: "budget report section weekly monthly quarterly" }),
      lesson({ text: "budget report section" }),
      lesson({ text: "budget report section weekly detailed" }),
    ];
    const suspects = findContradictionSuspects(
      { text: "budget report section weekly monthly quarterly detailed" },
      existing,
    );
    expect(suspects).toHaveLength(MAX_SUSPECTS);
    // Highest-overlap suspect first.
    expect(suspects[0].index).toBe(1);
  });
});

describe("buildRepromoteGuard", () => {
  const guard = buildRepromoteGuard({ guardCf: 0.6, threshold: 2 });

  it("allows re-promotion with no contradiction suspects", () => {
    expect(
      guard(lesson({ text: "Prefer terse standup summaries", ev: 2 }), [
        lesson({ text: "Include the budget section in reports", cf: 0.9 }),
      ]),
    ).toBe(true);
  });

  it("allows when the strongest suspect is below the guard cf", () => {
    expect(
      guard(
        lesson({ text: "Stop including the budget section", ev: 2 }),
        [lesson({ text: "Include the budget section in reports", cf: 0.4 })],
      ),
    ).toBe(true);
  });

  it("vetoes a contradicting re-promotion below the 1.5x bar", () => {
    // bar = 1.5 · 2 · 0.8 = 2.4 > ev 2 → veto
    expect(
      guard(
        lesson({ text: "Stop including the budget section", ev: 2 }),
        [lesson({ text: "Include the budget section in reports", cf: 0.8 })],
      ),
    ).toBe(false);
  });

  it("allows once evidence clears the bar", () => {
    // bar = 2.4, ev 3 ≥ 2.4 → allowed
    expect(
      guard(
        lesson({ text: "Stop including the budget section", ev: 3 }),
        [lesson({ text: "Include the budget section in reports", cf: 0.8 })],
      ),
    ).toBe(true);
  });
});
