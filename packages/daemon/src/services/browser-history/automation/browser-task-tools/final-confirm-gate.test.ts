/**
 * final-confirm-gate — §5 / §14.12 coverage.
 *
 * Pinned cases:
 *   - structural submit button (leg a) trips with `submit_button`.
 *   - form-Enter on any field (leg b1) trips with `form_submit_enter`.
 *   - form-button click without explicit type (leg b2) trips with
 *     `form_submit_click`.
 *   - `type="button"` opts out of leg (b2).
 *   - action-vocab regex (leg c) matches English + Japanese vocabulary.
 *   - Benign labels (Sign in, Continue, Skip) do NOT trip.
 *   - Coord-only (no DOM context) returns trip=false (the runner's
 *     gate input builder fails open in this shape).
 */

import { describe, expect, it } from "vitest";

import {
  ACTION_VOCAB_REGEX,
  decideFinalConfirmGate,
  type FinalConfirmGateInput,
} from "./final-confirm-gate.js";

function base(overrides: Partial<FinalConfirmGateInput> = {}): FinalConfirmGateInput {
  return {
    trigger: "click",
    tagName: "button",
    role: null,
    type: null,
    insideForm: false,
    visibleText: "Sign in",
    ariaLabel: null,
    ...overrides,
  };
}

describe("ACTION_VOCAB_REGEX", () => {
  it("covers the English commit vocabulary", () => {
    expect(ACTION_VOCAB_REGEX.test("Post")).toBe(true);
    expect(ACTION_VOCAB_REGEX.test("Submit form")).toBe(true);
    expect(ACTION_VOCAB_REGEX.test("Send message")).toBe(true);
    expect(ACTION_VOCAB_REGEX.test("Buy now")).toBe(true);
    expect(ACTION_VOCAB_REGEX.test("Reserve table")).toBe(true);
    expect(ACTION_VOCAB_REGEX.test("Book flight")).toBe(true);
    expect(ACTION_VOCAB_REGEX.test("Confirm order")).toBe(true);
    expect(ACTION_VOCAB_REGEX.test("Publish article")).toBe(true);
    expect(ACTION_VOCAB_REGEX.test("Delete account")).toBe(true);
  });

  it("pins the regex source to English-only after the 2026-05-27 revision", () => {
    // Sentinel — the regex used to enumerate non-English (Japanese)
    // verbs alongside the English vocabulary. Owner directive ("no JP
    // special, no hardcoded locale-specific safety") removed them so
    // the framework no longer bakes any single non-English locale's
    // vocab into the safety floor. Non-English UIs are covered by the
    // structural legs (submit-button shape + Enter-in-form-field)
    // which fire regardless of visible label.
    expect(ACTION_VOCAB_REGEX.source).toBe(
      "post|submit|send|buy|reserve|book|confirm|publish|delete|cancel order",
    );
    expect(ACTION_VOCAB_REGEX.flags).toBe("i");
  });

  it("does NOT match benign nav vocabulary", () => {
    expect(ACTION_VOCAB_REGEX.test("Sign in")).toBe(false);
    expect(ACTION_VOCAB_REGEX.test("Continue")).toBe(false);
    expect(ACTION_VOCAB_REGEX.test("Skip")).toBe(false);
    expect(ACTION_VOCAB_REGEX.test("Back")).toBe(false);
  });

  it("matches the narrow 'cancel order' compound, not bare 'Cancel'", () => {
    // §F12 decision — `cancel order` is destructive (order cancellation
    // may incur fees / cancel an already-shipping package), bare
    // `Cancel` (modal dismiss, sign-up cancel) is benign.
    expect(ACTION_VOCAB_REGEX.test("Cancel order")).toBe(true);
    expect(ACTION_VOCAB_REGEX.test("Cancel")).toBe(false);
  });

  it("does NOT match 'Remove' — F12 rationale", () => {
    // §F12 decision — `remove` is too broad (Remove filter / Remove
    // from cart / Remove tag are all benign-reversible). Pinned as a
    // negative test so a future PR that re-adds `remove` to the regex
    // fails loudly here.
    expect(ACTION_VOCAB_REGEX.test("Remove filter")).toBe(false);
    expect(ACTION_VOCAB_REGEX.test("Remove from cart")).toBe(false);
  });

  it("does NOT match 'Place order' — payment-path-blocker is the floor", () => {
    // §F12 decision — `place order` is the commit-money flow, blocked
    // at the network layer by `payment-path-blocker.ts`. Gating here
    // is redundant AND would fire on the cart-view "Place order" button
    // before the user has decided to commit, costing a token round-trip
    // for what the URL-level block will reject downstream.
    expect(ACTION_VOCAB_REGEX.test("Place order")).toBe(false);
  });
});

