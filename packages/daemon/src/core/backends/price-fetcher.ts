import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  BackendCostSource,
  BackendId,
  BackendModel,
  BackendUsage,
} from "@aitne/shared";
import type Database from "better-sqlite3";
import { readRuntimeState, writeRuntimeState } from "../../db/runtime-state.js";
import { estimateCostForUsage, findRegisteredModel } from "./model-registry.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PRICING_STATUS_KEY = "pricing_data_source_status";
const LITELLM_SOURCE_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

interface PriceCachePayload {
  fetchedAt: string;
  prices: Record<string, unknown>;
}

interface LiteLLMPriceEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  supports_prompt_caching?: boolean;
  max_input_tokens?: number;
  max_output_tokens?: number;
  input_cost_threshold_tokens?: number;
  input_cost_per_token_above_threshold?: number;
  output_cost_per_token_above_threshold?: number;
  cache_read_input_token_cost_above_threshold?: number;
  cache_creation_input_token_cost_above_threshold?: number;
}

interface StoredPricingStatus {
  lastAttemptAt?: string | null;
  lastError?: string | null;
}

interface PricingDataSourceStatus {
  source: "litellm" | "hardcoded";
  fetchedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  stale: boolean;
  sourceUrl: string;
}

interface EstimatedUsageCost {
  costSource: Exclude<BackendCostSource, "sdk">;
  costUsd: number;
}

export class PriceFetcher {
  readonly cachePath: string;
  readonly sourceUrl = LITELLM_SOURCE_URL;

  constructor(
    dataDir: string,
    private readonly db?: Database.Database,
  ) {
    this.cachePath = join(dataDir, "cache", "model-prices.json");
  }

  getStatus(): PricingDataSourceStatus {
    const cache = this.readCache();
    const persisted = this.db
      ? readRuntimeState<StoredPricingStatus>(this.db, PRICING_STATUS_KEY)
      : null;

    return {
      source: cache ? "litellm" : "hardcoded",
      fetchedAt: cache?.fetchedAt ?? null,
      lastAttemptAt: persisted?.lastAttemptAt ?? cache?.fetchedAt ?? null,
      lastError: persisted?.lastError ?? null,
      stale: cache ? Date.now() - Date.parse(cache.fetchedAt) > CACHE_TTL_MS : true,
      sourceUrl: this.sourceUrl,
    };
  }

