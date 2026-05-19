import { describe, it, expect } from "vitest";
import type { IntegrationListItem } from "@/lib/api-types";
import {
  delegatedToDirectResumeMessage,
  directToDelegatedLosses,
  formatDailyUsd,
  multiAccountWarning,
  nativeCostDelta,
  nativeToDirectResumeMessage,
  purgeCopyForIntegration,
  toNativeImpacts,
} from "./integration-mode-dialog.logic";

const gmailClaude: IntegrationListItem = {
  key: "gmail",
  displayName: "Gmail",
  supportedModes: ["direct", "delegated", "disabled"],
  directSetup: { credentialKeys: [], helpUrl: "" },
  backendConnectors: {
    claude: {
      toolNamespace: "x",
      // Claude connector — draft-only (no send/forward/delete/read_attachment).
      requiredCapabilities: ["search", "read", "draft", "label"],
      optionalCapabilities: ["draft", "label", "create_label"],
      capabilityTools: {},
    },
    codex: {
      toolNamespace: "y",
      requiredCapabilities: ["search", "read", "draft", "label", "send"],
      optionalCapabilities: [
        "draft",
        "label",
        "create_label",
        "update_draft",
        "send",
        "forward",
        "delete",
        "read_attachment",
        "batch",
      ],
      capabilityTools: {},
    },
  },
  skillsTouched: ["mail"],
  taskFlowsTouched: ["routine.morning_routine"],
  observersTouched: [],
  apiRoutesTouched: [],
  state: { mode: "disabled", lastChangedAt: "2026-04-20T00:00:00Z" },
};

const calendarClaude: IntegrationListItem = {
  ...gmailClaude,
  key: "google_calendar",
  displayName: "Google Calendar",
  backendConnectors: {
    claude: {
      toolNamespace: "x",
      requiredCapabilities: ["list_events", "get_event", "create_event"],
      optionalCapabilities: [
        "list_events",
        "get_event",
        "create_event",
        "update_event",
        "delete_event",
      ],
      capabilityTools: {},
    },
  },
};

describe("directToDelegatedLosses — gmail", () => {
  it("always warns about poller + FTS5 + single-account for gmail", () => {
    const losses = directToDelegatedLosses("gmail", "claude", gmailClaude);
    const messages = losses.map((l) => l.message);
    expect(messages.some((m) => /Mail poller/.test(m))).toBe(true);
    expect(messages.some((m) => /FTS5/.test(m))).toBe(true);
    expect(messages.some((m) => /one Google account/.test(m))).toBe(true);
  });

  it("warns about Claude draft-only gaps (send/forward/delete/attachment)", () => {
    const losses = directToDelegatedLosses("gmail", "claude", gmailClaude);
    const messages = losses.map((l) => l.message);
    expect(messages.some((m) => /Send is unavailable/.test(m))).toBe(true);
    expect(messages.some((m) => /Forward is unavailable/.test(m))).toBe(true);
    expect(messages.some((m) => /Archive \/ delete is unavailable/.test(m))).toBe(true);
    expect(messages.some((m) => /Read attachments is unavailable/.test(m))).toBe(true);
  });

  it("does NOT warn about the Claude gap when backend is Codex (full-auto)", () => {
    const losses = directToDelegatedLosses("gmail", "codex", gmailClaude);
    const messages = losses.map((l) => l.message);
    expect(messages.some((m) => /Send is unavailable/.test(m))).toBe(false);
    expect(messages.some((m) => /Read attachments is unavailable/.test(m))).toBe(false);
  });

  it("marks every loss reversible (tokens kept dormant by default)", () => {
    const losses = directToDelegatedLosses("gmail", "claude", gmailClaude);
    expect(losses.every((l) => l.reversible)).toBe(true);
  });
});

describe("directToDelegatedLosses — google_calendar", () => {
  it("warns about poller-cadence drop + 15-min alerts", () => {
    const losses = directToDelegatedLosses(
      "google_calendar",
      "claude",
      calendarClaude,
    );
    const messages = losses.map((l) => l.message);
    expect(messages.some((m) => /hourly granularity/.test(m))).toBe(true);
    expect(messages.some((m) => /15-minute/.test(m))).toBe(true);
  });

  it("does not emit Gmail losses for calendar", () => {
    const losses = directToDelegatedLosses(
      "google_calendar",
      "claude",
      calendarClaude,
    );
    const messages = losses.map((l) => l.message);
    expect(messages.some((m) => /FTS5/.test(m))).toBe(false);
    expect(messages.some((m) => /Send/.test(m))).toBe(false);
  });
});

