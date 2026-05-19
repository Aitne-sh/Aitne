import type Database from "better-sqlite3";
import { getAgentDayBoundsUtc, getAgentDayDateStr } from "@aitne/shared";
import {
  snapshotManagementTelemetry,
  summarize,
  type ActivityRebuildBucket,
  type HistogramSummary,
  type ManagementTelemetrySnapshot,
} from "./management-telemetry.js";

/**
 * MetricsCollector — aggregates self-evaluation metrics from DB.
 *
 * Design doc §18 metrics:
 * - Notification confirmation rate (> 70% target)
 * - Advisor call rate (opt-in advisor tool usage per session)
 * - Average response time (< 10s target)
 * - Daily cost vs budget
 * - Autonomous sessions today
 */

// ── Timeseries types ──

export interface MetricsDailyBucket {
  date: string;
  executions: number;
  executionsReactive: number;
  executionsAutonomous: number;
  failures: number;
  contextUpdatesAutonomous: number;
  contextUpdatesReactive: number;
  avgDurationMs: number | null;
  notificationsDelivered: number;
  notificationsReacted: number;
}

export interface MetricsErrorGroup {
  category: string;
  count: number;
  lastSeen: string;
  backend: string | null;
  sampleMessage: string;
}

export interface MetricsHeatmapDay {
  date: string;
  count: number;
}

export interface MetricsTimeseriesResponse {
  days: number;
  daily: MetricsDailyBucket[];
  recentErrors: MetricsErrorGroup[];
  heatmap: MetricsHeatmapDay[];
}

// ── Delegated task-mode metrics (DELEGATED-TASK-MODE-DESIGN.md §11.2) ──

/**
 * Result-axis bucket for `delegated_task_total{integration, backend, result}`.
 * `result` distinguishes between schema_violation / parse_error /
 * tool_unavailable / tool_failed / budget_exhausted / etc. as recorded in
 * the row's `errorClass` detail field. `success` covers the happy path
 * **except** when `needsConfirmation: true`, which is reported separately
 * under `destructive_blocked` so the outcomes don't double-count and the
 * dashboard can size the confirmation funnel without parsing detail JSON.
 */
export interface DelegatedTaskTotalBucket {
  integrationKey: string | null;
  backend: string | null;
  result: string;
  count: number;
}

export interface DelegatedTaskHistogramSummary {
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
}

/** Distribution of tool calls per task, grouped by integration+backend. */
export interface DelegatedTaskToolCallsBucket {
  integrationKey: string | null;
  backend: string | null;
  histogram: DelegatedTaskHistogramSummary;
}

/** §6 validation failures: `kind ∈ {parse_error, schema_violation}`. */
export interface DelegatedTaskValidationFailureBucket {
  integrationKey: string | null;
  backend: string | null;
  kind: "parse_error" | "schema_violation";
  count: number;
}

/** Counter incremented when `needsConfirmation: true` is returned. */
export interface DelegatedTaskDestructiveBlockedBucket {
  integrationKey: string | null;
  backend: string | null;
  count: number;
}

/** Summed cost across the window. */
export interface DelegatedTaskCostBucket {
  integrationKey: string | null;
  backend: string | null;
  costUsd: number;
}

export interface DelegatedTaskMetricsSnapshot {
  /** Window in days the snapshot covers. */
  windowDays: number;
  /** ISO timestamp the snapshot was generated. */
  collectedAt: string;
  total: DelegatedTaskTotalBucket[];
  toolCalls: DelegatedTaskToolCallsBucket[];
  validationFailures: DelegatedTaskValidationFailureBucket[];
  destructiveBlocked: DelegatedTaskDestructiveBlockedBucket[];
  costUsd: DelegatedTaskCostBucket[];
}

// ── Pre-pass fan-out metrics (docs/design/appendices/pre-pass-fan-out.md §7.3) ──

/**
 * One terminal-status bucket for `pre_pass_total{routine, integration, status}`.
 * The "status" axis is the chain's FINAL attempt status (the last
 * `routine.fetch_window` agent_actions row for a given
 * (parentCorrelationId, integrationKey) pair). Counts the number of
 * CHAINS — not attempts — so a 3-attempt chain ending in `failed`
 * contributes 1 to `failed`, not 3.
 */
export interface PrePassChainStatusBucket {
  routine: string;
  integrationKey: string;
  status: "success" | "partial" | "failed" | "skipped";
  count: number;
}

/**
 * Histogram bucket for `pre_pass_attempts{routine, integration}`. The
 * samples are the per-chain attempt counts (1 for first-try success,
 * up to `prePassMaxAttemptsPerIntegration` for an exhausted chain).
 */
export interface PrePassAttemptsBucket {
  routine: string;
  integrationKey: string;
  histogram: HistogramSummary;
}

/**
 * Histogram bucket for `pre_pass_cost_usd{routine}`. Samples are the
 * per-chain total cost (sum of `cost_usd` across all attempts).
 * Aggregated at routine level (not per-integration) per design §7.3
 * — a routine's pre-pass spend is the operator's primary cost lever.
 */
export interface PrePassCostBucket {
  routine: string;
  histogram: HistogramSummary;
}

/**
 * Histogram bucket for `pre_pass_duration_ms{routine, integration}`.
 * Samples are the per-chain total wall-clock duration in milliseconds
 * (sum of `duration_ms` across all attempts in the chain).
 */
export interface PrePassDurationBucket {
  routine: string;
  integrationKey: string;
  histogram: HistogramSummary;
}

/**
 * Bonus surface beyond the §7.3 metric set — counts of fan-out audit
 * rows where the SDK fell back from the requested backend mid-execute
 * (`detail.prePass.fallbackTriggered: true`). Recurring entries here
 * point at quota / auth issues on the requested backend.
 */
export interface PrePassFallbackBucket {
  routine: string;
  requestedBackend: string;
  actualBackend: string;
  count: number;
}

/**
 * docs/design/appendices/fetch-window-cost-reduction.md §10.1 — per-backend per-attempt
 * histogram used to verify Phase 1.5 (CLI instruction-file
 * minimization). The Claude `cacheCreationTokensPerAttempt` histogram is
 * the load-bearing surface on Claude; on Codex / Gemini / OpenCode the
 * provider exposes no paid cache-creation dimension, so the per-session
 * input-token spend is the equivalent verification signal — every byte
 * of the instruction file is billed at the full input rate.
 *
 * `actualBackend` is the resolved backend that produced the attempt's
 * row (matches `agent_actions.backend`). Attempts whose backend is
 * unknown (NULL column on legacy rows) are dropped from the histogram
 * rather than bucketed under `unknown` — without a backend axis the
 * row cannot prove the Phase 1.5 saving and would dilute every bucket.
 */
export interface PrePassPerBackendBucket {
  actualBackend: string;
  histogram: HistogramSummary;
}

