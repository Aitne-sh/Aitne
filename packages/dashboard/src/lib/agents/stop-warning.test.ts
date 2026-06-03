import { describe, expect, it } from "vitest";
import { buildStopWarningView } from "./stop-warning";
import type { StopWarning } from "./types";

describe("buildStopWarningView", () => {
  it("returns null for a missing warning", () => {
    expect(buildStopWarningView(null)).toBeNull();
    expect(buildStopWarningView(undefined)).toBeNull();
  });

  it("maps a critical warning to the destructive tone and surfaces the payload verbatim", () => {
    const warning: StopWarning = {
      level: "critical",
      services_lost: ["Daily state/today.md regeneration", "Morning DM digest"],
      dependent_agents: ["evening-review", "weekly-review"],
      reactivation_hint: "Re-enable from /agents/morning-routine.",
    };
    const view = buildStopWarningView(warning);
    expect(view).toEqual({
      level: "critical",
      levelLabel: "CRITICAL",
      tone: "destructive",
      servicesLost: ["Daily state/today.md regeneration", "Morning DM digest"],
      dependentAgents: ["evening-review", "weekly-review"],
      reactivationHint: "Re-enable from /agents/morning-routine.",
    });
  });

  it("maps high to destructive and normal to warning", () => {
    expect(buildStopWarningView({ level: "high", services_lost: ["x"], dependent_agents: [] })?.tone).toBe(
      "destructive",
    );
    expect(buildStopWarningView({ level: "normal", services_lost: ["x"], dependent_agents: [] })?.tone).toBe(
      "warning",
    );
  });

  it("drops blank service / dependent entries and an empty hint", () => {
    const view = buildStopWarningView({
      level: "normal",
      services_lost: ["real", "   "],
      dependent_agents: ["  ", "dep"],
      reactivation_hint: "   ",
    });
    expect(view?.servicesLost).toEqual(["real"]);
    expect(view?.dependentAgents).toEqual(["dep"]);
    expect(view?.reactivationHint).toBeNull();
  });

  it("handles a missing dependent_agents array", () => {
    const view = buildStopWarningView({
      level: "high",
      services_lost: ["x"],
    } as StopWarning);
    expect(view?.dependentAgents).toEqual([]);
    expect(view?.reactivationHint).toBeNull();
  });
});
