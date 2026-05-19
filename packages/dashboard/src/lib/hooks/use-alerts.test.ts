import { afterEach, describe, expect, it, vi } from "vitest";
import type { Alert } from "@/lib/api-types";
import { dismissAlert, isAlertDismissed } from "./use-alerts";

let idSeq = 0;

function alert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: `test.${idSeq++}`,
    severity: "info",
    title: "Test alert",
    source: "system",
    dismissable: true,
    detectedAt: "2026-05-01T12:00:00.000Z",
    fingerprint: "fp",
    ...overrides,
  };
}

function throwingWindow() {
  return {
    localStorage: {
      getItem: () => {
        throw new Error("storage blocked");
      },
      setItem: () => {
        throw new Error("storage blocked");
      },
    },
  };
}

describe("alert dismissal store", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("hides info alerts for the current session when localStorage writes fail", () => {
    vi.stubGlobal("window", throwingWindow());
    const a = alert({ severity: "info" });

    expect(isAlertDismissed(a)).toBe(false);
    dismissAlert(a);
    expect(isAlertDismissed(a)).toBe(true);
  });

  it("snoozes warning alerts in memory and expires them after 24 hours when localStorage writes fail", () => {
    vi.stubGlobal("window", throwingWindow());
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    const a = alert({ severity: "warning" });

    dismissAlert(a);
    expect(isAlertDismissed(a)).toBe(true);

    vi.setSystemTime(new Date("2026-05-02T12:00:00.001Z"));
    expect(isAlertDismissed(a)).toBe(false);
  });
});
