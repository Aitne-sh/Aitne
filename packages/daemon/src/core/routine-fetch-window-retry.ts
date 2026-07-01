/**
 * Retry-policy helpers for the pre-pass fan-out coordinator.
 *
 * docs/design/appendices/pre-pass-fan-out.md §4.4 — the coordinator spawns a fresh Haiku
 * sub-session per attempt and consults `defaultRetryDecision` (or any
 * `RetryDecisionFn`) between attempts to choose whether to spawn the
 * next one. Keeping the policy as pure data (decision matrix in
 * TypeScript, not in agent prose) makes the loop deterministic,
 * testable, and free of per-model variance.
 *
 * Phase 0 ships these helpers + their unit tests. The fan-out
 * coordinator that consumes them lands in Phase 1.
 */

import type { IntegrationKey } from "@aitne/shared";
import type { SubAttemptRecord } from "./routine-fetch-window-runner.js";

// ── Public types ───────────────────────────────────────────────────────────

/**
 * One pre-pass retry chain's policy. The runner constructs this from
 * `AgentConfig.prePass*` knobs (Phase 1) and passes it through every
 * `defaultRetryDecision` call.
 */
export interface RetryPolicy {
  /** Cap on attempts per integration. Default 3 per §6 config table. */
  maxAttempts: number;
  /**
   * Backoff between attempts, indexed by attempt number minus 1.
   * Length MUST equal `maxAttempts - 1`. Default `[1000, 2000, 4000]`.
   */
  backoffMs: readonly number[];
  /** Per-integration cumulative cost cap across attempts. Default 0.60 USD. */
  perIntegrationBudgetUsd: number;
  /**
   * Optional decision override. The coordinator passes this through to
   * unit tests / fixtures; production code uses `defaultRetryDecision`.
   */
  retryOn?: RetryDecisionFn;
  /**
   * Runtime knob for the partial-with-no-post branch. Defaults to true
   * when omitted so existing tests and callers keep the §4.4 matrix.
   */
  retryOnPartial?: boolean;
}

/**
 * Decision returned by a `RetryDecisionFn`. `reason` flows into the
 * `agent_actions.detail.prePass.retryReason` field so the audit feed
 * carries a human-grokkable trail of why each attempt fired (or didn't).
 */
export interface RetryDecision {
  retry: boolean;
  /** Short, stable identifier — used in audit rows, not user-facing prose. */
  reason: string;
}

/**
 * Decision-function signature. The coordinator invokes this AFTER
 * recording the latest attempt and BEFORE applying backoff for the next
 * attempt. `priorAttempts` excludes the current `report` so callers
 * computing cumulative cost can include `report.costUsd` themselves.
 */
export type RetryDecisionFn = (
  report: SubAttemptRecord,
  attempt: number,
  policy: RetryPolicy,
  priorAttempts: readonly SubAttemptRecord[],
) => RetryDecision;

// ── Decision matrix (docs/design/appendices/pre-pass-fan-out.md §4.4) ─────────────────────

/**
 * Stable reason identifiers. Centralised so the dashboard / audit feed
 * can render them consistently and so test assertions don't drift from
 * runtime values.
 */
