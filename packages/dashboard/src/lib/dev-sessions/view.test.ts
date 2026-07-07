import { describe, it, expect } from "vitest";
import {
  devStateBadgeVariant,
  devStateLabel,
  devLoopStateLabel,
  devReqStatusBadgeVariant,
  devPhaseLabel,
  reqSummary,
  formatCost,
  formatDevTime,
} from "./view.js";

describe("dev-sessions view helpers", () => {
  it("maps states to token-based badge variants", () => {
    expect(devStateBadgeVariant("interview")).toBe("blue");
    expect(devStateBadgeVariant("awaiting_approval")).toBe("purple");
    expect(devStateBadgeVariant("running")).toBe("amber");
    expect(devStateBadgeVariant("awaiting_user")).toBe("orange");
    expect(devStateBadgeVariant("done")).toBe("green");
    expect(devStateBadgeVariant("failed")).toBe("red");
    expect(devStateBadgeVariant("exited")).toBe("gray");
  });

  it("labels states and phases readably", () => {
    expect(devStateLabel("awaiting_user")).toBe("Awaiting decision");
    expect(devPhaseLabel("stop_eval")).toBe("Stop-eval");
  });

  it("humanizes the inner loop verdict", () => {
    expect(devLoopStateLabel("NEEDS_SPEC_DECISION")).toBe("NEEDS SPEC DECISION");
    expect(devLoopStateLabel(null)).toBeNull();
  });

  it("maps requirement status to a variant", () => {
    expect(devReqStatusBadgeVariant("met")).toBe("green");
    expect(devReqStatusBadgeVariant("regressed")).toBe("red");
    expect(devReqStatusBadgeVariant("at_risk")).toBe("orange");
    expect(devReqStatusBadgeVariant("unstarted")).toBe("gray");
  });

  it("summarizes REQ progress and cost", () => {
    expect(reqSummary(3, 5)).toBe("3/5 met");
    expect(formatCost(1.2)).toBe("$1.20");
    expect(formatCost(null)).toBe("—");
  });

  it("formats timestamps deterministically with injected now/tz", () => {
    const t = formatDevTime(1_700_000_000_000, {
      now: 1_700_000_600_000,
      locale: "en-US",
      timeZone: "UTC",
    });
    expect(t.absolute).toContain("2023");
    expect(t.relative).toContain("ago");
    expect(formatDevTime(null).absolute).toBe("—");
  });
});
