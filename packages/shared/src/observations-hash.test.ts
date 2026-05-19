import { describe, expect, it } from "vitest";
import { computeObservationHash } from "./observations-hash.js";

describe("computeObservationHash (INTEGRATION_NATIVE_MODE_DESIGN §8.3)", () => {
  it("returns a lowercase hex SHA-256 digest", () => {
    const hash = computeObservationHash("gmail", { threadId: "x" });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic across calls", () => {
    const a = computeObservationHash("gmail", { threadId: "x", subject: "y" });
    const b = computeObservationHash("gmail", { threadId: "x", subject: "y" });
    expect(a).toBe(b);
  });

  it("ignores object key insertion order (canonical stringify)", () => {
    const a = computeObservationHash("gmail", { a: 1, b: 2, c: 3 });
    const b = computeObservationHash("gmail", { c: 3, a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it("recurses into nested objects when comparing key order", () => {
    const a = computeObservationHash("notion", {
      page: { id: "abc", title: "T", props: { z: 1, a: 2 } },
    });
    const b = computeObservationHash("notion", {
      page: { props: { a: 2, z: 1 }, title: "T", id: "abc" },
    });
    expect(a).toBe(b);
  });

  it("treats arrays as ordered (different order → different hash)", () => {
    const a = computeObservationHash("gmail", { ids: ["a", "b", "c"] });
    const b = computeObservationHash("gmail", { ids: ["c", "b", "a"] });
    expect(a).not.toBe(b);
  });

  it("includes source in the hash (same payload, different source → different hash)", () => {
    const a = computeObservationHash("gmail", { id: "x" });
    const b = computeObservationHash("google_calendar", { id: "x" });
    expect(a).not.toBe(b);
  });

  it("drops undefined object properties (matches JSON.stringify semantics)", () => {
    const a = computeObservationHash("gmail", { id: "x", label: undefined });
    const b = computeObservationHash("gmail", { id: "x" });
    expect(a).toBe(b);
  });

  it("handles null and primitive payloads", () => {
    expect(computeObservationHash("git", null)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeObservationHash("git", 42)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeObservationHash("git", "literal")).toMatch(/^[0-9a-f]{64}$/);
    expect(computeObservationHash("git", true)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("distinguishes between null and the string 'null'", () => {
    const literalNull = computeObservationHash("git", null);
    const literalString = computeObservationHash("git", "null");
    expect(literalNull).not.toBe(literalString);
  });

  it("serialises undefined inside arrays as `null` (matches JSON.stringify semantics)", () => {
    // Arrays preserve order AND preserve `undefined` slots (unlike objects
    // where undefined properties are dropped). The canonical stringifier
    // funnels undefined through `JSON.stringify(undefined) ?? "null"` —
    // pin that fallback so the array hash matches the equivalent
    // null-explicit array.
    const withUndef = computeObservationHash("gmail", { ids: ["a", undefined, "b"] });
    const withNull = computeObservationHash("gmail", { ids: ["a", null, "b"] });
    expect(withUndef).toBe(withNull);
  });
});
