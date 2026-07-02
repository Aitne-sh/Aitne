import { describe, expect, it } from "vitest";

import {
  TUNING_CYCLE_HISTORY_CAP,
  TUNING_CYCLE_HISTORY_STATE_KEY,
  TUNING_GRADUATION_CYCLES,
  TUNING_GRADUATION_NOTIFIED_STATE_KEY,
  appendCycleToHistory,
  evaluateGraduation,
  parseCycleHistory,
  recordVerdictsInHistory,
  type TuningCycleHistoryEntry,
} from "./tuning-graduation.js";

function entry(
  over: Partial<TuningCycleHistoryEntry> = {},
): TuningCycleHistoryEntry {
  return {
    cycleId: "2026-06-09",
    generatedAt: "2026-06-09T05:00:00.000Z",
    recommendationCount: 2,
    verdicts: { apply: 0, reject: 0, defer: 0 },
    ...over,
  };
}

/** A fully-verdicted, ≥1-apply, 0-reject cycle. */
function qualifying(cycleId: string): TuningCycleHistoryEntry {
  return entry({
    cycleId,
    recommendationCount: 2,
    verdicts: { apply: 1, reject: 0, defer: 1 },
  });
}

/** A cycle the rules had nothing to say about — neither breaks nor extends. */
function neutral(cycleId: string): TuningCycleHistoryEntry {
  return entry({
    cycleId,
    recommendationCount: 0,
    verdicts: { apply: 0, reject: 0, defer: 0 },
  });
}

describe("tuning-graduation constants", () => {
  it("pins the state keys and bounds the design relies on", () => {
    expect(TUNING_GRADUATION_CYCLES).toBe(3);
    expect(TUNING_CYCLE_HISTORY_CAP).toBe(12);
    expect(TUNING_CYCLE_HISTORY_STATE_KEY).toBe("self_tuning.cycle_history");
    expect(TUNING_GRADUATION_NOTIFIED_STATE_KEY).toBe(
      "self_tuning.graduation_notified_at",
    );
    // Both keys must stay off the `self_tuning:` ledger prefix —
    // gatherLedger scans LIKE 'self_tuning:%'.
    expect(TUNING_CYCLE_HISTORY_STATE_KEY.startsWith("self_tuning:")).toBe(false);
    expect(
      TUNING_GRADUATION_NOTIFIED_STATE_KEY.startsWith("self_tuning:"),
    ).toBe(false);
  });
});

describe("appendCycleToHistory", () => {
  it("appends a new cycle without mutating the input", () => {
    const history = [qualifying("2026-06-02")];
    const next = appendCycleToHistory(history, entry({ cycleId: "2026-06-09" }));
    expect(next.map((e) => e.cycleId)).toEqual(["2026-06-02", "2026-06-09"]);
    expect(history).toHaveLength(1);
  });

  it("replaces an existing entry with the same cycleId in place (same-day re-run)", () => {
    const history = [
      qualifying("2026-06-02"),
      entry({ cycleId: "2026-06-09", recommendationCount: 3 }),
      neutral("2026-06-16"),
    ];
    const next = appendCycleToHistory(
      history,
      entry({ cycleId: "2026-06-09", recommendationCount: 1 }),
    );
    expect(next.map((e) => e.cycleId)).toEqual([
      "2026-06-02",
      "2026-06-09",
      "2026-06-16",
    ]);
    expect(next[1].recommendationCount).toBe(1);
  });

  it("caps at TUNING_CYCLE_HISTORY_CAP, dropping the oldest", () => {
    let history: TuningCycleHistoryEntry[] = [];
    for (let i = 1; i <= TUNING_CYCLE_HISTORY_CAP + 2; i++) {
      history = appendCycleToHistory(history, entry({ cycleId: `cycle-${i}` }));
    }
    expect(history).toHaveLength(TUNING_CYCLE_HISTORY_CAP);
    expect(history[0].cycleId).toBe("cycle-3");
    expect(history[history.length - 1].cycleId).toBe(
      `cycle-${TUNING_CYCLE_HISTORY_CAP + 2}`,
    );
  });

  it("trims an over-cap input blob even on a replace", () => {
    const oversized = Array.from({ length: TUNING_CYCLE_HISTORY_CAP + 3 }, (_, i) =>
      entry({ cycleId: `cycle-${i}` }),
    );
    const next = appendCycleToHistory(
      oversized,
      entry({ cycleId: `cycle-${TUNING_CYCLE_HISTORY_CAP + 2}` }),
    );
    expect(next).toHaveLength(TUNING_CYCLE_HISTORY_CAP);
  });
});

describe("recordVerdictsInHistory", () => {
  it("increments the matching cycle's tallies for each newly recorded verdict", () => {
    const history = [
      qualifying("2026-06-02"),
      entry({ cycleId: "2026-06-09", recommendationCount: 3 }),
    ];
    const next = recordVerdictsInHistory(history, "2026-06-09", [
      "apply",
      "defer",
      "reject",
    ]);
    expect(next[1].verdicts).toEqual({ apply: 1, reject: 1, defer: 1 });
    // Untouched sibling entry and input immutability.
    expect(next[0]).toEqual(history[0]);
    expect(history[1].verdicts).toEqual({ apply: 0, reject: 0, defer: 0 });
  });

  it("accumulates across successive calls (one POST per tally batch)", () => {
    const history = [entry({ cycleId: "2026-06-09", recommendationCount: 2 })];
    const next = recordVerdictsInHistory(
      recordVerdictsInHistory(history, "2026-06-09", ["apply"]),
      "2026-06-09",
      ["defer"],
    );
    expect(next[0].verdicts).toEqual({ apply: 1, reject: 0, defer: 1 });
  });

  it("returns the history unchanged for an unknown cycleId", () => {
    const history = [qualifying("2026-06-02")];
    const next = recordVerdictsInHistory(history, "2026-06-09", ["apply"]);
    expect(next).toEqual(history);
    expect(next).not.toBe(history); // still a fresh array
  });
});

