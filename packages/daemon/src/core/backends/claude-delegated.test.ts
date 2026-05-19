/**
 * Peer tests for `./claude-delegated.ts` — pattern B extraction from
 * `claude-code-core.ts` per file-split-plan §8 Tier 2.
 *
 * Scope: focused on the **new seam** introduced by the extraction — i.e.
 * the `ClaudeDelegatedDeps` record. Verifies that `runDelegatedTool` and
 * `runDelegatedTask` thread the deps through to:
 *   - `buildDaemonApiCliEnv` (via `deps.apiPort`)
 *   - SDK env (via `deps.readTokenManager.issue` or `deps.readToken`
 *     fallback)
 *   - `deps.readTokenManager.revoke` on the finally branch
 *
 * The deep stream-parser behavior (every errorClass classification, the
 * structured-output retry mapping, idle-watchdog timeout) is already
 * exhaustively covered by `claude-code-core.test.ts` through the shim
 * methods on `ClaudeCodeCore` — duplicating that here would only add
 * maintenance burden. The module is also coverage-gate-excluded
 * (vitest.config.ts) under the same "SDK stream consumer" rationale as
 * the parent file.
 */

import { describe, it, expect, vi, type Mock } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<
    typeof import("@anthropic-ai/claude-agent-sdk")
  >("@anthropic-ai/claude-agent-sdk");
  return {
    ...actual,
    query: vi.fn(),
  };
});

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  runDelegatedTool,
  runDelegatedTask,
  type ClaudeDelegatedDeps,
} from "./claude-delegated.js";
import type {
  DelegatedTaskInvokeParams,
  DelegatedToolInvokeParams,
  ReadSensitiveTokenManager,
} from "../agent-core.js";

function makeTokenManager(): ReadSensitiveTokenManager & {
  issue: Mock;
  revoke: Mock;
  isValid: Mock;
} {
  return {
    issue: vi.fn((scope: string) => `scoped:${scope}`) as Mock,
    revoke: vi.fn() as Mock,
    isValid: vi.fn(() => true) as Mock,
  };
}

function makeDeps(
  manager: ReadSensitiveTokenManager | undefined = undefined,
  readToken: string | undefined = undefined,
): ClaudeDelegatedDeps {
  return {
    apiPort: 8321,
    readToken,
    readTokenManager: manager,
  };
}

function makeToolParams(
  overrides: Partial<DelegatedToolInvokeParams> = {},
): DelegatedToolInvokeParams {
  return {
    toolName: "mcp__google_calendar__list_events",
    toolArgs: { calendarId: "primary" },
    modelId: "claude-haiku-4-5",
    maxTurns: 2,
    maxBudgetUsd: 0.1,
    sessionDir: "/tmp/pa-test/delegated-tool",
    abortSignal: undefined,
    ...overrides,
  } as DelegatedToolInvokeParams;
}

function makeTaskParams(
  overrides: Partial<DelegatedTaskInvokeParams> = {},
): DelegatedTaskInvokeParams {
  return {
    systemPrompt: "You are a delegated task subprocess. Plan and execute.",
    allowedTools: ["mcp__google_calendar__list_events"],
    destructiveTools: [],
    writeClassTools: [],
    modelId: "claude-haiku-4-5",
    maxToolCalls: 3,
    maxBudgetUsd: 0.5,
    sessionDir: "/tmp/pa-test/delegated-task",
    abortSignal: undefined,
    onToolStep: undefined,
    ...overrides,
  } as DelegatedTaskInvokeParams;
}

/** Build a one-shot SDK stream that emits exactly the messages provided. */
function stubQueryWith(messages: readonly unknown[]): void {
  (query as unknown as Mock).mockReset();
  (query as unknown as Mock).mockImplementation(() => {
    async function* gen() {
      for (const m of messages) yield m;
    }
    return gen();
  });
}

function resultMsg(
  subtype:
    | "success"
    | "error_max_turns"
    | "error_during_execution"
    | "error_max_structured_output_retries",
  extra: Record<string, unknown> = {},
) {
  return {
    type: "result",
    subtype,
    is_error: subtype !== "success",
    duration_ms: 50,
    num_turns: 1,
    total_cost_usd: 0.001,
    usage: {
      input_tokens: 100,
      output_tokens: 25,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    ...extra,
  } as const;
}

function assistantToolUse(name: string, id: string, input: unknown) {
  return {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name, id, input }],
    },
  } as const;
}

function userToolResult(toolUseId: string, content: string, isError = false) {
  return {
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: toolUseId, content, is_error: isError },
      ],
    },
  } as const;
}

