/**
 * Pure view helpers for the dev-sessions dashboard — badge variants, labels,
 * and deterministic time formatting. Kept free of React so they unit-test in a
 * plain Node vitest run (the dashboard convention).
 */

import { formatDistance } from "date-fns";
import type {
  DevAcRowStatus,
  DevChecklistDTO,
  DevIterationPhase,
  DevRequirementStatus,
  DevSessionLoopState,
  DevSessionState,
  DevTaskDTO,
  DevTaskState,
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
  decompose: "Decompose",
  decompose_review: "Decompose review",
  supervise: "Supervise",
  plan_review: "Plan review",
  merge: "Merge",
  baseline: "Baseline verify",
  rollback: "Rollback",
  contract_review: "Contract review",
  resume: "Resume",
  contract_gen: "Task contract",
};

export function devPhaseLabel(phase: DevIterationPhase): string {
  return PHASE_LABELS[phase] ?? phase;
}

// ── acceptance checklist rendering ─────────────────────────────────────

export function devAcStatusBadgeVariant(status: DevAcRowStatus): DevBadgeVariant {
  switch (status) {
    case "verified":
      return "green";
    case "failed":
      return "red";
    default:
      return "amber";
  }
}

/** "5/7 AC verified · 1 human awaiting sign-off" chip; null when the run has
 *  no checklist (predates the layer). */
export function checklistSummary(rows: readonly DevChecklistDTO[] | undefined): string | null {
  if (!rows || rows.length === 0) return null;
  const verified = rows.filter((r) => r.status === "verified").length;
  const humanPending = rows.filter((r) => r.method === "human" && r.status !== "verified").length;
  const base = `${verified}/${rows.length} AC verified`;
  return humanPending > 0
    ? `${base} · ${humanPending} human awaiting sign-off`
    : base;
}

// ── fleet task rendering ────────────────────────────────────────────────

const TASK_STATE_LABELS: Record<DevTaskState, string> = {
  queued: "Queued",
  running: "Running",
  supervise_pending: "Supervising",
  merge_pending: "Merging",
  awaiting_user: "Awaiting decision",
  merged: "Merged",
  failed: "Failed",
  superseded: "Superseded",
  dep_failed: "Dep failed",
};

export function devTaskStateLabel(state: DevTaskState): string {
  return TASK_STATE_LABELS[state] ?? state;
}

export function devTaskStateBadgeVariant(state: DevTaskState): DevBadgeVariant {
  switch (state) {
    case "merged":
      return "green";
    case "running":
    case "merge_pending":
      return "amber";
    case "supervise_pending":
      return "purple";
    case "awaiting_user":
      return "orange";
    case "failed":
    case "dep_failed":
      return "red";
    case "superseded":
      return "gray";
    default:
      return "blue";
  }
}

/** Group fleet tasks into their topological layers (the DTO's `group` index),
 *  sorted so the earliest layer renders first and tasks within a layer keep a
 *  stable key order. Returns [] for a single-loop / not-yet-decomposed run. */
export function groupTasksByLayer(tasks: readonly DevTaskDTO[]): DevTaskDTO[][] {
  if (tasks.length === 0) return [];
  const maxLayer = tasks.reduce((m, t) => Math.max(m, t.group), 0);
  const layers: DevTaskDTO[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const t of tasks) layers[t.group]!.push(t);
  for (const layer of layers) layer.sort((a, b) => a.taskKey.localeCompare(b.taskKey));
  return layers.filter((l) => l.length > 0);
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
