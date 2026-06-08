import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import {
  B4_DEFAULT_DAILY_SPEND_CAP_MINOR,
  B4_DEFAULT_DAILY_TOKEN_CAP,
} from "../services/browser-history/managed-chromium/types.js";
import { upsertSiteB4Config } from "./browser-automation-b4-config-store.js";
import {
  cancelPurchaseToken,
  consumePurchaseToken,
  defaultSiteB4Config,
  expireStalePurchaseTokens,
  finalizePurchaseToken,
  getPurchaseTokenByJti,
  getPurchaseTokenByRaw,
  getPurchaseTokenByTail,
  issuePurchaseToken,
  listPendingPurchaseTokens,
  listPendingTokensForChannel,
  listRecentPurchaseTokens,
  scrubRotatedPurchaseTokens,
  sweepOrphanedConsumedPurchaseTokens,
  type IssuePurchaseTokenInput,
} from "./browser-automation-purchase-tokens-store.js";

let db: Database.Database;

function enableSite(
  siteKey: string,
  opts: {
    currency?: string;
    dailyTokenCap?: number;
    dailySpendCapMinor?: number;
    perTxCapMinorOverride?: number | null;
    enabled?: boolean;
  } = {},
): void {
  upsertSiteB4Config(db, {
    siteKey,
    enabled: opts.enabled ?? true,
    currency: opts.currency ?? "USD",
    dailyTokenCap: opts.dailyTokenCap ?? 10,
    dailySpendCapMinor: opts.dailySpendCapMinor ?? 1_000_000,
    perTxCapMinorOverride: opts.perTxCapMinorOverride ?? null,
    updatedAt: 1,
  });
}

function issueInput(overrides: Partial<IssuePurchaseTokenInput> = {}): IssuePurchaseTokenInput {
  return {
    jti: overrides.jti ?? "jti-1",
    token: "!~aaaaaaaa",
    workflowInvocationId: "wf-1",
    siteKey: "shop",
    urlPattern: "https://shop.example/checkout",
    maxAmountMinor: 5000,
    currency: "USD",
    preScreenshotPath: "shop/pre.png",
    notesForUser: "confirm purchase",
    deliveredChannels: ["slack:C1"],
    issuedAt: 1_000_000,
    expiresAt: 1_000_000 + 5 * 60_000,
    ...overrides,
  };
}

/** Convenience: issue and assert success, returning the row. */
function issueOk(overrides: Partial<IssuePurchaseTokenInput> = {}) {
  const res = issuePurchaseToken(db, issueInput(overrides));
  if (!res.ok) throw new Error(`expected ok issuance, got ${res.reason}`);
  return res.row;
}

beforeEach(() => {
  db = new Database(":memory:");
  applySchema(db);
});

afterEach(() => {
  db.close();
});

