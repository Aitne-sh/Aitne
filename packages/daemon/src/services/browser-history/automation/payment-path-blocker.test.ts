import { describe, expect, it } from "vitest";

import {
  classifyPaymentPath,
  listPaymentPathPatterns,
  __testing,
} from "./payment-path-blocker.js";

describe("payment-path-blocker", () => {
  describe("classifyPaymentPath", () => {
    it("returns null for safe URLs", () => {
      expect(classifyPaymentPath("https://example.com/")).toBeNull();
      expect(classifyPaymentPath("https://example.com/products")).toBeNull();
      expect(classifyPaymentPath("https://example.com/checkout-faq")).toBeNull();
      expect(classifyPaymentPath("https://example.com/buying-guide")).toBeNull();
      expect(
        classifyPaymentPath("https://example.com/?ref=checkout"),
      ).toBeNull();
    });

    it("matches /checkout exactly", () => {
      expect(classifyPaymentPath("https://example.com/checkout")).toEqual({
        category: "checkout",
        matchedPath: "/checkout",
      });
      expect(
        classifyPaymentPath("https://example.com/cart/checkout/"),
      ).toEqual({
        category: "checkout",
        matchedPath: "/cart/checkout/",
      });
    });

    it("matches /payment (singular and plural)", () => {
      expect(
        classifyPaymentPath("https://example.com/payment")?.category,
      ).toBe("payment");
      expect(
        classifyPaymentPath("https://example.com/payments/new")?.category,
      ).toBe("payment");
      // /paymentinfo (no boundary) should NOT match
      expect(
        classifyPaymentPath("https://example.com/paymentinfo"),
      ).toBeNull();
    });

    it("matches /place-order with hyphen or underscore variants", () => {
      expect(
        classifyPaymentPath("https://example.com/place-order")?.category,
      ).toBe("place-order");
      expect(
        classifyPaymentPath("https://example.com/placeorder")?.category,
      ).toBe("place-order");
      expect(
        classifyPaymentPath("https://example.com/place_order")?.category,
      ).toBe("place-order");
    });

    it("matches /buy and /buy-now", () => {
      expect(classifyPaymentPath("https://example.com/buy")?.category).toBe(
        "buy",
      );
      expect(
        classifyPaymentPath("https://example.com/buy-now")?.category,
      ).toBe("buy");
      expect(
        classifyPaymentPath("https://www.amazon.co.jp/gp/buy/payselect/")
          ?.category,
      ).toBe("buy");
    });

    it("matches /place-bid and /bid", () => {
      expect(
        classifyPaymentPath("https://example.com/place-bid")?.category,
      ).toBe("place-bid");
      expect(classifyPaymentPath("https://example.com/bid")?.category).toBe(
        "place-bid",
      );
    });

    it("returns null for unparseable URLs", () => {
      expect(classifyPaymentPath("")).toBeNull();
      expect(classifyPaymentPath("not a url")).toBeNull();
    });

    it("returns null for non-string input", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(classifyPaymentPath(null as any)).toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(classifyPaymentPath(123 as any)).toBeNull();
    });

    it("is case-insensitive", () => {
      expect(
        classifyPaymentPath("https://example.com/CHECKOUT")?.category,
      ).toBe("checkout");
      expect(classifyPaymentPath("https://example.com/Buy")?.category).toBe(
        "buy",
      );
    });

    it("does not match when the keyword is mid-path without boundary", () => {
      // `/checkoutfoo` has no boundary after `checkout` so it's not a
      // payment surface — could legitimately be a content slug.
      expect(
        classifyPaymentPath("https://example.com/checkoutfoo"),
      ).toBeNull();
    });
  });

  describe("listPaymentPathPatterns", () => {
    it("returns the full list of categorised patterns", () => {
      const patterns = listPaymentPathPatterns();
      const categories = patterns.map((p) => p.category).sort();
      expect(categories).toEqual([
        "buy",
        "checkout",
        "payment",
        "place-bid",
        "place-order",
      ]);
    });
  });

  describe("__testing exports", () => {
    it("exposes the raw pattern table for assertion in upstream tests", () => {
      expect(__testing.PAYMENT_PATH_PATTERNS.length).toBeGreaterThan(0);
    });
  });
});
