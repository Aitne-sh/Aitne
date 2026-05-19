import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../db/client.js";
import { applySchema } from "../../db/schema.js";
import { PriceFetcher } from "./price-fetcher.js";

describe("PriceFetcher", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-price-fetcher-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("reports hardcoded fallback when no LiteLLM cache exists", () => {
    const db = createTestDatabase();
    applySchema(db);

    const fetcher = new PriceFetcher(dataDir, db);
    const status = fetcher.getStatus();

    expect(status).toMatchObject({
      source: "hardcoded",
      fetchedAt: null,
      stale: true,
      lastError: null,
    });

    db.close();
  });

  it("refreshes pricing metadata from LiteLLM and persists the cache", async () => {
    const db = createTestDatabase();
    applySchema(db);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            "gpt-5.4": {
              input_cost_per_token: 0.0000025,
              output_cost_per_token: 0.000015,
            },
          }),
          { status: 200 },
        ),
      ),
    );

    const fetcher = new PriceFetcher(dataDir, db);
    const status = await fetcher.refresh();

    expect(status.source).toBe("litellm");
    expect(status.fetchedAt).not.toBeNull();
    expect(status.lastError).toBeNull();
    expect(existsSync(fetcher.cachePath)).toBe(true);

    db.close();
  });

  it("estimates usage cost from cached LiteLLM pricing when available", () => {
    const db = createTestDatabase();
    applySchema(db);

    const fetcher = new PriceFetcher(dataDir, db);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            "gpt-5.4-mini": {
              input_cost_per_token: 0.00000015,
              output_cost_per_token: 0.0000006,
            },
          }),
          { status: 200 },
        ),
      ),
    );

    return fetcher.refresh().then(() => {
      const estimated = fetcher.estimateUsageCost({
        backendId: "codex",
        modelId: "gpt-5.4-mini",
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      });

      expect(estimated.costSource).toBe("litellm");
      expect(estimated.costUsd).toBeCloseTo(0.00045, 6);
      db.close();
    });
  });

  it("applies cached above-threshold input and output pricing", () => {
    const db = createTestDatabase();
    applySchema(db);

    const fetcher = new PriceFetcher(dataDir, db);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            "gpt-5.4": {
              input_cost_per_token: 0.0000025,
              output_cost_per_token: 0.000015,
              input_cost_per_token_above_272k_tokens: 0.000005,
              output_cost_per_token_above_272k_tokens: 0.0000225,
            },
          }),
          { status: 200 },
        ),
      ),
    );

    return fetcher.refresh().then(() => {
      const estimated = fetcher.estimateUsageCost({
        backendId: "codex",
        modelId: "gpt-5.4",
        usage: {
          inputTokens: 300_000,
          outputTokens: 1_000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      });

      expect(estimated.costSource).toBe("litellm");
      expect(estimated.costUsd).toBeCloseTo(1.5225, 6);
      db.close();
    });
  });

  it("ignores LiteLLM cache for pricingTrusted models and uses the registry rate", () => {
    const db = createTestDatabase();
    applySchema(db);

    // Stub LiteLLM cache with deliberately-wrong (1/3 of registry) prices for
    // claude-opus-4-7 — the same drift seen in the upstream community data
    // that motivated `pricingTrusted`. Registry should win, so the estimate
    // must match the registry's $0.015/$0.075 per 1k rate, not 1/3 of it.
    const fetcher = new PriceFetcher(dataDir, db);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            "claude-opus-4-7": {
              input_cost_per_token: 0.000005,
              output_cost_per_token: 0.000025,
              cache_read_input_token_cost: 0.0000005,
              cache_creation_input_token_cost: 0.00000625,
            },
          }),
          { status: 200 },
        ),
      ),
    );

    return fetcher.refresh().then(() => {
      const estimated = fetcher.estimateUsageCost({
        backendId: "claude",
        modelId: "claude-opus-4-7",
        usage: {
          inputTokens: 1_000,
          outputTokens: 1_000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      });

      // Registry: 1k input * $0.015/1k + 1k output * $0.075/1k = $0.090
      // If LiteLLM had won we'd see ~$0.030 (1/3 the registry rate).
      expect(estimated.costSource).toBe("hardcoded");
      expect(estimated.costUsd).toBeCloseTo(0.09, 6);
      db.close();
    });
  });

  it("falls back to hardcoded provenance when the cached entry does not cover used dimensions", () => {
    const db = createTestDatabase();
    applySchema(db);

    const fetcher = new PriceFetcher(dataDir, db);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            "gpt-5.4-mini": {
              input_cost_per_token: 0.00000015,
            },
          }),
          { status: 200 },
        ),
      ),
    );

    return fetcher.refresh().then(() => {
      const estimated = fetcher.estimateUsageCost({
        backendId: "codex",
        modelId: "gpt-5.4-mini",
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      });

      expect(estimated.costSource).toBe("hardcoded");
      db.close();
    });
  });
});
