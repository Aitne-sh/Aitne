import { describe, expect, it } from "vitest";
import { UrlExtractError, extractHttpUrls } from "./url-extract.js";

describe("extractHttpUrls", () => {
  it("extracts http and https URLs while preserving case", () => {
    expect(
      extractHttpUrls("See https://Example.com/Case/Path?a=B and http://x.test.").urls,
    ).toEqual(["https://example.com/Case/Path?a=B", "http://x.test/"]);
  });

  it("deduplicates URLs and rejects empty input", () => {
    expect(extractHttpUrls("https://a.test https://a.test/").urls).toEqual([
      "https://a.test/",
    ]);
    expect(() => extractHttpUrls("no links")).toThrow(UrlExtractError);
  });

  it("enforces a batch limit", () => {
    const body = Array.from({ length: 11 }, (_, i) => `https://e${i}.test`).join(" ");
    expect(() => extractHttpUrls(body, 10)).toThrow(/At most 10/);
  });

  it("peels trailing brackets and punctuation from wrapped URLs", () => {
    expect(
      extractHttpUrls("see [https://a.test/path], (https://b.test).").urls,
    ).toEqual(["https://a.test/path", "https://b.test/"]);
  });
});

