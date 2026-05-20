import { describe, it, expect } from "vitest";
import {
  isReloadTransition,
  reloadPatternKey,
} from "./reload-detector.js";

describe("isReloadTransition", () => {
  it("returns true when the low byte is 8 (PAGE_TRANSITION_RELOAD)", () => {
    expect(isReloadTransition(8)).toBe(true);
  });

  it("returns true when reload bit set with qualifiers", () => {
    // 0x40000008 — forward/back qualifier + reload core type
    expect(isReloadTransition(0x40000008)).toBe(true);
  });

  it("returns false for typed (1) transitions", () => {
    expect(isReloadTransition(1)).toBe(false);
  });

  it("returns false for link (0) transitions", () => {
    expect(isReloadTransition(0)).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isReloadTransition(null)).toBe(false);
    expect(isReloadTransition(undefined)).toBe(false);
  });
});

describe("reloadPatternKey", () => {
  it("returns host/first-segment for non-root paths", () => {
    expect(reloadPatternKey({ host: "claude.ai", path: "/settings/usage" })).toBe(
      "claude.ai/settings",
    );
  });

  it("returns host alone when path has no segments", () => {
    expect(reloadPatternKey({ host: "example.com", path: "/" })).toBe(
      "example.com",
    );
  });

  it("lowercases the first segment", () => {
    expect(reloadPatternKey({ host: "github.com", path: "/Anthropics" })).toBe(
      "github.com/anthropics",
    );
  });
});
