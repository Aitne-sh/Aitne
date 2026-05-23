import { describe, expect, it } from "vitest";

import { __testing, getAmazonPurchaseHistory } from "./get-amazon-purchase-history.js";

const { matchOrderId, matchOrderedDate, parseYen } = __testing;

describe("get-amazon-purchase-history — declaration", () => {
  it("declares the auth variant against amazon_jp", () => {
    expect(getAmazonPurchaseHistory.variant).toBe("auth");
    expect(getAmazonPurchaseHistory.siteKey).toBe("amazon_jp");
  });

  it("declares ReadSensitive risk tier (§16.5 minimum for auth workflows)", () => {
    expect(getAmazonPurchaseHistory.riskTier).toBe("read_sensitive");
  });

  it("targets the Amazon Japan your-orders subtree", () => {
    expect(
      getAmazonPurchaseHistory.allowlistRegex.test(
        "https://www.amazon.co.jp/gp/css/order-history",
      ),
    ).toBe(true);
    expect(
      getAmazonPurchaseHistory.allowlistRegex.test(
        "https://www.amazon.co.jp/dp/B0XXXX",
      ),
    ).toBe(false);
  });
});

describe("matchOrderId", () => {
  it("extracts a canonical Amazon order id from prose", () => {
    expect(matchOrderId("Order # 250-1234567-9876543 placed")).toBe(
      "250-1234567-9876543",
    );
  });

  it("returns null when no order-shape is present", () => {
    expect(matchOrderId("no id here")).toBeNull();
    expect(matchOrderId("250-12345")).toBeNull();
  });
});

describe("matchOrderedDate", () => {
  it("parses YYYY-MM-DD", () => {
    expect(matchOrderedDate("2026-05-21")).toBe("2026-05-21");
  });

  it("parses YYYY/MM/DD", () => {
    expect(matchOrderedDate("Ordered on 2026/5/3")).toBe("2026-05-03");
  });

  it("parses any non-digit separator (locale-agnostic)", () => {
    expect(matchOrderedDate("2026.05.21")).toBe("2026-05-21");
  });

  it("parses the compact YYYYMMDD form", () => {
    expect(matchOrderedDate("20260521")).toBe("2026-05-21");
  });

  it("returns null when no date-shape is present", () => {
    expect(matchOrderedDate("not a date")).toBeNull();
  });

  it("pads single-digit month + day", () => {
    expect(matchOrderedDate("2026-5-3")).toBe("2026-05-03");
  });
});

describe("parseYen", () => {
  it("parses a comma-formatted total", () => {
    expect(parseYen("1,234")).toBe(1234);
  });

  it("strips a currency prefix glyph", () => {
    expect(parseYen("$1,234")).toBe(1234);
  });

  it("strips an ISO-4217 prefix", () => {
    expect(parseYen("JPY 1234")).toBe(1234);
  });

  it("returns null on empty / non-numeric input", () => {
    expect(parseYen("")).toBeNull();
    expect(parseYen("---")).toBeNull();
    expect(parseYen("free")).toBeNull();
  });
});
