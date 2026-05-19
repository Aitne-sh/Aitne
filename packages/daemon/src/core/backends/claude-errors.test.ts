/**
 * Peer tests for `./claude-errors.ts` — pure error helpers split out of
 * `claude-code-core.ts` in Tier 1 of the file-split plan.
 *
 * These functions are also indirectly exercised by `claude-code-core.test.ts`
 * (since `ClaudeCodeCore` consumes them), but the parent test mostly
 * checks shape via the `Backend*Error` round-trip path. The Tier-2
 * `claude-auth` extraction reads the same `ErrorLike` type, so we lock
 * down the pure semantics here.
 */

import { describe, it, expect } from "vitest";

import {
  AgentTimeoutError,
  extractClaudeCodeQuotaResetHint,
  isClaudeCodeMaxBudgetError,
  isClaudeCodeQuotaError,
} from "./claude-errors.js";

describe("AgentTimeoutError", () => {
  it("carries the configured timeoutMs and a stable name", () => {
    const err = new AgentTimeoutError(120_000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AgentTimeoutError");
    expect(err.timeoutMs).toBe(120_000);
    expect(err.message).toContain("120000");
  });
});

describe("isClaudeCodeQuotaError", () => {
  it("detects HTTP 429 on Error-shaped errors", () => {
    const err = Object.assign(new Error("Too Many Requests"), { status: 429 });
    expect(isClaudeCodeQuotaError(err)).toBe(true);
  });

  it("detects 'rate' / 'quota' in the code field", () => {
    expect(
      isClaudeCodeQuotaError(Object.assign(new Error(""), { code: "rate_limited" })),
    ).toBe(true);
    expect(
      isClaudeCodeQuotaError(Object.assign(new Error(""), { code: "monthly_quota_reached" })),
    ).toBe(true);
  });

  it("detects 'rate' / 'quota' in the type field", () => {
    expect(
      isClaudeCodeQuotaError(Object.assign(new Error(""), { type: "rate_limit_exceeded" })),
    ).toBe(true);
  });

  it("detects rate-limit phrases in the message", () => {
    expect(isClaudeCodeQuotaError(new Error("Rate limit reached for your account"))).toBe(true);
    expect(isClaudeCodeQuotaError(new Error("You've hit your limit on Claude usage"))).toBe(true);
    expect(isClaudeCodeQuotaError(new Error("Too many requests, please wait"))).toBe(true);
  });

  it("returns false for non-quota Errors", () => {
    expect(isClaudeCodeQuotaError(new Error("ECONNREFUSED"))).toBe(false);
    expect(isClaudeCodeQuotaError(new Error("Internal server error"))).toBe(false);
  });

  it("returns false for non-Error inputs", () => {
    expect(isClaudeCodeQuotaError("Rate limit hit")).toBe(false);
    expect(isClaudeCodeQuotaError(null)).toBe(false);
    expect(isClaudeCodeQuotaError(42)).toBe(false);
  });
});

describe("isClaudeCodeMaxBudgetError", () => {
  it("matches 'max budget' phrasing in the message", () => {
    expect(isClaudeCodeMaxBudgetError(new Error("max budget exceeded"))).toBe(true);
    expect(isClaudeCodeMaxBudgetError(new Error("Maximum budget reached"))).toBe(true);
    expect(isClaudeCodeMaxBudgetError(new Error("per-turn budget exhausted"))).toBe(true);
  });

  it("matches the `max_budget_usd` config-key spelling", () => {
    expect(isClaudeCodeMaxBudgetError(new Error("max_budget_usd hit"))).toBe(true);
  });

  it("matches by code / type fields", () => {
    const errByCode = Object.assign(new Error(""), { code: "max_budget_usd" });
    expect(isClaudeCodeMaxBudgetError(errByCode)).toBe(true);
    // The type field is concatenated alongside message + code; a value
    // matching the regex there should also trigger.
    const errByType = Object.assign(new Error(""), { type: "max_budget_usd" });
    expect(isClaudeCodeMaxBudgetError(errByType)).toBe(true);
  });

  it("ignores non-string code/type fields (defensive narrowing)", () => {
    // Numeric code (Node EAI dial errors use numbers in some surfaces)
    // and array type should not be coerced into the regex haystack.
    expect(
      isClaudeCodeMaxBudgetError(Object.assign(new Error(""), { code: 42, type: [] })),
    ).toBe(false);
  });

  it("handles non-Error inputs (string fallback)", () => {
    expect(isClaudeCodeMaxBudgetError("max budget hit")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isClaudeCodeMaxBudgetError(new Error("rate limited"))).toBe(false);
    expect(isClaudeCodeMaxBudgetError(42)).toBe(false);
  });
});

describe("extractClaudeCodeQuotaResetHint", () => {
  it("extracts h:mm with am/pm and parses to 24-hour", () => {
    const hint = extractClaudeCodeQuotaResetHint(
      new Error("Rate limit hit — resets 9:30 am (US/Pacific)"),
    );
    expect(hint).not.toBeNull();
    expect(hint?.hour).toBe(9);
    expect(hint?.minute).toBe(30);
    expect(hint?.timeZone).toBe("US/Pacific");
  });

  it("handles hour-only (no minute)", () => {
    const hint = extractClaudeCodeQuotaResetHint(
      new Error("limits reset 3 pm"),
    );
    expect(hint?.hour).toBe(15);
    expect(hint?.minute).toBe(0);
  });

  it("converts pm correctly (1pm → 13, 12pm → 12)", () => {
    expect(extractClaudeCodeQuotaResetHint(new Error("reset 1 pm"))?.hour).toBe(13);
    expect(extractClaudeCodeQuotaResetHint(new Error("reset 12 pm"))?.hour).toBe(12);
  });

  it("converts am correctly (12am → 0)", () => {
    expect(extractClaudeCodeQuotaResetHint(new Error("reset 12 am"))?.hour).toBe(0);
  });

  it("returns null when no reset phrase is present", () => {
    expect(extractClaudeCodeQuotaResetHint(new Error("rate limited, retry later"))).toBeNull();
  });

  it("returns null for non-Error inputs", () => {
    expect(extractClaudeCodeQuotaResetHint("resets 9 am")).toBeNull();
    expect(extractClaudeCodeQuotaResetHint(null)).toBeNull();
  });

  it("captures the raw label text after 'resets'", () => {
    const hint = extractClaudeCodeQuotaResetHint(
      new Error("Limit hit — resets 9:00 am (UTC) so try again later"),
    );
    expect(hint?.rawLabel).toContain("9:00 am");
  });
});
