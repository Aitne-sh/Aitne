import { describe, expect, it } from "vitest";
import {
  extractAssistantTextFromParts,
  extractToolUsesFromParts,
  isMessageAborted,
  isTerminal,
  normalize,
  type OpencodeNormalizedEvent,
} from "./opencode-event-mapper.js";

interface CapturedEvent {
  type: string;
  properties?: unknown;
}

const TEXT_STREAM_EVENTS: CapturedEvent[] = [
  { type: "server.connected", properties: {} },
  {
    type: "session.status",
    properties: { sessionID: "ses_text", status: { type: "busy" } },
  },
  { type: "session.diff", properties: { sessionID: "ses_text", diff: [] } },
  { type: "server.heartbeat", properties: {} },
  {
    type: "message.part.delta",
    properties: {
      sessionID: "ses_text",
      messageID: "msg_text",
      partID: "prt_text",
      field: "text",
      delta: "Hello",
    },
  },
  {
    type: "session.status",
    properties: { sessionID: "ses_text", status: { type: "idle" } },
  },
  { type: "session.idle", properties: { sessionID: "ses_text" } },
];

const PERMISSION_EVENTS: CapturedEvent[] = [
  {
    type: "permission.asked",
    properties: {
      id: "per_bash",
      sessionID: "ses_permission",
      permission: "bash",
      patterns: ["echo NEEDS-PERMISSION"],
      always: ["echo *"],
      tool: {
        messageID: "msg_permission",
        callID: "call_permission",
      },
    },
  },
];

const API_ERROR_EVENTS: CapturedEvent[] = [
  {
    type: "session.error",
    properties: {
      sessionID: "ses_error",
      error: {
        name: "APIError",
        data: {
          message: "Missing Authentication header",
          statusCode: 401,
          isRetryable: false,
        },
      },
    },
  },
];

const ABORT_EVENTS: CapturedEvent[] = [
  {
    type: "session.error",
    properties: {
      sessionID: "ses_abort",
      error: { name: "MessageAbortedError", data: { message: "Aborted" } },
    },
  },
  { type: "session.idle", properties: { sessionID: "ses_abort" } },
];

function normalizeAll(events: CapturedEvent[]): OpencodeNormalizedEvent[] {
  return events.map((event) => normalize(event));
}

