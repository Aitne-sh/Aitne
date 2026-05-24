/**
 * Tests for `partial-extract-streak.ts`. Covers:
 *   - 3-row all-partial streak fires DM.
 *   - <3 partial rows → no fire.
 *   - One non-partial row inside the top-3 window → no fire.
 *   - 24h dedup window suppresses the second fire.
 *   - Dedup state ages out → fresh streak fires.
 *   - Notifier failure → dedup timestamp NOT written (retry-friendly).
 *   - notifier=null → streak detected but no DM (no_notifier
 *     suppression).
 *   - 7-day SELECT window — rows older than 7 days are excluded.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applySchema } from "../../db/schema.js";
import { readRuntimeState, writeRuntimeState } from "../../db/runtime-state.js";
import {
  PARTIAL_EXTRACT_DEDUP_KEY,
  maybeEmitPartialExtractStreakDm,
} from "./partial-extract-streak.js";

const STAGE_B_ACTION_TYPE = "routine.morning_routine_journal";

describe("maybeEmitPartialExtractStreakDm", () => {
  let db: Database.Database;
  let calls: Array<{ message: string }>;

  function makeNotifier() {
    return {
      notify: async (args: { message: string }) => {
        calls.push(args);
      },
    };
  }

  function makeFailingNotifier() {
    return {
      notify: async () => {
        throw new Error("dm-failed");
      },
    };
  }

  function seedRow(args: {
    eventId: string;
    dailyWrite: Record<string, unknown>;
    minutesAgo: number;
  }): void {
    db.prepare(
      `INSERT INTO agent_actions (event_id, action_type, result, detail, started_at, completed_at)
       VALUES (?, ?, 'success', ?, datetime('now', ?), datetime('now'))`,
    ).run(
      args.eventId,
      STAGE_B_ACTION_TYPE,
      JSON.stringify({ dailyWrite: args.dailyWrite }),
      `-${args.minutesAgo} minutes`,
    );
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    calls = [];
  });

  afterEach(() => {
    db.close();
  });

  it("fires DM when 3 most recent rows are all 'partial'", async () => {
    seedRow({
      eventId: "e3",
      dailyWrite: { ok: "partial", partialReason: "frontmatter_tag_missing" },
      minutesAgo: 10,
    });
    seedRow({
      eventId: "e2",
      dailyWrite: { ok: "partial", partialReason: "frontmatter_invalid_json" },
      minutesAgo: 24 * 60,
    });
    seedRow({
      eventId: "e1",
      dailyWrite: { ok: "partial", partialReason: "frontmatter_tag_missing" },
      minutesAgo: 48 * 60,
    });

    const result = await maybeEmitPartialExtractStreakDm({
      db,
      correlationId: "c",
      notifier: makeNotifier(),
    });

    expect(result.streakDetected).toBe(true);
    expect(result.dmSent).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].message).toMatch(/frontmatter_tag_missing × 2/);
    expect(calls[0].message).toMatch(/frontmatter_invalid_json × 1/);
    // Dedup timestamp written.
    expect(readRuntimeState<string>(db, PARTIAL_EXTRACT_DEDUP_KEY)).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });

  it("no fire when fewer than 3 Stage B rows in the 7-day window", async () => {
    seedRow({
      eventId: "e1",
      dailyWrite: { ok: "partial", partialReason: "frontmatter_tag_missing" },
      minutesAgo: 10,
    });

    const result = await maybeEmitPartialExtractStreakDm({
      db,
      correlationId: "c",
      notifier: makeNotifier(),
    });
    expect(result.streakDetected).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("no fire when one of the top-3 rows is 'complete'", async () => {
    seedRow({
      eventId: "e3",
      dailyWrite: { ok: "complete" },
      minutesAgo: 10,
    });
    seedRow({
      eventId: "e2",
      dailyWrite: { ok: "partial", partialReason: "frontmatter_tag_missing" },
      minutesAgo: 24 * 60,
    });
    seedRow({
      eventId: "e1",
      dailyWrite: { ok: "partial", partialReason: "frontmatter_tag_missing" },
      minutesAgo: 48 * 60,
    });

    const result = await maybeEmitPartialExtractStreakDm({
      db,
      correlationId: "c",
      notifier: makeNotifier(),
    });
    expect(result.streakDetected).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("dedup window suppresses the second fire within 24h", async () => {
    seedRow({ eventId: "e3", dailyWrite: { ok: "partial", partialReason: "frontmatter_tag_missing" }, minutesAgo: 10 });
    seedRow({ eventId: "e2", dailyWrite: { ok: "partial", partialReason: "frontmatter_tag_missing" }, minutesAgo: 24 * 60 });
    seedRow({ eventId: "e1", dailyWrite: { ok: "partial", partialReason: "frontmatter_tag_missing" }, minutesAgo: 48 * 60 });

    const now = new Date("2026-05-23T19:00:00.000Z");
    const r1 = await maybeEmitPartialExtractStreakDm({
      db,
      correlationId: "c",
      notifier: makeNotifier(),
      now: () => now,
    });
    expect(r1.dmSent).toBe(true);

    // Six hours later — still inside the 24h window.
    const r2 = await maybeEmitPartialExtractStreakDm({
      db,
      correlationId: "c",
      notifier: makeNotifier(),
      now: () => new Date(now.getTime() + 6 * 60 * 60 * 1000),
    });
    expect(r2.streakDetected).toBe(true);
    expect(r2.dmSent).toBe(false);
    expect(r2.suppressedReason).toBe("dedup_recent");
    expect(calls.length).toBe(1);
  });

  it("dedup expires after 24h — fresh streak fires again", async () => {
    seedRow({ eventId: "e3", dailyWrite: { ok: "partial", partialReason: "frontmatter_tag_missing" }, minutesAgo: 10 });
    seedRow({ eventId: "e2", dailyWrite: { ok: "partial", partialReason: "frontmatter_tag_missing" }, minutesAgo: 24 * 60 });
    seedRow({ eventId: "e1", dailyWrite: { ok: "partial", partialReason: "frontmatter_tag_missing" }, minutesAgo: 48 * 60 });

    // Pre-seed an old timestamp from 25 hours ago.
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeRuntimeState(db, PARTIAL_EXTRACT_DEDUP_KEY, past);

    const result = await maybeEmitPartialExtractStreakDm({
      db,
      correlationId: "c",
      notifier: makeNotifier(),
    });
    expect(result.dmSent).toBe(true);
    expect(calls.length).toBe(1);
  });

  it("notifier failure → dedup timestamp NOT written (retry-friendly)", async () => {
    seedRow({ eventId: "e3", dailyWrite: { ok: "partial", partialReason: "frontmatter_tag_missing" }, minutesAgo: 10 });
    seedRow({ eventId: "e2", dailyWrite: { ok: "partial", partialReason: "frontmatter_tag_missing" }, minutesAgo: 24 * 60 });
    seedRow({ eventId: "e1", dailyWrite: { ok: "partial", partialReason: "frontmatter_tag_missing" }, minutesAgo: 48 * 60 });

    const result = await maybeEmitPartialExtractStreakDm({
      db,
      correlationId: "c",
      notifier: makeFailingNotifier(),
    });
    expect(result.streakDetected).toBe(true);
    expect(result.dmSent).toBe(false);
    expect(result.suppressedReason).toBe("no_notifier");
    expect(readRuntimeState<string>(db, PARTIAL_EXTRACT_DEDUP_KEY)).toBeNull();
  });

  it("notifier=null → streak detected but no DM (no_notifier suppression)", async () => {
    seedRow({ eventId: "e3", dailyWrite: { ok: "partial", partialReason: "frontmatter_tag_missing" }, minutesAgo: 10 });
    seedRow({ eventId: "e2", dailyWrite: { ok: "partial", partialReason: "frontmatter_tag_missing" }, minutesAgo: 24 * 60 });
    seedRow({ eventId: "e1", dailyWrite: { ok: "partial", partialReason: "frontmatter_tag_missing" }, minutesAgo: 48 * 60 });

    const result = await maybeEmitPartialExtractStreakDm({
      db,
      correlationId: "c",
      notifier: null,
    });
    expect(result.streakDetected).toBe(true);
    expect(result.dmSent).toBe(false);
    expect(result.suppressedReason).toBe("no_notifier");
  });

  it("rows older than 7 days are excluded from the streak window", async () => {
    // Three "partial" rows but all > 7 days old — should NOT fire.
    seedRow({ eventId: "old1", dailyWrite: { ok: "partial", partialReason: "frontmatter_tag_missing" }, minutesAgo: 8 * 24 * 60 });
    seedRow({ eventId: "old2", dailyWrite: { ok: "partial", partialReason: "frontmatter_tag_missing" }, minutesAgo: 9 * 24 * 60 });
    seedRow({ eventId: "old3", dailyWrite: { ok: "partial", partialReason: "frontmatter_tag_missing" }, minutesAgo: 10 * 24 * 60 });

    const result = await maybeEmitPartialExtractStreakDm({
      db,
      correlationId: "c",
      notifier: makeNotifier(),
    });
    expect(result.streakDetected).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("malformed dedup timestamp is treated as 'never notified'", async () => {
    seedRow({ eventId: "e3", dailyWrite: { ok: "partial", partialReason: "frontmatter_tag_missing" }, minutesAgo: 10 });
    seedRow({ eventId: "e2", dailyWrite: { ok: "partial", partialReason: "frontmatter_tag_missing" }, minutesAgo: 24 * 60 });
    seedRow({ eventId: "e1", dailyWrite: { ok: "partial", partialReason: "frontmatter_tag_missing" }, minutesAgo: 48 * 60 });

    writeRuntimeState(db, PARTIAL_EXTRACT_DEDUP_KEY, "not-an-iso");

    const result = await maybeEmitPartialExtractStreakDm({
      db,
      correlationId: "c",
      notifier: makeNotifier(),
    });
    expect(result.dmSent).toBe(true);
  });
});