export const RETRY_REASONS = {
  MAX_ATTEMPTS: "max-attempts-reached",
  BUDGET_CAP: "per-integration-budget-cap",
  FLIP_LOCKED: "flip-locked",
  BUDGET_EXHAUSTED: "budget-exhausted",
  AUTH_FAILED: "auth-failed",
  FAILED_STATUS: "failed-status",
  UPSTREAM_5XX: "upstream-5xx",
  PARTIAL_NO_POST: "partial-no-post",
  /**
   * FETCH_WINDOW_TURN_LIMIT_FIX_PLAN.md P2.1 — a turn-limit kill's ONE
   * sanctioned retry. Unlike a same-envelope re-run (deterministic waste),
   * this retry re-dispatches with a ×1.5-widened `maxTurns` envelope
   * (`widenPrePassMaxTurns`), so it is materially different work: an
   * install whose real turn demand sits in the 21–30 band (or 31–45 after
   * widening) can complete on the second shot. Fires at most once per
   * chain — the second turn-limit kill (a prior attempt already carried a
   * turn-limit error) short-circuits to `DETERMINISTIC_FAILURE`.
   */
  TURN_LIMIT_WIDEN: "turn-limit-widen",
  /**
   * Errors whose cause is structural rather than transient — retrying with
   * the same source data will reproduce them byte-for-byte. Today's
   * surfaces:
   *
   *   - `{type:"fetch-failed", status:"permission-denied"}` — SDK Bash
   *     parser rejected the POST command (e.g., Unicode whitespace in a
   *     mail subject triggered Anthropic's `Ae6` "too-complex" gate, the
   *     SDK fell through to ask-mode, dontAsk denied). The agent will
   *     re-emit the same bytes on retry and re-trip the same gate.
   *
   *   - `{type:"pre-pass-failed", kind:"turn-limit"}` on a SECOND turn-limit
   *     kill — the backend's max-turns envelope killed the sub-session
   *     before the agent could emit its closing JSON line. Since P2.1 the
   *     FIRST turn-limit kill is NOT deterministic: it earns one retry
   *     under a ×1.5-widened envelope (`RETRY_REASONS.TURN_LIMIT_WIDEN`,
   *     see the failed branch of `defaultRetryDecision`). Only when the
   *     widened retry ALSO hits the cap (a prior attempt already carried a
   *     turn-limit error) does the chain deterministically stop here —
   *     further widening throws budget at a genuine runaway. Pre-P1 this
   *     class burned 3 × ~$0.19 per affected integration per tick with no
   *     widening at all.
   *
   * Distinct from `auth-failed` (401/403 — upstream credentials) and from
   * `upstream-5xx` (transient infra). Only the status=failed and
   * partial-no-post branches of rule 4 consult this — a `partial-with-
   * progress` report (`posted > 0`) already doesn't retry by rule 5, so
   * tagging it with deterministic-failure would misrepresent the audit
   * trail.
   *
   * `validation-error` is intentionally NOT in this class: per-item Zod
   * rejections from `/observations/batch` are exactly the §1.1 motivating
   * case — the agent receives `detail` in the prior-attempt-hint and can
   * correct the payload shape on retry. Classifying them as deterministic
   * would suppress that recovery path.
   */
  DETERMINISTIC_FAILURE: "deterministic-failure",
  SUCCESS: "success",
  PARTIAL_WITH_POST: "partial-with-progress",
  SKIPPED: "skipped",
  NO_PROGRESS: "no-progress",
} as const;

/**
 * Sum the cost across `priorAttempts` + the current `report`. Pure;
 * exported for unit testing the budget-cap branch in isolation.
 */
export function cumulativeAttemptCost(
  report: SubAttemptRecord,
  priorAttempts: readonly SubAttemptRecord[],
): number {
  let total = report.costUsd;
  for (const att of priorAttempts) total += att.costUsd;
  return total;
}

function isFetchFailedWithStatus(
  err: Record<string, unknown>,
  predicate: (status: number) => boolean,
): boolean {
  if (err.type !== "fetch-failed") return false;
  // `status` may arrive as number or string — MCP transports stringify
  // upstream HTTP codes inconsistently.
  const raw = err.status;
  const status = typeof raw === "number"
    ? raw
    : typeof raw === "string" && /^\d+$/.test(raw)
      ? Number.parseInt(raw, 10)
      : NaN;
  if (Number.isNaN(status)) return false;
  return predicate(status);
}

/**
 * Sentinel error-status strings the runner classifies as deterministic
 * (no point retrying — the next attempt re-emits the same bytes and
 * re-trips the same gate). The emitting side of the contract is the
 * agent profile's `fetch-failed` bullet
 * (`agent-assets/agent-profiles/routine-fetch-window.md`), which
 * instructs the agent to set `status:"permission-denied"` when its own
 * permission layer blocked a tool call; the runner interprets the
 * strings here, and any future telemetry that filters on them
 * references the same vocabulary.
 *
 * See `RETRY_REASONS.DETERMINISTIC_FAILURE` for the rationale and the
 * specific gates these sentinels are paired with — and for why
 * `validation-error` is deliberately absent (recoverable via
 * prior-attempt-hint, §1.1 motivating case).
 */
