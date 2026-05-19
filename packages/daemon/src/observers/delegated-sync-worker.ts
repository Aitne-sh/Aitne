import type Database from "better-sqlite3";
import {
  INTEGRATION_DESCRIPTORS,
  INTEGRATION_WRITE_TTL_MS,
  getSnapshotNormalizer,
  nextActiveHoursStart,
  nowInTimezone,
  type BackendId,
  type IntegrationKey,
  type IntegrationNormalizer,
} from "@aitne/shared";
import type { TodayWriteLockManager } from "../core/today-write-lock.js";
import {
  applyDriftEffects,
  emptyDriftSideEffects,
  type DriftSideEffects,
} from "../core/drift-effects.js";
import {
  reconcile,
  type ReconcileDiff,
  type ReconcileItem,
  type ReconcileRequest,
} from "../services/integrations/reconcile.js";
import type {
  DelegatedBackendInvoker,
  InvokeResult,
} from "../services/delegated-backend-invoker.js";
import type { DelegatedToolCost } from "../core/agent-core.js";
import { defaultModelForTier } from "../core/backends/model-registry.js";
import { readIntegrations } from "../db/integrations-store.js";
import { readRuntimeState } from "../db/runtime-state.js";
import { createLogger } from "../logging.js";
import type { Observer } from "./manager.js";

const logger = createLogger("delegated-sync-worker");

export const DELEGATED_SYNC_OBSERVER_NAME = "delegated-sync";
export const DELEGATED_SYNC_PROCESS_KEY = "integration_drift_sync";

const RUNTIME_CONFIG_KEY = "delegatedSync";
const DEFAULT_TICK_INTERVAL_SECONDS = 60;
const DEFAULT_MIN_INTERVAL_SECONDS = 60;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_BACKOFF_MULTIPLIER = 4;

/**
 * Default active-hours window for delegated-sync cadences. Mirrors Hourly
 * Check defaults (`hourlyCheckActiveStartHour=4`, `hourlyCheckActiveEndHour=24`)
 * so the two schedules align unless an operator overrides one or the other.
 * See `docs/design/appendices/delegated-sync-opt-in.md`.
 *
 * `endHour` is exclusive: `[start, end)`. `end=24` means "up to but not
 * including 24:00", i.e. the window covers 23:59:59.
 */
const DEFAULT_ACTIVE_START_HOUR = 4;
const DEFAULT_ACTIVE_END_HOUR = 24;

/**
 * Per-cadence retry policy for transient subprocess-side failures.
 *
 * Why retry only here: cadence-driven calls (`integration_drift_sync`)
 * are async, idempotent reads — there is no API caller waiting on the
 * outcome, and the connector tools used by cadences (calendar listEvents,
 * gmail search_threads, notion search) are read-only by construction.
 * Retrying is safe.
 *
 * Contrast with the synchronous proxy path (skill code in a Claude Code
 * / Codex / Gemini session calling `POST /api/delegated/run`): there the
 * tool may be write-class (gmail send, calendar updateEvent), and the
 * caller has its own deadline budget. The invoker layer must NOT retry
 * automatically — this module is the only legitimate place for retry.
 *
 * Retryable errorClasses are limited to subprocess-side transients —
 * `timeout` (idle watchdog or wall-clock fired), `subprocess_crashed`
 * (exit before paired tool_result), and `tool_not_registered` (Gemini
 * CLI's MCP tool registry hadn't fully populated when the model's
 * tool_use was dispatched — observed when the cadence's first tick
 * fires immediately after an integration switches to `delegated` and
 * the host extension's MCP server is still completing its handshake).
 * Auth / parse / wrong_tool / tool_error are deterministic; retrying
 * them would loop without changing outcome.
 *
 * MAX_RETRY_ATTEMPTS=1 (so total = 2 attempts) keeps the per-cadence
 * worst case inside ~2× the per-call ceiling: 75 s gemini idle + 1.5 s
 * delay + 75 s gemini idle ≈ 152 s. The cadence-tick mutex (`tickRunning`)
 * skips overlapping ticks during this window, but the next-cadence
 * (10–60 min interval) is unaffected.
 */
const RETRY_DELAY_MS = 1500;
const MAX_RETRY_ATTEMPTS = 1;
const RETRYABLE_ERROR_CLASSES: ReadonlySet<string> = new Set([
  "timeout",
  "subprocess_crashed",
  "tool_not_registered",
]);

/**
 * Wall-clock timeout for a single cadence invocation. The invoker has its
 * own per-request budget (see `delegated-backend-invoker.ts` ~line 585) but
 * a hung subprocess that ignores its abort signal would still leave
 * `tickRunning` pinned true forever and silently kill the worker. This
 * outer race guarantees the worker recovers even when the invoker's
 * cancellation path fails.
 *
 * 5 min is long enough for the slowest observed cadence (Gemini calendar
 * cold-start + tool roundtrip ≈ 75 s × 2 retries ≈ 150 s) plus headroom.
 * Operators can override via `runtime_state.delegatedSync.invokerTimeoutSeconds`
 * — the floor `MIN_INVOKER_TIMEOUT_MS` prevents pathological tiny values
 * that would treat every real call as a timeout.
 */
const DEFAULT_INVOKER_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_INVOKER_TIMEOUT_MS = 30 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface DelegatedSyncRuntimeConfig {
  /**
   * Seconds keyed by either:
   *   - "google_calendar:primary:imminent" (canonical)
   *   - "google_calendar.primary:imminent" (human-friendly)
   *   - "primary:imminent" (integration-local, kept for backwards compat)
   *
   * The integration-local form was introduced when calendar was the only
   * cadence; Phase 5 added gmail (`inbox:7d`) and notion (`recently_updated`)
   * cadences. Their window keys are unique across integrations today, so
   * the integration-local fallback still resolves unambiguously, but
   * operators should prefer the canonical fully-qualified form
   * (`<integration>:<windowKey>`) — a future cadence collision would
   * silently take the first match.
   */
  intervals?: Record<string, number>;
  /** Global floor in seconds. Per-cadence soft floors still apply. */
  minIntervalSeconds?: number;
  /**
   * Per-invocation wall-clock timeout in seconds. Bounds the worst-case
   * time `runCadence` can hold the `tickRunning` mutex when an invoker
   * subprocess hangs without honouring its own abort signal. Clamped to
   * `[MIN_INVOKER_TIMEOUT_MS / 1000, ∞)` — operators cannot push the
   * timeout below 30 s, which would cause healthy cadences to flap into
   * the "timeout" retry path.
   */
  invokerTimeoutSeconds?: number;
  /**
   * Per-cadence opt-in flag. Default false (cadence dormant) — see
   * `docs/design/appendices/delegated-sync-opt-in.md`. Keys are canonical
   * fully-qualified `<integration>:<windowKey>` only; the legacy alias
   * forms accepted by `intervals` are intentionally NOT honoured here so
   * a future cadence collision cannot silently flip the wrong toggle.
   */
  cadenceEnabled?: Record<string, boolean>;
  /**
   * Shared active-hours window applied to every cadence. Local-time hours
   * in the daemon's `timezone`; `[startHour, endHour)`. When unset, defaults
   * to `[4, 24)` to mirror the Hourly Check window.
   */
  activeStartHour?: number;
  activeEndHour?: number;
}

export interface DelegatedSyncCadenceContext {
  /** Window bounds derived from `buildWindow(now)`. */
  windowMin: string;
  windowMax: string;
  /** `now` snapshot used for window construction; identical to the
   *  `fetchedAt` posted to reconcile. */
  now: Date;
  /** Calendar id from worker options. Calendar cadences forward this; gmail
   *  and notion ignore it. */
  calendarId: string;
  /** Operator-tunable cap. Phase 1 used a per-cadence `maxResults` field;
   *  Phase 5 generalises it through the context object so a future cadence
   *  can drop the cap (Gemini Calendar `maxResults` is silently ignored
   *  upstream — the arg is a hint). */
  maxResults: number;
}

export interface DelegatedSyncToolCall {
  /** Fully-qualified tool name (`<connector.toolNamespace><bare>`). */
  toolName: string;
  /** Tool args as the connector expects them. */
  toolArgs: unknown;
}

