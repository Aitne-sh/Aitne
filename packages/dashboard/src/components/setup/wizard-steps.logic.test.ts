import { describe, it, expect } from "vitest";
import {
  BASE_INITIAL_STEPS,
  REQUIRED_STEPS,
  STEP_LABELS,
  deriveVaultMode,
  filterInitialSteps,
  isSkippable,
  type SetupStep,
} from "./wizard-steps.logic";

describe("deriveVaultMode", () => {
  it("prefers modeOverride when non-null — user's click wins", () => {
    // Even if config still says obsidian (because the migration hasn't
    // committed yet), the user's explicit "plain" selection must show.
    expect(deriveVaultMode("plain", "obsidian")).toBe("plain");
    expect(deriveVaultMode("obsidian", "plain")).toBe("obsidian");
  });

  it("mirrors config.vaultMode when no override", () => {
    // Re-entering the wizard after a prior setup (rules deleted but
    // config.vaultMode still obsidian) must show obsidian by default,
    // so the user is not silently downgraded.
    expect(deriveVaultMode(null, "obsidian")).toBe("obsidian");
    expect(deriveVaultMode(null, "plain")).toBe("plain");
  });

  it("defaults to plain when config is still loading (undefined / null)", () => {
    expect(deriveVaultMode(null, undefined)).toBe("plain");
    expect(deriveVaultMode(null, null)).toBe("plain");
  });
});

describe("BASE_INITIAL_STEPS ordering (SETUP-FLOW-REDESIGN-PLAN §4)", () => {
  it("declares the eight collection steps + complete in the documented order", () => {
    // Repositories are registered post-setup from Settings →
    // Connections → Repositories, so the wizard does not include them.
    expect([...BASE_INITIAL_STEPS]).toEqual([
      "basics",
      "vault",
      "backend",
      "mail",
      "calendar",
      "note",
      "messaging",
      "rules",
      "complete",
    ]);
  });

  it("does not reintroduce any of the legacy step ids", () => {
    // Regression guard — the redesign deletes welcome, mode, google-mode,
    // google, obsidian, notion-mode, notion, conversation, repositories.
    // None of them should re-appear in the list.
    const legacy = [
      "welcome",
      "mode",
      "google-mode",
      "google",
      "obsidian",
      "notion-mode",
      "notion",
      "conversation",
      "repositories",
    ];
    for (const id of legacy) {
      expect(BASE_INITIAL_STEPS).not.toContain(id as SetupStep);
    }
  });
});

describe("filterInitialSteps", () => {
  it("returns the base list as-is in v1 (no conditional sub-steps)", () => {
    expect(filterInitialSteps()).toEqual([...BASE_INITIAL_STEPS]);
  });

  it("returns a fresh array — caller can mutate without corrupting the base", () => {
    const result = filterInitialSteps();
    expect(result).not.toBe(BASE_INITIAL_STEPS);
  });

  it("respects a custom base list (for tests / special modes)", () => {
    const custom: readonly SetupStep[] = ["basics", "rules", "complete"];
    expect(filterInitialSteps(custom)).toEqual([
      "basics",
      "rules",
      "complete",
    ]);
  });
});

describe("REQUIRED_STEPS / isSkippable", () => {
  it("includes the four required collection steps + complete", () => {
    expect(REQUIRED_STEPS.has("basics")).toBe(true);
    expect(REQUIRED_STEPS.has("vault")).toBe(true);
    expect(REQUIRED_STEPS.has("backend")).toBe(true);
    expect(REQUIRED_STEPS.has("rules")).toBe(true);
    expect(REQUIRED_STEPS.has("complete")).toBe(true);
  });

  it("excludes the optional integration / messaging steps", () => {
    expect(REQUIRED_STEPS.has("mail")).toBe(false);
    expect(REQUIRED_STEPS.has("calendar")).toBe(false);
    expect(REQUIRED_STEPS.has("note")).toBe(false);
    expect(REQUIRED_STEPS.has("messaging")).toBe(false);
  });

  it("isSkippable agrees with REQUIRED_STEPS for every documented id", () => {
    for (const step of BASE_INITIAL_STEPS) {
      expect(isSkippable(step)).toBe(!REQUIRED_STEPS.has(step));
    }
  });
});

describe("STEP_LABELS", () => {
  it("provides a human-readable label for every step in BASE_INITIAL_STEPS", () => {
    for (const step of BASE_INITIAL_STEPS) {
      expect(STEP_LABELS[step]).toBeDefined();
      expect(STEP_LABELS[step].length).toBeGreaterThan(0);
    }
  });

  it("`complete` reads as `Done` for the terminal screen", () => {
    expect(STEP_LABELS.complete).toBe("Done");
  });
});
