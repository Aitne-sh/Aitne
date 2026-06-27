import { describe, it, expect } from "vitest";

import {
  BACKGROUND_TASK_FALLBACK_CLAUDE_MODEL,
  BACKGROUND_TASK_MAX_BUDGET_USD_CAP,
  BACKGROUND_TASK_MAX_TURNS_CAP,
  resolveBackgroundTaskEnvelope,
  tierEnvelope,
} from "./background-task-budget.js";

describe("resolveBackgroundTaskEnvelope", () => {
  it("defaults to the medium tier when tier + config are absent", () => {
    const r = resolveBackgroundTaskEnvelope({
      tier: null,
      maxBudgetUsd: null,
      processConfig: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.modelId).toBe(BACKGROUND_TASK_FALLBACK_CLAUDE_MODEL);
    expect(r.envelope).toEqual(
      expect.objectContaining({
        maxTurns: tierEnvelope("medium").maxTurns,
        maxBudgetUsd: tierEnvelope("medium").maxBudgetUsd,
        executeTimeoutMinutes: tierEnvelope("medium").executeTimeoutMinutes,
      }),
    );
  });

  it("uses the lite/high tier base envelopes", () => {
    const lite = resolveBackgroundTaskEnvelope({
      tier: "lite",
      maxBudgetUsd: null,
      processConfig: null,
    });
    const high = resolveBackgroundTaskEnvelope({
      tier: "high",
      maxBudgetUsd: null,
      processConfig: null,
    });
    expect(lite.ok && lite.envelope.executeTimeoutMinutes).toBe(
      tierEnvelope("lite").executeTimeoutMinutes,
    );
    expect(high.ok && high.envelope.maxTurns).toBe(tierEnvelope("high").maxTurns);
    expect(high.ok && high.envelope.maxBudgetUsd).toBeGreaterThan(
      tierEnvelope("lite").maxBudgetUsd,
    );
  });

  it("honours the process_backend_config model + caps", () => {
    const r = resolveBackgroundTaskEnvelope({
      tier: "medium",
      maxBudgetUsd: null,
      processConfig: {
        mainBackend: "claude",
        mainModel: "claude-opus-4-8",
        maxTurns: 25,
        maxBudgetUsd: 3.0,
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.modelId).toBe("claude-opus-4-8");
    expect(r.envelope.maxTurns).toBe(25);
    expect(r.envelope.maxBudgetUsd).toBe(3.0);
  });

  it("per-task maxBudgetUsd override wins over config + tier", () => {
    const r = resolveBackgroundTaskEnvelope({
      tier: "lite",
      maxBudgetUsd: 4.5,
      processConfig: {
        mainBackend: "claude",
        mainModel: null,
        maxTurns: null,
        maxBudgetUsd: 1.0,
      },
    });
    expect(r.ok && r.envelope.maxBudgetUsd).toBe(4.5);
    // empty main_model falls back to the constant
    expect(r.ok && r.envelope.modelId).toBe(BACKGROUND_TASK_FALLBACK_CLAUDE_MODEL);
  });

  it("clamps turns + budget to the hard caps", () => {
    const r = resolveBackgroundTaskEnvelope({
      tier: "high",
      maxBudgetUsd: 999,
      processConfig: {
        mainBackend: "claude",
        mainModel: "claude-sonnet-4-6",
        maxTurns: 9_999,
        maxBudgetUsd: null,
      },
    });
    expect(r.ok && r.envelope.maxTurns).toBe(BACKGROUND_TASK_MAX_TURNS_CAP);
    expect(r.ok && r.envelope.maxBudgetUsd).toBe(BACKGROUND_TASK_MAX_BUDGET_USD_CAP);
  });

  it("falls back to the tier budget when the override is non-positive", () => {
    const r = resolveBackgroundTaskEnvelope({
      tier: "medium",
      maxBudgetUsd: 0,
      processConfig: null,
    });
    // 0 is not a positive override → tier base (route schema rejects 0,
    // but the resolver is defensive).
    expect(r.ok && r.envelope.maxBudgetUsd).toBe(tierEnvelope("medium").maxBudgetUsd);
  });

  it("refuses a non-claude backend (background_task is Claude-only)", () => {
    const r = resolveBackgroundTaskEnvelope({
      tier: "medium",
      maxBudgetUsd: null,
      processConfig: {
        mainBackend: "codex",
        mainModel: "gpt-x",
        maxTurns: 40,
        maxBudgetUsd: 2,
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("backend_misconfigured");
    expect(r.detail).toContain("codex");
  });
});
