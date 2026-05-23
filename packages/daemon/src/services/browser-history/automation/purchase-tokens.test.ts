/**
 * Pure-logic tests for `purchase-tokens.ts` — the B-4 token shape,
 * classifier, and structural-anti-spoofing helpers. Lives in the
 * 100%-coverage gate: every branch of every function below is
 * exercised here.
 */

import { describe, expect, it } from "vitest";

import {
  classifyAdapterInbound,
  classifyPurchaseConfirmationTemplate,
  classifyPurchaseReply,
  classifyPurchaseTokenEcho,
  computePurchaseExpiry,
  formatPurchaseToken,
  hashReplyBody,
  isCancelPurchaseSlash,
  isPurchaseExpired,
  mintPurchaseToken,
  mintPurchaseTokenTail,
  parsePurchaseToken,
  parseVerifySlash,
  purchaseTokenEquals,
  PURCHASE_CONFIRMATION_HEADER,
  PURCHASE_CONFIRMATION_TEMPLATE_MARKERS,
  redactToken,
  type PurchaseTokenRowView,
} from "./purchase-tokens.js";

describe("mintPurchaseTokenTail", () => {
  it("produces an 8-char base32 string", () => {
    for (let i = 0; i < 32; i++) {
      const tail = mintPurchaseTokenTail();
      expect(tail).toHaveLength(8);
      expect(tail).toMatch(/^[A-Z2-7]{8}$/);
    }
  });

  it("collisions are vanishingly rare across 1000 mints (no exact dupes)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(mintPurchaseTokenTail());
    expect(seen.size).toBe(1000);
  });
});

describe("formatPurchaseToken", () => {
  it("prefixes a valid tail with !~", () => {
    expect(formatPurchaseToken("ABCD2345")).toBe("!~ABCD2345");
  });

  it("throws on wrong-length input", () => {
    expect(() => formatPurchaseToken("ABCD")).toThrow(/8 chars/);
  });

  it("throws on non-base32 characters", () => {
    expect(() => formatPurchaseToken("abcd2345")).toThrow(/base32/);
    expect(() => formatPurchaseToken("ABCD0123")).toThrow(/base32/);
  });
});

describe("mintPurchaseToken", () => {
  it("returns a prefixed canonical token", () => {
    const tok = mintPurchaseToken();
    expect(tok).toMatch(/^!~[A-Z2-7]{8}$/);
  });
});

