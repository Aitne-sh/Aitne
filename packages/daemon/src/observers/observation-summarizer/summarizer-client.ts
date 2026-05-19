/**
 * Backend-pluggable LLM client used by the observation summarizer.
 *
 * Today only Claude (Anthropic Messages API) is implemented. Codex and
 * Gemini fall back to `unsupported` — the worker translates that into a
 * `summary_status='skipped'` row so the hourly_check skill drops back to
 * the legacy fetch-on-doubt pattern. This keeps the summarizer optional
 * — non-Claude operators don't pay for it but also don't get the
 * downstream hourly_check savings until per-backend support lands.
 *
 * The client deliberately avoids the agent SDK's session machinery: a
 * one-shot summarizer with no tools doesn't need workdir + skills + MCP
 * materialization. A direct fetch keeps the per-call latency budget
 * tight (15 s in the worker) and the per-call cost dominated by the
 * tiny payload + 50-token output.
 */

import { redactSensitiveString } from "@aitne/shared";
import type { BackendId } from "@aitne/shared";
import { createLogger } from "../../logging.js";
import { APP_NAME } from "@aitne/shared";

const logger = createLogger("summarizer-client");

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";
const USER_AGENT = `${APP_NAME.toLowerCase().replace(/\s+/g, "-")}-summarizer/1.0`;

export interface SummarizerLlmRequest {
  systemPrompt: string;
  userMessage: string;
  /** Per-call wall clock cap. The worker enforces a 15 s default. */
  timeoutMs: number;
  /** Hard upper bound on output token count — the design budgets 50. */
  maxOutputTokens: number;
}

export interface SummarizerLlmResultOk {
  ok: true;
  rawText: string;
  modelId: string;
  /** Token totals used for telemetry only. Optional because providers vary. */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export type SummarizerLlmErrorClass =
  | "auth_missing"
  | "auth_invalid"
  | "rate_limited"
  | "timeout"
  | "network_error"
  | "unsupported_backend"
  | "bad_response"
  | "server_error";

export interface SummarizerLlmResultErr {
  ok: false;
  errorClass: SummarizerLlmErrorClass;
  message: string;
}

export type SummarizerLlmResult = SummarizerLlmResultOk | SummarizerLlmResultErr;

export interface SummarizerLlmClient {
  /** The (backend, model) pair as seeded in `process_backend_config`. */
  readonly backendId: BackendId;
  readonly modelId: string;
  call(request: SummarizerLlmRequest): Promise<SummarizerLlmResult>;
}

export interface AnthropicSummarizerClientOptions {
  modelId: string;
  /** Reads the API key on every call so a rotation in the keychain is honored without restart. */
  getApiKey: () => Promise<string | null>;
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Anthropic Messages API client tuned for summarization.
 *
 * - System prompt is sent as a `cache_control: { type: 'ephemeral' }` block so
 *   the per-source prefix gets the 5-min TTL cache after the first call.
 *   See https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching.
 * - No tools, no streaming — single response message, JSON parsed by caller.
 */
export class AnthropicSummarizerClient implements SummarizerLlmClient {
  readonly backendId: BackendId = "claude";
  readonly modelId: string;
  private readonly getApiKey: () => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicSummarizerClientOptions) {
    this.modelId = options.modelId;
    this.getApiKey = options.getApiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async call(request: SummarizerLlmRequest): Promise<SummarizerLlmResult> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      return { ok: false, errorClass: "auth_missing", message: "ANTHROPIC_API_KEY not configured for summarizer" };
    }

    const body = {
      model: this.modelId,
      max_tokens: request.maxOutputTokens,
      // Token caps are tiny — temperature 0 keeps the JSON shape stable.
      temperature: 0,
      system: [
        {
          type: "text",
          text: request.systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        { role: "user", content: request.userMessage },
      ],
    };

    let response: Response;
    try {
      response = await this.fetchImpl(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_API_VERSION,
          "content-type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(request.timeoutMs),
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : "unknown network error";
      const safe = redactSensitiveString(raw.replaceAll(apiKey, "[REDACTED]"));
      const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
      return {
        ok: false,
        errorClass: isTimeout ? "timeout" : "network_error",
        message: safe,
      };
    }

    if (!response.ok) {
      // Drain body for socket reuse + read structured error if present.
      const errText = await response.text().catch(() => "");
      const safeBody = redactSensitiveString(errText.replaceAll(apiKey, "[REDACTED]")).slice(0, 500);
      const cls = classifyAnthropicStatus(response.status);
      logger.debug(
        { status: response.status, errorClass: cls },
        "Anthropic summarizer call failed",
      );
      return {
        ok: false,
        errorClass: cls,
        message: `HTTP ${response.status}: ${safeBody}`,
      };
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      return { ok: false, errorClass: "bad_response", message: err instanceof Error ? err.message : "non-JSON response" };
    }

    const text = extractAnthropicText(json);
    if (text === null) {
      return { ok: false, errorClass: "bad_response", message: "no text content in Anthropic response" };
    }

    const usage = readAnthropicUsage(json);
    return {
      ok: true,
      rawText: text,
      modelId: this.modelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
    };
  }
}

/**
 * Stub used when the configured backend (Codex / Gemini) does not yet
 * have a summarizer implementation. The worker logs once and writes
 * `summary_status='skipped'`.
 */
export class UnsupportedSummarizerClient implements SummarizerLlmClient {
  constructor(public readonly backendId: BackendId, public readonly modelId: string) {}

  async call(): Promise<SummarizerLlmResult> {
    return {
      ok: false,
      errorClass: "unsupported_backend",
      message: `summarizer is not implemented for backend=${this.backendId}`,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function classifyAnthropicStatus(status: number): SummarizerLlmErrorClass {
  if (status === 401 || status === 403) return "auth_invalid";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "bad_response";
}

function extractAnthropicText(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const content = (json as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

function readAnthropicUsage(json: unknown): {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
} {
  if (!json || typeof json !== "object") return {};
  const usage = (json as Record<string, unknown>)["usage"];
  if (!usage || typeof usage !== "object") return {};
  const u = usage as Record<string, unknown>;
  return {
    inputTokens: numberOr(u["input_tokens"]),
    outputTokens: numberOr(u["output_tokens"]),
    cacheReadTokens: numberOr(u["cache_read_input_tokens"]),
    cacheCreationTokens: numberOr(u["cache_creation_input_tokens"]),
  };
}

function numberOr(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
