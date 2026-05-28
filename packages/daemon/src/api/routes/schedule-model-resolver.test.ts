import { describe, it, expect } from "vitest";
import {
  resolveModelToken,
  resolveModelTokenForPatch,
} from "./schedule-model-resolver.js";
import { snapshotModelRegistry } from "./schedule-validation.js";

/**
 * Phase D §4.3 unit tests for `resolveModelToken` and
 * `resolveModelTokenForPatch`. Pure module per the file-level
 * docstring — all branches reachable from synthetic inputs without
 * touching the DB or the live registry. 100% coverage tier per
 * `vitest.config.ts`.
 *
 * The resolver delegates to `validateModelToken` for the four kinds
 * (alias / model / ambiguous / unknown) and adds the persistence-
 * layer concerns: tier ↔ model mutual exclusion, alias rewrites,
 * deprecation warnings, and the PATCH-specific clear-with-null
 * sentinel.
 */

describe("resolveModelToken — no-pin path", () => {
  it("returns all-null when neither model nor tier is set", () => {
    const result = resolveModelToken({
      model: undefined,
      tier: undefined,
      fieldBase: "model",
      tierField: "tier",
      rowIndex: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toBeNull();
    expect(result.tierOverride).toBeNull();
    expect(result.backendId).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it("returns tier-only when tier is set and model is unset", () => {
    const result = resolveModelToken({
      model: undefined,
      tier: "lite",
      fieldBase: "model",
      tierField: "tier",
      rowIndex: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toBeNull();
    expect(result.tierOverride).toBe("lite");
    expect(result.backendId).toBeNull();
  });
});

describe("resolveModelToken — conflict + alias + registered + unknown", () => {
  it("rejects when both model and tier are set", () => {
    const result = resolveModelToken({
      model: "claude-opus-4-7",
      tier: "high",
      fieldBase: "rows[3].model",
      tierField: "rows[3].tier",
      rowIndex: 3,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe("schedule.tier_and_model_conflict");
    expect(result.errors[0].field).toBe("rows[3].model");
    expect(result.errors[0].rowIndex).toBe(3);
  });

  it("rewrites alias 'sonnet' to tier=medium", () => {
    const result = resolveModelToken({
      model: "sonnet",
      tier: undefined,
      fieldBase: "model",
      tierField: "tier",
      rowIndex: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toBeNull();
    expect(result.tierOverride).toBe("medium");
    expect(result.backendId).toBeNull();
  });

  it("rewrites alias 'opus' to tier=high", () => {
    const result = resolveModelToken({
      model: "opus",
      tier: undefined,
      fieldBase: "model",
      tierField: "tier",
      rowIndex: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tierOverride).toBe("high");
  });

  it("captures (model, backendId) for a registered non-deprecated id", () => {
    const result = resolveModelToken({
      model: "claude-opus-4-8",
      tier: undefined,
      fieldBase: "model",
      tierField: "tier",
      rowIndex: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toBe("claude-opus-4-8");
    expect(result.backendId).toBe("claude");
    expect(result.tierOverride).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it("attaches a schedule.model_deprecated warning for a deprecated id", () => {
    const result = resolveModelToken({
      model: "claude-opus-4-6",
      tier: undefined,
      fieldBase: "model",
      tierField: "tier",
      rowIndex: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toBe("claude-opus-4-6");
    expect(result.backendId).toBe("claude");
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0].code).toBe("schedule.model_deprecated");
    expect(result.warnings[0].severity).toBe("warning");
    expect(result.warnings[0].validValues).toMatchObject({
      model: "claude-opus-4-6",
      backendId: "claude",
    });
  });

  it("returns schedule.model_unknown with validValues for a typo", () => {
    const result = resolveModelToken({
      model: "gpt-5.4-turbo",
      tier: undefined,
      fieldBase: "model",
      tierField: "tier",
      rowIndex: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe("schedule.model_unknown");
    const validValues = result.errors[0].validValues as {
      aliases: string[];
      models: Record<string, string[]>;
    };
    expect(validValues.aliases).toEqual(["sonnet", "opus"]);
    expect(validValues.models.codex).toContain("gpt-5.4");
  });

  it("returns schedule.model_ambiguous when synthetic snapshot has collisions", () => {
    const snapshot: ReturnType<typeof snapshotModelRegistry> = {
      modelAliases: { sonnet: "medium", opus: "high" },
      models: {
        claude: [{ id: "shared-id", tier: "high", deprecated: false }],
        codex: [{ id: "shared-id", tier: "medium", deprecated: false }],
        gemini: [],
        opencode: [],
      },
    };
    const result = resolveModelToken({
      model: "shared-id",
      tier: undefined,
      fieldBase: "model",
      tierField: "tier",
      rowIndex: null,
      snapshot,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe("schedule.model_ambiguous");
  });
});

describe("resolveModelTokenForPatch — PATCH-specific semantics", () => {
  it("returns all-not-present when nothing is set (no DB columns touched)", () => {
    const result = resolveModelTokenForPatch({
      model: undefined,
      tier: undefined,
      fieldBase: "model",
      tierField: "tier",
      rowIndex: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.present).toBe(false);
    expect(result.tierOverride.present).toBe(false);
    expect(result.backendId.present).toBe(false);
  });

  it("model:null clears both model and backend_id", () => {
    const result = resolveModelTokenForPatch({
      model: null,
      tier: undefined,
      fieldBase: "model",
      tierField: "tier",
      rowIndex: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toEqual({ present: true, value: null });
    expect(result.backendId).toEqual({ present: true, value: null });
    expect(result.tierOverride.present).toBe(false);
  });

  it("tier:null clears tier_override (model untouched)", () => {
    const result = resolveModelTokenForPatch({
      model: undefined,
      tier: null,
      fieldBase: "model",
      tierField: "tier",
      rowIndex: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tierOverride).toEqual({ present: true, value: null });
    expect(result.model.present).toBe(false);
    expect(result.backendId.present).toBe(false);
  });

  it("alias on PATCH rewrites to tier + clears model + backend_id", () => {
    const result = resolveModelTokenForPatch({
      model: "opus",
      tier: undefined,
      fieldBase: "model",
      tierField: "tier",
      rowIndex: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toEqual({ present: true, value: null });
    expect(result.tierOverride).toEqual({ present: true, value: "high" });
    expect(result.backendId).toEqual({ present: true, value: null });
  });

  it("registered model on PATCH sets (model, backend_id) and clears tier_override", () => {
    const result = resolveModelTokenForPatch({
      model: "claude-opus-4-7",
      tier: undefined,
      fieldBase: "model",
      tierField: "tier",
      rowIndex: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toEqual({ present: true, value: "claude-opus-4-7" });
    expect(result.backendId).toEqual({ present: true, value: "claude" });
    expect(result.tierOverride).toEqual({ present: true, value: null });
  });

  it("preserves caller-supplied tier:null even when model writes a registered id", () => {
    // When the caller explicitly passes `tier:null`, the resolver
    // honors that intent — the tierPartial uses the explicit `null`
    // rather than the auto-clear path (both happen to write null
    // but the test pins that explicit clears are not lost).
    const result = resolveModelTokenForPatch({
      model: "claude-opus-4-7",
      tier: null,
      fieldBase: "model",
      tierField: "tier",
      rowIndex: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tierOverride).toEqual({ present: true, value: null });
  });

  it("rejects PATCH with both non-null tier and non-null model", () => {
    const result = resolveModelTokenForPatch({
      model: "claude-opus-4-7",
      tier: "high",
      fieldBase: "model",
      tierField: "tier",
      rowIndex: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe("schedule.tier_and_model_conflict");
  });

  it("ACCEPTS PATCH with tier:high + model:null (the clear-one-set-the-other form)", () => {
    const result = resolveModelTokenForPatch({
      model: null,
      tier: "high",
      fieldBase: "model",
      tierField: "tier",
      rowIndex: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toEqual({ present: true, value: null });
    expect(result.tierOverride).toEqual({ present: true, value: "high" });
    expect(result.backendId).toEqual({ present: true, value: null });
  });

  it("ACCEPTS PATCH with model:<id> + tier:null (mirror of above)", () => {
    const result = resolveModelTokenForPatch({
      model: "claude-opus-4-7",
      tier: null,
      fieldBase: "model",
      tierField: "tier",
      rowIndex: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toEqual({ present: true, value: "claude-opus-4-7" });
    expect(result.tierOverride).toEqual({ present: true, value: null });
  });

  it("attaches deprecated warning on PATCH model write to a deprecated id", () => {
    const result = resolveModelTokenForPatch({
      model: "claude-opus-4-6",
      tier: undefined,
      fieldBase: "model",
      tierField: "tier",
      rowIndex: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings[0].code).toBe("schedule.model_deprecated");
  });

  it("emits schedule.model_unknown on PATCH model typo with validValues", () => {
    const result = resolveModelTokenForPatch({
      model: "gpt-5.4-turbo",
      tier: undefined,
      fieldBase: "model",
      tierField: "tier",
      rowIndex: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe("schedule.model_unknown");
    expect(result.errors[0].validValues).toBeDefined();
  });

  it("emits schedule.model_ambiguous on PATCH with a synthetic collision", () => {
    const snapshot: ReturnType<typeof snapshotModelRegistry> = {
      modelAliases: { sonnet: "medium", opus: "high" },
      models: {
        claude: [{ id: "shared-id", tier: "high", deprecated: false }],
        codex: [{ id: "shared-id", tier: "medium", deprecated: false }],
        gemini: [],
        opencode: [],
      },
    };
    const result = resolveModelTokenForPatch({
      model: "shared-id",
      tier: undefined,
      fieldBase: "model",
      tierField: "tier",
      rowIndex: null,
      snapshot,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe("schedule.model_ambiguous");
  });
});
