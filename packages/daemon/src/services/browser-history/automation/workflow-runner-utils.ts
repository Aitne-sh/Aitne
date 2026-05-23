/**
 * Pure orchestration helpers for the workflow runner.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §8.4.
 *
 * The runner threads inputs through a fixed pipeline:
 *   1. Lookup workflow by name → 404 / unknown_workflow
 *   2. Zod-parse `params` → input_validation_error
 *   3. URL allowlist regex check (workflow-declared) → url_not_allowlisted
 *   4. eTLD+1 extract → user_allowlist_blocked / host_not_extractable
 *   5. Concurrency slot → rate_limited
 *   6. Spawn Playwright → playwright_launch_timeout / playwright_error
 *   7. run() (with per-workflow timeout) → timeout / playwright_error / success
 *   8. Zod-parse output → output_validation_error
 *   9. Wrap taggedUntrusted fields with `<external-content>` tags
 *  10. Persist audit row + return result
 *
 * Each step is small enough to extract into a pure function tested in
 * isolation. The orchestration shell (`workflow-runner.ts`) is the I/O
 * glue — it imports these helpers, holds the concurrency slot, calls
 * the Playwright-attached run(), and persists the audit row.
 *
 * Separating concerns keeps the safety-critical decision tree
 * (deny-on-unknown allowlist, URL regex check, host extraction) in the
 * coverage-locked set while the FS/SDK orchestration matches the
 * existing dispatcher-* exclusion rationale.
 */

import { createHash } from "node:crypto";

import {
  APPROVAL_TOKEN_REGEX,
  classifyApprovalValidation,
  type ApprovalRowView,
  type ApprovalValidationOutcome,
} from "./approval-tokens.js";
import { extractEtldPlusOne } from "./egress-denylist.js";
import {
  classifyPaymentPath,
  type PaymentPathBlockMatch,
} from "./payment-path-blocker.js";
import {
  getSite,
  isAllowlistSubsetOfSitePattern,
  isSiteConnectionFresh,
  type SiteDefinition,
} from "./site-registry.js";
import { RiskTier } from "../../../safety/risk-classifier.js";
import type { WorkflowDefinition, WorkflowRunResult } from "./types.js";

/** Hash the workflow's input params so the dashboard's Recent Automations
 *  panel can de-duplicate runs without persisting raw user-influenced
 *  text. SHA-256 truncated to 16 hex chars is plenty of collision space
 *  for the bounded number of params shapes per workflow. */
export function hashParams(params: unknown): string {
  let serialised: string;
  try {
    serialised = JSON.stringify(params);
  } catch {
    serialised = String(params);
  }
  return createHash("sha256").update(serialised).digest("hex").slice(0, 16);
}

/** Input-side Zod parse. Returns the typed value on success, or the
 *  short-circuit `input_validation_error` result the runner can hand
 *  straight back. */
