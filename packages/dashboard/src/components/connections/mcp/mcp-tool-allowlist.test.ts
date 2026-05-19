import { describe, it, expect } from "vitest";
import {
  deriveToolState,
  toggleToolAllowlist,
} from "./mcp-tool-allowlist";

describe("deriveToolState", () => {
  it("reports everything allowed when allowlist is null", () => {
    expect(deriveToolState(null, "any-tool")).toBe("allowed");
  });

  it("reports tool allowed when explicitly listed", () => {
    expect(deriveToolState(["a", "b"], "a")).toBe("allowed");
  });

  it("reports tool blocked when not in explicit list", () => {
    expect(deriveToolState(["a", "b"], "c")).toBe("blocked");
  });

  it("reports blocked when allowlist is empty", () => {
    expect(deriveToolState([], "a")).toBe("blocked");
  });
});

describe("toggleToolAllowlist", () => {
  const tools = ["a", "b", "c"];

  it("transitions null → [all-except-T] when disabling from implicit all", () => {
    expect(toggleToolAllowlist(null, "b", tools)).toEqual(["a", "c"]);
  });

  it("disables a tool from an explicit list", () => {
    expect(toggleToolAllowlist(["a", "b"], "b", tools)).toEqual(["a"]);
  });

  it("enables a tool from an explicit list (adds it in sort order)", () => {
    expect(toggleToolAllowlist(["a"], "c", tools)).toEqual(["a", "c"]);
  });

  it("normalizes back to null when enabling the final missing tool", () => {
    expect(toggleToolAllowlist(["a", "b"], "c", tools)).toBeNull();
  });

  it("drops to empty array when disabling the last allowed tool", () => {
    expect(toggleToolAllowlist(["a"], "a", tools)).toEqual([]);
  });

  it("keeps empty array when enabling from empty", () => {
    expect(toggleToolAllowlist([], "a", tools)).toEqual(["a"]);
  });

  it("ignores toggles for unknown tool names (returns input unchanged)", () => {
    expect(toggleToolAllowlist(["a"], "zzz", tools)).toEqual(["a"]);
    expect(toggleToolAllowlist(null, "zzz", tools)).toBeNull();
  });

  it("dedupes + drops stale entries when normalizing from null", () => {
    // Previous state had a stale tool from a renamed probe. Turning off 'b'
    // should not resurrect the stale tool in the new explicit array.
    const out = toggleToolAllowlist(null, "b", ["a", "b", "c", "a"]);
    expect(out).toEqual(["a", "c"]);
  });

  it("is idempotent across two opposite toggles", () => {
    const mid = toggleToolAllowlist(null, "b", tools); // ["a","c"]
    const back = toggleToolAllowlist(mid, "b", tools); // null
    expect(back).toBeNull();
  });
});
