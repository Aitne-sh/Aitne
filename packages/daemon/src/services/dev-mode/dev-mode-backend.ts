/**
 * Development-mode backend — the concrete `DevBackend` the runner hands to the
 * leg layer. It turns one `DevBackendRequest` into a Claude Agent SDK `query()`
 * session and maps the stream back to a `DevLegResponse`.
 *
 * It calls `query()` DIRECTLY (the `background-task-driver.ts` precedent), NOT
 * `IAgentRouter.execute` / `IAgentCore.execute`, for three reasons:
 *   1. Per-leg envelope — each leg carries its own `maxTurns` / `maxBudgetUsd`
 *      / tool allowlist; `router.execute` derives those from a single
 *      per-processKey binding and would ignore the leg envelopes.
 *   2. Repo isolation — a dev leg's cwd MUST be the registered repo (it writes
 *      real code there). `core.execute` would `materializeMcp` the daemon's MCP
 *      config + skills into that cwd (polluting the user's repo diff/commit)
 *      and load the daemon operator's `~/.claude` user scope. Direct `query()`
 *      with `settingSources:["project"]` + no `mcpServers` keeps the leg a
 *      clean coding agent that sees only the repo's own conventions.
 *   3. D6 safety — `permissionMode:"dontAsk"` + an explicit `allowedTools` list
 *      (the leg's scoped envelope, never `git push`) DENIES unlisted tools
 *      rather than prompting, so the autonomous loop cannot push.
 *
 * The concrete model id is still resolved through the router's binding table
 * (`resolveModelId`, injected) so this module owns no model-registry logic.
 *
 * I/O-shaped (SDK stream consumer); excluded from the coverage gate — the
 * runner's own tests inject a fake `DevBackend`.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { BackendModelTier, Event } from "@aitne/shared";
import { EventPriority } from "@aitne/shared";
import { ALWAYS_DISALLOWED_TOOLS } from "../../safety/always-disallowed.js";
import { buildExecutionPrompt } from "../../core/backends/prompt-utils.js";
import { createLogger } from "../../logging.js";
import type { DevLegResponse } from "./dev-loop-engine.js";
import type { DevBackend, DevBackendRequest } from "./dev-loop-legs.js";

const logger = createLogger("dev-mode-backend");

/** The logical process key for every dev-mode leg. Unregistered on purpose —
 *  it typechecks (`ProcessKey = KnownProcessKey | string`) and resolves to the
 *  default backend + tier-default model without a `process_backend_config`
 *  row. */
export const DEV_SESSION_PROCESS_KEY = "dev.session";

export interface DevModeBackendDeps {
  /** tier → concrete model id, via `router.resolveBinding(...).main.modelId`.
   *  Returns null when no backend can be resolved (fail the leg). */
  resolveModelId: (tier: BackendModelTier) => string | null;
  /** The active run's AbortController — a `cancel()` / timeout aborts the
   *  in-flight leg. One controller per run; the runner threads it here. */
  abortController?: AbortController;
  now?: () => number;
}

const DEV_LEG_ERROR: DevLegResponse = {
  text: "",
  sessionId: null,
  costUsd: 0,
  numTurns: 0,
  isError: true,
};

/** Build the synthetic Event a leg's `query()` context substitution + telemetry
 *  needs. Dev legs never read `{event_data[...]}` placeholders, so an empty
 *  `data` is sufficient. */
function devEvent(sessionDir: string): Event {
  return {
    type: DEV_SESSION_PROCESS_KEY,
    source: "dev-mode",
    priority: EventPriority.NORMAL,
    timestamp: new Date(),
    data: {},
    correlationId: `dev.session:${sessionDir}`,
  };
}

