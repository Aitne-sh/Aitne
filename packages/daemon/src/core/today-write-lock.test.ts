import { describe, expect, it } from "vitest";
import { getTodayWriteLockTimeoutMs } from "./today-write-lock.js";

describe("getTodayWriteLockTimeoutMs", () => {
  it("derives the lock timeout from execute timeout minutes", () => {
    expect(getTodayWriteLockTimeoutMs(15)).toBe((15 * 2 + 10) * 60 * 1000);
  });

  it("falls back to the default execute timeout when given NaN", () => {
    expect(getTodayWriteLockTimeoutMs(Number.NaN)).toBe((60 * 2 + 10) * 60 * 1000);
  });
});
