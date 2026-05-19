import { describe, it, expect } from "vitest";
import {
  BackendDecisiveFailure,
  BackendQuotaError,
  DelegatedProxyTimeoutError,
  DelegatedToolUnsupportedError,
  LiveProbeUnsupportedError,
  TaskModeUnsupportedError,
  classifyAbortReason,
} from "./agent-core.js";

describe("DelegatedProxyTimeoutError", () => {
  it("uses the default message when none is provided", () => {
    const err = new DelegatedProxyTimeoutError();
    expect(err.message).toBe("delegated proxy wall-clock timeout");
    expect(err.name).toBe("DelegatedProxyTimeoutError");
    expect(err).toBeInstanceOf(Error);
  });

  it("accepts a custom message (used by task-mode invoker)", () => {
    const err = new DelegatedProxyTimeoutError("delegated task wall-clock timeout");
    expect(err.message).toBe("delegated task wall-clock timeout");
    expect(err.name).toBe("DelegatedProxyTimeoutError");
  });
});

describe("classifyAbortReason", () => {
  it("classifies a DelegatedProxyTimeoutError as 'timeout'", () => {
    expect(classifyAbortReason(new DelegatedProxyTimeoutError())).toBe("timeout");
  });

  it("classifies a custom-message DelegatedProxyTimeoutError as 'timeout'", () => {
    // Subclass identity is what matters; the message can be anything the
    // invoker chooses. The classifier must not fall back to message-string
    // matching.
    expect(
      classifyAbortReason(new DelegatedProxyTimeoutError("anything goes")),
    ).toBe("timeout");
  });

  it("classifies a generic Error as 'cancelled'", () => {
    // Caller-side cancellation paths in the invoker propagate the caller's
    // abort reason verbatim. Anything that is not the wall-clock sentinel
    // must classify as cancelled so the dashboard can split the failure
    // surface.
    expect(classifyAbortReason(new Error("user clicked cancel"))).toBe(
      "cancelled",
    );
  });

  it("classifies undefined as 'cancelled'", () => {
    // AbortController.abort() with no argument leaves reason=undefined.
    expect(classifyAbortReason(undefined)).toBe("cancelled");
  });

  it("classifies a string reason as 'cancelled'", () => {
    expect(classifyAbortReason("session cancelled")).toBe("cancelled");
  });

  it("does not collide with a same-message generic Error", () => {
    // Defense: if a future caller throws a plain Error with the wall-clock
    // message string, instanceof still returns false and the call is
    // classified as a cancellation, not a timeout. This is the key
    // robustness property of the custom-class sentinel over message
    // matching.
    const decoy = new Error("delegated proxy wall-clock timeout");
    expect(classifyAbortReason(decoy)).toBe("cancelled");
  });
});

describe("TaskModeUnsupportedError", () => {
  it("encodes the backend id in both the field and the human-readable message", () => {
    const err = new TaskModeUnsupportedError("codex");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("TaskModeUnsupportedError");
    expect(err.backendId).toBe("codex");
    expect(err.message).toContain("codex");
    expect(err.message).toContain("runDelegatedTask");
  });
});

describe("LiveProbeUnsupportedError", () => {
  it("preserves the backend id and reason on the error instance", () => {
    const err = new LiveProbeUnsupportedError("gemini", "no MCP probe path");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("LiveProbeUnsupportedError");
    expect(err.backendId).toBe("gemini");
    expect(err.reason).toBe("no MCP probe path");
    // Message format must include both fields so the dashboard surfaces
    // a meaningful 501 body without inspecting the structured fields.
    expect(err.message).toContain("gemini");
    expect(err.message).toContain("no MCP probe path");
  });
});

describe("BackendQuotaError", () => {
  it("preserves the structured quota signal needed by BackendRouter for fallback", () => {
    const reset = {
      hour: 16,
      minute: 0,
      timeZone: "America/Los_Angeles",
      rawLabel: "4 PM PT",
    } as const;
    const err = new BackendQuotaError(
      "claude",
      "rate_limit_5h",
      reset,
      "Claude 5h window exhausted",
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("BackendQuotaError");
    expect(err.backendId).toBe("claude");
    expect(err.originalCode).toBe("rate_limit_5h");
    expect(err.resetHint).toEqual(reset);
    expect(err.message).toBe("Claude 5h window exhausted");
  });

  it("accepts a null reset hint when the upstream did not provide one", () => {
    const err = new BackendQuotaError(
      "gemini",
      "daily_cap_exceeded",
      null,
      "daily cap exceeded",
    );
    expect(err.resetHint).toBeNull();
  });
});

describe("DelegatedToolUnsupportedError", () => {
  it("encodes the backend id and the per-call reason in the human-readable message", () => {
    const err = new DelegatedToolUnsupportedError(
      "gemini",
      "stream extractor not yet wired",
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DelegatedToolUnsupportedError");
    expect(err.backendId).toBe("gemini");
    expect(err.message).toBe(
      "gemini: runDelegatedTool not implemented — stream extractor not yet wired",
    );
  });
});

describe("BackendDecisiveFailure", () => {
  it("captures the structured kind discriminator and underlying cause", () => {
    const cause = new Error("upstream HTTP 401");
    const err = new BackendDecisiveFailure("codex", "auth", cause);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("BackendDecisiveFailure");
    expect(err.backendId).toBe("codex");
    expect(err.kind).toBe("auth");
    expect(err.cause).toBe(cause);
    expect(err.message).toBe("codex decisive failure: auth");
  });
});
