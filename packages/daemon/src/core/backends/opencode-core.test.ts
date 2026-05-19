/**
 * docs/design/appendices/opencode-backend.md §6.2 — happy-path tests for OpencodeCore.
 *
 * Drives a fake `OpencodeServerManager` whose `client()` returns an
 * SDK-shaped stub. The stub emits a deterministic event stream and a
 * prompt response so the core's `execute()` exercises the full
 * normalise → stream → assemble path without any real opencode child
 * process. The Phase 0 corpus is the contract for raw-event shapes;
 * this test re-uses the same payload conventions.
 */

import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import type { OpencodeClient } from "@opencode-ai/sdk";
import {
  OpencodeCore,
  auditOpencodeTools,
  parseModelComposite,
} from "./opencode-core.js";
import type { OpencodeServerManager } from "./opencode-server-manager.js";
import type { RawOpencodeEvent } from "./opencode-types.js";
import { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import { applySchema } from "../../db/schema.js";
import type { AgentConfig } from "../../config.js";
import type { AgentExecuteParams } from "../agent-core.js";
import {
  BackendDecisiveFailure,
  DelegatedToolUnsupportedError,
  LiveProbeUnsupportedError,
  TaskModeUnsupportedError,
} from "../agent-core.js";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    workspaceDir: "/tmp/aitne-test-workspace",
    dataDir: "/tmp/aitne-test-data",
    apiPort: 8321,
    executeTimeoutMinutes: 5,
    opencodeExecutionPermissionMode: "strict",
    character: "",
    ...overrides,
  } as unknown as AgentConfig;
}

interface StubSession {
  id: string;
  prompts: number;
  deleted: boolean;
  aborted: boolean;
}

interface SessionGetData {
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
}

interface StubEnvelope {
  events: RawOpencodeEvent[];
  promptResponse: {
    info: {
      cost?: number;
      providerID?: string;
      modelID?: string;
      finish?: string;
      tokens?: {
        input?: number;
        output?: number;
        reasoning?: number;
        cache?: { read?: number; write?: number };
      };
      error?: { name: string; data?: unknown };
    };
    parts: Array<Record<string, unknown>>;
  };
  sessionGet?: SessionGetData;
  /**
   * Per-call sequence for `session.get`. When present, each call shifts
   * the next response from the front — used by resume tests to give a
   * different pre-turn snapshot vs post-turn aggregate. Overrides
   * `sessionGet` when both are set.
   */
  sessionGetSequence?: Array<SessionGetData | undefined>;
  /**
   * When set, `session.prompt` throws this error instead of returning a
   * response — used to assert the stale-session path on resume.
   */
  promptError?: Error;
}

interface StubCallTrace {
  createCalls: number;
  promptedSessionIds: string[];
  promptedTexts: string[];
  sessionGetCalls: number;
}

function makeStubManager(envelope: StubEnvelope): {
  manager: OpencodeServerManager;
  session: StubSession;
  ensureConfigCalls: number;
  trace: StubCallTrace;
} {
  const session: StubSession = {
    id: "ses_test_abc",
    prompts: 0,
    deleted: false,
    aborted: false,
  };
  let ensureConfigCalls = 0;
  const trace: StubCallTrace = {
    createCalls: 0,
    promptedSessionIds: [],
    promptedTexts: [],
    sessionGetCalls: 0,
  };
  const getSequence = envelope.sessionGetSequence
    ? [...envelope.sessionGetSequence]
    : null;

  const client = {
    session: {
      create: async () => {
        trace.createCalls += 1;
        return { data: { id: session.id } };
      },
      prompt: async (req: {
        path: { id: string };
        body: { parts?: Array<{ type: string; text?: string }> };
      }) => {
        session.prompts += 1;
        trace.promptedSessionIds.push(req.path.id);
        const firstText = req.body.parts?.find((p) => p.type === "text")?.text
          ?? "";
        trace.promptedTexts.push(firstText);
        if (envelope.promptError) {
          throw envelope.promptError;
        }
        return { data: envelope.promptResponse };
      },
      get: async () => {
        trace.sessionGetCalls += 1;
        if (getSequence) {
          const next = getSequence.shift();
          return next ? { data: next } : { data: undefined };
        }
        return envelope.sessionGet
          ? { data: envelope.sessionGet }
          : { data: undefined };
      },
      delete: async () => {
        session.deleted = true;
        return {};
      },
      abort: async () => {
        session.aborted = true;
        return {};
      },
    },
    config: {
      providers: async () => ({
        data: {
          providers: [{ id: "anthropic", name: "Anthropic", source: "config" }],
          default: { anthropic: "claude-sonnet-4-6" },
        },
      }),
    },
    event: {
      subscribe: async (options?: { signal?: AbortSignal }) => {
        // Yield events one at a time; honour the abort signal so the
        // wall-clock timeout test can short-circuit.
        async function* gen(): AsyncGenerator<unknown, void> {
          for (const event of envelope.events) {
            if (options?.signal?.aborted) return;
            yield event;
          }
        }
        return { stream: gen() };
      },
    },
  } as unknown as OpencodeClient;

  const manager: OpencodeServerManager = {
    mode: "managed",
    async ensureConfig() {
      ensureConfigCalls += 1;
    },
    async client() {
      return client;
    },
    async spawnEphemeral() {
      // Phase 4 stub — tests that exercise Path A override this on the
      // bespoke manager they construct (see runDelegatedTask cases below).
      throw new Error("spawnEphemeral not implemented in default stub");
    },
    async shutdown() {},
  };
  return {
    manager,
    session,
    trace,
    get ensureConfigCalls() {
      return ensureConfigCalls;
    },
  } as unknown as {
    manager: OpencodeServerManager;
    session: StubSession;
    ensureConfigCalls: number;
    trace: StubCallTrace;
  };
}

