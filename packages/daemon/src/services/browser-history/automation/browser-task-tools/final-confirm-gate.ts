/**
 * Final-confirm gate heuristic — BROWSER_TASK_REDESIGN_PLAN.md §5.
 *
 * Pure decision: given the description of a click / press_key target,
 * does the runner need to interpose a `!~xxxxxxxx` lite-final-confirm
 * round-trip before the activation materialises?
 *
 * The gate trips when `requireFinalConfirm === true` AND any of:
 *
 *   (a) The element is a `<button type="submit">` or
 *       `<input type="submit">`.
 *   (b) The element is inside a `<form>` AND the activation submits it
 *       (button without explicit `type`, or `Enter` keypress in any
 *        form field).
 *   (c) The element's role is `button` AND its visible text or
 *       `aria-label` matches an "irreversible action" vocabulary —
 *       English + Japanese covered at minimum.
 *
 * Legs (a) and (b) are STRUCTURAL — they reflect what the browser
 * would do without intervention. Leg (c) is HEURISTIC — site authors
 * choose any label they want. We keep the regex narrow enough that a
 * benign "Sign in" / "Confirm phone number" sequence does not pop a
 * token on every step, while still catching "Post", "Submit", "Buy",
 * "Confirm", "Publish" and their JP counterparts.
 *
 * The shape the runner passes is a `FinalConfirmGateInput` — pure JSON,
 * built by the tool body from a Playwright `ElementHandle` snapshot.
 * Keeping the decision pure means the I/O-bound tool implementations
 * can stay thin and the gate's regex / form-submit logic earns 100%
 * coverage in a peer test.
 *
 * Per the plan §14.10 "Hardcoded button-text denylist for every click
 * was REJECTED" — we deliberately scope leg (c) to vocabulary that
 * implies a commit / publish / send. A button labelled "Sign in" or
 * "Continue" passes the gate freely.
 */

/**
 * Input shape consumed by `decideFinalConfirmGate`. The runner builds
 * this from the live element snapshot; the gate decision is a pure
 * function of the snapshot.
 */
export interface FinalConfirmGateInput {
  /** Source of the activation — distinguishes "click" from "Enter
   *  press" semantics so the runner can apply the form-Enter rule
   *  only to keyboard input. */
  trigger: "click" | "press_key";
  /** For `press_key`: the literal key name. Only "Enter" trips the
   *  form-submit rule. */
  key?: string;
  /** Tag name of the focused element (`button`, `input`, `a`,
   *  `textarea`, …). Lower-case is assumed. */
  tagName: string;
  /** ARIA role of the focused element. `null` when none declared. */
  role: string | null;
  /** `type` attribute for buttons / inputs (`submit`, `button`,
   *  `reset`, `text`, `checkbox`, …). `null` when unset. */
  type: string | null;
  /** True when the element is inside a `<form>` ancestor. Drives the
   *  form-submit detection. */
  insideForm: boolean;
  /** Visible text content of the element, normalised (trimmed,
   *  collapsed whitespace). Used by leg (c). */
  visibleText: string;
  /** `aria-label` attribute value, normalised. Used by leg (c). */
  ariaLabel: string | null;
}

export type FinalConfirmGateDecision =
  | { trip: false }
  | {
      trip: true;
      /** Which leg fired — surfaced in the audit row so dashboards can
       *  show "structural submit" vs. "label heuristic" without
       *  guessing. */
      reason: "submit_button" | "form_submit_enter" | "form_submit_click" | "action_vocab";
      /** Normalised text/label that matched leg (c), or the activation
       *  description for legs (a) / (b). Surfaced in the DM body. */
      matched: string;
    };

