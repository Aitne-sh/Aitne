import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type DatabaseType from "better-sqlite3";
import { createEvent, EventPriority, type Event } from "@aitne/shared";
import { BackendDecisiveFailure, BackendQuotaError } from "../agent-core.js";
import type { AgentConfig } from "../../config.js";

/** Temp dirs must be declared with vi.hoisted so vi.mock (hoisted) can reference them. */
const { TEST_WORKDIR, TEST_RESUME_DIR } = vi.hoisted(() => {
  const os = require("node:os");
  const path = require("node:path");
  return {
    TEST_WORKDIR: path.join(os.tmpdir(), "pa-gemini-test-workdir"),
    TEST_RESUME_DIR: path.join(os.tmpdir(), "pa-gemini-test-resume"),
  };
});

// Mock cli-utils and workdir before importing GeminiCliCore
vi.mock("./cli-utils.js", () => {
  const findExecutableMock = vi.fn().mockReturnValue("/usr/local/bin/gemini");
  return {
  findExecutable: findExecutableMock,
  CliPathCache: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockImplementation(() => findExecutableMock()),
  })),
  runLineCommand: vi.fn(),
  parseJsonLine: vi.fn((line: string) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }),
  // Keep the real format check — it's a pure function with no side effects.
  isPlausibleGeminiApiKey: (raw: string | undefined): boolean => {
    const key = raw?.trim();
    if (!key) return false;
    return /^AIza[0-9A-Za-z_-]{35}$/.test(key);
  },
  };
});

vi.mock("../workdir.js", () => ({
  createSessionWorkdir: vi.fn().mockReturnValue(TEST_WORKDIR),
  cleanupSessionWorkdir: vi.fn(),
}));

import {
  GeminiCliCore,
  appendGeminiAttachmentTokens,
  collectMcpServerNames,
  extractGeminiServerName,
  isToolNotRegisteredError,
} from "./gemini-cli-core.js";
import { runLineCommand } from "./cli-utils.js";
import { createSessionWorkdir } from "../workdir.js";
import type { StagedAttachment } from "../agent-core.js";

const mockRunLineCommand = vi.mocked(runLineCommand);
const mockCreateSessionWorkdir = vi.mocked(createSessionWorkdir);

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    dataDir: "/tmp/test",
    workspaceDir: ".",
    apiPort: 8321,
    character: "",
    disallowedTools: [],
    allowedToolsOverride: null,
    executeTimeoutMinutes: 60,
    // getAgentDayDateStr() is now called in runTurn() to key the daily
    // request counter. Production always supplies these via env defaults;
    // tests used to skip them, which made the setUTCHours path throw
    // RangeError when the Gemini counter was added.
    timezone: "",
    dayBoundaryHour: 4,
    ...overrides,
  } as unknown as AgentConfig;
}

function makeEvent(overrides: Partial<Event> = {}): Event {
  return createEvent({
    type: "routine.activity_scan",
    source: "test",
    priority: EventPriority.NORMAL,
    ...overrides,
  });
}

function simulateGeminiRun(
  events: Record<string, unknown>[],
  exitCode = 0,
  stderrLines: string[] = [],
) {
  mockRunLineCommand.mockImplementation(async (options) => {
    const stdoutLines: string[] = [];
    for (const event of events) {
      const line = JSON.stringify(event);
      stdoutLines.push(line);
      options.onStdoutLine?.(line);
      // Faithfully simulate the real subprocess: when the caller fires
      // the AbortController (e.g. max-turns abort) the kernel kills the
      // child mid-stream — stop emitting further events. Without this,
      // tests that drive max-turns enforcement would still see every
      // queued event, which masks the abort and lets `numTurns` keep
      // climbing past the cap.
      if (options.abortSignal?.aborted) break;
    }
    for (const line of stderrLines) {
      options.onStderrLine?.(line);
    }
    return {
      exitCode,
      signal: options.abortSignal?.aborted ? "SIGTERM" : null,
      stdoutLines,
      stderrLines,
      timedOut: false,
    };
  });
}

