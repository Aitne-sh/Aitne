import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../db/schema.js";
import { writeIntegrations } from "../db/integrations-store.js";
import type {
  DelegatedToolInvokeParams,
  DelegatedToolResult,
  IAgentCore,
} from "../core/agent-core.js";
import { DelegatedToolUnsupportedError } from "../core/agent-core.js";
import type { AgentConfig } from "../config.js";
import {
  DelegatedBackendInvoker,
  runProxyTempdirJanitor,
} from "./delegated-backend-invoker.js";

interface TestEnv {
  db: Database.Database;
  dataDir: string;
  workspaceDir: string;
  cleanup: () => void;
}

function makeEnv(): TestEnv {
  const dataDir = mkdtempSync(join(tmpdir(), "pa-proxy-data-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "pa-proxy-ws-"));
  // Plant a proxy profile so the invoker materializes the canonical body.
  const profilesDir = join(workspaceDir, "agent-assets", "agent-profiles");
  mkdirSync(profilesDir, { recursive: true });
  writeFileSync(
    join(profilesDir, "proxy.md"),
    "# Test Proxy Profile\nCall the named tool exactly once.",
    "utf-8",
  );
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return {
    db,
    dataDir,
    workspaceDir,
    cleanup: () => {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    },
  };
}

function makeConfig(env: TestEnv, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    dataDir: env.dataDir,
    workspaceDir: env.workspaceDir,
    delegatedProxyMaxConcurrent: 2,
    ...overrides,
  } as unknown as AgentConfig;
}

function setIntegrationDelegated(
  env: TestEnv,
  opts: { delegatedBackend?: "claude" | "codex" | "gemini" } = {},
): void {
  writeIntegrations(env.db, {
    gmail: {
      mode: "delegated",
      delegatedBackend: opts.delegatedBackend ?? "codex",
      deniedTools: [],
      lastChangedAt: new Date().toISOString(),
    },
  });
}

function makeStubCore(
  backendId: "claude" | "codex" | "gemini",
  impl: (params: DelegatedToolInvokeParams) => Promise<DelegatedToolResult> | DelegatedToolResult,
): IAgentCore {
  const core = {
    backendId,
    runDelegatedTool: vi.fn(async (params: DelegatedToolInvokeParams) => impl(params)),
    listModels: () => [
      {
        backendId,
        modelId: `${backendId}-light-model`,
        label: "light",
        tier: "light" as const,
        available: true,
      },
      {
        backendId,
        modelId: `${backendId}-heavy-model`,
        label: "heavy",
        tier: "heavy" as const,
        available: true,
      },
    ],
    // The other IAgentCore methods aren't called by the invoker; cast loosely.
  } as unknown as IAgentCore;
  return core;
}

function readActions(db: Database.Database): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT id, action_type, backend, model_used, result, error,
              cost_usd, tokens_input, tokens_output, num_turns,
              duration_ms, event_id, trigger, detail
       FROM agent_actions WHERE action_type = 'delegated_proxy.invoke'
       ORDER BY id ASC`,
    )
    .all() as Array<Record<string, unknown>>;
}

let env: TestEnv;

beforeEach(() => {
  env = makeEnv();
});

afterEach(() => {
  env.cleanup();
});

// ── Happy path ───────────────────────────────────────────────────────────────

describe("DelegatedBackendInvoker happy path", () => {
  it("returns the tool result, materializes a proxy session, cleans it up, and writes a success row", async () => {
    setIntegrationDelegated(env);
    let observedSessionDir: string | null = null;
    let sessionContents: string | null = null;
    const core = makeStubCore("codex", (params) => {
      observedSessionDir = params.sessionDir;
      sessionContents = readFileSync(join(params.sessionDir, "AGENTS.md"), "utf-8");
      return {
        ok: true,
        toolResult: { messages: ["hello"] },
        cost: {
          tokensInput: 100,
          tokensOutput: 50,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          costUsd: 0.0123,
          durationMs: 800,
          numTurns: 1,
        },
      };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env),
      cores: { codex: core },
    });

    const result = await invoker.invoke({
      integrationKey: "gmail",
      toolName: "mcp__codex_apps__gmail._search_emails",
      toolArgs: { query: "from:alice", limit: 5 },
      parentEventId: "evt-123",
      parentProcessKey: "message.dm",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.toolResult).toEqual({ messages: ["hello"] });
      expect(result.cost.costUsd).toBeCloseTo(0.0123);
      // Phase C resolver: with no `delegatedModel` pin, the invoker uses
      // the canonical light-tier model from the static registry — for
      // codex that's `gpt-5.4-mini`. The stub core's `listModels` is
      // only consulted as a last-resort fallback when the registry has
      // no entry, so the stub's `codex-light-model` never wins here.
      expect(result.modelId).toBe("gpt-5.4-mini");
      expect(result.backendId).toBe("codex");
    }
    expect(observedSessionDir).toBeTruthy();
    expect(observedSessionDir!.startsWith(join(env.dataDir, "agent-sessions", "proxy-"))).toBe(true);
    // Cleanup happened in finally.
    expect(existsSync(observedSessionDir!)).toBe(false);
    // Materialized the proxy profile into the codex-shaped instruction file.
    expect(sessionContents).toContain("Test Proxy Profile");

    const rows = readActions(env.db);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.action_type).toBe("delegated_proxy.invoke");
    expect(row.backend).toBe("codex");
    expect(row.model_used).toBe("gpt-5.4-mini");
    expect(row.result).toBe("success");
    expect(row.cost_usd).toBeCloseTo(0.0123);
    expect(row.tokens_input).toBe(100);
    expect(row.tokens_output).toBe(50);
    expect(row.num_turns).toBe(1);
    expect(row.event_id).toBe("evt-123");
    expect(row.trigger).toBe("message.dm");
    const detail = JSON.parse(row.detail as string) as Record<string, unknown>;
    expect(detail.integrationKey).toBe("gmail");
    expect(detail.toolName).toBe("mcp__codex_apps__gmail._search_emails");
    expect(detail.toolArgsHash).toMatch(/^[0-9a-f]{16}$/);
    expect(detail.errorClass).toBeUndefined();
  });

  it("uses an injected resolveProxyModel callback when provided", async () => {
    setIntegrationDelegated(env);
    const core = makeStubCore("codex", () => ({
      ok: true,
      toolResult: {},
      cost: zeroCost(),
    }));
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env),
      cores: { codex: core },
      resolveProxyModel: (key, backend) => `injected-${key}-${backend}`,
    });
    const result = await invoker.invoke({
      integrationKey: "gmail",
      toolName: "tool",
      toolArgs: {},
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.modelId).toBe("injected-gmail-codex");
  });

  it("honours InvokeParams.modelOverride above the user pin and the canonical fallback", async () => {
    // Cadence path (`delegated-sync-worker`) pins medium tier per call so
    // the cadence does not regress to lite tier just because an operator
    // pinned Haiku for synchronous skill calls. The override only wins if
    // it is a registered model for the resolved backend.
    writeIntegrations(env.db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "codex",
        delegatedModel: "gpt-5.4-mini", // user pin we are overriding
        deniedTools: [],
        lastChangedAt: new Date().toISOString(),
      },
    });
    let observedModelId: string | null = null;
    const core = makeStubCore("codex", (params) => {
      observedModelId = params.modelId;
      return {
        ok: true,
        toolResult: null,
        cost: zeroCost(),
      };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env),
      cores: { codex: core },
    });
    const result = await invoker.invoke({
      integrationKey: "gmail",
      toolName: "t",
      toolArgs: {},
      modelOverride: "gpt-5.5",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.modelId).toBe("gpt-5.5");
    expect(observedModelId).toBe("gpt-5.5");
  });

  it("falls through to the user pin when modelOverride is not registered for the backend", async () => {
    writeIntegrations(env.db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "codex",
        delegatedModel: "gpt-5.5",
        deniedTools: [],
        lastChangedAt: new Date().toISOString(),
      },
    });
    const core = makeStubCore("codex", () => ({
      ok: true,
      toolResult: null,
      cost: zeroCost(),
    }));
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env),
      cores: { codex: core },
    });
    const result = await invoker.invoke({
      integrationKey: "gmail",
      toolName: "t",
      toolArgs: {},
      // unknown id — must not silently leak to the core; cascade to user pin.
      modelOverride: "claude-sonnet-4-6",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.modelId).toBe("gpt-5.5");
  });
});

// ── Failure paths ────────────────────────────────────────────────────────────

describe("DelegatedBackendInvoker failure paths", () => {
  it("rejects when integration is not in delegated mode", async () => {
    // Default integrations map has gmail.mode = 'disabled'
    const core = makeStubCore("codex", () => ({
      ok: true,
      toolResult: null,
      cost: zeroCost(),
    }));
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env),
      cores: { codex: core },
    });
    const result = await invoker.invoke({
      integrationKey: "gmail",
      toolName: "tool",
      toolArgs: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorClass).toBe("precondition");
    // Precondition errors short-circuit before tempdir + cost record.
    expect(readActions(env.db)).toHaveLength(0);
    expect(core.runDelegatedTool).not.toHaveBeenCalled();
  });

  it("rejects when the delegated backend has no registered core", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "claude" });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env),
      cores: {}, // claude not registered
    });
    const result = await invoker.invoke({
      integrationKey: "gmail",
      toolName: "tool",
      toolArgs: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorClass).toBe("precondition");
  });

  it("records a failed row + cost when the tool returns an error", async () => {
    setIntegrationDelegated(env);
    const core = makeStubCore("codex", () => ({
      ok: false,
      errorClass: "tool_error",
      message: "Gmail rejected: invalid query",
      cost: {
        tokensInput: 50,
        tokensOutput: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0.001,
        durationMs: 200,
        numTurns: 1,
      },
    }));
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env),
      cores: { codex: core },
    });
    const result = await invoker.invoke({
      integrationKey: "gmail",
      toolName: "tool",
      toolArgs: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorClass).toBe("tool_error");
      expect(result.message).toContain("Gmail rejected");
      expect(result.cost?.costUsd).toBeCloseTo(0.001);
    }
    const rows = readActions(env.db);
    expect(rows).toHaveLength(1);
    expect(rows[0].result).toBe("failed");
    expect(rows[0].cost_usd).toBeCloseTo(0.001);
    const detail = JSON.parse(rows[0].detail as string) as Record<string, unknown>;
    expect(detail.errorClass).toBe("tool_error");
  });

  it.each(["no_tool_call", "wrong_tool", "parse_error", "auth_error"] as const)(
    "propagates errorClass=%s and partial cost",
    async (errorClass) => {
      setIntegrationDelegated(env);
      const core = makeStubCore("codex", () => ({
        ok: false,
        errorClass,
        message: `simulated ${errorClass}`,
        cost: {
          tokensInput: 30,
          tokensOutput: 10,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          costUsd: 0.0005,
          durationMs: 120,
          numTurns: 1,
        },
      }));
      const invoker = new DelegatedBackendInvoker({
        db: env.db,
        config: makeConfig(env),
        cores: { codex: core },
      });
      const result = await invoker.invoke({
        integrationKey: "gmail",
        toolName: "tool",
        toolArgs: {},
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errorClass).toBe(errorClass);
      const rows = readActions(env.db);
      expect(rows).toHaveLength(1);
      expect(rows[0].cost_usd).toBeCloseTo(0.0005);
    },
  );

  it("classifies a thrown DelegatedToolUnsupportedError as 'unimplemented' and writes a zero-cost row", async () => {
    setIntegrationDelegated(env);
    const core = {
      backendId: "codex" as const,
      runDelegatedTool: vi.fn(async () => {
        throw new DelegatedToolUnsupportedError("codex", "stub");
      }),
      listModels: () => [],
    } as unknown as IAgentCore;
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env),
      cores: { codex: core },
    });
    const result = await invoker.invoke({
      integrationKey: "gmail",
      toolName: "tool",
      toolArgs: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorClass).toBe("unimplemented");
    const rows = readActions(env.db);
    expect(rows).toHaveLength(1);
    expect(rows[0].result).toBe("failed");
    expect(rows[0].cost_usd).toBe(0);
    const detail = JSON.parse(rows[0].detail as string) as Record<string, unknown>;
    expect(detail.errorClass).toBe("unimplemented");
  });

  it("classifies an unexpected exception as 'subprocess_crashed'", async () => {
    setIntegrationDelegated(env);
    const core = makeStubCore("codex", () => {
      throw new Error("kaboom");
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env),
      cores: { codex: core },
    });
    const result = await invoker.invoke({
      integrationKey: "gmail",
      toolName: "tool",
      toolArgs: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorClass).toBe("subprocess_crashed");
      expect(result.message).toContain("kaboom");
    }
  });

  it("cleans up the tempdir even when the core throws", async () => {
    setIntegrationDelegated(env);
    let observed: string | null = null;
    const core = makeStubCore("codex", (params) => {
      observed = params.sessionDir;
      expect(existsSync(params.sessionDir)).toBe(true);
      throw new Error("boom");
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env),
      cores: { codex: core },
    });
    await invoker.invoke({
      integrationKey: "gmail",
      toolName: "tool",
      toolArgs: {},
    });
    expect(observed).toBeTruthy();
    expect(existsSync(observed!)).toBe(false);
  });

  it("classifies the wall-clock timeout as 'timeout', distinct from a generic crash", async () => {
    vi.useFakeTimers();
    setIntegrationDelegated(env);
    let abortReason: unknown = null;
    const core = makeStubCore("codex", (params) =>
      new Promise<DelegatedToolResult>((_, reject) => {
        params.abortSignal?.addEventListener("abort", () => {
          abortReason = params.abortSignal!.reason;
          reject(new Error("aborted by timeout"));
        });
      }),
    );
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env),
      cores: { codex: core },
      defaults: { callTimeoutMs: 1_000 },
    });
    const promise = invoker.invoke({
      integrationKey: "gmail",
      toolName: "tool",
      toolArgs: {},
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await promise;
    vi.useRealTimers();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorClass).toBe("timeout");
    expect(abortReason).toBeInstanceOf(Error);
    // Wall-clock timer aborts with a `DelegatedProxyTimeoutError` instance,
    // not a string-tagged generic Error — the sentinel class is what the
    // backends classify against (see classifyAbortReason).
    expect((abortReason as Error).name).toBe("DelegatedProxyTimeoutError");
    // The recorded row carries the same classification so the dashboard's
    // failure-reason facet doesn't conflate timeouts with subprocess crashes.
    const rows = readActions(env.db);
    expect(rows).toHaveLength(1);
    const detail = JSON.parse(rows[0].detail as string) as Record<string, unknown>;
    expect(detail.errorClass).toBe("timeout");
  });
});

// ── Concurrency ──────────────────────────────────────────────────────────────

describe("DelegatedBackendInvoker concurrency limiter", () => {
  it("queues invocations beyond the cap and processes them FIFO", async () => {
    setIntegrationDelegated(env);
    const order: string[] = [];
    const releases: Array<() => void> = [];
    const core = makeStubCore("codex", () =>
      new Promise<DelegatedToolResult>((resolve) => {
        releases.push(() => {
          resolve({
            ok: true,
            toolResult: null,
            cost: zeroCost(),
          });
        });
      }),
    );
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env, { delegatedProxyMaxConcurrent: 1 }),
      cores: { codex: core },
    });

    const launch = (id: string) =>
      invoker
        .invoke({ integrationKey: "gmail", toolName: id, toolArgs: {} })
        .then(() => order.push(id));

    const p1 = launch("first");
    // Yield once to let p1 acquire the permit.
    await Promise.resolve();
    const p2 = launch("second");
    const p3 = launch("third");

    expect(invoker.inflightCount).toBe(1);
    expect(invoker.queueDepth).toBe(2);

    releases[0]();
    await p1;
    expect(order).toEqual(["first"]);

    // Wait one microtask tick for the queued waiter to promote.
    await Promise.resolve();
    releases[1]();
    await p2;
    expect(order).toEqual(["first", "second"]);

    await Promise.resolve();
    releases[2]();
    await p3;
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("times out queued waiters with delegated_proxy_busy and zero-cost row", async () => {
    vi.useFakeTimers();
    setIntegrationDelegated(env);
    let release: (() => void) | null = null;
    const core = makeStubCore("codex", () =>
      new Promise<DelegatedToolResult>((resolve) => {
        release = () =>
          resolve({
            ok: true,
            toolResult: null,
            cost: zeroCost(),
          });
      }),
    );
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env, { delegatedProxyMaxConcurrent: 1 }),
      cores: { codex: core },
      defaults: { queueWaitTimeoutMs: 500, callTimeoutMs: 60_000 },
    });

    const inflight = invoker.invoke({
      integrationKey: "gmail",
      toolName: "first",
      toolArgs: {},
    });
    await Promise.resolve();
    const queued = invoker.invoke({
      integrationKey: "gmail",
      toolName: "second",
      toolArgs: {},
    });

    await vi.advanceTimersByTimeAsync(500);
    const queuedResult = await queued;
    expect(queuedResult.ok).toBe(false);
    if (!queuedResult.ok) {
      expect(queuedResult.errorClass).toBe("delegated_proxy_busy");
    }

    release!();
    await inflight;
    vi.useRealTimers();

    const rows = readActions(env.db);
    expect(rows).toHaveLength(2);
    const busy = rows.find((r) => {
      const detail = JSON.parse(r.detail as string) as Record<string, unknown>;
      return detail.errorClass === "delegated_proxy_busy";
    });
    expect(busy).toBeTruthy();
    expect(busy!.cost_usd).toBe(0);
  });

  it("re-checks integration state after the queue wait — flip-to-disabled mid-flight rejects with precondition + recorded row", async () => {
    setIntegrationDelegated(env);
    let releaseInflight: (() => void) | null = null;
    const core = makeStubCore("codex", () =>
      new Promise<DelegatedToolResult>((resolve) => {
        releaseInflight = () =>
          resolve({
            ok: true,
            toolResult: null,
            cost: zeroCost(),
          });
      }),
    );
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env, { delegatedProxyMaxConcurrent: 1 }),
      cores: { codex: core },
    });

    // First request takes the only permit and parks; second waits in queue.
    const inflight = invoker.invoke({
      integrationKey: "gmail",
      toolName: "first",
      toolArgs: {},
    });
    await Promise.resolve();
    const queued = invoker.invoke({
      integrationKey: "gmail",
      toolName: "second",
      toolArgs: {},
    });

    expect(invoker.queueDepth).toBe(1);

    // User flips the integration off while the second request waits.
    writeIntegrations(env.db, {
      gmail: {
        mode: "disabled",
        delegatedBackend: null,
        deniedTools: [],
        lastChangedAt: new Date().toISOString(),
      },
    });

    // Release the inflight call; the queued waiter wakes and re-checks state.
    releaseInflight!();
    await inflight;
    const queuedResult = await queued;

    expect(queuedResult.ok).toBe(false);
    if (!queuedResult.ok) {
      expect(queuedResult.errorClass).toBe("precondition");
      expect(queuedResult.message).toContain("state changed during queue wait");
    }

    const rows = readActions(env.db);
    // First call succeeded (1 row) + second got a precondition failure (1 row)
    expect(rows).toHaveLength(2);
    const flipped = rows.find((r) => r.result === "failed");
    expect(flipped).toBeTruthy();
    const detail = JSON.parse(flipped!.detail as string) as Record<string, unknown>;
    expect(detail.errorClass).toBe("precondition");
    expect(flipped!.cost_usd).toBe(0);
    // The post-permit precondition row carries the prior backend so the
    // dashboard can attribute the wasted slot.
    expect(flipped!.backend).toBe("codex");
    // Tool was not invoked for the second request (its slot was wasted).
    expect(core.runDelegatedTool).toHaveBeenCalledTimes(1);
  });

  it("re-checks integration state after the queue wait — flip-to-different-backend uses the new core", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "codex" });
    let releaseInflight: (() => void) | null = null;
    const codexCore = makeStubCore("codex", () =>
      new Promise<DelegatedToolResult>((resolve) => {
        releaseInflight = () =>
          resolve({ ok: true, toolResult: null, cost: zeroCost() });
      }),
    );
    const claudeCore = makeStubCore("claude", () => ({
      ok: true,
      toolResult: { picked: "claude" },
      cost: zeroCost(),
    }));
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env, { delegatedProxyMaxConcurrent: 1 }),
      cores: { codex: codexCore, claude: claudeCore },
    });

    const inflight = invoker.invoke({
      integrationKey: "gmail",
      toolName: "first",
      toolArgs: {},
    });
    await Promise.resolve();
    const queued = invoker.invoke({
      integrationKey: "gmail",
      toolName: "second",
      toolArgs: {},
    });
    expect(invoker.queueDepth).toBe(1);

    // Mid-queue, user switches the delegated backend codex → claude.
    writeIntegrations(env.db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: new Date().toISOString(),
      },
    });

    releaseInflight!();
    await inflight;
    const queuedResult = await queued;

    expect(queuedResult.ok).toBe(true);
    if (queuedResult.ok) {
      expect(queuedResult.backendId).toBe("claude");
      expect(queuedResult.toolResult).toEqual({ picked: "claude" });
    }
    expect(claudeCore.runDelegatedTool).toHaveBeenCalledTimes(1);
    // Codex core was used only by the first (already-acquired) request.
    expect(codexCore.runDelegatedTool).toHaveBeenCalledTimes(1);
  });

  it("falls back to defaults when delegatedProxyMaxConcurrent is missing/invalid", async () => {
    setIntegrationDelegated(env);
    const core = makeStubCore("codex", () => ({
      ok: true,
      toolResult: null,
      cost: zeroCost(),
    }));
    const config = {
      dataDir: env.dataDir,
      workspaceDir: env.workspaceDir,
      // delegatedProxyMaxConcurrent intentionally omitted
    } as unknown as AgentConfig;
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config,
      cores: { codex: core },
    });
    const result = await invoker.invoke({
      integrationKey: "gmail",
      toolName: "x",
      toolArgs: {},
    });
    expect(result.ok).toBe(true);
  });
});

// ── Janitor ──────────────────────────────────────────────────────────────────

describe("runProxyTempdirJanitor", () => {
  it("removes proxy-* dirs older than the threshold and leaves fresh ones alone", () => {
    const sessions = join(env.dataDir, "agent-sessions");
    mkdirSync(sessions, { recursive: true });
    const stale = join(sessions, "proxy-stale");
    const fresh = join(sessions, "proxy-fresh");
    const sibling = join(sessions, "12345"); // existing event-session — must not touch
    mkdirSync(stale);
    mkdirSync(fresh);
    mkdirSync(sibling);

    const ageSec = 10 * 60; // 10 min ago
    const past = (Date.now() - ageSec * 1000) / 1000;
    utimesSync(stale, past, past);

    const removed = runProxyTempdirJanitor(env.dataDir);
    expect(removed).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(sibling)).toBe(true);
  });

  it("returns 0 when the sessions root does not exist", () => {
    const removed = runProxyTempdirJanitor(join(env.dataDir, "nonexistent"));
    expect(removed).toBe(0);
  });

  it("ignores non-directory entries with the proxy- prefix", () => {
    const sessions = join(env.dataDir, "agent-sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "proxy-not-a-dir"), "");
    const removed = runProxyTempdirJanitor(env.dataDir, { maxAgeMs: 0 });
    expect(removed).toBe(0);
    expect(existsSync(join(sessions, "proxy-not-a-dir"))).toBe(true);
  });

  it("respects an injected now() so test clocks are deterministic", () => {
    const sessions = join(env.dataDir, "agent-sessions");
    mkdirSync(sessions, { recursive: true });
    const dir = join(sessions, "proxy-x");
    mkdirSync(dir);
    const stat = statSync(dir);
    // Simulate looking at the system 1ms after creation — should be skipped.
    expect(
      runProxyTempdirJanitor(env.dataDir, {
        now: () => stat.mtimeMs + 1,
        maxAgeMs: 60_000,
      }),
    ).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });
});

// ── Edge cases for full branch coverage ──────────────────────────────────────

describe("DelegatedBackendInvoker edge cases", () => {
  it("classifies null DelegatedToolResult as parse_error (defensive)", async () => {
    setIntegrationDelegated(env);
    const core = makeStubCore("codex", () => null as unknown as DelegatedToolResult);
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env),
      cores: { codex: core },
    });
    const result = await invoker.invoke({
      integrationKey: "gmail",
      toolName: "tool",
      toolArgs: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorClass).toBe("parse_error");
  });

  it("aborts immediately if caller's abortSignal is already aborted", async () => {
    setIntegrationDelegated(env);
    let observedAbort: unknown = null;
    const core = makeStubCore("codex", (params) => {
      observedAbort = params.abortSignal?.aborted;
      return { ok: true, toolResult: null, cost: zeroCost() };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env),
      cores: { codex: core },
    });
    const ac = new AbortController();
    ac.abort(new Error("caller cancelled"));
    await invoker.invoke({
      integrationKey: "gmail",
      toolName: "tool",
      toolArgs: {},
      abortSignal: ac.signal,
    });
    expect(observedAbort).toBe(true);
  });

  it("propagates a mid-flight abort from the caller's signal", async () => {
    setIntegrationDelegated(env);
    let abortReason: unknown = null;
    const core = makeStubCore("codex", (params) =>
      new Promise<DelegatedToolResult>((_, reject) => {
        params.abortSignal?.addEventListener("abort", () => {
          abortReason = params.abortSignal!.reason;
          reject(new Error("caller aborted"));
        });
      }),
    );
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env),
      cores: { codex: core },
    });
    const ac = new AbortController();
    const promise = invoker.invoke({
      integrationKey: "gmail",
      toolName: "tool",
      toolArgs: {},
      abortSignal: ac.signal,
    });
    // Yield once to let the runDelegatedTool register its listener.
    await Promise.resolve();
    ac.abort(new Error("caller cancelled mid-flight"));
    const result = await promise;
    expect(result.ok).toBe(false);
    expect((abortReason as Error).message).toBe("caller cancelled mid-flight");
  });

  it("uses the registry canonical model regardless of what the core advertises (Phase C resolver)", async () => {
    // Phase A's resolver consulted `core.listModels()` first; Phase C
    // (DELEGATED-PROXY-API-DESIGN.md §4.2) inverts that — the canonical
    // light-tier model from the static MODEL_REGISTRY is the source of
    // truth, with `core.listModels()` only kicking in when the registry
    // has nothing for the backend. This test pins the new precedence so
    // a future refactor doesn't silently regress to the old order.
    setIntegrationDelegated(env);
    const core = {
      backendId: "codex" as const,
      runDelegatedTool: vi.fn(async () => ({
        ok: true,
        toolResult: null,
        cost: zeroCost(),
      })),
      listModels: () => [
        {
          backendId: "codex" as const,
          modelId: "codex-only-heavy",
          label: "heavy",
          tier: "heavy" as const,
          available: true,
        },
      ],
    } as unknown as IAgentCore;
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env),
      cores: { codex: core },
    });
    const result = await invoker.invoke({
      integrationKey: "gmail",
      toolName: "t",
      toolArgs: {},
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.modelId).toBe("gpt-5.4-mini");
  });

  it("uses an explicit user pin from delegatedModel even when the registry would suggest something else", async () => {
    // Phase C §4.2 — the user's `delegatedModel` pin wins when the
    // registry / DB knows it. Validate with a pin that's a real codex
    // light model registered under a different name from the canonical
    // pick (`gpt-5.4-mini` is canonical; we pin `gpt-5.5` instead).
    writeIntegrations(env.db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "codex",
        delegatedModel: "gpt-5.5",
        deniedTools: [],
        lastChangedAt: new Date().toISOString(),
      },
    });
    let observedModelId: string | null = null;
    const core = makeStubCore("codex", (params) => {
      observedModelId = params.modelId;
      return {
        ok: true,
        toolResult: null,
        cost: zeroCost(),
      };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env),
      cores: { codex: core },
    });
    const result = await invoker.invoke({
      integrationKey: "gmail",
      toolName: "t",
      toolArgs: {},
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.modelId).toBe("gpt-5.5");
    expect(observedModelId).toBe("gpt-5.5");
  });

  it("silently drops a stale pin when the registry no longer recognises the model id (canonical fallback)", async () => {
    // Phase C §4.2 — after a `delegatedBackend` swap a leftover pin from
    // the previous backend stays on disk. The resolver must NOT pass it
    // through to the core; instead it falls through to the canonical
    // light-tier model. Dashboard surfaces the staleness separately.
    writeIntegrations(env.db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "codex",
        delegatedModel: "claude-opus-4-7", // wrong backend
        deniedTools: [],
        lastChangedAt: new Date().toISOString(),
      },
    });
    const core = makeStubCore("codex", () => ({
      ok: true,
      toolResult: null,
      cost: zeroCost(),
    }));
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env),
      cores: { codex: core },
    });
    const result = await invoker.invoke({
      integrationKey: "gmail",
      toolName: "t",
      toolArgs: {},
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.modelId).toBe("gpt-5.4-mini");
  });

  it("hashArgs returns 'unhashable' for circular references in detail", async () => {
    setIntegrationDelegated(env);
    const core = makeStubCore("codex", () => ({
      ok: true,
      toolResult: null,
      cost: zeroCost(),
    }));
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env),
      cores: { codex: core },
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await invoker.invoke({
      integrationKey: "gmail",
      toolName: "t",
      toolArgs: circular,
    });
    const rows = readActions(env.db);
    const detail = JSON.parse(rows[0].detail as string) as Record<string, unknown>;
    expect(detail.toolArgsHash).toBe("unhashable");
  });

  it("survives a recordAction INSERT failure without throwing", async () => {
    setIntegrationDelegated(env);
    const core = makeStubCore("codex", () => ({
      ok: true,
      toolResult: { x: 1 },
      cost: zeroCost(),
    }));
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env),
      cores: { codex: core },
    });
    // Spy on prepare AFTER the integration read so only the INSERT throws.
    const realPrepare = env.db.prepare.bind(env.db);
    const prepareSpy = vi.spyOn(env.db, "prepare").mockImplementation(
      ((sql: string) => {
        if (sql.includes("INSERT INTO agent_actions")) {
          throw new Error("simulated INSERT failure");
        }
        return realPrepare(sql);
      }) as unknown as typeof env.db.prepare,
    );
    const result = await invoker.invoke({
      integrationKey: "gmail",
      toolName: "t",
      toolArgs: {},
    });
    prepareSpy.mockRestore();
    // Tool result still propagated to the caller; failure was swallowed
    // so it could not corrupt the success response.
    expect(result.ok).toBe(true);
  });

  it("janitor catches readdir failures and returns 0", () => {
    const badDataDir = join(env.dataDir, "x");
    const sessions = join(badDataDir, "agent-sessions");
    mkdirSync(sessions, { recursive: true });
    // Replace the directory with a plain file so readdir throws ENOTDIR.
    rmSync(sessions, { recursive: true, force: true });
    writeFileSync(sessions, "");
    expect(runProxyTempdirJanitor(badDataDir)).toBe(0);
  });

  it("janitor skips entries whose stat() throws", async () => {
    const { symlinkSync, lstatSync } = await import("node:fs");
    const sessions = join(env.dataDir, "agent-sessions");
    mkdirSync(sessions, { recursive: true });
    const dir = join(sessions, "proxy-vanish");
    mkdirSync(dir);
    // A broken symlink with the proxy- prefix forces statSync to throw.
    const broken = join(sessions, "proxy-broken");
    symlinkSync(join(env.dataDir, "does-not-exist"), broken);
    // Force the dir to be older so the rmSync branch is at least eligible.
    const past = (Date.now() - 60 * 60 * 1000) / 1000;
    utimesSync(dir, past, past);
    const removed = runProxyTempdirJanitor(env.dataDir);
    expect(removed).toBe(1); // proxy-vanish removed; broken symlink skipped
    // Symlink itself still on disk (lstatSync inspects the link, not target).
    expect(() => lstatSync(broken)).not.toThrow();
  });
});

// ── Materialization fallback ─────────────────────────────────────────────────

describe("DelegatedBackendInvoker materialization", () => {
  it("uses the inline fallback profile when proxy.md is missing", async () => {
    rmSync(join(env.workspaceDir, "agent-assets", "agent-profiles", "proxy.md"));
    setIntegrationDelegated(env, { delegatedBackend: "claude" });
    let body: string | null = null;
    const core = makeStubCore("claude", (params) => {
      body = readFileSync(join(params.sessionDir, "CLAUDE.md"), "utf-8");
      return { ok: true, toolResult: null, cost: zeroCost() };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env),
      cores: { claude: core },
    });
    const result = await invoker.invoke({
      integrationKey: "gmail",
      toolName: "tool",
      toolArgs: {},
    });
    expect(result.ok).toBe(true);
    expect(body).toContain("Delegated Proxy");
  });

  it("writes the gemini-shaped instruction file for gemini delegated backend", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "gemini" });
    let observed: string | null = null;
    const core = makeStubCore("gemini", (params) => {
      observed = params.sessionDir;
      expect(existsSync(join(params.sessionDir, "GEMINI.md"))).toBe(true);
      return { ok: true, toolResult: null, cost: zeroCost() };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env),
      cores: { gemini: core },
    });
    await invoker.invoke({
      integrationKey: "gmail",
      toolName: "tool",
      toolArgs: {},
    });
    expect(observed).toBeTruthy();
  });
});

// ── delegatedMaxTurns resolution (DELEGATED-PROXY-API-DESIGN.md §4.2) ───────

describe("DelegatedBackendInvoker delegatedMaxTurns", () => {
  it("uses the registry default (DELEGATED_PROXY_DEFAULTS.maxTurns = 4) when state.delegatedMaxTurns is unset", async () => {
    setIntegrationDelegated(env);
    let received: number | null = null;
    const core = makeStubCore("codex", (params) => {
      received = params.maxTurns;
      return { ok: true, toolResult: null, cost: zeroCost() };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env),
      cores: { codex: core },
    });
    const result = await invoker.invoke({
      integrationKey: "gmail",
      toolName: "tool",
      toolArgs: {},
    });
    expect(result.ok).toBe(true);
    // Bumped 2 → 4 (2026-04-29) — see delegated-proxy-config.ts comment.
    expect(received).toBe(4);
  });

  it("respects an explicit state.delegatedMaxTurns override", async () => {
    writeIntegrations(env.db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "codex",
        delegatedMaxTurns: 5,
        deniedTools: [],
        lastChangedAt: new Date().toISOString(),
      },
    });
    let received: number | null = null;
    const core = makeStubCore("codex", (params) => {
      received = params.maxTurns;
      return { ok: true, toolResult: null, cost: zeroCost() };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env),
      cores: { codex: core },
    });
    await invoker.invoke({
      integrationKey: "gmail",
      toolName: "tool",
      toolArgs: {},
    });
    expect(received).toBe(5);
  });

  it("uses the lower bound (1) when state.delegatedMaxTurns is at the floor", async () => {
    writeIntegrations(env.db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "codex",
        delegatedMaxTurns: 1,
        deniedTools: [],
        lastChangedAt: new Date().toISOString(),
      },
    });
    let received: number | null = null;
    const core = makeStubCore("codex", (params) => {
      received = params.maxTurns;
      return { ok: true, toolResult: null, cost: zeroCost() };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeConfig(env),
      cores: { codex: core },
    });
    await invoker.invoke({
      integrationKey: "gmail",
      toolName: "tool",
      toolArgs: {},
    });
    expect(received).toBe(1);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function zeroCost() {
  return {
    tokensInput: 0,
    tokensOutput: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    durationMs: 0,
    numTurns: 0,
  };
}

// ── DELEGATED-TASK-MODE-DESIGN.md §4.1 — invoker.task tests ──────────────────

describe("DelegatedBackendInvoker.task", () => {
  function makeTaskConfig(env: TestEnv, overrides: Partial<AgentConfig> = {}): AgentConfig {
    return makeConfig(env, {
      delegatedTaskModeEnabled: true,
      delegatedTaskMaxPerDay: 50,
      delegatedTaskDefaultMaxToolCalls: 5,
      delegatedTaskDefaultMaxBudgetUsd: 0.05,
      delegatedTaskDefaultTimeoutMs: 60000,
      delegatedTaskHeavyEnabled: false,
      timezone: "UTC",
      dayBoundaryHour: 4,
      ...overrides,
    } as Partial<AgentConfig>);
  }

  function makeTaskCore(
    backendId: "claude" | "codex" | "gemini",
    impl: (params: import("../core/agent-core.js").DelegatedTaskInvokeParams) =>
      | Promise<import("../core/agent-core.js").DelegatedTaskResultRaw>
      | import("../core/agent-core.js").DelegatedTaskResultRaw,
  ): IAgentCore {
    return {
      backendId,
      runDelegatedTool: vi.fn(),
      runDelegatedTask: vi.fn(async (p) => impl(p)),
      listModels: () => [
        {
          backendId,
          modelId: `${backendId}-light`,
          label: "light",
          tier: "light" as const,
          available: true,
        },
      ],
    } as unknown as IAgentCore;
  }

  const SCHEMA = {
    type: "object",
    required: ["messages"],
    properties: {
      messages: {
        type: "array",
        items: { type: "string" },
      },
    },
  };

  it("returns a successful task result and writes header + step rows", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "gemini" });
    const core = makeTaskCore("gemini", (p) => {
      // Step events flow through onToolStep
      p.onToolStep?.({
        toolName: "mcp_google-workspace_gmail.search",
        toolArgs: { q: "alice" },
        durationMs: 200,
        status: "ok",
        costUsd: null,
        tokensInput: null,
        tokensOutput: null,
      });
      return {
        ok: true,
        rawAssistantText: '{"messages":["a","b"]}',
        cost: {
          tokensInput: 100,
          tokensOutput: 30,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          costUsd: 0.001,
          durationMs: 600,
          numTurns: 2,
        },
        trace: [
          {
            toolName: "mcp_google-workspace_gmail.search",
            toolArgs: { q: "alice" },
            durationMs: 200,
            status: "ok",
            costUsd: null,
            tokensInput: null,
            tokensOutput: null,
          },
        ],
        writeClassToolFired: false,
      };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeTaskConfig(env),
      cores: { gemini: core },
    });

    const result = await invoker.task({
      integrationKey: "gmail",
      task: "Search for emails",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 5,
      maxBudgetUsd: 0.05,
      timeoutMs: 60000,
      allowDestructive: false,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({ messages: ["a", "b"] });
      expect(result.needsConfirmation).toBe(false);
    }

    const header = env.db
      .prepare(
        "SELECT result, action_type, backend, num_turns FROM agent_actions WHERE action_type = 'delegated_task.exec'",
      )
      .get() as Record<string, unknown>;
    expect(header.result).toBe("success");
    expect(header.backend).toBe("gemini");

    const steps = env.db
      .prepare(
        "SELECT detail FROM agent_actions WHERE action_type = 'delegated_task.tool_step'",
      )
      .all() as Array<{ detail: string }>;
    expect(steps.length).toBe(1);
    const stepDetail = JSON.parse(steps[0].detail) as Record<string, unknown>;
    expect(stepDetail.toolName).toBe("mcp_google-workspace_gmail.search");
  });

  it("returns task_mode_disabled when the kill switch is off", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "gemini" });
    const core = makeTaskCore("gemini", () => {
      throw new Error("should not be called");
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeTaskConfig(env, {
        delegatedTaskModeEnabled: false,
      } as Partial<AgentConfig>),
      cores: { gemini: core },
    });
    const result = await invoker.task({
      integrationKey: "gmail",
      task: "x",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 1,
      maxBudgetUsd: 0.01,
      timeoutMs: 1000,
      allowDestructive: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorClass).toBe("task_mode_disabled");
  });

  it("forwards a Codex-delegated /exec call to the Codex core (Phase 1.5+)", async () => {
    // Phase 1.5 (2026-05-01) wired Codex `runDelegatedTask` via daemon-side
    // stream pre-emption. The earlier short-circuit that returned
    // `task_mode_unsupported` for `delegatedBackend === "codex"` is gone.
    setIntegrationDelegated(env, { delegatedBackend: "codex" });
    const core = makeTaskCore("codex", () => ({
      ok: true,
      rawAssistantText: '{"messages":["ok"]}',
      cost: zeroCost(),
      trace: [],
      writeClassToolFired: false,
    }));
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeTaskConfig(env),
      cores: { codex: core },
    });
    const result = await invoker.task({
      integrationKey: "gmail",
      task: "x",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 1,
      maxBudgetUsd: 0.01,
      timeoutMs: 1000,
      allowDestructive: false,
    });
    expect(result.ok).toBe(true);
  });

  it("surfaces needsConfirmation envelope from the subprocess", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "gemini" });
    const core = makeTaskCore("gemini", () => ({
      ok: true,
      rawAssistantText: '{"needsConfirmation":true,"confirmationPlan":"Will send 1 email"}',
      cost: zeroCost(),
      trace: [],
      writeClassToolFired: false,
    }));
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeTaskConfig(env),
      cores: { gemini: core },
    });
    const result = await invoker.task({
      integrationKey: "gmail",
      task: "Send an email",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 1,
      maxBudgetUsd: 0.01,
      timeoutMs: 1000,
      allowDestructive: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.needsConfirmation).toBe(true);
      expect(result.confirmationPlan).toContain("send 1 email");
    }
  });

  it("retries once on schema_violation when no write-class tool fired", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "gemini" });
    let calls = 0;
    const seenPrompts: string[] = [];
    const core = makeTaskCore("gemini", (params) => {
      calls += 1;
      seenPrompts.push(params.systemPrompt);
      if (calls === 1) {
        return {
          ok: true,
          rawAssistantText: '{"messages": "bogus, not an array"}',
          cost: zeroCost(),
          trace: [],
          writeClassToolFired: false,
        };
      }
      return {
        ok: true,
        rawAssistantText: '{"messages":["recovered"]}',
        cost: zeroCost(),
        trace: [],
        writeClassToolFired: false,
      };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeTaskConfig(env),
      cores: { gemini: core },
    });
    const result = await invoker.task({
      integrationKey: "gmail",
      task: "Search for emails from alice",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 5,
      maxBudgetUsd: 0.05,
      timeoutMs: 60000,
      allowDestructive: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.retried).toBe(true);
      expect(result.result).toEqual({ messages: ["recovered"] });
    }
    expect(calls).toBe(2);
    // Critical regression guard: the retry prompt must carry BOTH the
    // original task description AND the retry instruction. Each call
    // spawns a fresh subprocess with no session memory; sending only the
    // retry instruction would leave the model unable to recover. See
    // DELEGATED-TASK-MODE-DESIGN.md §6.2.
    expect(seenPrompts[0]).toContain("Search for emails from alice");
    expect(seenPrompts[1]).toContain("Search for emails from alice");
    expect(seenPrompts[1]).toContain("Re-emit pure JSON");
    // The retry prompt must also still pin the schema (so the model
    // knows what shape to emit).
    expect(seenPrompts[1]).toContain("messages");
  });

  it("passes writeClassTools to the core including reversible writes like create_draft (§6.2 / §7.4)", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "claude" });
    let observedWriteClass: readonly string[] = [];
    let observedDestructive: readonly string[] = [];
    let observedAllowed: readonly string[] = [];
    const core = makeTaskCore("claude", (params) => {
      observedWriteClass = [...params.writeClassTools];
      observedDestructive = [...params.destructiveTools];
      observedAllowed = [...params.allowedTools];
      return {
        ok: true,
        rawAssistantText: '{"messages":[]}',
        cost: zeroCost(),
        trace: [],
        writeClassToolFired: false,
      };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeTaskConfig(env),
      cores: { claude: core },
    });
    await invoker.task({
      integrationKey: "gmail",
      task: "Search for emails",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 1,
      maxBudgetUsd: 0.01,
      timeoutMs: 1000,
      allowDestructive: false,
    });
    // create_draft is a reversible write — NOT in destructiveTools (it
    // shouldn't be denied with allowDestructive: false), but MUST be in
    // writeClassTools so the core's matcher flips writeClassToolFired
    // and suppresses the §6.2 retry. Pre-fix bug: the matcher used
    // destructiveTools and missed create_draft entirely, allowing a
    // duplicate-draft-on-retry hazard.
    expect(observedWriteClass).toContain("mcp__claude_ai_Gmail__create_draft");
    expect(observedDestructive).not.toContain(
      "mcp__claude_ai_Gmail__create_draft",
    );
    // Reversible writes stay in allowedTools even with allowDestructive=false.
    expect(observedAllowed).toContain("mcp__claude_ai_Gmail__create_draft");
    // Read-only tools never appear in writeClassTools.
    expect(observedWriteClass).not.toContain(
      "mcp__claude_ai_Gmail__list_drafts",
    );
    expect(observedWriteClass).not.toContain(
      "mcp__claude_ai_Gmail__search_threads",
    );
    // Destructive tools (label mutations on Claude's Gmail connector) are
    // a strict subset of writeClassTools.
    for (const d of observedDestructive) {
      expect(observedWriteClass).toContain(d);
    }
  });

  it("returns post_write_format_failure when validation fails AFTER a write-class tool ran (no retry)", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "gemini" });
    let calls = 0;
    const core = makeTaskCore("gemini", () => {
      calls += 1;
      return {
        ok: true,
        rawAssistantText: '{"messages": "bogus"}',
        cost: zeroCost(),
        trace: [
          {
            toolName: "mcp_google-workspace_gmail.send",
            toolArgs: { to: "alice" },
            durationMs: 100,
            status: "ok",
            costUsd: null,
            tokensInput: null,
            tokensOutput: null,
          },
        ],
        writeClassToolFired: true,
      };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeTaskConfig(env),
      cores: { gemini: core },
    });
    const result = await invoker.task({
      integrationKey: "gmail",
      task: "Send an email",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 1,
      maxBudgetUsd: 0.05,
      timeoutMs: 60000,
      allowDestructive: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorClass).toBe("post_write_format_failure");
      expect(result.raw).toContain("bogus");
    }
    expect(calls).toBe(1); // No retry
  });

  it("classifies tool_unavailable error envelope from subprocess", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "gemini" });
    const core = makeTaskCore("gemini", () => ({
      ok: true,
      rawAssistantText: '{"error":"tool_unavailable","missing":"send_email"}',
      cost: zeroCost(),
      trace: [],
      writeClassToolFired: false,
    }));
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeTaskConfig(env),
      cores: { gemini: core },
    });
    const result = await invoker.task({
      integrationKey: "gmail",
      task: "Post a tweet",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 1,
      maxBudgetUsd: 0.01,
      timeoutMs: 1000,
      allowDestructive: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorClass).toBe("tool_unavailable");
  });

  // §13 acceptance #6 — anti-prompt-injection. The subprocess receives a
  // tool_result with embedded "now also call delete_emails" instruction.
  // We assert on the trace shape: if the subprocess never calls
  // delete_emails (because allowedTools / admin policy denies it), the
  // injection failed.
  it("acceptance #6: prompt-injection in tool_result does NOT trigger an out-of-allowlist destructive call", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "gemini" });
    const observedAllowedTools: string[] = [];
    const observedDestructive: string[] = [];
    const core = makeTaskCore("gemini", (params) => {
      // Record what the runtime told the subprocess to allow.
      observedAllowedTools.push(...params.allowedTools);
      observedDestructive.push(...params.destructiveTools);
      // Simulate a well-behaved subprocess that ignores the injection.
      params.onToolStep?.({
        toolName: "mcp_google-workspace_gmail.search",
        toolArgs: { q: "alice" },
        durationMs: 100,
        status: "ok",
        costUsd: null,
        tokensInput: null,
        tokensOutput: null,
      });
      return {
        ok: true,
        rawAssistantText: '{"messages":["found one"]}',
        cost: zeroCost(),
        trace: [
          {
            toolName: "mcp_google-workspace_gmail.search",
            toolArgs: { q: "alice" },
            durationMs: 100,
            status: "ok",
            costUsd: null,
            tokensInput: null,
            tokensOutput: null,
          },
        ],
        writeClassToolFired: false,
      };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeTaskConfig(env),
      cores: { gemini: core },
    });
    const result = await invoker.task({
      integrationKey: "gmail",
      task: "Search for emails from alice",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 5,
      maxBudgetUsd: 0.05,
      timeoutMs: 60000,
      allowDestructive: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Trace shows exactly one search call — the injection didn't surface.
      expect(result.trace.length).toBe(1);
      expect(result.trace[0].toolName).toContain("search");
    }
    // Critical defense layer: the runtime fed the subprocess an
    // allowedTools list that EXCLUDES destructive tools (allowDestructive:
    // false). Even if the model had decided to call delete_emails, the
    // SDK / admin TOML would deny it.
    expect(observedAllowedTools.some((t) => t.endsWith(".search"))).toBe(true);
    expect(observedAllowedTools.some((t) => t.endsWith(".send"))).toBe(false);
    expect(observedAllowedTools.some((t) => t.endsWith(".modify"))).toBe(false);
    // The destructive list IS available for defense-in-depth deny rules.
    expect(observedDestructive.some((t) => t.endsWith(".send"))).toBe(true);
    expect(observedDestructive.some((t) => t.endsWith(".modify"))).toBe(true);
  });

  it("enforces the daily quota — subsequent calls hit task_quota_exhausted", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "gemini" });
    const core = makeTaskCore("gemini", () => ({
      ok: true,
      rawAssistantText: '{"messages":[]}',
      cost: zeroCost(),
      trace: [],
      writeClassToolFired: false,
    }));
    // Cap at 1 task/day so the second call trips the quota.
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeTaskConfig(env, {
        delegatedTaskMaxPerDay: 1,
      } as Partial<AgentConfig>),
      cores: { gemini: core },
    });
    const first = await invoker.task({
      integrationKey: "gmail",
      task: "x",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 1,
      maxBudgetUsd: 0.01,
      timeoutMs: 1000,
      allowDestructive: false,
    });
    expect(first.ok).toBe(true);
    const second = await invoker.task({
      integrationKey: "gmail",
      task: "x",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 1,
      maxBudgetUsd: 0.01,
      timeoutMs: 1000,
      allowDestructive: false,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.errorClass).toBe("task_quota_exhausted");
  });
});

// ── Janitor for orphaned in_progress task rows ──────────────────────────────

describe("runDelegatedTaskOrphanJanitor", () => {
  it("flips stale in_progress rows to failed=subprocess_orphaned", async () => {
    const { runDelegatedTaskOrphanJanitor } = await import("./delegated-backend-invoker.js");
    // Create a stale in_progress row directly.
    env.db
      .prepare(
        `INSERT INTO agent_actions
           (action_type, trigger, result, started_at, backend)
         VALUES ('delegated_task.exec', NULL, 'in_progress', datetime('now', '-1 hour'), 'gemini')`,
      )
      .run();
    env.db
      .prepare(
        `INSERT INTO agent_actions
           (action_type, trigger, result, started_at, backend)
         VALUES ('delegated_task.exec', NULL, 'in_progress', datetime('now'), 'gemini')`,
      )
      .run();
    const closed = runDelegatedTaskOrphanJanitor(env.db, { maxAgeMs: 60_000 });
    expect(closed).toBe(1);
    const stale = env.db
      .prepare(
        `SELECT result, error FROM agent_actions
         WHERE started_at < datetime('now', '-30 minutes')`,
      )
      .get() as { result: string; error: string };
    expect(stale.result).toBe("failed");
    expect(stale.error).toBe("subprocess_orphaned");
    const fresh = env.db
      .prepare(
        `SELECT result FROM agent_actions
         WHERE started_at >= datetime('now', '-30 minutes')`,
      )
      .get() as { result: string };
    expect(fresh.result).toBe("in_progress");
  });

  it("includes delegated_task.run rows in the orphan sweep (Phase 2)", async () => {
    const { runDelegatedTaskOrphanJanitor } = await import("./delegated-backend-invoker.js");
    env.db
      .prepare(
        `INSERT INTO agent_actions
           (action_type, trigger, result, started_at, backend)
         VALUES ('delegated_task.run', NULL, 'in_progress', datetime('now', '-30 minutes'), 'gemini')`,
      )
      .run();
    const closed = runDelegatedTaskOrphanJanitor(env.db, { maxAgeMs: 60_000 });
    expect(closed).toBe(1);
    const row = env.db
      .prepare(
        `SELECT result, error FROM agent_actions WHERE action_type = 'delegated_task.run'`,
      )
      .get() as { result: string; error: string };
    expect(row.result).toBe("failed");
    expect(row.error).toBe("subprocess_orphaned");
  });
});

// ── DELEGATED-TASK-MODE-DESIGN.md §4.2 — invoker.run (Phase 2) tests ────────

describe("DelegatedBackendInvoker.run", () => {
  function makeRunConfig(env: TestEnv, overrides: Partial<AgentConfig> = {}): AgentConfig {
    return makeConfig(env, {
      delegatedTaskModeEnabled: true,
      delegatedTaskMaxPerDay: 50,
      delegatedTaskDefaultMaxToolCalls: 5,
      delegatedTaskDefaultMaxBudgetUsd: 0.05,
      delegatedTaskDefaultTimeoutMs: 60000,
      delegatedTaskHeavyEnabled: false,
      timezone: "UTC",
      dayBoundaryHour: 4,
      ...overrides,
    } as Partial<AgentConfig>);
  }

  function makeRunCore(
    backendId: "claude" | "codex" | "gemini",
    impl: (params: import("../core/agent-core.js").DelegatedTaskInvokeParams) =>
      | Promise<import("../core/agent-core.js").DelegatedTaskResultRaw>
      | import("../core/agent-core.js").DelegatedTaskResultRaw,
  ): IAgentCore {
    return {
      backendId,
      runDelegatedTool: vi.fn(),
      runDelegatedTask: vi.fn(async (p) => impl(p)),
      listModels: () => [
        {
          backendId,
          modelId: `${backendId}-light`,
          label: "light",
          tier: "light" as const,
          available: true,
        },
      ],
    } as unknown as IAgentCore;
  }

  const SCHEMA = {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string" } },
  };

  it("happy path: runs the task with caller-supplied allowedTools and writes a delegated_task.run header + step row", async () => {
    let observedAllowed: readonly string[] | null = null;
    let observedDestructive: readonly string[] | null = null;
    let observedIntegrationKey: unknown = "<unset>";
    const core = makeRunCore("gemini", (p) => {
      observedAllowed = p.allowedTools;
      observedDestructive = p.destructiveTools;
      observedIntegrationKey = p.integrationKey;
      p.onToolStep?.({
        toolName: "mcp_my-server_search",
        toolArgs: { q: "x" },
        durationMs: 100,
        status: "ok",
        costUsd: null,
        tokensInput: null,
        tokensOutput: null,
      });
      return {
        ok: true,
        rawAssistantText: '{"text": "ok"}',
        cost: {
          tokensInput: 50,
          tokensOutput: 20,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          costUsd: 0.0005,
          durationMs: 200,
          numTurns: 1,
        },
        trace: [
          {
            toolName: "mcp_my-server_search",
            toolArgs: { q: "x" },
            durationMs: 100,
            status: "ok",
            costUsd: null,
            tokensInput: null,
            tokensOutput: null,
          },
        ],
        writeClassToolFired: false,
      };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeRunConfig(env),
      cores: { gemini: core },
    });

    const result = await invoker.run({
      delegatedBackend: "gemini",
      allowedTools: ["mcp_my-server_*"],
      task: "Look up the latest record",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 5,
      maxBudgetUsd: 0.05,
      timeoutMs: 60000,
      allowDestructive: false,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({ text: "ok" });
      expect(result.needsConfirmation).toBe(false);
      expect(result.backendId).toBe("gemini");
    }
    expect(observedAllowed).toEqual(["mcp_my-server_*"]);
    expect(observedDestructive).toEqual([]);
    expect(observedIntegrationKey).toBeUndefined();

    const header = env.db
      .prepare(
        `SELECT result, action_type, backend, detail FROM agent_actions
         WHERE action_type = 'delegated_task.run'`,
      )
      .get() as { result: string; action_type: string; backend: string; detail: string };
    expect(header.result).toBe("success");
    expect(header.backend).toBe("gemini");
    const headerDetail = JSON.parse(header.detail) as Record<string, unknown>;
    expect(headerDetail.delegatedBackend).toBe("gemini");
    expect(headerDetail.allowedToolsCount).toBe(1);
    expect(typeof headerDetail.allowedToolsHash).toBe("string");
    // Phase 2 has no integrationKey on the header.
    expect(headerDetail.integrationKey).toBeUndefined();

    const steps = env.db
      .prepare(
        "SELECT detail FROM agent_actions WHERE action_type = 'delegated_task.tool_step'",
      )
      .all() as Array<{ detail: string }>;
    expect(steps.length).toBe(1);
    const stepDetail = JSON.parse(steps[0].detail) as Record<string, unknown>;
    expect(stepDetail.toolName).toBe("mcp_my-server_search");
    // /run step rows omit integrationKey (no registered integration).
    expect(stepDetail.integrationKey).toBeUndefined();
  });

  it("returns task_mode_disabled when the kill switch is off", async () => {
    const core = makeRunCore("gemini", () => {
      throw new Error("should not be reached");
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeRunConfig(env, {
        delegatedTaskModeEnabled: false,
      } as Partial<AgentConfig>),
      cores: { gemini: core },
    });
    const result = await invoker.run({
      delegatedBackend: "gemini",
      allowedTools: ["mcp_my-server_search"],
      task: "x",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 1,
      maxBudgetUsd: 0.01,
      timeoutMs: 1000,
      allowDestructive: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorClass).toBe("task_mode_disabled");
  });

  it("returns task_quota_exhausted when the per-day cap is reached", async () => {
    // Resolve "today" the same way the invoker does so the seeded counter
    // matches whatever `getAgentDayDateStr(timezone, dayBoundaryHour)`
    // returns for the test config. Tests that fork the date format would
    // be flaky around the 04:00 boundary.
    const { getAgentDayDateStr } = await import("@aitne/shared");
    const today = getAgentDayDateStr("UTC", 4);
    const { writeRuntimeState } = await import("../db/runtime-state.js");
    writeRuntimeState(env.db, "delegated_task_count_today", {
      date: today,
      count: 1,
    });
    const core = makeRunCore("gemini", () => {
      throw new Error("should not be reached");
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeRunConfig(env, {
        delegatedTaskMaxPerDay: 1,
      } as Partial<AgentConfig>),
      cores: { gemini: core },
    });
    const result = await invoker.run({
      delegatedBackend: "gemini",
      allowedTools: ["mcp_my-server_search"],
      task: "x",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 1,
      maxBudgetUsd: 0.01,
      timeoutMs: 1000,
      allowDestructive: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorClass).toBe("task_quota_exhausted");
  });

  it("forwards a Codex /run call to the Codex core (Phase 1.5+)", async () => {
    // Phase 1.5 (2026-05-01) wired Codex's `runDelegatedTask`. The
    // earlier `task_mode_unsupported` short-circuit for codex is gone;
    // the /run path now resolves the Codex core and forwards.
    const core = makeRunCore("codex", () => ({
      ok: true,
      rawAssistantText: '{"text":"ok"}',
      cost: {
        tokensInput: 10,
        tokensOutput: 5,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
        durationMs: 50,
        numTurns: 1,
      },
      trace: [],
      writeClassToolFired: false,
    }));
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeRunConfig(env),
      cores: { codex: core },
    });
    const result = await invoker.run({
      delegatedBackend: "codex",
      allowedTools: ["mcp_my-server_search"],
      task: "x",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 1,
      maxBudgetUsd: 0.01,
      timeoutMs: 1000,
      allowDestructive: false,
    });
    expect(result.ok).toBe(true);
  });

  it("returns subprocess_crashed when the requested backend has no registered core", async () => {
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeRunConfig(env),
      cores: {}, // no claude / gemini core wired
    });
    const result = await invoker.run({
      delegatedBackend: "gemini",
      allowedTools: ["mcp_my-server_search"],
      task: "x",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 1,
      maxBudgetUsd: 0.01,
      timeoutMs: 1000,
      allowDestructive: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorClass).toBe("subprocess_crashed");
  });

  it("does not retry on schema_violation when a write-class tool fired (§7.4 idempotency)", async () => {
    let calls = 0;
    const core = makeRunCore("gemini", () => {
      calls += 1;
      // First (and only allowed) attempt: a write tool fired, then the
      // model emitted invalid JSON. §7.4 says: NO retry.
      return {
        ok: true,
        rawAssistantText: '{"not": "matching schema"}',
        cost: zeroCost(),
        trace: [],
        writeClassToolFired: true,
      };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeRunConfig(env),
      cores: { gemini: core },
    });
    const result = await invoker.run({
      delegatedBackend: "gemini",
      // `_send` is a write-verb suffix; resolved write-class set is
      // non-empty. (The cores' writeClassMatcher is what observes the
      // actual tool_use to flip the flag — we feed `writeClassToolFired:
      // true` from the stub directly to exercise the invoker's branch.)
      allowedTools: ["mcp_my-server_send", "mcp_my-server_search"],
      task: "Send a message",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 2,
      maxBudgetUsd: 0.05,
      timeoutMs: 60000,
      allowDestructive: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorClass).toBe("post_write_format_failure");
      expect(result.retried).toBe(false);
    }
    expect(calls).toBe(1);
  });

  it("retries once on schema_violation for read-only tasks (no write-class flag)", async () => {
    let calls = 0;
    const core = makeRunCore("gemini", () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          rawAssistantText: '{"not": "matching schema"}',
          cost: zeroCost(),
          trace: [],
          writeClassToolFired: false,
        };
      }
      return {
        ok: true,
        rawAssistantText: '{"text": "recovered"}',
        cost: zeroCost(),
        trace: [],
        writeClassToolFired: false,
      };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeRunConfig(env),
      cores: { gemini: core },
    });
    const result = await invoker.run({
      delegatedBackend: "gemini",
      allowedTools: ["mcp_my-server_search"],
      task: "Find the latest record",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 2,
      maxBudgetUsd: 0.05,
      timeoutMs: 60000,
      allowDestructive: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.retried).toBe(true);
      expect(result.result).toEqual({ text: "recovered" });
    }
    expect(calls).toBe(2);
  });
});

