/**
 * Pure view helpers for the dev-sessions dashboard — badge variants, labels,
 * and deterministic time formatting. Kept free of React so they unit-test in a
 * plain Node vitest run (the dashboard convention).
 */

import { formatDistance } from "date-fns";
import type {
  DevIterationPhase,
  DevRequirementStatus,
  DevSessionLoopState,
  DevSessionState,
} from "./types.js";

/** The `<Badge variant>` names this feature uses (local map — the dev states
 *  aren't in the shared status-badge vocabulary). */
export type DevBadgeVariant =
  | "blue"
  | "amber"
  | "orange"
  | "green"
  | "gray"
  | "red"
  | "purple";

/** Map a session state → a token-based Badge variant. */
export function devStateBadgeVariant(state: DevSessionState): DevBadgeVariant {
  switch (state) {
    case "interview":
      return "blue";
    case "awaiting_approval":
      return "purple";
    case "running":
      return "amber";
    case "awaiting_user":
      return "orange";
    case "done":
      return "green";
    case "failed":
      return "red";
    case "exited":
      return "gray";
    default:
      return "gray";
  }
}

const STATE_LABELS: Record<DevSessionState, string> = {
  interview: "Interview",
  awaiting_approval: "Awaiting approval",
  running: "Running",
  awaiting_user: "Awaiting decision",
  done: "Done",
  exited: "Exited",
  failed: "Failed",
};

export function devStateLabel(state: DevSessionState): string {
  return STATE_LABELS[state] ?? state;
}

/** A short human line for the inner loop verdict, when present. */
export function devLoopStateLabel(loopState: DevSessionLoopState | null): string | null {
  if (!loopState) return null;
  return loopState.replace(/_/g, " ");
}

/** Requirement status → Badge variant (met=green, regressed=red, …). */
export function devReqStatusBadgeVariant(status: DevRequirementStatus): DevBadgeVariant {
  switch (status) {
    case "met":
      return "green";
    case "in_progress":
      return "amber";
    case "at_risk":
      return "orange";
    case "regressed":
      return "red";
    default:
      return "gray";
  }
}

const PHASE_LABELS: Record<DevIterationPhase, string> = {
  plan: "Plan",
  implement: "Implement",
  evaluate: "Evaluate",
  review: "Review",
  stop_eval: "Stop-eval",
  gate: "Gate",
  evidence: "Evidence",
};

export function devPhaseLabel(phase: DevIterationPhase): string {
  return PHASE_LABELS[phase] ?? phase;
}

/** "3/5 requirements met" chip text. */
export function reqSummary(met: number, total: number): string {
  return `${met}/${total} met`;
}

export interface FormattedDevTime {
  absolute: string;
  relative: string;
}

/**
 * Format an epoch-ms timestamp for display. `now`/`locale`/`timeZone` are
 * injectable so tests are deterministic + timezone-stable.
 */
export function formatDevTime(
  ms: number | null,
  opts: { now?: number; locale?: string; timeZone?: string } = {},
): FormattedDevTime {
  if (ms === null || !Number.isFinite(ms)) {
    return { absolute: "—", relative: "" };
  }
  const date = new Date(ms);
  const now = opts.now !== undefined ? new Date(opts.now) : new Date();
  const absolute = date.toLocaleString(opts.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
  });
  const relative = formatDistance(date, now, { addSuffix: true });
  return { absolute, relative };
}

/** "$1.23" or "—" for a nullable cost. */
export function formatCost(costUsd: number | null): string {
  if (costUsd === null || !Number.isFinite(costUsd)) return "—";
  return `$${costUsd.toFixed(2)}`;
}
