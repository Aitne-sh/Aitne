/**
 * Integration test: ClaudeCodeCore MCP audit wiring.
 *
 * Verifies that `consumeStream` correctly wires the two-phase audit write:
 *   1. An `assistant` message with a `mcp__<server>__<tool>` tool_use block
 *      calls `logMcpToolCall` and stores the (rowId, startMs) in the pending map.
 *   2. A subsequent `user` message with a matching `tool_result` block calls
 *      `updateMcpToolCallResult` and removes the entry from the map.
 *
 * `consumeStream` is private, so tests access it via `(core as any).consumeStream`.
 * The SDK's `query` function is never called — we feed a synthetic async generator
 * directly to `consumeStream`, bypassing all auth and session setup.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { ClaudeCodeCore } from "./claude-code-core.js";
import { listMcpToolCalls } from "../../services/mcp/tool-audit.js";

function setupSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE mcp_tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      event_type TEXT,
      session_id TEXT,
      ok INTEGER,
      error TEXT,
      called_at INTEGER NOT NULL,
      duration_ms INTEGER
    );
  `);
}

/** Minimal SDK result message shape required by consumeStream. */
const MOCK_RESULT = {
  type: "result",
  subtype: "success",
  session_id: "sess-test",
  result: "done",
  total_cost_usd: 0,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  modelUsage: {},
  num_turns: 1,
  duration_api_ms: 0,
  is_error: false,
  stop_reason: "end_turn",
} as const;

async function* makeStream(
  toolUseId: string,
  toolName: string,
  isError: boolean,
  errorContent?: string,
) {
  yield { type: "system", subtype: "init", session_id: "sess-test", model: "claude-sonnet-4-6" };
  yield {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: toolUseId, name: toolName, input: {} }],
    },
  };
  yield {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          is_error: isError,
          content: errorContent ?? (isError ? "tool failed" : "result"),
        },
      ],
    },
  };
  yield MOCK_RESULT;
}

describe("ClaudeCodeCore MCP audit — consumeStream wiring", () => {
  let db: Database.Database;
  let core: ClaudeCodeCore;

  beforeEach(() => {
    db = new Database(":memory:");
    setupSchema(db);
    // Minimal config: allowedToolsOverride=null so warnOnMissingCriticalTools is a no-op.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = { allowedToolsOverride: null } as any;
    core = new ClaudeCodeCore(config);
    // blobStore is only accessed by materializeMcp(), not consumeStream().
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    core.setMcpContext({ db, blobStore: {} as any });
  });

  it("records ok=true and durationMs when tool_result is_error=false", async () => {
    const stream = makeStream("tu-001", "mcp__test-srv__do_thing", false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (core as any).consumeStream(stream, "claude-sonnet-4-6", Date.now(), undefined, "routine.test");

    const calls = listMcpToolCalls(db, "test-srv");
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("do_thing");
    expect(calls[0].ok).toBe(true);
    expect(calls[0].error).toBeNull();
    expect(calls[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(calls[0].eventType).toBe("routine.test");
    expect(calls[0].sessionId).toBe("sess-test");
  });

  it("records ok=false and error text when tool_result is_error=true", async () => {
    const stream = makeStream("tu-002", "mcp__test-srv__do_thing", true, "connection refused");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (core as any).consumeStream(stream, "claude-sonnet-4-6", Date.now(), undefined, "message.received.dm");

    const calls = listMcpToolCalls(db, "test-srv");
    expect(calls).toHaveLength(1);
    expect(calls[0].ok).toBe(false);
    expect(calls[0].error).toBe("connection refused");
    expect(calls[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("leaves ok=null and durationMs=null when no tool_result arrives for a tool_use", async () => {
    async function* streamWithoutResult() {
      yield { type: "system", subtype: "init", session_id: "sess", model: "claude" };
      yield {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "tu-003", name: "mcp__test-srv__do_thing", input: {} }],
        },
      };
      // No tool_result — simulates an abruptly-terminated stream or SDK anomaly.
      yield MOCK_RESULT;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (core as any).consumeStream(streamWithoutResult(), "claude-sonnet-4-6", Date.now(), undefined, undefined);

    const calls = listMcpToolCalls(db, "test-srv");
    expect(calls).toHaveLength(1);
    expect(calls[0].ok).toBeNull();
    expect(calls[0].durationMs).toBeNull();
  });

  it("handles multiple tool_use blocks and matches each to its result", async () => {
    async function* multiToolStream() {
      yield { type: "system", subtype: "init", session_id: "s", model: "c" };
      yield {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tu-A", name: "mcp__srv__toolA", input: {} },
            { type: "tool_use", id: "tu-B", name: "mcp__srv__toolB", input: {} },
          ],
        },
      };
      yield {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu-A", is_error: false, content: "ok" },
            { type: "tool_result", tool_use_id: "tu-B", is_error: true, content: "fail" },
          ],
        },
      };
      yield MOCK_RESULT;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (core as any).consumeStream(multiToolStream(), "claude-sonnet-4-6", Date.now(), undefined, undefined);

    const calls = listMcpToolCalls(db, "srv");
    expect(calls).toHaveLength(2);
    const toolA = calls.find((c) => c.toolName === "toolA");
    const toolB = calls.find((c) => c.toolName === "toolB");
    expect(toolA?.ok).toBe(true);
    expect(toolA?.durationMs).toBeGreaterThanOrEqual(0);
    expect(toolB?.ok).toBe(false);
    expect(toolB?.error).toBe("fail");
  });

  it("does not write a row for non-MCP tool_use blocks (e.g. Bash)", async () => {
    async function* bashStream() {
      yield { type: "system", subtype: "init", session_id: "s", model: "c" };
      yield {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "tu-bash", name: "Bash", input: { command: "echo hi" } }],
        },
      };
      yield {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tu-bash", is_error: false, content: "hi" }],
        },
      };
      yield MOCK_RESULT;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (core as any).consumeStream(bashStream(), "claude-sonnet-4-6", Date.now(), undefined, undefined);

    // No MCP server involved — table should be empty.
    const rows = db.prepare("SELECT COUNT(*) as cnt FROM mcp_tool_calls").get() as { cnt: number };
    expect(rows.cnt).toBe(0);
  });
});
