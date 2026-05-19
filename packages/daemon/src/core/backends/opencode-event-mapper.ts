/**
 * docs/design/appendices/opencode-backend.md §5.3 / §6.3 — defensive normaliser over the
 * SDK's `EventSubscribeResponse` union. The generated SDK union is
 * **incomplete** (V9): the server emits event types (`server.heartbeat`,
 * `permission.asked`) that are not declared, while it never emits some
 * types the SDK does declare (`message.part.updated`, `permission.replied`,
 * `session.compacted`, …). Phase 2 therefore widens the input type to a
 * plain `{ type: string; properties?: unknown }` and dispatches on the
 * string literal, with a `kind: "unknown"` fallthrough that lets the
 * dispatcher keep running while new event types accumulate.
 *
 * Tool-call / tool-result extraction is intentionally **not** done from
 * this stream — V9 confirmed `message.part.updated` is never emitted in
 * opencode 1.14.50, so tool data must be pulled from the final
 * `session.prompt` response `info.parts` array. See
 * `extractToolUsesFromParts` and `extractAssistantTextFromParts`.
 */

import type { RawOpencodeEvent } from "./opencode-types.js";

/**
 * Shape mirrors the runtime payload of an `APIError`-name session.error.
 * Loose typing — keep optional, since fixtures show field availability
 * varies across providers / failure modes.
 */
export interface OpencodeSessionErrorPayload {
  /** `MessageAbortedError`, `APIError`, `ProviderAuthError`, `UnknownError`,
   *  `MessageOutputLengthError`, or anything else opencode invents next. */
  name: string;
  data: {
    message?: string;
    statusCode?: number;
    isRetryable?: boolean;
    providerID?: string;
    responseHeaders?: Record<string, string>;
    responseBody?: string;
    [key: string]: unknown;
  };
}

export interface OpencodePermissionRequestEvent {
  toolName: string;
  permissionId: string;
  sessionId: string;
  /** Bash-glob patterns the user is asked to allow once. */
  patterns: string[];
  /** Bash-glob patterns the user is asked to "always" allow. */
  alwaysPatterns: string[];
  tool: { messageID: string; callID: string };
}

export type OpencodeNormalizedEvent =
  | { kind: "server_connected" }
  | { kind: "heartbeat" }
  | { kind: "session_status"; sessionId: string; status: string }
  | { kind: "session_diff"; sessionId: string }
  | { kind: "session_idle"; sessionId: string }
  | { kind: "session_error"; sessionId: string; error: OpencodeSessionErrorPayload }
  | {
      kind: "text_delta";
      sessionId: string;
      messageId: string;
      partId: string;
      field: string;
      delta: string;
    }
  | ({ kind: "permission_request" } & OpencodePermissionRequestEvent)
  | { kind: "unknown"; type: string; raw: unknown };

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Normalise a raw opencode event into the dispatch-friendly shape. Never
 * throws — unknown types fall through to `{ kind: "unknown" }` so the
 * caller can decide whether to log/alert/skip.
 */
export function normalize(event: RawOpencodeEvent): OpencodeNormalizedEvent {
  const props = asRecord(event.properties) ?? {};
  switch (event.type) {
    case "server.connected":
      return { kind: "server_connected" };
    case "server.heartbeat":
      return { kind: "heartbeat" };
    case "session.status": {
      const status = asRecord(props.status);
      return {
        kind: "session_status",
        sessionId: asString(props.sessionID) ?? "",
        status: asString(status?.type) ?? "",
      };
    }
    case "session.diff":
      return {
        kind: "session_diff",
        sessionId: asString(props.sessionID) ?? "",
      };
    case "session.idle":
      return {
        kind: "session_idle",
        sessionId: asString(props.sessionID) ?? "",
      };
    case "session.error": {
      const error = asRecord(props.error);
      const data = asRecord(error?.data) ?? {};
      const errorName = asString(error?.name) ?? "UnknownError";
      const sessionErr: OpencodeSessionErrorPayload = {
        name: errorName,
        data: data as OpencodeSessionErrorPayload["data"],
      };
      return {
        kind: "session_error",
        sessionId: asString(props.sessionID) ?? "",
        error: sessionErr,
      };
    }
    case "message.part.delta": {
      return {
        kind: "text_delta",
        sessionId: asString(props.sessionID) ?? "",
        messageId: asString(props.messageID) ?? "",
        partId: asString(props.partID) ?? "",
        field: asString(props.field) ?? "text",
        delta: asString(props.delta) ?? "",
      };
    }
    case "permission.asked": {
      const tool = asRecord(props.tool) ?? {};
      return {
        kind: "permission_request",
        toolName: asString(props.permission) ?? "",
        permissionId: asString(props.id) ?? "",
        sessionId: asString(props.sessionID) ?? "",
        patterns: asStringArray(props.patterns),
        alwaysPatterns: asStringArray(props.always),
        tool: {
          messageID: asString(tool.messageID) ?? "",
          callID: asString(tool.callID) ?? "",
        },
      };
    }
    default:
      return { kind: "unknown", type: event.type, raw: event };
  }
}

