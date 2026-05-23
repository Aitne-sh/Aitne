/**
 * Approval tokens — pure helpers for the Phase B-3 single-use,
 * 5-min-TTL approval flow.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §10 / §13 step 43.
 *
 * The flow:
 *
 *   1. Agent (or scheduler) calls `POST /workflows/:name` without a
 *      token. Runner inserts a `pending` row into
 *      `browser_automation_approvals` and returns
 *      `{ status: "needs_approval", approvalId, expiresAt }`.
 *
 *   2. Dashboard surfaces the pending row. User clicks Approve →
 *      dashboard hits `POST /approvals/:id/approve`. Daemon
 *      `mintApprovalToken()`s a 32-hex-char (128 bit) token, stores
 *      `sha256(token)` in `token_hash`, flips the row to `approved`,
 *      and returns the raw token in the response body **exactly once**.
 *
 *   3. Agent retries `POST /workflows/:name` with `approvalToken`.
 *      Runner re-hashes the supplied token via `hashApprovalToken()`
 *      and atomically CAS-consumes the row (`approved` → `consumed`)
 *      WHERE `token_hash` matches AND `expires_at > now` AND
 *      `workflow_name` matches AND `params_hash` matches. Any
 *      mismatch surfaces as `approval_token_invalid` or
 *      `approval_expired`.
 *
 * Pure — no FS, no DB, no clock. Time is injected; the caller (the DB
 * store) holds the side-effects. Lives in the 100%-coverage gate.
 *
 * Why hash-at-rest: a read-only DB exfiltration attacker cannot use a
 * stolen `token_hash` to invoke a workflow — the runner requires the
 * pre-image, which only the dashboard's bearer'd HTTP response of the
 * approve handler ever held. The retention sweep rotates `token_hash`
 * to NULL once `consumed_at` or `denied_at` plus 1 day has elapsed so
 * not even the hash lingers.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 5-minute TTL for every B-3 approval. Plan §10 specifies "5-minute
 *  TTL" verbatim; the dashboard's pending panel shows the countdown
 *  computed from this constant. */
export const APPROVAL_TTL_MS = 5 * 60 * 1000;

/** 16 bytes = 32 hex chars = 128 bits of entropy. Plan §13 step 43
 *  specifies "single-use, 5-min TTL, scoped per workflow". 128 bits
 *  comfortably exceeds the entropy needed for a 5-min window even
 *  under continuous brute force. */
export const APPROVAL_TOKEN_BYTES = 16;

/** Anchored shape used by both the issuance path (sanity-check the
 *  minted output) and the validation path (reject malformed user
 *  input before any DB lookup). Matches the
 *  `browserAutomationApprovalTokenSchema` regex in the shared
 *  package — keep them in lockstep. */
export const APPROVAL_TOKEN_REGEX = /^[0-9a-f]{32}$/;

/**
 * Mint a fresh approval token. Uses Node's CSPRNG — never `Math.random`.
 * Returns the raw token (hex string); the caller must immediately hash
 * it via `hashApprovalToken()` for persistence and surface the raw
 * value in its HTTP response exactly once.
 */
export function mintApprovalToken(): string {
  return randomBytes(APPROVAL_TOKEN_BYTES).toString("hex");
}

/**
 * Hash a token for at-rest storage. SHA-256 hex. The choice of SHA-256
 * over bcrypt/argon is deliberate — these tokens have 128 bits of
 * entropy each, so a fast pre-image search is computationally
 * infeasible (~2^127 hashes) regardless of hash speed, and the 5-min
 * TTL caps the window for any attempt. Salt is unnecessary for the
 * same reason: with full entropy, salt only defends against rainbow
 * tables, which are useless against a per-token-unique random.
 */
export function hashApprovalToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Pure, constant-time equality check on two hex hashes. Defends
 *  against timing-leak attacks where an attacker submits guesses and
 *  measures response time to bisect the correct hash. */