export interface DelegatedSyncCadenceDefinition {
  integration: IntegrationKey;
  windowKey: string;
  /**
   * Short human-readable label for dashboard rendering (e.g. "Imminent
   * events"). Stored alongside the structural fields so the cadence
   * catalog stays self-describing — the dashboard doesn't have to keep a
   * separate id-to-label map in sync.
   */
  displayName: string;
  /** One-sentence rationale for the cadence (dashboard tooltip text). */
  description: string;
  defaultIntervalSeconds: number;
  softFloorSeconds: number;
  maxResults: number;
  buildWindow(now: Date): { windowMin: string; windowMax: string };
  /**
   * Resolve the connector tool name + args for this cadence on a given
   * backend. Returning a structure rather than positional args keeps the
   * worker's tick loop integration-agnostic — calendar passes calendarId,
   * gmail passes a Gmail search query, notion passes a search query +
   * `created_date_range` filter.
   */
  buildToolCall(
    backendId: BackendId,
    ctx: DelegatedSyncCadenceContext,
  ): DelegatedSyncToolCall;
  /**
   * Pluck the raw item array from the connector's `toolResult`. Connectors
   * wrap items under different keys (`events` for calendar list, `messages`
   * / `threads` for gmail, `results` / `pages` for notion); the cadence
   * definition owns the key list so adding a new cadence does not require
   * touching the worker.
   */
  extractItems(toolResult: unknown): unknown[];
}

interface CadenceRuntimeState {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastCompletedAt: string | null;
  failureCount: number;
  lastError: string | null;
}

export interface DelegatedSyncCadenceStatus {
  integration: IntegrationKey;
  windowKey: string;
  /** Per-cadence opt-in flag. Default false — see appendix. */
  enabled: boolean;
  /**
   * Integration's current mode at status-read time. The dashboard uses
   * this to render a per-cadence chip (Delegated / Native). When the
   * integration is in `direct` or `disabled` the field is null; the
   * row is still surfaced so the operator sees "Gmail · disabled"
   * alongside its inert opt-in flag. `native` is surfaced for the same
   * visibility reason even though the worker does not run for it —
   * see `backend` below.
   */
  mode: "delegated" | "native" | null;
  /**
   * Backend the next tick will invoke (`delegatedBackend` for delegated
   * mode). `null` for any other mode, including `native` — the worker
   * does not invoke for native rows; their observations come from the
   * in-turn `routine.fetch_window` pre-pass instead.
   */
  backend: BackendId | null;
  /** Static catalog metadata; surfaced for the dashboard rendering layer. */
  displayName: string;
  description: string;
  defaultIntervalSeconds: number;
  softFloorSeconds: number;
  intervalSeconds: number;
  effectiveIntervalSeconds: number;
  circuitState: "ok" | "tripped";
  failureCount: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastCompletedAt: string | null;
  lastError: string | null;
  nextRunAt: string | null;
}

export interface DelegatedSyncActiveHours {
  startHour: number;
  endHour: number;
}

export interface DelegatedSyncStatus {
  workerRunning: boolean;
  lastSuccessAt: string | null;
  circuitState: "ok" | "tripped";
  /**
   * Shared active-hours window applied to every cadence. Defaults to
   * `{startHour: 4, endHour: 24}` when the operator has not customised it.
   * Out-of-window ticks return early; cadences don't accrue failureCount.
   */
  activeHours: DelegatedSyncActiveHours;
  /**
   * Whether the worker's most recent (or impending) tick falls inside
   * `activeHours`. The dashboard surfaces this so the user can see at a
   * glance whether the cadences are dormant due to time-of-day.
   */
  withinActiveHours: boolean;
  cadences: Record<string, DelegatedSyncCadenceStatus>;
  /**
   * Operator-supplied `runtime_state.delegatedSync.intervals` keys that did
   * not resolve to any known cadence id (canonical / dotted / window-only
   * form per `resolveIntervalSeconds`). Surfaced through `/api/health` so
   * the dashboard can flag a typo like `gmail:imminent` (no such cadence)
   * before it silently falls through to defaults. Empty list means every
   * configured key matched a cadence.
   */
  unrecognizedIntervalKeys: string[];
  /**
   * Cadence ids whose effective interval exceeds the agent-write TTL × 1.5
   * boundary documented in INTEGRATION-DRIFT-DETECTION-PLAN.md §17.11. An
   * operator-tunable cadence longer than this risks the agent's own writes
   * being mis-attributed `actor='user'` on the next reconcile because the
   * `integration_writes` mark expires before the worker re-fetches. Reported
   * here so the dashboard / health endpoint can surface the violation; the
   * worker continues to honour the configured cadence.
   */
  ttlContractViolations: Array<{
    cadenceId: string;
    intervalSeconds: number;
    ttlSeconds: number;
  }>;
}

/**
 * Structured result for the dashboard's Run Now button. The four error
 * codes match the four reasons a one-shot run can fail before reaching
 * the connector. Connector-level failures (timeout / auth) flow through
 * the normal cadence-failure code path and are reported via the next
 * `getStatus()` snapshot.
 */
export type DelegatedSyncRunCadenceResult =
  | { ok: true }
  | {
    ok: false;
    error:
      | "unknown_cadence"
      | "tick_in_progress"
      /**
       * Returned when the integration is in any mode the worker does
       * not run (`direct`, `disabled`, `native`) or in `delegated`
       * without `delegatedBackend` set. The old
       * `integration_not_delegated` value is retained in this union for
       * one cycle so older dashboard builds still render an error label
       * instead of falling through to the generic branch.
       */
      | "integration_not_synchronizable"
      | "integration_not_delegated"
      | "integration_disabled";
  };

export interface DelegatedSyncWorkerOptions {
  db: Database.Database;
  invoker: DelegatedBackendInvoker;
  calendarId: string;
  timezone?: string;
  todayWriteLock?: TodayWriteLockManager;
  triggerRoadmapRefresh?: (source: string, options?: { bypassDedup?: boolean }) => void;
  tickIntervalSeconds?: number;
  now?: () => Date;
  cadences?: readonly DelegatedSyncCadenceDefinition[];
  /**
   * Wall-clock timeout for a single `invoker.invoke()` call. Defaults to
   * `DEFAULT_INVOKER_TIMEOUT_MS`. Per-invocation override path:
   *   1. constructor option (this field) → fixed for the worker's lifetime
   *   2. runtime_state `delegatedSync.invokerTimeoutSeconds` → re-read per call
   *      (so a dashboard PATCH lands on the next cadence without restart)
   * Floor `MIN_INVOKER_TIMEOUT_MS` applies to both paths.
   */
  invokerTimeoutMs?: number;
}

const CALENDAR_IMMINENT_CADENCE: DelegatedSyncCadenceDefinition = {
  integration: "google_calendar",
  windowKey: "primary:imminent",
  displayName: "Calendar — imminent (next 1 h)",
  description:
    "Polls upcoming events in the next hour. Required for the 15-min-before-meeting reminder while calendar is in delegated mode.",
  defaultIntervalSeconds: 10 * 60,
  softFloorSeconds: 5 * 60,
  maxResults: 50,
  buildWindow: (now) => ({
    windowMin: new Date(now.getTime() - 15 * 60 * 1000).toISOString(),
    windowMax: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
  }),
  buildToolCall: (backendId, ctx) => ({
    toolName: namespacedTool(
      "google_calendar",
      backendId,
      calendarListBareTool(backendId),
    ),
    toolArgs: {
      calendarId: ctx.calendarId,
      timeMin: ctx.windowMin,
      timeMax: ctx.windowMax,
      maxResults: ctx.maxResults,
    },
  }),
  extractItems: (toolResult) => extractItemsByKeys(toolResult, CALENDAR_ITEM_KEYS),
};

const CALENDAR_24H_CADENCE: DelegatedSyncCadenceDefinition = {
  integration: "google_calendar",
  windowKey: "primary:24h",
  displayName: "Calendar — day-ahead (next 24 h)",
  description:
    "Polls the next 24 hours of events. Feeds far-future roadmap-refresh detection.",
  defaultIntervalSeconds: 60 * 60,
  softFloorSeconds: 30 * 60,
  maxResults: 250,
  buildWindow: (now) => ({
    windowMin: now.toISOString(),
    windowMax: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  }),
  buildToolCall: CALENDAR_IMMINENT_CADENCE.buildToolCall,
  extractItems: CALENDAR_IMMINENT_CADENCE.extractItems,
};

