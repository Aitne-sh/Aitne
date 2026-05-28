/**
 * navigate-guard — §5 / §14.1 / §14.12 coverage.
 */

import { describe, expect, it } from "vitest";

import { decideNavigate } from "./navigate-guard.js";

const AMAZON_JP = /^https?:\/\/(www\.)?amazon\.co\.jp\//i;

describe("decideNavigate", () => {
  it("accepts a URL inside the allowlist", () => {
    const r = decideNavigate({
      url: "https://www.amazon.co.jp/dp/B000",
      allowlistRegex: AMAZON_JP,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalisedUrl).toBe("https://www.amazon.co.jp/dp/B000");
  });

  it("rejects unparseable URLs", () => {
    const r = decideNavigate({ url: "not a url", allowlistRegex: AMAZON_JP });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("url_unparseable");
  });

  it("rejects empty string", () => {
    const r = decideNavigate({ url: "", allowlistRegex: AMAZON_JP });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("url_unparseable");
  });

  it("rejects non-string urls defensively", () => {
    const r = decideNavigate({
      url: 42 as unknown as string,
      allowlistRegex: AMAZON_JP,
    });
    if (!r.ok) expect(r.reason).toBe("url_unparseable");
  });

  it("rejects file:// URLs", () => {
    const r = decideNavigate({
      url: "file:///etc/passwd",
      allowlistRegex: /^.*/,
    });
    if (!r.ok) {
      expect(r.reason).toBe("scheme_denied");
      if (r.reason === "scheme_denied") expect(r.scheme).toBe("file:");
    }
  });

  it("rejects javascript: URLs", () => {
    const r = decideNavigate({
      url: "javascript:alert(1)",
      allowlistRegex: /^.*/,
    });
    if (!r.ok) expect(r.reason).toBe("scheme_denied");
  });

  it("rejects data: URLs", () => {
    const r = decideNavigate({
      url: "data:text/html,<script>x</script>",
      allowlistRegex: /^.*/,
    });
    if (!r.ok) expect(r.reason).toBe("scheme_denied");
  });

  it("rejects chrome:// URLs", () => {
    const r = decideNavigate({
      url: "chrome://settings/",
      allowlistRegex: /^.*/,
    });
    if (!r.ok) expect(r.reason).toBe("scheme_denied");
  });

  it("blocks payment-path URLs even when the host is allowlisted", () => {
    const r = decideNavigate({
      url: "https://www.amazon.co.jp/gp/buy/spc/handlers/display.html",
      allowlistRegex: AMAZON_JP,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("payment_path_blocked");
      if (r.reason === "payment_path_blocked") {
        expect(r.match.category).toBe("buy");
      }
    }
  });

  it("blocks /checkout payment paths", () => {
    const r = decideNavigate({
      url: "https://www.amazon.co.jp/checkout",
      allowlistRegex: AMAZON_JP,
    });
    if (!r.ok) {
      expect(r.reason).toBe("payment_path_blocked");
      if (r.reason === "payment_path_blocked") {
        expect(r.match.category).toBe("checkout");
      }
    }
  });

  it("blocks URLs outside the allowlist", () => {
    const r = decideNavigate({
      url: "https://evil.example.com/",
      allowlistRegex: AMAZON_JP,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("allowlist_blocked");
  });

  it("accepts http when the regex permits it", () => {
    const r = decideNavigate({
      url: "http://www.amazon.co.jp/",
      allowlistRegex: AMAZON_JP,
    });
    expect(r.ok).toBe(true);
  });

  it("evaluates payment block BEFORE allowlist check", () => {
    // A URL that matches the allowlist BUT is a payment path should
    // report `payment_path_blocked`, not `allowlist_blocked`. This
    // pins the ordering — order matters because dashboard surfaces
    // "blockedByPaymentPath" vs. "blockedByAllowlist" distinctly.
    const r = decideNavigate({
      url: "https://www.amazon.co.jp/gp/buy/",
      allowlistRegex: AMAZON_JP,
    });
    if (!r.ok) expect(r.reason).toBe("payment_path_blocked");
  });

  it("payment block triggers when host is OUTSIDE allowlist too — payment fires first", () => {
    const r = decideNavigate({
      url: "https://attacker.example/checkout/",
      allowlistRegex: AMAZON_JP,
    });
    if (!r.ok) expect(r.reason).toBe("payment_path_blocked");
  });
});
