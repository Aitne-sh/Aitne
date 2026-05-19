import { describe, it, expect } from "vitest";
import { selectAgentPlanRowForSchedule } from "./agent-schedule-plan-match.js";
import type { TodayAgentPlanRow } from "../../core/today-agent-plan.js";

// Pure-helper tests for the row-matching logic that POST /schedule and
// /schedule/batch use to back-link a scheduled row to its today.md Agent
// Plan entry. Design rationale: api-route-decomposition.md §5.5 — kept
// as a flat sibling so this can be unit-tested without going through Hono.
//
// `enrichAgentPlanTaskContext` itself is exercised in agent.test.ts via the
// route layer (it reads today.md from disk); the rules below stay focused
// on the pure selection logic.

function makeRow(overrides: Partial<TodayAgentPlanRow> = {}): TodayAgentPlanRow {
  return {
    line: 1,
    raw: "- [ ] 09:00 Send prep note [work] →DM",
    checked: false,
    time: "09:00",
    action: "Send prep note",
    category: "work",
    trigger: "DM",
    ...overrides,
  };
}

describe("selectAgentPlanRowForSchedule", () => {
  it("returns null when no rows are passed", () => {
    expect(selectAgentPlanRowForSchedule([], "anything", {})).toBeNull();
  });

  it("returns the only candidate when exactly one row is provided", () => {
    const row = makeRow();
    expect(selectAgentPlanRowForSchedule([row], "totally unrelated", {})).toBe(row);
  });

  it("returns the unique description match when multiple candidates differ in action", () => {
    const rows = [
      makeRow({ line: 1, action: "Send prep note" }),
      makeRow({ line: 2, action: "Review PR" }),
    ];
    expect(
      selectAgentPlanRowForSchedule(rows, "Review PR", {}),
    ).toBe(rows[1]);
  });

  it("returns null when description matches are ambiguous (>1 description match)", () => {
    const rows = [
      makeRow({ line: 1, action: "Send prep note" }),
      makeRow({ line: 2, action: "Send prep note" }),
    ];
    expect(selectAgentPlanRowForSchedule(rows, "Send prep note", {})).toBeNull();
  });

  it("narrows by trigger hint from taskContext.agentPlanTrigger", () => {
    const rows = [
      makeRow({ line: 1, action: "Send prep note", trigger: "DM" }),
      makeRow({ line: 2, action: "Send prep note", trigger: "wake" }),
    ];
    expect(
      selectAgentPlanRowForSchedule(rows, "Send prep note", {
        agentPlanTrigger: "wake",
      }),
    ).toBe(rows[1]);
  });

  it("falls back to taskContext.trigger when agentPlanTrigger is absent", () => {
    const rows = [
      makeRow({ line: 1, action: "x", trigger: "DM" }),
      makeRow({ line: 2, action: "x", trigger: "notify" }),
    ];
    expect(
      selectAgentPlanRowForSchedule(rows, "no-match", { trigger: "notify" }),
    ).toBe(rows[1]);
  });

  it("ignores trigger hint when filtering would empty the candidate set", () => {
    const rows = [
      makeRow({ line: 1, action: "Only candidate", trigger: "DM" }),
    ];
    // No row has trigger=wake; the helper must NOT zero out candidates.
    expect(
      selectAgentPlanRowForSchedule(rows, "Only candidate", {
        agentPlanTrigger: "wake",
      }),
    ).toBe(rows[0]);
  });

  it("narrows by category hint from taskContext.agentPlanCategory", () => {
    const rows = [
      makeRow({ line: 1, action: "x", category: "work" }),
      makeRow({ line: 2, action: "x", category: "study" }),
    ];
    expect(
      selectAgentPlanRowForSchedule(rows, "no-match", {
        agentPlanCategory: "study",
      }),
    ).toBe(rows[1]);
  });

  it("falls back to taskContext.category when agentPlanCategory is absent", () => {
    const rows = [
      makeRow({ line: 1, action: "x", category: "work" }),
      makeRow({ line: 2, action: "x", category: "home" }),
    ];
    expect(
      selectAgentPlanRowForSchedule(rows, "no-match", { category: "home" }),
    ).toBe(rows[1]);
  });

  it("ignores category hint when filtering would empty the candidate set", () => {
    const rows = [makeRow({ category: "work" })];
    expect(
      selectAgentPlanRowForSchedule(rows, "Send prep note", {
        agentPlanCategory: "study",
      }),
    ).toBe(rows[0]);
  });

  it("rejects non-enum trigger / category hints (treated as no hint)", () => {
    const rows = [
      makeRow({ line: 1, action: "x", trigger: "DM", category: "work" }),
      makeRow({ line: 2, action: "x", trigger: "wake", category: "study" }),
    ];
    // Bogus values should not narrow → both candidates survive → ambiguous → null.
    expect(
      selectAgentPlanRowForSchedule(rows, "no-match", {
        agentPlanTrigger: "bogus",
        agentPlanCategory: "bogus",
      }),
    ).toBeNull();
  });

  it("matches description case-insensitively after normalization", () => {
    const rows = [
      makeRow({ line: 1, action: "Send Prep Note" }),
      makeRow({ line: 2, action: "Review PR" }),
    ];
    expect(
      selectAgentPlanRowForSchedule(rows, "send  prep   note", {}),
    ).toBe(rows[0]);
  });

  it("matches when the row action is a substring of the schedule description", () => {
    const rows = [
      makeRow({ line: 1, action: "prep note" }),
      makeRow({ line: 2, action: "Review PR" }),
    ];
    expect(
      selectAgentPlanRowForSchedule(rows, "Send prep note for standup", {}),
    ).toBe(rows[0]);
  });

  it("returns null with multiple equally-ambiguous candidates after hint narrowing", () => {
    const rows = [
      makeRow({ line: 1, action: "alpha", trigger: "DM" }),
      makeRow({ line: 2, action: "beta",  trigger: "DM" }),
    ];
    expect(
      selectAgentPlanRowForSchedule(rows, "no-match", {
        agentPlanTrigger: "DM",
      }),
    ).toBeNull();
  });
});
