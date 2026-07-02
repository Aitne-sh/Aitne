import { describe, it, expect } from "vitest";
import type { ActivityScanSignals } from "../db/activity-scan-signals.js";
import {
  CHRONIC_FAILURE_REESCALATE_HOURS,
  decideStage,
  buildGateAuditDetail,
  renderGateDecisionBlock,
  renderSystemHealthBlock,
  type ActivityScanGateConfig,
} from "./activity-scan-gate.js";

const baseSignals: ActivityScanSignals = {
  pendingObsCount: 0,
  maxNoveltyScore: 0,
  noveltyDistribution: { low: 0, mid: 0, high: 0 },
  vipMailUnreadCount: 0,
  calendarHas24hChange: false,
  calendarHasConflict: false,
  agentPlanOverdueCount: 0,
  scheduleApproachingCount: 0,
  hoursSinceLastStage3Run: 1,
  chronicAgentFailures: [],
  hoursSinceLastChronicFailureEscalation: Number.POSITIVE_INFINITY,
};

const baseConfig: ActivityScanGateConfig = {
  heartbeatHours: 4,
  stage2Enabled: false,
};

function withSignals(patch: Partial<ActivityScanSignals>): ActivityScanSignals {
  return { ...baseSignals, ...patch };
}

describe("decideStage", () => {
  it("returns stage0_silent when no signal exists", () => {
    const d = decideStage(baseSignals, baseConfig);
    expect(d.stage).toBe("stage0_silent");
    expect(d.reason).toBe("no_signals");
  });

  it("escalates to stage3 on high novelty", () => {
    const d = decideStage(withSignals({ maxNoveltyScore: 3 }), baseConfig);
    expect(d.stage).toBe("stage3");
    expect(d.reason).toBe("high_novelty");
  });

  it("escalates to stage3 on calendar conflict", () => {
    const d = decideStage(
      withSignals({ calendarHasConflict: true }),
      baseConfig,
    );
    expect(d.stage).toBe("stage3");
    expect(d.reason).toBe("calendar_conflict");
  });

  it("escalates to stage3 on VIP mail unread", () => {
    const d = decideStage(withSignals({ vipMailUnreadCount: 1 }), baseConfig);
    expect(d.stage).toBe("stage3");
    expect(d.reason).toBe("vip_mail_unread");
  });

  it("escalates to stage3 on agent plan overdue", () => {
    const d = decideStage(withSignals({ agentPlanOverdueCount: 1 }), baseConfig);
    expect(d.stage).toBe("stage3");
    expect(d.reason).toBe("agent_plan_overdue");
  });

  it("escalates to stage3 on schedule approaching", () => {
    const d = decideStage(
      withSignals({ scheduleApproachingCount: 1 }),
      baseConfig,
    );
    expect(d.stage).toBe("stage3");
    expect(d.reason).toBe("schedule_approaching");
  });

  it("forces stage3 on chronic agent failures when not throttled", () => {
    const d = decideStage(
      withSignals({
        chronicAgentFailures: [
          { slug: "deploy-watch", streak: 3, lastErrorKind: "tool" },
        ],
      }),
      baseConfig,
    );
    expect(d.stage).toBe("stage3");
    expect(d.reason).toBe("agent_chronic_failure");
  });

  it("does not force stage3 when the last chronic-failure escalation is under 24h old", () => {
    const d = decideStage(
      withSignals({
        chronicAgentFailures: [
          { slug: "deploy-watch", streak: 3, lastErrorKind: "tool" },
        ],
        hoursSinceLastChronicFailureEscalation:
          CHRONIC_FAILURE_REESCALATE_HOURS - 0.1,
      }),
      baseConfig,
    );
    // With no other signal pending, the throttled tick falls through to
    // the ordinary silent path.
    expect(d.stage).toBe("stage0_silent");
    expect(d.reason).toBe("no_signals");
  });

  it("routes low signals to stage2 when stage2 enabled", () => {
    const d = decideStage(
      withSignals({ pendingObsCount: 3, maxNoveltyScore: 1 }),
      { ...baseConfig, stage2Enabled: true },
    );
    expect(d.stage).toBe("stage2");
    expect(d.reason).toBe("low_signal_default");
  });

  it("routes low signals to stage3 when stage2 disabled", () => {
    const d = decideStage(
      withSignals({ pendingObsCount: 3, maxNoveltyScore: 1 }),
      { ...baseConfig, stage2Enabled: false },
    );
    expect(d.stage).toBe("stage3");
    expect(d.reason).toBe("low_signal_default");
  });

  it("treats null novelty as cautious mid-tier (escalates) on heartbeat", () => {
    const d = decideStage(
      withSignals({ maxNoveltyScore: null, hoursSinceLastStage3Run: 5 }),
      { ...baseConfig, heartbeatHours: 4 },
    );
    expect(d.stage).toBe("stage3");
    expect(d.reason).toBe("heartbeat_due_with_novelty");
  });

  it("forces heartbeat run after window even on quiet signals", () => {
    const d = decideStage(
      withSignals({ hoursSinceLastStage3Run: 5, maxNoveltyScore: 0 }),
      { ...baseConfig, heartbeatHours: 4, stage2Enabled: true },
    );
    expect(d.stage).toBe("stage2");
    expect(d.reason).toBe("heartbeat_due");
  });

  it("falls back to stage3 on heartbeat when stage2 is disabled", () => {
    const d = decideStage(
      withSignals({ hoursSinceLastStage3Run: 5, maxNoveltyScore: 0 }),
      { ...baseConfig, heartbeatHours: 4, stage2Enabled: false },
    );
    expect(d.stage).toBe("stage3");
    expect(d.reason).toBe("heartbeat_due");
  });

  it("widens silent band via pendingObsLowSignalCeiling", () => {
    const d = decideStage(
      withSignals({ pendingObsCount: 2, maxNoveltyScore: 1 }),
      { ...baseConfig, stage2Enabled: false, pendingObsLowSignalCeiling: 5 },
    );
    expect(d.stage).toBe("stage0_silent");
    expect(d.reason).toBe("low_signal_under_ceiling");
  });

  it("does not silent-skip when calendarHas24hChange is true even under ceiling", () => {
    const d = decideStage(
      withSignals({
        pendingObsCount: 1,
        calendarHas24hChange: true,
        maxNoveltyScore: 1,
      }),
      { ...baseConfig, stage2Enabled: true, pendingObsLowSignalCeiling: 5 },
    );
    expect(d.stage).toBe("stage2");
  });
});