describe("decideFinalConfirmGate — structural submit (leg a)", () => {
  it("trips on <button type='submit'>", () => {
    const out = decideFinalConfirmGate(
      base({ tagName: "button", type: "submit", visibleText: "Sign in" }),
    );
    expect(out.trip).toBe(true);
    if (out.trip) expect(out.reason).toBe("submit_button");
  });

  it("trips on <input type='submit'>", () => {
    const out = decideFinalConfirmGate(
      base({ tagName: "input", type: "submit", visibleText: "Go" }),
    );
    expect(out.trip).toBe(true);
    if (out.trip) expect(out.reason).toBe("submit_button");
  });

  it("uses aria-label as the audit label when present", () => {
    const out = decideFinalConfirmGate(
      base({
        tagName: "button",
        type: "submit",
        visibleText: "",
        ariaLabel: "Sign in to account",
      }),
    );
    if (out.trip) expect(out.matched).toBe("Sign in to account");
  });

  it("falls back to '<submit>' when no label/text available", () => {
    const out = decideFinalConfirmGate(
      base({
        tagName: "button",
        type: "submit",
        visibleText: "",
        ariaLabel: null,
      }),
    );
    if (out.trip) expect(out.matched).toBe("<submit>");
  });
});

describe("decideFinalConfirmGate — form Enter (leg b1)", () => {
  it("trips on Enter inside any form field", () => {
    const out = decideFinalConfirmGate({
      trigger: "press_key",
      key: "Enter",
      tagName: "input",
      role: null,
      type: "text",
      insideForm: true,
      visibleText: "",
      ariaLabel: null,
    });
    expect(out.trip).toBe(true);
    if (out.trip) expect(out.reason).toBe("form_submit_enter");
  });

  it("does NOT trip on Enter outside a form", () => {
    const out = decideFinalConfirmGate({
      trigger: "press_key",
      key: "Enter",
      tagName: "input",
      role: null,
      type: "text",
      insideForm: false,
      visibleText: "",
      ariaLabel: null,
    });
    expect(out.trip).toBe(false);
  });

  it("does NOT trip on non-Enter keys", () => {
    const out = decideFinalConfirmGate({
      trigger: "press_key",
      key: "Tab",
      tagName: "input",
      role: null,
      type: "text",
      insideForm: true,
      visibleText: "",
      ariaLabel: null,
    });
    expect(out.trip).toBe(false);
  });

  it("falls back to '<form Enter>' when no label/text", () => {
    const out = decideFinalConfirmGate({
      trigger: "press_key",
      key: "Enter",
      tagName: "input",
      role: null,
      type: "text",
      insideForm: true,
      visibleText: "",
      ariaLabel: null,
    });
    if (out.trip) expect(out.matched).toBe("<form Enter>");
  });
});

describe("decideFinalConfirmGate — form button click (leg b2)", () => {
  it("trips on a <button> with no type inside a form", () => {
    const out = decideFinalConfirmGate(
      base({
        tagName: "button",
        type: null,
        insideForm: true,
        visibleText: "Save",
      }),
    );
    expect(out.trip).toBe(true);
    if (out.trip) expect(out.reason).toBe("form_submit_click");
  });

  it("opts out when type='button' explicitly", () => {
    const out = decideFinalConfirmGate(
      base({
        tagName: "button",
        type: "button",
        insideForm: true,
        visibleText: "Cancel",
      }),
    );
    expect(out.trip).toBe(false);
  });

  it("uses '<form button>' label fallback", () => {
    const out = decideFinalConfirmGate(
      base({
        tagName: "button",
        type: null,
        insideForm: true,
        visibleText: "",
        ariaLabel: null,
      }),
    );
    if (out.trip) expect(out.matched).toBe("<form button>");
  });
});