export interface PrePassMetricsSnapshot {
  /** Window in days the snapshot covers. */
  windowDays: number;
  /** ISO timestamp the snapshot was generated. */
  collectedAt: string;
  /** Total chains (unique parentCorrelationId × integrationKey pairs). */
  totalChains: number;
  /** Total attempts (one per `routine.fetch_window` row in the window). */
  totalAttempts: number;
  /** Per-(routine, integration, finalStatus) chain count. */
  chainsByStatus: PrePassChainStatusBucket[];
  /** Per-(routine, integration) histogram of attempt counts per chain. */
  attemptsPerChain: PrePassAttemptsBucket[];
  /** Per-routine histogram of total cost per chain. */
  costUsdByRoutine: PrePassCostBucket[];
  /** Per-(routine, integration) histogram of total duration per chain. */
  durationMsByIntegration: PrePassDurationBucket[];
  /** Per-(routine, requestedBackend, actualBackend) fallback count. */
  fallbacks: PrePassFallbackBucket[];
  /**
   * docs/design/appendices/fetch-window-cost-reduction.md §10.1 — per-attempt histogram
   * of `cache_creation_tokens`. The Phase 1 success criterion is
   * `p50` dropping by ≥25 K (from ~89 K baseline) across all
   * `routine.fetch_window` attempts in the window. Snapshot-level
   * (not per-routine / per-integration) because the cache_create cost
   * is dominated by what the SDK loads at session start, which is
   * identical across parents — splitting per-routine would just
   * fragment the same population without adding a signal.
   *
   * Phase 1.5 amendment: filtered to `actualBackend === 'claude'` only.
   * Codex / Gemini parsers hard-code `cache_creation_tokens = 0` (their
   * providers don't expose a paid cache-creation dimension), and
   * including those zeros would skew p50 toward 0 and obscure the
   * Phase 1 verification target. Post-D13, when the OpenCode core
   * starts populating cache.write into the same column, extend the
   * filter to `IN ('claude', 'opencode')`.
   */
  cacheCreationTokensPerAttempt: HistogramSummary;
  /**
   * Companion to `cacheCreationTokensPerAttempt`: per-attempt histogram
   * of `cache_read_tokens`. Together with `cacheCreationTokensPerAttempt`
   * the operator can derive the cache reuse ratio (`p50(read) /
   * p50(create)`) directly from the snapshot — the design's §1.1 table
   * compared the Haiku reuse ratio (1.51×) to Sonnet's (8.05×) as the
   * primary symptom of the cost shape, and Phase 1 should leave the
   * read side unchanged while shrinking the create side.
   *
   * Same Phase 1.5 filter as `cacheCreationTokensPerAttempt` —
   * Claude-only — for symmetry, so the reuse ratio derived from the
   * two histograms always reflects the same population.
   */
  cacheReadTokensPerAttempt: HistogramSummary;
  /**
   * docs/design/appendices/fetch-window-cost-reduction.md §10.1 (Phase 1.5) — per-backend
   * histogram of `tokens_input` for `routine.fetch_window` attempts. The
   * non-Claude analog of `cacheCreationTokensPerAttempt`: this is the
   * surface that directly observes Phase 1.5's CLI instruction-file
   * minimization on Codex / Gemini (and OpenCode, post-D13).
   */
  inputTokensByBackend: PrePassPerBackendBucket[];
  /**
   * docs/design/appendices/fetch-window-cost-reduction.md §10.1 (Phase 1.5) — per-backend
   * histogram of `cost_usd` for `routine.fetch_window` attempts.
   * Surfaces the dollar impact of Phase 1.5 / Phase 3 on each backend
   * independently — provider pricing differs significantly, so a single
   * cross-backend cost number would not be actionable.
   */
  costUsdByBackend: PrePassPerBackendBucket[];
}

// ── Management-registry metrics (docs/design/21 §14.3, P8) ──

/**
 * Per-`mt_id` consecutive-failure gauge bucket. Tracks the
 * `aitne_managed_tasks_consecutive_failures{mt_id}` series. Only rows
 * with `consecutive_failures > 0` are emitted so the snapshot stays
 * compact at steady state (most managed tasks have zero failures).
 */
export interface ManagedTaskConsecutiveFailureBucket {
  mtId: string;
  count: number;
  /** User-typed app label, surfaced so dashboards don't need a JOIN. */
  app: string;
}

/**
 * Result-axis tally for `aitne_managed_tasks_runs_total{result}`.
 * Bucketed by the `last_result` payload of `management_task.run_recorded`
 * and `management_task.run_now` audit rows. Strings starting with
 * `failed` map to `failed`, `skipped` map to `skipped`, anything else
 * (including `ok`, `ok (3 new)`, etc.) maps to `ok`. Rows with no
 * `last_result` payload are counted as `unknown`.
 */
export interface ManagedTaskRunsTotal {
  ok: number;
  failed: number;
  skipped: number;
  unknown: number;
}

export interface ManagementMetricsSnapshot {
  /** ISO timestamp the snapshot was generated. */
  collectedAt: string;
  /** Window in days the run-tally covers (clamped to [1, 90]). */
  windowDays: number;
  /** `aitne_managed_tasks_active` — active row count from `managed_tasks`. */
  active: number;
  /** Soft-warning threshold (`MANAGEMENT_ACTIVE_TASKS_SOFT_WARNING`). */
  softWarningThreshold: number;
  /** Hard-cap from `managementMaxActiveTasks` (defaults to 100). */
  hardCap: number;
  /** `aitne_managed_tasks_runs_total{result}` over the window. */
  runs: ManagedTaskRunsTotal;
  /** `aitne_managed_tasks_consecutive_failures{mt_id}` (only > 0). */
  consecutiveFailures: ManagedTaskConsecutiveFailureBucket[];
  /** Configured 3-strikes notify threshold (NFR / §10.4). */
  failureNotifyThreshold: number;
  /** `failingNow`: count of rows at or above the notify threshold. */
  failingNow: number;
  /**
   * Render histogram for `aitne_management_md_render_seconds`. Stored
   * in **milliseconds** so the field name matches `rebuildMs` below;
   * the design's `_seconds` suffix is the Prometheus naming convention,
   * not the JSON unit.
   */
  managementMdRenderMs: HistogramSummary;
  /** `aitne_activity_view_rebuild_seconds{source}` per active source. */
  activityViewRebuildMs: ActivityRebuildBucket[];
  /** `aitne_entity_mirror_lag_ms` — most-recent lag observation. */
  entityMirrorLag: ManagementTelemetrySnapshot["entityMirrorLag"];
}

// ── Snapshot types ──

export interface MetricsSnapshot {
  /** ISO timestamp of when metrics were collected */
  collectedAt: string;

  /** Notification confirmation rate (0–1) over last 30 days */
  notificationConfirmRate: number | null;
  /** Breakdown: delivered / reacted / total */
  notificationCounts: {
    delivered: number;
    reacted: number;
    suppressed: number;
  };

  /** Advisor call rate: advisor tool calls per successful session (last 30 days).
   *  Returns null until advisor telemetry is wired up. */
  advisorCallRate: number | null;
  proactiveForwardResume: {
    injected: number;
    disavowed: number;
    ratio: number | null;
    threshold: number;
  };
  /** Breakdown: Sonnet / Opus successful sessions last 30 days */
  modelCounts: {
    sonnetSessions: number;
    opusSessions: number;
  };

  /** Response time (ms) — for reactive message sessions */
  responseTime: {
    p50: number | null;
    p90: number | null;
    p95: number | null;
    p99: number | null;
    avg: number | null;
  };

  /** Cost metrics */
  cost: {
    todayUsd: number;
    last7dUsd: number;
    last30dUsd: number;
  };

  /** Session metrics */
  sessions: {
    todayTotal: number;
    todayAutonomous: number;
    todayReactive: number;
  };
}

export class MetricsCollector {
  constructor(
    private readonly db: Database.Database,
    private readonly timezoneConfig: { timezone: string; dayBoundaryHour: number } = { timezone: "", dayBoundaryHour: 4 },
  ) {}

  collectTimeseries(days: number, now?: Date): MetricsTimeseriesResponse {
    if (days === 0) {
      return this.todayTimeseries(now);
    }
    const daily = this.dailyBuckets(days);
    const recentErrors = this.errorGroups(days);
    const heatmap = this.heatmapData();
    return { days, daily, recentErrors, heatmap };
  }

