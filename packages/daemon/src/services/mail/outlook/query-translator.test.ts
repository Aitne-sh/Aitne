import { describe, expect, it } from "vitest";
import { translateQueryFilters } from "./query-translator.js";

const FIXED_NOW = () => new Date("2026-04-16T12:00:00.000Z");

describe("translateQueryFilters", () => {
  it("returns empty translation for null/empty input", () => {
    expect(translateQueryFilters(null)).toEqual({ filters: [], search: null });
    expect(translateQueryFilters("")).toEqual({ filters: [], search: null });
  });

  it("translates from: into a filter on emailAddress/address", () => {
    expect(translateQueryFilters("from:alice@example.com")).toEqual({
      filters: ["from/emailAddress/address eq 'alice@example.com'"],
      search: null,
    });
  });

  it("translates to: into a toRecipients/any filter", () => {
    expect(translateQueryFilters("to:bob@example.com")).toEqual({
      filters: ["toRecipients/any(r:r/emailAddress/address eq 'bob@example.com')"],
      search: null,
    });
  });

  it("translates is:unread into isRead eq false", () => {
    expect(translateQueryFilters("is:unread")).toEqual({
      filters: ["isRead eq false"],
      search: null,
    });
  });

  it("translates has:attachment into hasAttachments eq true", () => {
    expect(translateQueryFilters("has:attachment")).toEqual({
      filters: ["hasAttachments eq true"],
      search: null,
    });
  });

  it("translates newer_than:Nd to receivedDateTime ge ISO", () => {
    expect(translateQueryFilters("newer_than:7d", { now: FIXED_NOW })).toEqual({
      filters: ["receivedDateTime ge 2026-04-09T12:00:00.000Z"],
      search: null,
    });
  });

  it("translates older_than:Nd to receivedDateTime lt ISO", () => {
    expect(translateQueryFilters("older_than:30d", { now: FIXED_NOW })).toEqual({
      filters: ["receivedDateTime lt 2026-03-17T12:00:00.000Z"],
      search: null,
    });
  });

  it("ignores newer_than/older_than with malformed N", () => {
    expect(translateQueryFilters("newer_than:abc", { now: FIXED_NOW })).toEqual({
      filters: [],
      search: null,
    });
    expect(translateQueryFilters("older_than:14days", { now: FIXED_NOW })).toEqual({
      filters: [],
      search: null,
    });
  });

  it("folds subject: tokens into the $search string", () => {
    expect(translateQueryFilters('subject:"team lunch"')).toEqual({
      filters: [],
      search: 'subject:"team lunch"',
    });
  });

  it("falls free text into the $search string", () => {
    expect(translateQueryFilters("invoice march")).toEqual({
      filters: [],
      search: "invoice march",
    });
  });

  it("combines filters and search across mixed tokens", () => {
    const result = translateQueryFilters(
      'from:alice@example.com is:unread "team lunch" subject:"march invoice"',
      { now: FIXED_NOW },
    );
    expect(result.filters).toEqual([
      "from/emailAddress/address eq 'alice@example.com'",
      "isRead eq false",
    ]);
    expect(result.search).toBe('"team lunch" subject:"march invoice"');
  });

  it("escapes single-quotes in OData literals", () => {
    expect(translateQueryFilters("from:o'brien@example.com")).toEqual({
      filters: ["from/emailAddress/address eq 'o''brien@example.com'"],
      search: null,
    });
  });

  it("preserves quoted free-text tokens", () => {
    expect(translateQueryFilters('"hello world" foo')).toEqual({
      filters: [],
      search: '"hello world" foo',
    });
  });

  it("handles consecutive whitespace between tokens", () => {
    expect(translateQueryFilters("  is:unread   has:attachment  ")).toEqual({
      filters: ["isRead eq false", "hasAttachments eq true"],
      search: null,
    });
  });

  it("treats unterminated quoted token as a single token through end-of-input", () => {
    expect(translateQueryFilters('"unterminated subject')).toEqual({
      filters: [],
      search: '"unterminated subject',
    });
  });

  it("treats subject: with unquoted value as a single subject: token", () => {
    expect(translateQueryFilters("subject:march")).toEqual({
      filters: [],
      search: "subject:march",
    });
  });

  it("uses Date.now() when opts.now is omitted (smoke check)", () => {
    const result = translateQueryFilters("newer_than:1d");
    expect(result.filters).toHaveLength(1);
    expect(result.filters[0]).toMatch(/^receivedDateTime ge \d{4}-\d{2}-\d{2}T/);
  });
});
