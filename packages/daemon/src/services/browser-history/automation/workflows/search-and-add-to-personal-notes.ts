/**
 * searchAndAddToPersonalNotes workflow — Phase B-3 gated write.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §10 / §13 step 48.
 *
 * Search a logged-in site for a query, open the top result, and click
 * the site's "save / add to list / wishlist" affordance to persist the
 * item to the user's personal notes on that site. Captures a
 * screenshot at each stage so the user can audit the run.
 *
 * Auth variant — bound to `amazon_jp` in the initial release. Other
 * `siteKey` targets ship as sibling workflows in dedicated PRs
 * (different DOM selectors per site; the per-site sub-tree allowlist
 * regex narrows the egress surface, so generic "search" plumbing
 * across sites is not safe to share).
 *
 * The Approve risk-tier + B-3 approval-token gate apply: the runner
 * rejects the call with `needs_approval` until the user clicks Approve
 * in the dashboard for this specific (query, selector) pair.
 *
 * Excluded from coverage — `playwright-core` I/O.
 */

import { z } from "zod";

import { RiskTier } from "../../../../safety/risk-classifier.js";
import type { WorkflowDefinition } from "../types.js";

const selectorShape = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[#.A-Za-z0-9_\-[\]="': >+,~()*]+$/);

const inputSchema = z.object({
  /** URL of the site's search page (e.g.
   *  `https://www.amazon.co.jp/s?k=`). The query is appended /
   *  navigated to by the workflow; the runner's allowlist regex
   *  asserts the URL is under the workflow's site. */
  searchUrl: z.string().url().max(2048),
  /** Plain-text query — bounded length, CR/LF rejected so the
   *  workflow cannot inject newline-separated multi-search payloads. */
  query: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^\r\n]*$/),
  /** Selector for the search input on `searchUrl`. */
  searchInputSelector: selectorShape,
  /** Selector for the search submit button. */
  searchSubmitSelector: selectorShape,
  /** Selector matching the link of the first result the workflow
   *  clicks. The skill body documents how to identify a stable
   *  selector for the target site (e.g. Amazon's
   *  `[data-component-type='s-search-result'] h2 a`). */
  firstResultSelector: selectorShape,
  /** Selector for the "save" / "add to wishlist" affordance on the
   *  item detail page. */
  saveSelector: selectorShape,
  /** Optional post-save confirmation indicator. */
  successSelector: selectorShape.optional(),
});

const outputSchema = z.object({
  /** Search URL the workflow navigated to. */
  searchUrl: z.string().url(),
  /** Echo of the user's query — surfaced so the audit row stores it
   *  verbatim alongside the selectors. */
  query: z.string().max(256),
  /** URL the workflow resolved to after clicking the first result.
   *  Null when no result was reached (search-input miss / no
   *  results). */
  resolvedItemUrl: z.string().url().nullable(),
  /** Item title scraped from the detail page (truncated). Tagged
   *  untrusted because it originates from third-party DOM. */
  itemTitle: z
    .object({
      content: z.string().max(300).regex(/^[^\n\r]*$/),
      taggedUntrusted: z.literal(true),
    })
    .optional(),
  confirmation: z.enum(["verified", "presumed", "not_reached"]),
  /** Screenshot path of the post-save state (or the search results
   *  page when `confirmation === 'not_reached'`). */
  screenshotPath: z
    .string()
    .regex(/^\/api\/browser-automation\/traces\/[a-f0-9-]+\/[a-z0-9._-]+\.png$/),
});

export const searchAndAddToPersonalNotes: WorkflowDefinition<
  z.infer<typeof inputSchema>,
  z.infer<typeof outputSchema>
