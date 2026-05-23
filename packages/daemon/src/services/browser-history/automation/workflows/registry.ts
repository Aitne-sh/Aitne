/**
 * Workflow registry — Phase B-2.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §5.6 / §8.3.
 *
 * `Object.freeze`d at module load — the LLM cannot define new workflows
 * at runtime, period. Adding a workflow is a 1-line edit here plus a
 * new file under `./<name>.ts`, both reviewed in code review.
 *
 * `getWorkflow(name)` returns null on miss so the API route can render
 * a 404 with the canonical "unknown_workflow" outcome instead of
 * throwing. `listWorkflows()` powers the
 * `GET /api/browser-automation/workflows` endpoint and the dashboard's
 * "available workflows" panel.
 *
 * Lives in the covered set — the consistency test (workflow names
 * unique, registry frozen, every declaration passes
 * `workflowDeclarationIsConsistent`) is the structural guarantee.
 */

import { listPaymentPathPatterns } from "../payment-path-blocker.js";
import {
  getSite,
  isAllowlistSubsetOfSitePattern,
} from "../site-registry.js";
import {
  type WorkflowDefinition,
  workflowDeclarationIsConsistent,
} from "../types.js";
import { confirmCartCheckout } from "./confirm-cart-checkout.js";
import { extractNewsArticle } from "./extract-news-article.js";
import { fillAndSaveForm } from "./fill-and-save-form.js";
import { getAmazonPurchaseHistory } from "./get-amazon-purchase-history.js";
import { getPagePlainText } from "./get-page-plain-text.js";
import { screenshotPage } from "./screenshot-page.js";
import { searchAndAddToPersonalNotes } from "./search-and-add-to-personal-notes.js";
import { subscribeToNewsletter } from "./subscribe-to-newsletter.js";
import { RiskTier } from "../../../../safety/risk-classifier.js";

const REGISTRY_ENTRIES: ReadonlyArray<WorkflowDefinition> = Object.freeze([
  // Phase B-2 — read-only.
  extractNewsArticle as unknown as WorkflowDefinition,
  getPagePlainText as unknown as WorkflowDefinition,
  screenshotPage as unknown as WorkflowDefinition,
  // Phase B-2.5 — authenticated read.
  getAmazonPurchaseHistory as unknown as WorkflowDefinition,
  // Phase B-3 — gated writes.
  subscribeToNewsletter as unknown as WorkflowDefinition,
  fillAndSaveForm as unknown as WorkflowDefinition,
  searchAndAddToPersonalNotes as unknown as WorkflowDefinition,
  // Phase B-4 — experimental purchase. Behind the DM-token gate
  // enforced inside `purchase-handler.issueToken`; the registry-level
  // structural check below ensures every shipping purchase workflow
  // carries `variant: "purchase"` + a registered `siteKey`.
  confirmCartCheckout as unknown as WorkflowDefinition,
]);

const REGISTRY: Readonly<Record<string, WorkflowDefinition>> = Object.freeze(
  Object.fromEntries(REGISTRY_ENTRIES.map((def) => [def.name, def])),
);

export const WORKFLOWS: Readonly<Record<string, WorkflowDefinition>> = REGISTRY;

export function getWorkflow(name: string): WorkflowDefinition | null {
  if (!Object.prototype.hasOwnProperty.call(REGISTRY, name)) return null;
  return REGISTRY[name];
}

export function listWorkflows(): readonly WorkflowDefinition[] {
  return REGISTRY_ENTRIES;
}

/**
 * Validate every entry in the registry against the structural
 * invariants. Throws on the first violation so daemon boot fails fast
 * rather than landing a misshapen workflow in production. Exported so
 * the peer test can exercise each throw branch with bogus inputs (the
 * production loop below covers the happy path on every module load).
 */
