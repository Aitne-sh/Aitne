/**
 * Server-side API key verification via provider model-listing endpoints.
 *
 * Replaces the format-only check in each backend's `checkAuthDetailed()` API
 * key branch with a real HTTP call to the provider. The response tells us
 * whether the key is valid (`ok`), revoked/invalid (`unauthorized`), or
 * unreachable (`network_error`).
 *
 * **Design constraints** (roadmap §9.1):
 *  - 5 s timeout per request (`AbortSignal.timeout`).
 *  - Branded User-Agent on every request (Anthropic rate-limits empty UA —
 *    observed in Phase 0 §0-3). Brand tracks APP_NAME for rebrand cleanliness.
 *  - The API key MUST NOT appear in any log output. Callers that log the
 *    returned `detail` must run it through `redactSensitiveString` first
 *    (enforced by the existing `writeAuth*Detail` wrappers).
 *  - Network errors (DNS failure, timeout, ECONNRESET) throw so that
 *    `checkAll()` catches them and records `probe_network_error` telemetry
 *    without flipping the DB cache.
 */

import { APP_NAME } from "@aitne/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApiKeyProbeResult = {
  ok: boolean;
  /** Human-readable detail for DB `auth_detail`. */
  detail: string;
};

export type ApiKeyProvider = "anthropic" | "openai" | "google";

// ---------------------------------------------------------------------------
// Per-provider endpoint config
// ---------------------------------------------------------------------------

const PROBE_TIMEOUT_MS = 5_000;
// Lowercase, daemon-suffix form for HTTP User-Agent. The brand part is taken
// from APP_NAME so a rebrand surfaces in provider-side telemetry too. Spaces
// in APP_NAME are stripped (HTTP UA convention is single-token).
const USER_AGENT = `${APP_NAME.toLowerCase().replace(/\s+/g, "-")}-daemon/1.0`;

interface ProviderProbeConfig {
  /** Full URL (may contain the key as a query param for Google). */
  url: (key: string) => string;
  /** Headers to send. Key is substituted at call time. */
  headers: (key: string) => Record<string, string>;
  /** Human-readable provider name for detail messages. */
  label: string;
}

const PROVIDER_CONFIG: Record<ApiKeyProvider, ProviderProbeConfig> = {
  anthropic: {
    url: () => "https://api.anthropic.com/v1/models",
    headers: (key) => ({
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "User-Agent": USER_AGENT,
    }),
    label: "Anthropic",
  },
  openai: {
    url: () => "https://api.openai.com/v1/models",
    headers: (key) => ({
      Authorization: `Bearer ${key}`,
      "User-Agent": USER_AGENT,
    }),
    label: "OpenAI",
  },
  google: {
    // Google puts the key in the query string, not a header.
    url: (key) =>
      `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
    headers: () => ({
      "User-Agent": USER_AGENT,
    }),
    label: "Google AI",
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Probe a provider's models endpoint to verify whether an API key is valid.
 *
 * - **200** → `{ ok: true, detail: "Server-verified at HH:MM UTC" }`
 * - **401 / 403** → `{ ok: false, detail: "API key rejected by <provider> (HTTP <code>)" }`
 * - **Other HTTP status** → `{ ok: false, detail: "Unexpected HTTP <code> …" }`
 * - **Network / timeout** → throws (caller should catch and record `probe_network_error`)
 *
 * The function intentionally throws on network errors so that
 * `AuthHealthMonitor.checkAll()` can distinguish "key is revoked" (a result)
 * from "network is down" (an exception). The latter must NOT flip the DB
 * cache to `expired`.
 */
export async function probeApiKeyServerSide(
  provider: ApiKeyProvider,
  apiKey: string,
): Promise<ApiKeyProbeResult> {
  const config = PROVIDER_CONFIG[provider];
  const url = config.url(apiKey);
  const headers = config.headers(apiKey);

  // Wrap fetch in try/catch to sanitize error messages. Two leak vectors:
  //  1. Google puts the API key in the query string — Node's native fetch
  //     may include the full URL in `err.cause`.
  //  2. Some fetch implementations embed the URL in `err.message` itself
  //     (e.g. "Failed to fetch https://...?key=AIza...").
  // Re-throwing a new Error strips the cause chain, and `sanitizeMessage`
  // replaces any literal occurrence of the key in the message text.
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : "unknown network error";
    const safe = raw.replaceAll(apiKey, "[REDACTED]");
    throw new Error(`${config.label} probe failed: ${safe}`);
  }

  // Drain the response body so undici can reuse the TCP socket. The
  // /v1/models payload can be several KB; leaving it unconsumed pins the
  // connection until GC or the AbortSignal fires.
  response.body?.cancel();

  if (response.ok) {
    const hhmm = new Date().toISOString().slice(11, 16); // "HH:MM"
    return { ok: true, detail: `Server-verified at ${hhmm} UTC` };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      detail: `API key rejected by ${config.label} (HTTP ${response.status})`,
    };
  }

  // Unexpected status (429 rate-limit, 500 server error, etc.). Treat as
  // transient — don't flip the cache, but return a non-ok result so the
  // caller can decide. We throw here to match the "network_error" contract:
  // any non-definitive failure should leave the DB cache untouched.
  throw new Error(
    `${config.label} probe returned unexpected HTTP ${response.status}`,
  );
}
