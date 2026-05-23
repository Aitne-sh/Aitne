/**
 * getAmazonPurchaseHistory workflow — Phase B-2.5 authenticated read.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §16.4.
 *
 * Navigate to Amazon Japan's your-orders page (under the persistent
 * authenticated session in the `amazon_jp` profile dir) and extract
 * the order history for the most recent N months.
 *
 * Risk tier: `ReadSensitive` — logged-in PII (account label + order
 * IDs + items) flows through the output. The workflow runner's
 * site-gate (§16.4) verifies the per-site profile is connected + fresh
 * before this `run()` is reached; the per-workflow allowlist regex
 * is a subset of the site's `allowedHostPattern` (registry-validated).
 *
 * Excluded from the 100% coverage gate — same rationale as the B-2
 * `extractNewsArticle` workflow: the `run()` body calls into
 * `playwright-core`. The schemas + the (pure) DOM walk are testable
 * peers but the wiring would force a Playwright mock.
 */

import { z } from "zod";

import { RiskTier } from "../../../../safety/risk-classifier.js";
import type { WorkflowDefinition } from "../types.js";

const inputSchema = z.object({
  /** Lookback window in months. Amazon's UI exposes per-year buckets,
   *  so the runner converts months → years internally and trims the
   *  result list to the requested cutoff. */
  months: z.number().int().min(1).max(12).default(3),
});

const orderItemSchema = z.object({
  title: z
    .string()
    .max(300)
    .regex(/^[^\n\r]*$/),
  /** Marker that this string came from the external (untrusted) DOM.
   *  The runner's `wrapTaggedUntrusted` walk turns every such field
   *  into an `<external-content>`-bracketed value before the LLM sees
   *  it, so a malicious item title cannot smuggle prompt prose. */
  taggedUntrusted: z.literal(true),
});

const orderSchema = z.object({
  /** Amazon's order-ID shape: `XXX-NNNNNNN-NNNNNNN`. */
  orderId: z.string().regex(/^\d{3}-\d{7}-\d{7}$/),
  /** ISO date — only the day-precision portion is retained. */
  orderedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  total: z.object({
    /** Minor-unit (JPY has 0 fractional digits — the value equals the
     *  yen amount). Kept in minor units so a future EUR/USD site does
     *  not need a separate shape. */
    amountMinor: z.number().int().nonnegative(),
    /** ISO-4217 currency code. */
    currency: z.string().length(3).regex(/^[A-Z]{3}$/),
  }),
  items: z.array(orderItemSchema).max(20),
});

const outputSchema = z.object({
  /** Cutoff the workflow honoured — mirrors the input so the caller
   *  can verify the lookback matched the request. */
  monthsRequested: z.number().int().min(1).max(12),
  orders: z.array(orderSchema).max(200),
  /** Convenience aggregate — the dashboard's order-history card
   *  surfaces it without re-walking the items array. */
  itemsTotal: z.number().int().nonnegative(),
});

export const getAmazonPurchaseHistory: WorkflowDefinition<
  z.infer<typeof inputSchema>,
  z.infer<typeof outputSchema>
