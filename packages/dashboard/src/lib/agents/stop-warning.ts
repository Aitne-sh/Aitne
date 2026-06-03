import type { StopWarning } from "./types";

/**
 * Pure view-model for the stop-warning modal (§10.3). The modal renders ONLY
 * the strings carried in the Agent's `stop_warning` payload — the dashboard
 * never hardcodes the consequences. This helper normalizes the payload into a
 * render-ready shape (and decides the alert tone from the declared `level`) so
 * the modal component stays a dumb renderer and the mapping is unit-tested.
 */

export type StopWarningTone = "destructive" | "warning";

export interface StopWarningView {
  /** Declared severity, surfaced verbatim as an uppercase prefix. */
  level: StopWarning["level"];
  levelLabel: string;
  tone: StopWarningTone;
  /** Concrete services that stop (from `services_lost`). Never synthesised. */
  servicesLost: string[];
  /** Downstream Agents that may produce incomplete output. */
  dependentAgents: string[];
  /** Optional re-activation hint, trimmed to null when blank. */
  reactivationHint: string | null;
}

function toneForLevel(level: StopWarning["level"]): StopWarningTone {
  // `critical` and `high` are framed as destructive; `normal` as a softer
  // warning. The shared Alert only has destructive / warning variants.
  return level === "normal" ? "warning" : "destructive";
}

/**
 * Build the modal view-model. A `null` warning (a user Agent stopped without a
 * declared warning) yields `null` — the caller shows a generic confirm instead.
 */
export function buildStopWarningView(
  warning: StopWarning | null | undefined,
): StopWarningView | null {
  if (!warning) return null;
  const hint = warning.reactivation_hint?.trim();
  return {
    level: warning.level,
    levelLabel: warning.level.toUpperCase(),
    tone: toneForLevel(warning.level),
    servicesLost: warning.services_lost.filter((s) => s.trim().length > 0),
    dependentAgents: (warning.dependent_agents ?? []).filter(
      (s) => s.trim().length > 0,
    ),
    reactivationHint: hint && hint.length > 0 ? hint : null,
  };
}
