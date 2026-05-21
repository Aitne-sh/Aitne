import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../../db/schema.js";
import {
  DEFAULT_OFFER_RATE_LIMIT_CONFIG,
  gateOfferRateLimit,
  isInQuietHours,
  type OfferRateLimitConfig,
} from "./offer-rate-limit.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function seedCluster(
  db: Database.Database,
  slug: string,
  overrides: Partial<{
    lastDmAt: number | null;
    lastResearchOfferAt: number | null;
    lastWikiOfferAt: number | null;
    researchOfferAcceptedAt: number | null;
    wikiSummaryWrittenAt: number | null;
  }> = {},
): void {
  db.prepare(
    `INSERT OR REPLACE INTO browser_research_clusters (
       slug, root_task_id, display_name, started_at, last_activity_at,
       visits_total, meaningful_visits_total, meaningful_foreground_sec_total,
       distinct_meaningful_domains, status,
       last_dm_at, last_research_offer_at, last_wiki_offer_at,
       research_offer_accepted_at, wiki_summary_written_at
     ) VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 'active', ?, ?, ?, ?, ?)`,
  ).run(
    slug,
    Math.floor(Math.random() * 1_000_000),
    slug.replace("-", " "),
    overrides.lastDmAt ?? null,
    overrides.lastResearchOfferAt ?? null,
    overrides.lastWikiOfferAt ?? null,
    overrides.researchOfferAcceptedAt ?? null,
    overrides.wikiSummaryWrittenAt ?? null,
  );
}

