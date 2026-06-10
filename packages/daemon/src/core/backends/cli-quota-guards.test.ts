import { describe, expect, it, vi } from "vitest";
import {
  BackendDecisiveFailure,
  BackendQuotaError,
  type BackendQuotaSpend,
} from "../agent-core.js";
import type { PriceFetcher } from "./price-fetcher.js";
import {
  assertCostWithinMaxBudget,
  assertPromptCostWithinMaxBudget,
  classifyCliFailure,
  isMaxBudgetMessage,
  recoverCliFailureSpend,
} from "./cli-quota-guards.js";

describe("isMaxBudgetMessage", () => {
  it.each([
    "max budget exceeded",
    "Maximum budget hit",
    "max_budget_usd reject",
    "over the budget limit",
    "per-turn budget exceeded",
  ])("matches %j", (msg) => {
    expect(isMaxBudgetMessage(msg)).toBe(true);
  });

  it("does not match unrelated messages", () => {
    expect(isMaxBudgetMessage("connection reset by peer")).toBe(false);
  });
});

describe("assertCostWithinMaxBudget", () => {
  const base = {
    backendId: "codex" as const,
    label: "Codex",
    modelId: "gpt-x",
  };

  it("is a no-op when maxBudgetUsd is undefined", () => {
    expect(() =>
      assertCostWithinMaxBudget({ ...base, costUsd: 9_999, maxBudgetUsd: undefined }),
    ).not.toThrow();
  });

  it("is a no-op when cost is within budget", () => {
    expect(() =>
      assertCostWithinMaxBudget({ ...base, costUsd: 0.5, maxBudgetUsd: 1 }),
    ).not.toThrow();
  });

  it("throws BackendQuotaError with no spend when over budget and spend omitted", () => {
    let err: unknown;
    try {
      assertCostWithinMaxBudget({ ...base, costUsd: 2, maxBudgetUsd: 1 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BackendQuotaError);
    const quota = err as BackendQuotaError;
    expect(quota.backendId).toBe("codex");
    expect(quota.originalCode).toBe("max_budget_usd");
    expect(quota.spend).toBeNull();
    expect(quota.message).toContain("Codex estimated cost $2.0000");
    expect(quota.message).toContain("$1.00 for gpt-x");
  });

  it("attaches merged spend (modelId + costUsd) when over budget and spend provided", () => {
    const partialSpend: Omit<BackendQuotaSpend, "modelId" | "costUsd"> = {
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      numTurns: 3,
      durationMs: 1234,
      costSource: "hardcoded",
    };
    let err: unknown;
    try {
      assertCostWithinMaxBudget({
        ...base,
        costUsd: 4.2,
        maxBudgetUsd: 1,
        spend: partialSpend,
      });
    } catch (e) {
      err = e;
    }
    const quota = err as BackendQuotaError;
    expect(quota.spend).toEqual({
      ...partialSpend,
      modelId: "gpt-x",
      costUsd: 4.2,
    });
  });
});

describe("assertPromptCostWithinMaxBudget", () => {
  function fakePriceFetcher(costUsd: number): {
    fetcher: PriceFetcher;
    calls: unknown[];
  } {
    const calls: unknown[] = [];
    const fetcher = {
      estimateUsageCost: (params: unknown) => {
        calls.push(params);
        return { costUsd, costSource: "hardcoded" as const };
      },
    } as unknown as PriceFetcher;
    return { fetcher, calls };
  }

  it("is a no-op when maxBudgetUsd is undefined (does not even price)", () => {
    const { fetcher, calls } = fakePriceFetcher(100);
    expect(() =>
      assertPromptCostWithinMaxBudget({
        backendId: "gemini",
        label: "Gemini CLI",
        prompt: "hello",
        maxBudgetUsd: undefined,
        modelId: "gemini-x",
        priceFetcher: fetcher,
      }),
    ).not.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("is a no-op when estimated prompt cost is within budget", () => {
    const { fetcher, calls } = fakePriceFetcher(0.1);
    expect(() =>
      assertPromptCostWithinMaxBudget({
        backendId: "gemini",
        label: "Gemini CLI",
        prompt: "a longer prompt body",
        maxBudgetUsd: 1,
        modelId: "gemini-x",
        priceFetcher: fetcher,
      }),
    ).not.toThrow();
    // Priced with the estimated input-token usage envelope.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      backendId: "gemini",
      modelId: "gemini-x",
      usage: { outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    });
  });

  it("throws BackendQuotaError when estimated prompt cost exceeds budget", () => {
    const { fetcher } = fakePriceFetcher(5);
    let err: unknown;
    try {
      assertPromptCostWithinMaxBudget({
        backendId: "gemini",
        label: "Gemini CLI",
        prompt: "x",
        maxBudgetUsd: 1,
        modelId: "gemini-x",
        priceFetcher: fetcher,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BackendQuotaError);
    const quota = err as BackendQuotaError;
    expect(quota.originalCode).toBe("max_budget_usd");
    expect(quota.message).toContain("Gemini CLI estimated prompt cost $5.0000");
    expect(quota.message).toContain("$1.00 for gemini-x");
  });
});

describe("classifyCliFailure", () => {
  const base = {
    backendId: "codex" as const,
    rateLimitPattern: /rate limit|quota/i,
    authPattern: /unauthorized|login/i,
  };

  it("tags our own budget rejection as max_budget_usd", () => {
    const err = classifyCliFailure({ ...base, message: "per-turn budget exceeded" });
    expect(err).toBeInstanceOf(BackendQuotaError);
    expect((err as BackendQuotaError).originalCode).toBe("max_budget_usd");
  });

  it("tags rate-limit messages as rate_limited with an extracted reset hint", () => {
    const err = classifyCliFailure({
      ...base,
      message: "Quota exceeded. reset time 2026-05-15T03:00:00Z",
    });
    expect(err).toBeInstanceOf(BackendQuotaError);
    const quota = err as BackendQuotaError;
    expect(quota.originalCode).toBe("rate_limited");
    expect(quota.resetHint).toMatchObject({ hour: 3, minute: 0, timeZone: "UTC" });
  });

  it("tags rate-limit messages with a null reset hint when none is parseable", () => {
    const err = classifyCliFailure({ ...base, message: "rate limit hit" }) as BackendQuotaError;
    expect(err.originalCode).toBe("rate_limited");
    expect(err.resetHint).toBeNull();
  });

  it("returns an extraClassifier verdict ahead of the auth branch", () => {
    const extraClassifier = vi.fn(
      (message: string, backendId: "claude" | "codex" | "gemini" | "opencode") =>
        /denied by policy/i.test(message)
          ? new BackendDecisiveFailure(backendId, "policy_denied", new Error(message))
          : null,
    );
    // Message matches BOTH the policy regex and the auth regex ("login");
    // the pre-auth classifier must win.
    const err = classifyCliFailure({
      ...base,
      message: "denied by policy: login is not permitted",
      extraClassifier,
    });
    expect(err).toBeInstanceOf(BackendDecisiveFailure);
    expect((err as BackendDecisiveFailure).kind).toBe("policy_denied");
    expect(extraClassifier).toHaveBeenCalledWith(
      "denied by policy: login is not permitted",
      "codex",
    );
  });

  it("falls through to auth when the extraClassifier returns null", () => {
    const extraClassifier = vi.fn(() => null);
    const err = classifyCliFailure({
      ...base,
      message: "unauthorized request",
      extraClassifier,
    });
    expect((err as BackendDecisiveFailure).kind).toBe("auth");
    expect(extraClassifier).toHaveBeenCalled();
  });

  it("tags auth failures when no extraClassifier is supplied", () => {
    const err = classifyCliFailure({ ...base, message: "please login again" });
    expect((err as BackendDecisiveFailure).kind).toBe("auth");
  });

  it("tags timeout failures", () => {
    const err = classifyCliFailure({ ...base, message: "request timed out" });
    expect((err as BackendDecisiveFailure).kind).toBe("timeout");
  });

  it("tags everything else as other_non_retryable", () => {
    const err = classifyCliFailure({ ...base, message: "segfault in subprocess" });
    expect((err as BackendDecisiveFailure).kind).toBe("other_non_retryable");
  });
});

describe("classifyCliFailure — spend pass-through (PREPASS_COST_REDUCTION_PLAN.md N1)", () => {
  const base = {
    backendId: "codex" as const,
    rateLimitPattern: /rate limit|quota/i,
    authPattern: /unauthorized|login/i,
  };
  const spend: BackendQuotaSpend = {
    usage: {
      inputTokens: 1_000,
      outputTokens: 200,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    costUsd: 0.12,
    modelId: "gpt-x",
    numTurns: 3,
    durationMs: 9_000,
    costSource: "litellm",
  };

  it("attaches spend to max-budget quota errors", () => {
    const err = classifyCliFailure({ ...base, message: "max budget exceeded", spend });
    expect(err).toBeInstanceOf(BackendQuotaError);
    expect((err as BackendQuotaError).spend).toBe(spend);
  });

  it("attaches spend to rate-limit quota errors", () => {
    const err = classifyCliFailure({ ...base, message: "rate limit reached", spend });
    expect((err as BackendQuotaError).spend).toBe(spend);
  });

  it.each([
    ["auth", "unauthorized request"],
    ["timeout", "request timed out"],
    ["other_non_retryable", "segfault in subprocess"],
  ] as const)("attaches spend to %s decisive failures", (kind, message) => {
    const err = classifyCliFailure({ ...base, message, spend });
    expect(err).toBeInstanceOf(BackendDecisiveFailure);
    expect((err as BackendDecisiveFailure).kind).toBe(kind);
    expect((err as BackendDecisiveFailure).spend).toBe(spend);
  });

  it("defaults spend to null when not supplied", () => {
    const err = classifyCliFailure({ ...base, message: "segfault" });
    expect((err as BackendDecisiveFailure).spend).toBeNull();
  });
});

describe("recoverCliFailureSpend (PREPASS_COST_REDUCTION_PLAN.md N1)", () => {
  const priceFetcher = {
    estimateUsageCost: vi.fn(() => ({ costUsd: 0.05, costSource: "litellm" as const })),
  } as unknown as PriceFetcher;

  it("returns null when no usage was observed", () => {
    expect(
      recoverCliFailureSpend({
        backendId: "codex",
        priceFetcher,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        modelId: "gpt-x",
        numTurns: 0,
        durationMs: 1_000,
      }),
    ).toBeNull();
  });

  it("builds the spend payload from observed usage via the price fetcher", () => {
    const spend = recoverCliFailureSpend({
      backendId: "codex",
      priceFetcher,
      usage: {
        inputTokens: 5_000,
        outputTokens: 100,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      modelId: "gpt-x",
      numTurns: 4,
      durationMs: 30_000,
    });
    expect(spend).toMatchObject({
      costUsd: 0.05,
      modelId: "gpt-x",
      numTurns: 4,
      durationMs: 30_000,
      costSource: "litellm",
    });
    expect(spend?.usage.inputTokens).toBe(5_000);
  });

  it("floors numTurns at 1 and accepts cache-only usage", () => {
    const spend = recoverCliFailureSpend({
      backendId: "gemini",
      priceFetcher,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 8_000,
        cacheReadInputTokens: 0,
      },
      modelId: "gemini-3-flash",
      numTurns: 0,
      durationMs: 2_000,
    });
    expect(spend?.numTurns).toBe(1);
  });
});