export function validateWorkflowRegistry(
  entries: ReadonlyArray<WorkflowDefinition>,
): void {
  for (const def of entries) {
    if (!workflowDeclarationIsConsistent(def)) {
      throw new Error(
        `workflow registry: declaration for "${def.name}" is inconsistent ` +
          `(variant=${def.variant} siteKey=${String(def.siteKey)})`,
      );
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(def.name)) {
      throw new Error(
        `workflow registry: name "${def.name}" violates naming convention`,
      );
    }
    if (def.perWorkflowTimeoutMs < 1000 || def.perWorkflowTimeoutMs > 600_000) {
      throw new Error(
        `workflow registry: perWorkflowTimeoutMs out of range for "${def.name}"`,
      );
    }
    if (def.variant === "auth") {
      // §16.4 — every auth workflow's siteKey must resolve in the
      // site registry, and the workflow's allowlistRegex must be a
      // string-prefix subset of the site's allowedHostPattern.
      // workflowDeclarationIsConsistent already enforced a non-empty
      // siteKey on the auth branch, so we know it's a string here.
      const site = getSite(def.siteKey as string);
      if (!site) {
        throw new Error(
          `workflow registry: auth workflow "${def.name}" references unknown ` +
            `siteKey "${def.siteKey}"`,
        );
      }
      if (!isAllowlistSubsetOfSitePattern(def.allowlistRegex, site.allowedHostPattern)) {
        throw new Error(
          `workflow registry: auth workflow "${def.name}" allowlistRegex is not ` +
            `a subset of site "${def.siteKey}" allowedHostPattern`,
        );
      }
      // §16.6 #2 — the post-run signed-in re-check in
      // `workflow-runner.ts:probeSignedInOnContext` navigates to
      // `site.profileVerifyUrl` on the workflow's context. The
      // CDP-route interception is gated by the workflow's
      // `allowlistRegex`; if the regex does not cover
      // `profileVerifyUrl` the probe is silently denied and the
      // session-expiry signal is lost. Enforce here so a new auth
      // workflow that narrows its allowlist too aggressively fails
      // daemon boot.
      if (!def.allowlistRegex.test(site.profileVerifyUrl)) {
        throw new Error(
          `workflow registry: auth workflow "${def.name}" allowlistRegex must ` +
            `cover site "${def.siteKey}" profileVerifyUrl ` +
            `(${site.profileVerifyUrl}) so the post-run signed-in probe ` +
            `(§16.6) can navigate without being denied by the CDP ` +
            `interception layer`,
        );
      }
      // §16.5 — authenticated workflows are at minimum ReadSensitive.
      if (def.riskTier === RiskTier.Autonomous) {
        throw new Error(
          `workflow registry: auth workflow "${def.name}" cannot declare ` +
            `RiskTier.Autonomous — minimum tier for auth-variant workflows is ` +
            `ReadSensitive (§16.5)`,
        );
      }
    }

    // ── Phase B-4 structural rules — run BEFORE the B-3 payment-path
    // scan so purchase variants can carry `/checkout` etc. in their
    // allowlist legitimately.
    // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17 / §13 step 58.
    //
    // Every purchase-variant workflow MUST:
    //   - declare `riskTier === RiskTier.Approve` (commits money);
    //   - declare a `siteKey` that resolves in the frozen
    //     `SITE_REGISTRY`;
    //   - declare an `allowlistRegex` that is a string-prefix subset
    //     of the site's `allowedHostPattern` (same subset check as
    //     auth variants);
    //   - declare a `perWorkflowTimeoutMs` between 5 and 10 minutes
    //     (the DM-wait window + navigation budget).
    if (def.variant === "purchase") {
      if (def.riskTier !== RiskTier.Approve) {
        throw new Error(
          `workflow registry: purchase-variant workflow "${def.name}" must ` +
            `declare RiskTier.Approve (commits money). riskTier=${def.riskTier} ` +
            `is not permitted.`,
        );
      }
      const site = getSite(def.siteKey as string);
      if (!site) {
        throw new Error(
          `workflow registry: purchase-variant workflow "${def.name}" references ` +
            `unknown siteKey "${def.siteKey}".`,
        );
      }
      if (!isAllowlistSubsetOfSitePattern(def.allowlistRegex, site.allowedHostPattern)) {
        throw new Error(
          `workflow registry: purchase-variant workflow "${def.name}" allowlistRegex ` +
            `is not a subset of site "${def.siteKey}" allowedHostPattern.`,
        );
      }
      if (def.perWorkflowTimeoutMs < 5 * 60 * 1000 ||
          def.perWorkflowTimeoutMs > 10 * 60 * 1000) {
        throw new Error(
          `workflow registry: purchase-variant workflow "${def.name}" ` +
            `perWorkflowTimeoutMs must be between 5 and 10 minutes (got ` +
            `${def.perWorkflowTimeoutMs}ms). The DM-wait window is 5 min + ` +
            `navigation budget; outside this range either the user-reply ` +
            `polling deadlocks or the workflow holds a purchase context ` +
            `longer than the operational ceiling.`,
        );
      }
      // Skip the B-3 payment-path scan + the trailing Approve/variant
      // shape check — both are B-3 invariants the purchase variant
      // intentionally relaxes.
      continue;
    }

    // ── Phase B-3 structural rules ──
    // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §10 / §13 step 46.
    //
    // A workflow's allowlistRegex must NOT match any payment-path
    // pattern — otherwise the runtime payment-path blocker would
    // never see those URLs (the allowlist gate would short-circuit on
    // url_not_allowlisted before the payment block kicked in is the
    // wrong-way assertion; in fact the payment block runs BEFORE the
    // allowlist, so technically nothing leaks. BUT a workflow that
    // declares `allowlistRegex` covering /checkout signals an intent
    // mismatch — the developer thought writes were permitted there.
    // Fail boot to surface the misdeclaration.
    const allowlistSource = def.allowlistRegex.source
      .toLowerCase()
      .replace(/\\\//g, "/");
    for (const { category, pattern } of listPaymentPathPatterns()) {
      // We approximate "the workflow's allowlist source mentions a
      // payment-path keyword" by stripping the boundary group and
      // case-insensitively scanning for the bare category name.
      const keyword = category.replace(/-/g, "[-_]?");
      const probe = new RegExp(`/${keyword}(?:/|$|\\?|#|\\\\)`, "i");
      // Skip the actual payment pattern object (probe is reconstructed
      // here just so the lint mirrors the runtime blocker's shape).
      void pattern;
      if (probe.test(allowlistSource)) {
        throw new Error(
          `workflow registry: workflow "${def.name}" allowlistRegex covers ` +
            `the payment-path category "${category}" — payment surfaces are ` +
            `B-4 territory (§10 / §17), not B-3. Either narrow the allowlist ` +
            `or ship the workflow as a purchase-variant entry behind the ` +
            `DM-token gate.`,
        );
      }
    }

    // Approve-tier workflows are B-3 writes (anon / auth) OR B-4
    // purchase. Reject any other variant shape so a future variant
    // addition lands behind an explicit registry edit.
    if (
      def.riskTier === RiskTier.Approve &&
      def.variant !== "anon" &&
      def.variant !== "auth" &&
      def.variant !== "purchase"
    ) {
      throw new Error(
        `workflow registry: Approve-tier workflow "${def.name}" must declare ` +
          `variant 'anon', 'auth', or 'purchase'. variant='${def.variant}' ` +
          `is not recognised.`,
      );
    }

  }
}

// Compile-time assertion (run at module load): every shipped entry passes
// the consistency check. A misshapen workflow throws here, surfacing as
// a daemon-boot failure — that's the right blast radius for a broken
// registry.
validateWorkflowRegistry(REGISTRY_ENTRIES);
