import { describe, it, expect } from "vitest";
import {
  parseStage2Verdict,
  buildLogErrorContext,
} from "./dispatcher-types.js";
import {
  BackendQuotaError,
  BackendDecisiveFailure,
} from "./agent-core.js";
import { BackendRouterHandledError } from "./backends/backend-router.js";

describe("parseStage2Verdict", () => {
  it("returns 'failed' on empty input", () => {
    expect(parseStage2Verdict("")).toBe("failed");
    expect(parseStage2Verdict("   ")).toBe("failed");
    expect(parseStage2Verdict(undefined as unknown as string)).toBe("failed");
    expect(parseStage2Verdict(null as unknown as string)).toBe("failed");
  });

  it("returns 'failed' when no JSON object is present", () => {
    expect(parseStage2Verdict("not json at all")).toBe("failed");
  });

  it("returns 'failed' when the JSON object is malformed", () => {
    // Has braces so `objMatch` is non-null, but JSON.parse throws.
    expect(parseStage2Verdict("{ this is not: valid json }")).toBe("failed");
  });

  // The `!parsed || typeof parsed !== "object"` guard is `c8 ignore`d as
  // unreachable: the regex pre-filters to `\{...\}`, so JSON.parse either
  // throws (covered above) or returns a truthy object. Don't test it.

  it("returns 'failed' when action is missing or invalid", () => {
    expect(parseStage2Verdict('{"foo":"bar"}')).toBe("failed");
    expect(parseStage2Verdict('{"action":"halt"}')).toBe("failed");
  });

  it("returns 'log_only' / 'escalate' for valid verdicts", () => {
    expect(parseStage2Verdict('{"action":"log_only","reason":"noise"}')).toBe(
      "log_only",
    );
    expect(parseStage2Verdict('{"action":"escalate","reason":"vip"}')).toBe(
      "escalate",
    );
  });

  it("strips ```json fences before parsing", () => {
    expect(
      parseStage2Verdict('```json\n{"action":"log_only"}\n```'),
    ).toBe("log_only");
    expect(parseStage2Verdict('```\n{"action":"escalate"}\n```')).toBe(
      "escalate",
    );
  });

  it("matches the first JSON object even when prose follows", () => {
    expect(
      parseStage2Verdict('{"action":"log_only"} and some trailing prose'),
    ).toBe("log_only");
  });
});

describe("buildLogErrorContext", () => {
  it("returns just durationMs for unknown errors", () => {
    expect(buildLogErrorContext(new Error("boom"), 1234)).toEqual({
      durationMs: 1234,
    });
    expect(buildLogErrorContext("string thrown", 0)).toEqual({ durationMs: 0 });
  });

  it("extracts backendId, failureKind='quota', failureCode from a raw BackendQuotaError", () => {
    const err = new BackendQuotaError("claude", "rate_limit", null, "quota hit");
    expect(buildLogErrorContext(err, 200)).toEqual({
      durationMs: 200,
      backendId: "claude",
      failureKind: "quota",
      failureCode: "rate_limit",
    });
  });

  it("extracts backendId and failureKind from a raw BackendDecisiveFailure", () => {
    const err = new BackendDecisiveFailure("codex", "auth", new Error("401"));
    expect(buildLogErrorContext(err, 50)).toEqual({
      durationMs: 50,
      backendId: "codex",
      failureKind: "auth",
    });
  });

  it("unwraps a BackendRouterHandledError with a BackendQuotaError cause", () => {
    const cause = new BackendQuotaError(
      "claude",
      "tokens_exhausted",
      null,
      "tokens",
    );
    const err = new BackendRouterHandledError("router handled", cause, cause);
    expect(buildLogErrorContext(err, 99)).toEqual({
      durationMs: 99,
      backendId: "claude",
      failureKind: "quota",
      failureCode: "tokens_exhausted",
    });
  });

  it("unwraps a BackendRouterHandledError with a BackendDecisiveFailure cause", () => {
    const cause = new BackendDecisiveFailure(
      "gemini",
      "timeout",
      new Error("deadline"),
    );
    const err = new BackendRouterHandledError("router handled", cause, cause);
    expect(buildLogErrorContext(err, 1)).toEqual({
      durationMs: 1,
      backendId: "gemini",
      failureKind: "timeout",
    });
  });

  it("falls back to mainFailure.backendId when the cause is neither quota nor decisive", () => {
    // `cause` typed as BackendFailure at the API boundary, but the helper
    // defensively handles any other shape too — exercise the else branch.
    const mainFailure = new BackendDecisiveFailure(
      "claude",
      "other_non_retryable",
      new Error("x"),
    );
    const router = new BackendRouterHandledError(
      "router handled",
      // Pretend the cause is an oddball shape: only `backendId` exposed.
      { backendId: "codex" } as unknown as BackendDecisiveFailure,
      mainFailure,
    );
    // The cause's `backendId` is not used directly; the helper falls back
    // to mainFailure.backendId, and emits neither failureKind nor failureCode.
    expect(buildLogErrorContext(router, 7)).toEqual({
      durationMs: 7,
      backendId: "claude",
    });
  });
});
