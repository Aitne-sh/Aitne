import { describe, it, expect } from "vitest";
import type { IntegrationKey } from "@aitne/shared";
import type { IntegrationListItem } from "@/lib/api-types";
import { buildModeExplainer, modeShortLabel } from "./mode-explainer.logic";

const fakeDescriptor = (
  key: IntegrationKey,
  displayName: string,
): IntegrationListItem =>
  ({
    key,
    displayName,
    supportedModes: ["direct", "delegated", "disabled"],
    directSetup: { credentialKeys: [], helpUrl: "" },
    backendConnectors: {},
    userManagedConnector: false,
    state: {
      mode: "disabled",
      delegatedBackend: null,
      delegatedModel: null,
      deniedTools: [],
      subTier: null,
    },
  }) as unknown as IntegrationListItem;

describe("buildModeExplainer — Direct", () => {
  it("returns Direct copy that names the integration and mentions credential setup", () => {
    const copy = buildModeExplainer(
      "direct",
      fakeDescriptor("gmail", "Gmail"),
    );
    expect(copy.title).toBe("Direct");
    expect(copy.brief).toContain("Gmail");
    const joined = copy.details.join("\n");
    expect(joined).toMatch(/token/i);
    expect(joined).toMatch(/safety|destructive/i);
  });

  it("uses Google Cloud OAuth wording for gmail/google_calendar", () => {
    for (const key of ["gmail", "google_calendar"] as const) {
      const copy = buildModeExplainer("direct", fakeDescriptor(key, key));
      const joined = copy.details.join("\n");
      expect(joined).toMatch(/Google Cloud OAuth/);
      expect(joined).toMatch(/credentials JSON|browser consent/i);
    }
  });

  it("uses Notion-internal-integration wording for notion", () => {
    const copy = buildModeExplainer(
      "direct",
      fakeDescriptor("notion", "Notion"),
    );
    const joined = copy.details.join("\n");
    expect(joined).toMatch(/Notion internal-integration API key/);
    expect(joined).toMatch(/share each target database/i);
    // Must NOT inherit Google wording.
    expect(joined).not.toMatch(/Google Cloud OAuth/);
  });

  it("uses local-CLI wording for git/github (no daemon-managed credential)", () => {
    const gitCopy = buildModeExplainer(
      "direct",
      fakeDescriptor("git", "Git"),
    );
    const gitJoined = gitCopy.details.join("\n");
    expect(gitJoined).toMatch(/local git CLI/);
    expect(gitJoined).toMatch(/no credential is stored/i);
    expect(gitJoined).not.toMatch(/Google Cloud OAuth/);
    expect(gitJoined).not.toMatch(/Notion/);

    const ghCopy = buildModeExplainer(
      "direct",
      fakeDescriptor("github", "GitHub"),
    );
    const ghJoined = ghCopy.details.join("\n");
    expect(ghJoined).toMatch(/gh CLI/);
    expect(ghJoined).toMatch(/gh auth login/);
    expect(ghJoined).toMatch(/no credential is stored/i);
  });

  it("uses Microsoft Identity / BYOA wording for outlook_mail/outlook_calendar", () => {
    for (const key of ["outlook_mail", "outlook_calendar"] as const) {
      const copy = buildModeExplainer("direct", fakeDescriptor(key, key));
      const joined = copy.details.join("\n");
      expect(joined).toMatch(/Microsoft Identity/);
      expect(joined).toMatch(/BYOA|Azure/i);
      expect(joined).toMatch(/MSAL/);
    }
  });
});

