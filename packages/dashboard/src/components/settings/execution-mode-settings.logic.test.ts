import { describe, it, expect } from "vitest";
import {
  deriveOverridesFromConfig,
  deriveTopFromConfig,
  seedStateFromConfig,
} from "./execution-mode-settings.logic";

describe("deriveTopFromConfig", () => {
  it("returns 'safe' when every backend is strict", () => {
    expect(
      deriveTopFromConfig({
        claudeExecutionPermissionMode: "strict",
        codexExecutionPermissionMode: "strict",
        geminiExecutionPermissionMode: "strict",
        opencodeExecutionPermissionMode: "strict",
      }),
    ).toBe("safe");
  });

  it("returns 'allow' when every backend is allow", () => {
    expect(
      deriveTopFromConfig({
        claudeExecutionPermissionMode: "allow",
        codexExecutionPermissionMode: "allow",
        geminiExecutionPermissionMode: "allow",
        opencodeExecutionPermissionMode: "allow",
      }),
    ).toBe("allow");
  });

  it("returns null for divergent persisted state", () => {
    // One backend toggled independently — the settings UI should surface
    // the mismatch rather than picking one side arbitrarily.
    expect(
      deriveTopFromConfig({
        claudeExecutionPermissionMode: "strict",
        codexExecutionPermissionMode: "allow",
        geminiExecutionPermissionMode: "strict",
        opencodeExecutionPermissionMode: "strict",
      }),
    ).toBeNull();
  });
});

describe("deriveOverridesFromConfig", () => {
  it("returns empty overrides when config is unified", () => {
    const result = deriveOverridesFromConfig({
      claudeExecutionPermissionMode: "strict",
      codexExecutionPermissionMode: "strict",
      geminiExecutionPermissionMode: "strict",
      opencodeExecutionPermissionMode: "strict",
    });
    expect(result).toEqual({
      claude: null,
      codex: null,
      gemini: null,
      opencode: null,
    });
  });

  it("surfaces every backend as an explicit override when divergent", () => {
    const result = deriveOverridesFromConfig({
      claudeExecutionPermissionMode: "strict",
      codexExecutionPermissionMode: "allow",
      geminiExecutionPermissionMode: "strict",
      opencodeExecutionPermissionMode: "strict",
    });
    expect(result).toEqual({
      claude: "safe",
      codex: "allow",
      gemini: "safe",
      opencode: "safe",
    });
  });
});

describe("seedStateFromConfig", () => {
  it("unified config: top set, overrides empty, accordion closed", () => {
    const seed = seedStateFromConfig({
      claudeExecutionPermissionMode: "allow",
      codexExecutionPermissionMode: "allow",
      geminiExecutionPermissionMode: "allow",
      opencodeExecutionPermissionMode: "allow",
    });
    expect(seed.topLevel).toBe("allow");
    expect(seed.overrides).toEqual({
      claude: null,
      codex: null,
      gemini: null,
      opencode: null,
    });
    expect(seed.forceAccordionOpen).toBe(false);
  });

  it("divergent config: top null, overrides populated, accordion force-open", () => {
    const seed = seedStateFromConfig({
      claudeExecutionPermissionMode: "strict",
      codexExecutionPermissionMode: "allow",
      geminiExecutionPermissionMode: "strict",
      opencodeExecutionPermissionMode: "strict",
    });
    expect(seed.topLevel).toBeNull();
    expect(seed.overrides).toEqual({
      claude: "safe",
      codex: "allow",
      gemini: "safe",
      opencode: "safe",
    });
    expect(seed.forceAccordionOpen).toBe(true);
  });
});
