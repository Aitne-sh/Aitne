import { describe, it, expect } from "vitest";
import {
  snapshotModelRegistry,
  validateModelToken,
  type ModelRegistrySnapshot,
} from "./schedule-validation.js";

/**
 * `validateModelToken` matches entirely against its snapshot argument
 * (see file-level docstring) so the ambiguous branch is exercisable
 * without mutating the live `MODEL_REGISTRY`. Tests construct synthetic
 * snapshots when they need to hit branches the production registry
 * can't reach today.
 *
 * Phase B coverage tier — 100% statements/branches/functions/lines per
 * `vitest.config.ts`.
 */

function makeEmptySnapshot(): ModelRegistrySnapshot {
  return {
    modelAliases: { sonnet: "medium", opus: "high" },
    models: { claude: [], codex: [], gemini: [], opencode: [] },
  };
}

describe("snapshotModelRegistry", () => {
  it("includes the legacy alias → tier mapping", () => {
    const snap = snapshotModelRegistry();
    expect(snap.modelAliases).toEqual({ sonnet: "medium", opus: "high" });
  });

  it("emits a per-backend entry for every BackendId", () => {
    const snap = snapshotModelRegistry();
    expect(Object.keys(snap.models).sort()).toEqual(
      ["claude", "codex", "gemini", "opencode"].sort(),
    );
    // Production registry has at least one entry per backend.
    expect(snap.models.claude.length).toBeGreaterThan(0);
    expect(snap.models.codex.length).toBeGreaterThan(0);
    expect(snap.models.gemini.length).toBeGreaterThan(0);
    expect(snap.models.opencode.length).toBeGreaterThan(0);
  });

  it("carries id / tier / deprecated for every entry", () => {
    const snap = snapshotModelRegistry();
    for (const backend of ["claude", "codex", "gemini", "opencode"] as const) {
      for (const entry of snap.models[backend]) {
        expect(typeof entry.id).toBe("string");
        expect(["lite", "medium", "high"]).toContain(entry.tier);
        expect(typeof entry.deprecated).toBe("boolean");
      }
    }
  });

  it("preserves the deprecated flag on legacy models", () => {
    const snap = snapshotModelRegistry();
    const legacy = snap.models.claude.find((m) => m.id === "claude-opus-4-6");
    expect(legacy?.deprecated).toBe(true);
    const priorLegacy = snap.models.claude.find((m) => m.id === "claude-opus-4-7");
    expect(priorLegacy?.deprecated).toBe(true);
    const current = snap.models.claude.find((m) => m.id === "claude-opus-4-8");
    expect(current?.deprecated).toBe(false);
  });
});

describe("validateModelToken — alias path", () => {
  it("'sonnet' rewrites to medium tier", () => {
    const snap = snapshotModelRegistry();
    expect(validateModelToken("sonnet", snap)).toEqual({
      kind: "alias",
      tierToken: "medium",
    });
  });

  it("'opus' rewrites to high tier", () => {
    const snap = snapshotModelRegistry();
    expect(validateModelToken("opus", snap)).toEqual({
      kind: "alias",
      tierToken: "high",
    });
  });
});

describe("validateModelToken — registered single-match", () => {
  it("resolves a claude model to (backendId, modelId)", () => {
    const snap = snapshotModelRegistry();
    const result = validateModelToken("claude-opus-4-8", snap);
    expect(result).toEqual({
      kind: "model",
      backendId: "claude",
      modelId: "claude-opus-4-8",
      deprecated: false,
    });
  });

  it("resolves a codex model", () => {
    const snap = snapshotModelRegistry();
    const result = validateModelToken("gpt-5.4", snap);
    expect(result).toEqual({
      kind: "model",
      backendId: "codex",
      modelId: "gpt-5.4",
      deprecated: false,
    });
  });

  it("resolves a gemini model", () => {
    const snap = snapshotModelRegistry();
    const result = validateModelToken("gemini-3.1-pro-preview", snap);
    expect(result).toEqual({
      kind: "model",
      backendId: "gemini",
      modelId: "gemini-3.1-pro-preview",
      deprecated: false,
    });
  });

  it("resolves an opencode model whose id starts with anthropic/", () => {
    // The composite-form check sees the leading `anthropic/` prefix, fails
    // the `isBackendId` test (anthropic is not a daemon BackendId), and
    // falls through to the cross-backend scan — which finds the model
    // under the opencode entry. Coverage for the prefix-not-backend
    // fall-through branch.
    const snap = snapshotModelRegistry();
    const result = validateModelToken("anthropic/claude-opus-4-8", snap);
    expect(result).toEqual({
      kind: "model",
      backendId: "opencode",
      modelId: "anthropic/claude-opus-4-8",
      deprecated: false,
    });
  });
});

describe("validateModelToken — deprecated path", () => {
  it("flags a registered-but-deprecated claude model with deprecated:true", () => {
    const snap = snapshotModelRegistry();
    const result = validateModelToken("claude-opus-4-6", snap);
    expect(result).toEqual({
      kind: "model",
      backendId: "claude",
      modelId: "claude-opus-4-6",
      deprecated: true,
    });
  });

  it("flags a deprecated gemini model with deprecated:true", () => {
    const snap = snapshotModelRegistry();
    const result = validateModelToken("gemini-2.5-flash", snap);
    expect(result).toEqual({
      kind: "model",
      backendId: "gemini",
      modelId: "gemini-2.5-flash",
      deprecated: true,
    });
  });
});