export function createDevModeBackend(deps: DevModeBackendDeps): DevBackend {
  const now = deps.now ?? (() => Date.now());

  return {
    async runLeg(req: DevBackendRequest): Promise<DevLegResponse> {
      const modelId = deps.resolveModelId(req.tier);
      if (!modelId) {
        logger.error({ leg: req.taskFlowKey, tier: req.tier }, "dev-mode backend: no model for tier");
        return DEV_LEG_ERROR;
      }

      const event = devEvent(req.sessionDir);
      const fullPrompt = buildExecutionPrompt(req.prompt, req.context, event);

      // Per-leg AbortController. The watchdog (loop-kit maxIterSeconds) aborts
      // ONLY this leg — never the shared run controller — so a single hung leg
      // surfaces as a failed leg the engine handles (retry / BLOCKED), while
      // the loop keeps running. A run-level abort (cancel / session-timeout on
      // `deps.abortController`) is FORWARDED here so it still unwinds the
      // in-flight leg, and the runner sees the run controller aborted.
      const runSignal = deps.abortController?.signal;
      const legController = new AbortController();
      const forwardRunAbort = (): void => {
        try {
          legController.abort(runSignal?.reason ?? new Error("dev_run_aborted"));
        } catch {
          /* already aborted */
        }
      };
      if (runSignal) {
        if (runSignal.aborted) forwardRunAbort();
        else runSignal.addEventListener("abort", forwardRunAbort, { once: true });
      }
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      if (req.maxSeconds && req.maxSeconds > 0) {
        watchdog = setTimeout(() => {
          try {
            legController.abort(new Error("dev_leg_watchdog_timeout"));
          } catch {
            /* already aborted */
          }
        }, req.maxSeconds * 1000);
      }

      let costUsd = 0;
      let numTurns = 0;
      let sessionId: string | null = null;
      let isError = false;
      // The leg's verdict grammar (VERDICT:/STOP-EVAL:/agent-state) lives in the
      // model's REPLY TEXT — verdict-parse scans the whole reply for the last
      // matching line (loop-kit extract_verdict), so accumulate every assistant
      // text block. `finalResult` is the SDK `result` message's terminal text,
      // a fallback when no assistant text block streamed.
      const textParts: string[] = [];
      let finalResult = "";
      const startMs = now();

      try {
        const stream = query({
          prompt: fullPrompt,
          options: {
            cwd: req.sessionDir,
            model: modelId,
            maxTurns: req.maxTurns,
            maxBudgetUsd: req.maxBudgetUsd,
            abortController: legController,
            permissionMode: "dontAsk" as const,
            // REPLACE semantics — exactly the leg's envelope. Write legs get
            // Read/Glob/Grep/Write/Edit(+scoped Bash); read-only legs get
            // Read/Glob/Grep. Anything unlisted (git push, curl, …) is denied.
            allowedTools: [...req.allowedTools],
            disallowedTools: [...ALWAYS_DISALLOWED_TOOLS],
            // Load the repo's own CLAUDE.md / .claude conventions, NOT the
            // daemon operator's ~/.claude user scope.
            settingSources: ["project"] as const,
            // Each leg is a fresh loop-kit iteration — memory is .aitne-dev/ +
            // git, never a warm SDK transcript.
            persistSession: false,
            includePartialMessages: false,
          },
        });

        try {
          for await (const message of stream) {
            if (
              message.type === "system"
              && (message as { subtype?: string }).subtype === "init"
            ) {
              const sid = (message as { session_id?: string }).session_id ?? null;
              if (sid) sessionId = sid;
            } else if (message.type === "assistant") {
              const content = (message as { message?: { content?: unknown } }).message?.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (
                    block
                    && typeof block === "object"
                    && (block as { type?: string }).type === "text"
                    && typeof (block as { text?: unknown }).text === "string"
                  ) {
                    textParts.push((block as { text: string }).text);
                  }
                }
              }
            } else if (message.type === "result") {
              const result = message as {
                is_error?: boolean;
                total_cost_usd?: number;
                num_turns?: number;
                result?: string;
              };
              isError = isError || !!result.is_error;
              costUsd += result.total_cost_usd ?? 0;
              numTurns = result.num_turns ?? numTurns;
              if (typeof result.result === "string") finalResult = result.result;
            }
          }
        } finally {
          try {
            await (stream as { return?: (v?: unknown) => Promise<unknown> }).return?.(
              undefined,
            );
          } catch {
            /* ignore generator close error */
          }
        }

        if (legController.signal.aborted) {
          isError = true;
        }
      } catch (err) {
        isError = true;
        logger.error(
          { err, leg: req.taskFlowKey, aborted: legController.signal.aborted },
          "dev-mode backend: query threw",
        );
      } finally {
        if (watchdog) clearTimeout(watchdog);
        if (runSignal) runSignal.removeEventListener("abort", forwardRunAbort);
      }

      const text = textParts.length > 0 ? textParts.join("\n") : finalResult;
      logger.info(
        { leg: req.taskFlowKey, model: modelId, costUsd, numTurns, isError, textLen: text.length, durationMs: now() - startMs },
        "dev-mode leg finished",
      );
      return { text, sessionId, costUsd, numTurns, isError };
    },
  };
}
