import { describe, expect, it } from "vitest";
import {
  advanceCursor,
  buildInboxDeltaUrl,
  extractDeltaPage,
  isRemovedItem,
  parseGraphCursorJson,
  resolveDeltaUrl,
  serializeGraphCursor,
  type GraphCursor,
} from "./delta-cursor.js";

describe("buildInboxDeltaUrl", () => {
  it("builds a delta URL with $select and $top", () => {
    const url = buildInboxDeltaUrl({
      pageSize: 50,
      selectFields: ["id", "subject", "from"],
    });
    expect(url).toBe(
      "https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?%24select=id%2Csubject%2Cfrom&%24top=50",
    );
  });

  it("respects an alternate base URL for testing", () => {
    const url = buildInboxDeltaUrl({
      base: "http://localhost:9000/v1.0",
      pageSize: 10,
      selectFields: ["id"],
    });
    expect(url.startsWith("http://localhost:9000/v1.0/me/mailFolders/Inbox/messages/delta")).toBe(
      true,
    );
  });
});

describe("resolveDeltaUrl", () => {
  const initial = "https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$top=50";

  it("returns the initial URL when no cursor is provided", () => {
    expect(resolveDeltaUrl(null, initial)).toEqual({ url: initial, isContinuation: false });
  });

  it("prefers nextLink over deltaLink when both are present", () => {
    const cursor: GraphCursor = {
      kind: "graph",
      nextLink: "https://graph.microsoft.com/next",
      deltaLink: "https://graph.microsoft.com/delta",
    };
    expect(resolveDeltaUrl(cursor, initial)).toEqual({
      url: "https://graph.microsoft.com/next",
      isContinuation: true,
    });
  });

  it("uses deltaLink when only deltaLink is present", () => {
    const cursor: GraphCursor = { kind: "graph", deltaLink: "https://graph.microsoft.com/delta" };
    expect(resolveDeltaUrl(cursor, initial)).toEqual({
      url: "https://graph.microsoft.com/delta",
      isContinuation: true,
    });
  });

  it("falls back to the initial URL when cursor has neither link", () => {
    const cursor: GraphCursor = { kind: "graph" };
    expect(resolveDeltaUrl(cursor, initial)).toEqual({ url: initial, isContinuation: false });
  });
});

describe("extractDeltaPage", () => {
  it("parses nextLink-bearing pages", () => {
    const page = extractDeltaPage({
      value: [{ id: "1" }, { id: "2" }],
      "@odata.nextLink": "https://graph.microsoft.com/next",
    });
    expect(page.value).toEqual([{ id: "1" }, { id: "2" }]);
    expect(page.nextLink).toBe("https://graph.microsoft.com/next");
    expect(page.deltaLink).toBeNull();
  });

  it("parses deltaLink-bearing pages", () => {
    const page = extractDeltaPage({
      value: [],
      "@odata.deltaLink": "https://graph.microsoft.com/delta",
    });
    expect(page.value).toEqual([]);
    expect(page.nextLink).toBeNull();
    expect(page.deltaLink).toBe("https://graph.microsoft.com/delta");
  });

  it("normalizes a missing value array to []", () => {
    const page = extractDeltaPage({});
    expect(page.value).toEqual([]);
  });

  it("ignores non-string @odata.* fields defensively", () => {
    const page = extractDeltaPage({
      value: [{ id: "1" }],
      "@odata.nextLink": undefined,
      "@odata.deltaLink": undefined,
    });
    expect(page.nextLink).toBeNull();
    expect(page.deltaLink).toBeNull();
  });
});

describe("advanceCursor", () => {
  it("nextLink → drained=false", () => {
    const advance = advanceCursor({ value: [], nextLink: "https://x", deltaLink: null });
    expect(advance).toEqual({
      cursor: { kind: "graph", nextLink: "https://x" },
      drained: false,
    });
  });

  it("deltaLink only → drained=true", () => {
    const advance = advanceCursor({ value: [], nextLink: null, deltaLink: "https://y" });
    expect(advance).toEqual({
      cursor: { kind: "graph", deltaLink: "https://y" },
      drained: true,
    });
  });

  it("neither link → drained=true with empty cursor", () => {
    const advance = advanceCursor({ value: [], nextLink: null, deltaLink: null });
    expect(advance).toEqual({ cursor: { kind: "graph" }, drained: true });
  });
});

describe("isRemovedItem", () => {
  it("returns true for deleted items", () => {
    expect(isRemovedItem({ id: "1", "@removed": { reason: "deleted" } })).toBe(true);
  });

  it("returns true for changed items (moved out of Inbox)", () => {
    expect(isRemovedItem({ id: "1", "@removed": { reason: "changed" } })).toBe(true);
  });

  it("returns false for items without @removed", () => {
    expect(isRemovedItem({ id: "1" })).toBe(false);
  });

  it("returns false when @removed.reason is missing", () => {
    expect(isRemovedItem({ id: "1", "@removed": {} })).toBe(false);
  });
});

describe("cursor JSON round-trip", () => {
  it("parses a valid graph cursor JSON", () => {
    const cursor: GraphCursor = { kind: "graph", deltaLink: "https://x" };
    const round = parseGraphCursorJson(serializeGraphCursor(cursor));
    expect(round).toEqual(cursor);
  });

  it("returns null for null/empty input", () => {
    expect(parseGraphCursorJson(null)).toBeNull();
    expect(parseGraphCursorJson(undefined)).toBeNull();
    expect(parseGraphCursorJson("")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseGraphCursorJson("not-json")).toBeNull();
  });

  it("returns null when kind is not graph", () => {
    expect(parseGraphCursorJson(JSON.stringify({ kind: "gmail", lastEpoch: 1 }))).toBeNull();
  });
});
