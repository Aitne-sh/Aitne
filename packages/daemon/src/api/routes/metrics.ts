import { Hono } from "hono";
import {
  MANAGEMENT_ACTIVE_TASKS_SOFT_WARNING,
  MANAGEMENT_FAILURE_NOTIFY_THRESHOLD_DEFAULT,
  MANAGEMENT_MAX_ACTIVE_TASKS_DEFAULT,
} from "@aitne/shared";
import type { ApiDependencies } from "../server.js";
import { MetricsCollector } from "../../core/metrics.js";

/**
 * Metrics API route — exposes self-evaluation metrics.
 *
 * GET /metrics                    — full metrics snapshot
 * GET /metrics/timeseries         — historical daily buckets
 * GET /metrics/auth               — auth telemetry counters (Phase 8 dashboard)
 * GET /metrics/delegated-task     — DELEGATED-TASK-MODE-DESIGN.md §11.2
 * GET /metrics/managed-tasks      — docs/design/21 §14.3 (Phase 8)
 * GET /metrics/pre-pass           — docs/design/appendices/pre-pass-fan-out.md §7.3
 */
export function createMetricsRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  const collector = new MetricsCollector(deps.db, {
    timezone: deps.config.timezone,
    dayBoundaryHour: deps.config.dayBoundaryHour,
  });

  app.get("/metrics", (c) => {
    const snapshot = collector.collect();
    return c.json(snapshot);
  });

  app.get("/metrics/timeseries", (c) => {
    const daysParam = c.req.query("days");
    const parsed = daysParam ? Number(daysParam) : 30;
    const days = Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), 0), 90) : 30;
    const timeseries = collector.collectTimeseries(days);
    return c.json(timeseries);
  });

  /**
   * GET /metrics/auth — auth telemetry counters for dashboard analytics.
   *
   * Query params:
   *   ?hours=N  — lookback window in hours (default 72, max 720 = 30 days)
   *
   * Returns counters aggregated per backend (summed across sources) and a
   * source-grouped breakdown for the Phase 4 analytics tab.
   */
  app.get("/metrics/auth", (c) => {
    const telemetry = deps.authTelemetry;
    if (!telemetry) {
      return c.json({ error: "auth_telemetry_unavailable" }, 503);
    }

    const hoursParam = c.req.query("hours");
    const parsed = hoursParam ? Number(hoursParam) : 72;
    const hours = Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), 1), 720) : 72;

    return c.json({
      hours,
      counters: telemetry.snapshot(hours),
      bySource: telemetry.snapshotBySource(hours),
    });
  });

  /**
   * GET /metrics/delegated-task — DELEGATED-TASK-MODE-DESIGN.md §11.2.
   *
   * Aggregates the five task-mode metric families
   * (`delegated_task_total`, `_tool_calls`, `_validation_failures`,
   * `_destructive_blocked`, `_cost_usd`) from `agent_actions` rows of
   * type `delegated_task.exec` / `delegated_task.run`. The DB rows are
   * the source-of-truth — this endpoint just shapes them for the
   * dashboard.
   *
   * Query params:
   *   ?days=N — lookback window (1-90, default 30).
   */
  app.get("/metrics/delegated-task", (c) => {
    const daysParam = c.req.query("days");
    const parsed = daysParam ? Number(daysParam) : 30;
    const days = Number.isFinite(parsed)
      ? Math.min(Math.max(Math.floor(parsed), 1), 90)
      : 30;
    return c.json(collector.collectDelegatedTaskMetrics(days));
  });

  /**
   * GET /metrics/managed-tasks — docs/design/21-management-registry-and-
   * entities.md §14.3 (Phase 8).
   *
   * Returns the six-metric management snapshot: active count, runs total
   * (ok/failed/skipped/unknown), per-`mt_id` consecutive-failure gauge,
   * the `failingNow` count, the management.md render histogram, the
   * per-source activity-view rebuild histogram, and the entity-mirror
   * lag gauge. The histograms come from the in-memory telemetry buffer
   * so they reset on daemon restart by design.
   *
   * Query params:
   *   ?days=N — lookback window for the runs tally (1-90, default 30).
   *
   * `hardCap` mirrors the cap enforced by `POST /managed-tasks`
   * (`configuredMaxActiveTasks` in `managed-tasks.ts`): when the
   * operator overrides `config.managementMaxActiveTasks` the dashboard
   * displays the same number that 409s a registration. Soft warning
   * and notify-threshold are hard-coded defaults today (no `config.*`
   * tunable); they fall through to the shared constants.
   */
  app.get("/metrics/managed-tasks", (c) => {
    const daysParam = c.req.query("days");
    const parsed = daysParam ? Number(daysParam) : 30;
    const days = Number.isFinite(parsed)
      ? Math.min(Math.max(Math.floor(parsed), 1), 90)
      : 30;
    const configured = (deps.config as Record<string, unknown>)
      .managementMaxActiveTasks;
    const hardCap =
      typeof configured === "number"
        && Number.isFinite(configured)
        && configured > 0
        ? Math.floor(configured)
        : MANAGEMENT_MAX_ACTIVE_TASKS_DEFAULT;
    return c.json(
      collector.collectManagementMetrics({
        windowDays: days,
        softWarningThreshold: MANAGEMENT_ACTIVE_TASKS_SOFT_WARNING,
        hardCap,
        failureNotifyThreshold: MANAGEMENT_FAILURE_NOTIFY_THRESHOLD_DEFAULT,
      }),
    );
  });

  /**
   * GET /metrics/pre-pass — docs/design/appendices/pre-pass-fan-out.md §7.3.
   *
   * Aggregates `routine.fetch_window` audit rows (one per attempt per
   * integration per parent routine) into the four §7.3 metric families:
   *   - `chainsByStatus` (`pre_pass_total{routine, integration, status}`)
   *   - `attemptsPerChain` (`pre_pass_attempts{routine, integration}`)
   *   - `costUsdByRoutine` (`pre_pass_cost_usd{routine}`)
   *   - `durationMsByIntegration` (`pre_pass_duration_ms{routine, integration}`)
   * plus `fallbacks` — counts of attempts where the SDK fell back from
   * `requestedBackend` to `actualBackend` mid-execute (§5).
   *
   * Query params:
   *   ?days=N — lookback window (1-90, default 30).
   */
  app.get("/metrics/pre-pass", (c) => {
    const daysParam = c.req.query("days");
    const parsed = daysParam ? Number(daysParam) : 30;
    const days = Number.isFinite(parsed)
      ? Math.min(Math.max(Math.floor(parsed), 1), 90)
      : 30;
    return c.json(collector.collectPrePassMetrics(days));
  });

  return app;
}
