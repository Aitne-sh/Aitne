/**
 * `confirmCartCheckout` — Phase B-4's initial purchase workflow.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.5 / §13 step 58.
 *
 * Bound to `siteKey: "amazon_jp"`. The agent's input is the
 * sanity-check upper bound (`expectedMaxAmountMinor`) + the currency
 * code; the daemon mints the DM-issued token AFTER the pre-confirm
 * screenshot, threads the user-typed reply through the messaging
 * adapter's incoming hook, and only then clicks "Place order".
 *
 * Flow (timeline mirrors plan §17.3):
 *   1. Navigate to the cart-confirm URL (workflow-internal constant).
 *   2. Capture the pre-confirm screenshot.
 *   3. Hash the cart summary DOM + read displayed total.
 *   4. Sanity-check displayed total ≤ agent-declared
 *      `expectedMaxAmountMinor`. On miss → `amount_exceeds_expected`
 *      WITHOUT ever DMing the user (the agent has mis-assessed and
 *      should not get the user involved).
 *   5. Issue the `!~xxxxxxxx` token via `purchaseHandler.issueToken`.
 *      On failure → map to the appropriate `cancelled_*` /
 *      `daily_cap_exceeded` / `playwright_error` status.
 *   6. Await the user's DM reply (`purchaseHandler.awaitReply`).
 *      Returns confirmed / cancelled_by_user_reply / cancelled_wrong_token
 *      / cancelled_timeout / cancelled_explicit.
 *   7. On confirmed: reload, re-hash, re-read total. Any drift
 *      → `page_changed` / `amount_mismatch`, cancel.
 *   8. Click "Place order"; wait for the order-confirmed selector.
 *   9. Capture post-confirm screenshot, extract order ID, finalize.
 *
 * Excluded from the coverage gate — Playwright + DM I/O. The pure
 * decision logic (token shape, classifier, expiry arithmetic) lives
 * in `purchase-tokens.ts` and is the covered surface.
 */

import { z } from "zod";

import type {
  WorkflowDefinition,
  WorkflowRunContext,
} from "../types.js";
import { RiskTier } from "../../../../safety/risk-classifier.js";
import {
  PURCHASE_CONFIRMATION_TEMPLATE_MARKERS,
} from "../purchase-tokens.js";
import type {
  AwaitReplyResult,
  IssueTokenResult,
  PurchaseHandler,
} from "../purchase-handler.js";

const CONFIRM_CART_CHECKOUT_NAME = "confirmCartCheckout";

/**
 * Amazon JP cart-review entry point. The workflow expects the user (or
 * a B-3 workflow, future) to have already populated the cart and
 * walked through to the "review your order" page; the URL below is
 * Amazon's stable single-page-checkout entry. Site-specific. Update
 * here if Amazon ships a new shape.
 */
const AMAZON_JP_CART_REVIEW_URL =
  "https://www.amazon.co.jp/gp/buy/spc/handlers/display.html";

/** Selectors used to read the displayed grand-total + the place-order
 *  button. Each selector lists a primary + fallback chain so a
 *  cosmetic Amazon DOM tweak does not break the entire workflow. */
const AMAZON_JP_GRAND_TOTAL_SELECTORS = [
  "#subtotals-marketplace-table tr.grand-total-row td.a-text-right .a-color-price",
  "#submit-order-summary-grand-total .order-summary-grand-total-amount",
  "#subtotals-marketplace-table .grand-total-price",
  "[data-feature-name='OrderSummary'] tr:last-child .a-price .a-offscreen",
] as const;

const AMAZON_JP_PLACE_ORDER_SELECTORS = [
  "#submitOrderButtonId input[name='placeYourOrder1']",
  "input[name='placeYourOrder1']",
  "#submitOrderButtonId",
] as const;

const AMAZON_JP_ORDER_CONFIRMED_SELECTORS = [
  "h1#widget-purchase-confirmation-page-title",
  "#widget-purchase-confirmation",
  ".a-alert-content:contains('Thank you')",
] as const;

