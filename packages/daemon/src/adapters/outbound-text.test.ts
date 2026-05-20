import { describe, it, expect } from "vitest";
import {
  extensionFromMime,
  filenameForMime,
  splitOutboundText,
} from "./outbound-text.js";

describe("splitOutboundText", () => {
  it("returns the input unchanged when shorter than maxLen", () => {
    expect(splitOutboundText("hello", 100)).toEqual(["hello"]);
  });

  it("returns the input unchanged when exactly maxLen", () => {
    expect(splitOutboundText("hello", 5)).toEqual(["hello"]);
  });

  it("splits on the latest newline within the window and consumes that delimiter", () => {
    // Window: indices 0..10 inclusive. Newlines at 5 and 10. Splitter
    // picks the latest in-window newline (index 10) so the chunk hits
    // maxLen as closely as possible without overflowing.
    const text = "alpha\nbeta\ngamma";
    expect(splitOutboundText(text, 11)).toEqual(["alpha\nbeta", "gamma"]);
  });

  it("uses an earlier in-window newline when the latest one is past maxLen", () => {
    // maxLen=8: each iteration runs the latest-in-window scan independently
    // on the trimmed remainder, so the input ends up split at every newline.
    const text = "alpha\nbeta\ngamma";
    expect(splitOutboundText(text, 8)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("does not consume a newline that lands exactly at the maxLen boundary", () => {
    // When the newline is the character AT maxLen itself, the slice keeps
    // it on the next chunk so total length is preserved (round-trip
    // invariant for callers that join chunks back together).
    const text = "alpha\nbeta\ngamma";
    expect(splitOutboundText(text, 10)).toEqual(["alpha\nbeta", "\ngamma"]);
  });

  it("falls back to a hard cut at maxLen when no newline exists in the window", () => {
    const text = "abcdefghij";
    expect(splitOutboundText(text, 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("does not start the next chunk with a stray newline", () => {
    const text = "first line\nsecond line\nthird line";
    const chunks = splitOutboundText(text, 12);
    for (const chunk of chunks) {
      expect(chunk.startsWith("\n")).toBe(false);
    }
  });

  it("preserves a leading newline when the first split lands at maxLen exactly", () => {
    const text = "ab\ncdefghij";
    const chunks = splitOutboundText(text, 2);
    expect(chunks[0]).toBe("ab");
    expect(chunks.join("")).toBe(text);
  });

  it("handles an empty string", () => {
    expect(splitOutboundText("", 100)).toEqual([""]);
  });

  it("does not tear UTF-16 surrogate pairs at the maxLen boundary", () => {
    // 🎉 (U+1F389) encodes as high surrogate 0xD83C + low surrogate 0xDF89,
    // i.e. two UTF-16 code units. With maxLen=4 the naive cut lands
    // between the two halves, producing an unpaired high surrogate at the
    // end of chunk[0] and an unpaired low surrogate at the start of
    // chunk[1] — rendered as U+FFFD by Slack/Telegram/Discord.
    const text = "abc🎉def";
    const chunks = splitOutboundText(text, 4);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      if (chunk.length === 0) continue;
      const lastCode = chunk.charCodeAt(chunk.length - 1);
      const firstCode = chunk.charCodeAt(0);
      // No lone high surrogate at chunk end.
      expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
      // No lone low surrogate at chunk start.
      expect(firstCode >= 0xdc00 && firstCode <= 0xdfff).toBe(false);
    }
  });

  it("does not tear surrogate pairs when newline is the natural splitter", () => {
    // The latest in-window newline sits one code unit past a surrogate
    // pair — the backoff must still preserve the pair without
    // double-consuming.
    const text = "ab🎉\ncdef";
    const chunks = splitOutboundText(text, 5);
    expect(chunks.join("").replace(/\n/g, "")).toBe(text.replace(/\n/g, ""));
    for (const chunk of chunks) {
      if (chunk.length === 0) continue;
      const lastCode = chunk.charCodeAt(chunk.length - 1);
      expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
    }
  });

  it("backs off to a newline outside an open fence so the second chunk starts at the fence", () => {
    // Window puts the split candidate inside a fenced code block. The
    // fence-aware backoff walks to the newline immediately before the
    // most recent fence opener so the first chunk closes cleanly and the
    // second chunk begins with the fence line itself.
    const text = "prelude\n```js\ncode line one\ncode line two\n```\ntail";
    const chunks = splitOutboundText(text, 25);
    expect(chunks[0]).toBe("prelude");
    expect(chunks[1]?.startsWith("```")).toBe(true);
  });

  it("recognises indented fence openers (CommonMark §4.5: up to 3 leading spaces)", () => {
    // The opener has two leading spaces — isFenceLineStart must skip
    // whitespace before checking for three consecutive backticks. Without
    // the skip, the backoff would not trigger and the chunk would split
    // inside the code block.
    const text = "alpha\n  ```\ncode body line\n  ```\nomega";
    const chunks = splitOutboundText(text, 20);
    expect(chunks[0]).toBe("alpha");
    expect(chunks[1]?.startsWith("  ```")).toBe(true);
  });

  it("falls through to maxLen when no fence newline exists before the split", () => {
    // Open fence at index 0 with no earlier newline → the lookback returns
    // -1 and the splitter falls back to the surrogate/maxLen branch. This
    // exercises the `safe > 0` guard in splitOutboundText.
    const text = "```\nthis_is_a_long_code_body_with_no_safe_newlines_at_all_xx";
    const chunks = splitOutboundText(text, 10);
    // First chunk is the fence opener; remainder fans out at maxLen.
    expect(chunks[0]).toBe("```");
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe("extensionFromMime", () => {
  it("special-cases mpeg → mp3", () => {
    expect(extensionFromMime("audio/mpeg", "ogg")).toBe("mp3");
  });

  it("special-cases quicktime → mov", () => {
    expect(extensionFromMime("video/quicktime", "mp4")).toBe("mov");
  });

  it("special-cases 3gpp → 3gp", () => {
    expect(extensionFromMime("audio/3gpp", "ogg")).toBe("3gp");
  });

  it("strips charset suffixes", () => {
    expect(extensionFromMime("application/json;charset=utf-8", "bin")).toBe(
      "json",
    );
  });

  it("lowercases the subtype", () => {
    expect(extensionFromMime("image/JPEG", "jpg")).toBe("jpeg");
  });

  it("strips non-alphanumeric characters from the subtype", () => {
    expect(extensionFromMime("application/x-tar", "bin")).toBe("xtar");
  });

  it("falls back when MIME is missing", () => {
    expect(extensionFromMime(null, "bin")).toBe("bin");
    expect(extensionFromMime(undefined, "bin")).toBe("bin");
  });

  it("falls back when subtype is empty after stripping", () => {
    expect(extensionFromMime("application/-", "bin")).toBe("bin");
  });
});

describe("filenameForMime", () => {
  it("composes <base>.<ext> from MIME", () => {
    expect(filenameForMime("audio", "audio/mpeg", "ogg")).toBe("audio.mp3");
  });

  it("uses the fallback extension when MIME is missing", () => {
    expect(filenameForMime("file", null, "bin")).toBe("file.bin");
  });
});
