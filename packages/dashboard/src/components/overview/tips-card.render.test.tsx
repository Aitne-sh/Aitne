import type React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TipsCardBody, type Tip } from "./tips-card";

/**
 * Static-markup smoke tests for TipsCardBody. The body is hooks-free
 * by design (random selection lives in TipsCard, the wrapper) so that
 * layout decisions can be exercised without booting jsdom or
 * QueryClientProvider — same split as NotificationsPanelBody.
 *
 * Behavioral coverage targets:
 *  - Placeholder state when `tip` is null (skeleton shown, no CTA, no Next tip).
 *  - Tip with badge: badge label rendered.
 *  - Tip without href: CTA button suppressed but Next tip remains when onCycle is provided.
 *  - Tip with href but no cta: anchor falls back to the default "Learn more" verb.
 *  - aria-live region is present so SR users hear the swap.
 *  - Next tip button is omitted when `onCycle` is not supplied.
 */

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

const baseTip: Tip = {
  id: "demo",
  title: "DEMO_TITLE",
  description: "DEMO_DESCRIPTION",
};

describe("TipsCardBody", () => {
  it("renders a polite live region so screen readers announce tip swaps", () => {
    const html = render(<TipsCardBody tip={baseTip} />);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
  });

  it("renders the placeholder skeleton when tip is null and suppresses all action buttons", () => {
    const html = render(<TipsCardBody tip={null} onCycle={() => {}} />);
    expect(html).toContain("Did you know?");
    expect(html).toContain("animate-pulse");
    // No tip → no CTA, no Next tip, no link
    expect(html).not.toContain("Learn more");
    expect(html).not.toContain("Next tip");
    expect(html).not.toContain("href=");
  });

  it("renders the badge when present and omits it when absent", () => {
    const withBadge = render(
      <TipsCardBody tip={{ ...baseTip, badge: "Preview" }} />,
    );
    expect(withBadge).toContain("Preview");

    const withoutBadge = render(<TipsCardBody tip={baseTip} />);
    expect(withoutBadge).not.toContain("Preview");
  });

  it("hides the CTA button when href is missing but keeps Next tip when onCycle is provided", () => {
    const html = render(
      <TipsCardBody
        tip={{ ...baseTip, cta: "SHOULD_NOT_RENDER" }}
        onCycle={() => {}}
      />,
    );
    expect(html).not.toContain("SHOULD_NOT_RENDER");
    expect(html).not.toContain("href=");
    expect(html).toContain("Next tip");
  });

  it("falls back to a default 'Learn more' verb when href is set but cta is missing", () => {
    const html = render(
      <TipsCardBody tip={{ ...baseTip, href: "/settings/foo" }} />,
    );
    expect(html).toContain('href="/settings/foo"');
    expect(html).toContain("Learn more");
  });

  it("uses the supplied cta verb when one is provided", () => {
    const html = render(
      <TipsCardBody
        tip={{ ...baseTip, href: "/settings/foo", cta: "CUSTOM_VERB" }}
      />,
    );
    expect(html).toContain("CUSTOM_VERB");
    expect(html).not.toContain("Learn more");
  });

  it("omits the Next tip button when onCycle is not supplied", () => {
    const html = render(
      <TipsCardBody tip={{ ...baseTip, href: "/x", cta: "GO" }} />,
    );
    expect(html).not.toContain("Next tip");
    expect(html).toContain("GO");
  });
});
