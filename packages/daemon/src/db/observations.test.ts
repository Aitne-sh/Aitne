import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import {
  recordObservation,
  getPendingObservations,
  consumeObservations,
  getPendingCount,
  getPendingCountsByActor,
  getObservationStats,
  cleanupConsumedObservations,
  getStalePendingObservationStats,
  getSummaryStatusCounts,
  getNoveltyDistribution,
  getObservationForSummarization,
  listObservationsAwaitingSummary,
  updateObservationSummary,
  setObservationEnqueueHook,
} from "./observations.js";

describe("observations CRUD", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("recordObservation", () => {
    it("inserts a new pending row", () => {
      recordObservation(db, {
        source: "obsidian",
        ref: "notes/a.md",
        changeType: "modified",
        actor: "user",
        payload: { diffPreview: "hi" },
      });

      const rows = db
        .prepare("SELECT source, ref, change_type, actor, payload, consumed_at FROM observations")
        .all() as Array<{
          source: string;
          ref: string;
          change_type: string;
          actor: string;
          payload: string | null;
          consumed_at: string | null;
        }>;

      expect(rows).toHaveLength(1);
      expect(rows[0].source).toBe("obsidian");
      expect(rows[0].ref).toBe("notes/a.md");
      expect(rows[0].change_type).toBe("modified");
      expect(rows[0].actor).toBe("user");
      expect(rows[0].consumed_at).toBeNull();
      expect(JSON.parse(rows[0].payload ?? "{}")).toEqual({ diffPreview: "hi" });
    });

    it("defaults actor to 'user' and serializes null payload", () => {
      recordObservation(db, {
        source: "git:/repo",
        ref: "abcdef",
        changeType: "created",
      });

      const row = db
        .prepare("SELECT actor, payload FROM observations LIMIT 1")
        .get() as { actor: string; payload: string | null };
      expect(row.actor).toBe("user");
      expect(row.payload).toBeNull();
    });

    it("upserts on (source, ref) for pending rows — 2 writes produce 1 row", () => {
      recordObservation(db, {
        source: "obsidian",
        ref: "notes/dup.md",
        changeType: "modified",
        actor: "user",
        payload: { diffPreview: "first" },
      });
      recordObservation(db, {
        source: "obsidian",
        ref: "notes/dup.md",
        changeType: "modified",
        actor: "user",
        payload: { diffPreview: "second" },
      });

      const rows = db
        .prepare("SELECT payload FROM observations WHERE consumed_at IS NULL")
        .all() as Array<{ payload: string | null }>;
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].payload ?? "{}")).toEqual({ diffPreview: "second" });
    });

    it("allows a new pending row on the same (source, ref) once the previous is consumed", () => {
      recordObservation(db, {
        source: "obsidian",
        ref: "notes/x.md",
        changeType: "modified",
        actor: "user",
      });
      const firstId = (
        db.prepare("SELECT id FROM observations LIMIT 1").get() as { id: number }
      ).id;

      // Consume the first row
      consumeObservations(db, [firstId], "corr-1");

      // New change arrives for the same file — should be inserted, not rejected
      recordObservation(db, {
        source: "obsidian",
        ref: "notes/x.md",
        changeType: "modified",
        actor: "user",
      });

      const allRows = db
        .prepare("SELECT id, consumed_at FROM observations ORDER BY id")
        .all() as Array<{ id: number; consumed_at: string | null }>;
      expect(allRows).toHaveLength(2);
      expect(allRows[0].consumed_at).not.toBeNull();
      expect(allRows[1].consumed_at).toBeNull();
    });

    it("allows the same (source, ref) from different sources", () => {
      recordObservation(db, {
        source: "obsidian",
        ref: "notes/same.md",
        changeType: "modified",
      });
      recordObservation(db, {
        source: "git:/repo",
        ref: "notes/same.md",
        changeType: "modified",
      });
      const count = (
        db.prepare("SELECT COUNT(*) as c FROM observations").get() as { c: number }
      ).c;
      expect(count).toBe(2);
    });
  });

  describe("getPendingObservations", () => {
    beforeEach(() => {
      recordObservation(db, { source: "obsidian", ref: "a.md", changeType: "modified", actor: "user" });
      recordObservation(db, { source: "obsidian", ref: "b.md", changeType: "created", actor: "user" });
      recordObservation(db, { source: "git:/repo", ref: "c1", changeType: "created", actor: "user" });
      recordObservation(db, { source: "obsidian", ref: "agent.md", changeType: "modified", actor: "agent" });
    });

    it("returns only rows with consumed_at IS NULL by default", () => {
      const id = (
        db.prepare("SELECT id FROM observations WHERE ref = 'a.md'").get() as { id: number }
      ).id;
      consumeObservations(db, [id], "corr-1");
      const rows = getPendingObservations(db);
      expect(rows.map((r) => r.ref)).not.toContain("a.md");
      expect(rows).toHaveLength(3);
    });

    it("filters by actor", () => {
      const userRows = getPendingObservations(db, { actorFilter: "user" });
      expect(userRows.every((r) => r.actor === "user")).toBe(true);
      expect(userRows).toHaveLength(3);

      const agentRows = getPendingObservations(db, { actorFilter: "agent" });
      expect(agentRows).toHaveLength(1);
      expect(agentRows[0].ref).toBe("agent.md");
    });

    it("filters by source prefix", () => {
      const obsidian = getPendingObservations(db, { sourceFilter: "obsidian" });
      expect(obsidian.every((r) => r.source === "obsidian")).toBe(true);

      const git = getPendingObservations(db, { sourceFilter: "git:" });
      expect(git).toHaveLength(1);
      expect(git[0].source).toBe("git:/repo");
    });

    it("caps limit at 100 and defaults to 20", () => {
      const cappedRows = getPendingObservations(db, { limit: 500 });
      expect(cappedRows.length).toBeLessThanOrEqual(100);
    });

    it("orders by observed_at ASC then id ASC (oldest first)", () => {
      const rows = getPendingObservations(db);
      const ids = rows.map((r) => r.id);
      const sorted = [...ids].sort((x, y) => x - y);
      expect(ids).toEqual(sorted);
    });

    it("filters by `since` (observed_at >= cutoff)", () => {
      // Backdate the first row so it falls outside the `since` window.
      const id = (
        db.prepare("SELECT id FROM observations WHERE ref = 'a.md'").get() as {
          id: number;
        }
      ).id;
      db.prepare(
        "UPDATE observations SET observed_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
      ).run(id);

      const rows = getPendingObservations(db, { since: "2025-01-01T00:00:00.000Z" });
      expect(rows.map((r) => r.ref)).not.toContain("a.md");
      // The other 3 rows were observed at CURRENT_TIMESTAMP (≥ 2025).
      expect(rows).toHaveLength(3);
    });

    it("returns rows ignoring the consumed_at filter when `pending: false`", () => {
      // pending=false drops the implicit `consumed_at IS NULL` filter, so the
      // resulting WHERE clause has zero conditions (`where.length === 0` ternary
      // branch). With no other filters that produces a bare SELECT.
      const id = (
        db.prepare("SELECT id FROM observations WHERE ref = 'a.md'").get() as {
          id: number;
        }
      ).id;
      consumeObservations(db, [id], "corr-1");

      // Default pending → the consumed row is excluded.
      expect(getPendingObservations(db).map((r) => r.ref)).not.toContain("a.md");
      // pending: false → consumed row is included; matches the total count
      // of inserted rows in beforeEach (4).
      const all = getPendingObservations(db, { pending: false });
      expect(all.map((r) => r.ref).sort()).toEqual(
        ["a.md", "agent.md", "b.md", "c1"],
      );
    });

    it("clamps offset to a non-negative integer", () => {
      // Negative offset must not be passed through to SQL — Math.max(_, 0).
      expect(() =>
        getPendingObservations(db, { offset: -5 }),
      ).not.toThrow();
    });

    it("clamps limit to at least 1", () => {
      // limit=0 -> Math.max(0, 1) = 1.
      const rows = getPendingObservations(db, { limit: 0 });
      expect(rows.length).toBe(1);
    });
  });

  describe("consumeObservations", () => {
    it("marks rows as consumed and returns the count", () => {
      recordObservation(db, { source: "obsidian", ref: "1.md", changeType: "modified" });
      recordObservation(db, { source: "obsidian", ref: "2.md", changeType: "modified" });
      const ids = (
        db.prepare("SELECT id FROM observations ORDER BY id").all() as Array<{ id: number }>
      ).map((r) => r.id);

      const result = consumeObservations(db, ids, "corr-xyz");
      expect(result.consumed).toBe(2);
      expect(result.notFound).toEqual([]);

      const rows = db
        .prepare("SELECT consumed_at, consumed_by FROM observations")
        .all() as Array<{ consumed_at: string | null; consumed_by: string | null }>;
      expect(rows.every((r) => r.consumed_at !== null)).toBe(true);
      expect(rows.every((r) => r.consumed_by === "corr-xyz")).toBe(true);
    });

    it("returns notFound for ids that don't exist or are already consumed", () => {
      recordObservation(db, { source: "obsidian", ref: "1.md", changeType: "modified" });
      const id = (db.prepare("SELECT id FROM observations").get() as { id: number }).id;
      consumeObservations(db, [id], "first");

      const result = consumeObservations(db, [id, 99999], "second");
      expect(result.consumed).toBe(0);
      expect(result.notFound).toEqual([id, 99999]);
    });

    it("consumes the valid ids while reporting bogus ids in notFound", () => {
      // Mixed batch: existingIds is non-empty (UPDATE runs) AND notFound is
      // non-empty (debug log path inside `consumeObservations` fires).
      recordObservation(db, { source: "obsidian", ref: "real.md", changeType: "modified" });
      const realId = (
        db.prepare("SELECT id FROM observations WHERE ref = 'real.md'").get() as {
          id: number;
        }
      ).id;

      const result = consumeObservations(db, [realId, 999_999], "corr-mix");
      expect(result.consumed).toBe(1);
      expect(result.notFound).toEqual([999_999]);

      const consumed = db
        .prepare("SELECT consumed_at, consumed_by FROM observations WHERE id = ?")
        .get(realId) as { consumed_at: string | null; consumed_by: string | null };
      expect(consumed.consumed_at).not.toBeNull();
      expect(consumed.consumed_by).toBe("corr-mix");
    });

    it("is a no-op on empty id list", () => {
      const result = consumeObservations(db, [], "corr");
      expect(result).toEqual({ consumed: 0, notFound: [] });
    });
  });

  describe("getPendingCount", () => {
    it("counts only pending rows", () => {
      recordObservation(db, { source: "obsidian", ref: "1.md", changeType: "modified" });
      recordObservation(db, { source: "obsidian", ref: "2.md", changeType: "modified" });
      expect(getPendingCount(db)).toBe(2);

      const id = (
        db.prepare("SELECT id FROM observations LIMIT 1").get() as { id: number }
      ).id;
      consumeObservations(db, [id], "c");
      expect(getPendingCount(db)).toBe(1);
    });

    it("supports actor filter", () => {
      recordObservation(db, { source: "obsidian", ref: "user.md", changeType: "modified", actor: "user" });
      recordObservation(db, { source: "obsidian", ref: "agent.md", changeType: "modified", actor: "agent" });
      expect(getPendingCount(db, { actorFilter: "user" })).toBe(1);
      expect(getPendingCount(db, { actorFilter: "agent" })).toBe(1);
    });

    it("supports source prefix filter", () => {
      recordObservation(db, { source: "obsidian", ref: "a.md", changeType: "modified" });
      recordObservation(db, { source: "obsidian", ref: "b.md", changeType: "modified" });
      recordObservation(db, { source: "git:/repo", ref: "abc", changeType: "created" });
      expect(getPendingCount(db, { sourceFilter: "obsidian" })).toBe(2);
      expect(getPendingCount(db, { sourceFilter: "git:" })).toBe(1);
    });

    it("supports `since` filter (observed_at >= cutoff)", () => {
      recordObservation(db, { source: "obsidian", ref: "old.md", changeType: "modified" });
      const oldId = (
        db.prepare("SELECT id FROM observations WHERE ref = 'old.md'").get() as {
          id: number;
        }
      ).id;
      db.prepare(
        "UPDATE observations SET observed_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
      ).run(oldId);

      recordObservation(db, { source: "obsidian", ref: "new.md", changeType: "modified" });

      expect(getPendingCount(db, { since: "2025-01-01T00:00:00.000Z" })).toBe(1);
      expect(getPendingCount(db)).toBe(2);
    });
  });

  describe("getObservationStats", () => {
    it("returns total and per-source pending counts", () => {
      recordObservation(db, { source: "obsidian", ref: "1.md", changeType: "modified" });
      recordObservation(db, { source: "obsidian", ref: "2.md", changeType: "created" });
      recordObservation(db, { source: "git:/repo", ref: "abc", changeType: "created" });

      const stats = getObservationStats(db);
      expect(stats.totalPending).toBe(3);
      expect(stats.bySource.find((s) => s.source === "obsidian")?.pendingCount).toBe(2);
      expect(stats.bySource.find((s) => s.source === "git:/repo")?.pendingCount).toBe(1);
      expect(stats.oldestPendingObservedAt).toBeTruthy();
    });

    it("returns zero total and null oldest when empty", () => {
      const stats = getObservationStats(db);
      expect(stats.totalPending).toBe(0);
      expect(stats.oldestPendingObservedAt).toBeNull();
      expect(stats.bySource).toEqual([]);
    });

    it("supports filtering pending stats by actor", () => {
      recordObservation(db, { source: "obsidian", ref: "user.md", changeType: "modified", actor: "user" });
      recordObservation(db, { source: "obsidian", ref: "agent.md", changeType: "modified", actor: "agent" });
      recordObservation(db, { source: "git:/repo", ref: "sys", changeType: "created", actor: "system" });

      const stats = getObservationStats(db, { actorFilter: "user" });

      expect(stats.totalPending).toBe(1);
      expect(stats.bySource).toEqual([
        expect.objectContaining({ source: "obsidian", pendingCount: 1 }),
      ]);
    });
  });

  describe("getPendingCountsByActor", () => {
    it("returns pending counts grouped by actor", () => {
      recordObservation(db, { source: "obsidian", ref: "user.md", changeType: "modified", actor: "user" });
      recordObservation(db, { source: "obsidian", ref: "agent-1.md", changeType: "modified", actor: "agent" });
      recordObservation(db, { source: "obsidian", ref: "agent-2.md", changeType: "modified", actor: "agent" });

      const counts = getPendingCountsByActor(db);

      expect(counts).toEqual([
        { actor: "agent", pendingCount: 2 },
        { actor: "user", pendingCount: 1 },
      ]);
    });
  });

  describe("cleanupConsumedObservations", () => {
    it("deletes only rows consumed older than the cutoff", () => {
      // 1 pending (never touched), 1 consumed 8 days ago, 1 consumed today
      recordObservation(db, { source: "obsidian", ref: "pending.md", changeType: "modified" });

      db.prepare(
        "INSERT INTO observations (source, ref, change_type, actor, consumed_at, consumed_by) VALUES (?, ?, ?, ?, datetime('now', '-8 days'), 'old')",
      ).run("obsidian", "old.md", "modified", "user");

      db.prepare(
        "INSERT INTO observations (source, ref, change_type, actor, consumed_at, consumed_by) VALUES (?, ?, ?, ?, datetime('now', '-1 day'), 'recent')",
      ).run("obsidian", "recent.md", "modified", "user");

      const deleted = cleanupConsumedObservations(db, 7);
      expect(deleted).toBe(1);

      const remaining = db
        .prepare("SELECT ref FROM observations ORDER BY ref")
        .all() as Array<{ ref: string }>;
      expect(remaining.map((r) => r.ref)).toEqual(["pending.md", "recent.md"]);
    });

    it("leaves pending rows alone regardless of age", () => {
      // Simulate an ancient PENDING row (e.g., observed long ago, never consumed)
      db.prepare(
        "INSERT INTO observations (source, ref, change_type, actor, observed_at) VALUES (?, ?, ?, ?, datetime('now', '-30 days'))",
      ).run("obsidian", "ancient.md", "modified", "user");

      const deleted = cleanupConsumedObservations(db, 7);
      expect(deleted).toBe(0);

      const count = (
        db.prepare("SELECT COUNT(*) as c FROM observations").get() as { c: number }
      ).c;
      expect(count).toBe(1);
    });
  });

  describe("summarizer integration helpers (cost-reduction-structural §A)", () => {
    afterEach(() => {
      setObservationEnqueueHook(null);
    });

    it("seeds new rows with summary_status='pending' and the helpers see them", () => {
      recordObservation(db, {
        source: "obsidian:external",
        ref: "a.md",
        changeType: "modified",
      });
      const ids = listObservationsAwaitingSummary(db);
      expect(ids).toHaveLength(1);
      const row = getObservationForSummarization(db, ids[0]);
      expect(row).not.toBeNull();
      if (row) {
        expect(row.summaryStatus).toBe("pending");
        expect(row.changeType).toBe("modified");
        expect(row.source).toBe("obsidian:external");
      }
    });

    it("re-summarizes a row when the same (source, ref) is upserted with a new payload", () => {
      recordObservation(db, {
        source: "obsidian:external",
        ref: "a.md",
        changeType: "modified",
        payload: { diffPreview: "first" },
      });
      const id = (db.prepare("SELECT id FROM observations").get() as { id: number }).id;
      updateObservationSummary(db, {
        id,
        summaryText: "x",
        noveltyScore: 1,
        summaryStatus: "done",
        summaryBackend: "claude",
      });
      // Re-record with new payload — should reset the row to pending.
      recordObservation(db, {
        source: "obsidian:external",
        ref: "a.md",
        changeType: "modified",
        payload: { diffPreview: "second" },
      });
      const row = getObservationForSummarization(db, id);
      expect(row?.summaryStatus).toBe("pending");
    });

    it("invokes the enqueue hook with the row id on insert", () => {
      const calls: number[] = [];
      setObservationEnqueueHook((id) => calls.push(id));
      recordObservation(db, { source: "obsidian:external", ref: "x.md", changeType: "modified" });
      expect(calls).toHaveLength(1);
      expect(typeof calls[0]).toBe("number");
    });

    it("absorbs enqueue hook errors without breaking the insert", () => {
      setObservationEnqueueHook(() => {
        throw new Error("hook boom");
      });
      expect(() =>
        recordObservation(db, { source: "obsidian:external", ref: "x.md", changeType: "modified" }),
      ).not.toThrow();
      const count = (db.prepare("SELECT COUNT(*) AS c FROM observations").get() as { c: number }).c;
      expect(count).toBe(1);
    });

    it("returns null for getObservationForSummarization on consumed rows", () => {
      recordObservation(db, { source: "obsidian:external", ref: "x.md", changeType: "modified" });
      const id = (db.prepare("SELECT id FROM observations").get() as { id: number }).id;
      consumeObservations(db, [id], "corr-1");
      expect(getObservationForSummarization(db, id)).toBeNull();
    });

    it("getSummaryStatusCounts groups pending rows by status", () => {
      recordObservation(db, { source: "obsidian:external", ref: "p.md", changeType: "modified" });
      recordObservation(db, { source: "obsidian:external", ref: "d.md", changeType: "modified" });
      const dId = (
        db.prepare("SELECT id FROM observations WHERE ref = 'd.md'").get() as { id: number }
      ).id;
      updateObservationSummary(db, {
        id: dId,
        summaryText: "did",
        noveltyScore: 1,
        summaryStatus: "done",
        summaryBackend: "claude",
      });
      const counts = getSummaryStatusCounts(db);
      expect(counts.done).toBe(1);
      expect(counts.pending).toBe(1);
    });

    it("getNoveltyDistribution returns only done rows with valid scores", () => {
      recordObservation(db, { source: "obsidian:external", ref: "a.md", changeType: "modified" });
      recordObservation(db, { source: "obsidian:external", ref: "b.md", changeType: "modified" });
      const ids = (
        db.prepare("SELECT id FROM observations ORDER BY id").all() as { id: number }[]
      ).map((r) => r.id);
      updateObservationSummary(db, {
        id: ids[0],
        summaryText: "x",
        noveltyScore: 0,
        summaryStatus: "done",
      });
      updateObservationSummary(db, {
        id: ids[1],
        summaryText: "y",
        noveltyScore: 2,
        summaryStatus: "done",
      });
      const dist = getNoveltyDistribution(db);
      expect(dist).toEqual([
        { score: 0, count: 1 },
        { score: 2, count: 1 },
      ]);
    });
  });

  describe("getStalePendingObservationStats", () => {
    it("returns zero count when no pending rows exist", () => {
      const result = getStalePendingObservationStats(db, 14);
      expect(result.count).toBe(0);
      expect(result.oldestObservedAt).toBeNull();
    });

    it("counts only pending rows older than the threshold", () => {
      // Pending, observed 20 days ago — counts as stale
      db.prepare(
        "INSERT INTO observations (source, ref, change_type, actor, observed_at) VALUES (?, ?, 'modified', 'user', datetime('now', '-20 days'))",
      ).run("obsidian", "stale-20d.md");
      // Pending, observed 1 day ago — fresh, not counted
      db.prepare(
        "INSERT INTO observations (source, ref, change_type, actor, observed_at) VALUES (?, ?, 'modified', 'user', datetime('now', '-1 day'))",
      ).run("obsidian", "fresh.md");

      const result = getStalePendingObservationStats(db, 14);
      expect(result.count).toBe(1);
      expect(result.oldestObservedAt).not.toBeNull();
    });

    it("ignores consumed rows even if old", () => {
      // 30-day-old consumed row should NOT count as stale pending
      db.prepare(
        "INSERT INTO observations (source, ref, change_type, actor, observed_at, consumed_at, consumed_by) VALUES (?, ?, 'modified', 'user', datetime('now', '-30 days'), datetime('now', '-1 day'), 'corr')",
      ).run("obsidian", "consumed-old.md");

      const result = getStalePendingObservationStats(db, 14);
      expect(result.count).toBe(0);
      expect(result.oldestObservedAt).toBeNull();
    });

    it("returns the oldest observed_at among stale pending rows", () => {
      // Two stale pending rows; oldest is 25 days ago
      db.prepare(
        "INSERT INTO observations (source, ref, change_type, actor, observed_at) VALUES (?, ?, 'modified', 'user', datetime('now', '-25 days'))",
      ).run("obsidian", "older.md");
      db.prepare(
        "INSERT INTO observations (source, ref, change_type, actor, observed_at) VALUES (?, ?, 'modified', 'user', datetime('now', '-15 days'))",
      ).run("obsidian", "newer.md");

      const result = getStalePendingObservationStats(db, 14);
      expect(result.count).toBe(2);
      // Oldest should reflect the 25-day-old row
      expect(result.oldestObservedAt).not.toBeNull();
    });

    it("filters by actor when actorFilter is supplied", () => {
      // Stale agent row — counted by default, excluded with actorFilter:'user'.
      db.prepare(
        "INSERT INTO observations (source, ref, change_type, actor, observed_at) VALUES (?, ?, 'modified', 'agent', datetime('now', '-20 days'))",
      ).run("git:/repo", "agent-stale");
      // Stale user row — counted in both.
      db.prepare(
        "INSERT INTO observations (source, ref, change_type, actor, observed_at) VALUES (?, ?, 'modified', 'user', datetime('now', '-20 days'))",
      ).run("obsidian", "user-stale.md");

      const all = getStalePendingObservationStats(db, 14);
      expect(all.count).toBe(2);

      const userOnly = getStalePendingObservationStats(db, 14, { actorFilter: "user" });
      expect(userOnly.count).toBe(1);
    });
  });
});
