import { describe, expect, it } from "vitest";
import { z } from "zod";

import { RiskTier } from "../../../safety/risk-classifier.js";
import type { WorkflowDefinition } from "./types.js";
import {
  hashApprovalToken,
  type ApprovalRowView,
} from "./approval-tokens.js";
import {
  acquireSemaphoreSlot,
  checkPaymentPathBlock,
  checkUrlAndHostAllowlist,
  classifyRunFailure,
  extractPrimaryUrlFromParams,
  hashParams,
  resolveApprovalGate,
  resolveAuthSiteGate,
  validateWorkflowInput,
  validateWorkflowOutput,
  validationFailureToOutcome,
  WorkflowTimeoutError,
  withTimeout,
} from "./workflow-runner-utils.js";

const makeFakeDef = <I, O>(
  partial: Partial<WorkflowDefinition<I, O>> = {},
): WorkflowDefinition<I, O> => ({
  name: "fake",
  inputSchema: z.object({ url: z.string().url() }) as unknown as z.ZodType<I>,
  outputSchema: z.object({ ok: z.literal(true) }) as unknown as z.ZodType<O>,
  allowlistRegex: /^https:\/\/example\.com\//,
  riskTier: RiskTier.Autonomous,
  perWorkflowTimeoutMs: 5000,
  variant: "anon",
  async run() {
    return { ok: true } as unknown as O;
  },
  ...partial,
});

