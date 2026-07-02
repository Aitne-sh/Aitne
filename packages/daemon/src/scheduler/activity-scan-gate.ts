/**
 * Stage-1 deterministic gate for the three-stage activity_scan funnel
 * (cost-reduction-structural §B). Pure function over a `ActivityScanSignals`
 * snapshot — no DB handle, no clock, no I/O. The dispatcher computes the
 * snapshot via `computeActivityScanSignals`, then asks this module which
 * stage to enter.
 *
 * The four possible decisions:
 *   - `stage0_silent`: consume observations, append a single Agent Log
 *     line via the daemon-direct writer, return. No LLM call.
 *   - `stage2`: lite-tier triage (only when `stage2Enabled`). Strict
 *     JSON-only output decides log_only vs escalate.
 *   - `stage3`: existing full activity_scan session.
 *
 * HOURLY_CHECK_GATE_REDESIGN_PLAN.md Phase 4 collapsed the gateMode
 * enum (`off`/`shadow`/`live`) into a single execution path. The gate's
 * verdict is always honoured.
 */

import type { ActivityScanSignals } from "../db/activity-scan-signals.js";

export type ActivityScanGateStage = "stage0_silent" | "stage2" | "stage3";

export interface ActivityScanGateConfig {
  /**
   * Hours since the last Stage 3 run after which the gate force-runs at
   * least Stage 2 (or Stage 3 if novelty is high). Bounds the worst case
   * where Stage 0/1 keeps short-circuiting on a quiet day.
   */
  heartbeatHours: number;
  /**
   * When `false`, low-signal cases bypass Stage 2 entirely and route to
   * Stage 3. The cautious default — Stage 2 only takes effect after
   * shadow telemetry validates the decision boundary.
   */
  stage2Enabled: boolean;
  /**
   * Below this threshold, `pendingObsCount` alone does not imply
   * Stage 3. Default 0 — any pending observation hits the low-signal
   * branch which routes to Stage 2 or Stage 3 depending on the flag.
   */
  pendingObsLowSignalCeiling?: number;
}

export interface ActivityScanGateDecision {
  stage: ActivityScanGateStage;
  /** Short, telemetry-friendly explanation. */
  reason: string;
  /** Snapshot at decision time (echoed for the audit row). */
  signals: ActivityScanSignals;
}

const HIGH_NOVELTY_FLOOR = 3;
const ESCALATE_NOVELTY_FLOOR = 2;

/**
 * WP4 chronic-failure surfacing — minimum hours between two
 * `agent_chronic_failure` Stage-3 escalations. The throttle input is
 * `signals.hoursSinceLastChronicFailureEscalation` (derived from the
 * last gate audit row carrying this reason), so a still-broken agent
 * re-surfaces at most once a day instead of on every tick.
 */
export const CHRONIC_FAILURE_REESCALATE_HOURS = 24;

