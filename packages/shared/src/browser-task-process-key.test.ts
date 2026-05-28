/**
 * BROWSER_TASK_REDESIGN_PLAN.md §6.1 — ProcessKey + safety-floor +
 * presets coverage. The three pieces must move together; this peer
 * test pins them so a future drop of one without the others fails CI.
 */

import { describe, expect, it } from "vitest";

import {
  ALL_PROCESS_KEYS,
  CONFIGURABLE_PROCESS_KEYS,
  getDefaultTierForProcessKey,
  isConfigurableProcessKey,
  isProcessKey,
} from "./process-key.js";
import {
  BROWSER_HISTORY_PROCESS_KEYS,
  getBrowserHistorySafetyFloor,
} from "./integrations.js";

describe("browser_task ProcessKey wiring", () => {
  it("is configurable so /settings/models and applyDefaultPresets cover it", () => {
    expect(isConfigurableProcessKey("browser_task")).toBe(true);
  });

  it("is included in ALL_PROCESS_KEYS", () => {
    expect(ALL_PROCESS_KEYS.includes("browser_task" as never)).toBe(true);
  });

  it("isProcessKey returns true", () => {
    expect(isProcessKey("browser_task")).toBe(true);
  });

  it("defaults to medium tier", () => {
    expect(getDefaultTierForProcessKey("browser_task")).toBe("medium");
  });

  it("appears in CONFIGURABLE_PROCESS_KEYS exactly once", () => {
    const count = CONFIGURABLE_PROCESS_KEYS.filter((k) => k === "browser_task").length;
    expect(count).toBe(1);
  });
});

describe("browser_task safety floor", () => {
  it("is registered in BROWSER_HISTORY_PROCESS_KEYS", () => {
    expect(BROWSER_HISTORY_PROCESS_KEYS).toHaveProperty("browser_task");
  });

  it("is Claude-only — Codex / Gemini / opencode are NOT eligible", () => {
    const floor = getBrowserHistorySafetyFloor("browser_task");
    expect(floor).not.toBeNull();
    if (!floor) throw new Error("floor missing");
    expect(floor.eligible).toEqual(["claude"]);
  });

  it("carries a non-empty rationale", () => {
    const floor = getBrowserHistorySafetyFloor("browser_task");
    expect(floor?.rationale.length).toBeGreaterThan(0);
  });
});