/**
 * Gmail `inbox:7d` cadence. Plan §8.2 / §8.3:
 *   - Default 30 min, soft floor 15 min — gmail polls less often than
 *     calendar so the operator-tunable cost stays bounded.
 *   - Window is the last 7 days. Reconcile keys by `(integration,
 *     window_key)` so the partition is wide enough that a recent thread
 *     with a fresh reply doesn't drop out and falsely emit `deleted`. The
 *     LLM hourly check still post-filters to "last hour" inside its own
 *     decision flow; this cadence's job is structural diff, not selection.
 *   - `query="newer_than:7d"` Gmail search operator. `pageSize` /
 *     `max_results` / `maxResults` differs by backend (Claude / Codex /
 *     Gemini) — `gmailSearchToolCall` per-backend wraps the arg shape.
 */
const GMAIL_INBOX_7D_CADENCE: DelegatedSyncCadenceDefinition = {
  integration: "gmail",
  windowKey: "inbox:7d",
  displayName: "Gmail — inbox (last 7 days)",
  description:
    "Polls thread-level changes in the last 7 days of inbox. Surfaces new threads and replies for the hourly check.",
  defaultIntervalSeconds: 30 * 60,
  softFloorSeconds: 15 * 60,
  maxResults: 25,
  buildWindow: (now) => ({
    windowMin: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    // §5.1 sliding-window: a small forward buffer past `now` keeps a
    // message whose `internalDate` is exactly `now` from being classified
    // as out-of-window on the next reconcile.
    windowMax: new Date(now.getTime() + 60 * 1000).toISOString(),
  }),
  buildToolCall: gmailSearchToolCall,
  extractItems: (toolResult) => extractItemsByKeys(toolResult, GMAIL_ITEM_KEYS),
};

/**
 * Notion `recently_updated` cadence. Plan §8.2 / §8.3:
 *   - Default 60 min, soft floor 30 min.
 *   - Notion search has no `last_edited_time` filter (per the hourly
 *     check's existing footnote on coverage gaps); the cadence pulls a
 *     `created_date_range` window of the last 7 days as a coarse anchor
 *     and lets reconcile + the per-page `lastEditedTime` payload + the
 *     Notion normalizer's `inWindow` predicate sort out true churn.
 *   - The window's `created_date_range.start_date` arg is per the same
 *     date format the hourly_check prompt uses (`YYYY-MM-DD`), to mirror
 *     what the LLM-driven path was already producing — connectors uniformly
 *     accept that.
 */
const NOTION_RECENTLY_UPDATED_CADENCE: DelegatedSyncCadenceDefinition = {
  integration: "notion",
  windowKey: "recently_updated",
  displayName: "Notion — recently updated",
  description:
    "Polls pages updated in the last 7 days. Coarse window; per-page lastEditedTime filters in reconcile.",
  defaultIntervalSeconds: 60 * 60,
  softFloorSeconds: 30 * 60,
  maxResults: 25,
  buildWindow: (now) => ({
    windowMin: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    windowMax: new Date(now.getTime() + 60 * 1000).toISOString(),
  }),
  buildToolCall: notionSearchToolCall,
  extractItems: (toolResult) => extractItemsByKeys(toolResult, NOTION_ITEM_KEYS),
};

const DEFAULT_CADENCES: readonly DelegatedSyncCadenceDefinition[] = [
  CALENDAR_IMMINENT_CADENCE,
  CALENDAR_24H_CADENCE,
  GMAIL_INBOX_7D_CADENCE,
  NOTION_RECENTLY_UPDATED_CADENCE,
];

const DEFAULT_CADENCE_INTEGRATIONS: ReadonlySet<IntegrationKey> = new Set(
  DEFAULT_CADENCES.map((def) => def.integration),
);

/**
 * Worker stand-up predicate. True when at least one cadence-eligible
 * integration is in `delegated` mode with its master kill switch on.
 *
 * Native mode is intentionally excluded — per
 * `docs/design/appendices/native-integration-mode.md:263-266` the worker
 * "only iterates `mode === "delegated"`"; native observations come from
 * the in-turn `routine.fetch_window` pre-pass POSTing to
 * `/api/observations`, not from this worker. The §3.3 invariant
 * ("native MUST NOT call the daemon proxy") is enforced defensively by
 * `DelegatedBackendInvoker.resolvePreconditions`; entering this worker
 * for a native row would just produce a failed `integration_drift_sync`
 * audit row every hourly tick.
 *
 * Used by:
 *  - bootstrap (`packages/daemon/src/index.ts`) to decide whether to
 *    register the worker on startup;
 *  - `applyIntegrationModeChange` (`integration-lifecycle.ts`) to
 *    stand the worker up / tear it down as integrations flip in and out
 *    of delegated mode.
 */
export function hasActiveDelegatedSyncIntegration(
  db: Database.Database,
  override?: { key: IntegrationKey; state: import("@aitne/shared").IntegrationState },
): boolean {
  const integrations = readIntegrations(db);
  if (override) integrations[override.key] = override.state;
  return Object.entries(integrations).some(
    ([key, state]) =>
      DEFAULT_CADENCE_INTEGRATIONS.has(key as IntegrationKey)
      && state.mode === "delegated"
      && state.delegatedSyncEnabled !== false,
  );
}

/**
 * Resolve which backend the worker should invoke for a cadence, given
 * the integration's current state. Returns `null` when the integration
 * is not in delegated mode, when its master kill switch is explicitly
 * false, or when its `delegatedBackend` slot is empty. The cadence-level
 * `cadenceEnabled` opt-in is checked separately at the worker's tick gate.
 *
 * Native rows always return null — see `hasActiveDelegatedSyncIntegration`
 * for the rationale. `getStatus` still surfaces the row with
 * `mode='native', backend=null` so the dashboard can show "Native mode —
 * cadence not used" alongside the catalog entry.
 */
function backendForCadence(
  state: import("@aitne/shared").IntegrationState,
): BackendId | null {
  if (state.mode === "delegated"
      && state.delegatedSyncEnabled !== false
      && state.delegatedBackend) {
    return state.delegatedBackend;
  }
  return null;
}

export class DelegatedSyncWorker implements Observer {
  readonly name = DELEGATED_SYNC_OBSERVER_NAME;

  private timer: ReturnType<typeof setInterval> | null = null;
  private tickRunning = false;
  private readonly tickIntervalSeconds: number;
  private readonly now: () => Date;
  private readonly cadences: readonly DelegatedSyncCadenceDefinition[];
  private readonly states = new Map<string, CadenceRuntimeState>();
  /**
   * Constructor-supplied invoker timeout. When undefined (production
   * default), `resolveInvokerTimeoutMs()` falls back to the runtime_state
   * value (if set) or `DEFAULT_INVOKER_TIMEOUT_MS`.
   */
  private readonly invokerTimeoutMsOverride: number | undefined;

  constructor(private readonly options: DelegatedSyncWorkerOptions) {
    this.tickIntervalSeconds =
      options.tickIntervalSeconds ?? DEFAULT_TICK_INTERVAL_SECONDS;
    this.now = options.now ?? (() => new Date());
    this.cadences = options.cadences ?? DEFAULT_CADENCES;
    this.invokerTimeoutMsOverride = options.invokerTimeoutMs;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    // Register the interval before awaiting the initial tick. Two reasons:
    //  1. A second concurrent `start()` call hits `if (this.timer) return`
    //     immediately instead of falling through and double-registering.
    //  2. If the initial tick throws (e.g. transient DB error during boot),
    //     subsequent scheduled ticks still fire and recover state, instead
    //     of leaving the worker permanently silent.
    this.timer = setInterval(
      () => void this.tick(),
      this.tickIntervalSeconds * 1000,
    );
    this.timer.unref?.();
    // Phase 7 (h): seed per-cadence state from the most recent successful
    // delegated_sync row in agent_actions before the first tick. Daemon
    // restarts no longer re-spawn every cadence's subprocess when a sync
    // ran shortly before the restart; the natural cadenceDue check picks
    // up where the last process left off. When no history exists (fresh
    // install or retention-pruned table), states stay null and the first
    // tick fires for every cadence — same effect as the prior force-on-
    // start behaviour, achieved without redundant spawns.
    this.hydrateStateFromHistory();
    this.warnOnConfigViolations();
    try {
      await this.tick();
    } catch (err) {
      logger.warn({ err }, "Initial delegated sync tick failed; cadence-driven retries will continue");
    }
    logger.info(
      { tickIntervalSeconds: this.tickIntervalSeconds },
      "Delegated sync worker started",
    );
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info("Delegated sync worker stopped");
  }