describe("issuePurchaseToken — gates", () => {
  it("rejects when the site has no config row", () => {
    expect(issuePurchaseToken(db, issueInput())).toEqual({ ok: false, reason: "site_not_enabled" });
  });

  it("rejects when the site config is present but disabled", () => {
    enableSite("shop", { enabled: false });
    expect(issuePurchaseToken(db, issueInput())).toEqual({ ok: false, reason: "site_not_enabled" });
  });

  it("issues a pending token on the happy path and round-trips it", () => {
    enableSite("shop");
    const row = issueOk();
    expect(row).toMatchObject({
      jti: "jti-1",
      token: "!~aaaaaaaa",
      siteKey: "shop",
      maxAmountMinor: 5000,
      currency: "USD",
      deliveredChannels: ["slack:C1"],
      status: "pending",
      consumedAt: null,
      cancelledAt: null,
      confirmedAmountMinor: null,
    });
    expect(getPurchaseTokenByJti(db, "jti-1")).toEqual(row);
  });

  it("auto-generates a jti when omitted", () => {
    enableSite("shop");
    const res = issuePurchaseToken(db, issueInput({ jti: undefined }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.row.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects a currency mismatch against the site config", () => {
    enableSite("shop", { currency: "USD" });
    expect(issuePurchaseToken(db, issueInput({ currency: "EUR" }))).toEqual({
      ok: false,
      reason: "currency_mismatch",
      expected: "USD",
      actual: "EUR",
    });
  });

  it("rejects when the amount exceeds the per-tx override cap", () => {
    enableSite("shop", { perTxCapMinorOverride: 4000 });
    expect(issuePurchaseToken(db, issueInput({ maxAmountMinor: 4001 }))).toEqual({
      ok: false,
      reason: "daily_spend_cap_exceeded",
      capMinor: 4000,
      currentMinor: 0,
      proposedMinor: 4001,
    });
  });

  it("falls back to the daily spend cap as the per-tx ceiling when no override is set", () => {
    enableSite("shop", { dailySpendCapMinor: 4000, perTxCapMinorOverride: null });
    expect(issuePurchaseToken(db, issueInput({ maxAmountMinor: 4001 }))).toMatchObject({
      ok: false,
      reason: "daily_spend_cap_exceeded",
      capMinor: 4000,
    });
  });

  it("enforces the daily token cap, counting cancelled rows (anti-hammering)", () => {
    enableSite("shop", { dailyTokenCap: 1 });
    const first = issueOk({ jti: "t1", token: "!~t1" });
    cancelPurchaseToken(db, { jti: first.jti, reason: "explicit", cancelledAt: 1_000_100, onlyIfPending: true });
    // The cancelled row still counts toward the daily ceiling.
    expect(issuePurchaseToken(db, issueInput({ jti: "t2", token: "!~t2" }))).toEqual({
      ok: false,
      reason: "daily_token_cap_exceeded",
      cap: 1,
      used: 1,
    });
  });

  it("enforces per-site concurrency 1 (pending_exists) when the token cap is not yet hit", () => {
    enableSite("shop", { dailyTokenCap: 5 });
    issueOk({ jti: "t1", token: "!~t1" });
    expect(issuePurchaseToken(db, issueInput({ jti: "t2", token: "!~t2" }))).toEqual({
      ok: false,
      reason: "pending_exists",
      pendingJti: "t1",
    });
  });

  it("enforces the daily spend cap against accumulated confirmed amounts", () => {
    enableSite("shop", { dailyTokenCap: 5, dailySpendCapMinor: 10_000, perTxCapMinorOverride: 10_000 });
    const t1 = issueOk({ jti: "t1", token: "!~t1", maxAmountMinor: 6000 });
    consumePurchaseToken(db, { jti: t1.jti, channelRef: "slack:C1", consumedAt: 1_000_050, nowMs: 1_000_050 });
    finalizePurchaseToken(db, {
      jti: t1.jti,
      confirmedAmountMinor: 6000,
      currency: "USD",
      orderId: "ord-1",
      postScreenshotPath: "shop/post.png",
      finalizedAt: 1_000_060,
    });
    // 6000 already confirmed; a 5000 token would push the day to 11000 > 10000.
    expect(issuePurchaseToken(db, issueInput({ jti: "t2", token: "!~t2", maxAmountMinor: 5000 }))).toEqual({
      ok: false,
      reason: "daily_spend_cap_exceeded",
      capMinor: 10_000,
      currentMinor: 6000,
      proposedMinor: 5000,
    });
  });

  it("reports a token_collision when the raw token already exists at another site", () => {
    enableSite("shopA");
    enableSite("shopB");
    issueOk({ jti: "a", siteKey: "shopA", token: "!~dup" });
    expect(
      issuePurchaseToken(db, issueInput({ jti: "b", siteKey: "shopB", token: "!~dup" })),
    ).toEqual({ ok: false, reason: "token_collision" });
  });
});

describe("lookups", () => {
  beforeEach(() => enableSite("shop"));

  it("looks up by jti, raw token, and tail", () => {
    const row = issueOk({ token: "!~abcd1234" });
    expect(getPurchaseTokenByJti(db, row.jti)).toEqual(row);
    expect(getPurchaseTokenByRaw(db, "!~abcd1234")).toEqual(row);
    expect(getPurchaseTokenByTail(db, "abcd1234")).toEqual(row);
  });

  it("returns null for unknown lookups", () => {
    expect(getPurchaseTokenByJti(db, "ghost")).toBeNull();
    expect(getPurchaseTokenByRaw(db, "!~nope")).toBeNull();
    expect(getPurchaseTokenByTail(db, "nope")).toBeNull();
  });
});

describe("fromDbRow delivered_channels resilience", () => {
  it("falls back to [] on malformed or non-array delivered_channels", () => {
    db.prepare(
      `INSERT INTO browser_automation_purchase_tokens
         (jti, token, workflow_invocation_id, site_key, url_pattern, max_amount_minor,
          currency, pre_screenshot_path, delivered_channels, issued_at, expires_at, status)
       VALUES ('bad', '!~b', 'wf', 'shop', 'u', 1, 'USD', 'p', '{bad', 1, 2, 'pending')`,
    ).run();
    db.prepare(
      `INSERT INTO browser_automation_purchase_tokens
         (jti, token, workflow_invocation_id, site_key, url_pattern, max_amount_minor,
          currency, pre_screenshot_path, delivered_channels, issued_at, expires_at, status)
       VALUES ('obj', '!~o', 'wf', 'shop', 'u', 1, 'USD', 'p', '5', 1, 2, 'pending')`,
    ).run();
    expect(getPurchaseTokenByJti(db, "bad")!.deliveredChannels).toEqual([]);
    expect(getPurchaseTokenByJti(db, "obj")!.deliveredChannels).toEqual([]);
  });
});

describe("consumePurchaseToken (single-use CAS)", () => {
  beforeEach(() => enableSite("shop"));

  it("acquires a pending token once; the second acquire CAS-misses", () => {
    issueOk();
    const consumed = consumePurchaseToken(db, {
      jti: "jti-1",
      channelRef: "slack:C1",
      consumedAt: 1_000_100,
      nowMs: 1_000_100,
    });
    // The consume lock records consumed_at but keeps status='pending' until
    // finalize/cancel flips it.
    expect(consumed).toMatchObject({
      status: "pending",
      consumedAt: 1_000_100,
      consumedViaChannel: "slack:C1",
    });
    expect(
      consumePurchaseToken(db, { jti: "jti-1", channelRef: "slack:C2", consumedAt: 1_000_200, nowMs: 1_000_200 }),
    ).toBeNull();
    expect(getPurchaseTokenByJti(db, "jti-1")!.consumedViaChannel).toBe("slack:C1");
  });

  it("accepts consume at exactly expires_at and refuses after it", () => {
    issueOk({ expiresAt: 2_000_000 });
    expect(
      consumePurchaseToken(db, { jti: "jti-1", channelRef: "slack:C1", consumedAt: 2_000_000, nowMs: 2_000_000 }),
    ).not.toBeNull();

    // A second token (different site so per-site concurrency does not block)
    // consumed one ms past its TTL must CAS-miss.
    enableSite("shop2");
    issueOk({ jti: "jti-3", token: "!~cccccccc", siteKey: "shop2", expiresAt: 2_000_000 });
    expect(
      consumePurchaseToken(db, { jti: "jti-3", channelRef: "slack:C1", consumedAt: 2_000_001, nowMs: 2_000_001 }),
    ).toBeNull();
  });

  it("refuses to consume a cancelled token", () => {
    issueOk();
    cancelPurchaseToken(db, { jti: "jti-1", reason: "explicit", cancelledAt: 1_000_050, onlyIfPending: true });
    expect(
      consumePurchaseToken(db, { jti: "jti-1", channelRef: "slack:C1", consumedAt: 1_000_100, nowMs: 1_000_100 }),
    ).toBeNull();
  });
});

describe("cancelPurchaseToken", () => {
  beforeEach(() => enableSite("shop"));

  it("cancels a pending token and records the reason", () => {
    issueOk();
    const row = cancelPurchaseToken(db, {
      jti: "jti-1",
      reason: "user_reply",
      cancelledAt: 1_000_100,
      onlyIfPending: true,
    });
    expect(row).toMatchObject({ status: "cancelled", cancelledAt: 1_000_100, cancelReason: "user_reply" });
  });

  it("onlyIfPending refuses to cancel an already-consumed token", () => {
    issueOk();
    consumePurchaseToken(db, { jti: "jti-1", channelRef: "slack:C1", consumedAt: 1_000_050, nowMs: 1_000_050 });
    expect(
      cancelPurchaseToken(db, { jti: "jti-1", reason: "timeout", cancelledAt: 1_000_100, onlyIfPending: true }),
    ).toBeNull();
  });

  it("the non-onlyIfPending guard refuses to cancel a confirmed token", () => {
    issueOk();
    consumePurchaseToken(db, { jti: "jti-1", channelRef: "slack:C1", consumedAt: 1_000_050, nowMs: 1_000_050 });
    finalizePurchaseToken(db, {
      jti: "jti-1",
      confirmedAmountMinor: 5000,
      currency: "USD",
      orderId: "o",
      postScreenshotPath: "p.png",
      finalizedAt: 1_000_060,
    });
    expect(
      cancelPurchaseToken(db, { jti: "jti-1", reason: "dashboard_cancel", cancelledAt: 1_000_100 }),
    ).toBeNull();
  });

  it("returns null for an unknown jti", () => {
    expect(
      cancelPurchaseToken(db, { jti: "ghost", reason: "explicit", cancelledAt: 1, onlyIfPending: true }),
    ).toBeNull();
  });
});

describe("finalizePurchaseToken", () => {
  beforeEach(() => enableSite("shop"));

  it("confirms a consumed token, recording the order details", () => {
    issueOk();
    consumePurchaseToken(db, { jti: "jti-1", channelRef: "slack:C1", consumedAt: 1_000_050, nowMs: 1_000_050 });
    const row = finalizePurchaseToken(db, {
      jti: "jti-1",
      confirmedAmountMinor: 4800,
      currency: "USD",
      orderId: "ORDER-9",
      postScreenshotPath: "shop/post.png",
      finalizedAt: 1_000_060,
    });
    expect(row).toMatchObject({
      status: "confirmed",
      confirmedAmountMinor: 4800,
      orderId: "ORDER-9",
      postScreenshotPath: "shop/post.png",
    });
  });

  it("refuses to finalize a token that has not been consumed", () => {
    issueOk();
    expect(
      finalizePurchaseToken(db, {
        jti: "jti-1",
        confirmedAmountMinor: 4800,
        currency: "USD",
        orderId: null,
        postScreenshotPath: "p.png",
        finalizedAt: 1_000_060,
      }),
    ).toBeNull();
  });

  it("refuses a currency mismatch and a double-finalize", () => {
    issueOk();
    consumePurchaseToken(db, { jti: "jti-1", channelRef: "slack:C1", consumedAt: 1_000_050, nowMs: 1_000_050 });
    expect(
      finalizePurchaseToken(db, {
        jti: "jti-1",
        confirmedAmountMinor: 4800,
        currency: "EUR",
        orderId: null,
        postScreenshotPath: "p.png",
        finalizedAt: 1_000_060,
      }),
    ).toBeNull();
    // Finalize correctly, then a second finalize CAS-misses.
    finalizePurchaseToken(db, {
      jti: "jti-1",
      confirmedAmountMinor: 4800,
      currency: "USD",
      orderId: null,
      postScreenshotPath: "p.png",
      finalizedAt: 1_000_060,
    });
    expect(
      finalizePurchaseToken(db, {
        jti: "jti-1",
        confirmedAmountMinor: 9999,
        currency: "USD",
        orderId: null,
        postScreenshotPath: "p2.png",
        finalizedAt: 1_000_070,
      }),
    ).toBeNull();
    expect(getPurchaseTokenByJti(db, "jti-1")!.confirmedAmountMinor).toBe(4800);
  });
});

describe("retention sweeps", () => {
  beforeEach(() => enableSite("shop"));

  it("expireStalePurchaseTokens flips pre-consume past-TTL rows to expired/timeout", () => {
    issueOk({ jti: "stale", token: "!~stale", expiresAt: 2_000_000 });
    const expired = expireStalePurchaseTokens(db, 2_000_001);
    expect(expired.map((r) => r.jti)).toEqual(["stale"]);
    expect(getPurchaseTokenByJti(db, "stale")).toMatchObject({
      status: "expired",
      cancelReason: "timeout",
      cancelledAt: 2_000_001,
    });
  });

  it("expireStalePurchaseTokens ignores consumed rows and returns [] when nothing is overdue", () => {
    issueOk({ expiresAt: 2_000_000 });
    consumePurchaseToken(db, { jti: "jti-1", channelRef: "slack:C1", consumedAt: 1_500_000, nowMs: 1_500_000 });
    // consumed_at is set, so the pre-consume sweep skips it.
    expect(expireStalePurchaseTokens(db, 9_000_000)).toEqual([]);
    expect(getPurchaseTokenByJti(db, "jti-1")!.status).toBe("pending");
  });

  it("sweepOrphanedConsumedPurchaseTokens cancels consumed-but-not-finalized rows past the cutoff", () => {
    issueOk();
    consumePurchaseToken(db, { jti: "jti-1", channelRef: "slack:C1", consumedAt: 1_000_050, nowMs: 1_000_050 });
    const swept = sweepOrphanedConsumedPurchaseTokens(db, 1_000_100);
    expect(swept.map((r) => r.jti)).toEqual(["jti-1"]);
    expect(getPurchaseTokenByJti(db, "jti-1")).toMatchObject({
      status: "cancelled",
      cancelReason: "supervisor_orphan_sweep",
    });
  });

  it("sweepOrphanedConsumedPurchaseTokens returns [] when there are no orphans", () => {
    issueOk();
    expect(sweepOrphanedConsumedPurchaseTokens(db, 9_000_000)).toEqual([]);
  });

  it("scrubRotatedPurchaseTokens nulls raw tokens on old terminal rows only", () => {
    // Confirmed + old → scrubbed.
    issueOk({ jti: "done", token: "!~done" });
    consumePurchaseToken(db, { jti: "done", channelRef: "slack:C1", consumedAt: 1_000_050, nowMs: 1_000_050 });
    finalizePurchaseToken(db, {
      jti: "done",
      confirmedAmountMinor: 5000,
      currency: "USD",
      orderId: null,
      postScreenshotPath: "p.png",
      finalizedAt: 1_000_060,
    });
    // Pending → never scrubbed even when old.
    enableSite("shop2");
    issueOk({ jti: "pend", token: "!~pend", siteKey: "shop2" });

    expect(scrubRotatedPurchaseTokens(db, 9_000_000)).toBe(1);
    expect(getPurchaseTokenByJti(db, "done")!.token).toBeNull();
    expect(getPurchaseTokenByJti(db, "pend")!.token).toBe("!~pend");
  });
});

describe("dashboard listings", () => {
  beforeEach(() => enableSite("shop"));

  it("listPendingPurchaseTokens returns non-expired pending rows newest-first and clamps the limit", () => {
    issueOk({ jti: "a", token: "!~a", issuedAt: 1_000_000, expiresAt: 9_000_000 });
    // Different site so per-site concurrency does not block the second issue.
    enableSite("shop2");
    issueOk({ jti: "b", token: "!~b", siteKey: "shop2", issuedAt: 1_000_500, expiresAt: 9_000_000 });

    expect(listPendingPurchaseTokens(db, 1_000_600).map((r) => r.jti)).toEqual(["b", "a"]);
    expect(listPendingPurchaseTokens(db, 1_000_600, 0)).toHaveLength(1); // clamp floor
  });

  it("listRecentPurchaseTokens returns terminal rows ordered by their terminal timestamp", () => {
    issueOk({ jti: "cancelled", token: "!~c" });
    cancelPurchaseToken(db, { jti: "cancelled", reason: "explicit", cancelledAt: 1_000_300, onlyIfPending: true });
    enableSite("shop2");
    issueOk({ jti: "expired", token: "!~e", siteKey: "shop2", expiresAt: 1_000_100 });
    expireStalePurchaseTokens(db, 1_000_200);

    const recent = listRecentPurchaseTokens(db);
    expect(recent.map((r) => r.jti)).toEqual(["cancelled", "expired"]);
  });

  it("listPendingTokensForChannel filters by delivered channel membership", () => {
    issueOk({ jti: "c1", token: "!~c1", deliveredChannels: ["slack:C1"] });
    enableSite("shop2");
    issueOk({ jti: "c2", token: "!~c2", siteKey: "shop2", deliveredChannels: ["slack:C2"] });
    expect(listPendingTokensForChannel(db, "slack:C1", 1_000_001).map((r) => r.jti)).toEqual(["c1"]);
    expect(listPendingTokensForChannel(db, "slack:C9", 1_000_001)).toEqual([]);
  });
});

describe("defaultSiteB4Config", () => {
  it("returns the default caps for a freshly-enabled site", () => {
    expect(defaultSiteB4Config({ siteKey: "shop", currency: "JPY" })).toEqual({
      siteKey: "shop",
      currency: "JPY",
      dailyTokenCap: B4_DEFAULT_DAILY_TOKEN_CAP,
      dailySpendCapMinor: B4_DEFAULT_DAILY_SPEND_CAP_MINOR,
      perTxCapMinorOverride: null,
    });
  });
});