const AMAZON_JP_ORDER_ID_SELECTORS = [
  "[data-test-id='order-number']",
  "#widget-purchase-confirmation .a-color-success + .a-spacing-mini",
] as const;

/**
 * Workflow input + output schemas — plan §17.5 verbatim.
 */
const inputSchema = z.object({
  /** Agent-declared upper bound on the displayed total — when the
   *  daemon-computed displayed total exceeds this the workflow aborts
   *  BEFORE the user is DMed. Min 1 minor unit (no zero-amount
   *  workflows); max 1,000,000 minor units (¥1M = JPY hard ceiling
   *  irrespective of site config — defence-in-depth against a buggy
   *  per-site cap). */
  expectedMaxAmountMinor: z.number().int().min(1).max(1_000_000),
  /** ISO-4217 currency code the workflow expects; must match the
   *  site's B-4 config currency. */
  currency: z.string().length(3),
  /** Agent's free-text rationale rendered in the DM confirmation
   *  template. Max 200 chars (DM mobile-budget friendly). The
   *  outbound classifier checks the rendered DM against the reserved
   *  markers — the `notesForUser` MUST NOT contain any of them, to
   *  defend against the agent smuggling a fake confirmation marker
   *  into the daemon's template via the notes field. */
  notesForUser: z
    .string()
    .max(200)
    .refine(
      (s) => !PURCHASE_CONFIRMATION_TEMPLATE_MARKERS.some(
        (m) => s.toLowerCase().includes(m.toLowerCase()),
      ),
      {
        message:
          "notesForUser cannot contain reserved purchase-template markers",
      },
    )
    .optional(),
});

const outputSchema = z.object({
  status: z.enum([
    "confirmed",
    "cancelled_by_user_reply",
    "cancelled_wrong_token",
    "cancelled_timeout",
    "cancelled_explicit",
    "amount_mismatch",
    "amount_exceeds_expected",
    "daily_cap_exceeded",
    "page_changed",
    "playwright_error",
    // ── Pre-flight gate outcomes ──
    "b4_disabled",
    "site_not_enabled",
    "pending_exists",
    "no_primary_channels",
    "currency_mismatch",
    "delivery_failed",
  ]),
  confirmedAmountMinor: z.number().int().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  orderId: z.string().optional(),
  preConfirmScreenshotPath: z.string(),
  postConfirmScreenshotPath: z.string().optional(),
  /** Server-side opaque id — joins to `browser_automation_purchase_tokens.jti`.
   *  The raw `!~xxxxxxxx` token is NEVER returned in workflow output;
   *  the agent only ever sees the jti. */
  purchaseTokenAuditId: z.string().optional(),
  /** Categorical detail for the dashboard's recent-purchases panel.
   *  Populated on failure paths to disambiguate at-a-glance. */
  failureDetail: z
    .object({
      reason: z.string(),
      pendingJti: z.string().optional(),
      capMinor: z.number().optional(),
      currentMinor: z.number().optional(),
      proposedMinor: z.number().optional(),
      expected: z.string().optional(),
      actual: z.string().optional(),
    })
    .optional(),
});

export type ConfirmCartCheckoutInput = z.infer<typeof inputSchema>;
export type ConfirmCartCheckoutOutput = z.infer<typeof outputSchema>;

/**
 * Augmented workflow context the runner provides for purchase
 * variants. Carries the `PurchaseHandler` instance plus the
 * originating channel (when the workflow was kicked off by a user DM
 * — null for scheduled invocations).
 */
export interface PurchaseRunContext extends WorkflowRunContext {
  purchaseHandler: PurchaseHandler;
  originatingChannel: string | null;
}

/**
 * Internal Playwright shape — kept local so the workflow does not
 * pull in `playwright-core` types eagerly. The `playwrightContext` is
 * downcast at the boundary of `run()` and never escapes back into the
 * coverage-locked module surface.
 */