  private todayTimeseries(now?: Date): MetricsTimeseriesResponse {
    const bounds = getAgentDayBoundsUtc(
      this.timezoneConfig.timezone,
      this.timezoneConfig.dayBoundaryHour,
      now,
    );
    const agentDateStr = getAgentDayDateStr(
      this.timezoneConfig.timezone,
      this.timezoneConfig.dayBoundaryHour,
      now,
    );

    const actionRow = this.db
      .prepare(
        `SELECT
           COUNT(*) as executions,
           COUNT(*) FILTER (WHERE trigger = 'reactive') as reactive,
           COUNT(*) FILTER (WHERE trigger = 'autonomous') as autonomous,
           COUNT(*) FILTER (WHERE result = 'failed') as failures,
           COUNT(*) FILTER (WHERE context_updated = 1 AND trigger = 'autonomous') as ctx_auto,
           COUNT(*) FILTER (WHERE context_updated = 1 AND trigger = 'reactive') as ctx_reactive,
           AVG(CASE WHEN trigger = 'reactive' AND result = 'success' THEN duration_ms END) as avg_duration
         FROM agent_actions
         WHERE started_at >= ? AND started_at < ?`,
      )
      .get(bounds.start, bounds.end) as {
      executions: number;
      reactive: number;
      autonomous: number;
      failures: number;
      ctx_auto: number;
      ctx_reactive: number;
      avg_duration: number | null;
    };

    const notifRow = this.db
      .prepare(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'delivered') as delivered,
           COUNT(*) FILTER (WHERE status = 'delivered' AND user_reaction IS NOT NULL) as reacted
         FROM notification_log
         WHERE created_at >= ? AND created_at < ?`,
      )
      .get(bounds.start, bounds.end) as { delivered: number; reacted: number };

    const daily: MetricsDailyBucket[] = [
      {
        date: agentDateStr,
        executions: actionRow.executions ?? 0,
        executionsReactive: actionRow.reactive ?? 0,
        executionsAutonomous: actionRow.autonomous ?? 0,
        failures: actionRow.failures ?? 0,
        contextUpdatesAutonomous: actionRow.ctx_auto ?? 0,
        contextUpdatesReactive: actionRow.ctx_reactive ?? 0,
        avgDurationMs:
          actionRow.avg_duration !== null && actionRow.avg_duration !== undefined
            ? Math.round(actionRow.avg_duration)
            : null,
        notificationsDelivered: notifRow.delivered,
        notificationsReacted: notifRow.reacted,
      },
    ];

    const recentErrors = this.errorGroupsInRange(bounds.start, bounds.end);
    const heatmap = this.heatmapData();
    return { days: 0, daily, recentErrors, heatmap };
  }

  private dailyBuckets(days: number): MetricsDailyBucket[] {
    // Execution metrics from agent_actions
    const actionRows = this.db
      .prepare(
        `SELECT
           date(started_at) as date,
           COUNT(*) as executions,
           COUNT(*) FILTER (WHERE trigger = 'reactive') as reactive,
           COUNT(*) FILTER (WHERE trigger = 'autonomous') as autonomous,
           COUNT(*) FILTER (WHERE result = 'failed') as failures,
           COUNT(*) FILTER (WHERE context_updated = 1 AND trigger = 'autonomous') as ctx_auto,
           COUNT(*) FILTER (WHERE context_updated = 1 AND trigger = 'reactive') as ctx_reactive,
           AVG(CASE WHEN trigger = 'reactive' AND result = 'success' THEN duration_ms END) as avg_duration
         FROM agent_actions
         WHERE started_at > datetime('now', '-' || ? || ' days')
         GROUP BY date(started_at)
         ORDER BY date ASC`,
      )
      .all(days) as Array<{
      date: string;
      executions: number;
      reactive: number;
      autonomous: number;
      failures: number;
      ctx_auto: number;
      ctx_reactive: number;
      avg_duration: number | null;
      avg_tokens_in: number | null;
      avg_tokens_out: number | null;
    }>;

    // Notification metrics from notification_log
    const notifRows = this.db
      .prepare(
        `SELECT
           date(created_at) as date,
           COUNT(*) FILTER (WHERE status = 'delivered') as delivered,
           COUNT(*) FILTER (WHERE status = 'delivered' AND user_reaction IS NOT NULL) as reacted
         FROM notification_log
         WHERE created_at > datetime('now', '-' || ? || ' days')
         GROUP BY date(created_at)`,
      )
      .all(days) as Array<{
      date: string;
      delivered: number;
      reacted: number;
    }>;

    const actionMap = new Map(actionRows.map((r) => [r.date, r]));
    const notifMap = new Map(notifRows.map((r) => [r.date, r]));

    // Build a continuous date range so charts have no gaps
    const allDates = generateDateRange(days);

    return allDates.map((date) => {
      const row = actionMap.get(date);
      const notif = notifMap.get(date);
      return {
        date,
        executions: row?.executions ?? 0,
        executionsReactive: row?.reactive ?? 0,
        executionsAutonomous: row?.autonomous ?? 0,
        failures: row?.failures ?? 0,
        contextUpdatesAutonomous: row?.ctx_auto ?? 0,
        contextUpdatesReactive: row?.ctx_reactive ?? 0,
        avgDurationMs: row?.avg_duration !== null && row?.avg_duration !== undefined ? Math.round(row.avg_duration) : null,
        notificationsDelivered: notif?.delivered ?? 0,
        notificationsReacted: notif?.reacted ?? 0,
      };
    });
  }

  private errorGroups(days: number): MetricsErrorGroup[] {
    const rows = this.db
      .prepare(
        `SELECT error, model_used, started_at
         FROM agent_actions
         WHERE result = 'failed'
           AND error IS NOT NULL
           AND started_at > datetime('now', '-' || ? || ' days')
         ORDER BY started_at DESC`,
      )
      .all(days) as Array<{
      error: string;
      model_used: string | null;
      started_at: string;
    }>;

    return groupErrorRows(rows);
  }

  /**
   * Same shape as `errorGroups(days)` but filters by an explicit UTC
   * [start, end) window. Shares `groupErrorRows()` + `inferBackendFromModel()`
   * so the two paths can't drift.
   */
  private errorGroupsInRange(
    startUtc: string,
    endUtc: string,
  ): MetricsErrorGroup[] {
    const rows = this.db
      .prepare(
        `SELECT error, model_used, started_at
         FROM agent_actions
         WHERE result = 'failed'
           AND error IS NOT NULL
           AND started_at >= ?
           AND started_at < ?
         ORDER BY started_at DESC`,
      )
      .all(startUtc, endUtc) as Array<{
      error: string;
      model_used: string | null;
      started_at: string;
    }>;

    return groupErrorRows(rows);
  }

  private heatmapData(): MetricsHeatmapDay[] {
    // Always 12 weeks (84 days) regardless of the period param
    const rows = this.db
      .prepare(
        `SELECT date(started_at) as date, COUNT(*) as count
         FROM agent_actions
         WHERE started_at > datetime('now', '-84 days')
         GROUP BY date(started_at)
         ORDER BY date ASC`,
      )
      .all() as Array<{ date: string; count: number }>;

    return rows;
  }

  collect(): MetricsSnapshot {
    return {
      collectedAt: new Date().toISOString(),
      ...this.notificationMetrics(),
      ...this.modelMetrics(),
      proactiveForwardResume: this.proactiveForwardResumeMetrics(),
      responseTime: this.responseTimeMetrics(),
      cost: this.costMetrics(),
      sessions: this.sessionMetrics(),
    };
  }

  /**
   * DELEGATED-TASK-MODE-DESIGN.md §11.2 — task-mode counters/histogram
   * derived from the `delegated_task.exec` / `delegated_task.run` audit
   * rows the invoker writes via `recordTaskHeaderInProgress` +
   * `completeTaskHeader`. Source-of-truth is the rows themselves; this
   * surface aggregates them so the dashboard / `/metrics/delegated-task`
   * does not have to parse `detail` JSON inline.
   *
   * Window is the last `days` days (capped 1..90, default 30).
   *
   * Aggregation rules:
   *   - `total` — count rows grouped by `(integrationKey, backend, result)`.
   *     `result` is `'destructive_blocked'` when `detail.needsConfirmation`
   *     is true (a successful row that didn't actually execute the
   *     destructive op), otherwise the row's `result` value.
   *   - `toolCalls` — per-integration histogram of `detail.toolCallCount`
   *     across all rows (success + failure). Quantile estimates use the
   *     same nearest-rank method as `responseTimeMetrics`.
   *   - `validationFailures` — count rows where `detail.errorClass IN
   *     ('parse_error','schema_violation')`.
   *   - `destructiveBlocked` — count rows where `detail.needsConfirmation`
   *     is true (successful confirmation envelope returned).
   *   - `costUsd` — sum of `cost_usd` per `(integrationKey, backend)`.
   *
   * `cacheHit` rows (cost_usd=0, cost_source='cache') are included in all
   * counts so the dashboard can compare cache vs. live volumes; their
   * cost contribution is naturally zero.
   */
  collectDelegatedTaskMetrics(days: number = 30): DelegatedTaskMetricsSnapshot {
    const window = Number.isFinite(days)
      ? Math.min(Math.max(Math.floor(days), 1), 90)
      : 30;

    const rows = this.db
      .prepare(
        `SELECT
           backend,
           cost_usd,
           result,
           detail
         FROM agent_actions
         WHERE action_type IN ('delegated_task.exec', 'delegated_task.run')
           AND started_at > datetime('now', '-' || ? || ' days')`,
      )
      .all(window) as Array<{
      backend: string | null;
      cost_usd: number | null;
      result: string | null;
      detail: string | null;
    }>;

    const parsed: Array<{
      integrationKey: string | null;
      backend: string | null;
      result: string;
      costUsd: number;
      toolCallCount: number | null;
      errorClass: string | null;
      needsConfirmation: boolean;
    }> = [];

    for (const row of rows) {
      let detail: Record<string, unknown> = {};
      if (row.detail) {
        try {
          detail = JSON.parse(row.detail) as Record<string, unknown>;
        } catch {
          // Malformed JSON in detail is treated as empty so the row still
          // contributes to total/cost counts.
        }
      }
      const integrationKey = typeof detail.integrationKey === "string"
        ? detail.integrationKey
        : null;
      const errorClass = typeof detail.errorClass === "string"
        ? detail.errorClass
        : null;
      const toolCallCount = typeof detail.toolCallCount === "number"
        ? detail.toolCallCount
        : null;
      const needsConfirmation = detail.needsConfirmation === true;
      parsed.push({
        integrationKey,
        backend: row.backend,
        result: row.result ?? "unknown",
        costUsd: row.cost_usd ?? 0,
        toolCallCount,
        errorClass,
        needsConfirmation,
      });
    }

    return {
      windowDays: window,
      collectedAt: new Date().toISOString(),
      total: aggregateTotal(parsed),
      toolCalls: aggregateToolCalls(parsed),
      validationFailures: aggregateValidationFailures(parsed),
      destructiveBlocked: aggregateDestructiveBlocked(parsed),
      costUsd: aggregateCost(parsed),
    };
  }

  /**
   * docs/design/appendices/pre-pass-fan-out.md §7.3 — pre-pass fan-out metrics.
   *
   * Aggregates `routine.fetch_window` audit rows (one per attempt per
   * integration per parent routine) into the four metric families
   * called out in the design table:
   *   - `pre_pass_total{routine, integration, status}` — chain-level
   *     count keyed by terminal status.
   *   - `pre_pass_attempts{routine, integration}` — distribution of
   *     attempt counts per chain.
   *   - `pre_pass_cost_usd{routine}` — distribution of total cost per
   *     chain, rolled up by routine.
   *   - `pre_pass_duration_ms{routine, integration}` — distribution of
   *     total wall-clock duration per chain.
   *
   * A "chain" is the set of attempts sharing one
   * (`detail.prePass.parentCorrelationId`,
   *  `detail.prePass.integrationKey`) pair. The chain's terminal
   * status is the MAX(`attempt`) row's `status`. Aggregation runs in JS
   * after a single SELECT — the per-window row volume is bounded
   * (~170/day worst case per §5) so an in-memory rollup is cheaper
   * than nested SQL window-functions.
   *
   * Soft-fails on every block: a malformed JSON `detail` cell skips
   * the row but does not blank the entire snapshot, mirroring the
   * delegated-task / management aggregators.
   */
  collectPrePassMetrics(days: number = 30): PrePassMetricsSnapshot {
    const window = Number.isFinite(days)
      ? Math.min(Math.max(Math.floor(days), 1), 90)
      : 30;
    const collectedAt = new Date().toISOString();

    let rows: Array<{
      cost_usd: number | null;
      duration_ms: number | null;
      backend: string | null;
      detail: string | null;
      tokens_input: number | null;
      cache_creation_tokens: number | null;
      cache_read_tokens: number | null;
    }> = [];
    try {
      rows = this.db
        .prepare(
          `SELECT cost_usd, duration_ms, backend, detail,
                  tokens_input, cache_creation_tokens, cache_read_tokens
             FROM agent_actions
            WHERE action_type = 'routine.fetch_window'
              AND started_at > datetime('now', '-' || ? || ' days')
              AND detail IS NOT NULL`,
        )
        .all(window) as typeof rows;
    } catch {
      // Table missing in tests / fresh DB — return the empty snapshot.
      return emptyPrePassSnapshot(window, collectedAt);
    }

    interface ParsedAttemptRow {
      pcid: string;
      routine: string;
      integration: string;
      attempt: number;
      status: PrePassChainStatusBucket["status"];
      costUsd: number;
      durationMs: number;
      fallbackTriggered: boolean;
      requestedBackend: string | null;
      actualBackend: string | null;
      tokensInput: number | null;
      cacheCreationTokens: number | null;
      cacheReadTokens: number | null;
    }

    const attempts: ParsedAttemptRow[] = [];
    for (const row of rows) {
      let detail: Record<string, unknown> = {};
      try {
        detail = row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : {};
      } catch {
        continue; // malformed JSON — skip silently
      }
      const prePass = detail.prePass;
      if (!prePass || typeof prePass !== "object") continue;
      const pp = prePass as Record<string, unknown>;
      const pcid = typeof pp.parentCorrelationId === "string" ? pp.parentCorrelationId : null;
      const routine = typeof pp.parentRoutine === "string" ? pp.parentRoutine : null;
      const integration = typeof pp.integrationKey === "string" ? pp.integrationKey : null;
      const attempt = typeof pp.attempt === "number" ? pp.attempt : null;
      const status = typeof pp.status === "string"
        && (pp.status === "success" || pp.status === "partial" || pp.status === "failed" || pp.status === "skipped")
        ? pp.status
        : null;
      if (!pcid || !routine || !integration || attempt === null || status === null) continue;
      attempts.push({
        pcid,
        routine,
        integration,
        attempt,
        status,
        costUsd: row.cost_usd ?? 0,
        durationMs: row.duration_ms ?? 0,
        fallbackTriggered: pp.fallbackTriggered === true,
        requestedBackend: typeof pp.requestedBackend === "string" ? pp.requestedBackend : null,
        actualBackend: row.backend,
        tokensInput: row.tokens_input,
        cacheCreationTokens: row.cache_creation_tokens,
        cacheReadTokens: row.cache_read_tokens,
      });
    }

    return aggregatePrePassMetrics(attempts, window, collectedAt);
  }

  /**
   * docs/design/21-management-registry-and-entities.md §14.3 — the six
   * Phase-8 metrics, shaped for the dashboard's Management → History tab
   * and the `/metrics/managed-tasks` JSON surface.
   *
   * Sources:
   *   - `managed_tasks` rows for `active`, `consecutiveFailures`,
   *     `failingNow`.
   *   - `agent_actions` rows of type
   *     `management_task.run_recorded` / `management_task.run_now`
   *     for the `runs.{ok,failed,skipped,unknown}` tally over `windowDays`.
   *   - `snapshotManagementTelemetry()` for the histograms + entity-mirror
   *     gauge (process-local; resets on daemon restart by design).
   *
   * Aggregation rules:
   *   - Run rows are bucketed by the leading word of `detail.last_result`
   *     (`failed*` → `failed`, `skipped*` → `skipped`, `ok*` → `ok`,
   *     anything else → `unknown`). Case-insensitive.
   *   - `failingNow` is the count of rows where
   *     `consecutive_failures >= notifyThreshold`. The threshold is
   *     parameterised so a future config change automatically widens the
   *     gauge without re-deploying the dashboard.
   */
  collectManagementMetrics(
    options: {
      windowDays?: number;
      softWarningThreshold: number;
      hardCap: number;
      failureNotifyThreshold: number;
    },
  ): ManagementMetricsSnapshot {
    const window = Number.isFinite(options.windowDays)
      ? Math.min(Math.max(Math.floor(options.windowDays as number), 1), 90)
      : 30;
    const collectedAt = new Date().toISOString();

    // Soft-fail every query: a malformed managed_tasks row should not
    // blank the entire metrics endpoint. Each block returns a safe
    // fallback so the dashboard renders gracefully under degraded DB
    // conditions.
    let active = 0;
    let failingNow = 0;
    try {
      const row = this.db
        .prepare(
          `SELECT
             COUNT(*) AS active,
             COUNT(*) FILTER (WHERE consecutive_failures >= ?) AS failing_now
           FROM managed_tasks`,
        )
        .get(options.failureNotifyThreshold) as {
        active: number;
        failing_now: number;
      };
      active = row.active ?? 0;
      failingNow = row.failing_now ?? 0;
    } catch {
      // table missing in tests / fresh DB — treat as zero
    }

    let consecutiveFailures: ManagedTaskConsecutiveFailureBucket[] = [];
    try {
      const rows = this.db
        .prepare(
          `SELECT id AS mtId, app, consecutive_failures AS count
             FROM managed_tasks
            WHERE consecutive_failures > 0
            ORDER BY consecutive_failures DESC, id ASC`,
        )
        .all() as Array<{ mtId: string; app: string; count: number }>;
      consecutiveFailures = rows.map((r) => ({
        mtId: r.mtId,
        app: r.app,
        count: r.count,
      }));
    } catch {
      // ignore — fallback is empty list
    }

    let runs: ManagedTaskRunsTotal = { ok: 0, failed: 0, skipped: 0, unknown: 0 };
    try {
      const rows = this.db
        .prepare(
          `SELECT
             json_extract(detail, '$.last_result') AS last_result,
             COUNT(*) AS cnt
           FROM agent_actions
           WHERE action_type IN ('management_task.run_recorded', 'management_task.run_now')
             AND started_at > datetime('now', '-' || ? || ' days')
           GROUP BY 1`,
        )
        .all(window) as Array<{ last_result: string | null; cnt: number }>;
      runs = aggregateManagedTaskRuns(rows);
    } catch {
      // table missing or detail not JSON — treat as zero
    }

    const telemetry = snapshotManagementTelemetry();

    return {
      collectedAt,
      windowDays: window,
      active,
      softWarningThreshold: options.softWarningThreshold,
      hardCap: options.hardCap,
      runs,
      consecutiveFailures,
      failureNotifyThreshold: options.failureNotifyThreshold,
      failingNow,
      managementMdRenderMs: telemetry.managementMdRenderMs,
      activityViewRebuildMs: telemetry.activityViewRebuildMs,
      entityMirrorLag: telemetry.entityMirrorLag,
    };
  }

  private notificationMetrics() {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'delivered') as delivered,
           COUNT(*) FILTER (WHERE status = 'delivered' AND user_reaction IS NOT NULL) as reacted,
           COUNT(*) FILTER (WHERE status = 'suppressed') as suppressed
         FROM notification_log
         WHERE created_at > datetime('now', '-30 days')`,
      )
      .get() as { delivered: number; reacted: number; suppressed: number };