export function decideStage(
  signals: ActivityScanSignals,
  config: ActivityScanGateConfig,
): ActivityScanGateDecision {
  // WP4 chronic-failure surfacing: a chronically failing enabled agent
  // (deterministic detector over `agent_executions`) forces Stage 3 so
  // the LLM can decide whether the owner needs to know — throttled to
  // once per CHRONIC_FAILURE_REESCALATE_HOURS via the last gate audit
  // row carrying this reason. Sits ABOVE the heartbeat branch on purpose:
  // with Stage 2 enabled, a quiet vault takes `heartbeat_due → stage2` on
  // every tick and a lower-placed chronic clause would be starved
  // indefinitely (stage2 ticks never reset `hoursSinceLastStage3Run`).
  // Fires at most once per 24h, so claiming the reason ahead of the other
  // escalates costs nothing — every Stage 3 carries the `<system_health>`
  // block while failures persist regardless of the reason.
  if (
    signals.chronicAgentFailures.length > 0
    && signals.hoursSinceLastChronicFailureEscalation
      >= CHRONIC_FAILURE_REESCALATE_HOURS
  ) {
    return decision("stage3", "agent_chronic_failure", signals);
  }

  // Heartbeat: even on quiet days, exercise Stage 2/3 every N hours so
  // the gate's signal compute is exercised end-to-end. We pick Stage 3
  // when there is *some* novelty pending, Stage 2 otherwise — Stage 2
  // is the cheaper lite-tier shape and Stage 3 wastes context if there
  // is nothing to act on. If Stage 2 is disabled, the cautious fallback
  // is Stage 3.
  if (signals.hoursSinceLastStage3Run >= config.heartbeatHours) {
    if (numericNovelty(signals.maxNoveltyScore) >= ESCALATE_NOVELTY_FLOOR) {
      return decision("stage3", "heartbeat_due_with_novelty", signals);
    }
    return decision(
      config.stage2Enabled ? "stage2" : "stage3",
      "heartbeat_due",
      signals,
    );
  }

  // Hard escalate: any high-priority signal goes straight to Stage 3.
  if (numericNovelty(signals.maxNoveltyScore) >= HIGH_NOVELTY_FLOOR) {
    return decision("stage3", "high_novelty", signals);
  }
  if (signals.calendarHasConflict) {
    return decision("stage3", "calendar_conflict", signals);
  }
  if (signals.vipMailUnreadCount > 0) {
    return decision("stage3", "vip_mail_unread", signals);
  }
  if (signals.agentPlanOverdueCount > 0) {
    return decision("stage3", "agent_plan_overdue", signals);
  }
  if (signals.scheduleApproachingCount > 0) {
    return decision("stage3", "schedule_approaching", signals);
  }

  // No signals at all → Stage 0 silent.
  if (signals.pendingObsCount === 0 && !signals.calendarHas24hChange) {
    return decision("stage0_silent", "no_signals", signals);
  }

  // Low signals only → Stage 2 if enabled, else Stage 3 (cautious default).
  // The pendingObsLowSignalCeiling lets an operator widen the silent-skip
  // band ("at most N noise observations is still nothing to act on"); the
  // default 0 leaves the design's conservative posture intact.
  const ceiling = Math.max(0, config.pendingObsLowSignalCeiling ?? 0);
  if (
    signals.pendingObsCount <= ceiling
    && !signals.calendarHas24hChange
  ) {
    return decision("stage0_silent", "low_signal_under_ceiling", signals);
  }

  return decision(
    config.stage2Enabled ? "stage2" : "stage3",
    "low_signal_default",
    signals,
  );
}

/**
 * The dispatcher logs every cron tick to `agent_actions` regardless of
 * which stage runs. Helper that builds the JSON payload from a decision
 * so the schema stays consistent across stages and call-sites.
 */
export function buildGateAuditDetail(
  decision: ActivityScanGateDecision,
  extra: {
    appliedDecision: ActivityScanGateStage;
    /** Stage-2 LLM verdict, when Stage 2 ran. */
    stage2Verdict?: "log_only" | "escalate" | "failed";
    /** Forced-run flag from `/api/agent/run-now` etc. */
    forced?: boolean;
    /**
     * HOURLY_CHECK_GATE_REDESIGN_PLAN.md §3.5 — true when pre-pass for
     * any non-direct integration failed in `harvestForGate` and the
     * gate force-escalated to `stage3` regardless of the signal
     * verdict. Surfaced in the audit row so dashboards can flag the
     * cautious-escalate path.
     */
    cautiousEscalate?: boolean;
    /**
     * Original gate verdict captured BEFORE cautious-escalate
     * overwrote it. Persisted as `pre_escalate_gate_*` so dashboards
     * can answer "what would the gate have said if pre-pass had
     * succeeded?" — distinguishes a tick that was structurally
     * stage3 anyway from one that was forced up from stage0_silent
     * by a transient fetch outage.
     */
    preEscalateGateStage?: ActivityScanGateStage;
    preEscalateGateReason?: string;
  },
): Record<string, unknown> {
  return {
    stage_reached: extra.appliedDecision,
    gate_stage: decision.stage,
    gate_reason: decision.reason,
    forced: extra.forced ?? false,
    // WP4 — count of chronically failing agents at decision time; the
    // per-agent detail rides on the signal snapshot below.
    chronic_agent_failures: decision.signals.chronicAgentFailures.length,
    ...(extra.stage2Verdict ? { stage2_verdict: extra.stage2Verdict } : {}),
    ...(extra.cautiousEscalate ? { cautious_escalate: true } : {}),
    ...(extra.preEscalateGateStage
      ? { pre_escalate_gate_stage: extra.preEscalateGateStage }
      : {}),
    ...(extra.preEscalateGateReason
      ? { pre_escalate_gate_reason: extra.preEscalateGateReason }
      : {}),
    signal_snapshot: {
      pendingObsCount: decision.signals.pendingObsCount,
      maxNoveltyScore: decision.signals.maxNoveltyScore,
      noveltyDistribution: decision.signals.noveltyDistribution,
      vipMailUnreadCount: decision.signals.vipMailUnreadCount,
      calendarHas24hChange: decision.signals.calendarHas24hChange,
      calendarHasConflict: decision.signals.calendarHasConflict,
      agentPlanOverdueCount: decision.signals.agentPlanOverdueCount,
      scheduleApproachingCount: decision.signals.scheduleApproachingCount,
      hoursSinceLastStage3Run: serializeHours(
        decision.signals.hoursSinceLastStage3Run,
      ),
      chronicAgentFailures: decision.signals.chronicAgentFailures,
      hoursSinceLastChronicFailureEscalation: serializeHours(
        decision.signals.hoursSinceLastChronicFailureEscalation,
      ),
    },
  };
}

