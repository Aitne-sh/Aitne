/**
 * Per-task cumulative extract cap — BROWSER_TASK_REDESIGN_PLAN.md §14.6.
 *
 * The `extract` tool already caps each call's output at `maxChars`
 * (default 8 KB). §14.6 adds a CUMULATIVE cap so a page that returns
 * 8 KB of attacker prose 30 times can't erode the
 * `<external-content>` wrapper's "treat as data" instruction through
 * sheer volume.
 *
 * Cap: `EXTRACT_CUMULATIVE_CAP_CHARS = 128 * 1024` (128 KB).
 *
 * Pure decision module. The runner allocates one `ExtractCapState`
 * per task and threads it through every `extract` call. When the
 * cumulative counter would exceed the cap, the helper returns the
 * sentinel string per §14.6 and `outcome='extract_cap_exceeded'` so
 * the audit row is unambiguous. The cap does NOT abort the task —
 * the model can still call `finish` with what it already has.
 *
 * 100% coverage gate per §14.12.
 */

/** §14.6 — 128 KB cumulative cap. */
export const EXTRACT_CUMULATIVE_CAP_CHARS = 128 * 1024;

/** §5 — default per-call cap (8 KB). Mirrors the tool spec. */
export const EXTRACT_PER_CALL_DEFAULT_CHARS = 8 * 1024;

/** §5 — upper bound the per-call `maxChars` arg may request. The Zod
 *  schema caps at this; the cumulative cap then runs on top. */
export const EXTRACT_PER_CALL_MAX_CHARS = 32 * 1024;

/** Per-task counter. The runner replaces the state after every
 *  successful extract; the cumulative cap helper is the only thing
 *  that mutates it. */
export interface ExtractCapState {
  readonly accumulatedChars: number;
}

export function createExtractCapState(): ExtractCapState {
  return { accumulatedChars: 0 };
}

export type ExtractCapDecision =
  | {
      kind: "ok";
      state: ExtractCapState;
      /** Number of characters the runner should actually accept into
       *  the response after the per-call cap has been applied. May be
       *  less than `requestedChars` when the request would have
       *  pushed the cumulative counter past the cap; in that case
       *  the caller clamps the output and records a normal `ok`
       *  outcome — only a HARD overflow (zero room left) returns
       *  the `cap_exceeded` sentinel. */
      acceptedChars: number;
    }
  | {
      kind: "cap_exceeded";
      state: ExtractCapState;
      /** Sentinel content body per §14.6 — wrapped by the tool body
       *  in `<external-content>` before being returned to the agent. */
      sentinel: string;
    };

/**
 * Decide how to handle a fresh extract.
 *
 * Inputs:
 *   - `state`: current per-task cumulative counter.
 *   - `requestedChars`: number of characters the tool body wants to
 *     return after the per-call `maxChars` clamp has been applied.
 *
 * Output:
 *   - `kind: 'ok'` — accepted; state advances by `acceptedChars`. The
 *     caller writes its real content (truncated to `acceptedChars` if
 *     necessary) into the `<external-content>` wrapper.
 *   - `kind: 'cap_exceeded'` — no room left; the caller returns the
 *     sentinel verbatim and writes an `outcome='extract_cap_exceeded'`
 *     audit row. State counter does NOT advance (the sentinel itself
 *     is not user data).
 */
export function decideExtractCap(
  state: ExtractCapState,
  requestedChars: number,
): ExtractCapDecision {
  if (!Number.isFinite(requestedChars) || requestedChars < 0) {
    // Defensive — a caller passing NaN or a negative would corrupt
    // the counter. Treat as zero-byte extract and return `ok` so the
    // tool body can finish its happy path.
    return { kind: "ok", state, acceptedChars: 0 };
  }
  const remaining = EXTRACT_CUMULATIVE_CAP_CHARS - state.accumulatedChars;
  if (remaining <= 0) {
    return {
      kind: "cap_exceeded",
      state,
      sentinel: renderCapExceededSentinel(state.accumulatedChars),
    };
  }
  const accepted = Math.min(Math.floor(requestedChars), remaining);
  return {
    kind: "ok",
    state: { accumulatedChars: state.accumulatedChars + accepted },
    acceptedChars: accepted,
  };
}

/**
 * The exact body the tool returns inside `<external-content>` when
 * the cumulative cap trips. Tests pin the literal so a future
 * widening cannot silently break agent-side parsing.
 */
export function renderCapExceededSentinel(accumulatedChars: number): string {
  const kb = Math.round((accumulatedChars / 1024) * 10) / 10;
  return (
    `[EXTRACT_CAP_EXCEEDED — accumulated ${kb}KB of untrusted content `
    + "in this task; further reads denied until task ends]"
  );
}
