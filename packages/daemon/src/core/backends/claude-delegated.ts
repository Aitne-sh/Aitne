/**
 * Claude-backend delegated-execution surface — pattern B split out of
 * `claude-code-core.ts` as part of the file-split plan (Tier 2, §8).
 *
 * Two responsibilities, both stateless from a module perspective:
 *
 *  1. **`runDelegatedTool`** — DELEGATED-PROXY-API-DESIGN.md §4.5 single-tool
 *     proxy. Spawns a Claude SDK stream constrained to one named tool (plus
 *     the `ToolSearch` deferred-schema loader), captures the tool's result or
 *     classifies a failure into the canonical `errorClass` union, and returns
 *     a `DelegatedToolResult` to the invoker.
 *
 *  2. **`runDelegatedTask`** — DELEGATED-TASK-MODE-DESIGN.md §9.1 multi-tool
 *     task mode. Plans + executes 1..N MCP calls under a `maxToolCalls`
 *     ceiling, optionally bound to a JSON-schema (§13 Phase 3.1 structured
 *     output), and returns the validated final emission (or a classified
 *     failure).
 *
 * The two functions share no mutable state beyond a deps record holding
 * `apiPort` (for `buildDaemonApiCliEnv`) and the read-token surface
 * (`readToken` legacy fallback + scoped `readTokenManager`). Picking
 * standalone async functions over a `ClaudeDelegatedRunner` class produces
 * fewer cross-references and lets the test suite invoke them without
 * instantiating `ClaudeCodeCore`. The thin `runDelegatedTool` /
 * `runDelegatedTask` methods on `ClaudeCodeCore` remain as transitional
 * shims (file-split-plan §15) — they forward to the functions here so
 * existing callers (BackendRouter, DelegatedBackendInvoker, the test suite)
 * continue to dispatch through `core.runDelegated*`.
 */

