import { describe, it, expect } from "vitest";
import {
  BACKEND_IDS,
  RUNTIME_AVAILABLE_BACKEND_IDS,
  WEB_SEARCH_CAPABLE_BACKENDS,
  getBackendIds,
  isBackendId,
  isRuntimeAvailableBackendId,
} from "./backend.js";

describe("isBackendId", () => {
  it("returns true for known backend IDs", () => {
    for (const id of BACKEND_IDS) {
      expect(isBackendId(id)).toBe(true);
    }
  });

  it("returns false for unknown strings", () => {
    expect(isBackendId("openai")).toBe(false);
    expect(isBackendId("")).toBe(false);
  });
});

describe("getBackendIds", () => {
  it("returns the same array as BACKEND_IDS", () => {
    expect(getBackendIds()).toBe(BACKEND_IDS);
  });
});

describe("WEB_SEARCH_CAPABLE_BACKENDS", () => {
  it("includes all registered web-search capable backends", () => {
    expect(WEB_SEARCH_CAPABLE_BACKENDS.has("claude")).toBe(true);
    expect(WEB_SEARCH_CAPABLE_BACKENDS.has("codex")).toBe(true);
    expect(WEB_SEARCH_CAPABLE_BACKENDS.has("gemini")).toBe(true);
    expect(WEB_SEARCH_CAPABLE_BACKENDS.has("opencode")).toBe(true);
  });
});

describe("RUNTIME_AVAILABLE_BACKEND_IDS", () => {
  it("includes every wired backend (claude/codex/gemini/opencode)", () => {
    expect(RUNTIME_AVAILABLE_BACKEND_IDS).toContain("claude");
    expect(RUNTIME_AVAILABLE_BACKEND_IDS).toContain("codex");
    expect(RUNTIME_AVAILABLE_BACKEND_IDS).toContain("gemini");
    // docs/design/appendices/opencode-backend.md Phase 2 wired `OpencodeCore` into
    // `BackendRouter`. The constant widened in lock-step so destructive
    // API paths accept opencode without a separate runtime gate.
    expect(RUNTIME_AVAILABLE_BACKEND_IDS).toContain("opencode");
  });

  it("is a subset of BACKEND_IDS — every entry is a registered backend id", () => {
    for (const id of RUNTIME_AVAILABLE_BACKEND_IDS) {
      expect(BACKEND_IDS).toContain(id);
    }
  });
});

describe("isRuntimeAvailableBackendId", () => {
  it("returns true for runtime-available backends", () => {
    for (const id of RUNTIME_AVAILABLE_BACKEND_IDS) {
      expect(isRuntimeAvailableBackendId(id)).toBe(true);
    }
  });

  it("returns false for unknown strings", () => {
    expect(isRuntimeAvailableBackendId("openai")).toBe(false);
    expect(isRuntimeAvailableBackendId("")).toBe(false);
  });
});