/**
 * Build the `<gate_decision>` block injected into Stage 3's prompt so
 * the routine knows *why* it was escalated and can prioritize.
 */
export function renderGateDecisionBlock(
  decision: ActivityScanGateDecision,
  extra: { forced?: boolean; cautiousEscalate?: boolean },
): string {
  return [
    "<gate_decision>",
    `  triggered_by: ${decision.stage === "stage3" ? "stage1" : "stage2_escalation"}`,
    `  reason: ${decision.reason}`,
    `  forced: ${extra.forced ? "true" : "false"}`,
    ...(extra.cautiousEscalate ? ["  cautious_escalate: true"] : []),
    `  signals_snapshot: ${JSON.stringify({
      maxNovelty: decision.signals.maxNoveltyScore,
      pendingObs: decision.signals.pendingObsCount,
      vipMail: decision.signals.vipMailUnreadCount,
      calConflict: decision.signals.calendarHasConflict,
      agentPlanOverdue: decision.signals.agentPlanOverdueCount,
      scheduleApproaching: decision.signals.scheduleApproachingCount,
      chronicAgentFailures: decision.signals.chronicAgentFailures.length,
    })}`,
    "</gate_decision>",
  ].join("\n");
}

/**
 * WP4 chronic-failure surfacing — render the `<system_health>` block the
 * dispatcher attaches to EVERY Stage 3 event while at least one enabled
 * agent is chronically failing (not only the forced
 * `agent_chronic_failure` escalation). One line per failing agent with
 * slug, streak, last error kind, and the `/agents/<slug>` dashboard
 * page; the task-flow's Step 9 notify rules own whether the owner hears
 * about it. Pure string builder; returns null for empty input so the
 * caller can omit the event.data key entirely.
 */
export function renderSystemHealthBlock(
  failures: ActivityScanSignals["chronicAgentFailures"],
): string | null {
  if (failures.length === 0) return null;
  return [
    "<system_health>",
    "  These enabled agents have failed repeatedly on their most recent",
    "  runs. Their failures are otherwise silent — the owner may want to",
    "  know so they can fix or disable the agent.",
    ...failures.map(
      (f) =>
        `  - agent "${escapeXml(f.slug)}" failed its last ${f.streak} run(s)`
        + ` (last error kind: ${escapeXml(f.lastErrorKind ?? "unknown")});`
        + ` dashboard: /agents/${escapeXml(f.slug)}`,
    ),
    "</system_health>",
  ].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function numericNovelty(score: number | null): number {
  // Cautious default — null (no summary done yet) is treated as 2 so a
  // backlog of unsummarized observations does NOT silently skip the
  // routine. The design doc calls this out explicitly under "edge cases".
  return score ?? ESCALATE_NOVELTY_FLOOR;
}

function decision(
  stage: ActivityScanGateStage,
  reason: string,
  signals: ActivityScanSignals,
): ActivityScanGateDecision {
  return { stage, reason, signals };
}

function serializeHours(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(2));
}
