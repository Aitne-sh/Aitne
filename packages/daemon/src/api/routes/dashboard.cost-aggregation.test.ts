import { describe, it, expect } from "vitest";
import { aggregateByBilledModel } from "./dashboard/cost-approvals.js";

describe("aggregateByBilledModel", () => {
  it("falls back to model_used when model_usage_json is missing", () => {
    const result = aggregateByBilledModel([
      {
        model_used: "claude-opus-4-7",
        model_usage_json: null,
        cost_usd: 1.0,
      },
    ]);
    expect(result).toEqual([
      { model: "claude-opus-4-7", total_cost: 1.0, session_count: 1 },
    ]);
  });

  it("attributes cost to the actually-billed model from model_usage_json", () => {
    // Real example from the metrics-page bug report — the requested model is
    // claude-opus-4-7 but the SDK billed claude-opus-4-6[1m]. The chart must
    // show the cost under the model that actually ran, not the requested one.
    const result = aggregateByBilledModel([
      {
        model_used: "claude-opus-4-7",
        model_usage_json: JSON.stringify({
          "claude-opus-4-6[1m]": {
            inputTokens: 4,
            outputTokens: 858,
            costUsd: 0.055,
          },
        }),
        cost_usd: 0.055,
      },
    ]);
    expect(result).toEqual([
      { model: "claude-opus-4-6[1m]", total_cost: 0.055, session_count: 1 },
    ]);
  });

  it("splits a multi-model session across all billed models", () => {
    const result = aggregateByBilledModel([
      {
        model_used: "claude-opus-4-7",
        model_usage_json: JSON.stringify({
          "claude-opus-4-7": { costUsd: 2.0 },
          "claude-opus-4-6[1m]": { costUsd: 0.5 },
        }),
        cost_usd: 2.5,
      },
    ]);
    expect(result).toEqual([
      { model: "claude-opus-4-7", total_cost: 2.0, session_count: 1 },
      { model: "claude-opus-4-6[1m]", total_cost: 0.5, session_count: 1 },
    ]);
  });

  it("sums repeated bills across rows and sorts by total_cost desc", () => {
    const result = aggregateByBilledModel([
      {
        model_used: "claude-opus-4-7",
        model_usage_json: JSON.stringify({
          "claude-opus-4-7": { costUsd: 1.0 },
        }),
        cost_usd: 1.0,
      },
      {
        model_used: "claude-opus-4-7",
        model_usage_json: JSON.stringify({
          "claude-opus-4-6[1m]": { costUsd: 0.1 },
        }),
        cost_usd: 0.1,
      },
      {
        model_used: "claude-opus-4-7",
        model_usage_json: JSON.stringify({
          "claude-opus-4-7": { costUsd: 0.5 },
        }),
        cost_usd: 0.5,
      },
    ]);
    expect(result).toEqual([
      { model: "claude-opus-4-7", total_cost: 1.5, session_count: 2 },
      { model: "claude-opus-4-6[1m]", total_cost: 0.1, session_count: 1 },
    ]);
  });

  it("ignores malformed JSON and falls back to model_used", () => {
    const result = aggregateByBilledModel([
      {
        model_used: "claude-opus-4-7",
        model_usage_json: "{bad json",
        cost_usd: 1.0,
      },
    ]);
    expect(result).toEqual([
      { model: "claude-opus-4-7", total_cost: 1.0, session_count: 1 },
    ]);
  });

  it("treats empty model_usage_json object as no usage breakdown", () => {
    const result = aggregateByBilledModel([
      {
        model_used: "claude-opus-4-7",
        model_usage_json: "{}",
        cost_usd: 0.5,
      },
    ]);
    expect(result).toEqual([
      { model: "claude-opus-4-7", total_cost: 0.5, session_count: 1 },
    ]);
  });

  it("returns an empty array for no rows", () => {
    expect(aggregateByBilledModel([])).toEqual([]);
  });

  it("credits the SDK total_cost residual to model_used (server-side tool cost)", () => {
    // Real-world: a Claude session uses web_search. SDK reports
    // total_cost_usd = 1.10 but modelUsage[opus-4-7].costUSD = 1.00 — the
    // 0.10 residual is the web_search call. Without residual handling, that
    // 0.10 disappears from the model breakdown chart.
    const result = aggregateByBilledModel([
      {
        model_used: "claude-opus-4-7",
        model_usage_json: JSON.stringify({
          "claude-opus-4-7": { costUsd: 1.0 },
        }),
        cost_usd: 1.1,
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      model: "claude-opus-4-7",
      // 1.0 from per-model + 0.1 residual; residual goes to model_used.
      total_cost: expect.closeTo(1.1, 6) as unknown as number,
      // Single row touching opus-4-7 once — must remain 1, not 2, even
      // though we added cost twice.
      session_count: 1,
    });
  });

  it("credits residual to a separate bucket when model_used differs from billed", () => {
    // Requested opus-4-7, billed only opus-4-6[1m] for inference, plus
    // tool-use residual. The residual is "what would have been billed
    // against the requested model" — credit it to the requested bucket so
    // the chart still shows the requested model with non-zero spend.
    const result = aggregateByBilledModel([
      {
        model_used: "claude-opus-4-7",
        model_usage_json: JSON.stringify({
          "claude-opus-4-6[1m]": { costUsd: 0.5 },
        }),
        cost_usd: 0.6,
      },
    ]);
    expect(result).toEqual([
      { model: "claude-opus-4-6[1m]", total_cost: 0.5, session_count: 1 },
      {
        model: "claude-opus-4-7",
        total_cost: expect.closeTo(0.1, 6) as unknown as number,
        session_count: 1,
      },
    ]);
  });

  it("ignores sub-epsilon residuals (float-arithmetic noise)", () => {
    // Real-world rounding: SDK reports per-model 0.05547670 vs total
    // 0.05547675. residual = 5e-8, well below the 1e-6 epsilon — must NOT
    // create a second bucket against model_used. (Set sub-epsilon
    // explicitly; using equal numbers would yield residual = 0 and would
    // not exercise the threshold guard.)
    const result = aggregateByBilledModel([
      {
        model_used: "claude-opus-4-7",
        model_usage_json: JSON.stringify({
          "claude-opus-4-6[1m]": { costUsd: 0.0554767 },
        }),
        cost_usd: 0.05547675,
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.model).toBe("claude-opus-4-6[1m]");
  });
});
