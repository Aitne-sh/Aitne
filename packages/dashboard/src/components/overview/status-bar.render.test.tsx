import type React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { HealthResponse } from "@/lib/api-types";
import { StatusBar, type RunNowFeedback } from "./status-bar";

/**
 * Static-markup smoke tests for StatusBar. The component is pure props
 * (no hooks, no fetching — page.tsx owns the polling), so we can exercise
 * its three segments without booting React Query or jsdom.
 *
 * Behavioral coverage targets:
 *  - Daemon-down placeholder ("—" / "Waiting for daemon…") when health is undefined.
 *  - Healthy vs unhealthy state pill (label + token color).
 *  - Next-check sub-line composition: absolute time · active window · scheduled next.
 *  - Run-now button disabled + aria-busy while running.
 *  - Feedback message tones map to theme tokens and announce via role="status".
 *  - Today segment formats spend and pluralizes sessions.
 */

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

function health(over: Partial<HealthResponse> = {}): HealthResponse {
  return {
    status: "ok",
    uptime: 7_320, // 2h 2m
    activeSessions: 1,
    todaySessions: 4,
    todayCostUsd: 1.23,
    ...over,
  } as HealthResponse;
}

function bar(over: Partial<React.ComponentProps<typeof StatusBar>> = {}) {
  return (
    <StatusBar
      health={health()}
      nextCheckLabel="in 23 minutes"
      nextCheckAtLabel="06-10 23:00"
      nextCheckActive={true}
      scheduledNextLabel={null}
      onRunNow={() => {}}
      runNowRunning={false}
      runNowFeedback={null}
      {...over}
    />
  );
}

describe("StatusBar", () => {
  it("renders dashes and the waiting hint when health is undefined", () => {
    const html = render(bar({ health: undefined }));
    expect(html).toContain("—");
    expect(html).toContain("Waiting for daemon…");
  });

  it("shows Operational with the success dot when healthy", () => {
    const html = render(bar());
    expect(html).toContain("Operational");
    expect(html).toContain("bg-success");
    expect(html).not.toContain("Attention needed");
  });

  it("shows Attention needed with the destructive dot when unhealthy", () => {
    const html = render(bar({ health: health({ status: "degraded" }) }));
    expect(html).toContain("Attention needed");
    expect(html).toContain("bg-destructive");
  });

  it("renders uptime and active session count in the agent sub-line", () => {
    const html = render(bar());
    expect(html).toContain("Up 2h 2m");
    expect(html).toContain("1 active session");
    expect(html).not.toContain("1 active sessions");
  });

  it("composes the next-check sub-line from absolute time, window state and scheduled next", () => {
    const html = render(
      bar({ nextCheckActive: false, scheduledNextLabel: "06-11 09:00" }),
    );
    expect(html).toContain("in 23 minutes");
    expect(html).toContain("06-10 23:00 · Outside active window · next scheduled 06-11 09:00");
  });

  it("omits the absolute-time prefix when nextCheckAtLabel is null", () => {
    const html = render(bar({ nextCheckAtLabel: null }));
    expect(html).toContain(">Inside active window</p>");
  });

  it("disables the Run now button and marks it busy while running", () => {
    const html = render(bar({ runNowRunning: true }));
    expect(html).toContain("Running…");
    expect(html).toContain("disabled");
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain(">Run now<");
  });

  it("keeps the status live region mounted even when there is no feedback", () => {
    const html = render(bar({ runNowFeedback: null }));
    expect(html).toContain('role="status"');
  });

  it("announces feedback via role=status with the tone token class", () => {
    const tones: Array<[RunNowFeedback["tone"], string]> = [
      ["success", "text-success"],
      ["warning", "text-warning"],
      ["error", "text-destructive"],
    ];
    for (const [tone, cls] of tones) {
      const html = render(
        bar({ runNowFeedback: { tone, message: `MSG_${tone}` } }),
      );
      expect(html).toContain('role="status"');
      expect(html).toContain(cls);
      expect(html).toContain(`MSG_${tone}`);
    }
  });

  it("formats today's spend and pluralizes today's sessions", () => {
    const html = render(bar());
    expect(html).toContain("$1.23");
    expect(html).toContain("4 sessions so far today");

    const single = render(bar({ health: health({ todaySessions: 1 }) }));
    expect(single).toContain("1 session so far today");
  });
});
