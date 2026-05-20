import { describe, it, expect } from "vitest";
import {
  applyNoveltyFloor,
  parseSummarizerResponse,
  SUMMARY_MAX_CHARS,
} from "./response-parser.js";

describe("parseSummarizerResponse", () => {
  it("parses a strict JSON object with summary + novelty", () => {
    const result = parseSummarizerResponse('{"summary":"new TODO in today.md","novelty":2}');
    expect(result).toEqual({ ok: true, value: { summary: "new TODO in today.md", novelty: 2 } });
  });

  it("tolerates a leading sentence of preamble", () => {
    const raw = 'Here is the JSON: {"summary":"shipped a feature","novelty":1}';
    const result = parseSummarizerResponse(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.novelty).toBe(1);
  });

  it("tolerates markdown code fences around the JSON", () => {
    const raw = '```json\n{"summary":"meeting moved","novelty":2}\n```';
    const result = parseSummarizerResponse(raw);
    expect(result.ok).toBe(true);
  });

  it("rejects responses with no JSON object", () => {
    const result = parseSummarizerResponse("I don't know");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_json_object");
  });

  it("rejects unbalanced JSON braces as no_json_object", () => {
    const result = parseSummarizerResponse('{"summary":"oops","novelty":');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_json_object");
  });

  it("rejects malformed JSON inside balanced braces", () => {
    // Balanced braces but garbage content forces the JSON.parse path.
    const result = parseSummarizerResponse("{summary: not-json}");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_json");
  });

  it("rejects responses missing the summary field", () => {
    const result = parseSummarizerResponse('{"novelty":2}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_summary");
  });

  it("rejects responses missing the novelty field", () => {
    const result = parseSummarizerResponse('{"summary":"x"}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_novelty");
  });

  it("rejects out-of-range novelty values", () => {
    const result = parseSummarizerResponse('{"summary":"x","novelty":7}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_novelty");
  });

  it("coerces stringified novelty integers", () => {
    const result = parseSummarizerResponse('{"summary":"x","novelty":"2"}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.novelty).toBe(2);
  });

  it("clamps overlong summaries to SUMMARY_MAX_CHARS", () => {
    const long = "a".repeat(500);
    const result = parseSummarizerResponse(`{"summary":"${long}","novelty":0}`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.summary.length).toBe(SUMMARY_MAX_CHARS);
  });

  it("collapses internal whitespace in the summary", () => {
    const result = parseSummarizerResponse('{"summary":"a   b\\n\\nc","novelty":1}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.summary).toBe("a b c");
  });

  it("truncates rawSnippet to 200 chars on long inputs", () => {
    // Covers the true branch of `s.length > 200 ? slice + '...' : s` in
    // the `snippet()` helper. Use an oversize input that fails JSON.parse.
    const raw = "x".repeat(300);
    const result = parseSummarizerResponse(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rawSnippet.length).toBeLessThanOrEqual(203);
      expect(result.rawSnippet.endsWith("...")).toBe(true);
    }
  });
});

describe("applyNoveltyFloor", () => {
  it("raises novelty to the floor when below", () => {
    const out = applyNoveltyFloor({ summary: "x", novelty: 1 }, 3);
    expect(out.novelty).toBe(3);
  });

  it("leaves novelty unchanged when at or above the floor", () => {
    const at = applyNoveltyFloor({ summary: "x", novelty: 3 }, 3);
    expect(at.novelty).toBe(3);
    const above = applyNoveltyFloor({ summary: "x", novelty: 2 }, 1);
    expect(above.novelty).toBe(2);
  });

  it("is a no-op when no floor is supplied", () => {
    const out = applyNoveltyFloor({ summary: "x", novelty: 1 }, undefined);
    expect(out.novelty).toBe(1);
  });
});
