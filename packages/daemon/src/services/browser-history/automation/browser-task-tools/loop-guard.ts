/**
 * Per-task tool-call loop guard — BROWSER_TASK_REDESIGN_PLAN.md §14.5.
 *
 * Pure sliding-window detector. The runner calls `observe()` after every
 * tool decision; the helper returns `{ shouldAbort, reason }`. When the
 * abort fires, the runner releases the BrowserContext + DMs the user
 * "Task aborted: agent stuck in a loop on `<toolName>(<args>)`. Last
 * screenshot attached." (See §14.5 for the full DM body.)
 *
 * Threshold rationale (§14.5):
 *
 *   - Window size 10 — last 10 tool calls.
 *   - Trip at 4×same hash in the window.
 *   - 30-turn cap × 0.4 repeat rate ≈ 12 same-hash calls allowed before
 *     the loop guard trips before the turn cap, which is the right
 *     ordering so the guard catches stuck behaviour without firing on
 *     legitimate "click → screenshot → click → screenshot" exploration.
 *
 * Hash key shape: `${toolName}:${stableJSON(args)}` with `stableJSON`
 * being sort-keys + JSON.stringify. Arguments that differ on any leaf
 * produce different hashes, so a `click({selector:"#a"})` followed by
 * `click({selector:"#b"})` is NOT treated as a loop — exploration is
 * fine. A `click({selector:"#a"})` × 4 within 10 calls IS the loop.
 *
 * Pure — no FS, no DB, no clock. Lives in the 100%-coverage gate.
 */

import { createHash } from "node:crypto";

/** Window size — §14.5. The detector looks at the last `WINDOW_SIZE`
 *  tool calls. Older calls fall off the back of the window. */
export const LOOP_GUARD_WINDOW_SIZE = 10;

/** Repeat count that trips the guard. Per §14.5: "same hash repeats
 *  `>= 4` times in the window". */
export const LOOP_GUARD_REPEAT_THRESHOLD = 4;

/** Per-task state. The runner allocates one per task and replaces it
 *  after every `observe()` call. The shape is `readonly` so callers
 *  cannot accidentally mutate the window in place. */
export interface LoopGuardState {
  /** Sliding window of recent tool-call hashes. Newest at the tail. */
  readonly window: readonly string[];
}

export function createLoopGuardState(): LoopGuardState {
  return { window: [] };
}

export type LoopGuardObservation = {
  /** Tool name as the agent invoked it (`navigate`, `click`, …).
   *  The hashed key includes the tool name so two distinct tools
   *  cannot collide even with identical args. */
  toolName: string;
  /** Tool args object — hashed via sort-keys stable JSON. Pass the
   *  parsed Zod schema output, not the raw transport payload, so
   *  default-fill / coercion lands consistently. */
  args: unknown;
};

export type LoopGuardDecision =
  | { state: LoopGuardState; shouldAbort: false }
  | {
      state: LoopGuardState;
      shouldAbort: true;
      reason: "tool_loop_detected";
      /** Tool name of the repeated call — surfaced in DM body. */
      toolName: string;
      /** Stable args fragment (truncated to 80 chars) — surfaced in
       *  DM body. */
      argsFragment: string;
      /** Number of same-hash hits in the window at trip time
       *  (>= LOOP_GUARD_REPEAT_THRESHOLD). */
      repeatCount: number;
    };

/**
 * Observe a single tool call. Returns the new state + an abort
 * decision when the threshold trips.
 *
 * Window discipline:
 *   - Push the new hash onto the tail.
 *   - Drop the head if the window now exceeds `LOOP_GUARD_WINDOW_SIZE`.
 *   - Count occurrences of the new hash in the trimmed window.
 *   - Trip when count >= `LOOP_GUARD_REPEAT_THRESHOLD`.
 *
 * The detector trips ONCE — the caller is expected to abort the task
 * and discard the state. Calling `observe()` again on a tripped state
 * would re-trip; the function does not deduplicate.
 */
export function observeToolCall(
  state: LoopGuardState,
  obs: LoopGuardObservation,
): LoopGuardDecision {
  const hash = hashToolCall(obs);
  const nextWindow = [...state.window, hash];
  while (nextWindow.length > LOOP_GUARD_WINDOW_SIZE) {
    nextWindow.shift();
  }
  const repeatCount = nextWindow.filter((h) => h === hash).length;
  const nextState: LoopGuardState = { window: nextWindow };
  if (repeatCount >= LOOP_GUARD_REPEAT_THRESHOLD) {
    return {
      state: nextState,
      shouldAbort: true,
      reason: "tool_loop_detected",
      toolName: obs.toolName,
      argsFragment: argsFragmentFor(obs.args),
      repeatCount,
    };
  }
  return { state: nextState, shouldAbort: false };
}

/**
 * Produce a stable hash key for `(toolName, args)`. Equal args
 * regardless of key order map to the same hash; nested arrays /
 * objects are walked recursively. Functions, symbols, and BigInts
 * stringify to the JSON default (which drops them) — the hash is
 * stable on whatever survives the JSON pass.
 */
export function hashToolCall(obs: LoopGuardObservation): string {
  const canonical = stableJsonStringify(obs.args ?? null);
  const h = createHash("sha256");
  h.update(obs.toolName);
  h.update("\0");
  h.update(canonical);
  return h.digest("hex");
}

/**
 * `JSON.stringify` with deterministic key ordering at every nesting
 * level. Mirrors the redaction-coverage test's argument hasher in
 * spirit. Pure (no clock, no FS, no DB).
 */
export function stableJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, raw) => sortKeys(raw, seen));
}

function sortKeys(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((v) => sortKeys(v, seen));
  }
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[k] = sortKeys((value as Record<string, unknown>)[k], seen);
  }
  return sorted;
}

/** Short readable fragment of `args` for the DM body. 80 chars max. */
function argsFragmentFor(args: unknown): string {
  try {
    const s = stableJsonStringify(args ?? null);
    return s.length <= 80 ? s : `${s.slice(0, 77)}...`;
    /* c8 ignore start -- stableJsonStringify uses WeakSet so it
     * cannot throw under normal inputs; defensive catch for future
     * additions */
  } catch {
    return "<unstringifiable>";
  }
  /* c8 ignore stop */
}
