import { describe, it, expect } from "vitest";
import {
  seedGmailPollCursor,
  trimGmailProcessedIds,
  normalizeGmailPollCursor,
} from "./poll-cursor.js";

describe("seedGmailPollCursor", () => {
  it("creates a cursor with epoch from the given date", () => {
    const now = new Date("2026-04-17T00:00:00.000Z");
    const cursor = seedGmailPollCursor(now);
    expect(cursor.kind).toBe("gmail");
    expect(cursor.lastEpoch).toBe(Math.floor(now.getTime() / 1000));
    expect(cursor.processedIds).toEqual([]);
    expect(cursor.historyId).toBeUndefined();
  });

  it("stores historyId when provided", () => {
    const cursor = seedGmailPollCursor(new Date(), "hist-123");
    expect(cursor.historyId).toBe("hist-123");
  });

  it("omits historyId when null", () => {
    const cursor = seedGmailPollCursor(new Date(), null);
    expect(cursor.historyId).toBeUndefined();
  });
});

describe("trimGmailProcessedIds", () => {
  it("returns the array as-is when under the limit", () => {
    const ids = ["a", "b", "c"];
    expect(trimGmailProcessedIds(ids)).toEqual(ids);
  });

  it("slices to the last 500 when over limit", () => {
    const ids = Array.from({ length: 600 }, (_, i) => `id-${i}`);
    const result = trimGmailProcessedIds(ids);
    expect(result).toHaveLength(500);
    expect(result[0]).toBe("id-100");
  });
});

describe("normalizeGmailPollCursor", () => {
  it("returns a seeded cursor when cursor is null", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const cursor = normalizeGmailPollCursor(null, now);
    expect(cursor.kind).toBe("gmail");
    expect(cursor.processedIds).toEqual([]);
  });

  it("returns a seeded cursor when cursor has wrong kind", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const cursor = normalizeGmailPollCursor({ kind: "imap", folders: {} }, now);
    expect(cursor.kind).toBe("gmail");
  });

  it("preserves nextPageToken when non-empty string", () => {
    const input = {
      kind: "gmail" as const,
      lastEpoch: 1000,
      processedIds: [],
      nextPageToken: "token-abc",
    };
    const result = normalizeGmailPollCursor(input);
    expect(result.nextPageToken).toBe("token-abc");
  });

  it("drops nextPageToken when empty string", () => {
    const input = {
      kind: "gmail" as const,
      lastEpoch: 1000,
      processedIds: [],
      nextPageToken: "",
    };
    const result = normalizeGmailPollCursor(input);
    expect(result.nextPageToken).toBeUndefined();
  });

  it("preserves historyPageToken when non-empty string", () => {
    const input = {
      kind: "gmail" as const,
      lastEpoch: 1000,
      processedIds: [],
      historyPageToken: "hist-page-1",
    };
    const result = normalizeGmailPollCursor(input);
    expect(result.historyPageToken).toBe("hist-page-1");
  });

  it("drops historyPageToken when empty string", () => {
    const input = {
      kind: "gmail" as const,
      lastEpoch: 1000,
      processedIds: [],
      historyPageToken: "",
    };
    const result = normalizeGmailPollCursor(input);
    expect(result.historyPageToken).toBeUndefined();
  });

  it("filters non-string entries from processedIds", () => {
    const input = {
      kind: "gmail" as const,
      lastEpoch: 1000,
      processedIds: ["id1", 42 as unknown as string, "id2"],
    };
    const result = normalizeGmailPollCursor(input);
    expect(result.processedIds).toEqual(["id1", "id2"]);
  });

  it("replaces non-array processedIds with empty array", () => {
    const input = {
      kind: "gmail" as const,
      lastEpoch: 1000,
      processedIds: "bad" as unknown as string[],
    };
    const result = normalizeGmailPollCursor(input);
    expect(result.processedIds).toEqual([]);
  });
});