describe("opencode-event-mapper.normalize", () => {
  it("round-trips the v1-a one-turn text-only stream", () => {
    const normalized = normalizeAll(TEXT_STREAM_EVENTS);
    expect(normalized).toHaveLength(TEXT_STREAM_EVENTS.length);

    const kinds = normalized.map((event) => event.kind);
    expect(kinds).toContain("server_connected");
    expect(kinds).toContain("heartbeat");
    expect(kinds).toContain("text_delta");
    expect(kinds).toContain("session_idle");
    // V1 stream never carries an `unknown` event — fixture is the
    // contract for "default-config one-turn happy path".
    expect(kinds).not.toContain("unknown");
  });

  it("decodes message.part.delta into text_delta with the field payload", () => {
    const first = normalizeAll(TEXT_STREAM_EVENTS).find(
      (event) => event.kind === "text_delta",
    );
    expect(first).toBeDefined();
    if (first?.kind !== "text_delta") throw new Error("expected text_delta");
    expect(first.delta.length).toBeGreaterThan(0);
    expect(first.field).toBe("text");
    expect(first.sessionId).toBe("ses_text");
    expect(first.messageId).toBe("msg_text");
    expect(first.partId).toBe("prt_text");
  });

  it("maps permission.asked → permission_request with patterns + alwaysPatterns", () => {
    const askEvent = normalizeAll(PERMISSION_EVENTS).find(
      (event) => event.kind === "permission_request",
    );
    expect(askEvent).toBeDefined();
    if (askEvent?.kind !== "permission_request") {
      throw new Error("expected permission_request");
    }
    expect(askEvent.toolName).toBe("bash");
    expect(askEvent.patterns.length).toBeGreaterThan(0);
    expect(askEvent.alwaysPatterns.length).toBeGreaterThan(0);
    expect(askEvent.tool.callID).toBeTruthy();
    expect(askEvent.tool.messageID).toBeTruthy();
  });

  it("maps session.error from v10-bad-key into a typed APIError payload", () => {
    const errEvent = normalizeAll(API_ERROR_EVENTS).find(
      (event) => event.kind === "session_error",
    );
    expect(errEvent).toBeDefined();
    if (errEvent?.kind !== "session_error") {
      throw new Error("expected session_error");
    }
    expect(errEvent.error.name).toBe("APIError");
    expect(errEvent.error.data.statusCode).toBe(401);
    expect(errEvent.error.data.isRetryable).toBe(false);
  });

  it("flags MessageAbortedError from v9-abort", () => {
    const normalized = normalizeAll(ABORT_EVENTS);
    const errEvent = normalized.find((event) => event.kind === "session_error");
    expect(errEvent).toBeDefined();
    expect(isMessageAborted(errEvent)).toBe(true);
    if (errEvent?.kind !== "session_error") {
      throw new Error("expected session_error");
    }
    expect(errEvent.error.name).toBe("MessageAbortedError");
    // The abort path ends with session_idle, NOT a dedicated abort event.
    expect(normalized[normalized.length - 1]?.kind).toBe("session_idle");
  });

  it("emits session_status + session_diff as typed (not unknown)", () => {
    const kinds = normalizeAll(TEXT_STREAM_EVENTS).map((event) => event.kind);
    expect(kinds).toContain("session_status");
    expect(kinds).toContain("session_diff");
  });

  it("returns kind=unknown for never-before-seen event types", () => {
    const result = normalize({
      type: "future.unspecified",
      properties: { foo: "bar" },
    });
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") throw new Error("type narrow");
    expect(result.type).toBe("future.unspecified");
  });

  it("handles missing properties without throwing", () => {
    const result = normalize({ type: "server.connected" });
    expect(result.kind).toBe("server_connected");
  });

  it("tolerates a non-object properties payload by treating it as empty", () => {
    // The SDK contract widens `properties` to `unknown`; the runtime
    // observation is that the field is always an object. Defensive
    // handling lets us not crash if a future build changes that.
    const result = normalize({ type: "session.idle", properties: 42 });
    expect(result.kind).toBe("session_idle");
    if (result.kind !== "session_idle") throw new Error("kind narrow");
    expect(result.sessionId).toBe("");
  });
});

describe("opencode-event-mapper.isTerminal", () => {
  it("treats session_idle as terminal", () => {
    expect(
      isTerminal({ kind: "session_idle", sessionId: "ses_x" }),
    ).toBe(true);
  });

  it("treats session_error as terminal", () => {
    expect(
      isTerminal({
        kind: "session_error",
        sessionId: "ses_x",
        error: { name: "APIError", data: {} },
      }),
    ).toBe(true);
  });

  it("treats text_delta / heartbeat as non-terminal", () => {
    expect(
      isTerminal({
        kind: "text_delta",
        sessionId: "ses_x",
        messageId: "msg_x",
        partId: "prt_x",
        field: "text",
        delta: "hi",
      }),
    ).toBe(false);
    expect(isTerminal({ kind: "heartbeat" })).toBe(false);
  });
});

describe("opencode-event-mapper.extractAssistantTextFromParts", () => {
  it("joins all `text`-type parts and ignores reasoning / tool / step-start", () => {
    const parts = [
      { type: "step-start" },
      { type: "reasoning", text: "thinking..." },
      { type: "text", text: "Hello " },
      { type: "tool", state: { output: "result" } },
      { type: "text", text: "world" },
    ];
    expect(extractAssistantTextFromParts(parts)).toBe("Hello world");
  });

  it("returns empty string on non-array input", () => {
    expect(extractAssistantTextFromParts(null)).toBe("");
    expect(extractAssistantTextFromParts(undefined)).toBe("");
    expect(extractAssistantTextFromParts({})).toBe("");
  });
});

