/**
 * DM-token router — BROWSER_TASK_REDESIGN_PLAN.md §14.11 Q#6.
 *
 * Pure decision module shared between the messaging adapter's inbound
 * `!~xxxxxxxx` classifier and any future programmatic caller that
 * needs to know "given a token reply, which handler owns it?".
 *
 * Two stores share the `!~xxxxxxxx` envelope on the same primary
 * channels:
 *
 *  - B-4 purchase tokens (`browser_automation_purchase_tokens`)
 *  - lite-final-confirm tokens (`browser_task_final_confirm_tokens`)
 *
 * Both jtis are uuid v4 so a colliding-raw-string match is bounded by
 * uuid uniqueness — but the surface still has to deterministically
 * resolve the rare case where both stores return a row for the same
 * raw inbound. This module's `decideTokenReplyRoute` is the single
 * source of truth for that decision:
 *
 *   - exactly one row → route to that handler
 *   - both rows present → older `issuedAt` wins (deterministic;
 *     prevents the surface from oscillating between handlers on retries)
 *   - neither → `none` (caller fans strict-cancel-on-non-token-reply
 *     to both handlers if wired)
 *
 * Pure — no DB, no clock. 100% covered per §13 testing table extension.
 */

/** The minimal row shape the router needs from either store. Both
 *  `PurchaseTokenRow` and `LiteFinalConfirmTokenRow` carry these fields
 *  with identical semantics so the router can read either. */
export interface TokenIssueRowView {
  issuedAt: number;
}

export type TokenReplyRoute =
  | { kind: "none" }
  | { kind: "purchase" }
  | { kind: "lite_final_confirm" };

/**
 * Decide which handler should consume an inbound `!~xxxxxxxx` reply.
 *
 * The caller passes the result of `purchaseHandler.lookupByRaw(token)`
 * and `finalConfirmHandler.lookupByRaw(token)` (either may be null when
 * the corresponding handler isn't wired OR when the store has no
 * matching row). The router does NOT call into either store — it is
 * pure decision logic over the two views.
 *
 * Tie-break: when both rows exist, prefer the older `issuedAt`. If the
 * two are tied to the millisecond (cosmically unlikely), prefer
 * `purchase` — picking a stable left-hand side keeps the decision
 * reproducible without an external nonce.
 */
export function decideTokenReplyRoute(input: {
  purchaseRow: TokenIssueRowView | null;
  liteRow: TokenIssueRowView | null;
}): TokenReplyRoute {
  const { purchaseRow, liteRow } = input;
  if (!purchaseRow && !liteRow) return { kind: "none" };
  if (purchaseRow && !liteRow) return { kind: "purchase" };
  if (liteRow && !purchaseRow) return { kind: "lite_final_confirm" };
  // Both present — deterministic tie-break by oldest issuance, with
  // `purchase` winning a hard tie (both rows would represent a
  // sub-millisecond collision on a 40-bit shared token space — already
  // implausible; the rule preserves replayability for the case it
  // happens anyway).
  return purchaseRow!.issuedAt <= liteRow!.issuedAt
    ? { kind: "purchase" }
    : { kind: "lite_final_confirm" };
}
