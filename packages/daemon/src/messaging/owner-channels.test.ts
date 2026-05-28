import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  upsertOwnerChannel,
  getOwnerChannel,
  selectFirstPairedPlatform,
  selectDefaultOwnerChannel,
} from "./owner-channels.js";

describe("owner-channels", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE owner_channels (
        platform TEXT PRIMARY KEY,
        sender_id TEXT,
        channel_id TEXT NOT NULL,
        last_inbound_at TIMESTAMP,
        last_outbound_at TIMESTAMP,
        metadata JSON DEFAULT '{}'
      )
    `);
  });

  afterEach(() => {
    db.close();
  });

  describe("upsertOwnerChannel", () => {
    it("inserts a new channel record", () => {
      upsertOwnerChannel(db, {
        platform: "slack",
        senderId: "U123",
        channelId: "C456",
      });

      const row = getOwnerChannel(db, "slack");
      expect(row).not.toBeNull();
      expect(row!.platform).toBe("slack");
      expect(row!.sender_id).toBe("U123");
      expect(row!.channel_id).toBe("C456");
    });

    it("stores metadata as JSON", () => {
      upsertOwnerChannel(db, {
        platform: "telegram",
        channelId: "T789",
        metadata: { bot_name: "mybot" },
      });

      const row = getOwnerChannel(db, "telegram");
      expect(row).not.toBeNull();
      expect(JSON.parse(row!.metadata!)).toEqual({ bot_name: "mybot" });
    });

    it("defaults metadata to empty object when not provided", () => {
      upsertOwnerChannel(db, {
        platform: "discord",
        channelId: "D123",
      });

      const row = getOwnerChannel(db, "discord");
      expect(row).not.toBeNull();
      expect(JSON.parse(row!.metadata!)).toEqual({});
    });

    it("touches inbound timestamp when requested", () => {
      upsertOwnerChannel(db, {
        platform: "slack",
        channelId: "C1",
        touchInbound: true,
      });

      const row = getOwnerChannel(db, "slack");
      expect(row!.last_inbound_at).not.toBeNull();
      expect(row!.last_outbound_at).toBeNull();
    });

    it("touches outbound timestamp when requested", () => {
      upsertOwnerChannel(db, {
        platform: "slack",
        channelId: "C1",
        touchOutbound: true,
      });

      const row = getOwnerChannel(db, "slack");
      expect(row!.last_inbound_at).toBeNull();
      expect(row!.last_outbound_at).not.toBeNull();
    });

    it("updates existing record on conflict", () => {
      upsertOwnerChannel(db, {
        platform: "slack",
        senderId: "U1",
        channelId: "C1",
      });

      upsertOwnerChannel(db, {
        platform: "slack",
        senderId: "U2",
        channelId: "C2",
      });

      const row = getOwnerChannel(db, "slack");
      expect(row!.sender_id).toBe("U2");
      expect(row!.channel_id).toBe("C2");
    });

    it("preserves sender_id when update has null senderId", () => {
      upsertOwnerChannel(db, {
        platform: "slack",
        senderId: "U1",
        channelId: "C1",
      });

      upsertOwnerChannel(db, {
        platform: "slack",
        channelId: "C2",
      });

      const row = getOwnerChannel(db, "slack");
      expect(row!.sender_id).toBe("U1");
      expect(row!.channel_id).toBe("C2");
    });
  });

  describe("getOwnerChannel", () => {
    it("returns null for a nonexistent platform", () => {
      const row = getOwnerChannel(db, "nonexistent");
      expect(row).toBeNull();
    });

    it("returns the channel for an existing platform", () => {
      upsertOwnerChannel(db, {
        platform: "slack",
        senderId: "U1",
        channelId: "C1",
      });

      const row = getOwnerChannel(db, "slack");
      expect(row).not.toBeNull();
      expect(row!.platform).toBe("slack");
    });
  });

  describe("selectFirstPairedPlatform", () => {
    it("returns null for an empty eligible set", () => {
      expect(selectFirstPairedPlatform(db, [])).toBeNull();
    });

    it("returns the only candidate without touching the DB", () => {
      // No owner_channels rows seeded — single-candidate path must not
      // depend on DB state.
      expect(selectFirstPairedPlatform(db, ["telegram"])).toBe("telegram");
    });

    it("returns the earliest-paired platform among multiple eligible", () => {
      // Pair order: discord first, then slack, then telegram.
      upsertOwnerChannel(db, { platform: "discord", channelId: "D1" });
      upsertOwnerChannel(db, { platform: "slack", channelId: "S1" });
      upsertOwnerChannel(db, { platform: "telegram", channelId: "T1" });

      // Eligible in canonical order (slack first); chronological should
      // win and return discord.
      expect(
        selectFirstPairedPlatform(db, ["slack", "telegram", "discord"]),
      ).toBe("discord");
    });

    it("preserves original rowid through re-pair (upsert keeps order stable)", () => {
      upsertOwnerChannel(db, { platform: "discord", channelId: "D1" });
      upsertOwnerChannel(db, { platform: "slack", channelId: "S1" });
      // Re-pair discord — ON CONFLICT DO UPDATE keeps the original rowid.
      upsertOwnerChannel(db, {
        platform: "discord",
        channelId: "D2",
        touchInbound: true,
      });

      expect(selectFirstPairedPlatform(db, ["slack", "discord"])).toBe(
        "discord",
      );
    });

    it("falls back to canonical-order [0] when no eligible platform has a pairing row", () => {
      // Discord paired, but discord is not in the eligible set.
      upsertOwnerChannel(db, { platform: "discord", channelId: "D1" });
      // Slack/Telegram are eligible (e.g. env-var owner IDs) but neither
      // has been DM'd yet.
      expect(selectFirstPairedPlatform(db, ["slack", "telegram"])).toBe(
        "slack",
      );
    });

    it("skips paired platforms that are not in the eligible set", () => {
      upsertOwnerChannel(db, { platform: "whatsapp", channelId: "W1" });
      upsertOwnerChannel(db, { platform: "slack", channelId: "S1" });
      upsertOwnerChannel(db, { platform: "telegram", channelId: "T1" });

      // whatsapp paired earliest but isn't in eligible; the resolver
      // should advance to the next paired-and-eligible candidate.
      expect(selectFirstPairedPlatform(db, ["slack", "telegram"])).toBe(
        "slack",
      );
    });
  });

  describe("selectDefaultOwnerChannel", () => {
    // Explicit timestamps via raw SQL — CURRENT_TIMESTAMP has 1-second
    // resolution, so seeding distinct ordering needs hand-set values.
    const seed = (
      platform: string,
      channelId: string,
      inbound: string | null,
      outbound: string | null = null,
    ): void => {
      db.prepare(
        `INSERT INTO owner_channels (platform, channel_id, last_inbound_at, last_outbound_at)
         VALUES (?, ?, ?, ?)`,
      ).run(platform, channelId, inbound, outbound);
    };

    it("returns null when no owner channel is paired", () => {
      expect(selectDefaultOwnerChannel(db)).toBeNull();
    });

    it("returns the channel with the most recent inbound activity", () => {
      seed("dashboard", "dash-1", "2026-05-28 03:00:00");
      seed("whatsapp", "18589107283@s.whatsapp.net", "2026-05-28 04:00:00");

      expect(selectDefaultOwnerChannel(db)).toEqual({
        platform: "whatsapp",
        channelId: "18589107283@s.whatsapp.net",
      });
    });

    it("falls back to outbound recency when inbound is absent", () => {
      seed("dashboard", "dash-1", null, "2026-05-28 05:00:00");
      seed("telegram", "T1", null, "2026-05-28 02:00:00");

      expect(selectDefaultOwnerChannel(db)).toEqual({
        platform: "dashboard",
        channelId: "dash-1",
      });
    });

    it("breaks ties by earliest-paired rowid when no timestamps exist", () => {
      seed("slack", "S1", null, null);
      seed("discord", "D1", null, null);

      expect(selectDefaultOwnerChannel(db)).toEqual({
        platform: "slack",
        channelId: "S1",
      });
    });
  });
});
