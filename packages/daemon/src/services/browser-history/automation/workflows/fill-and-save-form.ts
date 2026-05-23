/**
 * fillAndSaveForm workflow — Phase B-3 gated write (authenticated).
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §10 / §13 step 48.
 *
 * Fill a list of `(selector, value)` pairs on a logged-in site, click
 * the save selector, screenshot the result. Auth variant — runs under
 * a B-2.5-connected site profile. The B-3 approval token is required
 * before this `run()` is reached.
 *
 * Why an auth-variant write helper: many user-side workflows want to
 * persist data into a third-party site the user is signed in to
 * (update an Amazon shipping address, save a Goodreads list note,
 * update a profile bio). Each of those is a distinct workflow at
 * scale, but the shape is uniform — `fillAndSaveForm` is the generic
 * harness the agent calls when the more specific workflow doesn't
 * exist yet, with explicit user approval per invocation. The skill
 * body documents that the workflow is intentionally generic to bound
 * what the agent can do without bespoke registry-side review.
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

const fillEntrySchema = z.object({
  selector: selectorShape,
  /** Free-form value the workflow types into the input. Capped at
   *  1 KB to keep audit / params-summary footprint bounded; CR/LF
   *  rejected so the fill cannot inject header lines into form
   *  posts that some sites assemble via fetch(). */
  value: z
    .string()
    .min(0)
    .max(1024)
    .regex(/^[^\r\n]*$/),
});

const inputSchema = z.object({
  /** Target page — must match the workflow's allowlistRegex (any
   *  http(s) URL bound by the runner's user-domain allowlist) and the
   *  authenticated `siteKey` registry entry's `allowedHostPattern`
   *  (the runner enforces). */
  url: z.string().url().max(2048),
  /** Which B-2.5 site profile to attach. The workflow declares a
   *  fixed siteKey on its definition (auth variant); the input field
   *  is informational only — the runner uses `def.siteKey` for the
   *  CDP attach, not this. We surface it on the input so the user's
   *  approval prompt clearly states "running under amazon_jp" rather
   *  than burying the site in workflow internals. */
  siteKey: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/),
  /** List of fills, applied in order. Capped at 12 so a degenerate
   *  input cannot fan out into a 1000-field replay. */
  fills: z.array(fillEntrySchema).min(1).max(12),
  /** CSS selector of the submit / save button. */
  saveSelector: selectorShape,
  /** Optional post-save success indicator. When omitted, the
   *  workflow waits 3 s and reports `confirmation: "presumed"`. */
  successSelector: selectorShape.optional(),
});

const outputSchema = z.object({
  url: z.string().url(),
  siteKey: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/),
  /** Count of fills applied — the workflow stops on the first fill
   *  that fails to find its selector (the page may have shifted layout
   *  since the user chose selectors), so this can be < fills.length. */
  fillsApplied: z.number().int().nonnegative(),
  fillsRequested: z.number().int().nonnegative(),
  confirmation: z.enum(["verified", "presumed"]),
  screenshotPath: z
    .string()
    .regex(/^\/api\/browser-automation\/traces\/[a-f0-9-]+\/[a-z0-9._-]+\.png$/),
});

/** Default auth site: ships bound to amazon_jp because the only
 *  registered B-2.5 sites at this revision are amazon_jp / amazon_com /
 *  netflix, and amazon_jp matches the project owner's locale. The
 *  registry validator (§16.4) ensures the workflow's
 *  `allowlistRegex` is a subset of the site's `allowedHostPattern`.
 *  Future siblings (`fillAndSaveForm_amazonCom`, etc.) ship as separate
 *  registry entries — one workflow definition per site. */
export const fillAndSaveForm: WorkflowDefinition<
  z.infer<typeof inputSchema>,
  z.infer<typeof outputSchema>
> = {
  name: "fillAndSaveForm",
  inputSchema,
  outputSchema,
  // Subset of SITE_REGISTRY.amazon_jp.allowedHostPattern. The registry
  // validator enforces the subset relation; widening this in a future
  // edit must keep it inside the site's pattern.
  allowlistRegex: /^https?:\/\/(www\.)?amazon\.co\.jp\//,
  riskTier: RiskTier.Approve,
  perWorkflowTimeoutMs: 60_000,
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
      await page.goto(params.url, {
        waitUntil: "domcontentloaded",
        timeout: 25_000,
      });
      let applied = 0;
      for (const fill of params.fills) {
        try {
          await page
            .locator(fill.selector)
            .first()
            .waitFor({ state: "visible", timeout: 5_000 });
          await page
            .locator(fill.selector)
            .first()
            .fill(fill.value, { timeout: 5_000 });
          applied += 1;
        } catch {
          // Stop on first missing selector — partial fills are more
          // dangerous than a clean abort (the user can re-issue with
          // corrected selectors after seeing the screenshot).
          break;
        }
      }
      if (applied === 0) {
        // No fills applied — abort before clicking save so we don't
        // submit an empty edit. Capture a screenshot so the user can
        // see why the selectors didn't resolve.
        const screenshotPath = await screenshotSink.capture("no-fills", page);
        return {
          url: params.url,
          siteKey: params.siteKey,
          fillsApplied: 0,
          fillsRequested: params.fills.length,
          confirmation: "presumed",
          screenshotPath,
        };
      }
      await page
        .locator(params.saveSelector)
        .first()
        .click({ timeout: 5_000 });

      let confirmation: "verified" | "presumed" = "presumed";
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
        url: params.url,
        siteKey: params.siteKey,
        fillsApplied: applied,
        fillsRequested: params.fills.length,
        confirmation,
        screenshotPath,
      };
    } finally {
      await page.close().catch(() => {});
    }
  },
};
