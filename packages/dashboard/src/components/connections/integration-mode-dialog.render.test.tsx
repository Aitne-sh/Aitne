import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DialogBody } from "./integration-mode-dialog";
import type { IntegrationListItem } from "@/lib/api-types";

const gmail: IntegrationListItem = {
  key: "gmail",
  displayName: "Gmail",
  supportedModes: ["direct", "delegated", "disabled"],
  directSetup: { credentialKeys: [], helpUrl: "" },
  backendConnectors: {
    claude: {
      toolNamespace: "mcp__claude_ai_Gmail__",
      requiredCapabilities: ["search", "read", "draft", "label"],
      optionalCapabilities: ["draft", "label", "create_label"],
      capabilityTools: {},
    },
    codex: {
      toolNamespace: "mcp__codex_apps__gmail._",
      requiredCapabilities: ["search", "read", "draft", "label", "send"],
      optionalCapabilities: ["send", "forward", "delete", "read_attachment"],
      capabilityTools: {},
    },
  },
  skillsTouched: ["mail"],
  taskFlowsTouched: ["routine.morning_routine"],
  observersTouched: [],
  apiRoutesTouched: [],
  state: { mode: "disabled", lastChangedAt: "2026-04-20T00:00:00Z" },
};

const calendar: IntegrationListItem = {
  ...gmail,
  key: "google_calendar",
  displayName: "Google Calendar",
};

/**
 * Render smoke tests for every `ModeSwitchAction` branch — catches "dialog
 * blew up on this transition" regressions that neither the logic tests nor
 * tsc can surface. One test per kind.
 */
