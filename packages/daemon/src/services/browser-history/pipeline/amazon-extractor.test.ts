import { describe, it, expect } from "vitest";
import { extractAmazonReference } from "./amazon-extractor.js";

function input(host: string, path: string, url?: string) {
  return {
    scheme: "https:",
    host,
    path,
    url: url ?? `https://${host}${path}`,
  };
}

describe("extractAmazonReference", () => {
  it("extracts ASIN from /dp/ paths on amazon.com", () => {
    expect(extractAmazonReference(input("amazon.com", "/dp/B08XYZ1234"))).toEqual({
      asin: "B08XYZ1234",
      locale: "com",
    });
  });

  it("extracts ASIN from /gp/product/ paths", () => {
    expect(
      extractAmazonReference(input("www.amazon.co.jp", "/gp/product/B0ABCDE123")),
    ).toEqual({ asin: "B0ABCDE123", locale: "co.jp" });
  });

  it("extracts ASIN from smile.amazon.com", () => {
    expect(
      extractAmazonReference(input("smile.amazon.com", "/dp/B08XYZ1234")),
    ).toEqual({ asin: "B08XYZ1234", locale: "com" });
  });

  it("extracts ASIN from /exec/obidos/asin/ legacy URLs", () => {
    expect(
      extractAmazonReference(input("amazon.com", "/exec/obidos/asin/B08XYZ1234/ref=foo")),
    ).toEqual({ asin: "B08XYZ1234", locale: "com" });
  });

  it("extracts ASIN from /gp/aw/d/ mobile URLs", () => {
    expect(
      extractAmazonReference(input("amazon.co.jp", "/gp/aw/d/B098765432")),
    ).toEqual({ asin: "B098765432", locale: "co.jp" });
  });

  it("extracts ASIN from query parameter when path lacks it", () => {
    expect(
      extractAmazonReference(
        input(
          "amazon.com",
          "/something",
          "https://amazon.com/something?asin=B0ZZZZZZZZ",
        ),
      ),
    ).toEqual({ asin: "B0ZZZZZZZZ", locale: "com" });
  });

  it("ignores AWS console (different vertical)", () => {
    expect(
      extractAmazonReference(input("console.aws.amazon.com", "/s3")),
    ).toBeNull();
  });

  it("ignores non-Amazon hosts", () => {
    expect(extractAmazonReference(input("example.com", "/dp/B08XYZ1234"))).toBeNull();
  });

  it("ignores non-https schemes", () => {
    const result = extractAmazonReference({
      scheme: "http:",
      host: "amazon.com",
      path: "/dp/B08XYZ1234",
      url: "http://amazon.com/dp/B08XYZ1234",
    });
    expect(result).toBeNull();
  });

  it("handles amazon.co.uk locale", () => {
    expect(
      extractAmazonReference(input("amazon.co.uk", "/dp/B0UKUKUK00")),
    ).toEqual({ asin: "B0UKUKUK00", locale: "co.uk" });
  });
});