  async refresh(): Promise<PricingDataSourceStatus> {
    const attemptedAt = new Date().toISOString();

    try {
      const response = await fetch(this.sourceUrl, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const json = await response.json();
      if (!json || typeof json !== "object" || Array.isArray(json)) {
        throw new Error("Invalid LiteLLM pricing payload");
      }

      this.writeCache({
        fetchedAt: attemptedAt,
        prices: json as Record<string, unknown>,
      });
      this.writeStatus({
        lastAttemptAt: attemptedAt,
        lastError: null,
      });
    } catch (error) {
      this.writeStatus({
        lastAttemptAt: attemptedAt,
        lastError: error instanceof Error ? error.message : "Unknown fetch error",
      });
    }

    return this.getStatus();
  }

  getPriceEntry(modelId: string): LiteLLMPriceEntry | null {
    const cache = this.readCache();
    if (!cache) {
      return null;
    }

    return normalizePriceEntry(cache.prices[modelId]);
  }

  estimateUsageCost(params: {
    backendId: BackendId;
    modelId: string;
    usage: BackendUsage;
    fallbackModel?: BackendModel;
  }): EstimatedUsageCost {
    const fallbackModel = params.fallbackModel
      ?? findRegisteredModel(params.backendId, params.modelId);
    const priceEntry = this.getPriceEntry(params.modelId);

    // Models flagged `pricingTrusted` use the registry as the authoritative
    // source — LiteLLM's community data is ignored for these. Used when
    // upstream is known to lag (e.g. newest Opus tier).
    if (fallbackModel?.pricingTrusted) {
      return {
        costSource: "hardcoded",
        costUsd: estimateCostForUsage(fallbackModel, params.usage),
      };
    }

    if (priceEntry) {
      const pricedModel = applyPriceEntry(
        fallbackModel ?? {
          backendId: params.backendId,
          modelId: params.modelId,
          label: params.modelId,
          displayName: params.modelId,
          tier: params.fallbackModel?.tier ?? "medium",
          available: true,
        },
        priceEntry,
      );

      return {
        costSource:
          fallbackModel && !isUsageFullyCoveredByPriceEntry(priceEntry, params.usage)
            ? "hardcoded"
            : "litellm",
        costUsd: estimateCostForUsage(pricedModel, params.usage),
      };
    }

    return {
      costSource: "hardcoded",
      costUsd: estimateCostForUsage(fallbackModel, params.usage),
    };
  }

  private readCache(): PriceCachePayload | null {
    if (!existsSync(this.cachePath)) {
      return null;
    }

    try {
      const raw = readFileSync(this.cachePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PriceCachePayload>;
      if (
        !parsed
        || typeof parsed !== "object"
        || typeof parsed.fetchedAt !== "string"
        || !parsed.prices
        || typeof parsed.prices !== "object"
        || Array.isArray(parsed.prices)
      ) {
        return null;
      }
      return {
        fetchedAt: parsed.fetchedAt,
        prices: parsed.prices as Record<string, unknown>,
      };
    } catch {
      return null;
    }
  }

  private writeCache(payload: PriceCachePayload): void {
    mkdirSync(dirname(this.cachePath), { recursive: true });
    writeFileSync(this.cachePath, JSON.stringify(payload, null, 2));
  }

  private writeStatus(status: StoredPricingStatus): void {
    if (!this.db) {
      return;
    }
    writeRuntimeState(this.db, PRICING_STATUS_KEY, status);
  }
}

function normalizePriceEntry(value: unknown): LiteLLMPriceEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const aboveThreshold = readAboveThresholdPricing(raw);

  const normalized = {
    input_cost_per_token: readOptionalNumber(raw.input_cost_per_token),
    output_cost_per_token: readOptionalNumber(raw.output_cost_per_token),
    cache_read_input_token_cost: readOptionalNumber(raw.cache_read_input_token_cost),
    cache_creation_input_token_cost: readOptionalNumber(raw.cache_creation_input_token_cost),
    supports_prompt_caching:
      typeof raw.supports_prompt_caching === "boolean"
        ? raw.supports_prompt_caching
        : undefined,
    max_input_tokens: readOptionalNumber(raw.max_input_tokens),
    max_output_tokens: readOptionalNumber(raw.max_output_tokens),
    ...aboveThreshold,
  };

  if (
    normalized.input_cost_per_token === undefined
    && normalized.output_cost_per_token === undefined
    && normalized.cache_read_input_token_cost === undefined
    && normalized.cache_creation_input_token_cost === undefined
    && normalized.input_cost_per_token_above_threshold === undefined
    && normalized.output_cost_per_token_above_threshold === undefined
    && normalized.cache_read_input_token_cost_above_threshold === undefined
    && normalized.cache_creation_input_token_cost_above_threshold === undefined
  ) {
    return null;
  }

  return normalized;
}

function readAboveThresholdPricing(raw: Record<string, unknown>): Pick<
  LiteLLMPriceEntry,
  | "input_cost_threshold_tokens"
  | "input_cost_per_token_above_threshold"
  | "output_cost_per_token_above_threshold"
  | "cache_read_input_token_cost_above_threshold"
  | "cache_creation_input_token_cost_above_threshold"
> {
  const result: Pick<
    LiteLLMPriceEntry,
    | "input_cost_threshold_tokens"
    | "input_cost_per_token_above_threshold"
    | "output_cost_per_token_above_threshold"
    | "cache_read_input_token_cost_above_threshold"
    | "cache_creation_input_token_cost_above_threshold"
  > = {};

  for (const [key, value] of Object.entries(raw)) {
    const match =
      /^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)_above_(\d+)k_tokens$/.exec(key);
    const price = readOptionalNumber(value);
    if (!match || price === undefined) {
      continue;
    }

    result.input_cost_threshold_tokens = Number.parseInt(match[2], 10) * 1000;
    if (match[1] === "input_cost_per_token") {
      result.input_cost_per_token_above_threshold = price;
    } else if (match[1] === "output_cost_per_token") {
      result.output_cost_per_token_above_threshold = price;
    } else if (match[1] === "cache_read_input_token_cost") {
      result.cache_read_input_token_cost_above_threshold = price;
    } else if (match[1] === "cache_creation_input_token_cost") {
      result.cache_creation_input_token_cost_above_threshold = price;
    }
  }

