/**
 * Purchase tokens — pure helpers for the Phase B-4 single-use,
 * 5-minute-TTL DM confirmation flow.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17 / §13 step 50.
 *
 * Mirrors the structural pattern of `approval-tokens.ts` (B-3) but
 * with three category-defining differences:
 *
 *   1. The token is a server-side opaque NONCE keyed to a DB row that
 *      carries every scope field (workflow_invocation_id, site_key,
 *      url_pattern, max_amount_minor, currency, delivered channels,
 *      deadline). Validation is therefore a DB lookup — NOT a
 *      cryptographic verify. HMAC adds no defence under the B-4 threat
 *      model: if the daemon is compromised the attacker controls both
 *      the HMAC key and the validator. See §17.2.
 *
 *   2. The token's literal shape is `!~<8 base32 chars>` — 40 bits of
 *      entropy. Lower than B-3's 128 bits because (a) the token has to
 *      be human-typeable in a DM and (b) the 5-min TTL combined with
 *      per-channel rate-limiting makes online brute-force infeasible.
 *      The `!~` literal prefix is what the messaging adapter's incoming
 *      classifier pattern-matches against; the prefix also serves as
 *      the structural anti-spoofing marker for the outbound classifier.
 *
 *   3. There is NO `mint` for the LLM — the agent CANNOT call this
 *      module. Tokens are issued by `purchase-handler.issueToken()`
 *      only, which the runner invokes mid-workflow AFTER the pre-
 *      confirm screenshot. The agent's only role is `confirmCartCheckout`'s
 *      input (`expectedMaxAmountMinor`, `currency`, `notesForUser`).
 *
 * Pure — no FS, no DB, no clock. Lives in the 100%-coverage gate.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  B4_TOKEN_BASE32_ALPHABET,
  B4_TOKEN_PREFIX,
  B4_TOKEN_REGEX,
  B4_TOKEN_TAIL_LENGTH,
  B4_TOKEN_TTL_MS,
} from "../managed-chromium/types.js";

/**
 * Reserved structural markers used by `purchase-handler` when it sends
 * the DM confirmation request via `sendSystemMessage`. The outbound
 * classifier (`classifyPurchaseConfirmationTemplate`) refuses any
 * agent-tool-originated outbound message that contains ANY of these
 * markers — they are daemon-only. This is what makes the consent flow
 * structurally unforgable from the LLM side: the agent cannot send a
 * fake "Aitne purchase confirmation" DM via any of its tools, because
 * the marker would trip the classifier before the adapter dispatches.
 *
 * Plan §17.7 specifies the marker set verbatim; the constants here are
 * the authoritative source the classifier and the template renderer
 * both read.
 */
export const PURCHASE_CONFIRMATION_TEMPLATE_MARKERS = Object.freeze([
  "Aitne purchase confirmation",
  "[purchase-verify:",
  "Approved on ",
] as const);

/** Header line that opens every daemon-emitted purchase-confirmation
 *  DM. The classifier matches the substring case-insensitively so a
 *  rendering tweak (e.g. wrapping the lock emoji in different unicode)
 *  cannot let an agent-tool message slip past. */
export const PURCHASE_CONFIRMATION_HEADER =
  "Aitne purchase confirmation";

/**
 * Mint the random 8-char base32 tail of a fresh purchase token. The
 * caller is responsible for prefixing with `!~` (use
 * `formatPurchaseToken`). Uses Node's CSPRNG — never `Math.random`.
 *
 * Bias note: 256 ÷ 32 = 8 exactly, so masking the low 5 bits of each
 * byte produces a uniform distribution over the base32 alphabet
 * without rejection sampling. This is the same construction the
 * Node base32-cli family uses; verified against §17.2's spec.
 */
export function mintPurchaseTokenTail(): string {
  const bytes = randomBytes(B4_TOKEN_TAIL_LENGTH);
  let out = "";
  for (let i = 0; i < B4_TOKEN_TAIL_LENGTH; i++) {
    out += B4_TOKEN_BASE32_ALPHABET[bytes[i] & 0x1f];
  }
  return out;
}