/**
 * `session.idle` marks the end of a single prompt turn. `session.error`
 * is also terminal — the dispatcher must stop awaiting deltas. Other
 * statuses (`busy`, etc.) are non-terminal liveness signals.
 *
 * Abort detection: there is **no** `session.aborted` event. The abort
 * path emits `session.error` with `error.name === "MessageAbortedError"`
 * followed by `session.idle` (V9 — `events/v9-abort.json`). Both are
 * terminal here; callers may further inspect `error.name` after the
 * fact.
 */
export function isTerminal(event: OpencodeNormalizedEvent): boolean {
  return event.kind === "session_idle" || event.kind === "session_error";
}

/**
 * Aborted-via-API detection. The SDK does NOT surface this via a
 * dedicated event type; the daemon must read it off the assistant
 * message's `info.error.name` field from the final `session.prompt`
 * response (or from a streamed `session.error`).
 */
export function isMessageAborted(
  event: OpencodeNormalizedEvent | undefined | null,
): boolean {
  return (
    !!event && event.kind === "session_error" && event.error.name === "MessageAbortedError"
  );
}

/**
 * Pull final assistant text from a `session.prompt` response's `parts`
 * array. opencode 1.14.50 splits the assistant message across multiple
 * typed parts; only `type: "text"` carries the user-visible response.
 * `reasoning` / `step-start` / `step-finish` / `tool` / `agent` /
 * `compaction` parts are ignored here.
 */
export function extractAssistantTextFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  const chunks: string[] = [];
  for (const part of parts) {
    const rec = asRecord(part);
    if (!rec) continue;
    if (rec.type === "text" && typeof rec.text === "string") {
      chunks.push(rec.text);
    }
  }
  return chunks.join("");
}

export interface ExtractedToolUse {
  callId: string;
  toolName: string;
  status: "pending" | "running" | "completed" | "error";
  input: Record<string, unknown>;
  output?: string;
  errorMessage?: string;
  durationMs?: number;
}

/**
 * Extract tool calls + results from a `session.prompt` response's
 * `parts` array. V9 confirmed that `message.part.updated` events are
 * NOT emitted in opencode 1.14.50; the final response carries the only
 * authoritative tool-call record. Pure function; safe to call on raw
 * unknown input.
 */
export function extractToolUsesFromParts(parts: unknown): ExtractedToolUse[] {
  if (!Array.isArray(parts)) return [];
  const tools: ExtractedToolUse[] = [];
  for (const part of parts) {
    const rec = asRecord(part);
    if (!rec || rec.type !== "tool") continue;
    const state = asRecord(rec.state);
    if (!state) continue;
    const status = asString(state.status);
    if (
      status !== "pending"
      && status !== "running"
      && status !== "completed"
      && status !== "error"
    ) {
      continue;
    }
    const time = asRecord(state.time);
    const startVal = time?.start;
    const endVal = time?.end;
    const durationMs =
      typeof startVal === "number" && typeof endVal === "number"
        ? Math.max(0, endVal - startVal)
        : undefined;
    const tool: ExtractedToolUse = {
      callId: asString(rec.callID) ?? "",
      toolName: asString(rec.tool) ?? "",
      status,
      input: (asRecord(state.input) as Record<string, unknown>) ?? {},
    };
    if (status === "completed") {
      tool.output = asString(state.output);
    }
    if (status === "error") {
      tool.errorMessage = asString(state.error);
    }
    if (durationMs !== undefined) tool.durationMs = durationMs;
    tools.push(tool);
  }
  return tools;
}