export function tokenHashEquals(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  // Buffer.from on hex throws on odd-length / invalid input; guard
  // with the regex first so timingSafeEqual receives clean inputs.
  // After this check + matching length, the byte buffers also match
  // length — no further size guard needed.
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/**
 * Compute the expiry timestamp for a freshly-minted approval given
 * `nowMs`. Exposed as a pure helper so the runner / store / tests
 * agree on the deadline arithmetic.
 */
export function computeApprovalExpiry(nowMs: number): number {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new Error("computeApprovalExpiry: nowMs must be a non-negative finite number");
  }
  return nowMs + APPROVAL_TTL_MS;
}

/** Lightweight view of the row needed by `classifyApprovalValidation`.
 *  Mirrors the persisted shape but omits anything the validator does
 *  not need to read (params_summary, origin, audit timestamps). */
export interface ApprovalRowView {
  id: string;
  workflowName: string;
  paramsHash: string;
  status: "pending" | "approved" | "consumed" | "denied" | "expired";
  expiresAt: number;
  tokenHash: string | null;
}

export type ApprovalValidationOutcome =
  | { ok: true; row: ApprovalRowView }
  | { ok: false; reason: "token_shape_invalid" }
  | { ok: false; reason: "row_not_found" }
  | { ok: false; reason: "wrong_status"; actualStatus: ApprovalRowView["status"] }
  | { ok: false; reason: "expired" }
  | { ok: false; reason: "workflow_mismatch" }
  | { ok: false; reason: "params_mismatch" }
  | { ok: false; reason: "hash_mismatch" };

/**
 * Categorise a token-redemption attempt against a fetched row. Pure —
 * the caller (DB store) is responsible for the atomic CAS that
 * actually flips the row to `consumed`; this function returns the
 * decision tree without any side effects so it can be tested
 * exhaustively.
 *
 * Order of checks matters for the LLM-facing surface: shape → row
 * presence → status → expiry → workflow/params binding → token-hash
 * compare. The runner folds (`row_not_found`, `wrong_status`,
 * `workflow_mismatch`, `params_mismatch`, `hash_mismatch`) into a
 * single `approval_token_invalid` outcome so timing-based
 * discrimination between failure modes does not leak via outcome
 * strings; categorical detail lives in the audit row only. `expired`
 * is its own outcome so the dashboard can give the user a clear
 * "request a new approval" prompt.
 */
export function classifyApprovalValidation(input: {
  token: string;
  expectedWorkflowName: string;
  expectedParamsHash: string;
  row: ApprovalRowView | null;
  nowMs: number;
}): ApprovalValidationOutcome {
  if (!APPROVAL_TOKEN_REGEX.test(input.token)) {
    return { ok: false, reason: "token_shape_invalid" };
  }
  if (!input.row) {
    return { ok: false, reason: "row_not_found" };
  }
  if (input.row.status !== "approved") {
    return {
      ok: false,
      reason: "wrong_status",
      actualStatus: input.row.status,
    };
  }
  if (input.nowMs > input.row.expiresAt) {
    return { ok: false, reason: "expired" };
  }
  if (input.row.workflowName !== input.expectedWorkflowName) {
    return { ok: false, reason: "workflow_mismatch" };
  }
  if (input.row.paramsHash !== input.expectedParamsHash) {
    return { ok: false, reason: "params_mismatch" };
  }
  if (!input.row.tokenHash) {
    return { ok: false, reason: "hash_mismatch" };
  }
  const computed = hashApprovalToken(input.token);
  if (!tokenHashEquals(computed, input.row.tokenHash)) {
    return { ok: false, reason: "hash_mismatch" };
  }
  return { ok: true, row: input.row };
}

/**
 * Decision for a pending row given the wall clock. A pending row whose
 * `expires_at` has passed should be flipped to `expired` by the
 * retention sweep — exposed as a pure predicate so the sweep + the
 * runner + the tests share one source of truth.
 */
export function isApprovalExpired(
  row: Pick<ApprovalRowView, "status" | "expiresAt">,
  nowMs: number,
): boolean {
  if (row.status === "consumed" || row.status === "denied" || row.status === "expired") {
    return false;
  }
  return nowMs > row.expiresAt;
}
