import type { DelegatedToolCost } from "../core/agent-core.js";

/**
 * Shared runtime helpers for the per-backend `runDelegatedTool`
 * implementations. The backends own the spawn + stream-event semantics
 * (Claude SDK `query()` vs Codex/Gemini JSONL CLI), but the prompt shape,
 * the tool-result extraction (string-or-block-array), and the empty-cost
 * sentinel are identical across them — centralising them here keeps the
 * three backend files honest and prevents drift in the prompt that
 * constrains the LLM to call exactly one tool.
 *
 * See DELEGATED-PROXY-API-DESIGN.md §4.1 (prompt shape) and §4.5
 * (output normalization — tool result, not model text).
 */

/**
 * Single user message that names the tool + verbatim JSON args. Mirrors
 * the agent-profiles/proxy.md hard-rules block — restating the
 * "no narration, single tool call" contract here is belt-and-suspenders
 * for backends whose system-prompt injection is less reliable than the
 * Claude Agent SDK's preset (Codex: prose AGENTS.md only; Gemini:
 * GEMINI.md + admin-policy TOML).
 */
export function buildDelegatedToolPrompt(
  toolName: string,
  toolArgs: unknown,
): string {
  const argsJson = JSON.stringify(toolArgs ?? {});
  return [
    `Call the tool \`${toolName}\` with these arguments (verbatim JSON):`,
    argsJson,
    "",
    "Return only the tool's raw result. Do not summarize, do not narrate, do not call other tools.",
    "If the tool errors, return the error verbatim.",
  ].join("\n");
}

/**
 * Flatten tool-result `content` blocks (Claude SDK shape) into a single
 * string. The SDK can return either a raw string or an array of
 * `{type: "text", text: "..."}` blocks; the route handler's responseMapper
 * works on either, but the failure paths (`tool_error`, `parse_error`)
 * want a single message field. Codex / Gemini paths reach this with
 * a primitive string already, in which case it's a no-op.
 */
export function flattenToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    if (content && typeof content === "object") {
      try {
        return JSON.stringify(content);
      } catch {
        return String(content);
      }
    }
    return content == null ? "" : String(content);
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (block && typeof block === "object") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") {
        parts.push(text);
        continue;
      }
      try {
        parts.push(JSON.stringify(block));
      } catch {
        parts.push(String(block));
      }
    }
  }
  return parts.join("\n");
}

/**
 * Parse a flattened tool result as JSON when possible; fall back to the
 * raw string. The route handler's `responseMapper` accepts either shape;
 * preferring parsed-JSON keeps the response-mapper from re-parsing for
 * the common case (connector tools all emit JSON envelopes).
 */
export function tryParseToolResult(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (
    trimmed.length >= 2
    && (trimmed.startsWith("{") || trimmed.startsWith("["))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Connector returned malformed JSON; surface the raw string. The
      // route handler's responseMapper still gets a chance to inspect.
    }
  }
  return raw;
}

export function emptyCost(): DelegatedToolCost {
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

/**
 * Cap a partial cost block's `durationMs` against the actual wall-clock
 * spent before failure. The backends compute `durationMs` from a startMs
 * captured before subprocess spawn — but the cost block we return on
 * failure should reflect the wall-clock the invoker can attribute, not
 * a model-reported duration. Backends call this as the final step
 * before returning `{ok: false, cost}` so the invoker's
 * `agent_actions.duration_ms` matches the real spend.
 */
export function withDurationMs(
  cost: DelegatedToolCost,
  startMs: number,
  now: () => number = Date.now,
): DelegatedToolCost {
  return { ...cost, durationMs: Math.max(0, now() - startMs) };
}