describe("GeminiCliCore", () => {
  let core: GeminiCliCore;

  beforeEach(() => {
    vi.clearAllMocks();
    // Create real temp dirs so writeFileSync for admin policy works
    mkdirSync(TEST_WORKDIR, { recursive: true });
    mkdirSync(TEST_RESUME_DIR, { recursive: true });
    core = new GeminiCliCore(makeConfig());
  });

  afterEach(() => {
    rmSync(TEST_WORKDIR, { recursive: true, force: true });
    rmSync(TEST_RESUME_DIR, { recursive: true, force: true });
  });

  describe("execute", () => {
    it("returns a successful AgentResult on normal completion", async () => {
      simulateGeminiRun([
        { type: "init", session_id: "gem-session-1", model: "gemini-2.5-pro" },
        { type: "message", role: "user", content: "test prompt" },
        { type: "message", role: "assistant", content: "Hello ", delta: true },
        { type: "message", role: "assistant", content: "world!", delta: true },
        {
          type: "result",
          status: "success",
          stats: {
            total_tokens: 150,
            input_tokens: 100,
            output_tokens: 50,
            cached: 10,
            duration_ms: 2500,
          },
        },
      ]);

      const result = await core.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gemini-2.5-pro",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
      });

      expect(result.backendId).toBe("gemini");
      expect(result.sessionId).toBe("gem-session-1");
      expect(result.isError).toBe(false);
      expect(result.usage.inputTokens).toBe(90);
      expect(result.usage.outputTokens).toBe(50);
      expect(result.usage.cacheReadInputTokens).toBe(10);
      expect(result.output).toBe("Hello world!");
    });

    it("streams delta content live, matching ClaudeCodeCore", async () => {
      // Regression guard parallel to the codex-core test: Gemini previously
      // buffered every delta until `assertWithinMaxBudget` ran, then emitted
      // one mega-chunk. Now deltas reach the caller as the CLI produces
      // them — same UX contract as Claude / Codex.
      simulateGeminiRun([
        { type: "init", session_id: "s1", model: "gemini-2.5-flash" },
        { type: "message", role: "assistant", content: "chunk1", delta: true },
        { type: "message", role: "assistant", content: "chunk2", delta: true },
        {
          type: "result",
          status: "success",
          stats: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      const chunks: string[] = [];
      const onEnd = vi.fn();

      await core.execute(
        {
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gemini-2.5-flash",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        },
        { onText: (t) => chunks.push(t), onEnd },
      );

      expect(chunks).toEqual(["chunk1", "chunk2"]);
      expect(onEnd).toHaveBeenCalledTimes(1);
    });

    it("uses final non-delta message if available", async () => {
      simulateGeminiRun([
        { type: "init", session_id: "s1" },
        { type: "message", role: "assistant", content: "Final answer", delta: false },
        {
          type: "result",
          status: "success",
          stats: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      const result = await core.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gemini-2.5-pro",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
      });

      expect(result.output).toBe("Final answer");
    });

    it("uses delta content when the final non-delta message is whitespace", async () => {
      simulateGeminiRun([
        { type: "init", session_id: "s1" },
        { type: "message", role: "assistant", content: "Management ", delta: true },
        { type: "message", role: "assistant", content: "rules preview", delta: true },
        { type: "message", role: "assistant", content: "   ", delta: false },
        {
          type: "result",
          status: "success",
          stats: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      const chunks: string[] = [];
      const result = await core.execute(
        {
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gemini-2.5-pro",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        },
        { onText: (t) => chunks.push(t) },
      );

      // Result still aggregates to the full string for downstream
      // consumers (recordMessage, audit log) but live streaming preserves
      // delta granularity for SSE / dashboard chat.
      expect(result.output).toBe("Management rules preview");
      expect(chunks).toEqual(["Management ", "rules preview"]);
    });

    it("throws max_budget_usd with spend metadata so the audit row records actual cost", async () => {
      // Codex carries `spend` into `BackendQuotaError` so the dispatcher
      // can persist a `result='failed'` agent_actions row populated with
      // the cost / numTurns / durationMs that Google already billed
      // before the per-turn budget gate fired. Without that, the
      // dashboard silently misses the spend (see `BackendQuotaSpend` docs
      // in agent-core.ts). Gemini previously dropped this metadata —
      // mirroring Codex's contract closes the same audit gap.
      simulateGeminiRun([
        { type: "init", session_id: "s1" },
        { type: "tool_use", tool_id: "t1", tool_name: "read_file", args: {} },
        { type: "message", role: "assistant", content: "Final answer", delta: false },
        {
          type: "result",
          status: "success",
          stats: { input_tokens: 100, output_tokens: 50 },
        },
      ]);

      const chunks: string[] = [];
      const error = (await core
        .execute({
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gemini-2.5-pro",
          maxTurns: 10,
          maxBudgetUsd: 0.0005,
        }, {
          onText: (text) => chunks.push(text),
        })
        .catch((err: unknown) => err)) as BackendQuotaError;

      expect(error).toBeInstanceOf(BackendQuotaError);
      expect(error).toMatchObject({ originalCode: "max_budget_usd" });
      expect(chunks).toEqual([]);
      // Spend metadata must be present and reflect the real run (1
      // tool_use + 1 final assistant turn = numTurns 2). costUsd is
      // computed from registry pricing; we only assert it's positive to
      // avoid pinning to a specific cents value that drifts with model
      // pricing updates.
      expect(error.spend).not.toBeNull();
      expect(error.spend?.modelId).toBe("gemini-2.5-pro");
      expect(error.spend?.numTurns).toBe(2);
      expect(error.spend?.costUsd).toBeGreaterThan(0);
      expect(error.spend?.usage.inputTokens).toBeGreaterThan(0);
      expect(typeof error.spend?.durationMs).toBe("number");
    });

    it("reports numTurns from observed tool_use events (matches Codex contract)", async () => {
      // Regression for the 'Customize Your Rules' force-stop bug: Gemini
      // previously hardcoded `numTurns: 1` regardless of how many model→tool
      // round-trips actually ran. The dispatcher/audit log treated every
      // multi-tool turn like a single-shot reply, which broke per-process
      // accounting and hid runaway sessions. Now `numTurns` is derived
      // from the `tool_use` events observed in the stream (one per
      // tool-call round-trip + one for the final assistant reply), mirroring
      // how `CodexCore` increments on `turn.started`.
      simulateGeminiRun([
        { type: "init", session_id: "s1", model: "gemini-2.5-pro" },
        {
          type: "tool_use",
          tool_id: "t1",
          tool_name: "read_file",
          args: { path: "x" },
        },
        { type: "tool_result", tool_id: "t1", status: "ok", output: "" },
        {
          type: "tool_use",
          tool_id: "t2",
          tool_name: "read_file",
          args: { path: "y" },
        },
        { type: "tool_result", tool_id: "t2", status: "ok", output: "" },
        { type: "message", role: "assistant", content: "Done.", delta: false },
        {
          type: "result",
          status: "success",
          stats: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      const result = await core.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gemini-2.5-pro",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
      });

      // 2 tool-call turns + 1 final assistant turn = 3.
      expect(result.numTurns).toBe(3);
      expect(result.isError).toBe(false);
    });

    it("aborts and throws max_turns when tool_use count exceeds the cap", async () => {
      // Without daemon-side enforcement, Gemini-CLI has no `--max-turns`
      // flag (verified via `gemini --help`) and `params.maxTurns` was
      // silently dropped. A runaway setup.initial / dashboard.chat would
      // burn the full `executeTimeoutMinutes` wall-clock (60 min default)
      // before any safety net fired — the user-reported "Customize Your
      // Rules force-stop / very-slow" symptom. The fix counts `tool_use`
      // events and aborts the subprocess via AbortController once the
      // cap is crossed, surfacing as `BackendDecisiveFailure("max_turns")`
      // identical to how Claude's SDK reports the same condition.
      //
      // The cap is enforced as `toolCallCount > maxTurns` (exclusive of
      // the cap itself) so existing absolute-block audit tests that pass
      // `maxTurns: 1` together with a single `tool_use` event keep
      // succeeding — see the comment in `runTurn` for the full
      // rationale on that semantic choice. With `maxTurns: 2`, the
      // abort therefore fires on the THIRD `tool_use` event (the first
      // call that would push the running total past 2). The
      // `simulateGeminiRun` helper honours `options.abortSignal.aborted`
      // exactly like the real subprocess kill chain, so the post-abort
      // message / result events should never reach the parser.
      simulateGeminiRun([
        { type: "init", session_id: "s1", model: "gemini-2.5-pro" },
        { type: "tool_use", tool_id: "t1", tool_name: "read_file", args: {} },
        { type: "tool_use", tool_id: "t2", tool_name: "read_file", args: {} },
        // The third tool_use is the one that crosses the cap — the
        // counter increments to 3, `3 > 2` trips, abort fires.
        { type: "tool_use", tool_id: "t3", tool_name: "read_file", args: {} },
        // Everything below must not reach the parser once the abort fires.
        { type: "message", role: "assistant", content: "should not see me", delta: true },
        { type: "message", role: "assistant", content: "or me", delta: false },
        {
          type: "result",
          status: "success",
          stats: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      const chunks: string[] = [];
      const onEnd = vi.fn();
      const error = await core
        .execute(
          {
            prompt: "test",
            context: "ctx",
            event: makeEvent(),
            modelId: "gemini-2.5-pro",
            maxTurns: 2,
            maxBudgetUsd: 1.0,
          },
          { onText: (t) => chunks.push(t), onEnd },
        )
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BackendDecisiveFailure);
      expect(error).toMatchObject({ kind: "max_turns", backendId: "gemini" });
      // Abort happens during the third tool_use; the post-abort message
      // deltas must not have been streamed to the caller.
      expect(chunks).toEqual([]);
      // `onEnd` still fires from the `finally` block — keep that contract
      // consistent with the normal-completion path so downstream SSE
      // consumers see a clean "stream closed" signal even on abort.
      expect(onEnd).toHaveBeenCalledTimes(1);
    });
  });

  describe("stats.models aggregation (auto-routing)", () => {
    it("records per-model usage when Gemini auto-routes across multiple models", async () => {
      simulateGeminiRun([
        { type: "init", session_id: "s1", model: "auto-gemini-3" },
        { type: "message", role: "assistant", content: "done", delta: true },
        {
          type: "result",
          status: "success",
          stats: {
            total_tokens: 19689,
            input_tokens: 19147,
            output_tokens: 101,
            cached: 0,
            duration_ms: 13593,
            models: {
              "gemini-2.5-flash-lite": {
                total_tokens: 3357,
                input_tokens: 2936,
                output_tokens: 72,
                cached: 0,
              },
              "gemini-3-flash-preview": {
                total_tokens: 16332,
                input_tokens: 16211,
                output_tokens: 29,
                cached: 0,
              },
            },
          },
        },
      ]);

      const result = await core.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gemini-2.5-pro",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
      });

      // modelUsage should contain entries for both actual models
      expect(Object.keys(result.modelUsage)).toHaveLength(2);
      expect(result.modelUsage["gemini-2.5-flash-lite"]).toBeDefined();
      expect(result.modelUsage["gemini-3-flash-preview"]).toBeDefined();

      // Check individual model token counts
      expect(result.modelUsage["gemini-2.5-flash-lite"]!.inputTokens).toBe(2936);
      expect(result.modelUsage["gemini-2.5-flash-lite"]!.outputTokens).toBe(72);
      expect(result.modelUsage["gemini-3-flash-preview"]!.inputTokens).toBe(16211);
      expect(result.modelUsage["gemini-3-flash-preview"]!.outputTokens).toBe(29);

      // Auto-routed models may not be in the price registry, so per-model
      // costUsd can be 0. The important thing is the structure is correct.
      expect(result.costUsd).toBeGreaterThanOrEqual(0);

      // actualModelId should be first model in the usage map
      expect(result.modelId).toBe("gemini-2.5-flash-lite");
    });

    it("falls back to requested model when stats.models is absent", async () => {
      simulateGeminiRun([
        { type: "init", session_id: "s1" },
        { type: "message", role: "assistant", content: "ok", delta: true },
        {
          type: "result",
          status: "success",
          stats: { input_tokens: 100, output_tokens: 50 },
        },
      ]);

      const result = await core.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gemini-2.5-pro",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
      });

      expect(result.modelId).toBe("gemini-2.5-pro");
    });
  });

  describe("error classification", () => {
    it("throws BackendQuotaError on rate limit / 429", async () => {
      simulateGeminiRun(
        [
          { type: "init", session_id: "s1" },
        ],
        1,
        ["Error: rate limit exceeded (429)"],
      );

      await expect(
        core.execute({
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gemini-2.5-pro",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        }),
      ).rejects.toBeInstanceOf(BackendQuotaError);
    });

    it("throws BackendQuotaError with max_budget_usd on budget limit messages", async () => {
      simulateGeminiRun(
        [
          { type: "init", session_id: "s1" },
          {
            type: "result",
            status: "error",
            stats: { input_tokens: 0, output_tokens: 0 },
            error: "Reached maximum budget ($1.00)",
          },
        ],
        1,
      );

      const error = await core
        .execute({
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gemini-2.5-pro",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        })
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BackendQuotaError);
      expect(error).toMatchObject({ originalCode: "max_budget_usd" });
    });

    it("throws BackendQuotaError on quota keyword in result error", async () => {
      simulateGeminiRun(
        [
          { type: "init", session_id: "s1" },
          {
            type: "result",
            status: "error",
            stats: { input_tokens: 0, output_tokens: 0 },
            error: "Quota exceeded for this project",
          },
        ],
        1,
      );

      await expect(
        core.execute({
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gemini-2.5-pro",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        }),
      ).rejects.toBeInstanceOf(BackendQuotaError);
    });

    it("throws BackendDecisiveFailure with kind=auth on authentication errors", async () => {
      simulateGeminiRun(
        [
          { type: "init", session_id: "s1" },
        ],
        1,
        ["Error: authentication page required, please run: gemini auth login"],
      );

      const error = await core
        .execute({
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gemini-2.5-pro",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        })
        .catch((e) => e);

      expect(error).toBeInstanceOf(BackendDecisiveFailure);
      expect((error as BackendDecisiveFailure).kind).toBe("auth");
    });

    it("throws BackendDecisiveFailure with kind=policy_denied when the CLI rejects a tool by policy", async () => {
      // Matches the production failure shape observed for event
      // 5400e2a4-f44c-41ea-af9d-c8293797581c: the Gemini CLI returns
      // exitCode 0 but emits a result event whose status is non-success
      // and whose `error` field is the "Tool execution denied by policy"
      // wrap. Pre-fix this fell into `other_non_retryable`; the fix is to
      // route it to a dedicated `policy_denied` kind so dashboards/audit
      // can distinguish an agent-side intent violation from an opaque
      // backend failure.
      simulateGeminiRun([
        { type: "init", session_id: "s1" },
        {
          type: "result",
          status: "error",
          stats: { input_tokens: 0, output_tokens: 0 },
          error:
            "Error executing tool run_shell_command: Tool execution denied by policy. curl with command chaining is not allowed. Use separate tool calls.",
        },
      ]);

      const error = await core
        .execute({
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gemini-2.5-pro",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        })
        .catch((e) => e);

      expect(error).toBeInstanceOf(BackendDecisiveFailure);
      expect((error as BackendDecisiveFailure).kind).toBe("policy_denied");
      expect(((error as BackendDecisiveFailure).cause as Error).message).toContain(
        "denied by policy",
      );
    });

    it("throws BackendDecisiveFailure with kind=timeout when process times out", async () => {
      mockRunLineCommand.mockResolvedValue({
        exitCode: null,
        signal: "SIGTERM" as NodeJS.Signals,
        stdoutLines: [],
        stderrLines: [],
        timedOut: true,
      });

      const error = await core
        .execute({
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gemini-2.5-pro",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        })
        .catch((e) => e);

      expect(error).toBeInstanceOf(BackendDecisiveFailure);
      expect((error as BackendDecisiveFailure).kind).toBe("timeout");
    });

    it("handles result with nested result object (variant format)", async () => {
      simulateGeminiRun([
        { type: "init", session_id: "s1" },
        { type: "message", role: "assistant", content: "ok", delta: true },
        {
          type: "result",
          result: {
            status: "success",
            stats: { input_tokens: 100, output_tokens: 50, duration_ms: 1000 },
          },
        },
      ]);

      const result = await core.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gemini-2.5-flash",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
      });

      expect(result.isError).toBe(false);
      expect(result.usage.inputTokens).toBe(100);
    });
  });

  describe("executeResume", () => {
    it("passes --resume flag to the CLI", async () => {
      simulateGeminiRun([
        { type: "init", session_id: "gem-session-2" },
        { type: "message", role: "assistant", content: "resumed", delta: true },
        {
          type: "result",
          status: "success",
          stats: { input_tokens: 50, output_tokens: 25 },
        },
      ]);

      const result = await core.executeResume({
        sessionId: "gem-session-1",
        message: "follow up",
        modelId: "gemini-2.5-pro",
        sessionDir: TEST_RESUME_DIR,
      });

      expect(result.backendId).toBe("gemini");
      expect(result.isError).toBe(false);

      // Verify --resume was passed in the args
      const callArgs = mockRunLineCommand.mock.calls[0]?.[0];
      expect(callArgs?.args).toContain("--resume");
      expect(callArgs?.args).toContain("gem-session-1");
    });

    it("injects daemon API helper env with a subprocess-only read token", async () => {
      simulateGeminiRun([
        { type: "init", session_id: "s1" },
        { type: "message", role: "assistant", content: "done", delta: true },
        {
          type: "result",
          status: "success",
          stats: { input_tokens: 50, output_tokens: 25 },
        },
      ]);

      core.setReadToken("gemini-read-token");
      await core.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gemini-2.5-pro",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
        processKey: "routine.activity_scan",
      });

      expect(mockCreateSessionWorkdir).toHaveBeenCalledWith(
        ".",
        "routine.activity_scan",
        // CONTEXT_VAULT_REDESIGN_PLAN.md v4 V11 — user skills root is
        // `<contextDir>/policies/skills`. Test config sets dataDir=/tmp/test
        // and uses plain vault mode → contextDir=/tmp/test/context.
        "/tmp/test/context/policies/skills",
        expect.objectContaining({
          backendId: "gemini",
        }),
      );
      const env = mockRunLineCommand.mock.calls[0]?.[0]?.env ?? {};
      expect(env.PA_DAEMON_API_BASE_URL).toBe("http://127.0.0.1:8321");
      expect(env.PA_DAEMON_READ_TOKEN).toBe("gemini-read-token");
      expect(env.PATH).toContain(`${TEST_WORKDIR}/.pa/bin`);
      // params.processKey must reach the session env as PA_PROCESS_KEY —
      // the CLI shim turns it into the x-process-key header on
      // PATCH /api/agent-actions/self (session_identity_missing 400
      // without it).
      expect(env.PA_PROCESS_KEY).toBe("routine.activity_scan");
    });

    it("throws BackendDecisiveFailure when resume fails", async () => {
      simulateGeminiRun(
        [
          { type: "init", session_id: "s1" },
          { type: "result", status: "error", error: "Session not found" },
        ],
        1,
      );

      const error = await core
        .executeResume({
          sessionId: "nonexistent",
          message: "follow up",
          modelId: "gemini-2.5-pro",
          sessionDir: TEST_RESUME_DIR,
        })
        .catch((e) => e);

      expect(error).toBeInstanceOf(BackendDecisiveFailure);
    });
  });

  describe("checkAuth", () => {
    // Valid Google API key format: `AIza` + 35 chars.
    const VALID_KEY = "AIzaSyA0123456789_0123456789-0123456789";

    it("returns not ok when CLI is not installed", async () => {
      // cliPath is resolved at construction — re-mock and re-construct.
      const { findExecutable } = await import("./cli-utils.js");
      vi.mocked(findExecutable).mockReturnValueOnce(null);
      const noCliCore = new GeminiCliCore(makeConfig());
      const origGemini = process.env.GEMINI_API_KEY;
      const origGoogle = process.env.GOOGLE_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      try {
        const result = await noCliCore.checkAuth();
        expect(result.ok).toBe(false);
        expect((result as { reason: string }).reason).toContain("not installed");
      } finally {
        if (origGemini !== undefined) process.env.GEMINI_API_KEY = origGemini;
        if (origGoogle !== undefined) process.env.GOOGLE_API_KEY = origGoogle;
      }
    });

    it("returns ok with api_key when GEMINI_API_KEY is a plausible key", async () => {
      const original = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = VALID_KEY;
      try {
        const result = await core.checkAuth();
        expect(result).toEqual({ ok: true, method: "api_key" });
      } finally {
        if (original === undefined) {
          delete process.env.GEMINI_API_KEY;
        } else {
          process.env.GEMINI_API_KEY = original;
        }
      }
    });

    it("returns ok with api_key when GOOGLE_API_KEY is a plausible key", async () => {
      const origGemini = process.env.GEMINI_API_KEY;
      const origGoogle = process.env.GOOGLE_API_KEY;
      delete process.env.GEMINI_API_KEY;
      process.env.GOOGLE_API_KEY = VALID_KEY;
      try {
        const result = await core.checkAuth();
        expect(result).toEqual({ ok: true, method: "api_key" });
      } finally {
        if (origGemini === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = origGemini;
        if (origGoogle === undefined) delete process.env.GOOGLE_API_KEY;
        else process.env.GOOGLE_API_KEY = origGoogle;
      }
    });

    it("rejects a malformed GEMINI_API_KEY", async () => {
      const origGemini = process.env.GEMINI_API_KEY;
      const origGoogle = process.env.GOOGLE_API_KEY;
      process.env.GEMINI_API_KEY = "not-a-google-key";
      delete process.env.GOOGLE_API_KEY;
      try {
        const result = await core.checkAuth();
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toMatch(/AIza/);
        }
      } finally {
        if (origGemini === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = origGemini;
        if (origGoogle !== undefined) process.env.GOOGLE_API_KEY = origGoogle;
      }
    });
  });

  describe("listModels", () => {
    it("returns gemini models from the registry", () => {
      const models = core.listModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models.every((m) => m.backendId === "gemini")).toBe(true);
      // Should include both high and lite tiers
      expect(models.some((m) => m.tier === "high")).toBe(true);
      expect(models.some((m) => m.tier === "lite")).toBe(true);
    });
  });

  describe("cost estimation with auto-routing", () => {
    it("sums per-model costs when stats.models is present", async () => {
      simulateGeminiRun([
        { type: "init", session_id: "s1" },
        { type: "message", role: "assistant", content: "ok", delta: true },
        {
          type: "result",
          status: "success",
          stats: {
            total_tokens: 2000,
            input_tokens: 1500,
            output_tokens: 500,
            models: {
              "gemini-2.5-flash": {
                input_tokens: 1000,
                output_tokens: 300,
                cached: 0,
              },
              "gemini-2.5-pro": {
                input_tokens: 500,
                output_tokens: 200,
                cached: 0,
              },
            },
          },
        },
      ]);

      const result = await core.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gemini-2.5-pro",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
      });

      // Each model entry should have its own costUsd
      const flashCost = result.modelUsage["gemini-2.5-flash"]?.costUsd ?? 0;
      const proCost = result.modelUsage["gemini-2.5-pro"]?.costUsd ?? 0;

      expect(flashCost).toBeGreaterThan(0);
      expect(proCost).toBeGreaterThan(0);

      // Total should equal sum of per-model costs
      expect(result.costUsd).toBeCloseTo(flashCost + proCost, 6);
    });

    it("prefers cached LiteLLM pricing for requested model totals", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "pa-gemini-pricing-"));
      mkdirSync(join(dataDir, "cache"), { recursive: true });
      writeFileSync(
        join(dataDir, "cache", "model-prices.json"),
        JSON.stringify({
          fetchedAt: new Date().toISOString(),
          prices: {
            "gemini-2.5-pro": {
              input_cost_per_token: 0.000003,
              output_cost_per_token: 0.000012,
            },
          },
        }),
      );

      simulateGeminiRun([
        { type: "init", session_id: "s1" },
        { type: "message", role: "assistant", content: "ok", delta: true },
        {
          type: "result",
          status: "success",
          stats: {
            input_tokens: 1000,
            output_tokens: 500,
          },
        },
      ]);

      try {
        const litellmCore = new GeminiCliCore(makeConfig({ dataDir }));
        const result = await litellmCore.execute({
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gemini-2.5-pro",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        });

        expect(result.costSource).toBe("litellm");
        expect(result.costUsd).toBeCloseTo(0.009, 6);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("marks aggregate costSource as hardcoded when auto-routed models mix cache and registry pricing", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "pa-gemini-pricing-mixed-"));
      mkdirSync(join(dataDir, "cache"), { recursive: true });
      writeFileSync(
        join(dataDir, "cache", "model-prices.json"),
        JSON.stringify({
          fetchedAt: new Date().toISOString(),
          prices: {
            "gemini-2.5-pro": {
              input_cost_per_token: 0.000003,
              output_cost_per_token: 0.000012,
            },
          },
        }),
      );

      simulateGeminiRun([
        { type: "init", session_id: "s1" },
        { type: "message", role: "assistant", content: "ok", delta: true },
        {
          type: "result",
          status: "success",
          stats: {
            input_tokens: 1500,
            output_tokens: 500,
            models: {
              "gemini-2.5-flash": {
                input_tokens: 1000,
                output_tokens: 300,
                cached: 0,
              },
              "gemini-2.5-pro": {
                input_tokens: 500,
                output_tokens: 200,
                cached: 0,
              },
            },
          },
        },
      ]);

      try {
        const mixedCore = new GeminiCliCore(makeConfig({ dataDir }));
        const result = await mixedCore.execute({
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gemini-2.5-pro",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        });

        expect(result.costSource).toBe("hardcoded");
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });
  });

  describe("admin policy and sandbox", () => {
    it("generateAdminPolicy produces valid TOML parseable by @iarna/toml", () => {
      // Use the same TOML parser that Gemini CLI bundles.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const toml = require("@iarna/toml") as { parse: (s: string) => { rule?: unknown[] } };
      const policy = core.generateAdminPolicy();
      const parsed = toml.parse(policy);
      expect(parsed.rule).toBeDefined();
      expect(Array.isArray(parsed.rule)).toBe(true);
      expect(parsed.rule!.length).toBeGreaterThan(10);
    });

    it("absolute-block rules are emitted in BOTH strict and allow mode at priority 999 (PolicyFileSchema in-tier ceiling)", () => {
      // EXECUTION-MODE-DESIGN.md §6.2 — the absolute-block layer holds in
      // both modes. Priority is pinned at 999 because Gemini CLI's
      // `PolicyFileSchema` rejects anything > 999 with "Schema validation
      // failed", which would drop the entire policy and silently disable
      // every other guardrail. Cross-tier precedence (admin vs user/
      // workspace/default) is preserved separately by `--admin-policy`,
      // so 999 still outranks any rule in lower tiers.
      const strictPolicy = core.generateAdminPolicy();
      const allowPolicy = core.generateAllowModeMinimalPolicy();
      for (const policy of [strictPolicy, allowPolicy]) {
        expect(policy).toContain("Absolute-block layer");
        expect(policy).toContain("priority = 999");
        // Representative entries from every §6.1 category.
        expect(policy).toContain('commandPrefix = "rm -rf"');
        expect(policy).toContain('commandPrefix = "sudo"');
      }
    });

    it("never emits a priority outside [0, 999] (Gemini PolicyFileSchema constraint)", () => {
      // Regression guard for the Gemini CLI 0.39.x policy schema:
      //   priority: z.number().int().min(0).max(999)
      // Any rule above 999 (e.g. the historical absolute-block at 1000)
      // makes Gemini drop the whole policy with "Schema validation failed",
      // and every delegated_proxy.invoke against this backend fails before
      // a tool call is even attempted. Exercise both modes AND a populated
      // disallowedTools/session-denied surface so a future contributor who
      // bumps `convertToolListToTomlRules` priority (currently 935) or
      // `buildSessionDeniedToolRules` (currently 936) gets caught here.
      const coreWithDisallowed = new GeminiCliCore(makeConfig({
        disallowedTools: [
          "Bash(rm -rf *)",
          "Read(~/.ssh/**)",
          "Write(~/.aws/**)",
        ],
      }));
      const policies = [
        core.generateAdminPolicy(),
        core.generateAdminPolicy({ webSearchEnabled: true }),
        core.generateAllowModeMinimalPolicy(),
        coreWithDisallowed.generateAdminPolicy(),
        coreWithDisallowed.generateAllowModeMinimalPolicy(),
      ];
      for (const policy of policies) {
        const matches = Array.from(policy.matchAll(/priority\s*=\s*(\d+)/g));
        expect(matches.length).toBeGreaterThan(0);
        for (const match of matches) {
          const value = parseInt(match[1], 10);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(999);
        }
      }
    });

    it("generateAdminPolicy with disallowedTools produces valid TOML", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const toml = require("@iarna/toml") as { parse: (s: string) => { rule?: unknown[] } };
      const coreWithDisallowed = new GeminiCliCore(makeConfig({
        disallowedTools: [
          'Bash(rm -rf *)', 'Bash(sudo *)',
          'Read(~/.ssh/**)', 'Write(~/.aws/**)', 'Edit(.env)',
        ],
      }));
      const policy = coreWithDisallowed.generateAdminPolicy();
      const parsed = toml.parse(policy);
      // Extra rules from disallowedTools
      expect(parsed.rule!.length).toBeGreaterThan(15);
    });

    it("generateAdminPolicy includes catch-all deny for whitelist semantics", () => {
      const policy = core.generateAdminPolicy();
      expect(policy).toContain('toolName = "*"');
      expect(policy).toContain("priority = 1");
    });

    it("generateAdminPolicy includes deny rules for web tools", () => {
      const policy = core.generateAdminPolicy();
      expect(policy).toContain('toolName = "google_web_search"');
      expect(policy).toContain('decision = "deny"');
      expect(policy).toContain('toolName = "web_fetch"');
    });

    it("generateAdminPolicy restricts curl to configured port", () => {
      const customCore = new GeminiCliCore(makeConfig({ apiPort: 9999 }));
      const policy = customCore.generateAdminPolicy();
      expect(policy).toContain("localhost:9999");
      // curl allow regex should reference the custom port
      expect(policy).toContain(":9999(/");
    });

    it("generateAdminPolicy blocks non-localhost URLs in shell commands", () => {
      const policy = core.generateAdminPolicy();
      expect(policy).toContain("non-localhost");
      expect(policy).toContain("priority = 960");
    });

    it("generateAdminPolicy blocks curl command chaining", () => {
      const policy = core.generateAdminPolicy();
      expect(policy).toContain("command chaining");
    });

    it("generateAdminPolicy blocks context dir writes", () => {
      const policy = core.generateAdminPolicy();
      // The context dir is derived from dataDir (/tmp/test/context)
      expect(policy).toContain("/tmp/test/context");
      expect(policy).toContain("Direct writes to context directory are forbidden");
    });

    it("generateAdminPolicy denies dangerous shell commands", () => {
      const policy = core.generateAdminPolicy();
      expect(policy).toContain('commandPrefix = "rm -rf"');
      expect(policy).toContain('commandPrefix = "sudo "');
      expect(policy).toContain('commandPrefix = "chmod "');
      expect(policy).toContain("git push --force");
      expect(policy).toContain("git reset --hard");
      expect(policy).toContain("git clean");
    });

    it("generateAdminPolicy denies sensitive path access", () => {
      const policy = core.generateAdminPolicy();
      expect(policy).toContain(".ssh/");
      expect(policy).toContain(".aws/");
      expect(policy).toContain(".gnupg/");
      expect(policy).toContain("Library/Keychains/");
    });

    it("generateAdminPolicy allows file read/write tools", () => {
      const policy = core.generateAdminPolicy();
      // Check for allow rules for file operations
      expect(policy).toMatch(/toolName = \[.*"read_file".*\].*\n.*decision = "allow"/);
      expect(policy).toMatch(/toolName = \[.*"write_file".*\].*\n.*decision = "allow"/);
    });

    it("generateAdminPolicy blocks curl connection-override flags", () => {
      const policy = core.generateAdminPolicy();
      expect(policy).toContain("--connect-to");
      expect(policy).toContain("--resolve");
      expect(policy).toContain("--proxy");
    });

    it("generateAdminPolicy denies invoke_agent (subagent dispatcher)", () => {
      // Regression guard: Gemini CLI's bundled policies/agents.toml allows
      // `invoke_agent` at default-tier priority 50; without an explicit
      // admin-tier deny, light-tier models (e.g. gemini-3.1-flash-lite-preview)
      // delegate proxy / per-turn calls to a `generalist` subagent. The
      // daemon's stream parser only sees the parent `invoke_agent` tool_use
      // and trips the anti-prompt-injection guard with errorClass=wrong_tool.
      const policy = core.generateAdminPolicy();
      expect(policy).toContain('toolName = "invoke_agent"');
      expect(policy).toContain("Subagent delegation via invoke_agent is not allowed");
    });

    it("generateAllowModeMinimalPolicy denies invoke_agent (subagent dispatcher)", () => {
      // Allow mode has no catch-all `*` deny, so without this rule the
      // bundled agents.toml allow at default tier wins and the proxy
      // returns wrong_tool whenever the lite model decides to delegate.
      const policy = core.generateAllowModeMinimalPolicy();
      expect(policy).toContain('toolName = "invoke_agent"');
      expect(policy).toContain("Subagent delegation via invoke_agent is not allowed");
    });

    it("generateAdminPolicy reflects config.disallowedTools", () => {
      const coreWithDisallowed = new GeminiCliCore(makeConfig({
        disallowedTools: [
          "Bash(npm publish *)",
          "Read(~/.gnupg/**)",
          "Write(.env)",
        ],
      }));
      const policy = coreWithDisallowed.generateAdminPolicy();
      expect(policy).toContain("User-configured disallowedTools");
      expect(policy).toContain('commandPrefix = "npm publish"');
      expect(policy).toContain(".gnupg/");
      expect(policy).toContain("Bash(npm publish *)");
    });

    describe("native-mode connector allow rules (INTEGRATION_NATIVE_MODE_DESIGN.md §11)", () => {
      // The admin policy catch-all (`toolName = "*"`, priority 1) denies any
      // unmatched tool — including native MCP calls. The agent's
      // `SKILL.native.gemini.md` body instructs the agent to call
      // `mcp_google-workspace_gmail.search` / similar; without an admin-tier
      // allow rule at higher-than-catch-all priority, those calls return
      // "permission denied" and the DM agent reports it can't access mail.
      // These tests pin the wire-up to the registry.
      let dataDir: string;
      let db: DatabaseType.Database;

      beforeEach(async () => {
        dataDir = mkdtempSync(join(tmpdir(), "pa-gemini-native-"));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Database = require("better-sqlite3") as typeof import("better-sqlite3");
        const { applySchema } = await import("../../db/schema.js");
        db = new (Database as unknown as new (path: string) => DatabaseType.Database)(":memory:");
        db.pragma("foreign_keys = ON");
        applySchema(db);
      });

      afterEach(() => {
        try {
          db?.close();
        } catch {
          /* best-effort */
        }
        try {
          rmSync(dataDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      });

      async function flipToNative(
        key: "gmail" | "google_calendar",
      ): Promise<GeminiCliCore> {
        const { writeIntegrations } = await import("../../db/integrations-store.js");
        writeIntegrations(db, {
          [key]: {
            mode: "native",
            nativeBackend: "gemini",
            deniedTools: [],
            lastChangedAt: new Date().toISOString(),
          },
        });
        const nativeCore = new GeminiCliCore(makeConfig({ dataDir }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        nativeCore.setMcpContext({ db, blobStore: {} as any });
        return nativeCore;
      }

      it("emits allow rules for Gmail native MCP tools at priority 920", async () => {
        const nativeCore = await flipToNative("gmail");
        const policy = nativeCore.generateAdminPolicy();
        expect(policy).toContain("Native-mode connector allow");
        // Read-class
        expect(policy).toContain('toolName = "mcp_google-workspace_gmail.search"');
        // Write-class (draft) — included because the registry enumerates
        // every capability tool; destructive-confirm is enforced via
        // skill body + deniedTools, not via this allowlist.
        expect(policy).toContain('toolName = "mcp_google-workspace_gmail.createDraft"');
        // Priority must place allow below sessionDeniedTools (936) and
        // above the catch-all deny (1).
        expect(policy).toMatch(
          /toolName = "mcp_google-workspace_gmail\.search"[\s\S]*?priority = 920/,
        );
      });

      it("emits allow rules for Google Calendar native MCP tools", async () => {
        const nativeCore = await flipToNative("google_calendar");
        const policy = nativeCore.generateAdminPolicy();
        expect(policy).toContain('toolName = "mcp_google-workspace_calendar.listEvents"');
        expect(policy).toContain('toolName = "mcp_google-workspace_calendar.createEvent"');
      });

      it("does NOT emit allow rules when integration is native to a different backend (claude)", async () => {
        const { writeIntegrations } = await import("../../db/integrations-store.js");
        writeIntegrations(db, {
          gmail: {
            mode: "native",
            nativeBackend: "claude",
            deniedTools: [],
            lastChangedAt: new Date().toISOString(),
          },
        });
        const claudeCore = new GeminiCliCore(makeConfig({ dataDir }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        claudeCore.setMcpContext({ db, blobStore: {} as any });
        const policy = claudeCore.generateAdminPolicy();
        expect(policy).not.toContain("Native-mode connector allow");
        expect(policy).not.toContain('toolName = "mcp_google-workspace_gmail.search"');
      });

      it("does NOT emit allow rules when integration is in delegated mode", async () => {
        // Cross-mode isolation: only mode === "native" contributes here.
        const { writeIntegrations } = await import("../../db/integrations-store.js");
        writeIntegrations(db, {
          gmail: {
            mode: "delegated",
            delegatedBackend: "gemini",
            deniedTools: [],
            lastChangedAt: new Date().toISOString(),
          },
        });
        const delegatedCore = new GeminiCliCore(makeConfig({ dataDir }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delegatedCore.setMcpContext({ db, blobStore: {} as any });
        const policy = delegatedCore.generateAdminPolicy();
        expect(policy).not.toContain("Native-mode connector allow");
      });

      it("emits no allow rules when no integrations are in native mode", async () => {
        const policy = core.generateAdminPolicy();
        expect(policy).not.toContain("Native-mode connector allow");
      });

      it("produces TOML still parseable by @iarna/toml after native allow rules append", async () => {
        const nativeCore = await flipToNative("gmail");
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const toml = require("@iarna/toml") as { parse: (s: string) => { rule?: unknown[] } };
        const policy = nativeCore.generateAdminPolicy();
        const parsed = toml.parse(policy);
        expect(parsed.rule).toBeDefined();
        expect(Array.isArray(parsed.rule)).toBe(true);
      });
    });

    it("--admin-policy is passed in BOTH strict and allow modes (invariant)", async () => {
      // Regression guard: the admin-policy is the ONLY mechanism on Gemini
      // for preserving context-dir integrity + sensitive-path reads in allow
      // mode. Dropping the flag (as an earlier iteration did) leaves nothing
      // between `--approval-mode yolo` and the filesystem.
      for (const mode of ["strict", "allow"] as const) {
        mockRunLineCommand.mockClear();
        const backendCore = new GeminiCliCore(
          makeConfig({ geminiExecutionPermissionMode: mode }),
        );
        simulateGeminiRun([
          { type: "init", session_id: "s1" },
          { type: "message", role: "assistant", content: "ok", delta: true },
          {
            type: "result",
            status: "success",
            stats: { input_tokens: 10, output_tokens: 5 },
          },
        ]);

        await backendCore.execute({
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gemini-2.5-pro",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        });

        const args = mockRunLineCommand.mock.calls[0]?.[0]?.args ?? [];
        expect(args).toContain("--admin-policy");
        expect(args).toContain("--approval-mode");
        expect(args[args.indexOf("--approval-mode") + 1]).toBe("yolo");
      }
    });

    it("buildArgs includes --sandbox and --admin-policy flags", async () => {
      simulateGeminiRun([
        { type: "init", session_id: "s1" },
        { type: "message", role: "assistant", content: "ok", delta: true },
        {
          type: "result",
          status: "success",
          stats: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      await core.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gemini-2.5-pro",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
      });

      const callArgs = mockRunLineCommand.mock.calls[0]?.[0];
      expect(callArgs?.args).toContain("--sandbox");
      expect(callArgs?.args).toContain("--admin-policy");
      // Daemon-created session workdirs aren't interactively trusted; the
      // admin policy is the actual safety surface, so --skip-trust must
      // bypass the trusted-folders gate or every Gemini run errors out
      // with "Gemini CLI is not running in a trusted directory".
      expect(callArgs?.args).toContain("--skip-trust");

      // Policy path should be in the session workdir
      const policyIndex = callArgs?.args.indexOf("--admin-policy");
      expect(policyIndex).toBeDefined();
      const policyPath = callArgs?.args[(policyIndex ?? 0) + 1];
      expect(policyPath).toContain(".pa-admin-policy.toml");
    });

    it("writes admin policy file to session workdir before execution", async () => {
      simulateGeminiRun([
        { type: "init", session_id: "s1" },
        { type: "message", role: "assistant", content: "ok", delta: true },
        {
          type: "result",
          status: "success",
          stats: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      await core.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gemini-2.5-pro",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
      });

      // Policy file should exist in the session workdir
      const policyPath = join(TEST_WORKDIR, ".pa-admin-policy.toml");
      expect(existsSync(policyPath)).toBe(true);
      const policyContent = readFileSync(policyPath, "utf-8");
      expect(policyContent).toContain("google_web_search");
      expect(policyContent).toContain("web_fetch");
    });

    it("allow mode drops --sandbox (container) but keeps --admin-policy pointing at a minimal policy", async () => {
      const allowCore = new GeminiCliCore(
        makeConfig({ geminiExecutionPermissionMode: "allow" }),
      );
      simulateGeminiRun([
        { type: "init", session_id: "s1" },
        { type: "message", role: "assistant", content: "ok", delta: true },
        {
          type: "result",
          status: "success",
          stats: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      await allowCore.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gemini-2.5-pro",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
      });

      const args = mockRunLineCommand.mock.calls[0]?.[0]?.args ?? [];
      // Container sandbox off (--sandbox), yolo approval on.
      expect(args).not.toContain("--sandbox");
      expect(args).toContain("--approval-mode");
      expect(args[args.indexOf("--approval-mode") + 1]).toBe("yolo");
      // Admin policy always passed so memory-layer + secret-path invariants
      // survive allow mode.
      expect(args).toContain("--admin-policy");
      const policyPath = join(TEST_WORKDIR, ".pa-admin-policy.toml");
      expect(existsSync(policyPath)).toBe(true);
      const policy = readFileSync(policyPath, "utf-8");
      // Minimal policy — has context-dir + sensitive-path denies, no
      // catch-all. Everything else falls through to yolo.
      expect(policy).toContain("Allow mode (minimal)");
      expect(policy).toContain("context directory");
      expect(policy).not.toContain('toolName = "*"');
    });
  });

  describe("generateAllowModeMinimalPolicy", () => {
    it("produces valid TOML with only narrow denies", async () => {
      const { parse } = await import("@iarna/toml");
      const policy = core.generateAllowModeMinimalPolicy();
      const parsed = parse(policy) as { rule?: Array<Record<string, unknown>> };
      const rules = parsed.rule ?? [];
      // No catch-all deny rule — allow mode inherits yolo for unmatched tools.
      expect(rules.every((r) => r.toolName !== "*")).toBe(true);
      // Every rule in the minimal policy is a deny.
      expect(rules.every((r) => r.decision === "deny")).toBe(true);
    });

    it("denies context-dir writes (write_file/replace + shell command regex)", () => {
      const policy = core.generateAllowModeMinimalPolicy();
      // write_file / replace direct denial.
      expect(policy).toMatch(
        /toolName = \["write_file", "replace"\][\s\S]*?decision = "deny"/,
      );
      // shell command denial references the context dir path somehow.
      expect(policy).toContain('toolName = "run_shell_command"');
      expect(policy).toContain("context directory");
    });

    it("shell-command regex matches absolute, ~, and $HOME / ${HOME} path forms", async () => {
      const { parse } = await import("@iarna/toml");
      const { homedir } = await import("node:os");
      const { join, resolve } = await import("node:path");
      const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");

      const fakeHome = mkdtempSync(join(tmpdir(), "pa-gemini-home-"));
      vi.stubEnv("HOME", fakeHome);
      try {
        // Put dataDir under $HOME so the home-tilde forms are activated.
        const home = homedir();
        const dataDir = mkdtempSync(resolve(home, ".pa-gemini-obfuscation-"));
        mkdirSync(resolve(dataDir, "context"), { recursive: true });
        const homeCore = new GeminiCliCore(
          makeConfig({ dataDir, geminiExecutionPermissionMode: "allow" }),
        );
        const policy = homeCore.generateAllowModeMinimalPolicy();
        const parsed = parse(policy) as {
          rule?: Array<{ toolName?: unknown; commandRegex?: string }>;
        };
        const shellRule = (parsed.rule ?? []).find(
          (r) => r.toolName === "run_shell_command" && r.commandRegex,
        );
        expect(shellRule).toBeDefined();
        const regex = new RegExp(shellRule!.commandRegex as string);

        const contextDir = resolve(dataDir, "context");
        const tilde = contextDir.replace(home, "~");
        const dollar = contextDir.replace(home, "$HOME");
        const braced = contextDir.replace(home, "${HOME}");

        expect(regex.test(`echo > ${contextDir}/today.md`)).toBe(true);
        expect(regex.test(`tee ${tilde}/user.md`)).toBe(true);
        expect(regex.test(`cat > ${dollar}/user.md`)).toBe(true);
        expect(regex.test(`cp ${braced}/user.md /tmp/`)).toBe(true);
        expect(regex.test("curl http://localhost:8321/api/health")).toBe(false);
        rmSync(dataDir, { recursive: true, force: true });
      } finally {
        vi.unstubAllEnvs();
        rmSync(fakeHome, { recursive: true, force: true });
      }
    });

    it("denies sensitive-path reads (ssh, aws, gnupg, keychain, .env, secrets)", () => {
      const policy = core.generateAllowModeMinimalPolicy();
      for (const fragment of [
        "\\.ssh[\\\\/]",
        "\\.aws[\\\\/]",
        "\\.gnupg[\\\\/]",
        "Library[\\\\/]Keychains[\\\\/]",
        "\\.env",
        "\\.personal-agent[\\\\/]secrets[\\\\/]",
        "\\.personal-agent[\\\\/]backups[\\\\/]",
      ]) {
        expect(policy).toContain(fragment);
      }
    });

    it("sensitive-path regex actually blocks root .env reads (JSON-stringified args)", async () => {
      // Regression guard: Gemini applies argsPattern against the JSON-
      // stringified args object (e.g. `{"file_path":".env"}`). The prior
      // pattern `\.env($|\.|/)` silently missed root `.env` because the
      // terminator set did not include the JSON closing-quote `"`. The
      // canonical fix is to add `\"` to the alternation.
      const { parse } = await import("@iarna/toml");
      const policy = core.generateAllowModeMinimalPolicy();
      const parsed = parse(policy) as {
        rule?: Array<{ toolName?: unknown; argsPattern?: string; decision?: string }>;
      };
      const sensitiveRule = (parsed.rule ?? []).find(
        (r) =>
          Array.isArray(r.toolName) &&
          (r.toolName as string[]).includes("read_file") &&
          r.argsPattern,
      );
      expect(sensitiveRule).toBeDefined();
      const regex = new RegExp(sensitiveRule!.argsPattern as string);

      // Exact paths Gemini would serialize for read_file / write_file.
      expect(regex.test('{"file_path":".env"}')).toBe(true);
      expect(regex.test('{"file_path":".env.local"}')).toBe(true);
      expect(regex.test('{"file_path":"/path/to/.env"}')).toBe(true);
      expect(regex.test('{"file_path":"~/.ssh/id_rsa"}')).toBe(true);
      // Non-sensitive paths stay allowed.
      expect(regex.test('{"file_path":"/tmp/notes.md"}')).toBe(false);
    });
  });

  describe("summarize", () => {
    it("returns the output from a summary run", async () => {
      simulateGeminiRun([
        { type: "init", session_id: "s-summary" },
        { type: "message", role: "assistant", content: "Summary text", delta: true },
        {
          type: "result",
          status: "success",
          stats: { input_tokens: 50, output_tokens: 25 },
        },
      ]);

      const result = await core.summarize("conversation text here");
      expect(result).toBe("Summary text");
    });
  });

  describe("trackVaultWrite", () => {
    it("marks vault-scoped writes when writeTracker is present", async () => {
      const markWriting = vi.fn();
      const trackerCore = new GeminiCliCore(
        makeConfig({ externalObsidianVaultPath: "/Users/test/vault" }),
        { markWriting, wasRecentlyWritten: vi.fn() } as any,
      );

      simulateGeminiRun([
        { type: "init", session_id: "s1" },
        {
          type: "tool_use",
          tool_name: "write_file",
          args: { file_path: "/Users/test/vault/note.md" },
        },
        { type: "message", role: "assistant", content: "done", delta: true },
        {
          type: "result",
          status: "success",
          stats: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      await trackerCore.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gemini-2.5-pro",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
      });

      expect(markWriting).toHaveBeenCalledWith(
        expect.stringContaining("/Users/test/vault/note.md"),
      );
    });

    it("does not mark writes outside the vault path", async () => {
      const markWriting = vi.fn();
      const trackerCore = new GeminiCliCore(
        makeConfig({ externalObsidianVaultPath: "/Users/test/vault" }),
        { markWriting, wasRecentlyWritten: vi.fn() } as any,
      );

      simulateGeminiRun([
        { type: "init", session_id: "s1" },
        {
          type: "tool_use",
          tool_name: "write_file",
          args: { file_path: "/tmp/other/file.md" },
        },
        { type: "message", role: "assistant", content: "done", delta: true },
        {
          type: "result",
          status: "success",
          stats: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      await trackerCore.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gemini-2.5-pro",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
      });

      expect(markWriting).not.toHaveBeenCalled();
    });

    it("ignores non-write tool_use events", async () => {
      const markWriting = vi.fn();
      const trackerCore = new GeminiCliCore(
        makeConfig({ externalObsidianVaultPath: "/Users/test/vault" }),
        { markWriting, wasRecentlyWritten: vi.fn() } as any,
      );

      simulateGeminiRun([
        { type: "init", session_id: "s1" },
        {
          type: "tool_use",
          tool_name: "read_file",
          args: { file_path: "/Users/test/vault/note.md" },
        },
        { type: "message", role: "assistant", content: "done", delta: true },
        {
          type: "result",
          status: "success",
          stats: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      await trackerCore.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gemini-2.5-pro",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
      });

      expect(markWriting).not.toHaveBeenCalled();
    });
  });

  describe("edge cases in stream handling", () => {
    it("ignores empty assistant content", async () => {
      simulateGeminiRun([
        { type: "init", session_id: "s1" },
        { type: "message", role: "assistant", content: "", delta: true },
        { type: "message", role: "assistant", content: "actual output", delta: true },
        {
          type: "result",
          status: "success",
          stats: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      const chunks: string[] = [];
      await core.execute(
        {
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gemini-2.5-pro",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        },
        { onText: (t) => chunks.push(t) },
      );

      expect(chunks).toEqual(["actual output"]);
    });

    it("handles non-JSON stdout lines that match failure pattern", async () => {
      simulateGeminiRun(
        [
          { type: "init", session_id: "s1" },
        ],
        1,
        [],
      );

      // Override the mock to emit a non-JSON error line too
      mockRunLineCommand.mockImplementation(async (options) => {
        options.onStdoutLine?.("Error: API key invalid");
        return {
          exitCode: 1,
          signal: null,
          stdoutLines: ["Error: API key invalid"],
          stderrLines: [],
          timedOut: false,
        };
      });

      const error = await core
        .execute({
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gemini-2.5-pro",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        })
        .catch((e) => e);

      expect(error).toBeInstanceOf(BackendDecisiveFailure);
    });

    it("sends non-streamed output to onText when only final message is present", async () => {
      simulateGeminiRun([
        { type: "init", session_id: "s1" },
        { type: "message", role: "assistant", content: "Final answer", delta: false },
        {
          type: "result",
          status: "success",
          stats: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      const chunks: string[] = [];
      await core.execute(
        {
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gemini-2.5-pro",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        },
        { onText: (t) => chunks.push(t) },
      );

      expect(chunks).toEqual(["Final answer"]);
    });
  });

  describe("checkAuth - vertex and no auth", () => {
    it("returns ok with vertex when GOOGLE_APPLICATION_CREDENTIALS and PROJECT are set", async () => {
      const origGemini = process.env.GEMINI_API_KEY;
      const origGoogle = process.env.GOOGLE_API_KEY;
      const origGAC = process.env.GOOGLE_APPLICATION_CREDENTIALS;
      const origGCP = process.env.GOOGLE_CLOUD_PROJECT;
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      process.env.GOOGLE_APPLICATION_CREDENTIALS = "/path/to/creds.json";
      process.env.GOOGLE_CLOUD_PROJECT = "my-project";
      try {
        const result = await core.checkAuth();
        expect(result).toEqual({ ok: true, method: "vertex" });
      } finally {
        if (origGemini === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = origGemini;
        if (origGoogle === undefined) delete process.env.GOOGLE_API_KEY;
        else process.env.GOOGLE_API_KEY = origGoogle;
        if (origGAC === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
        else process.env.GOOGLE_APPLICATION_CREDENTIALS = origGAC;
        if (origGCP === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
        else process.env.GOOGLE_CLOUD_PROJECT = origGCP;
      }
    });
  });

  describe("generateAdminPolicy web search rules", () => {
    it("denies both google_web_search and web_fetch by default", () => {
      const policy = core.generateAdminPolicy();
      // Both should be denied at priority 999
      expect(policy).toMatch(/toolName = "google_web_search"\ndecision = "deny"/);
      expect(policy).toMatch(/toolName = "web_fetch"\ndecision = "deny"/);
    });

    it("allows google_web_search but still denies web_fetch when webSearchEnabled", () => {
      const policy = core.generateAdminPolicy({ webSearchEnabled: true });
      // google_web_search should be allowed
      expect(policy).toMatch(/toolName = "google_web_search"\ndecision = "allow"/);
      // web_fetch must remain denied (exfiltration risk)
      expect(policy).toMatch(/toolName = "web_fetch"\ndecision = "deny"/);
    });

    it("does not contain allow rules for web tools when disabled", () => {
      const policy = core.generateAdminPolicy({ webSearchEnabled: false });
      expect(policy).not.toMatch(/toolName = "google_web_search"\ndecision = "allow"/);
    });

    it("allows web_fetch (only) when wikiUrlFetchEnabled is set", () => {
      const policy = core.generateAdminPolicy({ wikiUrlFetchEnabled: true });
      // web_fetch flips from deny→allow for wiki ingestion turns.
      expect(policy).toMatch(/toolName = "web_fetch"\ndecision = "allow"/);
      // google_web_search stays denied — wiki only widens the URL-fetch
      // path; free-form web search is a separate toggle.
      expect(policy).toMatch(/toolName = "google_web_search"\ndecision = "deny"/);
    });

    it("allows both when webSearchEnabled and wikiUrlFetchEnabled are set", () => {
      const policy = core.generateAdminPolicy({
        webSearchEnabled: true,
        wikiUrlFetchEnabled: true,
      });
      expect(policy).toMatch(/toolName = "google_web_search"\ndecision = "allow"/);
      expect(policy).toMatch(/toolName = "web_fetch"\ndecision = "allow"/);
    });
  });
});

// Daily request counter tests live in their own describe block because they
// need a real sqlite database wired through the `db` constructor parameter,
// unlike the shared `core` fixture above (which uses an in-memory / no-db
// setup). They share the same vi.mock() for cli-utils + workdir.
describe("GeminiCliCore daily request counter", () => {
  // Lazy-imported so the hoisted vi.mock() from the top of the file applies.
  let Database: typeof DatabaseType;
  let applySchema: typeof import("../../db/schema.js").applySchema;
  let applyDefaultPresets: typeof import("./plan-presets.js").applyDefaultPresets;
  let readRuntimeState: typeof import("../../db/runtime-state.js").readRuntimeState;
  let writeRuntimeState: typeof import("../../db/runtime-state.js").writeRuntimeState;

  beforeEach(async () => {
    vi.clearAllMocks();
    mkdirSync(TEST_WORKDIR, { recursive: true });
    mkdirSync(TEST_RESUME_DIR, { recursive: true });
    Database = (await import("better-sqlite3")).default;
    applySchema = (await import("../../db/schema.js")).applySchema;
    applyDefaultPresets = (await import("./plan-presets.js")).applyDefaultPresets;
    const runtimeState = await import("../../db/runtime-state.js");
    readRuntimeState = runtimeState.readRuntimeState;
    writeRuntimeState = runtimeState.writeRuntimeState;
  });

  afterEach(() => {
    rmSync(TEST_WORKDIR, { recursive: true, force: true });
    rmSync(TEST_RESUME_DIR, { recursive: true, force: true });
  });

  function makeDb(): import("better-sqlite3").Database {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    return db;
  }

  function simulateOneAssistantMessage(): void {
    simulateGeminiRun([
      { type: "init", session_id: "s1" },
      { type: "message", role: "assistant", content: "hello", delta: false },
      {
        type: "result",
        status: "success",
        stats: { input_tokens: 10, output_tokens: 5 },
      },
    ]);
  }

  /**
   * Delta-only streaming pattern — no `delta: false` aggregate message is
   * ever emitted. This is a realistic Gemini CLI pattern that broke an
   * earlier counter implementation (increment-on-non-delta-message).
   */
  function simulateDeltaOnlyRun(): void {
    simulateGeminiRun([
      { type: "init", session_id: "s1" },
      { type: "message", role: "assistant", content: "hello ", delta: true },
      { type: "message", role: "assistant", content: "world", delta: true },
      {
        type: "result",
        status: "success",
        stats: { input_tokens: 10, output_tokens: 5 },
      },
    ]);
  }

  it("increments the per-day counter on successful runTurn completion", async () => {
    const db = makeDb();
    applyDefaultPresets(db, { defaultBackend: "gemini", force: true });

    const trackerCore = new GeminiCliCore(
      makeConfig(),
      undefined,
      undefined,
      db,
    );

    simulateOneAssistantMessage();
    await trackerCore.execute({
      prompt: "test",
      context: "ctx",
      event: makeEvent(),
      modelId: "gemini-2.5-pro",
      maxTurns: 10,
      maxBudgetUsd: 1.0,
    });

    const state = readRuntimeState<{ date: string; count: number }>(
      db,
      "gemini_requests_today",
    );
    expect(state).not.toBeNull();
    expect(state!.count).toBe(1);

    // Second execute → counter = 2.
    simulateOneAssistantMessage();
    await trackerCore.execute({
      prompt: "test",
      context: "ctx",
      event: makeEvent(),
      modelId: "gemini-2.5-pro",
      maxTurns: 10,
      maxBudgetUsd: 1.0,
    });
    const state2 = readRuntimeState<{ date: string; count: number }>(
      db,
      "gemini_requests_today",
    );
    expect(state2!.count).toBe(2);

    db.close();
  });

  it("increments even when Gemini streams only delta messages (no final aggregate)", async () => {
    // Regression guard: earlier implementations incremented on
    // `delta: false` assistant messages, which meant delta-only streaming
    // silently skipped the counter in production. Per-runTurn increment
    // at the successful completion point fixes that.
    const db = makeDb();
    applyDefaultPresets(db, { defaultBackend: "gemini", force: true });

    const deltaCore = new GeminiCliCore(
      makeConfig(),
      undefined,
      undefined,
      db,
    );

    simulateDeltaOnlyRun();
    await deltaCore.execute({
      prompt: "test",
      context: "ctx",
      event: makeEvent(),
      modelId: "gemini-2.5-pro",
      maxTurns: 10,
      maxBudgetUsd: 1.0,
    });

    const state = readRuntimeState<{ date: string; count: number }>(
      db,
      "gemini_requests_today",
    );
    expect(state).not.toBeNull();
    expect(state!.count).toBe(1);

    db.close();
  });

  it("does NOT increment when runTurn fails (auth failure, timeout, etc.)", async () => {
    const db = makeDb();
    applyDefaultPresets(db, { defaultBackend: "gemini", force: true });

    const failCore = new GeminiCliCore(
      makeConfig(),
      undefined,
      undefined,
      db,
    );

    // Simulate a CLI subprocess that exits non-zero and emits a failure
    // line on stderr. The run reaches past the auth + quota gate, but
    // fails before the counter-bump line.
    mockRunLineCommand.mockImplementation(async (options) => {
      options.onStderrLine?.("Error: Gemini API request failed: 500 internal error");
      return {
        exitCode: 1,
        signal: null,
        stdoutLines: [],
        stderrLines: ["Error: Gemini API request failed: 500 internal error"],
        timedOut: false,
      };
    });

    const err = await failCore
      .execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gemini-2.5-pro",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);

    const state = readRuntimeState<{ date: string; count: number }>(
      db,
      "gemini_requests_today",
    );
    // No successful completion → counter untouched.
    expect(state).toBeNull();

    db.close();
  });

  it("throws BackendQuotaError when the daily ceiling is already hit", async () => {
    const db = makeDb();
    // gemini_free has the lowest ceiling (900) — seed a count past that.
    applyDefaultPresets(db, { defaultBackend: "gemini", force: true });

    // Seed the counter above the ceiling using the same runtime_state key.
    // getAgentDayDateStr needs the same timezone/dayBoundaryHour as the
    // Gemini core, so derive `today` the same way.
    const { getAgentDayDateStr } = await import("@aitne/shared");
    const today = getAgentDayDateStr("", 4);
    writeRuntimeState(db, "gemini_requests_today", {
      date: today,
      count: 900,
    });

    const quotaCore = new GeminiCliCore(
      makeConfig(),
      undefined,
      undefined,
      db,
    );

    const err = await quotaCore
      .execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gemini-3-flash-preview",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(BackendQuotaError);
    expect((err as BackendQuotaError).backendId).toBe("gemini");
    // runLineCommand must not have been invoked — pre-flight refusal.
    expect(mockRunLineCommand).not.toHaveBeenCalled();

    db.close();
  });

  // Removed: "does NOT enforce a ceiling when the active plan is a Claude
  // preset". The daemon no longer carries plan-aware ceiling logic — a fixed
  // 450 req/day ceiling applies whenever db is injected, regardless of what
  // the operator's other backends are configured for. See `gemini-cli-core.ts`
  // (`GEMINI_DAILY_REQUEST_CEILING`) for the rationale.

  it("resets the counter when the agent day rolls over", async () => {
    const db = makeDb();
    applyDefaultPresets(db, { defaultBackend: "gemini", force: true });

    // Seed a previous-day counter — should be treated as zero on read.
    writeRuntimeState(db, "gemini_requests_today", {
      date: "1999-01-01",
      count: 500,
    });

    const rolloverCore = new GeminiCliCore(
      makeConfig(),
      undefined,
      undefined,
      db,
    );

    simulateOneAssistantMessage();
    await rolloverCore.execute({
      prompt: "test",
      context: "ctx",
      event: makeEvent(),
      modelId: "gemini-2.5-pro",
      maxTurns: 10,
      maxBudgetUsd: 1.0,
    });

    const state = readRuntimeState<{ date: string; count: number }>(
      db,
      "gemini_requests_today",
    );
    // Post-execute: date matches today, count starts from 1 (not 501).
    expect(state!.count).toBe(1);
    expect(state!.date).not.toBe("1999-01-01");

    db.close();
  });
});

describe("appendGeminiAttachmentTokens — @-expansion helper", () => {
  const mk = (overrides: Partial<StagedAttachment> = {}): StagedAttachment => ({
    id: "att",
    safeFilename: "file.pdf",
    mimeType: "application/pdf",
    absolutePath: "/tmp/session/_attachments/file.pdf",
    relativePath: "_attachments/file.pdf",
    ...overrides,
  });

  it("returns the prompt unchanged when no attachments are staged", () => {
    expect(appendGeminiAttachmentTokens("hello", undefined)).toBe("hello");
    expect(appendGeminiAttachmentTokens("hello", [])).toBe("hello");
  });

  it("appends `@<relativePath>` tokens for every staged file", () => {
    const prompt = "Summarize:";
    const staged = [
      mk({ relativePath: "_attachments/a.pdf" }),
      mk({ id: "b", safeFilename: "b.png", relativePath: "_attachments/b.png", mimeType: "image/png" }),
    ];
    expect(appendGeminiAttachmentTokens(prompt, staged)).toBe(
      "Summarize:\n\n@_attachments/a.pdf @_attachments/b.png",
    );
  });

  it("uses a double-newline separator so tokens don't merge into the last prompt line", () => {
    // Concretely: Gemini's CLI parses `@path` as a standalone token. A
    // single newline is fine too, but a blank line between prose and tokens
    // is how our other prompt generators (context block, task flow) delimit
    // sections — keep it consistent.
    const out = appendGeminiAttachmentTokens("body", [mk()]);
    expect(out.startsWith("body\n\n@")).toBe(true);
  });
});

// ── DELEGATED-PROXY-API-DESIGN.md §4.5 — runDelegatedTool ────────────────
//
// Gemini's stream-json schema does not expose a discrete `tool_response`
// event with a structured payload, so the proxy implementation is
// text-fallback (extract result from the assistant's final message) per
// the doc-comment on `GeminiCliCore.runDelegatedTool`. These tests pin
// the contract: matching tool_use → success; wrong tool_use → wrong_tool;
// no tool_use → no_tool_call; aborted signal → timeout.
describe("GeminiCliCore.runDelegatedTool", () => {
  const VALID_KEY = "AIzaSyA0123456789_0123456789-0123456789";
  let core: GeminiCliCore;
  let savedKey: string | undefined;
  let proxyDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mkdirSync(TEST_WORKDIR, { recursive: true });
    savedKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = VALID_KEY;
    core = new GeminiCliCore(makeConfig());
    proxyDir = mkdtempSync(join(tmpdir(), "proxy-gemini-"));
  });

  afterEach(() => {
    rmSync(TEST_WORKDIR, { recursive: true, force: true });
    rmSync(proxyDir, { recursive: true, force: true });
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedKey;
  });

  function makeProxyParams(overrides: Record<string, unknown> = {}) {
    return {
      integrationKey: "gmail" as const,
      toolName: "mcp__codex_apps__gmail._search_emails",
      toolArgs: { query: "from:foo" },
      modelId: "gemini-2.5-flash",
      maxTurns: 2,
      maxBudgetUsd: 0.5,
      sessionDir: proxyDir,
      ...overrides,
    };
  }

  it("returns ok=true with parsed assistant final message as tool result", async () => {
    simulateGeminiRun([
      { type: "init", session_id: "sess-1" },
      {
        type: "tool_use",
        tool_name: "mcp__codex_apps__gmail._search_emails",
        args: { query: "from:foo" },
      },
      {
        type: "message",
        role: "assistant",
        content: '{"messages":[{"id":"abc"}]}',
      },
      {
        type: "result",
        result: {
          status: "success",
          stats: { input_tokens: 800, output_tokens: 50 },
        },
      },
    ]);
    const result = await core.runDelegatedTool(makeProxyParams());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.toolResult).toEqual({ messages: [{ id: "abc" }] });
    expect(result.cost.tokensInput).toBeGreaterThan(0);
  });

  it("classifies wrong tool_use as 'wrong_tool'", async () => {
    simulateGeminiRun([
      { type: "init", session_id: "sess-1" },
      {
        type: "tool_use",
        tool_name: "mcp__codex_apps__gmail._send_email",
        args: {},
      },
      { type: "result", result: { status: "success", stats: {} } },
    ]);
    const result = await core.runDelegatedTool(makeProxyParams());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errorClass).toBe("wrong_tool");
  });

  it("classifies absence of tool_use as 'no_tool_call'", async () => {
    simulateGeminiRun([
      { type: "init", session_id: "sess-1" },
      { type: "message", role: "assistant", content: "I cannot help with that." },
      { type: "result", result: { status: "success", stats: {} } },
    ]);
    const result = await core.runDelegatedTool(makeProxyParams());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errorClass).toBe("no_tool_call");
  });

  it("classifies result.status='error' alongside content as 'tool_error'", async () => {
    simulateGeminiRun([
      { type: "init", session_id: "sess-1" },
      {
        type: "tool_use",
        tool_name: "mcp__codex_apps__gmail._search_emails",
      },
      {
        type: "message",
        role: "assistant",
        content: "permission denied: missing scope",
      },
      {
        type: "result",
        result: {
          status: "error",
          stats: { input_tokens: 100, output_tokens: 5 },
          error: "permission denied",
        },
      },
    ]);
    const result = await core.runDelegatedTool(makeProxyParams());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errorClass).toBe("tool_error");
    expect(result.message).toContain("permission denied");
  });

  it("classifies subprocess timeout via runResult.timedOut", async () => {
    mockRunLineCommand.mockImplementation(async () => ({
      exitCode: null,
      signal: null,
      stdoutLines: [],
      stderrLines: [],
      timedOut: true,
    }));
    const result = await core.runDelegatedTool(makeProxyParams());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errorClass).toBe("timeout");
  });

  it("returns subprocess_crashed when CLI is missing on PATH", async () => {
    const { findExecutable } = await import("./cli-utils.js");
    vi.mocked(findExecutable).mockReturnValueOnce(null);
    const noBinaryCore = new GeminiCliCore(makeConfig());
    const result = await noBinaryCore.runDelegatedTool(makeProxyParams());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errorClass).toBe("subprocess_crashed");
    expect(result.message).toContain("gemini CLI not found");
  });

  it("classifies parse_error when matched tool fired but no assistant text", async () => {
    simulateGeminiRun([
      { type: "init", session_id: "sess-1" },
      {
        type: "tool_use",
        tool_name: "mcp__codex_apps__gmail._search_emails",
      },
      { type: "result", result: { status: "success", stats: {} } },
    ]);
    const result = await core.runDelegatedTool(makeProxyParams());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errorClass).toBe("parse_error");
  });

  it("uses structured tool_result.output and ignores assistant prose", async () => {
    // Reproduces the Flash Lite "narrate the result" behavior — the
    // assistant message contains a Japanese-language summary that would
    // be useless to the caller, but the tool_result event carries the
    // raw connector envelope.
    //
    // Schema reference: Gemini CLI v0.40 stream-json — `tool_result`
    // event with `tool_id` (paired with prior `tool_use`), `status`,
    // and `output` (string-encoded). Bump this comment + interface if
    // upgrading the CLI changes the field names.
    simulateGeminiRun([
      { type: "init", session_id: "sess-1" },
      {
        type: "tool_use",
        tool_name: "mcp__codex_apps__gmail._search_emails",
        tool_id: "search_1",
        args: { query: "from:foo" },
      },
      {
        type: "tool_result",
        tool_id: "search_1",
        status: "success",
        output: '[{"id":"abc","subject":"hi"}]',
      },
      {
        type: "message",
        role: "assistant",
        content: "Found 1 email. From: foo, subject: hi.",
      },
      { type: "result", result: { status: "success", stats: { input_tokens: 800, output_tokens: 50 } } },
    ]);
    const result = await core.runDelegatedTool(makeProxyParams());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.toolResult).toEqual([{ id: "abc", subject: "hi" }]);
  });

  it("surfaces tool_result.status='error' as tool_error", async () => {
    simulateGeminiRun([
      { type: "init", session_id: "sess-1" },
      {
        type: "tool_use",
        tool_name: "mcp__codex_apps__gmail._search_emails",
        tool_id: "search_1",
      },
      {
        type: "tool_result",
        tool_id: "search_1",
        status: "error",
        output: "permission denied: missing scope",
      },
      { type: "result", result: { status: "success", stats: {} } },
    ]);
    const result = await core.runDelegatedTool(makeProxyParams());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errorClass).toBe("tool_error");
    expect(result.message).toContain("permission denied");
  });

  it("reclassifies Gemini CLI 'Tool not found' as tool_not_registered (retryable)", async () => {
    // Repro of the cadence-on-fresh-delegation race observed 2026-05-04:
    // when the worker's first tick fires immediately after an integration
    // switches to `delegated`, the host google-workspace MCP extension's
    // tool registry hasn't completed its handshake. The model still emits
    // a tool_use for the requested name (it was in the prompt verbatim),
    // and Gemini CLI returns a synthetic tool_result with the registry
    // miss error verbatim.
    simulateGeminiRun([
      { type: "init", session_id: "sess-1" },
      {
        type: "tool_use",
        tool_name: "mcp__codex_apps__gmail._search_emails",
        tool_id: "search_1",
      },
      {
        type: "tool_result",
        tool_id: "search_1",
        status: "error",
        output:
          'Tool "mcp__codex_apps__gmail._search_emails" not found.'
          + ' Did you mean one of: "google_web_search", "grep_search", "write_file"?',
      },
      { type: "result", result: { status: "success", stats: {} } },
    ]);
    const result = await core.runDelegatedTool(makeProxyParams());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errorClass).toBe("tool_not_registered");
    expect(result.message).toContain("not found");
  });

  it("does not reclassify when the not-found message refers to a different tool", async () => {
    // Defensive against false positives — a connector that emits its own
    // 'X not found' upstream-error string about an unrelated tool name
    // must still surface as `tool_error` (the actual upstream failure),
    // not be retried as a transient registry miss.
    simulateGeminiRun([
      { type: "init", session_id: "sess-1" },
      {
        type: "tool_use",
        tool_name: "mcp__codex_apps__gmail._search_emails",
        tool_id: "search_1",
      },
      {
        type: "tool_result",
        tool_id: "search_1",
        status: "error",
        output: 'Tool "mcp_other_unrelated" not found. Did you mean "x"?',
      },
      { type: "result", result: { status: "success", stats: {} } },
    ]);
    const result = await core.runDelegatedTool(makeProxyParams());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errorClass).toBe("tool_error");
  });

  it("captures the first tool_result when the model retries the same tool", async () => {
    // Gemini sometimes invokes the requested tool more than once — e.g.
    // a redundant confirmation call after the prompt asked for one
    // shot. Take the first paired result so the proxy is deterministic.
    simulateGeminiRun([
      { type: "init", session_id: "sess-1" },
      {
        type: "tool_use",
        tool_name: "mcp__codex_apps__gmail._search_emails",
        tool_id: "search_1",
      },
      {
        type: "tool_result",
        tool_id: "search_1",
        status: "success",
        output: '[{"id":"first"}]',
      },
      {
        type: "tool_use",
        tool_name: "mcp__codex_apps__gmail._search_emails",
        tool_id: "search_2",
      },
      {
        type: "tool_result",
        tool_id: "search_2",
        status: "success",
        output: '[{"id":"second"}]',
      },
      { type: "result", result: { status: "success", stats: {} } },
    ]);
    const result = await core.runDelegatedTool(makeProxyParams());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.toolResult).toEqual([{ id: "first" }]);
  });

  it("refuses pre-flight when daily-request ceiling is already hit", async () => {
    // gemini_free has the lowest ceiling (900). Pre-seed the counter past
    // it so runDelegatedTool's gate fires before runLineCommand.
    const Database = (await import("better-sqlite3")).default;
    const { applySchema } = await import("../../db/schema.js");
    const { applyDefaultPresets } = await import("\./plan-presets\.js");
    const { writeRuntimeState } = await import("../../db/runtime-state.js");
    const { getAgentDayDateStr } = await import("@aitne/shared");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    applyDefaultPresets(db, { defaultBackend: "gemini", force: true });
    const today = getAgentDayDateStr("", 4);
    writeRuntimeState(db, "gemini_requests_today", { date: today, count: 900 });

    const ceilingCore = new GeminiCliCore(
      makeConfig(),
      undefined,
      undefined,
      db,
    );
    const result = await ceilingCore.runDelegatedTool(makeProxyParams());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errorClass).toBe("auth_error");
    expect(result.message).toMatch(/ceiling reached/);
    // Pre-flight refusal — must not spawn the CLI.
    expect(mockRunLineCommand).not.toHaveBeenCalled();
    db.close();
  });

  it("increments the per-day counter on successful proxy invocation", async () => {
    const Database = (await import("better-sqlite3")).default;
    const { applySchema } = await import("../../db/schema.js");
    const { applyDefaultPresets } = await import("\./plan-presets\.js");
    const { readRuntimeState } = await import("../../db/runtime-state.js");
    const { getAgentDayDateStr } = await import("@aitne/shared");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    applyDefaultPresets(db, { defaultBackend: "gemini", force: true });

    const trackerCore = new GeminiCliCore(
      makeConfig(),
      undefined,
      undefined,
      db,
    );
    simulateGeminiRun([
      { type: "init", session_id: "s1" },
      {
        type: "tool_use",
        tool_name: "mcp__codex_apps__gmail._search_emails",
      },
      {
        type: "message",
        role: "assistant",
        content: '{"messages":[]}',
      },
      { type: "result", result: { status: "success", stats: {} } },
    ]);
    const result = await trackerCore.runDelegatedTool(makeProxyParams());
    expect(result.ok).toBe(true);

    const today = getAgentDayDateStr("", 4);
    const state = readRuntimeState<{ date: string; count: number }>(
      db,
      "gemini_requests_today",
    );
    expect(state).toEqual({ date: today, count: 1 });
    db.close();
  });
});

/**
 * DELEGATED-TASK-MODE-DESIGN.md §4.2 / §9.3 regression — Phase 2 (`/api/delegated/run`)
 * may pass trailing-`*` glob patterns in `allowedTools`. The Gemini admin policy
 * TOML at priority 920 accepts globs (verified against the gemini-cli policy
 * engine docs), but the daemon-side stream guard previously checked
 * `Set.has(toolName)` (exact-equality) and silently aborted every glob-admitted
 * tool call as `policy_violation`. The existing invoker-level tests stub
 * `runDelegatedTask` and never exercise this guard — this block exercises the
 * actual `gemini-cli-core.ts` stream parser.
 */
describe("GeminiCliCore.runDelegatedTask — Phase 2 glob allowedTools (§4.2)", () => {
  const VALID_KEY = "AIzaSyA0123456789_0123456789-0123456789";
  let core: GeminiCliCore;
  let savedKey: string | undefined;
  let proxyDir: string;
  const SCHEMA = {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string" } },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mkdirSync(TEST_WORKDIR, { recursive: true });
    savedKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = VALID_KEY;
    core = new GeminiCliCore(makeConfig());
    proxyDir = mkdtempSync(join(tmpdir(), "task-gemini-"));
  });

  afterEach(() => {
    rmSync(TEST_WORKDIR, { recursive: true, force: true });
    rmSync(proxyDir, { recursive: true, force: true });
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedKey;
  });

  function makeTaskParams(overrides: Record<string, unknown> = {}) {
    return {
      systemPrompt: "task body",
      validate: (_value: unknown) => true,
      validatorErrorMessage: () => "",
      allowedTools: ["mcp_my-server_*"],
      destructiveTools: [],
      writeClassTools: [],
      modelId: "gemini-2.5-flash",
      maxToolCalls: 5,
      maxBudgetUsd: 0.05,
      timeoutMs: 60000,
      allowDestructive: false,
      sessionDir: proxyDir,
      ...overrides,
    } as unknown as Parameters<typeof core.runDelegatedTask>[0];
  }

  it("admits a glob-matched tool_use (regression: Set.has exact-equality)", async () => {
    simulateGeminiRun([
      { type: "init", session_id: "task-1" },
      {
        type: "tool_use",
        tool_id: "use-1",
        tool_name: "mcp_my-server_search",
        args: { q: "x" },
      },
      {
        type: "tool_result",
        tool_id: "use-1",
        status: "ok",
      },
      {
        type: "message",
        role: "assistant",
        content: '{"text":"ok"}',
      },
      {
        type: "result",
        result: { status: "success", stats: { input_tokens: 10, output_tokens: 5 } },
      },
    ]);

    const result = await core.runDelegatedTask(makeTaskParams());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.trace.map((s) => s.toolName)).toEqual(["mcp_my-server_search"]);
  });

  it("aborts a tool_use that does not match any allowedTools pattern", async () => {
    simulateGeminiRun([
      { type: "init", session_id: "task-2" },
      {
        type: "tool_use",
        tool_id: "use-1",
        tool_name: "mcp_other-server_send",
        args: {},
      },
      { type: "result", result: { status: "success", stats: {} } },
    ]);

    const result = await core.runDelegatedTask(makeTaskParams());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errorClass).toBe("policy_violation");
  });

  it("aborts a destructive tool_use even when it matches a glob in allowedTools", async () => {
    simulateGeminiRun([
      { type: "init", session_id: "task-3" },
      {
        type: "tool_use",
        tool_id: "use-1",
        tool_name: "mcp_my-server_send",
        args: {},
      },
      { type: "result", result: { status: "success", stats: {} } },
    ]);

    const result = await core.runDelegatedTask(
      makeTaskParams({
        // §7.2 — destructive list deny still wins over a glob admit.
        destructiveTools: ["mcp_my-server_send"],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errorClass).toBe("policy_violation");
  });

  it("filters messageType:thought from rawAssistantText (reasoning gate)", async () => {
    // Mirror of the executeTurn reasoning gate at the delegated-task
    // surface. Gemini CLI 0.x emits internal deliberation as
    // assistant-role messages tagged `messageType: "thought"`; without
    // the filter these accumulate into `finalAssistantMessage` /
    // `assistantDelta` and surface as `rawAssistantText`, where the
    // dispatcher's structured-output validator would either reject
    // them as parse_error wrapped around reasoning or fold them into
    // delegated-task traces verbatim.
    simulateGeminiRun([
      { type: "init", session_id: "task-thought" },
      {
        type: "message",
        role: "assistant",
        messageType: "thought",
        content: "Let me consider the request carefully before answering.",
      },
      {
        type: "message",
        role: "assistant",
        content: '{"text":"final answer"}',
      },
      {
        type: "result",
        result: {
          status: "success",
          stats: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ]);

    const result = await core.runDelegatedTask(makeTaskParams());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.rawAssistantText).toBe('{"text":"final answer"}');
    expect(result.rawAssistantText).not.toContain("consider");
    expect(result.rawAssistantText).not.toContain("carefully");
  });
});

describe("isToolNotRegisteredError", () => {
  it("matches the multi-suggestion form", () => {
    const msg =
      'Tool "mcp_google-workspace_gmail.search" not found.'
      + ' Did you mean one of: "google_web_search", "grep_search", "write_file"?';
    expect(
      isToolNotRegisteredError(msg, "mcp_google-workspace_gmail.search"),
    ).toBe(true);
  });

  it("matches the single-suggestion form", () => {
    const msg =
      'Tool "mcp_notion_search" not found. Did you mean "google_web_search"?';
    expect(isToolNotRegisteredError(msg, "mcp_notion_search")).toBe(true);
  });

  it("rejects when expected name does not appear in the prefix", () => {
    // Defensive: connector might emit its own 'X not found' upstream
    // error string. We anchor on the expected tool name to avoid
    // reclassifying unrelated connector errors as transient.
    const msg = 'Tool "mcp_other" not found. Did you mean "x"?';
    expect(isToolNotRegisteredError(msg, "mcp_google-workspace_gmail.search"))
      .toBe(false);
  });

  it("rejects unrelated error strings", () => {
    expect(isToolNotRegisteredError("permission denied", "any")).toBe(false);
    expect(isToolNotRegisteredError("", "any")).toBe(false);
  });

  it("escapes regex metacharacters in expected tool name", () => {
    // The Gemini connector tool names contain `.` — must not match wildcards.
    const msg = 'Tool "mcp_google-workspace_gmail.search" not found. Did you mean "x"?';
    // A name with `.` replaced by any char must NOT match (anchoring).
    expect(isToolNotRegisteredError(msg, "mcp_google-workspace_gmailXsearch"))
      .toBe(false);
  });
});

describe("extractGeminiServerName", () => {
  it("returns the server name for the google-workspace gmail namespace", () => {
    expect(extractGeminiServerName("mcp_google-workspace_gmail.")).toBe(
      "google-workspace",
    );
  });

  it("returns the server name for the google-workspace calendar namespace", () => {
    expect(extractGeminiServerName("mcp_google-workspace_calendar.")).toBe(
      "google-workspace",
    );
  });

  it("returns the server name when the namespace ends right after the server", () => {
    // Notion-shape: `mcp_notion_<tool>` — server name is everything between
    // the `mcp_` prefix and the trailing underscore.
    expect(extractGeminiServerName("mcp_notion_")).toBe("notion");
  });

  it("rejects Claude / Codex double-underscore namespaces", () => {
    expect(extractGeminiServerName("mcp__claude_ai_Gmail__")).toBeNull();
    expect(extractGeminiServerName("mcp__codex_apps__gmail._")).toBeNull();
  });

  it("returns null for namespaces that are not Gemini-shaped", () => {
    expect(extractGeminiServerName("not-mcp")).toBeNull();
    expect(extractGeminiServerName("")).toBeNull();
    expect(extractGeminiServerName("mcp_")).toBeNull();
  });
});

describe("collectMcpServerNames", () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pa-gemini-mcpscan-"));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("collects every key under the mcpServers object", () => {
    const file = join(tempDir, "manifest.json");
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          "google-workspace": { command: "node", args: ["dist/index.js"] },
          notion: { url: "https://mcp.notion.com/mcp" },
        },
      }),
    );
    const out = new Set<string>();
    collectMcpServerNames(file, out);
    expect([...out].sort()).toEqual(["google-workspace", "notion"]);
  });

  it("is a no-op when the file is missing", () => {
    const out = new Set<string>();
    collectMcpServerNames(join(tempDir, "missing.json"), out);
    expect(out.size).toBe(0);
  });

  it("is a no-op when the JSON does not have an mcpServers block", () => {
    const file = join(tempDir, "no-mcp.json");
    writeFileSync(file, JSON.stringify({ ui: { theme: "Default Light" } }));
    const out = new Set<string>();
    collectMcpServerNames(file, out);
    expect(out.size).toBe(0);
  });

  it("is a no-op for malformed JSON", () => {
    const file = join(tempDir, "broken.json");
    writeFileSync(file, "{ not valid json");
    const out = new Set<string>();
    collectMcpServerNames(file, out);
    expect(out.size).toBe(0);
  });

  it("ignores arrays where an object is expected (mcpServers as a list)", () => {
    // Defensive: a user who hand-edits settings.json with
    // `"mcpServers": [{"name": "notion"}]` (array shape instead of
    // dict) would otherwise see `Object.keys()` return numeric index
    // strings as server names.
    const file = join(tempDir, "array-mcp.json");
    writeFileSync(file, JSON.stringify({ mcpServers: [{ name: "a" }] }));
    const out = new Set<string>();
    collectMcpServerNames(file, out);
    expect(out.size).toBe(0);
  });

  it("ignores top-level arrays (file is a JSON array, not an object)", () => {
    const file = join(tempDir, "top-array.json");
    writeFileSync(file, JSON.stringify([{ mcpServers: { x: {} } }]));
    const out = new Set<string>();
    collectMcpServerNames(file, out);
    expect(out.size).toBe(0);
  });
});

/**
 * Integration tests for the Fix-3 / Fix-4 wiring: classifyFailure must
 * surface a structured `resetHint` for provider rate-limit messages, the
 * daily-ceiling throw must carry the synthesised agent-day boundary hint,
 * and runTurn's stream observer must write a `blocked_absolute` audit row
 * (with the stream-observation trigger and `result='partial'`) when a
 * `tool_use` matches an absolute-block pattern.
 */
describe("GeminiCliCore — quota reset hint + absolute-block stream observation", () => {
  let Database: typeof DatabaseType;
  let applySchema: typeof import("../../db/schema.js").applySchema;

  beforeEach(async () => {
    vi.clearAllMocks();
    mkdirSync(TEST_WORKDIR, { recursive: true });
    mkdirSync(TEST_RESUME_DIR, { recursive: true });
    Database = (await import("better-sqlite3")).default;
    applySchema = (await import("../../db/schema.js")).applySchema;
  });

  afterEach(() => {
    rmSync(TEST_WORKDIR, { recursive: true, force: true });
    rmSync(TEST_RESUME_DIR, { recursive: true, force: true });
  });

  function makeDbCore(configOverrides: Partial<AgentConfig> = {}): {
    db: import("better-sqlite3").Database;
    core: GeminiCliCore;
  } {
    const db = new Database(":memory:");
    applySchema(db);
    const core = new GeminiCliCore(makeConfig(configOverrides));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    core.setMcpContext({ db, blobStore: {} as any });
    return { db, core };
  }

  it("classifyFailure attaches a reset hint to ISO 'try again at' messages", () => {
    const core = new GeminiCliCore(makeConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = (core as any).classifyFailure(
      "Quota exceeded. Please try again at 2026-05-15T03:00:00Z",
    );
    expect(err).toBeInstanceOf(BackendQuotaError);
    expect(err.originalCode).toBe("rate_limited");
    expect(err.resetHint).toMatchObject({
      hour: 3,
      minute: 0,
      timeZone: "UTC",
    });
  });

  it("classifyFailure leaves resetHint null when no pattern matches", () => {
    const core = new GeminiCliCore(makeConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = (core as any).classifyFailure("rate limit exceeded");
    expect(err.resetHint).toBeNull();
  });

  it("classifyFailure tags Gemini policy denials as policy_denied", () => {
    const core = new GeminiCliCore(makeConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = (core as any).classifyFailure(
      "Error executing tool run_shell_command: Tool execution denied by policy. curl with command chaining is not allowed. Use separate tool calls.",
    );
    expect(err).toBeInstanceOf(BackendDecisiveFailure);
    expect(err.kind).toBe("policy_denied");
  });

  it("classifyFailure prioritises policy_denied over the auth regex", () => {
    // A hypothetical future TOML deny message that mentions "login" or
    // "required" must not get mis-routed into the auth-recovery flow.
    const core = new GeminiCliCore(makeConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = (core as any).classifyFailure(
      "Error executing tool run_shell_command: Tool execution denied by policy. login shell commands are not permitted in daemon mode.",
    );
    expect(err).toBeInstanceOf(BackendDecisiveFailure);
    expect(err.kind).toBe("policy_denied");
  });

  it("execute writes a blocked_absolute row when run_shell_command matches", async () => {
    const { db, core } = makeDbCore();
    simulateGeminiRun([
      { type: "init", session_id: "s1" },
      // Gemini built-in shell tool — extractGeminiToolUseTarget maps
      // run_shell_command → Bash and feeds the command string through
      // classifyAbsoluteBlock.
      {
        type: "tool_use",
        tool_name: "run_shell_command",
        args: { command: "rm -rf ~" },
        tool_id: "call-1",
      },
      {
        type: "result",
        status: "success",
        stats: { input_tokens: 5, output_tokens: 1 },
      },
    ]);

    await core.execute({
      prompt: "p",
      context: "c",
      event: makeEvent(),
      modelId: "gemini-2.5-pro",
      maxTurns: 1,
      maxBudgetUsd: 1.0,
    });

    const rows = db
      .prepare(
        `SELECT trigger, result, detail, backend FROM agent_actions
           WHERE action_type = 'blocked_absolute'`,
      )
      .all() as Array<{
        trigger: string;
        result: string;
        detail: string;
        backend: string;
      }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].backend).toBe("gemini");
    expect(rows[0].trigger).toBe("absolute_block_stream_observation");
    expect(rows[0].result).toBe("partial");
    const detail = JSON.parse(rows[0].detail);
    expect(detail.category).toBe("recursive_delete");
    expect(detail.observation).toBe("stream");

    db.close();
  });

  it("execute writes a row for read_file targeting a secret path", async () => {
    const { db, core } = makeDbCore();
    simulateGeminiRun([
      { type: "init", session_id: "s1" },
      {
        type: "tool_use",
        tool_name: "read_file",
        args: { absolute_path: "/Users/x/.ssh/id_rsa" },
        tool_id: "call-1",
      },
      {
        type: "result",
        status: "success",
        stats: { input_tokens: 5, output_tokens: 1 },
      },
    ]);

    await core.execute({
      prompt: "p",
      context: "c",
      event: makeEvent(),
      modelId: "gemini-2.5-pro",
      maxTurns: 1,
      maxBudgetUsd: 1.0,
    });

    const row = db
      .prepare(
        `SELECT detail FROM agent_actions WHERE action_type = 'blocked_absolute'`,
      )
      .get() as { detail: string };
    expect(row).toBeDefined();
    const detail = JSON.parse(row.detail);
    expect(detail.category).toBe("secret_read");
    expect(detail.toolName).toBe("Read");

    db.close();
  });

  it("execute writes nothing for a benign tool_use", async () => {
    const { db, core } = makeDbCore();
    simulateGeminiRun([
      { type: "init", session_id: "s1" },
      {
        type: "tool_use",
        tool_name: "run_shell_command",
        args: { command: "ls -la" },
        tool_id: "call-1",
      },
      {
        type: "result",
        status: "success",
        stats: { input_tokens: 5, output_tokens: 1 },
      },
    ]);

    await core.execute({
      prompt: "p",
      context: "c",
      event: makeEvent(),
      modelId: "gemini-2.5-pro",
      maxTurns: 1,
      maxBudgetUsd: 1.0,
    });

    const rows = db
      .prepare(
        `SELECT id FROM agent_actions WHERE action_type = 'blocked_absolute'`,
      )
      .all();
    expect(rows).toHaveLength(0);
    db.close();
  });
});
