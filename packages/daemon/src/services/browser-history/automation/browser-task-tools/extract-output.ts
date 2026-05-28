/**
 * Pure output builder for the `extract` tool —
 * BROWSER_TASK_REDESIGN_PLAN.md §5 / §14.6.
 *
 * Given:
 *   - raw page text (extractor output BEFORE per-call clamp)
 *   - per-call `maxChars` clamp
 *   - per-task cumulative cap state
 *   - origin URL
 *
 * Produce:
 *   - the `<external-content origin="…">…</external-content>` string
 *     the runner returns to the agent
 *   - the new cumulative-cap state
 *   - the audit outcome (`ok` | `extract_cap_exceeded`)
 *   - the number of accepted characters (audit telemetry)
 *
 * The single output composer pulls together three concerns that all
 * matter for safety: per-call clamp, cumulative cap (§14.6), and
 * secret-shape redaction (`redactSecretShapes`). Keeping the
 * composition pure lets the test suite drive every combination
 * without booting a Playwright page.
 *
 * 100% coverage gate.
 */

import {
  redactSecretShapes,
  renderExternalContentTag,
} from "../external-content.js";
import {
  decideExtractCap,
  EXTRACT_PER_CALL_DEFAULT_CHARS,
  type ExtractCapState,
} from "./extract-cap.js";

export interface BuildExtractOutputInput {
  /** Raw extractor output — never wrapped, never redacted. */
  rawText: string;
  /** Per-call cap. The composer clamps `rawText.length` to this BEFORE
   *  consulting the cumulative cap. Default 8 KB per §5. */
  maxChars?: number;
  /** Per-task cumulative-cap state. The composer returns the updated
   *  state for the runner to thread back into the task. */
  capState: ExtractCapState;
  /** Origin URL — embedded in the `<external-content>` attribute so
   *  the agent (and a future auditor) can trace odd content back to a
   *  page. */
  origin: string;
}

export interface BuildExtractOutputResult {
  /** Wrapped output the tool body returns. */
  content: string;
  /** Updated cumulative-cap state. */
  capState: ExtractCapState;
  /** Number of characters of real content accepted (excluding the
   *  wrapper bytes and the cap-exceeded sentinel). */
  acceptedChars: number;
  /** Audit outcome for the action-log row. */
  outcome: "ok" | "extract_cap_exceeded";
}

/**
 * Apply the per-call clamp → cumulative-cap → secret-redaction →
 * wrap pipeline. Order matters:
 *
 *   1. Per-call clamp first — the cumulative-cap counter must reflect
 *      what we'd ACTUALLY return, not the upstream raw length.
 *   2. Cumulative cap second — when the per-task counter is saturated,
 *      we return the sentinel verbatim (no further redaction needed).
 *   3. Secret redaction third — applied to the clamped slice before
 *      wrapping so leaked tokens never reach the agent.
 *   4. `<external-content>` wrap last — the runner is the only writer
 *      of this tag and the agent's system prompt treats the body as
 *      data.
 */
export function buildExtractOutput(
  input: BuildExtractOutputInput,
): BuildExtractOutputResult {
  const perCallCap = input.maxChars ?? EXTRACT_PER_CALL_DEFAULT_CHARS;
  const safeRaw = typeof input.rawText === "string" ? input.rawText : "";
  const clamped =
    safeRaw.length > perCallCap ? safeRaw.slice(0, perCallCap) : safeRaw;

  const decision = decideExtractCap(input.capState, clamped.length);

  if (decision.kind === "cap_exceeded") {
    return {
      content: renderExternalContentTag(input.origin, decision.sentinel),
      capState: decision.state,
      acceptedChars: 0,
      outcome: "extract_cap_exceeded",
    };
  }

  // Real content path. Apply secret-shape redaction (best-effort
  // defence in depth — §8.5.1) on the clamped slice before wrapping.
  // If the cumulative cap accepts fewer chars than the clamp gave,
  // truncate to the accepted budget.
  const acceptedSlice =
    decision.acceptedChars < clamped.length
      ? clamped.slice(0, decision.acceptedChars)
      : clamped;
  const redacted = redactSecretShapes(acceptedSlice);
  return {
    content: renderExternalContentTag(input.origin, redacted),
    capState: decision.state,
    acceptedChars: decision.acceptedChars,
    outcome: "ok",
  };
}
