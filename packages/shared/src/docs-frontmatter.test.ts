import { describe, it, expect } from "vitest";
import { FrontmatterParseError, parseFrontmatter } from "./docs-frontmatter.js";

describe("parseFrontmatter", () => {
  it("returns null when no frontmatter is present", () => {
    expect(parseFrontmatter("# Title\n\nbody only")).toBeNull();
  });

  it("parses scalar key/value pairs", () => {
    const result = parseFrontmatter(`---
title: Morning Routine
schema_version: 1
status: stable
---
body`);
    expect(result?.values).toEqual({
      title: "Morning Routine",
      schema_version: 1,
      status: "stable",
    });
    expect(result?.body).toBe("body");
  });

  it("parses string list form", () => {
    const result = parseFrontmatter(`---
aliases:
  - morning_routine
  - daily morning routine
tags:
  - routine
  - heavy-tier
---
`);
    expect(result?.values.aliases).toEqual([
      "morning_routine",
      "daily morning routine",
    ]);
    expect(result?.values.tags).toEqual(["routine", "heavy-tier"]);
  });

  it("parses block-scalar summary with trailing newline (|)", () => {
    const result = parseFrontmatter(`---
summary: |
  First line.
  Second line.
title: ok
---
`);
    expect(result?.values.summary).toBe("First line.\nSecond line.\n");
    expect(result?.values.title).toBe("ok");
  });

  it("parses block-scalar with strip-trailing-newline (|-)", () => {
    const result = parseFrontmatter(`---
summary: |-
  First.
  Second.
title: ok
---
`);
    expect(result?.values.summary).toBe("First.\nSecond.");
  });

  it("recognizes empty inline object {}", () => {
    const result = parseFrontmatter(`---
title: ok
extra: {}
---
`);
    expect(result?.values.extra).toEqual({});
  });

  it("strips inline comments after a scalar", () => {
    const result = parseFrontmatter(`---
title: ok # the title
schema_version: 1 # version
---
`);
    expect(result?.values.title).toBe("ok");
    expect(result?.values.schema_version).toBe(1);
  });

  it("supports quoted strings (preserves ':' inside)", () => {
    const result = parseFrontmatter(`---
title: "A: complete title"
---
`);
    expect(result?.values.title).toBe("A: complete title");
  });

  it("throws on missing closing ---", () => {
    expect(() => parseFrontmatter("---\ntitle: ok\nno close")).toThrow(
      FrontmatterParseError,
    );
  });

  it("throws on flow-style array literal", () => {
    expect(() =>
      parseFrontmatter(`---
tags: [a, b]
---`),
    ).toThrow(/flow-style/);
  });

  it("throws on nested mapping", () => {
    expect(() =>
      parseFrontmatter(`---
weights:
  title: 3.0
---`),
    ).toThrow(FrontmatterParseError);
  });

  it("returns null when source is empty (lines[0] is undefined)", () => {
    expect(parseFrontmatter("")).toBeNull();
  });

  it("parses null / ~ / empty scalars all as null", () => {
    const result = parseFrontmatter(`---
explicit_null: null
tilde: ~
empty:
title: ok
---
`);
    expect(result?.values.explicit_null).toBeNull();
    expect(result?.values.tilde).toBeNull();
    // `empty:` with no value is list-form; an empty list, not null.
    expect(result?.values.empty).toEqual([]);
    expect(result?.values.title).toBe("ok");
  });

  it("parses boolean true / false scalars", () => {
    const result = parseFrontmatter(`---
enabled: true
disabled: false
---
`);
    expect(result?.values.enabled).toBe(true);
    expect(result?.values.disabled).toBe(false);
  });

  it("parses single-quoted strings", () => {
    const result = parseFrontmatter(`---
title: 'A: complete title'
---
`);
    expect(result?.values.title).toBe("A: complete title");
  });

  it("falls back to raw string when bare-numeric overflows to non-finite", () => {
    // `9` × 400 matches /^-?\d+(\.\d+)?$/ but Number(...) = Infinity, so
    // Number.isFinite is false and the parser returns the raw string.
    const big = "9".repeat(400);
    const result = parseFrontmatter(`---
big: ${big}
---
`);
    expect(result?.values.big).toBe(big);
  });

  it("skips blank and comment lines at the top level", () => {
    const result = parseFrontmatter(`---
# a top-level comment
title: ok

# another comment
schema_version: 1
---
`);
    expect(result?.values).toEqual({ title: "ok", schema_version: 1 });
  });

  it("skips comment lines inside a list form", () => {
    const result = parseFrontmatter(`---
aliases:
  - one
  # commented-out alias
  - two
---
`);
    expect(result?.values.aliases).toEqual(["one", "two"]);
  });

  it("throws when a top-level line starts with whitespace (nested mapping)", () => {
    // Leading space on a top-level key triggers the "unexpected
    // indentation" guard before the colon check.
    expect(() =>
      parseFrontmatter(`---
title: ok
 bad: stray-indent
---`),
    ).toThrow(/unexpected indentation/);
  });

  it("throws when a top-level line is missing its colon", () => {
    expect(() =>
      parseFrontmatter(`---
title ok
---`),
    ).toThrow(/expected 'key: value'/);
  });

  it("accepts tab-indented continuation under a block scalar (|)", () => {
    // Tab indent counts as one indent level; the parser strips the tab.
    const result = parseFrontmatter(
      "---\nsummary: |\n\tFirst tab.\n\tSecond tab.\ntitle: ok\n---\n",
    );
    expect(result?.values.summary).toBe("First tab.\nSecond tab.\n");
    expect(result?.values.title).toBe("ok");
  });
});