describe("gateOfferRateLimit", () => {
  let db: Database.Database;
  const NOW = Date.parse("2026-05-20T12:00:00Z");
  const baseConfig: OfferRateLimitConfig = {
    ...DEFAULT_OFFER_RATE_LIMIT_CONFIG,
    // Disable quiet hours for the baseline tests; per-test we enable it
    // where it matters.
    quietHoursStart: null,
    quietHoursEnd: null,
    timezone: "UTC",
  };

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("fires for the first candidate when no recent activity exists", () => {
    seedCluster(db, "quantum-mechanics");
    const result = gateOfferRateLimit(db, "quantum-mechanics", NOW, baseConfig);
    expect(result).toEqual({ decision: "fire" });
  });

  it("skips with daily_cap when 2 offers have already fired in the last 24h", () => {
    seedCluster(db, "topic-a", { lastDmAt: NOW - 10 * HOUR_MS });
    seedCluster(db, "topic-b", { lastDmAt: NOW - 5 * HOUR_MS });
    seedCluster(db, "topic-c");
    const result = gateOfferRateLimit(db, "topic-c", NOW, baseConfig);
    expect(result).toEqual({ decision: "skip", reason: "daily_cap" });
  });

  it("skips with interval when the most recent fire is within 4h", () => {
    seedCluster(db, "topic-a", { lastDmAt: NOW - 2 * HOUR_MS });
    seedCluster(db, "topic-b");
    const result = gateOfferRateLimit(db, "topic-b", NOW, baseConfig);
    expect(result).toEqual({ decision: "skip", reason: "interval" });
  });

  it("skips with same_topic when the candidate matches a recently-fired slug", () => {
    seedCluster(db, "quantum-mechanics", { lastDmAt: NOW - 5 * HOUR_MS });
    const result = gateOfferRateLimit(
      db,
      "quantum-mechanics",
      NOW,
      baseConfig,
    );
    expect(result).toEqual({ decision: "skip", reason: "same_topic" });
  });

  it("skips with same_topic when a non-most-recent fire matches the candidate (higher cap)", () => {
    // The most-recent fire is `topic-a`, but `topic-b` also appears
    // earlier in the 24h window. With a daily cap > 2, daily_cap doesn't
    // trip; the `recentFires.some(...)` fallback must catch the dupe.
    seedCluster(db, "topic-b", { lastDmAt: NOW - 10 * HOUR_MS });
    seedCluster(db, "topic-a", { lastDmAt: NOW - 5 * HOUR_MS });
    const result = gateOfferRateLimit(db, "topic-b", NOW, {
      ...baseConfig,
      globalDailyCap: 5,
    });
    expect(result).toEqual({ decision: "skip", reason: "same_topic" });
  });

  it("fires when daily cap clear, interval elapsed, and different topic", () => {
    seedCluster(db, "topic-a", { lastDmAt: NOW - 5 * HOUR_MS });
    seedCluster(db, "topic-b");
    const result = gateOfferRateLimit(db, "topic-b", NOW, baseConfig);
    expect(result).toEqual({ decision: "fire" });
  });

  it("ignores fires older than 24h for the daily cap", () => {
    seedCluster(db, "topic-a", { lastDmAt: NOW - 30 * HOUR_MS });
    seedCluster(db, "topic-b", { lastDmAt: NOW - 26 * HOUR_MS });
    seedCluster(db, "topic-c");
    const result = gateOfferRateLimit(db, "topic-c", NOW, baseConfig);
    expect(result).toEqual({ decision: "fire" });
  });

  it("skips with decline_backoff when both option windows are open and unaccepted", () => {
    seedCluster(db, "stale-cluster", {
      lastResearchOfferAt: NOW - 10 * DAY_MS,
      lastWikiOfferAt: NOW - 10 * DAY_MS,
      researchOfferAcceptedAt: null,
      wikiSummaryWrittenAt: null,
    });
    const result = gateOfferRateLimit(
      db,
      "stale-cluster",
      NOW,
      baseConfig,
    );
    expect(result).toEqual({ decision: "skip", reason: "decline_backoff" });
  });

  it("does NOT trigger decline_backoff when only one option's window is in cooldown", () => {
    seedCluster(db, "half-cooled", {
      lastResearchOfferAt: NOW - 10 * DAY_MS,
      lastWikiOfferAt: null, // wiki window is fresh
      researchOfferAcceptedAt: null,
    });
    const result = gateOfferRateLimit(db, "half-cooled", NOW, baseConfig);
    expect(result).toEqual({ decision: "fire" });
  });

  it("does NOT trigger decline_backoff when the offer was accepted (acceptance closes the window)", () => {
    seedCluster(db, "accepted-cluster", {
      lastResearchOfferAt: NOW - 10 * DAY_MS,
      researchOfferAcceptedAt: NOW - 9 * DAY_MS,
      lastWikiOfferAt: NOW - 10 * DAY_MS,
      wikiSummaryWrittenAt: NOW - 8 * DAY_MS,
    });
    const result = gateOfferRateLimit(db, "accepted-cluster", NOW, baseConfig);
    expect(result).toEqual({ decision: "fire" });
  });

  it("skips with active_conversation when the owner DM scope has recent message activity", () => {
    seedCluster(db, "topic-a");
    // Insert a recent owner DM message — within the 30-minute window.
    db.prepare(
      `INSERT INTO conversation_sessions (id, platform, channel_id, scope, scope_key, status, started_at)
       VALUES (1, 'slack', 'D-OWNER', 'owner_dm', 'owner', 'active', ?)`,
    ).run(new Date(NOW - HOUR_MS).toISOString().slice(0, 19).replace("T", " "));
    db.prepare(
      `INSERT INTO messages (session_id, role, content, platform, timestamp)
       VALUES (1, 'user', 'hi', 'slack', ?)`,
    ).run(
      new Date(NOW - 5 * 60 * 1000).toISOString().slice(0, 19).replace("T", " "),
    );
    const result = gateOfferRateLimit(db, "topic-a", NOW, baseConfig);
    expect(result).toEqual({ decision: "skip", reason: "active_conversation" });
  });

  it("does NOT skip when the most recent owner DM is older than the activity window", () => {
    seedCluster(db, "topic-a");
    db.prepare(
      `INSERT INTO conversation_sessions (id, platform, channel_id, scope, scope_key, status, started_at)
       VALUES (1, 'slack', 'D-OWNER', 'owner_dm', 'owner', 'active', ?)`,
    ).run(new Date(NOW - 2 * HOUR_MS).toISOString().slice(0, 19).replace("T", " "));
    db.prepare(
      `INSERT INTO messages (session_id, role, content, platform, timestamp)
       VALUES (1, 'user', 'hi', 'slack', ?)`,
    ).run(
      new Date(NOW - HOUR_MS).toISOString().slice(0, 19).replace("T", " "),
    );
    const result = gateOfferRateLimit(db, "topic-a", NOW, baseConfig);
    expect(result).toEqual({ decision: "fire" });
  });

  it("skips with quiet_hours when the current time falls inside the quiet window", () => {
    seedCluster(db, "topic-a");
    // NOW = 2026-05-20 12:00 UTC. Set quiet hours 10:00-14:00 — inside.
    const config: OfferRateLimitConfig = {
      ...baseConfig,
      quietHoursStart: "10:00",
      quietHoursEnd: "14:00",
      timezone: "UTC",
    };
    const result = gateOfferRateLimit(db, "topic-a", NOW, config);
    expect(result).toEqual({ decision: "skip", reason: "quiet_hours" });
  });

  it("fires when outside the quiet window", () => {
    seedCluster(db, "topic-a");
    const config: OfferRateLimitConfig = {
      ...baseConfig,
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
      timezone: "UTC",
    };
    // NOW = 12:00 UTC — outside the 22:00-07:00 window.
    const result = gateOfferRateLimit(db, "topic-a", NOW, config);
    expect(result).toEqual({ decision: "fire" });
  });
});