describe("computePurchaseExpiry", () => {
  it("adds 5 minutes to now", () => {
    expect(computePurchaseExpiry(1_000)).toBe(1_000 + 5 * 60 * 1000);
  });

  it("rejects NaN / Infinity / negative", () => {
    expect(() => computePurchaseExpiry(Number.NaN)).toThrow();
    expect(() => computePurchaseExpiry(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => computePurchaseExpiry(-1)).toThrow();
  });
});

describe("parsePurchaseToken", () => {
  it("matches the canonical shape and strips whitespace", () => {
    expect(parsePurchaseToken("!~ABCD2345")).toBe("!~ABCD2345");
    expect(parsePurchaseToken("  !~ABCD2345 \n")).toBe("!~ABCD2345");
  });

  it("rejects mid-stream tokens (must be the entire trimmed body)", () => {
    expect(parsePurchaseToken("prefix !~ABCD2345 suffix")).toBeNull();
  });

  it("rejects wrong-case / wrong-charset", () => {
    expect(parsePurchaseToken("!~abcd2345")).toBeNull();
    expect(parsePurchaseToken("!~ABCD0123")).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(parsePurchaseToken(undefined as unknown as string)).toBeNull();
    expect(parsePurchaseToken(123 as unknown as string)).toBeNull();
  });
});

describe("hashReplyBody", () => {
  it("returns a deterministic sha256 hex", () => {
    const a = hashReplyBody("!~ABCD2345");
    const b = hashReplyBody("!~ABCD2345");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs across inputs", () => {
    expect(hashReplyBody("a")).not.toBe(hashReplyBody("b"));
  });
});

describe("purchaseTokenEquals", () => {
  it("constant-time compares equal strings", () => {
    expect(purchaseTokenEquals("!~ABCD2345", "!~ABCD2345")).toBe(true);
  });

  it("rejects unequal strings", () => {
    expect(purchaseTokenEquals("!~ABCD2345", "!~EFGH2345")).toBe(false);
  });

  it("rejects length / type mismatches", () => {
    expect(purchaseTokenEquals("!~A", "!~AB")).toBe(false);
    expect(purchaseTokenEquals(undefined as unknown as string, "")).toBe(false);
  });
});

describe("redactToken", () => {
  it("preserves !~ prefix + last 3 chars", () => {
    expect(redactToken("!~ABCD2345")).toBe("!~****345");
  });

  it("returns <redacted> on short input", () => {
    expect(redactToken("abc")).toBe("<redacted>");
    expect(redactToken("" as string)).toBe("<redacted>");
  });
});

const baseRow: PurchaseTokenRowView = {
  jti: "00000000-0000-0000-0000-000000000001",
  token: "!~ABCD2345",
  workflowInvocationId: "wf-1",
  siteKey: "amazon_jp",
  status: "pending",
  issuedAt: 1_000,
  expiresAt: 1_000 + 5 * 60 * 1000,
  consumedAt: null,
  cancelledAt: null,
  deliveredChannels: ["slack:C1", "telegram:T1"],
};

describe("classifyPurchaseReply", () => {
  it("returns shape_invalid for non-token bodies", () => {
    expect(
      classifyPurchaseReply({
        body: "hello",
        channelRef: "slack:C1",
        row: baseRow,
        nowMs: 2_000,
      }),
    ).toEqual({ kind: "shape_invalid" });
  });

  it("returns no_match when no row", () => {
    expect(
      classifyPurchaseReply({
        body: "!~ABCD2345",
        channelRef: "slack:C1",
        row: null,
        nowMs: 2_000,
      }),
    ).toEqual({ kind: "no_match" });
  });

  it("returns already_consumed when consumed_at is set", () => {
    const out = classifyPurchaseReply({
      body: "!~ABCD2345",
      channelRef: "slack:C1",
      row: { ...baseRow, consumedAt: 1_500 },
      nowMs: 2_000,
    });
    expect(out.kind).toBe("already_consumed");
  });

  it("returns already_cancelled when status is cancelled", () => {
    const out = classifyPurchaseReply({
      body: "!~ABCD2345",
      channelRef: "slack:C1",
      row: { ...baseRow, cancelledAt: 1_500, status: "cancelled" },
      nowMs: 2_000,
    });
    expect(out.kind).toBe("already_cancelled");
  });

  it("returns expired when status is expired or nowMs > expiresAt", () => {
    expect(
      classifyPurchaseReply({
        body: "!~ABCD2345",
        channelRef: "slack:C1",
        row: { ...baseRow, status: "expired" },
        nowMs: 2_000,
      }).kind,
    ).toBe("expired");
    expect(
      classifyPurchaseReply({
        body: "!~ABCD2345",
        channelRef: "slack:C1",
        row: baseRow,
        nowMs: baseRow.expiresAt + 1,
      }).kind,
    ).toBe("expired");
  });

  it("returns wrong_channel when channelRef is not in delivered_channels", () => {
    expect(
      classifyPurchaseReply({
        body: "!~ABCD2345",
        channelRef: "discord:D1",
        row: baseRow,
        nowMs: 2_000,
      }).kind,
    ).toBe("wrong_channel");
  });

  it("returns consume on happy path", () => {
    expect(
      classifyPurchaseReply({
        body: "!~ABCD2345",
        channelRef: "slack:C1",
        row: baseRow,
        nowMs: 2_000,
      }).kind,
    ).toBe("consume");
  });
});

describe("isPurchaseExpired", () => {
  it("returns true for pending past TTL", () => {
    expect(
      isPurchaseExpired(
        {
          status: "pending",
          expiresAt: 100,
          consumedAt: null,
          cancelledAt: null,
        },
        200,
      ),
    ).toBe(true);
  });

  it("returns false for terminal states", () => {
    expect(
      isPurchaseExpired(
        { status: "confirmed", expiresAt: 100, consumedAt: 50, cancelledAt: null },
        200,
      ),
    ).toBe(false);
    expect(
      isPurchaseExpired(
        { status: "cancelled", expiresAt: 100, consumedAt: null, cancelledAt: 75 },
        200,
      ),
    ).toBe(false);
  });

  it("returns false when consumed_at or cancelled_at is set", () => {
    expect(
      isPurchaseExpired(
        { status: "pending", expiresAt: 100, consumedAt: 50, cancelledAt: null },
        200,
      ),
    ).toBe(false);
    expect(
      isPurchaseExpired(
        { status: "pending", expiresAt: 100, consumedAt: null, cancelledAt: 75 },
        200,
      ),
    ).toBe(false);
  });

  it("returns false when not yet expired", () => {
    expect(
      isPurchaseExpired(
        {
          status: "pending",
          expiresAt: 100,
          consumedAt: null,
          cancelledAt: null,
        },
        50,
      ),
    ).toBe(false);
  });
});

describe("classifyPurchaseTokenEcho", () => {
  it("matches an embedded token anywhere in the arg", () => {
    const match = classifyPurchaseTokenEcho('curl -d {"x":"!~ABCD2345"}');
    expect(match).not.toBeNull();
    expect(match?.redacted).toBe("!~****345");
  });

  it("returns null on no match", () => {
    expect(classifyPurchaseTokenEcho("ls -la")).toBeNull();
    expect(classifyPurchaseTokenEcho("")).toBeNull();
    expect(classifyPurchaseTokenEcho(undefined)).toBeNull();
  });
});

describe("classifyPurchaseConfirmationTemplate", () => {
  it("matches each reserved marker case-insensitively", () => {
    for (const marker of PURCHASE_CONFIRMATION_TEMPLATE_MARKERS) {
      const match = classifyPurchaseConfirmationTemplate(
        `prefix ${marker.toLowerCase()} suffix`,
      );
      expect(match).not.toBeNull();
      expect(match?.marker).toBe(marker);
    }
  });

  it("returns null when no reserved marker present", () => {
    expect(
      classifyPurchaseConfirmationTemplate("ordinary message"),
    ).toBeNull();
    expect(classifyPurchaseConfirmationTemplate("")).toBeNull();
    expect(classifyPurchaseConfirmationTemplate(undefined)).toBeNull();
  });

  it("matches the canonical confirmation header", () => {
    const match = classifyPurchaseConfirmationTemplate(
      `🔐 ${PURCHASE_CONFIRMATION_HEADER}\nbody`,
    );
    expect(match).not.toBeNull();
  });
});

describe("parseVerifySlash", () => {
  it("parses a verify slash", () => {
    expect(parseVerifySlash("!verify ABCD2345")).toEqual({ tail: "ABCD2345" });
  });

  it("strips whitespace", () => {
    expect(parseVerifySlash("  !verify ABCD2345  ")).toEqual({
      tail: "ABCD2345",
    });
  });

  it("returns null on shape miss", () => {
    expect(parseVerifySlash("!verify")).toBeNull();
    expect(parseVerifySlash("!verify abcd2345")).toBeNull();
    expect(parseVerifySlash("!verify ABCD23")).toBeNull();
    expect(parseVerifySlash("!verify ABCD23456")).toBeNull();
    expect(parseVerifySlash(undefined as unknown as string)).toBeNull();
  });
});

describe("isCancelPurchaseSlash", () => {
  it("matches the canonical slash", () => {
    expect(isCancelPurchaseSlash("!cancel-purchase")).toBe(true);
    expect(isCancelPurchaseSlash("!cancel-purchase please")).toBe(true);
  });

  it("rejects non-matches", () => {
    expect(isCancelPurchaseSlash("cancel-purchase")).toBe(false);
    expect(isCancelPurchaseSlash("!cancel")).toBe(false);
    expect(isCancelPurchaseSlash(undefined as unknown as string)).toBe(false);
  });
});

describe("classifyAdapterInbound", () => {
  it("returns verify for !verify <tail>", () => {
    expect(classifyAdapterInbound("!verify ABCD2345")).toEqual({
      kind: "verify",
      tail: "ABCD2345",
    });
  });

  it("returns cancel_purchase for !cancel-purchase", () => {
    expect(classifyAdapterInbound("!cancel-purchase")).toEqual({
      kind: "cancel_purchase",
    });
  });

  it("returns token_reply for a bare token line", () => {
    expect(classifyAdapterInbound("!~ABCD2345")).toEqual({
      kind: "token_reply",
      token: "!~ABCD2345",
    });
  });

  it("returns passthrough on everything else", () => {
    expect(classifyAdapterInbound("hello")).toEqual({ kind: "passthrough" });
    expect(classifyAdapterInbound("")).toEqual({ kind: "passthrough" });
  });

  it("prioritises slashes over token shape (so a paste of `!verify TOKEN` wins)", () => {
    expect(classifyAdapterInbound("!verify ABCD2345").kind).toBe("verify");
    expect(classifyAdapterInbound("!cancel-purchase ").kind).toBe(
      "cancel_purchase",
    );
  });
});