export function validateWorkflowInput<T>(
  def: WorkflowDefinition<T, unknown>,
  workflowId: string,
  params: unknown,
):
  | { ok: true; value: T }
  | { ok: false; result: Extract<WorkflowRunResult, { status: "input_validation_error" }> } {
  const parsed = def.inputSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      result: {
        status: "input_validation_error",
        workflowId,
        validationErrors: parsed.error.flatten(),
      },
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Extract the primary network URL from the validated params. Probes the
 * recognised field names in declaration-priority order:
 *
 *   url > targetUrl > searchUrl > urls[0]
 *
 * Returns null when no URL-shaped field is present — the runner then
 * skips both the payment-path block and the URL+host allowlist steps.
 * That null path is reserved for workflows that genuinely do not touch
 * the network at the schema boundary (the auth-variant
 * `getAmazonPurchaseHistory` derives its target from `siteKey`, not
 * from params); a workflow that hits the network MUST carry one of
 * these field names so the payment-path block (B-3 hard exclusion per
 * §10) runs.
 *
 * `searchUrl` is the field name used by `searchAndAddToPersonalNotes`;
 * adding it here was load-bearing — without it the payment-path block
 * (which checks `/checkout`, `/buy`, …) is silently bypassed for that
 * workflow even though it declares Approve tier.
 */
export function extractPrimaryUrlFromParams(params: unknown): string | null {
  if (typeof params !== "object" || params === null) return null;
  const obj = params as Record<string, unknown>;
  if (typeof obj.url === "string") return obj.url;
  if (typeof obj.targetUrl === "string") return obj.targetUrl;
  if (typeof obj.searchUrl === "string") return obj.searchUrl;
  if (Array.isArray(obj.urls) && typeof obj.urls[0] === "string") {
    return obj.urls[0];
  }
  return null;
}

/** Decision for step 3 (per-workflow URL allowlist) + step 4 (user
 *  domain allowlist + host extraction). Pure — the runner provides the
 *  user-allowlist read function. */
export function checkUrlAndHostAllowlist(
  def: Pick<WorkflowDefinition, "allowlistRegex">,
  url: string,
  isHostAllowed: (host: string) => boolean,
): { ok: true; host: string }
  | { ok: false; status: "url_not_allowlisted"; detail: { url: string } }
  | { ok: false; status: "user_allowlist_blocked"; detail: { host: string } }
  | { ok: false; status: "host_not_extractable" } {
  if (!def.allowlistRegex.test(url)) {
    return {
      ok: false,
      status: "url_not_allowlisted",
      detail: { url },
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, status: "host_not_extractable" };
  }
  const host = extractEtldPlusOne(parsed.hostname);
  if (!host) {
    return { ok: false, status: "host_not_extractable" };
  }
  if (!isHostAllowed(host)) {
    return {
      ok: false,
      status: "user_allowlist_blocked",
      detail: { host },
    };
  }
  return { ok: true, host };
}

/**
 * Output-side Zod parse. Returns either the parsed value (typed-loose
 * for the runner's downstream `wrapTaggedUntrusted` walk) or the
 * `output_validation_error` short-circuit.
 */
export function validateWorkflowOutput<T>(
  def: WorkflowDefinition<unknown, T>,
  workflowId: string,
  output: unknown,
):
  | { ok: true; value: T }
  | {
      ok: false;
      result: Extract<WorkflowRunResult, { status: "output_validation_error" }>;
    } {
  const parsed = def.outputSchema.safeParse(output);
  if (!parsed.success) {
    return {
      ok: false,
      result: {
        status: "output_validation_error",
        workflowId,
        validationErrors: parsed.error.flatten(),
      },
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Promise.race against a deadline that throws a structured timeout
 * error rather than rejecting with a generic message — the runner
 * branches on the marker to set the outcome to `timeout`.
 *
 * Exported so the orchestrator's tests can exercise the timeout
 * branch without needing real Playwright.
 */
export class WorkflowTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`workflow exceeded ${timeoutMs}ms`);
    this.name = "WorkflowTimeoutError";
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new WorkflowTimeoutError(timeoutMs));
    }, timeoutMs);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Classify a thrown error from inside `run()` into the runner's two
 * failure outcomes. Timeouts (via `WorkflowTimeoutError`) get the
 * dedicated `timeout` status; everything else folds into
 * `playwright_error` with a short, redacted reason.
 *
 * The reason string is capped at 200 chars to keep the audit row
 * compact and avoid leaking the full Playwright internal stack (which
 * sometimes embeds URL fragments). The cap is also why workflows that
 * need richer diagnostics should record into the trace store, not into
 * the throw message.
 */
export function classifyRunFailure(
  err: unknown,
  workflowId: string,
):
  | Extract<WorkflowRunResult, { status: "timeout" }>
  | Extract<WorkflowRunResult, { status: "playwright_error" }> {
  if (err instanceof WorkflowTimeoutError) {
    return { status: "timeout", workflowId };
  }
  const raw = err instanceof Error ? err.message : String(err);
  const reason = raw.slice(0, 200);
  return {
    status: "playwright_error",
    workflowId,
    detail: { reason },
  };
}