function makeExecuteParams(
  overrides: Partial<AgentExecuteParams> = {},
): AgentExecuteParams {
  // Use a non-message event so `buildExecutionPrompt` skips the
  // MessageEvent branch — the test exercises the core, not the prompt
  // composition. `routine.hourly_check` is a `RoutineEvent` so the
  // prompt utility's branch reads `event.routine`, which is undefined
  // here and gracefully skipped.
  return {
    prompt: "What is 2+2?",
    context: "",
    event: {
      type: "routine.hourly_check",
      source: "cron",
      priority: 1 as 1 | 2 | 3,
      timestamp: new Date("2026-05-14T00:00:00Z"),
      data: {},
      correlationId: "corr_test",
    },
    modelId: "anthropic/claude-sonnet-4-6",
    maxTurns: 10,
    maxBudgetUsd: 1.0,
    sessionDir: "/tmp/aitne-opencode-test-session",
    ...overrides,
  };
}

describe("parseModelComposite", () => {
  it("splits on the first slash only", () => {
    expect(parseModelComposite("anthropic/claude-haiku-4-5")).toEqual({
      providerID: "anthropic",
      modelID: "claude-haiku-4-5",
    });
  });

  it("preserves slashes inside the model id", () => {
    expect(parseModelComposite("openrouter/openai/gpt-oss-20b:free")).toEqual({
      providerID: "openrouter",
      modelID: "openai/gpt-oss-20b:free",
    });
  });

  it("returns null on missing slash", () => {
    expect(parseModelComposite("claude-only")).toBeNull();
  });

  it("returns null on empty provider or empty model", () => {
    expect(parseModelComposite("/foo")).toBeNull();
    expect(parseModelComposite("foo/")).toBeNull();
  });
});