describe("buildGateAuditDetail", () => {
  it("preserves the decision shape and adds applied stage", () => {
    const decision = decideStage(withSignals({ maxNoveltyScore: 3 }), baseConfig);
    const detail = buildGateAuditDetail(decision, {
      appliedDecision: "stage3",
    });
    expect(detail.stage_reached).toBe("stage3");
    expect(detail.gate_stage).toBe("stage3");
    expect(detail.gate_reason).toBe("high_novelty");
    expect(detail.forced).toBe(false);
    expect((detail.signal_snapshot as Record<string, unknown>).maxNoveltyScore).toBe(3);
  });

  it("surfaces cautious_escalate flag when set", () => {
    const decision = decideStage(baseSignals, baseConfig);
    const detail = buildGateAuditDetail(decision, {
      appliedDecision: "stage3",
      cautiousEscalate: true,
    });
    expect(detail.stage_reached).toBe("stage3");
    expect(detail.cautious_escalate).toBe(true);
  });

  it("persists the pre-escalate gate verdict alongside a cautious escalate", () => {
    const decision = decideStage(baseSignals, baseConfig);
    const detail = buildGateAuditDetail(decision, {
      appliedDecision: "stage3",
      cautiousEscalate: true,
      preEscalateGateStage: "stage0_silent",
      preEscalateGateReason: "no_signals",
    });
    expect(detail.pre_escalate_gate_stage).toBe("stage0_silent");
    expect(detail.pre_escalate_gate_reason).toBe("no_signals");
  });

  it("includes stage2_verdict in the audit detail when provided", () => {
    const decision = decideStage(baseSignals, { ...baseConfig, stage2Enabled: true });
    const detail = buildGateAuditDetail(decision, {
      appliedDecision: "stage2",
      stage2Verdict: "escalate",
    });
    expect(detail.stage2_verdict).toBe("escalate");
  });

  it("normalizes Infinity to null in the persisted snapshot", () => {
    const decision = decideStage(
      withSignals({ hoursSinceLastStage3Run: Number.POSITIVE_INFINITY }),
      baseConfig,
    );
    const detail = buildGateAuditDetail(decision, {
      appliedDecision: "stage0_silent",
    });
    expect(
      (detail.signal_snapshot as Record<string, unknown>).hoursSinceLastStage3Run,
    ).toBeNull();
    // hoursSinceLastChronicFailureEscalation (Infinity in baseSignals)
    // goes through the same normalization.
    expect(
      (detail.signal_snapshot as Record<string, unknown>)
        .hoursSinceLastChronicFailureEscalation,
    ).toBeNull();
  });

  it("carries the chronic-failure count and per-agent snapshot detail", () => {
    const failures = [
      { slug: "deploy-watch", streak: 3, lastErrorKind: "tool" },
      { slug: "mail-digest", streak: 5, lastErrorKind: null },
    ];
    const decision = decideStage(
      withSignals({ chronicAgentFailures: failures }),
      baseConfig,
    );
    const detail = buildGateAuditDetail(decision, {
      appliedDecision: "stage3",
    });
    expect(detail.gate_reason).toBe("agent_chronic_failure");
    expect(detail.chronic_agent_failures).toBe(2);
    expect(
      (detail.signal_snapshot as Record<string, unknown>).chronicAgentFailures,
    ).toEqual(failures);
  });
});

