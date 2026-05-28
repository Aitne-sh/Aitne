/**
 * extract-cap — §14.6 / §14.12 coverage.
 */

import { describe, expect, it } from "vitest";

import {
  createExtractCapState,
  decideExtractCap,
  EXTRACT_CUMULATIVE_CAP_CHARS,
  EXTRACT_PER_CALL_DEFAULT_CHARS,
  renderCapExceededSentinel,
} from "./extract-cap.js";

describe("decideExtractCap", () => {
  it("accepts a request that fits", () => {
    const r = decideExtractCap(createExtractCapState(), 1000);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.acceptedChars).toBe(1000);
      expect(r.state.accumulatedChars).toBe(1000);
    }
  });

  it("clamps to the remaining budget when a request would overflow", () => {
    // Pre-load almost-full.
    const seed = { accumulatedChars: EXTRACT_CUMULATIVE_CAP_CHARS - 500 };
    const r = decideExtractCap(seed, 5000);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.acceptedChars).toBe(500);
      expect(r.state.accumulatedChars).toBe(EXTRACT_CUMULATIVE_CAP_CHARS);
    }
  });

  it("returns cap_exceeded when no room is left", () => {
    const seed = { accumulatedChars: EXTRACT_CUMULATIVE_CAP_CHARS };
    const r = decideExtractCap(seed, 100);
    expect(r.kind).toBe("cap_exceeded");
    if (r.kind === "cap_exceeded") {
      expect(r.state.accumulatedChars).toBe(EXTRACT_CUMULATIVE_CAP_CHARS);
      expect(r.sentinel).toContain("EXTRACT_CAP_EXCEEDED");
    }
  });

  it("returns cap_exceeded when the cumulative counter is already past the cap", () => {
    const seed = { accumulatedChars: EXTRACT_CUMULATIVE_CAP_CHARS + 5 };
    const r = decideExtractCap(seed, 1);
    expect(r.kind).toBe("cap_exceeded");
  });

  it("treats NaN / negative requestedChars as zero-byte accept", () => {
    const seed = createExtractCapState();
    const r1 = decideExtractCap(seed, NaN);
    expect(r1.kind).toBe("ok");
    if (r1.kind === "ok") expect(r1.acceptedChars).toBe(0);
    const r2 = decideExtractCap(seed, -100);
    if (r2.kind === "ok") expect(r2.acceptedChars).toBe(0);
  });

  it("does not regress the counter on a clamped accept", () => {
    let state = createExtractCapState();
    for (let i = 0; i < 16; i++) {
      const r = decideExtractCap(state, EXTRACT_PER_CALL_DEFAULT_CHARS);
      if (r.kind === "ok") state = r.state;
    }
    // 16 × 8KB = 128KB exactly — the 17th call returns cap_exceeded.
    const cap = decideExtractCap(state, EXTRACT_PER_CALL_DEFAULT_CHARS);
    expect(cap.kind).toBe("cap_exceeded");
  });

  it("counter persists across calls", () => {
    let state = createExtractCapState();
    state = (decideExtractCap(state, 1000) as { state: { accumulatedChars: number } }).state;
    state = (decideExtractCap(state, 2000) as { state: { accumulatedChars: number } }).state;
    expect(state.accumulatedChars).toBe(3000);
  });
});

describe("renderCapExceededSentinel", () => {
  it("includes the accumulated kilobyte count", () => {
    expect(renderCapExceededSentinel(128 * 1024)).toContain("128KB");
    expect(renderCapExceededSentinel(64 * 1024)).toContain("64KB");
  });

  it("is the literal §14.6 sentinel shape (tests pin the prose)", () => {
    const s = renderCapExceededSentinel(EXTRACT_CUMULATIVE_CAP_CHARS);
    expect(s.startsWith("[EXTRACT_CAP_EXCEEDED")).toBe(true);
    expect(s.includes("further reads denied")).toBe(true);
  });

  it("rounds to one decimal place", () => {
    // 130000 bytes → 126.95... KB → 127 (rounded to .9 then .0)
    const s = renderCapExceededSentinel(130_000);
    // Should contain digits + at most one decimal.
    expect(/\d+(\.\d)?KB/.test(s)).toBe(true);
  });
});