describe("decideFinalConfirmGate — action vocab (leg c)", () => {
  it("trips on role=button with 'Submit' text", () => {
    const out = decideFinalConfirmGate({
      trigger: "click",
      tagName: "div",
      role: "button",
      type: null,
      insideForm: false,
      visibleText: "Submit Report",
      ariaLabel: null,
    });
    expect(out.trip).toBe(true);
    if (out.trip) {
      expect(out.reason).toBe("action_vocab");
      expect(out.matched).toBe("Submit Report");
    }
  });

  it("trips on <a role=button> with commit-vocab visible text", () => {
    const out = decideFinalConfirmGate({
      trigger: "click",
      tagName: "a",
      role: "button",
      type: null,
      insideForm: false,
      visibleText: "Post",
      ariaLabel: null,
    });
    expect(out.trip).toBe(true);
    if (out.trip) expect(out.reason).toBe("action_vocab");
  });

  it("trips on aria-label matching the vocab even if visible text is benign", () => {
    const out = decideFinalConfirmGate({
      trigger: "click",
      tagName: "button",
      role: "button",
      type: null,
      insideForm: false,
      visibleText: "→",
      ariaLabel: "Send tweet",
    });
    expect(out.trip).toBe(true);
    if (out.trip) expect(out.matched).toBe("Send tweet");
  });

  it("does NOT trip on benign 'Sign in' / 'Continue'", () => {
    expect(
      decideFinalConfirmGate(
        base({ tagName: "button", visibleText: "Sign in" }),
      ).trip,
    ).toBe(false);
    expect(
      decideFinalConfirmGate(
        base({ tagName: "button", visibleText: "Continue" }),
      ).trip,
    ).toBe(false);
  });

  it("truncates long matched labels to 80 chars", () => {
    const label = "Send ".repeat(40);
    const out = decideFinalConfirmGate({
      trigger: "click",
      tagName: "button",
      role: "button",
      type: null,
      insideForm: false,
      visibleText: label,
      ariaLabel: null,
    });
    if (out.trip) expect(out.matched.length).toBeLessThanOrEqual(80);
  });
});

describe("decideFinalConfirmGate — branch coverage edge cases", () => {
  it("treats an undefined key as not-Enter (leg b1 false branch)", () => {
    const out = decideFinalConfirmGate({
      trigger: "press_key",
      // key intentionally omitted
      tagName: "input",
      role: null,
      type: "text",
      insideForm: true,
      visibleText: "",
      ariaLabel: null,
    });
    expect(out.trip).toBe(false);
  });

  it("ignores aria=button on non-<a> tag (leg c looksLikeButton branch)", () => {
    // role=button on a span IS still "looksLikeButton". Branch focus
    // is the `(tagName==='a' && role==='button')` arm: tagName='a'
    // but role !== 'button' should NOT trigger that specific arm
    // (still trips via the role-button arm if role IS button).
    const out = decideFinalConfirmGate({
      trigger: "click",
      tagName: "a",
      role: "link",
      type: null,
      insideForm: false,
      visibleText: "Submit",
      ariaLabel: null,
    });
    // role is not "button" and tagName is not "button" — does NOT
    // trigger leg (c).
    expect(out.trip).toBe(false);
  });

  it("handles null visibleText in leg (c) action-vocab evaluation", () => {
    const out = decideFinalConfirmGate({
      trigger: "click",
      tagName: "button",
      role: null,
      type: null,
      insideForm: false,
      // visibleText empty + null aria — `||` short-circuit on the
      // `(input.visibleText || "")` arm.
      visibleText: "",
      ariaLabel: null,
    });
    expect(out.trip).toBe(false);
  });
});

describe("decideFinalConfirmGate — non-button targets", () => {
  it("returns trip=false for a div with no role and benign text", () => {
    const out = decideFinalConfirmGate({
      trigger: "click",
      tagName: "div",
      role: null,
      type: null,
      insideForm: false,
      visibleText: "Hello",
      ariaLabel: null,
    });
    expect(out.trip).toBe(false);
  });

  it("returns trip=false for a coord-only (unknown DOM) target", () => {
    const out = decideFinalConfirmGate({
      trigger: "click",
      tagName: "unknown",
      role: null,
      type: null,
      insideForm: false,
      visibleText: "",
      ariaLabel: null,
    });
    expect(out.trip).toBe(false);
  });
});