interface ContextLike {
  newPage(): Promise<PageLike>;
}
interface PageLike {
  goto(
    url: string,
    opts: { waitUntil: "domcontentloaded"; timeout: number },
  ): Promise<unknown>;
  reload(opts: {
    waitUntil: "domcontentloaded";
    timeout: number;
  }): Promise<unknown>;
  url(): string;
  content(): Promise<string>;
  locator(selector: string): LocatorLike;
  waitForSelector(
    selector: string,
    opts: { timeout: number; state?: "attached" | "visible" },
  ): Promise<unknown>;
  click(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  close(): Promise<void>;
  textContent(selector: string): Promise<string | null>;
  evaluate<T>(fn: () => T): Promise<T>;
}
interface LocatorLike {
  first(): LocatorLike;
  textContent(opts?: { timeout?: number }): Promise<string | null>;
  isVisible(opts?: { timeout?: number }): Promise<boolean>;
  count(): Promise<number>;
}

export const confirmCartCheckout: WorkflowDefinition<
  ConfirmCartCheckoutInput,
  ConfirmCartCheckoutOutput
> = {
  name: CONFIRM_CART_CHECKOUT_NAME,
  variant: "purchase",
  siteKey: "amazon_jp",
  allowlistRegex:
    /^https?:\/\/(www\.)?amazon\.co\.jp\/(gp\/cart|gp\/buy|checkout)/,
  inputSchema,
  outputSchema,
  riskTier: RiskTier.Approve,
  perWorkflowTimeoutMs: 6 * 60 * 1000,
  async run(ctx): Promise<ConfirmCartCheckoutOutput> {
    // The runner injects purchaseHandler + originatingChannel into the
    // ctx object for purchase variants (see workflow-runner.ts step 7).
    // The base WorkflowRunContext typing doesn't carry these fields, so
    // we widen via cast at the boundary — the cast is safe because the
    // runner branches on `def.variant === "purchase"` before invoking.
    const augmented = ctx as typeof ctx & {
      purchaseHandler: PurchaseHandler;
      originatingChannel: string | null;
    };
    const { params, screenshotSink, signal, workflowId } = augmented;
    const playwrightContext = augmented.playwrightContext as ContextLike;
    const purchaseHandler = augmented.purchaseHandler;
    const originatingChannel = augmented.originatingChannel;

    let page: PageLike | null = null;
    let preScreenshotPath = "";

    try {
      page = await playwrightContext.newPage();
      await page.goto(AMAZON_JP_CART_REVIEW_URL, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });

      // Step 1 — pre-confirm screenshot. We capture BEFORE the amount
      // sanity check so the audit trail carries the screenshot even on
      // the `amount_exceeds_expected` early abort (the user can later
      // inspect what the agent saw).
      preScreenshotPath = await screenshotSink.capture(
        "pre-confirm",
        page,
      );

      // Step 2 — read displayed total + compute cart summary hash.
      const displayedTotalMinor = await readDisplayedTotalMinor(
        page,
        params.currency,
      );
      if (displayedTotalMinor === null) {
        return {
          status: "playwright_error",
          preConfirmScreenshotPath: preScreenshotPath,
          failureDetail: {
            reason: "cart_grand_total_selector_no_match",
          },
        };
      }
      const preCartHash = await computeCartSummaryHash(page);

      // Step 3 — agent-side upper-bound sanity check. Bail BEFORE
      // DMing the user; this is "the agent has mis-assessed the
      // request", not "the user needs to make a decision".
      if (displayedTotalMinor > params.expectedMaxAmountMinor) {
        return {
          status: "amount_exceeds_expected",
          confirmedAmountMinor: displayedTotalMinor,
          currency: params.currency,
          preConfirmScreenshotPath: preScreenshotPath,
          failureDetail: {
            reason: "displayed_exceeds_expected",
            proposedMinor: displayedTotalMinor,
            capMinor: params.expectedMaxAmountMinor,
          },
        };
      }

      // Step 4 — mint the token + DM. The handler does the per-site
      // cap enforcement atomically; mapping failures back to the
      // workflow's outputSchema status set happens in
      // `mapIssueFailure`.
      const issued = await purchaseHandler.issueToken({
        workflowInvocationId: workflowId,
        siteKey: "amazon_jp",
        urlPattern: confirmCartCheckout.allowlistRegex.source,
        displayedTotalMinor,
        currency: params.currency,
        preScreenshotPath,
        notesForUser: params.notesForUser ?? null,
        originatingChannel,
      });
      if (!issued.ok) {
        return mapIssueFailure(issued, preScreenshotPath);
      }

      // Step 5 — await the DM reply. AbortSignal threading lets the
      // runner's `perWorkflowTimeoutMs` race cancel this loop.
      const reply = await purchaseHandler.awaitReply({
        jti: issued.jti,
        abortSignal: signal,
      });
      if (reply.status !== "confirmed") {
        return {
          status: mapAwaitReplyStatus(reply.status),
          preConfirmScreenshotPath: preScreenshotPath,
          purchaseTokenAuditId: issued.jti,
          currency: params.currency,
        };
      }

      // Step 6 — post-resume re-check. The cart may have mutated
      // between the screenshot and the user typing the token (e.g.,
      // they clicked an "edit" link in another tab). We re-load + re-
      // hash before clicking Confirm.
      await page.reload({
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
      const postPauseHash = await computeCartSummaryHash(page);
      if (postPauseHash !== preCartHash) {
        // Post-consume failure — the user already typed the token, so
        // the row is `pending+consumed_at!=null`. Cancel must run in
        // any-non-terminal mode or the CAS misses and the row sticks
        // forever (and the user never gets the cancellation DM).
        await purchaseHandler.cancel(
          issued.jti,
          "page_changed",
          "any-non-terminal",
        );
        return {
          status: "page_changed",
          preConfirmScreenshotPath: preScreenshotPath,
          purchaseTokenAuditId: issued.jti,
          failureDetail: { reason: "cart_dom_mutated_during_pause" },
        };
      }
      const postPauseTotalMinor = await readDisplayedTotalMinor(
        page,
        params.currency,
      );
      if (
        postPauseTotalMinor === null ||
        postPauseTotalMinor !== displayedTotalMinor
      ) {
        await purchaseHandler.cancel(
          issued.jti,
          "amount_mismatch",
          "any-non-terminal",
        );
        return {
          status: "amount_mismatch",
          preConfirmScreenshotPath: preScreenshotPath,
          purchaseTokenAuditId: issued.jti,
          failureDetail: {
            reason: "displayed_total_changed_during_pause",
            proposedMinor: postPauseTotalMinor ?? -1,
            currentMinor: displayedTotalMinor,
          },
        };
      }

      // Step 7 — click Place Order. The first selector that resolves
      // wins; the workflow short-circuits to playwright_error if none
      // resolve in 8 s (Amazon's checkout takes ~1–2 s to render
      // under sandbox).
      const placeOrderSelector = await firstResolvingSelector(
        page,
        AMAZON_JP_PLACE_ORDER_SELECTORS,
        8_000,
      );
      if (!placeOrderSelector) {
        // Post-consume failure path — see §17.3 cancel-on-failure rules.
        await purchaseHandler.cancel(
          issued.jti,
          "playwright_error",
          "any-non-terminal",
        );
        return {
          status: "playwright_error",
          preConfirmScreenshotPath: preScreenshotPath,
          purchaseTokenAuditId: issued.jti,
          failureDetail: { reason: "place_order_button_not_found" },
        };
      }
      await page.click(placeOrderSelector, { timeout: 10_000 });

      // Step 8 — wait for the order-confirmed selector. 30 s is a
      // generous slack — Amazon's place-order RTT under normal
      // network conditions is 3–8 s; outliers hit ~20 s.
      const confirmedSelector = await firstResolvingSelector(
        page,
        AMAZON_JP_ORDER_CONFIRMED_SELECTORS,
        30_000,
      );
      if (!confirmedSelector) {
        // The click landed but the confirmation page never rendered
        // — Amazon may have intercepted with a 2FA challenge or the
        // network failed mid-place-order. We do NOT click again (that
        // could double-spend); instead surface playwright_error and
        // leave the cancellation to the user.
        //
        // Post-consume cancel path — see §17.3 cancel-on-failure rules.
        // The row is `pending+consumed_at!=null`; pending-only mode
        // would miss the CAS and leave the row stuck, so we explicitly
        // request the broader predicate.
        await purchaseHandler.cancel(
          issued.jti,
          "playwright_error",
          "any-non-terminal",
        );
        return {
          status: "playwright_error",
          preConfirmScreenshotPath: preScreenshotPath,
          purchaseTokenAuditId: issued.jti,
          failureDetail: {
            reason: "order_confirmation_page_did_not_render",
          },
        };
      }

      // Step 9 — capture post-confirm screenshot + extract order ID.
      const postScreenshotPath = await screenshotSink.capture(
        "post-confirm",
        page,
      );
      const orderId = await extractOrderId(page);

      // Step 10 — finalize. Wraps the row in the `confirmed` terminal
      // state with the confirmed amount + order id + post-screenshot.
      const finalized = await purchaseHandler.finalize({
        jti: issued.jti,
        confirmedAmountMinor: displayedTotalMinor,
        currency: params.currency,
        orderId,
        postScreenshotPath,
      });
      if (!finalized) {
        // Finalize CAS missed — should not happen on the happy path
        // (the consumed_at predicate is satisfied at this point).
        return {
          status: "playwright_error",
          preConfirmScreenshotPath: preScreenshotPath,
          postConfirmScreenshotPath: postScreenshotPath,
          purchaseTokenAuditId: issued.jti,
          failureDetail: { reason: "finalize_cas_missed" },
        };
      }
      return {
        status: "confirmed",
        confirmedAmountMinor: displayedTotalMinor,
        currency: params.currency,
        orderId: orderId ?? undefined,
        preConfirmScreenshotPath: preScreenshotPath,
        postConfirmScreenshotPath: postScreenshotPath,
        purchaseTokenAuditId: issued.jti,
      };
    } finally {
      // The runner releases the Playwright handle in workflow-runner.ts;
      // we close the page so any pending in-page event listeners don't
      // leak past the workflow turn.
      try {
        await page?.close();
      } catch {
        // best-effort
      }
    }
  },
};

function mapAwaitReplyStatus(
  status: AwaitReplyResult["status"],
): ConfirmCartCheckoutOutput["status"] {
  switch (status) {
    case "cancelled_by_user_reply":
      return "cancelled_by_user_reply";
    case "cancelled_wrong_token":
      return "cancelled_wrong_token";
    case "cancelled_timeout":
      return "cancelled_timeout";
    case "cancelled_explicit":
      return "cancelled_explicit";
    case "cancelled_other":
      return "playwright_error";
    case "confirmed":
      // Defensive — the caller handles `confirmed` BEFORE invoking
      // this mapper; unreachable in practice.
      return "confirmed";
  }
}

function mapIssueFailure(
  result: Exclude<IssueTokenResult, { ok: true }>,
  preScreenshotPath: string,
): ConfirmCartCheckoutOutput {
  switch (result.reason) {
    case "b4_disabled":
      return {
        status: "b4_disabled",
        preConfirmScreenshotPath: preScreenshotPath,
        failureDetail: { reason: "b4_master_toggle_off" },
      };
    case "site_not_enabled":
      return {
        status: "site_not_enabled",
        preConfirmScreenshotPath: preScreenshotPath,
        failureDetail: { reason: "site_b4_disabled" },
      };
    case "no_primary_channels":
      return {
        status: "no_primary_channels",
        preConfirmScreenshotPath: preScreenshotPath,
        failureDetail: { reason: "no_primary_channels_configured" },
      };
    case "pending_exists":
      return {
        status: "pending_exists",
        preConfirmScreenshotPath: preScreenshotPath,
        failureDetail: {
          reason: "concurrent_pending_token",
          pendingJti: result.pendingJti,
        },
      };
    case "daily_token_cap_exceeded":
      return {
        status: "daily_cap_exceeded",
        preConfirmScreenshotPath: preScreenshotPath,
        failureDetail: {
          reason: "daily_token_cap_exceeded",
          capMinor: result.cap,
          currentMinor: result.used,
        },
      };
    case "daily_spend_cap_exceeded":
      return {
        status: "daily_cap_exceeded",
        preConfirmScreenshotPath: preScreenshotPath,
        failureDetail: {
          reason: "daily_spend_cap_exceeded",
          capMinor: result.capMinor,
          currentMinor: result.currentMinor,
          proposedMinor: result.proposedMinor,
        },
      };
    case "currency_mismatch":
      return {
        status: "currency_mismatch",
        preConfirmScreenshotPath: preScreenshotPath,
        failureDetail: {
          reason: "currency_does_not_match_site_config",
          expected: result.expected,
          actual: result.actual,
        },
      };
    case "delivery_failed":
      return {
        status: "delivery_failed",
        preConfirmScreenshotPath: preScreenshotPath,
        purchaseTokenAuditId: result.jti,
        failureDetail: { reason: "dm_delivery_failed_on_all_channels" },
      };
  }
}

/**
 * Pure-ish: tries each selector in order and returns the first one
 * that becomes visible within `timeoutMs`. Returns null when nothing
 * resolves — the workflow surfaces `playwright_error` with a
 * categorical reason in that case.
 *
 * Total timeout is `selectors.length * (timeoutMs / N)` worst-case;
 * with 3 selectors and 8 s budget each gets ~2.6 s, plenty for
 * Amazon's render cadence under sandbox.
 */
async function firstResolvingSelector(
  page: PageLike,
  selectors: readonly string[],
  timeoutMs: number,
): Promise<string | null> {
  const perSelector = Math.max(
    500,
    Math.floor(timeoutMs / Math.max(1, selectors.length)),
  );
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, {
        timeout: perSelector,
        state: "visible",
      });
      return sel;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Read the Amazon JP cart's grand total. Returns the value in minor
 * units (¥1 = 1 minor unit per ISO-4217 zero-decimal currencies)
 * matching `currency`, or null when no selector resolves or the parse
 * fails.
 *
 * The parse strips currency symbols + thousands separators + decimal
 * separators per the currency's convention. For JPY (zero-decimal)
 * we round to integer; for non-JPY (e.g., USD) we multiply by 100.
 */
async function readDisplayedTotalMinor(
  page: PageLike,
  currency: string,
): Promise<number | null> {
  const sel = await firstResolvingSelector(
    page,
    AMAZON_JP_GRAND_TOTAL_SELECTORS,
    8_000,
  );
  if (!sel) return null;
  let text: string | null = null;
  try {
    text = await page.textContent(sel);
  } catch {
    return null;
  }
  if (!text) return null;
  return parseDisplayedAmount(text, currency);
}

/**
 * Parse a displayed price string like `"¥3,500"` / `"$30.00"` /
 * `"30.00 USD"` into minor units. Pure; tested in the workflow's
 * unit test. Returns null on parse failure.
 *
 * Heuristic — strips every character outside `[0-9.,-]` and walks the
 * remaining structure:
 *   - Last separator that has 1 or 2 digits AFTER it is the decimal
 *     point; everything else is thousands separator (or noise).
 *   - For zero-decimal currencies (JPY etc.) the integer-only result
 *     is returned as-is.
 *   - For 2-decimal currencies the result is multiplied by 100.
 *
 * Negative amounts → null (Amazon's cart never displays negatives).
 */
export function parseDisplayedAmount(
  raw: string,
  currency: string,
): number | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const stripped = raw.replace(/[^0-9.,-]/g, "");
  if (stripped.length === 0) return null;
  if (stripped.includes("-")) return null;
  const zeroDecimal = ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase());

