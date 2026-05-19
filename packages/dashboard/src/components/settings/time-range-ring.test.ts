import { describe, expect, it } from "vitest";
import {
  hourToAngle,
  angleToHour,
  arcPath,
  parseHHMM,
  formatHHMM,
  snap15,
  snapHour,
} from "./time-range-ring.js";

describe("parseHHMM", () => {
  it("parses whole hours", () => {
    expect(parseHHMM("00:00")).toBe(0);
    expect(parseHHMM("12:00")).toBe(12);
    expect(parseHHMM("23:00")).toBe(23);
  });

  it("parses fractional hours", () => {
    expect(parseHHMM("23:30")).toBe(23.5);
    expect(parseHHMM("06:15")).toBe(6.25);
    expect(parseHHMM("07:45")).toBe(7.75);
  });
});

describe("formatHHMM", () => {
  it("formats whole hours", () => {
    expect(formatHHMM(0)).toBe("00:00");
    expect(formatHHMM(12)).toBe("12:00");
    expect(formatHHMM(23)).toBe("23:00");
  });

  it("formats fractional hours", () => {
    expect(formatHHMM(23.5)).toBe("23:30");
    expect(formatHHMM(6.25)).toBe("06:15");
    expect(formatHHMM(7.75)).toBe("07:45");
  });

  it("wraps 24 to 00", () => {
    expect(formatHHMM(24)).toBe("00:00");
  });

  it("handles negative wrap", () => {
    // snap15 can produce values like -0.25 in edge cases near 0
    expect(formatHHMM(-0.25)).toBe("23:45");
  });

  it("round-trips with parseHHMM", () => {
    for (const t of ["00:00", "06:15", "12:30", "23:45"]) {
      expect(formatHHMM(parseHHMM(t))).toBe(t);
    }
  });
});

describe("snap15", () => {
  it("snaps to nearest 15 minutes", () => {
    expect(snap15(6.1)).toBe(6.0);
    expect(snap15(6.2)).toBe(6.25);
    expect(snap15(6.37)).toBe(6.25);
    expect(snap15(6.38)).toBe(6.5);
    expect(snap15(6.63)).toBe(6.75);
    expect(snap15(6.88)).toBe(7.0);
  });

  it("snaps 23.9 to 24.0", () => {
    expect(snap15(23.9)).toBe(24.0);
  });
});

describe("snapHour", () => {
  it("snaps to nearest whole hour", () => {
    expect(snapHour(6.3)).toBe(6);
    expect(snapHour(6.5)).toBe(7); // Math.round rounds up at .5
    expect(snapHour(6.7)).toBe(7);
  });

  it("wraps 24 to 0", () => {
    expect(snapHour(23.6)).toBe(0); // rounds to 24, % 24 = 0
  });
});

describe("hourToAngle / angleToHour", () => {
  it("0:00 maps to top (−π/2)", () => {
    expect(hourToAngle(0)).toBeCloseTo(-Math.PI / 2);
  });

  it("6:00 maps to right (0)", () => {
    expect(hourToAngle(6)).toBeCloseTo(0);
  });

  it("12:00 maps to bottom (π/2)", () => {
    expect(hourToAngle(12)).toBeCloseTo(Math.PI / 2);
  });

  it("18:00 maps to left (π or −π)", () => {
    expect(hourToAngle(18)).toBeCloseTo(Math.PI);
  });

  it("round-trips through angleToHour", () => {
    for (const h of [0, 3, 6, 9, 12, 15, 18, 21, 23.5]) {
      expect(angleToHour(hourToAngle(h))).toBeCloseTo(h);
    }
  });

  it("angleToHour always returns [0, 24)", () => {
    // Test various raw angles
    for (let a = -Math.PI * 2; a <= Math.PI * 2; a += 0.3) {
      const h = angleToHour(a);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(24);
    }
  });
});

describe("arcPath", () => {
  it("returns a valid SVG path string", () => {
    const p = arcPath(hourToAngle(4), hourToAngle(20), 90);
    expect(p).toMatch(/^M /);
    expect(p).toContain(" A ");
  });

  it("midnight wrap: 23:00 → 07:00 is 8 hours", () => {
    const startA = hourToAngle(23);
    const endA = hourToAngle(7);
    // Compute sweep the same way arcPath does
    let sweep = endA - startA;
    if (sweep <= 0) sweep += Math.PI * 2;
    const sweepHours = (sweep / (Math.PI * 2)) * 24;
    expect(sweepHours).toBeCloseTo(8);
  });

  it("full-day range (4→4) renders nearly a full circle", () => {
    const a = hourToAngle(4);
    // Same start and end → sweep becomes 2π (clamped to 2π−0.001)
    const p = arcPath(a, a, 90);
    expect(p).toContain(" A ");
    // The large-arc flag should be 1 for a near-full circle
    expect(p).toMatch(/A 90 90 0 1 1/);
  });

  it("activeStartHour=4 → activeEndHour=24 is 20 hours", () => {
    const startA = hourToAngle(4);
    const endA = hourToAngle(24 % 24); // 0
    let sweep = endA - startA;
    if (sweep <= 0) sweep += Math.PI * 2;
    const sweepHours = (sweep / (Math.PI * 2)) * 24;
    expect(sweepHours).toBeCloseTo(20);
  });
});
