import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  getSnapshotNormalizer,
  type IntegrationNormalizer,
} from "@aitne/shared";
import { applySchema } from "../../db/schema.js";
import {
  markIntegrationWrite,
  reconcile,
  type ReconcileItem,
  type ReconcileRequest,
} from "./reconcile.js";

const calendar = getSnapshotNormalizer("google_calendar") as IntegrationNormalizer;

interface RawCalendarEvent {
  id: string;
  summary?: string;
  start?: { dateTime: string };
  end?: { dateTime: string };
  location?: string;
  attendees?: Array<{ email: string; responseStatus?: string }>;
  recurringEventId?: string;
}

function buildItem(raw: RawCalendarEvent): ReconcileItem {
  const payload = calendar.payload(raw);
  return {
    itemId: calendar.itemId(raw),
    contentHash: calendar.hash(payload),
    payload,
    itemStart: calendar.itemStart(raw),
  };
}

const WINDOW_MIN = "2026-04-28T00:00:00Z";
const WINDOW_MAX = "2026-04-29T00:00:00Z";

function buildRequest(
  items: ReconcileItem[],
  overrides: Partial<ReconcileRequest> = {},
): ReconcileRequest {
  return {
    integration: "google_calendar",
    windowKey: "primary:24h",
    windowMin: WINDOW_MIN,
    windowMax: WINDOW_MAX,
    fetchedAt: "2026-04-28T12:00:00Z",
    items,
    ...overrides,
  };
}