describe("renderGateDecisionBlock", () => {
  it("emits a structured block with reason and snapshot", () => {
    const decision = decideStage(
      withSignals({ maxNoveltyScore: 3, pendingObsCount: 4 }),
      baseConfig,
    );
    const block = renderGateDecisionBlock(decision, { forced: false });
    expect(block).toContain("<gate_decision>");
    expect(block).toContain("reason: high_novelty");
    expect(block).toContain('"maxNovelty":3');
    expect(block).toContain('"pendingObs":4');
    expect(block).toContain("</gate_decision>");
  });

  it("labels Stage 2 escalations as `stage2_escalation` in the triggered_by line", () => {
    // Decision whose `stage` is not `stage3` (stage2 here): renders the
    // "triggered by stage2 escalation" branch.
    const decision = decideStage(baseSignals, { ...baseConfig, stage2Enabled: true });
    const block = renderGateDecisionBlock(decision, { forced: true });
    expect(block).toContain("triggered_by: stage2_escalation");
    expect(block).toContain("forced: true");
  });

  it("emits cautious_escalate line when the harvest forced stage3", () => {
    const decision = decideStage(
      withSignals({ maxNoveltyScore: 3, pendingObsCount: 0 }),
      baseConfig,
    );
    const block = renderGateDecisionBlock(decision, {
      forced: false,
      cautiousEscalate: true,
    });
    expect(block).toContain("cautious_escalate: true");
  });

  it("carries the chronic-failure count in the signals snapshot", () => {
    const decision = decideStage(
      withSignals({
        chronicAgentFailures: [
          { slug: "deploy-watch", streak: 3, lastErrorKind: "tool" },
          { slug: "mail-digest", streak: 5, lastErrorKind: null },
        ],
      }),
      baseConfig,
    );
    const block = renderGateDecisionBlock(decision, { forced: false });
    expect(block).toContain('"chronicAgentFailures":2');
  });
});

describe("renderSystemHealthBlock", () => {
  it("returns null for empty input", () => {
    expect(renderSystemHealthBlock([])).toBeNull();
  });

  it("renders a preamble plus one line per failing agent with slug, streak, error kind, and dashboard hint", () => {
    const block = renderSystemHealthBlock([
      { slug: "deploy-watch", streak: 3, lastErrorKind: "tool" },
      { slug: "mail-digest", streak: 5, lastErrorKind: null },
    ]);
    expect(block).not.toBeNull();
    expect(block).toContain("<system_health>");
    expect(block).toContain("</system_health>");
    expect(block).toContain("failed repeatedly");
    expect(block).toContain('agent "deploy-watch" failed its last 3 run(s)');
    expect(block).toContain("last error kind: tool");
    expect(block).toContain("dashboard: /agents/deploy-watch");
    // NULL error kind is rendered as "unknown".
    expect(block).toContain('agent "mail-digest" failed its last 5 run(s)');
    expect(block).toContain("last error kind: unknown");
    expect(block).toContain("dashboard: /agents/mail-digest");
  });

  it("XML-escapes slug and error kind", () => {
    const block = renderSystemHealthBlock([
      { slug: 'we"ird<&>', streak: 3, lastErrorKind: '<tool & "quota">' },
    ]);
    expect(block).toContain("we&quot;ird&lt;&amp;&gt;");
    expect(block).toContain("&lt;tool &amp; &quot;quota&quot;&gt;");
    expect(block).not.toContain("<tool");
  });
});
