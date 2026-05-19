import { describe, it, expect } from "vitest";
import { buildMatchExpression, isAsciiOnlyQuery } from "./fts5.js";

describe("buildMatchExpression", () => {
  it("returns null for empty input", () => {
    expect(buildMatchExpression("")).toBeNull();
    expect(buildMatchExpression("   ")).toBeNull();
    expect(buildMatchExpression("\t\n")).toBeNull();
  });

  it("quotes each whitespace-separated token as a phrase", () => {
    expect(buildMatchExpression("flight confirmation")).toBe(
      '"flight" "confirmation"',
    );
  });

  it("escapes embedded double-quotes by doubling them", () => {
    // FTS5 phrase syntax: `""` inside `"..."` is the escape for a literal `"`.
    expect(buildMatchExpression('say "hi"')).toBe('"say" """hi"""');
  });

  it("treats column-filter syntax as a literal phrase", () => {
    // `from:alice` would be a column filter in raw FTS5 — quoting protects it.
    expect(buildMatchExpression("from:alice")).toBe('"from:alice"');
  });

  it("neutralizes FTS5 boolean operators by quoting each token", () => {
    // `OR` / `AND` / `NOT` between unquoted tokens are operators. Once each
    // token is wrapped as a phrase, they become literal-text matches that
    // are AND-joined under the implicit operator semantics.
    expect(buildMatchExpression("foo OR bar")).toBe('"foo" "OR" "bar"');
    expect(buildMatchExpression("foo NOT bar")).toBe('"foo" "NOT" "bar"');
    expect(buildMatchExpression("foo NEAR/3 bar")).toBe(
      '"foo" "NEAR/3" "bar"',
    );
  });

  it("strips wildcard `*` by quoting tokens (no prefix-search escape)", () => {
    // Raw FTS5 `foo*` is a prefix wildcard. Quoting forces a literal phrase
    // search — `*` becomes a tokenizer non-token char, harmless inside a
    // phrase token.
    expect(buildMatchExpression("foo*")).toBe('"foo*"');
  });

  it("collapses runs of whitespace to single token boundaries", () => {
    expect(buildMatchExpression("  alpha   beta  ")).toBe(
      '"alpha" "beta"',
    );
  });

  it("preserves Unicode characters inside phrases", () => {
    expect(buildMatchExpression("会議 議事録")).toBe('"会議" "議事録"');
  });
});

describe("isAsciiOnlyQuery", () => {
  it("returns true for plain English", () => {
    expect(isAsciiOnlyQuery("delegated mode")).toBe(true);
  });

  it("returns true for the empty string", () => {
    expect(isAsciiOnlyQuery("")).toBe(true);
  });

  it("returns true for whitespace only", () => {
    expect(isAsciiOnlyQuery("   \t\n")).toBe(true);
  });

  it("returns false when any code point is at or above 0x80", () => {
    expect(isAsciiOnlyQuery("delegatedモード")).toBe(false);
    expect(isAsciiOnlyQuery("朝のルーチン")).toBe(false);
    // Latin-1 supplement (é) is also outside printable ASCII.
    expect(isAsciiOnlyQuery("café")).toBe(false);
  });

  it("returns true for ASCII punctuation and symbols", () => {
    expect(isAsciiOnlyQuery("foo:bar")).toBe(true);
    expect(isAsciiOnlyQuery("a*b?c=d&e")).toBe(true);
    expect(isAsciiOnlyQuery('"quoted"')).toBe(true);
  });

  it("returns false at the boundary just past 0x7f", () => {
    // U+0080 is the first non-ASCII code point.
    expect(isAsciiOnlyQuery("ab")).toBe(false);
  });
});