describe("reconcile", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("treats first call as initial snapshot — emits no diff entries", () => {
    const items = [
      buildItem({
        id: "evt-1",
        summary: "A",
        start: { dateTime: "2026-04-28T09:00:00Z" },
      }),
      buildItem({
        id: "evt-2",
        summary: "B",
        start: { dateTime: "2026-04-28T10:00:00Z" },
      }),
    ];
    const result = reconcile(db, buildRequest(items), { normalizer: calendar });
    expect(result.isInitialSnapshot).toBe(true);
    expect(result.created).toHaveLength(0);
    expect(result.modified).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
    expect(result.unchanged).toBe(0);

    // Snapshot rows are written even on the initial call so the next
    // reconcile has a baseline.
    const rows = db
      .prepare(
        "SELECT item_id FROM integration_snapshots WHERE integration = 'google_calendar' AND window_key = 'primary:24h' ORDER BY item_id",
      )
      .all() as { item_id: string }[];
    expect(rows.map((r) => r.item_id)).toEqual(["evt-1", "evt-2"]);
  });

  it("respects caller-supplied isInitialSnapshot=true even when prior is non-empty", () => {
    // Seed a snapshot row.
    reconcile(
      db,
      buildRequest([
        buildItem({ id: "evt-old", start: { dateTime: "2026-04-28T08:00:00Z" } }),
      ]),
      { normalizer: calendar },
    );
    // Caller asserts a fresh snapshot — diff stays silent even though
    // prior rows exist (they will be deleted but no observation).
    const result = reconcile(
      db,
      buildRequest(
        [buildItem({ id: "evt-1", start: { dateTime: "2026-04-28T09:00:00Z" } })],
        { isInitialSnapshot: true },
      ),
      { normalizer: calendar },
    );
    expect(result.isInitialSnapshot).toBe(true);
    expect(result.created).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
  });

  it("emits created/modified/deleted on subsequent calls", () => {
    // Seed.
    reconcile(
      db,
      buildRequest([
        buildItem({
          id: "evt-1",
          summary: "A",
          start: { dateTime: "2026-04-28T09:00:00Z" },
        }),
        buildItem({
          id: "evt-2",
          summary: "B",
          start: { dateTime: "2026-04-28T10:00:00Z" },
        }),
      ]),
      { normalizer: calendar },
    );

    // evt-1 modified, evt-2 unchanged, evt-3 created, evt-2 still present.
    // Wait — to test deleted, drop evt-2.
    const result = reconcile(
      db,
      buildRequest([
        buildItem({
          id: "evt-1",
          summary: "A renamed",
          start: { dateTime: "2026-04-28T09:00:00Z" },
        }),
        buildItem({
          id: "evt-3",
          summary: "C",
          start: { dateTime: "2026-04-28T11:00:00Z" },
        }),
      ]),
      { normalizer: calendar },
    );

    expect(result.isInitialSnapshot).toBe(false);
    expect(result.created.map((c) => c.itemId)).toEqual(["evt-3"]);
    expect(result.modified.map((m) => m.itemId)).toEqual(["evt-1"]);
    expect(result.deleted.map((d) => d.itemId)).toEqual(["evt-2"]);
    expect(result.unchanged).toBe(0);

    const m = result.modified[0];
    expect(m.prior).toBeDefined();
    expect(m.current).toBeDefined();
    expect(m.prior.contentHash).not.toBe(m.current.contentHash);
  });

  it("treats an empty first fetch as an initialized partition", () => {
    const emptyInitial = reconcile(db, buildRequest([]), { normalizer: calendar });
    expect(emptyInitial.isInitialSnapshot).toBe(true);

    const result = reconcile(
      db,
      buildRequest([
        buildItem({
          id: "evt-after-empty",
          summary: "New after empty baseline",
          start: { dateTime: "2026-04-28T09:00:00Z" },
        }),
      ]),
      { normalizer: calendar },
    );

    expect(result.isInitialSnapshot).toBe(false);
    expect(result.created.map((c) => c.itemId)).toEqual(["evt-after-empty"]);
  });

  it("re-emits created after a previously populated partition was fully drained", () => {
    // Regression for the partition-init/prior-set conflation: a sparse
    // user calendar can legitimately reach an empty partition (every prior
    // event slid out or was deleted), and the *next* additive change must
    // surface as `created` rather than be silently absorbed as another
    // initial snapshot. Without `runtime_state`-backed init tracking this
    // path was broken — the second `reconcile([])` would re-trigger the
    // silent-initial branch via `prior.size === 0`.
    reconcile(
      db,
      buildRequest([
        buildItem({
          id: "evt-original",
          start: { dateTime: "2026-04-28T09:00:00Z" },
        }),
      ]),
      { normalizer: calendar },
    );
    const drained = reconcile(db, buildRequest([]), { normalizer: calendar });
    expect(drained.isInitialSnapshot).toBe(false);
    expect(drained.deleted.map((d) => d.itemId)).toEqual(["evt-original"]);

    const refilled = reconcile(
      db,
      buildRequest([
        buildItem({
          id: "evt-after-drain",
          start: { dateTime: "2026-04-28T15:00:00Z" },
        }),
      ]),
      { normalizer: calendar },
    );
    expect(refilled.isInitialSnapshot).toBe(false);
    expect(refilled.created.map((c) => c.itemId)).toEqual(["evt-after-drain"]);
  });

  it("counts unchanged items and bumps fetched_at without writing diff entries", () => {
    const item = buildItem({
      id: "evt-1",
      summary: "A",
      start: { dateTime: "2026-04-28T09:00:00Z" },
    });
    reconcile(db, buildRequest([item], { fetchedAt: "2026-04-28T11:00:00Z" }), {
      normalizer: calendar,
    });
    const result = reconcile(
      db,
      buildRequest([item], { fetchedAt: "2026-04-28T12:00:00Z" }),
      { normalizer: calendar },
    );
    expect(result.created).toHaveLength(0);
    expect(result.modified).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
    expect(result.unchanged).toBe(1);

    const row = db
      .prepare(
        "SELECT fetched_at FROM integration_snapshots WHERE item_id = ?",
      )
      .get("evt-1") as { fetched_at: string };
    expect(row.fetched_at).toBe("2026-04-28T12:00:00Z");
  });

  it("is idempotent — running twice with the same input returns identical zero-diff", () => {
    const items = [
      buildItem({ id: "evt-1", start: { dateTime: "2026-04-28T09:00:00Z" } }),
    ];
    reconcile(db, buildRequest(items), { normalizer: calendar });
    const a = reconcile(db, buildRequest(items), { normalizer: calendar });
    const b = reconcile(db, buildRequest(items), { normalizer: calendar });
    expect(a).toEqual(b);
    expect(a.created).toHaveLength(0);
    expect(a.modified).toHaveLength(0);
    expect(a.deleted).toHaveLength(0);
    expect(a.unchanged).toBe(1);
  });

  describe("§5.1 sliding-window predicate", () => {
    it("does NOT emit deleted when prior item slid out of [windowMin, windowMax)", () => {
      // Seed an event whose start is 09:00. Window covers all of 28th.
      reconcile(
        db,
        buildRequest([
          buildItem({
            id: "imminent-evt",
            start: { dateTime: "2026-04-28T09:00:00Z" },
          }),
        ]),
        { normalizer: calendar },
      );
      // Re-fetch with a window that no longer includes 09:00 (slid past).
      const result = reconcile(
        db,
        buildRequest([], {
          windowMin: "2026-04-28T10:00:00Z",
          windowMax: "2026-04-28T11:00:00Z",
          fetchedAt: "2026-04-28T10:30:00Z",
        }),
        { normalizer: calendar },
      );
      expect(result.deleted).toHaveLength(0);
      expect(result.prunedOutOfWindow).toBe(1);

      // Snapshot row was deleted regardless — partition's prior set should
      // be empty.
      const remaining = db
        .prepare(
          "SELECT count(*) AS c FROM integration_snapshots WHERE integration = 'google_calendar' AND window_key = 'primary:24h'",
        )
        .get() as { c: number };
      expect(remaining.c).toBe(0);
    });

    it("DOES emit deleted when prior item is still in window but missing from new fetch", () => {
      // Seed.
      reconcile(
        db,
        buildRequest([
          buildItem({
            id: "evt-removed",
            start: { dateTime: "2026-04-28T15:00:00Z" },
          }),
        ]),
        { normalizer: calendar },
      );
      // Re-fetch with the same window — the event was truly removed upstream.
      const result = reconcile(db, buildRequest([]), { normalizer: calendar });
      expect(result.deleted.map((d) => d.itemId)).toEqual(["evt-removed"]);
      expect(result.prunedOutOfWindow).toBe(0);
    });
  });

  describe("actor resolution", () => {
    it("resolves actor=user by default for new items", () => {
      // Seed a baseline so subsequent diff is not the silent-initial path.
      reconcile(
        db,
        buildRequest([
          buildItem({
            id: "evt-seed",
            start: { dateTime: "2026-04-28T08:00:00Z" },
          }),
        ]),
        { normalizer: calendar },
      );
      const result = reconcile(
        db,
        buildRequest([
          buildItem({
            id: "evt-seed",
            start: { dateTime: "2026-04-28T08:00:00Z" },
          }),
          buildItem({
            id: "evt-1",
            start: { dateTime: "2026-04-28T09:00:00Z" },
          }),
        ]),
        { normalizer: calendar },
      );
      expect(result.created[0].actor).toBe("user");
    });

    it("honours caller actorHint when integration_writes has no row", () => {
      reconcile(
        db,
        buildRequest([
          buildItem({
            id: "evt-seed",
            start: { dateTime: "2026-04-28T08:00:00Z" },
          }),
        ]),
        { normalizer: calendar },
      );
      const item = buildItem({
        id: "evt-1",
        start: { dateTime: "2026-04-28T09:00:00Z" },
      });
      const result = reconcile(
        db,
        buildRequest([
          buildItem({
            id: "evt-seed",
            start: { dateTime: "2026-04-28T08:00:00Z" },
          }),
          { ...item, actorHint: "system" },
        ]),
        { normalizer: calendar },
      );
      expect(result.created[0].actor).toBe("system");
    });

    it("integration_writes wins over caller actorHint", () => {
      reconcile(
        db,
        buildRequest([
          buildItem({
            id: "evt-seed",
            start: { dateTime: "2026-04-28T08:00:00Z" },
          }),
        ]),
        { normalizer: calendar },
      );
      // Mark the new item as agent-written.
      markIntegrationWrite(db, {
        integration: "google_calendar",
        itemId: "evt-1",
        ttlMs: 15 * 60 * 1000,
        nowIso: "2026-04-28T11:55:00Z",
      });
      const item = buildItem({
        id: "evt-1",
        start: { dateTime: "2026-04-28T09:00:00Z" },
      });
      const result = reconcile(
        db,
        buildRequest(
          [
            buildItem({
              id: "evt-seed",
              start: { dateTime: "2026-04-28T08:00:00Z" },
            }),
            { ...item, actorHint: "user" }, // explicit hint, ignored
          ],
          { fetchedAt: "2026-04-28T12:00:00Z" },
        ),
        { normalizer: calendar },
      );
      expect(result.created[0].actor).toBe("agent");
    });

    it("expired integration_writes row falls through to default actor", () => {
      reconcile(
        db,
        buildRequest([
          buildItem({
            id: "evt-seed",
            start: { dateTime: "2026-04-28T08:00:00Z" },
          }),
        ]),
        { normalizer: calendar },
      );
      markIntegrationWrite(db, {
        integration: "google_calendar",
        itemId: "evt-1",
        ttlMs: 1,
        nowIso: "2026-04-28T10:00:00Z",
      });
      const item = buildItem({
        id: "evt-1",
        start: { dateTime: "2026-04-28T09:00:00Z" },
      });
      const result = reconcile(
        db,
        buildRequest(
          [
            buildItem({
              id: "evt-seed",
              start: { dateTime: "2026-04-28T08:00:00Z" },
            }),
            item,
          ],
          { fetchedAt: "2026-04-28T11:00:00Z" },
        ),
        { normalizer: calendar },
      );
      expect(result.created[0].actor).toBe("user");
    });

    it("modified diff entries also resolve through integration_writes", () => {
      const original = buildItem({
        id: "evt-1",
        summary: "A",
        start: { dateTime: "2026-04-28T09:00:00Z" },
      });
      reconcile(db, buildRequest([original]), { normalizer: calendar });

      markIntegrationWrite(db, {
        integration: "google_calendar",
        itemId: "evt-1",
        ttlMs: 15 * 60 * 1000,
        nowIso: "2026-04-28T11:55:00Z",
      });

      const modified = buildItem({
        id: "evt-1",
        summary: "A renamed",
        start: { dateTime: "2026-04-28T09:00:00Z" },
      });
      const result = reconcile(
        db,
        buildRequest([modified], { fetchedAt: "2026-04-28T12:00:00Z" }),
        { normalizer: calendar },
      );
      expect(result.modified).toHaveLength(1);
      expect(result.modified[0].actor).toBe("agent");
    });
  });

  it("invokes onDiffInTransaction with the diff inside the same transaction", () => {
    // Phase 2 wires drift-effects through this callback; the contract is
    // that side effects (observation insertion, today_refresh schedule)
    // commit atomically with the snapshot rows. Verify the callback fires
    // exactly once with the resolved diff and that a throw inside it
    // rolls back the snapshot write so a partial-state crash cannot leave
    // the partition out of sync with the observation log.
    reconcile(
      db,
      buildRequest([
        buildItem({
          id: "evt-1",
          start: { dateTime: "2026-04-28T09:00:00Z" },
        }),
      ]),
      { normalizer: calendar },
    );
    const diffs: import("./reconcile.js").ReconcileDiff[] = [];
    reconcile(
      db,
      buildRequest([
        buildItem({
          id: "evt-1",
          summary: "renamed",
          start: { dateTime: "2026-04-28T09:00:00Z" },
        }),
      ]),
      {
        normalizer: calendar,
        onDiffInTransaction: (diff) => diffs.push(diff),
      },
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0].modified.map((m) => m.itemId)).toEqual(["evt-1"]);

    // Now throw inside the callback — the snapshot upsert from this run
    // must roll back so subsequent reconciles see the prior payload.
    expect(() =>
      reconcile(
        db,
        buildRequest([
          buildItem({
            id: "evt-1",
            summary: "would-be-rolled-back",
            start: { dateTime: "2026-04-28T09:00:00Z" },
          }),
        ]),
        {
          normalizer: calendar,
          onDiffInTransaction: () => {
            throw new Error("simulated phase-2 effect failure");
          },
        },
      ),
    ).toThrow(/simulated phase-2 effect failure/);

    const row = db
      .prepare(
        "SELECT payload_json FROM integration_snapshots WHERE item_id = ?",
      )
      .get("evt-1") as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as { summary: string };
    expect(payload.summary).toBe("renamed");
  });

  it("prefers resolveActorHint for deleted items over the prior snapshot's stored actor_hint", () => {
    // Deletions read the actor from the prior snapshot row by default
    // (e.g. an agent-created event the user later cancels still surfaces
    // as actor='agent' for traceability). When a daemon-internal caller
    // also wires a fresh resolveActorHint — for instance the calendar
    // route's AgentWriteTracker holding the most recent attribution — the
    // resolver should win over the snapshot's possibly-stale value.
    reconcile(
      db,
      buildRequest([
        buildItem({
          id: "evt-1",
          start: { dateTime: "2026-04-28T09:00:00Z" },
        }),
      ]),
      { normalizer: calendar },
    );
    const result = reconcile(
      db,
      buildRequest([]),
      {
        normalizer: calendar,
        resolveActorHint: () => "system",
      },
    );
    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0].actor).toBe("system");
  });

  it("consults resolveActorHint for new items only when integration_writes has no row", () => {
    // Daemon-internal callers (e.g. CalendarPoller) bridge their existing
    // path-keyed AgentWriteTracker into reconcile via the resolveActorHint
    // dep. Verify it's used as a fallback after integration_writes and
    // before the caller's request-body actorHint.
    reconcile(
      db,
      buildRequest([
        buildItem({
          id: "evt-seed",
          start: { dateTime: "2026-04-28T08:00:00Z" },
        }),
      ]),
      { normalizer: calendar },
    );
    const seen: Array<{ integration: string; itemId: string }> = [];
    const result = reconcile(
      db,
      buildRequest([
        buildItem({
          id: "evt-seed",
          start: { dateTime: "2026-04-28T08:00:00Z" },
        }),
        buildItem({
          id: "evt-from-poller",
          start: { dateTime: "2026-04-28T09:00:00Z" },
        }),
      ]),
      {
        normalizer: calendar,
        resolveActorHint: (integration, itemId) => {
          seen.push({ integration, itemId });
          return itemId === "evt-from-poller" ? "agent" : null;
        },
      },
    );
    expect(seen).toContainEqual({
      integration: "google_calendar",
      itemId: "evt-from-poller",
    });
    const created = result.created.find((c) => c.itemId === "evt-from-poller");
    expect(created?.actor).toBe("agent");
  });

  it("treats omitted itemStart as null without throwing", () => {
    // The route handler always supplies itemStart via the normalizer, but
    // reconcile's function-level contract accepts undefined (for callers
    // that key on integrations without a scheduled-start field).
    const item = {
      itemId: "no-time-evt",
      contentHash: "abc",
      payload: { foo: "bar" },
    };
    const result = reconcile(db, buildRequest([item]), { normalizer: calendar });
    expect(result.isInitialSnapshot).toBe(true);
    const row = db
      .prepare("SELECT item_start FROM integration_snapshots WHERE item_id = ?")
      .get("no-time-evt") as { item_start: string | null };
    expect(row.item_start).toBeNull();
  });

  it("dry-run computes the diff but writes nothing to the snapshot table or runtime_state", () => {
    // First reconcile (apply) seeds evt-1 in the partition.
    reconcile(
      db,
      buildRequest([
        buildItem({ id: "evt-1", start: { dateTime: "2026-04-28T09:00:00Z" } }),
      ]),
      { normalizer: calendar },
    );

    // Snapshot the partition state so we can compare after the dry-run.
    const before = db
      .prepare(
        "SELECT item_id, content_hash, payload_json FROM integration_snapshots WHERE integration = ? AND window_key = ? ORDER BY item_id",
      )
      .all("google_calendar", "primary:24h");
    const sideEffects: Array<unknown> = [];

    // Dry-run: send a different summary so the would-be diff is `modified`.
    const dryResult = reconcile(
      db,
      buildRequest(
        [
          buildItem({
            id: "evt-1",
            summary: "Renamed",
            start: { dateTime: "2026-04-28T09:00:00Z" },
          }),
        ],
        { mode: "dry-run" },
      ),
      {
        normalizer: calendar,
        onDiffInTransaction: (d) => sideEffects.push(d),
      },
    );

    expect(dryResult.modified).toHaveLength(1);
    expect(dryResult.modified[0].itemId).toBe("evt-1");
    // Side-effects callback must NOT fire under dry-run — drift effects
    // would leak observations / today_refresh schedules otherwise.
    expect(sideEffects).toHaveLength(0);

    const after = db
      .prepare(
        "SELECT item_id, content_hash, payload_json FROM integration_snapshots WHERE integration = ? AND window_key = ? ORDER BY item_id",
      )
      .all("google_calendar", "primary:24h");
    expect(after).toEqual(before);

    // A subsequent apply call sees the original prior, so the modified
    // diff still exists — confirms the dry-run did not mutate state.
    const applyResult = reconcile(
      db,
      buildRequest([
        buildItem({
          id: "evt-1",
          summary: "Renamed",
          start: { dateTime: "2026-04-28T09:00:00Z" },
        }),
      ]),
      { normalizer: calendar },
    );
    expect(applyResult.modified).toHaveLength(1);
  });

  it("dry-run on an empty partition still reports isInitialSnapshot without writing the partition init flag", () => {
    const dryResult = reconcile(
      db,
      buildRequest(
        [buildItem({ id: "evt-1", start: { dateTime: "2026-04-28T09:00:00Z" } })],
        { mode: "dry-run" },
      ),
      { normalizer: calendar },
    );
    expect(dryResult.isInitialSnapshot).toBe(true);
    expect(dryResult.created).toHaveLength(0);

    // The next non-dry-run call must still be classified as initial — the
    // dry-run did not seed runtime_state.
    const applyResult = reconcile(
      db,
      buildRequest([
        buildItem({ id: "evt-1", start: { dateTime: "2026-04-28T09:00:00Z" } }),
      ]),
      { normalizer: calendar },
    );
    expect(applyResult.isInitialSnapshot).toBe(true);
  });

  it("handles a fresh window_key partition independently per integration+window", () => {
    // primary:24h has evt-1; primary:imminent should be untouched on first
    // call against the imminent partition.
    reconcile(
      db,
      buildRequest(
        [
          buildItem({
            id: "evt-1",
            start: { dateTime: "2026-04-28T09:00:00Z" },
          }),
        ],
        { windowKey: "primary:24h" },
      ),
      { normalizer: calendar },
    );

    const result = reconcile(
      db,
      buildRequest([], {
        windowKey: "primary:imminent",
        windowMin: "2026-04-28T10:00:00Z",
        windowMax: "2026-04-28T11:00:00Z",
      }),
      { normalizer: calendar },
    );
    expect(result.isInitialSnapshot).toBe(true);
    expect(result.deleted).toHaveLength(0);
  });
});

