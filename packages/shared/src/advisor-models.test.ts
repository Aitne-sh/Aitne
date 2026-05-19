import { describe, expect, it } from "vitest";
import {
  ADVISOR_ALLOWED_MODELS,
  DEFAULT_ADVISOR_MODEL,
  isAdvisorModel,
} from "./advisor-models.js";

describe("ADVISOR_ALLOWED_MODELS", () => {
  it("pins the SDK 0.2.98 advisor allowlist (Sonnet/Opus 4.6)", () => {
    expect([...ADVISOR_ALLOWED_MODELS]).toEqual([
      "claude-sonnet-4-6",
      "claude-opus-4-6",
    ]);
  });

  it("uses the first entry as the canonical default", () => {
    expect(DEFAULT_ADVISOR_MODEL).toBe(ADVISOR_ALLOWED_MODELS[0]);
  });
});

describe("isAdvisorModel", () => {
  it("accepts every entry in the allowlist", () => {
    for (const id of ADVISOR_ALLOWED_MODELS) {
      expect(isAdvisorModel(id)).toBe(true);
    }
  });

  it("rejects strings that are not in the allowlist", () => {
    expect(isAdvisorModel("claude-opus-4-7")).toBe(false);
    expect(isAdvisorModel("")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isAdvisorModel(null)).toBe(false);
    expect(isAdvisorModel(undefined)).toBe(false);
    expect(isAdvisorModel(42)).toBe(false);
    expect(isAdvisorModel({})).toBe(false);
  });
});
