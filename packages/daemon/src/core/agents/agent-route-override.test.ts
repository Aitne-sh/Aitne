import { describe, expect, it } from "vitest";

import {
  extractAgentRouteOverride,
  inferBackendForModel,
} from "./agent-route-override.js";
import {
  DEFAULT_CLAUDE_MEDIUM_MODEL,
  DEFAULT_CODEX_MEDIUM_MODEL,
} from "../backends/model-registry.js";

describe("inferBackendForModel", () => {
  it("finds the owning backend for a registered model id", () => {
    expect(inferBackendForModel(DEFAULT_CLAUDE_MEDIUM_MODEL)).toBe("claude");
    expect(inferBackendForModel(DEFAULT_CODEX_MEDIUM_MODEL)).toBe("codex");
  });

  it("returns null for an id no backend registers", () => {
    expect(inferBackendForModel("totally-custom-model")).toBeNull();
  });
});

describe("extractAgentRouteOverride", () => {
  it("returns null for non-object snapshots", () => {
    expect(extractAgentRouteOverride(null)).toBeNull();
    expect(extractAgentRouteOverride(undefined)).toBeNull();
    expect(extractAgentRouteOverride("snapshot")).toBeNull();
    expect(extractAgentRouteOverride([1, 2])).toBeNull();
  });

  it("returns null when nothing routing-relevant is present", () => {
    expect(extractAgentRouteOverride({})).toBeNull();
    expect(
      extractAgentRouteOverride({
        "on_error.notify_owner": true,
        "limits.timeout_minutes": 5,
        "enabled": false,
      }),
    ).toBeNull();
  });

  it("extracts a tier override", () => {
    expect(extractAgentRouteOverride({ "backend.tier": "high" })).toEqual({
      tier: "high",
      modelId: null,
      backendId: null,
      maxTurns: null,
      maxBudgetUsd: null,
    });
  });

  it("drops an out-of-vocabulary tier", () => {
    expect(extractAgentRouteOverride({ "backend.tier": "huge" })).toBeNull();
  });

  it("extracts a model pin with its stored backend_id", () => {
    expect(
      extractAgentRouteOverride({
        "backend.model": "gpt-5.4",
        "backend.backend_id": "codex",
      }),
    ).toEqual({
      tier: null,
      modelId: "gpt-5.4",
      backendId: "codex",
      maxTurns: null,
      maxBudgetUsd: null,
    });
  });

  it("infers the backend from the registry when backend_id is absent (legacy snapshot)", () => {
    const override = extractAgentRouteOverride({
      "backend.model": DEFAULT_CLAUDE_MEDIUM_MODEL,
    });
    expect(override).toEqual({
      tier: null,
      modelId: DEFAULT_CLAUDE_MEDIUM_MODEL,
      backendId: "claude",
      maxTurns: null,
      maxBudgetUsd: null,
    });
  });

  it("drops a model pin whose backend cannot be resolved, keeping other overrides", () => {
    expect(
      extractAgentRouteOverride({
        "backend.model": "totally-custom-model",
        "backend.tier": "medium",
        "limits.max_turns": 12,
      }),
    ).toEqual({
      tier: "medium",
      modelId: null,
      backendId: null,
      maxTurns: 12,
      maxBudgetUsd: null,
    });
  });

  it("ignores an invalid stored backend_id and falls back to inference", () => {
    const override = extractAgentRouteOverride({
      "backend.model": DEFAULT_CODEX_MEDIUM_MODEL,
      "backend.backend_id": "not-a-backend",
    });
    expect(override?.backendId).toBe("codex");
  });

  it("extracts limit overrides and re-guards their contracts", () => {
    expect(
      extractAgentRouteOverride({
        "limits.max_turns": 15,
        "limits.max_budget_usd": 0.75,
      }),
    ).toEqual({
      tier: null,
      modelId: null,
      backendId: null,
      maxTurns: 15,
      maxBudgetUsd: 0.75,
    });
    // Out-of-contract values are dropped, never thrown on.
    expect(
      extractAgentRouteOverride({
        "limits.max_turns": 2.5,
        "limits.max_budget_usd": -1,
      }),
    ).toBeNull();
    expect(
      extractAgentRouteOverride({
        "limits.max_budget_usd": 0,
      }),
    ).toEqual({
      tier: null,
      modelId: null,
      backendId: null,
      maxTurns: null,
      maxBudgetUsd: 0,
    });
  });

  it("drops an empty-string model (matches the schema's .min(1))", () => {
    expect(extractAgentRouteOverride({ "backend.model": "" })).toBeNull();
  });
});
