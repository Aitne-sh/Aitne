import { describe, it, expect } from "vitest";
import { redactVisit } from "./redactor.js";

describe("redactVisit", () => {
  it("strips orderId query parameter", () => {
    const result = redactVisit({
      url: "https://amazon.com/gp/orders?orderId=123-4567890",
      title: "Your Order",
      searchQuery: null,
    });
    expect(result.url).not.toContain("orderId");
    expect(result.url).not.toContain("123-4567890");
  });

  it("strips JWT-shaped query parameter", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const result = redactVisit({
      url: `https://example.com/?token=${jwt}`,
      title: "OK",
      searchQuery: null,
    });
    expect(result.url).not.toContain(jwt);
  });

  it("strips access_token / id_token", () => {
    const result = redactVisit({
      url: "https://example.com/?access_token=secret&id_token=xyz",
      title: "OK",
      searchQuery: null,
    });
    expect(result.url).not.toContain("secret");
    expect(result.url).not.toContain("xyz");
  });

  it("drops title containing 'password'", () => {
    expect(
      redactVisit({
        url: "https://example.com/page",
        title: "Reset your password",
        searchQuery: null,
      }).title,
    ).toBeNull();
  });

  it("drops title containing 'api key'", () => {
    expect(
      redactVisit({
        url: "https://example.com/page",
        title: "Your API key is ready",
        searchQuery: null,
      }).title,
    ).toBeNull();
  });

  it("drops the entire visit for adult-classified host", () => {
    expect(
      redactVisit({
        url: "https://pornhub.com/something",
        title: "anything",
        searchQuery: null,
      }).drop,
    ).toBe(true);
  });

  it("redacts title + searchQuery for banking host but keeps domain", () => {
    const result = redactVisit({
      url: "https://chase.com/accounts/balance",
      title: "Account balance: $1234",
      searchQuery: "balance",
    });
    expect(result.drop).toBe(false);
    expect(result.title).toBeNull();
    expect(result.searchQuery).toBeNull();
    expect(result.host).toBe("chase.com");
  });

  it("returns dropped row for unparseable URLs", () => {
    const result = redactVisit({
      url: "not a url",
      title: "ignored",
      searchQuery: null,
    });
    expect(result.drop).toBe(true);
  });

  it("normalises URL hash off", () => {
    const result = redactVisit({
      url: "https://example.com/page#section",
      title: "OK",
      searchQuery: null,
    });
    expect(result.url).not.toContain("#section");
  });

  it("truncates very long titles", () => {
    const long = "a".repeat(500);
    const result = redactVisit({
      url: "https://example.com/page",
      title: long,
      searchQuery: null,
    });
    expect(result.title?.length ?? 0).toBeLessThanOrEqual(240);
  });
});
