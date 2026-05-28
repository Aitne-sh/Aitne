/**
 * Lite-final-confirm tokens — pure helpers for the browser-task
 * single-use, 5-minute-TTL DM confirmation flow.
 *
 * BROWSER_TASK_REDESIGN_PLAN.md §5 ("Final-confirm tokens are NOT B-4
 * purchase tokens") / §14.11 / §13 testing table.
 *
 * The shape and lifecycle mirror `purchase-tokens.ts` deliberately —
 * both surfaces emit `!~xxxxxxxx` strings on the same primary channels,
 * and the messaging adapter's `jti`-prefix dispatcher (§14.11 Q#6) fans
 * a single inbound to whichever handler holds the matching token. The
 * structural separation lives at:
 *
 *  - DB table (`browser_task_final_confirm_tokens` vs.
 *    `browser_automation_purchase_tokens`)
 *  - Handler (`final-confirm-handler.ts` vs. `purchase-handler.ts`)
 *  - DM template (a future "Aitne confirmation required" marker, kept
 *    distinct from B-4's "Aitne purchase confirmation" so the outbound
 *    guard's marker set in `purchase-tokens.ts` does not overlap)
 *
 * Pure — no FS, no DB, no clock. Lives in the 100%-coverage gate. The
 * shape constants (`B4_TOKEN_*`) come from `managed-chromium/types.ts`
 * — those are not B-4-specific despite the historical naming, they are
 * the shared `!~xxxxxxxx` envelope every Aitne single-use DM token
 * uses.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  B4_TOKEN_BASE32_ALPHABET,
  B4_TOKEN_PREFIX,
  B4_TOKEN_REGEX,
  B4_TOKEN_TAIL_LENGTH,
  B4_TOKEN_TTL_MS,
} from "../managed-chromium/types.js";

/** Mint the random 8-char base32 tail of a fresh lite-final-confirm
 *  token. Same construction as `purchase-tokens.mintPurchaseTokenTail`
 *  — uniform distribution via `& 0x1f` masking (256 ÷ 32 = 8 exactly,
 *  no rejection sampling needed). Pure (CSPRNG via node:crypto). */
export function mintLiteFinalConfirmTokenTail(): string {
  const bytes = randomBytes(B4_TOKEN_TAIL_LENGTH);
  let out = "";
  for (let i = 0; i < B4_TOKEN_TAIL_LENGTH; i++) {
    out += B4_TOKEN_BASE32_ALPHABET[bytes[i] & 0x1f];
  }
  return out;
}

/** Compose `!~xxxxxxxx` from a freshly minted tail. */
export function formatLiteFinalConfirmToken(tail: string): string {
  if (tail.length !== B4_TOKEN_TAIL_LENGTH) {
    throw new Error(
      `formatLiteFinalConfirmToken: tail must be exactly ${B4_TOKEN_TAIL_LENGTH} chars`,
    );
  }
  if (!/^[A-Z2-7]+$/.test(tail)) {
    throw new Error(
      "formatLiteFinalConfirmToken: tail must be base32 [A-Z2-7]",
    );
  }
  return `${B4_TOKEN_PREFIX}${tail}`;
}

/** Mint a fresh canonical token (prefix included). */
export function mintLiteFinalConfirmToken(): string {
  return formatLiteFinalConfirmToken(mintLiteFinalConfirmTokenTail());
}

/** Compute the expiry timestamp for a freshly-minted token given
 *  `nowMs`. */
export function computeLiteFinalConfirmExpiry(nowMs: number): number {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new Error(
      "computeLiteFinalConfirmExpiry: nowMs must be a non-negative finite number",
    );
  }
  return nowMs + B4_TOKEN_TTL_MS;
}

/** Pattern-match a body against the canonical token regex. Same shape
 *  as `purchase-tokens.parsePurchaseToken`. The messaging adapter's
 *  inbound classifier calls BOTH parsers and routes by jti prefix
 *  when both produce a match (the regex is identical so a match on
 *  one implies a match on the other; the dispatcher then queries each
 *  store and routes to whichever returns a row). */
export function parseLiteFinalConfirmToken(body: string): string | null {
  if (typeof body !== "string") return null;
  const trimmed = body.trim();
  if (!B4_TOKEN_REGEX.test(trimmed)) return null;
  return trimmed;
}

/** Pure SHA-256 hex of the inbound message body, for the audit-trail
 *  hash that joins replies to tokens without persisting the raw
 *  string. Same shape as B-4 `hashReplyBody`. */
export function hashReplyBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** Constant-time string equality for the consume-time CAS. */
export function liteFinalConfirmTokenEquals(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Redact a token for log / DM surfaces — never log the raw form. */
export function redactToken(token: string): string {
  if (typeof token !== "string" || token.length < 5) return "<redacted>";
  return `${token.slice(0, 2)}****${token.slice(-3)}`;
}

/** Persisted view used by the classifier — the subset of the DB row
 *  the pure decision tree reads. Decoupled from the full DB-row shape
 *  so a future column add does not require classifier changes. */
export interface LiteFinalConfirmTokenRowView {
  jti: string;
  token: string | null;
  taskId: string;
  status: "pending" | "confirmed" | "cancelled" | "expired";
  issuedAt: number;
  expiresAt: number;
  consumedAt: number | null;
  cancelledAt: number | null;
  deliveredChannels: readonly string[];
}

/** Decision tree for an inbound `!~xxxxxxxx`-shaped reply. Same shape
 *  as `classifyPurchaseReply`. Pure — the caller (store + handler) is
 *  responsible for the atomic CAS that flips the row to `consumed`. */
export type LiteFinalConfirmReplyDecision =
  | { kind: "shape_invalid" }
  | { kind: "no_match" }
  | { kind: "already_consumed"; row: LiteFinalConfirmTokenRowView }
  | { kind: "already_cancelled"; row: LiteFinalConfirmTokenRowView }
  | { kind: "expired"; row: LiteFinalConfirmTokenRowView }
  | { kind: "wrong_channel"; row: LiteFinalConfirmTokenRowView }
  | { kind: "consume"; row: LiteFinalConfirmTokenRowView };

export function classifyLiteFinalConfirmReply(input: {
  body: string;
  channelRef: string;
  row: LiteFinalConfirmTokenRowView | null;
  nowMs: number;
}): LiteFinalConfirmReplyDecision {
  const parsed = parseLiteFinalConfirmToken(input.body);
  if (parsed === null) return { kind: "shape_invalid" };
  if (!input.row) return { kind: "no_match" };
  if (input.row.consumedAt !== null) {
    return { kind: "already_consumed", row: input.row };
  }
  if (input.row.cancelledAt !== null || input.row.status === "cancelled") {
    return { kind: "already_cancelled", row: input.row };
  }
  if (input.row.status === "expired" || input.nowMs > input.row.expiresAt) {
    return { kind: "expired", row: input.row };
  }
  if (!input.row.deliveredChannels.includes(input.channelRef)) {
    return { kind: "wrong_channel", row: input.row };
  }
  return { kind: "consume", row: input.row };
}

/** Predicate for the supervisor's orphan sweep — given a row's
 *  status/expiry/consume/cancel timestamps and the current wall clock,
 *  is the row a candidate for `expired` transition? */
export function isLiteFinalConfirmExpired(
  row: Pick<
    LiteFinalConfirmTokenRowView,
    "status" | "expiresAt" | "consumedAt" | "cancelledAt"
  >,
  nowMs: number,
): boolean {
  if (row.status !== "pending") return false;
  if (row.consumedAt !== null || row.cancelledAt !== null) return false;
  return nowMs > row.expiresAt;
}