import {
  query,
  type Query,
  type SDKAssistantMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { matchRunAllowedToolPattern } from "@aitne/shared";

import {
  classifyAbortReason,
  DelegatedProxyTimeoutError,
  type DelegatedTaskInvokeParams,
  type DelegatedTaskResultRaw,
  type DelegatedTaskToolStepRaw,
  type DelegatedToolInvokeParams,
  type DelegatedToolResult,
  type ReadSensitiveTokenManager,
} from "../agent-core.js";
import { buildDaemonApiCliEnv } from "../daemon-api-cli.js";
import { createLogger } from "../../logging.js";
import { ALWAYS_DISALLOWED_TOOLS } from "../../safety/always-disallowed.js";
import { DELEGATED_PROXY_DEFAULTS } from "../../services/delegated-proxy-config.js";
import {
  buildDelegatedToolPrompt,
  emptyCost,
  flattenToolResultContent,
  tryParseToolResult,
  withDurationMs,
} from "../../services/delegated-tool-runtime.js";
import { IdleWatchdog } from "./idle-watchdog.js";

const logger = createLogger("claude-delegated");

/**
 * The built-in Claude Code tool that loads schemas for deferred MCP tools.
 * When a session inherits many MCP servers from the user's global config,
 * the CLI defers a portion of the tool schemas; the model must call
 * `ToolSearch` to bring a specific tool's schema into the working set
 * before invoking it. The proxy explicitly allows it (see `runDelegatedTool`)
 * and the stream parser excludes it from `wrongToolName` capture so a
 * partial-trace failure (`ToolSearch` + max_turns before the connector
 * call) classifies as `no_tool_call` rather than the misleading
 * `wrong_tool=ToolSearch`.
 */
const DEFERRED_TOOL_DISCOVERY_TOOL_NAME = "ToolSearch";

/**
 * Dependencies required to run a delegated proxy/task call. Picked out of
 * `ClaudeCodeCore` so the functions here can be invoked without holding a
 * full core instance. `readTokenManager` is preferred when present (per-
 * session scoped tokens); the legacy shared `readToken` is the fallback for
 * cores wired before the manager API existed.
 */
export interface ClaudeDelegatedDeps {
  readonly apiPort: number;
  readonly readToken: string | undefined;
  readonly readTokenManager: ReadSensitiveTokenManager | undefined;
}

/**
 * DELEGATED-PROXY-API-DESIGN.md §4.5 — Claude SDK single-tool proxy.
 *
 * Failure classification (errorClass values):
 *   - `wrong_tool` — model called a tool other than `toolName`
 *     (excluding `ToolSearch`, which is the expected deferred-schema loader).
 *   - `tool_error` — the tool call returned `is_error: true`.
 *   - `auth_error` — the SDK surfaced an authentication failure either
 *     mid-stream or as a thrown exception.
 *   - `no_tool_call` — the stream terminated without invoking `toolName`.
 *   - `parse_error` — the stream ended without a terminal `result` message.
 *   - `timeout` / `cancelled` — caller signal or idle-watchdog trip.
 *   - `subprocess_crashed` — exception thrown out of the iterator.
 *
 * Cost is captured from the terminal `SDKResultMessage` regardless of
 * subtype so the invoker can attribute partial spend on the failure
 * paths (no_tool_call, wrong_tool, tool_error).
 */
export async function runDelegatedTool(
  deps: ClaudeDelegatedDeps,
  params: DelegatedToolInvokeParams,
): Promise<DelegatedToolResult> {
  const startMs = Date.now();
  const { toolName, toolArgs, modelId, maxTurns, maxBudgetUsd, sessionDir } =
    params;
  const prompt = buildDelegatedToolPrompt(toolName, toolArgs);
  const daemonReadToken =
    deps.readTokenManager?.issue(sessionDir) ?? deps.readToken;

  let stream: Query | null = null;
  const aborted = { value: false };
  // `abortReason` carries the reason that caused `aborted.value=true`
  // so the post-loop classifier can map idle-watchdog aborts to
  // `errorClass="timeout"`. Falls back to the caller's signal reason
  // when only the caller initiated the abort.
  let abortReason: unknown = null;
  const closeStream = (): void => {
    void (async () => {
      try {
        await stream?.return?.(undefined);
      } catch {
        /* stream already closed */
      }
    })();
  };
  const onAbort = () => {
    aborted.value = true;
    abortReason = params.abortSignal?.reason ?? null;
    closeStream();
  };
  if (params.abortSignal) {
    if (params.abortSignal.aborted) {
      aborted.value = true;
      abortReason = params.abortSignal.reason ?? null;
    } else {
      params.abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  // Idle watchdog. Claude SDK runs in-process; cold-start is
  // negligible (no MCP/CLI load) so the typical first message lands
  // within 1-3 s. A 30 s idle threshold catches a stuck SDK iterator
  // (network stall, server-side hang) without false-tripping a slow
  // tool. On trip we close the stream the same way `onAbort` does and
  // record the trip in `abortReason` so the classifier returns
  // `errorClass="timeout"` (uniform with CLI backends).
  const idleTimeoutMs =
    DELEGATED_PROXY_DEFAULTS.idleTimeoutMsByBackend.claude
    ?? DELEGATED_PROXY_DEFAULTS.idleTimeoutMs;
  const idleWatchdog = new IdleWatchdog({
    idleTimeoutMs,
    onTimeout: (idleMs) => {
      if (aborted.value) return;
      aborted.value = true;
      abortReason = new DelegatedProxyTimeoutError(
        `claude SDK stream idle for ${idleMs}ms (limit ${idleTimeoutMs}ms)`,
      );
      logger.warn(
        { idleMs, idleTimeoutMs, toolName },
        "claude delegated proxy idle watchdog tripped",
      );
      closeStream();
    },
  });

  try {
    stream = query({
      prompt,
      options: {
        model: modelId,
        maxTurns,
        maxBudgetUsd,
        cwd: sessionDir,
        env: buildDaemonApiCliEnv(
          sessionDir,
          deps.apiPort,
          { readToken: daemonReadToken, sessionBackend: "claude" },
        ),
        systemPrompt: { type: "preset", preset: "claude_code" },
        permissionMode: "dontAsk",
        // The connector tool must be pre-authorized — Claude SDK with
        // permissionMode="dontAsk" silently denies anything not in
        // allowedTools.
        //
        // ToolSearch is Claude Code's deferred-tool discovery mechanism:
        // when many MCP servers are registered in the user's global
        // config (~/.claude.json: Notion, Gmail, GCal, Drive, Figma,
        // Canva, Hugging Face, …) the CLI ships only a working set of
        // tool schemas and defers the rest. To call a deferred tool, the
        // model must first call ToolSearch to load its schema. Without
        // ToolSearch allowed, the proxy's first turn was wasted on a
        // denied ToolSearch call (audit log 2026-04-29: 1 Notion failure
        // logged as `wrong_tool=ToolSearch`, 5 logged as
        // `subprocess_crashed: Reached maximum number of turns (2)` —
        // the model retried other approaches and exhausted the budget).
        //
        // Allowing ToolSearch is safe: allowedTools enforcement still
        // gates which tools can be CALLED, and ToolSearch only loads
        // schemas into context. The proxy parser below also skips
        // ToolSearch when capturing `wrongToolName` so a ToolSearch+
        // partial-result trace classifies as `no_tool_call` rather than
        // misleading `wrong_tool=ToolSearch`.
        //
        // TODO(future): a cleaner architectural fix is to materialize a
        // session-local `.mcp.json` containing only the relevant
        // connector's MCP server and pass `strictMcpConfig: true` —
        // that prevents deferral entirely (one MCP server → schemas fit
        // in the working set). Punted because it requires extracting
        // server configs from the user's global file per integration.
        allowedTools: [toolName, DEFERRED_TOOL_DISCOVERY_TOOL_NAME],
        // Defense-in-depth: even with allowedTools restricted to a tight
        // set, keep the absolute-block layer (rm -rf, sudo, secret file
        // reads) merged so a future relaxation of allowedTools can't
        // accidentally drop these guarantees.
        disallowedTools: [...ALWAYS_DISALLOWED_TOOLS],
        // Adaptive thinking is the SDK default for thinking-capable
        // models (Haiku 4.5+ / Sonnet 4.6+). Per Anthropic's docs
        // thinking happens within a single API call so it does not
        // typically burn an extra turn — but for a proxy that issues
        // one named tool call with explicit args, thinking adds latency
        // and tokens for no benefit. The proxy.md profile says "no
        // narration"; disabling thinking aligns runtime behavior with
        // that intent.
        thinking: { type: "disabled" },
      },
    });

    let capturedToolUseId: string | null = null;
    let capturedToolResult: unknown = undefined;
    let capturedToolErrorMessage: string | null = null;
    let wrongToolName: string | null = null;
    let cost = emptyCost();
    let terminalSubtype: string | null = null;
    let terminalIsError = false;
    let terminalErrors: string[] = [];

    try {
      idleWatchdog.start();
      for await (const message of stream) {
        idleWatchdog.beat();
        if (aborted.value) {
          break;
        }
        if (message.type === "assistant") {
          const assistantMsg = message as SDKAssistantMessage;
          const blocks = assistantMsg.message?.content;
          if (!Array.isArray(blocks)) continue;
          for (const block of blocks) {
            if (!block || typeof block !== "object") continue;
            const blockType = (block as { type?: string }).type;
            if (blockType !== "tool_use") continue;
            const blockName = (block as { name?: string }).name;
            const blockId = (block as { id?: string }).id;
            if (typeof blockName !== "string" || typeof blockId !== "string") {
              continue;
            }
            if (blockName === toolName) {
              if (capturedToolUseId === null) {
                capturedToolUseId = blockId;
              }
            } else if (blockName === DEFERRED_TOOL_DISCOVERY_TOOL_NAME) {
              // Expected intermediate step for loading the connector's
              // deferred MCP schema — not a violation. Do not capture as
              // wrongToolName so a partial trace (ToolSearch + max_turns
              // before the connector call) classifies as `no_tool_call`
              // instead of misleading `wrong_tool=ToolSearch`.
            } else if (wrongToolName === null) {
              wrongToolName = blockName;
              // Early abort: bound the wall-clock spend on a wrong_tool
              // failure to ~5s. Set `aborted` so the next loop iteration
              // breaks; close the SDK stream so any pending tool_use
              // doesn't continue. The post-loop classifier checks
              // `wrongToolName` BEFORE the abort branch, so the failure
              // is correctly attributed.
              aborted.value = true;
              closeStream();
            }
          }
        } else if (message.type === "user") {
          const userMsg = message as SDKUserMessage;
          const content = userMsg.message?.content;
          if (!Array.isArray(content)) continue;
          for (const block of content) {
            if (!block || typeof block !== "object") continue;
            if ((block as { type?: string }).type !== "tool_result") continue;
            const tuid = (block as { tool_use_id?: string }).tool_use_id;
            if (tuid !== capturedToolUseId) continue;
            const isToolError =
              (block as { is_error?: boolean }).is_error === true;
            const rawContent = (block as { content?: unknown }).content;
            const flat = flattenToolResultContent(rawContent);
            if (isToolError) {
              capturedToolErrorMessage =
                flat.trim().length > 0 ? flat : "tool returned is_error";
            } else if (capturedToolResult === undefined) {
              capturedToolResult = tryParseToolResult(flat);
            }
          }
        } else if (message.type === "result") {
          const r = message as SDKResultMessage;
          terminalSubtype = r.subtype;
          terminalIsError = r.is_error;
          cost = {
            tokensInput: r.usage.input_tokens ?? 0,
            tokensOutput: r.usage.output_tokens ?? 0,
            cacheCreationTokens: r.usage.cache_creation_input_tokens ?? 0,
            cacheReadTokens: r.usage.cache_read_input_tokens ?? 0,
            costUsd: r.total_cost_usd ?? 0,
            durationMs: r.duration_ms ?? Date.now() - startMs,
            numTurns: r.num_turns ?? 0,
          };
          if (r.subtype !== "success" && "errors" in r && Array.isArray(r.errors)) {
            terminalErrors = r.errors;
          }
          // The result message is terminal per SDK semantics. Break out
          // before the next iterator step. When `r.is_error` is true, the
          // SDK's transport sets `lastErrorResultText` and throws on the
          // next `readMessages` iteration — wrapping it as
          // `Error("Claude Code returned an error result: <text>")`. That
          // throw would land in the outer catch and misclassify as
          // `subprocess_crashed`, discarding the captured cost. Audit log
          // (2026-04-29) showed 5 such failures with num_turns=0,
          // tokens=0, masking that this was actually `error_max_turns`.
          // Breaking here lets the post-loop classifier run with the
          // captured terminalSubtype, terminalErrors, wrongToolName, and
          // cost intact.
          break;
        }
      }
    } finally {
      idleWatchdog.stop();
      try {
        await stream?.return?.(undefined);
      } catch {
        /* stream already closed */
      }
    }

    cost = withDurationMs(cost, startMs);

    // wrong_tool check hoisted above the abort branch because the
    // early-abort path sets `aborted.value` AND `wrongToolName`.
    // Without this ordering the failure would surface as `cancelled`
    // instead of the actual upstream cause. The `abortReason` field
    // distinguishes idle-watchdog aborts (errorClass="timeout") from
    // caller-initiated cancels (errorClass="cancelled" unless the
    // caller's reason was itself a `DelegatedProxyTimeoutError`).
    if (wrongToolName !== null) {
      return {
        ok: false,
        errorClass: "wrong_tool",
        message: `model called '${wrongToolName}' instead of requested '${toolName}'`,
        cost,
      };
    }
    if (aborted.value) {
      const reason = abortReason ?? params.abortSignal?.reason;
      const errorClass = classifyAbortReason(reason);
      const idleAbort = reason instanceof DelegatedProxyTimeoutError
        && /idle/.test(reason.message);
      return {
        ok: false,
        errorClass,
        message:
          errorClass === "timeout"
            ? (idleAbort
              ? `delegated proxy stream went idle (no claude SDK events for ${idleTimeoutMs}ms)`
              : "delegated proxy timed out (wall-clock)")
            : "delegated proxy cancelled by caller",
        cost,
      };
    }
    if (capturedToolResult !== undefined) {
      return { ok: true, toolResult: capturedToolResult, cost };
    }
    if (capturedToolErrorMessage !== null) {
      return {
        ok: false,
        errorClass: "tool_error",
        message: capturedToolErrorMessage,
        cost,
      };
    }
    // Map specific terminal subtypes before falling through to
    // no_tool_call. The model can fail for auth or budget reasons
    // before ever emitting a tool_use block.
    if (terminalSubtype === "error_during_execution" && terminalErrors.length > 0) {
      const joined = terminalErrors.join("; ");
      if (/auth|unauthorized|authentication_failed|invalid api key/i.test(joined)) {
        return {
          ok: false,
          errorClass: "auth_error",
          message: joined,
          cost,
        };
      }
      return {
        ok: false,
        errorClass: "tool_error",
        message: joined,
        cost,
      };
    }
    if (terminalSubtype === null && !terminalIsError) {
      // Stream ended before any terminal `result` arrived — abnormal
      // termination not classified as an abort. Treat as parse_error
      // so the route handler can surface the bug rather than retrying.
      return {
        ok: false,
        errorClass: "parse_error",
        message: "Claude SDK stream ended without a terminal result message",
        cost,
      };
    }
    return {
      ok: false,
      errorClass: "no_tool_call",
      message: `model did not invoke '${toolName}' within ${maxTurns} turns (subtype=${terminalSubtype ?? "unknown"})`,
      cost,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cost = withDurationMs(emptyCost(), startMs);
    // Map auth-shape exceptions before the catch-all subprocess_crashed.
    if (/authentication_failed|unauthorized|invalid api key|sk-ant-/i.test(message)) {
      return { ok: false, errorClass: "auth_error", message, cost };
    }
    if (aborted.value) {
      return {
        ok: false,
        errorClass: classifyAbortReason(abortReason ?? params.abortSignal?.reason),
        message,
        cost,
      };
    }
    return { ok: false, errorClass: "subprocess_crashed", message, cost };
  } finally {
    params.abortSignal?.removeEventListener("abort", onAbort);
    deps.readTokenManager?.revoke(sessionDir);
  }
}

/**
 * DELEGATED-TASK-MODE-DESIGN.md §9.1 — Claude SDK task mode. The
 * subprocess plans + executes 1..N MCP calls within `allowedTools` and
 * emits a final assistant message that the runtime helper validates
 * against the caller's `outputSchema`.
 *
 * Stream parsing differences from `runDelegatedTool`:
 *   - We accept multiple `tool_use` blocks (counted against `maxToolCalls`).
 *   - We track per-tool durations to feed `onToolStep`.
 *   - We capture the *final* assistant text (after the last tool turn)
 *     as the validation target, not a single tool's `tool_result`.
 *
 * Safety:
 *   - `allowedTools` already excludes the destructive set when
 *     `allowDestructive: false`; the SDK will not surface those tools.
 *   - `disallowedTools` is the absolute-block layer + the destructive
 *     set as defense-in-depth (so a future relaxation of allowedTools
 *     can't accidentally widen the surface).
 *
 * The §6.2 "no retry after write" rule is enforced at the invoker
 * layer; this method just signals via `writeClassToolFired` whether
 * any destructive tool ran during the task.
 */
export async function runDelegatedTask(
  deps: ClaudeDelegatedDeps,
  params: DelegatedTaskInvokeParams,
): Promise<DelegatedTaskResultRaw> {
  const startMs = Date.now();
  const {
    systemPrompt,
    allowedTools,
    destructiveTools,
    writeClassTools,
    modelId,
    maxToolCalls,
    maxBudgetUsd,
    sessionDir,
    onToolStep,
  } = params;
  const daemonReadToken =
    deps.readTokenManager?.issue(sessionDir) ?? deps.readToken;
  const trace: DelegatedTaskToolStepRaw[] = [];
  // §6.2 / §7.4 — match against the *write-class* set (destructive ∪
  // reversible writes), not just destructive. Otherwise reversible
  // write tools like `create_draft` slip past the retry guard and the
  // single retry creates a duplicate side effect.
  //
  // Phase 1 (`/exec`) entries are fully-qualified exact names — the
  // exact-equality fast path inside `matchRunAllowedToolPattern` covers
  // them at one comparison. Phase 2 (`/api/delegated/run`) may pass
  // `*`-suffixed glob patterns derived from the caller's allowedTools
  // (DELEGATED-TASK-MODE-DESIGN.md §4.2); the shared helper handles both.
  const writeClassMatcher = (name: string): boolean =>
    writeClassTools.some((pattern) =>
      matchRunAllowedToolPattern(pattern, name),
    );
  let writeClassToolFired = false;

  // DELEGATED-TASK-MODE-DESIGN.md §13 Phase 3.1 — Claude SDK
  // structured-output. When the invoker passed `structuredOutputEnabled:
  // true` AND a `wrappedSchema`, configure `outputFormat` so the SDK
  // validates the model's final emission against the schema (with its
  // own internal retries) and surfaces it on `SDKResultSuccess.structured_output`.
  // We still capture the assistant text as a fallback — if the SDK
  // returns success without `structured_output` (older subtype, future
  // shape change, kill-switch flips off mid-call), the existing text
  // path takes over.
  const useStructuredOutput =
    params.structuredOutputEnabled === true
    && !!params.wrappedSchema;
  let capturedStructured: unknown;
  let sawStructuredOutputRetryError = false;

  let stream: Query | null = null;
  const aborted = { value: false };
  const onAbort = () => {
    aborted.value = true;
    void (async () => {
      try {
        await stream?.return?.(undefined);
      } catch {
        /* stream already closed */
      }
    })();
  };
  if (params.abortSignal) {
    if (params.abortSignal.aborted) {
      aborted.value = true;
    } else {
      params.abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  /**
   * Track each `tool_use` so we can pair it with its `tool_result` to
   * compute per-call duration. The SDK does not surface per-tool cost
   * directly — token usage comes only on the terminal `result` event,
   * spanning every turn — so per-step `costUsd` / `tokens*` stay null.
   * The header row aggregates from the final usage event.
   */
  interface PendingToolUse {
    name: string;
    args: unknown;
    startedAt: number;
  }
  const pendingByUseId = new Map<string, PendingToolUse>();
  let toolCallCount = 0;
  let loopAborted = false;
  let assistantTextChunks: string[] = [];
  /** The "final" assistant message is the most recent assistant message
   *  that contained NO `tool_use` block. The SDK emits one assistant
   *  message per turn; the planning turns mix text + tool_use, the
   *  closing turn is text-only. */
  let lastAssistantTextOnlyChunks: string[] = [];

  try {
    stream = query({
      prompt: systemPrompt,
      options: {
        model: modelId,
        maxTurns: Math.max(2, maxToolCalls + 1),
        maxBudgetUsd,
        cwd: sessionDir,
        env: buildDaemonApiCliEnv(
          sessionDir,
          deps.apiPort,
          { readToken: daemonReadToken, sessionBackend: "claude" },
        ),
        systemPrompt: { type: "preset", preset: "claude_code" },
        permissionMode: "dontAsk",
        allowedTools: [...allowedTools],
        // Defense-in-depth: absolute-block layer + destructive denies.
        // Destructive entries are redundant with the allowedTools
        // subtraction (when allowDestructive=false) but kept so a
        // future allowedTools widening doesn't drop the guarantee.
        disallowedTools: [
          ...ALWAYS_DISALLOWED_TOOLS,
          ...(params.allowDestructive ? [] : destructiveTools),
        ],
        // §13 Phase 3.1 — bind the wrapped schema (user schema OR
        // confirmation envelope OR error envelope) to SDK 0.2.98's
        // `outputFormat`. Result message carries `structured_output`
        // which we read below. Off when the kill switch is false or
        // the invoker omitted the wrapped schema.
        ...(useStructuredOutput && params.wrappedSchema
          ? {
            outputFormat: {
              type: "json_schema" as const,
              schema: params.wrappedSchema,
            },
          }
          : {}),
      },
    });

    let cost = emptyCost();

    try {
      for await (const message of stream) {
        if (aborted.value || loopAborted) break;
        if (message.type === "assistant") {
          const assistantMsg = message as SDKAssistantMessage;
          const blocks = assistantMsg.message?.content;
          if (!Array.isArray(blocks)) continue;
          const textChunks: string[] = [];
          let sawToolUse = false;
          for (const block of blocks) {
            if (!block || typeof block !== "object") continue;
            const blockType = (block as { type?: string }).type;
            if (blockType === "text") {
              const text = (block as { text?: unknown }).text;
              if (typeof text === "string") textChunks.push(text);
              continue;
            }
            if (blockType !== "tool_use") continue;
            sawToolUse = true;
            const blockName = (block as { name?: string }).name;
            const blockId = (block as { id?: string }).id;
            const blockArgs = (block as { input?: unknown }).input;
            if (typeof blockName !== "string" || typeof blockId !== "string") {
              continue;
            }
            toolCallCount += 1;
            if (toolCallCount > maxToolCalls) {
              // §7.5 — once the cap is exceeded, abort. The next
              // tool_use is treated as overrun.
              loopAborted = true;
              aborted.value = true;
              try {
                await stream?.return?.(undefined);
              } catch {
                /* already closed */
              }
              break;
            }
            if (writeClassMatcher(blockName)) {
              writeClassToolFired = true;
            }
            pendingByUseId.set(blockId, {
              name: blockName,
              args: blockArgs,
              startedAt: Date.now(),
            });
          }
          assistantTextChunks = assistantTextChunks.concat(textChunks);
          if (!sawToolUse && textChunks.length > 0) {
            lastAssistantTextOnlyChunks = textChunks;
          }
        } else if (message.type === "user") {
          const userMsg = message as SDKUserMessage;
          const content = userMsg.message?.content;
          if (!Array.isArray(content)) continue;
          for (const block of content) {
            if (!block || typeof block !== "object") continue;
            if ((block as { type?: string }).type !== "tool_result") continue;
            const tuid = (block as { tool_use_id?: string }).tool_use_id;
            if (typeof tuid !== "string") continue;
            const pending = pendingByUseId.get(tuid);
            if (!pending) continue;
            pendingByUseId.delete(tuid);
            const isToolError =
              (block as { is_error?: boolean }).is_error === true;
            // `tool_result` content is either a string or an array of
            // content blocks (typically a single `{type:"text", text}`).
            // The MCP SDK wraps connector JSON responses by serializing
            // to that text body, so the response-shape walker
            // downstream wants the parsed object. Pull the first text
            // block, JSON-parse when possible, fallback to the raw
            // string so the field is always populated for ok steps.
            let parsedToolResult: unknown;
            const blockContent = (block as { content?: unknown }).content;
            if (typeof blockContent === "string") {
              try {
                parsedToolResult = JSON.parse(blockContent);
              } catch {
                parsedToolResult = blockContent;
              }
            } else if (Array.isArray(blockContent)) {
              const firstText = blockContent.find(
                (b): b is { type: "text"; text: string } =>
                  !!b
                  && typeof b === "object"
                  && (b as { type?: unknown }).type === "text"
                  && typeof (b as { text?: unknown }).text === "string",
              );
              if (firstText) {
                try {
                  parsedToolResult = JSON.parse(firstText.text);
                } catch {
                  parsedToolResult = firstText.text;
                }
              } else {
                parsedToolResult = blockContent;
              }
            }
            const step: DelegatedTaskToolStepRaw = {
              toolName: pending.name,
              toolArgs: pending.args,
              durationMs: Date.now() - pending.startedAt,
              status: isToolError ? "error" : "ok",
              costUsd: null,
              tokensInput: null,
              tokensOutput: null,
              toolResult: parsedToolResult,
            };
            trace.push(step);
            onToolStep?.(step);
          }
        } else if (message.type === "result") {
          const r = message as SDKResultMessage;
          cost = {
            tokensInput: r.usage.input_tokens ?? 0,
            tokensOutput: r.usage.output_tokens ?? 0,
            cacheCreationTokens: r.usage.cache_creation_input_tokens ?? 0,
            cacheReadTokens: r.usage.cache_read_input_tokens ?? 0,
            costUsd: r.total_cost_usd ?? 0,
            durationMs: r.duration_ms ?? Date.now() - startMs,
            numTurns: r.num_turns ?? 0,
          };
          // §13 Phase 3.1 — capture structured output when present, and
          // map the SDK's structured-output-retry-exhausted subtype to
          // a parse_error so the invoker classifies it consistently
          // with the text-extract path.
          if (r.subtype === "success") {
            const success = r as unknown as { structured_output?: unknown };
            if (success.structured_output !== undefined) {
              capturedStructured = success.structured_output;
            }
          } else if (
            r.subtype === "error_max_structured_output_retries"
          ) {
            sawStructuredOutputRetryError = true;
          }
        }
      }
    } finally {
      try {
        await stream?.return?.(undefined);
      } catch {
        /* already closed */
      }
    }

    cost = withDurationMs(cost, startMs);

    if (loopAborted) {
      return {
        ok: false,
        errorClass: "loop_aborted",
        message: `subprocess exceeded maxToolCalls=${maxToolCalls}`,
        cost,
        trace,
        writeClassToolFired,
      };
    }
    if (aborted.value) {
      const errorClass = classifyAbortReason(params.abortSignal?.reason);
      return {
        ok: false,
        errorClass,
        message:
          errorClass === "timeout"
            ? "delegated task timed out (wall-clock)"
            : "delegated task cancelled by caller",
        cost,
        trace,
        writeClassToolFired,
      };
    }

    const finalText = lastAssistantTextOnlyChunks.length > 0
      ? lastAssistantTextOnlyChunks.join("\n").trim()
      : assistantTextChunks.join("\n").trim();

    // §13 Phase 3.1 — `error_max_structured_output_retries` typically
    // fires when the model wanted to emit a §7.2 confirmation envelope
    // or §5.1 error envelope, neither of which satisfies the user's
    // narrow schema. The assistant text emissions captured during those
    // retries land in `assistantTextChunks` / `lastAssistantTextOnlyChunks`,
    // so the invoker's text-extract chain can route them via
    // `detectConfirmationEnvelope` / `detectErrorEnvelope`. Only return
    // `parse_error` if there is also no usable text — otherwise fall
    // through to the text-emission path (no `structuredOutput` field
    // set, so the invoker uses `rawAssistantText`).
    if (
      sawStructuredOutputRetryError
      && capturedStructured === undefined
      && finalText.length === 0
    ) {
      return {
        ok: false,
        errorClass: "parse_error",
        message:
          "Claude SDK exhausted structured-output retries and emitted no text fallback.",
        cost,
        trace,
        writeClassToolFired,
      };
    }

    // §13 Phase 3.1 — when the SDK supplied `structured_output`, that
    // is the validated final emission; the assistant text may be empty
    // (the SDK consumes the JSON internally on success). Skip the
    // empty-text parse_error guard in that case.
    if (capturedStructured === undefined && finalText.length === 0) {
      return {
        ok: false,
        errorClass: "parse_error",
        message: "Claude SDK stream ended without a text-only assistant turn",
        cost,
        trace,
        writeClassToolFired,
      };
    }

    return {
      ok: true,
      // When structured output is present, `rawAssistantText` is purely
      // a fallback; the invoker prefers `structuredOutput`. Carry both
      // so a future kill-switch flip mid-restart still sees an
      // extractable text emission.
      rawAssistantText: finalText,
      cost,
      trace,
      writeClassToolFired,
      ...(capturedStructured !== undefined
        ? { structuredOutput: capturedStructured }
        : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cost = withDurationMs(emptyCost(), startMs);
    if (/authentication_failed|unauthorized|invalid api key|sk-ant-/i.test(message)) {
      return {
        ok: false,
        errorClass: "auth_error",
        message,
        cost,
        trace,
        writeClassToolFired,
      };
    }
    if (aborted.value) {
      return {
        ok: false,
        errorClass: classifyAbortReason(params.abortSignal?.reason),
        message,
        cost,
        trace,
        writeClassToolFired,
      };
    }
    return {
      ok: false,
      errorClass: "subprocess_crashed",
      message,
      cost,
      trace,
      writeClassToolFired,
    };
  } finally {
    params.abortSignal?.removeEventListener("abort", onAbort);
    deps.readTokenManager?.revoke(sessionDir);
  }
}