describe("opencode-event-mapper.extractToolUsesFromParts", () => {
  it("extracts a completed tool call with input + output + duration", () => {
    const parts = [
      { type: "step-start" },
      {
        type: "tool",
        callID: "call_1",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "echo PHASE0-BASH-OK" },
          output: "PHASE0-BASH-OK\n",
          title: "Bash",
          metadata: {},
          time: { start: 1, end: 11 },
        },
      },
      { type: "text", text: "done" },
    ];
    const tools = extractToolUsesFromParts(parts);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      callId: "call_1",
      toolName: "bash",
      status: "completed",
      input: { command: "echo PHASE0-BASH-OK" },
      output: "PHASE0-BASH-OK\n",
      durationMs: 10,
    });
  });

  it("extracts an error-state tool call with the error message", () => {
    const parts = [
      {
        type: "tool",
        callID: "call_err",
        tool: "edit",
        state: {
          status: "error",
          input: { path: "/etc/passwd" },
          error: "permission denied",
          time: { start: 1, end: 2 },
        },
      },
    ];
    const tools = extractToolUsesFromParts(parts);
    expect(tools[0]).toMatchObject({
      callId: "call_err",
      toolName: "edit",
      status: "error",
      errorMessage: "permission denied",
    });
  });

  it("returns empty array on non-array input", () => {
    expect(extractToolUsesFromParts(null)).toEqual([]);
    expect(extractToolUsesFromParts("not-parts")).toEqual([]);
  });

  it("ignores parts with unknown status (forward compatibility)", () => {
    const parts = [
      {
        type: "tool",
        callID: "x",
        tool: "bash",
        state: { status: "future-state", input: {} },
      },
    ];
    expect(extractToolUsesFromParts(parts)).toEqual([]);
  });

  it("skips non-tool parts and tool parts missing state", () => {
    const parts = [
      { type: "text", text: "hello" },
      { type: "tool", callID: "no-state", tool: "bash" },
      null,
    ];
    expect(extractToolUsesFromParts(parts)).toEqual([]);
  });

  it("emits durationMs=undefined when time.start/end are absent", () => {
    const parts = [
      {
        type: "tool",
        callID: "no-time",
        tool: "read",
        state: { status: "completed", input: {}, output: "ok" },
      },
    ];
    const [tool] = extractToolUsesFromParts(parts);
    expect(tool?.durationMs).toBeUndefined();
  });

  it("falls back to empty input when state.input is not an object", () => {
    const parts = [
      {
        type: "tool",
        callID: "bad-input",
        tool: "read",
        state: { status: "completed", input: 42, output: "" },
      },
    ];
    const [tool] = extractToolUsesFromParts(parts);
    expect(tool?.input).toEqual({});
  });

  it("emits pending / running statuses with no output or error", () => {
    const parts = [
      {
        type: "tool",
        callID: "p",
        tool: "bash",
        state: { status: "pending", input: { command: "x" }, raw: "" },
      },
      {
        type: "tool",
        callID: "r",
        tool: "bash",
        state: {
          status: "running",
          input: { command: "y" },
          time: { start: 100 },
        },
      },
    ];
    const tools = extractToolUsesFromParts(parts);
    expect(tools.map((t) => t.status)).toEqual(["pending", "running"]);
    expect(tools[0]?.output).toBeUndefined();
    expect(tools[0]?.errorMessage).toBeUndefined();
  });
});