describe("evaluateGraduation", () => {
  it("reports zero streak on an empty history", () => {
    expect(evaluateGraduation([])).toEqual({
      graduated: false,
      qualifyingStreak: 0,
    });
  });

  it("graduates at exactly TUNING_GRADUATION_CYCLES consecutive qualifying cycles", () => {
    const two = [qualifying("c1"), qualifying("c2")];
    expect(evaluateGraduation(two)).toEqual({
      graduated: false,
      qualifyingStreak: 2,
    });
    const three = [...two, qualifying("c3")];
    expect(evaluateGraduation(three)).toEqual({
      graduated: true,
      qualifyingStreak: 3,
    });
  });

  it("keeps counting past the bar (streak > required)", () => {
    const four = [
      qualifying("c1"),
      qualifying("c2"),
      qualifying("c3"),
      qualifying("c4"),
    ];
    expect(evaluateGraduation(four)).toEqual({
      graduated: true,
      qualifyingStreak: 4,
    });
  });

  it("a reject-bearing cycle stops the walk — the streak restarts after it", () => {
    const history = [
      qualifying("c1"),
      entry({
        cycleId: "c2",
        recommendationCount: 2,
        verdicts: { apply: 1, reject: 1, defer: 0 },
      }),
      qualifying("c3"),
      qualifying("c4"),
    ];
    expect(evaluateGraduation(history)).toEqual({
      graduated: false,
      qualifyingStreak: 2,
    });
  });

  it("an all-defer cycle does not qualify (no apply endorsement)", () => {
    const history = [
      qualifying("c1"),
      entry({
        cycleId: "c2",
        recommendationCount: 2,
        verdicts: { apply: 0, reject: 0, defer: 2 },
      }),
    ];
    expect(evaluateGraduation(history)).toEqual({
      graduated: false,
      qualifyingStreak: 0,
    });
  });

  it("a partially-verdicted cycle does not qualify", () => {
    const history = [
      entry({
        cycleId: "c1",
        recommendationCount: 3,
        verdicts: { apply: 1, reject: 0, defer: 1 }, // one verdict missing
      }),
    ];
    expect(evaluateGraduation(history)).toEqual({
      graduated: false,
      qualifyingStreak: 0,
    });
  });

  it("an over-tallied cycle degrades to non-qualifying (sum must equal count)", () => {
    const history = [
      entry({
        cycleId: "c1",
        recommendationCount: 1,
        verdicts: { apply: 2, reject: 0, defer: 0 },
      }),
    ];
    expect(evaluateGraduation(history)).toEqual({
      graduated: false,
      qualifyingStreak: 0,
    });
  });

  it("neutral zero-recommendation cycles are skipped, not counted either way", () => {
    const history = [
      qualifying("c1"),
      neutral("c2"),
      qualifying("c3"),
      neutral("c4"),
      qualifying("c5"),
    ];
    expect(evaluateGraduation(history)).toEqual({
      graduated: true,
      qualifyingStreak: 3,
    });
  });

  it("an all-neutral history has zero streak", () => {
    expect(evaluateGraduation([neutral("c1"), neutral("c2")])).toEqual({
      graduated: false,
      qualifyingStreak: 0,
    });
  });
});

describe("parseCycleHistory", () => {
  it("degrades every non-array blob to an empty history", () => {
    expect(parseCycleHistory(null)).toEqual([]);
    expect(parseCycleHistory(undefined)).toEqual([]);
    expect(parseCycleHistory("corrupt")).toEqual([]);
    expect(parseCycleHistory(42)).toEqual([]);
    expect(parseCycleHistory({ entries: [] })).toEqual([]);
  });

  it("keeps valid entries and drops malformed ones", () => {
    const good = entry({ cycleId: "2026-06-09" });
    const parsed = parseCycleHistory([
      good,
      null,
      "not-an-entry",
      ["array-entry"],
      { ...good, cycleId: 42 }, // cycleId not a string
      { ...good, generatedAt: null }, // generatedAt not a string
      { ...good, recommendationCount: "2" }, // count not a number
      { ...good, verdicts: null }, // tallies missing
      { ...good, verdicts: [1, 2, 3] }, // tallies not a record
      { ...good, verdicts: { apply: "1", reject: 0, defer: 0 } },
      { ...good, verdicts: { apply: 1, reject: null, defer: 0 } },
      { ...good, verdicts: { apply: 1, reject: 0 } }, // defer missing
    ]);
    expect(parsed).toEqual([good]);
  });

  it("round-trips a history the writers produced", () => {
    const history = [qualifying("c1"), neutral("c2")];
    expect(parseCycleHistory(JSON.parse(JSON.stringify(history)))).toEqual(
      history,
    );
  });
});
