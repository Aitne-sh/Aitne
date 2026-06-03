import { describe, expect, it } from "vitest";
import {
  checkCronDrift,
  substituteCron,
  validateCronExpression,
} from "./cron-substitute.js";

describe("substituteCron", () => {
  it("substitutes a bare {dayBoundaryHour} with the live value", () => {
    expect(substituteCron("0 {dayBoundaryHour} * * *", { dayBoundaryHour: 4 })).toBe(
      "0 4 * * *",
    );
    expect(substituteCron("0 {dayBoundaryHour} * * *", { dayBoundaryHour: 0 })).toBe(
      "0 0 * * *",
    );
  });

  it("applies a negative offset, wrapping backward across midnight", () => {
    expect(substituteCron("50 {dayBoundaryHour-1} * * *", { dayBoundaryHour: 4 })).toBe(
      "50 3 * * *",
    );
    // 0 − 1 wraps to 23.
    expect(substituteCron("45 {dayBoundaryHour-1} * * *", { dayBoundaryHour: 0 })).toBe(
      "45 23 * * *",
    );
  });

  it("applies a positive offset, wrapping forward across midnight", () => {
    // 23 + 2 = 25 → wraps to 1.
    expect(substituteCron("0 {dayBoundaryHour+2} * * *", { dayBoundaryHour: 23 })).toBe(
      "0 1 * * *",
    );
  });

  it("leaves a placeholder-free expression unchanged", () => {
    expect(substituteCron("0 18 * * *", { dayBoundaryHour: 4 })).toBe("0 18 * * *");
    expect(substituteCron("0 19 * * 5", { dayBoundaryHour: 4 })).toBe("0 19 * * 5");
  });

  it("substitutes every placeholder occurrence in one expression", () => {
    expect(
      substituteCron("{dayBoundaryHour} {dayBoundaryHour-1} * * *", { dayBoundaryHour: 5 }),
    ).toBe("5 4 * * *");
  });

  it("leaves a malformed placeholder intact (surfaced later by validateCronExpression)", () => {
    // No digits after the sign → the optional offset group fails → no match.
    expect(substituteCron("50 {dayBoundaryHour-} * * *", { dayBoundaryHour: 4 })).toBe(
      "50 {dayBoundaryHour-} * * *",
    );
  });
});

describe("checkCronDrift", () => {
  it("returns null when the registry expression is null (runtime-window builtin)", () => {
    expect(checkCronDrift("0 4 * * *", null)).toBeNull();
  });

  it("returns null when the resolved expressions agree", () => {
    expect(checkCronDrift("0 4 * * *", "0 4 * * *")).toBeNull();
  });

  it("ignores cosmetic whitespace differences", () => {
    expect(checkCronDrift("0   4 * * *", " 0 4 * * * ")).toBeNull();
  });

  it("returns a warning describing the drift on mismatch", () => {
    const warning = checkCronDrift("0 4 * * *", "0 5 * * *");
    expect(warning).not.toBeNull();
    expect(warning).toContain("0 4 * * *");
    expect(warning).toContain("0 5 * * *");
  });
});

describe("validateCronExpression", () => {
  it("accepts a well-formed 5-field expression", () => {
    expect(validateCronExpression("0 4 * * *")).toBeNull();
  });

  it("accepts a well-formed 6-field (with-seconds) expression", () => {
    expect(validateCronExpression("0 0 4 * * *")).toBeNull();
  });

  it("flags an empty / whitespace-only expression", () => {
    expect(validateCronExpression("")).toBe("empty cron expression");
    expect(validateCronExpression("   ")).toBe("empty cron expression");
  });

  it("flags an unresolved placeholder (opening or closing brace)", () => {
    expect(validateCronExpression("50 {dayBoundaryHour-} * * *")).toContain(
      "unresolved placeholder",
    );
    // A stray closing brace with no opening brace still trips the check.
    expect(validateCronExpression("50 3} * * *")).toContain("unresolved placeholder");
  });

  it("flags a wrong field count", () => {
    expect(validateCronExpression("0 4 *")).toContain("must have 5 or 6 fields");
    expect(validateCronExpression("0 4 * * * * *")).toContain("must have 5 or 6 fields");
  });
});