describe("markIntegrationWrite", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });
  afterEach(() => db.close());

  it("inserts a row with computed expires_at", () => {
    markIntegrationWrite(db, {
      integration: "google_calendar",
      itemId: "evt-1",
      ttlMs: 15 * 60 * 1000,
      nowIso: "2026-04-28T12:00:00Z",
    });
    const row = db
      .prepare(
        "SELECT integration, item_id, written_at, written_by, expires_at FROM integration_writes WHERE item_id = ?",
      )
      .get("evt-1") as {
        integration: string;
        item_id: string;
        written_at: string;
        written_by: string;
        expires_at: string;
      };
    expect(row.integration).toBe("google_calendar");
    expect(row.written_at).toBe("2026-04-28T12:00:00Z");
    expect(row.written_by).toBe("agent");
    expect(row.expires_at).toBe("2026-04-28T12:15:00.000Z");
  });

  it("UPSERTs on duplicate (integration, item_id) — last write wins", () => {
    markIntegrationWrite(db, {
      integration: "google_calendar",
      itemId: "evt-1",
      ttlMs: 60_000,
      nowIso: "2026-04-28T12:00:00Z",
    });
    markIntegrationWrite(db, {
      integration: "google_calendar",
      itemId: "evt-1",
      ttlMs: 60_000,
      nowIso: "2026-04-28T13:00:00Z",
    });
    const rows = db
      .prepare(
        "SELECT written_at, expires_at FROM integration_writes WHERE item_id = ?",
      )
      .all("evt-1") as { written_at: string; expires_at: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].written_at).toBe("2026-04-28T13:00:00Z");
    expect(rows[0].expires_at).toBe("2026-04-28T13:01:00.000Z");
  });
});
