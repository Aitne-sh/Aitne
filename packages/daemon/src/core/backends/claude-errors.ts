/**
 * Claude-backend error types and introspection helpers — pure module split
 * out of `claude-code-core.ts` as part of the file-split plan (Tier 1, §8).
 *
 * No instance state. Every export is pure over its arguments. Consumed by
 * `ClaudeCodeCore`'s stream/error-mapping paths and by `BackendRouter` via
 * the error types it re-exports.
 */

export class AgentTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Agent execution exceeded timeout of ${timeoutMs}ms`);
    this.name = "AgentTimeoutError";
  }
}

export interface ClaudeCodeQuotaResetHint {
  hour: number;
  minute: number;
  timeZone?: string;
  rawLabel: string;
}

/**
 * Structural shape that all three SDK / CLI error surfaces happen to expose
 * (Anthropic SDK errors, `BackendQuotaError`, raw Node `Error`s) when
 * narrowed by the type / status / code probes below. Exported so the
 * surrounding error-mapping code in `claude-code-core.ts` and
 * `claude-auth.ts` (file-split-plan.md §8) can share a single definition.
 *
 * @internal — module-friendship type for the backends-folder; not part of
 * the `claude-code-core.ts` public surface.
 */
export type ErrorLike = {
  status?: number;
  code?: string;
  type?: string;
  cause?: unknown;
  message?: string;
};

export function isClaudeCodeQuotaError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const maybeRecord = error as Error & {
    status?: number;
    code?: string;
    type?: string;
    cause?: unknown;
  };
  const message = error.message.toLowerCase();
  const code = typeof maybeRecord.code === "string" ? maybeRecord.code.toLowerCase() : "";
  const type = typeof maybeRecord.type === "string" ? maybeRecord.type.toLowerCase() : "";

  if (maybeRecord.status === 429) {
    return true;
  }
  if (code.includes("rate") || code.includes("quota")) {
    return true;
  }
  if (type.includes("rate") || type.includes("quota")) {
    return true;
  }
  return /rate.?limit|quota|too many requests|you['']?\s*ve hit your limit/.test(message);
}

export function isClaudeCodeMaxBudgetError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
  const code =
    typeof error === "object" && error !== null && typeof (error as ErrorLike).code === "string"
      ? (error as ErrorLike).code
      : "";
  const type =
    typeof error === "object" && error !== null && typeof (error as ErrorLike).type === "string"
      ? (error as ErrorLike).type
      : "";

  return /max(?:imum)? budget|max_budget_usd|budget limit|per-turn budget/i.test(
    `${message} ${code} ${type}`,
  );
}

export function extractClaudeCodeQuotaResetHint(
  error: unknown,
): ClaudeCodeQuotaResetHint | null {
  if (!(error instanceof Error)) {
    return null;
  }

  const match = /resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\))?/i.exec(
    error.message,
  );
  if (!match) {
    return null;
  }

  const rawHour = Number(match[1]);
  const meridiem = match[3].toLowerCase();
  let hour = rawHour % 12;
  if (meridiem === "pm") {
    hour += 12;
  }

  return {
    hour,
    minute: match[2] ? Number(match[2]) : 0,
    timeZone: match[4]?.trim() || undefined,
    rawLabel: error.message.slice(match.index).replace(/^resets?\s+/i, "").trim(),
  };
}
