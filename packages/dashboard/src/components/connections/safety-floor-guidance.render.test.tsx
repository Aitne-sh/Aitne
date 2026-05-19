import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SafetyFloorGuidance } from "./safety-floor-guidance";

/**
 * DELEGATED-MODE-V2-DESIGN.md §7.1 — verbatim US-English contract
 * (Decision Log #11). Snapshot drift would silently weaken the
 * "destructive ops require user confirmation" CLAUDE.md invariant the
 * starter floor underpins. These tests assert the load-bearing tokens
 * (tool names, the verdict labels, the why-defaults justification)
 * appear after render, without snapshotting the entire markup —
 * Tailwind class churn is unrelated to copy fidelity.
 */
describe("SafetyFloorGuidance — §7.1 literal-copy contract", () => {
  it("renders Gmail × Codex starter entries with correct verdicts", () => {
    const html = renderToStaticMarkup(
      <SafetyFloorGuidance integrationKey="gmail" delegatedBackend="codex" />,
    );
    expect(html).toContain("Your destructive-action floor");
    expect(html).toContain("Gmail (delegated to Codex)");
    expect(html).toContain("send_email");
    expect(html).toContain("delete_emails");
    expect(html).toContain("archive_emails");
    expect(html).toContain("apply_labels_to_emails");
    expect(html).toContain("strictly destructive");
    expect(html).toContain("destructive ops require user confirmation");
  });

  it("renders Gmail × Claude as draft-only with label-only mutating ops", () => {
    const html = renderToStaticMarkup(
      <SafetyFloorGuidance integrationKey="gmail" delegatedBackend="claude" />,
    );
    expect(html).toContain("Gmail (delegated to Claude)");
    expect(html).toContain("draft-only");
    expect(html).toContain("label_message");
    expect(html).toContain("label_thread");
    // Per-block heading + the bullet list above the trailing "Why these
    // defaults?" footer must contain the Claude entries; the footer
    // legitimately references `send_email` / `delete_emails` as
    // strictly-destructive examples even on the Claude path, so we can't
    // assert those absent. Instead, verify the heading uniquely
    // identifies this branch.
    expect(html).not.toContain("Gmail (delegated to Codex)");
    expect(html).not.toContain("apply_labels_to_emails");
  });

  it("renders Google Calendar starter entries identically for Codex and Claude", () => {
    const codexHtml = renderToStaticMarkup(
      <SafetyFloorGuidance
        integrationKey="google_calendar"
        delegatedBackend="codex"
      />,
    );
    const claudeHtml = renderToStaticMarkup(
      <SafetyFloorGuidance
        integrationKey="google_calendar"
        delegatedBackend="claude"
      />,
    );
    for (const html of [codexHtml, claudeHtml]) {
      expect(html).toContain("Google Calendar — pre-populated entries:");
      expect(html).toContain("delete_event");
      expect(html).toContain("update_event");
      expect(html).toContain("strictly destructive");
    }
    // The earlier draft leaked design-doc meta-info into the UI heading
    // ("(same on both Codex and Claude)") — guard against regression.
    expect(codexHtml).not.toContain("(same on both");
    expect(claudeHtml).not.toContain("(same on both");
  });

  it("always renders the trailing 'rejected at the daemon' guarantee", () => {
    const html = renderToStaticMarkup(
      <SafetyFloorGuidance integrationKey="gmail" delegatedBackend="codex" />,
    );
    expect(html).toContain("rejected at the daemon");
    expect(html).toContain("direct API");
    expect(html).toContain("cross-backend proxy");
    expect(html).toContain("same-backend native MCP");
  });
});
