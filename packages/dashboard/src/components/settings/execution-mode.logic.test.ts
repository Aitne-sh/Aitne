import { describe, it, expect } from "vitest";
import {
  EMPTY_OVERRIDES,
  buildSetupModePayload,
  canApply,
  hasDivergentOverride,
  internalToUi,
  resolveEffectiveMode,
  uiToInternal,
} from "./execution-mode.logic";

describe("uiToInternal / internalToUi", () => {
  it("round-trips safe ↔ strict and allow ↔ allow", () => {
    expect(uiToInternal("safe")).toBe("strict");
    expect(uiToInternal("allow")).toBe("allow");
    expect(internalToUi("strict")).toBe("safe");
    expect(internalToUi("allow")).toBe("allow");
  });
});

describe("buildSetupModePayload", () => {
  it("omits perBackend when all overrides follow the top-level pick", () => {
    // Default flow — user leaves the advanced accordion untouched. We
    // should not send an empty perBackend object (daemon would still
    // apply it as a no-op but it clutters the audit row).
    expect(buildSetupModePayload("safe", EMPTY_OVERRIDES)).toEqual({
      mode: "safe",
    });
    expect(buildSetupModePayload("allow", EMPTY_OVERRIDES)).toEqual({
      mode: "allow",
    });
  });

  it("omits overrides that match the top-level pick", () => {
    // Selecting the same mode in the accordion as the top-level is a no-op
    // — the daemon already has that value applied to the backend. Emit the
    // top-level pick only.
    expect(
      buildSetupModePayload("safe", {
        claude: "safe",
        codex: "safe",
        gemini: null,
      }),
    ).toEqual({ mode: "safe" });
  });

  it("emits only the divergent rows in perBackend", () => {
    expect(
      buildSetupModePayload("safe", {
        claude: null,
        codex: "allow",
        gemini: null,
      }),
    ).toEqual({
      mode: "safe",
      perBackend: { codex: "allow" },
    });
  });

  it("supports divergence in the opposite direction (top allow, one strict)", () => {
    expect(
      buildSetupModePayload("allow", {
        claude: "safe",
        codex: null,
        gemini: null,
      }),
    ).toEqual({
      mode: "allow",
      perBackend: { claude: "safe" },
    });
  });

  describe("null top-level (divergent-apply path)", () => {
    it("returns null when any override is still unset", () => {
      expect(
        buildSetupModePayload(null, { claude: "safe", codex: null, gemini: null }),
      ).toBeNull();
      expect(buildSetupModePayload(null, EMPTY_OVERRIDES)).toBeNull();
    });

    it("picks a synthetic top from the majority override when every backend is set", () => {
      // Two safe, one allow → synthetic top safe, emit the allow.
      expect(
        buildSetupModePayload(null, {
          claude: "safe",
          codex: "allow",
          gemini: "safe",
          opencode: "safe",
        }),
      ).toEqual({ mode: "safe", perBackend: { codex: "allow" } });

      // Two allow, one safe → synthetic top allow, emit the safe.
      expect(
        buildSetupModePayload(null, {
          claude: "allow",
          codex: "safe",
          gemini: "allow",
          opencode: "allow",
        }),
      ).toEqual({ mode: "allow", perBackend: { codex: "safe" } });
    });

    it("omits perBackend when every override agrees", () => {
      expect(
        buildSetupModePayload(null, {
          claude: "allow",
          codex: "allow",
          gemini: "allow",
          opencode: "allow",
        }),
      ).toEqual({ mode: "allow" });
    });
  });
});

describe("canApply", () => {
  it("false when top is null and overrides incomplete", () => {
    expect(canApply(null, EMPTY_OVERRIDES)).toBe(false);
    expect(
      canApply(null, { claude: "safe", codex: null, gemini: null }),
    ).toBe(false);
  });

  it("true when a top is picked", () => {
    expect(canApply("safe", EMPTY_OVERRIDES)).toBe(true);
    expect(canApply("allow", EMPTY_OVERRIDES)).toBe(true);
  });

  it("true when top is null but every override is set", () => {
    expect(
      canApply(null, {
        claude: "safe",
        codex: "allow",
        gemini: "safe",
        opencode: "safe",
      }),
    ).toBe(true);
  });
});

describe("resolveEffectiveMode", () => {
  it("returns the override when set", () => {
    expect(
      resolveEffectiveMode("claude", "safe", {
        claude: "allow",
        codex: null,
        gemini: null,
      }),
    ).toBe("allow");
  });

  it("falls back to top-level when override is null", () => {
    expect(resolveEffectiveMode("codex", "safe", EMPTY_OVERRIDES)).toBe("safe");
    expect(resolveEffectiveMode("codex", "allow", EMPTY_OVERRIDES)).toBe(
      "allow",
    );
  });
});

describe("hasDivergentOverride", () => {
  it("false when every override is null", () => {
    expect(hasDivergentOverride("safe", EMPTY_OVERRIDES)).toBe(false);
  });

  it("false when overrides equal the top-level pick", () => {
    expect(
      hasDivergentOverride("safe", {
        claude: "safe",
        codex: "safe",
        gemini: "safe",
      }),
    ).toBe(false);
  });

  it("true as soon as one row diverges", () => {
    expect(
      hasDivergentOverride("safe", {
        claude: null,
        codex: "allow",
        gemini: null,
      }),
    ).toBe(true);
  });
});