describe("isInQuietHours — windows that cross midnight", () => {
  it("treats 22:00-07:00 as quiet at 01:00", () => {
    const oneAm = Date.parse("2026-05-20T01:00:00Z");
    expect(isInQuietHours(oneAm, "22:00", "07:00", "UTC")).toBe(true);
  });

  it("treats 22:00-07:00 as quiet at 23:30", () => {
    const elevenThirtyPm = Date.parse("2026-05-20T23:30:00Z");
    expect(isInQuietHours(elevenThirtyPm, "22:00", "07:00", "UTC")).toBe(true);
  });

  it("treats 22:00-07:00 as NOT quiet at 12:00", () => {
    const noon = Date.parse("2026-05-20T12:00:00Z");
    expect(isInQuietHours(noon, "22:00", "07:00", "UTC")).toBe(false);
  });
});

describe("isInQuietHours — same-day windows", () => {
  it("treats 09:00-17:00 as quiet at 14:00", () => {
    const twoPm = Date.parse("2026-05-20T14:00:00Z");
    expect(isInQuietHours(twoPm, "09:00", "17:00", "UTC")).toBe(true);
  });

  it("treats 09:00-17:00 as NOT quiet at 22:00", () => {
    const tenPm = Date.parse("2026-05-20T22:00:00Z");
    expect(isInQuietHours(tenPm, "09:00", "17:00", "UTC")).toBe(false);
  });

  it("end of window is exclusive (17:00 itself is NOT inside 09:00-17:00)", () => {
    const fivePm = Date.parse("2026-05-20T17:00:00Z");
    expect(isInQuietHours(fivePm, "09:00", "17:00", "UTC")).toBe(false);
  });
});

describe("isInQuietHours — degenerate inputs", () => {
  it("returns false for an empty window (start === end)", () => {
    const now = Date.parse("2026-05-20T12:00:00Z");
    expect(isInQuietHours(now, "12:00", "12:00", "UTC")).toBe(false);
  });

  it("returns false for malformed time strings", () => {
    const now = Date.parse("2026-05-20T12:00:00Z");
    expect(isInQuietHours(now, "not-a-time", "07:00", "UTC")).toBe(false);
    expect(isInQuietHours(now, "22:00", "25:99", "UTC")).toBe(false);
  });
});