describe("multiAccountWarning", () => {
  it("returns null for zero or one account", () => {
    expect(multiAccountWarning("gmail", 0)).toBeNull();
    expect(multiAccountWarning("gmail", 1)).toBeNull();
  });

  it("returns a warning string for multiple accounts", () => {
    const msg = multiAccountWarning("gmail", 3);
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/2 Gmail accounts will be disabled/);
  });

  it("uses singular when exactly one account will be dropped", () => {
    const msg = multiAccountWarning("gmail", 2);
    expect(msg).toMatch(/1 Gmail account will be disabled/);
  });

  it("returns null for non-gmail integrations", () => {
    expect(multiAccountWarning("google_calendar", 5)).toBeNull();
  });
});

describe("delegatedToDirectResumeMessage", () => {
  it("says tokens present → no re-consent", () => {
    const msg = delegatedToDirectResumeMessage("gmail", true);
    expect(msg).toMatch(/keychain/);
    expect(msg).toMatch(/no re-consent/);
  });

  it("says no tokens → walk through GCP setup", () => {
    const msg = delegatedToDirectResumeMessage("google_calendar", false);
    expect(msg).toMatch(/Google Cloud setup/);
  });

  it("names the integration", () => {
    expect(delegatedToDirectResumeMessage("gmail", true)).toMatch(/Gmail/);
    expect(delegatedToDirectResumeMessage("google_calendar", false)).toMatch(
      /Google Calendar/,
    );
  });

  it("uses Notion-shaped wording for the notion key (not Google copy)", () => {
    // Pre-fix bug: any non-gmail key fell through to "Google Calendar"
    // and "5-step Google Cloud setup", which is wrong for Notion.
    const present = delegatedToDirectResumeMessage("notion", true);
    expect(present).toMatch(/Notion/);
    expect(present).not.toMatch(/Google Calendar/);
    expect(present).toMatch(/API key/);

    const absent = delegatedToDirectResumeMessage("notion", false);
    expect(absent).toMatch(/Notion/);
    expect(absent).not.toMatch(/Google Cloud setup/);
    expect(absent).toMatch(/internal integration/);
  });
});

// ── Notion fixture for purge / loss tests ──

const notionClaude: IntegrationListItem = {
  key: "notion",
  displayName: "Notion",
  supportedModes: ["direct", "delegated", "disabled"],
  directSetup: { credentialKeys: ["notionApiKey"], helpUrl: "x" },
  backendConnectors: {
    claude: {
      toolNamespace: "mcp__claude_ai_Notion__",
      requiredCapabilities: [
        "search",
        "read",
        "create_page",
        "update_properties",
        "patch_content",
        "archive",
      ],
      optionalCapabilities: [
        "search",
        "read",
        "create_page",
        "update_properties",
        "patch_content",
        "replace_content",
        "archive",
        "comments",
      ],
      capabilityTools: {},
    },
  },
  skillsTouched: ["notion"],
  taskFlowsTouched: ["routine.hourly_check"],
  observersTouched: ["notion-poller"],
  apiRoutesTouched: ["/api/notion/query", "/api/notion/search", "/api/notion/pages"],
  state: { mode: "disabled", lastChangedAt: "2026-04-25T00:00:00Z" },
};

describe("directToDelegatedLosses — notion", () => {
  // Pre-fix bug: notion fell through every branch and returned []. The
  // dialog header said "You will lose these direct-mode features" with no
  // bullets — confusing UI plus a real omission of structured-filter and
  // archive-workaround caveats.
  it("warns about NotionPoller stop, structured-filter loss, and archive workaround", () => {
    const losses = directToDelegatedLosses("notion", "claude", notionClaude);
    expect(losses.length).toBeGreaterThan(0);
    const messages = losses.map((l) => l.message);
    expect(messages.some((m) => /Notion poller/.test(m))).toBe(true);
    expect(messages.some((m) => /Structured property filter/.test(m))).toBe(
      true,
    );
    expect(messages.some((m) => /Native page archive/.test(m))).toBe(true);
  });

  it("phrases the page-archive loss as 'no native trash op' (workarounds exist)", () => {
    // Skill body documents status-property update and move-to-trash-page
    // workarounds — the loss is reduced, not absolute.
    const messages = directToDelegatedLosses(
      "notion",
      "claude",
      notionClaude,
    ).map((l) => l.message);
    const archiveMsg = messages.find((m) => /archive/.test(m));
    expect(archiveMsg).toBeDefined();
    expect(archiveMsg).toMatch(/workarounds?/);
  });

  it("does not emit Gmail/Calendar losses for notion", () => {
    const messages = directToDelegatedLosses(
      "notion",
      "claude",
      notionClaude,
    ).map((l) => l.message);
    expect(messages.some((m) => /FTS5/.test(m))).toBe(false);
    expect(messages.some((m) => /15-minute/.test(m))).toBe(false);
  });

  it("marks every notion loss reversible", () => {
    const losses = directToDelegatedLosses("notion", "claude", notionClaude);
    expect(losses.every((l) => l.reversible)).toBe(true);
  });
});

