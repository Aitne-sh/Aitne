/**
 * `RoutineFetchWindowRunner` — pre-pass fan-out coordinator.
 *
 * docs/design/appendices/routine-data-acquisition.md §6.1.1 + docs/design/appendices/pre-pass-fan-out.md
 * — every routine dispatcher (morning_routine, today_refresh,
 * activity_scan, evening / weekly / monthly review) calls this runner
 * immediately before dispatching the parent session. The runner:
 *
 *  1. Reads the per-routine plan from `ROUTINE_WINDOWS` and the current
 *     integration state, fans rows out per-account where applicable,
 *     resolves each row's predicate (`direct` / `delegated-same` /
 *     `delegated-cross` / `native` / skip), and partitions the plan
 *     by `IntegrationKey` via `splitAcquisitionPlanByIntegration`.
 *  2. Spawns one lite-tier `routine.fetch_window` sub-session per
 *     integration in parallel (bounded by `prePassFanOutConcurrency`).
 *     Each sub-session sees exactly one partial — the
 *     `{integration_partial}` placeholder in the
 *     `routine.fetch_window` task-flow is replaced with the body of
 *     `_partials/<integration prePassPartial>` so the lite-tier model
 *     never has to disambiguate cross-API argument names. Each
 *     sub-session runs through an independent retry loop bounded by
 *     `prePassMaxAttemptsPerIntegration`, `prePassBackoffMs`, and the
 *     per-integration / per-routine USD budget caps.
 *  3. Merges the sub-reports into a single `FetchReport` (additive
 *     `<integration>` children on the `<fetch_report>` XML block) and
 *     returns it plus the rendered block.
 *  4. The caller grafts the block into the **parent** routine event's
 *     `event.data.fetchReportBlock`. ContextBuilder injects it verbatim
 *     into the parent session's prompt (mirrors the `<gate_decision>`
 *     pattern used by activity_scan Stage 3).
 *
 * Failure-mode contract (docs/design/appendices/pre-pass-fan-out.md §5):
 *
 *  - **No applicable rows** (routine has no windows in `ROUTINE_WINDOWS`,
 *    every integration is disabled, every account list is empty) — the
 *    runner returns an empty `<fetch_report>` with `status="skipped"` and
 *    `fetched=posted=duplicates=0`. The parent routine still runs; the
 *    block is informational only.
 *  - **Pre-pass session errors** (binding resolve fails, agent throws,
 *    JSON parse fails) — recorded per-attempt; the retry loop fires up
 *    to `maxAttempts` before giving up. Final per-integration status
 *    surfaces in `<integration status="failed">`. Pre-pass cost gains
 *    are forfeit for that integration; siblings are unaffected.
 *    Throwing here would otherwise propagate up and abort the parent
 *    routine — the opposite of P3 ("Lite for Fetch, Medium for Decide").
 *  - **Partial success** — the report's `errors` array carries per-row
 *    failures (`no-surface`, `fetch-failed`, `budget-exhausted`,
 *    `budget-cap`, `global-budget-cap`). The block surfaces them so the
 *    parent prompt can decide whether to treat its observations view as
 *    complete.
 */

import type Database from "better-sqlite3";
import type {
  AgentResult,
  BackendId,
  Event,
  IntegrationKey,
  IntegrationState,
  ProcessKey,
  ProcessModelTier,
  RoutineEvent,
} from "@aitne/shared";
import {
  EventPriority,
  INTEGRATION_KEYS,
  createEvent,
  getAgentDayDateStr,
  getIntegrationDescriptor,
  isRoutineEvent,
} from "@aitne/shared";
import type { AgentConfig } from "../config.js";
import { readIntegrations } from "../db/integrations-store.js";
import type { MailAccount } from "../services/mail/provider.js";
import type { IAgentRouter } from "./backends/backend-router.js";
import type {
  IAuditLogger,
  IContextBuilder,
} from "./dispatcher-types.js";
import type { PromptAssembler } from "./dispatcher-prompt.js";
import { renderPartialForFanOut } from "./prompts.js";
import { OBSERVATIONS_MCP_TOOL_NAME } from "../services/mcp/sdk-observations-server.js";
import {
  ROUTINE_WINDOWS,
  routineHasWindows,
  WINDOW_QUERIES,
  type RoutineWindowKey,
} from "./routine-windows.js";
import {
  buildAcquisitionPlanAssembly,
  buildAcquisitionTimestamps,
  splitAcquisitionPlanByIntegration,
  type AcquisitionAccount,
  type AcquisitionPlanDrop,
  type AcquisitionSubPlan,
  type AcquisitionTimestamps,
  type BuildAcquisitionPlanInput,
} from "./routine-acquisition-plan.js";
import {
  BackendDecisiveFailure,
  BackendQuotaError,
  extractBackendSpend,
} from "./agent-core.js";
import { BackendRouterHandledError } from "./backends/backend-router.js";
import type { PrePassObservationsSink } from "../services/mcp/sdk-observations-server.js";
import type { AutonomousSpawnGate, SpawnGateDecision } from "./spawn-gates.js";
import {
  RETRY_REASONS,
  TURN_LIMIT_FAILURE_KIND,
  buildPriorAttemptHintBlock,
  computePrePassMaxTurns,
  defaultRetryDecision,
  widenPrePassMaxTurns,
  type RetryDecision,
  type RetryPolicy,
} from "./routine-fetch-window-retry.js";
import { writeRuntimeState } from "../db/runtime-state.js";
import { prePassLastRunRuntimeStateKey } from "./pre-pass-freshness.js";
import { createLogger } from "../logging.js";

const logger = createLogger("routine-fetch-window-runner");

// ── Public types ───────────────────────────────────────────────────────────

/**
 * Structured form of the agent's single-line JSON output. Matches the
 * contract in `agent-profiles/routine-fetch-window.md`:
 *
 * ```json
 * {"fetched": <int>, "posted": <int>, "duplicates": <int>, "errors": [...]}
 * ```
 *
 * `status` is the runner's classification of the run — `success` /
 * `partial` (any errors) / `failed` (parse / agent / dispatch failure) /
 * `skipped` (no applicable rows). Persisted in the `<fetch_report>`
 * block so the parent routine can branch deterministically without
 * re-counting the errors array.
 */
export interface FetchReport {
  status: "success" | "partial" | "failed" | "skipped";
  fetched: number;
  posted: number;
  duplicates: number;
  errors: ReadonlyArray<Record<string, unknown>>;
  /** True when the runner skipped dispatching a session entirely. */
  skipped: boolean;
  /** Set when status === "failed" — the message captured in the audit row. */
  failureReason?: string;
  /** Stable ID for telemetry tie-back; mirrors the fetcher event's correlationId. */
  fetcherCorrelationId?: string;
  /**
   * docs/design/appendices/pre-pass-fan-out.md §4.5 — per-integration breakdown. Top-level
   * counts above already aggregate the children; the breakdown lets
   * downstream consumers (parent task-flow prose, dashboard renderers)
   * branch per integration. Absent on the `skipped` / `failed` paths
   * that short-circuit before fan-out (no-routine-key, no-windows,
   * empty plan, plan-assembly-failed).
   */
  perIntegration?: ReadonlyArray<SubReport>;
}

/**
 * docs/design/appendices/pre-pass-fan-out.md §4.3 — one attempt of one integration's
 * sub-session. The fan-out coordinator records one of these per
 * `agentRouter.execute` invocation; `defaultRetryDecision` consumes
 * the latest record to decide whether to spawn another attempt.
 */
export interface SubAttemptRecord {
  /** 1-indexed. */
  attempt: number;
  status: FetchReport["status"];
  fetched: number;
  posted: number;
  duplicates: number;
  errors: ReadonlyArray<Record<string, unknown>>;
  /** Set when the agent's output failed strict-JSON parse. */
  parseError?: string;
  fetcherCorrelationId: string;
  /** ISO 8601 UTC. */
  startedAt: string;
  /** ISO 8601 UTC. */
  endedAt: string;
  costUsd: number;
  numTurns: number;
}

/**
 * docs/design/appendices/pre-pass-fan-out.md §4.3 — final per-integration verdict the
 * coordinator emits after its retry loop terminates. Mirrors the
 * fields of the last `SubAttemptRecord` (the final attempt's outcome
 * is the integration's effective outcome) plus the integration key
 * and the full attempt history.
 */
export interface SubReport extends SubAttemptRecord {
  integrationKey: IntegrationKey;
  /** Full attempt history; `attempts[attempts.length - 1]` matches the inherited fields. */
  attempts: ReadonlyArray<SubAttemptRecord>;
  /**
   * True iff the loop exhausted `maxAttempts` (or a budget/global cap
   * tripped) without reaching a non-retryable success state.
   */
  retriesExhausted: boolean;
}

export interface RoutineFetchWindowResult {
  report: FetchReport;
  /** XML block to graft into the parent routine event's `event.data.fetchReportBlock`. */
  block: string;
}

/**
 * HOURLY_CHECK_GATE_REDESIGN_PLAN.md §3.4 — caller options for `run()`.
 *
 * The activity_scan coordinator passes `integrationKeyFilter` to restrict
 * the fan-out to the subset of integrations whose freshness window has
 * elapsed. Morning_routine / evening_review / weekly_review call
 * `run()` without options so they fetch every integration the routine
 * declares (their windows are larger and the freshness gate would
 * defeat the purpose of the larger window).
 */
export interface RoutineFetchWindowRunOptions {
  /**
   * Restrict the fan-out to the listed integration keys. Integrations
   * whose key is not in the set are dropped after
   * `splitAcquisitionPlanByIntegration` runs, producing the same
   * "empty plan → skipped" outcome as if they had no fetch rows.
   *
   * Empty set → entire fan-out is skipped (returns a `status='skipped'`
   * fetch report). Callers that want "fetch everything" should pass
   * `options=undefined`, not an empty set.
   */
  integrationKeyFilter?: ReadonlySet<IntegrationKey>;
}

export interface RoutineFetchWindowRunnerDeps {
  db: Database.Database;
  config: AgentConfig;
  contextBuilder: IContextBuilder;
  agentRouter: IAgentRouter;
  audit: IAuditLogger;
  prompt: PromptAssembler;
  /**
   * Returns the active mail account list — used to fan rows out per
   * account when `RoutineWindowSpec.perAccount === true`. Threads the
   * dispatcher's existing `getActiveMailAccounts` closure so the runner
   * doesn't need to depend on the registry directly.
   */
  getActiveMailAccounts: () => readonly MailAccount[];
  /**
   * Lazy accessor for the dashboard SSE event broadcaster (A2 / B2
   * observability extension). When set, the runner emits
   * `kind: "prepass_started"` / `"prepass_completed"` payloads to the
   * default `event` SSE channel so the setup wizard can render the
   * "Fetching your mail and Notion data…" sub-step distinctly from
   * the parent routine's `routine_started` / `routine_completed`
   * envelope. Returns `null` when the dispatcher has not wired a
   * broadcaster yet (test paths, headless installs); the runner
   * treats every call as fire-and-forget and never propagates a
   * broadcaster failure into the parent dispatch.
   *
   * Optional — when undefined the runner runs exactly as it did
   * pre-A2, including the empty-plan short-circuit.
   */
  getEventBroadcaster?: () => { broadcastEvent: (data: unknown) => void } | null;
  /**
   * PREPASS_COST_REDUCTION_PLAN.md N2 — offline/auth spawn gate shared
   * with the dispatcher. Evaluated per integration sub-session (the
   * hourly `harvestForGate` path spawns the runner directly, bypassing
   * the dispatcher's own gate). Optional: when undefined the runner
   * spawns unconditionally, exactly as pre-N2.
   */
  spawnGate?: AutonomousSpawnGate;
}

// ── Module helpers ────────────────────────────────────────────────────────

/** The ProcessKey + event type the pre-pass session always runs under. */
const FETCH_WINDOW_PROCESS_KEY: ProcessKey = "routine.fetch_window";
const FETCH_WINDOW_EVENT_TYPE = "routine.fetch_window";
/**
 * docs/design/appendices/pre-pass-fan-out.md §4.2 — the single placeholder the
 * `routine.fetch_window.md` task-flow carries in place of inline
 * integration partials. The runner substitutes this with the
 * integration-specific partial body loaded via
 * `renderPartialForFanOut`. Kept as a constant so the task-flow file
 * and the substitution call cannot drift apart.
 */
const FETCH_WINDOW_INTEGRATION_PARTIAL_PLACEHOLDER = "{integration_partial}";

/**
 * Daemon REST surfaces the pre-pass partials may target. Curl prefixes
 * are constructed with the configured `apiPort` at dispatch time so a
 * non-default port survives the clamp. Everything OTHER than these
 * prefixes is denied — the pre-pass cannot reach `/api/notify`,
 * `/api/context/*`, `/api/agent/*`, etc., even though Bash(curl *) is
 * the project default. This is the daemon-side enforcement that backs
 * the agent profile's "no notify, no context writes" guardrails (P3:
 * Lite for Fetch — the pre-pass has zero business making decisions).
 *
 * Each pattern uses a wildcard `*` between `curl` and the URL so the
 * SDK's glob matcher accepts both flag orderings the Haiku fetcher
 * actually emits:
 *
 *   - `curl http://localhost:.../api/observations -X POST -d @-` (URL first)
 *   - `curl -X POST -H 'Content-Type: …' http://localhost:.../api/observations -d @-`
 *     (flags first)
 *
 * The original prefix-anchored form (`Bash(curl http://localhost:.../api/observations*)`)
 * silently denied the flags-first invocation, manifesting as `posted=0,
 * fetched=N` reports — Haiku fetched via MCP, then could not POST a single
 * observation. The curl PreToolUse hook in `claude-tool-collection.ts`
 * remains the host/port/exfil chokepoint; this clamp now restricts only
 * the daemon-API namespace, which is what we actually need.
 *
 * 2026-05-29: the observations-WRITE curl pattern is omitted ENTIRELY on
 * the Claude backend (see `buildPrePassDaemonRestPatterns`). Claude posts
 * via the in-process `mcp__aitne-observations__submit_observations` MCP
 * tool — structured transport, never shell-parsed — the only path that
 * survives the SDK's `Ae6` Unicode-whitespace bash preflight that
 * otherwise denies `curl … -d @-` bodies and cascades to `budget-cap`.
 * The wildcard rationale above still governs the surviving READ curls
 * (mail/calendar/notion/integrations) and codex/gemini's write curl.
 *
 * `jq *` stays allowed because direct-mode partials pipe curl output
 * through jq for compact projection before posting to /api/observations.
 *
 * The clamp is Claude-only — Codex/Gemini have no per-spawn allowedTools
 * surface today (CLAUDE.md acknowledges the gap). The
 * `process_backend_config` envelope (`max_turns=20`, `max_budget_usd=0.50`)
 * remains the floor on those backends.
 */
