/**
 * Pre-flight URL guard for the `navigate` tool.
 *
 * Three checks, in order:
 *
 *   1. URL must parse and use `http:` or `https:` (scheme floor —
 *      `file:` / `javascript:` / `data:` / `blob:` / `chrome:` /
 *      `chrome-extension:` denied unconditionally).
 *   2. URL pathname must not match the payment-path patterns
 *      (`classifyPaymentPath` from `payment-path-blocker.ts`). This
 *      check is INDEPENDENT of any per-task allowlist — even if the
 *      operator explicitly registered an allowlist that would
 *      otherwise admit a checkout URL, the payment-path block fails
 *      closed. Browser-task does NOT carry the B-4 token surface;
 *      commit-money flows belong to `purchase-handler`.
 *   3. If a per-task `allowlistRegex` is supplied, URL must match it.
 *      When `null` (the 2026-05-27 open-navigation default for
 *      browser-task), no positive selector applies and the URL passes
 *      whatever the denylist gate decides. The CDP route handler
 *      enforces the denylist at the per-request boundary.
 *
 * Pure — no FS, no DB, no clock, no network. Lives in the 100%-
 * coverage gate.
 */

import {
  classifyPaymentPath,
  type PaymentPathBlockMatch,
} from "../payment-path-blocker.js";

/** Allowed URL schemes for browser-task navigations. */
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

export type NavigateGuardDecision =
  | { ok: true; normalisedUrl: string }
  | {
      ok: false;
      reason: "url_unparseable";
    }
  | {
      ok: false;
      reason: "scheme_denied";
      scheme: string;
    }
  | {
      ok: false;
      reason: "payment_path_blocked";
      match: PaymentPathBlockMatch;
    }
  | {
      ok: false;
      reason: "allowlist_blocked";
    };

/**
 * Pre-flight check for the `navigate` tool.
 *
 * Returns `{ ok: true, normalisedUrl }` when all three checks pass.
 * `normalisedUrl` is the parsed URL re-serialised via `URL` so the
 * action-log row records a canonical form.
 */
export function decideNavigate(input: {
  url: string;
  allowlistRegex: RegExp | null;
}): NavigateGuardDecision {
  if (typeof input.url !== "string" || input.url.length === 0) {
    return { ok: false, reason: "url_unparseable" };
  }
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return { ok: false, reason: "url_unparseable" };
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { ok: false, reason: "scheme_denied", scheme: parsed.protocol };
  }
  const normalised = parsed.toString();
  const paymentMatch = classifyPaymentPath(normalised);
  if (paymentMatch !== null) {
    return {
      ok: false,
      reason: "payment_path_blocked",
      match: paymentMatch,
    };
  }
  if (input.allowlistRegex !== null && !input.allowlistRegex.test(normalised)) {
    return { ok: false, reason: "allowlist_blocked" };
  }
  return { ok: true, normalisedUrl: normalised };
}
