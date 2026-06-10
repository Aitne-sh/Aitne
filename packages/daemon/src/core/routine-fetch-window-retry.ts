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
   * Errors whose cause is structural rather than transient — retrying with
   * the same source data will reproduce them byte-for-byte. Today's only
   * surface:
   *
   *   - `{type:"fetch-failed", status:"permission-denied"}` — SDK Bash
   *     parser rejected the POST command (e.g., Unicode whitespace in a
   *     mail subject triggered Anthropic's `Ae6` "too-complex" gate, the
   *     SDK fell through to ask-mode, dontAsk denied). The agent will
   *     re-emit the same bytes on retry and re-trip the same gate.
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
    // status=failed normally retries (an attempt that died without
    // emitting <fetch_report> may produce one on the next try). When the
    // attempt EXPLICITLY surfaced a deterministic error (e.g. the agent
    // tried to POST, the SDK Bash preflight rejected the body, the
    // session bailed to status=failed), retry re-runs the same shape
    // and re-trips the same gate.
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
  lines.push(`  <hint>${xmlText(GENERIC_HINT_PROSE)}</hint>`);
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