describe("DialogBody — render smoke tests", () => {
  it("renders direct-to-delegated body with feature-loss list", () => {
    const html = renderToStaticMarkup(
      <DialogBody
        action={{ kind: "direct-to-delegated", toBackend: "claude" }}
        descriptor={gmail}
        gmailAccountCount={1}
      />,
    );
    expect(html).toContain("lose these direct-mode features");
    expect(html).toContain("Mail poller");
    expect(html).toContain("Send is unavailable");
  });

  it("shows multi-account warning when count > 1", () => {
    const html = renderToStaticMarkup(
      <DialogBody
        action={{ kind: "direct-to-delegated", toBackend: "claude" }}
        descriptor={gmail}
        gmailAccountCount={3}
      />,
    );
    expect(html).toContain("2 Gmail accounts will be disabled");
  });

  it("suppresses multi-account warning for single account", () => {
    // The generic Gmail warning about "Additional accounts will be disabled"
    // is part of the base losses (single-account cap is a feature of
    // delegated mode itself). The per-count warning "N accounts will be
    // disabled" should NOT appear when only one account is configured.
    const html = renderToStaticMarkup(
      <DialogBody
        action={{ kind: "direct-to-delegated", toBackend: "codex" }}
        descriptor={gmail}
        gmailAccountCount={1}
      />,
    );
    expect(html).not.toMatch(/\d+ Gmail accounts? will be disabled/);
  });

  it("renders delegated-to-direct body with keychain copy when tokens present", () => {
    const html = renderToStaticMarkup(
      <DialogBody
        action={{ kind: "delegated-to-direct", needsOauthSetup: false }}
        descriptor={gmail}
        gmailAccountCount={0}
      />,
    );
    expect(html).toContain("keychain");
    expect(html).toContain("no re-consent");
  });

  it("renders delegated-to-direct body pointing to setup when no tokens", () => {
    const html = renderToStaticMarkup(
      <DialogBody
        action={{ kind: "delegated-to-direct", needsOauthSetup: true }}
        descriptor={calendar}
        gmailAccountCount={0}
      />,
    );
    expect(html).toContain("Google Cloud setup");
  });

  it("renders delegated-backend-change body with the target backend name", () => {
    const html = renderToStaticMarkup(
      <DialogBody
        action={{ kind: "delegated-backend-change", toBackend: "codex" }}
        descriptor={gmail}
        gmailAccountCount={0}
      />,
    );
    expect(html).toContain("codex");
    expect(html).toContain("re-materialize");
  });

  it("renders enable-from-disabled delegated body", () => {
    const html = renderToStaticMarkup(
      <DialogBody
        action={{ kind: "enable-from-disabled", to: "delegated", toBackend: "claude" }}
        descriptor={gmail}
        gmailAccountCount={0}
      />,
    );
    expect(html).toContain("delegate to the claude backend");
  });

  it("renders enable-from-disabled direct body", () => {
    const html = renderToStaticMarkup(
      <DialogBody
        action={{ kind: "enable-from-disabled", to: "direct" }}
        descriptor={calendar}
        gmailAccountCount={0}
      />,
    );
    expect(html).toContain("poll the service directly");
  });

  it("renders disable-from-active body", () => {
    const html = renderToStaticMarkup(
      <DialogBody
        action={{ kind: "disable-from-active" }}
        descriptor={gmail}
        gmailAccountCount={0}
      />,
    );
    expect(html).toContain("stops observing");
    expect(html).toContain("credentials stay");
  });

  // §7.2 — deniedTools-inactive alert on delegated → direct.
  // Verbatim US-English copy is part of the §13 resolution; CI fails on
  // prose drift here just as it does for the other branches above.
  const DENIED_TOOLS_ALERT_PROSE =
    "Your tool deny list will be retained but is inactive in direct mode. Re-enabling delegated mode restores it.";

  it("§7.2 — surfaces deniedTools-inactive alert on delegated → direct when the deny list is non-empty", () => {
    const html = renderToStaticMarkup(
      <DialogBody
        action={{ kind: "delegated-to-direct", needsOauthSetup: false }}
        descriptor={{
          ...gmail,
          state: {
            ...gmail.state,
            deniedTools: ["send_email"],
          },
        }}
        gmailAccountCount={1}
      />,
    );
    expect(html).toContain(DENIED_TOOLS_ALERT_PROSE);
  });

  it("§7.2 — omits the deniedTools alert when the deny list is empty", () => {
    const html = renderToStaticMarkup(
      <DialogBody
        action={{ kind: "delegated-to-direct", needsOauthSetup: false }}
        descriptor={{
          ...gmail,
          state: {
            ...gmail.state,
            deniedTools: [],
          },
        }}
        gmailAccountCount={1}
      />,
    );
    expect(html).not.toContain(DENIED_TOOLS_ALERT_PROSE);
  });

  it("§7.2 — omits the deniedTools alert when the deniedTools field is undefined", () => {
    // Guards the `?? 0` fallback in the JSX trigger — without it, an
    // undefined `state.deniedTools` would NPE on `.length` for an
    // integration whose state has never recorded a deny list.
    const stateWithoutDenied: typeof gmail.state = { ...gmail.state };
    delete (stateWithoutDenied as { deniedTools?: string[] }).deniedTools;
    const html = renderToStaticMarkup(
      <DialogBody
        action={{ kind: "delegated-to-direct", needsOauthSetup: false }}
        descriptor={{
          ...gmail,
          state: stateWithoutDenied,
        }}
        gmailAccountCount={1}
      />,
    );
    expect(html).not.toContain(DENIED_TOOLS_ALERT_PROSE);
  });

  // ── INTEGRATION_NATIVE_MODE_DESIGN.md §11 — native transitions ─────────
  // Phase C ships four new ModeSwitchAction branches that the dialog must
  // render. The logic tests in `.logic.test.ts` cover the message strings;
  // these smoke tests catch JSX-level regressions (missing branch, wrong
  // chip colour class, accidental crash when descriptor lacks a field).

  it("renders to-native body from direct source — cost chip + impacts + connector note", () => {
    const html = renderToStaticMarkup(
      <DialogBody
        action={{ kind: "to-native", fromMode: "direct", toBackend: "claude" }}
        descriptor={gmail}
        gmailAccountCount={1}
      />,
    );
    // §11.5 — native mode intro line names the target backend.
    expect(html).toContain("claude");
    expect(html).toContain("Native mode");
    // §11.6 / §14.4 — cost-delta chip rendered with daily figures.
    expect(html).toContain("Estimated cost shift");
    expect(html).toContain("$0.39/day");
    // §11.3 — direct-source impact list calls out poller stop + dormant tokens.
    expect(html).toContain("poller");
    expect(html).toMatch(/credentials.+keychain/);
    // Connector-must-be-configured note is non-reversible (red dot — class
    // marker bg-destructive lives in the JSX literal).
    expect(html).toContain("connector configured");
    expect(html).toContain("bg-destructive");
  });

  it("renders to-native body from delegated source — different impact set + multiplier chip", () => {
    const html = renderToStaticMarkup(
      <DialogBody
        action={{ kind: "to-native", fromMode: "delegated", toBackend: "claude" }}
        descriptor={gmail}
        gmailAccountCount={0}
      />,
    );
    // Delegated-source must call out worker stop + the ~25–30× multiplier.
    expect(html).toContain("delegated-sync worker");
    expect(html).toMatch(/20–30×|more expensive/);
    // Cost chip shows multiplier when source > 0 (delegated → native).
    expect(html).toMatch(/×\s*<\/strong>\s*more per integration/);
    // Multi-account warning only fires when fromMode === "direct" — must
    // be absent for delegated → native even if the count is high.
  });

  it("renders to-native body from disabled source — re-enable copy, no multiplier", () => {
    const html = renderToStaticMarkup(
      <DialogBody
        action={{ kind: "to-native", fromMode: "disabled", toBackend: "codex" }}
        descriptor={gmail}
        gmailAccountCount={0}
      />,
    );
    // Disabled-source frames the flip as "becomes reachable again".
    expect(html).toMatch(/reachable|silent/);
    // No multiplier line when source pays nothing (fromDailyUsd === 0).
    expect(html).not.toMatch(/×\s*<\/strong>\s*more per integration/);
  });

  it("renders to-native body — multi-account warning fires only for direct source", () => {
    // Same descriptor + count, swap fromMode. Only direct surfaces the
    // §4.12.4 multi-account warning, because delegated/disabled never
    // had multiple direct accounts attached.
    const direct = renderToStaticMarkup(
      <DialogBody
        action={{ kind: "to-native", fromMode: "direct", toBackend: "claude" }}
        descriptor={gmail}
        gmailAccountCount={3}
      />,
    );
    expect(direct).toContain("2 Gmail accounts will be disabled");

    const delegated = renderToStaticMarkup(
      <DialogBody
        action={{ kind: "to-native", fromMode: "delegated", toBackend: "claude" }}
        descriptor={gmail}
        gmailAccountCount={3}
      />,
    );
    expect(delegated).not.toMatch(/\d+ Gmail accounts? will be disabled/);
  });

  it("renders native-to-direct body with keychain copy when tokens present", () => {
    const html = renderToStaticMarkup(
      <DialogBody
        action={{ kind: "native-to-direct", needsOauthSetup: false }}
        descriptor={gmail}
        gmailAccountCount={0}
      />,
    );
    expect(html).toContain("keychain");
    expect(html).toMatch(/re-enables polling/);
  });

  it("renders native-to-direct body pointing to setup when no tokens", () => {
    const html = renderToStaticMarkup(
      <DialogBody
        action={{ kind: "native-to-direct", needsOauthSetup: true }}
        descriptor={calendar}
        gmailAccountCount={0}
      />,
    );
    // §11.3 — native left auth in the backend, so a flip back to direct
    // walks through the integration's setup phrase.
    expect(html).toContain("native mode left credential management");
    expect(html).toContain("Google Cloud setup");
  });

  it("renders native-to-delegated body naming the target backend + worker resume", () => {
    const html = renderToStaticMarkup(
      <DialogBody
        action={{ kind: "native-to-delegated", toBackend: "gemini" }}
        descriptor={gmail}
        gmailAccountCount={0}
      />,
    );
    expect(html).toContain("gemini");
    expect(html).toContain("delegated-sync worker");
  });

  it("renders native-to-disabled body with reversibility copy", () => {
    const html = renderToStaticMarkup(
      <DialogBody
        action={{ kind: "native-to-disabled" }}
        descriptor={gmail}
        gmailAccountCount={0}
      />,
    );
    expect(html).toContain("loses awareness");
    expect(html).toMatch(/no data is destroyed/);
  });
});