  // Locate decimal separator: the last `.` or `,` followed by exactly
  // 1 or 2 digits at end-of-string. Everything else is thousands.
  const decimalMatch = /([.,])\d{1,2}$/.exec(stripped);
  let majorStr: string;
  let minorStr: string;
  if (decimalMatch && !zeroDecimal) {
    const idx = decimalMatch.index;
    majorStr = stripped.slice(0, idx).replace(/[.,]/g, "");
    minorStr = stripped.slice(idx + 1);
  } else {
    majorStr = stripped.replace(/[.,]/g, "");
    minorStr = "";
  }
  if (majorStr.length === 0) return null;
  const major = Number.parseInt(majorStr, 10);
  if (!Number.isFinite(major) || major < 0) return null;
  if (zeroDecimal) return major;
  const minor = minorStr.length === 0
    ? 0
    : Number.parseInt(minorStr.padEnd(2, "0").slice(0, 2), 10);
  if (!Number.isFinite(minor) || minor < 0) return null;
  return major * 100 + minor;
}

const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "JPY", "KRW", "VND", "CLP", "ISK", "PYG", "RWF", "UGX",
  "BIF", "DJF", "GNF", "KMF", "MGA", "XAF", "XOF", "XPF",
]);

/**
 * Hash the cart summary region's DOM so a between-screenshot-and-
 * confirm mutation is detectable. Reads the inner text of every
 * grand-total + item-row selector; produces a stable SHA-1 hex. The
 * hash is intentionally narrow — it covers the prices but not the
 * page chrome — so unrelated tweaks (a banner ad refresh) don't
 * false-trigger `page_changed`.
 *
 * Uses `page.evaluate` to run the DOM read inside the browser
 * context; the resulting string is hashed in Node. Falls back to
 * `page.content()` (full HTML) if the in-page DOM read fails — that
 * over-triggers, but only in the rare case the evaluate path errors,
 * which means there's likely a deeper Playwright problem we want to
 * surface anyway.
 */
