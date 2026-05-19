/**
 * Freshness-window helpers for the hourly_check pre-pass harvester
 * (HOURLY_CHECK_GATE_REDESIGN_PLAN.md §3.4).
 *
 * The pre-pass fetcher writes a `runtime_state` row keyed by integration
 * after every successful per-integration completion. The hourly_check
 * coordinator's `harvestForGate` reads the row to decide whether the
 * window is fresh enough to skip pre-pass on this tick.
 *
 * The key prefix is intentionally shared across every routine that
 * spawns `routine.fetch_window` (morning_routine, hourly_check,
 * evening_review, weekly_review, today_refresh). Sharing means a
 * morning_routine that just ran at 04:00 suppresses the 05:00
 * hourly_check pre-pass — exactly what we want to avoid double-fetching.
 *
 * Module is intentionally trivial — separated so both the runner (writer)
 * and the coordinator (reader) can depend on a single string-builder
 * without a circular import.
 */
import type { IntegrationKey } from "@aitne/shared";

/** Stable namespace prefix — also used by lint/audit tooling. */
export const PRE_PASS_LAST_RUN_KEY_PREFIX = "pre_pass_last_run";

/**
 * Build the canonical `runtime_state` key for "when did the pre-pass
 * last successfully fetch this integration's window?".
 */
export function prePassLastRunRuntimeStateKey(
  integrationKey: IntegrationKey,
): string {
  return `${PRE_PASS_LAST_RUN_KEY_PREFIX}:${integrationKey}`;
}
