import type {
  BrowserHistoryLifecycleBrowserState,
  BrowserHistoryLifecycleStateValue,
} from "@aitne/shared";
import type { FailureEscalationInput } from "../types.js";

const PAUSE_AFTER_FAILURES = 3;
const PAUSE_MS = 24 * 60 * 60 * 1000;

// "paused", "success", and "skipped" outcomes are handled by early returns
// in nextBrowserLifecycleState below — narrow the input type here so a
// future refactor that bypasses those branches surfaces as a type error.
type FailureOutcome = Exclude<
  FailureEscalationInput["outcome"],
  "paused" | "success" | "skipped"
>;

function stateForOutcome(outcome: FailureOutcome): BrowserHistoryLifecycleStateValue {
  if (outcome === "sync_unresponsive") return "sync_unresponsive";
  if (outcome === "launch_failed") return "launch_failed_recently";
  return "stale"; // outcome === "error"
}

export function nextBrowserLifecycleState(
  input: FailureEscalationInput,
): BrowserHistoryLifecycleBrowserState {
  if (input.outcome === "paused") {
    return {
      state: "lifecycle_paused",
      lastLaunchAt: null,
      lastSuccessfulSyncAt: null,
      lastCheckedAt: input.nowMs,
      consecutiveFailures: input.consecutiveFailures,
      pausedUntil: input.nowMs + PAUSE_MS,
      lastOutcome: input.outcome,
    };
  }

  if (input.outcome === "success" || input.outcome === "skipped") {
    return {
      state: input.outcome === "success" ? "healthy" : "stopped",
      lastLaunchAt: null,
      lastSuccessfulSyncAt: input.outcome === "success" ? input.nowMs : null,
      lastCheckedAt: input.nowMs,
      consecutiveFailures: 0,
      pausedUntil: null,
      lastOutcome: input.outcome,
    };
  }

  const failures = input.consecutiveFailures + 1;
  if (failures >= PAUSE_AFTER_FAILURES) {
    return {
      state: "lifecycle_paused",
      lastLaunchAt: null,
      lastSuccessfulSyncAt: null,
      lastCheckedAt: input.nowMs,
      consecutiveFailures: failures,
      pausedUntil: input.nowMs + PAUSE_MS,
      lastOutcome: input.outcome,
    };
  }

  return {
    state: stateForOutcome(input.outcome),
    lastLaunchAt: null,
    lastSuccessfulSyncAt: null,
    lastCheckedAt: input.nowMs,
    consecutiveFailures: failures,
    pausedUntil: null,
    lastOutcome: input.outcome,
  };
}