  async tick(options: { force?: boolean } = {}): Promise<void> {
    if (this.tickRunning) {
      logger.debug("Delegated sync tick already running — skipping overlap");
      return;
    }
    this.tickRunning = true;
    try {
      await this.runTick(options.force === true);
    } finally {
      this.tickRunning = false;
    }
  }

  getStatus(now: Date = this.now()): DelegatedSyncStatus {
    const runtimeConfig = this.readRuntimeConfig();
    // Resolved up front because per-cadence `nextRunAt` projects past
    // out-of-window candidates to the next active-hours start.
    const activeHours = resolveActiveHours(runtimeConfig);
    const cadences: Record<string, DelegatedSyncCadenceStatus> = {};
    const ttlContractViolations: DelegatedSyncStatus["ttlContractViolations"] = [];
    let lastSuccessAt: string | null = null;
    let anyTripped = false;

    // Read integration states once per status snapshot so each
    // cadence row can surface the current mode + resolved backend.
    const integrationStates = readIntegrations(this.options.db);

    for (const def of this.cadences) {
      const id = cadenceId(def);
      const state = this.getState(id);
      const intervalSeconds = this.resolveIntervalSeconds(def, runtimeConfig);
      const effectiveIntervalSeconds = computeEffectiveIntervalSeconds(
        intervalSeconds,
        state.failureCount,
      );
      const circuitState = state.failureCount >= CIRCUIT_FAILURE_THRESHOLD
        ? "tripped"
        : "ok";
      if (circuitState === "tripped") anyTripped = true;
      if (
        state.lastSuccessAt
        && (lastSuccessAt === null || state.lastSuccessAt > lastSuccessAt)
      ) {
        lastSuccessAt = state.lastSuccessAt;
      }
      const integrationState = integrationStates[def.integration];
      const resolvedBackend = backendForCadence(integrationState);
      const resolvedMode: DelegatedSyncCadenceStatus["mode"] =
        integrationState.mode === "delegated" || integrationState.mode === "native"
          ? integrationState.mode
          : null;
      cadences[id] = {
        integration: def.integration,
        windowKey: def.windowKey,
        enabled: isCadenceEnabled(def, runtimeConfig),
        mode: resolvedMode,
        backend: resolvedBackend,
        displayName: def.displayName,
        description: def.description,
        defaultIntervalSeconds: def.defaultIntervalSeconds,
        softFloorSeconds: def.softFloorSeconds,
        intervalSeconds,
        effectiveIntervalSeconds,
        circuitState,
        failureCount: state.failureCount,
        lastAttemptAt: state.lastAttemptAt,
        lastSuccessAt: state.lastSuccessAt,
        lastCompletedAt: state.lastCompletedAt,
        lastError: state.lastError,
        nextRunAt: nextRunAt(
          state,
          effectiveIntervalSeconds,
          now,
          this.options.timezone,
          activeHours,
        ),
      };

      const ttlMs = INTEGRATION_WRITE_TTL_MS[def.integration];
      const ttlSeconds = Math.floor(ttlMs / 1000);
      if (intervalSeconds * TTL_CONTRACT_RATIO > ttlSeconds) {
        ttlContractViolations.push({
          cadenceId: id,
          intervalSeconds,
          ttlSeconds,
        });
      }
    }

    return {
      workerRunning: this.timer !== null,
      lastSuccessAt,
      circuitState: anyTripped ? "tripped" : "ok",
      activeHours,
      withinActiveHours: isWithinActiveHours(now, this.options.timezone, activeHours),
      cadences,
      unrecognizedIntervalKeys: collectUnrecognizedIntervalKeys(
        this.cadences,
        runtimeConfig,
      ),
      ttlContractViolations,
    };
  }

  /**
   * Hourly-check-driven refresh: fires any cadence whose integration is in
   * delegated mode but whose per-cadence opt-in flag (`cadenceEnabled[id]`)
   * is NOT `true`. Cadences the operator opted in run on their own
   * user-set interval via the regular tick loop and are intentionally
   * skipped here so we don't spend tokens twice for the same partition.
   * Native rows are skipped by `backendForCadence` returning null — their
   * observations come from the in-turn `routine.fetch_window` pre-pass
   * instead, see `docs/design/appendices/native-integration-mode.md`
   * §"Polling, observers, and the hourly-check threshold".
   *
   * Why this exists: when every cadence is disabled (the post-Phase-9
   * default), Gmail / Notion observations would otherwise dry up entirely
   * — the delegated `routine.hourly_check` task flow's Step 0a / 0c rely
   * on `mail:lifecycle` / `notion:<db>` rows the worker writes server-
   * side, and the agent prompt is explicitly told NOT to call the
   * gmail / notion `/reconcile` route directly (would poison the worker's
   * 7 d partition with a narrow window). This method makes the hourly
   * check itself the producer for those partitions when the user has not
   * opted into a per-cadence schedule.
   *
   * Active-hours are NOT consulted: this method runs only because the
   * hourly check itself fired, which already passed `hourlyCheckActive*`
   * gating. The cadence-side `activeStartHour` / `activeEndHour` window
   * applies only to the worker's own 60 s tick.
   *
   * Cadences run in parallel — they target independent integrations and
   * connector subprocesses, so wall-clock latency is bounded by the
   * slowest single cadence rather than the sum. Serialised through the
   * `tickRunning` mutex so the regular timer tick or a dashboard Run-Now
   * click landing simultaneously doesn't double-spawn the same connector.
   * Failures are caught per-cadence inside `runCadence` (failureCount /
   * circuit-breaker) and surfaced through the next `getStatus()` snapshot;
   * this method does not throw.
   */
  async runDisabledCadencesForHourlyCheck(): Promise<void> {
    if (this.tickRunning) {
      logger.debug(
        "Skipping hourly-check delegated refresh — worker tick already in flight",
      );
      return;
    }
    this.tickRunning = true;
    try {
      const integrations = readIntegrations(this.options.db);
      const runtimeConfig = this.readRuntimeConfig();
      const tasks: Promise<void>[] = [];
      for (const def of this.cadences) {
        const integrationState = integrations[def.integration];
        const backend = backendForCadence(integrationState);
        if (!backend) continue;
        // Skip cadences the operator opted in — the regular tick handles
        // those on the user-set interval. The whole point of this method
        // is to cover the opt-OUT case.
        if (isCadenceEnabled(def, runtimeConfig)) continue;

        const normalizer = getSnapshotNormalizer(def.integration);
        /* c8 ignore next 2 — defensive against descriptor-before-normalizer drift. */
        if (!normalizer) continue;
        tasks.push(
          this.runCadence(def, normalizer, backend),
        );
      }
      if (tasks.length === 0) return;
      // `runCadence` swallows its own errors; `allSettled` keeps a future
      // refactor that lets it throw from poisoning the rest of the batch.
      await Promise.allSettled(tasks);
    } finally {
      this.tickRunning = false;
    }
  }

  /**
   * Run a single cadence on demand (dashboard "Run Now" button). Bypasses
   * `cadenceEnabled`, `cadenceDue`, and active-hours gating — the user
   * explicitly asked for one-shot execution. The integration master switch
   * (`delegatedSyncEnabled === false`) is still honoured because that's a
   * kill switch, not a schedule.
   *
   * Serialised through `tickRunning` so a Run-Now click during the 60 s
   * scheduled tick window doesn't double-spawn the same connector
   * subprocess. Returns a structured failure code rather than throwing so
   * the dashboard can render the four known reasons cleanly.
   */
  async runCadenceNow(cadenceIdInput: string): Promise<DelegatedSyncRunCadenceResult> {
    const def = this.cadences.find((d) => cadenceId(d) === cadenceIdInput);
    if (!def) return { ok: false, error: "unknown_cadence" };

    if (this.tickRunning) return { ok: false, error: "tick_in_progress" };

    const integrations = readIntegrations(this.options.db);
    const integrationState = integrations[def.integration];

    // Kill-switch is checked before the resolver so its dedicated error
    // code (`integration_disabled`) is surfaced; `backendForCadence`
    // would otherwise collapse a kill-switched row into the generic
    // `integration_not_synchronizable` bucket. Native rows fall through
    // to that generic code by design — the worker has no role in native
    // mode (see `hasActiveDelegatedSyncIntegration`).
    if (integrationState.mode === "delegated" && integrationState.delegatedSyncEnabled === false) {
      return { ok: false, error: "integration_disabled" };
    }
    const backend = backendForCadence(integrationState);
    if (!backend) {
      return { ok: false, error: "integration_not_synchronizable" };
    }

    const normalizer = getSnapshotNormalizer(def.integration);
    /* c8 ignore start — every shipped integration registers a normalizer;
     *   defensive against future descriptor-before-normalizer drift. */
    if (!normalizer) return { ok: false, error: "integration_not_synchronizable" };
    /* c8 ignore stop */

    this.tickRunning = true;
    try {
      await this.runCadence(def, normalizer, backend);
      return { ok: true };
    } finally {
      this.tickRunning = false;
    }
  }