/** Compose a full canonical `!~xxxxxxxx` token from a freshly minted
 *  tail. The two-step shape exists so callers that only have the tail
 *  (e.g. dashboard log lines that redact to `…<tail>`) do not duplicate
 *  the prefix-construction logic. */
export function formatPurchaseToken(tail: string): string {
  if (tail.length !== B4_TOKEN_TAIL_LENGTH) {
    throw new Error(
      `formatPurchaseToken: tail must be exactly ${B4_TOKEN_TAIL_LENGTH} chars`,
    );
  }
  if (!/^[A-Z2-7]+$/.test(tail)) {
    throw new Error("formatPurchaseToken: tail must be base32 [A-Z2-7]");
  }
  return `${B4_TOKEN_PREFIX}${tail}`;
}

/**
 * Mint a fresh purchase token (prefix included). Convenience wrapper
 * around `mintPurchaseTokenTail` + `formatPurchaseToken`.
 *
 * The result is the raw `!~xxxxxxxx` string. The caller (the purchase
 * handler) inserts it into the DB row and delivers via DM. Never log
 * the raw token — `redactToken()` is the dashboard-safe form.
 */
export function mintPurchaseToken(): string {
  return formatPurchaseToken(mintPurchaseTokenTail());
}

/**
 * Compute the expiry timestamp for a freshly-minted token given
 * `nowMs`. Pure so the handler / store / tests agree on the deadline
 * arithmetic.
 */
export function computePurchaseExpiry(nowMs: number): number {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new Error(
      "computePurchaseExpiry: nowMs must be a non-negative finite number",
    );
  }
  return nowMs + B4_TOKEN_TTL_MS;
}

/**
 * Trim and pattern-match a candidate body against the canonical token
 * regex. Returns the matched token on success, null on miss — the
 * caller never reaches the DB on a miss, so the round-trip cost stays
 * proportional to the matched-token rate.
 *
 * The trim is required because messaging adapters routinely deliver
 * messages with leading/trailing whitespace (Slack collapses newlines,
 * WhatsApp keeps them).
 */
export function parsePurchaseToken(body: string): string | null {
  if (typeof body !== "string") return null;
  const trimmed = body.trim();
  if (!B4_TOKEN_REGEX.test(trimmed)) return null;
  return trimmed;
}

/** Pure SHA-256 hex of the inbound message body. Used as
 *  `browser_automation_purchase_replies.message_body_hash` so the audit
 *  trail can detect duplicate / replayed replies without persisting the
 *  raw token. The hash domain is "the entire message body the adapter
 *  received" — NOT "the parsed token" — so a hash collision between two
 *  reply attempts proves the same exact body was sent twice, which is
 *  the property the dashboard's replay-analysis view needs. */
export function hashReplyBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** Constant-time comparison on two opaque strings of equal length.
 *  Used by the consume-time CAS to defend against timing-leak attacks
 *  where an attacker submits guesses and measures response time to
 *  bisect the correct token. */
