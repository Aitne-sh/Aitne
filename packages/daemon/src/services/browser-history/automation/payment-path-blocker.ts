/**
 * Payment-path blocker — pure URL pattern guard for the workflow runner.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §10 / §13 step 46.
 *
 * Hard-blocks any workflow whose primary URL navigates to a payment
 * surface: any path ending in /checkout, /payment, /place-order, /buy,
 * or /place-bid. The check runs BEFORE the workflow's own
 * `allowlistRegex` so a workflow that mistakenly includes a payment
 * sub-tree in its allowlist still fails closed.
 *
 * Why structural: B-3 introduces user-approved write workflows operating
 * against logged-in profiles. Payment surfaces are categorically
 * different — they commit money and belong to B-4 (which gates with a
 * DM-issued single-use token, screenshot-first consent, and per-site
 * spend caps). A B-3 workflow holding a generic Approve token must not
 * be able to navigate to a payment path: the user-facing approval
 * dialog explicitly does not authorise that semantic class.
 *
 * The runner applies this guard to every non-purchase workflow (anon,
 * auth, and any future variant). Only `variant === "purchase"`
 * bypasses it — those workflows ship via B-4 with their own gate.
 *
 * Pure — no FS, no DB, no network. Lives in the 100%-coverage gate.
 */

/** Closed set of payment-path categories. The category is surfaced in
 *  the audit row's `detail` so the dashboard can distinguish "this
 *  workflow tried to reach checkout" from "this workflow tried to
 *  reach a bid form" — useful when triaging an over-eager workflow
 *  declaration without scanning the raw URL. */
export type PaymentPathCategory =
  | "checkout"
  | "payment"
  | "place-order"
  | "buy"
  | "place-bid";

/**
 * Anchored on a path-segment boundary so a benign URL like
 * `/checkout-faq` or `/buying-guide` does NOT match. The trailing
 * alternation `(?:\/|\?|#|$)` ensures the matched segment is the last
 * segment, or that the URL continues with a separator (query, fragment,
 * or end-of-string). Case-insensitive — site URLs sometimes vary case
 * in the wild.
 *
 * `payments` (plural) is included alongside `payment` because real-
 * world e-commerce uses both (Amazon: `/gp/buy/payselect/`, Shopify:
 * `/payments/...`). The cost of a false positive (rejecting a
 * legitimate non-commerce path that happens to contain `/payment/`) is
 * a clear error the user can route around by re-scoping the workflow;
 * the cost of a false negative (letting an agent navigate `/buy` under
 * a B-3 token) is a financial commitment without B-4 protections. We
 * favour false positives.
 */
const PAYMENT_PATH_PATTERNS: ReadonlyArray<{
  category: PaymentPathCategory;
  pattern: RegExp;
}> = Object.freeze([
  {
    category: "checkout",
    pattern: /\/checkout(?:\/|\?|#|$)/i,
  },
  {
    category: "payment",
    pattern: /\/payments?(?:\/|\?|#|$)/i,
  },
  {
    category: "place-order",
    // Both `place-order` (hyphenated) and `placeorder` (no separator)
    // — Amazon historically used the latter in older URL schemes.
    pattern: /\/place[-_]?order(?:\/|\?|#|$)/i,
  },
  {
    category: "buy",
    // `/gp/buy/` (Amazon) + plain `/buy` + `/buy-now`. The trailing
    // `(?:-now)?` allows the "Buy Now" pattern many storefronts use as
    // the express-checkout entry-point.
    pattern: /\/(?:gp\/buy|buy(?:-now)?)(?:\/|\?|#|$)/i,
  },
  {
    category: "place-bid",
    // eBay / Yahoo Auctions surface. `/place-bid` and `/bid` are both
    // bid-commitment surfaces under the same risk class.
    pattern: /\/(?:place-bid|bid)(?:\/|\?|#|$)/i,
  },
]);

export interface PaymentPathBlockMatch {
  category: PaymentPathCategory;
  matchedPath: string;
}

/**
 * Returns the matched category when the URL's pathname matches one of
 * the payment-path patterns, or null when the URL is safe. Tolerant of
 * malformed input — non-string / unparseable values return null and the
 * upstream URL-validator catches them via the per-workflow input schema.
 *
 * The function only inspects the URL's `pathname` — query string,
 * fragment, and hostname are not consulted. A workflow can hand the
 * function a query that mentions "checkout" without triggering the
 * block; this is intentional, since query-string filtering would over-
 * match (legitimate URLs frequently carry `?ref=checkout` etc.).
 */
export function classifyPaymentPath(url: string): PaymentPathBlockMatch | null {
  if (typeof url !== "string" || url.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // The pathname is what the patterns key off — they each carry an
  // anchored boundary that handles trailing / / ? / # / $.
  const path = parsed.pathname;
  for (const { category, pattern } of PAYMENT_PATH_PATTERNS) {
    if (pattern.test(path)) {
      return { category, matchedPath: path };
    }
  }
  return null;
}

/** Exposed for tests so the registry validator (registry.ts) can scan
 *  every workflow's `allowlistRegex.source` for a payment pattern and
 *  reject the declaration at module load. The validator iterates this
 *  table — adding a new pattern automatically tightens the check. */
export function listPaymentPathPatterns(): ReadonlyArray<{
  category: PaymentPathCategory;
  pattern: RegExp;
}> {
  return PAYMENT_PATH_PATTERNS;
}

export const __testing = {
  PAYMENT_PATH_PATTERNS,
};