  private async runTick(force: boolean): Promise<void> {
    const integrations = readIntegrations(this.options.db);
    const runtimeConfig = this.readRuntimeConfig();
    const now = this.now();

    // Active-hours gate (delegated-sync-opt-in.md). Outside the window the
    // entire tick is skipped; cadences don't accrue failureCount or move
    // their lastAttemptAt clock. `force=true` (test fixtures, future
    // batch-run paths) bypasses time gating; `runCadenceNow` has its own
    // bypass via the run-once code path above.
    if (!force) {
      const activeHours = resolveActiveHours(runtimeConfig);
      if (!isWithinActiveHours(now, this.options.timezone, activeHours)) {
        return;
      }
    }

    for (const def of this.cadences) {
      const integrationState = integrations[def.integration];
      const backend = backendForCadence(integrationState);
      if (!backend) continue;

      // Per-cadence opt-in (default false). `force=true` bypasses so the
      // existing test fixtures and any future "run all due cadences now"
      // call stay simple. The integration master switch above is the kill
      // switch and is honoured even under `force=true`.
      if (!force && !isCadenceEnabled(def, runtimeConfig)) continue;

      const normalizer = getSnapshotNormalizer(def.integration);
      // Defensive: every IntegrationKey ships a normalizer after Phase 5.
      // The branch survives so a future integration whose connector
      // wiring lands before its normalizer doesn't crash the worker; the
      // cadence is silently skipped instead.
      /* c8 ignore start */
      if (!normalizer) {
        logger.debug(
          { integration: def.integration, windowKey: def.windowKey },
          "Skipping cadence sync without a snapshot normalizer",
        );
        continue;
      }
      /* c8 ignore stop */

      const id = cadenceId(def);
      const state = this.getState(id);
      const intervalSeconds = this.resolveIntervalSeconds(def, runtimeConfig);
      const effectiveSeconds = computeEffectiveIntervalSeconds(
        intervalSeconds,
        state.failureCount,
      );
      if (!force && !cadenceDue(state, effectiveSeconds, now)) continue;

      await this.runCadence(def, normalizer, backend);
    }
  }

  private async runCadence(
    def: DelegatedSyncCadenceDefinition,
    normalizer: IntegrationNormalizer,
    backendId: BackendId,
  ): Promise<void> {
    const id = cadenceId(def);
    const state = this.getState(id);
    const startedAt = this.now();
    state.lastAttemptAt = startedAt.toISOString();

    let invokeResult: InvokeResult | null = null;
    let diff: ReconcileDiff | null = null;
    let sideEffects: DriftSideEffects = emptyDriftSideEffects();
    let itemsSeen = 0;
    let retryAttempts = 0;
    try {
      const { windowMin, windowMax } = def.buildWindow(startedAt);
      const ctx: DelegatedSyncCadenceContext = {
        windowMin,
        windowMax,
        now: startedAt,
        calendarId: this.options.calendarId,
        maxResults: def.maxResults,
      };
      const { toolName, toolArgs } = def.buildToolCall(backendId, ctx);
      // Cadence-path model pin. The canonical delegated proxy resolver
      // returns the lite-tier model (Haiku on Claude); audit log
      // 2026-05-04 showed the cadence calls timing out at the wall-clock
      // cap on Haiku — the connector tool sequence (ToolSearch → tool →
      // response) plus session-dir cold-start was overrunning the 30s
      // window. Pin the cadence to medium tier (Sonnet on Claude / 2.5-
      // flash on Gemini) so cadence reliability does not regress when an
      // operator pins Haiku via `integrations.md` for synchronous skill
      // calls — those still flow through `delegatedModel` resolution and
      // are unaffected.
      const cadenceModelOverride = defaultModelForTier(backendId, "medium");
      const invokeParams = {
        integrationKey: def.integration,
        toolName,
        toolArgs,
        parentProcessKey: DELEGATED_SYNC_PROCESS_KEY,
        modelOverride: cadenceModelOverride,
      };

      while (true) {
        invokeResult = await this.invokeWithTimeout(invokeParams);
        if (invokeResult.ok) break;
        if (
          retryAttempts >= MAX_RETRY_ATTEMPTS
          || !RETRYABLE_ERROR_CLASSES.has(invokeResult.errorClass)
        ) {
          break;
        }
        retryAttempts += 1;
        logger.info(
          {
            integration: def.integration,
            windowKey: def.windowKey,
            backendId,
            errorClass: invokeResult.errorClass,
            attempt: retryAttempts,
            maxRetryAttempts: MAX_RETRY_ATTEMPTS,
          },
          "Delegated sync cadence retrying after transient failure",
        );
        await sleep(RETRY_DELAY_MS);
      }
      if (!invokeResult.ok) {
        throw new Error(invokeResult.message);
      }

      const rawItems = def.extractItems(invokeResult.toolResult);
      itemsSeen = rawItems.length;
      const items = normalizeItems(rawItems, normalizer);
      const req: ReconcileRequest = {
        integration: def.integration,
        windowKey: def.windowKey,
        windowMin,
        windowMax,
        fetchedAt: startedAt.toISOString(),
        items,
      };
      diff = reconcile(this.options.db, req, {
        normalizer,
        onDiffInTransaction: (d) => {
          sideEffects = applyDriftEffects(req, d, {
            db: this.options.db,
            calendarId: this.options.calendarId,
            timezone: this.options.timezone,
            todayWriteLock: this.options.todayWriteLock,
            triggerRoadmapRefresh: this.options.triggerRoadmapRefresh,
            // Phase 7: forward the worker's clock so today-drift detection
            // is deterministic in tests (the worker uses an injected now()
            // for window construction; without this forwarder drift-effects
            // would call real `new Date()` and the test would flap across
            // UTC midnight when the fixed NOW and the real clock disagree
            // on what `today` is).
            now: this.now,
          });
        },
      });

      const completedAt = this.now();
      state.lastCompletedAt = completedAt.toISOString();
      state.lastSuccessAt = completedAt.toISOString();
      state.failureCount = 0;
      state.lastError = null;
      recordDelegatedSyncAction(this.options.db, {
        def,
        result: "success",
        startedAt,
        completedAt,
        invokeResult,
        itemsSeen,
        diff,
        sideEffects,
        error: null,
        retryAttempts,
      });
    } catch (err) {
      const completedAt = this.now();
      const message = err instanceof Error ? err.message : String(err);
      state.lastCompletedAt = completedAt.toISOString();
      state.failureCount += 1;
      state.lastError = message;
      recordDelegatedSyncAction(this.options.db, {
        def,
        result: "failed",
        startedAt,
        completedAt,
        invokeResult,
        itemsSeen,
        diff,
        sideEffects,
        error: message,
        retryAttempts,
      });
      logger.warn(
        {
          err,
          integration: def.integration,
          windowKey: def.windowKey,
          failureCount: state.failureCount,
        },
        "Delegated sync cadence failed",
      );
    }
  }

  private getState(id: string): CadenceRuntimeState {
    let state = this.states.get(id);
    if (!state) {
      state = {
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastCompletedAt: null,
        failureCount: 0,
        lastError: null,
      };
      this.states.set(id, state);
    }
    return state;
  }

