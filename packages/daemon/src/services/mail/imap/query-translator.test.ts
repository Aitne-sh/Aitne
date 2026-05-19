import { describe, expect, it } from "vitest";
import { translateImapQuery } from "./query-translator.js";

const FIXED_NOW = () => new Date("2026-04-16T12:00:00.000Z");

describe("translateImapQuery", () => {
  it("returns empty translation for null/empty input", () => {
    expect(translateImapQuery(null)).toEqual({
      terms: [],
      warnings: [],
      requiresClientSideUnicodeFilter: false,
    });
    expect(translateImapQuery("")).toEqual({
      terms: [],
      warnings: [],
      requiresClientSideUnicodeFilter: false,
    });
  });

  it("translates structured tokens into IMAP SEARCH terms", () => {
    expect(
      translateImapQuery(
        'from:alice@example.com to:bob@example.com subject:"team lunch" is:unread has:attachment',
      ),
    ).toEqual({
      terms: [
        { op: "FROM", value: "alice@example.com" },
        { op: "TO", value: "bob@example.com" },
        { op: "SUBJECT", value: "team lunch" },
        { op: "UNSEEN" },
        { op: "LARGER", value: "50000" },
      ],
      warnings: [],
      requiresClientSideUnicodeFilter: false,
    });
  });

  it("translates older/newer date filters", () => {
    expect(
      translateImapQuery("newer_than:7d older_than:30d", { now: FIXED_NOW }),
    ).toEqual({
      terms: [
        { op: "SINCE", value: "09-Apr-2026" },
        { op: "BEFORE", value: "17-Mar-2026" },
      ],
      warnings: [],
      requiresClientSideUnicodeFilter: false,
    });
  });

  it("maps ASCII free-text to TEXT terms", () => {
    expect(translateImapQuery('"invoice april"')).toEqual({
      terms: [{ op: "TEXT", value: "invoice april" }],
      warnings: [],
      requiresClientSideUnicodeFilter: false,
    });
  });

  it("flags non-ASCII free-text for client-side filtering", () => {
    expect(translateImapQuery("café")).toEqual({
      terms: [],
      warnings: [],
      requiresClientSideUnicodeFilter: true,
    });
  });

  it("records malformed older/newer tokens as warnings", () => {
    expect(translateImapQuery("newer_than:bad")).toEqual({
      terms: [],
      warnings: ["unsupported_token:newer_than:bad"],
      requiresClientSideUnicodeFilter: false,
    });
  });

  it("records malformed older_than token as warning", () => {
    expect(translateImapQuery("older_than:bad")).toEqual({
      terms: [],
      warnings: ["unsupported_token:older_than:bad"],
      requiresClientSideUnicodeFilter: false,
    });
  });

  it("flags non-ASCII subject value for client-side filtering without adding SUBJECT term", () => {
    const result = translateImapQuery("subject:café");
    expect(result.terms).toEqual([]);
    expect(result.requiresClientSideUnicodeFilter).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("records empty-after-unquoting token as warning", () => {
    const result = translateImapQuery('""');
    expect(result.terms).toEqual([]);
    expect(result.warnings).toEqual(['unsupported_token:""']);
    expect(result.requiresClientSideUnicodeFilter).toBe(false);
  });

  it("handles query with trailing whitespace (break after empty-scan path)", () => {
    // Query ending with a space: after the last token is parsed, the outer
    // loop re-enters, the inner whitespace-skip advances i to q.length, and
    // `if (i >= q.length) break` fires before attempting to parse another token.
    const result = translateImapQuery("from:alice@example.com ");
    expect(result.terms).toEqual([{ op: "FROM", value: "alice@example.com" }]);
    expect(result.warnings).toEqual([]);
  });
});