  return result;
}

function applyPriceEntry(model: BackendModel, entry: LiteLLMPriceEntry): BackendModel {
  return {
    ...model,
    supportsPromptCaching: entry.supports_prompt_caching ?? model.supportsPromptCaching,
    usdPer1kIn: perTokenToPer1k(entry.input_cost_per_token) ?? model.usdPer1kIn,
    usdPer1kOut: perTokenToPer1k(entry.output_cost_per_token) ?? model.usdPer1kOut,
    usdPer1kCacheRead:
      perTokenToPer1k(entry.cache_read_input_token_cost) ?? model.usdPer1kCacheRead,
    usdPer1kCacheCreate:
      perTokenToPer1k(entry.cache_creation_input_token_cost) ?? model.usdPer1kCacheCreate,
    inputCostThresholdTokens:
      entry.input_cost_threshold_tokens ?? model.inputCostThresholdTokens,
    usdPer1kInAboveThreshold:
      perTokenToPer1k(entry.input_cost_per_token_above_threshold)
      ?? model.usdPer1kInAboveThreshold,
    usdPer1kOutAboveThreshold:
      perTokenToPer1k(entry.output_cost_per_token_above_threshold)
      ?? model.usdPer1kOutAboveThreshold,
    usdPer1kCacheReadAboveThreshold:
      perTokenToPer1k(entry.cache_read_input_token_cost_above_threshold)
      ?? model.usdPer1kCacheReadAboveThreshold,
    usdPer1kCacheCreateAboveThreshold:
      perTokenToPer1k(entry.cache_creation_input_token_cost_above_threshold)
      ?? model.usdPer1kCacheCreateAboveThreshold,
    maxInputTokens: entry.max_input_tokens ?? model.maxInputTokens,
    maxOutputTokens: entry.max_output_tokens ?? model.maxOutputTokens,
  };
}

function perTokenToPer1k(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value * 1000;
}

function isUsageFullyCoveredByPriceEntry(
  entry: LiteLLMPriceEntry,
  usage: BackendUsage,
): boolean {
  if (usage.outputTokens > 0 && entry.output_cost_per_token === undefined) {
    return false;
  }
  if (usage.cacheReadInputTokens > 0 && entry.cache_read_input_token_cost === undefined) {
    return false;
  }
  if (usage.cacheCreationInputTokens > 0 && entry.cache_creation_input_token_cost === undefined) {
    return false;
  }
  const thresholdInputTokens =
    usage.inputTokens
    + usage.cacheReadInputTokens
    + usage.cacheCreationInputTokens;
  if (thresholdInputTokens <= 0) {
    return true;
  }

  if (usage.inputTokens > 0 && entry.input_cost_per_token === undefined) {
    return false;
  }
  if (
    entry.input_cost_threshold_tokens !== undefined
    && thresholdInputTokens > entry.input_cost_threshold_tokens
    && (
      (usage.inputTokens > 0 && entry.input_cost_per_token_above_threshold === undefined)
      || (usage.outputTokens > 0 && entry.output_cost_per_token_above_threshold === undefined)
      || (
        usage.cacheReadInputTokens > 0
        && entry.cache_read_input_token_cost_above_threshold === undefined
      )
      || (
        usage.cacheCreationInputTokens > 0
        && entry.cache_creation_input_token_cost_above_threshold === undefined
      )
    )
  ) {
    return false;
  }

  return true;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