  /**
   * Resolve the effective wall-clock timeout for a single invocation.
   * Precedence: constructor override > runtime_state > built-in default.
   *
   * The runtime_state path is clamped to `[MIN_INVOKER_TIMEOUT_MS, ∞)` so
   * an operator typo cannot flap healthy cadences into the timeout retry
   * path. The constructor override deliberately bypasses the floor — it
   * is a programmatic injection point (production wiring + tests) and the
   * caller already knows the floor. This mirrors the convention used by
   * the rest of the options surface (e.g. `tickIntervalSeconds`, where
   * the constructor option also bypasses operator-side floors).
   *
   * Defensive: an override of zero or a negative number (programmer bug)
   * would race the timeout against the very first event-loop turn and
   * effectively disable cadences. Fall back to the default in that case
   * — tests that need a tiny timeout must use a small positive value
   * (e.g. 50 ms), which is what every existing test does.
   */
  private resolveInvokerTimeoutMs(
    runtimeConfig: DelegatedSyncRuntimeConfig,
  ): number {
    const override = this.invokerTimeoutMsOverride;
    if (override !== undefined) {
      if (Number.isFinite(override) && override > 0) return override;
      logger.warn(
        { invokerTimeoutMsOverride: override },
        "Ignoring non-positive invokerTimeoutMs override; falling back to default",
      );
    }
    const configuredSeconds = positiveNumber(runtimeConfig.invokerTimeoutSeconds);
    if (configuredSeconds !== null) {
      return Math.max(configuredSeconds * 1000, MIN_INVOKER_TIMEOUT_MS);
    }
    return DEFAULT_INVOKER_TIMEOUT_MS;
  }

  /**
   * Race `invoker.invoke()` against a wall-clock timer. On timeout:
   *   1. Abort the invoker's `abortSignal` so the subprocess gets a chance
   *      to bail out (proxy path honours abort; CLI subprocess paths kill
   *      the child).
   *   2. Resolve with a synthetic `errorClass: "timeout"` result so the
   *      existing retry path inside `runCadence` handles it identically
   *      to invoker-internal timeouts. `RETRYABLE_ERROR_CLASSES` already
   *      includes "timeout".
   *
   * Why this exists even though the invoker has its own timeout: a hung
   * subprocess that ignores SIGTERM (rare, but observed under heavy fs
   * pressure during integration tests) would still leave the invoker's
   * await unresolved indefinitely. The outer race is the worker's
   * self-defence: it guarantees `tickRunning` releases within
   * `invokerTimeoutMs + a small scheduling delay`, regardless of whether
   * the invoker's own cancellation path completed.
   */
  private async invokeWithTimeout(
    params: Parameters<DelegatedBackendInvoker["invoke"]>[0],
  ): Promise<InvokeResult> {
    const runtimeConfig = this.readRuntimeConfig();
    const timeoutMs = this.resolveInvokerTimeoutMs(runtimeConfig);

    const ac = new AbortController();
    // If the caller supplied a signal, forward its abort to our controller
    // so cancellation chains transparently. The cadence path does not pass
    // one today, but the type allows it (`InvokeParams.abortSignal`).
    const externalSignal = params.abortSignal;
    const externalListener = () => ac.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) {
        ac.abort(externalSignal.reason);
      } else {
        externalSignal.addEventListener("abort", externalListener, { once: true });
      }
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    const timeoutPromise = new Promise<InvokeResult>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        ac.abort(new Error("delegated-sync invoker wall-clock timeout"));
        resolve({
          ok: false,
          errorClass: "timeout",
          message:
            `Delegated sync invoker did not return within ${timeoutMs} ms; `
            + "aborted to free the tickRunning mutex",
        });
      }, timeoutMs);
    });

    const invokePromise = this.options.invoker.invoke({
      ...params,
      abortSignal: ac.signal,
    });
    // Pre-attach a catch handler so a late rejection (after timeout fired)
    // cannot escape as an `unhandledRejection`. The original promise still
    // wins the race when it resolves first; this catch is only reached
    // when the race already settled on the timeout branch.
    invokePromise.catch((err: unknown) => {
      if (!timedOut) return;
      logger.debug(
        { err },
        "Invoker resolved late after wall-clock timeout — result discarded",
      );
    });

    try {
      return await Promise.race([invokePromise, timeoutPromise]);
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", externalListener);
      }
    }
  }

  private readRuntimeConfig(): DelegatedSyncRuntimeConfig {
    const raw = readRuntimeState<DelegatedSyncRuntimeConfig>(
      this.options.db,
      RUNTIME_CONFIG_KEY,
    );
    if (!raw || typeof raw !== "object") return {};
    return raw;
  }

  private resolveIntervalSeconds(
    def: DelegatedSyncCadenceDefinition,
    runtimeConfig: DelegatedSyncRuntimeConfig,
  ): number {
    const configured = runtimeConfig.intervals?.[cadenceId(def)]
      ?? runtimeConfig.intervals?.[`${def.integration}.${def.windowKey}`]
      ?? runtimeConfig.intervals?.[def.windowKey];
    const floor = Math.max(
      def.softFloorSeconds,
      positiveNumber(runtimeConfig.minIntervalSeconds)
        ?? DEFAULT_MIN_INTERVAL_SECONDS,
    );
    return Math.max(
      floor,
      positiveNumber(configured) ?? def.defaultIntervalSeconds,
    );
  }

  /**
   * Phase 7 (h): rebuild per-cadence `lastAttemptAt` / `lastSuccessAt` from
   * the most recent `delegated_sync` row in `agent_actions` so a daemon
   * restart shortly after a successful sync does not re-spawn a subprocess
   * for that cadence. Idempotent — re-running on an already-warm states
   * map only overwrites with same-or-newer timestamps. Failures during
   * hydration log warn and leave the cadence's state empty (which falls
   * back to "due immediately", matching the prior force-on-start
   * behaviour).
   */
  private hydrateStateFromHistory(): void {
    for (const def of this.cadences) {
      try {
        const row = this.options.db
          .prepare(
            `SELECT started_at AS startedAt, completed_at AS completedAt, result
             FROM agent_actions
             WHERE action_type = 'delegated_sync'
               AND json_extract(detail, '$.integration') = ?
               AND json_extract(detail, '$.windowKey') = ?
             ORDER BY started_at DESC
             LIMIT 1`,
          )
          .get(def.integration, def.windowKey) as
          | { startedAt: string; completedAt: string; result: string }
          | undefined;
        if (!row) continue;
        const state = this.getState(cadenceId(def));
        const startedIso = sqliteDatetimeToIso(row.startedAt);
        const completedIso = sqliteDatetimeToIso(row.completedAt);
        if (startedIso) state.lastAttemptAt = startedIso;
        if (completedIso) state.lastCompletedAt = completedIso;
        if (row.result === "success" && completedIso) {
          state.lastSuccessAt = completedIso;
        }
        /* c8 ignore start — defensive against a stripped test schema or
         *   a corrupted agent_actions row; production always has the
         *   table and json_extract returns null for missing keys rather
         *   than throwing. The worst case is one redundant subprocess
         *   spawn on the first tick, which is the prior force-on-start
         *   behaviour. */
      } catch (err) {
        logger.warn(
          { err, integration: def.integration, windowKey: def.windowKey },
          "Hydration from agent_actions failed; cadence will tick on first cycle",
        );
      }
      /* c8 ignore stop */
    }
  }

  /**
   * Phase 7 (g) + (c): emit a single warn at start when the operator's
   * `runtime_state.delegatedSync.intervals` includes typo'd keys or when a
   * resolved cadence violates the TTL × 1.5 contract. Both checks fire
   * once per `start()` to avoid log spam; they are also exposed via
   * `getStatus()` so the dashboard can surface them on-screen.
   */
  private warnOnConfigViolations(): void {
    const runtimeConfig = this.readRuntimeConfig();
    const unrecognized = collectUnrecognizedIntervalKeys(
      this.cadences,
      runtimeConfig,
    );
    if (unrecognized.length > 0) {
      logger.warn(
        { unrecognizedIntervalKeys: unrecognized },
        "delegatedSync.intervals contains keys that did not resolve to any known cadence id; configured values are ignored for those keys",
      );
    }

    const violations: Array<{
      cadenceId: string;
      intervalSeconds: number;
      ttlSeconds: number;
    }> = [];
    for (const def of this.cadences) {
      const intervalSeconds = this.resolveIntervalSeconds(def, runtimeConfig);
      const ttlSeconds = Math.floor(
        INTEGRATION_WRITE_TTL_MS[def.integration] / 1000,
      );
      if (intervalSeconds * TTL_CONTRACT_RATIO > ttlSeconds) {
        violations.push({ cadenceId: cadenceId(def), intervalSeconds, ttlSeconds });
      }
    }
    if (violations.length > 0) {
      logger.warn(
        { ttlContractViolations: violations, ttlContractRatio: TTL_CONTRACT_RATIO },
        "delegatedSync cadence(s) exceed integration_writes TTL × 1.5; agent-originated writes within these cadences may be re-attributed actor='user' on the next reconcile",
      );
    }
  }
}