describe("workflow-runner-utils", () => {
  describe("hashParams", () => {
    it("produces a stable 16-char hex hash for equal inputs", () => {
      const a = hashParams({ url: "https://example.com/", n: 1 });
      const b = hashParams({ url: "https://example.com/", n: 1 });
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{16}$/);
    });

    it("differentiates different inputs", () => {
      expect(hashParams({ x: 1 })).not.toBe(hashParams({ x: 2 }));
    });

    it("falls back to String() for unserialisable inputs (circular)", () => {
      const a: Record<string, unknown> = {};
      a.self = a;
      expect(() => hashParams(a)).not.toThrow();
    });
  });

  describe("validateWorkflowInput", () => {
    it("returns the typed value on success", () => {
      const def = makeFakeDef();
      const r = validateWorkflowInput(def, "wfid", { url: "https://example.com/" });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.url).toBe("https://example.com/");
    });

    it("returns a structured input_validation_error result on failure", () => {
      const def = makeFakeDef();
      const r = validateWorkflowInput(def, "wfid", { url: "not a url" });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.result.status).toBe("input_validation_error");
        expect(r.result.workflowId).toBe("wfid");
        expect(r.result.validationErrors).toBeTruthy();
      }
    });
  });

  describe("extractPrimaryUrlFromParams", () => {
    it("reads .url first", () => {
      expect(extractPrimaryUrlFromParams({ url: "https://a" })).toBe("https://a");
    });
    it("falls back to .targetUrl", () => {
      expect(extractPrimaryUrlFromParams({ targetUrl: "https://b" })).toBe("https://b");
    });
    it("falls back to .searchUrl (used by searchAndAddToPersonalNotes)", () => {
      // Load-bearing regression test: a missing `searchUrl` branch
      // means the payment-path block (B-3 hard exclusion) is silently
      // bypassed for searchAndAddToPersonalNotes, since the runner
      // gates that block on `extractPrimaryUrlFromParams != null`.
      expect(
        extractPrimaryUrlFromParams({
          searchUrl: "https://www.amazon.co.jp/s?k=test",
        }),
      ).toBe("https://www.amazon.co.jp/s?k=test");
    });
    it("falls back to .urls[0]", () => {
      expect(extractPrimaryUrlFromParams({ urls: ["https://c"] })).toBe("https://c");
    });
    it("prefers .url when multiple candidate fields are present", () => {
      expect(
        extractPrimaryUrlFromParams({
          url: "https://a",
          targetUrl: "https://b",
          searchUrl: "https://c",
          urls: ["https://d"],
        }),
      ).toBe("https://a");
    });
    it("returns null when no URL-shaped field is present", () => {
      expect(extractPrimaryUrlFromParams({})).toBeNull();
      expect(extractPrimaryUrlFromParams(null)).toBeNull();
      expect(extractPrimaryUrlFromParams("str")).toBeNull();
      expect(extractPrimaryUrlFromParams({ urls: [42] })).toBeNull();
    });
  });

  describe("checkUrlAndHostAllowlist", () => {
    const def = { allowlistRegex: /^https:\/\/example\.com\// };
    const allow = (host: string): boolean => host === "example.com";

    it("returns ok+host when URL passes both gates", () => {
      const r = checkUrlAndHostAllowlist(def, "https://example.com/x", allow);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.host).toBe("example.com");
    });

    it("returns url_not_allowlisted when workflow regex misses", () => {
      const r = checkUrlAndHostAllowlist(def, "https://other.com/x", allow);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe("url_not_allowlisted");
    });

    it("returns user_allowlist_blocked when user has not opted in", () => {
      const r = checkUrlAndHostAllowlist(
        { allowlistRegex: /^https?:\/\// },
        "https://example.com/",
        () => false,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe("user_allowlist_blocked");
        if (r.status === "user_allowlist_blocked") {
          expect(r.detail.host).toBe("example.com");
        }
      }
    });

    it("returns host_not_extractable on malformed URL", () => {
      const r = checkUrlAndHostAllowlist(
        { allowlistRegex: /^/ },
        "https://",
        allow,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe("host_not_extractable");
    });

    it("returns host_not_extractable when URL parses but hostname is empty (file:// shape)", () => {
      // `new URL("file:///etc/passwd")` succeeds but `parsed.hostname`
      // is `""` — `extractEtldPlusOne` then returns "" and the
      // `!host` branch fires. Exercises a separate code path from the
      // malformed-URL case above (which goes through the `catch`).
      const r = checkUrlAndHostAllowlist(
        { allowlistRegex: /^/ },
        "file:///etc/passwd",
        allow,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe("host_not_extractable");
    });
  });

  describe("validateWorkflowOutput", () => {
    it("returns the typed value on success", () => {
      const def = makeFakeDef();
      const r = validateWorkflowOutput(def, "wfid", { ok: true });
      expect(r.ok).toBe(true);
    });
    it("returns output_validation_error on failure", () => {
      const def = makeFakeDef();
      const r = validateWorkflowOutput(def, "wfid", { ok: false });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.result.status).toBe("output_validation_error");
    });
  });

  describe("withTimeout + WorkflowTimeoutError", () => {
    it("resolves when the inner promise resolves first", async () => {
      const v = await withTimeout(Promise.resolve(42), 1000);
      expect(v).toBe(42);
    });

    it("rejects with WorkflowTimeoutError when the deadline elapses", async () => {
      await expect(
        withTimeout(new Promise(() => {}), 30),
      ).rejects.toBeInstanceOf(WorkflowTimeoutError);
    });

    it("propagates rejections from the inner promise", async () => {
      await expect(
        withTimeout(Promise.reject(new Error("boom")), 1000),
      ).rejects.toThrow("boom");
    });
  });

  describe("classifyRunFailure", () => {
    it("returns the dedicated timeout status for WorkflowTimeoutError", () => {
      const r = classifyRunFailure(new WorkflowTimeoutError(5000), "wfid");
      expect(r.status).toBe("timeout");
      if (r.status === "timeout") expect(r.workflowId).toBe("wfid");
    });

    it("folds Error instances into playwright_error with capped reason", () => {
      const long = new Error("x".repeat(500));
      const r = classifyRunFailure(long, "wfid");
      expect(r.status).toBe("playwright_error");
      if (r.status === "playwright_error") {
        expect(r.detail.reason.length).toBeLessThanOrEqual(200);
      }
    });

    it("folds non-Error throws into playwright_error too", () => {
      const r = classifyRunFailure("just a string", "wfid");
      expect(r.status).toBe("playwright_error");
      if (r.status === "playwright_error") {
        expect(r.detail.reason).toBe("just a string");
      }
    });
  });

  describe("resolveAuthSiteGate", () => {
    const allowlistAmazonJp = /^https?:\/\/(www\.)?amazon\.co\.jp\/your-orders/;
    const allowlistDisjoint = /^https?:\/\/example\.com\//;
    const now = 1_700_000_000_000;

    it("accepts a known site with valid allowlist + fresh connection", () => {
      const r = resolveAuthSiteGate({
        siteKey: "amazon_jp",
        allowlistRegex: allowlistAmazonJp,
        connection: { connectedAt: now - 10 * 24 * 60 * 60 * 1000, lastWorkflowAt: null },
        nowMs: now,
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.site.siteKey).toBe("amazon_jp");
    });

    it("rejects an unknown siteKey", () => {
      const r = resolveAuthSiteGate({
        siteKey: "not_a_site",
        allowlistRegex: allowlistAmazonJp,
        connection: null,
        nowMs: now,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe("unknown_site");
        expect(r.siteKey).toBe("not_a_site");
      }
    });

    it("rejects when allowlistRegex is not a subset of the site pattern", () => {
      const r = resolveAuthSiteGate({
        siteKey: "amazon_jp",
        allowlistRegex: allowlistDisjoint,
        connection: { connectedAt: now, lastWorkflowAt: null },
        nowMs: now,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe("allowlist_not_subset");
    });

    it("rejects when no connection record exists", () => {
      const r = resolveAuthSiteGate({
        siteKey: "amazon_jp",
        allowlistRegex: allowlistAmazonJp,
        connection: null,
        nowMs: now,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe("site_not_connected");
    });

    it("rejects when the connection is older than sessionMaxAgeDays", () => {
      const r = resolveAuthSiteGate({
        siteKey: "amazon_jp", // sessionMaxAgeDays = 90
        allowlistRegex: allowlistAmazonJp,
        connection: {
          connectedAt: now - 100 * 24 * 60 * 60 * 1000,
          lastWorkflowAt: null,
        },
        nowMs: now,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe("site_not_connected");
    });
  });

  describe("acquireSemaphoreSlot", () => {
    it("serialises callers: the second cannot enter until the first releases", async () => {
      // Two consecutive `acquireSemaphoreSlot` calls share the chain
      // pointer the way the production code does: snapshot the
      // current slot, swap in the returned `nextSlot`. With the prior
      // broken `takeSlot()` this test would resolve A and B in
      // parallel; the new helper enforces the FIFO.
      let slot: Promise<unknown> = Promise.resolve();
      const order: string[] = [];

      const a = acquireSemaphoreSlot(slot);
      slot = a.nextSlot;
      const b = acquireSemaphoreSlot(slot);
      slot = b.nextSlot;

      const aRan = (async () => {
        await a.acquire.wait;
        order.push("a-start");
        // Yield once to give B a chance to incorrectly enter.
        await new Promise<void>((r) => setTimeout(r, 5));
        order.push("a-end");
        a.acquire.release();
      })();

      const bRan = (async () => {
        await b.acquire.wait;
        order.push("b-start");
        b.acquire.release();
      })();

      await Promise.all([aRan, bRan]);
      expect(order).toEqual(["a-start", "a-end", "b-start"]);
    });

    it("release is idempotent — calling twice does not unblock an extra caller", async () => {
      let slot: Promise<unknown> = Promise.resolve();
      const a = acquireSemaphoreSlot(slot);
      slot = a.nextSlot;
      const b = acquireSemaphoreSlot(slot);
      slot = b.nextSlot;
      await a.acquire.wait;
      a.acquire.release();
      a.acquire.release(); // second release is a no-op (idempotent)
      // B should still wake up cleanly.
      await expect(b.acquire.wait).resolves.toBeUndefined();
      b.acquire.release();
    });

    it("a rejected prior chain still lets the next caller proceed", async () => {
      // If a buggy holder leaves its slot in a rejected state, the
      // chain must not poison subsequent callers — the helper swallows
      // the upstream rejection so the FIFO survives transient errors.
      const slot: Promise<unknown> = Promise.reject(new Error("prior boom"));
      // Suppress the unhandled-rejection warning from the test runner.
      slot.catch(() => {});
      const a = acquireSemaphoreSlot(slot);
      await expect(a.acquire.wait).resolves.toBeUndefined();
      a.acquire.release();
    });
  });

  // ── Phase B-3 helpers ─────────────────────────────────────────────
  describe("checkPaymentPathBlock", () => {
    it("returns null for non-purchase workflows on safe URLs", () => {
      expect(
        checkPaymentPathBlock(
          { variant: "anon" },
          "https://example.com/products",
        ),
      ).toBeNull();
    });

    it("returns the match for non-purchase workflows on payment URLs", () => {
      const m = checkPaymentPathBlock(
        { variant: "auth" },
        "https://example.com/checkout",
      );
      expect(m?.category).toBe("checkout");
    });

    it("returns null for purchase-variant workflows regardless of URL", () => {
      expect(
        checkPaymentPathBlock(
          { variant: "purchase" },
          "https://example.com/checkout",
        ),
      ).toBeNull();
    });
  });

  describe("validationFailureToOutcome", () => {
    it("maps 'expired' to approval_expired", () => {
      expect(
        validationFailureToOutcome({ ok: false, reason: "expired" }),
      ).toBe("approval_expired");
    });

    it("folds every non-expiry failure into approval_token_invalid", () => {
      const reasons = [
        "token_shape_invalid",
        "row_not_found",
        "workflow_mismatch",
        "params_mismatch",
        "hash_mismatch",
      ] as const;
      for (const reason of reasons) {
        expect(
          validationFailureToOutcome({ ok: false, reason }),
        ).toBe("approval_token_invalid");
      }
    });

    it("folds wrong_status into approval_token_invalid", () => {
      expect(
        validationFailureToOutcome({
          ok: false,
          reason: "wrong_status",
          actualStatus: "consumed",
        }),
      ).toBe("approval_token_invalid");
    });
  });

  describe("resolveApprovalGate", () => {
    const baseRow: ApprovalRowView = {
      id: "approval-id",
      workflowName: "subscribeToNewsletter",
      paramsHash: "deadbeefcafebabe",
      status: "approved",
      expiresAt: 9_999_999_999,
      tokenHash: hashApprovalToken("00112233445566778899aabbccddeeff"),
    };

    it("returns not_required for purchase variant", () => {
      const r = resolveApprovalGate({
        workflowDef: {
          name: "x",
          variant: "purchase",
          riskTier: RiskTier.Approve,
        },
        workflowName: "x",
        paramsHash: "abc",
        approvalToken: undefined,
        row: null,
        nowMs: 0,
      });
      expect(r.kind).toBe("not_required");
    });

    it("returns not_required for non-Approve tier", () => {
      const r = resolveApprovalGate({
        workflowDef: {
          name: "x",
          variant: "anon",
          riskTier: RiskTier.Autonomous,
        },
        workflowName: "x",
        paramsHash: "abc",
        approvalToken: undefined,
        row: null,
        nowMs: 0,
      });
      expect(r.kind).toBe("not_required");
    });

    it("returns missing_token when Approve-tier and no token", () => {
      const r = resolveApprovalGate({
        workflowDef: {
          name: "subscribeToNewsletter",
          variant: "anon",
          riskTier: RiskTier.Approve,
        },
        workflowName: "subscribeToNewsletter",
        paramsHash: "abc",
        approvalToken: undefined,
        row: null,
        nowMs: 0,
      });
      expect(r.kind).toBe("missing_token");
    });

    it("returns validation_failed for malformed token", () => {
      const r = resolveApprovalGate({
        workflowDef: {
          name: "subscribeToNewsletter",
          variant: "anon",
          riskTier: RiskTier.Approve,
        },
        workflowName: "subscribeToNewsletter",
        paramsHash: baseRow.paramsHash,
        approvalToken: "not-32-hex",
        row: baseRow,
        nowMs: 0,
      });
      expect(r.kind).toBe("validation_failed");
      if (r.kind === "validation_failed") {
        expect(r.failure.reason).toBe("token_shape_invalid");
      }
    });

    it("returns validated for a correctly-bound token + row", () => {
      const r = resolveApprovalGate({
        workflowDef: {
          name: baseRow.workflowName,
          variant: "anon",
          riskTier: RiskTier.Approve,
        },
        workflowName: baseRow.workflowName,
        paramsHash: baseRow.paramsHash,
        approvalToken: "00112233445566778899aabbccddeeff",
        row: baseRow,
        nowMs: 0,
      });
      expect(r.kind).toBe("validated");
      if (r.kind === "validated") {
        expect(r.row.id).toBe(baseRow.id);
      }
    });

    it("returns validation_failed with expired reason when nowMs > expiresAt", () => {
      const r = resolveApprovalGate({
        workflowDef: {
          name: baseRow.workflowName,
          variant: "anon",
          riskTier: RiskTier.Approve,
        },
        workflowName: baseRow.workflowName,
        paramsHash: baseRow.paramsHash,
        approvalToken: "00112233445566778899aabbccddeeff",
        row: baseRow,
        nowMs: baseRow.expiresAt + 1,
      });
      expect(r.kind).toBe("validation_failed");
      if (r.kind === "validation_failed") {
        expect(r.failure.reason).toBe("expired");
      }
    });
  });
});