function buildPrePassDaemonRestPatterns(
  apiPort: number,
  sessionBackend: BackendId,
): readonly string[] {
  const root = `http://localhost:${apiPort}/api`;
  // Observations WRITE surface — the only write the pre-pass performs (GET
  // reads of pending observations live in the activity-scan session, never
  // here). For Claude the structured MCP tool
  // `mcp__aitne-observations__submit_observations` (added by
  // `composePrePassAllowedTools`) is the ONLY sanctioned write path, so we
  // deliberately OMIT the curl pattern: a `curl … -d @- <<'JSON'` body whose
  // calendar titles / mail subjects carry Unicode whitespace (U+3000 in JP
  // titles, NBSP/ZWS in promo subjects) makes the SDK's `Ae6` bash preflight
  // mark the command `too-complex` ("Contains Unicode whitespace") and deny
  // it under dontAsk — which the runner then retries until it trips the
  // per-integration `budget-cap`. Dropping the curl allow-rule forces Claude
  // onto the MCP transport (structured JSON, never shell-parsed) and closes
  // that failure class. codex/gemini have no MCP transport, so they retain
  // the curl pattern (accepted gap — see `composePrePassAllowedTools`).
  const observationsWrite =
    sessionBackend === "claude"
      ? []
      : [`Bash(curl *${root}/observations*)`];
  return [
    ...observationsWrite,
    // Direct-mode mail / calendar / notion reads.
    `Bash(curl *${root}/mail/*)`,
    `Bash(curl *${root}/calendar/*)`,
    `Bash(curl *${root}/notion/*)`,
    // delegated-cross proxy. Only Gmail / Google Calendar / Notion
    // expose this; user-managed Outlook has no proxy and the runner
    // collapses cross-backend bindings to delegated-same per
    // routine-acquisition-plan.ts:resolveFetchMode.
    `Bash(curl *${root}/integrations/*)`,
    // Compact-projection helper used by the partials.
    "Bash(jq *)",
  ];
}

/**
 * Project the active integrations into the per-backend MCP tool names
 * the pre-pass needs. Includes both delegated-same bindings (where the
 * connector is registered through the daemon's Claude SDK) AND native
 * bindings (where the connector is loaded by the user but the same
 * descriptor declares which capability tool names exist). User-managed
 * descriptors (`backendConnectors[backend]` undefined for Outlook) are
 * skipped — those rows surface as `no-surface` errors per the partial
 * contract, which is the documented behaviour.
 *
 * Cross-backend delegated bindings contribute zero MCP tools because
 * the partial reaches them through `/api/integrations/<key>/exec`, not
 * via the session backend's MCP namespace.
 */
/**
 * Observability helper: list integrations whose `<fetch>` row will spawn
 * on a backend OTHER than the pre-pass default `sessionBackend`. After
 * the per-integration backend routing fix (see
 * `routine-acquisition-plan.ts#resolveIntegrationBackend`), native
 * bindings whose `nativeBackend !== sessionBackend` are NO LONGER
 * silently dropped — they spawn on the integration's actual
 * `nativeBackend` via `BackendRouter.resolveBinding({requestedBackendId})`.
 * The previous "dropped" semantics is dead; this helper is preserved as
 * a *cross-backend-spawn* signal so the daemon log surfaces "this
 * routine fans out across multiple backends" up-front (useful when
 * debugging Codex / Gemini auth issues that only manifest in pre-pass).
 *
 * Routine-scoped: only considers integrations that appear in
 * `ROUTINE_WINDOWS[routine]` (via WINDOW_QUERIES per window symbol). A
 * native-mismatched gmail row never surfaces under routine.weekly_review
 * because weekly_review only touches calendar.
 *
 * Returns one entry per affected integration with `{ key, nativeBackend }`.
 * Pure — pulls only from the integrations snapshot + the routine catalog,
 * no side effects.
 */
function collectCrossBackendNativeIntegrations(
  routine: RoutineWindowKey,
  integrations: Partial<Record<IntegrationKey, IntegrationState>>,
  sessionBackend: BackendId,
): ReadonlyArray<{ key: IntegrationKey; nativeBackend: BackendId }> {
  // Collect the integrations this routine genuinely touches by walking
  // its window specs against the WINDOW_QUERIES catalog. Using the
  // same data sources as `collectFetchRows` in routine-acquisition-plan.ts
  // keeps the WARN aligned with the actual filter logic.
  const routineIntegrations = new Set<IntegrationKey>();
  for (const spec of ROUTINE_WINDOWS[routine]) {
    const cell = WINDOW_QUERIES[spec.window];
    if (!cell) continue;
    for (const key of Object.keys(cell) as IntegrationKey[]) {
      routineIntegrations.add(key);
    }
  }

  const out: { key: IntegrationKey; nativeBackend: BackendId }[] = [];
  for (const key of INTEGRATION_KEYS) {
    if (!routineIntegrations.has(key)) continue;
    const state = integrations[key];
    if (!state || state.mode !== "native") continue;
    if (!state.nativeBackend) continue;
    if (state.nativeBackend === sessionBackend) continue;
    out.push({ key, nativeBackend: state.nativeBackend });
  }
  return out;
}

function collectIntegrationToolsForBackend(
  integrations: Partial<Record<IntegrationKey, IntegrationState>>,
  backend: BackendId,
): readonly string[] {
  const out = new Set<string>();
  for (const key of INTEGRATION_KEYS) {
    const state = integrations[key];
    if (!state) continue;
    let active = false;
    if (state.mode === "delegated" && state.delegatedBackend === backend) {
      active = true;
    } else if (state.mode === "native" && state.nativeBackend === backend) {
      active = true;
    }
    if (!active) continue;
    const connector = getIntegrationDescriptor(key).backendConnectors[backend];
    if (!connector) continue; // user-managed (no descriptor connector for this backend)
    for (const toolNames of Object.values(connector.capabilityTools)) {
      for (const toolName of toolNames) {
        out.add(connector.toolNamespace + toolName);
      }
    }
  }
  return Array.from(out);
}

/**
 * Compose the per-execute `allowedToolsOverride` for the pre-pass. The
 * override REPLACES the SDK's default allowlist (no union per
 * claude-code-core.ts:437) so the list must be exhaustive for every
 * surface the partials use under any (integration, mode) cell. Mode
 * coverage:
 *
 *  - `direct`: daemon REST → curl prefix.
 *  - `delegated-same`: session backend MCP → integration tool name.
 *  - `delegated-cross`: daemon delegation proxy → curl prefix
 *    (`/api/integrations/<key>/exec`).
 *  - `native` (descriptor-bound): session backend MCP → integration
 *    tool name.
 *  - `native` (user-managed) / no-surface: nothing in the override —
 *    the partial records `no-surface` and the runner's report carries
 *    the gap forward to the parent routine.
 *
 * `ToolSearch` is appended for Claude sessions whenever at least one
 * descriptor-bound MCP tool is present. Claude Code 2.1+ defers large
 * MCP tool manifests (`mcp__claude_ai_Gmail__*`,
 * `mcp__claude_ai_Google_Calendar__*`, `mcp__claude_ai_Notion__*`, …)
 * behind `ToolSearch`, so the model must call `ToolSearch` to load a
 * deferred tool's schema before it can be invoked. Without `ToolSearch`
 * allowed, the Haiku fetcher emits a denied ToolSearch call on its
 * first turn, gives up, and returns text with no JSON — the parent
 * routine then sees `<fetch_report status="failed" reason="no-json-object">`.
 * Mirrors the same workaround in `claude-delegated.ts` (delegated proxy
 * `allowedTools: [toolName, "ToolSearch"]`). Codex / Gemini have no
 * per-spawn allowedTools surface today and ignore the override entirely
 * (CLAUDE.md acknowledges the gap), so the `ToolSearch` widening is
 * gated on `sessionBackend === "claude"` to keep the list minimal for
 * other backends.
 *
 * Exported for unit testing — the runner consumes it via
 * `composePrePassAllowedTools` at dispatch time.
 */
export function composePrePassAllowedTools(
  apiPort: number,
  integrations: Partial<Record<IntegrationKey, IntegrationState>>,
  sessionBackend: BackendId,
): readonly string[] {
  const integrationTools = collectIntegrationToolsForBackend(
    integrations,
    sessionBackend,
  );
  const needsDeferredDiscovery =
    sessionBackend === "claude" && integrationTools.length > 0;
  // In-process MCP tool `mcp__aitne-observations__submit_observations` is
  // the structural fix for the Unicode-whitespace-in-curl-body class of
  // failures (promotional senders + NBSP/ZWS in mail subjects cause the
  // SDK's `Ae6` bash preflight to mark the command `too-complex` and
  // deny it under dontAsk, burning attempts and surfacing budget-cap).
  // Server is registered in-process by
  // `ClaudeCodeCore.getObservationsMcpServer`; per-session exposure is
  // controlled here. Claude-only because the SDK MCP transport is
  // Claude-specific; codex/gemini pre-pass sessions retain the curl
  // pattern via `buildPrePassDaemonRestPatterns` and remain at risk of
  // the same class of denial (accepted gap until those backends gain a
  // parallel structured channel).
  const observationsMcpTools =
    sessionBackend === "claude" ? [OBSERVATIONS_MCP_TOOL_NAME] : [];
  return [
    ...buildPrePassDaemonRestPatterns(apiPort, sessionBackend),
    ...integrationTools,
    ...observationsMcpTools,
    ...(needsDeferredDiscovery ? ["ToolSearch"] : []),
  ];
}

/**
 * Map a `MailAccount.kind` onto the integration key the registry uses
 * for routing. Today: `gmail` → `gmail`, `outlook` → `outlook_mail`.
 * Yahoo / iCloud / IMAP accounts are not tied to a routed integration
 * and therefore do not participate in the pre-pass fan-out today.
 */
function mailAccountIntegrationKey(account: MailAccount): IntegrationKey | null {
  switch (account.kind) {
    case "gmail":
      return "gmail";
    case "outlook":
      return "outlook_mail";
    default:
      return null;
  }
}

/**
 * Derive the canonical `RoutineWindowKey` from a routine event. The
 * caller's intent is conveyed by `event.type` (always `routine.<name>`),
 * with `RoutineEvent.routine` carrying the same suffix without the
 * `routine.` prefix. Returns null for routines outside the catalog so
 * the caller can short-circuit before touching plan assembly.
 */
export function routineWindowKeyFromEvent(event: Event): RoutineWindowKey | null {
  if (!isRoutineEvent(event)) return null;
  const candidate = `routine.${event.routine}`;
  return (
    (ROUTINE_WINDOWS as Record<string, unknown>)[candidate] !== undefined
      ? (candidate as RoutineWindowKey)
      : null
  );
}

/**
 * Walk `text` and return every balanced `{...}` slice (top-level objects
 * only; nested braces are honoured). Strings are tracked so brace
 * characters inside `"..."` literals don't unbalance the scan. Used by
 * `parseFetchWindowOutput` to pick the LAST top-level object on stdout —
 * agents occasionally emit a think-aloud line carrying a JSON snippet
 * before the verdict, and the fetcher's contract is "the last
 * top-level JSON object wins."
 *
 * Exported for direct unit testing; the runner consumes it via
 * `parseFetchWindowOutput`.
 */
export function extractBalancedJsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          out.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return out;
}

