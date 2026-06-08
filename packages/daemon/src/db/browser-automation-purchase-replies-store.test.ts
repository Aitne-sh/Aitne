import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import {
  deletePurchaseRepliesOlderThan,
  insertPurchaseReply,
  listRecentPurchaseReplies,
  type InsertPurchaseReplyInput,
} from "./browser-automation-purchase-replies-store.js";

let db: Database.Database;

function input(overrides: Partial<InsertPurchaseReplyInput> = {}): InsertPurchaseReplyInput {
  return {
    receivedAt: 1000,
    channelRef: "slack:C1",
    messageBodyHash: "abc123",
    matchedJti: "jti-1",
    outcome: "consumed",
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  applySchema(db);
});

afterEach(() => {
  db.close();
});

describe("insertPurchaseReply", () => {
  it("round-trips a matched reply", () => {
    const row = insertPurchaseReply(db, input());
    expect(row).toMatchObject({
      receivedAt: 1000,
      channelRef: "slack:C1",
      messageBodyHash: "abc123",
      matchedJti: "jti-1",
      outcome: "consumed",
    });
    expect(row.id).toBeGreaterThan(0);
  });

  it("records a null matched_jti for shape_invalid / no_match outcomes", () => {
    const row = insertPurchaseReply(db, input({ matchedJti: null, outcome: "shape_invalid" }));
    expect(row.matchedJti).toBeNull();
    expect(row.outcome).toBe("shape_invalid");
  });
});

describe("listRecentPurchaseReplies", () => {
  it("orders by received_at DESC", () => {
    insertPurchaseReply(db, input({ receivedAt: 100, messageBodyHash: "a" }));
    insertPurchaseReply(db, input({ receivedAt: 300, messageBodyHash: "c" }));
    insertPurchaseReply(db, input({ receivedAt: 200, messageBodyHash: "b" }));
    expect(listRecentPurchaseReplies(db).map((r) => r.messageBodyHash)).toEqual(["c", "b", "a"]);
  });

  it("clamps the limit to a floor of 1", () => {
    insertPurchaseReply(db, input({ receivedAt: 1 }));
    insertPurchaseReply(db, input({ receivedAt: 2 }));
    expect(listRecentPurchaseReplies(db, 0)).toHaveLength(1);
  });

  it("floors a fractional limit", () => {
    insertPurchaseReply(db, input({ receivedAt: 1 }));
    insertPurchaseReply(db, input({ receivedAt: 2 }));
    insertPurchaseReply(db, input({ receivedAt: 3 }));
    expect(listRecentPurchaseReplies(db, 2.9)).toHaveLength(2);
  });
});

describe("deletePurchaseRepliesOlderThan", () => {
  it("prunes rows strictly older than the cutoff", () => {
    insertPurchaseReply(db, input({ receivedAt: 100 }));
    insertPurchaseReply(db, input({ receivedAt: 1000 }));
    expect(deletePurchaseRepliesOlderThan(db, 500)).toBe(1);
    expect(listRecentPurchaseReplies(db).map((r) => r.receivedAt)).toEqual([1000]);
  });
});
