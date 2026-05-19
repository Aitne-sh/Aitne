import { describe, it, expect } from "vitest";
import {
  buildDelegatedToolPrompt,
  emptyCost,
  flattenToolResultContent,
  tryParseToolResult,
  withDurationMs,
} from "./delegated-tool-runtime.js";

describe("buildDelegatedToolPrompt", () => {
  it("includes the tool name and verbatim JSON args", () => {
    const out = buildDelegatedToolPrompt("gmail.search", { query: "from:me" });
    expect(out).toContain("`gmail.search`");
    expect(out).toContain('{"query":"from:me"}');
    expect(out).toContain("Return only the tool's raw result");
  });

  it("emits empty-object args when args are nullish", () => {
    expect(buildDelegatedToolPrompt("noop", null)).toContain("{}");
    expect(buildDelegatedToolPrompt("noop", undefined)).toContain("{}");
  });
});

describe("flattenToolResultContent", () => {
  it("returns string input unchanged", () => {
    expect(flattenToolResultContent("hello")).toBe("hello");
  });

  it("stringifies plain objects", () => {
    expect(flattenToolResultContent({ ok: true })).toBe('{"ok":true}');
  });

  it("falls back to String() when JSON.stringify throws (cyclic ref)", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const out = flattenToolResultContent(cyclic);
    expect(typeof out).toBe("string");
    expect(out).toBe(String(cyclic));
  });

  it("returns empty string for null/undefined", () => {
    expect(flattenToolResultContent(null)).toBe("");
    expect(flattenToolResultContent(undefined)).toBe("");
  });

  it("coerces other primitives via String()", () => {
    expect(flattenToolResultContent(42)).toBe("42");
    expect(flattenToolResultContent(true)).toBe("true");
  });

  it("joins string blocks with newlines", () => {
    expect(flattenToolResultContent(["a", "b"])).toBe("a\nb");
  });

  it("extracts text field from block-array entries", () => {
    expect(
      flattenToolResultContent([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
    ).toBe("first\nsecond");
  });

  it("stringifies non-text blocks via JSON", () => {
    expect(flattenToolResultContent([{ type: "image", url: "x" }])).toBe(
      '{"type":"image","url":"x"}',
    );
  });

  it("falls back to String() for cyclic blocks in array path", () => {
    const cyclic: Record<string, unknown> = { type: "weird" };
    cyclic.self = cyclic;
    const out = flattenToolResultContent([cyclic]);
    expect(out).toBe(String(cyclic));
  });

  it("ignores non-object/non-string array entries", () => {
    expect(flattenToolResultContent([null, undefined, 42, "ok"])).toBe("ok");
  });
});

describe("tryParseToolResult", () => {
  it("returns non-string input unchanged", () => {
    const obj = { already: "parsed" };
    expect(tryParseToolResult(obj)).toBe(obj);
  });

  it("parses JSON object strings", () => {
    expect(tryParseToolResult('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses JSON array strings", () => {
    expect(tryParseToolResult("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("handles whitespace-padded JSON", () => {
    expect(tryParseToolResult('  {"a":1}  ')).toEqual({ a: 1 });
  });

  it("returns raw string when JSON parse fails", () => {
    expect(tryParseToolResult("{not json")).toBe("{not json");
  });

  it("returns raw string for non-JSON-shaped strings", () => {
    expect(tryParseToolResult("plain text")).toBe("plain text");
  });

  it("returns raw string when length < 2", () => {
    expect(tryParseToolResult("{")).toBe("{");
    expect(tryParseToolResult("")).toBe("");
  });
});

describe("emptyCost", () => {
  it("returns all-zero cost block", () => {
    expect(emptyCost()).toEqual({
      tokensInput: 0,
      tokensOutput: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
      durationMs: 0,
      numTurns: 0,
    });
  });
});

describe("withDurationMs", () => {
  it("computes duration from start and now", () => {
    const out = withDurationMs(emptyCost(), 1000, () => 1500);
    expect(out.durationMs).toBe(500);
  });

  it("clamps negative duration to 0", () => {
    const out = withDurationMs(emptyCost(), 2000, () => 1000);
    expect(out.durationMs).toBe(0);
  });

  it("uses Date.now when no clock provided", () => {
    const before = Date.now();
    const out = withDurationMs(emptyCost(), before - 10);
    expect(out.durationMs).toBeGreaterThanOrEqual(10);
  });

  it("preserves other cost fields", () => {
    const cost = {
      tokensInput: 5,
      tokensOutput: 6,
      cacheCreationTokens: 7,
      cacheReadTokens: 8,
      costUsd: 0.01,
      durationMs: 999,
      numTurns: 1,
    };
    const out = withDurationMs(cost, 0, () => 100);
    expect(out).toEqual({ ...cost, durationMs: 100 });
  });
});
