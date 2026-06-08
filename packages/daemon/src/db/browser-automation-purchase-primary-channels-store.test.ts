import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import {
  channelRef,
  clearPrimaryChannel,
  countPrimaryChannels,
  isPrimaryChannelRef,
  listPrimaryChannels,
  parseChannelRef,
  setPrimaryChannel,
} from "./browser-automation-purchase-primary-channels-store.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  applySchema(db);
});

afterEach(() => {
  db.close();
});

describe("setPrimaryChannel / list / count", () => {
  it("inserts rows and counts them", () => {
    setPrimaryChannel(db, { platform: "slack", channelId: "C1", setAt: 1 });
    setPrimaryChannel(db, { platform: "telegram", channelId: "9", setAt: 2 });
    expect(countPrimaryChannels(db)).toBe(2);
    expect(listPrimaryChannels(db)).toEqual([
      { platform: "slack", channelId: "C1", setAt: 1 },
      { platform: "telegram", channelId: "9", setAt: 2 },
    ]);
  });

  it("upserts on the (platform, channel_id) primary key (INSERT OR REPLACE)", () => {
    setPrimaryChannel(db, { platform: "slack", channelId: "C1", setAt: 1 });
    setPrimaryChannel(db, { platform: "slack", channelId: "C1", setAt: 99 });
    expect(countPrimaryChannels(db)).toBe(1);
    expect(listPrimaryChannels(db)[0].setAt).toBe(99);
  });

  it("orders by platform then channel_id", () => {
    setPrimaryChannel(db, { platform: "telegram", channelId: "9", setAt: 1 });
    setPrimaryChannel(db, { platform: "slack", channelId: "C2", setAt: 1 });
    setPrimaryChannel(db, { platform: "slack", channelId: "C1", setAt: 1 });
    expect(listPrimaryChannels(db).map((r) => `${r.platform}:${r.channelId}`)).toEqual([
      "slack:C1",
      "slack:C2",
      "telegram:9",
    ]);
  });
});

describe("clearPrimaryChannel", () => {
  it("removes the row and reports the change count", () => {
    setPrimaryChannel(db, { platform: "slack", channelId: "C1", setAt: 1 });
    expect(clearPrimaryChannel(db, "slack", "C1")).toBe(1);
    expect(countPrimaryChannels(db)).toBe(0);
    expect(clearPrimaryChannel(db, "slack", "C1")).toBe(0);
  });
});

describe("channelRef / parseChannelRef", () => {
  it("formats <platform>:<channel_id>", () => {
    expect(channelRef("slack", "C1")).toBe("slack:C1");
  });

  it("parses a simple ref", () => {
    expect(parseChannelRef("slack:C1")).toEqual({ platform: "slack", channelId: "C1" });
  });

  it("splits only on the first colon so colon-bearing channel ids survive", () => {
    expect(parseChannelRef("slack:C1:thread:42")).toEqual({
      platform: "slack",
      channelId: "C1:thread:42",
    });
  });

  it("rejects malformed refs (leading colon, trailing colon, no colon)", () => {
    expect(parseChannelRef(":C1")).toBeNull();
    expect(parseChannelRef("slack:")).toBeNull();
    expect(parseChannelRef("slackC1")).toBeNull();
  });
});

describe("isPrimaryChannelRef", () => {
  it("is true only for an existing primary row", () => {
    setPrimaryChannel(db, { platform: "slack", channelId: "C1", setAt: 1 });
    expect(isPrimaryChannelRef(db, "slack:C1")).toBe(true);
    expect(isPrimaryChannelRef(db, "slack:C2")).toBe(false);
  });

  it("is false for a malformed ref", () => {
    expect(isPrimaryChannelRef(db, "garbage")).toBe(false);
  });
});
