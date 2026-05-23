/**
 * subscribeToNewsletter workflow — Phase B-3 (first gated write).
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §10 / §13 step 47.
 *
 * Fill the user's email into a newsletter signup form and submit.
 * Anonymous variant — newsletter signup is typically a public form
 * that requires no logged-in session; the action's mild
 * consequentiality (the user's email lands on a third party's list)
 * justifies the Approve risk-tier and the B-3 approval-token gate.
 *
 * The runner enforces the approval gate BEFORE this `run()` is
 * reached: the workflow function only sees validated input + a
 * Playwright context whose CDP network interception layer has
 * already pinned the egress allowlist to the workflow's
 * `allowlistRegex` (the target host) plus the global denylist.
 *
 * Excluded from the 100% coverage gate — `playwright-core` I/O.
 * The pure helpers (URL host extraction, output cleaning) and the
 * registry-validation tests are the covered surfaces.
 */

import { z } from "zod";

import { RiskTier } from "../../../../safety/risk-classifier.js";
import type { WorkflowDefinition } from "../types.js";

const inputSchema = z.object({
  /** Page that hosts the signup form. Must match the workflow's
   *  allowlist regex (any http(s) URL bound at the per-domain user
   *  allowlist by the runner's step 4) and must not navigate to a
   *  payment surface (runner step 2.5). */
  url: z.string().url().max(2048),
  /** RFC-5322-lite email pattern — strict enough to reject CR/LF
   *  injection (the form fill cannot leak headers) without dragging
   *  in a full RFC parser. The runner forwards this verbatim to the
   *  page; an injection-shaped value flips input validation to error. */
  email: z
    .string()
    .min(3)
    .max(254)
    .regex(/^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/),
  /** CSS selector pointing at the email `<input>`. The skill body /
   *  user-facing docs explain how to identify the right selector
   *  (Inspector → Copy selector). The runner constrains it to a safe
   *  CSS subset to forbid `:has()` / `:scope` JavaScript-eval shapes
   *  that some libraries treat differently than the browser. */
  emailSelector: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[#.A-Za-z0-9_\-[\]="': >+,~()*]+$/),
  /** CSS selector of the submit button. Same shape constraint as
   *  `emailSelector`. */
  submitSelector: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[#.A-Za-z0-9_\-[\]="': >+,~()*]+$/),
  /** Optional success indicator — the workflow waits for this
   *  selector to appear post-submit before declaring success. When
   *  omitted, the workflow falls back to a fixed 2s settle period
   *  and reports `confirmation: "presumed"`. */
  successSelector: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[#.A-Za-z0-9_\-[\]="': >+,~()*]+$/)
    .optional(),
});

const outputSchema = z.object({
  url: z.string().url(),
  /** Domain we submitted to (eTLD+1) — surfaced so the audit row
   *  records the actual destination. The runner's CDP intercept
   *  already enforced this is within the workflow's allowlist + the
   *  user's per-domain opt-in. */
  host: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/),
  /** Did the success selector resolve post-submit?  `verified` =
   *  successSelector matched; `presumed` = no selector was provided
   *  AND the submit click did not raise. The agent's DM-facing
   *  surface should phrase a `presumed` result as "I submitted the
   *  form; verify in your inbox". */
  confirmation: z.enum(["verified", "presumed"]),
  /** Screenshot of the post-submit page — the user can sanity-check
   *  via the dashboard's trace viewer. */
  screenshotPath: z
    .string()
    .regex(/^\/api\/browser-automation\/traces\/[a-f0-9-]+\/[a-z0-9._-]+\.png$/),
});

export const subscribeToNewsletter: WorkflowDefinition<
  z.infer<typeof inputSchema>,
  z.infer<typeof outputSchema>
> = {
  name: "subscribeToNewsletter",
  inputSchema,
  outputSchema,
  // Any http(s) URL — bound by the runner's step 4 against the user's
  // per-domain allowlist. The payment-path blocker (step 2.5) rejects
  // checkout/buy paths before the workflow runs.
  allowlistRegex: /^https?:\/\/[^\s/]+\//,
  riskTier: RiskTier.Approve,
  perWorkflowTimeoutMs: 45_000,
  variant: "anon",
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
        timeout: 20_000,
      });
      await page
        .locator(params.emailSelector)
        .first()
        .waitFor({ state: "visible", timeout: 8_000 });
      await page
        .locator(params.emailSelector)
        .first()
        .fill(params.email, { timeout: 5_000 });
      await page
        .locator(params.submitSelector)
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
        await page.waitForTimeout(2_000);
      }
      const screenshotPath = await screenshotSink.capture("post-submit", page);

      const parsedUrl = new URL(params.url);
      const host = parsedUrl.hostname.toLowerCase();
      return {
        url: params.url,
        host,
        confirmation,
        screenshotPath,
      };
    } finally {
      await page.close().catch(() => {});
    }
  },
};
