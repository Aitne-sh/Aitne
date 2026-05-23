import { describe, expect, it } from "vitest";
import { z } from "zod";

import { RiskTier } from "../../../../safety/risk-classifier.js";
import {
  getSite,
  isAllowlistSubsetOfSitePattern,
} from "../site-registry.js";
import type { WorkflowDefinition } from "../types.js";
import { workflowDeclarationIsConsistent } from "../types.js";
import {
  getWorkflow,
  listWorkflows,
  validateWorkflowRegistry,
  WORKFLOWS,
} from "./registry.js";

const makeFakeDef = (
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition => ({
  name: "fakeWorkflow",
  inputSchema: z.object({}) as z.ZodType<unknown>,
  outputSchema: z.object({}) as z.ZodType<unknown>,
  allowlistRegex: /^/,
  riskTier: RiskTier.Autonomous,
  perWorkflowTimeoutMs: 10_000,
  variant: "anon",
  async run() {
    return {};
  },
  ...overrides,
});

describe("workflows/registry", () => {
  it("freezes the registry object so the LLM cannot mutate it at runtime", () => {
    expect(Object.isFrozen(WORKFLOWS)).toBe(true);
  });

  it("exposes the B-2 + B-2.5 + B-3 + B-4 workflows", () => {
    const names = listWorkflows().map((d) => d.name).sort();
    expect(names).toEqual([
      "confirmCartCheckout",
      "extractNewsArticle",
      "fillAndSaveForm",
      "getAmazonPurchaseHistory",
      "getPagePlainText",
      "screenshotPage",
      "searchAndAddToPersonalNotes",
      "subscribeToNewsletter",
    ].sort());
  });

  it("getWorkflow returns the right def by name", () => {
    const def = getWorkflow("screenshotPage");
    expect(def?.name).toBe("screenshotPage");
  });

  it("getWorkflow returns null for an unknown name (no exception)", () => {
    expect(getWorkflow("notARealWorkflow")).toBeNull();
    // Defence: also resilient against prototype-pollution attempts.
    expect(getWorkflow("__proto__")).toBeNull();
    expect(getWorkflow("constructor")).toBeNull();
  });

  it("every registered workflow passes the declaration consistency check", () => {
    for (const def of listWorkflows()) {
      expect(workflowDeclarationIsConsistent(def)).toBe(true);
    }
  });

  it("every registered workflow has a valid name + non-trivial timeout", () => {
    for (const def of listWorkflows()) {
      expect(def.name).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/);
      expect(def.perWorkflowTimeoutMs).toBeGreaterThanOrEqual(1000);
      expect(def.perWorkflowTimeoutMs).toBeLessThanOrEqual(600_000);
    }
  });

  it("every anon-variant workflow ships without a siteKey", () => {
    for (const def of listWorkflows()) {
      if (def.variant === "anon") {
        expect(def.siteKey).toBeUndefined();
      }
    }
  });

  it("every auth-variant workflow resolves its siteKey in the site registry", () => {
    for (const def of listWorkflows()) {
      if (def.variant === "auth") {
        expect(def.siteKey).toBeTruthy();
        expect(getSite(def.siteKey as string)).not.toBeNull();
      }
    }
  });

  it("every auth-variant workflow's allowlistRegex is a subset of its site's allowedHostPattern", () => {
    for (const def of listWorkflows()) {
      if (def.variant === "auth") {
        const site = getSite(def.siteKey as string);
        expect(site).not.toBeNull();
        if (site) {
          expect(
            isAllowlistSubsetOfSitePattern(
              def.allowlistRegex,
              site.allowedHostPattern,
            ),
          ).toBe(true);
        }
      }
    }
  });

  it("every auth-variant workflow declares at least RiskTier.ReadSensitive", () => {
    for (const def of listWorkflows()) {
      if (def.variant === "auth") {
        expect(def.riskTier).not.toBe(RiskTier.Autonomous);
      }
    }
  });
});