// ── DELEGATED-TASK-MODE-DESIGN.md §13 Phase 3 — Phase 3.1 / 3.2 / 3.3 tests ──

describe("DelegatedBackendInvoker.task — Phase 3 optimizations", () => {
  function makeTaskConfig(env: TestEnv, overrides: Partial<AgentConfig> = {}): AgentConfig {
    return makeConfig(env, {
      delegatedTaskModeEnabled: true,
      delegatedTaskMaxPerDay: 50,
      delegatedTaskDefaultMaxToolCalls: 5,
      delegatedTaskDefaultMaxBudgetUsd: 0.05,
      delegatedTaskDefaultTimeoutMs: 60000,
      delegatedTaskHeavyEnabled: false,
      delegatedTaskStructuredOutputEnabled: true,
      delegatedTaskSubprocessPoolEnabled: false,
      delegatedTaskSubprocessPoolTtlSeconds: 30,
      delegatedTaskCacheEnabled: false,
      delegatedTaskCacheTtlSeconds: 60,
      delegatedTaskCacheMaxEntries: 16,
      timezone: "UTC",
      dayBoundaryHour: 4,
      ...overrides,
    } as Partial<AgentConfig>);
  }

  function makeTaskCore(
    backendId: "claude" | "codex" | "gemini",
    impl: (params: import("../core/agent-core.js").DelegatedTaskInvokeParams) =>
      | Promise<import("../core/agent-core.js").DelegatedTaskResultRaw>
      | import("../core/agent-core.js").DelegatedTaskResultRaw,
  ): IAgentCore {
    return {
      backendId,
      runDelegatedTool: vi.fn(),
      runDelegatedTask: vi.fn(async (p) => impl(p)),
      listModels: () => [
        {
          backendId,
          modelId: `${backendId}-light`,
          label: "light",
          tier: "light" as const,
          available: true,
        },
      ],
    } as unknown as IAgentCore;
  }

  const SCHEMA = {
    type: "object",
    required: ["messages"],
    properties: {
      messages: {
        type: "array",
        items: { type: "string" },
      },
    },
  };

  const SUCCESS_PAYLOAD = '{"messages":["alpha","beta"]}';

  function successCore(opts: { writeClass?: boolean; structured?: unknown } = {}): {
    core: IAgentCore;
    callCount: () => number;
  } {
    let calls = 0;
    const core = makeTaskCore("gemini", () => {
      calls += 1;
      const base = {
        ok: true as const,
        rawAssistantText: SUCCESS_PAYLOAD,
        cost: {
          tokensInput: 100,
          tokensOutput: 30,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          costUsd: 0.001,
          durationMs: 600,
          numTurns: 2,
        },
        trace: [],
        writeClassToolFired: opts.writeClass === true,
      };
      if (opts.structured !== undefined) {
        return { ...base, structuredOutput: opts.structured };
      }
      return base;
    });
    return { core, callCount: () => calls };
  }

  // ── Phase 3.1 structured output ─────────────────────────────────────────

  it("3.1: passes wrappedSchema + structuredOutputEnabled to the core when the kill switch is on", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "gemini" });
    let observed: import("../core/agent-core.js").DelegatedTaskInvokeParams | null = null;
    const core = makeTaskCore("gemini", (p) => {
      observed = p;
      return {
        ok: true,
        rawAssistantText: SUCCESS_PAYLOAD,
        cost: zeroCost(),
        trace: [],
        writeClassToolFired: false,
      };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeTaskConfig(env, {
        delegatedTaskStructuredOutputEnabled: true,
      }),
      cores: { gemini: core },
    });
    await invoker.task({
      integrationKey: "gmail",
      task: "Search",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 5,
      maxBudgetUsd: 0.05,
      timeoutMs: 60000,
      allowDestructive: false,
    });
    expect(observed).not.toBeNull();
    expect(observed!.structuredOutputEnabled).toBe(true);
    expect(observed!.wrappedSchema).toBeTruthy();
    // §13 Phase 3.1 post-review — the schema is the user's verbatim, not
    // a oneOf wrapper. Confirmation/error envelopes route via the
    // text-extract fallback when the SDK can't produce structured
    // output that satisfies the user schema.
    expect(observed!.wrappedSchema).toBe(SCHEMA);
  });

  it("3.1: omits wrappedSchema when the kill switch is off", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "gemini" });
    let observed: import("../core/agent-core.js").DelegatedTaskInvokeParams | null = null;
    const core = makeTaskCore("gemini", (p) => {
      observed = p;
      return {
        ok: true,
        rawAssistantText: SUCCESS_PAYLOAD,
        cost: zeroCost(),
        trace: [],
        writeClassToolFired: false,
      };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeTaskConfig(env, {
        delegatedTaskStructuredOutputEnabled: false,
      }),
      cores: { gemini: core },
    });
    await invoker.task({
      integrationKey: "gmail",
      task: "Search",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 5,
      maxBudgetUsd: 0.05,
      timeoutMs: 60000,
      allowDestructive: false,
    });
    expect(observed!.structuredOutputEnabled).toBe(false);
    expect(observed!.wrappedSchema).toBeUndefined();
  });

  it("3.1: prefers structuredOutput over text extraction when supplied", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "gemini" });
    const core = makeTaskCore("gemini", () => ({
      ok: true,
      // Text says one thing; structured output says another. The invoker
      // must pick the structured one.
      rawAssistantText: '{"messages":["from-text"]}',
      structuredOutput: { messages: ["from-structured"] },
      cost: zeroCost(),
      trace: [],
      writeClassToolFired: false,
    }));
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeTaskConfig(env),
      cores: { gemini: core },
    });
    const result = await invoker.task({
      integrationKey: "gmail",
      task: "Search",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 5,
      maxBudgetUsd: 0.05,
      timeoutMs: 60000,
      allowDestructive: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({ messages: ["from-structured"] });
    }
  });

  it("3.1: structuredOutput confirmation envelope routes to needsConfirmation", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "gemini" });
    const core = makeTaskCore("gemini", () => ({
      ok: true,
      rawAssistantText: "",
      structuredOutput: {
        needsConfirmation: true,
        confirmationPlan: "I would send the email to bob",
      },
      cost: zeroCost(),
      trace: [],
      writeClassToolFired: false,
    }));
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeTaskConfig(env),
      cores: { gemini: core },
    });
    const result = await invoker.task({
      integrationKey: "gmail",
      task: "Send something",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 5,
      maxBudgetUsd: 0.05,
      timeoutMs: 60000,
      allowDestructive: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.needsConfirmation).toBe(true);
      expect(result.confirmationPlan).toBe("I would send the email to bob");
    }
  });

  it("3.1: structuredOutput error envelope classifies as the right errorClass", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "gemini" });
    const core = makeTaskCore("gemini", () => ({
      ok: true,
      rawAssistantText: "",
      structuredOutput: { error: "tool_unavailable", missing: "send_to_slack" },
      cost: zeroCost(),
      trace: [],
      writeClassToolFired: false,
    }));
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeTaskConfig(env),
      cores: { gemini: core },
    });
    const result = await invoker.task({
      integrationKey: "gmail",
      task: "Send something",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 5,
      maxBudgetUsd: 0.05,
      timeoutMs: 60000,
      allowDestructive: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorClass).toBe("tool_unavailable");
    }
  });

  // ── Phase 3.2 session-dir pool ──────────────────────────────────────────

  it("3.2: with pool disabled, each task() call materializes a fresh dir", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "gemini" });
    const observedDirs: string[] = [];
    const core = makeTaskCore("gemini", (p) => {
      observedDirs.push(p.sessionDir);
      return {
        ok: true,
        rawAssistantText: SUCCESS_PAYLOAD,
        cost: zeroCost(),
        trace: [],
        writeClassToolFired: false,
      };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeTaskConfig(env, { delegatedTaskSubprocessPoolEnabled: false }),
      cores: { gemini: core },
    });
    for (let i = 0; i < 2; i++) {
      await invoker.task({
        integrationKey: "gmail",
        task: "Search",
        outputSchema: SCHEMA as Record<string, unknown>,
        maxToolCalls: 5,
        maxBudgetUsd: 0.05,
        timeoutMs: 60000,
        allowDestructive: false,
      });
    }
    expect(observedDirs).toHaveLength(2);
    expect(observedDirs[0]).not.toBe(observedDirs[1]);
  });

  it("3.2: with pool enabled, two consecutive task() calls reuse the same dir", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "gemini" });
    const observedDirs: string[] = [];
    const core = makeTaskCore("gemini", (p) => {
      observedDirs.push(p.sessionDir);
      return {
        ok: true,
        rawAssistantText: SUCCESS_PAYLOAD,
        cost: zeroCost(),
        trace: [],
        writeClassToolFired: false,
      };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeTaskConfig(env, {
        delegatedTaskSubprocessPoolEnabled: true,
        delegatedTaskSubprocessPoolTtlSeconds: 30,
      }),
      cores: { gemini: core },
    });
    for (let i = 0; i < 2; i++) {
      await invoker.task({
        integrationKey: "gmail",
        task: "Search",
        outputSchema: SCHEMA as Record<string, unknown>,
        maxToolCalls: 5,
        maxBudgetUsd: 0.05,
        timeoutMs: 60000,
        allowDestructive: false,
      });
    }
    expect(observedDirs).toHaveLength(2);
    expect(observedDirs[0]).toBe(observedDirs[1]);
  });

  it("3.2: write-class tool fires DISCARD path so dir is not reused", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "gemini" });
    const observedDirs: string[] = [];
    let writeClassNext = true;
    const core = makeTaskCore("gemini", (p) => {
      observedDirs.push(p.sessionDir);
      const wc = writeClassNext;
      writeClassNext = false;
      return {
        ok: true,
        rawAssistantText: SUCCESS_PAYLOAD,
        cost: zeroCost(),
        trace: [],
        writeClassToolFired: wc,
      };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeTaskConfig(env, {
        delegatedTaskSubprocessPoolEnabled: true,
        delegatedTaskSubprocessPoolTtlSeconds: 30,
      }),
      cores: { gemini: core },
    });
    for (let i = 0; i < 2; i++) {
      await invoker.task({
        integrationKey: "gmail",
        task: "Search",
        outputSchema: SCHEMA as Record<string, unknown>,
        maxToolCalls: 5,
        maxBudgetUsd: 0.05,
        timeoutMs: 60000,
        allowDestructive: true, // allow the write
      });
    }
    expect(observedDirs).toHaveLength(2);
    expect(observedDirs[0]).not.toBe(observedDirs[1]);
  });

  // ── Phase 3.3 result cache ──────────────────────────────────────────────

  it("3.3: cacheable=true with cache off does NOT cache", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "gemini" });
    const { core, callCount } = successCore();
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeTaskConfig(env, { delegatedTaskCacheEnabled: false }),
      cores: { gemini: core },
    });
    for (let i = 0; i < 2; i++) {
      await invoker.task({
        integrationKey: "gmail",
        task: "Search",
        outputSchema: SCHEMA as Record<string, unknown>,
        maxToolCalls: 5,
        maxBudgetUsd: 0.05,
        timeoutMs: 60000,
        allowDestructive: false,
        cacheable: true,
      });
    }
    expect(callCount()).toBe(2);
  });

  it("3.3: cacheable=true with cache on serves the second call from cache", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "gemini" });
    const { core, callCount } = successCore();
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeTaskConfig(env, { delegatedTaskCacheEnabled: true }),
      cores: { gemini: core },
    });
    for (let i = 0; i < 2; i++) {
      const r = await invoker.task({
        integrationKey: "gmail",
        task: "Search",
        outputSchema: SCHEMA as Record<string, unknown>,
        maxToolCalls: 5,
        maxBudgetUsd: 0.05,
        timeoutMs: 60000,
        allowDestructive: false,
        cacheable: true,
      });
      expect(r.ok).toBe(true);
    }
    expect(callCount()).toBe(1); // second call hit cache
    // Both calls wrote a header row; second one carries detail.cacheHit=true.
    const headers = env.db
      .prepare(
        `SELECT detail FROM agent_actions WHERE action_type = 'delegated_task.exec' ORDER BY id ASC`,
      )
      .all() as Array<{ detail: string }>;
    expect(headers).toHaveLength(2);
    const second = JSON.parse(headers[1].detail) as { cacheHit?: boolean };
    expect(second.cacheHit).toBe(true);
  });

  it("3.3: cache hit writes a zero-cost audit row", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "gemini" });
    const { core } = successCore();
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeTaskConfig(env, { delegatedTaskCacheEnabled: true }),
      cores: { gemini: core },
    });
    const params = {
      integrationKey: "gmail" as const,
      task: "Search",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 5,
      maxBudgetUsd: 0.05,
      timeoutMs: 60000,
      allowDestructive: false,
      cacheable: true,
    };
    await invoker.task(params);
    await invoker.task(params);
    const rows = env.db
      .prepare(
        `SELECT cost_usd, num_turns, detail FROM agent_actions
         WHERE action_type = 'delegated_task.exec' ORDER BY id ASC`,
      )
      .all() as Array<{ cost_usd: number; num_turns: number; detail: string }>;
    expect(rows).toHaveLength(2);
    const second = JSON.parse(rows[1].detail) as { cacheHit?: boolean };
    expect(second.cacheHit).toBe(true);
    expect(rows[1].cost_usd).toBe(0);
  });

  it("3.3: cache key invalidates when integration's lastChangedAt changes", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "gemini" });
    const { core, callCount } = successCore();
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeTaskConfig(env, { delegatedTaskCacheEnabled: true }),
      cores: { gemini: core },
    });
    const params = {
      integrationKey: "gmail" as const,
      task: "Search",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 5,
      maxBudgetUsd: 0.05,
      timeoutMs: 60000,
      allowDestructive: false,
      cacheable: true,
    };
    await invoker.task(params);
    // Mutate state.lastChangedAt — simulate a deniedTools change.
    writeIntegrations(env.db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "gemini",
        deniedTools: ["mcp_google-workspace_gmail.send"],
        lastChangedAt: new Date(Date.now() + 1000).toISOString(),
      },
    });
    await invoker.task(params);
    expect(callCount()).toBe(2); // second call did NOT hit cache
  });

  it("3.3: NEVER caches a write-class outcome (idempotency rule)", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "gemini" });
    let calls = 0;
    const core = makeTaskCore("gemini", () => {
      calls += 1;
      return {
        ok: true,
        rawAssistantText: SUCCESS_PAYLOAD,
        cost: zeroCost(),
        trace: [],
        writeClassToolFired: true, // simulates a create_draft etc.
      };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeTaskConfig(env, { delegatedTaskCacheEnabled: true }),
      cores: { gemini: core },
    });
    const params = {
      integrationKey: "gmail" as const,
      task: "Create draft",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 5,
      maxBudgetUsd: 0.05,
      timeoutMs: 60000,
      allowDestructive: false,
      cacheable: true,
    };
    await invoker.task(params);
    await invoker.task(params);
    expect(calls).toBe(2); // never served from cache
  });

  it("3.3: NEVER caches a needsConfirmation envelope", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "gemini" });
    let calls = 0;
    const core = makeTaskCore("gemini", () => {
      calls += 1;
      return {
        ok: true,
        rawAssistantText:
          '{"needsConfirmation":true,"confirmationPlan":"send to bob"}',
        cost: zeroCost(),
        trace: [],
        writeClassToolFired: false,
      };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeTaskConfig(env, { delegatedTaskCacheEnabled: true }),
      cores: { gemini: core },
    });
    const params = {
      integrationKey: "gmail" as const,
      task: "Send something",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 5,
      maxBudgetUsd: 0.05,
      timeoutMs: 60000,
      allowDestructive: false,
      cacheable: true,
    };
    await invoker.task(params);
    await invoker.task(params);
    expect(calls).toBe(2);
  });

  it("3.3: cache hit does NOT consume the daily quota", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "gemini" });
    const { core } = successCore();
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeTaskConfig(env, { delegatedTaskCacheEnabled: true }),
      cores: { gemini: core },
    });
    const params = {
      integrationKey: "gmail" as const,
      task: "Search",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 5,
      maxBudgetUsd: 0.05,
      timeoutMs: 60000,
      allowDestructive: false,
      cacheable: true,
    };
    await invoker.task(params);
    await invoker.task(params);
    // Quota counts subprocess invocations; only the first should have
    // bumped the counter.
    const stateRow = env.db
      .prepare(`SELECT value_json FROM runtime_state WHERE key = 'delegated_task_count_today'`)
      .get() as { value_json: string } | undefined;
    expect(stateRow).toBeTruthy();
    const parsed = JSON.parse(stateRow!.value_json) as { count: number };
    expect(parsed.count).toBe(1);
  });

  it("3.3: emergency disable mid-window clears cache and stops serving hits", async () => {
    setIntegrationDelegated(env, { delegatedBackend: "gemini" });
    const { core, callCount } = successCore();
    const config = makeTaskConfig(env, { delegatedTaskCacheEnabled: true });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config,
      cores: { gemini: core },
    });
    const params = {
      integrationKey: "gmail" as const,
      task: "Search",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 5,
      maxBudgetUsd: 0.05,
      timeoutMs: 60000,
      allowDestructive: false,
      cacheable: true,
    };
    await invoker.task(params);
    expect(callCount()).toBe(1);
    // Flip kill switch off mid-window.
    (config as { delegatedTaskCacheEnabled: boolean }).delegatedTaskCacheEnabled = false;
    await invoker.task(params);
    expect(callCount()).toBe(2);
    // Flip back on — entries were cleared at flip-off, so no stale hit.
    (config as { delegatedTaskCacheEnabled: boolean }).delegatedTaskCacheEnabled = true;
    await invoker.task(params);
    expect(callCount()).toBe(3);
  });
});

