import type { BackendId } from "@aitne/shared";

/**
 * Delegated proxy invoker constants. Centralised so unit tests can override
 * via a typed object and so the values are documented in one place.
 *
 * The default-concurrent cap is wired through `AgentConfig.delegatedProxyMaxConcurrent`
 * (DELEGATED-PROXY-API-DESIGN.md §10 / §12 decision 7) — this module ships
 * the *fallback* used when the field is absent, e.g. in tests that build a
 * partial config object.
 */
export const DELEGATED_PROXY_DEFAULTS = {
  /**
   * Per-call max turns. Bumped 2 → 4 (2026-04-29) after audit log showed 5
   * back-to-back `subprocess_crashed: Reached maximum number of turns (2)`
   * failures on Notion `recently_updated` cadence inside `delegated_sync`.
   * Root cause: when many MCP servers are registered, Claude Code defers
   * tool schemas and the model burns a turn on `ToolSearch` before it can
   * call the namespaced connector tool. Combined with
   *   - the doc's own list_labels → apply_labels example (3-turn floor)
   *   - the rare model preamble before tool_use
   * the previous floor of 2 was too tight. 4 covers
   *   ToolSearch (1) → connector tool (2) → final response (3) + buffer.
   * v0.1 ships UI only for `delegatedModel`, not `delegatedMaxTurns`
   * (§4.2 / §13 Q3) — operators can hand-edit `~/.personal-agent/integrations.md`
   * to override per integration.
   */
  maxTurns: 4,
  /**
   * Per-call USD ceiling. Belt-and-suspenders alongside the LLM's own
   * tool-only prompt — the proxy can still loop if the model misbehaves;
   * this caps the spend per misbehaving invocation.
   */
  maxBudgetUsd: 0.5,
  /**
   * Per-call wall-clock timeout. Aborts the subprocess on overrun.
   *
   * Default raised 30s → 120s (2026-05-04) after audit log showed
   * `delegated_sync` cadences on Claude Haiku timing out at the 30s cap
   * with retryAttempts=1, totalling ~64s wall-clock. Sonnet on the
   * cadence path needs more headroom for the ToolSearch (1) → connector
   * tool (2) → final response (3) sequence when the per-session MCP
   * config registers many servers. 120s comfortably covers the worst-
   * case healthy call (measured 30-60s with cold session-dir +
   * connector tool latency) without making a stuck call drag the next
   * tick into a backlog.
   *
   * Gemini's CLI cold-start + MCP-extension load + flash-lite latency
   * routinely takes 35-50s for a single tool call (measured 2026-04-27),
   * but a 90-day `listEvents` against google-workspace can stretch past
   * 90s under concurrent load — observed 2026-04-28 during back-to-back
   * roadmap_refresh runs. Gemini cap stays 180s.
   */
  callTimeoutMs: 120_000,
  callTimeoutMsByBackend: {
    gemini: 180_000,
  } as Partial<Record<BackendId, number>>,
  /**
   * Per-call stream-idle timeout. Aborts the subprocess (or closes the
   * SDK iterator) when no stream event has arrived inside this window.
   *
   * Rationale: the wall-clock cap above is the upper bound on a worst-
   * case stuck call. In practice, a healthy delegated invocation emits
   * stream events fairly continuously — Claude SDK messages every 1-3 s
   * after warm-up, Codex `turn.*` events every 5-15 s, Gemini stream-json
   * lines every 5-30 s including MCP cold-start. When `gemini-cli`
   * hangs entirely (audit log 2026-05-02 / 2026-05-03 cluster: 9 of
   * 83 cadence calls timed out at the 180 s wall-clock with zero output),
   * the wall-clock is the only signal — leaving synchronous callers
   * blocked for 180 s before they see a deterministic failure.
   *
   * Per-backend tuning reflects cold-start variance: Claude has none
   * (in-process), Codex has light startup, Gemini has CLI + MCP-extension
   * load on top of flash-lite first-token latency. Each value is at
   * least 2× the observed worst-case healthy first-event time so a slow-
   * but-functional call is not falsely killed.
   *
   * Operators can hand-edit this constant if their environment shows
   * different startup characteristics; v0.1 ships no UI for it.
   */
  idleTimeoutMs: 30_000,
  idleTimeoutMsByBackend: {
    claude: 30_000,
    codex: 60_000,
    gemini: 75_000,
  } as Partial<Record<BackendId, number>>,
  /** Queue-wait timeout. Excess requests after this 503 with `delegated_proxy_busy`. */
  queueWaitTimeoutMs: 60_000,
  /** Tempdir basename prefix — janitor scans for `proxy-*` directories. */
  tempdirPrefix: "proxy-",
  /**
   * Boot-time janitor age threshold. Anything older than this in the
   * sessions root with the proxy- prefix is removed at startup. Covers
   * SIGKILL mid-call cases the per-call `finally` cannot.
   */
  janitorMaxAgeMs: 5 * 60 * 1000,
  /** Default concurrent cap — overridden by `AgentConfig.delegatedProxyMaxConcurrent`. */
  defaultMaxConcurrent: 4,
} as const;

export type DelegatedProxyDefaults = typeof DELEGATED_PROXY_DEFAULTS;