    const rate =
      row.delivered > 0 ? row.reacted / row.delivered : null;

    return {
      notificationConfirmRate: rate,
      notificationCounts: {
        delivered: row.delivered,
        reacted: row.reacted,
        suppressed: row.suppressed,
      },
    };
  }

  private modelMetrics() {
    // Count Sonnet sessions (not skipped) in last 30 days
    const sonnetRow = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM agent_actions
         WHERE model_used LIKE '%sonnet%'
           AND result = 'success'
           AND started_at > datetime('now', '-30 days')`,
      )
      .get() as { cnt: number };

    // Count Opus sessions in last 30 days
    const opusRow = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM agent_actions
         WHERE model_used LIKE '%opus%'
           AND result = 'success'
           AND started_at > datetime('now', '-30 days')`,
      )
      .get() as { cnt: number };

    // Advisor telemetry — populated by Claude Code backend only.
    // `advisorCallRate` is defined as `(advisor calls) / (successful
    // Sonnet+Opus sessions)` — i.e. roughly "how many advisor consults per
    // session the agent makes". Returns null when there are no sessions to
    // divide by.
    const advisorRow = this.hasAdvisorCallCountColumn()
      ? (this.db
          .prepare(
            `SELECT
               COALESCE(SUM(advisor_call_count), 0) as total_calls,
               COUNT(*) FILTER (
                 WHERE (model_used LIKE '%sonnet%' OR model_used LIKE '%opus%')
                   AND result = 'success'
               ) as eligible_sessions
             FROM agent_actions
             WHERE started_at > datetime('now', '-30 days')`,
          )
          .get() as { total_calls: number; eligible_sessions: number })
      : { total_calls: 0, eligible_sessions: 0 };

    const advisorCallRate =
      advisorRow.eligible_sessions > 0
        ? advisorRow.total_calls / advisorRow.eligible_sessions
        : null;

    return {
      advisorCallRate,
      modelCounts: {
        sonnetSessions: sonnetRow.cnt,
        opusSessions: opusRow.cnt,
      },
    };
  }

  private proactiveForwardResumeMetrics() {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) FILTER (WHERE action_type = 'proactive_forward_injected') as injected,
           COUNT(*) FILTER (WHERE action_type = 'proactive_forward_disavowed') as disavowed
         FROM agent_actions
         WHERE action_type IN (
           'proactive_forward_injected',
           'proactive_forward_disavowed'
         )
           AND started_at > datetime('now', '-30 days')`,
      )
      .get() as { injected: number; disavowed: number };
    const injected = row.injected ?? 0;
    const disavowed = row.disavowed ?? 0;
    return {
      injected,
      disavowed,
      ratio: injected > 0 ? disavowed / injected : null,
      threshold: 0.05,
    };
  }

  /**
   * Defensive guard for tests that hand-craft a DB without applying the
   * full schema. Production DBs always have this column.
   */
  private hasAdvisorCallCountColumn(): boolean {
    const cols = this.db.pragma("table_info(agent_actions)") as {
      name: string;
    }[];
    return cols.some((col) => col.name === "advisor_call_count");
  }

  private responseTimeMetrics() {
    // Percentiles from reactive sessions (message responses) in last 30 days
    const rows = this.db
      .prepare(
        `SELECT duration_ms FROM agent_actions
         WHERE trigger = 'reactive'
           AND result = 'success'
           AND duration_ms IS NOT NULL
           AND started_at > datetime('now', '-30 days')
         ORDER BY duration_ms ASC`,
      )
      .all() as { duration_ms: number }[];

    if (rows.length === 0) {
      return { p50: null, p90: null, p95: null, p99: null, avg: null };
    }

    const durations = rows.map((r) => r.duration_ms);
    const p = (pct: number) =>
      durations[Math.min(Math.floor(durations.length * pct), durations.length - 1)];
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;

    return {
      p50: p(0.5),
      p90: p(0.9),
      p95: p(0.95),
      p99: p(0.99),
      avg: Math.round(avg),
    };
  }

  private costMetrics() {
    // datetime(started_at) normalizes mixed ISO-8601 / SQL formats so that
    // legacy delegated_proxy.invoke rows (written in ISO-with-T-and-Z) are
    // not lexicographically excluded from the agent-day window.
    const bounds = getAgentDayBoundsUtc(this.timezoneConfig.timezone, this.timezoneConfig.dayBoundaryHour);
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN datetime(started_at) >= ? AND datetime(started_at) < ? THEN cost_usd ELSE 0 END), 0) as today,
           COALESCE(SUM(CASE WHEN started_at > datetime('now', '-7 days') THEN cost_usd ELSE 0 END), 0) as last7d,
           COALESCE(SUM(cost_usd), 0) as last30d
         FROM agent_actions
         WHERE started_at > datetime('now', '-30 days')`,
      )
      .get(bounds.start, bounds.end) as { today: number; last7d: number; last30d: number };

    return {
      todayUsd: row.today,
      last7dUsd: row.last7d,
      last30dUsd: row.last30d,
    };
  }

  private sessionMetrics() {
    // See costMetrics() above — datetime(started_at) defends against legacy
    // mixed-format rows that would otherwise sort outside the day window.
    const bounds = getAgentDayBoundsUtc(this.timezoneConfig.timezone, this.timezoneConfig.dayBoundaryHour);
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE trigger = 'autonomous') as autonomous,
           COUNT(*) FILTER (WHERE trigger = 'reactive') as reactive
         FROM agent_actions
         WHERE datetime(started_at) >= ? AND datetime(started_at) < ?
           AND cost_usd IS NOT NULL`,
      )
      .get(bounds.start, bounds.end) as { total: number; autonomous: number; reactive: number };

    return {
      todayTotal: row.total,
      todayAutonomous: row.autonomous,
      todayReactive: row.reactive,
    };
  }
}

// ── Date helpers ──

/** Generate an array of "YYYY-MM-DD" strings for the last N days (UTC). */
function generateDateRange(days: number): string[] {
  const result: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(now.getUTCDate() - i);
    result.push(d.toISOString().slice(0, 10));
  }
  return result;
}

// ── Error classification ──

/**
 * Map a stored `model_used` string to a backend id. Purely a string-sniffing
 * helper — no DB access, no logging. Shared by both `errorGroups(days)` and
 * `errorGroupsInRange(start, end)` so the two windows stay consistent.
 * Exported for direct unit testing — the two call sites are indirect.
 */
export function inferBackendFromModel(modelUsed: string | null): string | null {
  if (!modelUsed) return null;
  if (
    modelUsed.includes("sonnet") ||
    modelUsed.includes("opus") ||
    modelUsed.includes("haiku")
  ) {
    return "claude-code";
  }
  if (modelUsed.includes("gemini")) return "gemini-cli";
  if (
    modelUsed.includes("codex") ||
    modelUsed.includes("gpt") ||
    modelUsed.includes("o3") ||
    modelUsed.includes("o4")
  ) {
    return "codex";
  }
  return null;
}

/**
 * Group raw failed-action rows by category and return the shape the API
 * exposes. Extracted so the days-windowed and agent-day-windowed variants
 * share identical grouping / sampling rules. Exported for direct testing.
 */
export function groupErrorRows(
  rows: Array<{ error: string; model_used: string | null; started_at: string }>,
): MetricsErrorGroup[] {
  const groups = new Map<string, MetricsErrorGroup>();
  for (const row of rows) {
    const category = categorizeError(row.error);
    const existing = groups.get(category);
    if (existing) {
      existing.count++;
      continue;
    }
    groups.set(category, {
      category,
      count: 1,
      lastSeen: row.started_at,
      backend: inferBackendFromModel(row.model_used),
      sampleMessage:
        row.error.length > 200 ? row.error.slice(0, 200) + "…" : row.error,
    });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

// ── Delegated-task aggregation helpers ──

interface ParsedTaskRow {
  integrationKey: string | null;
  backend: string | null;
  result: string;
  costUsd: number;
  toolCallCount: number | null;
  errorClass: string | null;
  needsConfirmation: boolean;
}

function bucketKey(integrationKey: string | null, backend: string | null): string {
  return `${integrationKey ?? "<none>"}::${backend ?? "<none>"}`;
}

function aggregateTotal(rows: ParsedTaskRow[]): DelegatedTaskTotalBucket[] {
  const map = new Map<string, DelegatedTaskTotalBucket>();
  for (const row of rows) {
    // Confirmation envelopes ride the success path in agent_actions but
    // they DID NOT execute the destructive tool — surfacing them under a
    // distinct result bucket prevents the dashboard from mistaking them
    // for "task succeeded" outcomes.
    const result = row.needsConfirmation ? "destructive_blocked" : row.result;
    const key = `${bucketKey(row.integrationKey, row.backend)}::${result}`;
    const existing = map.get(key);
    if (existing) {
      existing.count++;
      continue;
    }
    map.set(key, {
      integrationKey: row.integrationKey,
      backend: row.backend,
      result,
      count: 1,
    });
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function aggregateToolCalls(rows: ParsedTaskRow[]): DelegatedTaskToolCallsBucket[] {
  const groups = new Map<
    string,
    {
      integrationKey: string | null;
      backend: string | null;
      values: number[];
    }
  >();
  for (const row of rows) {
    if (row.toolCallCount === null) continue;
    const key = bucketKey(row.integrationKey, row.backend);
    let group = groups.get(key);
    if (!group) {
      group = {
        integrationKey: row.integrationKey,
        backend: row.backend,
        values: [],
      };
      groups.set(key, group);
    }
    group.values.push(row.toolCallCount);
  }
  return [...groups.values()].map((g) => {
    const sorted = [...g.values].sort((a, b) => a - b);
    const histogram: DelegatedTaskHistogramSummary = {
      count: sorted.length,
      sum: sorted.reduce((a, b) => a + b, 0),
      min: sorted.length > 0 ? sorted[0] : null,
      max: sorted.length > 0 ? sorted[sorted.length - 1] : null,
      avg: sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
      p50: percentile(sorted, 0.5),
      p90: percentile(sorted, 0.9),
      p95: percentile(sorted, 0.95),
    };
    return {
      integrationKey: g.integrationKey,
      backend: g.backend,
      histogram,
    };
  });
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[idx];
}

function aggregateValidationFailures(
  rows: ParsedTaskRow[],
): DelegatedTaskValidationFailureBucket[] {
  const map = new Map<string, DelegatedTaskValidationFailureBucket>();
  for (const row of rows) {
    if (row.errorClass !== "parse_error" && row.errorClass !== "schema_violation") {
      continue;
    }
    const key = `${bucketKey(row.integrationKey, row.backend)}::${row.errorClass}`;
    const existing = map.get(key);
    if (existing) {
      existing.count++;
      continue;
    }
    map.set(key, {
      integrationKey: row.integrationKey,
      backend: row.backend,
      kind: row.errorClass,
      count: 1,
    });
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function aggregateDestructiveBlocked(
  rows: ParsedTaskRow[],
): DelegatedTaskDestructiveBlockedBucket[] {
  const map = new Map<string, DelegatedTaskDestructiveBlockedBucket>();
  for (const row of rows) {
    if (!row.needsConfirmation) continue;
    const key = bucketKey(row.integrationKey, row.backend);
    const existing = map.get(key);
    if (existing) {
      existing.count++;
      continue;
    }
    map.set(key, {
      integrationKey: row.integrationKey,
      backend: row.backend,
      count: 1,
    });
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function aggregateCost(rows: ParsedTaskRow[]): DelegatedTaskCostBucket[] {
  const map = new Map<string, DelegatedTaskCostBucket>();
  for (const row of rows) {
    const key = bucketKey(row.integrationKey, row.backend);
    const existing = map.get(key);
    if (existing) {
      existing.costUsd += row.costUsd;
      continue;
    }
    map.set(key, {
      integrationKey: row.integrationKey,
      backend: row.backend,
      costUsd: row.costUsd,
    });
  }
  return [...map.values()].sort((a, b) => b.costUsd - a.costUsd);
}

function categorizeError(error: string): string {
  const lower = error.toLowerCase();
  if (lower.includes("quota") || lower.includes("rate limit") || lower.includes("429") || lower.includes("too many requests")) {
    return "quota";
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("deadline")) {
    return "timeout";
  }
  if (lower.includes("auth") || lower.includes("401") || lower.includes("403") || lower.includes("permission") || lower.includes("unauthorized")) {
    return "auth";
  }
  if (lower.includes("network") || lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("fetch failed")) {
    return "network";
  }
  return "other";
}

// ── Management-task run aggregation ──────────────────────────────────────────

/**
 * Bucket a `last_result` payload string into one of the four exposed
 * counters. Pure helper exported for direct unit tests so the
 * dashboard's run-totals contract is locked.
 *
 *   `null` / `''` / non-string                    → `unknown`
 *   `failed`, `failed: ...`, `Failed (foo)`, ...  → `failed`
 *   `skipped`, `skipped: foo`, ...                → `skipped`
 *   `ok`, `ok (3 new)`, `OK`, ...                 → `ok`
 *   anything else (`pending`, ad-hoc strings)     → `unknown`
 *
 * Whitespace and case are normalised; punctuation after the leading
 * word is ignored. The leading-word policy is intentional — the
 * `last_result` column is short-form-by-convention but free-text by
 * schema, so a trailing detail string ("ok (3 new)") must not change
 * the bucket.
 */
export function classifyManagedTaskRunResult(
  lastResult: string | null | undefined,
): keyof ManagedTaskRunsTotal {
  if (typeof lastResult !== "string") return "unknown";
  const normalised = lastResult.trim().toLowerCase();
  if (normalised === "") return "unknown";
  if (/^failed\b/.test(normalised) || normalised.startsWith("failed:")) {
    return "failed";
  }
  if (/^skipped\b/.test(normalised) || normalised.startsWith("skipped:")) {
    return "skipped";
  }
  if (/^ok\b/.test(normalised) || normalised === "ok") {
    return "ok";
  }
  return "unknown";
}

/**
 * Sum a flat list of `(last_result, count)` rows from
 * `agent_actions` into the four-axis tally. Pure — DB-free for tests.
 */
export function aggregateManagedTaskRuns(
  rows: ReadonlyArray<{ last_result: string | null; cnt: number }>,
): ManagedTaskRunsTotal {
  const totals: ManagedTaskRunsTotal = {
    ok: 0,
    failed: 0,
    skipped: 0,
    unknown: 0,
  };
  for (const row of rows) {
    const bucket = classifyManagedTaskRunResult(row.last_result);
    totals[bucket] += row.cnt;
  }
  return totals;
}

// ── Pre-pass fan-out aggregation (docs/design/appendices/pre-pass-fan-out.md §7.3) ──

interface PrePassParsedAttempt {
  pcid: string;
  routine: string;
  integration: string;
  attempt: number;
  status: PrePassChainStatusBucket["status"];
  costUsd: number;
  durationMs: number;
  fallbackTriggered: boolean;
  requestedBackend: string | null;
  actualBackend: string | null;
  /**
   * Per-attempt SDK-reported `cache_creation_tokens`. May be `null` for
   * legacy rows written before the column was populated, or for non-Claude
   * backends that don't surface a cache-create signal — those rows are
   * dropped from the histogram so the snapshot reflects only attempts
   * where the metric is meaningful (Phase 1's target).
   */
  cacheCreationTokens: number | null;
  /** Per-attempt SDK-reported `cache_read_tokens`; same nullability rules. */
  cacheReadTokens: number | null;
  /**
   * Per-attempt `tokens_input` from `agent_actions.tokens_input`.
   * Surfaces as the per-backend `inputTokensByBackend` histogram — the
   * non-Claude analog of `cacheCreationTokensPerAttempt` since Codex /
   * Gemini providers don't expose a paid cache-creation dimension.
   * `null` rows are dropped from the histogram for the same reason as
   * the cache columns.
   */
  tokensInput: number | null;
}

function emptyPrePassSnapshot(
  windowDays: number,
  collectedAt: string,
): PrePassMetricsSnapshot {
  const emptyHistogram: HistogramSummary = {
    count: 0,
    sum: 0,
    min: null,
    max: null,
    avg: null,
    p50: null,
    p90: null,
    p95: null,
  };
  return {
    windowDays,
    collectedAt,
    totalChains: 0,
    totalAttempts: 0,
    chainsByStatus: [],
    attemptsPerChain: [],
    costUsdByRoutine: [],
    durationMsByIntegration: [],
    fallbacks: [],
    cacheCreationTokensPerAttempt: emptyHistogram,
    cacheReadTokensPerAttempt: emptyHistogram,
    inputTokensByBackend: [],
    costUsdByBackend: [],
  };
}

/**
 * Pure aggregation kernel for `collectPrePassMetrics`. Takes the parsed
 * attempt rows and rolls them up into the §7.3 snapshot shape. Exported
 * for direct unit testing without a SQLite fixture.
 *
 * Chain identity = (parentCorrelationId, integrationKey). Each chain's
 * terminal status is the MAX(`attempt`) row's status; each chain's
 * total cost / duration is the sum across attempts.
 */
export function aggregatePrePassMetrics(
  attempts: readonly PrePassParsedAttempt[],
  windowDays: number,
  collectedAt: string,
): PrePassMetricsSnapshot {
  if (attempts.length === 0) return emptyPrePassSnapshot(windowDays, collectedAt);

  // Roll up by chain. A chain is one (parentCorrelationId,
  // integrationKey) pair — all attempts share that pair by
  // construction. Use nested Maps keyed by string fields directly so
  // we don't have to invent / split a composite-key encoding.
  interface ChainSummary {
    routine: string;
    integration: string;
    attempts: number;
    finalAttempt: number;
    finalStatus: PrePassChainStatusBucket["status"];
    totalCostUsd: number;
    totalDurationMs: number;
  }
  // pcid → integration → ChainSummary.
  const chainsByPcid = new Map<string, Map<string, ChainSummary>>();

  for (const att of attempts) {
    let perPcid = chainsByPcid.get(att.pcid);
    if (!perPcid) {
      perPcid = new Map<string, ChainSummary>();
      chainsByPcid.set(att.pcid, perPcid);
    }
    const existing = perPcid.get(att.integration);
    if (existing === undefined) {
      perPcid.set(att.integration, {
        routine: att.routine,
        integration: att.integration,
        attempts: 1,
        finalAttempt: att.attempt,
        finalStatus: att.status,
        totalCostUsd: att.costUsd,
        totalDurationMs: att.durationMs,
      });
    } else {
      existing.attempts += 1;
      existing.totalCostUsd += att.costUsd;
      existing.totalDurationMs += att.durationMs;
      // Update terminal status to the row with the highest attempt
      // index — chain status mirrors the runner's `final` attempt.
      if (att.attempt > existing.finalAttempt) {
        existing.finalAttempt = att.attempt;
        existing.finalStatus = att.status;
      }
    }
  }

  // Flatten chain summaries into a single iterable for the next pass.
  const allChains: ChainSummary[] = [];
  for (const perPcid of chainsByPcid.values()) {
    for (const chain of perPcid.values()) allChains.push(chain);
  }

  // chainsByStatus — routine → integration → status → count.
  const statusCounts = new Map<string, Map<string, Map<string, number>>>();
  // routine → integration → samples (per-chain attempt counts).
  const attemptsSamples = new Map<string, Map<string, number[]>>();
  // routine → samples (per-chain total cost).
  const costSamples = new Map<string, number[]>();
  // routine → integration → samples (per-chain total duration).
  const durationSamples = new Map<string, Map<string, number[]>>();

  function getOrCreateMap<K, V>(m: Map<K, V>, k: K, factory: () => V): V {
    const existing = m.get(k);
    if (existing !== undefined) return existing;
    const created = factory();
    m.set(k, created);
    return created;
  }

  for (const chain of allChains) {
    const byRoutine = getOrCreateMap(
      statusCounts,
      chain.routine,
      () => new Map<string, Map<string, number>>(),
    );
    const byIntegration = getOrCreateMap(
      byRoutine,
      chain.integration,
      () => new Map<string, number>(),
    );
    byIntegration.set(
      chain.finalStatus,
      (byIntegration.get(chain.finalStatus) ?? 0) + 1,
    );

    const attemptsByRoutine = getOrCreateMap(
      attemptsSamples,
      chain.routine,
      () => new Map<string, number[]>(),
    );
    getOrCreateMap(attemptsByRoutine, chain.integration, () => []).push(
      chain.attempts,
    );

    getOrCreateMap(costSamples, chain.routine, () => []).push(chain.totalCostUsd);

    const durationByRoutine = getOrCreateMap(
      durationSamples,
      chain.routine,
      () => new Map<string, number[]>(),
    );
    getOrCreateMap(durationByRoutine, chain.integration, () => []).push(
      chain.totalDurationMs,
    );
  }

  const chainsByStatus: PrePassChainStatusBucket[] = [];
  for (const [routine, byIntegration] of statusCounts.entries()) {
    for (const [integration, byStatus] of byIntegration.entries()) {
      for (const [status, count] of byStatus.entries()) {
        chainsByStatus.push({
          routine,
          integrationKey: integration,
          status: status as PrePassChainStatusBucket["status"],
          count,
        });
      }
    }
  }
  chainsByStatus.sort((a, b) => {
    return (
      a.routine.localeCompare(b.routine)
      || a.integrationKey.localeCompare(b.integrationKey)
      || a.status.localeCompare(b.status)
    );
  });

  const attemptsPerChain: PrePassAttemptsBucket[] = [];
  for (const [routine, byIntegration] of attemptsSamples.entries()) {
    for (const [integration, samples] of byIntegration.entries()) {
      attemptsPerChain.push({
        routine,
        integrationKey: integration,
        histogram: summarize(samples),
      });
    }
  }
  attemptsPerChain.sort((a, b) =>
    a.routine.localeCompare(b.routine)
    || a.integrationKey.localeCompare(b.integrationKey),
  );

  const costUsdByRoutine: PrePassCostBucket[] = [];
  for (const [routine, samples] of costSamples.entries()) {
    costUsdByRoutine.push({ routine, histogram: summarize(samples) });
  }
  costUsdByRoutine.sort((a, b) => a.routine.localeCompare(b.routine));

  const durationMsByIntegration: PrePassDurationBucket[] = [];
  for (const [routine, byIntegration] of durationSamples.entries()) {
    for (const [integration, samples] of byIntegration.entries()) {
      durationMsByIntegration.push({
        routine,
        integrationKey: integration,
        histogram: summarize(samples),
      });
    }
  }
  durationMsByIntegration.sort((a, b) =>
    a.routine.localeCompare(b.routine)
    || a.integrationKey.localeCompare(b.integrationKey),
  );

  // Fallbacks — counted at the attempt level (one fallback observation
  // per attempt that triggered it). routine → requested → actual → count.
  const fallbackCounts = new Map<string, Map<string, Map<string, number>>>();
  for (const att of attempts) {
    if (!att.fallbackTriggered) continue;
    if (!att.requestedBackend || !att.actualBackend) continue;
    const byRequested = getOrCreateMap(
      fallbackCounts,
      att.routine,
      () => new Map<string, Map<string, number>>(),
    );
    const byActual = getOrCreateMap(
      byRequested,
      att.requestedBackend,
      () => new Map<string, number>(),
    );
    byActual.set(att.actualBackend, (byActual.get(att.actualBackend) ?? 0) + 1);
  }
  const fallbacks: PrePassFallbackBucket[] = [];
  for (const [routine, byRequested] of fallbackCounts.entries()) {
    for (const [requestedBackend, byActual] of byRequested.entries()) {
      for (const [actualBackend, count] of byActual.entries()) {
        fallbacks.push({ routine, requestedBackend, actualBackend, count });
      }
    }
  }
  fallbacks.sort((a, b) =>
    a.routine.localeCompare(b.routine)
    || a.requestedBackend.localeCompare(b.requestedBackend)
    || a.actualBackend.localeCompare(b.actualBackend),
  );

  // Cache-creation / cache-read token histograms — design §10.1 surface
  // for verifying Phase 1 cost reduction. Phase 1.5 amendment: restrict
  // to `actualBackend === 'claude'`. Codex / Gemini parsers persist
  // `cache_creation_tokens = 0` (their providers don't expose a paid
  // cache-creation dimension); including those zeros would skew p50
  // downward and obscure the Phase 1 verification target. Post-D13, when
  // the OpenCode core starts populating `cache.write` into the same
  // column, widen the predicate to also accept `'opencode'`.
  const cacheCreationSamples: number[] = [];
  const cacheReadSamples: number[] = [];
  // Phase 1.5 — per-backend `tokens_input` + `cost_usd` histograms. The
  // non-Claude analog of the cache-create metric: every byte of the
  // instruction file is billed at the full input rate on Codex / Gemini /
  // OpenCode, so input-tokens directly observe Phase 1.5's reduction.
  const inputTokensByBackend = new Map<string, number[]>();
  const costUsdByBackend = new Map<string, number[]>();
  for (const att of attempts) {
    if (att.actualBackend === "claude") {
      if (typeof att.cacheCreationTokens === "number") {
        cacheCreationSamples.push(att.cacheCreationTokens);
      }
      if (typeof att.cacheReadTokens === "number") {
        cacheReadSamples.push(att.cacheReadTokens);
      }
    }
    if (att.actualBackend === null) continue;
    if (typeof att.tokensInput === "number") {
      const samples = inputTokensByBackend.get(att.actualBackend);
      if (samples) samples.push(att.tokensInput);
      else inputTokensByBackend.set(att.actualBackend, [att.tokensInput]);
    }
    // `costUsd` is always a number on the parsed row (NULL coalesces to
    // 0 in the projection above). Zero-cost attempts are still
    // information — they signal cost-source = sdk failed to populate or
    // a session that exited before billing — keep them in the bucket.
    const costSamples = costUsdByBackend.get(att.actualBackend);
    if (costSamples) costSamples.push(att.costUsd);
    else costUsdByBackend.set(att.actualBackend, [att.costUsd]);
  }

  const inputTokensByBackendBuckets: PrePassPerBackendBucket[] = [];
  for (const [actualBackend, samples] of inputTokensByBackend.entries()) {
    inputTokensByBackendBuckets.push({ actualBackend, histogram: summarize(samples) });
  }
  inputTokensByBackendBuckets.sort((a, b) =>
    a.actualBackend.localeCompare(b.actualBackend),
  );
  const costUsdByBackendBuckets: PrePassPerBackendBucket[] = [];
  for (const [actualBackend, samples] of costUsdByBackend.entries()) {
    costUsdByBackendBuckets.push({ actualBackend, histogram: summarize(samples) });
  }
  costUsdByBackendBuckets.sort((a, b) =>
    a.actualBackend.localeCompare(b.actualBackend),
  );

  return {
    windowDays,
    collectedAt,
    totalChains: allChains.length,
    totalAttempts: attempts.length,
    chainsByStatus,
    attemptsPerChain,
    costUsdByRoutine,
    durationMsByIntegration,
    fallbacks,
    cacheCreationTokensPerAttempt: summarize(cacheCreationSamples),
    cacheReadTokensPerAttempt: summarize(cacheReadSamples),
    inputTokensByBackend: inputTokensByBackendBuckets,
    costUsdByBackend: costUsdByBackendBuckets,
  };}