export function purchaseTokenEquals(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Redact a token for log / DM surfaces — never log the raw form.
 *  The shape is `!~****<last3>` so an operator scanning logs can match
 *  a recently-DMed token by the trailing 3 chars without reconstructing
 *  the secret. */
export function redactToken(token: string): string {
  if (typeof token !== "string" || token.length < 5) return "<redacted>";
  return `${token.slice(0, 2)}****${token.slice(-3)}`;
}

/** Persisted view of a purchase-token row — the subset the validation
 *  classifier needs to read. Keeps the pure validator decoupled from
 *  the full DB row shape (which includes screenshot paths and the
 *  delivered-channels JSON blob the store hydrates separately). */
export interface PurchaseTokenRowView {
  jti: string;
  token: string | null;
  workflowInvocationId: string;
  siteKey: string;
  status: "pending" | "confirmed" | "cancelled" | "expired";
  issuedAt: number;
  expiresAt: number;
  consumedAt: number | null;
  cancelledAt: number | null;
  /** Parsed `delivered_channels` JSON — see plan §17.3 "delivered_to_channels". */
  deliveredChannels: readonly string[];
}

/**
 * Decision tree for an inbound `!~xxxxxxxx`-shaped reply. Categorical
 * outcomes used by the messaging adapter's incoming hook + the audit
 * row. Pure — the caller (store + handler) is responsible for the
 * atomic CAS that flips the row to `consumed`; this function returns
 * the decision without any side effects so it can be exhaustively
 * tested.
 *
 * Order of checks matters for the reply-surface user sees:
 *   1. shape   — body is not `!~[A-Z2-7]{8}`
 *   2. lookup  — no row with `token = candidate`
 *   3. already consumed → `already_consumed`
 *   4. cancelled → `already_cancelled`
 *   5. expired (status pending + expires_at passed)
 *   6. channel mismatch → `wrong_channel` (treated as suspicious leak)
 *   7. happy path → `consume`
 *
 * The runner-side CAS adds the atomic `consumed_at IS NULL` predicate
 * on top so two simultaneous replies on different channels cannot
 * both consume the same token.
 */
export type PurchaseReplyDecision =
  | { kind: "shape_invalid" }
  | { kind: "no_match" }
  | { kind: "already_consumed"; row: PurchaseTokenRowView }
  | { kind: "already_cancelled"; row: PurchaseTokenRowView }
  | { kind: "expired"; row: PurchaseTokenRowView }
  | { kind: "wrong_channel"; row: PurchaseTokenRowView }
  | { kind: "consume"; row: PurchaseTokenRowView };

export function classifyPurchaseReply(input: {
  body: string;
  channelRef: string;
  row: PurchaseTokenRowView | null;
  nowMs: number;
}): PurchaseReplyDecision {
  const parsed = parsePurchaseToken(input.body);
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

/**
 * Predicate for the supervisor's orphan sweep — given a row from the
 * tokens table and the current wall clock, does the row need to be
 * flipped to `expired` and its Chromium SIGKILLed? Pure so the sweep
 * + the route layer + the tests share one source of truth.
 */
export function isPurchaseExpired(
  row: Pick<PurchaseTokenRowView, "status" | "expiresAt" | "consumedAt" | "cancelledAt">,
  nowMs: number,
): boolean {
  if (row.status !== "pending") return false;
  if (row.consumedAt !== null || row.cancelledAt !== null) return false;
  return nowMs > row.expiresAt;
}

/**
 * `classifyPurchaseTokenEcho` — absolute-block layer classifier for the
 * agent-tool surface. Matches any argument containing the `!~[A-Z2-7]{8}`
 * shape, regardless of position. The PreToolUse hook + the
 * `disallowedTools` glob list use this to deny tool invocations whose
 * args carry a live (or stale) purchase token — defence-in-depth so
 * that even a buggy messaging adapter that accidentally surfaces the
 * raw `!~` string to the LLM cannot have it round-trip back into a
 * tool call.
 *
 * The classifier is intentionally regex-only: it never reads the DB.
 * A false positive (an agent legitimately writing `!~ABCDEFGH` in some
 * other context) blocks one tool call — the cost is minimal. The cost
 * of a false negative is the LLM successfully echoing a live token,
 * which §17.7 explicitly defends against.
 */
const PURCHASE_TOKEN_EMBED_PATTERN = /!~[A-Z2-7]{8}/;

export interface PurchaseTokenEchoMatch {
  /** Redacted shape — `!~****<last3>` — recorded in the audit row. The
   *  raw match is NEVER persisted; only the redacted form. */
  redacted: string;
}

export function classifyPurchaseTokenEcho(
  rawArg: string | undefined,
): PurchaseTokenEchoMatch | null {
  if (typeof rawArg !== "string" || rawArg.length === 0) return null;
  const m = PURCHASE_TOKEN_EMBED_PATTERN.exec(rawArg);
  if (!m) return null;
  return { redacted: redactToken(m[0]) };
}

/**
 * `classifyPurchaseConfirmationTemplate` — outbound classifier applied
 * to every agent-tool-originated outbound message. Rejects any payload
 * containing one of the §17.7 reserved structural markers. Daemon-side
 * code that legitimately needs to emit a confirmation template
 * (`purchase-handler.sendPurchaseRequestDM()`) does so via
 * `sendSystemMessage(credential, ...)`, which the agent tools cannot
 * mint. The classifier therefore enforces the rule structurally — the
 * agent literally cannot send a fake confirmation message.
 *
 * Pure regex-based scan. The marker set is closed (Object.freeze) so a
 * dashboard tweak that introduces a new marker has to land here too,
 * surfacing as an obvious one-line edit.
 *
 * Case-insensitive — a buggy LLM might lowercase the header by accident
 * and we still want to refuse. The literal `[purchase-verify:` marker
 * carries its own case sensitivity floor (the bracket plus colon are
 * not paraphrasable).
 */
export interface PurchaseConfirmationTemplateMatch {
  marker: (typeof PURCHASE_CONFIRMATION_TEMPLATE_MARKERS)[number];
}

export function classifyPurchaseConfirmationTemplate(
  outbound: string | undefined,
): PurchaseConfirmationTemplateMatch | null {
  if (typeof outbound !== "string" || outbound.length === 0) return null;
  const lc = outbound.toLowerCase();
  for (const marker of PURCHASE_CONFIRMATION_TEMPLATE_MARKERS) {
    if (lc.includes(marker.toLowerCase())) return { marker };
  }
  return null;
}

/** Pattern for the `!verify <8-char>` slash command (§17.7). The
 *  messaging adapter pattern-matches inbound on this BEFORE routing to
 *  the DM agent; on match, the adapter looks up the pending token by
 *  tail and replies with the structured legitimacy message. */
export const VERIFY_SLASH_REGEX = /^!verify\s+([A-Z2-7]{8})\s*$/;

/** Pattern for `!cancel-purchase` slash. On match the adapter routes
 *  to the purchase handler, which cancels every pending token whose
 *  `delivered_channels` contains the inbound channel. */
export const CANCEL_PURCHASE_SLASH_REGEX = /^!cancel-purchase\b/;

/** Parsed shape of a `!verify <tail>` invocation. */
export interface VerifySlashParse {
  /** The 8-char base32 tail. The handler concatenates `!~` + tail
   *  back to the canonical token shape for the DB lookup. */
  tail: string;
}

/** Pure parser — returns the tail on shape match, null otherwise. */
export function parseVerifySlash(body: string): VerifySlashParse | null {
  if (typeof body !== "string") return null;
  const m = VERIFY_SLASH_REGEX.exec(body.trim());
  if (!m) return null;
  return { tail: m[1] };
}

/** Pure predicate for `!cancel-purchase`. */
export function isCancelPurchaseSlash(body: string): boolean {
  if (typeof body !== "string") return false;
  return CANCEL_PURCHASE_SLASH_REGEX.test(body.trim());
}

/**
 * Top-level adapter-side classifier — categorical decision for an
 * inbound message body. The messaging adapter (Discord, Slack, …)
 * calls this BEFORE routing the message to the DM agent. On any non-
 * `passthrough` outcome the adapter handles directly (the inbound
 * is NEVER forwarded to the LLM) and the inbound is recorded on the
 * `_replies` audit table.
 *
 * Order of dispatch:
 *   1. `!verify <8-char>` → verify
 *   2. `!cancel-purchase` → cancel
 *   3. `!~[A-Z2-7]{8}` exact-line → token reply
 *   4. anything else → passthrough (the DM agent sees the message)
 *
 * This guard layer is the structural anti-spoofing barrier described
 * in §17.7 — even a buggy adapter that accidentally lets a token
 * reach the LLM is defended by `classifyPurchaseTokenEcho`
 * (PreToolUse) and `classifyPurchaseConfirmationTemplate` (outbound).
 */
export type AdapterInboundClassification =
  | { kind: "verify"; tail: string }
  | { kind: "cancel_purchase" }
  | { kind: "token_reply"; token: string }
  | { kind: "passthrough" };

export function classifyAdapterInbound(body: string): AdapterInboundClassification {
  const verify = parseVerifySlash(body);
  if (verify) return { kind: "verify", tail: verify.tail };
  if (isCancelPurchaseSlash(body)) return { kind: "cancel_purchase" };
  const tok = parsePurchaseToken(body);
  if (tok !== null) return { kind: "token_reply", token: tok };
  return { kind: "passthrough" };
}