const DETERMINISTIC_FETCH_FAILED_STATUSES: ReadonlySet<string> = new Set([
  "permission-denied",
]);

/**
 * `errors[].kind` sentinel the runner stamps on the attempt record when a
 * fan-out execute throw traces back to the backend's max-turns envelope
 * (`BackendDecisiveFailure(kind="max_turns")`). Shared here — the retry
 * module owns the decision vocabulary — and consumed by the runner's
 * `failedAttemptRecord` call site so producer and matcher cannot drift.
 * See `RETRY_REASONS.TURN_LIMIT_WIDEN` / `DETERMINISTIC_FAILURE` for the
 * widen-once-then-stop policy a turn-limit kill drives
 * (FETCH_WINDOW_TURN_LIMIT_FIX_PLAN.md P1.2 + P2.1).
 */
export const TURN_LIMIT_FAILURE_KIND = "turn-limit";

function isTurnLimitError(err: Record<string, unknown>): boolean {
  return err.type === "pre-pass-failed" && err.kind === TURN_LIMIT_FAILURE_KIND;
}

// ── Dynamic turn-envelope sizing (FETCH_WINDOW_TURN_LIMIT_FIX_PLAN.md P2.1) ──

/**
 * Tunables for the per-sub-session `maxTurns` envelope. Pre-P2 every
 * fan-out sub-session inherited the same static `process_backend_config`
 * envelope (20 after P1.3) regardless of how much work its plan actually
 * implied, so a high-row install sat to the right of the reference
 * distribution and deterministically overflowed. `computePrePassMaxTurns`
 * sizes the envelope from the sub-plan's fetch-row count; the constants
 * below encode the turn budget a single fetch row consumes on the Haiku
 * lite tier.
 *
 *  - `base` — fixed startup cost independent of row count: ToolSearch
 *    schema loads for the deferred MCP tools (1+ turn each on Claude 2.1+),
 *    the reads that don't map 1:1 to a row, plus the closing JSON turn.
 *  - `perRow` — one search/fetch call + one `submit_observations` batch
 *    per `<fetch>` row in the sub-plan.
 *  - `batchAllowance` — headroom for pagination and multi-batch submits
 *    when a single window returns > `BATCH_MAX_OBSERVATIONS` items
 *    (the data-dependent tail N4 measured as `max=11` on one install).
 *  - `ceiling` — hard upper bound. The `max_budget_usd` cap ($0.50) is the
 *    real stop-loss well before this many turns of runaway matter; the cap
 *    only bounds the arithmetic so a mis-counted plan can't request 100s.
 *  - `widenFactor` — the P2.1 one-shot retry multiplier.
 */
export const PREPASS_TURN_ENVELOPE = {
  base: 8,
  perRow: 2,
  batchAllowance: 4,
  ceiling: 30,
  widenFactor: 1.5,
} as const;

/**
 * Size a sub-session's `maxTurns` from its fetch-row count. Pure.
 *
 * The DB-resolved `seedMaxTurns` (the `process_backend_config` envelope,
 * or an operator's `updated_by='user'` PUT) is the **floor** — the dynamic
 * envelope only ever ADDS headroom, never trims below what the operator
 * configured, so the P1.3 win (and any manual mitigation) is preserved.
 * The `ceiling` is likewise raised to the seed when an operator explicitly
 * configured a larger static envelope, so a `seedMaxTurns > ceiling`
 * override is honoured rather than clamped away.
 */
export function computePrePassMaxTurns(
  seedMaxTurns: number,
  fetchRowCount: number,
): number {
  const { base, perRow, batchAllowance, ceiling } = PREPASS_TURN_ENVELOPE;
  const rows = Math.max(0, Math.trunc(fetchRowCount));
  const raw = base + perRow * rows + batchAllowance;
  const effectiveCeiling = Math.max(ceiling, seedMaxTurns);
  return Math.min(Math.max(raw, seedMaxTurns), effectiveCeiling);
}

/**
 * Widen an envelope for a turn-limit kill's single sanctioned retry
 * (P2.1). ×`widenFactor`, rounded up, bounded by `widenFactor × the
 * effective ceiling` so an operator's raised seed still governs the top.
 * Pure.
 */