> = {
  name: "getAmazonPurchaseHistory",
  inputSchema,
  outputSchema,
  // Subset of `SITE_REGISTRY.amazon_jp.allowedHostPattern` — the
  // registry's allowlist-subset validator (§16.4) enforces the
  // relation at module load. We narrow further to the `your-orders`
  // sub-tree so a registry mistake widening the parent pattern still
  // does not let this workflow navigate the broader site.
  allowlistRegex: /^https?:\/\/(www\.)?amazon\.co\.jp\/(your-orders|gp\/your-account|gp\/css\/order-history)/,
  riskTier: RiskTier.ReadSensitive,
  perWorkflowTimeoutMs: 60_000,
  variant: "auth",
  siteKey: "amazon_jp",
  async run({ params, playwrightContext }) {
    const ctx = playwrightContext as {
      newPage: () => Promise<unknown>;
    };
    const page = (await ctx.newPage()) as {
      goto: (
        url: string,
        opts: { waitUntil: "domcontentloaded"; timeout: number },
      ) => Promise<unknown>;
      evaluate: <T>(fn: () => T) => Promise<T>;
      close: () => Promise<void>;
    };
    try {
      await page.goto("https://www.amazon.co.jp/gp/css/order-history", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      type DomLike = {
        document: {
          querySelectorAll: (sel: string) => ArrayLike<DomNodeLike>;
        };
      };
      type DomNodeLike = {
        getAttribute: (name: string) => string | null;
        textContent: string | null;
        querySelector: (sel: string) => DomNodeLike | null;
        querySelectorAll: (sel: string) => ArrayLike<DomNodeLike>;
      };
      const extracted = await page.evaluate(() => {
        const doc = (globalThis as unknown as DomLike).document;
        const orderNodes: DomNodeLike[] = [];
        const orderArr = doc.querySelectorAll(".order-card, .order, .a-box-group");
        for (let i = 0; i < orderArr.length; i++) orderNodes.push(orderArr[i]);
        const out: Array<{
          orderIdRaw: string;
          orderedAtRaw: string;
          totalRaw: string;
          items: Array<{ title: string }>;
        }> = [];
        for (const node of orderNodes) {
          const orderIdEl = node.querySelector(
            "[data-test-id='order-id'], .yohtmlc-order-id, bdi",
          );
          const orderedAtEl = node.querySelector(
            "[data-test-id='order-date'], .order-date-invoice-item, .a-color-secondary",
          );
          const totalEl = node.querySelector(
            "[data-test-id='order-total'], .yohtmlc-order-total .value, .a-price",
          );
          const itemsArr = node.querySelectorAll(
            ".yohtmlc-item .a-link-normal, .a-row .a-link-normal",
          );
          const items: Array<{ title: string }> = [];
          for (let i = 0; i < itemsArr.length && items.length < 20; i++) {
            const text = (itemsArr[i].textContent ?? "").trim();
            if (text.length > 0 && text.length < 300) {
              items.push({ title: text });
            }
          }
          out.push({
            orderIdRaw: (orderIdEl?.textContent ?? "").trim(),
            orderedAtRaw: (orderedAtEl?.textContent ?? "").trim(),
            totalRaw: (totalEl?.textContent ?? "").trim(),
            items,
          });
        }
        return out;
      });

      const orders: z.infer<typeof orderSchema>[] = [];
      for (const raw of extracted) {
        const orderId = matchOrderId(raw.orderIdRaw);
        if (!orderId) continue;
        const orderedAt = matchOrderedDate(raw.orderedAtRaw);
        if (!orderedAt) continue;
        const amountMinor = parseYen(raw.totalRaw);
        if (amountMinor === null) continue;
        orders.push({
          orderId,
          orderedAt,
          total: { amountMinor, currency: "JPY" },
          items: raw.items.map((it) => ({
            title: it.title.replace(/[\r\n\t]+/g, " ").trim(),
            taggedUntrusted: true as const,
          })),
        });
      }
      return {
        monthsRequested: params.months,
        orders: orders.slice(0, 200),
        itemsTotal: orders.reduce((acc, o) => acc + o.items.length, 0),
      };
    } finally {
      await page.close().catch(() => {});
    }
  },
};

/** Pull an Amazon-shaped order id out of a free-form DOM snippet. */
function matchOrderId(raw: string): string | null {
  const m = raw.match(/(\d{3}-\d{7}-\d{7})/);
  return m ? m[1] : null;
}

/**
 * Best-effort date parse. Accepts `YYYY{sep}MM{sep}DD` for any
 * locale-specific separator (slash, dash, dot, or any other
 * non-digit character) plus the all-digits compact form. The
 * non-digit class is deliberately broad — different Amazon locales
 * render dates with different glyphs as separators, and the daemon
 * does not ship locale-specific regexes per CLAUDE.md language policy.
 */
function matchOrderedDate(raw: string): string | null {
  const m =
    raw.match(/(\d{4})\D{1,3}(\d{1,2})\D{1,3}(\d{1,2})/) ??
    raw.match(/(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const y = m[1];
  const mo = m[2].padStart(2, "0");
  const d = m[3].padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/**
 * Parse a JPY-shaped total into integer yen. Strips every non-digit
 * character from the input (currency symbol, locale unit glyph,
 * thousands separators, whitespace, ISO-4217 prefix) so the parser
 * works regardless of which locale Amazon's UI rendered. Returns null
 * on an empty or unparseable result.
 */
function parseYen(raw: string): number | null {
  const cleaned = raw.replace(/\D+/g, "");
  if (cleaned.length === 0) return null;
  const n = Number.parseInt(cleaned, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export const __testing = {
  matchOrderId,
  matchOrderedDate,
  parseYen,
};