function cadenceId(def: DelegatedSyncCadenceDefinition): string {
  return `${def.integration}:${def.windowKey}`;
}

/**
 * Per-cadence opt-in check (delegated-sync-opt-in.md). Defaults to `false`
 * when the operator hasn't set the flag, which means a fresh
 * `runtime_state.delegatedSync` row keeps every cadence dormant. Canonical
 * fully-qualified IDs only — the legacy alias forms accepted by `intervals`
 * are intentionally not honoured here so a future cadence collision cannot
 * silently flip the wrong toggle.
 */
function isCadenceEnabled(
  def: DelegatedSyncCadenceDefinition,
  runtimeConfig: DelegatedSyncRuntimeConfig,
): boolean {
  return runtimeConfig.cadenceEnabled?.[cadenceId(def)] === true;
}

/**
 * Resolve the active-hours window from operator config, falling back to
 * the Hourly-Check-aligned default. A malformed or out-of-range pair (e.g.
 * `start >= end`, or numbers outside `[0,24]`) is treated as "use defaults"
 * — the worker can't usefully interpret an inverted window, and falling
 * back keeps cadences running rather than silently disabling them.
 */
export function resolveActiveHours(
  runtimeConfig: DelegatedSyncRuntimeConfig,
): DelegatedSyncActiveHours {
  const start = runtimeConfig.activeStartHour;
  const end = runtimeConfig.activeEndHour;
  if (
    Number.isInteger(start)
    && Number.isInteger(end)
    && (start as number) >= 0
    && (start as number) <= 23
    && (end as number) >= 1
    && (end as number) <= 24
    && (start as number) < (end as number)
  ) {
    return { startHour: start as number, endHour: end as number };
  }
  return {
    startHour: DEFAULT_ACTIVE_START_HOUR,
    endHour: DEFAULT_ACTIVE_END_HOUR,
  };
}

/**
 * `true` when `now` falls inside `[startHour, endHour)` in the daemon's
 * configured timezone. `endHour=24` is exclusive — i.e. covers up to
 * 23:59:59. Mirrors the semantics of Hourly Check's window so an operator
 * who already understands one understands the other.
 */
export function isWithinActiveHours(
  now: Date,
  timezone: string | undefined,
  activeHours: DelegatedSyncActiveHours,
): boolean {
  const local = nowInTimezone(timezone, now);
  return local.hours >= activeHours.startHour && local.hours < activeHours.endHour;
}

/**
 * INTEGRATION-DRIFT-DETECTION-PLAN.md §17.11 — `integration_writes.expires_at`
 * must outlive the slowest reconcile cadence by ~1.5×, otherwise an
 * agent-originated write at T0 has its mark expire just before the next
 * worker tick re-fetches and the diff resolves `actor='user'` instead of
 * `'agent'`. Phase 7 (c) tightens both halves: the TTL constants
 * (INTEGRATION_WRITE_TTL_MS, in @aitne/shared) cover the default
 * cadences with margin, and this ratio is the daemon-side check that fires
 * a warn when an operator-tuned cadence pushes past the boundary.
 */
const TTL_CONTRACT_RATIO = 1.5;

/**
 * Build the alias set a runtime-config key may take and check operator-
 * supplied keys against it. Three accepted forms:
 *   - canonical fully-qualified (`google_calendar:primary:24h`)
 *   - dotted human-friendly (`google_calendar.primary:24h`)
 *   - integration-local (`primary:24h` — only unambiguous when the window
 *     key is unique across cadences, which the §8.2 default set respects)
 *
 * Returns the sorted list of operator keys that match none of the three
 * forms for any registered cadence. Sorted for stable assertions and
 * stable health-endpoint output.
 */
function collectUnrecognizedIntervalKeys(
  cadences: readonly DelegatedSyncCadenceDefinition[],
  runtimeConfig: DelegatedSyncRuntimeConfig,
): string[] {
  if (!runtimeConfig.intervals) return [];
  const known = new Set<string>();
  for (const def of cadences) {
    known.add(cadenceId(def));
    known.add(`${def.integration}.${def.windowKey}`);
    known.add(def.windowKey);
  }
  const unrecognized: string[] = [];
  for (const key of Object.keys(runtimeConfig.intervals)) {
    if (!known.has(key)) unrecognized.push(key);
  }
  return unrecognized.sort();
}

/**
 * `agent_actions` stores `started_at` / `completed_at` as SQLite datetime
 * (`YYYY-MM-DD HH:MM:SS`). Hydration converts them back to ISO 8601 to
 * match the in-memory `CadenceRuntimeState` format. Returns `null` for an
 * unparseable value so a malformed historical row does not poison the
 * runtime state map.
 */