export function widenPrePassMaxTurns(
  previousMaxTurns: number,
  seedMaxTurns: number,
): number {
  const { widenFactor, ceiling } = PREPASS_TURN_ENVELOPE;
  const effectiveCeiling = Math.max(ceiling, seedMaxTurns);
  const widened = Math.ceil(previousMaxTurns * widenFactor);
  const cap = Math.ceil(effectiveCeiling * widenFactor);
  return Math.min(widened, cap);
}

/**
 * Deterministic-failure classifier for the `status=failed` /
 * `partial-no-post` branches. Turn-limit kills are deliberately EXCLUDED
 * here — since P2.1 they earn one widened retry, so they are classified in
 * the failed branch's dedicated turn-limit sub-branch rather than being
 * folded into the always-stop deterministic set. This function now covers
 * only the permission-denied gate, whose retry genuinely re-emits the same
 * bytes and re-trips the same SDK preflight.
 */
function isDeterministicError(err: Record<string, unknown>): boolean {
  if (err.type !== "fetch-failed") return false;
  return typeof err.status === "string"
    && DETERMINISTIC_FETCH_FAILED_STATUSES.has(err.status);
}

/**
 * Default retry policy from §4.4. Pure: decision is fully determined by
 * the inputs, no side effects, no shared state. Decision order:
 *
 *  1. Attempts cap (no retry, reason `max-attempts-reached`).
 *  2. Per-integration cumulative budget cap.
 *  3. Terminal error classes — flip-lock, budget-exhausted, auth (401/403).
 *  4. Retry-worthy outcomes — failed status, upstream 5xx, partial-no-post.
 *     Each of these branches consults `isDeterministicError` BEFORE
 *     emitting its retry decision: when the report carries a
 *     `permission-denied` error and no 5xx is present, the branch
 *     short-circuits to `deterministic-failure` instead of looping.
 *  5. Non-retry-by-default — success, partial-with-progress, skipped, no-progress.
 *
 * The motivating §1.1 failure ("Unknown name &quot;limit&quot;") lands
 * as `status="partial"` with `fetched > 0`, `posted === 0` and a
 * `fetch-failed` error — rule (4)'s `partial-no-post` branch catches it
 * and retries (the agent fixes the arg name on retry via the
 * prior-attempt-hint).
 *
 * A Unicode-whitespace-in-mail-body failure lands as `status="partial"`
 * with `posted === 0` and a `{type:"fetch-failed",
 * status:"permission-denied", message:"Bash tool blocked..."}` —
 * rule (4)'s partial-no-post branch sees the deterministic error and
 * short-circuits to `deterministic-failure` instead of burning two more
 * attempts on bytes the SDK will keep rejecting.
 */