describe("purgeCopyForIntegration", () => {
  // The data-loss bug this guards: pre-fix, IntegrationCard.applySwitch
  // unconditionally deleted googleCredentialsJson + googleTokenJson on
  // Purge regardless of which integration was being flipped. Driving the
  // secret-key list off `descriptor.directSetup.credentialKeys` makes
  // Notion purge hit notionApiKey instead.
  it("uses descriptor.directSetup.credentialKeys verbatim as the secret-store keys to delete", () => {
    const copy = purgeCopyForIntegration(notionClaude);
    expect(copy).not.toBeNull();
    expect(copy!.secretKeys).toEqual(["notionApiKey"]);
  });

  it("names the integration in the confirm title (no generic 'OAuth credentials' wording)", () => {
    const copy = purgeCopyForIntegration(notionClaude);
    expect(copy!.confirmTitle).toMatch(/Notion/);
    expect(copy!.confirmTitle).not.toMatch(/OAuth/);
  });

  it("references the actual secret-store key in the confirm description", () => {
    const copy = purgeCopyForIntegration(notionClaude);
    expect(copy!.confirmDescription).toMatch(/notionApiKey/);
    // Pre-fix wording leaked Google's secret names — guard against that
    // regressing if someone hardcodes again.
    expect(copy!.confirmDescription).not.toMatch(/googleCredentialsJson/);
    expect(copy!.confirmDescription).not.toMatch(/googleTokenJson/);
  });

  it("uses the Notion-shaped setup phrase, not the Google one", () => {
    const copy = purgeCopyForIntegration(notionClaude);
    expect(copy!.confirmDescription).not.toMatch(/Google Cloud setup/);
    expect(copy!.optionDescription).not.toMatch(/Google Cloud setup/);
    expect(copy!.optionDescription).toMatch(/internal integration/);
  });

  it("returns null when the descriptor has no directSetup (delegated-only)", () => {
    const delegatedOnly: IntegrationListItem = {
      ...notionClaude,
      directSetup: null,
    };
    expect(purgeCopyForIntegration(delegatedOnly)).toBeNull();
  });

  it("returns null when credentialKeys is empty", () => {
    const empty: IntegrationListItem = {
      ...notionClaude,
      directSetup: { credentialKeys: [], helpUrl: "x" },
    };
    expect(purgeCopyForIntegration(empty)).toBeNull();
  });

  it("Google entry joins both secret keys in display + delete list", () => {
    // The Gmail fixture at the top of this file passes empty credentialKeys
    // for brevity in the loss-message tests; here we assert the production
    // Google shape (two keys) flows verbatim into the secret-list join.
    const gmailWithBothKeys: IntegrationListItem = {
      ...gmailClaude,
      directSetup: {
        credentialKeys: ["googleCredentialsJson", "googleTokenJson"],
        helpUrl: "x",
      },
    };
    const copy = purgeCopyForIntegration(gmailWithBothKeys);
    expect(copy).not.toBeNull();
    expect(copy!.secretKeys).toEqual([
      "googleCredentialsJson",
      "googleTokenJson",
    ]);
    for (const k of copy!.secretKeys) {
      expect(copy!.confirmDescription).toContain(k);
    }
  });
});

// ── INTEGRATION_NATIVE_MODE_DESIGN.md §11.3 / §11.6 — native flip ──────────

