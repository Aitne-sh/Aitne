import type React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Alert } from "@/lib/api-types";
import { NotificationsPanelBody } from "./notifications-panel";

/**
 * Static-markup smoke tests for NotificationsPanelBody. The body is
 * intentionally hooks-free so we can exercise its layout decisions
 * without booting React Query or jsdom — the wrapper component
 * (NotificationsPanel) plugs `useAlerts` in.
 *
 * Behavioral coverage targets:
 *  - Empty state renders nothing.
 *  - Errors render before non-errors.
 *  - The "Show N more" gate hides low-severity items past the limit.
 *  - Dismissable rows expose the X button; non-dismissable rows do not.
 */

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

function alert(over: Partial<Alert>): Alert {
  return {
    id: "test",
    severity: "warning",
    title: "Title",
    source: "system",
    dismissable: true,
    detectedAt: "2026-05-01T12:00:00Z",
    fingerprint: "fp",
    ...over,
  };
}

describe("NotificationsPanelBody", () => {
  it("renders nothing when there are no alerts", () => {
    const html = render(<NotificationsPanelBody alerts={[]} />);
    expect(html).toBe("");
  });

  it("renders the section landmark with the Notifications aria-label when alerts exist", () => {
    const html = render(
      <NotificationsPanelBody
        alerts={[alert({ id: "a", title: "Solo" })]}
      />,
    );
    expect(html).toContain('aria-label="Notifications"');
    expect(html).toContain("Solo");
  });

  it("emits errors before non-errors in the rendered order", () => {
    const html = render(
      <NotificationsPanelBody
        alerts={[
          alert({ id: "info1", severity: "info", title: "INFO_ROW" }),
          alert({
            id: "err1",
            severity: "error",
            title: "ERROR_ROW",
            dismissable: false,
          }),
        ]}
      />,
    );
    const errIdx = html.indexOf("ERROR_ROW");
    const infoIdx = html.indexOf("INFO_ROW");
    expect(errIdx).toBeGreaterThan(-1);
    expect(infoIdx).toBeGreaterThan(-1);
    expect(errIdx).toBeLessThan(infoIdx);
  });

  it("hides low-severity rows past the visible limit behind a 'Show N more' button", () => {
    const alerts: Alert[] = [];
    for (let i = 0; i < 7; i++) {
      alerts.push(
        alert({ id: `info${i}`, severity: "info", title: `INFO_${i}` }),
      );
    }
    const html = render(<NotificationsPanelBody alerts={alerts} />);
    // First 5 stay visible; the remaining 2 are gated.
    expect(html).toContain("INFO_0");
    expect(html).toContain("INFO_4");
    expect(html).not.toContain("INFO_5");
    expect(html).toContain("Show 2 more");
  });

  it("renders the dismiss button only for dismissable alerts when onDismiss is supplied", () => {
    const dismissable = render(
      <NotificationsPanelBody
        alerts={[alert({ id: "w", severity: "warning", dismissable: true })]}
        onDismiss={() => {}}
      />,
    );
    expect(dismissable).toMatch(/aria-label="(Snooze for 24 hours|Dismiss notification)"/);

    const nonDismissable = render(
      <NotificationsPanelBody
        alerts={[
          alert({ id: "e", severity: "error", dismissable: false }),
        ]}
        onDismiss={() => {}}
      />,
    );
    expect(nonDismissable).not.toContain("aria-label=\"Snooze for 24 hours\"");
    expect(nonDismissable).not.toContain("aria-label=\"Dismiss notification\"");
  });

  it("labels the deep-link anchor by href so the verb matches the destination", () => {
    // /connections/* — connection settings page, not the top-level
    // settings page. Using "Open settings" here mismatches the cause
    // (broken connection) and the link target.
    const connection = render(
      <NotificationsPanelBody
        alerts={[
          alert({
            id: "x",
            severity: "info",
            title: "T",
            href: "/connections/calendar#google",
          }),
        ]}
      />,
    );
    expect(connection).toContain("href=\"/connections/calendar#google\"");
    expect(connection).toContain("Open connection settings");
    expect(connection).not.toContain("Open settings<");

    // /settings/* — top-level settings, including subpages like
    // /settings/advanced and /settings/backends.
    const settings = render(
      <NotificationsPanelBody
        alerts={[
          alert({
            id: "y",
            severity: "error",
            title: "T",
            dismissable: false,
            href: "/settings/advanced",
          }),
        ]}
      />,
    );
    expect(settings).toContain("href=\"/settings/advanced\"");
    expect(settings).toContain("Open settings");

    // Unknown prefix — fall back to a generic verb so we never label
    // an unrelated page as "settings". Today no detector emits this,
    // but the panel is rendering arbitrary daemon-supplied alerts.
    const unknown = render(
      <NotificationsPanelBody
        alerts={[
          alert({
            id: "z",
            severity: "info",
            title: "T",
            href: "/somewhere-new",
          }),
        ]}
      />,
    );
    expect(unknown).toContain("View details");
    expect(unknown).not.toContain("Open settings");

    // Path-boundary check: a sibling route that merely starts with
    // "settings" (e.g. /settings-foo) must not be labelled as
    // settings — that mismatch is exactly what we are guarding
    // against.
    const sibling = render(
      <NotificationsPanelBody
        alerts={[
          alert({
            id: "s",
            severity: "info",
            title: "T",
            href: "/settings-foo",
          }),
        ]}
      />,
    );
    expect(sibling).toContain("View details");
    expect(sibling).not.toContain("Open settings");
  });
});