export const defaultRetryDecision: RetryDecisionFn = (
  report,
  attempt,
  policy,
  priorAttempts,
) => {
  // (1) Attempts cap — the loop body checks this before spawning attempt N+1.
  if (attempt >= policy.maxAttempts) {
    return { retry: false, reason: RETRY_REASONS.MAX_ATTEMPTS };
  }

  // (2) Cumulative cost cap. Compare against the cost AFTER recording
  // this attempt; if it's already at/over the cap, no point retrying.
  const cumulative = cumulativeAttemptCost(report, priorAttempts);
  if (cumulative >= policy.perIntegrationBudgetUsd) {
    return { retry: false, reason: RETRY_REASONS.BUDGET_CAP };
  }

  // (3) Terminal error classes — first match wins.
  for (const err of report.errors) {
    if (err.type === "flip-locked") {
      return { retry: false, reason: RETRY_REASONS.FLIP_LOCKED };
    }
    if (err.type === "budget-exhausted") {
      return { retry: false, reason: RETRY_REASONS.BUDGET_EXHAUSTED };
    }
    if (isFetchFailedWithStatus(err, (s) => s === 401 || s === 403)) {
      return { retry: false, reason: RETRY_REASONS.AUTH_FAILED };
    }
  }

  // 5xx presence is consulted by every deterministic-failure short-
  // circuit below — if ANY error is a transient 5xx, the partial path
  // may still make progress on those items via retry, so we never
  // suppress the retry on the basis of co-present deterministic errors.
  const hasUpstream5xx = report.errors.some((err) =>
    isFetchFailedWithStatus(err, (s) => s >= 500 && s < 600),
  );

  // (4) Retry-worthy.
  if (report.status === "failed") {
    // P2.1 — a turn-limit kill is retried EXACTLY once, under a widened
    // envelope the runner applies on the next attempt (×1.5 `maxTurns`).
    // The first turn-limit therefore retries (`TURN_LIMIT_WIDEN`); a
    // second one — a PRIOR attempt already carried a turn-limit error, so
    // the widened envelope also overflowed — is a genuine runaway and
    // stops deterministically. The `!hasUpstream5xx` guard defers to the
    // 5xx-may-progress rule for the (defensive, non-production) mixed
    // report shape, matching the permission-denied branch below.
    if (!hasUpstream5xx && report.errors.some(isTurnLimitError)) {
      const priorTurnLimit = priorAttempts.some((att) =>
        att.errors.some(isTurnLimitError),
      );
      if (priorTurnLimit) {
        return { retry: false, reason: RETRY_REASONS.DETERMINISTIC_FAILURE };
      }
      return { retry: true, reason: RETRY_REASONS.TURN_LIMIT_WIDEN };
    }
    // status=failed normally retries (an attempt that died without
    // emitting <fetch_report> may produce one on the next try). When the
    // attempt EXPLICITLY surfaced a deterministic error (the SDK Bash
    // preflight rejected the POST body — kind stays permission-denied),
    // retry re-runs the same shape and re-trips the same gate.
    if (!hasUpstream5xx && report.errors.some(isDeterministicError)) {
      return { retry: false, reason: RETRY_REASONS.DETERMINISTIC_FAILURE };
    }
    return { retry: true, reason: RETRY_REASONS.FAILED_STATUS };
  }
  if (hasUpstream5xx) {
    return { retry: true, reason: RETRY_REASONS.UPSTREAM_5XX };
  }
  if (
    policy.retryOnPartial !== false
    &&
    report.status === "partial"
    && report.posted === 0
    && report.fetched > 0
  ) {
    // Deterministic partial-no-post: every item failed for the same
    // structural reason (e.g. Unicode whitespace in mail bodies trips
    // the SDK Bash preflight on every retry). Short-circuit here BEFORE
    // emitting PARTIAL_NO_POST so the audit row carries the actual
    // cause and the runner stops burning budget on guaranteed-fail
    // retries. (5xx presence already returned above, so reaching this
    // point means no transient mixed in.)
    if (report.errors.some(isDeterministicError)) {
      return { retry: false, reason: RETRY_REASONS.DETERMINISTIC_FAILURE };
    }
    return { retry: true, reason: RETRY_REASONS.PARTIAL_NO_POST };
  }

  // (5) Non-retry-by-default outcomes.
  if (report.status === "success") {
    return { retry: false, reason: RETRY_REASONS.SUCCESS };
  }
  if (report.status === "partial" && report.posted > 0) {
    return { retry: false, reason: RETRY_REASONS.PARTIAL_WITH_POST };
  }
  if (report.status === "skipped") {
    return { retry: false, reason: RETRY_REASONS.SKIPPED };
  }
  // Partial with fetched=0 and posted=0 — every fetch errored before
  // returning items. The spec's matrix doesn't list this case; default
  // to no-retry to keep the policy conservative (the §1.1 motivating
  // failure is partial-no-post WITH fetched>0, which is already caught
  // above). Operators who see this case in telemetry can override via
  // `RetryPolicy.retryOn`.
  return { retry: false, reason: RETRY_REASONS.NO_PROGRESS };
};

// ── Prior-attempt hint rendering (docs/design/appendices/pre-pass-fan-out.md §4.4) ────────

function xmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function xmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Generic MVP hint prose. §4.4 calls out the OQ-3 upgrade path
 * (schema-aware classifier that promotes the hint to a specific
 * substitution, e.g. `limit` → `maxResults`); the MVP stays generic so
 * the hint-builder is not coupled to upstream argument-name schemas
 * that drift independently.
 */
const GENERIC_HINT_PROSE
  = "The previous attempt's call returned the error above. Re-read the partial body and try a different argument shape — the partial is the source of truth for tool argument names, not your memory of prior calls.";

