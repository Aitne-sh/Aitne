import { describe, expect, it } from "vitest";
import { parseDays } from "./query-utils.js";

describe("parseDays", () => {
  it("parses a positive integer followed by 'd'", () => {
    expect(parseDays("7d")).toBe(7);
    expect(parseDays("1d")).toBe(1);
    expect(parseDays("365d")).toBe(365);
  });

  it("parses zero", () => {
    expect(parseDays("0d")).toBe(0);
  });

  it("returns null for inputs missing the 'd' suffix", () => {
    expect(parseDays("7")).toBeNull();
    expect(parseDays("")).toBeNull();
  });

  it("returns null for non-digit prefixes", () => {
    expect(parseDays("d")).toBeNull();
    expect(parseDays("-1d")).toBeNull();
    expect(parseDays("1.5d")).toBeNull();
    expect(parseDays("seven d")).toBeNull();
  });

  it("returns null for surrounding whitespace or trailing characters", () => {
    expect(parseDays(" 7d")).toBeNull();
    expect(parseDays("7d ")).toBeNull();
    expect(parseDays("7days")).toBeNull();
    expect(parseDays("7D")).toBeNull();
  });
});
