import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEvent, EventPriority, type Event } from "@aitne/shared";
import { BackendDecisiveFailure, BackendQuotaError } from "../agent-core.js";
import type { AgentConfig } from "../../config.js";

// Mock cli-utils and workdir before importing CodexCore
vi.mock("./cli-utils.js", () => {
  const findExecutableMock = vi.fn().mockReturnValue("/usr/local/bin/codex");
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
  createOutputCapturePath: vi.fn().mockReturnValue("/tmp/codex-output.txt"),
  readFileIfExists: vi.fn().mockReturnValue(null),
  removeFileIfExists: vi.fn(),
  // Keep the real format check in tests — it's a pure function with
  // no side effects and the tests exercise both valid and invalid
  // inputs.
  isPlausibleOpenAiApiKey: (raw: string | undefined): boolean => {
    const key = raw?.trim();
    if (!key) return false;
    if (/^sk-ant-/.test(key)) return false;
    return /^sk-[A-Za-z0-9_-]{30,}$/.test(key);
  },
  };
});

vi.mock("../workdir.js", () => ({
  createSessionWorkdir: vi.fn().mockReturnValue("/tmp/test-workdir"),
  cleanupSessionWorkdir: vi.fn(),
}));

import {
  CodexCore,
  CODEX_ARGV_BUDGET_BYTES,
  CODEX_PROBE_TOOLS_PROMPT,
  buildCodexImageArgs,
} from "./codex-core.js";
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
    ...overrides,
  } as unknown as AgentConfig;
}

function makeEvent(overrides: Partial<Event> = {}): Event {
  return createEvent({
    type: "routine.hourly_check",
    source: "test",
    priority: EventPriority.NORMAL,
    ...overrides,
  });
}

/**
 * Simulate runLineCommand by calling onStdoutLine with JSONL events,
 * then resolving with the given exit code.
 */
function simulateCodexRun(
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
    }
    for (const line of stderrLines) {
      options.onStderrLine?.(line);
    }
    return {
      exitCode,
      signal: null,
      stdoutLines,
      stderrLines,
      timedOut: false,
    };
  });
}