describe("validateModelToken — composite-form disambiguator", () => {
  it("resolves '<backend>/<model>' against the named backend", () => {
    const snap = snapshotModelRegistry();
    const result = validateModelToken("claude/claude-opus-4-8", snap);
    expect(result).toEqual({
      kind: "model",
      backendId: "claude",
      modelId: "claude-opus-4-8",
      deprecated: false,
    });
  });

  it("resolves an opencode model through the explicit 'opencode/...' prefix", () => {
    const snap = snapshotModelRegistry();
    const result = validateModelToken(
      "opencode/anthropic/claude-opus-4-8",
      snap,
    );
    expect(result).toEqual({
      kind: "model",
      backendId: "opencode",
      modelId: "anthropic/claude-opus-4-8",
      deprecated: false,
    });
  });

  it("returns unknown when the named backend has no matching model", () => {
    const snap = snapshotModelRegistry();
    const result = validateModelToken("claude/does-not-exist", snap);
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") return;
    expect(result.validValues.aliases).toEqual(["sonnet", "opus"]);
    // The simplified payload excludes deprecated models so the LLM retry
    // can't immediately loop on a row the registry would have warned about.
    expect(result.validValues.models.claude).not.toContain("claude-opus-4-6");
    expect(result.validValues.models.claude).toContain("claude-opus-4-8");
  });

  it("treats a token whose part after the slash is empty as no composite match", () => {
    // `claude/` triggers the firstSlash branch but rest.length === 0, so
    // we fall through to the cross-backend scan. The scan finds nothing
    // and returns unknown. (The composite-form short-circuit must NOT
    // emit unknown here — it must defer to the scan.)
    const snap = snapshotModelRegistry();
    const result = validateModelToken("claude/", snap);
    expect(result.kind).toBe("unknown");
  });

  it("falls through when leading slash means firstSlash === 0", () => {
    const snap = snapshotModelRegistry();
    const result = validateModelToken("/claude-opus-4-7", snap);
    // firstSlash > 0 fails → composite branch skipped → cross-backend
    // scan looks for the literal "/claude-opus-4-7" → no match → unknown.
    expect(result.kind).toBe("unknown");
  });
});

describe("validateModelToken — ambiguous path", () => {
  it("returns kind:'ambiguous' when one id is registered under two backends", () => {
    // Build a synthetic snapshot where the same modelId appears under
    // claude AND codex. The live registry never collides today, but the
    // future-proof branch must still be exercised.
    const ambiguousSnap: ModelRegistrySnapshot = {
      modelAliases: { sonnet: "medium", opus: "high" },
      models: {
        claude: [{ id: "shared-id", tier: "high", deprecated: false }],
        codex: [{ id: "shared-id", tier: "medium", deprecated: false }],
        gemini: [],
        opencode: [],
      },
    };
    const result = validateModelToken("shared-id", ambiguousSnap);
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.matches).toEqual([
      { backendId: "claude", modelId: "shared-id" },
      { backendId: "codex", modelId: "shared-id" },
    ]);
    expect(result.validValues.matches).toEqual(result.matches);
    expect(result.validValues.hint).toContain("multiple backends");
    expect(result.validValues.hint).toContain("claude");
    expect(result.validValues.hint).toContain("codex");
    expect(result.validValues.hint).toContain("claude/shared-id");
  });
});

describe("validateModelToken — unknown path", () => {
  it("returns kind:'unknown' for a free-form typo", () => {
    const snap = snapshotModelRegistry();
    const result = validateModelToken("gpt-5.4-turbo", snap);
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") return;
    expect(result.validValues.aliases).toEqual(["sonnet", "opus"]);
    // Every backend gets a list, even if empty.
    expect(Object.keys(result.validValues.models).sort()).toEqual(
      ["claude", "codex", "gemini", "opencode"].sort(),
    );
    expect(result.validValues.models.codex).toContain("gpt-5.4");
  });

  it("returns kind:'unknown' for the empty string", () => {
    const snap = snapshotModelRegistry();
    const result = validateModelToken("", snap);
    expect(result.kind).toBe("unknown");
  });

  it("emits an unknown-shape payload that omits deprecated entries", () => {
    const snap = snapshotModelRegistry();
    const result = validateModelToken("definitely-not-a-model", snap);
    if (result.kind !== "unknown") throw new Error("expected unknown");
    // Live registry has 4 deprecated entries (claude-opus-4-6,
    // gemini-3-pro-preview, gemini-3-flash-preview, gemini-2.5-flash).
    const allIds = [
      ...result.validValues.models.claude,
      ...result.validValues.models.codex,
      ...result.validValues.models.gemini,
      ...result.validValues.models.opencode,
    ];
    expect(allIds).not.toContain("claude-opus-4-6");
    expect(allIds).not.toContain("gemini-3-pro-preview");
    expect(allIds).not.toContain("gemini-2.5-flash");
  });

  it("handles an empty snapshot without throwing", () => {
    // Defense-in-depth: the snapshot argument is caller-supplied, and a
    // future Phase D test harness might pass an empty registry to verify
    // route-level error envelopes. The helper must not throw on empty.
    const empty = makeEmptySnapshot();
    const result = validateModelToken("anything", empty);
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") return;
    expect(result.validValues.models.claude).toEqual([]);
  });
});