/** Strict-JSON parse of the fetcher's single-line output. */
export function parseFetchWindowOutput(
  output: string,
): FetchReport | { parseError: string } {
  const trimmed = (output ?? "").trim();
  if (!trimmed) return { parseError: "empty-output" };
  // Tolerate code fences without making them mandatory — mirrors
  // `parseStage2Verdict` in dispatcher-types.ts.
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const candidates = extractBalancedJsonObjects(stripped);
  if (candidates.length === 0) return { parseError: "no-json-object" };
  const objText = candidates[candidates.length - 1]!;
  let parsed: unknown;
  try {
    parsed = JSON.parse(objText);
  } catch (err) {
    return { parseError: `invalid-json: ${(err as Error).message}` };
  }
  if (!parsed || typeof parsed !== "object") {
    return { parseError: "not-an-object" };
  }
  const obj = parsed as Record<string, unknown>;
  const fetched = typeof obj.fetched === "number" ? obj.fetched : 0;
  const posted = typeof obj.posted === "number" ? obj.posted : 0;
  const duplicates = typeof obj.duplicates === "number" ? obj.duplicates : 0;
  const errors = Array.isArray(obj.errors)
    ? obj.errors
        .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
        .map((row) => ({ ...row }))
    : [];
  const status: FetchReport["status"] = errors.length > 0 ? "partial" : "success";
  return {
    status,
    fetched,
    posted,
    duplicates,
    errors,
    skipped: false,
  };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Render the `<fetch_report>` XML block injected into the parent
 * routine's prompt. Keep the schema narrow — every additional attribute
 * costs prompt tokens on the cache-warm parent session.
 *
 * `meta.routine` accepts any string so the no-routine-key skip path can
 * render the parent event's actual type (e.g. `routine.skill_curation`)
 * instead of borrowing a catalog entry as a placeholder. The renderer
 * strips the `routine.` prefix verbatim — callers may pass either the
 * fully-qualified ProcessKey or a bare suffix.
 */
export function renderFetchReportBlock(
  report: FetchReport,
  meta: { routine: RoutineWindowKey | string; agentDay: string },
): string {
  const routineAttr = meta.routine.replace(/^routine\./, "");
  const lines: string[] = [
    `<fetch_report routine="${xmlEscape(routineAttr)}" agent_day="${xmlEscape(meta.agentDay)}" status="${xmlEscape(report.status)}" fetched="${report.fetched}" posted="${report.posted}" duplicates="${report.duplicates}">`,
  ];
  if (report.failureReason) {
    lines.push(`  <failure>${xmlEscape(report.failureReason)}</failure>`);
  }
  for (const err of report.errors) {
    const type = typeof err.type === "string" ? err.type : "unknown";
    // Compact, attribute-shaped serialisation: every string-typed key
    // becomes an XML attribute; nested objects are collapsed to JSON
    // text content so the block stays parseable both as XML and as a
    // line-by-line scan target.
    const attrEntries = Object.entries(err).filter(
      ([k, v]) => k !== "type" && (typeof v === "string" || typeof v === "number"),
    );
    const attrs = attrEntries
      .map(([k, v]) => `${xmlEscape(k)}="${xmlEscape(String(v))}"`)
      .join(" ");
    const nested = Object.entries(err).filter(
      ([k, v]) =>
        k !== "type"
        && typeof v !== "string"
        && typeof v !== "number",
    );
    if (nested.length > 0) {
      lines.push(
        `  <error type="${xmlEscape(type)}"${attrs ? " " + attrs : ""}>${xmlEscape(JSON.stringify(Object.fromEntries(nested)))}</error>`,
      );
    } else {
      lines.push(
        `  <error type="${xmlEscape(type)}"${attrs ? " " + attrs : ""} />`,
      );
    }
  }
  lines.push("</fetch_report>");
  return lines.join("\n");
}

// ── Fan-out aggregation (docs/design/appendices/pre-pass-fan-out.md §4.5) ─────────────────

/**
 * Resolve the aggregate `<fetch_report>` status from a set of
 * sub-reports' final statuses, per §4.5:
 *
 *  - `success` iff every non-skipped sub-report is `success`. Skipped
 *    sub-reports do not count against success.
 *  - `failed` iff every non-skipped sub-report is `failed`.
 *  - `partial` for any other mix (incl. one success + one failed).
 *  - `skipped` only when the input is empty (the caller handles
 *    "every sub-report skipped" separately — the runner short-circuits
 *    before fan-out when no integrations are active).
 *
 * Exported for unit testing the status-resolution branch in isolation.
 */
export function aggregateFanOutStatus(
  subReports: readonly SubReport[],
): FetchReport["status"] {
  if (subReports.length === 0) return "skipped";
  const nonSkipped = subReports.filter((r) => r.status !== "skipped");
  if (nonSkipped.length === 0) return "skipped";
  const allSuccess = nonSkipped.every((r) => r.status === "success");
  if (allSuccess) return "success";
  const allFailed = nonSkipped.every((r) => r.status === "failed");
  if (allFailed) return "failed";
  return "partial";
}

/**
 * Render the additive `<integration>` children + the `<error>`
 * grandchildren that go inside a fan-out `<fetch_report>`. The parent
 * `<fetch_report ...>` open/close lines are produced by
 * `renderFetchReportBlock`; this helper produces only the body lines so
 * the two can compose cleanly.
 */
function renderPerIntegrationLines(subReports: readonly SubReport[]): string[] {
  const lines: string[] = [];
  for (const sub of subReports) {
    const errors = errorsForSubReport(sub);
    const openAttrs = [
      `key="${xmlEscape(sub.integrationKey)}"`,
      `status="${xmlEscape(sub.status)}"`,
      `fetched="${sub.fetched}"`,
      `posted="${sub.posted}"`,
      `duplicates="${sub.duplicates}"`,
      `attempts="${sub.attempts.length}"`,
    ];
    if (errors.length === 0) {
      lines.push(`  <integration ${openAttrs.join(" ")} />`);
      continue;
    }
    lines.push(`  <integration ${openAttrs.join(" ")}>`);
    for (const err of errors) {
      const type = typeof err.type === "string" ? err.type : "unknown";
      const attrEntries = Object.entries(err).filter(
        ([k, v]) => k !== "type" && (typeof v === "string" || typeof v === "number"),
      );
      const attrs = attrEntries
        .map(([k, v]) => `${xmlEscape(k)}="${xmlEscape(String(v))}"`)
        .join(" ");
      lines.push(
        `    <error type="${xmlEscape(type)}"${attrs ? " " + attrs : ""} />`,
      );
    }
    lines.push(`  </integration>`);
  }
  return lines;
}

/**
 * Flatten every attempt's `errors` into a single sequence — the runner
 * always pushes at least one record per loop iteration, so the union of
 * attempts' errors is the canonical list (and equals `sub.errors`,
 * which is set from `flatMap(attempts, e => e.errors)` at sub-report
 * construction time). Kept as a helper so the rendering / merge call
 * sites read declaratively.
 */
function errorsForSubReport(sub: SubReport): ReadonlyArray<Record<string, unknown>> {
  return sub.attempts.flatMap((att) => att.errors);
}

// docs/design/appendices/pre-pass-fan-out.md §7.1 / §7.2 — shared headline summaries
// used by BOTH the coordinator daemon log line AND the
// `prepass_completed` SSE payload. Keeping the shapes identical means a
// reader correlating logs and the dashboard never sees a different
// number for the same routine.

/** Headline numbers for one integration's full retry chain. */
export interface IntegrationSummary {
  key: IntegrationKey;
  status: FetchReport["status"];
  attempts: number;
  fetched: number;
  posted: number;
  duplicates: number;
  costUsd: number;
  durationMs: number;
  /** Set only when status === "failed"; first error message of final attempt. */
  finalError?: string;
}

/** Headline numbers for the whole fan-out routine. */
export interface AggregateSummary {
  status: FetchReport["status"];
  fetched: number;
  posted: number;
  duplicates: number;
  costUsd: number;
}

function attemptDurationMs(att: SubAttemptRecord): number {
  const start = Date.parse(att.startedAt);
  const end = Date.parse(att.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

function pickFinalErrorMessage(sub: SubReport): string | undefined {
  if (sub.status !== "failed") return undefined;
  const finalAttempt = sub.attempts[sub.attempts.length - 1];
  const firstError = finalAttempt?.errors?.[0];
  if (!firstError) return undefined;
  const message = firstError.message ?? firstError.reason ?? firstError.kind;
  return typeof message === "string" ? message : undefined;
}

export function summarizeIntegrationReport(sub: SubReport): IntegrationSummary {
  const costUsd = sub.attempts.reduce((sum, att) => sum + att.costUsd, 0);
  const durationMs = sub.attempts.reduce(
    (sum, att) => sum + attemptDurationMs(att),
    0,
  );
  const finalError = pickFinalErrorMessage(sub);
  return {
    key: sub.integrationKey,
    status: sub.status,
    attempts: sub.attempts.length,
    fetched: sub.fetched,
    posted: sub.posted,
    duplicates: sub.duplicates,
    costUsd,
    durationMs,
    ...(finalError ? { finalError } : {}),
  };
}

export function summarizeFetchReport(report: FetchReport): AggregateSummary {
  const perIntegration = report.perIntegration ?? [];
  const costUsd = perIntegration.reduce(
    (sum, sub) => sum + sub.attempts.reduce((s, att) => s + att.costUsd, 0),
    0,
  );
  return {
    status: report.status,
    fetched: report.fetched,
    posted: report.posted,
    duplicates: report.duplicates,
    costUsd,
  };
}

/**
 * Merge fan-out sub-reports into a single `FetchReport` + the rendered
 * `<fetch_report>` XML block the parent routine sees. §4.5.
 *
 *  - Counts (`fetched`, `posted`, `duplicates`): arithmetic sum.
 *  - `errors`: concatenation, each error tagged with
 *    `integration: <key>` (and the per-attempt rows already carry
 *    `attempt: <n>` via the runner's per-attempt error-recording —
 *    `mergeSubReports` does not invent annotations beyond `integration`).
 *  - `status`: `aggregateFanOutStatus`.
 *  - `failureReason`: only when aggregate is `failed`; one-line summary
 *    listing the failed integrations and their attempt counts.
 *  - `perIntegration`: sorted by `INTEGRATION_KEYS` order regardless of
 *    completion order (deterministic — §4.6).
 *
 * Pure function: no side effects, no DB / clock dependencies.
 */
export function mergeSubReports(
  subReports: readonly SubReport[],
  routine: RoutineWindowKey | string,
  agentDay: string,
): { report: FetchReport; block: string } {
  // Deterministic ordering by INTEGRATION_KEYS enumeration order so the
  // block is stable across runs regardless of which sub-session
  // finished first.
  const ordered = INTEGRATION_KEYS
    .map((k) => subReports.find((r) => r.integrationKey === k))
    .filter((r): r is SubReport => r !== undefined);
  // Defensive — preserve any non-canonical keys at the tail rather
  // than dropping them. Today every SubReport's integrationKey comes
  // from the canonical enum, but a future key added to the registry
  // without the catalog catching up would otherwise be silently
  // suppressed.
  for (const r of subReports) {
    if (!ordered.includes(r)) ordered.push(r);
  }

  let fetched = 0;
  let posted = 0;
  let duplicates = 0;
  const errors: Record<string, unknown>[] = [];
  for (const sub of ordered) {
    fetched += sub.fetched;
    posted += sub.posted;
    duplicates += sub.duplicates;
    for (const err of errorsForSubReport(sub)) {
      errors.push({ ...err, integration: sub.integrationKey });
    }
  }

  const status = aggregateFanOutStatus(ordered);
  let failureReason: string | undefined;
  if (status === "failed") {
    const failedSummaries = ordered
      .filter((r) => r.status === "failed")
      .map((r) => `${r.integrationKey} (${r.attempts.length} attempts)`);
    failureReason = failedSummaries.length > 0
      ? `${failedSummaries.length} integrations failed: ${failedSummaries.join(", ")}`
      : "all sub-sessions failed";
  }

  const report: FetchReport = {
    status,
    fetched,
    posted,
    duplicates,
    errors,
    skipped: status === "skipped",
    ...(failureReason !== undefined ? { failureReason } : {}),
    perIntegration: ordered,
  };

  // Render: open/close come from a `renderFetchReportBlock`-shaped
  // header line; body interleaves the per-integration children. We
  // emit a fresh string rather than calling `renderFetchReportBlock`
  // because the aggregated block carries `<integration>` children that
  // the short-circuit (skipped / failed) blocks emitted by
  // `renderFetchReportBlock` do not — keeping the two render paths
  // explicit avoids cross-contaminating their shapes.
  const routineAttr = routine.replace(/^routine\./, "");
  const headerAttrs = [
    `routine="${xmlEscape(routineAttr)}"`,
    `agent_day="${xmlEscape(agentDay)}"`,
    `status="${xmlEscape(status)}"`,
    `fetched="${fetched}"`,
    `posted="${posted}"`,
    `duplicates="${duplicates}"`,
  ];
  const lines: string[] = [`<fetch_report ${headerAttrs.join(" ")}>`];
  if (failureReason !== undefined) {
    lines.push(`  <failure>${xmlEscape(failureReason)}</failure>`);
  }
  lines.push(...renderPerIntegrationLines(ordered));
  lines.push("</fetch_report>");
  return { report, block: lines.join("\n") };
}

interface BudgetReservation {
  ok: boolean;
  remaining: number;
  estimateUsd: number;
}

/**
 * Race-free local budget guard for one fan-out coordinator. Reservations
 * mutate a separate `reservedUsd` bucket before async work starts; commit
 * releases that reservation and records the measured spend.
 */
class FanOutBudgetGuard {
  private reservedUsd = 0;
  private spentUsd = 0;

  constructor(private readonly capUsd: number) {}

  reserve(estimateUsd: number): BudgetReservation {
    // Defensive normalisation: a non-finite estimate (NaN / undefined coerced
    // through Math.max) would poison `reservedUsd` permanently — every
    // subsequent reserve() would arithmetic-NaN and report `false` for the
    // headroom check. The binding contract today guarantees a finite number,
    // but the guard is one strict layer below where a malformed config or a
    // future backend shape could leak through.
    const estimate = Number.isFinite(estimateUsd)
      ? Math.max(0, estimateUsd)
      : 0;
    if (!Number.isFinite(this.capUsd)) {
      return { ok: true, remaining: Number.POSITIVE_INFINITY, estimateUsd: estimate };
    }
    const remaining = this.capUsd - this.spentUsd - this.reservedUsd;
    if (estimate > remaining) {
      return { ok: false, remaining: Math.max(0, remaining), estimateUsd: estimate };
    }
    this.reservedUsd += estimate;
    return {
      ok: true,
      remaining: Math.max(0, this.capUsd - this.spentUsd - this.reservedUsd),
      estimateUsd: estimate,
    };
  }

  commit(reservation: BudgetReservation, actualUsd: number): void {
    if (!reservation.ok) return;
    this.reservedUsd = Math.max(0, this.reservedUsd - reservation.estimateUsd);
    // Same defensive guard as reserve() — NaN actualUsd from a misbehaving
    // backend would otherwise corrupt the spend counter and silently disable
    // the cap for the remainder of the routine.
    if (Number.isFinite(actualUsd)) {
      this.spentUsd += Math.max(0, actualUsd);
    }
  }

  get spent(): number {
    return this.spentUsd;
  }
}

interface FanOutPlanContext {
  key: RoutineWindowKey;
  agentDay: string;
  placeholder: RoutineEvent;
  integrationsSnapshot: Partial<Record<IntegrationKey, IntegrationState>>;
  subPlans: readonly AcquisitionSubPlan[];
  /**
   * Per-attempt re-plan needs the original accounts + timestamps so a
   * mid-loop binding swap (escalation tier or §5 BackendQuotaError
   * fallback) can re-derive the sub-plan against the CURRENT backend
   * without recomputing windows / advancing `now`. Snapshot semantics:
   * accounts and timestamps are captured ONCE at run() entry and
   * threaded through every attempt — same TOCTOU contract as
   * `integrationsSnapshot`.
   */
  accounts: readonly AcquisitionAccount[];
  timestamps: AcquisitionTimestamps;
  /**
   * PREPASS_COST_REDUCTION_PLAN.md N3 — (window × integration) cells the
   * plan assembly dropped (no binding, disabled, no catalog query, no
   * accounts). Surfaced as `skipped` audit rows by `logPlanAssemblyDrops`
   * so the drops stop vanishing without a trace.
   */
  drops: readonly AcquisitionPlanDrop[];
}

interface FanOutRunInput {
  key: RoutineWindowKey;
  agentDay: string;
  parentEvent: Event;
  subPlans: readonly AcquisitionSubPlan[];
  integrationsSnapshot: Partial<Record<IntegrationKey, IntegrationState>>;
  accounts: readonly AcquisitionAccount[];
  timestamps: AcquisitionTimestamps;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithConcurrency<T>(
  tasks: readonly (() => Promise<T>)[],
  concurrency: number | null,
): Promise<T[]> {
  if (tasks.length === 0) return [];
  if (concurrency === null || concurrency >= tasks.length) {
    return Promise.all(tasks.map((task) => task()));
  }

  const limit = Math.max(1, Math.trunc(concurrency));
  const results = new Array<T>(tasks.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]!();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * PREPASS_COST_REDUCTION_PLAN.md N1 — total spend recovered from a
 * fan-out execute throw. The router can wrap up to two backend failures
 * (main + fallback, both possibly billed) in a
 * `BackendRouterHandledError`; sum across the distinct failures so the
 * budget guards and the attempt record reflect everything the provider
 * charged for the attempt.
 */
interface RecoveredFailureSpend {
  costUsd: number;
  numTurns: number;
  costSource: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  } | null;
}

function recoverRouterErrorSpend(error: unknown): RecoveredFailureSpend | null {
  const failures: unknown[] = [];
  if (error instanceof BackendRouterHandledError) {
    failures.push(error.mainFailure);
    if (error.fallbackFailure && error.fallbackFailure !== error.mainFailure) {
      failures.push(error.fallbackFailure);
    }
    if (error.cause && !failures.includes(error.cause)) {
      failures.push(error.cause);
    }
  } else {
    failures.push(error);
  }
  let found = false;
  let costUsd = 0;
  let numTurns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;
  let costSource: string | null = null;
  for (const failure of failures) {
    const spend = extractBackendSpend(failure);
    if (!spend) continue;
    found = true;
    costUsd += spend.costUsd;
    numTurns += spend.numTurns;
    inputTokens += spend.usage.inputTokens;
    outputTokens += spend.usage.outputTokens;
    cacheCreationInputTokens += spend.usage.cacheCreationInputTokens;
    cacheReadInputTokens += spend.usage.cacheReadInputTokens;
    costSource = costSource ?? spend.costSource ?? null;
  }
  if (!found) return null;
  return {
    costUsd,
    numTurns,
    costSource,
    usage: {
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
    },
  };
}

/**
 * Unwrap a fan-out execute throw into the individual backend failures
 * behind it. A `BackendRouterHandledError` carries the main failure plus
 * an optional distinct fallback failure; anything else (a raw backend
 * failure, a plain Error) is returned as a single-element list. The
 * `is*RouterError` classifiers below `.every()` over this so a mixed
 * fallback (main hit its cap, fallback timed out) is NOT treated as a
 * pure hard-stop.
 */
function routerBackendFailures(error: unknown): unknown[] {
  return error instanceof BackendRouterHandledError
    ? [
        error.mainFailure,
        ...(error.fallbackFailure && error.fallbackFailure !== error.mainFailure
          ? [error.fallbackFailure]
          : []),
      ]
    : [error];
}

/**
 * FETCH_WINDOW_TURN_LIMIT_FIX_PLAN.md P1.2 — true when EVERY backend
 * attempt behind a fan-out execute throw was stopped by its max-turns
 * envelope (`BackendDecisiveFailure(kind="max_turns")`). A retry
 * re-dispatches the identical sub-plan under the identical envelope, so
 * such a failure is deterministic and the attempt record is stamped
 * `kind:"turn-limit"` instead of the generic `agent-execute-failed` —
 * `defaultRetryDecision` then gives it one widened retry, then stops.
 * When a fallback backend failed for a DIFFERENT reason (timeout, 5xx)
 * this returns false: a retry could still succeed via that fallback, so
 * the generic retry path keeps its shot.
 */
function isTurnLimitRouterError(error: unknown): boolean {
  return routerBackendFailures(error).every(
    (failure) =>
      failure instanceof BackendDecisiveFailure && failure.kind === "max_turns",
  );
}

/**
 * FETCH_WINDOW_TURN_LIMIT_FIX_PLAN.md P2.2 — true when EVERY backend
 * attempt behind a fan-out execute throw was stopped by the SDK's
 * `max_budget_usd` cap (`BackendQuotaError`, `originalCode ===
 * "max_budget_usd"`). Like a turn-limit kill, a budget kill terminates
 * the session before it can emit its closing JSON line, so a run that
 * durably posted observations first is factually `partial`. Mixed causes
 * (a fallback that failed differently) return false — the generic path
 * keeps its retry shot.
 */
function isBudgetLimitRouterError(error: unknown): boolean {
  return routerBackendFailures(error).every(
    (failure) =>
      failure instanceof BackendQuotaError
      && failure.originalCode === "max_budget_usd",
  );
}

/**
 * FETCH_WINDOW_TURN_LIMIT_FIX_PLAN.md P2.2 — a sub-session's ground-truth
 * ledger of what it durably posted, accumulated from the in-process
 * `submit_observations` handler across all its batches. Read after
 * `execute` returns OR throws; the source of truth on a hard-stop kill
 * where the agent's closing JSON line was never emitted.
 */
interface PrePassObservationsTally {
  fetched: number;
  posted: number;
  duplicates: number;
  /** Number of `submit_observations` calls the handler serviced. */
  batches: number;
}

// ── Runner ────────────────────────────────────────────────────────────────

export class RoutineFetchWindowRunner {
  private readonly db: Database.Database;
  private readonly config: AgentConfig;
  private readonly contextBuilder: IContextBuilder;
  private readonly agentRouter: IAgentRouter;
  private readonly audit: IAuditLogger;
  private readonly prompt: PromptAssembler;
  private readonly getActiveMailAccounts: () => readonly MailAccount[];
  private readonly getEventBroadcaster:
    | (() => { broadcastEvent: (data: unknown) => void } | null)
    | null;
  private readonly spawnGate: AutonomousSpawnGate | null;

  constructor(deps: RoutineFetchWindowRunnerDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.contextBuilder = deps.contextBuilder;
    this.agentRouter = deps.agentRouter;
    this.audit = deps.audit;
    this.prompt = deps.prompt;
    this.getActiveMailAccounts = deps.getActiveMailAccounts;
    this.getEventBroadcaster = deps.getEventBroadcaster ?? null;
    this.spawnGate = deps.spawnGate ?? null;
  }

  /**
   * Broadcast a single pre-pass progress event to the dashboard SSE
   * channel. Failure is contained — the broadcaster contract is
   * fire-and-forget and a misbehaving writer must not affect the
   * runner's return value or the parent routine's dispatch.
   *
   * Schema (default `event` SSE channel, matches existing
   * `kind: "main_backend_changed"` / `"routine_started"` pattern):
   *   { kind, routine, source, correlationId, timestamp, status? }
   * `status` is set on `prepass_completed` only and reflects the
   * FetchReport.status field (success / partial / failed / skipped).
   */
  private broadcastPrepassProgress(
    kind:
      | "prepass_started"
      | "prepass_completed"
      | "prepass_subsession_started"
      | "prepass_subsession_completed",
    parentEvent: Event,
    extra?: Record<string, unknown> & {
      status?: FetchReport["status"];
      reason?: string;
    },
  ): void {
    const broadcaster = this.getEventBroadcaster?.();
    if (!broadcaster) return;
    try {
      broadcaster.broadcastEvent({
        kind,
        routine: isRoutineEvent(parentEvent) ? parentEvent.routine : null,
        source: parentEvent.source,
        correlationId: parentEvent.correlationId,
        timestamp: new Date().toISOString(),
        ...(extra?.status ? { status: extra.status } : {}),
        ...(extra?.reason ? { reason: extra.reason } : {}),
        ...Object.fromEntries(
          Object.entries(extra ?? {}).filter(
            ([key]) => key !== "status" && key !== "reason",
          ),
        ),
      });
    } catch {
      // Intentionally silent — broadcaster failures are already logged at
      // the EventBroadcaster.broadcastNamedEvent layer. Re-logging here
      // would spam during transient SSE client churn.
    }
  }

  /**
   * Execute the pre-pass for `parentEvent`. Returns the fetch report
   * and rendered `<fetch_report>` block; callers graft the block into
   * the parent event's `event.data.fetchReportBlock` so ContextBuilder
   * injects it into the parent prompt.
   *
   * `routineKey` overrides the auto-derived window key. After the
   * variant collapse documented in
   * `docs/design/appendices/morning-routine-optimization.md`,
   * morning_routine no longer toggles to a separate
   * `routine.morning_routine_initial` — both branches share the same
   * window plan. The override seam is kept for callers that already
   * know the canonical RoutineWindowKey and want to skip the event-
   * shape derivation.
   */
  async run(
    parentEvent: Event,
    routineKey?: RoutineWindowKey,
    options?: RoutineFetchWindowRunOptions,
  ): Promise<RoutineFetchWindowResult> {
    // B2 observability — announce pre-pass entry so the dashboard can
    // render "Fetching your mail and Notion data…" as a sub-step of the
    // parent routine's `routine_started` envelope. `prepass_completed`
    // (with status) fires from the single exit point at the bottom of
    // `runImpl` via the try/finally below. Symmetric: every started
    // emit has a matching completed emit, even on the skipped paths
    // (skipping is itself information the user wants to see).
    this.broadcastPrepassProgress("prepass_started", parentEvent);
    let outcome: RoutineFetchWindowResult | undefined;
    try {
      outcome = await this.runImpl(parentEvent, routineKey, options);
      return outcome;
    } finally {
      // §7.2 — `prepass_completed` payload contract:
      //   { kind, routine, source, correlationId, timestamp, status, reason?,
      //     aggregate: {status, fetched, posted, duplicates, costUsd},
      //     perIntegration: [{key, status, attempts, fetched, posted,
      //                       duplicates, costUsd, durationMs, finalError?}] }
      // The aggregate + perIntegration arrays let the dashboard render
      // the per-integration progress card the design called for without
      // re-querying the daemon. Skipped / failed short-circuit paths
      // (no-routine-key / no-windows / empty-plan / plan-assembly-failed)
      // produce reports without `perIntegration`; in those cases the
      // aggregate still carries the headline (fetched/posted = 0,
      // costUsd = 0) and `perIntegration` is the empty array.
      const report = outcome?.report;
      const perIntegration = (report?.perIntegration ?? []).map(
        summarizeIntegrationReport,
      );
      const aggregate = report
        ? summarizeFetchReport(report)
        : undefined;
      this.broadcastPrepassProgress("prepass_completed", parentEvent, {
        status: report?.status,
        ...(report?.failureReason ? { reason: report.failureReason } : {}),
        ...(aggregate ? { aggregate } : {}),
        perIntegration,
      });
    }
  }

  private async runImpl(
    parentEvent: Event,
    routineKey?: RoutineWindowKey,
    options?: RoutineFetchWindowRunOptions,
  ): Promise<RoutineFetchWindowResult> {
    const key =
      routineKey ?? routineWindowKeyFromEvent(parentEvent);
    const agentDay = getAgentDayDateStr(
      this.config.timezone || undefined,
      this.config.dayBoundaryHour,
    );

    if (!key) {
      const report: FetchReport = {
        status: "skipped",
        fetched: 0,
        posted: 0,
        duplicates: 0,
        errors: [],
        skipped: true,
        failureReason: "no-routine-window-key",
      };
      // Surface the parent's actual event type rather than borrowing a
      // catalog entry — the report attribution would otherwise lie about
      // which routine the pre-pass was attempted for, hiding the
      // misroute behind a plausible-looking placeholder.
      const block = renderFetchReportBlock(report, {
        routine: parentEvent.type,
        agentDay,
      });
      return { report, block };
    }

    if (!routineHasWindows(key)) {
      const report: FetchReport = {
        status: "skipped",
        fetched: 0,
        posted: 0,
        duplicates: 0,
        errors: [],
        skipped: true,
      };
      const block = renderFetchReportBlock(report, { routine: key, agentDay });
      return { report, block };
    }

    let planContext: FanOutPlanContext;
    try {
      planContext = this.buildFanOutPlanContext(parentEvent, key, agentDay);
    } catch (err) {
      return this.fail(
        key,
        agentDay,
        parentEvent,
        "plan-assembly-failed",
        err,
      );
    }

    // PREPASS_COST_REDUCTION_PLAN.md N3 — surface plan-assembly drops as
    // `skipped` audit rows before the empty-plan short-circuit below, so
    // the all-cells-dropped case (the one the short-circuit hides) is
    // recorded too. Observability only — no new skip behavior.
    this.logPlanAssemblyDrops(parentEvent, key, planContext.drops);

    // HOURLY_CHECK_GATE_REDESIGN_PLAN.md §3.4 — when the caller is the
    // activity_scan coordinator, the freshness gate restricts pre-pass to
    // a subset of integrations. `integrationKeyFilter` is honoured here
    // (before fan-out) so the runner only spawns sub-sessions for stale
    // integrations.
    if (options?.integrationKeyFilter) {
      const filter = options.integrationKeyFilter;
      planContext = {
        ...planContext,
        subPlans: planContext.subPlans.filter((p) =>
          filter.has(p.integrationKey),
        ),
      };
    }

    // The acquisition plan can resolve to zero `<fetch>` rows when every
    // integration the routine touches is disabled / cross-backend-bound
    // on a connector-less integration / etc. `splitAcquisitionPlanByIntegration`
    // drops integrations with no rows, so an empty `subPlans` exactly
    // means the routine has nothing to fetch. Treat that as a skip —
    // we don't pay the cold-start to confirm the agent has nothing
    // to do.
    if (planContext.subPlans.length === 0) {
      const report: FetchReport = {
        status: "skipped",
        fetched: 0,
        posted: 0,
        duplicates: 0,
        errors: [],
        skipped: true,
        fetcherCorrelationId: planContext.placeholder.correlationId,
      };
      const block = renderFetchReportBlock(report, { routine: key, agentDay });
      logger.debug(
        {
          routine: key,
          correlationId: planContext.placeholder.correlationId,
          parentCorrelationId: parentEvent.correlationId,
        },
        "Routine fetch-window pre-pass skipped — acquisition plan empty",
      );
      return { report, block };
    }

    try {
      return await this.runFanOut({
        key,
        agentDay,
        parentEvent,
        subPlans: planContext.subPlans,
        integrationsSnapshot: planContext.integrationsSnapshot,
        accounts: planContext.accounts,
        timestamps: planContext.timestamps,
      });
    } catch (err) {
      return this.fail(key, agentDay, parentEvent, "fan-out-failed", err, {
        fetcherCorrelationId: planContext.placeholder.correlationId,
      });
    }
  }

  private buildFanOutPlanContext(
    parentEvent: Event,
    key: RoutineWindowKey,
    agentDay: string,
  ): FanOutPlanContext {
    // Resolve binding off a placeholder event so we know the session
    // backend before splitting the plan (the partial body's mode markers
    // and the per-row delegated-same / delegated-cross resolution both
    // depend on the resolved backend). The placeholder borrows the
    // parent correlationId so the empty-plan and plan-assembly-failed
    // short-circuit reports carry a stable correlation id; fan-out
    // sub-sessions get fresh ids per attempt.
    const placeholder: RoutineEvent = {
      ...createEvent({
        type: FETCH_WINDOW_EVENT_TYPE,
        source: parentEvent.source,
        priority: EventPriority.NORMAL,
        correlationId: parentEvent.correlationId,
      }),
      routine: "fetch_window",
    };
    const preBinding = this.agentRouter.resolveBinding(placeholder, {
      processKey: FETCH_WINDOW_PROCESS_KEY,
    });

    const integrationsSnapshot = readIntegrations(this.db);
    const accounts = this.collectAccounts(integrationsSnapshot);
    const timestamps = buildAcquisitionTimestamps(
      new Date(),
      this.config.timezone || undefined,
      this.config.dayBoundaryHour,
    );
    const planInput: BuildAcquisitionPlanInput = {
      routine: key,
      agentDay,
      integrations: integrationsSnapshot,
      sessionBackend: preBinding.main.backendId,
      accounts,
      timestamps,
    };
    const { subPlans, drops } = buildAcquisitionPlanAssembly(planInput);

    // Observability: surface integrations whose `<fetch>` row will spawn
    // on a backend OTHER than the pre-pass default. Per-integration
    // backend routing (resolveIntegrationBackend +
    // requestedBackendId) means these rows are NOT dropped — they spawn
    // on the integration's bound backend via the BackendRouter's
    // backend-only override path. Logged at `info` so the daemon log
    // surfaces the cross-backend fan-out shape on every routine, which
    // is the canonical signal when debugging Codex / Gemini auth issues
    // that only manifest in the pre-pass (the main routine ran on
    // claude but gmail-native sub-session is spawning on codex).
    const crossBackendNativeIntegrations = collectCrossBackendNativeIntegrations(
      key,
      integrationsSnapshot,
      preBinding.main.backendId,
    );
    if (crossBackendNativeIntegrations.length > 0) {
      logger.info(
        {
          routine: key,
          defaultSessionBackend: preBinding.main.backendId,
          crossBackendNativeIntegrations,
          parentCorrelationId: parentEvent.correlationId,
        },
        "Routine fetch-window pre-pass: native bindings will spawn on "
          + "their bound backend via per-integration backend routing "
          + "(BackendRouter.requestedBackendId override); the default "
          + "fetch_window backend will run direct / delegated / "
          + "same-backend-native rows in parallel.",
      );
    }

    return {
      key,
      agentDay,
      placeholder,
      integrationsSnapshot,
      subPlans,
      accounts,
      timestamps,
      drops,
    };
  }

  /**
   * Defensive re-derivation of the per-integration sub-plan against the
   * CURRENT attempt's binding. With per-integration backend routing in
   * place, the attempt's binding is pinned to `subPlan.requiredBackend`
   * via `BackendRouter.resolveBinding({ requestedBackendId })`, so
   * `binding.main.backendId` always equals the original plan's backend
   * and the recomputed block is bit-identical to `input.subPlan.block`
   * in production. The defensive branch is retained for two reasons:
   *
   *  1. Regression test coverage — the runner unit test mocks
   *     `resolveBinding` to return a different backend mid-loop,
   *     exercising the rebuild mechanics so a future change that
   *     re-introduces cross-backend swaps (e.g. dropping the
   *     requestedBackendId pin or extending escalation to also flip
   *     backends) cannot silently regress plan-vs-partial alignment.
   *  2. Graceful degradation — returns null when the integration is
   *     unreachable on the attempted backend; the caller logs the
   *     original sub-plan and lets the agent emit `no-surface` errors
   *     organically rather than throwing.
   *
   * Pure: snapshot inputs (`integrationsSnapshot`, `accounts`,
   * `timestamps`) are frozen at run() entry; only `sessionBackend`
   * varies across attempts. Re-derivation is cheap —
   * `splitAcquisitionPlanByIntegration` walks `ROUTINE_WINDOWS[routine]`
   * (a small constant) without I/O.
   */
  private rebuildSubPlanForBackend(
    integrationKey: IntegrationKey,
    routineKey: RoutineWindowKey,
    agentDay: string,
    sessionBackend: BackendId,
    integrationsSnapshot: Partial<Record<IntegrationKey, IntegrationState>>,
    accounts: readonly AcquisitionAccount[],
    timestamps: AcquisitionTimestamps,
  ): AcquisitionSubPlan | null {
    const subPlans = splitAcquisitionPlanByIntegration({
      routine: routineKey,
      agentDay,
      integrations: integrationsSnapshot,
      sessionBackend,
      accounts,
      timestamps,
    });
    return subPlans.find((p) => p.integrationKey === integrationKey) ?? null;
  }

  private buildRetryPolicy(): RetryPolicy {
    return {
      maxAttempts: clampInt(this.config.prePassMaxAttemptsPerIntegration, 1, 5, 3),
      backoffMs: Array.isArray(this.config.prePassBackoffMs)
        ? this.config.prePassBackoffMs
        : [1000, 2000, 4000],
      perIntegrationBudgetUsd: nonNegativeNumber(
        this.config.prePassMaxBudgetUsdPerIntegration,
        0.6,
      ),
      retryOnPartial: this.config.prePassRetryOnPartial !== false,
    };
  }

  private fanOutConcurrency(): number | null {
    const configured = this.config.prePassFanOutConcurrency;
    if (configured === null || configured === undefined) return null;
    // Cap at the integration roster size — fan-out spawns at most one
    // sub-session per IntegrationKey, so a higher concurrency cannot
    // help and a hardcoded literal would silently restrict whenever a
    // new integration descriptor is added to `INTEGRATION_KEYS`.
    return clampInt(
      configured,
      1,
      INTEGRATION_KEYS.length,
      INTEGRATION_KEYS.length,
    );
  }

  private retryEscalationTier(): ProcessModelTier | null {
    const configured = this.config.prePassRetryEscalationTier;
    return configured === "lite" || configured === "medium" || configured === "high"
      ? configured
      : null;
  }

  private async runFanOut(input: FanOutRunInput): Promise<RoutineFetchWindowResult> {
    const policy = this.buildRetryPolicy();

    // Pre-resolve each subPlan's attempt-1 binding so both budget guards
    // can be sized to fit the actual per-attempt envelopes. Without this,
    // the static defaults (perIntegrationBudgetUsd=0.6,
    // perRoutineBudgetUsd=1.5) — sized for Claude's $0.50 baseline —
    // dead-lock the pre-pass after a default-backend switch. Codex /
    // Gemini's `applyBackendBudgetFactor` scales the lite-tier envelope
    // 2.5× (e.g. `routine.fetch_window` $0.50 → $1.25), and the runner
    // rejected `integrationBudget.reserve(1.25)` against `remaining=0.6`
    // on attempt 1 with `{type:"budget-cap", remaining:0.6, attempt:1}`.
    // The cap is meant to bound retry runaway; a cap below a single
    // attempt's envelope is a misconfiguration that prevents any work.
    // Bindings that fail to resolve here are recorded as null; the
    // per-integration loop's existing binding-resolve-failed path
    // surfaces the error per attempt.
    type PreResolved = ReturnType<IAgentRouter["resolveBinding"]>;
    const preResolvedBindings = new Map<IntegrationKey, PreResolved | null>();
    let estimatedTotalUsd = 0;
    for (const subPlan of input.subPlans) {
      try {
        // Use the parentEvent as the resolver event so this pre-resolve
        // call carries no per-attempt correlationId — the inner loop
        // creates fresh fetcherEvents for the actual sub-session
        // execution. Attempt 1 inside `runOneIntegrationWithRetry`
        // REUSES this binding (skip-inner-resolve) so the net
        // resolveBinding call count is unchanged: 1 placeholder + N
        // pre-resolves + 0 attempt-1 inner + K escalation/retry inner.
        // Without that reuse, every test that asserts a call count
        // would shift by N.
        const binding = this.agentRouter.resolveBinding(input.parentEvent, {
          processKey: FETCH_WINDOW_PROCESS_KEY,
          requestedBackendId: subPlan.requiredBackend,
        });
        preResolvedBindings.set(subPlan.integrationKey, binding);
        estimatedTotalUsd += binding.main.maxBudgetUsd;
      } catch {
        preResolvedBindings.set(subPlan.integrationKey, null);
      }
    }

    const configuredGlobalCap = nonNegativeNumber(
      this.config.prePassMaxBudgetUsdPerRoutine,
      1.5,
    );
    const effectiveGlobalCap = Math.max(configuredGlobalCap, estimatedTotalUsd);
    if (effectiveGlobalCap > configuredGlobalCap) {
      logger.warn(
        {
          routine: input.key,
          configuredCap: configuredGlobalCap,
          effectiveCap: effectiveGlobalCap,
          estimatedTotalUsd,
          parentCorrelationId: input.parentEvent.correlationId,
        },
        "Routine fetch-window per-routine budget cap raised to floor at "
          + "sum of binding envelopes — configured cap would block the "
          + "first attempts. Raise prePassMaxBudgetUsdPerRoutine to "
          + "silence this warning.",
      );
    }
    const globalBudget = new FanOutBudgetGuard(effectiveGlobalCap);
    const tasks = input.subPlans.map((subPlan) => async () =>
      this.runOneIntegrationWithRetry({
        ...input,
        subPlan,
        policy,
        globalBudget,
        preResolvedBinding: preResolvedBindings.get(subPlan.integrationKey) ?? null,
      }));
    const subReports = await runWithConcurrency(tasks, this.fanOutConcurrency());
    const merged = mergeSubReports(subReports, input.key, input.agentDay);
    // §7.1 example shape — `integrations: [{key, status, attempts, fetched,
    // posted, duplicates, durationMs, costUsd, finalError?}]` plus an
    // `aggregate` headline. Reuse the helpers so the SSE
    // `prepass_completed` payload (in `run()` below) and this log line
    // never disagree on the per-integration numbers.
    const integrations = subReports.map(summarizeIntegrationReport);
    logger.info(
      {
        routine: input.key,
        parentCorrelationId: input.parentEvent.correlationId,
        integrations,
        aggregate: {
          ...summarizeFetchReport(merged.report),
          // Use the live `globalBudget.spent` counter here so the daemon
          // log line is the canonical readout for "what the global cap
          // saw" — the §7.2 SSE payload mirrors `summarizeFetchReport`'s
          // sum-over-attempts. Today the two converge (every committed
          // cost is also reflected in an attempt's `costUsd`), but tying
          // the log line to the guard means a future divergence (e.g. a
          // commit path that bypasses the per-attempt record) surfaces
          // here instead of going silent.
          costUsd: globalBudget.spent,
        },
      },
      "Routine fetch-window fan-out completed",
    );
    return merged;
  }

  private async runOneIntegrationWithRetry(input: FanOutRunInput & {
    subPlan: AcquisitionSubPlan;
    policy: RetryPolicy;
    globalBudget: FanOutBudgetGuard;
    preResolvedBinding: ReturnType<IAgentRouter["resolveBinding"]> | null;
  }): Promise<SubReport> {
    // PREPASS_COST_REDUCTION_PLAN.md N2 — offline/auth spawn gate, per
    // sub-session because each integration can route to a different
    // backend (`requiredBackend`). Skips only when EVERY candidate
    // backend is non-viable; the DNS verdict is cached (~60s) inside the
    // gate so an N-integration fan-out costs one lookup per host.
    // Freshness (`pre_pass_last_run:<key>`) is untouched by construction
    // — only `success` writes it — so the next tick retries.
    const gateDecision = await this.evaluateSpawnGate(input);
    if (gateDecision?.skip) {
      return this.spawnGateSkippedSubReport(input, gateDecision);
    }

    const attempts: SubAttemptRecord[] = [];
    // Per-integration budget cap is enforced at TWO complementary layers,
    // BOTH driven by `policy.perIntegrationBudgetUsd`:
    //   (1) `integrationBudget` (this guard) — HARD pre-attempt reservation
    //       against the binding's `max_budget_usd` envelope. Trips before
    //       the next SDK call when the upper bound on the next attempt
    //       would exceed the cap. Surfaces as `{type:"budget-cap"}`.
    //   (2) `defaultRetryDecision`'s cumulative-cost branch — SOFT
    //       post-attempt check against actual `costUsd` summed across
    //       priorAttempts. Surfaces as `decision.reason="per-integration-budget-cap"`.
    // Layer (1) is the pessimistic guard (envelope ≥ actual); layer (2)
    // catches the case where individual attempts cost more than expected.
    // Either fires depending on the cost shape — both are intentional.
    //
    // The cap is floored at the pre-resolved binding's per-attempt
    // envelope so attempt 1 always fits. Same rationale as the
    // globalBudget floor in `runFanOut`: a static cap below a single
    // attempt's envelope (e.g. the 0.6 default vs Codex lite's $1.25)
    // would dead-lock every integration on attempt 1; the cap is meant
    // to bound retry runaway, not block the first attempt. The cloned
    // policy threads the same floor through `defaultRetryDecision`'s
    // soft cumulative-cost check so the two layers stay aligned.
    const floorBudget = input.preResolvedBinding?.main.maxBudgetUsd ?? 0;
    const effectivePolicy: RetryPolicy =
      floorBudget > input.policy.perIntegrationBudgetUsd
        ? { ...input.policy, perIntegrationBudgetUsd: floorBudget }
        : input.policy;
    const integrationBudget = new FanOutBudgetGuard(
      effectivePolicy.perIntegrationBudgetUsd,
    );
    const retryOn = effectivePolicy.retryOn ?? defaultRetryDecision;
    const escalationTier = this.retryEscalationTier();
    let retriesExhausted = false;

    for (let attempt = 1; attempt <= input.policy.maxAttempts; attempt++) {
      const startedAt = new Date().toISOString();
      const fetcherEvent = this.createFanOutFetcherEvent(
        input.parentEvent,
        input.key,
        input.subPlan,
        attempt,
        input.policy.maxAttempts,
      );
      const requestedTier =
        attempt > 1 && escalationTier !== null ? escalationTier : undefined;

      // Symmetry guarantee: every iteration emits exactly one
      // `prepass_subsession_started` BEFORE any work, and exactly one
      // `prepass_subsession_completed` after the attempt's outcome is
      // recorded — including the binding-resolve-failed and budget-cap
      // short-circuits, which previously were invisible to the dashboard.
      this.emitSubSessionStarted(input, fetcherEvent.correlationId, attempt);

      let binding: ReturnType<IAgentRouter["resolveBinding"]>;
      try {
        // Per-integration backend routing. `subPlan.requiredBackend`
        // equals the integration's `nativeBackend` (native), the
        // `delegatedBackend` for userManagedConnector descriptors, or
        // the configured fetch_window default backend otherwise.
        // Passing `requestedBackendId` triggers BackendRouter's
        // backend-only override branch (added alongside this routing
        // path), which preserves the `routine.fetch_window` process
        // tier + envelope while spawning the sub-session on the
        // integration's actual backend. This is the structural fix for
        // the pre-existing silent-drop when a `native` binding's
        // `nativeBackend` differed from the configured fetch_window
        // backend.
        //
        // Fallback is dropped on backend-only override (router
        // contract); the `routine.fetch_window` seed in db/schema.ts
        // already ships without a fallback, so the override has no
        // additional cost in the default deployment.
        //
        // Attempt 1 reuses the binding that `runFanOut` pre-resolved to
        // size the budget guards — same args (no `requestedTier`,
        // `requestedBackendId=subPlan.requiredBackend`), so resolving
        // again would just spend an extra router call without changing
        // the binding. Attempts > 1 resolve fresh so escalation-tier
        // hints can flip the model. Pre-resolve failures (`null`) fall
        // through to a fresh attempt-1 resolve, which surfaces the same
        // `binding-resolve-failed` error path as before.
        if (attempt === 1 && input.preResolvedBinding) {
          binding = input.preResolvedBinding;
        } else {
          binding = this.agentRouter.resolveBinding(fetcherEvent, {
            processKey: FETCH_WINDOW_PROCESS_KEY,
            ...(requestedTier ? { requestedTier } : {}),
            requestedBackendId: input.subPlan.requiredBackend,
          });
        }
      } catch (err) {
        const record = this.failedAttemptRecord(
          attempt,
          fetcherEvent.correlationId,
          startedAt,
          "binding-resolve-failed",
          err,
        );
        attempts.push(record);
        const decision = retryOn(record, attempt, effectivePolicy, attempts.slice(0, -1));
        this.logFanOutFailure(input, fetcherEvent, record, decision, {
          failureKind: "binding-resolve-failed",
          err,
          startedAt,
        });
        this.emitSubSessionCompleted(input, fetcherEvent.correlationId, attempt, record, decision);
        if (!decision.retry) {
          retriesExhausted = this.didExhaustRetries(record, decision, input.policy);
          break;
        }
        await sleep(this.backoffForAttempt(input.policy, attempt));
        continue;
      }

      // §5 BackendQuotaError row + §4.4 retryEscalationTier — the
      // pre-pass plan was originally rendered against
      // `preBinding.main.backendId` (set in `buildFanOutPlanContext`).
      // If THIS attempt's binding picks a different backend (escalation
      // tier flipped main, or the resolver picked a different default
      // for a higher tier), re-derive the per-integration sub-plan
      // against the current backend so the plan's `<fetch mode="…">`
      // attributes match the partial body's remaining mode-branch
      // (`renderPartialForFanOut` filters the partial against the
      // CURRENT backend; the plan must follow). The recompute uses the
      // frozen accounts + timestamps from `buildFanOutPlanContext` so
      // the windows don't drift mid-routine.
      const livePlan = this.rebuildSubPlanForBackend(
        input.subPlan.integrationKey,
        input.key,
        input.agentDay,
        binding.main.backendId,
        input.integrationsSnapshot,
        input.accounts,
        input.timestamps,
      );
      // Native-mode integrations bound to a specific backend can become
      // unreachable after a cross-backend binding swap (the new backend
      // has no native connector for this integration). When that
      // happens, `livePlan` is null — fall back to the original
      // sub-plan so the agent still iterates the rows and surfaces
      // `no-surface` errors organically. The retry policy will then
      // either escalate or short-circuit per the existing matrix.
      if (livePlan && livePlan.block !== input.subPlan.block) {
        // Mutate the per-attempt fetcher event so ContextBuilder injects
        // the freshly-rendered plan block instead of the stale one.
        // Cheap — the event is a one-shot per attempt.
        (fetcherEvent.data as Record<string, unknown>).acquisitionPlanBlock
          = livePlan.block;
      }

      const estimateUsd = binding.main.maxBudgetUsd;
      const globalReservation = input.globalBudget.reserve(estimateUsd);
      if (!globalReservation.ok) {
        const record = this.budgetCapAttemptRecord(
          attempt,
          fetcherEvent.correlationId,
          startedAt,
          "global-budget-cap",
          globalReservation.remaining,
        );
        attempts.push(record);
        const decision: RetryDecision = {
          retry: false,
          reason: "global-budget-cap",
        };
        this.logFanOutFailure(input, fetcherEvent, record, decision, {
          failureKind: "global-budget-cap",
          binding: binding.main,
          startedAt,
        });
        this.emitSubSessionCompleted(input, fetcherEvent.correlationId, attempt, record, decision);
        retriesExhausted = true;
        break;
      }
      const integrationReservation = integrationBudget.reserve(estimateUsd);
      if (!integrationReservation.ok) {
        input.globalBudget.commit(globalReservation, 0);
        const record = this.budgetCapAttemptRecord(
          attempt,
          fetcherEvent.correlationId,
          startedAt,
          "budget-cap",
          integrationReservation.remaining,
        );
        attempts.push(record);
        const decision: RetryDecision = {
          retry: false,
          reason: "budget-cap",
        };
        this.logFanOutFailure(input, fetcherEvent, record, decision, {
          failureKind: "budget-cap",
          binding: binding.main,
          startedAt,
        });
        this.emitSubSessionCompleted(input, fetcherEvent.correlationId, attempt, record, decision);
        retriesExhausted = true;
        break;
      }

      let context: string;
      try {
        context = await this.contextBuilder.build(fetcherEvent);
      } catch (err) {
        input.globalBudget.commit(globalReservation, 0);
        integrationBudget.commit(integrationReservation, 0);
        const record = this.failedAttemptRecord(
          attempt,
          fetcherEvent.correlationId,
          startedAt,
          "context-build-failed",
          err,
        );
        attempts.push(record);
        const decision = retryOn(record, attempt, effectivePolicy, attempts.slice(0, -1));
        this.logFanOutFailure(input, fetcherEvent, record, decision, {
          failureKind: "context-build-failed",
          err,
          binding: binding.main,
          startedAt,
        });
        this.emitSubSessionCompleted(input, fetcherEvent.correlationId, attempt, record, decision);
        if (!decision.retry) {
          retriesExhausted = this.didExhaustRetries(record, decision, input.policy);
          break;
        }
        await sleep(this.backoffForAttempt(input.policy, attempt));
        continue;
      }

      let result: AgentResult | null = null;
      let executeErr: unknown = undefined;
      let record: SubAttemptRecord;
      // Audit `failureKind` for the throw path. Defaults to the generic
      // execute-failure label; the P2.2 synthesis branch overrides it with
      // the specific `${killKind}-partial` marker so the error feed
      // distinguishes "killed but salvaged N" from a total loss.
      let throwFailureKind = "agent-execute-failed";
      // FETCH_WINDOW_TURN_LIMIT_FIX_PLAN.md P3.2 — the turn envelope this
      // attempt is dispatched under. Hoisted to the loop-iteration scope
      // (default = the DB-resolved seed) so both the success and the
      // failure audit rows carry the DENOMINATOR the dashboard renders as
      // "turn limit (numTurns/maxTurns)" and the operator can read headroom
      // on healthy runs too. The try below overwrites it with the P2.1
      // dynamic / widened value once computed; if the try throws before that
      // point, the seed is the honest cap that was in effect.
      let envelopeMaxTurns = binding.main.maxTurns;
      // FETCH_WINDOW_TURN_LIMIT_FIX_PLAN.md P2.2 — ground-truth ledger of
      // what THIS attempt durably posted, fed by the in-process
      // `submit_observations` handler (Claude only; a no-op on other
      // backends). Read in the catch to synthesise a `partial` on a
      // hard-stop kill instead of discarding the progress as `failed`.
      const observationsTally: PrePassObservationsTally = {
        fetched: 0,
        posted: 0,
        duplicates: 0,
        batches: 0,
      };
      const observationsSink: PrePassObservationsSink = (delta) => {
        observationsTally.fetched += delta.fetched;
        observationsTally.posted += delta.posted;
        observationsTally.duplicates += delta.duplicates;
        observationsTally.batches += 1;
      };
      try {
        const priorAttemptHintBlock = buildPriorAttemptHintBlock(
          attempts,
          input.subPlan.integrationKey,
        );
        // docs/design/appendices/pre-pass-fan-out.md §4.2 — every sub-session sees the
        // `routine.fetch_window` task-flow body with `{integration_partial}`
        // substituted for the one partial its integrationKey owns. The
        // integrations snapshot fed to both the partial's mode filter
        // and the composed allowed-tools list is sliced to a single key
        // so the sub-session cannot see — or call MCP tools for — any
        // other integration's surface (defense-in-depth on top of the
        // prompt isolation).
        const slicedIntegrations = this.sliceIntegrationSnapshot(
          input.integrationsSnapshot,
          input.subPlan.integrationKey,
        );
        const partialFilename = getIntegrationDescriptor(
          input.subPlan.integrationKey,
        ).prePassPartial;
        if (!partialFilename) {
          throw new Error(
            `Integration "${input.subPlan.integrationKey}" has no prePassPartial descriptor field — cannot dispatch fan-out sub-session`,
          );
        }
        const reassemblePrompt = (bid: BackendId): string => {
          const assembled = this.prompt.assemble(
            FETCH_WINDOW_EVENT_TYPE,
            FETCH_WINDOW_PROCESS_KEY,
            bid,
          );
          // Re-render the partial against the resolved backend each
          // time the SDK reassembles (e.g. on quota-driven fallback).
          // Mode markers inside the partial depend on the chosen
          // backend, so a cross-backend fallback must regenerate the
          // body to match the new MCP surface — matches the failure
          // mode catalogue's BackendQuotaError row.
          const partialBody = renderPartialForFanOut(
            partialFilename,
            slicedIntegrations,
            bid,
          );
          const filled = assembled.replaceAll(
            FETCH_WINDOW_INTEGRATION_PARTIAL_PLACEHOLDER,
            partialBody,
          );
          return priorAttemptHintBlock
            ? `${priorAttemptHintBlock}\n\n${filled}`
            : filled;
        };
        const prompt = reassemblePrompt(binding.main.backendId);
        const allowedToolsOverride = composePrePassAllowedTools(
          this.config.apiPort,
          slicedIntegrations,
          binding.main.backendId,
        );

        // FETCH_WINDOW_TURN_LIMIT_FIX_PLAN.md P2.1 — size THIS attempt's turn
        // envelope from the sub-plan's fetch-row count and clone the binding
        // so the router's `execute` reads the adjusted `maxTurns` (no new
        // router API — it already reads `binding.main.maxTurns`). The DB
        // envelope is the floor, so operator PUTs and the P1.3 default are
        // preserved; the budget envelope is untouched. A turn-limit kill on
        // a PRIOR attempt widens this attempt's envelope ×1.5 for its one
        // sanctioned retry (`RETRY_REASONS.TURN_LIMIT_WIDEN`).
        const seedMaxTurns = binding.main.maxTurns;
        const priorTurnLimit = attempts.some((att) =>
          att.errors.some(
            (e) =>
              e.type === "pre-pass-failed"
              && e.kind === TURN_LIMIT_FAILURE_KIND,
          ),
        );
        const baseMaxTurns = computePrePassMaxTurns(
          seedMaxTurns,
          input.subPlan.fetchRowCount,
        );
        envelopeMaxTurns = priorTurnLimit
          ? widenPrePassMaxTurns(baseMaxTurns, seedMaxTurns)
          : baseMaxTurns;
        const executeBinding =
          envelopeMaxTurns === binding.main.maxTurns
            ? binding
            : {
                ...binding,
                main: { ...binding.main, maxTurns: envelopeMaxTurns },
              };

        result = await this.agentRouter.execute({
          prompt,
          context,
          event: fetcherEvent,
          processKey: FETCH_WINDOW_PROCESS_KEY,
          preResolvedBinding: executeBinding,
          reassemblePrompt,
          allowedToolsOverride,
          observationsSink,
        });
        input.globalBudget.commit(globalReservation, result.costUsd);
        integrationBudget.commit(integrationReservation, result.costUsd);
        record = this.attemptRecordFromResult(attempt, fetcherEvent, startedAt, result);
      } catch (err) {
        // PREPASS_COST_REDUCTION_PLAN.md N1 — the throw path can still
        // have billed the provider (post-hoc budget kill, partial stream
        // abort). Recover the spend the backend cores attached so the
        // budget guards account for real consumption and the attempt
        // record / audit row carry the cost instead of a silent 0.
        const failureSpend = recoverRouterErrorSpend(err);
        input.globalBudget.commit(globalReservation, failureSpend?.costUsd ?? 0);
        integrationBudget.commit(
          integrationReservation,
          failureSpend?.costUsd ?? 0,
        );
        executeErr = err;
        const turnLimited = isTurnLimitRouterError(err);
        const budgetLimited = isBudgetLimitRouterError(err);
        // FETCH_WINDOW_TURN_LIMIT_FIX_PLAN.md P2.2 — server-side report
        // synthesis. When a hard-stop kill (max-turns or budget) cut the
        // session short AFTER it durably posted observations, the honest
        // outcome is `partial`, not `failed`: the observations are already
        // committed (in-process MCP write), so the agent's un-emitted
        // closing JSON line is a cross-check we no longer depend on (R4/R5).
        // The runner's own tally is ground truth. The retry matrix then
        // reads it as partial-with-progress → no retry: a re-fetch would
        // re-do the same work the envelope already capped, and server-side
        // dedup would absorb the re-posts anyway.
        if (
          (turnLimited || budgetLimited)
          && observationsTally.posted > 0
        ) {
          const killKind = turnLimited ? "turn-limit" : "budget-limit";
          record = this.synthesizedPartialRecord(
            attempt,
            fetcherEvent.correlationId,
            startedAt,
            observationsTally,
            failureSpend,
            err,
            killKind,
          );
          throwFailureKind = `${killKind}-partial`;
        } else {
          // FETCH_WINDOW_TURN_LIMIT_FIX_PLAN.md P3.2 — stamp the audit
          // `failureKind` with the specific turn-limit reason instead of the
          // generic `agent-execute-failed`, so the dashboard categorises a
          // total-loss turn-limit kill as "turn limit" rather than "Other" (the
          // pre-P1 `other_non_retryable` symptom the operator saw). Mirrors the
          // `turn-limit-partial` label the salvaged-partial branch above sets.
          // Scoped to turn-limit deliberately: a budget kill keeps
          // `agent-execute-failed` (it's the intended stop-loss, not a bug, and
          // has no dedicated dashboard bucket). The RECORD's error kind (below)
          // stays `turn-limit` / `agent-execute-failed` — that vocabulary drives
          // the retry matrix (`isTurnLimitError`), independent of this
          // display-only failureKind.
          if (turnLimited) throwFailureKind = "turn-limit";
          record = this.failedAttemptRecord(
            attempt,
            fetcherEvent.correlationId,
            startedAt,
            // FETCH_WINDOW_TURN_LIMIT_FIX_PLAN.md P1.2 / P2.1 — a max-turns
            // kill (that posted nothing) is stamped so `defaultRetryDecision`
            // gives it exactly ONE widened retry (`TURN_LIMIT_WIDEN`) and
            // then stops, instead of burning every attempt at the same size.
            turnLimited ? TURN_LIMIT_FAILURE_KIND : "agent-execute-failed",
            err,
            failureSpend,
          );
        }
      }

      attempts.push(record);
      const decision = retryOn(record, attempt, input.policy, attempts.slice(0, -1));
      if (result) {
        this.logFanOutAttempt(
          input,
          fetcherEvent,
          result,
          record,
          decision,
          binding.main.backendId,
          envelopeMaxTurns,
        );
      } else {
        // §7.1 — when the SDK actually invoked a backend session and
        // that session threw (timeout, BackendQuotaError, transport
        // failure, …) the audit feed must reflect it. Successful
        // attempts log via `logFanOutAttempt` with the AgentResult; the
        // throw path has no result, so we route through
        // `logFanOutFailure` which carries the same `detail.prePass`
        // payload the metrics aggregator filters on (preserving the
        // failure on `/metrics/pre-pass` alongside the other four
        // pre-execute failure modes).
        this.logFanOutFailure(input, fetcherEvent, record, decision, {
          failureKind: throwFailureKind,
          err: executeErr,
          binding: binding.main,
          startedAt,
          spend: recoverRouterErrorSpend(executeErr),
          maxTurns: envelopeMaxTurns,
        });
      }
      this.emitSubSessionCompleted(input, fetcherEvent.correlationId, attempt, record, decision);

      if (!decision.retry) {
        retriesExhausted = this.didExhaustRetries(record, decision, input.policy);
        break;
      }
      await sleep(this.backoffForAttempt(input.policy, attempt));
    }

    if (attempts.length === 0) {
      const now = new Date().toISOString();
      attempts.push({
        attempt: 0,
        status: "skipped",
        fetched: 0,
        posted: 0,
        duplicates: 0,
        errors: [],
        fetcherCorrelationId: input.parentEvent.correlationId,
        startedAt: now,
        endedAt: now,
        costUsd: 0,
        numTurns: 0,
      });
    }

    const final = attempts[attempts.length - 1]!;
    const allErrors = attempts.flatMap((att) => att.errors);

    // HOURLY_CHECK_GATE_REDESIGN_PLAN.md §3.4 — record the freshness
    // timestamp on every successful integration completion. The
    // coordinator's `harvestForGate` reads this key to suppress
    // redundant pre-pass spawns within the configured freshness window
    // (default 30 min). Shared across morning_routine / activity_scan /
    // evening_review / weekly_review / today_refresh by construction:
    // the runner has no notion of parent routine.
    //
    // `success` only. `partial` and `failed` do NOT update the key so a
    // partial fetch does not suppress the next tick's retry — the gate
    // gets a fresh shot. `skipped` (no work to do) is also excluded;
    // there is no fetched data backing the timestamp.
    if (final.status === "success") {
      try {
        writeRuntimeState(
          this.db,
          prePassLastRunRuntimeStateKey(input.subPlan.integrationKey),
          new Date().toISOString(),
        );
      } catch (err) {
        logger.warn(
          {
            err,
            routine: input.key,
            integrationKey: input.subPlan.integrationKey,
          },
          "Failed to persist pre_pass_last_run runtime_state; freshness gate degraded",
        );
      }
    }

    return {
      ...final,
      errors: allErrors.length > 0 ? allErrors : final.errors,
      integrationKey: input.subPlan.integrationKey,
      attempts,
      retriesExhausted,
    };
  }

  /**
   * Emit `prepass_subsession_started` for an attempt that is about to run.
   * Called at the TOP of every loop iteration so the started/completed
   * pair is symmetric across all paths — including binding-resolve-failed
   * and budget-cap short-circuits, which previously emitted neither.
   */
  private emitSubSessionStarted(
    input: FanOutRunInput & { subPlan: AcquisitionSubPlan; policy: RetryPolicy },
    fetcherCorrelationId: string,
    attempt: number,
  ): void {
    this.broadcastPrepassProgress("prepass_subsession_started", input.parentEvent, {
      routine: input.key,
      integrationKey: input.subPlan.integrationKey,
      attempt,
      maxAttempts: input.policy.maxAttempts,
      fetcherCorrelationId,
      parentCorrelationId: input.parentEvent.correlationId,
    });
  }

  /**
   * Emit `prepass_subsession_completed` for an attempt that has just
   * recorded its outcome. Mirror of `emitSubSessionStarted` — invoked
   * once per iteration after every code path that pushes a record
   * (success, parse error, agent throw, binding-resolve-failed,
   * global-budget-cap, per-integration-budget-cap).
   */
  private emitSubSessionCompleted(
    input: FanOutRunInput & { subPlan: AcquisitionSubPlan; policy: RetryPolicy },
    fetcherCorrelationId: string,
    attempt: number,
    record: SubAttemptRecord,
    decision: RetryDecision,
  ): void {
    this.broadcastPrepassProgress("prepass_subsession_completed", input.parentEvent, {
      routine: input.key,
      integrationKey: input.subPlan.integrationKey,
      attempt,
      maxAttempts: input.policy.maxAttempts,
      fetcherCorrelationId,
      parentCorrelationId: input.parentEvent.correlationId,
      status: record.status,
      fetched: record.fetched,
      posted: record.posted,
      duplicates: record.duplicates,
      willRetry: decision.retry,
      retryReason: decision.reason,
    });
  }

  private createFanOutFetcherEvent(
    parentEvent: Event,
    key: RoutineWindowKey,
    subPlan: AcquisitionSubPlan,
    attempt: number,
    maxAttempts: number,
  ): RoutineEvent {
    return {
      ...createEvent({
        type: FETCH_WINDOW_EVENT_TYPE,
        source: parentEvent.source,
        priority: EventPriority.NORMAL,
      }),
      routine: "fetch_window",
      data: {
        acquisitionPlanBlock: subPlan.block,
        parentRoutine: key,
        parentCorrelationId: parentEvent.correlationId,
        prePassFanOut: {
          integrationKey: subPlan.integrationKey,
          attempt,
          maxAttempts,
          fetchRowCount: subPlan.fetchRowCount,
          rowsHaveAccount: subPlan.rowsHaveAccount,
        },
      },
    } as RoutineEvent;
  }

  private sliceIntegrationSnapshot(
    integrations: Partial<Record<IntegrationKey, IntegrationState>>,
    key: IntegrationKey,
  ): Partial<Record<IntegrationKey, IntegrationState>> {
    const state = integrations[key];
    return state ? { [key]: state } : {};
  }

  private attemptRecordFromResult(
    attempt: number,
    fetcherEvent: RoutineEvent,
    startedAt: string,
    result: AgentResult,
  ): SubAttemptRecord {
    const parsed = parseFetchWindowOutput(result.output);
    const endedAt = new Date().toISOString();
    if ("parseError" in parsed) {
      return {
        attempt,
        status: "failed",
        fetched: 0,
        posted: 0,
        duplicates: 0,
        errors: [
          {
            type: "pre-pass-parse-failed",
            reason: parsed.parseError,
            attempt,
          },
        ],
        parseError: parsed.parseError,
        fetcherCorrelationId: fetcherEvent.correlationId,
        startedAt,
        endedAt,
        costUsd: result.costUsd,
        numTurns: result.numTurns,
      };
    }
    return {
      attempt,
      status: parsed.status,
      fetched: parsed.fetched,
      posted: parsed.posted,
      duplicates: parsed.duplicates,
      errors: parsed.errors.map((err) => ({ ...err, attempt })),
      fetcherCorrelationId: fetcherEvent.correlationId,
      startedAt,
      endedAt,
      costUsd: result.costUsd,
      numTurns: result.numTurns,
    };
  }

  private failedAttemptRecord(
    attempt: number,
    fetcherCorrelationId: string,
    startedAt: string,
    kind: string,
    err: unknown,
    /**
     * PREPASS_COST_REDUCTION_PLAN.md N1 — spend recovered from the
     * failure signal when the provider already billed the attempt.
     * Absent for pre-execute failures (binding/context), which are
     * genuinely zero-cost.
     */
    spend?: RecoveredFailureSpend | null,
  ): SubAttemptRecord {
    const message = err instanceof Error ? err.message : String(err);
    const endedAt = new Date().toISOString();
    return {
      attempt,
      status: "failed",
      fetched: 0,
      posted: 0,
      duplicates: 0,
      errors: [{ type: "pre-pass-failed", kind, message, attempt }],
      fetcherCorrelationId,
      startedAt,
      endedAt,
      costUsd: spend?.costUsd ?? 0,
      numTurns: spend?.numTurns ?? 0,
    };
  }

  /**
   * FETCH_WINDOW_TURN_LIMIT_FIX_PLAN.md P2.2 — build a `partial` record for
   * a hard-stop kill that durably posted observations before the envelope
   * cut it off. The counts come from the runner's ground-truth tally, not
   * the agent's un-emitted JSON line. The `pre-pass-truncated` error is
   * deliberately a NEUTRAL type (not `budget-exhausted`, which would trip
   * `defaultRetryDecision`'s terminal rule 3): a synthesized partial with
   * `posted > 0` must flow to the `partial-with-progress` (no-retry) rule
   * so the audit trail records the honest reason and the runner skips a
   * wasteful re-fetch. Freshness is NOT written (status is `partial`, and
   * only `success` stamps `pre_pass_last_run`), so the next tick still gets
   * a full shot at the window the kill truncated.
   */
  private synthesizedPartialRecord(
    attempt: number,
    fetcherCorrelationId: string,
    startedAt: string,
    tally: PrePassObservationsTally,
    spend: RecoveredFailureSpend | null,
    err: unknown,
    killKind: "turn-limit" | "budget-limit",
  ): SubAttemptRecord {
    const message = err instanceof Error ? err.message : String(err);
    const endedAt = new Date().toISOString();
    return {
      attempt,
      status: "partial",
      fetched: tally.fetched,
      posted: tally.posted,
      duplicates: tally.duplicates,
      errors: [
        {
          type: "pre-pass-truncated",
          kind: killKind,
          posted: tally.posted,
          fetched: tally.fetched,
          duplicates: tally.duplicates,
          batches: tally.batches,
          message,
          attempt,
        },
      ],
      fetcherCorrelationId,
      startedAt,
      endedAt,
      costUsd: spend?.costUsd ?? 0,
      numTurns: spend?.numTurns ?? 0,
    };
  }

  private budgetCapAttemptRecord(
    attempt: number,
    fetcherCorrelationId: string,
    startedAt: string,
    type: "budget-cap" | "global-budget-cap",
    remaining: number,
  ): SubAttemptRecord {
    const endedAt = new Date().toISOString();
    return {
      attempt,
      status: "failed",
      fetched: 0,
      posted: 0,
      duplicates: 0,
      errors: [{ type, remaining, attempt }],
      fetcherCorrelationId,
      startedAt,
      endedAt,
      costUsd: 0,
      numTurns: 0,
    };
  }

  private didExhaustRetries(
    record: SubAttemptRecord,
    decision: RetryDecision,
    policy: RetryPolicy,
  ): boolean {
    if (record.status === "success" || record.status === "skipped") return false;
    // FanOutBudgetGuard.reserve() failures surface as explicit error rows
    // — those are the parallel-reservation cap trips covered by §4.7.
    if (
      record.errors.some(
        (err) => err.type === "budget-cap" || err.type === "global-budget-cap",
      )
    ) {
      return true;
    }
    // §4.3 contract: "exhausted maxAttempts (or a budget/global cap tripped)".
    // The per-integration cumulative-cost cap branch in defaultRetryDecision
    // returns reason=BUDGET_CAP without leaving a budget-cap error row on
    // the attempt — without this clause the sub-report would carry
    // retriesExhausted=false even though the loop terminated on a cap.
    if (
      decision.reason === RETRY_REASONS.MAX_ATTEMPTS
      || decision.reason === RETRY_REASONS.BUDGET_CAP
    ) {
      return true;
    }
    return record.attempt >= policy.maxAttempts;
  }

  private backoffForAttempt(policy: RetryPolicy, attempt: number): number {
    if (attempt >= policy.maxAttempts) return 0;
    const configured = policy.backoffMs[attempt - 1];
    if (typeof configured === "number") return Math.max(0, configured);
    const last = policy.backoffMs[policy.backoffMs.length - 1];
    return typeof last === "number" ? Math.max(0, last) : 0;
  }

  /**
   * PREPASS_COST_REDUCTION_PLAN.md N2 — evaluate the offline/auth spawn
   * gate for one integration's sub-session. Candidates are the
   * pre-resolved binding's main + fallback backends; when pre-resolve
   * failed, the sub-plan's `requiredBackend` is the only candidate the
   * attempt loop could use. Fail-open on every error path (returns null).
   */
  private async evaluateSpawnGate(input: FanOutRunInput & {
    subPlan: AcquisitionSubPlan;
    preResolvedBinding: ReturnType<IAgentRouter["resolveBinding"]> | null;
  }): Promise<SpawnGateDecision | null> {
    if (!this.spawnGate) return null;
    try {
      const binding = input.preResolvedBinding;
      const candidates: BackendId[] = binding
        ? [binding.main.backendId]
        : [input.subPlan.requiredBackend];
      if (
        binding?.fallback
        && binding.fallback.backendId !== binding.main.backendId
      ) {
        candidates.push(binding.fallback.backendId);
      }
      return await this.spawnGate.evaluate(candidates);
    } catch (err) {
      logger.warn(
        {
          err,
          routine: input.key,
          integrationKey: input.subPlan.integrationKey,
        },
        "Pre-pass spawn-gate evaluation failed — failing open",
      );
      return null;
    }
  }

  /**
   * Build the `skipped` SubReport for a spawn-gate skip and write its
   * audit row. Mirrors the empty-attempts synthetic record (attempt 0,
   * no SSE sub-session emits — no session was spawned). The audit row is
   * `result='skipped'` with `detail.prePass.skipReason` carrying N2's
   * `offline` / `auth_unhealthy`, matching the N3 plan-drop row shape so
   * all pre-pass skip telemetry is queryable through one path.
   */
  private spawnGateSkippedSubReport(
    input: FanOutRunInput & {
      subPlan: AcquisitionSubPlan;
      policy: RetryPolicy;
    },
    decision: SpawnGateDecision,
  ): SubReport {
    const reason = decision.reason ?? "offline";
    const now = new Date().toISOString();
    const record: SubAttemptRecord = {
      attempt: 0,
      status: "skipped",
      fetched: 0,
      posted: 0,
      duplicates: 0,
      errors: [{ type: "spawn-gate-skipped", reason, attempt: 0 }],
      fetcherCorrelationId: input.parentEvent.correlationId,
      startedAt: now,
      endedAt: now,
      costUsd: 0,
      numTurns: 0,
    };
    try {
      const fetcherEvent = this.createFanOutFetcherEvent(
        input.parentEvent,
        input.key,
        input.subPlan,
        0,
        input.policy.maxAttempts,
      );
      this.audit.logSkip(fetcherEvent, reason, "autonomous", {
        prePass: {
          parentCorrelationId: input.parentEvent.correlationId,
          parentRoutine: input.key,
          integrationKey: input.subPlan.integrationKey,
          skipReason: reason,
          spawnGate: { backends: decision.backends },
        },
      });
    } catch (err) {
      logger.warn(
        {
          err,
          routine: input.key,
          integrationKey: input.subPlan.integrationKey,
          reason,
        },
        "Failed to log spawn-gate skip audit row",
      );
    }
    logger.info(
      {
        routine: input.key,
        integrationKey: input.subPlan.integrationKey,
        reason,
        backends: decision.backends,
        parentCorrelationId: input.parentEvent.correlationId,
      },
      "Pre-pass sub-session skipped — spawn gate (offline / auth-unhealthy backends)",
    );
    return {
      ...record,
      integrationKey: input.subPlan.integrationKey,
      attempts: [record],
      retriesExhausted: false,
    };
  }

  /**
   * PREPASS_COST_REDUCTION_PLAN.md N3 — one `skipped` audit row per
   * (integration × reason) group of plan-assembly drops, with the
   * dropped windows listed in `detail.prePass.windows`. Grouped at
   * integration granularity because that is the unit a session would
   * have been spawned for (and the unit the deferred R5 streak skip
   * will key on). Observability only — no skip behavior changes here.
   */
  private logPlanAssemblyDrops(
    parentEvent: Event,
    key: RoutineWindowKey,
    allDrops: readonly AcquisitionPlanDrop[],
  ): void {
    // `direct_inline_prefetch` is the catalog working as designed (the
    // daemon fetches that data inline; see the reason's doc comment) —
    // auditing it every run would bury the genuine drop signal R4/R5
    // need under deterministic noise.
    const drops = allDrops.filter((d) => d.reason !== "direct_inline_prefetch");
    if (drops.length === 0) return;
    try {
      const groups = new Map<string, {
        integration: IntegrationKey;
        reason: AcquisitionPlanDrop["reason"];
        windows: string[];
      }>();
      for (const drop of drops) {
        const groupKey = `${drop.integration}|${drop.reason}`;
        const existing = groups.get(groupKey);
        if (existing) {
          existing.windows.push(drop.window);
        } else {
          groups.set(groupKey, {
            integration: drop.integration,
            reason: drop.reason,
            windows: [drop.window],
          });
        }
      }
      for (const group of groups.values()) {
        const dropEvent: RoutineEvent = {
          ...createEvent({
            type: FETCH_WINDOW_EVENT_TYPE,
            source: parentEvent.source,
            priority: EventPriority.NORMAL,
            correlationId: parentEvent.correlationId,
          }),
          routine: "fetch_window",
        };
        this.audit.logSkip(
          dropEvent,
          `plan_drop:${group.reason}`,
          "autonomous",
          {
            prePass: {
              parentCorrelationId: parentEvent.correlationId,
              parentRoutine: key,
              integrationKey: group.integration,
              skipReason: group.reason,
              windows: group.windows,
            },
          },
        );
      }
      logger.debug(
        {
          routine: key,
          parentCorrelationId: parentEvent.correlationId,
          drops,
        },
        "Pre-pass plan-assembly drops recorded",
      );
    } catch (err) {
      logger.warn(
        { err, routine: key, dropCount: drops.length },
        "Failed to log pre-pass plan-assembly drop audit rows",
      );
    }
  }

  /**
   * Unified audit-row companion for every fan-out failure mode —
   * binding-resolve-failed, global-budget-cap, budget-cap (per-integration),
   * context-build-failed, and agent-execute-failed. Routes through
   * `audit.logError` (writes `result='failed'`) with a `prePass` payload
   * so `MetricsCollector.collectPrePassMetrics` can see every failure
   * mode without a parallel `result='success'` row. Before this helper
   * existed, the four pre-execute branches wrote nothing at all and the
   * agent-execute path wrote a `failureKind`-only row that the aggregator
   * silently skipped (it filters on `detail.prePass` being a non-null
   * object). Cost / tokens are intentionally NOT supplied — pre-execute
   * paths have zero cost, the agent-execute throw path has no usable
   * AgentResult, so any figure here would be a guess; the aggregator
   * coalesces missing `cost_usd` to 0.
   */
  private logFanOutFailure(
    input: FanOutRunInput & {
      subPlan: AcquisitionSubPlan;
      policy: RetryPolicy;
      globalBudget: FanOutBudgetGuard;
    },
    fetcherEvent: RoutineEvent,
    record: SubAttemptRecord,
    decision: RetryDecision,
    options: {
      failureKind: string;
      err?: unknown;
      binding?: { backendId: BackendId; modelId: string };
      startedAt: string;
      /**
       * PREPASS_COST_REDUCTION_PLAN.md N1 — spend recovered from the
       * failure signal. When present the audit row carries the real
       * cost/tokens the provider billed; pre-execute failure modes keep
       * the historical no-cost row (they are genuinely zero-cost).
       */
      spend?: RecoveredFailureSpend | null;
      /**
       * FETCH_WINDOW_TURN_LIMIT_FIX_PLAN.md P3.2 — the turn envelope the
       * killed attempt ran under (the DENOMINATOR the dashboard renders as
       * "turn limit (numTurns/maxTurns)"). Absent for pre-execute failure
       * modes (binding-resolve / budget-cap) where no session was dispatched.
       */
      maxTurns?: number;
    },
  ): void {
    try {
      const message = options.err instanceof Error
        ? options.err.message
        : options.err !== undefined
          ? String(options.err)
          : options.failureKind;
      const error = new Error(message);
      const startMs = Date.parse(options.startedAt);
      const durationMs = Number.isFinite(startMs)
        ? Math.max(0, Date.now() - startMs)
        : undefined;
      this.audit.logError(fetcherEvent, error, "autonomous", {
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(options.binding ? { backendId: options.binding.backendId } : {}),
        ...(options.binding ? { modelId: options.binding.modelId } : {}),
        ...(options.spend
          ? {
              costUsd: options.spend.costUsd,
              numTurns: options.spend.numTurns,
              ...(options.spend.costSource
                ? { costSource: options.spend.costSource }
                : {}),
              ...(options.spend.usage
                ? {
                    tokensInput: options.spend.usage.inputTokens,
                    tokensOutput: options.spend.usage.outputTokens,
                    tokensCacheCreation:
                      options.spend.usage.cacheCreationInputTokens,
                    tokensCacheRead: options.spend.usage.cacheReadInputTokens,
                  }
                : {}),
            }
          : {}),
        failureKind: options.failureKind,
        prePass: {
          parentCorrelationId: input.parentEvent.correlationId,
          parentRoutine: input.key,
          integrationKey: input.subPlan.integrationKey,
          attempt: record.attempt,
          maxAttempts: input.policy.maxAttempts,
          retriedFromAttempt: record.attempt > 1 ? record.attempt - 1 : null,
          status: record.status,
          fetched: record.fetched,
          posted: record.posted,
          duplicates: record.duplicates,
          errors: record.errors,
          willRetry: decision.retry,
          retryReason: decision.reason,
          ...(options.binding ? { requestedBackend: options.binding.backendId } : {}),
          ...(typeof options.maxTurns === "number"
            ? { maxTurns: options.maxTurns }
            : {}),
        },
      });
    } catch (logErr) {
      logger.warn(
        {
          err: logErr,
          routine: input.key,
          integrationKey: input.subPlan.integrationKey,
          failureKind: options.failureKind,
          correlationId: fetcherEvent.correlationId,
        },
        "Failed to log routine.fetch_window fan-out failure audit row",
      );
    }
  }

  private logFanOutAttempt(
    input: FanOutRunInput & {
      subPlan: AcquisitionSubPlan;
      policy: RetryPolicy;
      globalBudget: FanOutBudgetGuard;
    },
    fetcherEvent: RoutineEvent,
    result: AgentResult,
    record: SubAttemptRecord,
    decision: RetryDecision,
    requestedBackend: BackendId,
    /**
     * FETCH_WINDOW_TURN_LIMIT_FIX_PLAN.md P3.2 — the turn envelope this
     * attempt ran under, persisted on every pre-pass row (not just failures)
     * so the dashboard can show `numTurns/maxTurns` headroom on healthy runs
     * and `/metrics/pre-pass` sizing can be read against the cap in effect.
     */
    maxTurns: number,
  ): void {
    // §5 BackendQuotaError mitigation — set `fallbackTriggered` when the
    // backend that actually executed differs from the binding the runner
    // asked for. The audit row's `backend` column carries the ACTUAL
    // backend (set from `result.backendId` above); `requestedBackend`
    // surfaces what the runner intended, so the operator can spot
    // recurring fallbacks by grepping `fallbackTriggered: true` rows
    // without reconstructing the binding state from the daemon log.
    const fallbackTriggered =
      result.backendId !== undefined && result.backendId !== requestedBackend;
    try {
      this.audit.logAction({
        event: fetcherEvent,
        model: result.model,
        costUsd: result.costUsd,
        usage: result.usage,
        modelUsage: result.modelUsage,
        durationMs: result.durationMs,
        numTurns: result.numTurns,
        trigger: "autonomous",
        ...(result.backendId ? { backend: result.backendId } : {}),
        ...(result.costSource ? { costSource: result.costSource } : {}),
        contextUpdated: result.contextUpdated,
        ...(typeof result.advisorCallCount === "number"
          ? { advisorCallCount: result.advisorCallCount }
          : {}),
        prePass: {
          parentCorrelationId: input.parentEvent.correlationId,
          // §7.3 metric aggregation — every fan-out audit row carries
          // the parent routine key so `/metrics/pre-pass` can group by
          // routine without joining back to the parent's row.
          parentRoutine: input.key,
          integrationKey: input.subPlan.integrationKey,
          attempt: record.attempt,
          maxAttempts: input.policy.maxAttempts,
          // §7.1 example surfaces `retriedFromAttempt`. `null` for the
          // first attempt in a sub-session's chain; otherwise the prior
          // attempt index. Derivable but cheaper than a cross-row join.
          retriedFromAttempt: record.attempt > 1 ? record.attempt - 1 : null,
          status: record.status,
          fetched: record.fetched,
          posted: record.posted,
          duplicates: record.duplicates,
          errors: record.errors,
          willRetry: decision.retry,
          retryReason: decision.reason,
          ...(fallbackTriggered ? { fallbackTriggered: true } : {}),
          requestedBackend,
          maxTurns,
        },
      });
    } catch (err) {
      logger.warn(
        {
          err,
          routine: input.key,
          integrationKey: input.subPlan.integrationKey,
          correlationId: fetcherEvent.correlationId,
        },
        "Failed to log routine.fetch_window fan-out agent_actions row",
      );
    }
  }

  /**
   * Helper for the failure paths — renders a `<fetch_report status="failed">`
   * block and logs the underlying error. Never throws so the caller can
   * always continue with the parent routine dispatch.
   */
  private fail(
    routine: RoutineWindowKey,
    agentDay: string,
    parentEvent: Event,
    kind: string,
    err: unknown,
    extra: { fetcherCorrelationId?: string } = {},
  ): RoutineFetchWindowResult {
    const message = err instanceof Error ? err.message : String(err);
    const report: FetchReport = {
      status: "failed",
      fetched: 0,
      posted: 0,
      duplicates: 0,
      errors: [{ type: "pre-pass-failed", kind, message }],
      skipped: false,
      failureReason: `${kind}: ${message}`,
      ...(extra.fetcherCorrelationId
        ? { fetcherCorrelationId: extra.fetcherCorrelationId }
        : {}),
    };
    const block = renderFetchReportBlock(report, { routine, agentDay });
    logger.warn(
      {
        routine,
        kind,
        err,
        parentCorrelationId: parentEvent.correlationId,
      },
      "Routine fetch-window pre-pass failed — parent routine will see <fetch_report status='failed'>",
    );
    return { report, block };
  }

  /**
   * Translate the mail registry's active-account list into the
   * `AcquisitionAccount[]` shape `buildAcquisitionPlan` expects. Only
   * accounts whose integration is currently non-disabled survive — a
   * disabled gmail integration with five accounts produces zero rows,
   * matching the partial's `<!-- mode:disabled:gmail -->` no-op.
   */
  private collectAccounts(
    integrations: Partial<Record<IntegrationKey, IntegrationState>>,
  ): AcquisitionAccount[] {
    const rows: AcquisitionAccount[] = [];
    for (const account of this.getActiveMailAccounts()) {
      const integrationKey = mailAccountIntegrationKey(account);
      if (integrationKey === null) continue;
      const state = integrations[integrationKey];
      if (!state || state.mode === "disabled") continue;
      rows.push({
        integration: integrationKey,
        accountId: account.id,
        label: account.email,
      });
    }
    return rows;
  }
}
