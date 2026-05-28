/**
 * extract-output — §5 / §14.6 / §14.12 coverage.
 */

import { describe, expect, it } from "vitest";

import {
  EXTRACT_CUMULATIVE_CAP_CHARS,
  EXTRACT_PER_CALL_DEFAULT_CHARS,
  createExtractCapState,
} from "./extract-cap.js";
import { buildExtractOutput } from "./extract-output.js";

describe("buildExtractOutput", () => {
  it("wraps the output in <external-content origin=...>...</external-content>", () => {
    const r = buildExtractOutput({
      rawText: "Hello, world",
      capState: createExtractCapState(),
      origin: "https://example.com/page",
    });
    expect(r.outcome).toBe("ok");
    expect(r.content).toMatch(/^<external-content origin="https:\/\/example.com\/page">/);
    expect(r.content).toContain("Hello, world");
    expect(r.content.endsWith("</external-content>")).toBe(true);
  });

  it("clamps to the per-call maxChars", () => {
    // Use prose with single-letter words so the long-token redactor
    // (`[A-Za-z0-9_-]{32,}` boundaries) doesn't eat the slice.
    const phrase = "a b c d e f g h ";
    const raw = phrase.repeat(2_000);
    const r = buildExtractOutput({
      rawText: raw,
      maxChars: 100,
      capState: createExtractCapState(),
      origin: "https://example.com/",
    });
    expect(r.outcome).toBe("ok");
    expect(r.acceptedChars).toBe(100);
    // Extract the body inside the wrapper and assert byte length.
    const m = r.content.match(/^<external-content [^>]*>([\s\S]*)<\/external-content>$/);
    expect(m).not.toBeNull();
    if (m) expect(m[1].length).toBe(100);
  });

  it("applies the cumulative cap on top of the per-call cap", () => {
    const seed = { accumulatedChars: EXTRACT_CUMULATIVE_CAP_CHARS - 30 };
    const r = buildExtractOutput({
      rawText: "y".repeat(EXTRACT_PER_CALL_DEFAULT_CHARS),
      capState: seed,
      origin: "https://example.com/",
    });
    expect(r.outcome).toBe("ok");
    expect(r.acceptedChars).toBe(30);
    expect(r.capState.accumulatedChars).toBe(EXTRACT_CUMULATIVE_CAP_CHARS);
  });

  it("returns the sentinel when no cumulative budget remains", () => {
    const seed = { accumulatedChars: EXTRACT_CUMULATIVE_CAP_CHARS };
    const r = buildExtractOutput({
      rawText: "z".repeat(100),
      capState: seed,
      origin: "https://example.com/",
    });
    expect(r.outcome).toBe("extract_cap_exceeded");
    expect(r.acceptedChars).toBe(0);
    expect(r.content).toContain("EXTRACT_CAP_EXCEEDED");
    expect(r.content).toMatch(/^<external-content origin=/);
  });

  it("redacts secret shapes before wrapping", () => {
    // 32+ char base64url-ish run.
    const secret = "abcdef1234567890ABCDEF1234567890XYZ";
    const r = buildExtractOutput({
      rawText: `prefix ${secret} suffix`,
      capState: createExtractCapState(),
      origin: "https://example.com/",
    });
    expect(r.outcome).toBe("ok");
    expect(r.content).toContain("[REDACTED]");
    expect(r.content).not.toContain(secret);
  });

  it("redacts a JWT shape", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
      + "."
      + "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ"
      + "."
      + "TJVA95OrM7E2cBab30RMHrHDcEfxjoYZgeFONFh7HgQ";
    const r = buildExtractOutput({
      rawText: jwt,
      capState: createExtractCapState(),
      origin: "https://example.com/",
    });
    expect(r.content).toContain("[REDACTED]");
    expect(r.content).not.toContain(jwt);
  });

  it("handles a non-string rawText defensively", () => {
    const r = buildExtractOutput({
      rawText: null as unknown as string,
      capState: createExtractCapState(),
      origin: "https://example.com/",
    });
    expect(r.outcome).toBe("ok");
    expect(r.acceptedChars).toBe(0);
  });

  it("supports a custom maxChars override", () => {
    const r = buildExtractOutput({
      rawText: "a".repeat(100),
      maxChars: 50,
      capState: createExtractCapState(),
      origin: "https://example.com/",
    });
    expect(r.acceptedChars).toBe(50);
  });
});