describe("validateWorkflowRegistry (failure branches)", () => {
  it("accepts a registry whose entries pass every invariant", () => {
    expect(() => validateWorkflowRegistry([makeFakeDef()])).not.toThrow();
  });

  it("throws on declaration inconsistency (auth without siteKey)", () => {
    const bogus = makeFakeDef({ variant: "auth" });
    expect(() => validateWorkflowRegistry([bogus])).toThrowError(
      /declaration for "fakeWorkflow" is inconsistent/,
    );
  });

  it("throws on naming-convention violation", () => {
    const bogus = makeFakeDef({ name: "1starts-with-digit" });
    expect(() => validateWorkflowRegistry([bogus])).toThrowError(
      /name "1starts-with-digit" violates naming convention/,
    );
  });

  it("throws on per-workflow timeout below the 1 s floor", () => {
    const bogus = makeFakeDef({ perWorkflowTimeoutMs: 100 });
    expect(() => validateWorkflowRegistry([bogus])).toThrowError(
      /perWorkflowTimeoutMs out of range/,
    );
  });

  it("throws on per-workflow timeout above the 10 min ceiling", () => {
    const bogus = makeFakeDef({ perWorkflowTimeoutMs: 999_999 });
    expect(() => validateWorkflowRegistry([bogus])).toThrowError(
      /perWorkflowTimeoutMs out of range/,
    );
  });

  it("throws when an auth workflow references an unknown siteKey", () => {
    const bogus = makeFakeDef({
      variant: "auth",
      siteKey: "not_a_real_site",
      riskTier: RiskTier.ReadSensitive,
    });
    expect(() => validateWorkflowRegistry([bogus])).toThrowError(
      /references unknown siteKey/,
    );
  });

  it("throws when an auth workflow's allowlist is not a subset of its site pattern", () => {
    const bogus = makeFakeDef({
      variant: "auth",
      siteKey: "amazon_jp",
      riskTier: RiskTier.ReadSensitive,
      allowlistRegex: /^https?:\/\/example\.com\//,
    });
    expect(() => validateWorkflowRegistry([bogus])).toThrowError(
      /allowlistRegex is not a subset/,
    );
  });

  it("throws when an auth workflow declares Autonomous risk tier", () => {
    const bogus = makeFakeDef({
      variant: "auth",
      siteKey: "amazon_jp",
      riskTier: RiskTier.Autonomous,
      allowlistRegex: /^https?:\/\/(www\.)?amazon\.co\.jp\//,
    });
    expect(() => validateWorkflowRegistry([bogus])).toThrowError(
      /cannot declare RiskTier.Autonomous/,
    );
  });

  it("throws when an auth workflow's allowlist does not cover the site's profileVerifyUrl", () => {
    // amazon_jp.profileVerifyUrl is /gp/your-account; an allowlist that
    // covers only /your-orders would deny the post-run signed-in probe
    // (§16.6 #2) at the CDP layer, silently losing the session-expiry
    // signal. The validator must reject the misshape at daemon boot.
    const bogus = makeFakeDef({
      variant: "auth",
      siteKey: "amazon_jp",
      riskTier: RiskTier.ReadSensitive,
      allowlistRegex: /^https?:\/\/(www\.)?amazon\.co\.jp\/your-orders/,
    });
    expect(() => validateWorkflowRegistry([bogus])).toThrowError(
      /must cover site "amazon_jp" profileVerifyUrl/,
    );
  });

  it("accepts a well-shaped auth workflow whose allowlist covers profileVerifyUrl", () => {
    const fine = makeFakeDef({
      variant: "auth",
      siteKey: "amazon_jp",
      riskTier: RiskTier.ReadSensitive,
      allowlistRegex: /^https?:\/\/(www\.)?amazon\.co\.jp\/(your-orders|gp\/your-account|gp\/css\/order-history)/,
    });
    expect(() => validateWorkflowRegistry([fine])).not.toThrow();
  });

  // ── Phase B-3 invariants (§10 / §13 step 46) ─────────────────────
  it("throws when a workflow's allowlistRegex covers /checkout (payment path)", () => {
    const bogus = makeFakeDef({
      variant: "anon",
      riskTier: RiskTier.Approve,
      allowlistRegex: /^https?:\/\/example\.com\/checkout\//,
    });
    expect(() => validateWorkflowRegistry([bogus])).toThrowError(
      /payment-path category "checkout"/,
    );
  });

  it("throws when a workflow's allowlistRegex covers /buy (payment path)", () => {
    const bogus = makeFakeDef({
      variant: "anon",
      riskTier: RiskTier.Approve,
      allowlistRegex: /^https?:\/\/example\.com\/buy/,
    });
    expect(() => validateWorkflowRegistry([bogus])).toThrowError(
      /payment-path category "buy"/,
    );
  });

  it("throws when a workflow's allowlistRegex covers /place-order", () => {
    const bogus = makeFakeDef({
      variant: "anon",
      riskTier: RiskTier.Approve,
      allowlistRegex: /^https?:\/\/example\.com\/place-order/,
    });
    expect(() => validateWorkflowRegistry([bogus])).toThrowError(
      /payment-path category "place-order"/,
    );
  });

  it("throws when a workflow's allowlistRegex covers /payment", () => {
    const bogus = makeFakeDef({
      variant: "anon",
      riskTier: RiskTier.Approve,
      allowlistRegex: /^https?:\/\/example\.com\/payment\//,
    });
    expect(() => validateWorkflowRegistry([bogus])).toThrowError(
      /payment-path category "payment"/,
    );
  });

  it("throws when a workflow's allowlistRegex covers /place-bid", () => {
    const bogus = makeFakeDef({
      variant: "anon",
      riskTier: RiskTier.Approve,
      allowlistRegex: /^https?:\/\/example\.com\/place-bid/,
    });
    expect(() => validateWorkflowRegistry([bogus])).toThrowError(
      /payment-path category "place-bid"/,
    );
  });

  it("accepts a well-formed Approve-tier purchase variant (B-4 shipped)", () => {
    // Plan §17.5 confirmCartCheckout shape — variant=purchase, Approve
    // tier, siteKey resolves in SITE_REGISTRY, allowlist subset of
    // site pattern, 6-min timeout within [5min, 10min].
    const ok = makeFakeDef({
      variant: "purchase",
      siteKey: "amazon_jp",
      riskTier: RiskTier.Approve,
      allowlistRegex:
        /^https?:\/\/(www\.)?amazon\.co\.jp\/(gp\/cart|gp\/buy|checkout)/,
      perWorkflowTimeoutMs: 6 * 60 * 1000,
    });
    expect(() => validateWorkflowRegistry([ok])).not.toThrow();
  });

  it("throws when a purchase variant is registered with a non-Approve tier (commits money)", () => {
    const bogus = makeFakeDef({
      variant: "purchase",
      siteKey: "amazon_jp",
      riskTier: RiskTier.ReadSensitive,
      allowlistRegex:
        /^https?:\/\/(www\.)?amazon\.co\.jp\/(gp\/cart|gp\/buy|checkout)/,
      perWorkflowTimeoutMs: 6 * 60 * 1000,
    });
    expect(() => validateWorkflowRegistry([bogus])).toThrowError(
      /purchase-variant workflow .* must declare RiskTier\.Approve/,
    );
  });

  it("throws when a purchase variant references an unknown siteKey", () => {
    const bogus = makeFakeDef({
      variant: "purchase",
      siteKey: "unknown_site",
      riskTier: RiskTier.Approve,
      allowlistRegex: /^https?:\/\/example\.com\/checkout/,
      perWorkflowTimeoutMs: 6 * 60 * 1000,
    });
    expect(() => validateWorkflowRegistry([bogus])).toThrowError(
      /unknown siteKey "unknown_site"/,
    );
  });

  it("throws when a purchase variant declares perWorkflowTimeoutMs outside the 5–10 min band", () => {
    const tooShort = makeFakeDef({
      variant: "purchase",
      siteKey: "amazon_jp",
      riskTier: RiskTier.Approve,
      allowlistRegex:
        /^https?:\/\/(www\.)?amazon\.co\.jp\/(gp\/cart|gp\/buy|checkout)/,
      perWorkflowTimeoutMs: 60_000,
    });
    expect(() => validateWorkflowRegistry([tooShort])).toThrowError(
      /perWorkflowTimeoutMs must be between 5 and 10 minutes/,
    );
  });

  it("throws when a purchase variant allowlist is not a subset of site pattern", () => {
    const bogus = makeFakeDef({
      variant: "purchase",
      siteKey: "amazon_jp",
      riskTier: RiskTier.Approve,
      // Refers to amazon.com (US), but siteKey is amazon_jp.
      allowlistRegex: /^https?:\/\/(www\.)?amazon\.com\/checkout/,
      perWorkflowTimeoutMs: 6 * 60 * 1000,
    });
    expect(() => validateWorkflowRegistry([bogus])).toThrowError(
      /allowlistRegex is not a subset of site "amazon_jp"/,
    );
  });

  // Defensive: if a future PR widens WorkflowVariant without updating the
  // registry's Approve-tier shape check, boot must fail loudly rather than
  // silently let an unrecognised variant ship at Approve risk. Cast forces
  // the unknown variant past the type system; siteKey is set so the
  // earlier consistency check (anon → no siteKey; else → siteKey) passes.
  it("throws when an Approve-tier workflow declares an unrecognised variant", () => {
    const bogus = {
      ...makeFakeDef({
        riskTier: RiskTier.Approve,
        siteKey: "amazon_jp",
        allowlistRegex: /^https?:\/\/example\.com\/anything/,
      }),
      variant: "future-variant",
    } as unknown as WorkflowDefinition;
    expect(() => validateWorkflowRegistry([bogus])).toThrowError(
      /must declare variant 'anon', 'auth', or 'purchase'/,
    );
  });
});