async function computeCartSummaryHash(page: PageLike): Promise<string> {
  const { createHash } = await import("node:crypto");
  const candidates = [
    "#subtotals-marketplace-table",
    "#submit-order-summary-grand-total",
    "[data-feature-name='OrderSummary']",
  ];
  // Read each candidate's textContent in the Node side via Playwright's
  // textContent API rather than `page.evaluate(() => document.querySelector)`
  // — keeps the daemon's tsconfig DOM-free and avoids dragging in the
  // browser-global `document` symbol just for this read. Order-stable
  // (we iterate the candidates array) and tolerant of misses (textContent
  // returns null when the selector resolves to nothing).
  const parts: string[] = [];
  for (const sel of candidates) {
    try {
      const t = await page.textContent(sel);
      if (t) parts.push(t.replace(/\s+/g, " ").trim());
    } catch {
      // selector miss or transient error — skip
    }
  }
  let payload = parts.join("\n");
  if (payload.length === 0) {
    try {
      payload = await page.content();
    } catch {
      payload = "";
    }
  }
  return createHash("sha1").update(payload, "utf8").digest("hex");
}

/**
 * Extract the order ID from the post-confirm thank-you page. Returns
 * null when no selector resolves — the workflow still returns
 * `confirmed` (the purchase committed), the order ID just stays
 * undefined in the output for the dashboard. Most Amazon pages
 * surface the order ID as `Order #503-XXXXXXX-XXXXXXX`.
 */
async function extractOrderId(page: PageLike): Promise<string | null> {
  for (const sel of AMAZON_JP_ORDER_ID_SELECTORS) {
    try {
      const txt = await page.textContent(sel);
      if (txt) {
        const m = /(\d{3}-\d{7}-\d{7})/.exec(txt);
        if (m) return m[1];
        return txt.trim().slice(0, 64);
      }
    } catch {
      // try next
    }
  }
  try {
    // Last-resort: scrape the full page text for the order-ID shape.
    const full = await page.content();
    const m = /(\d{3}-\d{7}-\d{7})/.exec(full);
    if (m) return m[1];
  } catch {
    // ignore
  }
  return null;
}