describe("opencode-event-mapper.normalize — edge cases for branch coverage", () => {
  it("handles permission.asked missing patterns / always (defaults to empty arrays)", () => {
    const result = normalize({
      type: "permission.asked",
      properties: {
        id: "per_x",
        sessionID: "ses_x",
        permission: "edit",
        // patterns + always intentionally absent
      },
    });
    expect(result.kind).toBe("permission_request");
    if (result.kind !== "permission_request") return;
    expect(result.patterns).toEqual([]);
    expect(result.alwaysPatterns).toEqual([]);
    expect(result.tool.callID).toBe("");
    expect(result.tool.messageID).toBe("");
  });

  it("normalises session.error with missing error.data into an empty data object", () => {
    const result = normalize({
      type: "session.error",
      properties: {
        sessionID: "ses_x",
        error: { name: "APIError" },
      },
    });
    expect(result.kind).toBe("session_error");
    if (result.kind !== "session_error") return;
    expect(result.error.name).toBe("APIError");
    expect(result.error.data).toEqual({});
  });

  it("defaults error.name to UnknownError when missing", () => {
    const result = normalize({
      type: "session.error",
      properties: {
        sessionID: "ses_x",
        // error.name absent → defensive default
        error: { data: { message: "?" } },
      },
    });
    expect(result.kind).toBe("session_error");
    if (result.kind !== "session_error") return;
    expect(result.error.name).toBe("UnknownError");
  });

  it("session.status with missing status.type yields empty string", () => {
    const result = normalize({
      type: "session.status",
      properties: { sessionID: "ses_x" },
    });
    expect(result.kind).toBe("session_status");
    if (result.kind !== "session_status") return;
    expect(result.status).toBe("");
  });

  it("session.status / session.diff / session.error default sessionId to empty when absent", () => {
    const status = normalize({ type: "session.status", properties: {} });
    expect(status.kind).toBe("session_status");
    if (status.kind === "session_status") expect(status.sessionId).toBe("");

    const diff = normalize({ type: "session.diff", properties: {} });
    expect(diff.kind).toBe("session_diff");
    if (diff.kind === "session_diff") expect(diff.sessionId).toBe("");

    const err = normalize({
      type: "session.error",
      properties: { error: { name: "APIError", data: {} } },
    });
    expect(err.kind).toBe("session_error");
    if (err.kind === "session_error") expect(err.sessionId).toBe("");
  });

  it("text_delta defaults every id field + delta to empty when absent", () => {
    const result = normalize({
      type: "message.part.delta",
      properties: {},
    });
    expect(result.kind).toBe("text_delta");
    if (result.kind !== "text_delta") return;
    expect(result.sessionId).toBe("");
    expect(result.messageId).toBe("");
    expect(result.partId).toBe("");
    expect(result.field).toBe("text");
    expect(result.delta).toBe("");
  });

  it("permission_request defaults toolName + permissionId to empty when absent", () => {
    const result = normalize({
      type: "permission.asked",
      properties: { sessionID: "ses_x" },
    });
    expect(result.kind).toBe("permission_request");
    if (result.kind !== "permission_request") return;
    expect(result.toolName).toBe("");
    expect(result.permissionId).toBe("");
  });

  it("asStringArray rejects non-string entries", () => {
    const result = normalize({
      type: "permission.asked",
      properties: {
        id: "per_x",
        sessionID: "ses_x",
        permission: "bash",
        patterns: ["ls *", 42, null, "rm *"],
        always: [],
      },
    });
    expect(result.kind).toBe("permission_request");
    if (result.kind !== "permission_request") return;
    expect(result.patterns).toEqual(["ls *", "rm *"]);
  });

  it("permission_request defaults sessionId to empty string when absent", () => {
    const result = normalize({
      type: "permission.asked",
      properties: { id: "per_x", permission: "bash" },
    });
    expect(result.kind).toBe("permission_request");
    if (result.kind !== "permission_request") return;
    expect(result.sessionId).toBe("");
  });

  it("extractAssistantTextFromParts skips non-object entries (null) defensively", () => {
    expect(extractAssistantTextFromParts([null, undefined, "raw"])).toBe("");
  });

  it("extractToolUsesFromParts defaults callID and tool to empty when absent", () => {
    const [tool] = extractToolUsesFromParts([
      { type: "tool", state: { status: "completed", input: {}, output: "" } },
    ]);
    expect(tool?.callId).toBe("");
    expect(tool?.toolName).toBe("");
  });

  it("isMessageAborted returns false for null and unrelated event kinds", () => {
    expect(isMessageAborted(null)).toBe(false);
    expect(isMessageAborted(undefined)).toBe(false);
    expect(
      isMessageAborted({ kind: "session_idle", sessionId: "x" }),
    ).toBe(false);
  });
});
