/**
 * Peer test for `browser-task-transition-events.ts` — pure-logic checks
 * for the SSE payload emitter (§9a.5 Shape B).
 *
 * Excluded from the I/O-heavy paths; the emitter itself is a tiny
 * wrapper around `broadcastNamedEvent` so the assertions focus on the
 * payload shape, the brief truncation, the control-char scrub, and the
 * no-broadcaster fallback.
 */

import { describe, expect, it, vi } from "vitest";
import type { BrowserTaskRow } from "../../db/browser-task-store.js";
import {
  briefPayload,
  createBrowserTaskTransitionEmitter,
  noopBrowserTaskTransitionEmitter,
  type BroadcastSink,
} from "./browser-task-transition-events.js";

function makeRow(overrides: Partial<BrowserTaskRow> = {}): BrowserTaskRow {
  return {
    id: "task-1",
    description: "Send a contact form on Amazon",
    siteKey: "amazon_jp",
    extraAllowedHosts: [],
    originatingChannel: "slack:U123",
    scheduleRowId: null,
    requireFinalConfirm: true,
    state: "pending",
    outcomeDetail: null,
    report: null,
    effectiveAllowlistRegex: null,
    blockedRequestsCount: 0,
    extractCharsTotal: 0,
    origin: "agent",
    costUsd: null,
    createdAt: 1_700_000_000_000,
    startedAt: null,
    finishedAt: null,
    deliveredAt: null,
    ...overrides,
  };
}

describe("briefPayload", () => {
  it("extracts the canonical fields from a row", () => {
    const row = makeRow({ state: "running", startedAt: 1_700_000_001_000 });
    const payload = briefPayload(row, row.startedAt!);
    expect(payload).toEqual({
      taskId: "task-1",
      state: "running",
      transitionedAt: 1_700_000_001_000,
      brief: "Send a contact form on Amazon",
      outcomeDetail: null,
      originatingChannel: "slack:U123",
    });
  });

  it("truncates the brief to 80 chars", () => {
    const long = "x".repeat(200);
    const payload = briefPayload(makeRow({ description: long }), 0);
    expect(payload.brief.length).toBe(80);
    expect(payload.brief).toBe("x".repeat(80));
  });

  it("scrubs ASCII control characters from the brief", () => {
    const NUL = String.fromCharCode(0x00);
    const DEL = String.fromCharCode(0x7f);
    const desc = "line one\nline\ttwo" + NUL + "NUL" + DEL + "DEL";
    const payload = briefPayload(makeRow({ description: desc }), 0);
    // All control chars (newline, tab, NUL, DEL) replaced with spaces.
    expect(payload.brief).toBe("line one line two NUL DEL");
    // Defensive — no unscrubbed control chars in the output.
    expect(payload.brief).not.toMatch(new RegExp("[\\x00-\\x1f\\x7f]"));
  });

  it("carries the outcome detail for terminal rows", () => {
    const row = makeRow({
      state: "failed",
      outcomeDetail: "not_implemented",
      finishedAt: 1_700_000_002_000,
    });
    const payload = briefPayload(row, row.finishedAt!);
    expect(payload.state).toBe("failed");
    expect(payload.outcomeDetail).toBe("not_implemented");
  });
});

describe("createBrowserTaskTransitionEmitter", () => {
  it("returns the no-op emitter when sink is null", () => {
    const emitter = createBrowserTaskTransitionEmitter(null);
    expect(emitter).toBe(noopBrowserTaskTransitionEmitter);
  });

  it("returns the no-op emitter when sink is undefined", () => {
    const emitter = createBrowserTaskTransitionEmitter(undefined);
    expect(emitter).toBe(noopBrowserTaskTransitionEmitter);
  });

  it("forwards emits to broadcastNamedEvent under the 'browser_task' name", () => {
    const sink: BroadcastSink = {
      broadcastNamedEvent: vi.fn(),
    };
    const emitter = createBrowserTaskTransitionEmitter(sink);
    const row = makeRow({ state: "running", startedAt: 12345 });
    const payload = emitter.emitFromRow(row, 12345);
    expect(sink.broadcastNamedEvent).toHaveBeenCalledOnce();
    expect(sink.broadcastNamedEvent).toHaveBeenCalledWith("browser_task", payload);
  });

  it("returns null and skips emit when emitFromRow receives null", () => {
    const sink: BroadcastSink = {
      broadcastNamedEvent: vi.fn(),
    };
    const emitter = createBrowserTaskTransitionEmitter(sink);
    const result = emitter.emitFromRow(null, 0);
    expect(result).toBeNull();
    expect(sink.broadcastNamedEvent).not.toHaveBeenCalled();
  });

  it("emit(payload) forwards the supplied payload verbatim", () => {
    const sink: BroadcastSink = {
      broadcastNamedEvent: vi.fn(),
    };
    const emitter = createBrowserTaskTransitionEmitter(sink);
    const payload = {
      taskId: "task-2",
      state: "completed" as const,
      transitionedAt: 99,
      brief: "manual",
      outcomeDetail: null,
      originatingChannel: null,
    };
    emitter.emit(payload);
    expect(sink.broadcastNamedEvent).toHaveBeenCalledWith("browser_task", payload);
  });
});

describe("noopBrowserTaskTransitionEmitter.emit", () => {
  it("is a no-op that never throws", () => {
    expect(() =>
      noopBrowserTaskTransitionEmitter.emit({
        taskId: "t",
        state: "pending",
        transitionedAt: 0,
        brief: "x",
        outcomeDetail: null,
        originatingChannel: null,
      }),
    ).not.toThrow();
  });
});

describe("noopBrowserTaskTransitionEmitter.emitFromRow", () => {
  it("returns the payload shape without emitting anywhere", () => {
    const row = makeRow({ state: "awaiting_user" });
    const result = noopBrowserTaskTransitionEmitter.emitFromRow(row, 42);
    expect(result?.state).toBe("awaiting_user");
    expect(result?.transitionedAt).toBe(42);
  });

  it("returns null when row is null", () => {
    const result = noopBrowserTaskTransitionEmitter.emitFromRow(null, 0);
    expect(result).toBeNull();
  });
});