/**
 * Promise-chain semaphore — enforces the "1 Instance A globally" cap
 * (plan §8.1 / parent §18.7). Each call returns a Promise that resolves
 * once the previous holder calls `release`; the caller MUST await it
 * before doing real work, and MUST invoke the returned release fn
 * exactly once (in a `finally`) so the next caller in the FIFO chain
 * unblocks.
 *
 * The chain pointer is closed-over module state on the consumer side
 * (`workflow-runner.ts` keeps a `let slot = Promise.resolve()`); this
 * helper performs the chain swap atomically so two concurrent
 * `acquire()` calls cannot both see the same `current` and end up
 * racing past it. Returning the pair `{ wait, release }` instead of a
 * single Promise lets the caller short-circuit on cancellation while
 * still releasing the slot — the previous shape (synchronously
 * returning a release fn without ever exposing the `wait` promise)
 * silently dropped serialisation because nothing awaited the chain.
 */
export interface SemaphoreAcquire {
  /** Promise that resolves when this caller owns the slot. AWAIT before
   *  the critical section. */
  wait: Promise<void>;
  /** Release the slot — invoke exactly once after the critical section,
   *  even on error. Idempotent: a second call is a no-op. */
  release: () => void;
}

/**
 * Pure resolver for the auth-variant site_not_connected gate
 * (§16.4). Combines:
 *   - `getSite(siteKey)` registry lookup — returns
 *     `unknown_site` when the workflow declares a siteKey absent from
 *     the frozen registry. This is a daemon-boot invariant; if the
 *     registry validation passed at module load, every shipping
 *     workflow's siteKey resolves. The branch exists for tests + the
 *     forward path where a future workflow ships before its site
 *     entry lands in the same PR.
 *   - allowlistRegex ⊆ site.allowedHostPattern subset check (§16.4).
 *     The registry test enforces this for shipping workflows; the
 *     runtime check is defence-in-depth so a mistyped registry entry
 *     does not silently widen the network surface.
 *   - persistent connection row presence + freshness against the
 *     site's `sessionMaxAgeDays`.
 *
 * Pure — takes raw inputs and an injected `connection` reader so it
 * lives in the 100%-covered set without dragging in a DB handle.
 */
export type AuthSiteGateResolution =
  | { ok: true; site: SiteDefinition }
  | {
      ok: false;
      status: "unknown_site" | "allowlist_not_subset" | "site_not_connected";
      siteKey: string;
    };

export function resolveAuthSiteGate(input: {
  siteKey: string;
  allowlistRegex: RegExp;
  connection: { connectedAt: number; lastWorkflowAt: number | null } | null;
  nowMs: number;
}): AuthSiteGateResolution {
  const site = getSite(input.siteKey);
  if (!site) {
    return { ok: false, status: "unknown_site", siteKey: input.siteKey };
  }
  if (!isAllowlistSubsetOfSitePattern(input.allowlistRegex, site.allowedHostPattern)) {
    return {
      ok: false,
      status: "allowlist_not_subset",
      siteKey: input.siteKey,
    };
  }
  if (!input.connection) {
    return { ok: false, status: "site_not_connected", siteKey: input.siteKey };
  }
  if (!isSiteConnectionFresh(site, input.connection.connectedAt, input.nowMs)) {
    return { ok: false, status: "site_not_connected", siteKey: input.siteKey };
  }
  return { ok: true, site };
}

/**
 * Pure payment-path gate. Returns the matched category when the
 * workflow's primary URL is a payment surface that B-3 cannot reach
 * (even with a valid approval token), or null when the URL is safe.
 *
 * The runner short-circuits with `payment_path_blocked` on any match.
 * Variant exception: `variant === "purchase"` workflows bypass this
 * gate entirely — those ship via B-4 with the DM-token gate.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §10 / §13 step 46.
 */
export function checkPaymentPathBlock(
  def: Pick<WorkflowDefinition, "variant">,
  url: string,
): PaymentPathBlockMatch | null {
  if (def.variant === "purchase") return null;
  return classifyPaymentPath(url);
}