describe("buildModeExplainer — Delegated", () => {
  const descriptor = fakeDescriptor("gmail", "Gmail");

  it("names CLIs and warns about per-call cost", () => {
    const copy = buildModeExplainer("delegated", descriptor);
    expect(copy.title).toBe("Delegated");
    const joined = copy.details.join("\n");
    expect(joined).toMatch(/Claude Code/);
    expect(joined).toMatch(/Codex/);
    expect(joined).toMatch(/Gemini/);
    expect(joined).toMatch(/per-call|token cost/i);
  });

  it("includes the concrete cross-backend flow sentence the user requested", () => {
    const copy = buildModeExplainer("delegated", descriptor);
    const joined = copy.details.join("\n");
    // The flow sentence: main agent → daemon API → CLI → service → daemon → main agent.
    expect(joined).toMatch(/main DM agent/i);
    expect(joined).toMatch(/this app's API/);
    expect(joined).toMatch(/invokes the chosen CLI/);
    expect(joined).toMatch(/back through the daemon/);
  });

  it("interpolates the descriptor displayName into the flow sentence", () => {
    const notionCopy = buildModeExplainer(
      "delegated",
      fakeDescriptor("notion", "Notion"),
    );
    const joined = notionCopy.details.join("\n");
    expect(joined).toMatch(/read Notion/);
    expect(joined).toMatch(/talk to Notion/);
  });
});

describe("buildModeExplainer — Disabled", () => {
  const descriptor = fakeDescriptor("gmail", "Gmail");

  it("explains no observers + clean reversibility", () => {
    const copy = buildModeExplainer("disabled", descriptor);
    expect(copy.title).toBe("Disabled");
    const joined = copy.details.join("\n");
    expect(joined).toMatch(/observers|awareness/i);
    expect(joined).toMatch(/one click|reversible|no data is destroyed/i);
  });

  it("captures the user's stated guidance: same-backend-already-has-it ⇒ pick disabled", () => {
    const copy = buildModeExplainer("disabled", descriptor);
    const joined = copy.details.join("\n");
    expect(joined).toMatch(/already has Gmail access/);
    expect(joined).toMatch(/cross-backend delegation/);
  });
});

describe("buildModeExplainer — interpolation", () => {
  it("interpolates the descriptor's displayName so non-Gmail integrations read naturally", () => {
    const notionCopy = buildModeExplainer(
      "disabled",
      fakeDescriptor("notion", "Notion"),
    );
    expect(notionCopy.brief).toContain("Notion");
    expect(notionCopy.brief).not.toContain("Gmail");
  });

  it("provides a footnote string for every mode (used as the recommendation line)", () => {
    const descriptor = fakeDescriptor("gmail", "Gmail");
    for (const mode of ["direct", "delegated", "disabled"] as const) {
      const copy = buildModeExplainer(mode, descriptor);
      expect(copy.footnote).toBeTruthy();
      expect(copy.footnote!.length).toBeGreaterThan(0);
    }
  });

  it("returns the full set of every IntegrationKey's direct copy without throwing (exhaustive switch)", () => {
    const keys: IntegrationKey[] = [
      "gmail",
      "google_calendar",
      "notion",
      "git",
      "github",
      "outlook_mail",
      "outlook_calendar",
    ];
    for (const key of keys) {
      const copy = buildModeExplainer("direct", fakeDescriptor(key, key));
      expect(copy.title).toBe("Direct");
      // The integration-aware sentence must always be present (exhaustiveness).
      expect(copy.details.length).toBeGreaterThanOrEqual(4);
    }
  });
});

describe("modeShortLabel", () => {
  it("renders the canonical English label per mode", () => {
    expect(modeShortLabel("direct")).toBe("Direct");
    expect(modeShortLabel("delegated")).toBe("Delegated");
    expect(modeShortLabel("disabled")).toBe("Disabled");
  });

  it("INTEGRATION_NATIVE_MODE_DESIGN.md §11.5 — covers native", () => {
    expect(modeShortLabel("native")).toBe("Native");
  });
});

// ── INTEGRATION_NATIVE_MODE_DESIGN.md §11.1 — native explainer copy ────────

describe("buildModeExplainer — Native", () => {
  const descriptor = fakeDescriptor("gmail", "Gmail");

  it("renders title that names the main backend so users can tell native rows apart", () => {
    const copy = buildModeExplainer("native", descriptor, "claude");
    expect(copy.title).toContain("Native");
    expect(copy.title).toContain("Claude");
  });

  it("falls back to a generic backend phrase when no main backend is provided", () => {
    const copy = buildModeExplainer("native", descriptor, null);
    // Should not crash and should not pretend a specific backend is bound.
    expect(copy.title).toContain("Native");
    expect(copy.brief).toContain("Gmail");
    expect(copy.brief.toLowerCase()).toContain("your main backend");
  });

  it("mentions the cost shift so users notice the medium-tier tradeoff", () => {
    const copy = buildModeExplainer("native", descriptor, "claude");
    const joined = copy.details.join("\n");
    expect(joined.toLowerCase()).toMatch(/token|cost|expensive/);
    expect(joined).toMatch(/medium/i);
  });

  it("warns that switching the main backend re-disables the row (§11.4)", () => {
    const copy = buildModeExplainer("native", descriptor, "claude");
    const joined = copy.details.join("\n");
    expect(joined.toLowerCase()).toMatch(/main backend/);
    expect(joined.toLowerCase()).toMatch(/disabled|re-configure/);
  });

  it("explains the agent-side connector requirement (auth lives in the backend)", () => {
    const copy = buildModeExplainer(
      "native",
      fakeDescriptor("google_calendar", "Google Calendar"),
      "claude",
    );
    const joined = copy.details.join("\n");
    expect(joined.toLowerCase()).toMatch(
      /connector configured|claude\.ai\/connections|extension/,
    );
    expect(joined.toLowerCase()).toMatch(
      /the daemon never sees|credentials/i,
    );
  });

  it("renders per-backend display name for each supported backend", () => {
    for (const backend of ["claude", "codex", "gemini"] as const) {
      const copy = buildModeExplainer("native", descriptor, backend);
      // Title casing: Claude / Codex / Gemini.
      const expected = backend.charAt(0).toUpperCase() + backend.slice(1);
      expect(copy.title).toContain(expected);
    }
  });
});