function sqliteDatetimeToIso(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const normalised = value.includes("T") ? value : value.replace(" ", "T");
  const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(normalised)
    ? normalised
    : `${normalised}Z`;
  const ms = Date.parse(withZone);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function computeEffectiveIntervalSeconds(
  intervalSeconds: number,
  failureCount: number,
): number {
  return failureCount >= CIRCUIT_FAILURE_THRESHOLD
    ? intervalSeconds * CIRCUIT_BACKOFF_MULTIPLIER
    : intervalSeconds;
}

function cadenceDue(
  state: CadenceRuntimeState,
  intervalSeconds: number,
  now: Date,
): boolean {
  if (!state.lastAttemptAt) return true;
  const lastAttemptMs = Date.parse(state.lastAttemptAt);
  if (!Number.isFinite(lastAttemptMs)) return true;
  return now.getTime() - lastAttemptMs >= intervalSeconds * 1000;
}

/**
 * `nextRunAt` projects the next time this cadence is expected to fire.
 * Computes the interval-based candidate (or `now` for first run / malformed
 * lastAttemptAt), floors to `now` (never returns a past instant), and then
 * shifts forward to the next active-hours start when the candidate falls
 * outside the configured window. Mirrors the worker's actual gating order
 * (active-hours gate first, then cadenceDue) so the dashboard's "next run
 * in Xm" matches what the operator will observe.
 */
function nextRunAt(
  state: CadenceRuntimeState,
  intervalSeconds: number,
  now: Date,
  timezone: string | undefined,
  activeHours: DelegatedSyncActiveHours,
): string | null {
  let candidateMs: number;
  if (!state.lastAttemptAt) {
    candidateMs = now.getTime();
  } else {
    const lastAttemptMs = Date.parse(state.lastAttemptAt);
    candidateMs = Number.isFinite(lastAttemptMs)
      ? lastAttemptMs + intervalSeconds * 1000
      : now.getTime();
  }
  // Floor to `now` — a recurrence due in the past would actually fire on
  // the next tick, not retroactively. Reporting it as "now" is the most
  // accurate forward-looking value.
  const candidate = new Date(Math.max(candidateMs, now.getTime()));
  return nextActiveHoursStart(
    candidate,
    timezone,
    activeHours.startHour,
    activeHours.endHour,
  ).toISOString();
}

/**
 * Resolve the fully-qualified tool name for `(integration, backendId, bareTool)`.
 * Throws when the descriptor lacks a connector for the requested backend —
 * defensive against an integration mode change racing the worker tick (the
 * caller has already confirmed `delegatedBackend` resolves; this is the
 * second-line check the descriptor lookup performs anyway).
 */
function namespacedTool(
  integration: IntegrationKey,
  backendId: BackendId,
  bareTool: string,
): string {
  const connector
    = INTEGRATION_DESCRIPTORS[integration].backendConnectors[backendId];
  /* c8 ignore next 5 */
  if (!connector) {
    throw new Error(
      `${integration} has no delegated connector for backend '${backendId}'`,
    );
  }
  return `${connector.toolNamespace}${bareTool}`;
}

function calendarListBareTool(backendId: BackendId): string {
  return backendId === "claude"
    ? "list_events"
    : backendId === "codex"
      ? "search_events"
      : "listEvents";
}

/**
 * Per-integration item-array key list. Connectors wrap upstream payloads
 * differently — `events` for calendar list (Google API native field),
 * `messages` / `threads` for Gmail search, `results` / `pages` for Notion
 * search. The cadence-supplied list is what the worker walks via
 * {@link extractItemsByKeys} when normalising the tool result.
 */
const CALENDAR_ITEM_KEYS = ["events", "items", "calendarEvents"] as const;
const GMAIL_ITEM_KEYS = ["threads", "messages", "items"] as const;
const NOTION_ITEM_KEYS = ["results", "pages", "items"] as const;

const SHARED_WRAPPER_KEYS = ["toolResult", "data", "result"] as const;

function extractItemsByKeys(
  value: unknown,
  keys: readonly string[],
): unknown[] {
  const items = tryExtractItemsByKeys(value, keys, 0);
  if (items) return items;
  throw new Error(
    `delegated tool result did not contain an item array (looked for ${
      [...keys, ...SHARED_WRAPPER_KEYS].join(", ")
    })`,
  );
}

function tryExtractItemsByKeys(
  value: unknown,
  keys: readonly string[],
  depth: number,
): unknown[] | null {
  if (depth > 4) return null;
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return [];
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        return tryExtractItemsByKeys(JSON.parse(trimmed), keys, depth + 1);
      } catch {
        return null;
      }
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  for (const key of [...keys, ...SHARED_WRAPPER_KEYS]) {
    if (key in obj) {
      const nested = tryExtractItemsByKeys(obj[key], keys, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Per-backend Gmail search tool call. Each Codex / Claude / Gemini Gmail
 * connector exposes a slightly different search API; this maps the
 * cadence's intent (`newer_than:7d`, capped to `maxResults`) onto the
 * connector's actual parameter names. The tool name resolves through
 * `INTEGRATION_DESCRIPTORS.gmail.backendConnectors[backendId].toolNamespace`
 * so namespace drift in the descriptor stays the single source of truth.
 */
function gmailSearchToolCall(
  backendId: BackendId,
  ctx: DelegatedSyncCadenceContext,
): DelegatedSyncToolCall {
  const query = "newer_than:7d";
  switch (backendId) {
    case "claude":
      return {
        toolName: namespacedTool("gmail", "claude", "search_threads"),
        toolArgs: { query, pageSize: ctx.maxResults },
      };
    case "codex":
      return {
        toolName: namespacedTool("gmail", "codex", "search_emails"),
        toolArgs: { query, max_results: ctx.maxResults },
      };
    case "gemini":
      return {
        toolName: namespacedTool("gmail", "gemini", "search"),
        toolArgs: { query, maxResults: ctx.maxResults },
      };
    // Exhaustive switch over the BackendId union; a future backend would
    // surface here at compile time.
    /* c8 ignore start */
    default:
      throw new Error(`unsupported backend '${backendId as string}' for gmail`);
    /* c8 ignore stop */
  }
}

/**
 * Per-backend Notion search tool call. All three connectors accept the
 * same shape (`query`, `filters.created_date_range.start_date`, page-size
 * cap), but the bare tool name differs: Codex strips the `notion-` prefix
 * (`_search` vs `notion-search`).
 */
function notionSearchToolCall(
  backendId: BackendId,
  ctx: DelegatedSyncCadenceContext,
): DelegatedSyncToolCall {
  const startDate = isoDate(ctx.windowMin);
  const args = {
    query: "updated",
    filters: { created_date_range: { start_date: startDate } },
    page_size: ctx.maxResults,
  };
  switch (backendId) {
    case "claude":
      return { toolName: namespacedTool("notion", "claude", "notion-search"), toolArgs: args };
    case "codex":
      return { toolName: namespacedTool("notion", "codex", "search"), toolArgs: args };
    case "gemini":
      return { toolName: namespacedTool("notion", "gemini", "notion-search"), toolArgs: args };
    /* c8 ignore start */
    default:
      throw new Error(`unsupported backend '${backendId as string}' for notion`);
    /* c8 ignore stop */
  }
}

function isoDate(iso: string): string {
  // Trim ISO-8601 instant down to YYYY-MM-DD. `Date.parse` is the same
  // mechanism the validation layer uses; we slice the resulting ISO string
  // rather than risk a per-locale formatter producing zone-shifted dates.
  const ms = Date.parse(iso);
  // windowMin is built by buildWindow above; an unparseable value would
  // mean the caller corrupted it, which the integration tests would catch
  // before this branch ever fires.
  /* c8 ignore start */
  if (!Number.isFinite(ms)) {
    throw new Error(`isoDate: cannot parse '${iso}'`);
  }
  /* c8 ignore stop */
  return new Date(ms).toISOString().slice(0, 10);
}

function normalizeItems(
  rawEvents: readonly unknown[],
  normalizer: IntegrationNormalizer,
): ReconcileItem[] {
  return rawEvents.map((raw) => {
    const payload = normalizer.payload(raw);
    return {
      itemId: normalizer.itemId(raw),
      contentHash: normalizer.hash(payload),
      payload,
      itemStart: normalizer.itemStart(raw),
    };
  });
}

function zeroCost(): DelegatedToolCost {
  return {
    tokensInput: 0,
    tokensOutput: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    durationMs: 0,
    numTurns: 0,
  };
}

function resultCost(result: InvokeResult | null): DelegatedToolCost {
  if (!result) return zeroCost();
  if (result.ok) return result.cost;
  return result.cost ?? zeroCost();
}

function recordDelegatedSyncAction(
  db: Database.Database,
  args: {
    def: DelegatedSyncCadenceDefinition;
    result: "success" | "failed";
    startedAt: Date;
    completedAt: Date;
    invokeResult: InvokeResult | null;
    itemsSeen: number;
    diff: ReconcileDiff | null;
    sideEffects: DriftSideEffects;
    error: string | null;
    /** Number of retry attempts the cadence performed (0 if first try
     *  succeeded; up to MAX_RETRY_ATTEMPTS). Surfaced in detail.JSON only
     *  when > 0 to keep the audit row compact for the common-case path. */
    retryAttempts: number;
  },
): void {
  const cost = resultCost(args.invokeResult);
  const detail = {
    integration: args.def.integration,
    windowKey: args.def.windowKey,
    itemsSeen: args.itemsSeen,
    ...(args.diff
      ? {
        created: args.diff.created.length,
        modified: args.diff.modified.length,
        deleted: args.diff.deleted.length,
        unchanged: args.diff.unchanged,
        prunedOutOfWindow: args.diff.prunedOutOfWindow,
        isInitialSnapshot: args.diff.isInitialSnapshot,
      }
      : {}),
    sideEffects: args.sideEffects,
    ...(args.retryAttempts > 0 ? { retryAttempts: args.retryAttempts } : {}),
    errorClass:
      args.invokeResult && !args.invokeResult.ok
        ? args.invokeResult.errorClass
        : undefined,
  };

  try {
    db.prepare(
      `INSERT INTO agent_actions (
         event_id, action_type, trigger, model_used,
         cost_usd, tokens_input, tokens_output,
         cache_creation_tokens, cache_read_tokens,
         duration_ms, num_turns, result, detail,
         started_at, completed_at, error, backend, cost_source, source_kind
       ) VALUES (
         NULL, 'delegated_sync', ?, ?,
         ?, ?, ?,
         ?, ?,
         ?, ?, ?, ?,
         datetime(?), datetime(?), ?, ?, 'sdk', 'cron'
       )`,
    ).run(
      DELEGATED_SYNC_PROCESS_KEY,
      args.invokeResult?.modelId ?? null,
      cost.costUsd,
      cost.tokensInput,
      cost.tokensOutput,
      cost.cacheCreationTokens,
      cost.cacheReadTokens,
      cost.durationMs || Math.max(0, args.completedAt.getTime() - args.startedAt.getTime()),
      cost.numTurns,
      args.result,
      JSON.stringify(detail),
      args.startedAt.toISOString(),
      args.completedAt.toISOString(),
      args.error,
      args.invokeResult?.backendId ?? null,
    );
  } catch (err) {
    logger.error({ err }, "failed to record delegated_sync action");
  }
}

export const __delegatedSyncWorkerTestExports = {
  calendarListBareTool,
  namespacedTool,
  extractItemsByKeys,
  gmailSearchToolCall,
  notionSearchToolCall,
  isoDate,
  collectUnrecognizedIntervalKeys,
  sqliteDatetimeToIso,
  isCadenceEnabled,
  TTL_CONTRACT_RATIO,
  CALENDAR_ITEM_KEYS,
  GMAIL_ITEM_KEYS,
  NOTION_ITEM_KEYS,
  CALENDAR_IMMINENT_CADENCE,
  CALENDAR_24H_CADENCE,
  GMAIL_INBOX_7D_CADENCE,
  NOTION_RECENTLY_UPDATED_CADENCE,
  DEFAULT_ACTIVE_START_HOUR,
  DEFAULT_ACTIVE_END_HOUR,
};
