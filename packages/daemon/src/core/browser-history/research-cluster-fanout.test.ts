import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Event } from "@aitne/shared";
import { applySchema } from "../../db/schema.js";
import { claimClusterJournalEnqueue } from "../../db/browser-history-store.js";
import {
  fanoutResearchClusterUpdates,
} from "./research-cluster-fanout.js";

const TODAY = "2026-06-11";
const TOMORROW = "2026-06-12";

class StubBus {
  events: Event[] = [];
  async put(event: Event): Promise<void> {
    this.events.push(event);
  }
}

function seedCluster(
  db: Database.Database,
  args: {
    slug: string;
    rootTaskId: number;
    status?: "active" | "muted" | "concluded" | "dormant";
    lastActivityAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO browser_research_clusters
       (slug, root_task_id, display_name, started_at, last_activity_at,
        visits_total, meaningful_visits_total, meaningful_foreground_sec_total,
        distinct_meaningful_domains, status)
     VALUES (?, ?, ?, ?, ?, 1, 1, 120, 1, ?)`,
  ).run(
    args.slug,
    args.rootTaskId,
    args.slug,
    1_700_000_000_000,
    args.lastActivityAt,
    args.status ?? "active",
  );
}

function stampOf(db: Database.Database, slug: string): string | null {
  return (
    db
      .prepare(
        `SELECT journal_update_enqueued_on AS stamp
           FROM browser_research_clusters WHERE slug = ?`,
      )
      .get(slug) as { stamp: string | null }
  ).stamp;
}

describe("fanoutResearchClusterUpdates", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });
  afterEach(() => {
    db.close();
  });

  it("returns empty when no EventBus is wired and stamps nothing", async () => {
    seedCluster(db, { slug: "early", rootTaskId: 9, lastActivityAt: Date.now() });
    const result = await fanoutResearchClusterUpdates(db, null, {
      todayAgentDay: TODAY,
    });
    expect(result.enqueuedSlugs).toEqual([]);
    // Early-boot path must not consume the cluster's daily slot.
    expect(stampOf(db, "early")).toBeNull();
  });

  it("enqueues one event per active cluster with recent activity", async () => {
    const now = Date.now();
    seedCluster(db, { slug: "fresh-a", rootTaskId: 1, lastActivityAt: now - 1000 });
    seedCluster(db, { slug: "fresh-b", rootTaskId: 2, lastActivityAt: now - 2000 });
    // Stale (>24h) — should NOT appear.
    seedCluster(db, {
      slug: "stale",
      rootTaskId: 3,
      lastActivityAt: now - 10 * 86_400_000,
    });
    // Muted — should NOT appear.
    seedCluster(db, {
      slug: "muted",
      rootTaskId: 4,
      lastActivityAt: now - 1000,
      status: "muted",
    });
    const bus = new StubBus();
    const result = await fanoutResearchClusterUpdates(db, bus, {
      nowMs: now,
      todayAgentDay: TODAY,
    });
    expect(result.enqueuedSlugs.sort()).toEqual(["fresh-a", "fresh-b"]);
    expect(bus.events.every((e) => e.type === "routine.research_cluster_update")).toBe(true);
  });

  it("defaults nowMs to Date.now() when omitted (covers the ?? branch)", async () => {
    seedCluster(db, {
      slug: "fresh-now",
      rootTaskId: 7,
      lastActivityAt: Date.now() - 1000,
    });
    const bus = new StubBus();
    const result = await fanoutResearchClusterUpdates(db, bus, {
      todayAgentDay: TODAY,
    });
    expect(result.enqueuedSlugs).toContain("fresh-now");
  });

  it("respects the limit argument", async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      seedCluster(db, {
        slug: `c${i}`,
        rootTaskId: i + 1,
        lastActivityAt: now - (i + 1) * 1000,
      });
    }
    const bus = new StubBus();
    const result = await fanoutResearchClusterUpdates(db, bus, {
      nowMs: now,
      limit: 2,
      todayAgentDay: TODAY,
    });
    expect(result.enqueuedSlugs).toHaveLength(2);
  });

  it("stamps each cluster with the agent day it was enqueued on", async () => {
    const now = Date.now();
    seedCluster(db, { slug: "stamped", rootTaskId: 11, lastActivityAt: now - 1000 });
    const bus = new StubBus();
    await fanoutResearchClusterUpdates(db, bus, {
      nowMs: now,
      todayAgentDay: TODAY,
    });
    expect(stampOf(db, "stamped")).toBe(TODAY);
  });

  it("is a no-op on a same-day replay (RC1 — DarkWake day-boundary replays)", async () => {
    const now = Date.now();
    seedCluster(db, { slug: "once", rootTaskId: 13, lastActivityAt: now - 1000 });
    const bus = new StubBus();
    const first = await fanoutResearchClusterUpdates(db, bus, {
      nowMs: now,
      todayAgentDay: TODAY,
    });
    expect(first.enqueuedSlugs).toEqual(["once"]);
    const replay = await fanoutResearchClusterUpdates(db, bus, {
      nowMs: now,
      todayAgentDay: TODAY,
    });
    expect(replay.enqueuedSlugs).toEqual([]);
    expect(bus.events).toHaveLength(1);
  });

  it("re-enqueues a still-active cluster on the next agent day", async () => {
    const now = Date.now();
    seedCluster(db, { slug: "daily", rootTaskId: 17, lastActivityAt: now - 1000 });
    const bus = new StubBus();
    await fanoutResearchClusterUpdates(db, bus, {
      nowMs: now,
      todayAgentDay: TODAY,
    });
    const nextDay = await fanoutResearchClusterUpdates(db, bus, {
      nowMs: now,
      todayAgentDay: TOMORROW,
    });
    expect(nextDay.enqueuedSlugs).toEqual(["daily"]);
    expect(stampOf(db, "daily")).toBe(TOMORROW);
  });

  it("stamps BEFORE enqueueing so a failed put cannot same-day loop", async () => {
    const now = Date.now();
    seedCluster(db, { slug: "doomed", rootTaskId: 19, lastActivityAt: now - 1000 });
    const failingBus = {
      async put(): Promise<void> {
        throw new Error("bus down");
      },
    };
    await expect(
      fanoutResearchClusterUpdates(db, failingBus, {
        nowMs: now,
        todayAgentDay: TODAY,
      }),
    ).rejects.toThrow("bus down");
    // Stamp persisted despite the failed enqueue — the cluster retries
    // on the NEXT agent day instead of every day-boundary replay.
    expect(stampOf(db, "doomed")).toBe(TODAY);
    const replay = await fanoutResearchClusterUpdates(db, new StubBus(), {
      nowMs: now,
      todayAgentDay: TODAY,
    });
    expect(replay.enqueuedSlugs).toEqual([]);
  });

  it("skips a cluster a concurrent fire claims between list and enqueue", async () => {
    // Both clusters are eligible when this fan-out snapshots the list,
    // but a CONCURRENT day-boundary callback (the 04:00 cron is
    // fire-and-forget and can overlap a wake catch-up) claims "beta"
    // while we are awaiting the put for "alpha". The atomic per-row claim
    // must make our loop skip "beta" — only one fire enqueues it.
    const now = Date.now();
    seedCluster(db, { slug: "alpha", rootTaskId: 23, lastActivityAt: now - 1000 });
    seedCluster(db, { slug: "beta", rootTaskId: 29, lastActivityAt: now - 2000 });
    // DESC by last_activity_at → alpha is enqueued first; simulate the
    // race inside its put, before the loop reaches beta.
    const racingBus = {
      events: [] as Event[],
      async put(event: Event): Promise<void> {
        this.events.push(event);
        claimClusterJournalEnqueue(db, "beta", TODAY);
      },
    };
    const result = await fanoutResearchClusterUpdates(db, racingBus, {
      nowMs: now,
      todayAgentDay: TODAY,
    });
    expect(result.enqueuedSlugs).toEqual(["alpha"]);
    expect(racingBus.events).toHaveLength(1);
    // beta was claimed by the racing fire — still stamped, never enqueued twice.
    expect(stampOf(db, "beta")).toBe(TODAY);
  });
});
