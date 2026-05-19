import { describe, it, expect } from "vitest";
import {
  RECOMMENDED_BACKEND,
  isAllowModeActive,
  isContinueEligible,
  isRecommended,
  shouldEnableVerifyInstall,
  shouldShowCliInstall,
  shouldShowWizardConfigureLaterHint,
} from "./backend-card.logic";

describe("RECOMMENDED_BACKEND / isRecommended", () => {
  it("pins Claude as the product-level recommended backend", () => {
    // Regression guard: if product decides to change the recommendation
    // we want this test to flip intentionally, not by drift.
    expect(RECOMMENDED_BACKEND).toBe("claude");
    expect(isRecommended("claude")).toBe(true);
    expect(isRecommended("codex")).toBe(false);
    expect(isRecommended("gemini")).toBe(false);
  });
});

describe("shouldShowCliInstall", () => {
  it("returns true when CLI is not installed", () => {
    expect(shouldShowCliInstall(false)).toBe(true);
  });
  it("returns false when CLI is already installed", () => {
    // We hide the panel entirely — not just its done state — so the
    // card doesn't re-fetch install methods every mount.
    expect(shouldShowCliInstall(true)).toBe(false);
  });
});

describe("shouldEnableVerifyInstall", () => {
  it("enables when no card mutation is in flight, regardless of install state", () => {
    // The button is allowed even with the CLI absent — the server-side
    // handler returns a "not installed" diagnostic, which is more useful
    // than a greyed-out button with no feedback.
    expect(shouldEnableVerifyInstall(false)).toBe(true);
  });
  it("disables while another card mutation is in flight", () => {
    expect(shouldEnableVerifyInstall(true)).toBe(false);
  });
});

describe("shouldShowWizardConfigureLaterHint", () => {
  const base = {
    mode: "wizard" as const,
    isMain: false,
    cliInstalled: false,
  };

  it("shows on non-main wizard card when CLI is missing", () => {
    expect(shouldShowWizardConfigureLaterHint(base)).toBe(true);
  });

  it("hides on a non-main wizard card where the CLI is installed", () => {
    // Auth verify was removed from the setup flow — once the CLI is on
    // PATH, the card has nothing actionable left to nag about.
    expect(
      shouldShowWizardConfigureLaterHint({ ...base, cliInstalled: true }),
    ).toBe(false);
  });

  it("hides on the main card regardless of state", () => {
    // The main card blocks Continue via its own gating; the hint would
    // duplicate the gating message and confuse the user.
    expect(
      shouldShowWizardConfigureLaterHint({ ...base, isMain: true }),
    ).toBe(false);
  });

  it("hides in settings mode entirely", () => {
    expect(
      shouldShowWizardConfigureLaterHint({ ...base, mode: "settings" }),
    ).toBe(false);
  });
});

describe("isContinueEligible", () => {
  it("allows once a main backend is picked", () => {
    expect(isContinueEligible({ mainBackend: "claude" })).toBe(true);
    expect(isContinueEligible({ mainBackend: "codex" })).toBe(true);
    expect(isContinueEligible({ mainBackend: "gemini" })).toBe(true);
  });

  it("blocks only when main backend is null (no pick yet)", () => {
    // CLI install, auth verify, and API key registration are all
    // skippable in this wizard step — `mainBackend != null` is the
    // only hard gate.
    expect(isContinueEligible({ mainBackend: null })).toBe(false);
  });
});

describe("isAllowModeActive", () => {
  it("true only for the exact 'allow' sentinel", () => {
    expect(isAllowModeActive("allow")).toBe(true);
  });
  it("false for strict / undefined / null / unknown", () => {
    expect(isAllowModeActive("strict")).toBe(false);
    expect(isAllowModeActive(undefined)).toBe(false);
    expect(isAllowModeActive(null)).toBe(false);
    expect(isAllowModeActive("unexpected-new-mode")).toBe(false);
  });
});