describe("toNativeImpacts", () => {
  it("warns about poller / classifier shutdown when source is direct", () => {
    const impacts = toNativeImpacts("direct", gmailClaude, "claude");
    const messages = impacts.map((i) => i.message);
    expect(messages.some((m) => /poller/.test(m))).toBe(true);
    expect(messages.some((m) => /FTS5|classifier/.test(m))).toBe(true);
  });

  it("warns that direct-mode credentials stay dormant in the keychain on direct → native (§11.3)", () => {
    // The dialog hides the direct→delegated TokenHandlingPicker for native
    // flips, so without this line users don't learn their OAuth tokens
    // remain in the keychain. Surfaced as a reversible impact because the
    // flip back to direct re-uses the dormant tokens without re-consent.
    const impacts = toNativeImpacts("direct", gmailClaude, "claude");
    const messages = impacts.map((i) => i.message);
    expect(
      messages.some((m) => /direct-mode credentials.+stay in the keychain/.test(m)),
    ).toBe(true);
    // The note must NOT appear for non-direct sources — delegated/disabled
    // paths have no daemon-owned credentials to mention.
    for (const from of ["delegated", "disabled"] as const) {
      const others = toNativeImpacts(from, gmailClaude, "claude").map(
        (i) => i.message,
      );
      expect(
        others.some((m) => /direct-mode credentials/.test(m)),
      ).toBe(false);
    }
  });

  it("warns about delegated-worker stop + cost shift when source is delegated", () => {
    const impacts = toNativeImpacts("delegated", gmailClaude, "claude");
    const messages = impacts.map((i) => i.message);
    expect(messages.some((m) => /delegated-sync worker/.test(m))).toBe(true);
    expect(messages.some((m) => /20–30×|more expensive/.test(m))).toBe(true);
  });

  it("explains the re-enable when source is disabled (silent → in-turn fetch)", () => {
    const impacts = toNativeImpacts("disabled", gmailClaude, "claude");
    const messages = impacts.map((i) => i.message);
    expect(messages.some((m) => /reachable|silent/.test(m))).toBe(true);
  });

  it("always documents the connector-must-be-configured requirement (non-reversible)", () => {
    for (const from of ["direct", "delegated", "disabled"] as const) {
      const impacts = toNativeImpacts(from, gmailClaude, "claude");
      const connectorNote = impacts.find((i) =>
        /connector configured/i.test(i.message),
      );
      expect(connectorNote).toBeDefined();
      expect(connectorNote!.reversible).toBe(false);
    }
  });

  it("always documents the main-backend-switch behaviour (§11.4 cascade)", () => {
    for (const from of ["direct", "delegated", "disabled"] as const) {
      const impacts = toNativeImpacts(from, gmailClaude, "claude");
      const cascadeNote = impacts.find((i) =>
        /main backend later/.test(i.message),
      );
      expect(cascadeNote).toBeDefined();
    }
  });

  it("interpolates the target backend into the connector-requirement message", () => {
    const impacts = toNativeImpacts("disabled", gmailClaude, "gemini");
    expect(impacts.some((i) => /gemini/.test(i.message))).toBe(true);
  });
});

describe("nativeCostDelta", () => {
  it("delegated source carries the ~25-30× multiplier per §14.4", () => {
    const delta = nativeCostDelta("delegated");
    expect(delta.fromDailyUsd).toBeCloseTo(0.014, 4);
    expect(delta.toDailyUsd).toBeCloseTo(0.39, 2);
    expect(delta.multiplier).toBeGreaterThanOrEqual(20);
    expect(delta.multiplier).toBeLessThanOrEqual(35);
    expect(delta.fromLabel).toMatch(/delegated worker/);
  });

  it("direct source pays no LLM tokens for the fetch (multiplier is null)", () => {
    const delta = nativeCostDelta("direct");
    expect(delta.fromDailyUsd).toBe(0);
    expect(delta.multiplier).toBeNull();
    expect(delta.fromLabel).toMatch(/no LLM tokens/);
  });

  it("disabled source carries the full per-day native cost", () => {
    const delta = nativeCostDelta("disabled");
    expect(delta.fromDailyUsd).toBe(0);
    expect(delta.toDailyUsd).toBeCloseTo(0.39, 2);
    expect(delta.multiplier).toBeNull();
    expect(delta.fromLabel).toMatch(/disabled/);
  });

  it("yearlyDeltaUsd is non-negative and reflects the daily shift", () => {
    const delegatedDelta = nativeCostDelta("delegated");
    expect(delegatedDelta.yearlyDeltaUsd).toBeGreaterThan(0);
    // Sanity: yearly should be roughly 365 × daily delta.
    const expected = Math.round(
      (delegatedDelta.toDailyUsd - delegatedDelta.fromDailyUsd) * 365,
    );
    expect(delegatedDelta.yearlyDeltaUsd).toBe(expected);
  });
});

describe("formatDailyUsd", () => {
  it("renders $0 exactly for zero", () => {
    expect(formatDailyUsd(0)).toBe("$0");
  });
  it("renders the floor sentinel for tiny positive values", () => {
    expect(formatDailyUsd(0.001)).toBe("<$0.01");
  });
  it("renders 2-decimal values for >= $0.01", () => {
    expect(formatDailyUsd(0.39)).toBe("$0.39");
    expect(formatDailyUsd(1.5)).toBe("$1.50");
  });
});

describe("nativeToDirectResumeMessage", () => {
  it("present-credentials phrasing uses the keychain language", () => {
    const msg = nativeToDirectResumeMessage("gmail", true);
    expect(msg).toMatch(/keychain/);
    expect(msg).toMatch(/re-enables polling/);
  });

  it("absent-credentials phrasing explains why native left the keychain empty", () => {
    const msg = nativeToDirectResumeMessage("gmail", false);
    expect(msg).toMatch(/native mode left credential management to the backend/);
    expect(msg).toMatch(/Google Cloud setup/);
  });

  it("names the integration", () => {
    expect(nativeToDirectResumeMessage("notion", false)).toMatch(/Notion/);
    expect(nativeToDirectResumeMessage("google_calendar", true)).toMatch(
      /Google Calendar/,
    );
  });
});