describe("CodexCore", () => {
  let core: CodexCore;

  beforeEach(() => {
    vi.clearAllMocks();
    core = new CodexCore(makeConfig());
  });

  describe("execute", () => {
    it("returns a successful AgentResult on normal completion", async () => {
      simulateCodexRun([
        { type: "thread.started", thread_id: "thread-123" },
        { type: "turn.started" },
        { type: "item.updated", item: { delta: "Hello " } },
        { type: "item.updated", item: { delta: "world!" } },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 10 },
        },
      ]);

      const result = await core.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gpt-5.4",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
      });

      expect(result.backendId).toBe("codex");
      expect(result.sessionId).toBe("thread-123");
      expect(result.modelId).toBe("gpt-5.4");
      expect(result.isError).toBe(false);
      expect(result.usage.inputTokens).toBe(90);
      expect(result.usage.outputTokens).toBe(50);
      expect(result.usage.cacheReadInputTokens).toBe(10);
      expect(result.numTurns).toBe(1);
    });

    it("streams text deltas live, matching ClaudeCodeCore", async () => {
      // Regression guard for the 'Customize Your Rules' silent-3-minute bug:
      // codex-core previously buffered every delta until `assertWithinMaxBudget`
      // ran, then emitted one mega-chunk. Now deltas reach the caller as the
      // CLI produces them — same UX contract as ClaudeCodeCore.consumeStream.
      simulateCodexRun([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        { type: "item.updated", item: { delta: "chunk1" } },
        { type: "item.updated", item: { delta: "chunk2" } },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      const chunks: string[] = [];
      const onText = vi.fn((text: string) => chunks.push(text));
      const onEnd = vi.fn();

      await core.execute(
        {
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gpt-5.4",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        },
        { onText, onEnd },
      );

      expect(chunks).toEqual(["chunk1", "chunk2"]);
      expect(onEnd).toHaveBeenCalledTimes(1);
    });

    it("does not stream reasoning items to the chat bubble", async () => {
      // Regression for the 'Customize Your Rules' bug: codex GPT-5 family
      // emits `item.completed` / `item.updated` events whose `item.type`
      // is `reasoning` (newer) or `agent_reasoning` (older). Before the
      // fix, `extractCodexText` blindly pulled `item.text` / `item.delta`
      // from these too and the reasoning summary was concatenated with
      // the assistant reply inside the dashboard chat bubble. The chunks
      // forwarded to onText must contain ONLY assistant text. The
      // accumulated `output` (returned to the dispatcher and persisted
      // as the assistant message) must also be reasoning-free so the DB
      // row + bootstrap re-render stay clean.
      const { readFileIfExists } = await import("./cli-utils.js");
      vi.mocked(readFileIfExists).mockReturnValueOnce("");

      simulateCodexRun([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        {
          type: "item.updated",
          item: { type: "reasoning", delta: "I should plan two turns..." },
        },
        {
          type: "item.completed",
          item: { type: "reasoning", text: "Final reasoning summary" },
        },
        // Older codex builds emit reasoning at the outer event level.
        { type: "agent_reasoning_delta", delta: "stale reasoning shape" },
        { type: "item.updated", item: { type: "agent_message", delta: "Hello " } },
        { type: "item.updated", item: { type: "agent_message", delta: "world!" } },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      const chunks: string[] = [];
      const result = await core.execute(
        {
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gpt-5.4",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        },
        { onText: (t) => chunks.push(t) },
      );

      expect(chunks).toEqual(["Hello ", "world!"]);
      expect(result.output).toBe("Hello world!");
      expect(chunks.join("")).not.toContain("reasoning");
      expect(result.output).not.toContain("reasoning");
    });

    it("filters reasoning streaming deltas by item id (type declared only on item.started)", async () => {
      // The realistic codex 0.121+ wire format: `item.started` declares
      // the item type once, then a series of `item.updated` events carry
      // only `id + delta` (no repeat of the type). A per-event `type`
      // filter alone misses the streaming chunks. `reasoningItemIds`
      // tracking is what makes the fix sound.
      const { readFileIfExists } = await import("./cli-utils.js");
      vi.mocked(readFileIfExists).mockReturnValueOnce("");

      simulateCodexRun([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        // Reasoning item — type is on `started`, the next two `updated`
        // events carry ONLY `{id, delta}`.
        { type: "item.started", item: { id: "r1", type: "reasoning" } },
        { type: "item.updated", item: { id: "r1", delta: "Let me think..." } },
        { type: "item.updated", item: { id: "r1", delta: " ...about this." } },
        { type: "item.completed", item: { id: "r1" } },
        // Assistant message — same id-only delta pattern, but with an
        // assistant_message type recorded on the `started` event so the
        // deltas pass through.
        { type: "item.started", item: { id: "m1", type: "assistant_message" } },
        { type: "item.updated", item: { id: "m1", delta: "Hello " } },
        { type: "item.updated", item: { id: "m1", delta: "world!" } },
        { type: "item.completed", item: { id: "m1" } },
        // Also exercise the alternative naming `item_type` (some codex
        // builds use this instead of `type`).
        { type: "item.started", item: { id: "r2", item_type: "reasoning" } },
        { type: "item.updated", item: { id: "r2", delta: "more secret thought" } },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      const chunks: string[] = [];
      const result = await core.execute(
        {
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gpt-5.4",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        },
        { onText: (t) => chunks.push(t) },
      );

      expect(chunks).toEqual(["Hello ", "world!"]);
      expect(result.output).toBe("Hello world!");
      expect(chunks.join("")).not.toContain("think");
      expect(chunks.join("")).not.toContain("secret");
      expect(result.output).not.toContain("think");
      expect(result.output).not.toContain("secret");
    });

    it("suppresses --output-last-message file content when reasoning was observed and stream produced no agent text", async () => {
      // Regression for the chat-bubble reasoning leak: codex 0.121+
      // sometimes writes the GPT-5 reasoning summary to the
      // `--output-last-message` file when the turn ended with only a
      // reasoning item and no agent_message item. The previous code
      // unconditionally preferred the file's content over the
      // (correctly filtered) stream chunks, so the reasoning summary
      // surfaced verbatim in the dashboard chat bubble and was
      // persisted to `messages.content`. The fix gates the file
      // fallback on `observedReasoning`: when the stream gate fired
      // and produced no assistant text, the file is refused even
      // when non-empty.
      const { readFileIfExists } = await import("./cli-utils.js");
      vi.mocked(readFileIfExists).mockReturnValueOnce(
        "確認します。先に会話スタイルは character 用として扱い、管理先の未回答項目をどう扱うべきかを詰めます。",
      );

      simulateCodexRun([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        // Reasoning item, type declared on `started` then a stream of
        // id-only updates — the classic codex 0.121+ wire format.
        { type: "item.started", item: { id: "r1", type: "reasoning" } },
        { type: "item.updated", item: { id: "r1", delta: "確認します。" } },
        { type: "item.updated", item: { id: "r1", delta: "詰めます。" } },
        { type: "item.completed", item: { id: "r1" } },
        // Turn ends with no `agent_message` item — the only text on
        // the wire was reasoning. Stream chunks (after filtering) are
        // empty; the file fallback would otherwise be used.
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      const chunks: string[] = [];
      const result = await core.execute(
        {
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gpt-5.4",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        },
        { onText: (t) => chunks.push(t) },
      );

      expect(chunks).toEqual([]);
      expect(result.output).toBe("");
      expect(result.output).not.toContain("確認");
      expect(result.output).not.toContain("詰めます");
    });

    it("uses --output-last-message file content when no reasoning was observed (existing fallback preserved)", async () => {
      // The reasoning gate must NOT regress the legitimate fallback:
      // a tool-only turn whose final agent_message arrives only via
      // `--output-last-message` (no streamed deltas). Stream is empty
      // AND no reasoning was observed → the file content is the
      // authoritative source. Pair test for the suppression case
      // above to make sure both branches of the new logic are
      // covered.
      const { readFileIfExists } = await import("./cli-utils.js");
      vi.mocked(readFileIfExists).mockReturnValueOnce(
        "Tool ran successfully. Result attached.",
      );

      simulateCodexRun([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      const result = await core.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gpt-5.4",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
      });

      expect(result.output).toBe("Tool ran successfully. Result attached.");
    });

    it("prefers filtered stream text over the --output-last-message file when both are non-empty (reasoning observed)", async () => {
      // Even when reasoning was observed, if the stream ALSO produced
      // a real agent_message text (after filtering), that text is
      // already the correct answer — don't second-guess by reading
      // the file. This protects against any edge case where the file
      // captures a stale reasoning summary alongside a successful
      // final message.
      const { readFileIfExists } = await import("./cli-utils.js");
      vi.mocked(readFileIfExists).mockReturnValueOnce(
        "leaked reasoning narration from file",
      );

      simulateCodexRun([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        { type: "item.started", item: { id: "r1", type: "reasoning" } },
        { type: "item.updated", item: { id: "r1", delta: "thinking..." } },
        { type: "item.completed", item: { id: "r1" } },
        { type: "item.started", item: { id: "m1", type: "assistant_message" } },
        { type: "item.updated", item: { id: "m1", delta: "real answer" } },
        { type: "item.completed", item: { id: "m1" } },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      const result = await core.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gpt-5.4",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
      });

      expect(result.output).toBe("real answer");
      expect(result.output).not.toContain("leaked");
      expect(result.output).not.toContain("thinking");
    });

    it("drops Responses-API verbatim reasoning_summary events at the outer level", async () => {
      // codex 0.121+ sometimes relays OpenAI Responses-API streaming
      // events verbatim through `codex exec --json` when running
      // against gpt-5/o-series models. These events carry reasoning
      // text in outer `event.delta` / `event.text` fields with no
      // `event.item` wrapper, so item-id tracking does NOT catch
      // them. The defensive entries in
      // `CODEX_REASONING_OUTER_EVENT_TYPES` must filter them at the
      // outer-type level.
      const { readFileIfExists } = await import("./cli-utils.js");
      vi.mocked(readFileIfExists).mockReturnValueOnce("");

      simulateCodexRun([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        {
          type: "response.reasoning_summary_text.delta",
          delta: "internal thought process step 1",
        },
        {
          type: "response.reasoning_summary_text.done",
          text: "internal thought process complete",
        },
        {
          type: "response.reasoning_summary_part.added",
          text: "part metadata",
        },
        { type: "item.started", item: { id: "m1", type: "assistant_message" } },
        { type: "item.updated", item: { id: "m1", delta: "hello" } },
        { type: "item.completed", item: { id: "m1" } },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      const chunks: string[] = [];
      const result = await core.execute(
        {
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gpt-5.4",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        },
        { onText: (t) => chunks.push(t) },
      );

      expect(chunks).toEqual(["hello"]);
      expect(result.output).toBe("hello");
      expect(result.output).not.toContain("internal");
      expect(result.output).not.toContain("thought");
      expect(result.output).not.toContain("part metadata");
    });

    it("extracts text from output_text field", async () => {
      simulateCodexRun([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        { type: "message", output_text: "direct output" },
        {
          type: "turn.completed",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      const chunks: string[] = [];
      await core.execute(
        {
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gpt-5.4",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        },
        { onText: (t) => chunks.push(t) },
      );

      expect(chunks).toEqual(["direct output"]);
    });

    it("uses streamed text when the output capture file is empty", async () => {
      const { readFileIfExists } = await import("./cli-utils.js");
      vi.mocked(readFileIfExists).mockReturnValueOnce("");

      simulateCodexRun([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        { type: "item.updated", item: { delta: "Management " } },
        { type: "item.updated", item: { delta: "rules preview" } },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      const chunks: string[] = [];
      const result = await core.execute(
        {
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gpt-5.4",
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

    it("throws max_budget_usd when estimated cost exceeds the per-turn budget", async () => {
      simulateCodexRun([
        { type: "thread.started", thread_id: "thread-123" },
        { type: "turn.started" },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      ]);

      const chunks: string[] = [];
      const error = await core
        .execute({
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gpt-5.4",
          maxTurns: 10,
          maxBudgetUsd: 0.0005,
        }, {
          onText: (text) => chunks.push(text),
        })
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BackendQuotaError);
      expect(error).toMatchObject({ originalCode: "max_budget_usd" });
      expect(chunks).toEqual([]);
      // Post-hoc spend payload must accompany the error so the dispatcher's
      // error handler can record the row in `agent_actions` with
      // `result='failed'` + the actual cost. Without it the dashboard
      // silently drops budget-rejected spend.
      const quota = error as BackendQuotaError;
      expect(quota.spend).not.toBeNull();
      expect(quota.spend?.modelId).toBe("gpt-5.4");
      expect(quota.spend?.usage.inputTokens).toBe(100);
      expect(quota.spend?.usage.outputTokens).toBe(50);
      expect(quota.spend?.costUsd).toBeGreaterThan(0);
      expect(quota.spend?.numTurns).toBe(1);
    });
  });

  describe("error classification", () => {
    it("throws BackendQuotaError on rate limit messages", async () => {
      simulateCodexRun(
        [
          { type: "thread.started", thread_id: "t1" },
          { type: "turn.started" },
          { type: "turn.failed", error: { message: "Rate limit reached for requests" } },
        ],
        1,
      );

      await expect(
        core.execute({
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gpt-5.4",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        }),
      ).rejects.toBeInstanceOf(BackendQuotaError);
    });

    it("throws BackendQuotaError with max_budget_usd on budget limit messages", async () => {
      simulateCodexRun(
        [
          { type: "thread.started", thread_id: "t1" },
          { type: "turn.started" },
          { type: "turn.failed", error: { message: "Reached maximum budget ($1.00)" } },
        ],
        1,
      );

      const error = await core
        .execute({
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gpt-5.4",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        })
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BackendQuotaError);
      expect(error).toMatchObject({ originalCode: "max_budget_usd" });
    });

    it("throws BackendQuotaError on usage limit stderr", async () => {
      simulateCodexRun(
        [
          { type: "thread.started", thread_id: "t1" },
          { type: "turn.started" },
        ],
        1,
        ["Error: usage limit exceeded"],
      );

      await expect(
        core.execute({
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gpt-5.4",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        }),
      ).rejects.toBeInstanceOf(BackendQuotaError);
    });

    it("throws BackendDecisiveFailure with kind=auth on unauthorized", async () => {
      simulateCodexRun(
        [
          { type: "thread.started", thread_id: "t1" },
          { type: "error", message: "Unauthorized: invalid API key" },
        ],
        1,
      );

      const error = await core
        .execute({
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gpt-5.4",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        })
        .catch((e) => e);

      expect(error).toBeInstanceOf(BackendDecisiveFailure);
      expect((error as BackendDecisiveFailure).kind).toBe("auth");
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
          modelId: "gpt-5.4",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        })
        .catch((e) => e);

      expect(error).toBeInstanceOf(BackendDecisiveFailure);
      expect((error as BackendDecisiveFailure).kind).toBe("timeout");
    });
  });

  describe("executeResume", () => {
    it("passes resume session ID in args", async () => {
      simulateCodexRun([
        { type: "turn.started" },
        { type: "item.updated", item: { delta: "resumed reply" } },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 50, output_tokens: 25 },
        },
      ]);

      const result = await core.executeResume({
        sessionId: "thread-abc",
        message: "follow up",
        modelId: "gpt-5.4",
        sessionDir: "/tmp/existing-session",
      });

      expect(result.backendId).toBe("codex");
      expect(result.isError).toBe(false);

      // Verify resume args were passed
      const callArgs = mockRunLineCommand.mock.calls[0]?.[0];
      expect(callArgs?.args).toContain("resume");
      expect(callArgs?.args).toContain("thread-abc");
    });

    it("throws BackendDecisiveFailure when resume fails with auth error", async () => {
      simulateCodexRun(
        [{ type: "error", message: "Unauthorized: session expired" }],
        1,
      );

      const error = await core
        .executeResume({
          sessionId: "thread-invalid",
          message: "follow up",
          modelId: "gpt-5.4",
          sessionDir: "/tmp/existing-session",
        })
        .catch((e) => e);

      expect(error).toBeInstanceOf(BackendDecisiveFailure);
      expect((error as BackendDecisiveFailure).kind).toBe("auth");
    });
  });

  describe("output file fallback", () => {
    it("reads output from --output-last-message file when stream has no text", async () => {
      const { readFileIfExists } = await import("./cli-utils.js");
      vi.mocked(readFileIfExists).mockReturnValueOnce("file-based output");

      simulateCodexRun([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      const result = await core.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gpt-5.4",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
      });

      expect(result.output).toBe("file-based output");
    });
  });

  describe("checkAuth", () => {
    const VALID_KEY = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij";

    it("returns ok with api_key when OPENAI_API_KEY is a plausible key", async () => {
      const original = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = VALID_KEY;
      try {
        const result = await core.checkAuth();
        expect(result).toEqual({ ok: true, method: "api_key" });
      } finally {
        if (original === undefined) {
          delete process.env.OPENAI_API_KEY;
        } else {
          process.env.OPENAI_API_KEY = original;
        }
      }
    });

    it("rejects a malformed OPENAI_API_KEY", async () => {
      const original = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "sk-test-123";
      try {
        const result = await core.checkAuth();
        expect(result.ok).toBe(false);
      } finally {
        if (original === undefined) {
          delete process.env.OPENAI_API_KEY;
        } else {
          process.env.OPENAI_API_KEY = original;
        }
      }
    });

    it("returns not ok when CLI is not installed", async () => {
      // cliPath is resolved at construction time now, so we need to
      // reconstruct the core AFTER mocking findExecutable to null.
      const { findExecutable } = await import("./cli-utils.js");
      vi.mocked(findExecutable).mockReturnValueOnce(null);
      const noCliCore = new CodexCore(makeConfig());
      const original = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      try {
        const result = await noCliCore.checkAuth();
        expect(result.ok).toBe(false);
      } finally {
        if (original !== undefined) process.env.OPENAI_API_KEY = original;
      }
    });
  });

  describe("listModels", () => {
    it("returns codex models from the registry", () => {
      const models = core.listModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models.every((m) => m.backendId === "codex")).toBe(true);
    });
  });

  describe("summarize", () => {
    it("returns the output from a summary run", async () => {
      const { readFileIfExists } = await import("./cli-utils.js");
      vi.mocked(readFileIfExists).mockReturnValueOnce("Summary text");

      simulateCodexRun([
        { type: "thread.started", thread_id: "t-summary" },
        { type: "turn.started" },
        {
          type: "turn.completed",
          model: "gpt-5.4-mini",
          usage: { input_tokens: 50, output_tokens: 25 },
        },
      ]);

      const result = await core.summarize("conversation text here");
      expect(result).toBe("Summary text");
    });
  });

  describe("probeTools", () => {
    it("uses tool_search in the discovery prompt so Codex apps are lazy-loaded", async () => {
      simulateCodexRun([
        {
          type: "item.completed",
          item: {
            type: "agent_message",
            text:
              "mcp__codex_apps__gmail._search_emails\n"
              + "not-a-tool\n"
              + "mcp__codex_apps__gmail._read_email",
          },
        },
        {
          type: "item.completed",
          item: {
            type: "agent_message",
            text: "mcp__codex_apps__gmail._send_email",
          },
        },
        { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } },
      ]);

      const tools = await core.probeTools();

      expect(tools).toEqual([
        "mcp__codex_apps__gmail._search_emails",
        "mcp__codex_apps__gmail._read_email",
        "mcp__codex_apps__gmail._send_email",
      ]);
      expect(CODEX_PROBE_TOOLS_PROMPT).toContain("tool_search");
      expect(CODEX_PROBE_TOOLS_PROMPT).toContain("Gmail");
      expect(CODEX_PROBE_TOOLS_PROMPT).toContain("Google Calendar");
      expect(CODEX_PROBE_TOOLS_PROMPT).toContain("_list_labels");
      const args = mockRunLineCommand.mock.calls[0]?.[0]?.args ?? [];
      expect(args).toContain(CODEX_PROBE_TOOLS_PROMPT);
    });

    it("derives the prompt from INTEGRATION_DESCRIPTORS so Notion is enumerated", () => {
      // Regression for the Codex-side silent-false-negative: before the
      // prompt was registry-driven, Notion (added via NOTION_DELEGATION_DESIGN)
      // was never asked of `tool_search`, so `evaluateProbe` permanently
      // saw `present=false` for `notion+codex` even with the connector live.
      // displayName + namespace prefix is the stable surface — pinning a
      // specific capabilityTool name would couple this test to registry
      // tweaks that don't actually break the probe.
      expect(CODEX_PROBE_TOOLS_PROMPT).toContain("Notion");
      expect(CODEX_PROBE_TOOLS_PROMPT).toContain("mcp__codex_apps__notion._");
    });
  });

  describe("error classification details", () => {
    it("classifies timeout messages as BackendDecisiveFailure(timeout)", async () => {
      simulateCodexRun(
        [
          { type: "thread.started", thread_id: "t1" },
          { type: "error", message: "request timed out" },
        ],
        1,
      );

      const error = await core
        .execute({
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gpt-5.4",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        })
        .catch((e) => e);

      expect(error).toBeInstanceOf(BackendDecisiveFailure);
      expect((error as BackendDecisiveFailure).kind).toBe("timeout");
    });

    it("classifies unrecognized errors as other_non_retryable", async () => {
      simulateCodexRun(
        [
          { type: "thread.started", thread_id: "t1" },
          { type: "error", message: "something unexpected happened" },
        ],
        1,
      );

      const error = await core
        .execute({
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gpt-5.4",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        })
        .catch((e) => e);

      expect(error).toBeInstanceOf(BackendDecisiveFailure);
      expect((error as BackendDecisiveFailure).kind).toBe("other_non_retryable");
    });
  });

  describe("extractCodexText edge cases", () => {
    it("extracts text from direct delta field on event", async () => {
      simulateCodexRun([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        { type: "content.delta", delta: "direct delta" },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      const chunks: string[] = [];
      await core.execute(
        {
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gpt-5.4",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        },
        { onText: (t) => chunks.push(t) },
      );

      expect(chunks).toContain("direct delta");
    });

    it("extracts text from direct text field on event", async () => {
      simulateCodexRun([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        { type: "message.text", text: "text field" },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      const chunks: string[] = [];
      await core.execute(
        {
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gpt-5.4",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        },
        { onText: (t) => chunks.push(t) },
      );

      expect(chunks).toContain("text field");
    });

    it("extracts text from item.text field", async () => {
      simulateCodexRun([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        { type: "item.updated", item: { text: "item text" } },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      const chunks: string[] = [];
      await core.execute(
        {
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gpt-5.4",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        },
        { onText: (t) => chunks.push(t) },
      );

      expect(chunks).toContain("item text");
    });
  });

  describe("error event filtering", () => {
    it("ignores Reconnecting... messages in error events", async () => {
      simulateCodexRun([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        { type: "error", message: "Reconnecting..." },
        { type: "item.updated", item: { delta: "output" } },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      const result = await core.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gpt-5.4",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
      });

      expect(result.isError).toBe(false);
    });
  });

  describe("buildArgs", () => {
    it("includes --ephemeral when persistSession is false", async () => {
      simulateCodexRun([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      await core.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gpt-5.4",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
        persistSession: false,
      });

      const callArgs = mockRunLineCommand.mock.calls[0]?.[0];
      expect(callArgs?.args).toContain("--ephemeral");
    });

    it("omits --ephemeral when persistSession is true", async () => {
      simulateCodexRun([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      await core.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gpt-5.4",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
        persistSession: true,
      });

      const callArgs = mockRunLineCommand.mock.calls[0]?.[0];
      expect(callArgs?.args).not.toContain("--ephemeral");
    });

    it("opts the workspace-write sandbox into localhost network access on execute", async () => {
      // Regression: BUG-DM-BACKEND-PERMISSIONS §5. Without this `-c` override,
      // Seatbelt blocks all network egress under workspace-write and curl to
      // the daemon API fails with a sandbox denial.
      simulateCodexRun([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      await core.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gpt-5.4",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
        persistSession: false,
      });

      const args = mockRunLineCommand.mock.calls[0]?.[0]?.args ?? [];
      expect(args).toContain("-c");
      expect(args).toContain("sandbox_workspace_write.network_access=true");
      const flagIdx = args.indexOf("sandbox_workspace_write.network_access=true");
      expect(args[flagIdx - 1]).toBe("-c");
    });

    it("injects daemon API helper env without exposing a read token", async () => {
      simulateCodexRun([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      await core.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gpt-5.4",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
        persistSession: false,
      });

      expect(mockCreateSessionWorkdir).toHaveBeenCalledWith(
        ".",
        "routine.hourly_check",
        "/tmp/test/skills",
        expect.objectContaining({
          backendId: "codex",
        }),
      );
      const env = mockRunLineCommand.mock.calls[0]?.[0]?.env ?? {};
      expect(env.PA_DAEMON_API_BASE_URL).toBe("http://127.0.0.1:8321");
      expect(env.PA_DAEMON_READ_TOKEN).toBeUndefined();
      expect(env.PATH).toContain("/tmp/test-workdir/.pa/bin");
    });

    it("opts the workspace-write sandbox into localhost network access on resume", async () => {
      simulateCodexRun([
        { type: "turn.started" },
        { type: "item.updated", item: { delta: "resumed reply" } },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      await core.executeResume({
        sessionId: "thread-abc",
        message: "follow up",
        modelId: "gpt-5.4",
        sessionDir: "/tmp/existing-session",
      });

      const args = mockRunLineCommand.mock.calls[0]?.[0]?.args ?? [];
      expect(args).toContain("-c");
      expect(args).toContain("sandbox_workspace_write.network_access=true");
      const flagIdx = args.indexOf("sandbox_workspace_write.network_access=true");
      expect(args[flagIdx - 1]).toBe("-c");
    });

    it("strict-mode resume omits --sandbox and --color (rejected by `codex exec resume` on 0.121.0)", async () => {
      // Regression guard: `codex exec resume --help` on v0.121.0 shows neither
      // `--sandbox` nor `--color` in its accepted flag set. Passing either
      // errors out with `error: unexpected argument '...' found`. Sandbox
      // mode must be set via `-c sandbox_mode="..."` instead, which is
      // accepted by both exec and resume.
      simulateCodexRun([
        { type: "turn.started" },
        { type: "item.updated", item: { delta: "resumed reply" } },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      await core.executeResume({
        sessionId: "thread-abc",
        message: "follow up",
        modelId: "gpt-5.4",
        sessionDir: "/tmp/existing-session",
      });

      const args = mockRunLineCommand.mock.calls[0]?.[0]?.args ?? [];
      expect(args).not.toContain("--sandbox");
      expect(args).not.toContain("--color");
      expect(args).toContain('sandbox_mode="workspace-write"');
      expect(args).toContain("sandbox_workspace_write.network_access=true");
    });

    it("allow-mode resume passes --dangerously-bypass-approvals-and-sandbox and no --color", async () => {
      const allowCore = new CodexCore(
        makeConfig({ codexExecutionPermissionMode: "allow" }),
      );
      simulateCodexRun([
        { type: "turn.started" },
        { type: "item.updated", item: { delta: "resumed reply" } },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      await allowCore.executeResume({
        sessionId: "thread-abc",
        message: "follow up",
        modelId: "gpt-5.4",
        sessionDir: "/tmp/existing-session",
      });

      const args = mockRunLineCommand.mock.calls[0]?.[0]?.args ?? [];
      expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(args).not.toContain("--color");
      expect(args).not.toContain("--sandbox");
    });

    it("swaps workspace-write for --dangerously-bypass-approvals-and-sandbox in allow mode", async () => {
      const allowCore = new CodexCore(
        makeConfig({ codexExecutionPermissionMode: "allow" }),
      );
      simulateCodexRun([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      await allowCore.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gpt-5.4",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
        persistSession: false,
      });

      const args = mockRunLineCommand.mock.calls[0]?.[0]?.args ?? [];
      expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(args).not.toContain("--sandbox");
      expect(args).not.toContain("workspace-write");
      expect(args).not.toContain("sandbox_workspace_write.network_access=true");
    });

    it("omits tools.web_search override when webSearchEnabled is false", async () => {
      simulateCodexRun([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      await core.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gpt-5.4",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
        persistSession: false,
        webSearchEnabled: false,
      });

      const args = mockRunLineCommand.mock.calls[0]?.[0]?.args ?? [];
      expect(args).not.toContain("tools.web_search=true");
    });

    it("adds `-c tools.web_search=true` to fresh exec when webSearchEnabled is true", async () => {
      simulateCodexRun([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      await core.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gpt-5.4",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
        persistSession: false,
        webSearchEnabled: true,
      });

      const args = mockRunLineCommand.mock.calls[0]?.[0]?.args ?? [];
      expect(args).toContain("tools.web_search=true");
      const flagIdx = args.indexOf("tools.web_search=true");
      expect(args[flagIdx - 1]).toBe("-c");
    });

    it("adds `-c tools.web_search=true` on resume when webSearchEnabled is true", async () => {
      simulateCodexRun([
        { type: "turn.started" },
        { type: "item.updated", item: { delta: "resumed reply" } },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      await core.executeResume({
        sessionId: "thread-abc",
        message: "follow up",
        modelId: "gpt-5.4",
        sessionDir: "/tmp/existing-session",
        webSearchEnabled: true,
      });

      const args = mockRunLineCommand.mock.calls[0]?.[0]?.args ?? [];
      expect(args).toContain("tools.web_search=true");
      const flagIdx = args.indexOf("tools.web_search=true");
      expect(args[flagIdx - 1]).toBe("-c");
    });

    it("keeps `-c tools.web_search=true` alongside the workspace-write sandbox in safe mode", async () => {
      // Regression guard: web-search is meant to work IN safe mode (the
      // tool runs server-side at OpenAI), so the `-c tools.web_search=true`
      // override must not displace the sandbox `-c` overrides.
      simulateCodexRun([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      await core.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gpt-5.4",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
        persistSession: false,
        webSearchEnabled: true,
      });

      const args = mockRunLineCommand.mock.calls[0]?.[0]?.args ?? [];
      expect(args).toContain("tools.web_search=true");
      expect(args).toContain('sandbox_mode="workspace-write"');
      expect(args).toContain("sandbox_workspace_write.network_access=true");
      expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    });

    it("keeps `-c tools.web_search=true` in allow mode alongside the dangerous-bypass flag", async () => {
      // Regression guard: allow mode collapses sandboxArgs to the single
      // `--dangerously-bypass-approvals-and-sandbox` flag. The web-search
      // override must still attach — it is independent of the sandbox
      // posture (Responses-API tool runs server-side at OpenAI).
      const allowCore = new CodexCore(
        makeConfig({ codexExecutionPermissionMode: "allow" }),
      );
      simulateCodexRun([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        {
          type: "turn.completed",
          model: "gpt-5.4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      await allowCore.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gpt-5.4",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
        persistSession: false,
        webSearchEnabled: true,
      });

      const args = mockRunLineCommand.mock.calls[0]?.[0]?.args ?? [];
      expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(args).toContain("tools.web_search=true");
      const flagIdx = args.indexOf("tools.web_search=true");
      expect(args[flagIdx - 1]).toBe("-c");
      // The dangerous bypass replaces the workspace-write `-c` block;
      // make sure that displacement did not also drop our override.
      expect(args).not.toContain('sandbox_mode="workspace-write"');
      expect(args).not.toContain("sandbox_workspace_write.network_access=true");
    });
  });

  describe("cost estimation", () => {
    it("estimates cost from usage and model registry", async () => {
      simulateCodexRun([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        {
          type: "turn.completed",
          model: "gpt-5.4-mini",
          usage: { input_tokens: 1000, output_tokens: 500 },
        },
      ]);

      const result = await core.execute({
        prompt: "test",
        context: "ctx",
        event: makeEvent(),
        modelId: "gpt-5.4-mini",
        maxTurns: 10,
        maxBudgetUsd: 1.0,
      });

      // gpt-5.4-mini: $0.00015/1k in, $0.0006/1k out
      // 1k input = $0.00015, 0.5k output = $0.0003
      expect(result.costUsd).toBeGreaterThan(0);
      expect(result.costSource).toBe("hardcoded");
    });

    it("prefers cached LiteLLM pricing when available", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "pa-codex-pricing-"));
      mkdirSync(join(dataDir, "cache"), { recursive: true });
      writeFileSync(
        join(dataDir, "cache", "model-prices.json"),
        JSON.stringify({
          fetchedAt: new Date().toISOString(),
          prices: {
            "gpt-5.4-mini": {
              input_cost_per_token: 0.0000002,
              output_cost_per_token: 0.0000008,
            },
          },
        }),
      );

      simulateCodexRun([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        {
          type: "turn.completed",
          model: "gpt-5.4-mini",
          usage: { input_tokens: 1000, output_tokens: 500 },
        },
      ]);

      try {
        const litellmCore = new CodexCore(makeConfig({ dataDir }));
        const result = await litellmCore.execute({
          prompt: "test",
          context: "ctx",
          event: makeEvent(),
          modelId: "gpt-5.4-mini",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        });

        expect(result.costSource).toBe("litellm");
        expect(result.costUsd).toBeCloseTo(0.0006, 6);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });
  });
});

describe("buildCodexImageArgs — chat-attachments --image translation", () => {
  const mk = (overrides: Partial<StagedAttachment> = {}): StagedAttachment => ({
    id: "att-1",
    safeFilename: "photo.png",
    mimeType: "image/png",
    absolutePath: "/tmp/session/_attachments/photo.png",
    relativePath: "_attachments/photo.png",
    ...overrides,
  });

  it("returns [] when the staged list is empty or undefined", () => {
    expect(buildCodexImageArgs(undefined, CODEX_ARGV_BUDGET_BYTES)).toEqual([]);
    expect(buildCodexImageArgs([], CODEX_ARGV_BUDGET_BYTES)).toEqual([]);
  });

  it("skips non-image MIMEs entirely (those stay staged-only)", () => {
    const staged = [
      mk({ mimeType: "application/pdf", safeFilename: "report.pdf" }),
      mk({ mimeType: "text/plain", safeFilename: "notes.txt" }),
    ];
    expect(buildCodexImageArgs(staged, CODEX_ARGV_BUDGET_BYTES)).toEqual([]);
  });

  it("emits `--image <absolutePath>` pairs for every image attachment", () => {
    const staged = [
      mk({ id: "a", absolutePath: "/tmp/a.png" }),
      mk({
        id: "b",
        absolutePath: "/tmp/b.jpg",
        mimeType: "image/jpeg",
        safeFilename: "b.jpg",
      }),
    ];
    expect(buildCodexImageArgs(staged, CODEX_ARGV_BUDGET_BYTES)).toEqual([
      "--image",
      "/tmp/a.png",
      "--image",
      "/tmp/b.jpg",
    ]);
  });

  it("case-insensitively matches image MIMEs (upstream `file-type` may lowercase)", () => {
    const staged = [mk({ mimeType: "IMAGE/WEBP" })];
    expect(buildCodexImageArgs(staged, CODEX_ARGV_BUDGET_BYTES)).toEqual([
      "--image",
      staged[0].absolutePath,
    ]);
  });

  it("drops the entire image list when total argv would exceed the budget", () => {
    // A 1 KB budget is well below the bytes needed for 5 long paths.
    const staged = Array.from({ length: 5 }, (_, i) =>
      mk({
        id: `i${i}`,
        safeFilename: `img${i}.png`,
        absolutePath: `/very/long/path/segments/${"x".repeat(500)}/img${i}.png`,
      }),
    );
    expect(buildCodexImageArgs(staged, 1024)).toEqual([]);
  });

  it("keeps the list when it fits exactly within the budget", () => {
    const staged = [mk({ absolutePath: "/short.png" })];
    // Bytes: "--image"(7)+1 + "/short.png"(10)+1 = 19 bytes per pair.
    expect(buildCodexImageArgs(staged, 19)).toEqual(["--image", "/short.png"]);
  });
});

// ── DELEGATED-PROXY-API-DESIGN.md §4.5 — runDelegatedTool ────────────────
describe("CodexCore.runDelegatedTool", () => {
  const VALID_KEY = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij";
  let core: CodexCore;
  let savedKey: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = VALID_KEY;
    core = new CodexCore(makeConfig());
  });

  function restoreEnv() {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
  }

  function makeProxyParams(overrides: Record<string, unknown> = {}) {
    const sessionDir = mkdtempSync(join(tmpdir(), "proxy-codex-"));
    return {
      sessionDir,
      params: {
        integrationKey: "gmail" as const,
        toolName: "mcp__codex_apps__gmail._search_emails",
        toolArgs: { query: "from:foo" },
        modelId: "gpt-5.4-mini",
        maxTurns: 2,
        maxBudgetUsd: 0.5,
        sessionDir,
        ...overrides,
      },
    };
  }

  function tearDown(sessionDir: string) {
    rmSync(sessionDir, { recursive: true, force: true });
  }

  it("returns ok=true with parsed toolResult when item.output is JSON", async () => {
    const { params, sessionDir } = makeProxyParams();
    try {
      simulateCodexRun([
        { type: "thread.started", thread_id: "t-1" },
        { type: "turn.started" },
        {
          type: "item.created",
          item: {
            type: "function_call",
            id: "fc_1",
            name: "mcp__codex_apps__gmail._search_emails",
            tool: "_search_emails",
            server: "codex_apps",
            arguments: '{"query":"from:foo"}',
          },
        },
        {
          type: "item.completed",
          item: {
            type: "function_call_output",
            call_id: "fc_1",
            output: { messages: [{ id: "abc" }] },
          },
        },
        {
          type: "turn.completed",
          model: "gpt-5.4-mini",
          usage: {
            input_tokens: 800,
            output_tokens: 50,
            cached_input_tokens: 0,
          },
        },
      ]);
      const result = await core.runDelegatedTool(params);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.toolResult).toEqual({ messages: [{ id: "abc" }] });
      expect(result.cost.tokensInput).toBeGreaterThan(0);
      expect(result.cost.numTurns).toBe(1);
    } finally {
      tearDown(sessionDir);
      restoreEnv();
    }
  });

  it("classifies a wrong tool call as 'wrong_tool'", async () => {
    const { params, sessionDir } = makeProxyParams();
    try {
      simulateCodexRun([
        { type: "thread.started", thread_id: "t-1" },
        { type: "turn.started" },
        {
          type: "item.created",
          item: {
            type: "function_call",
            id: "fc_1",
            name: "mcp__codex_apps__gmail._send_email",
            tool: "_send_email",
            server: "codex_apps",
          },
        },
        {
          type: "turn.completed",
          model: "gpt-5.4-mini",
          usage: { input_tokens: 100, output_tokens: 5 },
        },
      ]);
      const result = await core.runDelegatedTool(params);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.errorClass).toBe("wrong_tool");
    } finally {
      tearDown(sessionDir);
      restoreEnv();
    }
  });

  it("classifies absence of any tool call as 'no_tool_call'", async () => {
    const { params, sessionDir } = makeProxyParams();
    try {
      simulateCodexRun([
        { type: "thread.started", thread_id: "t-1" },
        { type: "turn.started" },
        {
          type: "turn.completed",
          model: "gpt-5.4-mini",
          usage: { input_tokens: 50, output_tokens: 1 },
        },
      ]);
      const result = await core.runDelegatedTool(params);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.errorClass).toBe("no_tool_call");
    } finally {
      tearDown(sessionDir);
      restoreEnv();
    }
  });

  it("classifies an item carrying is_error=true as 'tool_error'", async () => {
    const { params, sessionDir } = makeProxyParams();
    try {
      simulateCodexRun([
        { type: "turn.started" },
        {
          type: "item.created",
          item: {
            type: "function_call",
            id: "fc_1",
            name: "mcp__codex_apps__gmail._search_emails",
            tool: "_search_emails",
            server: "codex_apps",
          },
        },
        {
          type: "item.completed",
          item: {
            type: "function_call_output",
            call_id: "fc_1",
            is_error: true,
            output: "permission denied: missing scope",
          },
        },
        {
          type: "turn.completed",
          model: "gpt-5.4-mini",
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      ]);
      const result = await core.runDelegatedTool(params);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.errorClass).toBe("tool_error");
      expect(result.message).toContain("permission denied");
    } finally {
      tearDown(sessionDir);
      restoreEnv();
    }
  });

  it("classifies subprocess timeout via runResult.timedOut", async () => {
    const { params, sessionDir } = makeProxyParams();
    try {
      mockRunLineCommand.mockImplementation(async () => ({
        exitCode: null,
        signal: null,
        stdoutLines: [],
        stderrLines: [],
        timedOut: true,
      }));
      const result = await core.runDelegatedTool(params);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.errorClass).toBe("timeout");
    } finally {
      tearDown(sessionDir);
      restoreEnv();
    }
  });

  it("classifies a non-zero exit with auth-shaped stderr as 'auth_error'", async () => {
    const { params, sessionDir } = makeProxyParams();
    try {
      simulateCodexRun(
        [{ type: "error", message: "unauthorized: refresh token expired" }],
        1,
        ["error: unauthorized"],
      );
      const result = await core.runDelegatedTool(params);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.errorClass).toBe("auth_error");
    } finally {
      tearDown(sessionDir);
      restoreEnv();
    }
  });

  it("returns ok=true via --output-last-message fallback when structured pairing yields nothing", async () => {
    const { params, sessionDir } = makeProxyParams();
    try {
      // Tool call seen but no paired output item — invoker falls back to
      // the captured assistant final message.
      simulateCodexRun([
        { type: "turn.started" },
        {
          type: "item.created",
          item: {
            type: "function_call",
            id: "fc_1",
            name: "mcp__codex_apps__gmail._search_emails",
            tool: "_search_emails",
            server: "codex_apps",
          },
        },
        {
          type: "turn.completed",
          model: "gpt-5.4-mini",
          usage: { input_tokens: 100, output_tokens: 5 },
        },
      ]);
      const { readFileIfExists } = await import("./cli-utils.js");
      vi.mocked(readFileIfExists).mockReturnValueOnce(
        '{"messages":[{"id":"xyz"}]}',
      );
      const result = await core.runDelegatedTool(params);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.toolResult).toEqual({ messages: [{ id: "xyz" }] });
    } finally {
      tearDown(sessionDir);
      restoreEnv();
    }
  });

  it("suppresses --output-last-message fallback when reasoning was observed during the proxy turn", async () => {
    // Reasoning-gate sibling of the executeTurn test, on the
    // delegated-proxy surface. When structured tool-result pairing
    // does not yield a result, runDelegatedTool falls back to the
    // captured `--output-last-message` content. If codex emitted
    // reasoning items during the turn (codex GPT-5 family), the
    // file may itself contain a reasoning summary — using it would
    // surface reasoning narration as a fake "tool result" through
    // `tryParseToolResult`. The gate must refuse the file in that
    // case so the proxy returns no_tool_call instead.
    const { params, sessionDir } = makeProxyParams();
    const { readFileIfExists } = await import("./cli-utils.js");
    // File contains plausible reasoning narration. WITHOUT the
    // gate this would surface as `toolResult: <reasoning text>`.
    // Use mockReturnValue (not Once) so the value applies for the
    // entire test; the finally block restores the default `null`
    // so unconsumed queue values cannot bleed into the next test
    // (vi.clearAllMocks does NOT drain mockReturnValueOnce queues —
    // a property the gate makes load-bearing because suppression
    // means readFileIfExists is never called).
    vi.mocked(readFileIfExists).mockReturnValue(
      "I should check the inbox first and then summarize.",
    );
    try {
      simulateCodexRun([
        { type: "turn.started" },
        // Matching MCP tool call but no paired output item.
        {
          type: "item.created",
          item: {
            type: "function_call",
            id: "fc_1",
            name: "mcp__codex_apps__gmail._search_emails",
            tool: "_search_emails",
            server: "codex_apps",
          },
        },
        // Reasoning items observed during the turn — these set the
        // `observedReasoning` flag inside runDelegatedTool.
        { type: "item.started", item: { id: "r1", type: "reasoning" } },
        { type: "item.updated", item: { id: "r1", delta: "deliberating" } },
        { type: "item.completed", item: { id: "r1" } },
        {
          type: "turn.completed",
          model: "gpt-5.4-mini",
          usage: { input_tokens: 100, output_tokens: 5 },
        },
      ]);
      const result = await core.runDelegatedTool(params);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      // The exact class depends on the post-fallback branch; the
      // critical assertion is that the file's reasoning text NEVER
      // reaches the returned message verbatim.
      expect(result.message ?? "").not.toContain("inbox first");
      expect(result.message ?? "").not.toContain("summarize");
    } finally {
      vi.mocked(readFileIfExists).mockReset();
      vi.mocked(readFileIfExists).mockReturnValue(null);
      tearDown(sessionDir);
      restoreEnv();
    }
  });

  it("mirrors codexExecutionPermissionMode 'allow' into --dangerously-bypass-approvals-and-sandbox", async () => {
    const { params, sessionDir } = makeProxyParams();
    try {
      const allowCore = new CodexCore(
        makeConfig({ codexExecutionPermissionMode: "allow" } as Partial<AgentConfig>),
      );
      simulateCodexRun([
        { type: "turn.started" },
        {
          type: "item.created",
          item: {
            type: "function_call",
            id: "fc_1",
            name: "mcp__codex_apps__gmail._search_emails",
            tool: "_search_emails",
            server: "codex_apps",
          },
        },
        {
          type: "item.completed",
          item: {
            type: "function_call_output",
            call_id: "fc_1",
            output: { messages: [] },
          },
        },
        {
          type: "turn.completed",
          model: "gpt-5.4-mini",
          usage: { input_tokens: 50, output_tokens: 5 },
        },
      ]);
      await allowCore.runDelegatedTool(params);
      const argv = mockRunLineCommand.mock.calls[0]?.[0]?.args ?? [];
      expect(argv).toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(argv).not.toContain('sandbox_mode="workspace-write"');
    } finally {
      tearDown(sessionDir);
      restoreEnv();
    }
  });

  it("uses workspace-write sandbox in strict mode (default)", async () => {
    const { params, sessionDir } = makeProxyParams();
    try {
      simulateCodexRun([
        { type: "turn.started" },
        { type: "turn.completed", model: "gpt-5.4-mini", usage: { input_tokens: 1, output_tokens: 1 } },
      ]);
      await core.runDelegatedTool(params);
      const argv = mockRunLineCommand.mock.calls[0]?.[0]?.args ?? [];
      expect(argv).toContain('sandbox_mode="workspace-write"');
      expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    } finally {
      tearDown(sessionDir);
      restoreEnv();
    }
  });

  it("returns subprocess_crashed when the CLI binary is missing on PATH", async () => {
    const { params, sessionDir } = makeProxyParams();
    try {
      const { findExecutable } = await import("./cli-utils.js");
      vi.mocked(findExecutable).mockReturnValueOnce(null);
      const noBinaryCore = new CodexCore(makeConfig());
      const result = await noBinaryCore.runDelegatedTool(params);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.errorClass).toBe("subprocess_crashed");
      expect(result.message).toContain("codex CLI not found");
    } finally {
      tearDown(sessionDir);
      restoreEnv();
    }
  });
});

// ── DELEGATED-TASK-MODE-DESIGN.md §9 — runDelegatedTask (Phase 1.5) ──────
//
// Codex task mode lives entirely in daemon-side stream pre-emption: the
// CLI offers no per-spawn allowedTools surface for MCP calls, so we
// observe each `tool_use` item on stdout, gate it against the per-task
// envelope, and abort via the local AbortController if the model reaches
// outside. These tests exercise the gating + classification rather than
// the prompt-injection surface (the runtime helper has dedicated tests
// for that).
describe("CodexCore.runDelegatedTask", () => {
  const VALID_KEY = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij";
  let core: CodexCore;
  let savedKey: string | undefined;
  let proxyDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    savedKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = VALID_KEY;
    core = new CodexCore(makeConfig());
    proxyDir = mkdtempSync(join(tmpdir(), "task-codex-"));
  });

  function restoreEnv() {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
    rmSync(proxyDir, { recursive: true, force: true });
  }

  function makeTaskParams(overrides: Record<string, unknown> = {}) {
    return {
      integrationKey: "gmail" as const,
      systemPrompt: "task body",
      validate: (_value: unknown) => true,
      validatorErrorMessage: () => "",
      allowedTools: ["mcp__codex_apps__gmail._search_emails"],
      destructiveTools: [],
      writeClassTools: [],
      modelId: "gpt-5.4-mini",
      maxToolCalls: 5,
      maxBudgetUsd: 0.05,
      timeoutMs: 60000,
      allowDestructive: false,
      sessionDir: proxyDir,
      ...overrides,
    } as unknown as Parameters<typeof core.runDelegatedTask>[0];
  }

  it("returns ok=true with rawAssistantText from --output-last-message on success", async () => {
    // Arrange: a single allowed tool_use, paired result, then turn.completed.
    // The output-last-message file mock returns a JSON-shaped final message.
    simulateCodexRun([
      { type: "turn.started" },
      {
        type: "item.created",
        item: {
          type: "function_call",
          id: "fc_1",
          name: "mcp__codex_apps__gmail._search_emails",
          tool: "_search_emails",
          server: "codex_apps",
          arguments: '{"query":"from:foo"}',
        },
      },
      {
        type: "item.completed",
        item: {
          type: "function_call_output",
          call_id: "fc_1",
          output: '[{"id":"abc"}]',
        },
      },
      {
        type: "turn.completed",
        model: "gpt-5.4-mini",
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    ]);
    const { readFileIfExists } = await import("./cli-utils.js");
    vi.mocked(readFileIfExists).mockReturnValueOnce('{"messages":[{"id":"abc"}]}');

    try {
      const result = await core.runDelegatedTask(makeTaskParams());
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.rawAssistantText).toBe('{"messages":[{"id":"abc"}]}');
      expect(result.trace.map((s) => s.toolName)).toEqual([
        "mcp__codex_apps__gmail._search_emails",
      ]);
      expect(result.trace[0].status).toBe("ok");
      expect(result.trace[0].toolArgs).toEqual({ query: "from:foo" });
      expect(result.cost.tokensInput).toBeGreaterThan(0);
    } finally {
      restoreEnv();
    }
  });

  // /exec actor-attribution depends on each ok trace step carrying the
  // parsed connector response in `toolResult` so the response-shape
  // walker can pluck ids on id-in-response writes (send_email,
  // create_event, notion-create-pages). The route stub-tests can't
  // exercise this wiring — they synthesize trace steps directly. This
  // assertion locks the contract: when Codex emits a JSON-shaped
  // `function_call_output`, the trace step's toolResult is the parsed
  // object, not the raw string.
  it("populates trace[i].toolResult by JSON-parsing the function_call_output payload", async () => {
    simulateCodexRun([
      { type: "turn.started" },
      {
        type: "item.created",
        item: {
          type: "function_call",
          id: "fc_1",
          name: "mcp__codex_apps__gmail._send_email",
          tool: "_send_email",
          server: "codex_apps",
          arguments: '{"to":"alice@example.com","subject":"hi"}',
        },
      },
      {
        type: "item.completed",
        item: {
          type: "function_call_output",
          call_id: "fc_1",
          output: '{"messageId":"new-msg-7","threadId":"new-thread-7"}',
        },
      },
      {
        type: "turn.completed",
        model: "gpt-5.4-mini",
        usage: { input_tokens: 80, output_tokens: 20 },
      },
    ]);
    const { readFileIfExists } = await import("./cli-utils.js");
    vi.mocked(readFileIfExists).mockReturnValueOnce('{"messages":["sent"]}');

    try {
      const result = await core.runDelegatedTask(
        makeTaskParams({
          allowedTools: ["mcp__codex_apps__gmail._send_email"],
          destructiveTools: ["mcp__codex_apps__gmail._send_email"],
          allowDestructive: true,
        }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.trace).toHaveLength(1);
      expect(result.trace[0].toolResult).toEqual({
        messageId: "new-msg-7",
        threadId: "new-thread-7",
      });
    } finally {
      restoreEnv();
    }
  });

  // Connectors that return free-form text (no JSON envelope) must still
  // populate `toolResult` so the field is uniformly present on ok
  // steps — the route's response-shape walker simply finds no id and
  // falls through to args-side extraction. Verifying the fallback keeps
  // future regressions where a thrown JSON.parse exception poisons the
  // trace from going unnoticed.
  it("populates trace[i].toolResult with the raw string when the payload is not JSON", async () => {
    simulateCodexRun([
      { type: "turn.started" },
      {
        type: "item.created",
        item: {
          type: "function_call",
          id: "fc_1",
          name: "mcp__codex_apps__gmail._search_emails",
          tool: "_search_emails",
          server: "codex_apps",
          arguments: '{"query":"x"}',
        },
      },
      {
        type: "item.completed",
        item: {
          type: "function_call_output",
          call_id: "fc_1",
          output: "no results found",
        },
      },
      {
        type: "turn.completed",
        model: "gpt-5.4-mini",
        usage: { input_tokens: 30, output_tokens: 10 },
      },
    ]);
    const { readFileIfExists } = await import("./cli-utils.js");
    vi.mocked(readFileIfExists).mockReturnValueOnce('{"messages":[]}');

    try {
      const result = await core.runDelegatedTask(makeTaskParams());
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.trace).toHaveLength(1);
      expect(result.trace[0].toolResult).toBe("no results found");
    } finally {
      restoreEnv();
    }
  });

  it("classifies a tool_use outside allowedTools as 'policy_violation' and aborts the subprocess", async () => {
    simulateCodexRun([
      { type: "turn.started" },
      {
        type: "item.created",
        item: {
          type: "function_call",
          id: "fc_1",
          // Caller's allowedTools = [`_search_emails`]; this is `_send_email`.
          name: "mcp__codex_apps__gmail._send_email",
          tool: "_send_email",
          server: "codex_apps",
        },
      },
      {
        type: "turn.completed",
        model: "gpt-5.4-mini",
        usage: { input_tokens: 50, output_tokens: 5 },
      },
    ]);
    try {
      const result = await core.runDelegatedTask(makeTaskParams());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.errorClass).toBe("policy_violation");
      expect(result.message).toContain("mcp__codex_apps__gmail._send_email");
    } finally {
      restoreEnv();
    }
  });

  it("denies a destructive tool even when allowedTools nominally admits it (allowDestructive=false)", async () => {
    // Caller listed `_send_email` in allowedTools (e.g. derived from a
    // capability key) but did NOT pass allowDestructive=true. The
    // destructive deny set must win.
    simulateCodexRun([
      { type: "turn.started" },
      {
        type: "item.created",
        item: {
          type: "function_call",
          id: "fc_1",
          name: "mcp__codex_apps__gmail._send_email",
          tool: "_send_email",
          server: "codex_apps",
        },
      },
      {
        type: "turn.completed",
        model: "gpt-5.4-mini",
        usage: { input_tokens: 50, output_tokens: 5 },
      },
    ]);
    try {
      const result = await core.runDelegatedTask(
        makeTaskParams({
          allowedTools: [
            "mcp__codex_apps__gmail._search_emails",
            "mcp__codex_apps__gmail._send_email",
          ],
          destructiveTools: ["mcp__codex_apps__gmail._send_email"],
        }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.errorClass).toBe("policy_violation");
    } finally {
      restoreEnv();
    }
  });

  it("classifies maxToolCalls overflow as 'loop_aborted'", async () => {
    simulateCodexRun([
      { type: "turn.started" },
      {
        type: "item.created",
        item: {
          type: "function_call",
          id: "fc_1",
          name: "mcp__codex_apps__gmail._search_emails",
          tool: "_search_emails",
          server: "codex_apps",
        },
      },
      {
        type: "item.created",
        item: {
          type: "function_call",
          id: "fc_2",
          name: "mcp__codex_apps__gmail._search_emails",
          tool: "_search_emails",
          server: "codex_apps",
        },
      },
      {
        type: "turn.completed",
        model: "gpt-5.4-mini",
        usage: { input_tokens: 50, output_tokens: 5 },
      },
    ]);
    try {
      const result = await core.runDelegatedTask(
        makeTaskParams({ maxToolCalls: 1 }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.errorClass).toBe("loop_aborted");
      expect(result.message).toContain("maxToolCalls=1");
    } finally {
      restoreEnv();
    }
  });

  it("flips writeClassToolFired when an allowed write-class tool runs", async () => {
    // Reversible-write scenario: `_create_draft` is write-class but not
    // destructive. Should run successfully and flip the flag so the
    // invoker can suppress the §6.2 single retry.
    simulateCodexRun([
      { type: "turn.started" },
      {
        type: "item.created",
        item: {
          type: "function_call",
          id: "fc_1",
          name: "mcp__codex_apps__gmail._create_draft",
          tool: "_create_draft",
          server: "codex_apps",
        },
      },
      {
        type: "item.completed",
        item: {
          type: "function_call_output",
          call_id: "fc_1",
          output: '{"id":"draft-1"}',
        },
      },
      {
        type: "turn.completed",
        model: "gpt-5.4-mini",
        usage: { input_tokens: 60, output_tokens: 10 },
      },
    ]);
    const { readFileIfExists } = await import("./cli-utils.js");
    vi.mocked(readFileIfExists).mockReturnValueOnce('{"draftId":"draft-1"}');

    try {
      const result = await core.runDelegatedTask(
        makeTaskParams({
          allowedTools: ["mcp__codex_apps__gmail._create_draft"],
          writeClassTools: ["mcp__codex_apps__gmail._create_draft"],
        }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.writeClassToolFired).toBe(true);
    } finally {
      restoreEnv();
    }
  });

  it("suppresses --output-last-message and returns parse_error when reasoning was observed during the turn", async () => {
    // Reasoning-gate sibling of the executeTurn test. The delegated
    // task surface has no stream-side text accumulator, so the file
    // is the only text source — when reasoning was observed and the
    // file may carry a reasoning summary (codex GPT-5 behavior), we
    // refuse the file and surface a parse_error rather than feeding
    // reasoning narration to the dispatcher's structured-output
    // validator (which would either reject it as malformed JSON or
    // land it verbatim in delegated-task traces).
    //
    // mock semantics: use mockReturnValue (not Once) + reset in
    // finally because the gate causes readFileIfExists to NOT be
    // called, so an unconsumed mockReturnValueOnce would leak into
    // the next test's queue. vi.clearAllMocks does not drain those
    // queues.
    simulateCodexRun([
      { type: "turn.started" },
      // Reasoning item via the realistic codex 0.121+ wire format
      // (type declared on `item.started`, deltas pinned by id).
      { type: "item.started", item: { id: "r1", type: "reasoning" } },
      { type: "item.updated", item: { id: "r1", delta: "let me think" } },
      { type: "item.completed", item: { id: "r1" } },
      {
        type: "turn.completed",
        model: "gpt-5.4-mini",
        usage: { input_tokens: 20, output_tokens: 5 },
      },
    ]);
    const { readFileIfExists } = await import("./cli-utils.js");
    vi.mocked(readFileIfExists).mockReturnValue(
      "I will analyze and then respond carefully.",
    );
    try {
      const result = await core.runDelegatedTask(makeTaskParams());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.errorClass).toBe("parse_error");
      expect(result.message).toContain("reasoning");
      // The file content must NOT leak through to the message.
      expect(result.message).not.toContain("analyze");
      expect(result.message).not.toContain("carefully");
    } finally {
      vi.mocked(readFileIfExists).mockReset();
      vi.mocked(readFileIfExists).mockReturnValue(null);
      restoreEnv();
    }
  });

  it("classifies an empty --output-last-message as 'parse_error'", async () => {
    simulateCodexRun([
      { type: "turn.started" },
      {
        type: "turn.completed",
        model: "gpt-5.4-mini",
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    ]);
    const { readFileIfExists } = await import("./cli-utils.js");
    vi.mocked(readFileIfExists).mockReturnValueOnce("");
    try {
      const result = await core.runDelegatedTask(makeTaskParams());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.errorClass).toBe("parse_error");
    } finally {
      restoreEnv();
    }
  });

  it("classifies subprocess wall-clock timeout via runResult.timedOut", async () => {
    mockRunLineCommand.mockImplementation(async () => ({
      exitCode: null,
      signal: null,
      stdoutLines: [],
      stderrLines: [],
      timedOut: true,
    }));
    try {
      const result = await core.runDelegatedTask(makeTaskParams());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.errorClass).toBe("timeout");
    } finally {
      restoreEnv();
    }
  });

  it("classifies missing codex binary as 'subprocess_crashed'", async () => {
    const { findExecutable } = await import("./cli-utils.js");
    vi.mocked(findExecutable).mockReturnValueOnce(null);
    const noBinaryCore = new CodexCore(makeConfig());
    try {
      const result = await noBinaryCore.runDelegatedTask(makeTaskParams());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.errorClass).toBe("subprocess_crashed");
      expect(result.message).toContain("codex CLI not found");
    } finally {
      restoreEnv();
    }
  });
});

/**
 * Integration tests for the Fix-3 / Fix-4 wiring landed alongside the read-
 * token plumbing: classifyFailure must surface a structured `resetHint` for
 * provider rate-limit messages, and the runTurn stream observer must write a
 * `blocked_absolute` audit row (with the stream-observation trigger and
 * `result='partial'`) when an `item.action.command` matches an absolute-block
 * pattern.
 *
 * Lazy-import Database / applySchema after the hoisted vi.mock() at the top
 * of the file applies — same pattern used by the existing
 * "GeminiCliCore daily request counter" suite below in gemini-cli-core.test.ts.
 */
describe("CodexCore — quota reset hint + absolute-block stream observation", () => {
  let Database: typeof import("better-sqlite3").default;
  let applySchema: typeof import("../../db/schema.js").applySchema;

  beforeEach(async () => {
    vi.clearAllMocks();
    Database = (await import("better-sqlite3")).default;
    applySchema = (await import("../../db/schema.js")).applySchema;
  });

  function makeDbCore(): {
    db: import("better-sqlite3").Database;
    core: CodexCore;
  } {
    const db = new Database(":memory:");
    applySchema(db);
    const core = new CodexCore(makeConfig());
    // Audit writes go through `mcpContext.db`; the materializer short-circuits
    // when there are no rows in `mcp_servers`, so a fresh schema is enough.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- blobStore is unused on this path
    core.setMcpContext({ db, blobStore: {} as any });
    return { db, core };
  }

  it("classifyFailure attaches a reset hint to OpenAI 'try again in Xm' messages", () => {
    const core = new CodexCore(makeConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising private method
    const err = (core as any).classifyFailure(
      "Rate limit reached. Please try again in 26m11s.",
    );
    expect(err).toBeInstanceOf(BackendQuotaError);
    expect(err.originalCode).toBe("rate_limited");
    expect(err.resetHint).not.toBeNull();
    expect(err.resetHint?.timeZone).toBe("UTC");
    expect(err.resetHint?.rawLabel).toContain("try again in");
  });

  it("classifyFailure leaves resetHint null when no reset-time pattern is present", () => {
    const core = new CodexCore(makeConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = (core as any).classifyFailure(
      "Usage limit exceeded for this account.",
    );
    expect(err).toBeInstanceOf(BackendQuotaError);
    expect(err.resetHint).toBeNull();
  });

  it("execute writes a blocked_absolute row when an action.command matches", async () => {
    const { db, core } = makeDbCore();
    simulateCodexRun([
      { type: "thread.started", thread_id: "t1" },
      { type: "turn.started" },
      // OpenAI Responses-API local_shell_call shape — argv array under
      // item.action.command. Matches `extractCodexShellCall`'s shape #2.
      {
        type: "item.updated",
        item: { action: { type: "exec", command: ["rm", "-rf", "~"] } },
      },
      {
        type: "turn.completed",
        model: "gpt-5.4",
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    ]);

    await core.execute({
      prompt: "p",
      context: "c",
      event: makeEvent(),
      modelId: "gpt-5.4",
      maxTurns: 1,
      maxBudgetUsd: 1.0,
    });

    const rows = db
      .prepare(
        `SELECT action_type, trigger, result, detail, backend FROM agent_actions
           WHERE action_type = 'blocked_absolute'`,
      )
      .all() as Array<{
        action_type: string;
        trigger: string;
        result: string;
        detail: string;
        backend: string;
      }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].backend).toBe("codex");
    expect(rows[0].trigger).toBe("absolute_block_stream_observation");
    expect(rows[0].result).toBe("partial");
    const detail = JSON.parse(rows[0].detail);
    expect(detail.category).toBe("recursive_delete");
    expect(detail.observation).toBe("stream");

    db.close();
  });

  it("execute writes no row when item shape does not match a shell call", async () => {
    const { db, core } = makeDbCore();
    simulateCodexRun([
      { type: "thread.started", thread_id: "t1" },
      { type: "turn.started" },
      // Plain text delta — no command field, no action — must not trigger.
      { type: "item.updated", item: { delta: "hello" } },
      {
        type: "turn.completed",
        model: "gpt-5.4",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);

    await core.execute({
      prompt: "p",
      context: "c",
      event: makeEvent(),
      modelId: "gpt-5.4",
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
