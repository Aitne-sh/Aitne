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

  it("skips candidates whose new URL constructor throws", () => {
    // `http://%` matches the candidate regex but isn't a valid URL — the
    // catch must swallow the parse failure and move on to the next match
    // rather than 500ing the whole extraction.
    expect(extractHttpUrls("see http://% and https://ok.test").urls).toEqual([
      "https://ok.test/",
    ]);
  });
});