> = {
  name: "searchAndAddToPersonalNotes",
  inputSchema,
  outputSchema,
  // Same Amazon JP narrowing as `fillAndSaveForm` — keep the surface
  // small until per-site siblings ship.
  allowlistRegex: /^https?:\/\/(www\.)?amazon\.co\.jp\//,
  riskTier: RiskTier.Approve,
  perWorkflowTimeoutMs: 75_000,
  variant: "auth",
  siteKey: "amazon_jp",
  async run({ params, playwrightContext, screenshotSink }) {
    const ctx = playwrightContext as {
      newPage: () => Promise<unknown>;
    };
    const page = (await ctx.newPage()) as {
      goto: (
        url: string,
        opts: { waitUntil: "domcontentloaded"; timeout: number },
      ) => Promise<unknown>;
      url: () => string;
      title: () => Promise<string>;
      locator: (sel: string) => {
        first: () => {
          fill: (text: string, opts?: { timeout?: number }) => Promise<unknown>;
          click: (opts?: { timeout?: number }) => Promise<unknown>;
          waitFor: (opts: {
            state: "visible";
            timeout: number;
          }) => Promise<unknown>;
        };
      };
      waitForTimeout: (ms: number) => Promise<unknown>;
      close: () => Promise<void>;
    };
    try {
      await page.goto(params.searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: 25_000,
      });
      try {
        await page
          .locator(params.searchInputSelector)
          .first()
          .fill(params.query, { timeout: 5_000 });
        await page
          .locator(params.searchSubmitSelector)
          .first()
          .click({ timeout: 5_000 });
      } catch {
        const screenshotPath = await screenshotSink.capture(
          "search-input-miss",
          page,
        );
        return {
          searchUrl: params.searchUrl,
          query: params.query,
          resolvedItemUrl: null,
          confirmation: "not_reached",
          screenshotPath,
        };
      }
      try {
        await page
          .locator(params.firstResultSelector)
          .first()
          .waitFor({ state: "visible", timeout: 8_000 });
        await page
          .locator(params.firstResultSelector)
          .first()
          .click({ timeout: 5_000 });
      } catch {
        const screenshotPath = await screenshotSink.capture(
          "no-results",
          page,
        );
        return {
          searchUrl: params.searchUrl,
          query: params.query,
          resolvedItemUrl: null,
          confirmation: "not_reached",
          screenshotPath,
        };
      }
      // Settle navigation post-click.
      await page.waitForTimeout(1_500);
      const resolvedItemUrl = (() => {
        try {
          const u = new URL(page.url());
          // Drop any user-tracking fragments; keep path + scheme + host.
          return `${u.origin}${u.pathname}`;
        } catch {
          return null;
        }
      })();
      const titleRaw = (await page.title().catch(() => "")) ?? "";
      const itemTitle = titleRaw
        ? {
            content: titleRaw
              .replace(/[\r\n\t]+/g, " ")
              .replace(/\s{2,}/g, " ")
              .trim()
              .slice(0, 300),
            taggedUntrusted: true as const,
          }
        : undefined;
      try {
        await page
          .locator(params.saveSelector)
          .first()
          .click({ timeout: 5_000 });
      } catch {
        const screenshotPath = await screenshotSink.capture(
          "save-selector-miss",
          page,
        );
        return {
          searchUrl: params.searchUrl,
          query: params.query,
          resolvedItemUrl,
          ...(itemTitle ? { itemTitle } : {}),
          confirmation: "not_reached",
          screenshotPath,
        };
      }
      let confirmation: "verified" | "presumed" | "not_reached" = "presumed";
      if (params.successSelector) {
        try {
          await page
            .locator(params.successSelector)
            .first()
            .waitFor({ state: "visible", timeout: 10_000 });
          confirmation = "verified";
        } catch {
          confirmation = "presumed";
        }
      } else {
        await page.waitForTimeout(3_000);
      }
      const screenshotPath = await screenshotSink.capture("post-save", page);
      return {
        searchUrl: params.searchUrl,
        query: params.query,
        resolvedItemUrl,
        ...(itemTitle ? { itemTitle } : {}),
        confirmation,
        screenshotPath,
      };
    } finally {
      await page.close().catch(() => {});
    }
  },
};