/**
 * FETCH_WINDOW_TURN_LIMIT_FIX_PLAN.md P2.1 — hint prose for a prior attempt
 * killed by the max-turns envelope. The generic argument-shape prose is
 * actively wrong for this class (§1 step 7 of the plan: argument shapes are
 * irrelevant to a turn-budget overflow); what the single widened retry needs
 * is turn compression, so the hint mirrors the task-flow's "Turn efficiency"
 * vocabulary (P3.1). The retry runs under a ×1.5-widened cap and is the last
 * sanctioned attempt — a second overflow stops the chain deterministically.
 */
const TURN_LIMIT_HINT_PROSE
  = "The previous attempt was killed by the platform's maximum-turns cap before it could finish — a turn-budget overflow, not a tool-argument problem. This retry runs under a widened cap and is the final attempt, so spend turns sparingly: load every needed tool schema in ONE ToolSearch call, issue independent fetch calls together in the same turn, never fetch per-item detail the list response already carries, and submit observations in as few batches as possible.";

function pickFirstError(
  errors: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  return errors.length > 0 ? errors[0] : undefined;
}

function renderErrorChild(err: Record<string, unknown>): string {
  const type = typeof err.type === "string" ? err.type : "unknown";
  // Surface every string/number attribute (other than `type`) so the
  // motivating §1.1 case carries `status="400"` and `message="…"`
  // verbatim into the next attempt's prompt.
  const attrEntries = Object.entries(err).filter(
    ([k, v]) => k !== "type" && (typeof v === "string" || typeof v === "number"),
  );
  const attrs = attrEntries
    .map(([k, v]) => `${xmlAttr(k)}="${xmlAttr(String(v))}"`)
    .join(" ");
  const tagName = xmlAttr(type.replace(/-/g, "_"));
  return `<${tagName}${attrs ? " " + attrs : ""} />`;
}

function renderOnePriorAttempt(
  record: SubAttemptRecord,
  integrationKey: IntegrationKey | undefined,
): string {
  const openParts = [`attempt="${record.attempt}"`];
  if (integrationKey !== undefined) {
    openParts.push(`integration="${xmlAttr(integrationKey)}"`);
  }
  const lines = [`<prior_attempt_error ${openParts.join(" ")}>`];
  const firstErr = pickFirstError(record.errors);
  if (firstErr) {
    lines.push(`  ${renderErrorChild(firstErr)}`);
  } else if (record.parseError) {
    lines.push(
      `  <parse_failed reason="${xmlAttr(record.parseError)}" />`,
    );
  } else {
    // The attempt was retried but carried neither an explicit error nor
    // a parseError — likely a coordinator-side timeout or quota error
    // logged as a generic failed-status. Surface that explicitly so the
    // model knows *something* went wrong, not just that retry was
    // selected silently.
    lines.push(`  <failed status="${xmlAttr(record.status)}" />`);
  }
  // P2.1 — a turn-limit prior attempt gets the turn-compression hint; the
  // argument-shape prose would misdirect the widened retry (the error was
  // never about tool arguments). Keyed off the SAME error the block renders
  // so hint and evidence cannot disagree.
  const hintProse = firstErr && isTurnLimitError(firstErr)
    ? TURN_LIMIT_HINT_PROSE
    : GENERIC_HINT_PROSE;
  lines.push(`  <hint>${xmlText(hintProse)}</hint>`);
  lines.push("</prior_attempt_error>");
  return lines.join("\n");
}

/**
 * Render the `<prior_attempt_error>` block sequence injected into a
 * sub-session's prompt on attempt > 1. Returns the empty string when
 * `attempts` is empty so callers can unconditionally concatenate the
 * result.
 *
 * **Ordering.** Newest first — attempt N (most recent) appears before
 * attempt N-1, etc. The model reads the most-recent failure top of
 * page; deeper history is context-only.
 */
export function buildPriorAttemptHintBlock(
  attempts: readonly SubAttemptRecord[],
  integrationKey?: IntegrationKey,
): string {
  if (attempts.length === 0) return "";
  const newestFirst = [...attempts].reverse();
  return newestFirst
    .map((att) => renderOnePriorAttempt(att, integrationKey))
    .join("\n");
}