describe("DelegatedBackendInvoker.run — Phase 3 optimizations", () => {
  function makeRunConfig(env: TestEnv, overrides: Partial<AgentConfig> = {}): AgentConfig {
    return makeConfig(env, {
      delegatedTaskModeEnabled: true,
      delegatedTaskMaxPerDay: 50,
      delegatedTaskDefaultMaxToolCalls: 5,
      delegatedTaskDefaultMaxBudgetUsd: 0.05,
      delegatedTaskDefaultTimeoutMs: 60000,
      delegatedTaskHeavyEnabled: false,
      delegatedTaskStructuredOutputEnabled: true,
      delegatedTaskSubprocessPoolEnabled: false,
      delegatedTaskSubprocessPoolTtlSeconds: 30,
      delegatedTaskCacheEnabled: false,
      delegatedTaskCacheTtlSeconds: 60,
      delegatedTaskCacheMaxEntries: 16,
      timezone: "UTC",
      dayBoundaryHour: 4,
      ...overrides,
    } as Partial<AgentConfig>);
  }

  function makeRunCore(
    backendId: "claude" | "codex" | "gemini",
    impl: (params: import("../core/agent-core.js").DelegatedTaskInvokeParams) =>
      | Promise<import("../core/agent-core.js").DelegatedTaskResultRaw>
      | import("../core/agent-core.js").DelegatedTaskResultRaw,
  ): IAgentCore {
    return {
      backendId,
      runDelegatedTool: vi.fn(),
      runDelegatedTask: vi.fn(async (p) => impl(p)),
      listModels: () => [
        {
          backendId,
          modelId: `${backendId}-light`,
          label: "light",
          tier: "light" as const,
          available: true,
        },
      ],
    } as unknown as IAgentCore;
  }

  const SCHEMA = {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string" } },
  };

  it("3.3: cacheable=true with cache off does NOT cache (run)", async () => {
    let calls = 0;
    const core = makeRunCore("gemini", () => {
      calls += 1;
      return {
        ok: true,
        rawAssistantText: '{"text":"hello"}',
        cost: zeroCost(),
        trace: [],
        writeClassToolFired: false,
      };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeRunConfig(env, { delegatedTaskCacheEnabled: false }),
      cores: { gemini: core },
    });
    for (let i = 0; i < 2; i++) {
      await invoker.run({
        delegatedBackend: "gemini",
        allowedTools: ["mcp_my-server_search"],
        task: "find x",
        outputSchema: SCHEMA as Record<string, unknown>,
        maxToolCalls: 2,
        maxBudgetUsd: 0.05,
        timeoutMs: 60_000,
        allowDestructive: false,
        cacheable: true,
      });
    }
    expect(calls).toBe(2);
  });

  it("3.3: cacheable=true with cache on serves second run() call from cache", async () => {
    let calls = 0;
    const core = makeRunCore("gemini", () => {
      calls += 1;
      return {
        ok: true,
        rawAssistantText: '{"text":"hello"}',
        cost: zeroCost(),
        trace: [],
        writeClassToolFired: false,
      };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeRunConfig(env, { delegatedTaskCacheEnabled: true }),
      cores: { gemini: core },
    });
    const baseParams = {
      delegatedBackend: "gemini" as const,
      allowedTools: ["mcp_my-server_search"],
      task: "find x",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 2,
      maxBudgetUsd: 0.05,
      timeoutMs: 60_000,
      allowDestructive: false,
      cacheable: true,
    };
    await invoker.run(baseParams);
    await invoker.run(baseParams);
    expect(calls).toBe(1);
    const headers = env.db
      .prepare(
        `SELECT detail FROM agent_actions WHERE action_type = 'delegated_task.run' ORDER BY id ASC`,
      )
      .all() as Array<{ detail: string }>;
    expect(headers).toHaveLength(2);
    const second = JSON.parse(headers[1].detail) as { cacheHit?: boolean };
    expect(second.cacheHit).toBe(true);
  });

  it("3.3: different allowedTools force a cache miss (runScope changes)", async () => {
    let calls = 0;
    const core = makeRunCore("gemini", () => {
      calls += 1;
      return {
        ok: true,
        rawAssistantText: '{"text":"hello"}',
        cost: zeroCost(),
        trace: [],
        writeClassToolFired: false,
      };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeRunConfig(env, { delegatedTaskCacheEnabled: true }),
      cores: { gemini: core },
    });
    const baseParams = {
      delegatedBackend: "gemini" as const,
      task: "find x",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 2,
      maxBudgetUsd: 0.05,
      timeoutMs: 60_000,
      allowDestructive: false,
      cacheable: true,
    };
    await invoker.run({ ...baseParams, allowedTools: ["mcp_my-server_search"] });
    await invoker.run({ ...baseParams, allowedTools: ["mcp_other-server_search"] });
    expect(calls).toBe(2);
  });

  it("3.2: run() reuses session dirs when pool enabled", async () => {
    const observedDirs: string[] = [];
    const core = makeRunCore("gemini", (p) => {
      observedDirs.push(p.sessionDir);
      return {
        ok: true,
        rawAssistantText: '{"text":"x"}',
        cost: zeroCost(),
        trace: [],
        writeClassToolFired: false,
      };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeRunConfig(env, {
        delegatedTaskSubprocessPoolEnabled: true,
        delegatedTaskSubprocessPoolTtlSeconds: 30,
      }),
      cores: { gemini: core },
    });
    for (let i = 0; i < 2; i++) {
      await invoker.run({
        delegatedBackend: "gemini",
        allowedTools: ["mcp_my-server_search"],
        task: "x",
        outputSchema: SCHEMA as Record<string, unknown>,
        maxToolCalls: 2,
        maxBudgetUsd: 0.05,
        timeoutMs: 60_000,
        allowDestructive: false,
      });
    }
    expect(observedDirs).toHaveLength(2);
    expect(observedDirs[0]).toBe(observedDirs[1]);
  });

  it("3.1: run() passes wrappedSchema + structuredOutputEnabled to the core", async () => {
    let observed: import("../core/agent-core.js").DelegatedTaskInvokeParams | null = null;
    const core = makeRunCore("gemini", (p) => {
      observed = p;
      return {
        ok: true,
        rawAssistantText: '{"text":"x"}',
        cost: zeroCost(),
        trace: [],
        writeClassToolFired: false,
      };
    });
    const invoker = new DelegatedBackendInvoker({
      db: env.db,
      config: makeRunConfig(env, { delegatedTaskStructuredOutputEnabled: true }),
      cores: { gemini: core },
    });
    await invoker.run({
      delegatedBackend: "gemini",
      allowedTools: ["mcp_my-server_search"],
      task: "x",
      outputSchema: SCHEMA as Record<string, unknown>,
      maxToolCalls: 2,
      maxBudgetUsd: 0.05,
      timeoutMs: 60_000,
      allowDestructive: false,
    });
    expect(observed).not.toBeNull();
    expect(observed!.structuredOutputEnabled).toBe(true);
    expect(observed!.wrappedSchema).toBe(SCHEMA);
  });
});