describe("OpencodeCore.execute (happy path)", () => {
  it("returns aggregated cost + tokens from session.get", async () => {
    const envelope: StubEnvelope = {
      events: [
        { type: "server.connected", properties: {} },
        {
          type: "message.part.delta",
          properties: {
            sessionID: "ses_test_abc",
            messageID: "msg_a",
            partID: "prt_a",
            field: "text",
            delta: "4",
          },
        },
        {
          type: "session.idle",
          properties: { sessionID: "ses_test_abc" },
        },
      ],
      promptResponse: {
        info: {
          cost: 0,
          providerID: "anthropic",
          modelID: "claude-sonnet-4-6",
          finish: "stop",
          tokens: {
            input: 100,
            output: 5,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [
          { type: "step-start" },
          { type: "text", text: "4" },
        ],
      },
      sessionGet: {
        cost: 0.0003,
        tokens: {
          input: 100,
          output: 5,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    };
    const { manager, session } = makeStubManager(envelope);
    const writeTracker = new AgentWriteTracker();
    const core = new OpencodeCore(makeConfig(), writeTracker, manager);
    const collected: string[] = [];
    const result = await core.execute(makeExecuteParams(), {
      onText: (text) => collected.push(text),
    });
    expect(result.output).toBe("4");
    expect(result.backendId).toBe("opencode");
    expect(result.sessionId).toBe(session.id);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.costUsd).toBeCloseTo(0.0003, 5);
    expect(result.stopReason).toBe("stop");
    // Stream callback received the delta(s).
    expect(collected.join("")).toContain("4");
  });

  it("falls back to assistant-message tokens when session.get has no data", async () => {
    const envelope: StubEnvelope = {
      events: [{ type: "session.idle", properties: { sessionID: "ses_test_abc" } }],
      promptResponse: {
        info: {
          cost: 0.0007,
          providerID: "anthropic",
          modelID: "claude-haiku-4-5",
          finish: "stop",
          tokens: {
            input: 200,
            output: 12,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [{ type: "text", text: "done" }],
      },
    };
    const { manager } = makeStubManager(envelope);
    const core = new OpencodeCore(
      makeConfig(),
      new AgentWriteTracker(),
      manager,
    );
    const result = await core.execute(makeExecuteParams());
    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.outputTokens).toBe(12);
    expect(result.costUsd).toBeCloseTo(0.0007, 5);
  });

  it("raises BackendDecisiveFailure on a malformed model id", async () => {
    const envelope: StubEnvelope = {
      events: [],
      promptResponse: { info: {}, parts: [] },
    };
    const { manager } = makeStubManager(envelope);
    const core = new OpencodeCore(
      makeConfig(),
      new AgentWriteTracker(),
      manager,
    );
    await expect(
      core.execute(makeExecuteParams({ modelId: "noslash" })),
    ).rejects.toBeInstanceOf(BackendDecisiveFailure);
  });

  it("classifies MessageAbortedError as a timeout failure", async () => {
    const envelope: StubEnvelope = {
      events: [
        {
          type: "session.error",
          properties: {
            sessionID: "ses_test_abc",
            error: {
              name: "MessageAbortedError",
              data: { message: "Aborted" },
            },
          },
        },
        { type: "session.idle", properties: { sessionID: "ses_test_abc" } },
      ],
      promptResponse: {
        info: {
          cost: 0,
          providerID: "anthropic",
          modelID: "claude-sonnet-4-6",
          error: { name: "MessageAbortedError", data: { message: "Aborted" } },
        },
        parts: [],
      },
    };
    const { manager } = makeStubManager(envelope);
    const core = new OpencodeCore(
      makeConfig(),
      new AgentWriteTracker(),
      manager,
    );
    const err = await core
      .execute(makeExecuteParams())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendDecisiveFailure);
    expect((err as BackendDecisiveFailure).kind).toBe("timeout");
  });

  it("classifies 401 stream errors as auth failure", async () => {
    const envelope: StubEnvelope = {
      events: [
        {
          type: "session.error",
          properties: {
            sessionID: "ses_test_abc",
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
        { type: "session.idle", properties: { sessionID: "ses_test_abc" } },
      ],
      promptResponse: {
        info: {
          cost: 0,
          providerID: "anthropic",
          modelID: "claude-sonnet-4-6",
        },
        parts: [],
      },
    };
    const { manager } = makeStubManager(envelope);
    const core = new OpencodeCore(
      makeConfig(),
      new AgentWriteTracker(),
      manager,
    );
    const err = await core
      .execute(makeExecuteParams())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendDecisiveFailure);
    expect((err as BackendDecisiveFailure).kind).toBe("auth");
  });

  it("classifies 429 stream errors as quota failure", async () => {
    const envelope: StubEnvelope = {
      events: [
        {
          type: "session.error",
          properties: {
            sessionID: "ses_test_abc",
            error: {
              name: "APIError",
              data: {
                message: "Rate limited",
                statusCode: 429,
                isRetryable: true,
              },
            },
          },
        },
        { type: "session.idle", properties: { sessionID: "ses_test_abc" } },
      ],
      promptResponse: { info: {}, parts: [] },
    };
    const { manager } = makeStubManager(envelope);
    const core = new OpencodeCore(
      makeConfig(),
      new AgentWriteTracker(),
      manager,
    );
    const err = await core
      .execute(makeExecuteParams())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendDecisiveFailure);
    expect((err as BackendDecisiveFailure).kind).toBe("quota");
  });

  it("invokes setMcpContext without throwing (Phase 2 no-op)", () => {
    const envelope: StubEnvelope = {
      events: [],
      promptResponse: { info: {}, parts: [] },
    };
    const { manager } = makeStubManager(envelope);
    const core = new OpencodeCore(
      makeConfig(),
      new AgentWriteTracker(),
      manager,
    );
    expect(() =>
      core.setMcpContext({
        db: {} as unknown as import("better-sqlite3").Database,
        blobStore:
          {} as unknown as import("../../secrets/encrypted-blob-store.js").EncryptedBlobStore,
      }),
    ).not.toThrow();
  });
});

describe("OpencodeCore stubs (Phase 2 unsupported surfaces)", () => {
  it("probeTools throws LiveProbeUnsupportedError", async () => {
    const { manager } = makeStubManager({
      events: [],
      promptResponse: { info: {}, parts: [] },
    });
    const core = new OpencodeCore(
      makeConfig(),
      new AgentWriteTracker(),
      manager,
    );
    await expect(core.probeTools()).rejects.toBeInstanceOf(
      LiveProbeUnsupportedError,
    );
  });

  it("runDelegatedTool throws DelegatedToolUnsupportedError", async () => {
    const { manager } = makeStubManager({
      events: [],
      promptResponse: { info: {}, parts: [] },
    });
    const core = new OpencodeCore(
      makeConfig(),
      new AgentWriteTracker(),
      manager,
    );
    await expect(
      core.runDelegatedTool({
        integrationKey: "gmail",
        toolName: "search_threads",
        toolArgs: {},
        modelId: "anthropic/claude-haiku-4-5",
        maxTurns: 1,
        maxBudgetUsd: 0.01,
        sessionDir: "/tmp/x",
      }),
    ).rejects.toBeInstanceOf(DelegatedToolUnsupportedError);
  });

  it("runDelegatedTask throws TaskModeUnsupportedError in remote mode", async () => {
    const { manager } = makeStubManager({
      events: [],
      promptResponse: { info: {}, parts: [] },
    });
    const remoteManager: OpencodeServerManager = {
      ...manager,
      mode: "remote",
    };
    const core = new OpencodeCore(
      makeConfig(),
      new AgentWriteTracker(),
      remoteManager,
    );
    await expect(
      core.runDelegatedTask({
        systemPrompt: "",
        validate: () => true,
        validatorErrorMessage: () => "",
        allowedTools: [],
        destructiveTools: [],
        writeClassTools: [],
        modelId: "anthropic/claude-haiku-4-5",
        maxToolCalls: 1,
        maxBudgetUsd: 0.01,
        timeoutMs: 1000,
        allowDestructive: false,
        sessionDir: "/tmp/x",
      }),
    ).rejects.toBeInstanceOf(TaskModeUnsupportedError);
  });

  it("summarize falls back to truncation when the SDK call fails", async () => {
    // Default stub doesn't implement the summarize/messages SDK calls,
    // so the new V11-shaped flow throws and falls through to the
    // truncation back-stop. The fallback contract is the only thing
    // callers depend on across backends; the SDK round-trip is
    // exercised by the dedicated test below.
    const { manager } = makeStubManager({
      events: [],
      promptResponse: { info: {}, parts: [] },
    });
    const core = new OpencodeCore(
      makeConfig(),
      new AgentWriteTracker(),
      manager,
    );
    const short = await core.summarize("hello");
    expect(short).toBe("hello");
    const long = await core.summarize("x".repeat(5000));
    expect(long.length).toBe(4096);
  });

});

describe("OpencodeCore.executeResume (resume turn)", () => {
  it("re-enters an existing session id and skips session.create", async () => {
    const envelope: StubEnvelope = {
      events: [
        {
          type: "message.part.delta",
          properties: {
            sessionID: "ses_pre_existing",
            messageID: "msg_r1",
            partID: "prt_r1",
            field: "text",
            delta: "got it",
          },
        },
        { type: "session.idle", properties: { sessionID: "ses_pre_existing" } },
      ],
      promptResponse: {
        info: {
          cost: 0.12,
          providerID: "anthropic",
          modelID: "claude-sonnet-4-6",
          finish: "stop",
          tokens: {
            input: 50,
            output: 10,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [{ type: "text", text: "got it" }],
      },
      sessionGetSequence: [
        // Pre-turn snapshot — session already has prior turns' cost.
        {
          cost: 0.2,
          tokens: {
            input: 200,
            output: 30,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        // Post-turn aggregate — cumulative after this turn.
        {
          cost: 0.32,
          tokens: {
            input: 250,
            output: 40,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      ],
    };
    const { manager, session, trace } = makeStubManager(envelope);
    const core = new OpencodeCore(
      makeConfig(),
      new AgentWriteTracker(),
      manager,
    );
    const result = await core.executeResume({
      sessionId: "ses_pre_existing",
      message: "thanks!",
      modelId: "anthropic/claude-sonnet-4-6",
      sessionDir: "/tmp/aitne-opencode-test-session",
    });

    expect(trace.createCalls).toBe(0);
    expect(trace.promptedSessionIds).toEqual(["ses_pre_existing"]);
    // Bare message — no `<task_flow>` / event framing from
    // buildExecutionPrompt; resume sends params.message verbatim.
    expect(trace.promptedTexts).toEqual(["thanks!"]);
    expect(result.sessionId).toBe("ses_pre_existing");
    expect(result.output).toBe("got it");
    // Cost is the per-turn delta (0.32 - 0.20), not the cumulative
    // session total (0.32).
    expect(result.costUsd).toBeCloseTo(0.12, 5);
    // Token usage is per-turn delta too.
    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(10);
    // Resume must never delete the server-side session — the next turn
    // needs it.
    expect(session.deleted).toBe(false);
  });

  it("throws synchronously when sessionDir is missing", async () => {
    const { manager } = makeStubManager({
      events: [],
      promptResponse: { info: {}, parts: [] },
    });
    const core = new OpencodeCore(
      makeConfig(),
      new AgentWriteTracker(),
      manager,
    );
    await expect(
      core.executeResume({
        sessionId: "ses_x",
        message: "hi",
        modelId: "anthropic/claude-haiku-4-5",
      }),
    ).rejects.toThrow(/sessionDir is required/);
  });

  it("propagates a session.prompt error for a stale session id", async () => {
    const envelope: StubEnvelope = {
      events: [],
      promptResponse: { info: {}, parts: [] },
      promptError: Object.assign(new Error("session ses_gone not found"), {
        status: 404,
      }),
    };
    const { manager, trace } = makeStubManager(envelope);
    const core = new OpencodeCore(
      makeConfig(),
      new AgentWriteTracker(),
      manager,
    );
    await expect(
      core.executeResume({
        sessionId: "ses_gone",
        message: "hi",
        modelId: "anthropic/claude-haiku-4-5",
        sessionDir: "/tmp/aitne-opencode-test-session",
      }),
    ).rejects.toThrow(/not found/);
    expect(trace.createCalls).toBe(0);
    expect(trace.promptedSessionIds).toEqual(["ses_gone"]);
  });
});

describe("OpencodeCore.checkAuth", () => {
  it("returns ok when at least one provider is configured", async () => {
    const { manager } = makeStubManager({
      events: [],
      promptResponse: { info: {}, parts: [] },
    });
    const core = new OpencodeCore(
      makeConfig(),
      new AgentWriteTracker(),
      manager,
    );
    const auth = await core.checkAuth();
    expect(auth.ok).toBe(true);
  });

  it("returns not-ok when the providers query fails", async () => {
    const failingClient = {
      config: {
        providers: async () => {
          throw new Error("unreachable");
        },
      },
    } as unknown as OpencodeClient;
    const manager: OpencodeServerManager = {
      mode: "managed",
      async ensureConfig() {},
      async client() {
        return failingClient;
      },
      async spawnEphemeral() {
        throw new Error("spawnEphemeral not implemented in this stub");
      },
      async shutdown() {},
    };
    const core = new OpencodeCore(
      makeConfig(),
      new AgentWriteTracker(),
      manager,
    );
    const auth = await core.checkAuth();
    expect(auth.ok).toBe(false);
  });
});

describe("OpencodeCore basic-auth fetch wrapper (unit-level)", () => {
  it("does not interfere with the inner fetch when no credentials set", async () => {
    // Smoke: ensures the import wires cleanly. The dedicated wrapper
    // tests live in opencode-basic-auth-fetch.test.ts (Phase 5).
    const { createBasicAuthFetch } = await import(
      "./opencode-basic-auth-fetch.js"
    );
    const inner = vi.fn(async () => new Response("ok"));
    const wrapped = createBasicAuthFetch(null, inner as unknown as typeof fetch);
    await wrapped("http://example.test/x", { method: "GET" });
    expect(inner).toHaveBeenCalled();
  });
});

describe("OpencodeCore.execute (ordering invariants from review)", () => {
  // Regression test for the §5.1 subscribe-then-prompt ordering invariant.
  // Earlier rev kicked off `consumeEventStream` (which awaits subscribe
  // internally) AND `session.prompt` concurrently — `event.subscribe()`
  // could lose the race against the prompt and miss the first
  // `message.part.delta` events. Now subscribe is awaited explicitly
  // before the prompt is sent.
  it("awaits event.subscribe BEFORE sending session.prompt", async () => {
    const order: string[] = [];
    const session: StubSession = {
      id: "ses_test_order",
      prompts: 0,
      deleted: false,
      aborted: false,
    };
    const client = {
      session: {
        create: async () => ({ data: { id: session.id } }),
        prompt: async () => {
          order.push("prompt");
          session.prompts += 1;
          return {
            data: {
              info: {
                cost: 0.0001,
                providerID: "anthropic",
                modelID: "claude-sonnet-4-6",
                tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
              },
              parts: [{ type: "text", text: "ok" }],
            },
          };
        },
        get: async () => ({ data: undefined }),
        delete: async () => ({}),
        abort: async () => ({}),
      },
      config: {
        providers: async () => ({
          data: { providers: [{ id: "anthropic", name: "Anthropic", source: "config" }], default: {} },
        }),
      },
      event: {
        subscribe: async () => {
          order.push("subscribe");
          async function* gen(): AsyncGenerator<unknown, void> {
            yield { type: "session.idle", properties: { sessionID: session.id } };
          }
          return { stream: gen() };
        },
      },
    } as unknown as OpencodeClient;
    const manager: OpencodeServerManager = {
      mode: "managed",
      async ensureConfig() {},
      async client() {
        return client;
      },
      async spawnEphemeral() {
        throw new Error("spawnEphemeral not implemented in this stub");
      },
      async shutdown() {},
    };
    const core = new OpencodeCore(makeConfig(), new AgentWriteTracker(), manager);
    await core.execute(makeExecuteParams());
    // The first call MUST be subscribe; only after it completes do we
    // hit prompt. Without this guarantee, early text deltas can flow
    // into a not-yet-bound stream.
    expect(order[0]).toBe("subscribe");
    expect(order[1]).toBe("prompt");
  });

  // Regression test for the prompt-fast-fail leak. Earlier rev never
  // aborted the consumer when `session.prompt` threw, so the for-await
  // loop hung waiting for `session.idle` until the wall-clock timeout
  // fired (default 5 minutes). The fix wires the abort signal so the
  // consumer drains immediately on prompt failure.
  it("releases the event consumer when session.prompt throws (no 5-minute hang)", async () => {
    let consumerExited = false;
    const session: StubSession = {
      id: "ses_test_fail",
      prompts: 0,
      deleted: false,
      aborted: false,
    };
    const client = {
      session: {
        create: async () => ({ data: { id: session.id } }),
        prompt: async () => {
          throw new Error("synthetic transport failure");
        },
        get: async () => ({ data: undefined }),
        delete: async () => ({}),
        abort: async () => ({}),
      },
      config: {
        providers: async () => ({
          data: { providers: [{ id: "anthropic", name: "Anthropic", source: "config" }], default: {} },
        }),
      },
      event: {
        subscribe: async (options?: { signal?: AbortSignal }) => {
          async function* gen(): AsyncGenerator<unknown, void> {
            // Yield zero events and wait — without an abort the consumer
            // would block indefinitely. The signal handler bridges the
            // abort so the for-await loop exits.
            await new Promise<void>((resolve) => {
              if (options?.signal?.aborted) {
                resolve();
                return;
              }
              options?.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
            consumerExited = true;
          }
          return { stream: gen() };
        },
      },
    } as unknown as OpencodeClient;
    const manager: OpencodeServerManager = {
      mode: "managed",
      async ensureConfig() {},
      async client() {
        return client;
      },
      async spawnEphemeral() {
        throw new Error("spawnEphemeral not implemented in this stub");
      },
      async shutdown() {},
    };
    const core = new OpencodeCore(
      // 60-min timeout — the test would hang if the leak weren't fixed.
      makeConfig({ executeTimeoutMinutes: 60 } as Partial<AgentConfig>),
      new AgentWriteTracker(),
      manager,
    );
    const start = Date.now();
    await expect(core.execute(makeExecuteParams())).rejects.toThrow(
      /synthetic transport failure/,
    );
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(consumerExited).toBe(true);
  });
});

describe("OpencodeCore — Phase 3 wiring", () => {
  it("passes per-session disallowedTools through to runtimeConfig.permission", async () => {
    let capturedConfig: unknown = null;
    const envelope: StubEnvelope = {
      events: [
        { type: "session.idle", properties: { sessionID: "ses_test_abc" } },
      ],
      promptResponse: {
        info: {
          cost: 0.0001,
          providerID: "anthropic",
          modelID: "claude-sonnet-4-6",
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [{ type: "text", text: "ok" }],
      },
    };
    const { manager: baseMgr } = makeStubManager(envelope);
    // Wrap the manager so we can sniff the runtime config that flows
    // through ensureConfig() — the §5.1 chokepoint.
    const manager: OpencodeServerManager = {
      mode: baseMgr.mode,
      ensureConfig: async (config) => {
        capturedConfig = config;
      },
      client: baseMgr.client.bind(baseMgr),
      spawnEphemeral: baseMgr.spawnEphemeral.bind(baseMgr),
      shutdown: baseMgr.shutdown.bind(baseMgr),
    };
    const core = new OpencodeCore(
      makeConfig({
        disallowedTools: ["Bash(npm publish *)"],
        opencodeExecutionPermissionMode: "strict",
      } as Partial<AgentConfig>),
      new AgentWriteTracker(),
      manager,
    );
    await core.execute(makeExecuteParams());
    const cfg = capturedConfig as { permission?: { bash?: Record<string, string> } };
    expect(cfg.permission?.bash?.["npm publish *"]).toBe("deny");
    // Absolute-block layer always merges on top of per-session denies.
    expect(cfg.permission?.bash?.["rm -rf *"]).toBe("deny");
  });

  it("two same-envelope executes produce identical runtime config (bounce avoidance)", async () => {
    const captured: unknown[] = [];
    const envelope: StubEnvelope = {
      events: [
        { type: "session.idle", properties: { sessionID: "ses_test_abc" } },
      ],
      promptResponse: {
        info: {
          cost: 0.0001,
          providerID: "anthropic",
          modelID: "claude-sonnet-4-6",
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [{ type: "text", text: "ok" }],
      },
    };
    const { manager: baseMgr } = makeStubManager(envelope);
    const manager: OpencodeServerManager = {
      mode: baseMgr.mode,
      ensureConfig: async (config) => {
        captured.push(config);
      },
      client: baseMgr.client.bind(baseMgr),
      spawnEphemeral: baseMgr.spawnEphemeral.bind(baseMgr),
      shutdown: baseMgr.shutdown.bind(baseMgr),
    };
    const core = new OpencodeCore(makeConfig(), new AgentWriteTracker(), manager);
    await core.execute(makeExecuteParams());
    await core.execute(makeExecuteParams());
    expect(captured).toHaveLength(2);
    // Deep-equal — the bounce-hash relies on this; if two same-envelope
    // configs diverged in any field the server would respawn every call.
    expect(JSON.stringify(captured[0])).toBe(JSON.stringify(captured[1]));
  });

  it("emits defensive instructions only when env flag is set", async () => {
    const original = process.env.PA_OPENCODE_DEFENSIVE_INSTRUCTIONS;
    try {
      process.env.PA_OPENCODE_DEFENSIVE_INSTRUCTIONS = "1";
      let capturedConfig: unknown = null;
      const envelope: StubEnvelope = {
        events: [
          { type: "session.idle", properties: { sessionID: "ses_test_abc" } },
        ],
        promptResponse: {
          info: {
            cost: 0.0001,
            providerID: "anthropic",
            modelID: "claude-sonnet-4-6",
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [{ type: "text", text: "ok" }],
        },
      };
      const { manager: baseMgr } = makeStubManager(envelope);
      const manager: OpencodeServerManager = {
        mode: baseMgr.mode,
        ensureConfig: async (config) => {
          capturedConfig = config;
        },
        client: baseMgr.client.bind(baseMgr),
        spawnEphemeral: baseMgr.spawnEphemeral.bind(baseMgr),
        shutdown: baseMgr.shutdown.bind(baseMgr),
      };
      const core = new OpencodeCore(makeConfig(), new AgentWriteTracker(), manager);
      await core.execute(makeExecuteParams());
      const cfg = capturedConfig as { instructions?: string[] };
      expect(cfg.instructions).toEqual(["AGENTS.md", ".opencode/agent/*.md"]);
    } finally {
      if (original === undefined) {
        delete process.env.PA_OPENCODE_DEFENSIVE_INSTRUCTIONS;
      } else {
        process.env.PA_OPENCODE_DEFENSIVE_INSTRUCTIONS = original;
      }
    }
  });
});

describe("auditOpencodeTools — synthetic absolute-block audit", () => {
  it("writes a blocked_absolute row for a bash rm -rf invocation", () => {
    const db = new Database(":memory:");
    applySchema(db);
    try {
      auditOpencodeTools(
        [
          {
            callId: "c1",
            toolName: "bash",
            status: "completed",
            input: { command: "rm -rf /" },
          },
        ],
        { db, mode: "strict", sessionId: null },
      );
      const rows = db
        .prepare(
          "SELECT action_type, trigger, result, backend, detail FROM agent_actions",
        )
        .all() as Array<{
          action_type: string;
          trigger: string;
          result: string;
          backend: string;
          detail: string;
        }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].action_type).toBe("blocked_absolute");
      expect(rows[0].trigger).toBe("absolute_block_stream_observation");
      expect(rows[0].result).toBe("partial");
      expect(rows[0].backend).toBe("opencode");
      const detail = JSON.parse(rows[0].detail);
      expect(detail.category).toBe("recursive_delete");
      expect(detail.observation).toBe("stream");
    } finally {
      db.close();
    }
  });

  it("does not write a row for benign bash invocations", () => {
    const db = new Database(":memory:");
    applySchema(db);
    try {
      auditOpencodeTools(
        [
          { callId: "c1", toolName: "bash", status: "completed", input: { command: "ls -la" } },
          { callId: "c2", toolName: "read", status: "completed", input: { filePath: "/tmp/x" } },
          { callId: "c3", toolName: "write", status: "completed", input: { filePath: "/tmp/y" } },
        ],
        { db, mode: "strict", sessionId: null },
      );
      const rows = db.prepare("SELECT id FROM agent_actions").all();
      expect(rows).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("writes a row for read on a secret path (extractOpencodeToolUseTarget → Read)", () => {
    const db = new Database(":memory:");
    applySchema(db);
    try {
      auditOpencodeTools(
        [
          {
            callId: "c1",
            toolName: "read",
            status: "completed",
            input: { filePath: "/Users/x/.ssh/id_rsa" },
          },
        ],
        { db, mode: "allow", sessionId: 99 },
      );
      const row = db
        .prepare(
          "SELECT detail FROM agent_actions WHERE action_type = 'blocked_absolute'",
        )
        .get() as { detail: string } | undefined;
      expect(row).toBeDefined();
      const detail = JSON.parse(row!.detail);
      expect(detail.category).toBe("secret_read");
      expect(detail.mode).toBe("allow");
      expect(detail.sessionId).toBe(99);
    } finally {
      db.close();
    }
  });

  it("ignores pending and running tool entries (input not yet final)", () => {
    const db = new Database(":memory:");
    applySchema(db);
    try {
      auditOpencodeTools(
        [
          { callId: "c1", toolName: "bash", status: "pending", input: { command: "rm -rf /" } },
          { callId: "c2", toolName: "bash", status: "running", input: { command: "rm -rf /" } },
        ],
        { db, mode: "strict", sessionId: null },
      );
      expect(db.prepare("SELECT id FROM agent_actions").all()).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("is a no-op when db is undefined", () => {
    expect(() =>
      auditOpencodeTools(
        [
          { callId: "c1", toolName: "bash", status: "completed", input: { command: "rm -rf /" } },
        ],
        { db: undefined, mode: "strict", sessionId: null },
      ),
    ).not.toThrow();
  });
});

describe("OpencodeCore.summarize — Phase 4 / V11 round-trip", () => {
  it("returns the assistant summary text from session.messages", async () => {
    let summarizeCalls = 0;
    const messages: Array<{
      info: { role: string; summary?: boolean };
      parts: Array<{ type: string; text: string }>;
    }> = [];
    const client = {
      session: {
        create: async () => ({ data: { id: "ses_summary" } }),
        prompt: async () => {
          // Simulate the priming turn — opencode returns a regular
          // assistant message; the summary is added by the subsequent
          // session.summarize() call, NOT by this prompt response.
          messages.push({
            info: { role: "user" },
            parts: [{ type: "text", text: "primer" }],
          });
          messages.push({
            info: { role: "assistant" },
            parts: [{ type: "text", text: "ok" }],
          });
          return {
            data: { info: {}, parts: [{ type: "text", text: "ok" }] },
          };
        },
        summarize: async () => {
          summarizeCalls += 1;
          // V11 — the call returns `{ data: true }` and the actual
          // summary is appended as a new assistant message marked
          // `info.summary = true`.
          messages.push({
            info: { role: "assistant", summary: true },
            parts: [{ type: "text", text: "Conversation summary: alice met bob." }],
          });
          return { data: true };
        },
        messages: async () => ({ data: messages }),
        delete: async () => ({}),
        get: async () => ({ data: undefined }),
        abort: async () => ({}),
      },
      config: {
        providers: async () => ({
          data: {
            providers: [{ id: "anthropic", name: "Anthropic", source: "config" }],
            default: { anthropic: "claude-haiku-4-5" },
          },
        }),
      },
      event: {
        subscribe: async () => {
          async function* gen(): AsyncGenerator<unknown, void> {}
          return { stream: gen() };
        },
      },
    } as unknown as OpencodeClient;
    const manager: OpencodeServerManager = {
      mode: "managed",
      async ensureConfig() {},
      async client() {
        return client;
      },
      async spawnEphemeral() {
        throw new Error("not used");
      },
      async shutdown() {},
    };
    const core = new OpencodeCore(makeConfig(), new AgentWriteTracker(), manager);
    const summary = await core.summarize(
      "alice met bob today, discussed project x.",
    );
    expect(summarizeCalls).toBe(1);
    expect(summary).toBe("Conversation summary: alice met bob.");
  });

  it("returns truncation fallback when no summary message lands", async () => {
    const messages: Array<{
      info: { role: string; summary?: boolean };
      parts: Array<{ type: string; text: string }>;
    }> = [];
    const client = {
      session: {
        create: async () => ({ data: { id: "ses_x" } }),
        prompt: async () => {
          messages.push({
            info: { role: "assistant" },
            parts: [{ type: "text", text: "ok" }],
          });
          return { data: { info: {}, parts: [] } };
        },
        // V11 returns true, but no assistant message with summary=true
        // is appended — the fallback contract returns the truncated
        // input rather than throwing.
        summarize: async () => ({ data: true }),
        messages: async () => ({ data: messages }),
        delete: async () => ({}),
      },
      config: {
        providers: async () => ({
          data: { providers: [{ id: "anthropic", name: "x", source: "config" }], default: {} },
        }),
      },
    } as unknown as OpencodeClient;
    const manager: OpencodeServerManager = {
      mode: "managed",
      async ensureConfig() {},
      async client() {
        return client;
      },
      async spawnEphemeral() {
        throw new Error("not used");
      },
      async shutdown() {},
    };
    const core = new OpencodeCore(makeConfig(), new AgentWriteTracker(), manager);
    const summary = await core.summarize("x".repeat(5000));
    // Fallback truncation contract — same shape as the Phase 2 stub.
    expect(summary.length).toBe(4096);
  });
});

describe("OpencodeCore.runDelegatedTask — Phase 4 (ephemeral isolation)", () => {
  it("runs against an ephemeral server with tight permission and returns ok", async () => {
    let capturedConfig: unknown = null;
    let ephemeralCloses = 0;
    const ephemeralClient = {
      session: {
        create: async () => ({ data: { id: "ses_delegated" } }),
        prompt: async () => ({
          data: {
            info: {
              cost: 0.0002,
              providerID: "anthropic",
              modelID: "claude-haiku-4-5",
              tokens: { input: 50, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
            },
            parts: [
              { type: "text", text: '{"items":["alpha","beta"]}' },
              {
                type: "tool",
                tool: "search_emails",
                callID: "call_a",
                state: { status: "completed", input: { query: "*" }, output: "ok", time: { start: 0, end: 5 } },
              },
            ],
          },
        }),
        delete: async () => ({}),
        abort: async () => ({}),
      },
      config: {
        providers: async () => ({
          data: { providers: [{ id: "anthropic", name: "x", source: "config" }], default: {} },
        }),
      },
      event: {
        subscribe: async () => {
          async function* gen(): AsyncGenerator<unknown, void> {}
          return { stream: gen() };
        },
      },
    } as unknown as OpencodeClient;
    const manager: OpencodeServerManager = {
      mode: "managed",
      async ensureConfig() {},
      async client() {
        return ephemeralClient;
      },
      async spawnEphemeral(config) {
        capturedConfig = config;
        return {
          client: ephemeralClient,
          close: async () => {
            ephemeralCloses += 1;
          },
        };
      },
      async shutdown() {},
    };
    const core = new OpencodeCore(makeConfig(), new AgentWriteTracker(), manager);
    const onSteps: string[] = [];
    const result = await core.runDelegatedTask({
      systemPrompt: "List emails matching *.",
      validate: () => true,
      validatorErrorMessage: () => "",
      allowedTools: ["search_emails"],
      destructiveTools: [],
      writeClassTools: [],
      modelId: "anthropic/claude-haiku-4-5",
      maxToolCalls: 10,
      maxBudgetUsd: 0.1,
      timeoutMs: 5000,
      allowDestructive: false,
      sessionDir: "/tmp/aitne-delegated-test",
      onToolStep: (step) => onSteps.push(step.toolName),
    });
    expect(result.ok).toBe(true);
    expect(ephemeralCloses).toBe(1);
    if (result.ok) {
      expect(result.rawAssistantText).toBe('{"items":["alpha","beta"]}');
      expect(result.trace).toHaveLength(1);
      expect(result.trace[0].toolName).toBe("search_emails");
    }
    // The tight permission JSON went through ensureConfig of the
    // ephemeral spawn — verify edit/webfetch flipped to deny.
    const cfg = capturedConfig as {
      permission?: { edit?: string; webfetch?: string; bash?: Record<string, string> };
      tools?: Record<string, boolean>;
    };
    expect(cfg.permission?.edit).toBe("deny");
    expect(cfg.permission?.webfetch).toBe("deny");
    expect(cfg.tools?.read).toBe(false);
    expect(cfg.tools?.write).toBe(false);
    expect(cfg.tools?.task).toBe(false);
    expect(onSteps).toEqual(["search_emails"]);
  });

  it("classifies a tool call outside the allowlist as policy_violation", async () => {
    const ephemeralClient = {
      session: {
        create: async () => ({ data: { id: "ses_policy" } }),
        prompt: async () => ({
          data: {
            info: {
              cost: 0,
              providerID: "anthropic",
              modelID: "claude-haiku-4-5",
              tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
            },
            parts: [
              { type: "text", text: "trying" },
              {
                type: "tool",
                tool: "send_email",
                callID: "call_x",
                state: { status: "completed", input: { to: "x" }, output: "ok" },
              },
            ],
          },
        }),
        delete: async () => ({}),
      },
      config: {
        providers: async () => ({
          data: { providers: [{ id: "anthropic", name: "x", source: "config" }], default: {} },
        }),
      },
    } as unknown as OpencodeClient;
    const manager: OpencodeServerManager = {
      mode: "managed",
      async ensureConfig() {},
      async client() {
        return ephemeralClient;
      },
      async spawnEphemeral() {
        return { client: ephemeralClient, close: async () => {} };
      },
      async shutdown() {},
    };
    const core = new OpencodeCore(makeConfig(), new AgentWriteTracker(), manager);
    const result = await core.runDelegatedTask({
      systemPrompt: "Read emails.",
      validate: () => true,
      validatorErrorMessage: () => "",
      allowedTools: ["search_emails"],
      destructiveTools: ["send_email"],
      writeClassTools: ["send_email"],
      modelId: "anthropic/claude-haiku-4-5",
      maxToolCalls: 10,
      maxBudgetUsd: 0.1,
      timeoutMs: 5000,
      allowDestructive: false,
      sessionDir: "/tmp/aitne-policy-test",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorClass).toBe("policy_violation");
      expect(result.message).toContain("send_email");
      expect(result.writeClassToolFired).toBe(true);
    }
  });
});

describe("OpencodeCore — routine.hourly_check.triage json_schema", () => {
  it("threads format into prompt body and reads info.structured back", async () => {
    let capturedBody: unknown = null;
    const client = {
      session: {
        create: async () => ({ data: { id: "ses_triage" } }),
        prompt: async (req: { body: unknown }) => {
          capturedBody = req.body;
          // V4 — when format.type === "json_schema" was sent, the
          // validated parsed object lives at info.structured (not in
          // text parts; the text part is empty).
          return {
            data: {
              info: {
                cost: 0.00005,
                providerID: "anthropic",
                modelID: "claude-haiku-4-5",
                finish: "stop",
                tokens: { input: 30, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
                structured: { action: "log_only", reason: "no signal" },
              },
              parts: [{ type: "text", text: "" }],
            },
          };
        },
        get: async () => ({ data: undefined }),
        delete: async () => ({}),
        abort: async () => ({}),
      },
      config: {
        providers: async () => ({
          data: { providers: [{ id: "anthropic", name: "x", source: "config" }], default: {} },
        }),
      },
      event: {
        subscribe: async () => {
          async function* gen(): AsyncGenerator<unknown, void> {
            yield { type: "session.idle", properties: { sessionID: "ses_triage" } };
          }
          return { stream: gen() };
        },
      },
    } as unknown as OpencodeClient;
    const manager: OpencodeServerManager = {
      mode: "managed",
      async ensureConfig() {},
      async client() {
        return client;
      },
      async spawnEphemeral() {
        throw new Error("not used");
      },
      async shutdown() {},
    };
    const core = new OpencodeCore(makeConfig(), new AgentWriteTracker(), manager);
    const result = await core.execute(
      makeExecuteParams({
        processKey: "routine.hourly_check.triage",
      }),
    );
    // The dispatcher's parseStage2Verdict reads result.output as text;
    // for the json_schema path opencode-core stringifies info.structured
    // back so the existing parser keeps working across backends.
    expect(result.output).toBe(
      '{"action":"log_only","reason":"no signal"}',
    );
    expect(JSON.parse(result.output)).toEqual({
      action: "log_only",
      reason: "no signal",
    });
    // The format envelope was applied to the prompt body.
    const body = capturedBody as { format?: { type?: string; retryCount?: number } };
    expect(body.format?.type).toBe("json_schema");
    expect(body.format?.retryCount).toBe(2);
  });

  it("raises BackendDecisiveFailure when info.structured is missing on a json_schema turn", async () => {
    const client = {
      session: {
        create: async () => ({ data: { id: "ses_missing" } }),
        prompt: async () => ({
          data: {
            info: {
              cost: 0,
              providerID: "anthropic",
              modelID: "claude-haiku-4-5",
              finish: "stop",
              tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              // no `structured` field — opencode's retryCount=2
              // exhausted server-side without producing a valid envelope.
            },
            parts: [{ type: "text", text: "" }],
          },
        }),
        get: async () => ({ data: undefined }),
        delete: async () => ({}),
        abort: async () => ({}),
      },
      config: {
        providers: async () => ({
          data: { providers: [{ id: "anthropic", name: "x", source: "config" }], default: {} },
        }),
      },
      event: {
        subscribe: async () => {
          async function* gen(): AsyncGenerator<unknown, void> {
            yield { type: "session.idle", properties: { sessionID: "ses_missing" } };
          }
          return { stream: gen() };
        },
      },
    } as unknown as OpencodeClient;
    const manager: OpencodeServerManager = {
      mode: "managed",
      async ensureConfig() {},
      async client() {
        return client;
      },
      async spawnEphemeral() {
        throw new Error("not used");
      },
      async shutdown() {},
    };
    const core = new OpencodeCore(makeConfig(), new AgentWriteTracker(), manager);
    await expect(
      core.execute(
        makeExecuteParams({
          processKey: "routine.hourly_check.triage",
        }),
      ),
    ).rejects.toBeInstanceOf(BackendDecisiveFailure);
  });
});