/**
 * Pure resolver for the B-3 approval gate. Determines whether a
 * workflow needs an approval token, and if a token was supplied,
 * whether it validates against the persisted approved row.
 *
 * The runner reads the approval row by `findApprovedRowByTokenHash`
 * (DB-side) and the I/O wrapper passes the result here for the
 * categorical decision. Pure so the decision tree is testable without
 * a live DB.
 *
 * Returns:
 *   - `not_required` when the workflow is not Approve-tier OR is the
 *     B-4 purchase variant (B-4 uses its own DM-token gate, not this).
 *   - `missing_token` when the workflow requires approval and no token
 *     was supplied — the runner creates a fresh pending row and
 *     returns `needs_approval` upstream.
 *   - `validation_failed` (with the inner classification) when a token
 *     was supplied but rejected.
 *   - `validated` (with the matching row view) when the token validates
 *     and the runner should atomically CAS-consume.
 */
export type ApprovalGateResolution =
  | { kind: "not_required" }
  | { kind: "missing_token" }
  | { kind: "validation_failed"; failure: Extract<ApprovalValidationOutcome, { ok: false }> }
  | { kind: "validated"; row: ApprovalRowView };

export function resolveApprovalGate(input: {
  workflowDef: Pick<WorkflowDefinition, "riskTier" | "variant" | "name">;
  workflowName: string;
  paramsHash: string;
  approvalToken: string | undefined;
  row: ApprovalRowView | null;
  nowMs: number;
}): ApprovalGateResolution {
  // B-4 purchase variant carries its own DM-token gate; do not double-
  // gate it here. The runner already short-circuits the purchase
  // variant before reaching this resolver, but be defensive.
  if (input.workflowDef.variant === "purchase") {
    return { kind: "not_required" };
  }
  if (input.workflowDef.riskTier !== RiskTier.Approve) {
    return { kind: "not_required" };
  }
  if (input.approvalToken === undefined) {
    return { kind: "missing_token" };
  }
  if (!APPROVAL_TOKEN_REGEX.test(input.approvalToken)) {
    return {
      kind: "validation_failed",
      failure: { ok: false, reason: "token_shape_invalid" },
    };
  }
  const outcome = classifyApprovalValidation({
    token: input.approvalToken,
    expectedWorkflowName: input.workflowName,
    expectedParamsHash: input.paramsHash,
    row: input.row,
    nowMs: input.nowMs,
  });
  if (outcome.ok) {
    return { kind: "validated", row: outcome.row };
  }
  return { kind: "validation_failed", failure: outcome };
}

/**
 * Map the validation failure detail into the runner's wire-level
 * outcome. The runner folds every non-expiry failure mode
 * (`row_not_found`, `wrong_status`, `workflow_mismatch`,
 * `params_mismatch`, `hash_mismatch`, `token_shape_invalid`) into
 * `approval_token_invalid` so timing-based discrimination across
 * failure types cannot leak via outcome strings — categorical detail
 * lives in the audit row only.
 */
export function validationFailureToOutcome(
  failure: Extract<ApprovalValidationOutcome, { ok: false }>,
): "approval_expired" | "approval_token_invalid" {
  return failure.reason === "expired" ? "approval_expired" : "approval_token_invalid";
}

export function acquireSemaphoreSlot(
  currentSlot: Promise<unknown>,
): { acquire: SemaphoreAcquire; nextSlot: Promise<unknown> } {
  let releaseFn!: () => void;
  let released = false;
  const heldUntil = new Promise<void>((resolve) => {
    releaseFn = () => {
      if (released) return;
      released = true;
      resolve();
    };
  });
  // The next caller's `wait` chains off `heldUntil`, so the FIFO order
  // is: prior slot's heldUntil → this caller can start → this caller's
  // heldUntil → next caller can start. `currentSlot.catch(() => {})`
  // swallows rejections from prior holders so one buggy workflow does
  // not poison the chain for everyone behind it.
  const wait = currentSlot.then(
    () => undefined,
    () => undefined,
  );
  const nextSlot = wait.then(() => heldUntil);
  return {
    acquire: { wait, release: releaseFn },
    nextSlot,
  };
}