describe("runDelegatedTool — deps wiring", () => {
  it("threads deps.readTokenManager.issue and revoke around the call", async () => {
    const mgr = makeTokenManager();
    stubQueryWith([
      assistantToolUse("mcp__google_calendar__list_events", "tu-1", {}),
      userToolResult("tu-1", JSON.stringify({ items: [] })),
      resultMsg("success"),
    ]);

    const params = makeToolParams();
    const result = await runDelegatedTool(makeDeps(mgr), params);

    expect(mgr.issue).toHaveBeenCalledWith(params.sessionDir);
    expect(mgr.revoke).toHaveBeenCalledWith(params.sessionDir);
    expect(result.ok).toBe(true);
  });

  it("falls back to deps.readToken when no manager is wired", async () => {
    stubQueryWith([
      assistantToolUse("mcp__google_calendar__list_events", "tu-1", {}),
      userToolResult("tu-1", JSON.stringify({ items: [] })),
      resultMsg("success"),
    ]);
    const result = await runDelegatedTool(makeDeps(undefined, "legacy-token"), makeToolParams());
    expect(result.ok).toBe(true);

    // Confirm the env wiring carried the legacy token. The SDK stub records
    // the options call site so we can inspect `options.env`.
    const call = (query as unknown as Mock).mock.calls[0]?.[0] as {
      options: { env: Record<string, string> };
    };
    expect(call.options.env).toBeDefined();
    expect(Object.values(call.options.env).some((v) => v === "legacy-token")).toBe(
      true,
    );
  });

  it("passes deps.apiPort through to the daemon-api env helper", async () => {
    stubQueryWith([resultMsg("error_max_turns")]);
    await runDelegatedTool({ ...makeDeps(), apiPort: 9999 }, makeToolParams());
    const call = (query as unknown as Mock).mock.calls[0]?.[0] as {
      options: { env: Record<string, string> };
    };
    expect(
      Object.values(call.options.env).some((v) => /9999/.test(v)),
    ).toBe(true);
  });

  it("classifies a wrong tool call as errorClass=wrong_tool", async () => {
    stubQueryWith([
      assistantToolUse("not_the_requested_tool", "tu-1", {}),
      resultMsg("error_max_turns"),
    ]);
    const result = await runDelegatedTool(makeDeps(makeTokenManager()), makeToolParams());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorClass).toBe("wrong_tool");
    }
  });

  it("prefers deps.readTokenManager.issue over deps.readToken when both are set", async () => {
    const mgr = makeTokenManager();
    stubQueryWith([
      assistantToolUse("mcp__google_calendar__list_events", "tu-1", {}),
      userToolResult("tu-1", JSON.stringify({ items: [] })),
      resultMsg("success"),
    ]);
    await runDelegatedTool(makeDeps(mgr, "legacy-token-should-be-ignored"), makeToolParams());
    expect(mgr.issue).toHaveBeenCalledTimes(1);
    const call = (query as unknown as Mock).mock.calls[0]?.[0] as {
      options: { env: Record<string, string> };
    };
    const envValues = Object.values(call.options.env);
    expect(envValues.some((v) => v === "scoped:/tmp/pa-test/delegated-tool")).toBe(true);
    expect(envValues.includes("legacy-token-should-be-ignored")).toBe(false);
  });

  it("classifies a stream with no matching tool_use as errorClass=no_tool_call", async () => {
    stubQueryWith([resultMsg("error_max_turns")]);
    const result = await runDelegatedTool(makeDeps(makeTokenManager()), makeToolParams());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorClass).toBe("no_tool_call");
    }
  });

  it("revokes the scoped token even on subprocess crash", async () => {
    const mgr = makeTokenManager();
    (query as unknown as Mock).mockReset();
    (query as unknown as Mock).mockImplementation(() => {
      async function* gen() {
        throw new Error("authentication_failed: invalid api key");
        // eslint-disable-next-line no-unreachable
        yield resultMsg("success");
      }
      return gen();
    });
    const result = await runDelegatedTool(makeDeps(mgr), makeToolParams());
    expect(mgr.revoke).toHaveBeenCalledWith("/tmp/pa-test/delegated-tool");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorClass).toBe("auth_error");
    }
  });
});

describe("runDelegatedTask — deps wiring", () => {
  it("issues/revokes via deps.readTokenManager and resolves the final text", async () => {
    const mgr = makeTokenManager();
    stubQueryWith([
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "{\"ok\": true}" }],
        },
      },
      resultMsg("success"),
    ]);

    const params = makeTaskParams();
    const result = await runDelegatedTask(makeDeps(mgr), params);

    expect(mgr.issue).toHaveBeenCalledWith(params.sessionDir);
    expect(mgr.revoke).toHaveBeenCalledWith(params.sessionDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rawAssistantText).toContain("{\"ok\": true}");
      expect(result.writeClassToolFired).toBe(false);
    }
  });

  it("treats exceeding maxToolCalls as errorClass=loop_aborted", async () => {
    stubQueryWith([
      assistantToolUse("mcp__google_calendar__list_events", "tu-1", {}),
      userToolResult("tu-1", "{}"),
      assistantToolUse("mcp__google_calendar__list_events", "tu-2", {}),
      // Two tool calls, maxToolCalls=1 → second one trips loop_aborted.
      resultMsg("success"),
    ]);
    const result = await runDelegatedTask(
      makeDeps(makeTokenManager()),
      makeTaskParams({ maxToolCalls: 1 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorClass).toBe("loop_aborted");
    }
  });

  it("returns auth_error when the SDK throws an authentication_failed exception", async () => {
    (query as unknown as Mock).mockReset();
    (query as unknown as Mock).mockImplementation(() => {
      async function* gen() {
        throw new Error("unauthorized: invalid api key");
        // eslint-disable-next-line no-unreachable
        yield resultMsg("success");
      }
      return gen();
    });
    const result = await runDelegatedTask(
      makeDeps(makeTokenManager()),
      makeTaskParams(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorClass).toBe("auth_error");
    }
  });
});