/**
 * English-only "irreversible action" vocabulary. The gate is otherwise
 * locale-blind — the rest of the heuristic (form submit detection,
 * role=button + insideForm tightening) handles non-English UIs through
 * structural shape, not button text.
 *
 * Tests pin the exact pattern source so a future widening cannot silently
 * break a fixture.
 *
 * Vocab selection rationale (resolves F12 from the Phase 2 review):
 *
 *   - **Spec baseline (§5):** `post|submit|send|buy|confirm|publish` +
 *     `reserve|book`. These are the irreversible commit actions the
 *     original design pinned. `reserve` and `book` cover the booking-
 *     flow surface (travel / restaurant / appointment) that would
 *     otherwise rely on `confirm`.
 *   - **Added — destructive-by-name (low false-positive):** `delete`.
 *     Deleting a post / account / record is irreversible and the word
 *     almost never appears on benign UI controls in a non-destructive
 *     sense; gating it costs one extra DM token on true destructive
 *     flows but practically never on incidental clicks.
 *   - **Added — narrow compound:** `cancel order`. Order-cancellation
 *     UIs are destructive (no easy undo, may incur fees, may cancel a
 *     ship-already-in-progress). The 2-word literal means "cancel
 *     dialog" / "cancel filter" / standalone "cancel" do NOT trip —
 *     only the specific irreversible action does.
 *   - **Deliberately NOT added — `remove`:** UI buttons read "Remove
 *     filter", "Remove from cart", "Remove tag" — all reversible.
 *     Adding `remove` would fire the gate on every cart edit, which
 *     §14.10's "Hardcoded button-text denylist for every click" trade-
 *     off rejected for exactly this reason.
 *   - **Deliberately NOT added — `place order`:** commit-money flow
 *     blocked at the `payment-path-blocker.ts` layer (path regex on
 *     `/checkout`, `/buy`, `/place-order`). The gate is redundant with
 *     the structural block and would fire on the legitimate cart-view
 *     button (the actual checkout URL is the one denied, not the click).
 *
 * Non-English UIs: covered by the structural legs (a) submit-button
 * tag-shape and (b) Enter-in-form-field — both of which fire regardless
 * of the visible label. Adding locale-specific vocabulary back into the
 * regex requires the same "low false-positive on benign UI" judgment
 * applied above. Prior revisions enumerated Japanese verbs here; the
 * 2026-05-27 revision removed them so the framework no longer bakes
 * any single non-English locale's vocabulary into the safety floor
 * (`feedback_no_jp_special_no_hardcoded_domains`).
 */
export const ACTION_VOCAB_REGEX: RegExp =
  /post|submit|send|buy|reserve|book|confirm|publish|delete|cancel order/i;

/** Tag names whose default activation submits an enclosing form when
 *  `type` is unset / `type='submit'`. Lower-case is assumed. */
const FORM_SUBMITTING_TAGS = new Set(["button"]);

/** Pure gate decision. Returns `{trip:false}` when no rule fires;
 *  otherwise the structured trip reason + the matched fragment for
 *  audit / DM body. */
export function decideFinalConfirmGate(
  input: FinalConfirmGateInput,
): FinalConfirmGateDecision {
  // Leg (a): structural submit. <button type="submit"> or <input type="submit">.
  if (
    (input.tagName === "button" || input.tagName === "input")
    && input.type === "submit"
  ) {
    return {
      trip: true,
      reason: "submit_button",
      matched: deriveLabelForAudit(input) || "<submit>",
    };
  }
  // Leg (b1): Enter inside a form. Any form field would submit on Enter
  // unless the page swallows the event — fail closed.
  if (
    input.trigger === "press_key"
    && (input.key ?? "").toLowerCase() === "enter"
    && input.insideForm
  ) {
    return {
      trip: true,
      reason: "form_submit_enter",
      matched: deriveLabelForAudit(input) || "<form Enter>",
    };
  }
  // Leg (b2): click on a <button> with no explicit type inside a form
  // (HTML default is type="submit"). `type="button"` opts out.
  if (
    input.trigger === "click"
    && FORM_SUBMITTING_TAGS.has(input.tagName)
    && input.insideForm
    && (input.type === null || input.type === "submit")
  ) {
    return {
      trip: true,
      reason: "form_submit_click",
      matched: deriveLabelForAudit(input) || "<form button>",
    };
  }
  // Leg (c): role-button with action-vocab visible text or aria-label.
  // Active for both click and press_key — Space/Enter on a role=button
  // commits the same way a click does.
  const looksLikeButton =
    input.role === "button"
    || input.tagName === "button"
    || (input.tagName === "a" && input.role === "button");
  if (looksLikeButton) {
    const text = (input.visibleText || "").trim();
    const aria = (input.ariaLabel || "").trim();
    const haystack = aria.length > 0 ? `${text} ${aria}` : text;
    if (haystack.length > 0 && ACTION_VOCAB_REGEX.test(haystack)) {
      return {
        trip: true,
        reason: "action_vocab",
        matched: (aria.length > 0 ? aria : text).slice(0, 80),
      };
    }
  }
  return { trip: false };
}

/** Surface a short label for the audit row / DM body. Prefers
 *  aria-label, falls back to visible text, finally to empty. */
function deriveLabelForAudit(input: FinalConfirmGateInput): string {
  if (input.ariaLabel && input.ariaLabel.trim().length > 0) {
    return input.ariaLabel.trim().slice(0, 80);
  }
  return (input.visibleText || "").trim().slice(0, 80);
}
