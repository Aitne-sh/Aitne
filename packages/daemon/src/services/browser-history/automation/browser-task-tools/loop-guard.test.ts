/**
 * loop-guard — §14.5 / §14.12 coverage.
 */

import { describe, expect, it } from "vitest";

import {
  createLoopGuardState,
  hashToolCall,
  LOOP_GUARD_REPEAT_THRESHOLD,
  LOOP_GUARD_WINDOW_SIZE,
  observeToolCall,
  stableJsonStringify,
} from "./loop-guard.js";

describe("hashToolCall", () => {
  it("yields the same hash for equal args regardless of key order", () => {
    const a = hashToolCall({ toolName: "click", args: { a: 1, b: 2 } });
    const b = hashToolCall({ toolName: "click", args: { b: 2, a: 1 } });
    expect(a).toBe(b);
  });

  it("differs by tool name", () => {
    const a = hashToolCall({ toolName: "click", args: { x: 1 } });
    const b = hashToolCall({ toolName: "type", args: { x: 1 } });
    expect(a).not.toBe(b);
  });

  it("differs when any leaf differs", () => {
    const a = hashToolCall({ toolName: "click", args: { selector: "#a" } });
    const b = hashToolCall({ toolName: "click", args: { selector: "#b" } });
    expect(a).not.toBe(b);
  });

  it("treats nested objects deterministically", () => {
    const a = hashToolCall({
      toolName: "click",
      args: { target: { kind: "selector", value: "#x" } },
    });
    const b = hashToolCall({
      toolName: "click",
      args: { target: { value: "#x", kind: "selector" } },
    });
    expect(a).toBe(b);
  });

  it("hashes a null arg deterministically", () => {
    const a = hashToolCall({ toolName: "finish", args: null });
    const b = hashToolCall({ toolName: "finish", args: null });
    expect(a).toBe(b);
  });
});

describe("stableJsonStringify", () => {
  it("sorts keys at every nesting level", () => {
    const s = stableJsonStringify({ b: { d: 2, c: 1 }, a: [3, 2, 1] });
    expect(s).toBe('{"a":[3,2,1],"b":{"c":1,"d":2}}');
  });

  it("handles circular references with [circular]", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const s = stableJsonStringify(obj);
    expect(s).toContain("[circular]");
  });
});

describe("observeToolCall", () => {
  it("does not trip on the first occurrence", () => {
    const result = observeToolCall(createLoopGuardState(), {
      toolName: "click",
      args: { x: 1 },
    });
    expect(result.shouldAbort).toBe(false);
    expect(result.state.window.length).toBe(1);
  });

  it("trips when the same hash appears LOOP_GUARD_REPEAT_THRESHOLD times in the window", () => {
    let state = createLoopGuardState();
    let result = observeToolCall(state, { toolName: "click", args: { x: 1 } });
    for (let i = 0; i < LOOP_GUARD_REPEAT_THRESHOLD - 1; i++) {
      state = result.state;
      result = observeToolCall(state, { toolName: "click", args: { x: 1 } });
    }
    expect(result.shouldAbort).toBe(true);
    if (result.shouldAbort) {
      expect(result.reason).toBe("tool_loop_detected");
      expect(result.toolName).toBe("click");
      expect(result.repeatCount).toBe(LOOP_GUARD_REPEAT_THRESHOLD);
      expect(result.argsFragment).toContain('"x"');
    }
  });

  it("does NOT trip when args differ between calls", () => {
    let state = createLoopGuardState();
    let result = observeToolCall(state, { toolName: "click", args: { x: 1 } });
    for (let i = 2; i <= LOOP_GUARD_REPEAT_THRESHOLD; i++) {
      state = result.state;
      result = observeToolCall(state, { toolName: "click", args: { x: i } });
    }
    expect(result.shouldAbort).toBe(false);
  });

  it("does NOT trip when tool name differs between calls", () => {
    let state = createLoopGuardState();
    let result = observeToolCall(state, { toolName: "click", args: { x: 1 } });
    state = result.state;
    result = observeToolCall(state, { toolName: "type", args: { x: 1 } });
    state = result.state;
    result = observeToolCall(state, { toolName: "press_key", args: { x: 1 } });
    state = result.state;
    result = observeToolCall(state, { toolName: "click", args: { x: 1 } });
    expect(result.shouldAbort).toBe(false);
  });

  it("expires older hashes after LOOP_GUARD_WINDOW_SIZE distinct calls", () => {
    // Push (THRESHOLD - 1) clicks, then enough distinct calls to push
    // them out of the window, then a fresh click. Should not trip.
    let state = createLoopGuardState();
    let result = observeToolCall(state, { toolName: "click", args: { x: 1 } });
    for (let i = 0; i < LOOP_GUARD_REPEAT_THRESHOLD - 2; i++) {
      state = result.state;
      result = observeToolCall(state, { toolName: "click", args: { x: 1 } });
    }
    // Now push LOOP_GUARD_WINDOW_SIZE distinct calls — the original
    // x:1 clicks fall off the back.
    for (let i = 0; i < LOOP_GUARD_WINDOW_SIZE; i++) {
      state = result.state;
      result = observeToolCall(state, { toolName: "click", args: { x: 1000 + i } });
    }
    state = result.state;
    result = observeToolCall(state, { toolName: "click", args: { x: 1 } });
    expect(result.shouldAbort).toBe(false);
  });

  it("caps the window size at LOOP_GUARD_WINDOW_SIZE", () => {
    let state = createLoopGuardState();
    for (let i = 0; i < LOOP_GUARD_WINDOW_SIZE + 5; i++) {
      const r = observeToolCall(state, { toolName: "click", args: { x: i } });
      state = r.state;
    }
    expect(state.window.length).toBe(LOOP_GUARD_WINDOW_SIZE);
  });

  it("trips cleanly when args is null (argsFragmentFor null-coalesce path)", () => {
    let state = createLoopGuardState();
    let result = observeToolCall(state, { toolName: "finish", args: null });
    for (let i = 0; i < LOOP_GUARD_REPEAT_THRESHOLD - 1; i++) {
      state = result.state;
      result = observeToolCall(state, { toolName: "finish", args: null });
    }
    expect(result.shouldAbort).toBe(true);
    if (result.shouldAbort) {
      expect(result.argsFragment).toBe("null");
    }
  });

  it("truncates very long argsFragment to ≤ 80 chars", () => {
    const longText = "x".repeat(500);
    let state = createLoopGuardState();
    let result = observeToolCall(state, { toolName: "type", args: { text: longText } });
    for (let i = 0; i < LOOP_GUARD_REPEAT_THRESHOLD - 1; i++) {
      state = result.state;
      result = observeToolCall(state, { toolName: "type", args: { text: longText } });
    }
    if (result.shouldAbort) {
      expect(result.argsFragment.length).toBeLessThanOrEqual(80);
      expect(result.argsFragment.endsWith("...")).toBe(true);
    }
  });
});
