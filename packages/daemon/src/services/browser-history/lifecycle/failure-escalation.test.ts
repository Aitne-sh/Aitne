import { describe, expect, it } from "vitest";
import { nextBrowserLifecycleState } from "./failure-escalation.js";

describe("nextBrowserLifecycleState", () => {
  it("pauses after three consecutive launch or sync failures", () => {
    const nowMs = Date.UTC(2026, 4, 20);
    const next = nextBrowserLifecycleState({
      state: "launch_failed_recently",
      consecutiveFailures: 2,
      nowMs,
      outcome: "launch_failed",
    });

    expect(next).toMatchObject({
      state: "lifecycle_paused",
      consecutiveFailures: 3,
      lastCheckedAt: nowMs,
      lastOutcome: "launch_failed",
    });
    expect(next.pausedUntil).toBe(nowMs + 24 * 60 * 60 * 1000);
  });

  it("clears failure counters and pause state after a successful sync", () => {
    const nowMs = Date.UTC(2026, 4, 20, 1);
    const next = nextBrowserLifecycleState({
      state: "lifecycle_paused",
      consecutiveFailures: 3,
      nowMs,
      outcome: "success",
    });

    expect(next).toMatchObject({
      state: "healthy",
      consecutiveFailures: 0,
      pausedUntil: null,
      lastSuccessfulSyncAt: nowMs,
      lastOutcome: "success",
    });
  });

  it("treats a skipped tick (quiet hours) as stopped without touching the failure counter", () => {
    const nowMs = Date.UTC(2026, 4, 20, 2);
    const next = nextBrowserLifecycleState({
      state: "healthy",
      consecutiveFailures: 0,
      nowMs,
      outcome: "skipped",
    });
    expect(next).toMatchObject({
      state: "stopped",
      consecutiveFailures: 0,
      pausedUntil: null,
      lastSuccessfulSyncAt: null,
      lastOutcome: "skipped",
    });
  });

  it("increments failure counter on a single sync_unresponsive outcome without pausing", () => {
    const nowMs = Date.UTC(2026, 4, 20, 3);
    const next = nextBrowserLifecycleState({
      state: "healthy",
      consecutiveFailures: 0,
      nowMs,
      outcome: "sync_unresponsive",
    });
    expect(next).toMatchObject({
      state: "sync_unresponsive",
      consecutiveFailures: 1,
      pausedUntil: null,
      lastOutcome: "sync_unresponsive",
    });
  });

  it("maps a thrown error outcome to the stale fallback state and counts it as a failure", () => {
    const nowMs = Date.UTC(2026, 4, 20, 4);
    const next = nextBrowserLifecycleState({
      state: "healthy",
      consecutiveFailures: 1,
      nowMs,
      outcome: "error",
    });
    expect(next).toMatchObject({
      state: "stale",
      consecutiveFailures: 2,
      pausedUntil: null,
      lastOutcome: "error",
    });
  });

  it("paused outcome restamps lifecycle_paused without resetting the failure counter", () => {
    const nowMs = Date.UTC(2026, 4, 20, 5);
    const next = nextBrowserLifecycleState({
      state: "lifecycle_paused",
      consecutiveFailures: 3,
      nowMs,
      outcome: "paused",
    });
    expect(next).toMatchObject({
      state: "lifecycle_paused",
      consecutiveFailures: 3,
      lastOutcome: "paused",
    });
    expect(next.pausedUntil).toBe(nowMs + 24 * 60 * 60 * 1000);
  });
});
